#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

function run(command, args, opts = {}) {
  return spawnSync(command, args, {
    cwd: opts.cwd || process.cwd(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: opts.timeout || 120000,
    windowsHide: true,
  });
}

function parseJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function check(name, ok, detail = '', fix = '') {
  return { name, ok: Boolean(ok), detail, fix };
}

async function main() {
  const checks = [];
  const daemonPort = process.env.DAEMON_PORT || '40225';

  const preflight = run(process.execPath, ['scripts/preflight.js'], { timeout: 180000 });
  const preflightPayload = parseJson(preflight.stdout || preflight.stderr || '');
  checks.push(check(
    'skill_preflight',
    preflight.status === 0 && preflightPayload?.ok,
    preflightPayload ? `checks=${preflightPayload.checks?.length || 0}` : (preflight.stdout || preflight.stderr).slice(-1200),
    'Fix failed checks from scripts/preflight.js.',
  ));

  const helpOk = run(process.execPath, ['scripts/help.js']);
  checks.push(check(
    'quick_help',
    helpOk.status === 0 && /Social Auto Publish Skill/.test(helpOk.stdout),
    helpOk.stdout.slice(0, 300),
  ));

  const taskValidate = run(process.execPath, ['scripts/validate-publish-task.js', '--task', 'templates/publish-task.stability.json']);
  const taskPayload = parseJson(taskValidate.stdout || taskValidate.stderr || '');
  checks.push(check(
    'publish_task_template',
    taskValidate.status === 0 && taskPayload?.ok,
    taskPayload ? JSON.stringify(taskPayload.validation || taskPayload).slice(0, 800) : (taskValidate.stdout || taskValidate.stderr).slice(-800),
    'Fix templates/publish-task.stability.json or validate-publish-task.js.',
  ));

  const sauDoctor = run(process.execPath, ['scripts/sau-publish-wrapper.js', 'doctor'], { timeout: 60000 });
  checks.push(check(
    'social_auto_upload_doctor',
    sauDoctor.status === 0,
    (sauDoctor.stdout || sauDoctor.stderr).slice(-800),
    'Install social-auto-upload dependencies or set SAU_CLI_COMMAND.',
  ));

  const daemonHealth = await fetch(`http://127.0.0.1:${daemonPort}/health`).then((res) => res.json()).catch((err) => ({ ok: false, error: err.message }));
  checks.push(check(
    'douyin_daemon_health',
    daemonHealth.ok,
    JSON.stringify(daemonHealth).slice(0, 500),
    `Run npm run daemon from this skill directory, or call a Douyin MCP/browser tool once to auto-start it. Expected DAEMON_PORT=${daemonPort}.`,
  ));

  const nonBlocking = new Set(['douyin_daemon_health']);
  const ok = checks.filter((item) => !nonBlocking.has(item.name)).every((item) => item.ok);
  console.log(JSON.stringify({
    ok,
    browserTasksNeedDaemon: true,
    checks,
  }, null, 2));
  if (!ok) process.exit(1);
}

main().catch((err) => {
  console.log(JSON.stringify({ ok: false, error: err.message, stack: err.stack }, null, 2));
  process.exit(1);
});
