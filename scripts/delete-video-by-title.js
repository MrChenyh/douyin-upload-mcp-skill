#!/usr/bin/env node
import { createDouyinSession, disconnect } from '../src/index.js';
import { sleep } from '../src/util.js';

const MANAGE_URL = 'https://creator.douyin.com/creator-micro/content/manage?enter_from=cleanup_by_title';

const TEXT = {
  worksManage: '\u4f5c\u54c1\u7ba1\u7406',
  deleteWork: '\u5220\u9664\u4f5c\u54c1',
  delete: '\u5220\u9664',
  ok: '\u786e\u5b9a',
  confirm: '\u786e\u8ba4',
  keepDeleting: '\u4ecd\u8981\u5220\u9664',
  removeThisWork: '\u79fb\u9664\u6b64\u4f5c\u54c1',
  cancel: '\u53d6\u6d88',
};

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith('--')) {
      args._.push(item);
      continue;
    }
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

function usage() {
  console.error('Usage: node scripts/delete-video-by-title.js --title "<exact title>" [--execute]');
}

function printJson(payload) {
  console.log(JSON.stringify(payload, null, 2));
}

async function waitForManagePage(page, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    last = await page.evaluate((labels) => {
      const compact = (value = '') => String(value || '').replace(/\s+/g, ' ').trim();
      const text = compact(document.body?.innerText || '');
      return {
        loaded: text.includes(labels.worksManage) || text.includes(labels.deleteWork),
        url: location.href,
        title: document.title,
        textSample: text.slice(0, 1000),
      };
    }, TEXT).catch((err) => ({ loaded: false, error: err.message }));
    if (last.loaded) return { ok: true, last };
    await sleep(500);
  }
  return { ok: false, last };
}

async function scrollSearch(page, title, maxScrolls = 8) {
  for (let i = 0; i <= maxScrolls; i += 1) {
    const rows = await findVideoRows(page, title);
    if (rows.length > 0) return { ok: true, rows, scrolls: i };
    await page.evaluate(() => {
      window.scrollBy({ top: Math.max(480, window.innerHeight * 0.78), behavior: 'instant' });
    }).catch(() => {});
    await sleep(900);
  }
  const rows = await findVideoRows(page, title);
  return { ok: rows.length > 0, rows, scrolls: maxScrolls };
}

async function findVideoRows(page, title) {
  return page.evaluate((expectedTitle, labels) => {
    const compact = (value = '') => String(value || '').replace(/\s+/g, ' ').trim();
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const titleText = compact(expectedTitle);
    const selector = 'div, li, article, section, tr';
    const nodes = [...document.querySelectorAll(selector)];
    const rows = [];

    for (const node of nodes) {
      if (!visible(node)) continue;
      const text = compact(node.innerText || node.textContent || '');
      if (!text.includes(titleText)) continue;
      const hasDeleteText = text.includes(labels.deleteWork) || text.includes(labels.delete);
      const deleteButtons = [...node.querySelectorAll('button, [role="button"], a, span, div')]
        .filter(visible)
        .map((el) => compact(el.innerText || el.textContent || el.getAttribute('aria-label') || el.title || ''))
        .filter((label) => label === labels.deleteWork || label === labels.delete || label.includes(labels.deleteWork));
      if (!hasDeleteText && deleteButtons.length === 0) continue;
      const rect = node.getBoundingClientRect();
      if (rect.width < 180 || rect.height < 36) continue;

      const titleCount = text.split(titleText).length - 1;
      const deleteCount = [labels.deleteWork, labels.delete].reduce((sum, label) => sum + (text.split(label).length - 1), 0);
      const dateCount = (text.match(/20\d{2}[\-/.\u5e74]\d{1,2}[\-/.\u6708]\d{1,2}/g) || []).length;
      rows.push({
        text,
        titleCount,
        deleteCount,
        buttonCount: deleteButtons.length,
        dateCount,
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        top: Math.round(rect.top + window.scrollY),
        left: Math.round(rect.left + window.scrollX),
      });
    }

    rows.sort((a, b) => {
      const score = (row) =>
        (row.titleCount === 1 ? 0 : 1000) +
        (row.buttonCount > 0 ? 0 : 150) +
        (row.deleteCount > 0 ? 0 : 100) +
        (row.dateCount > 0 ? 0 : 20) +
        Math.min(row.height, 1200);
      return score(a) - score(b) || a.top - b.top;
    });

    return rows.slice(0, 20).map((row, rank) => ({
      rank,
      titleCount: row.titleCount,
      deleteCount: row.deleteCount,
      buttonCount: row.buttonCount,
      dateCount: row.dateCount,
      top: row.top,
      left: row.left,
      width: row.width,
      height: row.height,
      sample: row.text.slice(0, 700),
    }));
  }, title, TEXT);
}

