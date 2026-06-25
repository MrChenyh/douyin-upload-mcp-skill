# 多平台自动发布 Skill 安装指南

这份指南给需要在本机或 OpenClaw 环境里使用自动发布功能的用户。

## 你会得到什么

- 抖音自动发布：字段化视频任务、本地视频任务、自定义封面、发布状态查询。
- 小红书/快手自动发布：视频和图文，通过 `social-auto-upload`。
- 视频号自动发布：视频发布。
- 登录辅助：二维码、短信验证码、安全验证阻塞状态。

不包含数字人、内容生成、营销自动化、数据分析、评论/私信回复或定时运营任务。

## 第 1 步：基础环境

需要 Node.js 22+、Chrome / Edge / Chromium、Python 3 和 Pillow。Ubuntu / WSL Ubuntu 可参考：

```bash
sudo apt update
sudo apt install -y curl ca-certificates gnupg git python3 python3-pip

NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)"
if [ "$NODE_MAJOR" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt install -y nodejs
fi

if ! command -v google-chrome >/dev/null 2>&1 && ! command -v chromium >/dev/null 2>&1; then
  sudo snap install chromium --classic || sudo apt install -y chromium-browser
fi
```

Windows 上只要能运行 Node.js 22+，并安装 Edge 或 Chrome 即可。

## 第 2 步：获取 Skill

GitHub 手工安装：

```bash
mkdir -p ~/openclaw-skills
cd ~/openclaw-skills
git clone https://github.com/MrChenyh/douyin-upload-mcp-skill.git social-auto-publish-skill
cd social-auto-publish-skill
```

如果 GitHub 仓库之后已经改名，直接使用新的仓库 URL 即可。

## 第 3 步：安装依赖并检查

```bash
npm install
cp .env.example .env.local
node scripts/preflight.js
node scripts/agent-ready.js
```

如果你只想把 MCP 注册到 OpenClaw：

```bash
node scripts/bootstrap-openclaw.js --apply
```

注册后的 MCP server 名称是 `social_auto_publish`。

## 第 4 步：配置 social-auto-upload

先检查发布引擎：

```bash
node scripts/sau-publish-wrapper.js doctor
```

如果提示缺少 Python 依赖，进入 vendored SAU 目录安装：

```bash
cd vendor/social-auto-upload
python3 -m pip install -r requirements.txt
cd ../..
```

也可以使用外部 `sau` 命令，并在 `.env.local` 里设置：

```env
SAU_CLI_COMMAND=sau
```

## 第 5 步：登录平台账号

每个平台都建议先登录并检查：

```bash
node scripts/sau-publish-wrapper.js login --platform xiaohongshu --account default
node scripts/sau-publish-wrapper.js check --platform xiaohongshu --account default

node scripts/sau-publish-wrapper.js login --platform kuaishou --account default
node scripts/sau-publish-wrapper.js check --platform kuaishou --account default

node scripts/sau-publish-wrapper.js login --platform tencent --account default
node scripts/sau-publish-wrapper.js check --platform tencent --account default
```

抖音也可以使用本 Skill 的原生登录检查：

```bash
node scripts/douyin-login-monitor.js check
node scripts/douyin-login-monitor.js fresh-qr --customer-ready
```

二维码图片会返回本机路径。请在宿主界面里展示该图片，或让用户打开图片扫码。

## 第 6 步：发布

抖音字段化发布：

```bash
node scripts/prepare-upstream-publish-task.js --input upstream.txt --output publish-task.json
node scripts/validate-publish-task.js --task publish-task.json
node scripts/publish-task.js --task publish-task.json --execute
```

字段化文本示例：

```text
tags:#宠物险#保险
"封面图片": "https://example.com/cover.png"
标题："养宠不焦虑的秘诀？"
"视频地址": "https://example.com/video.mp4"
```

小红书/快手视频发布：

```bash
node scripts/sau-publish-wrapper.js publish-video --platform xiaohongshu --account default --file /abs/video.mp4 --title "标题" --desc "简介" --tags "标签1,标签2" --headed
node scripts/sau-publish-wrapper.js publish-video --platform kuaishou --account default --file /abs/video.mp4 --title "标题" --desc "简介" --tags "标签1,标签2"
```

图文发布：

```bash
node scripts/sau-publish-wrapper.js publish-note --platform xiaohongshu --account default --images /abs/1.png,/abs/2.png --title "标题" --note "正文" --tags "标签1,标签2" --headed
```

视频号视频发布：

```bash
node scripts/sau-publish-wrapper.js publish-video --platform tencent --account default --file /abs/video.mp4 --title "标题" --desc "简介" --tags "标签1,标签2"
```

## 本地抖音发布控制台

```bash
npm run local:publish-console
```

打开 `http://127.0.0.1:3766`，可以上传视频、填写标题/简介/tags、打开登录页并查看发布 job。

## 常见问题

### 二维码过期

重新执行：

```bash
node scripts/douyin-login-monitor.js fresh-qr --customer-ready
```

### 浏览器无法启动

运行：

```bash
node scripts/preflight.js
```

检查 `browser_executable`、`display_or_xvfb`、`browser_user_data_dir_writable`。

### 发布卡在短信或安全验证

这是平台要求的人工动作。请在可见浏览器中完成验证码、扫码确认、滑块或风控提示后，再重新检查状态或继续发布。

### 真实发布很久没结束

大视频上传、转码和发文助手检测可能很慢。优先使用 MCP 异步入口 `douyin_publish_from_upstream_text`，再轮询 `douyin_publish_job_status`。
