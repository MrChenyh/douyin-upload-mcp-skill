# Douyin Upload MCP Skill

OpenClaw 中用于抖音创作者平台的自动发布、登录守卫、数据同步、评论回复、私信回复和数字人自动化营销。

## 适用场景

- 飞书里发 `发布抖音`
- 飞书里发 `发送二维码`
- 飞书里发 `已登录` 或 6 位验证码
- 飞书里发 `发布视频`
- 飞书里发 `更新数据`、`数据报告`
- 飞书里发 `生成下一条视频`、`下一条视频`、`内容方案`。这是后台 job，最终只由 skill 给飞书发一条完整方案；agent 不要改调低层工具或自行整理回复
- 飞书里发 `生成人设`、`训练数字人`、`开启自动化营销`
- 飞书里发 `自动回复评论`、`自动回复私信`
- 其他 agent 发送字段化发布任务：`视频地址`、`封面图片`、`标题`、`tags`

## 快速开始

### 发布版边界

这个仓库/ClawHub 包只包含可公开分发的 skill、脚本和安装说明，不包含：

- API key、飞书 app secret、模型 key
- 抖音登录态、Cookie、浏览器 profile
- 小冰视频工具私有包
- WSL 镜像、Edge/Chrome 浏览器安装包、`node_modules`

安装后需要在目标机器本地复制 `.env.example` 为 `.env.local` 并填写自己的配置。小冰视频工具如需使用，请通过私有渠道取得并设置 `XIAOICE_VIDEO_TOOL_DIR` / `XIAOICE_VIDEO_ENV_PATH`。

### 给客户的小白教程

客户安装和使用教程见：

```text
references/customer-install-guide.md
```

给已经接好飞书机器人的新 OpenClaw 客户，优先把整个 skill 文件夹和这份教程发给对方。客户只需要按教程执行自举、开启定时任务，然后在飞书发送 `发布抖音`、`数据报告`、`自动回复`、`定时任务` 等指令。

### 1. 确认前置条件

需要这些宿主机条件：

- Node.js 20+
- Chrome / Edge / Chromium 之一
- 中文字体可用。公开版不会内置字体文件；如系统没有合适中文字体，按 `preflight` 提示安装 Noto CJK 等字体
- 可写的 OpenClaw 工作区
- 飞书机器人和回调配置
- 飞书多维表授权
- 小冰视频工具和数字人训练 API 配置（仅自动化营销/一键成片需要）

这些不是每次手工安装，而是第一次装机或迁移时必须存在。Skill 会自动补依赖、注册配置和守护进程，但不会凭空创造宿主机运行环境。

### 2. 一次性自举

推荐直接从 ClawHub 安装到当前 OpenClaw workspace：

```bash
openclaw skills install douyin-upload-mcp-skill --force
cd ~/.openclaw/workspace/skills/douyin-upload-mcp-skill
cp .env.example .env.local
# 编辑 .env.local，填写目标机器自己的飞书、模型、多维表、小冰/Coze 配置
node scripts/bootstrap-openclaw.js --apply
```

注意：OpenClaw 2026.4.2 中 `openclaw ... --version` 是顶层版本参数，会只打印 OpenClaw 版本并退出；安装最新版请不要加 `--version 0.1.0`。如需指定版本，可先用 `clawhub install` 安装到手工目录，或确认你当前 OpenClaw 版本已经修复该参数冲突。

如果不用 ClawHub，也可以手工 clone 到任意目录，例如：

```bash
mkdir -p ~/openclaw-skills
cd ~/openclaw-skills
git clone https://github.com/MrChenyh/douyin-upload-mcp-skill.git
cd douyin-upload-mcp-skill
cp .env.example .env.local
# 编辑 .env.local，填写目标机器自己的飞书、模型、多维表、小冰/Coze 配置
npm install
node scripts/bootstrap-openclaw.js --apply
```

这一步会：

- 安装或检查 `node_modules`
- 安装或检查中文字体兜底包
- 注册 `mcp.servers.douyin`
- 写入并启动 `douyin-skill-supervisor.service`
- 检查浏览器 daemon
- 对接 OpenClaw gateway

### 3. 验收

```bash
node scripts/preflight.js --online
node scripts/agent-ready.js
```

### 4. 开启默认定时任务

```bash
node scripts/douyin-schedule-manager.js install-default
node scripts/douyin-schedule-manager.js status
```

默认：

- 每 30 分钟检查新评论和新私信并自动回复
- 每天 07:30 生成近 1 天数据分析报告和下一条视频方案并发飞书

飞书里也可以发送：

```text
定时任务
修改定时任务 自动回复 30分钟
修改定时任务 数据报告 07:30
关闭定时任务
开启定时任务
```

### 5. 直接使用

在飞书里发送：

```text
发布抖音
```

后续按提示继续即可。

群聊/私聊会话会自适应：OpenClaw 调用 `douyin__douyin_feishu_route_text` 时应传入当前飞书消息的 `messageId` 和 `chatId`（通常来自消息元数据 `message_id` 与 `conversation_label/chat_id`）。传入后，二维码、短信、发布完成、数据报告和自动回复统计都会发回触发来源。

