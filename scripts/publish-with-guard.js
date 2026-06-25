#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

function usage() {
  console.error(`Usage:
  node scripts/publish-with-guard.js --file /abs/video.mp4 [--title TITLE] [--description TEXT] [--topics topic1,topic2] [--cover-image /abs/cover.png] [--timeout 1800000] [--assistant-timeout 600000] [--fresh]
`);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith('--')) continue;
    const key = item.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function runNode(args, opts = {}) {
  return spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: Number(opts.timeout || 0) || undefined,
  });
}

function killProcessTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try { process.kill(pid, 'SIGTERM'); } catch {}
  }
}

async function runNodeStreaming(args, opts = {}) {
  const timeoutMs = Number(opts.timeout || 0);
  const heartbeatMs = Number(opts.heartbeatMs || 30000);
  const startedAt = Date.now();
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let stdout = '';
  let stderr = '';
  let timedOut = false;
  let settled = false;

  child.stdout.on('data', (chunk) => {
    const text = String(chunk || '');
    stdout += text;
    process.stdout.write(text);
  });
  child.stderr.on('data', (chunk) => {
    const text = String(chunk || '');
    stderr += text;
    process.stderr.write(text);
  });

  const timer = timeoutMs > 0 ? setTimeout(() => {
    if (settled) return;
    timedOut = true;
    process.stderr.write(`[publish-with-guard] timeout after ${timeoutMs}ms, killing process tree pid=${child.pid}\n`);
    killProcessTree(child.pid);
  }, timeoutMs) : null;

  const heartbeat = heartbeatMs > 0 ? setInterval(() => {
    if (settled) return;
    process.stderr.write(`[publish-with-guard] still running ${Math.round((Date.now() - startedAt) / 1000)}s: ${args.join(' ')}\n`);
  }, heartbeatMs) : null;

  const exit = await new Promise((resolvePromise) => {
    child.on('error', (err) => resolvePromise({ status: null, signal: null, error: err.message }));
    child.on('exit', (status, signal) => resolvePromise({ status, signal, error: '' }));
  });

  settled = true;
  if (timer) clearTimeout(timer);
  if (heartbeat) clearInterval(heartbeat);

  return {
    status: exit.status,
    signal: exit.signal,
    error: exit.error,
    timedOut,
    stdout,
    stderr,
    output: `${stdout || ''}${stderr || ''}`.trim(),
  };
}

function extractJson(stdout) {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`No JSON payload found in output:\n${stdout}`);
  }
  return JSON.parse(stdout.slice(start, end + 1));
}

function printResult(result) {
  console.log(JSON.stringify(result, null, 2));
}

function safeExtractJson(text) {
  try {
    return extractJson(text || '');
  } catch {
    return null;
  }
}

function isRetryablePublishError(payload) {
  return [
    'publish_btn_not_found',
    'publish_btn_obstructed',
    'publish_btn_disabled',
    'publish_submit_unconfirmed',
    'publish_click_returned_to_upload',
    'publish_editor_not_ready',
    'editor_has_unpublished_changes',
  ].includes(payload?.error);
}

function isCoverFailure(payload) {
  return /cover|封面/i.test(String(payload?.error || payload?.publish?.error || ''));
}

function allowCoverFallback(args) {
  return args.allowCoverFallback === true || process.env.DOUYIN_ALLOW_COVER_FALLBACK === 'true';
}

function cleanupFailedUploadDraft() {
  return runNode(['--input-type=module', '-e', `
    import { createDouyinSession, disconnect } from './src/index.js';
    const { ops } = await createDouyinSession();
    try {
      await ops.goUploadPage({ force: true });
      console.log(JSON.stringify(await ops.abandonUnpublishedDraft(), null, 2));
    } finally {
      disconnect();
    }
  `], { timeout: 180000 });
}

