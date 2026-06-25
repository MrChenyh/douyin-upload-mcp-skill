#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { loadPublishTask, validatePublishTask } from './validate-publish-task.js';
import { acquireBrowserTaskLock } from './browser-task-lock.js';
import '../src/config.js';

function usage() {
  console.error(`Usage:
  node scripts/publish-task.js --task templates/publish-task.from-upstream.json [--execute]

Default mode is dry-run. Add --execute to publish for real.
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
  const result = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: Number(opts.timeout || 600000),
  });
  return {
    ok: result.status === 0,
    status: result.status,
    signal: result.signal,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    output: `${result.stderr || ''}${result.stdout || ''}`.trim(),
  };
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

function isCurrentDraftPublishable(payload) {
  const url = String(payload?.currentPage?.url || payload?.url || '');
  if (url.includes('/content/post/video')) return true;
  if (payload?.assistant?.publishButtonVisible) return true;
  const text = `${payload?.assistant?.textSample || ''}\n${payload?.currentPage?.textSample || ''}`;
  return /发布暂存离开|预览视频|作品描述|发布设置/.test(text) && /发布/.test(text);
}

async function runNodeStreaming(args, opts = {}) {
  const timeoutMs = Number(opts.timeout || 600000);
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
    process.stderr.write(`[publish-task] timeout after ${timeoutMs}ms, killing process tree pid=${child.pid}\n`);
    killProcessTree(child.pid);
  }, timeoutMs) : null;

  const heartbeat = heartbeatMs > 0 ? setInterval(() => {
    if (settled) return;
    process.stderr.write(`[publish-task] still running ${Math.round((Date.now() - startedAt) / 1000)}s: ${args.join(' ')}\n`);
  }, heartbeatMs) : null;

  const exit = await new Promise((resolvePromise) => {
    child.on('error', (err) => resolvePromise({ status: null, signal: null, error: err.message }));
    child.on('exit', (status, signal) => resolvePromise({ status, signal, error: '' }));
  });

  settled = true;
  if (timer) clearTimeout(timer);
  if (heartbeat) clearInterval(heartbeat);

  return {
    ok: exit.status === 0,
    status: exit.status,
    signal: exit.signal,
    timedOut,
    error: exit.error,
    stdout,
    stderr,
    output: `${stderr || ''}${stdout || ''}`.trim(),
  };
}

function parseLastJson(text) {
  const trimmed = String(text || '').trim();
  const candidates = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        candidates.push(trimmed.slice(start, i + 1));
        start = -1;
      }
    }
  }
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(candidates[i]);
    } catch {
      continue;
    }
  }
  return null;
}

function topicsFromTask(task) {
  const metadata = task.metadata || {};
  const values = [
    ...(Array.isArray(metadata.topics) ? metadata.topics : []),
    ...(Array.isArray(metadata.tags) ? metadata.tags : []),
  ];
  return [...new Set(values.map((item) => String(item).trim().replace(/^#+/, '')).filter(Boolean))];
}

function normalizePublishTitle(title, maxLength = 30) {
  const clean = String(title || '')
    .replace(/#[^\s#，。,;；!！?？)）(（]+/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[，,、；;：:|｜\\/-]+$/g, '')
    .trim();
  const limit = Number.isFinite(Number(maxLength)) && Number(maxLength) > 0 ? Number(maxLength) : 30;
  return Array.from(clean).slice(0, limit).join('');
}

function descriptionFromTask(task) {
  const metadata = task.metadata || {};
  return metadata.description || '';
}

function parseDurationMs(value, fallback) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return fallback;
  const numeric = Number(text);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const match = text.match(/^(\d+)\s*(ms|s|m|h)$/);
  if (!match) return fallback;
  const amount = Number(match[1]);
  const unit = match[2];
  if (unit === 'ms') return amount;
  if (unit === 's') return amount * 1000;
  if (unit === 'm') return amount * 60_000;
  if (unit === 'h') return amount * 3_600_000;
  return fallback;
}

function verifyPublishedWithRetry(title) {
  const attempts = [];
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    const verify = runNode([
      'scripts/douyin-cli.js',
      'verify-published',
      '--title',
      title,
      '--wait-ms',
      '8000',
    ], { timeout: 120000 });
    const payload = parseLastJson(verify.output);
    attempts.push({ attempt, ok: verify.ok, verify: payload || verify });
    if (verify.ok && payload?.found) return { ok: true, verify: payload, attempts };
  }
  return { ok: false, verify: attempts.at(-1)?.verify || null, attempts };
}

function customerMessageForFailure(payload) {
  const full = JSON.stringify(payload || {});
  const error = payload?.error || payload?.publish?.error || payload?.publish?.publish?.error;
  const detailError = payload?.detail?.error || payload?.publish?.detail?.error || payload?.publish?.cover?.error;
  const code = detailError || error;
  if (/publish_verification_required/i.test(code || '') || payload?.publish?.detail?.found || payload?.publish?.publish?.detail?.found) {
    return '抖音发布需要短信验证。请直接回复 6 位验证码。';
  }
  if (/ProtocolError|protocolTimeout|Runtime\.callFunctionOn timed out|Network\.enable timed out|Target closed|Session closed|WebSocket/i.test(`${code || ''}\n${full}`)) {
    return '发布页面控制超时，我已保留当前草稿并会尝试恢复。请稍后回复：发布视频';
  }
  if (/upload_timeout|editor_in_progress|upload_page_timeout|hd_publish_btn_not_found|editor_navigation_blocked|publish_editor_not_ready|publish_btn_not_found|publish_btn_obstructed|publish_btn_disabled|publish_submit_unconfirmed|publish_click_returned_to_upload/i.test(code || '')) {
    return '发布页面未准备好，我已保留素材。请稍后回复：发布视频';
  }
  if (/cover|封面/i.test(code || '')) {
    return '封面设置失败，请重新发送可用的封面图片。';
  }
  if (/file_not_found|video|upload|上传/i.test(code || '')) {
    return '视频处理失败，请重新发送可用的视频。';
  }
  if (/login|session/i.test(code || '')) {
    return '抖音需要重新登录。请在电脑端打开宿主界面，用手机抖音 App 扫码，完成后重试发布。';
  }
  return '发布失败，请重新发送可用的视频和封面。';
}

function customerMessageForValidation(validation) {
  const text = [...(validation.errors || []), ...(validation.warnings || [])].join(' ');
  if (/cover|封面|imagePath|imageUrl/i.test(text)) {
    return '封面设置失败，请重新发送可用的封面图片。';
  }
  if (/video|视频|videoPath|videoUrl/i.test(text)) {
    return '视频处理失败，请重新发送可用的视频。';
  }
  return '素材处理失败，请重新发送可用的视频和封面。';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.task || args.help) {
    usage();
    process.exit(args.help ? 0 : 2);
  }
  const task = loadPublishTask(args.task);
  const validation = validatePublishTask(task);
  const plan = {
    title: normalizePublishTitle(task.metadata?.title),
    description: descriptionFromTask(task),
    topics: topicsFromTask(task),
    videoPath: task.media?.videoPath,
    coverImagePath: task.media?.cover?.imagePath || null,
  };

  if (!validation.ok || !args.execute) {
    console.log(JSON.stringify({
      ok: validation.ok,
      mode: args.execute ? 'execute' : 'dry-run',
      validation,
      plan,
      customerMessage: validation.ok ? undefined : customerMessageForValidation(validation),
      executeCommand: `node scripts/publish-task.js --task ${args.task} --execute`,
    }, null, 2));
    if (!validation.ok) process.exitCode = 1;
    return;
  }

  const publishTimeoutMs = parseDurationMs(args.publishTimeoutMs || process.env.DOUYIN_PUBLISH_TASK_TIMEOUT_MS, 3_600_000);
  const uploadTimeoutMs = parseDurationMs(args.uploadTimeoutMs || process.env.DOUYIN_UPLOAD_TIMEOUT_MS, 1_800_000);
  const assistantTimeoutMs = parseDurationMs(args.assistantTimeoutMs || process.env.DOUYIN_ASSISTANT_TIMEOUT_MS, 600_000);
  const releaseLock = await acquireBrowserTaskLock(`publish:${plan.title || plan.videoPath}`, publishTimeoutMs + 120_000, {
    priority: 'publish',
  });
  let publish;
  let publishPayload;
  try {
    console.error(`[publish-task] starting publish-with-guard for "${plan.title}"`);
    publish = await runNodeStreaming([
      'scripts/publish-with-guard.js',
      '--file',
      plan.videoPath,
      '--title',
      plan.title,
      ...(plan.description ? ['--description', plan.description] : []),
      ...(plan.topics.length ? ['--topics', plan.topics.join(',')] : []),
      ...(plan.coverImagePath ? ['--cover-image', plan.coverImagePath] : []),
      ...(args.allowCoverFallback ? ['--allow-cover-fallback'] : []),
      '--timeout',
      String(uploadTimeoutMs),
      '--assistant-timeout',
      String(assistantTimeoutMs),
      '--fresh',
    ], {
      timeout: publishTimeoutMs,
      heartbeatMs: Number(args.heartbeatMs || process.env.DOUYIN_PUBLISH_HEARTBEAT_MS || 30000),
    });
    publishPayload = parseLastJson(publish.output);
  } finally {
    releaseLock();
  }
  if (!publish.ok) {
    console.error('[publish-task] publish did not finish cleanly; checking current publish state');
    const current = runNode([
      'scripts/douyin-cli.js',
      'publish-state',
      '--title',
      plan.title,
      '--wait-ms',
      '5000',
    ], { timeout: 180000 });
    const currentPayload = parseLastJson(current.output);
    if (currentPayload?.manage?.found || (currentPayload?.published && !currentPayload?.currentPage?.url?.includes('/content/post/video'))) {
      console.log(JSON.stringify({
        ok: true,
        stage: 'verified',
        recoveredAfterPublishFailure: true,
        plan,
        publish: publishPayload || publish,
        verify: currentPayload.manage || currentPayload,
      }, null, 2));
      return;
    }
    if (isCurrentDraftPublishable(currentPayload)) {
      console.error('[publish-task] current draft is publishable; trying publish-current-draft once');
      const draftRetry = await runNodeStreaming([
        'scripts/douyin-cli.js',
        'publish-current-draft',
        '--title',
        plan.title,
        ...(plan.description ? ['--description', plan.description] : []),
        ...(plan.topics.length ? ['--topics', plan.topics.join(',')] : []),
        '--assistant-timeout',
        String(assistantTimeoutMs),
      ], {
        timeout: Math.min(publishTimeoutMs, 1_800_000),
        heartbeatMs: Number(args.heartbeatMs || process.env.DOUYIN_PUBLISH_HEARTBEAT_MS || 30000),
      });
      const draftPayload = parseLastJson(draftRetry.output);
      if (draftRetry.ok && draftPayload?.ok) {
        const verify = verifyPublishedWithRetry(plan.title);
        console.log(JSON.stringify({
          ok: verify.ok,
          stage: verify.ok ? 'verified' : 'verify',
          recoveredFromPublishableDraft: true,
          plan,
          publish: draftPayload,
          firstFailure: publishPayload || publish,
          previousState: currentPayload,
          verify: verify.verify,
          verifyAttempts: verify.attempts,
        }, null, 2));
        if (!verify.ok) process.exitCode = 1;
        return;
      }
      publishPayload = {
        ...(publishPayload || {}),
        retryCurrentDraft: draftPayload || draftRetry,
        previousState: currentPayload,
      };
    }
    if (/ProtocolError|protocolTimeout|Runtime\.callFunctionOn timed out|Network\.enable timed out|Target closed|Session closed|WebSocket/i.test(JSON.stringify(publishPayload || publish))) {
      console.error('[publish-task] protocol-style failure detected; trying publish-current-draft once');
      const retry = await runNodeStreaming([
        'scripts/douyin-cli.js',
        'publish-current-draft',
        '--title',
        plan.title,
        ...(plan.description ? ['--description', plan.description] : []),
        ...(plan.topics.length ? ['--topics', plan.topics.join(',')] : []),
        '--assistant-timeout',
        String(assistantTimeoutMs),
      ], {
        timeout: Math.min(publishTimeoutMs, 1_800_000),
        heartbeatMs: Number(args.heartbeatMs || process.env.DOUYIN_PUBLISH_HEARTBEAT_MS || 30000),
      });
      const retryPayload = parseLastJson(retry.output);
      if (retry.ok && retryPayload?.ok) {
        const verify = verifyPublishedWithRetry(plan.title);
        console.log(JSON.stringify({
          ok: verify.ok,
          stage: verify.ok ? 'verified' : 'verify',
          recoveredAfterProtocolTimeout: true,
          plan,
          publish: retryPayload,
          firstFailure: publishPayload || publish,
          verify: verify.verify,
          verifyAttempts: verify.attempts,
        }, null, 2));
        if (!verify.ok) process.exitCode = 1;
        return;
      }
      publishPayload = {
        ...(publishPayload || {}),
        retryCurrentDraft: retryPayload || retry,
      };
    }
    console.log(JSON.stringify({
      ok: false,
      stage: 'publish',
      plan,
      timeouts: { publishTimeoutMs, uploadTimeoutMs, assistantTimeoutMs },
      customerMessage: customerMessageForFailure(publishPayload || publish),
      publish: publishPayload || publish,
    }, null, 2));
    process.exitCode = 1;
    return;
  }

  const verify = verifyPublishedWithRetry(plan.title);
  console.log(JSON.stringify({
    ok: verify.ok,
    stage: verify.ok ? 'verified' : 'verify',
    plan,
    publish: publishPayload,
    verify: verify.verify,
    verifyAttempts: verify.attempts,
  }, null, 2));
  if (!verify.ok) process.exitCode = 1;
}

main().catch((err) => {
  console.log(JSON.stringify({ ok: false, error: err.message, stack: err.stack }, null, 2));
  process.exit(1);
});
