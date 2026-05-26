#!/usr/bin/env node
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const skillRoot = resolve(__dirname, '..');
const argv = process.argv.slice(2);
const outDir = resolve(valueAfter('--out') || argv.find((item) => !item.startsWith('--')) || '/tmp');
const xiaoiceToolDir = resolve(valueAfter('--xiaoice-tool-dir') || process.env.XIAOICE_VIDEO_TOOL_DIR || join(process.env.HOME || '.', '自动营销', 'xiaoice-video-tool'));
const openclawConfigPath = resolve(valueAfter('--openclaw-config') || process.env.OPENCLAW_CONFIG_PATH || join(homedir(), '.openclaw', 'openclaw.json'));
const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
const bundleName = `douyin-migration-private-bundle-${stamp}`;
const outPath = join(outDir, `${bundleName}.tar.gz`);

function valueAfter(flag) {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : '';
}

function usage() {
  console.log(`Usage:
  node scripts/export-migration-bundle.js [out-dir]
  node scripts/export-migration-bundle.js --out /tmp --xiaoice-tool-dir ~/自动营销/xiaoice-video-tool

This creates a trusted private migration bundle containing local env secrets.
Do not upload the output publicly.`);
}

if (argv.includes('--help') || argv.includes('-h')) {
  usage();
  process.exit(0);
}

