#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sourceRoot = resolve(__dirname, '..');
const args = new Set(process.argv.slice(2));
const apply = args.has('--apply');
const replace = args.has('--replace');
const help = args.has('--help') || args.has('-h');
const targetArg = valueAfter('--target');
const targetRoot = resolve(targetArg || join(homedir(), '.openclaw', 'skills', 'social-auto-publish-skill'));

function valueAfter(flag) {
  const argv = process.argv.slice(2);
  const index = argv.indexOf(flag);
  if (index < 0) return '';
  return argv[index + 1] || '';
}

function run(command, commandArgs = [], opts = {}) {
  return spawnSync(command, commandArgs, {
    cwd: opts.cwd || targetRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: opts.timeout || 300000,
    windowsHide: true,
    env: { ...process.env, ...(opts.env || {}) },
  });
}

function check(name, ok, detail = '', fix = '') {
  return { name, ok: Boolean(ok), detail, fix };
}

function samePath(a, b) {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return resolve(a) === resolve(b);
  }
}

function copySkill(checks) {
  const alreadyInPlace = existsSync(targetRoot) && samePath(sourceRoot, targetRoot);
  if (alreadyInPlace) {
    checks.push(check('copy_skill', true, `already in ${targetRoot}`));
    return;
  }
  if (!apply) {
    checks.push(check('copy_skill', false, `${sourceRoot} -> ${targetRoot}`, 'Run with --apply to copy skill into OpenClaw skills directory.'));
    return;
  }
  if (replace) rmSync(targetRoot, { recursive: true, force: true });
  mkdirSync(targetRoot, { recursive: true });
  cpSync(sourceRoot, targetRoot, {
    recursive: true,
    force: true,
    dereference: false,
    filter: (src) => {
      const rel = src.slice(sourceRoot.length).replace(/^[/\\]+/, '').replace(/\\/g, '/');
      if (!rel) return true;
      return ![
        '.git',
        'node_modules',
        'douyin-output',
        'temp',
        'dist',
        '.runtime',
      ].some((blocked) => rel === blocked || rel.startsWith(`${blocked}/`))
        && !rel.endsWith('.log')
        && !rel.includes('/__pycache__/')
        && !rel.endsWith('.pyc')
        && !/^\.env(\.|$)/.test(rel);
    },
  });
  checks.push(check('copy_skill', existsSync(join(targetRoot, 'SKILL.md')), `${sourceRoot} -> ${targetRoot}`));
}

function runBootstrap(checks) {
  if (!existsSync(join(targetRoot, 'scripts', 'bootstrap-openclaw.js'))) {
    checks.push(check('bootstrap_openclaw', false, 'missing scripts/bootstrap-openclaw.js', 'Check package extraction/copy.'));
    return;
  }
  const bootstrapArgs = ['scripts/bootstrap-openclaw.js'];
  if (apply) bootstrapArgs.push('--apply');
  const result = run(process.execPath, bootstrapArgs, { timeout: 600000 });
  checks.push(check(
    apply ? 'bootstrap_openclaw_apply' : 'bootstrap_openclaw_check',
    result.status === 0,
    (result.stdout || result.stderr).slice(-2000),
    'Fix bootstrap blockers and rerun installer.',
  ));
}

function finalChecks(checks) {
  if (!apply) return;
  const ready = run(process.execPath, ['scripts/agent-ready.js'], { timeout: 300000 });
  checks.push(check('agent_ready', ready.status === 0, (ready.stdout || ready.stderr).slice(-1500), 'Check agent-ready output.'));
}

if (help) {
  console.log(`Usage:
  node scripts/install-openclaw-skill.js --apply
  node scripts/install-openclaw-skill.js --apply --replace

Options:
  --target <dir>   Default: ~/.openclaw/skills/social-auto-publish-skill
  --replace        Remove target skill directory before copying

Without --apply it only checks what would be configured.`);
  process.exit(0);
}

const checks = [];
checks.push(check('node_version', Number(process.versions.node.split('.')[0]) >= 22, process.versions.node, 'Install Node.js 22+.'));
copySkill(checks);
runBootstrap(checks);
finalChecks(checks);

const blockers = checks.filter((item) => !item.ok);
console.log(JSON.stringify({
  ok: blockers.length === 0,
  applied: apply,
  sourceRoot,
  targetRoot,
  mcpServerName: 'social_auto_publish',
  nextHumanSteps: [
    'Fill .env.local only if BROWSER_PATH/OUTPUT_DIR/state paths need overrides.',
    'Run node scripts/sau-publish-wrapper.js login --platform <platform> --account default for each target platform.',
    'First real publish may require QR scan, SMS, or security verification.',
  ],
  checks,
  blockers,
}, null, 2));

if (blockers.length) process.exitCode = 1;
