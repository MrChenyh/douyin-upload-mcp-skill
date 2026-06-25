#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const PUBLIC_DIR = join(__dirname, 'public');
const PORT = Number(process.env.LOCAL_PUBLISH_CONSOLE_PORT || 3766);
const IS_WINDOWS = process.platform === 'win32';
const STATE_DIR = process.env.LOCAL_PUBLISH_CONSOLE_STATE_DIR
  || (IS_WINDOWS && process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, 'DouyinLocalPublishConsole')
    : join(homedir(), '.douyin-local-publish-console'));
const JOB_DIR = join(STATE_DIR, 'jobs');
const UPLOAD_DIR = join(STATE_DIR, 'uploads');
const DOWNLOAD_DIR = join(STATE_DIR, 'downloads');
const TASK_DIR = join(STATE_DIR, 'tasks');

const jobs = new Map();

function now() {
  return new Date().toISOString();
}

function json(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function text(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
  });
  res.end(body);
}

function notFound(res) {
  json(res, 404, { ok: false, error: 'not_found' });
}

function readBody(req, maxBytes = 20 * 1024 * 1024) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error(`request_body_too_large:${maxBytes}`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolvePromise(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const body = await readBody(req, 2 * 1024 * 1024);
  if (!body.length) return {};
  return JSON.parse(body.toString('utf8'));
}

function parseMultipart(buffer, contentType) {
  const boundaryMatch = String(contentType || '').match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!boundaryMatch) throw new Error('multipart_boundary_missing');
  const boundary = Buffer.from(`--${boundaryMatch[1] || boundaryMatch[2]}`);
  const parts = [];
  let cursor = buffer.indexOf(boundary);
  while (cursor !== -1) {
    cursor += boundary.length;
    if (buffer[cursor] === 45 && buffer[cursor + 1] === 45) break;
    if (buffer[cursor] === 13 && buffer[cursor + 1] === 10) cursor += 2;
    const headerEnd = buffer.indexOf(Buffer.from('\r\n\r\n'), cursor);
    if (headerEnd === -1) break;
    const headerText = buffer.slice(cursor, headerEnd).toString('utf8');
    const next = buffer.indexOf(boundary, headerEnd + 4);
    if (next === -1) break;
    let dataEnd = next;
    if (buffer[dataEnd - 2] === 13 && buffer[dataEnd - 1] === 10) dataEnd -= 2;
    const disposition = headerText.match(/content-disposition:\s*form-data;([^\r\n]+)/i)?.[1] || '';
    const name = disposition.match(/name="([^"]+)"/i)?.[1];
    const filename = disposition.match(/filename="([^"]*)"/i)?.[1];
    const contentTypeHeader = headerText.match(/content-type:\s*([^\r\n]+)/i)?.[1]?.trim();
    if (name) {
      parts.push({
        name,
        filename,
        contentType: contentTypeHeader,
        data: buffer.slice(headerEnd + 4, dataEnd),
      });
    }
    cursor = next;
  }
  return parts;
}

async function readMultipart(req) {
  const body = await readBody(req, Number(process.env.LOCAL_PUBLISH_CONSOLE_MAX_UPLOAD_BYTES || 1024 * 1024 * 1024));
  const parts = parseMultipart(body, req.headers['content-type']);
  const fields = {};
  const files = {};
  mkdirSync(UPLOAD_DIR, { recursive: true });
  for (const part of parts) {
    if (part.filename) {
      if (!part.data.length) continue;
      const ext = extname(part.filename) || '';
      const safeName = `${Date.now()}-${randomUUID()}${ext}`;
      const filePath = join(UPLOAD_DIR, safeName);
      writeFileSync(filePath, part.data);
      files[part.name] = {
        originalName: part.filename,
        path: filePath,
        contentType: part.contentType,
        size: part.data.length,
      };
    } else {
      fields[part.name] = part.data.toString('utf8').trim();
    }
  }
  return { fields, files };
}

function runNodeSync(args, opts = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: Number(opts.timeout || 120000),
    env: { ...process.env, ...(opts.env || {}) },
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
  return {
    ok: result.status === 0,
    status: result.status,
    signal: result.signal,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    output,
    json: parseLastJson(output),
  };
}

function parseLastJson(textValue) {
  const source = String(textValue || '').trim();
  const candidates = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
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
        candidates.push(source.slice(start, i + 1));
        start = -1;
      }
    }
  }
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(candidates[i]);
    } catch {
      // Try the previous candidate.
    }
  }
  return null;
}