function readJson(path, fallback = null) {
  try {
    if (!existsSync(path)) return fallback;
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

function parseEnvFile(path) {
  if (!existsSync(path)) return {};
  const env = {};
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const index = line.indexOf('=');
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    env[key] = value;
  }
  return env;
}

function serializeEnv(env) {
  return Object.entries(env)
    .filter(([key]) => key)
    .map(([key, value]) => `${key}=${String(value ?? '').replace(/\n/g, '\\n')}`)
    .join('\n') + '\n';
}

function hashFile(path) {
  const hash = createHash('sha256');
  hash.update(readFileSync(path));
  return hash.digest('hex');
}

function copyTree(source, target, blockedNames = []) {
  if (!existsSync(source)) throw new Error(`missing_source:${source}`);
  const blocked = new Set(blockedNames.map((item) => item.toLowerCase()));
  cpSync(source, target, {
    recursive: true,
    force: true,
    dereference: false,
    filter: (src) => {
      const rel = src.slice(source.length).replace(/^\/+/, '');
      if (!rel) return true;
      const parts = rel.split(/[\\/]+/).map((item) => item.toLowerCase());
      if (parts.some((part) => blocked.has(part))) return false;
      if (rel.endsWith('.log') || rel.endsWith('.pyc') || rel.includes('/__pycache__/')) return false;
      return true;
    },
  });
}

function pickOpenClawSnippet() {
  const cfg = readJson(openclawConfigPath, {});
  const feishu = cfg.channels?.feishu || {};
  const accountId = process.env.FEISHU_ACCOUNT_ID || feishu.defaultAccount || Object.keys(feishu.accounts || {})[0] || '';
  const account = accountId ? feishu.accounts?.[accountId] : null;
  return {
    sourcePath: openclawConfigPath,
    channels: {
      feishu: {
        defaultAccount: accountId || feishu.defaultAccount || '',
        appId: account?.appId || feishu.appId || '',
        appSecret: account?.appSecret || feishu.appSecret || '',
      },
    },
    models: cfg.models || {},
    model: cfg.model || cfg.defaultModel || null,
    agents: cfg.agents || null,
    mcp: {
      servers: {
        douyin: cfg.mcp?.servers?.douyin || null,
      },
    },
  };
}

function configuredKeys(env) {
  return Object.fromEntries(Object.entries(env).map(([key, value]) => [key, Boolean(String(value || '').trim())]));
}

function writeReadme(target) {
  writeFileSync(join(target, 'README-MIGRATION.md'), `# Douyin Migration Private Bundle

This bundle is private and contains local API credentials.

Contents:
- douyin-upload-mcp-skill/
- xiaoice-video-tool/
- openclaw-config-snippet.json
- migration-manifest.json
- references/migration-lab-install-prompt.md

Install in a clean WSL Ubuntu/OpenClaw environment with:

\`\`\`bash
cd /tmp/douyin-migration-bundle
node douyin-upload-mcp-skill/scripts/migration-lab-three-deploy-acceptance.js --bundle-root "$PWD" --rounds 3 --persona-json /path/to/persona.json
\`\`\`
`);
}

mkdirSync(outDir, { recursive: true });
const tempParent = mkdtempSync(join(tmpdir(), 'douyin-migration-bundle-'));
const bundleRoot = join(tempParent, bundleName);
mkdirSync(bundleRoot, { recursive: true });

try {
  const skillTarget = join(bundleRoot, 'douyin-upload-mcp-skill');
  copyTree(skillRoot, skillTarget, [
    '.git',
    'node_modules',
    'douyin-output',
    'test',
    'temp',
    '__pycache__',
  ]);

  const xiaoiceTarget = join(bundleRoot, 'xiaoice-video-tool');
  copyTree(xiaoiceToolDir, xiaoiceTarget, [
    '.git',
    'node_modules',
    'data',
    'tmp',
    '__pycache__',
  ]);

  const skillEnvLocalPath = join(skillTarget, '.env.local');
  const skillEnv = {
    ...parseEnvFile(join(skillTarget, '.env')),
    ...parseEnvFile(skillEnvLocalPath),
    XIAOICE_VIDEO_TOOL_DIR: '$HOME/自动营销/xiaoice-video-tool',
    XIAOICE_VIDEO_ENV_PATH: '$HOME/自动营销/xiaoice-video-tool/.env',
    DOUYIN_MONITOR_STATE_DIR: '$HOME/.openclaw/workspace/douyin-ops',
    BROWSER_USER_DATA_DIR: '$HOME/.wjz_browser_data',
    BROWSER_DEBUG_PORT: '19800',
    BROWSER_PROTOCOL_TIMEOUT: '1200000',
    DAEMON_PORT: '41225',
  };
  writeFileSync(skillEnvLocalPath, serializeEnv(skillEnv));

  const openclawSnippet = pickOpenClawSnippet();
  writeFileSync(join(bundleRoot, 'openclaw-config-snippet.json'), `${JSON.stringify(openclawSnippet, null, 2)}\n`);

  const xiaoiceEnv = parseEnvFile(join(xiaoiceTarget, '.env'));
  const manifest = {
    bundleName,
    createdAt: new Date().toISOString(),
    source: {
      skillRoot,
      xiaoiceToolDir,
      openclawConfigPath,
    },
    installDefaults: {
      distroName: 'OpenClaw-Douyin-MigrationLab',
      rootfsTar: '/mnt/c/WSL/ubuntu-jammy-wsl-amd64-wsl.rootfs.tar.gz',
      skillTarget: '$HOME/.openclaw/skills/douyin-upload-mcp-skill',
      xiaoiceTarget: '$HOME/自动营销/xiaoice-video-tool',
      stateDir: '$HOME/.openclaw/workspace/douyin-ops',
      browserUserDataDir: '$HOME/.wjz_browser_data',
      daemonPort: 41225,
      browserDebugPort: 19800,
      browserProtocolTimeout: 1200000,
    },
    hashes: {
      skillMd: hashFile(join(skillTarget, 'SKILL.md')),
      skillPackageJson: hashFile(join(skillTarget, 'package.json')),
      xiaoicePackageJson: hashFile(join(xiaoiceTarget, 'package.json')),
      openclawSnippet: hashFile(join(bundleRoot, 'openclaw-config-snippet.json')),
    },
    configuredSecrets: {
      skill: configuredKeys(parseEnvFile(skillEnvLocalPath)),
      xiaoice: configuredKeys(xiaoiceEnv),
      openclawFeishu: configuredKeys(openclawSnippet.channels.feishu || {}),
    },
    excluded: [
      'node_modules',
      'browser login state',
      'OpenClaw sessions',
      'OpenClaw workspace runtime state',
      'published work cache',
      'xiaoice data/tmp runtime dirs',
    ],
    acceptance: {
      command: 'node scripts/migration-lab-three-deploy-acceptance.js --rounds 3 --bundle-root /path/to/extracted-bundle --persona-json /path/to/persona.json',
      singleDeployCommand: 'node scripts/migration-lab-acceptance.js --rounds 3 --real --cleanup --persona-json /path/to/persona.json',
      personaInput: 'Set DOUYIN_ACCEPTANCE_PERSONA_JSON or pass --persona-json with a real front-photo URL before first-round training.',
      personaTemplate: 'references/migration-acceptance-persona.example.json',
      requiredSystemPackages: ['nodejs>=22', 'microsoft-edge-stable or chrome/chromium', 'python3', 'python3-pil', 'xvfb or WSLg display'],
      firstRound: 'real Coze + Xiaoice digital-human training',
      laterRounds: 'reuse first trained modelId',
      reuseExistingVideo: 'For migration-only acceptance, pass --reuse-video-url and optional --reuse-cover-url to skip Xiaoice generation and validate deployment/login/publish/delete only.',
      loginHandling: 'Sends a fresh QR, waits for real scan/SMS/security completion, and records human blockers without faking success.',
      passRule: 'three consecutive successful rounds; any failure resets the count',
    },
  };
  writeFileSync(join(bundleRoot, 'migration-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeReadme(bundleRoot);

  const tar = spawnSync('tar', ['-czf', outPath, '-C', tempParent, bundleName], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120000,
  });
  if (tar.status !== 0) {
    throw new Error(`tar_failed:${tar.stderr || tar.stdout}`);
  }
  console.log(JSON.stringify({
    ok: true,
    bundlePath: outPath,
    bundleName,
    warning: 'Private bundle contains API credentials. Transfer only to trusted machines.',
    manifest,
  }, null, 2));
} finally {
  rmSync(tempParent, { recursive: true, force: true });
}
