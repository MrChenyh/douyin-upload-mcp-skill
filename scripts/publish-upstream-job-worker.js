#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import '../src/config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = process.env.DOUYIN_MONITOR_STATE_DIR || join(process.env.HOME || process.env.USERPROFILE || '.', '.openclaw', 'workspace', 'social-auto-publish');
const UPSTREAM_CACHE_DIR = process.env.DOUYIN_UPSTREAM_CACHE_DIR || join(STATE_DIR, 'upstream');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith('--')) continue;
    const key = item.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) args[key] = true;
    else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function loadJob(jobPath) {
  return JSON.parse(readFileSync(jobPath, 'utf8'));
}

function saveJob(jobPath, patch) {
  const current = existsSync(jobPath) ? loadJob(jobPath) : {};
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
  mkdirSync(dirname(jobPath), { recursive: true });
  writeFileSync(jobPath, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

function runNode(args, opts = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd: join(__dirname, '..'),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: Number(opts.timeout || 3_600_000),
    windowsHide: true,
  });
  return {
    ok: result.status === 0,
    status: result.status,
    signal: result.signal,
    output: `${result.stdout || ''}${result.stderr || ''}`.trim(),
  };
}

function runNodeAsync(args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: join(__dirname, '..'),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...(opts.env || {}) },
      windowsHide: true,
    });
    const maxBuffer = Number(opts.maxBuffer || 2_000_000);
    const chunks = [];
    const startedAt = Date.now();
    let settled = false;
    let timedOut = false;
    let timer = null;

    function append(chunk) {
      chunks.push(Buffer.from(chunk));
      let total = chunks.reduce((sum, item) => sum + item.length, 0);
      while (total > maxBuffer && chunks.length > 1) total -= chunks.shift().length;
    }

    function finish(status, signal, error) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({
        ok: status === 0 && !timedOut,
        status,
        signal,
        error,
        timedOut,
        elapsedMs: Date.now() - startedAt,
        output: Buffer.concat(chunks).toString('utf8').trim(),
      });
    }

    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.on('error', (err) => finish(null, null, err.message));
    child.on('close', (status, signal) => finish(status, signal, null));

    const timeoutMs = Number(opts.timeout || 3_900_000);
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        setTimeout(() => {
          if (!settled) child.kill('SIGKILL');
        }, 5000).unref();
      }, timeoutMs);
      timer.unref();
    }
  });
}

function parseJsonObjects(text) {
  const objects = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  const raw = String(text || '');
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
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
      if (depth === 0 && start >= 0) {
        try {
          objects.push(JSON.parse(raw.slice(start, i + 1)));
        } catch {
          // Ignore logger text.
        }
        start = -1;
      }
    }
  }
  return objects;
}

function parseLastJson(text) {
  return parseJsonObjects(text).at(-1) || null;
}

function compactOutput(text, max = 5000) {
  const raw = String(text || '');
  return raw.length > max ? raw.slice(-max) : raw;
}

function startPublishHeartbeat(jobPath) {
  return setInterval(() => {
    saveJob(jobPath, {
      status: 'running',
      stage: 'publishing',
      heartbeatAt: new Date().toISOString(),
    });
  }, 10_000);
}

function publishLooksSuccessful(publishPayload, title) {
  return Boolean(
    publishPayload?.ok === true
      && publishPayload?.stage === 'verified'
      && publishPayload?.verify?.found === true
      && (!title || publishPayload.verify.title === title || publishPayload.verify.textSample?.includes?.(title))
  );
}

