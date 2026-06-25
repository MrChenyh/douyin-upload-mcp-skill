#!/usr/bin/env node
import { createDouyinSession, disconnect } from '../../src/index.js';
import config from '../../src/config.js';

async function main() {
  const { page } = await createDouyinSession();
  await page.goto(config.douyinUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await page.bringToFront().catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 1000));
  console.log(JSON.stringify({
    ok: true,
    url: page.url(),
    message: '已打开抖音创作者平台。请在浏览器里手动完成登录。',
  }, null, 2));
}

main().catch((err) => {
  console.log(JSON.stringify({ ok: false, error: err.message, stack: err.stack }, null, 2));
  process.exit(1);
}).finally(() => {
  disconnect();
});