如果模型只传了 `text`，MCP 会从 OpenClaw 最近飞书会话日志中兜底推断来源，优先使用最近匹配原文的群聊/私聊。参数和近期日志都拿不到来源时，才回退到 `DOUYIN_FEISHU_RECEIVE_ID`。

## 常见安装命令

如果宿主机还没有 Node 或浏览器，可以先补前置，再跑自举：

```bash
sudo apt update
sudo apt install -y curl ca-certificates gnupg

if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt install -y nodejs
fi

if ! command -v google-chrome >/dev/null 2>&1 && ! command -v chromium >/dev/null 2>&1; then
  sudo snap install chromium --classic || sudo apt install -y chromium-browser
fi

cd ~/.openclaw/workspace/skills/douyin-upload-mcp-skill
cp .env.example .env.local
# 编辑 .env.local，填写目标机器自己的飞书、模型、多维表、小冰/Coze 配置
npm install
node scripts/bootstrap-openclaw.js --apply
node scripts/preflight.js --online
node scripts/agent-ready.js
```

如果是通过 `openclaw skills install` 安装，目录通常是：

```bash
cd ~/.openclaw/workspace/skills/douyin-upload-mcp-skill
```

## 运行原理

- `Node`：运行 skill 脚本、MCP server、daemon
- `浏览器`：真正执行抖音网页操作
- `daemon`：管理浏览器生命周期，自动拉起和释放
- `OpenClaw gateway`：接收飞书消息并路由到 skill

## 主要工具

### 飞书单入口

- `douyin__douyin_feishu_route_text`

### 登录与二维码

- `douyin__douyin_check_login`
- `douyin__douyin_fresh_qr`

### 发布

- `douyin__douyin_publish_video`
- `douyin__douyin_publish_from_upstream_text`
- `douyin__douyin_publish_job_status`
- `douyin__douyin_publish_imagetext`

### 数据

- `douyin__douyin_data_analysis`
- `douyin__douyin_sync_data_to_feishu_bitable`
- `douyin__douyin_data_report_from_feishu_bitable`

### 评论 / 私信 / 自动回复

- `douyin__douyin_comment_list`
- `douyin__douyin_comment_reply`
- `douyin__douyin_dm_list`
- `douyin__douyin_dm_reply`
- `douyin__douyin_auto_reply`

### 数字人自动化营销

- `douyin__douyin_persona_flow`
- `douyin__douyin_marketing_controller`
- `douyin__douyin_digital_human_training`
- `douyin__douyin_xiaoice_video_produce`

### 调试

- `douyin__douyin_probe`
- `douyin__douyin_screenshot`

### 截图排查

当页面卡住、验证码异常、中文显示方块、按钮不可点、弹窗挡路时，先截图再判断。

可用方式：

- MCP：`douyin__douyin_screenshot`
- 命令行：`node scripts/douyin-cli.js screenshot`

截图默认保存到 `OUTPUT_DIR`，OpenClaw 飞书模式下也可以把截图直接发回当前会话。

## 飞书触发词

- `发布抖音`
- `发送二维码`
- `已登录`
- 6 位验证码
- `发布视频`
- `更新数据`
- `数据报告`
- `生成人设`
- `训练数字人`
- `开启自动化营销`
- `自动回复评论`
- `自动回复私信`
- `定时任务`

## 重要规则

- OpenClaw 飞书模式下只保留一个飞书入口，不要同时启动 watcher
- 二维码只能在客户明确回复 `发送二维码` 后发送
- 字段化发布任务里有 `封面图片` 时，必须上传并验证封面
- 评论自动回复默认处理抖音创作者中心新增未回复评论和未读私信；若评论筛选失败，会回退到可见评论的作者回复检测，避免重复回复
- 数据报告会先生成基础数字汇总，再用 OpenClaw 当前模型（如 MiniMax-M2.7）生成增强分析；不要用 Codex/GPT 输出替代 OpenClaw/MiniMax 验收结果
- 自动回复优先使用 OpenClaw/MiniMax 或兼容接口生成简短互动回复；未配置或失败时自动回落到确定性规则
- 自动化营销正式开启前必须已生成人设，并提供本人照片完成数字人训练、绑定客户数字人 ID，或明确确认使用默认测试数字人
- 未配置 Coze/小冰 API 时，数字人训练和一键成片不可用；基础发布、登录、数据、评论/私信功能可独立配置使用
- 任何关键闭环都要实测，连续 3 次成功才算通过

## 参考文档

- `[SKILL.md](SKILL.md)`
- `[references/login-feishu.md](references/login-feishu.md)`
- `[references/publish-flow.md](references/publish-flow.md)`
- `[references/data-interactions.md](references/data-interactions.md)`
- `[references/multica.md](references/multica.md)`
- `[references/pitfalls.md](references/pitfalls.md)`
