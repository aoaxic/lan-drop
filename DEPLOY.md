# 部署指南 · 零成本拿到固定网址

目标：把 LAN Drop 部署到 Render 免费托管，得到一个 `https://xxx.onrender.com` 固定网址——**任何网络**（家里 Wi-Fi、公司、手机流量）打开都进入同一入口，服务器自动让**同一出口（同局域网）的设备互见**。

预计用时：15~20 分钟。全程只需注册两个免费账号，不需要信用卡。

---

## 准备好的东西（本目录已包含）

| 文件 | 作用 |
|---|---|
| `server.js` | 读取 `PORT` 环境变量、监听 `0.0.0.0`，云平台即插即用 |
| `render.yaml` | Render 一键部署蓝图（已配好构建/启动命令/健康检查） |
| `.gitignore` | 排除 node_modules 等 |

---

## 第一步：推送到 GitHub（约 5 分钟）

1. 打开 https://github.com 注册/登录账号
2. 右上角 **+** → **New repository**
   - 名称：`lan-drop`（随意）
   - 可见性：选 **Private**（私有，只有你能看）
   - **不要**勾选 "Add a README"
   - 点 **Create repository**
3. 在本机终端执行（把 `你的用户名` 换成你的）：

```bash
cd /Users/aoaxic/WorkBuddy/2026-09-03-14-13-12/lan-drop
git init
git add .
git commit -m "LAN Drop: ready for deploy"
git branch -M main
git remote add origin https://github.com/你的用户名/lan-drop.git
git push -u origin main
```

> 如果还没配置过 git 身份，先执行：
> `git config --global user.name "你的名字"` 和 `git config --global user.email "你的邮箱"`
> 推送时 GitHub 会弹浏览器登录授权，按提示操作即可。

## 第二步：部署到 Render（约 5 分钟 + 等待构建）

1. 打开 https://render.com 注册/登录（可用 GitHub 账号一键登录）
2. 控制台点 **New +** → **Web Service**
3. 选择 **Build and deploy from a Git repository** → 授权并选中刚才的 `lan-drop` 仓库 → **Connect**
4. 配置页面：
   - **Name**：`lan-drop`（会决定网址前缀，如 `lan-drop.onrender.com`）
   - **Region**： Singapore（离国内最近的可用区）
   - **Branch**： `main`
   - **Runtime**： Node（会自动读取 `render.yaml`，一般无需手填）
   - **Instance Type**： **Free**
5. 点 **Create Web Service**，等 2~3 分钟构建完成
6. 页面顶部会出现 **https://lan-drop-xxxx.onrender.com** —— 这就是你的固定网址 ✅

## 第三步：验证（1 分钟）

1. 电脑浏览器打开该网址 → 顶栏应显示「已连接 · 分组 net-x.x.x.x」
2. 手机连**同一个 Wi-Fi** 打开同一网址 → 两边应互相看到对方
3. 发一个文件试试，确认百分比进度正常

---

## 使用与说明

- **网址固定**：收藏到手机主屏幕 / 电脑收藏夹即可，永不变
- **自动分组**：服务器按你的公网出口 IP 分房间——同一 Wi-Fi 下的人互见，其他网络看不到你
- **临时跨网络互传**：双方都在网址后加相同的 `?room=xxx`（例：`https://xxx.onrender.com/?room=abc123`）
- **隐私提示**：同一条宽带下的所有设备（如家人）都会出现在彼此列表里，介意的话用 `?room=` 单独开房间

## 免费版的两个限制（正常现象）

1. **休眠**：15 分钟无人访问会休眠，下次打开需等 30~60 秒唤醒。规避：常用就多开几次；或以后升级付费实例（$7/月不休眠）
2. **速度**：服务器在海外（新加坡），但只传输信令（几 KB），**文件本体走点对点直传不受影响**；仅当路由器 AP 隔离触发中转兜底时才会慢

## 以后想升级

- **国内访问慢/经常用** → 买腾讯云轻量服务器（约 ¥50/月），`git clone` 你的仓库 → `npm install` → `pm2 start server.js` → 防火墙放行端口，用 `http://公网IP:端口` 访问（免域名、免备案）
- **想要好记域名** → 注册 `.com`（约 ¥60/年），海外托管直接在 Render 设置里 Add Custom Domain，无需备案
