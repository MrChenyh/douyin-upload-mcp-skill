import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, extname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const originalStdoutWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = function writeStdout(chunk, encoding, callback) {
  const text = typeof chunk === "string" ? chunk : chunk.toString();
  if (text.trimStart().startsWith("{")) return originalStdoutWrite(chunk, encoding, callback);
  return process.stderr.write(chunk, encoding, callback);
};
console.log = console.error;
console.warn = console.error;
console.info = console.error;
console.debug = console.error;

import { createDouyinSession, disconnect } from "./index.js";
import config from "./config.js";
import { startBackgroundNodeJob } from "../scripts/background-job.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const HOME = process.env.HOME || process.env.USERPROFILE || ".";
const STATE_DIR = process.env.DOUYIN_MONITOR_STATE_DIR || join(HOME, ".openclaw", "workspace", "social-auto-publish");
const MCP_CACHE_DIR = join(STATE_DIR, "upstream");
const PUBLISH_JOB_DIR = process.env.DOUYIN_PUBLISH_JOB_DIR || join(STATE_DIR, "publish-jobs");

function jsonText(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError: payload?.ok === false };
}

function textResult(text, isError = false) {
  return { content: [{ type: "text", text: String(text || "") }], isError };
}

function extFromUrl(url, fallback = ".bin") {
  try {
    return extname(new URL(url).pathname) || fallback;
  } catch {
    return fallback;
  }
}

async function downloadToMcpCache(url, kind = "resource", fallbackExt = ".bin") {
  const cleanUrl = String(url || "").trim();
  if (!cleanUrl) return null;
  mkdirSync(MCP_CACHE_DIR, { recursive: true });
  const hash = createHash("sha256").update(cleanUrl).digest("hex").slice(0, 16);
  const outputPath = join(MCP_CACHE_DIR, `${hash}${extFromUrl(cleanUrl, fallbackExt)}`);
  if (existsSync(outputPath)) return outputPath;
  const response = await fetch(cleanUrl);
  if (!response.ok || !response.body) throw new Error(`${kind}_download_failed:${response.status}`);
  await pipeline(response.body, createWriteStream(outputPath));
  return outputPath;
}

function makeJobId(prefix = "publish") {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function readJsonFile(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function startUpstreamPublishJob(text) {
  mkdirSync(PUBLISH_JOB_DIR, { recursive: true });
  const jobId = makeJobId("upstream");
  const inputPath = join(PUBLISH_JOB_DIR, `${jobId}.txt`);
  const taskPath = join(PUBLISH_JOB_DIR, `${jobId}.task.json`);
  const statusPath = join(PUBLISH_JOB_DIR, `${jobId}.status.json`);
  writeFileSync(inputPath, String(text || "").trim());
  writeFileSync(statusPath, `${JSON.stringify({
    ok: true,
    jobId,
    status: "queued",
    stage: "queued",
    inputPath,
    taskPath,
    createdAt: new Date().toISOString(),
  }, null, 2)}\n`);

  const runner = startBackgroundNodeJob({
    scriptPath: join(ROOT, "scripts", "publish-upstream-job-worker.js"),
    args: ["--job", statusPath],
    cwd: ROOT,
    unitName: `social-auto-publish-${jobId}`,
    description: `Social auto publish ${jobId}`,
    runtimeMaxSec: 3900,
  });
  const current = readJsonFile(statusPath);
  writeFileSync(statusPath, `${JSON.stringify({ ...current, runner, updatedAt: new Date().toISOString() }, null, 2)}\n`);
  return { jobId, inputPath, taskPath, statusPath, runner };
}

function runNodeScript(args, opts = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: Number(opts.timeout || 120000),
    windowsHide: true,
  });
  return {
    ok: result.status === 0,
    status: result.status,
    signal: result.signal,
    output: `${result.stdout || ""}${result.stderr || ""}`.trim(),
  };
}

const server = new McpServer({
  name: "social-auto-publish-mcp-server",
  version: "0.2.0",
});