function commandExists(command) {
  if (IS_WINDOWS) {
    const result = spawnSync('where.exe', [command], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    return result.status === 0;
  }
  const result = spawnSync('bash', ['-lc', `command -v ${command} >/dev/null 2>&1`], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return result.status === 0;
}

function nodeModuleAvailable(moduleName) {
  const result = spawnSync(process.execPath, ['-e', `import('${moduleName}').then(()=>process.exit(0)).catch(()=>process.exit(1))`], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 20_000,
  });
  return result.status === 0;
}

function findBrowser() {
  const envPath = process.env.BROWSER_PATH;
  if (envPath && existsSync(envPath)) return { ok: true, path: envPath, source: 'BROWSER_PATH' };
  if (IS_WINDOWS) {
    const bases = [
      process.env.PROGRAMFILES,
      process.env['PROGRAMFILES(X86)'],
      process.env.LOCALAPPDATA,
    ].filter(Boolean);
    const paths = [
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ];
    for (const base of bases) {
      paths.push(
        join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      );
    }
    for (const item of paths) {
      if (existsSync(item)) return { ok: true, path: item, source: 'windows-known-path' };
    }
    return { ok: false, path: null, source: null };
  }
  const candidates = [
    'google-chrome',
    'google-chrome-stable',
    'chromium-browser',
    'chromium',
    'microsoft-edge',
    'microsoft-edge-stable',
  ];
  for (const command of candidates) {
    const result = spawnSync('bash', ['-lc', `command -v ${command}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const path = result.stdout.trim();
    if (result.status === 0 && path) return { ok: true, path, source: command };
  }
  return { ok: false, path: null, source: null };
}

function npmAvailable() {
  const runtimeNpm = IS_WINDOWS
    ? join(ROOT, '.runtime', 'node-v22.22.1-win-x64', 'npm.cmd')
    : null;
  const command = runtimeNpm && existsSync(runtimeNpm)
    ? runtimeNpm
    : (process.platform === 'win32' ? 'npm.cmd' : 'npm');
  const result = IS_WINDOWS
    ? spawnSync('cmd.exe', ['/d', '/c', 'call', command, '--version'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 20_000,
      windowsHide: true,
    })
    : spawnSync(command, ['--version'], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 20_000,
    windowsHide: true,
  });
  return {
    ok: result.status === 0,
    version: String(result.stdout || '').trim() || null,
    command,
    error: result.error?.message || null,
    stderr: String(result.stderr || '').trim() || null,
  };
}

function portableNodeInfo() {
  const nodePath = process.execPath;
  const inRuntimeDir = nodePath.toLowerCase().includes(`${sep}.runtime${sep}`.toLowerCase())
    || nodePath.toLowerCase().includes('\\.runtime\\')
    || nodePath.toLowerCase().includes('/.runtime/');
  return {
    nodePath,
    portable: inRuntimeDir || Boolean(process.env.LOCAL_PUBLISH_PORTABLE_NODE),
  };
}

function normalizeTitle(title) {
  return Array.from(String(title || '')
    .replace(/#[^\s#，。,;；!！?？)）(（]+/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[，,、；;：:|｜\\/-]+$/g, '')
    .trim())
    .slice(0, 30)
    .join('');
}

function splitTags(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).replace(/^#+/, '').trim()).filter(Boolean);
  return String(value || '')
    .split(/(?=#)|[,，\s]+/)
    .map((item) => item.replace(/^#+/, '').trim())
    .filter(Boolean);
}

function extFromUrl(url, fallback) {
  try {
    const parsed = new URL(url);
    const ext = extname(parsed.pathname);
    if (ext) return ext;
  } catch {
    // Fall through.
  }
  return fallback;
}

async function download(url, fallbackExt) {
  const clean = String(url || '').trim();
  if (!clean) return null;
  mkdirSync(DOWNLOAD_DIR, { recursive: true });
  const hash = createHash('sha256').update(clean).digest('hex').slice(0, 16);
  const outputPath = join(DOWNLOAD_DIR, `${hash}${extFromUrl(clean, fallbackExt)}`);
  if (existsSync(outputPath)) return outputPath;
  let response;
  try {
    response = await fetch(clean);
  } catch (err) {
    throw new Error(`download_failed:${err.message}`);
  }
  if (!response.ok || !response.body) {
    throw new Error(`download_failed:${response.status}`);
  }
  await pipeline(response.body, createWriteStream(outputPath));
  return outputPath;
}

function validateLocalFile(filePath, label) {
  if (!filePath) return null;
  const absolute = resolve(filePath);
  if (!existsSync(absolute)) throw new Error(`${label}_not_found`);
  const st = statSync(absolute);
  if (!st.isFile()) throw new Error(`${label}_not_file`);
  return absolute;
}

function buildTask({ title, description, tags, videoPath, videoUrl, coverPath, coverUrl }) {
  const safeTitle = normalizeTitle(title);
  return {
    type: 'video',
    media: {
      videoPath,
      videoUrl: videoUrl || null,
      videoPaths: [],
      cover: {
        mode: 'auto_recommended',
        imagePath: coverPath || null,
        imageUrl: coverUrl || null,
      },
    },
    metadata: {
      title: safeTitle,
      description: String(description || '').trim(),
      topics: splitTags(tags),
      mentions: [],
      collection: null,
      declaration: null,
      chapters: [],
      tags: splitTags(tags),
      location: null,
      hotspot: null,
    },
    settings: {
      visibility: 'public',
      allowSave: true,
      publishTime: { mode: 'now', scheduledAt: null },
    },
  };
}

function saveJob(job) {
  mkdirSync(JOB_DIR, { recursive: true });
  writeFileSync(join(JOB_DIR, `${job.id}.json`), `${JSON.stringify(publicJob(job), null, 2)}\n`);
}

function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    currentStep: job.currentStep,
    canCancel: Boolean(job.child && !job.finishedAt),
    input: job.input,
    taskPath: job.taskPath,
    result: job.result,
    error: job.error,
    logs: job.logs.slice(-500),
  };
}

function pushLog(job, level, message, extra = null) {
  job.logs.push({ ts: now(), level, message, extra });
  saveJob(job);
}

function setStep(job, step) {
  job.currentStep = step;
  pushLog(job, 'info', step);
}

async function prepareTaskFromInput(input) {
  let videoPath = input.videoFilePath ? validateLocalFile(input.videoFilePath, 'video') : null;
  let coverPath = input.coverFilePath ? validateLocalFile(input.coverFilePath, 'cover') : null;
  const videoUrl = String(input.videoUrl || '').trim();
  const coverUrl = String(input.coverUrl || '').trim();

  if (!videoPath && videoUrl) videoPath = await download(videoUrl, '.mp4');
  if (!coverPath && coverUrl) coverPath = await download(coverUrl, '.png');

  return buildTask({
    title: input.title,
    description: input.description,
    tags: input.tags,
    videoPath,
    videoUrl,
    coverPath,
    coverUrl,
  });
}

function classifyPublishResult(payload, output) {
  const textValue = JSON.stringify(payload || {}) + '\n' + String(output || '');
  if (payload?.ok === true) return { ok: true, status: 'succeeded', message: '发布成功，已在作品管理页验证。' };
  if (/ERR_MODULE_NOT_FOUND|Cannot find package|MODULE_NOT_FOUND|puppeteer-core|npm install|npm ci/i.test(textValue)) {
    return { ok: false, status: 'failed', message: '本地依赖未安装完整，请先在项目目录执行 npm ci。' };
  }
  if (/sms|验证码|publish_verification_required/i.test(textValue)) {
    return { ok: false, status: 'needs_user_action', message: '抖音要求验证码或二次确认，请在浏览器里手动完成后重新查询或重试发布。' };
  }
  if (/captcha|安全验证|滑块|机器人|risk|风控|device/i.test(textValue)) {
    return { ok: false, status: 'needs_user_action', message: '抖音出现安全验证或风控，请在浏览器里手动完成。' };
  }
  if (/login|session|qrcode|未登录/i.test(textValue)) {
    return { ok: false, status: 'needs_login', message: '抖音未登录或登录已失效，请先在本机浏览器完成登录。' };
  }
  if (/cover|封面/i.test(textValue)) {
    return { ok: false, status: 'failed', message: '封面设置失败，请重新选择可用封面。' };
  }
  if (/video|upload|上传|file_not_found/i.test(textValue)) {
    return { ok: false, status: 'failed', message: '视频处理或上传失败，请重新选择可用视频。' };
  }
  if (/timeout|ProtocolError|Target closed|Session closed|WebSocket/i.test(textValue)) {
    return { ok: false, status: 'uncertain', message: '页面控制超时，当前发布结果不确定，请查看浏览器页面或作品管理页。' };
  }
  return { ok: false, status: 'failed', message: '发布失败，请查看日志和浏览器页面。' };
}

async function runPublishJob(job) {
  try {
    job.status = 'running';
    job.startedAt = now();
    setStep(job, '准备素材');
    const task = await prepareTaskFromInput(job.input);
    mkdirSync(TASK_DIR, { recursive: true });
    job.taskPath = join(TASK_DIR, `${job.id}.json`);
    writeFileSync(job.taskPath, `${JSON.stringify(task, null, 2)}\n`);

    setStep(job, '校验任务字段');
    const validate = runNodeSync(['scripts/validate-publish-task.js', '--task', job.taskPath]);
    job.validation = validate.json || validate.output;
    if (!validate.ok) {
      job.status = 'failed';
      job.error = {
        message: '任务字段校验失败，请检查视频、标题、封面和 tags。',
        validation: job.validation,
      };
      pushLog(job, 'error', job.error.message, job.error.validation);
      return;
    }

    setStep(job, '执行抖音发布');
    const child = spawn(process.execPath, [
      'scripts/publish-task.js',
      '--task',
      job.taskPath,
      '--execute',
    ], {
      cwd: ROOT,
      env: {
        ...process.env,
        DOUYIN_PUBLISH_TASK_TIMEOUT_MS: process.env.DOUYIN_PUBLISH_TASK_TIMEOUT_MS || '3600000',
        DOUYIN_UPLOAD_TIMEOUT_MS: process.env.DOUYIN_UPLOAD_TIMEOUT_MS || '1800000',
        DOUYIN_ASSISTANT_TIMEOUT_MS: process.env.DOUYIN_ASSISTANT_TIMEOUT_MS || '600000',
        BROWSER_PROTOCOL_TIMEOUT: process.env.BROWSER_PROTOCOL_TIMEOUT || '1200000',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    job.child = child;
    let output = '';
    child.stdout.on('data', (chunk) => {
      const textChunk = chunk.toString();
      output += textChunk;
      pushLog(job, 'stdout', textChunk.trim());
    });
    child.stderr.on('data', (chunk) => {
      const textChunk = chunk.toString();
      output += textChunk;
      pushLog(job, 'stderr', textChunk.trim());
    });
    const exit = await new Promise((resolveExit) => {
      child.on('exit', (code, signal) => resolveExit({ code, signal }));
    });
    job.child = null;
    job.finishedAt = now();
    const payload = parseLastJson(output);
    const classified = classifyPublishResult(payload, output);
    job.status = classified.status;
    job.result = {
      exit,
      ok: exit.code === 0 && classified.ok,
      message: classified.message,
      payload,
    };
    pushLog(job, classified.ok ? 'info' : 'warn', classified.message, { exit });
  } catch (err) {
    job.status = /download_failed|fetch failed|not_found|not_file|校验/.test(err.message) ? 'failed' : 'uncertain';
    job.finishedAt = now();
    job.error = {
      message: err.message,
      stack: err.stack,
    };
    pushLog(job, 'error', err.message);
  } finally {
    saveJob(job);
  }
}

async function createPublishJobFromRequest(req) {
  const contentType = String(req.headers['content-type'] || '');
  if (contentType.includes('multipart/form-data')) {
    const { fields, files } = await readMultipart(req);
    return {
      title: fields.title,
      description: fields.description,
      tags: fields.tags,
      videoUrl: fields.videoUrl,
      coverUrl: fields.coverUrl,
      videoFilePath: fields.videoFilePath || files.video?.path,
      coverFilePath: fields.coverFilePath || files.cover?.path,
    };
  }
  return readJson(req);
}

function handleHealth(res) {
  const scripts = [
    'scripts/publish-task.js',
    'scripts/validate-publish-task.js',
    'scripts/douyin-cli.js',
    'scripts/douyin-login-monitor.js',
  ];
  const browser = findBrowser();
  const npm = npmAvailable();
  const nodeRuntime = portableNodeInfo();
  const dependencies = {
    'puppeteer-core': nodeModuleAvailable('puppeteer-core'),
    'puppeteer-extra': nodeModuleAvailable('puppeteer-extra'),
    'puppeteer-extra-plugin-stealth': nodeModuleAvailable('puppeteer-extra-plugin-stealth'),
  };
  const payload = {
    ok: scripts.every((item) => existsSync(join(ROOT, item))) && browser.ok && Object.values(dependencies).every(Boolean),
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    nodeRuntime,
    npm,
    root: ROOT,
    stateDir: STATE_DIR,
    scripts: Object.fromEntries(scripts.map((item) => [item, existsSync(join(ROOT, item))])),
    dependencies,
    browser,
    hasXvfbRun: IS_WINDOWS ? false : commandExists('xvfb-run'),
    openclawRequired: false,
  };
  json(res, payload.ok ? 200 : 503, payload);
}

function handleLoginOpen(res) {
  const result = runNodeSync(['local-publish-console/scripts/open-login-page.js'], { timeout: 60000 });
  json(res, result.ok ? 200 : 500, {
    ok: result.ok,
    message: result.ok ? '已打开抖音创作者平台。请在浏览器里手动完成登录。' : '打开抖音页面失败。',
    result: result.json || result.output,
  });
}

function handleLoginStatus(res) {
  const result = runNodeSync(['scripts/douyin-cli.js', 'check-login'], { timeout: 120000 });
  const payload = result.json || {};
  const safeRaw = { ...payload };
  if (safeRaw.qrcodePath) safeRaw.qrcodePath = '[local-browser-qr-hidden]';
  json(res, result.ok ? 200 : 500, {
    ok: result.ok,
    loggedIn: Boolean(payload.loggedIn),
    phase: payload.phase || 'unknown',
    message: payload.loggedIn
      ? '抖音已登录。'
      : '抖音未登录或需要人工验证，请在弹出的浏览器里完成登录后重新检测。',
    raw: safeRaw || result.output,
  });
}

async function handlePublish(req, res) {
  const input = await createPublishJobFromRequest(req);
  const title = normalizeTitle(input.title);
  if (!title) {
    json(res, 400, { ok: false, error: 'title_required', message: '请填写标题。' });
    return;
  }
  if (!input.videoUrl && !input.videoFilePath) {
    json(res, 400, { ok: false, error: 'video_required', message: '请填写视频 URL、视频绝对路径，或上传视频文件。' });
    return;
  }
  const job = {
    id: randomUUID(),
    status: 'queued',
    createdAt: now(),
    startedAt: null,
    finishedAt: null,
    currentStep: '排队中',
    input: { ...input, title },
    taskPath: null,
    result: null,
    error: null,
    logs: [],
    child: null,
  };
  jobs.set(job.id, job);
  saveJob(job);
  setImmediate(() => runPublishJob(job));
  json(res, 202, { ok: true, job: publicJob(job) });
}

function handleJobStatus(res, jobId) {
  const job = jobs.get(jobId);
  if (job) {
    json(res, 200, { ok: true, job: publicJob(job) });
    return;
  }
  const path = join(JOB_DIR, `${jobId}.json`);
  if (existsSync(path)) {
    json(res, 200, { ok: true, job: JSON.parse(readFileSync(path, 'utf8')) });
    return;
  }
  notFound(res);
}

function handleCancel(res, jobId) {
  const job = jobs.get(jobId);
  if (!job) {
    notFound(res);
    return;
  }
  if (job.child && !job.finishedAt) {
    job.child.kill('SIGTERM');
    job.status = 'cancelled';
    job.finishedAt = now();
    pushLog(job, 'warn', '任务已取消');
  }
  json(res, 200, { ok: true, job: publicJob(job) });
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const relative = url.pathname === '/' ? '/index.html' : url.pathname;
  const filePath = resolve(PUBLIC_DIR, `.${relative}`);
  if (!filePath.startsWith(PUBLIC_DIR) || !existsSync(filePath)) {
    notFound(res);
    return;
  }
  const ext = extname(filePath);
  const type = ext === '.html' ? 'text/html; charset=utf-8'
    : ext === '.css' ? 'text/css; charset=utf-8'
      : ext === '.js' ? 'application/javascript; charset=utf-8'
        : 'application/octet-stream';
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
  createReadStream(filePath).pipe(res);
}

async function router(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    if (req.method === 'GET' && url.pathname === '/api/health') return handleHealth(res);
    if (req.method === 'POST' && url.pathname === '/api/login/open') return handleLoginOpen(res);
    if (req.method === 'GET' && url.pathname === '/api/login/status') return handleLoginStatus(res);
    if (req.method === 'POST' && url.pathname === '/api/publish') return handlePublish(req, res);
    const jobMatch = url.pathname.match(/^\/api\/publish\/([^/]+)$/);
    if (req.method === 'GET' && jobMatch) return handleJobStatus(res, jobMatch[1]);
    const cancelMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/cancel$/);
    if (req.method === 'POST' && cancelMatch) return handleCancel(res, cancelMatch[1]);
    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res);
    return text(res, 405, 'method not allowed');
  } catch (err) {
    json(res, 500, { ok: false, error: err.message, stack: err.stack });
  }
}

mkdirSync(STATE_DIR, { recursive: true });
mkdirSync(JOB_DIR, { recursive: true });
mkdirSync(UPLOAD_DIR, { recursive: true });
mkdirSync(DOWNLOAD_DIR, { recursive: true });
mkdirSync(TASK_DIR, { recursive: true });

const server = createServer(router);
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Local Douyin publish console: http://127.0.0.1:${PORT}`);
});
