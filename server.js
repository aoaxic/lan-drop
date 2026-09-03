'use strict';
/*
 * LAN Drop — 局域网闪传 (服务器端网络分组版)
 * 信令走同源 WebSocket，文件默认 WebRTC 点对点直传，
 * 直连不通时自动走服务器中转(relay)。房间由服务器按连接来源 IP 自动划分：
 *   - 公网 IPv4 → 按出口 IP 分组（部署到公网后，任意网络打开同一网址，
 *     同出口=同局域网的人自动互见 —— 固定入口的根本解法）
 *   - IPv6 → /64 前缀；内网直连 → /24 网段；反代时读 X-Forwarded-For
 *   - URL ?room=xxx 显式覆盖优先
 * 服务器还负责：
 *   - 广告 mDNS 主机名 landrop.local (iOS/macOS 可直接收藏)
 *   - 提供 /api/qr 生成地址二维码 (手机扫码即连)
 *
 * 启动:  node server.js [端口]   或   PORT=8000 node server.js
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const dgram = require('dgram');
const { WebSocketServer } = require('ws');
let QR = null;
try { QR = require('qrcode'); } catch (e) { QR = null; }

const PORT = process.argv[2] ? parseInt(process.argv[2], 10) : (process.env.PORT ? parseInt(process.env.PORT, 10) : 8000);
const HOST = '0.0.0.0';
const ROOT = path.join(__dirname, 'public');
const MDNS_NAME = 'landrop.local';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

function getLanIp() {
  const ifs = os.networkInterfaces();
  // 优先非内网常见网段，回退到第一个 IPv4
  let fallback = '127.0.0.1';
  for (const name of Object.keys(ifs)) {
    for (const ni of ifs[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) {
        if (/^192\.168\.|^10\.|^172\.(1[6-9]|2\d|3[01])\./.test(ni.address)) return ni.address;
        fallback = ni.address;
      }
    }
  }
  return fallback;
}
const LAN_IP = getLanIp();

// ---------------- 静态服务 ----------------
const server = http.createServer((req, res) => {
  const raw = req.url.split('?')[0];
  let urlPath = decodeURIComponent(raw);
  if (urlPath === '/') urlPath = '/index.html';

  if (urlPath === '/api/info') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ lanIp: LAN_IP, port: PORT, mdns: MDNS_NAME, reachable: `http://${LAN_IP}:${PORT}` }));
    return;
  }
  if (urlPath === '/api/qr') {
    const q = req.url.split('?')[1] || '';
    const text = new URLSearchParams(q).get('text') || '';
    return serveQr(text, res);
  }

  const fp = path.join(ROOT, path.normalize(urlPath));
  if (!fp.startsWith(ROOT)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
    res.end(data);
  });
});

function serveQr(text, res) {
  if (!QR || !text) { res.writeHead(404); res.end('qr unavailable'); return; }
  QR.toString(text, { type: 'svg', margin: 1, width: 240 }, (err, svg) => {
    if (err) { res.writeHead(500); res.end('qr error'); return; }
    res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
    res.end(svg);
  });
}

// ---------------- 信令 (WebSocket) ----------------
const rooms = new Map(); // room -> Map(uid -> peer)
function getRoom(r) { if (!rooms.has(r)) rooms.set(r, new Map()); return rooms.get(r); }

// 服务器端网络分组：从 socket 真实来源 IP 计算房间。
// - 公网 IPv4 → 按 IP 本身分组（同一宽带出口 = 同一房间，天然实现"同局域网互见"）
// - IPv6     → 按 /64 前缀分组
// - 内网 IPv4 → 按 /24 网段分组（本地部署时，同一子网的设备互见）
// - 环回     → 统一 'local'（本机调试的多个标签页互见）
// 部署在公网 VPS 时，浏览器直连或经 nginx 反代（X-Forwarded-For）都能拿到真实出口 IP，
// 任意网络的设备打开同一网址，同一出口的人自动互见 —— 这就是"固定入口"的根本解法。
function normalizeIp(ip) {
  if (!ip) return '';
  ip = String(ip).trim();
  if (ip.startsWith('::ffff:')) ip = ip.slice(7); // IPv4-mapped IPv6
  return ip;
}
function clientIpFromReq(req) {
  // 反向代理场景（nginx/云托管）：取 X-Forwarded-For 第一个（最初的客户端）
  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    const first = normalizeIp(String(xff).split(',')[0]);
    if (first) return first;
  }
  return normalizeIp(req.socket && req.socket.remoteAddress);
}
function isPrivateIpv4(ip) {
  return /^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
}
function roomFromIp(ip) {
  if (!ip) return 'default';
  if (ip === '::1' || ip.startsWith('127.')) {
    // 环回访问（localhost/127.0.0.1）：和本机局域网 IP 分到同一 /24 组，
    // 让电脑用 localhost 打开的页面也能与手机扫码的局域网设备互见
    if (LAN_IP && isPrivateIpv4(LAN_IP)) return 'lan-' + LAN_IP.split('.').slice(0, 3).join('.');
    return 'local';
  }
  if (ip.includes(':')) { // IPv6 → /64 前缀
    const g = ip.split(':').slice(0, 4).join(':');
    return 'v6-' + g;
  }
  if (isPrivateIpv4(ip)) return 'lan-' + ip.split('.').slice(0, 3).join('.'); // /24
  return 'net-' + ip; // 公网 IPv4：按出口 IP 分组
}

const wss = new WebSocketServer({ server, path: '/signal' });

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.peer = null;
  ws.clientIp = clientIpFromReq(req);
  ws.clientRoom = roomFromIp(ws.clientIp);
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (buf) => {
    let m; try { m = JSON.parse(buf.toString()); } catch (e) { return; }
    handle(ws, m);
  });
  ws.on('close', () => { removePeer(ws); });
  ws.on('error', () => {});
});

function send(ws, obj) {
  if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify(obj)); } catch (e) {} }
}

function handle(ws, m) {
  if (m.type === 'hello') {
    // 房间优先级：URL 显式 ?room= 覆盖 > 服务器按来源 IP 自动分组
    const room = (m.room ? String(m.room) : '').slice(0, 40) || ws.clientRoom || 'default';
    const uid = crypto.randomBytes(6).toString('hex');
    const peer = {
      uid,
      name: String(m.name || '设备').slice(0, 40),
      kind: m.kind === 'phone' ? 'phone' : 'desktop',
      room,
      ws
    };
    ws.peer = peer;
    getRoom(room).set(uid, peer);
    send(ws, { type: 'welcome', uid, room, clientIp: ws.clientIp, lanIp: LAN_IP, port: PORT, mdns: MDNS_NAME });
    broadcastPeers(room);
  } else if (m.type === 'signal') {
    const p = ws.peer; if (!p || !m.to) return;
    const target = getRoom(p.room).get(m.to);
    if (target) send(target.ws, { type: 'signal', from: p.uid, name: p.name, data: m.data });
  } else if (m.type === 'relay') {
    const p = ws.peer; if (!p || !m.to) return;
    const target = getRoom(p.room).get(m.to);
    if (target) send(target.ws, { type: 'relay', from: p.uid, name: p.name, payload: m.payload || {} });
  } else if (m.type === 'bye') {
    removePeer(ws);
  }
}

function removePeer(ws) {
  const p = ws.peer; if (!p) return;
  const room = getRoom(p.room);
  room.delete(p.uid);
  ws.peer = null;
  broadcastPeers(p.room);
}

function broadcastPeers(room) {
  const all = [...getRoom(room).values()];
  const base = all.map(p => ({ uid: p.uid, name: p.name, kind: p.kind }));
  for (const p of all) {
    const others = base.filter(x => x.uid !== p.uid);
    send(p.ws, { type: 'peers', peers: others });
  }
}

// 心跳清扫
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { removePeer(ws); try { ws.terminate(); } catch (e) {} continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) {}
  }
  for (const [r, rm] of rooms) { if (rm.size === 0) rooms.delete(r); }
}, 15000);

// ---------------- mDNS 广告 (landrop.local) ----------------
function dnsName(n) {
  let out = Buffer.alloc(0);
  for (const p of n.split('.')) {
    if (!p) continue;
    const b = Buffer.from(p);
    out = Buffer.concat([out, Buffer.from([b.length]), b]);
  }
  return Buffer.concat([out, Buffer.from([0])]);
}

function buildMdnsResponse(name, ip) {
  const nameBuf = dnsName(name);
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0x8400, 2); // response, authoritative
  header.writeUInt16BE(1, 4);      // questions
  header.writeUInt16BE(1, 6);      // answers
  const question = Buffer.concat([nameBuf, Buffer.from([0, 1, 0, 1])]); // A IN
  const answerName = Buffer.from([0xC0, 0x0C]); // pointer to offset 12
  const typeA = Buffer.from([0, 1]);
  const classIN = Buffer.from([0, 1]);
  const ttl = Buffer.alloc(4); ttl.writeUInt32BE(120, 0);
  const rdata = Buffer.from(ip.split('.').map(Number));
  const rdlen = Buffer.from([0, 4]);
  const answer = Buffer.concat([answerName, typeA, classIN, ttl, rdlen, rdata]);
  return Buffer.concat([header, question, answer]);
}

function startMdns() {
  try {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    sock.on('error', () => {});
    sock.bind(5353, () => { try { sock.addMembership('224.0.0.251'); } catch (e) {} });
    const resp = buildMdnsResponse(MDNS_NAME, LAN_IP);
    sock.on('message', (msg, rinfo) => {
      if (msg && msg.toString('latin1').includes('landrop')) {
        try { sock.send(resp, 0, resp.length, 5353, rinfo.address); } catch (e) {}
      }
    });
    setInterval(() => { try { sock.send(resp, 5353, '224.0.0.251'); } catch (e) {} }, 30000);
    console.log(`[mDNS] 广告已启动: ${MDNS_NAME} -> ${LAN_IP}`);
  } catch (e) {
    console.log('[mDNS] 不可用 (不影响功能):', e.message);
  }
}

server.listen(PORT, HOST, () => {
  console.log('================================================');
  console.log(' LAN Drop 局域网闪传 已启动');
  console.log(` 本机访问 : http://127.0.0.1:${PORT}`);
  console.log(` 局域网   : http://${LAN_IP}:${PORT}`);
  console.log(` 主机名   : http://${MDNS_NAME}:${PORT}  (iOS/macOS 可直接收藏)`);
  console.log(` 手机扫码 : 打开页面后用相机/扫码 App 扫页面上的二维码`);
  console.log(' 提示: 部署到公网 VPS 后即为固定入口，任意网络的');
  console.log('       设备打开同一网址，同出口(同局域网)自动互见。');
  console.log('================================================');
  startMdns();
});
