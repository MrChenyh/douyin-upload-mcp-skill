#!/usr/bin/env node
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';

const TEXT = {
  publish: '发表',
  know: '我知道了',
  ok: '确定',
  confirm: '确认',
  done: '完成',
  cover: '封面',
  profileCard: '个人主页卡片',
  success: '发表成功',
  management: '视频管理',
  published: '已发表',
  cancelUpload: '取消上传',
  coverPreview: '封面预览',
};

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function publishCompleted(finalText, title, url = '') {
  const text = normalizeText(finalText);
  const cleanTitle = normalizeText(title);
  if (/发表成功|已发表/.test(text)) return true;
  if (url.includes('/post/list') && cleanTitle && text.includes(cleanTitle)) return true;
  return false;
}

function parseTencentListTimes(textValue) {
  const text = normalizeText(textValue);
  const matches = text.matchAll(/(20\d{2})年(\d{2})月(\d{2})日\s+(\d{2}):(\d{2})/g);
  const dates = [];
  for (const match of matches) {
    const [, year, month, day, hour, minute] = match;
    dates.push(new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      0,
      0,
    ));
  }
  return dates.filter((date) => !Number.isNaN(date.getTime()));
}

function hasRecentListItem(finalText, startedAt, finishedAt = new Date()) {
  const started = startedAt instanceof Date ? startedAt.getTime() : Number(startedAt || 0);
  const finished = finishedAt instanceof Date ? finishedAt.getTime() : Number(finishedAt || Date.now());
  if (!started) return false;
  const lowerBound = started - 5 * 60 * 1000;
  const upperBound = finished + 5 * 60 * 1000;
  return parseTencentListTimes(finalText).some((date) => {
    const time = date.getTime();
    return time >= lowerBound && time <= upperBound;
  });
}

function hasProcessingListItem(finalText) {
  return /视频\s*\(\d+\).*发表视频\s+处理中\s+删除/.test(normalizeText(finalText));
}

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function splitList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || '').trim()).filter(Boolean);
  return String(value || '').split(/[,\s，、]+/u).map((item) => item.trim()).filter(Boolean);
}

function print(payload) {
  console.log(JSON.stringify(payload, null, 2));
}

async function screenshot(page, outDir, name) {
  if (!outDir) return '';
  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, `${name}.png`);
  await page.screenshot({ path, fullPage: true }).catch(() => {});
  print({ screenshot: name, path });
  return path;
}

function publishFrames(page) {
  return page.frames().filter((frame) => frame.url().includes('/micro/content/post/create')).reverse();
}

async function frameSummary(page) {
  const rows = [];
  for (const frame of publishFrames(page)) {
    rows.push(await frame.evaluate(() => ({
      url: location.href,
      fileCount: document.querySelectorAll('input[type="file"], input[accept*="video"]').length,
      editor: Boolean(document.querySelector('div.input-editor,[contenteditable="true"]')),
      buttons: [...document.querySelectorAll('button')].map((el) => ({
        text: (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim(),
        cls: String(el.className || ''),
        disabled: Boolean(el.disabled),
      })).slice(-10),
      text: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 260),
    })).catch((error) => ({ url: frame.url(), error: String(error) })));
  }
  return rows;
}

async function getPage(browser) {
  const pages = await browser.pages();
  const page = pages.find((item) => item.url().includes('channels.weixin.qq.com/platform/post/create'))
    || pages.find((item) => item.url().includes('channels.weixin.qq.com/platform/'));
  if (!page) throw new Error('tencent_embedded_page_not_found');
  if (!page.url().includes('/platform/post/create')) {
    await page.goto('https://channels.weixin.qq.com/platform/post/create', { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {});
  }
  return page;
}

async function getFrameWithVideoInput(page, timeoutMs = 60_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    for (const frame of publishFrames(page)) {
      const inputHandle = await frame.evaluateHandle(() => (
        document.querySelector('input[type="file"][accept*="video"], input[accept*="video"], input[type="file"]')
      )).catch(() => null);
      const input = inputHandle?.asElement ? inputHandle.asElement() : null;
      if (input) return { frame, input };
    }
    await sleep(500);
  }
  throw new Error(`video_input_not_found:${JSON.stringify(await frameSummary(page))}`);
}

async function getPrimaryFrame(page, timeoutMs = 180_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    for (const frame of publishFrames(page)) {
      const ok = await frame.evaluate(() => {
        const editor = document.querySelector('div.input-editor,[contenteditable="true"]');
        if (!editor) return false;
        const rect = editor.getBoundingClientRect();
        const style = getComputedStyle(editor);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      }).catch(() => false);
      if (ok) return frame;
    }
    await sleep(1000);
  }
  throw new Error(`tencent_publish_frame_not_ready:${JSON.stringify(await frameSummary(page))}`);
}

