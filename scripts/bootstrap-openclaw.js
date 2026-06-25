#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import '../src/config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const home = homedir();
const args = new Set(process.argv.slice(2));
const apply = args.has('--apply');
const skipPreflight = args.has('--skip-preflight');
const nodeBin = process.execPath;
const stateDir = process.env.DOUYIN_MONITOR_STATE_DIR || join(home, '.openclaw', 'workspace', 'social-auto-publish');
const browserDebugPort = process.env.BROWSER_DEBUG_PORT || '40821';
const daemonPort = process.env.DAEMON_PORT || '40225';
const browserUserDataDir = process.env.BROWSER_USER_DATA_DIR || join(home, '.wjz_browser_data');
const openclawConfigPath = process.env.OPENCLAW_CONFIG_PATH || join(home, '.openclaw', 'openclaw.json');

function run(command, commandArgs = [], opts = {}) {
  const nodeDir = dirname(nodeBin);
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') || 'PATH';
  return spawnSync(command, commandArgs, {
    cwd: opts.cwd || root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: opts.timeout || 120000,
    windowsHide: true,
    env: {
      ...process.env,
      [pathKey]: `${nodeDir}${process.platform === 'win32' ? ';' : ':'}${process.env[pathKey] || ''}`,
      ...(opts.env || {}),
    },
  });
}

function check(name, ok, detail = '', fix = '') {
  return { name, ok: Boolean(ok), detail, fix };
}

function firstExisting(paths) {
  return paths.find((item) => item && existsSync(item)) || '';
}

