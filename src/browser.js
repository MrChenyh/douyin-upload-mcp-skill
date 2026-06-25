/**
 * browser.js — 浏览器客户端连接器（面向 Skill）
 *
 * 职责：
 *   1. 向 Daemon 服务请求 wsEndpoint，并通过 puppeteer.connect() 直连浏览器。
 *   2. 如果 Daemon 未启动，自动以后台进程拉起 server.js，等待就绪后再连接。
 */
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import puppeteerCore from 'puppeteer-core';
import { addExtra } from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import config from './config.js';
import { sleep } from './util.js';

const puppeteer = addExtra(puppeteerCore);
puppeteer.use(StealthPlugin());

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DAEMON_SCRIPT = join(__dirname, 'daemon', 'server.js');

let _browser = null;

const DAEMON_URL = `http://127.0.0.1:${config.daemonPort}`;

const DAEMON_READY_TIMEOUT = 15_000;
const DAEMON_POLL_INTERVAL = 500;
const DAEMON_STOP_TIMEOUT = 8_000;
const ELECTRON_APP_URL = () => `http://${config.browserDebugHost}:${config.browserDebugPort}`;
const DOUYIN_CREATOR_HOST_RE = /(^|\.)creator\.douyin\.com$/i;
const DOUYIN_RELATED_HOST_RE = /(^|\.)(creator|www|login)\.douyin\.com$/i;

async function isDaemonAlive() {
  try {
    const res = await fetch(`${DAEMON_URL}/health`, { signal: AbortSignal.timeout(2000) });
    const data = await res.json();
    return data.ok === true;
  } catch {
    return false;
  }
}

function hasCommand(command) {
  const result = spawnSync('bash', ['-lc', `command -v ${command} >/dev/null 2>&1`], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return result.status === 0;
}

function killDaemonProcesses() {
  spawnSync('bash', ['-lc', "pgrep -f 'src/daemon/server.js' | xargs -r kill -TERM"], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
  });
}

function spawnDaemon(opts = {}) {
  console.log(`[browser] 🚀 Daemon 未运行，正在自动启动: node ${DAEMON_SCRIPT}`);
  const useXvfb = process.platform === 'linux'
    && hasCommand('xvfb-run')
    && (opts.forceXvfb || process.env.DOUYIN_USE_XVFB === 'true' || (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY));
  const command = useXvfb ? 'xvfb-run' : process.execPath;
  const args = useXvfb
    ? ['-a', '--server-args=-screen 0 1440x1000x24', process.execPath, DAEMON_SCRIPT]
    : [DAEMON_SCRIPT];

  const child = spawn(command, args, {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, ...(useXvfb ? { BROWSER_HEADLESS: 'false' } : {}) },
  });

  child.on('error', (err) => {
    console.warn(`[browser] Daemon 自动启动失败: ${err.message}`);
  });
  child.unref();
  console.log(`[browser] Daemon 进程已分离 (pid=${child.pid}, mode=${useXvfb ? 'xvfb-run' : 'plain'})，等待就绪...`);
}

async function waitDaemonReady() {
  const deadline = Date.now() + DAEMON_READY_TIMEOUT;
  while (Date.now() < deadline) {
    await sleep(DAEMON_POLL_INTERVAL);
    if (await isDaemonAlive()) {
      console.log('[browser] ✅ Daemon 就绪');
      return;
    }
  }

  throw new Error(
    `Daemon 自动启动超时（${DAEMON_READY_TIMEOUT / 1000}s 内未响应 /health）！\n` +
    `请检查端口 ${config.daemonPort} 是否被占用，或手动运行: npm run daemon`
  );
}

async function waitDaemonStopped() {
  const deadline = Date.now() + DAEMON_STOP_TIMEOUT;
  while (Date.now() < deadline) {
    if (!(await isDaemonAlive())) return true;
    await sleep(DAEMON_POLL_INTERVAL);
  }

  spawnSync('bash', ['-lc', "pgrep -f 'src/daemon/server.js' | xargs -r kill -KILL"], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
  });
  await sleep(DAEMON_POLL_INTERVAL);
  return !(await isDaemonAlive());
}

async function ensureDaemon(opts = {}) {
  if (await isDaemonAlive()) {
    return;
  }

  spawnDaemon(opts);
  await waitDaemonReady();
}

async function acquireBrowserFromDaemon() {
  console.log(`[browser] 正在呼叫 Daemon: ${DAEMON_URL}/browser/acquire ...`);
  const res = await fetch(`${DAEMON_URL}/browser/acquire`);
  const acquireData = await res.json();

  if (!acquireData.ok) {
    const detail = acquireData.detail ? ` (${acquireData.detail})` : '';
    throw new Error(`${acquireData.error || 'Daemon 返回失败'}${detail}`);
  }
  return acquireData;
}

function isDouyinCreatorUrl(value = '') {
  try {
    const parsed = new URL(value);
    return DOUYIN_CREATOR_HOST_RE.test(parsed.hostname);
  } catch {
    return /creator\.douyin\.com/i.test(String(value || ''));
  }
}

function isDouyinRelatedUrl(value = '') {
  try {
    const parsed = new URL(value);
    return DOUYIN_RELATED_HOST_RE.test(parsed.hostname);
  } catch {
    return /douyin\.com/i.test(String(value || ''));
  }
}

async function getPageTitle(page) {
  try {
    return await page.title();
  } catch {
    return '';
  }
}

/**
 * 在浏览器中找到抖音创作者平台标签页，或新开一个
 * @param {import('puppeteer-core').Browser} browser
 * @returns {Promise<import('puppeteer-core').Page>}
 */
