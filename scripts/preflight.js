#!/usr/bin/env node
import { accessSync, constants, copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { platform, homedir } from 'node:os';
import config from '../src/config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const args = new Set(process.argv.slice(2));
const home = homedir();

function check(name, ok, detail = '', fix = '') {
  return { name, ok: Boolean(ok), detail, fix };
}

function canWrite(dir) {
  try {
    mkdirSync(dir, { recursive: true });
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function run(command, commandArgs = [], opts = {}) {
  return spawnSync(command, commandArgs, {
    cwd: opts.cwd || root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: opts.timeout || 120000,
    windowsHide: true,
    env: { ...process.env, ...(opts.env || {}) },
  });
}

function sauEnv() {
  const sauDir = join(root, 'vendor', 'social-auto-upload');
  const next = {
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
    PLAYWRIGHT_DOWNLOAD_HOST: process.env.PLAYWRIGHT_DOWNLOAD_HOST || 'https://npmmirror.com/mirrors/playwright',
  };
  next.PYTHONPATH = [sauDir, process.env.PYTHONPATH || ''].filter(Boolean).join(process.platform === 'win32' ? ';' : ':');
  return next;
}

function ensureSauConfig() {
  const sauDir = join(root, 'vendor', 'social-auto-upload');
  const confPath = join(sauDir, 'conf.py');
  if (existsSync(confPath)) return true;
  const examplePath = join(sauDir, 'conf.example.py');
  if (!existsSync(examplePath)) return false;
  copyFileSync(examplePath, confPath);
  return true;
}

function detectBrowser() {
  if (config.browserPath && existsSync(config.browserPath)) return config.browserPath;
  if (platform() === 'win32') {
    const candidates = [
      join(process.env.PROGRAMFILES || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(process.env['PROGRAMFILES(X86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(process.env.PROGRAMFILES || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(process.env['PROGRAMFILES(X86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ];
    return candidates.find((item) => item && existsSync(item)) || null;
  }
  const candidates = [
    '/usr/bin/microsoft-edge',
    '/usr/bin/microsoft-edge-stable',
    '/opt/microsoft/msedge-beta/msedge',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  return candidates.find((item) => existsSync(item)) || null;
}

function parseJsonFromOutput(output) {
  const text = String(output || '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function commandWorks(command, commandArgs, opts = {}) {
  const result = run(command, commandArgs, opts);
  return { ok: result.status === 0, output: `${result.stdout || ''}${result.stderr || ''}`.trim(), status: result.status };
}

function sauCommand() {
  const configured = String(process.env.SAU_CLI_COMMAND || process.env.SOCIAL_AUTO_UPLOAD_CLI_COMMAND || '').trim();
  if (configured) return { command: configured, args: [], cwd: root, display: configured };
  const sauCli = join(root, 'vendor', 'social-auto-upload', 'sau_cli.py');
  const python = process.platform === 'win32' ? 'python' : 'python3';
  if (existsSync(sauCli)) {
    ensureSauConfig();
    return { command: python, args: [sauCli], cwd: join(root, 'vendor', 'social-auto-upload'), display: `${python} ${sauCli}`, env: sauEnv() };
  }
  return { command: 'sau', args: [], cwd: root, display: 'sau' };
}

async function main() {
  const checks = [];
  const nodeMajor = Number(process.versions.node.split('.')[0]);

  checks.push(check('node_version', nodeMajor >= 22, process.versions.node, 'Install Node.js 22+.'));
  checks.push(check('package_json', existsSync(join(root, 'package.json')), join(root, 'package.json')));
  checks.push(check('skill_file', existsSync(join(root, 'SKILL.md')), join(root, 'SKILL.md')));
  checks.push(check('node_modules', existsSync(join(root, 'node_modules', 'puppeteer-core')), join(root, 'node_modules'), 'Run npm install in the skill directory.'));

  const syntaxFiles = [
    'src/mcp-server.js',
    'scripts/douyin-login-monitor.js',
    'scripts/publish-with-guard.js',
    'scripts/douyin-cli.js',
    'scripts/inspect-publish-fields.js',
    'scripts/validate-publish-task.js',
    'scripts/run-publish-task-stability.js',
    'scripts/publish-upstream-job-worker.js',
    'scripts/sau-publish-wrapper.js',
    'scripts/tencent-embedded-publish.js',
  ];
  for (const file of syntaxFiles) {
    if (!existsSync(join(root, file))) {
      checks.push(check(`syntax:${file}`, false, 'missing', `Restore ${file}.`));
      continue;
    }
    const res = run(process.execPath, ['--check', file]);
    checks.push(check(`syntax:${file}`, res.status === 0, (res.stderr || res.stdout || '').trim(), `Fix syntax in ${file}.`));
  }

  const browser = detectBrowser();
  checks.push(check('browser_executable', browser, browser || `configured=${config.browserPath || '(auto)'}`, 'Install Chrome/Edge/Chromium or set BROWSER_PATH.'));

  const displayReady = process.platform === 'win32'
    || Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY || existsSync('/tmp/.X11-unix'));
  const xvfb = process.platform === 'win32' ? { stdout: '' } : run('bash', ['-lc', 'command -v xvfb-run || true']);
  checks.push(check(
    'display_or_xvfb',
    displayReady || Boolean((xvfb.stdout || '').trim()),
    process.platform === 'win32'
      ? 'Windows GUI available'
      : `DISPLAY=${process.env.DISPLAY || ''}, WAYLAND_DISPLAY=${process.env.WAYLAND_DISPLAY || ''}, xvfb=${(xvfb.stdout || '').trim() || '(missing)'}`,
    'Install xvfb or ensure WSLg DISPLAY/WAYLAND_DISPLAY is available.',
  ));

  if (existsSync(join(root, 'scripts', 'ensure-cjk-fonts.js'))) {
    const cjkFontProbe = run(process.execPath, [join(root, 'scripts', 'ensure-cjk-fonts.js')]);
    const cjkPayload = parseJsonFromOutput(`${cjkFontProbe.stdout || ''}${cjkFontProbe.stderr || ''}`);
    checks.push(check(
      'cjk_fonts',
      cjkFontProbe.status === 0 && cjkPayload?.ok,
      cjkPayload ? JSON.stringify(cjkPayload).slice(0, 700) : `${cjkFontProbe.stdout || ''}${cjkFontProbe.stderr || ''}`.trim().slice(-700),
      'Check Windows font mount or install a CJK font package.',
    ));
  }

  const qrPython = process.env.DOUYIN_QR_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const qrDependency = run(qrPython, ['-c', 'import PIL; print("pillow ok")']);
  checks.push(check(
    'qr_detector_pillow',
    qrDependency.status === 0,
    (qrDependency.stdout || qrDependency.stderr || '').trim().slice(-500),
    'Install Pillow, or set DOUYIN_QR_PYTHON to a Python environment with Pillow.',
  ));

  const browserDataDir = config.browserUserDataDir || join(home, '.wjz_browser_data');
  checks.push(check('browser_user_data_dir_writable', canWrite(browserDataDir), browserDataDir, 'Set BROWSER_USER_DATA_DIR to a writable path.'));
  checks.push(check('output_dir_writable', canWrite(config.outputDir), config.outputDir, 'Set OUTPUT_DIR to a writable path.'));
  checks.push(check('state_dir_writable', canWrite(process.env.DOUYIN_MONITOR_STATE_DIR || join(home, '.openclaw', 'workspace', 'social-auto-publish')), process.env.DOUYIN_MONITOR_STATE_DIR || join(home, '.openclaw', 'workspace', 'social-auto-publish')));

  const sau = sauCommand();
  const sauHelp = commandWorks(sau.command, [...sau.args, '--help'], { cwd: sau.cwd, timeout: 30000, env: sau.env || {} });
  checks.push(check(
    'social_auto_upload_cli',
    sauHelp.ok && /douyin|xiaohongshu|kuaishou|tencent|upload-video|usage/i.test(sauHelp.output),
    `${sau.display}: ${sauHelp.output.slice(-800)}`,
    'Install social-auto-upload dependencies or set SAU_CLI_COMMAND/SOCIAL_AUTO_UPLOAD_CLI_COMMAND.',
  ));

  const passed = checks.every((item) => item.ok);
  const summary = {
    ok: passed,
    root,
    node: process.version,
    browser,
    sauCommand: sau.display,
    commandForMcp: 'node src/mcp-server.js',
    commandForDouyinConsole: 'npm run local:publish-console',
    screenshotCommand: 'node scripts/douyin-cli.js screenshot',
    checks,
  };

  if (args.has('--json') || true) console.log(JSON.stringify(summary, null, 2));
  if (!passed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: err.message, stack: err.stack }, null, 2));
  process.exitCode = 1;
});
