#!/usr/bin/env node
import assert from 'node:assert/strict';

function shouldForceVisiblePublish(platform) {
  return platform === 'xiaohongshu';
}

function effectiveHeadlessForPlatform(platform, requestedHeadless) {
  return shouldForceVisiblePublish(platform) ? false : requestedHeadless !== false;
}

assert.equal(shouldForceVisiblePublish('xiaohongshu'), true);
assert.equal(shouldForceVisiblePublish('douyin'), false);
assert.equal(effectiveHeadlessForPlatform('xiaohongshu', true), false);
assert.equal(effectiveHeadlessForPlatform('xiaohongshu', false), false);
assert.equal(effectiveHeadlessForPlatform('xiaohongshu', undefined), false);
assert.equal(effectiveHeadlessForPlatform('douyin', true), true);
assert.equal(effectiveHeadlessForPlatform('douyin', false), false);
assert.equal(effectiveHeadlessForPlatform('kuaishou', undefined), true);
assert.equal(effectiveHeadlessForPlatform('tencent', undefined), true);

console.log(JSON.stringify({ ok: true, cases: 9 }));