function detectBrowser() {
  if (process.platform === 'win32') {
    return firstExisting([
      process.env.BROWSER_PATH,
      join(process.env.PROGRAMFILES || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(process.env['PROGRAMFILES(X86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(process.env.PROGRAMFILES || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(process.env['PROGRAMFILES(X86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ]);
  }
  return firstExisting([
    process.env.BROWSER_PATH,
    '/usr/bin/microsoft-edge',
    '/usr/bin/microsoft-edge-stable',
    '/opt/microsoft/msedge-beta/msedge',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ]);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function backupPath(path) {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `${path}.bak-social-auto-publish-${stamp}`;
}

function desiredMcpEnv(currentEnv = {}) {
  const browser = detectBrowser();
  return {
    ...currentEnv,
    ...(browser ? { BROWSER_PATH: browser } : {}),
    BROWSER_DEBUG_PORT: browserDebugPort,
    DAEMON_PORT: daemonPort,
    BROWSER_USER_DATA_DIR: browserUserDataDir,
    BROWSER_HEADLESS: 'false',
    OUTPUT_DIR: join(stateDir, 'output'),
    DOUYIN_MONITOR_STATE_DIR: stateDir,
  };
}

function desiredMcpServer(currentServer = {}) {
  return {
    ...currentServer,
    command: nodeBin,
    args: [join(root, 'src', 'mcp-server.js')],
    cwd: root,
    env: desiredMcpEnv(currentServer.env || {}),
  };
}

function mcpServerLooksConfigured(server) {
  if (!server || typeof server !== 'object') return false;
  const desired = desiredMcpServer(server);
  const envKeys = Object.keys(desired.env || {});
  return server.command === desired.command
    && JSON.stringify(server.args || []) === JSON.stringify(desired.args)
    && server.cwd === desired.cwd
    && envKeys.every((key) => server.env?.[key] === desired.env[key]);
}

function summarizeMcpServer(server) {
  return {
    command: server?.command || '',
    argsOk: JSON.stringify(server?.args || []) === JSON.stringify([join(root, 'src', 'mcp-server.js')]),
    cwdOk: server?.cwd === root,
    envKeys: Object.keys(server?.env || {}).sort(),
  };
}

function ensureNpmInstall(checks) {
  const modulesOk = existsSync(join(root, 'node_modules', 'puppeteer-core'));
  if (modulesOk) {
    checks.push(check('node_dependencies', true, 'node_modules present'));
    return;
  }
  if (!apply) {
    checks.push(check('node_dependencies', false, 'node_modules missing', 'Run npm install, or rerun bootstrap with --apply.'));
    return;
  }
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const installArgs = existsSync(join(root, 'package-lock.json')) ? ['ci'] : ['install'];
  const npm = run(npmCmd, installArgs, { timeout: 300000 });
  checks.push(check(
    'node_dependencies',
    npm.status === 0 && existsSync(join(root, 'node_modules', 'puppeteer-core')),
    (npm.stdout || npm.stderr).slice(-1000),
    `npm ${installArgs.join(' ')} failed; check network/npm registry.`,
  ));
}

function ensureBrowser(checks) {
  const browser = detectBrowser();
  checks.push(check(
    'browser_executable',
    Boolean(browser),
    browser || '(not found)',
    'Install Microsoft Edge/Chrome/Chromium, or set BROWSER_PATH in .env.local.',
  ));
}

function checkOpenClawConfig(checks) {
  if (!existsSync(openclawConfigPath)) {
    checks.push(check('openclaw_config', false, openclawConfigPath, 'Install/configure OpenClaw first, or use this skill directly with node src/mcp-server.js.'));
    return false;
  }

  let cfg;
  try {
    cfg = readJson(openclawConfigPath);
  } catch (err) {
    checks.push(check('openclaw_config', false, err.message, 'Fix OpenClaw JSON config syntax.'));
    return false;
  }

  const current = cfg.mcp?.servers?.social_auto_publish || cfg.mcp?.servers?.douyin;
  const configured = mcpServerLooksConfigured(current);
  if (!apply) {
    checks.push(check(
      'openclaw_mcp_registration',
      configured,
      JSON.stringify(summarizeMcpServer(current)).slice(0, 500),
      'Rerun bootstrap with --apply to register mcp.servers.social_auto_publish.',
    ));
    return false;
  }

  let changed = false;
  if (!configured) {
    const backup = backupPath(openclawConfigPath);
    writeFileSync(backup, `${JSON.stringify(cfg, null, 2)}\n`);
    cfg.mcp = cfg.mcp || {};
    cfg.mcp.servers = cfg.mcp.servers || {};
    cfg.mcp.servers.social_auto_publish = desiredMcpServer(current || {});
    writeFileSync(openclawConfigPath, `${JSON.stringify(cfg, null, 2)}\n`);
    changed = true;
  }

  const after = readJson(openclawConfigPath);
  const afterServer = after.mcp?.servers?.social_auto_publish;
  checks.push(check(
    'openclaw_mcp_registration',
    mcpServerLooksConfigured(afterServer),
    JSON.stringify(summarizeMcpServer(afterServer)).slice(0, 500),
    'Check mcp.servers.social_auto_publish in OpenClaw config.',
  ));
  return changed;
}

async function main() {
  const checks = [];
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  checks.push(check('node_version', nodeMajor >= 22, process.versions.node, 'Use Node.js 22+.'));

  ensureNpmInstall(checks);
  ensureBrowser(checks);
  mkdirSync(join(stateDir, 'output'), { recursive: true });
  mkdirSync(join(stateDir, 'logs'), { recursive: true });
  checks.push(check('state_dir', existsSync(stateDir), stateDir));

  const mcpChanged = checkOpenClawConfig(checks);

  if (!skipPreflight) {
    const preflight = run(nodeBin, ['scripts/preflight.js'], { timeout: 240000 });
    const raw = preflight.stdout || preflight.stderr || '';
    checks.push(check(
      'skill_preflight',
      preflight.status === 0,
      raw.slice(-1200),
      'Configure missing browser/Python/social-auto-upload items reported by preflight.',
    ));
  }

  const blockers = checks.filter((item) => !item.ok).map((item) => ({ name: item.name, fix: item.fix, detail: item.detail }));
  console.log(JSON.stringify({
    ok: blockers.length === 0,
    applied: apply,
    root,
    stateDir,
    daemonPort,
    browserDebugPort,
    browserUserDataDir,
    openclawConfigPath,
    mcpChanged,
    copyToNewOpenClawFirstCommand: 'node scripts/bootstrap-openclaw.js --apply',
    humanRequired: [
      'First platform QR scan/login',
      'SMS verification when a platform requires it',
      'Security challenges such as slider/captcha',
    ],
    checks,
    blockers,
  }, null, 2));

  if (blockers.length) process.exitCode = 1;
}

main().catch((err) => {
  console.log(JSON.stringify({ ok: false, error: err.message, stack: err.stack }, null, 2));
  process.exitCode = 1;
});
