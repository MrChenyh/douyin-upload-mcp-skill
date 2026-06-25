import { spawn, spawnSync } from 'node:child_process';

const ENV_KEYS_TO_KEEP = [
  'HOME',
  'PATH',
  'USER',
  'LOGNAME',
  'SHELL',
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'XDG_RUNTIME_DIR',
  'DBUS_SESSION_BUS_ADDRESS',
  'OPENCLAW_CONFIG_PATH',
  'DOUYIN_MONITOR_STATE_DIR',
  'DOUYIN_PUBLISH_JOB_DIR',
  'DOUYIN_UPSTREAM_CACHE_DIR',
  'DOUYIN_UPLOAD_TIMEOUT_MS',
  'DOUYIN_ASSISTANT_TIMEOUT_MS',
  'DOUYIN_PUBLISH_TASK_TIMEOUT_MS',
  'DOUYIN_PUBLISH_JOB_TIMEOUT_MS',
  'DOUYIN_PUBLISH_HEARTBEAT_MS',
  'SAU_CLI_COMMAND',
  'SOCIAL_AUTO_UPLOAD_CLI_COMMAND',
  'SAU_CLI_TIMEOUT_MS',
  'SAU_PYTHON',
  'PLAYWRIGHT_DOWNLOAD_HOST',
  'BROWSER_DEBUG_PORT',
  'BROWSER_DEBUG_HOST',
  'BROWSER_PATH',
  'BROWSER_HEADLESS',
  'BROWSER_USER_DATA_DIR',
  'BROWSER_PROTOCOL_TIMEOUT',
  'DAEMON_PORT',
  'OUTPUT_DIR',
];

function sanitizeUnitName(name) {
  const clean = String(name || 'job')
    .replace(/[^A-Za-z0-9_.:-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 180);
  return clean || `job-${Date.now()}`;
}

function buildEnvArgs(extraEnv = {}) {
  const merged = { ...process.env, ...extraEnv };
  const args = [];
  for (const key of ENV_KEYS_TO_KEEP) {
    const value = merged[key];
    if (value !== undefined && value !== null && String(value) !== '') {
      args.push(`--setenv=${key}=${String(value)}`);
    }
  }
  return args;
}

export function startBackgroundNodeJob({
  scriptPath,
  args = [],
  cwd,
  unitName,
  description,
  env = {},
  runtimeMaxSec = 1800,
}) {
  const unit = sanitizeUnitName(unitName);
  const command = [process.execPath, scriptPath, ...args];
  const systemdArgs = [
    '--user',
    '--collect',
    '--no-block',
    `--unit=${unit}`,
    `--description=${description || unit}`,
    `--working-directory=${cwd}`,
    `--property=RuntimeMaxSec=${runtimeMaxSec}`,
    ...buildEnvArgs(env),
    ...command,
  ];
  const systemd = spawnSync('systemd-run', systemdArgs, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (systemd.status === 0) {
    return {
      ok: true,
      runner: 'systemd-run',
      unit,
      output: `${systemd.stderr || ''}${systemd.stdout || ''}`.trim(),
    };
  }

  const child = spawn(process.execPath, [scriptPath, ...args], {
    cwd,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, ...env },
  });
  child.unref();
  return {
    ok: true,
    runner: 'node-detached-fallback',
    pid: child.pid,
    systemdError: `${systemd.stderr || ''}${systemd.stdout || ''}`.trim(),
  };
}
