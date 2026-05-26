# 抖音自动化营销 Skill 调研与 ClawHub 部署方案

## 0. 一句话结论

当前方案可行：抖音自动化营销 skill 可以通过 ClawHub 分发给纯净 OpenClaw 环境，ClawHub 负责下发 skill 代码、小冰工具代码和配置模板；目标机器本地执行一次 `npm ci` + `bootstrap` 后即可完成依赖安装、MCP 注册、小冰工具安装和 daemon 启动。

但 ClawHub 不会、也不应该自动携带密钥和登录态。因此目标机器仍需本地填写 `.env.local` 和小冰 `.env`，并在首次使用时完成抖音扫码登录。

## 1. 背景

当前目标是把抖音自动化营销能力交付给其他 OpenClaw 用户使用。用户侧默认只有 OpenClaw 环境，不一定有 Codex，也不应要求用户理解项目内部代码结构。

Skill 需要覆盖：

- 抖音创作者平台登录、二维码、短信验证、视频发布、截图和发布状态通知。
- 评论/私信读取与自动回复。
- 数据同步、数据报告、下一条视频方案生成。
- 人设定位、数字人形象训练、一键成片、自动化营销定时流程。
- 小冰一键成片工具、浏览器 daemon、OpenClaw MCP 注册和本地守护进程。

## 2. 调研结论

### 2.1 ClawHub 适合承载什么

ClawHub 适合承载可公开分发的文件：

- `SKILL.md` 和 OpenClaw 识别 skill 所需文档。
- Node 脚本、MCP server、浏览器 daemon、定时任务脚本。
- `vendor/xiaoice-video-tool` 小冰一键成片工具代码。
- 配置模板和安装说明。
- README、用户教程、验收说明。

### 2.2 ClawHub 不适合承载什么

以下内容不能上传 ClawHub/GitHub：

- `.env`、`.env.local`、真实 API key、飞书 app secret、小冰 provider key、Coze token。
- 抖音登录态、Cookie、浏览器 profile。
- OpenClaw 会话历史、workspace 运行状态。
- 已发布作品缓存、测试视频、数据库、日志。
- `node_modules`。
- Edge/Chrome 浏览器二进制。

浏览器由安装脚本检测并提示/尝试安装；`node_modules` 由用户或 OpenClaw agent 在目标机器执行 `npm ci` 生成；所有 key 由目标机器本地填写。

### 2.3 ClawHub 安装的真实边界

实测发现：

- `openclaw skills install` 会把 skill 文件安装到 OpenClaw workspace。
- OpenClaw `skills check` 能识别该 skill 为 ready，表示 `SKILL.md` 和技能描述可被模型读取。
- 但 ClawHub 不会自动执行 `npm ci`，不会自动填写 `.env.local`，不会自动授权飞书，也不会自动扫码登录抖音。
- 因此安装后必须执行一次本地自举脚本：`node scripts/bootstrap-openclaw.js --apply`。

这不是 bug，而是 OpenClaw/ClawHub 的安全边界：下载安装和本地执行配置是两步。

## 3. 当前部署包内容

当前公开包已发布：

- GitHub: `https://github.com/MrChenyh/douyin-upload-mcp-skill`
- ClawHub: `douyin-upload-mcp-skill@0.1.5`

公开包包含：

- `SKILL.md`
- `README.md`
- `references/customer-install-guide.md`
- `references/skill-local-config.md`
- `references/xiaoice-service-config.md`
- `scripts/bootstrap-openclaw.js`
- `scripts/preflight.js`
- `scripts/agent-ready.js`
- `src/mcp-server.js`
- `src/daemon/*`
- `vendor/xiaoice-video-tool/*`

公开包不包含真实密钥和登录状态。

## 4. 用户安装方案

### 4.1 前置条件

目标机器建议为 Windows + WSL Ubuntu，且 OpenClaw 安装在 Ubuntu/WSL 内。

需要：

- Node.js 22+
- OpenClaw 2026.4.2 或更新版本
- Edge / Chrome / Chromium
- 可用网络
- 飞书机器人 app 配置
- 小冰一键成片 API 配置
- Coze/数字人训练相关 API 配置

### 4.2 从 ClawHub 安装

```bash
openclaw skills install douyin-upload-mcp-skill --force
cd ~/.openclaw/workspace/skills/douyin-upload-mcp-skill
```

如果使用 OpenClaw profile，例如：

```bash
openclaw --profile customer-a skills install douyin-upload-mcp-skill --force
```

安装目录通常是：

```bash
~/.openclaw/workspace-customer-a/skills/douyin-upload-mcp-skill
```

实际以安装命令输出的 `Installing to ...` 或 `Installed ... -> ...` 路径为准。

### 4.3 生成配置并自举

在 skill 目录执行：

