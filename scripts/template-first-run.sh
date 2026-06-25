#!/usr/bin/env bash
set -euo pipefail

HOME_DIR="${HOME}"
SKILL_DIR="${SOCIAL_AUTO_PUBLISH_SKILL_DIR:-${HOME_DIR}/.openclaw/skills/social-auto-publish-skill}"
STATE_DIR="${DOUYIN_MONITOR_STATE_DIR:-${HOME_DIR}/.openclaw/workspace/social-auto-publish}"
BROWSER_DIR="${BROWSER_USER_DATA_DIR:-${HOME_DIR}/.wjz_browser_data}"

if [ ! -f "${SKILL_DIR}/SKILL.md" ]; then
  echo "missing skill: ${SKILL_DIR}" >&2
  exit 1
fi

mkdir -p "${STATE_DIR}/logs" "${STATE_DIR}/output" "${BROWSER_DIR}" "${HOME_DIR}/.openclaw"

export DOUYIN_MONITOR_STATE_DIR="${STATE_DIR}"
export BROWSER_USER_DATA_DIR="${BROWSER_DIR}"
export BROWSER_DEBUG_PORT="${BROWSER_DEBUG_PORT:-40821}"
export BROWSER_PROTOCOL_TIMEOUT="${BROWSER_PROTOCOL_TIMEOUT:-1200000}"
export DAEMON_PORT="${DAEMON_PORT:-40225}"
export DOUYIN_USE_XVFB="${DOUYIN_USE_XVFB:-true}"

cd "${SKILL_DIR}"

npm install
node scripts/bootstrap-openclaw.js --apply || true
node scripts/preflight.js || true
node scripts/agent-ready.js || true

cat <<'MSG'
Social Auto Publish first run finished.
Next steps:
1. Log in each target platform with scripts/sau-publish-wrapper.js login --platform <platform> --account default.
2. For Douyin-only local publishing, run npm run local:publish-console.
MSG
