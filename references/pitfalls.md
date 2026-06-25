# Pitfalls And Generalization Rules

Read this when a publish workflow behaves strangely, a test fails, or a new agent is taking over.

## Scope

- This skill only publishes prepared media. Do not route content planning, data reporting, digital-human generation, marketing automation, comments, or DMs into this package.
- Do not expose stack traces, HTTP details, local cookie paths, or browser profile paths to end users.
- Platform security prompts are human blockers, not automation bugs to bypass.

## Login

- Refresh/regenerate QR before capture and run quality detection.
- Do not use QR images with gray overlay, refresh icon, expired state, abnormal size, or cropped edges.
- For SMS, click send/resend first. Fill only the latest 6-digit code and click confirm.
- Wait briefly before declaring logged in; require creator-backend or page signals.
- For Xiaohongshu, prefer visible browser mode because login and risk prompts often need human inspection.

## Browser And Environment

- Browser tasks are serial. Shared daemon/page means parallel tests can create fake navigation and focus failures.
- Reuse the skill daemon/CDP browser for Douyin. Do not start competing browser profiles for the same account.
- If `X Server` or `DISPLAY` fails on Linux/WSL, use `xvfb-run`, set `DOUYIN_USE_XVFB=true`, or run on a machine with a visible desktop.
- `Missing X server`, `acquire_failed`, `Not connected`, `Target closed`, and `Session closed` are usually recoverable browser failures. Restart the daemon and retry before reporting permanent failure.
- In sandboxes, redirect `DOUYIN_MONITOR_STATE_DIR`, `OUTPUT_DIR`, and `BROWSER_USER_DATA_DIR` to writable directories.

## Douyin Publish

- Close popups, overlays, exit prompts, and guide panels before clicking page controls.
- Avoid refresh/back/exit/top-page buttons unless explicitly intended.
- Confirm upload input, title, description, topics, and cover by reading page state.
- If custom cover exists, it must be uploaded, saved, and verified. Failure blocks publish unless the user explicitly allows fallback.
- Custom cover save is not complete until any `是否确认应用此封面？` dialog is confirmed and disappears.
- Stability tests should include `coverImagePath`; otherwise they do not prove field `封面图片` works.
- If the upload page shows `你还有上次未发布的视频，是否继续编辑？`, fresh upload must either click `放弃` and verify the prompt disappeared, or resume the draft intentionally.
- If upload returns `上传失败，重新上传`, clean the failed draft and retry upload once before failing.
- The publish assistant progress can stall below 100%. After video upload is complete, if the real publish button is visible after the soft timeout, publish instead of waiting indefinitely.
- Set `BROWSER_PROTOCOL_TIMEOUT=1200000` before daemon startup for real publishing. The default 300000ms can cause false `Runtime.callFunctionOn timed out` failures on large videos.
- The bottom publish control lives in a `发布暂存离开` area. If a mouse click returns to upload while preserving a draft, resume the draft and use DOM/React fallback.
- `publish-state` must not treat `/content/manage` or `加载中，请稍候` as success. With a title, success means the title is found in the works list.
- Do not use synchronous low-level MCP for long fieldized publishing. Use async job entry plus status polling.
- Fieldized publish text must use the async job entry or task scripts so `封面图片` becomes `coverImagePath`.
- Publish can require SMS after all fields, cover, tags, and upload are ready. This is a resumable draft state, not an immediate publish failure.
- In publish SMS verification, ignore the bottom red `发送短信验证` link. Click the input-row `获取验证码` / `发送验证码` / `接收短信验证码` control instead.
- Publish success requires toast/API/management-page title verification, not just a clickable button.

## SAU Platforms

- Always run `scripts/sau-publish-wrapper.js doctor` before diagnosing platform-specific failures.
- Run `login` then `check` for each target account before publishing.
- Xiaohongshu should be headed unless a target machine has already proven headless stability.
- Treat captcha, slider, account risk, and platform policy prompts as `needs_user_action`.
- WeChat Channels image-text publishing is out of scope for this package.

## Validation

- `node scripts/preflight.js` checks local dependencies and syntax, not real platform publishing.
- `node scripts/run-publish-task-stability.js --rounds 3` without `--execute` is a dry-run.
- Real acceptance requires a logged-in account and human cooperation for QR, SMS, and security verification.
- Critical publish fixes should be tested with 3 consecutive successful real submissions when the user explicitly asks for real validation.