server.registerTool(
  "douyin_check_login",
  {
    description: "检查抖音创作者平台登录状态。可传入短信验证码完成登录或发布二次验证。",
    inputSchema: {
      smsCode: z.string().optional().describe("6 位短信验证码，可用于登录或发布二次验证。"),
    },
  },
  async ({ smsCode }) => {
    try {
      const { ops } = await createDouyinSession();
      const result = await ops.checkLogin({ smsCode });
      disconnect();
      return jsonText({
        ok: Boolean(result.ok ?? true),
        loggedIn: Boolean(result.loggedIn),
        phase: result.phase,
        qrcodePath: result.qrcodePath,
        message: result.message,
        clicked: result.clicked,
      });
    } catch (err) {
      disconnect();
      return jsonText({ ok: false, error: err.message, stack: err.stack });
    }
  }
);

server.registerTool(
  "douyin_fresh_qr",
  {
    description: "刷新抖音登录页并返回最新二维码文件路径。二维码只返回本机路径，不会发送到外部渠道。",
    inputSchema: {
      maxQrAttempts: z.number().default(3).describe("最多刷新/检测二维码次数，默认 3。"),
    },
  },
  async ({ maxQrAttempts }) => {
    const args = ["scripts/douyin-login-monitor.js", "fresh-qr", "--max-qr-attempts", String(maxQrAttempts || 3)];
    const result = runNodeScript(args, { timeout: 180000 });
    return textResult(result.output || `fresh-qr exited with status ${result.status}`, !result.ok);
  }
);

server.registerTool(
  "douyin_probe",
  {
    description: "探测当前抖音创作者平台页面、关键按钮和上传区是否就绪。",
    inputSchema: {},
  },
  async () => {
    try {
      const { ops } = await createDouyinSession();
      const result = await ops.probe();
      disconnect();
      return jsonText({ ok: true, ...result });
    } catch (err) {
      disconnect();
      return jsonText({ ok: false, error: err.message, stack: err.stack });
    }
  }
);

server.registerTool(
  "douyin_page_summary",
  {
    description: "读取当前抖音页面 URL、标题和可见文本摘要，用于排查登录、发布页和验证码状态。",
    inputSchema: {},
  },
  async () => {
    try {
      const { ops } = await createDouyinSession();
      const summary = await ops.getCurrentPageSummary();
      disconnect();
      return jsonText({ ok: true, summary });
    } catch (err) {
      disconnect();
      return jsonText({ ok: false, error: err.message, stack: err.stack });
    }
  }
);

server.registerTool(
  "douyin_navigate_to",
  {
    description: "导航到 douyin.com 域名下的页面。只允许抖音域名。",
    inputSchema: {
      url: z.string().describe("目标 URL，必须是 douyin.com 域名。"),
      timeout: z.number().default(30000).describe("导航超时，毫秒。"),
    },
  },
  async ({ url, timeout }) => {
    try {
      const { ops } = await createDouyinSession();
      const result = await ops.navigateTo(url, { timeout });
      disconnect();
      return jsonText(result);
    } catch (err) {
      disconnect();
      return jsonText({ ok: false, error: err.message, stack: err.stack });
    }
  }
);

server.registerTool(
  "douyin_reload_page",
  {
    description: "刷新当前抖音页面。",
    inputSchema: {
      timeout: z.number().default(30000).describe("刷新超时，毫秒。"),
    },
  },
  async ({ timeout }) => {
    try {
      const { ops } = await createDouyinSession();
      const result = await ops.reloadPage({ timeout });
      disconnect();
      return jsonText(result);
    } catch (err) {
      disconnect();
      return jsonText({ ok: false, error: err.message, stack: err.stack });
    }
  }
);

server.registerTool(
  "douyin_screenshot",
  {
    description: "保存当前抖音页面截图到 OUTPUT_DIR 并返回本机路径。",
    inputSchema: {
      fullPage: z.boolean().default(true).describe("是否截整页。"),
    },
  },
  async ({ fullPage }) => {
    try {
      mkdirSync(config.outputDir, { recursive: true });
      const path = join(config.outputDir, `douyin-mcp-screenshot-${Date.now()}.png`);
      const { ops } = await createDouyinSession();
      await ops.screenshot({ path, fullPage });
      disconnect();
      return jsonText({ ok: true, path });
    } catch (err) {
      disconnect();
      return jsonText({ ok: false, error: err.message, stack: err.stack });
    }
  }
);