async function clickDelete(page, title) {
  return page.evaluate((expectedTitle, labels) => {
    const compact = (value = '') => String(value || '').replace(/\s+/g, ' ').trim();
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const titleText = compact(expectedTitle);
    const nodes = [...document.querySelectorAll('div, li, article, section, tr')];
    const candidates = [];

    for (const node of nodes) {
      if (!visible(node)) continue;
      const text = compact(node.innerText || node.textContent || '');
      if (!text.includes(titleText)) continue;
      const rect = node.getBoundingClientRect();
      if (rect.width < 180 || rect.height < 36) continue;
      const controls = [...node.querySelectorAll('button, [role="button"], a, span, div')]
        .filter(visible)
        .map((el) => {
          const controlRect = el.getBoundingClientRect();
          const label = compact(el.innerText || el.textContent || el.getAttribute('aria-label') || el.title || '');
          return {
            el,
            label,
            area: controlRect.width * controlRect.height,
            width: Math.round(controlRect.width),
            height: Math.round(controlRect.height),
            top: Math.round(controlRect.top + window.scrollY),
            left: Math.round(controlRect.left + window.scrollX),
          };
        })
        .filter((control) => control.label === labels.deleteWork || control.label === labels.delete || control.label.includes(labels.deleteWork));
      const hasDeleteText = text.includes(labels.deleteWork) || text.includes(labels.delete);
      if (!controls.length && !hasDeleteText) continue;
      const titleCount = text.split(titleText).length - 1;
      const deleteCount = [labels.deleteWork, labels.delete].reduce((sum, label) => sum + (text.split(label).length - 1), 0);
      const dateCount = (text.match(/20\d{2}[\-/.\u5e74]\d{1,2}[\-/.\u6708]\d{1,2}/g) || []).length;
      candidates.push({ node, text, rect, controls, titleCount, deleteCount, dateCount });
    }

    candidates.sort((a, b) => {
      const score = (item) =>
        (item.titleCount === 1 ? 0 : 1000) +
        (item.controls.length > 0 ? 0 : 150) +
        (item.deleteCount > 0 ? 0 : 100) +
        (item.dateCount > 0 ? 0 : 20) +
        Math.min(item.rect.height, 1200);
      return score(a) - score(b) || a.rect.top - b.rect.top;
    });

    const item = candidates[0];
    if (!item) return { ok: false, error: 'target_row_not_found' };

    const target = item.controls.sort((a, b) => {
      const labelRank = (label) => (label === labels.deleteWork ? 0 : label === labels.delete ? 1 : 2);
      return labelRank(a.label) - labelRank(b.label) || a.area - b.area;
    })[0];
    if (!target) {
      return {
        ok: false,
        error: 'delete_button_not_found',
        rowSample: item.text.slice(0, 700),
      };
    }

    target.el.scrollIntoView({ block: 'center', inline: 'center' });
    target.el.click();
    return {
      ok: true,
      button: {
        text: target.label,
        width: target.width,
        height: target.height,
        top: target.top,
        left: target.left,
      },
      row: {
        titleCount: item.titleCount,
        deleteCount: item.deleteCount,
        dateCount: item.dateCount,
        width: Math.round(item.rect.width),
        height: Math.round(item.rect.height),
        top: Math.round(item.rect.top + window.scrollY),
        sample: item.text.slice(0, 700),
      },
    };
  }, title, TEXT);
}