```bash
npm ci
cp references/skill-local-config.md .env.local 2>/dev/null || cp .env.example .env.local
node scripts/bootstrap-openclaw.js --apply
```

这一步会：

- 安装/检查 Node 依赖。
- 把 `vendor/xiaoice-video-tool` 安装到 `~/自动营销/xiaoice-video-tool`。
- 生成小冰工具 `.env` 模板。
- 检测浏览器。
- 注册 OpenClaw MCP server。
- 启动 `douyin-skill-supervisor.service`。
- 启动抖音浏览器 daemon。

### 4.4 填写本机配置

编辑 skill 配置：

```bash
nano .env.local
```

至少需要填写：

```text
FEISHU_APP_ID=
FEISHU_APP_SECRET=
DOUYIN_FEISHU_RECEIVE_ID=
DOUYIN_FEISHU_RECEIVE_ID_TYPE=chat_id
DOUYIN_PERSONA_API_KEY=
DOUYIN_NEXT_VIDEO_PLAN_API_KEY=
DOUYIN_DATA_REPORT_API_KEY=
DOUYIN_AUTO_REPLY_API_KEY=
DIGITAL_HUMAN_COZE_TOKEN=
DIGITAL_HUMAN_TRAINING_API_KEY=
```

编辑小冰工具配置：

```bash
nano ~/自动营销/xiaoice-video-tool/.env
```

至少需要填写：

```text
VIDEO_SERVICE_INTERNAL_TOKEN=本机内部随机口令
VIDEO_SERVICE_ADMIN_TOKEN=本机管理随机口令
VIDEO_SERVICE_CALLBACK_TOKEN=回调随机口令
VIDEO_PROVIDER_API_BASE_URL=小冰一键成片 API 地址
VIDEO_PROVIDER_API_KEY=小冰一键成片 API key
VIDEO_PROVIDER_VH_BIZ_ID=数字人模型 ID
```

### 4.5 在线验收

填写配置后运行：

```bash
node scripts/bootstrap-openclaw.js --apply
node scripts/preflight.js --online
node scripts/agent-ready.js
```

`preflight --online` 全部通过后，才认为环境已可用。

## 5. 实测结果

已做纯净 OpenClaw profile 实测：

- 新建 profile: `douyin-clawhub-pure-test`
- 从 ClawHub 安装 `douyin-upload-mcp-skill@0.1.5`
- OpenClaw `skills check --json` 识别为 `eligible / ready`
- ClawHub 安装后确认存在：
  - `references/skill-local-config.md`
  - `references/xiaoice-service-config.md`
  - `vendor/xiaoice-video-tool`
- 执行 `npm ci` 成功
- 执行 `node scripts/bootstrap-openclaw.js --apply` 成功
- 小冰工具安装成功
- 小冰 `.env` 生成成功
- MCP 注册成功
- supervisor 启动成功
- 抖音 daemon health 成功

剩余未自动完成项：

- 飞书 app / secret / receive id 需要目标机器填写。
- 小冰 provider key 需要目标机器填写。
- Coze/数字人训练 key 需要目标机器填写。
- 抖音首次使用需要扫码登录。

## 6. 验收标准

### 环境验收

```bash
node scripts/preflight.js --online
node scripts/agent-ready.js
```

通过标准：

- Node 22+ 可用。
- 浏览器可用。
- 飞书配置可用。
- 小冰工具存在且 `.env` 已配置。
- MCP 已注册。
- daemon 正常。

### 真实业务验收

需要人工配合：

- 飞书发送 `发布抖音`。
- 系统发送二维码。
- 用户扫码/短信验证。
- 使用测试视频发布。
- 发布成功后删除测试作品。
- 飞书发送 `数据报告`、`自动回复评论`、`自动回复私信`、`定时任务` 做功能验证。

## 7. 风险与边界

- ClawHub 安装不等于完整运行，必须执行 `npm ci` 和 `bootstrap`。
- OpenClaw `skills check` 的 ready 只代表 skill 可被模型读取，不代表 env/API 已填。
- API key 不上传，必须由目标机器本地配置。
- 抖音登录态不迁移，首次使用必须扫码。
- 浏览器二进制不上传，目标机器需要安装 Edge/Chrome/Chromium。
- 若目标用户完全不会命令行，需要让 OpenClaw agent 按本方案代执行命令，或改用 WSL 镜像交付。

## 8. 推荐交付方式

推荐当前阶段采用：

1. ClawHub 安装 skill。
2. 目标机器本地填写 env。
3. 运行 bootstrap 和 preflight。
4. 飞书真实测试发布/数据/自动回复。

如果目标用户完全没有命令行能力，再考虑 WSL 镜像交付。WSL 镜像能降低用户安装门槛，但包体更大，更新和密钥管理也更复杂。
