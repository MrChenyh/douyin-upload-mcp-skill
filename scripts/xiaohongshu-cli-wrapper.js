#!/usr/bin/env node
import { existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { delimiter, join, resolve } from 'node:path';

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
    join(home, '.local', 'bin'),
    join(home, 'AppData', 'Roaming', 'Python', 'Python312', 'Scripts'),
    join(home, 'AppData', 'Roaming', 'Python', 'Python311', 'Scripts'),
    join(home, 'AppData', 'Roaming', 'Python', 'Python310', 'Scripts'),
  ].filter((item) => item && existsSync(item));
}

function buildEnv() {
  const env = {
    ...process.env,
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
  };
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') || 'Path';
  env[pathKey] = [env[pathKey], ...extraPath()].filter(Boolean).join(delimiter);
  return env;
}

function command() {
  return String(process.env.XIAOHONGSHU_CLI_COMMAND || process.env.XHS_CLI_COMMAND || 'xhs').trim() || 'xhs';
}

function splitList(value) {
  if (Array.isArray(value)) return value;
  return String(value || '')
    .split(/[;|,，\n]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function validateImage(filePath) {
  const absolute = resolve(String(filePath || '').trim());
  if (!existsSync(absolute)) throw new Error(`image_not_found:${absolute}`);
  if (!statSync(absolute).isFile()) throw new Error(`image_not_file:${absolute}`);
  return absolute;
}

function run(args) {
  const result = spawnSync(command(), args, {
    cwd: process.cwd(),
    env: buildEnv(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: Number(process.env.XIAOHONGSHU_CLI_TIMEOUT_MS || 300000),
    windowsHide: true,
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
  if (output) process.stdout.write(`${output}\n`);
  return {
    status: result.status,
    signal: result.signal,
    error: result.error?.message || null,
    output,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const action = args._[0] || 'help';
  if (action === 'doctor') {
    const result = run(['--help']);
    process.exit(result.status === 0 ? 0 : 1);
  }
  if (action === 'status') {
    const result = run(['status']);
    process.exit(result.status === 0 ? 0 : 1);
  }
  if (action === 'login') {
    const cliArgs = ['login'];
    if (args['cookie-source']) cliArgs.push('--cookie-source', args['cookie-source']);
    if (args.qrcode) cliArgs.push('--qrcode');
    if (args.json) cliArgs.push('--json');
    const result = run(cliArgs);
    process.exit(result.status === 0 ? 0 : 1);
  }
  if (action === 'post') {
    const title = String(args.title || '').trim();
    const body = String(args.body || '').trim();
    const images = splitList(args.images).map(validateImage);
    if (!title) throw new Error('title_required');
    if (!body) throw new Error('body_required');
    if (!images.length) throw new Error('image_required');
    const cliArgs = ['post', '--title', title, '--body', body];
    for (const image of images) cliArgs.push('--images', image);
    for (const topic of splitList(args.topics || args.topic || args.tags)) cliArgs.push('--topic', topic.replace(/^#+/, ''));
    if (args.private) cliArgs.push('--private');
    cliArgs.push('--json');
    const result = run(cliArgs);
    process.exit(result.status === 0 ? 0 : 1);
  }
  console.error('Usage: node scripts/xiaohongshu-cli-wrapper.js doctor|status|login|post --title ... --body ... --images a.jpg;b.jpg [--topics ...] [--private]');
  process.exit(2);
}

try {
  main();
} catch (err) {
  console.error(err.stack || err.message);
  process.exit(1);
}