function publishTimeoutBudget(args) {
  const upload = Number(args.timeout || 0);
  const assistant = Number(args.assistantTimeout || 0);
  const explicit = Number(args.publishTimeout || process.env.DOUYIN_PUBLISH_TASK_TIMEOUT_MS || 0);
  return explicit || Math.max(upload + assistant + 120000, 300000);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.file || args.help) {
    usage();
    process.exit(args.help ? 0 : 2);
  }
  if (!existsSync(args.file)) {
    printResult({ ok: false, error: 'file_not_found', file: args.file });
    process.exit(2);
  }

  // Do not pass --title here: title verification navigates away from the
  // publish editor and can interrupt an active upload.
  process.stderr.write('[publish-with-guard] checking current publish state\n');
  const stateBefore = runNode(['scripts/douyin-cli.js', 'publish-state'], { timeout: 180000 });
  const statePayload = safeExtractJson(stateBefore.stdout || '');
  if (statePayload?.verification?.found) {
    printResult({
      ok: false,
      error: 'publish_verification_required',
      detail: statePayload.verification,
    });
    process.exit(1);
  }
  if (
    !args.fresh
    && statePayload?.currentPage?.url?.includes('/content/post/video')
    && statePayload?.assistant
    && statePayload.assistant.ready !== true
  ) {
    printResult({
      ok: false,
      error: 'editor_in_progress',
      detail: {
        message: 'Current publish editor still has an unfinished upload or assistant task; stopped before starting a new upload.',
        assistant: statePayload.assistant,
        currentPage: statePayload.currentPage,
      },
    });
    process.exit(1);
  }

  process.stderr.write('[publish-with-guard] checking login state\n');
  const checkArgs = ['scripts/douyin-login-monitor.js', 'check'];
  const check = runNode(checkArgs, { timeout: 180000 });
  process.stderr.write(check.stderr || '');
  const checkPayload = extractJson(check.stdout || '');

  if (checkPayload.kind !== 'logged_in') {
    printResult({
      ok: false,
      blocked: true,
      reason: checkPayload.kind,
      phase: checkPayload.phase,
      qrcodePath: checkPayload.qrcodePath,
      screenshotPath: checkPayload.screenshotPath,
      advice: checkPayload.advice,
      message: checkPayload.message,
    });
    process.exit(3);
  }

  const publishArgs = ['scripts/douyin-cli.js', 'publish-video', '--file', args.file];
  if (args.title) publishArgs.push('--title', args.title);
  if (args.description) publishArgs.push('--description', args.description);
  if (args.topics) publishArgs.push('--topics', args.topics);
  if (args.coverImage) publishArgs.push('--cover-image', args.coverImage);
  if (args.allowCoverFallback) publishArgs.push('--allow-cover-fallback');
  if (args.timeout) publishArgs.push('--timeout', args.timeout);
  if (args.assistantTimeout) publishArgs.push('--assistant-timeout', args.assistantTimeout);
  if (args.fresh) publishArgs.push('--fresh');

  const heartbeatMs = Number(args.heartbeatMs || process.env.DOUYIN_PUBLISH_HEARTBEAT_MS || 30000);
  const timeoutMs = publishTimeoutBudget(args);
  process.stderr.write(`[publish-with-guard] starting publish-video timeout=${timeoutMs}ms\n`);
  let publish = await runNodeStreaming(publishArgs, { timeout: timeoutMs, heartbeatMs });
  let payload = safeExtractJson(publish.stdout || publish.output || '');

  if (publish.status !== 0 && payload?.error === 'upload_failed') {
    process.stderr.write('[publish-with-guard] upload_failed; cleaning draft and retrying once\n');
    const cleanup = cleanupFailedUploadDraft();
    process.stderr.write(cleanup.stderr || '');
    const second = await runNodeStreaming(publishArgs, { timeout: timeoutMs, heartbeatMs });
    const secondPayload = safeExtractJson(second.stdout || second.output || '');
    if (second.status === 0) {
      process.exit(0);
    }
    publish = second;
    payload = secondPayload || payload;
  }

  if (publish.status !== 0 && isCoverFailure(payload) && args.coverImage) {
    if (!allowCoverFallback(args)) {
      printResult({
        ok: false,
        error: 'custom_cover_required_failed',
        coverImage: args.coverImage,
        detail: payload || safeExtractJson(publish.stdout || '') || {
          status: publish.status,
          signal: publish.signal,
          timedOut: publish.timedOut,
          output: publish.output,
        },
      });
      process.exit(1);
    }
    process.stderr.write('[publish-with-guard] cover failed; retrying once without custom cover\n');
    const noCoverArgs = publishArgs.filter((item, index) => {
      if (item === '--cover-image') return false;
      if (index > 0 && publishArgs[index - 1] === '--cover-image') return false;
      return true;
    });
    const retry = await runNodeStreaming(noCoverArgs, { timeout: timeoutMs, heartbeatMs });
    if (retry.status === 0) {
      process.exit(0);
    }
    printResult({
      ok: false,
      error: 'publish_without_custom_cover_failed',
      first: payload || safeExtractJson(publish.stdout || '') || {
        status: publish.status,
        signal: publish.signal,
        timedOut: publish.timedOut,
        output: publish.output,
      },
      retry: safeExtractJson(retry.stdout || '') || {
        status: retry.status,
        signal: retry.signal,
        timedOut: retry.timedOut,
        output: retry.output,
      },
    });
    process.exit(1);
  }

  if (publish.status !== 0 && isRetryablePublishError(payload)) {
    process.stderr.write('[publish-with-guard] retryable publish error; trying current draft once\n');
    const retryArgs = ['scripts/douyin-cli.js', 'publish-current-draft'];
    if (args.title) retryArgs.push('--title', args.title);
    if (args.description) retryArgs.push('--description', args.description);
    if (args.topics) retryArgs.push('--topics', args.topics);
    if (args.assistantTimeout) retryArgs.push('--assistant-timeout', args.assistantTimeout);
    const retry = await runNodeStreaming(retryArgs, { timeout: 180000, heartbeatMs });
    if (retry.status === 0) {
      process.exit(0);
    }
    printResult({
      ok: false,
      error: 'publish_retry_failed',
      first: payload || safeExtractJson(publish.stdout || '') || {
        status: publish.status,
        signal: publish.signal,
        timedOut: publish.timedOut,
        output: publish.output,
      },
      retry: safeExtractJson(retry.stdout || '') || {
        status: retry.status,
        signal: retry.signal,
        timedOut: retry.timedOut,
        output: retry.output,
      },
    });
    process.exit(1);
  }

  if (publish.status !== 0 && !payload) {
    printResult({
      ok: false,
      error: publish.timedOut ? 'publish_timeout' : 'publish_process_failed',
      status: publish.status,
      signal: publish.signal,
      timedOut: publish.timedOut,
      detail: publish.error || publish.stderr || publish.stdout,
    });
  }
  process.exit(publish.status ?? 1);
}

main().catch((err) => {
  printResult({ ok: false, error: err.message, stack: err.stack });
  process.exit(1);
});
