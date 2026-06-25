# Local Configuration Template

Copy this file or `.env.example` to `.env.local` on the target machine.

```env
# Browser / Douyin daemon
BROWSER_PATH=
BROWSER_DEBUG_HOST=127.0.0.1
BROWSER_DEBUG_PORT=40821
BROWSER_USER_DATA_DIR=
BROWSER_HEADLESS=false
BROWSER_PROTOCOL_TIMEOUT=1200000
OUTPUT_DIR=
DAEMON_PORT=40225
DOUYIN_MONITOR_STATE_DIR=
DOUYIN_UPSTREAM_CACHE_DIR=
DOUYIN_USE_XVFB=true

# Douyin publish timeouts
DOUYIN_UPLOAD_TIMEOUT_MS=1800000
DOUYIN_ASSISTANT_TIMEOUT_MS=600000
DOUYIN_PUBLISH_TASK_TIMEOUT_MS=3600000
DOUYIN_PUBLISH_JOB_TIMEOUT_MS=3900000
DOUYIN_PUBLISH_HEARTBEAT_MS=30000

# social-auto-upload / SAU
# Leave blank to use bundled vendor/social-auto-upload/sau_cli.py when possible.
SAU_CLI_COMMAND=
SOCIAL_AUTO_UPLOAD_CLI_COMMAND=
SAU_CLI_TIMEOUT_MS=3600000
PLAYWRIGHT_DOWNLOAD_HOST=https://npmmirror.com/mirrors/playwright

# Local Douyin console
LOCAL_PUBLISH_CONSOLE_PORT=3766
LOCAL_PUBLISH_CONSOLE_STATE_DIR=
```

Do not store platform cookies, browser user data, `.env.local`, or SAU runtime cookie files in a public package.
