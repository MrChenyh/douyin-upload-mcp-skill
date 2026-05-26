# 抖音自动运营 Skill 小白安装教程

这份教程给已经装好 OpenClaw、并且已经接好飞书机器人的客户使用。

## 你会得到什么

- 自动发布抖音：飞书发 `发布抖音`，按提示扫码、发视频或字段化任务。
- 获取数据生成分析：飞书发 `更新数据` 或 `数据报告`。
- 自动回复评论：飞书发 `自动回复评论`。
- 自动回复私信：飞书发 `自动回复私信`。
- 数字人自动化营销：飞书发 `生成人设`、`训练数字人`、`开启自动化营销`。
- 定时任务：默认每 30 分钟自动回复新评论/私信；开启自动化营销后，每天 07:30 自动生成视频，待你确认后发布。

## 第 1 步：安装基础环境

如果你的机器是 Ubuntu / WSL Ubuntu，先执行这一段：

```bash
sudo apt update
sudo apt install -y curl ca-certificates gnupg git

if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt install -y nodejs
fi

if ! command -v google-chrome >/dev/null 2>&1 && ! command -v chromium >/dev/null 2>&1; then
  sudo snap install chromium --classic || sudo apt install -y chromium-browser
fi
```

如果你已经能运行 `node -v`，并且电脑里有 Chrome / Edge / Chromium，可以跳过这一步。

## 第 2 步：放入 skill

把 `douyin-upload-mcp-skill` 文件夹放到：

```text
~/.openclaw/skills/douyin-upload-mcp-skill
```

如果是从 GitHub 安装，可以用：

```bash
mkdir -p ~/.openclaw/skills
cd ~/.openclaw/skills
git clone <你的仓库地址> douyin-upload-mcp-skill
```

## 第 3 步：一键自举

```bash
cd ~/.openclaw/skills/douyin-upload-mcp-skill
npm install
node scripts/bootstrap-openclaw.js --apply
node scripts/preflight.js --online
node scripts/agent-ready.js
```

这一步会自动完成：

- 注册 OpenClaw MCP 工具。
- 启动抖音浏览器守护进程。
- 检查飞书配置。
- 检查中文字体，避免浏览器截图中文变方块。
- 检查数据分析所需的飞书多维表配置。

## 第 4 步：开启默认定时任务

```bash
node scripts/douyin-schedule-manager.js install-default
node scripts/douyin-schedule-manager.js status
```

默认任务：

- 每 30 分钟：检查新增未回复评论和未读私信，并按内容自动回复。
- 开启自动化营销后每天 07:30：自动生成视频，待你回复【确认发布】后发布。

## 第 5 步：在飞书里使用

常用指令：

```text
发布抖音
生成人设
训练数字人
开启自动化营销
更新数据
数据报告
自动回复
自动回复评论
自动回复私信
截图
定时任务
```

修改定时任务：

```text
修改定时任务 自动回复 30分钟
修改定时任务 自动化营销 07:30
关闭定时任务
开启定时任务
```

字段化发布任务格式：

```text
tags:#宠物险#保险
"封面图片": "https://example.com/cover.png"
标题："养宠不焦虑的秘诀？"
"视频地址": "https://example.com/video.mp4"
```

数字人训练材料格式：

```text
姓名：张三
照片：https://example.com/photo.jpg
性别：男
年龄：35
从业年限：8年
主营业务：...
核心优势：...
目标客户：...
个人特质：...
经验案例：...
IP核心诉求：...
禁忌与偏好：...
```

先发送上述信息生成人设，系统会返回账号定位方案并等待用户确认。用户回复 `确认人设` 后，系统会自动用已确认人设和本人照片请求 Coze 生成训练视频，并提交小冰质检和训练；客户已有数字人时也可以直接发送 `绑定数字人ID xxxxx`。默认 model id 只用于 demo、应急降级或稳定性 dry-run。

## 登录提醒

首次使用或登录失效时：

1. 飞书发 `发布抖音`。
2. 系统提示准备扫码后，回复 `发送二维码`。
3. 在电脑端飞书查看二维码，用手机抖音 App 扫码。
4. 扫码确认后回复 `已登录`。
5. 如果需要短信验证码，直接回复 6 位数字。

注意：抖音手机端通常不能直接扫描同一台手机相册里的二维码，所以建议在电脑端飞书查看二维码。

## 常见问题

### 飞书没反应

运行：

```bash
node scripts/openclaw-douyin-health.js --fix --restart-gateway
```

然后在飞书重新发送上一条指令。

### 浏览器没有打开或连接失败

运行：

```bash
node scripts/bootstrap-openclaw.js --apply
node scripts/openclaw-douyin-health.js --fix --restart-gateway
```

### 二维码过期

飞书回复：

```text
发送二维码
```

系统会重新获取最新二维码，不要使用旧图。

### 想看当前页面

飞书发送：

```text
截图
```

系统会把当前抖音页面截图发回飞书。

### 定时任务不确定有没有开启

飞书发送：

```text
定时任务
```

或命令行执行：

```bash
node scripts/douyin-schedule-manager.js status
```
