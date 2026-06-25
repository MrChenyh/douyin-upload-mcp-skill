#!/usr/bin/env node
import { copyFileSync, existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SAU_DIR = join(ROOT, 'vendor', 'social-auto-upload');

function ensureSauConfig() {
  const confPath = join(SAU_DIR, 'conf.py');
  if (existsSync(confPath)) return;
  const examplePath = join(SAU_DIR, 'conf.example.py');
  if (existsSync(examplePath)) copyFileSync(examplePath, confPath);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith('--')) {
      args._.push(item);
      continue;
    }
    const key = item.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function extraPath() {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  return [
    join(SAU_DIR, '.venv', process.platform === 'win32' ? 'Scripts' : 'bin'),
    join(home, '.local', 'bin'),
    join(home, 'AppData', 'Roaming', 'Python', 'Python312', 'Scripts'),
    join(home, 'AppData', 'Roaming', 'Python', 'Python311', 'Scripts'),
    join(home, 'AppData', 'Roaming', 'Python', 'Python310', 'Scripts'),
  ].filter((item) => item && existsSync(item));
}

function env() {
  const next = {
    ...process.env,
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
    PLAYWRIGHT_DOWNLOAD_HOST: process.env.PLAYWRIGHT_DOWNLOAD_HOST || 'https://npmmirror.com/mirrors/playwright',
  };
  const pathKey = Object.keys(next).find((key) => key.toLowerCase() === 'path') || 'Path';
  next[pathKey] = [next[pathKey], ...extraPath()].filter(Boolean).join(delimiter);
  next.PYTHONPATH = [SAU_DIR, next.PYTHONPATH || ''].filter(Boolean).join(delimiter);
  return next;
}

function sauCommandSpec() {
  const configured = String(process.env.SAU_CLI_COMMAND || process.env.SOCIAL_AUTO_UPLOAD_CLI_COMMAND || '').trim();
  if (configured) return { command: configured, args: [], cwd: ROOT, display: configured };
  const sauCli = join(SAU_DIR, 'sau_cli.py');
  if (existsSync(sauCli)) {
    ensureSauConfig();
    const python = process.env.SAU_PYTHON || process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
    return { command: python, args: [sauCli], cwd: SAU_DIR, display: `${python} ${sauCli}` };
  }
  return { command: 'sau', args: [], cwd: ROOT, display: 'sau' };
}

function splitList(value) {
  return String(value || '').split(/[;|,\uFF0C\n]+/).map((item) => item.trim()).filter(Boolean);
}

function validateFile(filePath) {
  const absolute = resolve(String(filePath || '').trim());
  if (!existsSync(absolute)) throw new Error(`file_not_found:${absolute}`);
  if (!statSync(absolute).isFile()) throw new Error(`file_not_file:${absolute}`);
  return absolute;
}

function run(args) {
  const spec = sauCommandSpec();
  const result = spawnSync(spec.command, [...spec.args, ...args], {
    cwd: spec.cwd,
    env: env(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: Number(process.env.SAU_CLI_TIMEOUT_MS || 3_600_000),
    windowsHide: true,
  });
  const output = `${result.stdout || ''}${result.stderr || ''}${result.error?.message || ''}`.trim();
  if (process.env.SAU_WRAPPER_DEBUG === 'true') process.stderr.write(`[sau-wrapper] ${spec.display}\n`);
  if (output) process.stdout.write(`${output}\n`);
  return result.status === 0 ? 0 : 1;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const action = args._[0] || 'help';
  const platform = args.platform || args._[1];
  const account = args.account || 'default';

  if (action === 'doctor') process.exit(run(['--help']));
  if (action === 'check') process.exit(run([platform, 'check', '--account', account]));
  if (action === 'login') process.exit(run([platform, 'login', '--account', account, '--headed']));

  if (action === 'publish-video') {
    const file = validateFile(args.file || args.video || args.videoPath);
    const cliArgs = [platform, 'upload-video', '--account', account, '--file', file, '--title', args.title || '', '--desc', args.desc || args.description || ''];
    if (args.tags) cliArgs.push('--tags', args.tags);
    if (args.thumbnail || args.cover) cliArgs.push('--thumbnail', validateFile(args.thumbnail || args.cover));
    if (args.schedule) cliArgs.push('--schedule', args.schedule);
    cliArgs.push(args.headed ? '--headed' : '--headless');
    process.exit(run(cliArgs));
  }

  if (action === 'publish-note') {
    const images = splitList(args.images).map(validateFile);
    const cliArgs = [platform, 'upload-note', '--account', account, '--images', ...images, '--title', args.title || '', '--note', args.note || args.body || ''];
    if (args.tags) cliArgs.push('--tags', args.tags);
    if (args.schedule) cliArgs.push('--schedule', args.schedule);
    cliArgs.push(args.headed ? '--headed' : '--headless');
    process.exit(run(cliArgs));
  }

  console.error('Usage: node scripts/sau-publish-wrapper.js doctor|check|login|publish-video|publish-note --platform douyin|xiaohongshu --account default ...');
  process.exit(2);
}

try {
  main();
} catch (err) {
  console.error(err.stack || err.message);
  process.exit(1);
}
