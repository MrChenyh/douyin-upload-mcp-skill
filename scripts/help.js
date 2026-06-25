#!/usr/bin/env node

const text = `
Social Auto Publish Skill - quick usage

1. Install and check
   npm install
   node scripts/preflight.js
   node scripts/agent-ready.js

2. MCP server
   node src/mcp-server.js

   Main tools:
   - douyin_check_login
   - douyin_fresh_qr
   - douyin_publish_video
   - douyin_publish_imagetext
   - douyin_publish_from_upstream_text
   - douyin_publish_job_status
   - social_publish_account
   - social_publish_with_sau

3. Fieldized Douyin publish input
   tags:#宠物险#保险
   "封面图片": "https://example.com/cover.png"
   标题："养宠不焦虑的秘诀？"
   "视频地址": "https://example.com/video.mp4"

   Use MCP douyin_publish_from_upstream_text, then poll douyin_publish_job_status.

4. Local Douyin publish task
   node scripts/prepare-upstream-publish-task.js --input upstream.txt --output publish-task.json
   node scripts/validate-publish-task.js --task publish-task.json
   node scripts/publish-task.js --task publish-task.json --execute

5. Local Douyin publish console
   npm run local:publish-console
   Open http://127.0.0.1:3766

6. Multi-platform publishing with social-auto-upload
   node scripts/sau-publish-wrapper.js doctor
   node scripts/sau-publish-wrapper.js login --platform xiaohongshu --account default
   node scripts/sau-publish-wrapper.js check --platform kuaishou --account default
   node scripts/sau-publish-wrapper.js publish-video --platform xiaohongshu --file /abs/video.mp4 --title "标题" --desc "简介" --tags "标签1,标签2" --headed
   node scripts/sau-publish-wrapper.js publish-note --platform kuaishou --images /abs/1.png,/abs/2.png --title "标题" --note "正文" --tags "标签1,标签2"

7. Stability checks
   node scripts/validate-publish-task.js --task templates/publish-task.stability.json
   node scripts/run-publish-task-stability.js --task templates/publish-task.stability.json --rounds 3

Real publishing requires a logged-in browser and may require QR scan, SMS, or manual security verification.
`.trim();

console.log(text);
