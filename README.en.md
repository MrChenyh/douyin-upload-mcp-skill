# Social Auto Publish Skill

A Codex / OpenClaw skill for automatic social publishing. It focuses only on publishing: account login checks, media preparation, video or image-text upload, Douyin QR/SMS/security blockers, asynchronous publish jobs, and publish-status queries.

This repository was originally named `douyin-upload-mcp-skill`. The recommended project name is now `social-auto-publish-skill`; the existing GitHub URL can keep working until the repository is renamed in GitHub settings.

## Supported Platforms

| Platform | Video | Image-text | Notes |
|---|---:|---:|---|
| Douyin | yes | yes | Native CDP publisher with fieldized tasks, custom cover handling, and publish verification |
| Xiaohongshu | yes | yes | Via bundled `vendor/social-auto-upload`; headed mode is recommended |
| Kuaishou | yes | yes | Via bundled `vendor/social-auto-upload` |
| WeChat Channels | yes | no | Via `scripts/tencent-embedded-publish.js` or SAU `tencent` video publishing |

Not included: digital humans, one-click video generation, marketing automation, data analysis, comment/DM auto-replies, Feishu Bitable sync, or scheduled operations.

## Quick Start

```bash
git clone https://github.com/MrChenyh/douyin-upload-mcp-skill.git social-auto-publish-skill
cd social-auto-publish-skill
npm install
node scripts/preflight.js
node scripts/agent-ready.js
```

Run the MCP server:

```bash
node src/mcp-server.js
```

Register it with OpenClaw:

```bash
node scripts/bootstrap-openclaw.js --apply
```

Bootstrap registers the MCP server as `social_auto_publish`.

## Douyin Fieldized Publishing

Upstream agents can provide text like:

```text
tags:#tag1#tag2
"封面图片": "https://example.com/cover.png"
标题："Post title"
"视频地址": "https://example.com/video.mp4"
```

Recommended MCP flow:

1. Call `douyin_publish_from_upstream_text({ text })`.
2. Poll `douyin_publish_job_status({ jobId })`.
3. Wait for `status=succeeded`, `failed`, or `blocked` before reporting the result.

CLI equivalent:

```bash
node scripts/prepare-upstream-publish-task.js --input upstream.txt --output publish-task.json
node scripts/validate-publish-task.js --task publish-task.json
node scripts/publish-task.js --task publish-task.json --execute
```

Real publishing may take a long time because of upload, transcode, assistant checks, SMS, or security verification. Avoid short synchronous request timeouts for real jobs.

## Multi-Platform Publishing

```bash
node scripts/sau-publish-wrapper.js doctor
node scripts/sau-publish-wrapper.js login --platform xiaohongshu --account default
node scripts/sau-publish-wrapper.js check --platform kuaishou --account default
node scripts/sau-publish-wrapper.js publish-video --platform xiaohongshu --account default --file /abs/video.mp4 --title "Title" --desc "Description" --tags "tag1,tag2" --headed
node scripts/sau-publish-wrapper.js publish-note --platform kuaishou --account default --images /abs/1.png,/abs/2.png --title "Title" --note "Body" --tags "tag1,tag2"
```

## Local Douyin Console

```bash
npm run local:publish-console
```

Open `http://127.0.0.1:3766`.

## MCP Tools

- `douyin_check_login`
- `douyin_fresh_qr`
- `douyin_publish_video`
- `douyin_publish_imagetext`
- `douyin_publish_from_upstream_text`
- `douyin_publish_job_status`
- `social_publish_account`
- `social_publish_with_sau`

Hosts may prefix tool names, for example `social_auto_publish__douyin_check_login`.

## Validation

```bash
node scripts/preflight.js
node scripts/validate-publish-task.js --task templates/publish-task.stability.json
node scripts/run-publish-task-stability.js --task templates/publish-task.stability.json --rounds 3
```

Files in `templates/sample-media/` are placeholders for fresh-clone schema validation only. Replace them with real media before passing `--execute`.

Dry-runs do not prove real platform publishing. Real validation needs a logged-in account and may require human QR, SMS, or security verification.