async function findOrCreateDouyinPage(browser, opts = {}) {
  const pages = await browser.pages();

  // 优先复用已有的抖音创作者平台页面
  for (const page of pages) {
    const url = page.url();
    if (url.includes('creator.douyin.com')) {
      console.log('[browser] 命中已有抖音创作者平台页面');
      await page.bringToFront();
      return page;
    }
  }

  if (opts.requireExistingPage) {
    throw new Error('embedded_douyin_page_not_found');
  }

  // 没找到，新开一个标签页
  const page = await browser.newPage();
  await page.goto(config.douyinUrl, {
    waitUntil: 'networkidle2',
    timeout: 30_000,
  });
  console.log('[browser] 已打开新的抖音创作者平台页面');
  return page;
}

async function findOrCreateDouyinPageRobust(browser, opts = {}) {
  const pages = await browser.pages();
  const candidates = [];

  for (const page of pages) {
    const url = page.url();
    const title = await getPageTitle(page);
    if (isDouyinCreatorUrl(url)) candidates.push({ page, url, title, score: 0 });
    else if (isDouyinRelatedUrl(url)) candidates.push({ page, url, title, score: 20 });
    else if (/抖音|创作者|creator|douyin/i.test(`${title} ${url}`)) candidates.push({ page, url, title, score: 40 });
  }

  candidates.sort((a, b) => a.score - b.score);
  const best = candidates[0];
  if (best) {
    console.log(`[browser] 命中已有抖音创作者平台页面: ${best.url || best.title || 'unknown'}`);
    await best.page.bringToFront();
    if (!isDouyinCreatorUrl(best.url) && !opts.requireExistingPage) {
      await best.page.goto(config.douyinUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
      }).catch(() => {});
    }
    return best.page;
  }

  if (opts.requireExistingPage) {
    throw new Error('embedded_douyin_page_not_found');
  }

  const page = await browser.newPage();
  await page.goto(config.douyinUrl, {
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
  });
  console.log('[browser] 已打开新的抖音创作者平台页面');
  return page;
}

async function ensureElectronAppBrowser() {
  if (_browser && _browser.isConnected()) {
    const page = await findOrCreateDouyinPageRobust(_browser, { requireExistingPage: true });
    return { browser: _browser, page };
  }

  console.log(`[browser] 正在连接 Electron App CDP: ${ELECTRON_APP_URL()}`);
  _browser = await puppeteer.connect({
    browserURL: ELECTRON_APP_URL(),
    defaultViewport: null,
    protocolTimeout: config.browserProtocolTimeout,
  });

  try {
    const page = await findOrCreateDouyinPageRobust(_browser, {
      requireExistingPage: true,
    });
    console.log('[browser] 已连接到 Electron 内嵌抖音页面');
    return { browser: _browser, page };
  } catch (err) {
    disconnect();
    throw new Error(
      `Electron App 已连接，但未找到内嵌抖音页面。\n` +
      `请先在桌面 App 中打开抖音创作者平台，再重试。\n` +
      `底层报错: ${err.message}`
    );
  }
}

/**
 * 确保浏览器可用 — Skill 唯一的对外入口
 */
export async function ensureBrowser() {
  if (config.browserProvider === 'electron-app') {
    return ensureElectronAppBrowser();
  }

  if (_browser && _browser.isConnected()) {
    const page = await findOrCreateDouyinPageRobust(_browser, {
      requireExistingPage: config.browserRequireExistingPage,
    });
    return { browser: _browser, page };
  }

  await ensureDaemon();

  let acquireData;
  try {
    acquireData = await acquireBrowserFromDaemon();
  } catch (err) {
    if (/Missing X server|x server|DISPLAY|headful browser/i.test(err.message) && hasCommand('xvfb-run')) {
      console.warn('[browser] 当前 Daemon 无可用显示环境，重启到 xvfb-run 模式后重试...');
      killDaemonProcesses();
      await waitDaemonStopped();
      await sleep(1500);
      spawnDaemon({ forceXvfb: true });
      await waitDaemonReady();
      try {
        acquireData = await acquireBrowserFromDaemon();
      } catch (retryErr) {
        throw new Error(
          `Daemon 已用 xvfb-run 重启但获取浏览器仍失败！\n` +
          `底层报错: ${retryErr.message}`
        );
      }
    } else {
      throw new Error(
        `Daemon 已启动但获取浏览器失败！\n` +
        `底层报错: ${err.message}`
      );
    }
  }

  if (!acquireData) {
    throw new Error(
      `Daemon 已启动但获取浏览器失败！\n` +
      `底层报错: empty_acquire_response`
    );
  }

  console.log(`[browser] 从 Daemon 获取到 wsEndpoint，正在建立 CDP 直连...`);
  _browser = await puppeteer.connect({
    browserWSEndpoint: acquireData.wsEndpoint,
    defaultViewport: null,
    protocolTimeout: config.browserProtocolTimeout,
  });

  const page = await findOrCreateDouyinPageRobust(_browser, {
    requireExistingPage: config.browserRequireExistingPage,
  });
  console.log(`[browser] CDP 直连成功，pid=${acquireData.pid}`);
  return { browser: _browser, page };
}

/**
 * 断开 WebSocket 连接（不关闭浏览器）
 */
export function disconnect() {
  if (_browser) {
    _browser.disconnect();
    _browser = null;
    console.log('[browser] 已断开 CDP 连接（浏览器仍由 Daemon 守护）');
  }
}
