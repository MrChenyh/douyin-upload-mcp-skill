---
name: social-auto-publish-skill
description: Multi-platform automatic publishing for Douyin, Xiaohongshu, Kuaishou, and WeChat Channels. Use when Codex/OpenClaw needs to log in to publishing platforms, prepare fieldized publish tasks, upload videos or image-text notes, handle Douyin QR/SMS/security verification, run guarded or asynchronous publishing jobs, or maintain the bundled social-auto-upload based publishing workflow. This skill is only for automatic publishing; it does not provide marketing automation, data analysis, auto-replies, digital-human generation, or content planning.
---

# Social Auto Publish Skill

Use this skill to publish prepared media to social platforms. Keep the workflow narrow: validate inputs, ensure the account is logged in, publish, then verify or report the exact blocker.

## Supported Targets

| Platform | Video | Image-text | Main path |
|---|---:|---:|---|
| Douyin | yes | yes | `src/` CDP publisher, `scripts/publish-task.js`, MCP tools |
| Xiaohongshu | yes | yes | `scripts/sau-publish-wrapper.js` / `vendor/social-auto-upload` |
| Kuaishou | yes | yes | `scripts/sau-publish-wrapper.js` / `vendor/social-auto-upload` |
| WeChat Channels | yes | no | `scripts/tencent-embedded-publish.js` or SAU `tencent` video |

## Fast Paths

Install and check:

```bash
npm install
node scripts/preflight.js
node scripts/agent-ready.js
```

Run MCP server:

```bash
node src/mcp-server.js
```

Run the local Douyin publish console:

```bash
npm run local:publish-console
```

Check and log in platform accounts through social-auto-upload:

```bash
node scripts/sau-publish-wrapper.js doctor
node scripts/sau-publish-wrapper.js login --platform xiaohongshu --account default
node scripts/sau-publish-wrapper.js check --platform kuaishou --account default
```

## Douyin Fieldized Publish

Prefer the async MCP path when an upstream agent provides text fields or remote URLs. It avoids long MCP request timeouts while video upload, transcode, and assistant checks are running.

Input shape:

```text
tags:#标签1#标签2
"封面图片": "https://example.com/cover.png"
标题："作品标题"
"视频地址": "https://example.com/video.mp4"
```

MCP flow:

1. Call `douyin_publish_from_upstream_text({ text })`.
2. Poll `douyin_publish_job_status({ jobId })` until `status` is `succeeded`, `failed`, or `blocked`.
3. Do not start a duplicate publish for the same fieldized text while a job is running.

CLI equivalent:

```bash
node scripts/prepare-upstream-publish-task.js --input upstream.txt --output publish-task.json
node scripts/validate-publish-task.js --task publish-task.json
node scripts/publish-task.js --task publish-task.json --execute
```

Read `references/publish-task.md` for the full JSON contract and `references/publish-flow.md` for page behavior, cover handling, SMS blockers, and success verification.

## Multi-Platform Publish

Use `scripts/sau-publish-wrapper.js` for Xiaohongshu, Kuaishou, and generic SAU-backed publishing. It also supports Douyin, but the native Douyin publisher is preferred when custom cover verification and management-page verification matter.

Examples:

```bash
node scripts/sau-publish-wrapper.js publish-video --platform xiaohongshu --account default --file /abs/video.mp4 --title "标题" --desc "简介" --tags "标签1,标签2" --headed
node scripts/sau-publish-wrapper.js publish-note --platform kuaishou --account default --images /abs/1.png,/abs/2.png --title "标题" --note "正文" --tags "标签1,标签2"
```

Rules:

- Use visible browser mode for Xiaohongshu login and publishing unless the user explicitly accepts headless risk.
- Treat captcha, slider, account risk, and SMS prompts as human blockers. Do not try to bypass platform security.
- WeChat Channels currently supports video publishing only.
- Verify platform account state before publishing; use `login` before `publish-*` when `check` fails.

## Douyin Publishing Rules

- Reuse this skill's daemon/CDP browser. Do not start competing browser profiles for Douyin tasks.
- Browser tasks are serial. Do not run login, screenshot, data entry, and publish jobs in parallel against the same page.
- Titles should stay within Douyin's visible 30-character limit. The converter, publish page, verification, and final status must use the same safe title.
- If `封面图片` or `cover.imagePath` is provided, upload and verify the custom cover. Do not silently fall back to AI recommended cover unless the user explicitly allows it.
- Fill topics through the page's topic control, not only as plain description hashtags.
- Publish success requires a success toast/API signal, management-page navigation plus title verification, or `douyin-cli verify-published --title`. Editor state alone is not success.
- Large videos may take 30-60 minutes. Use async job paths and long timeouts.

## Login And Blockers

- `douyin_check_login` reports `loggedIn`, `phase`, and a local `qrcodePath` when available.
- `douyin_fresh_qr` refreshes and returns a local QR image path. Show or send that image through the surrounding product if needed.
- If SMS appears during login or publishing, ask the human for the latest 6-digit code and pass it to `douyin_check_login` or `douyin-cli submit-sms-code`.
- If slider/captcha/risk verification appears, pause and ask the human to complete it in the visible browser.

## MCP Tools

The server name registered by bootstrap is `social_auto_publish`. Common tool names may be prefixed by the host as `social_auto_publish__...`.

- `douyin_check_login`
- `douyin_fresh_qr`
- `douyin_probe`
- `douyin_page_summary`
- `douyin_navigate_to`
- `douyin_reload_page`
- `douyin_screenshot`
- `douyin_publish_video`
- `douyin_publish_imagetext`
- `douyin_publish_from_upstream_text`
- `douyin_publish_job_status`
- `social_publish_account`
- `social_publish_with_sau`

## References

- Read `references/publish-flow.md` for Douyin publish-page behavior and verification rules.
- Read `references/publish-task.md` for the JSON task contract.
- Read `references/customer-install-guide.md` for customer-facing setup.
- Read `references/skill-local-config.md` when preparing `.env.local`.
- Read `references/pitfalls.md` when a browser, login, or publish task behaves strangely.

## Packaging Rules

Public GitHub packages must not contain `.env`, `.env.local`, browser user data, cookies, `vendor/social-auto-upload/cookies`, logs, `node_modules`, `.runtime`, `dist`, or generated publish output.