async function confirmDelete(page, timeout = 12_000) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    last = await page.evaluate((labels) => {
      const compact = (value = '') => String(value || '').replace(/\s+/g, ' ').trim();
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const bodyText = compact(document.body?.innerText || '');
      const dialogTextPresent = [labels.removeThisWork, labels.keepDeleting, labels.deleteWork]
        .some((label) => bodyText.includes(label));
      const candidates = [...document.querySelectorAll('button, [role="button"], a, span, div')]
        .filter(visible)
        .map((el) => {
          const rect = el.getBoundingClientRect();
          const label = compact(el.innerText || el.textContent || el.getAttribute('aria-label') || el.title || '');
          return {
            el,
            label,
            area: rect.width * rect.height,
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            top: Math.round(rect.top + window.scrollY),
            left: Math.round(rect.left + window.scrollX),
          };
        })
        .filter((item) => [labels.ok, labels.confirm, labels.delete, labels.keepDeleting, labels.deleteWork].includes(item.label))
        .filter((item) => item.label !== labels.cancel)
        .sort((a, b) => {
          const rank = (label) => {
            if (label === labels.ok || label === labels.confirm) return dialogTextPresent ? 0 : 2;
            if (label === labels.keepDeleting || label === labels.delete) return 1;
            if (label === labels.deleteWork) return 3;
            return 4;
          };
          return rank(a.label) - rank(b.label) || a.area - b.area;
        });

      const target = candidates[0];
      if (!target) {
        return { ok: false, error: 'confirm_button_not_found', dialogTextPresent, textSample: bodyText.slice(0, 1200) };
      }

      target.el.scrollIntoView({ block: 'center', inline: 'center' });
      target.el.click();
      return {
        ok: true,
        clicked: target.label,
        dialogTextPresent,
        button: {
          width: target.width,
          height: target.height,
          top: target.top,
          left: target.left,
        },
        textSample: bodyText.slice(0, 1200),
      };
    }, TEXT).catch((err) => ({ ok: false, error: err.message }));
    if (last.ok) return last;
    await sleep(600);
  }
  return last || { ok: false, error: 'confirm_button_not_found' };
}

async function waitUntilMissing(page, title, timeout = 25_000) {
  const deadline = Date.now() + timeout;
  let lastRows = [];
  while (Date.now() < deadline) {
    await sleep(1000);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
    await waitForManagePage(page, 6000);
    const search = await scrollSearch(page, title, 3);
    lastRows = search.rows;
    if (lastRows.length === 0) return { ok: true, rows: [] };
  }
  return { ok: false, rows: lastRows };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const title = String(args.title || '').trim();
  if (!title || args.help) {
    usage();
    process.exitCode = args.help ? 0 : 2;
    return;
  }

  const { page } = await createDouyinSession();
  try {
    await page.goto(MANAGE_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
    const loaded = await waitForManagePage(page);
    const search = await scrollSearch(page, title);
    printJson({
      ok: true,
      mode: args.execute ? 'execute' : 'inspect',
      loaded,
      title,
      found: search.rows.length > 0,
      rows: search.rows,
      scrolls: search.scrolls,
    });

    if (!args.execute || search.rows.length === 0) return;

    const click = await clickDelete(page, title);
    if (!click.ok) {
      printJson({ ok: false, step: 'click_delete', title, click });
      process.exitCode = 1;
      return;
    }

    const confirm = await confirmDelete(page);
    if (!confirm.ok) {
      printJson({ ok: false, step: 'confirm_delete', title, click, confirm });
      process.exitCode = 1;
      return;
    }

    const missing = await waitUntilMissing(page, title);
    printJson({
      ok: missing.ok,
      deleted: missing.ok,
      title,
      click,
      confirm,
      remainingRows: missing.rows,
    });
    if (!missing.ok) process.exitCode = 1;
  } finally {
    disconnect();
  }
}

main().catch((err) => {
  printJson({ ok: false, error: err.message, stack: err.stack });
  disconnect();
  process.exit(1);
});