server.registerTool(
  "douyin_publish_video",
  {
    description: "同步发布本地视频到抖音创作者平台。适合本地绝对路径视频；字段化 URL 任务优先使用 douyin_publish_from_upstream_text 异步入口。",
    inputSchema: {
      filePath: z.string().describe("视频文件绝对路径。"),
      title: z.string().optional().describe("作品标题。"),
      description: z.string().optional().describe("作品简介。"),
      topics: z.union([z.string(), z.array(z.string())]).optional().describe("话题/tag 列表。"),
      coverImagePath: z.string().optional().describe("自定义封面图片绝对路径。"),
      coverImageUrl: z.string().optional().describe("自定义封面图片 URL，会先下载到本地缓存。"),
      timeout: z.number().default(300000).describe("视频上传超时，毫秒。"),
    },
  },
  async ({ filePath, title, description, topics, coverImagePath, coverImageUrl, timeout }) => {
    try {
      const { ops } = await createDouyinSession();
      const login = await ops.checkLogin();
      if (!login.loggedIn) {
        disconnect();
        return jsonText({
          ok: false,
          needsUserAction: true,
          phase: login.phase,
          qrcodePath: login.qrcodePath,
          message: login.message || `未登录，当前阶段: ${login.phase}`,
        });
      }

      const resolvedCoverImagePath = coverImagePath || (coverImageUrl
        ? await downloadToMcpCache(coverImageUrl, "cover", ".png")
        : null);
      const result = await ops.publishVideo(filePath, {
        title,
        description,
        topics,
        coverImagePath: resolvedCoverImagePath,
        freshUpload: true,
        timeout,
      });
      disconnect();
      return jsonText({ ok: Boolean(result.ok), coverImagePath: resolvedCoverImagePath, result });
    } catch (err) {
      disconnect();
      return jsonText({ ok: false, error: err.message, stack: err.stack });
    }
  }
);

server.registerTool(
  "douyin_publish_imagetext",
  {
    description: "发布图文到抖音创作者平台。",
    inputSchema: {
      filePaths: z.array(z.string()).describe("图片文件绝对路径数组。"),
      title: z.string().optional().describe("作品标题。"),
      description: z.string().optional().describe("作品简介。"),
    },
  },
  async ({ filePaths, title, description }) => {
    try {
      const { ops } = await createDouyinSession();
      const login = await ops.checkLogin();
      if (!login.loggedIn) {
        disconnect();
        return jsonText({
          ok: false,
          needsUserAction: true,
          phase: login.phase,
          qrcodePath: login.qrcodePath,
          message: login.message || `未登录，当前阶段: ${login.phase}`,
        });
      }
      const result = await ops.publishImageText(filePaths, { title, description });
      disconnect();
      return jsonText({ ok: Boolean(result.ok), result });
    } catch (err) {
      disconnect();
      return jsonText({ ok: false, error: err.message, stack: err.stack });
    }
  }
);

server.registerTool(
  "douyin_publish_from_upstream_text",
  {
    description: "从字段化文本异步发布抖音视频。解析“视频地址/封面图片/标题/tags”，下载素材，后台执行发布并持续写入状态文件。",
    inputSchema: {
      text: z.string().describe("字段化文本，包含 视频地址、标题，可选 封面图片、tags。"),
    },
  },
  async ({ text }) => {
    try {
      const job = startUpstreamPublishJob(text);
      return jsonText({
        ok: true,
        jobId: job.jobId,
        status: "started",
        statusPath: job.statusPath,
        next: "调用 douyin_publish_job_status 查询，直到 status=succeeded、failed 或 blocked。不要重复发起同一发布。",
      });
    } catch (err) {
      return jsonText({ ok: false, error: err.message, stack: err.stack });
    }
  }
);

