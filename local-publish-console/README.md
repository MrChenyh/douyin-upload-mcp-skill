# 抖音本地发布控制台 MMVP

这个目录是一个不依赖 OpenClaw 的本地发布 MMVP，用于验证：

```text
本地 Node 服务 -> 现有抖音发布脚本 -> 本机浏览器 -> 抖音创作者平台
```

## Windows 启动

普通 Windows 客户优先使用：

```text
local-publish-console\start-console.bat
```

首次运行会自动下载便携 Node.js 22 到项目内 `.runtime` 目录，执行 `npm ci`，然后自动打开抖音创作者平台：

```text
https://creator.douyin.com/
```

本地控制服务仍运行在：

```text
http://127.0.0.1:3766
```

默认使用：

```text
%LOCALAPPDATA%\DouyinLocalPublishConsole
```

保存任务、上传素材、下载素材和独立浏览器 profile。

## 开发启动

在项目根目录执行：

```bash
npm run local:publish-console
```

然后可手动打开调试控制台：

```text
http://127.0.0.1:3766
```

也可以直接执行：

```bash
node local-publish-console/server.js
```

## 使用流程

1. 双击启动器，系统自动打开抖音创作者平台。
2. 用户在官方页面里手动扫码、输入验证码或完成安全验证。
3. 后续由本地服务 API 接收发布任务并调用现有脚本自动发布。
4. 如需调试，可打开 `http://127.0.0.1:3766` 查看 health、登录状态和任务日志。

## 设计边界

- 不需要 OpenClaw。
- 不需要任何外部聊天机器人。
- 不自动发送二维码。
- 不绕过验证码、滑块、安全验证或风控。
- 异常时保留浏览器页面，让用户手动处理。
- 第一版只验证自动发布，不做内容生成、数据分析或互动回复。

## 状态目录

Windows 默认状态目录：

```text
%LOCALAPPDATA%\DouyinLocalPublishConsole
```

Linux / WSL 默认状态目录：

```text
~/.douyin-local-publish-console
```

其中包含：

- `uploads/`：网页上传的视频和封面。
- `downloads/`：从 URL 下载的视频和封面。
- `tasks/`：生成的发布任务 JSON。
- `jobs/`：任务状态和日志。

## 接口

- `GET /api/health`
- `POST /api/login/open`
- `GET /api/login/status`
- `POST /api/publish`
- `GET /api/publish/:jobId`
- `POST /api/jobs/:jobId/cancel`

## 调试控制台

默认启动器不打开本地前端页面，只打开抖音官方创作者平台。

如需打开本地调试控制台：

```powershell
.\local-publish-console\start-console.ps1 -OpenConsole
```

## Windows 常见问题

- 没有 Node：双击 `start-console.bat` 会自动下载便携 Node，不需要全局安装。
- Node 下载失败：检查网络，或后续使用离线包把 `.runtime` 一起交付。
- 没有 Edge/Chrome：请先安装 Microsoft Edge 或 Chrome，或设置 `BROWSER_PATH`。
- 抖音验证码/安全验证：在弹出的 Windows Edge 里手动完成，然后回页面点“检测登录状态”。
- 端口占用：用 PowerShell 执行 `.\local-publish-console\start-console.ps1 -Port 3767`。