function failMessage(payload) {
  const text = JSON.stringify(payload || {});
  if (/publish_verification_required|publish_sms|发布需要短信验证|为确保是本人操作抖音账号/i.test(text)) {
    return '抖音发布需要短信验证。请在当前浏览器完成验证码后重试或继续发布草稿。';
  }
  if (/ProtocolError|protocolTimeout|Runtime\.callFunctionOn timed out|Network\.enable timed out|Target closed|Session closed|WebSocket/i.test(text)) {
    return '发布页面控制超时，当前草稿可能仍可恢复。请查看浏览器页面或稍后重试。';
  }
  if (/upload_timeout|editor_in_progress|upload_page_timeout|hd_publish_btn_not_found|editor_navigation_blocked|publish_editor_not_ready|publish_btn_not_found|publish_btn_obstructed|publish_btn_disabled|publish_submit_unconfirmed|publish_click_returned_to_upload/i.test(text)) {
    return '发布页面未准备好或上传流程被阻塞，请查看浏览器页面后重试。';
  }
  if (/cover|封面/i.test(text)) return '封面设置失败，请重新提供可用封面图片。';
  if (/video|upload|file|视频|上传/i.test(text)) return '视频处理失败，请重新提供可用视频。';
  if (/login|session|登录/i.test(text)) return '抖音需要重新登录。请先完成扫码/验证码/安全验证。';
  return '发布失败，请查看状态文件和浏览器页面。';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.job) {
    console.error('Usage: node scripts/publish-upstream-job-worker.js --job /abs/job.json');
    process.exit(2);
  }

  const jobPath = args.job;
  const job = saveJob(jobPath, { status: 'running', stage: 'prepare', startedAt: new Date().toISOString() });
  const taskPath = job.taskPath;
  const inputPath = job.inputPath;

  let preparedPayload = null;
  if (args.skipPrepare) {
    preparedPayload = { ok: true, skipped: true };
    saveJob(jobPath, { stage: 'prepared', prepared: preparedPayload });
  } else {
    const prepared = runNode([
      'scripts/prepare-upstream-publish-task.js',
      '--input', inputPath,
      '--output', taskPath,
      '--cache-dir', UPSTREAM_CACHE_DIR,
    ], { timeout: 180000 });
    preparedPayload = parseLastJson(prepared.output);
    saveJob(jobPath, {
      stage: 'prepared',
      prepared: preparedPayload || { ok: prepared.ok, output: compactOutput(prepared.output) },
    });
    if (!prepared.ok || !preparedPayload?.ok) {
      const message = preparedPayload?.customerMessage || '素材处理失败，请重新提供可用的视频和封面。';
      saveJob(jobPath, {
        ok: false,
        status: 'failed',
        stage: 'prepare_failed',
        message,
        error: preparedPayload || compactOutput(prepared.output),
        finishedAt: new Date().toISOString(),
      });
      process.exit(1);
    }
  }

  if (process.env.DOUYIN_TEST_FAKE_PUBLISH_SUCCESS === 'true') {
    const title = job.title || preparedPayload?.validation?.normalized?.title || '测试发布成功';
    const publishPayload = { ok: true, stage: 'verified', plan: { title }, verify: { found: true, title }, fake: true };
    saveJob(jobPath, {
      ok: true,
      status: 'succeeded',
      stage: 'verified',
      message: `《${title}》发布成功。`,
      publish: publishPayload,
      finishedAt: new Date().toISOString(),
    });
    return;
  }

  saveJob(jobPath, { stage: 'publishing', publishStartedAt: new Date().toISOString() });
  const publishTimer = startPublishHeartbeat(jobPath);
  const publish = await runNodeAsync([
    'scripts/publish-task.js',
    '--task', taskPath,
    '--execute',
  ], { timeout: Number(job.publishTimeoutMs || process.env.DOUYIN_PUBLISH_JOB_TIMEOUT_MS || 3_900_000) });
  clearInterval(publishTimer);
  const publishPayload = parseLastJson(publish.output);
  const title = publishPayload?.plan?.title || preparedPayload?.validation?.normalized?.title || '';

  if (!publish.ok || !publishLooksSuccessful(publishPayload, title)) {
    const text = JSON.stringify(publishPayload || publish.output || {});
    if (/publish_verification_required|publish_sms|为确保是本人操作抖音账号/i.test(text)) {
      const message = '抖音发布需要短信验证。请在当前浏览器完成验证码后重试或继续发布草稿。';
      saveJob(jobPath, {
        ok: false,
        status: 'blocked',
        stage: 'waiting_publish_sms',
        title,
        message,
        publish: publishPayload || { ok: publish.ok, output: compactOutput(publish.output) },
        finishedAt: new Date().toISOString(),
      });
      process.exit(0);
    }
    const message = publishPayload?.customerMessage || failMessage(publishPayload || publish.output);
    saveJob(jobPath, {
      ok: false,
      status: 'failed',
      stage: publishPayload?.stage || 'publish_failed',
      title,
      message,
      publish: publishPayload || { ok: publish.ok, output: compactOutput(publish.output) },
      finishedAt: new Date().toISOString(),
    });
    process.exit(1);
  }

  saveJob(jobPath, {
    ok: true,
    status: 'succeeded',
    stage: 'verified',
    title,
    message: title ? `《${title}》发布成功。` : '发布成功。',
    publish: publishPayload,
    finishedAt: new Date().toISOString(),
  });
}

main().catch((err) => {
  const args = parseArgs(process.argv.slice(2));
  if (args.job) {
    saveJob(args.job, {
      ok: false,
      status: 'failed',
      stage: 'crashed',
      message: '发布任务异常退出。',
      error: err.message,
      stack: err.stack,
      finishedAt: new Date().toISOString(),
    });
  } else {
    console.error(err.stack || err.message);
  }
  process.exit(1);
});