async function clickVisibleTextButton(frame, texts) {
  const list = Array.isArray(texts) ? texts : [texts];
  const buttons = await frame.$$('button, a, div, span');
  for (const button of buttons) {
    const info = await frame.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return {
        text: (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim(),
        cls: String(el.className || ''),
        visible: rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden',
        disabled: Boolean(el.disabled) || String(el.className || '').includes('disabled'),
      };
    }, button).catch(() => null);
    if (info?.visible && !info.disabled && list.includes(info.text)) {
      await button.click();
      return true;
    }
  }
  return false;
}

async function dismissTips(frame) {
  for (let i = 0; i < 6; i += 1) {
    const clicked = await clickVisibleTextButton(frame, TEXT.know);
    if (!clicked) return;
    await sleep(600);
  }
}

async function fillContent(frame, payload) {
  const tags = splitList(payload.tags);
  const body = [
    payload.title,
    tags.map((tag) => `#${tag.replace(/^#/, '')}`).join(' '),
    payload.description,
  ].filter(Boolean).join('\n');
  const filled = await frame.evaluate((value) => {
    const editor = document.querySelector('div.input-editor,[contenteditable="true"]');
    if (!editor) return false;
    editor.focus();
    editor.textContent = value;
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    editor.dispatchEvent(new Event('change', { bubbles: true }));
    editor.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
    return true;
  }, body);
  if (!filled) throw new Error('description_editor_not_found');

  const shortTitle = String(payload.shortTitle || payload.title || '').slice(0, 16);
  await frame.evaluate((value) => {
    const input = [...document.querySelectorAll('input[type="text"]')]
      .find((el) => (el.placeholder || '').includes('短标题') || String(el.className || '').includes('weui-desktop-form__input'));
    if (!input || !value) return;
    input.focus();
    input.value = value;
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, shortTitle);
}

async function findPublishButton(frame) {
  const target = await frame.evaluate(() => {
    const body = document.querySelector('.app-body') || document.scrollingElement || document.documentElement;
    if (body) body.scrollTop = body.scrollHeight;
    window.scrollTo(0, document.body?.scrollHeight || 0);
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const candidates = [...document.querySelectorAll('button')]
      .map((el) => {
        const rect = el.getBoundingClientRect();
        return {
          text: (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim(),
          cls: String(el.className || ''),
          visible: visible(el),
          disabled: Boolean(el.disabled) || String(el.className || '').includes('disabled'),
          x: rect.x + rect.width / 2,
          y: rect.y + rect.height / 2,
          width: rect.width,
          height: rect.height,
          top: rect.y,
        };
      })
      .filter((item) => item.visible && item.text === '发表')
      .sort((a, b) => {
        const rank = (item) => {
          let value = 0;
          if (!/primary/i.test(item.cls)) value += 100;
          if (item.disabled) value += 1000;
          value += Math.abs((item.width * item.height) - 4800) / 100;
          return value;
        };
        return rank(a) - rank(b) || b.top - a.top;
      });
    return candidates[0] || null;
  }).catch(() => null);
  if (!target) return null;
  return {
    info: {
      text: target.text,
      cls: target.cls,
      visible: target.visible,
      disabled: target.disabled,
    },
    click: async (page) => {
      await page.mouse.click(target.x, target.y);
    },
  };
}

async function clickPublishButton(page, frame, timeoutMs = 30_000) {
  const started = Date.now();
  let lastText = '';
  while (Date.now() - started < timeoutMs) {
    const found = await findPublishButton(frame);
    if (found && !found.info.disabled) {
      await found.click(page);
      return { ok: true, method: 'mouse-coordinate', info: found.info };
    }
    lastText = await frame.evaluate(() => (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 800)).catch(() => '');
    if (/上传失败|不支持|违规|请重新上传|登录/.test(lastText)) {
      return {
        ok: false,
        error: 'tencent_upload_blocked',
        detail: lastText,
      };
    }
    await sleep(1000);
  }
  return { ok: false, error: 'publish_button_not_enabled', detail: lastText };
}

async function waitPublishEnabled(frame, timeoutMs = 600_000) {
  const started = Date.now();
  let lastText = '';
  while (Date.now() - started < timeoutMs) {
    const found = await findPublishButton(frame);
    if (found && !found.info.disabled) return found;
    lastText = await frame.evaluate(() => (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 800)).catch(() => '');
    if (/上传失败|不支持|违规|请重新上传|登录/.test(lastText)) throw new Error(`tencent_upload_blocked:${lastText}`);
    await sleep(2000);
  }
  throw new Error(`publish_button_not_enabled:${lastText}`);
}

async function setCover(frame, coverPath) {
  if (!coverPath) return { ok: false, reason: 'cover_not_provided' };
  const entry = await frame.evaluateHandle((coverText, profileCardText) => {
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 20 && rect.height > 20 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    return [...document.querySelectorAll('div,button,span')]
      .find((el) => visible(el) && (
        (el.innerText || '').includes(coverText)
        || (el.innerText || '').includes(profileCardText)
        || String(el.className || '').includes('cover')
      ));
  }, TEXT.cover, TEXT.profileCard);
  const element = entry.asElement();
  if (!element) return { ok: false, reason: 'cover_entry_not_found' };
  await element.click().catch(() => {});
  await sleep(1500);

  const coverInputHandle = await frame.evaluateHandle(() => (
    document.querySelector('input[type="file"][accept*="image"], input[accept*="image"], input[type="file"][accept*=".png"], input[type="file"][accept*="jpg"]')
  )).catch(() => null);
  const coverInput = coverInputHandle?.asElement ? coverInputHandle.asElement() : null;
  if (!coverInput) return { ok: false, reason: 'cover_file_input_not_found' };
  await coverInput.uploadFile(coverPath);
  await sleep(2000);
  await clickVisibleTextButton(frame, [TEXT.ok, TEXT.confirm, TEXT.done]);
  await sleep(1200);
  await clickVisibleTextButton(frame, [TEXT.ok, TEXT.confirm, TEXT.done]);
  await sleep(1200);
  return { ok: true };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const videoPath = String(args.file || args.video || '').trim();
  const title = String(args.title || '').trim();
  if (!videoPath || !title) {
    throw new Error('Usage: node scripts/tencent-embedded-publish.js --file <mp4> --title <title> [--desc <desc>] [--tags <tags>] [--thumbnail <image>]');
  }

  const debugHost = process.env.BROWSER_DEBUG_HOST || '127.0.0.1';
  const debugPort = process.env.BROWSER_DEBUG_PORT || '40821';
  const browserURL = `http://${debugHost}:${debugPort}`;
  const outDir = args.debug
    ? join(process.cwd(), 'temp', 'tencent-embedded-publish', new Date().toISOString().replace(/[:.]/g, '-'))
    : '';
  const payload = {
    videoPath,
    coverPath: String(args.thumbnail || args.cover || '').trim(),
    title,
    description: String(args.desc || args.description || title).trim(),
    tags: splitList(args.tags),
    shortTitle: String(args.shortTitle || title).trim(),
  };

  const browser = await puppeteer.connect({ browserURL, defaultViewport: null });
  try {
    const page = await getPage(browser);
    await page.bringToFront().catch(() => {});
    await screenshot(page, outDir, '00-ready');

    let frame = await getPrimaryFrame(page);
    await dismissTips(frame);
    const initialText = await frame.evaluate(() => document.body?.innerText || '').catch(() => '');
    if (!(initialText.includes(TEXT.cancelUpload) || initialText.includes(TEXT.coverPreview))) {
      const target = await getFrameWithVideoInput(page);
      frame = target.frame;
      await target.input.uploadFile(payload.videoPath);
      await screenshot(page, outDir, '01-video-selected');
      frame = await getPrimaryFrame(page);
    }

    await fillContent(frame, payload);
    await screenshot(page, outDir, '02-fields-filled');
    const publishReady = await waitPublishEnabled(frame);
    await screenshot(page, outDir, '03-upload-complete');
    const cover = await setCover(frame, payload.coverPath);
    await screenshot(page, outDir, '04-before-publish');

    const publishClick = await clickPublishButton(page, frame, 30_000);
    if (!publishClick.ok) throw new Error(`${publishClick.error}:${publishClick.detail || ''}`);
    const publishClickedAt = new Date();
    await sleep(6000);
    await screenshot(page, outDir, '05-after-publish-click');

    let finalText = '';
    for (let i = 0; i < 48; i += 1) {
      finalText = await frame.evaluate(() => (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 1600)).catch(() => '');
      if (
        publishCompleted(finalText, payload.title, page.url())
        || (page.url().includes('/post/list') && hasRecentListItem(finalText, publishClickedAt))
        || (page.url().includes('/post/list') && hasProcessingListItem(finalText))
      ) break;
      await clickVisibleTextButton(frame, [TEXT.ok, TEXT.confirm, TEXT.know]);
      await sleep(2500);
    }
    await screenshot(page, outDir, '06-final');
    finalText = await frame.evaluate(() => (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 1600)).catch(() => finalText);
    const recentListItem = page.url().includes('/post/list') && hasRecentListItem(finalText, publishClickedAt);
    const processingListItem = page.url().includes('/post/list') && hasProcessingListItem(finalText);
    const ok = publishCompleted(finalText, payload.title, page.url()) || recentListItem || processingListItem;
    print({
      ok,
      platform: 'tencent',
      title: payload.title,
      cover,
      publishReady: publishReady.info,
      recentListItem,
      processingListItem,
      finalUrl: page.url(),
      finalText,
      outDir,
    });
    if (!ok) process.exitCode = 1;
  } finally {
    await browser.disconnect();
  }
}

main().catch((error) => {
  print({ ok: false, platform: 'tencent', error: error.message, stack: error.stack });
  process.exitCode = 1;
});
