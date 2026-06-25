# Social Auto Publish Skill

面向 Codex / OpenClaw 的多平台自动发布 Skill，聚焦发布链路本身：账号登录检查、素材准备、视频/图文发布、二维码/短信/安全验证处理、异步发布任务和发布结果查询。

这个仓库由原 `douyin-upload-mcp-skill` 收束而来。新项目名建议使用 `social-auto-publish-skill`；当前 GitHub 仓库地址仍可继续使用，后续可以在 GitHub 设置里把仓库名改掉。

## 支持平台

| 平台 | 视频 | 图文 | 说明 |
|---|---:|---:|---|
| 抖音 | 支持 | 支持 | 内置 CDP 发布链路，支持字段化任务、自定义封面、发布验证 |
| 小红书 | 支持 | 支持 | 通过 `vendor/social-auto-upload`，建议可见浏览器发布 |
| 快手 | 支持 | 支持 | 通过 `vendor/social-auto-upload` |
| 视频号 | 支持 | 暂不支持 | 通过 `scripts/tencent-embedded-publish.js` 或 SAU `tencent` 视频发布 |

不包含：数字人、一键成片、自动化营销、数据分析、评论/私信自动回复、飞书多维表同步、定时运营任务。

## 快速开始

```bash
git clone https://github.com/MrChenyh/douyin-upload-mcp-skill.git social-auto-publish-skill
cd social-auto-publish-skill
npm install
node scripts/preflight.js
node scripts/agent-ready.js
```

启动 MCP：

```bash
node src/mcp-server.js
```

注册到 OpenClaw：

```bash
node scripts/bootstrap-openclaw.js --apply
```

自举脚本会把 MCP server 注册为 `social_auto_publish`，入口脚本为 `src/mcp-server.js`。

## 抖音字段化发布

上游 agent 可以直接传字段化文本：

```text
tags:#宠物险#保险
"封面图片": "https://example.com/cover.png"
标题："养宠不焦虑的秘诀？"
"视频地址": "https://example.com/video.mp4"
```

推荐 MCP 流程：

1. 调用 `douyin_publish_from_upstream_text({ text })`。
2. 用返回的 `jobId` 轮询 `douyin_publish_job_status({ jobId })`。
3. 等到 `status=succeeded`、`failed` 或 `blocked` 后再告知结果。

命令行等价流程：

```bash
node scripts/prepare-upstream-publish-task.js --input upstream.txt --output publish-task.json
node scripts/validate-publish-task.js --task publish-task.json
node scripts/publish-task.js --task publish-task.json --execute
```

真实发布可能因为上传、转码、发文助手检测、短信验证耗时很久。不要把一次真实发布包在很短的同步请求里。

## 多平台发布

先检查发布引擎：

```bash
node scripts/sau-publish-wrapper.js doctor
```

登录和检查账号：

```bash
node scripts/sau-publish-wrapper.js login --platform xiaohongshu --account default
node scripts/sau-publish-wrapper.js check --platform kuaishou --account default
```

发布视频：

```bash
node scripts/sau-publish-wrapper.js publish-video --platform xiaohongshu --account default --file /abs/video.mp4 --title "标题" --desc "简介" --tags "标签1,标签2" --headed
```

发布图文：

```bash
node scripts/sau-publish-wrapper.js publish-note --platform kuaishou --account default --images /abs/1.png,/abs/2.png --title "标题" --note "正文" --tags "标签1,标签2"
```

## 本地抖音发布控制台

```bash
npm run local:publish-console
```

浏览器打开：`http://127.0.0.1:3766`

这个控制台只做抖音本地发布：打开登录页、检查登录态、上传或填写视频、查看发布 job 状态。

## MCP 工具

常用工具：

- `douyin_check_login`
- `douyin_fresh_qr`
- `douyin_publish_video`
- `douyin_publish_imagetext`
- `douyin_publish_from_upstream_text`
- `douyin_publish_job_status`
- `social_publish_account`
- `social_publish_with_sau`

不同宿主可能会加 server 前缀，例如 `social_auto_publish__douyin_check_login`。

## 配置

复制模板：

```bash
cp .env.example .env.local
```

常用变量：

```env
BROWSER_PATH=
BROWSER_DEBUG_PORT=40821
BROWSER_USER_DATA_DIR=
BROWSER_HEADLESS=false
BROWSER_PROTOCOL_TIMEOUT=1200000
OUTPUT_DIR=
DAEMON_PORT=40225
DOUYIN_MONITOR_STATE_DIR=
SAU_CLI_COMMAND=
SOCIAL_AUTO_UPLOAD_CLI_COMMAND=
```

公开仓库不要提交 `.env`、`.env.local`、浏览器用户数据、cookies、日志、`node_modules`、`.runtime`、`dist` 或发布输出文件。

## 验证

```bash
node scripts/preflight.js
node scripts/validate-publish-task.js --task templates/publish-task.stability.json
node scripts/run-publish-task-stability.js --task templates/publish-task.stability.json --rounds 3
```

`templates/sample-media/` 里的文件只是 fresh clone 后用于结构校验的占位文件，不是可发布素材。真实 `--execute` 前请把模板里的视频和封面路径换成真实文件。

真实发布验收需要真人配合扫码、短信验证码或安全验证。dry-run 通过不等于平台真实发布通过。

## 参考文档

- `SKILL.md`：给 Codex/OpenClaw agent 使用的核心说明
- `references/publish-flow.md`：抖音发布页行为、封面、按钮、验证规则
- `references/publish-task.md`：发布任务 JSON 契约
- `references/customer-install-guide.md`：客户安装说明
- `references/pitfalls.md`：发布链路常见坑