server.registerTool(
  "douyin_publish_job_status",
  {
    description: "查询 douyin_publish_from_upstream_text 启动的异步发布 job 状态。",
    inputSchema: {
      jobId: z.string().describe("发布 job id。"),
    },
  },
  async ({ jobId }) => {
    try {
      const statusPath = join(PUBLISH_JOB_DIR, `${jobId}.status.json`);
      if (!existsSync(statusPath)) return jsonText({ ok: false, error: "publish_job_not_found", jobId });
      return jsonText(readJsonFile(statusPath));
    } catch (err) {
      return jsonText({ ok: false, error: err.message, stack: err.stack });
    }
  }
);

server.registerTool(
  "social_publish_with_sau",
  {
    description: "使用 social-auto-upload wrapper 发布到 douyin、xiaohongshu、kuaishou 或 tencent。需要先通过 social_publish_account 执行登录/检查。",
    inputSchema: {
      platform: z.enum(["douyin", "xiaohongshu", "kuaishou", "tencent"]).describe("发布平台。"),
      type: z.enum(["video", "note"]).default("video").describe("video 视频；note 图文。视频号仅支持 video。"),
      account: z.string().default("default").describe("账号名。"),
      file: z.string().optional().describe("视频文件绝对路径，type=video 时必填。"),
      images: z.union([z.string(), z.array(z.string())]).optional().describe("图文图片路径，逗号分隔或数组。"),
      title: z.string().describe("标题。"),
      description: z.string().optional().describe("视频简介或图文正文。"),
      tags: z.union([z.string(), z.array(z.string())]).optional().describe("标签，逗号分隔或数组。"),
      coverPath: z.string().optional().describe("封面图片路径。"),
      schedule: z.string().optional().describe("定时发布时间，格式 YYYY-MM-DD HH:mm。"),
      headed: z.boolean().default(false).describe("是否显示浏览器窗口。小红书建议 true。"),
    },
  },
  async ({ platform, type, account, file, images, title, description, tags, coverPath, schedule, headed }) => {
    const action = type === "note" ? "publish-note" : "publish-video";
    const args = ["scripts/sau-publish-wrapper.js", action, "--platform", platform, "--account", account, "--title", title];
    if (type === "video") {
      if (!file) return jsonText({ ok: false, error: "video_file_required" });
      args.push("--file", file, "--desc", description || "");
      if (coverPath) args.push("--thumbnail", coverPath);
    } else {
      const imageValue = Array.isArray(images) ? images.join(",") : String(images || "");
      if (!imageValue.trim()) return jsonText({ ok: false, error: "images_required" });
      args.push("--images", imageValue, "--note", description || "");
    }
    const tagValue = Array.isArray(tags) ? tags.join(",") : String(tags || "");
    if (tagValue) args.push("--tags", tagValue);
    if (schedule) args.push("--schedule", schedule);
    if (headed || platform === "xiaohongshu") args.push("--headed");
    const result = runNodeScript(args, { timeout: 3_900_000 });
    return jsonText({ ok: result.ok, platform, type, status: result.status, output: result.output });
  }
);

server.registerTool(
  "social_publish_account",
  {
    description: "检查或登录 social-auto-upload 平台账号。支持 douyin、xiaohongshu、kuaishou、tencent。",
    inputSchema: {
      action: z.enum(["doctor", "check", "login"]).default("check").describe("doctor 检查发布引擎；check 检查账号；login 打开登录流程。"),
      platform: z.enum(["douyin", "xiaohongshu", "kuaishou", "tencent"]).optional().describe("平台，doctor 可省略。"),
      account: z.string().default("default").describe("账号名。"),
    },
  },
  async ({ action, platform, account }) => {
    const args = ["scripts/sau-publish-wrapper.js", action];
    if (platform) args.push("--platform", platform);
    if (account) args.push("--account", account);
    const result = runNodeScript(args, { timeout: action === "login" ? 900000 : 120000 });
    return jsonText({ ok: result.ok, action, platform: platform || null, account, status: result.status, output: result.output });
  }
);

async function run() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Social Auto Publish MCP Server running on stdio");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
