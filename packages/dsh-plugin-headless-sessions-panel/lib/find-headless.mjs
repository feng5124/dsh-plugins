#!/usr/bin/env node
// find-headless.mjs — 在本机找出 DSH 的「无头（headless）」会话，以及最近活动过的会话。
//
// 背景（2026-10-07 取证所得）：
//   1) 无头会话的会话文件在 ~/.dsh/sessions/<工作区编码目录>/session-<uuid>/session.v4.jsonl.zstd
//      文件名固定 session.v4.jsonl.zstd，内容是 **多帧追加** 的 zstd；Node 的 zstdDecompressSync
//      只解第一帧，所以本脚本按帧边界贪心解码。
//   2) 会话文件的 mtime 一直在涨 = 那个会话正在跑；会话首行 JSON 里有 {id, cwd, createdAt}。
//   3) 本机正在跑的无头进程命令行含 "cli.js" ... "headless" ...，用 CreationDate 与会话 createdAt 对齐。
//
// 用法：
//   node find-headless.mjs                列出“正在跑 / 最近 5 分钟内活动过”的会话
//   node find-headless.mjs --all          列出全部会话（含早已结束的）
//   node find-headless.mjs --json         机器可读输出
//   node find-headless.mjs --dump <id前缀>  把某个会话导成可读 markdown，打印输出路径
//   node find-headless.mjs --full         --all 时也解析目标/最近动作（慢一点）

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SESSIONS_ROOT = path.join(os.homedir(), ".dsh", "sessions");
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const argv = process.argv.slice(2);
const has = (n) => argv.includes(n);
const opt = (n) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};
const LIVE_MS = Number(process.env.DSH_LIVE_MS ?? 5 * 60 * 1000);
const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "out");

// ---------- zstd 多帧解码 ----------
function frameStarts(buf) {
  const starts = [0];
  let i = 4;
  while ((i = buf.indexOf(MAGIC, i)) !== -1) {
    starts.push(i);
    i += 4;
  }
  return starts;
}
function tryDecode(buf, a, b) {
  try {
    return zlib.zstdDecompressSync(b === undefined ? buf.subarray(a) : buf.subarray(a, b));
  } catch {
    return null;
  }
}
// 从第 fromIdx 帧起，最多解 limit 个完整帧（最后一帧若写到一半会自动停在上一帧）
function decodeFrames(buf, starts, fromIdx = 0, limit = Infinity) {
  let pos = starts[fromIdx];
  const parts = [];
  let frames = 0;
  for (;;) {
    const next = starts.find((s) => s > pos);
    const dec = tryDecode(buf, pos, next);
    if (!dec) return { text: Buffer.concat(parts).toString("utf8"), complete: false, frames };
    parts.push(dec);
    frames++;
    if (next === undefined) return { text: Buffer.concat(parts).toString("utf8"), complete: true, frames };
    if (frames >= limit) return { text: Buffer.concat(parts).toString("utf8"), complete: true, frames, stopped: true };
    pos = next;
  }
}
const parseLines = (text) =>
  text
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

// ---------- 会话文件 ----------
function allSessionFiles(root) {
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const ws of fs.readdirSync(root, { withFileTypes: true })) {
    if (!ws.isDirectory()) continue;
    const wsDir = path.join(root, ws.name);
    let items = [];
    try {
      items = fs.readdirSync(wsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const s of items) {
      if (!s.isDirectory() || !s.name.startsWith("session-")) continue;
      const f = path.join(wsDir, s.name, "session.v4.jsonl.zstd");
      if (fs.existsSync(f)) out.push(f);
    }
  }
  return out;
}

function readSession(file) {
  const st = fs.statSync(file);
  const buf = fs.readFileSync(file);
  const starts = frameStarts(buf);
  const head = decodeFrames(buf, starts, 0, 1);
  const ev = parseLines(head.text).find((e) => e.type === "session");
  return {
    file,
    size: st.size,
    mtime: st.mtimeMs,
    id: ev?.id ?? path.basename(path.dirname(file)),
    cwd: ev?.cwd ?? "?",
    createdAt: ev?.createdAt ?? 0,
    buf,
    starts,
  };
}

/** Flatten one event `content` payload to plain text. */
function textOf(c) {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((x) => (typeof x === "string" ? x : (x?.text ?? ""))).join("\n");
  return "";
}

// 首部信息（便宜：只解前 30 帧）。标题来自 `session/title`；没有标题时用**用户发的首句话**
// 兜底 —— 无头会话的名字全是 `session-<uuid>`，光看 id 无法分辨（2026-10-30 用户要求）。
//
// 注意 `source.kind`：DSH 自己的兜底标题是**截断过的**（`fallbackSessionTitle` 按
// fallbackMaxWords/fallbackMaxBytes 裁剪，中文没有空格所以等于截断字节），
// 例如「用无头会话插件打开一个已归」。这种截断标题不如完整的首句话好认，所以
// displayTitle 优先用「真标题」（用户改名 / 模型生成），兜底标题时改用首句话。
function headInfo(s) {
  const info = { goal: null, title: null, titleSource: null, firstText: null, events: 0 };
  const early = decodeFrames(s.buf, s.starts, 0, Math.min(30, s.starts.length));
  for (const e of parseLines(early.text)) {
    if (e.type === "goal/change" && info.goal === null && e.data?.goal?.objective) info.goal = e.data.goal.objective;
    if (e.type === "session/title" && info.title === null && e.data?.title) {
      info.title = e.data.title;
      info.titleSource = e.data?.source?.kind ?? null;
    }
    if (e.type === "user/message" && e.data?.source?.kind === "user") {
      info.events++;
      if (info.firstText === null) {
        const body = textOf(e.data.content).replace(/\s+/g, " ").trim();
        // 注入的运行时上下文不是用户说的话，别拿它当名字。
        if (body && !/^<system-reminder>/.test(body) && !/Current runtime context/.test(body)) {
          info.firstText = body.slice(0, 120);
        }
      }
    }
  }
  return info;
}

function tailInfo(s) {
  const info = { last: null, lastAt: null, lastTool: null };
  // 从文件末尾往回找最后几个完整帧
  const collected = [];
  for (let k = s.starts.length - 1; k >= 0 && collected.length < 5; k--) {
    const dec = tryDecode(s.buf, s.starts[k], k + 1 < s.starts.length ? s.starts[k + 1] : undefined);
    if (dec) collected.unshift(dec.toString("utf8"));
  }
  const tailEv = parseLines(collected.join(""));
  for (const e of tailEv) {
    if (e.type === "assistant/message") {
      const c = e.data?.message?.content;
      const txt = typeof c === "string" ? c : Array.isArray(c) ? c.map((x) => x?.text ?? "").join(" ") : "";
      if (txt.trim()) info.last = txt.replace(/\s+/g, " ").trim().slice(0, 240);
      info.lastAt = e.time;
    }
    if (e.type === "tool/call") info.lastTool = e.data?.name;
  }
  return info;
}

// ---------- 无头进程 ----------
function dshProcesses() {
  const ps = `
$ErrorActionPreference='SilentlyContinue'
Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" |
  Select-Object ProcessId,@{n='Start';e={$_.CreationDate.ToString('o')}},CommandLine |
  ConvertTo-Json -Compress -Depth 3
`;
  try {
    const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], {
      encoding: "utf8",
      timeout: 20000,
    }).trim();
    if (!out) return [];
    const j = JSON.parse(out);
    return (Array.isArray(j) ? j : [j]).map((p) => ({
      pid: p.ProcessId,
      start: Date.parse(p.Start) || 0,
      cmd: p.CommandLine || "",
      // 真·无头会话 = ...dsh-desktop-host\lib\cli.js" headless "<提示词>"；
      // 只看 /headless/ 会把「命令行里恰好含 headless 字样的工具子进程」误判（例如本脚本自己）
      headless: /cli\.js["']?\s+headless\b/.test(p.CommandLine || ""),
    }));
  } catch (e) {
    console.error(`[warn] 进程枚举失败（${String(e.message).split("\n")[0]}）；仅按会话文件 mtime 判断活性`);
    return [];
  }
}

// ---------- 原子写入 ----------
function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp" + process.pid;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}
const local = (ms) => (ms ? new Date(ms).toLocaleString("sv-SE") : "-");
const ago = (ms) => {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 90) return `${s}s 前`;
  if (s < 5400) return `${Math.round(s / 60)}m 前`;
  return `${(s / 3600).toFixed(1)}h 前`;
};

// ---------- dump ----------
function dump(s) {
  const full = decodeFrames(s.buf, s.starts, 0, Infinity);
  const out = [];
  out.push(`# DSH 会话 ${s.id}`);
  out.push(`- cwd: ${s.cwd}`);
  out.push(`- createdAt: ${local(s.createdAt)} (${s.createdAt})`);
  out.push(`- 会话文件: ${s.file}`);
  out.push(`- 导出时刻: ${local(Date.now())}；完整解码: ${full.complete ? "是" : "否（末尾帧正在写入，已截到上一完整帧）"}`);
  out.push("");
  const textOf = (c) =>
    typeof c === "string" ? c : Array.isArray(c) ? c.map((x) => (typeof x === "string" ? x : x?.text ?? "")).join("\n") : "";
  for (const e of parseLines(full.text)) {
    const d = e.data ?? e;
    if (e.type === "user/message") {
      const kind = typeof d.source === "string" ? d.source : d.source?.kind ?? "?";
      const body = textOf(d.content);
      if (kind !== "user" && !/^\s*<system-reminder/.test(body) && !/Current runtime context/.test(body)) continue;
      out.push(`## [${local(e.time)}] USER (${kind})`);
      out.push(body.slice(0, 3000));
      out.push("");
    } else if (e.type === "assistant/message") {
      const body = textOf(d.message?.content ?? d.message);
      if (body.trim()) {
        out.push(`## [${local(e.time)}] ASSISTANT t${d.turn}/s${d.step}`);
        out.push(body.replace(/\s+/g, " ").slice(0, 1200));
        out.push("");
      }
    } else if (e.type === "tool/call") {
      out.push(`### [${local(e.time)}] tool:${d.name}  ${String(JSON.stringify(d.arguments)).replace(/\s+/g, " ").slice(0, 300)}`);
    } else if (e.type === "tool/result") {
      const body = textOf(d.message?.content ?? d.message).replace(/\s+/g, " ");
      out.push(`    -> ${body.slice(0, 300)}`);
    } else if (e.type === "goal/change") {
      out.push(`> GOAL(${d.operation}): ${(d.goal?.objective ?? "").replace(/\s+/g, " ")}`);
    }
  }
  const p = path.join(OUT_DIR, `${s.id}.md`);
  writeAtomic(p, out.join("\n"));
  console.log(`导出完成：${p}`);
}

// ---------- main ----------
const procs = dshProcesses();
const headlessProcs = procs.filter((p) => p.headless);
let sessions = allSessionFiles(SESSIONS_ROOT).map(readSession);
const now = Date.now();

// 进程 ↔ 会话对齐：无头会话的 createdAt 与无头进程启动时间最接近者（20s 容差）
for (const p of headlessProcs) {
  let best = null;
  for (const s of sessions) {
    const d = Math.abs(s.createdAt - p.start);
    if (d < 20000 && (!best || d < best.d)) best = { s, d };
  }
  p.session = best?.s ?? null;
  if (p.session) p.session.pid = p.pid;
}
// 无头进程没能对齐到会话的，也标出来
const running = sessions.filter((s) => s.pid);
const live = sessions.filter((s) => now - s.mtime < LIVE_MS);

if (has("--dump")) {
  const want = (opt("--dump") ?? "").toLowerCase();
  const s = sessions.find((x) => x.id.toLowerCase().includes(want));
  if (!s) {
    console.error(`没有匹配 "${want}" 的会话`);
    process.exit(2);
  }
  dump(s);
  process.exit(0);
}

const rows = has("--all")
  ? sessions.sort((a, b) => b.mtime - a.mtime).slice(0, has("--limit") ? Number(opt("--limit")) : 50)
  : [...new Set([...running, ...live])].sort((a, b) => b.mtime - a.mtime);

const detailed = has("--full") || !has("--all");
// 首部（标题/目标/首句）总是解：它是面板「名字」的唯一来源，`--all --json` 也要。
const enriched = rows.map((s) => ({ ...s, ...headInfo(s), ...(detailed ? tailInfo(s) : {}) }));
/**
 * Final display name. A true title (user rename / model-generated) wins; DSH's
 * deterministic `fallback` title is a byte-truncated prefix, so the full first
 * sentence of the user reads better for telling sessions apart.
 */
const displayName = (s) => {
  if (s.title && s.titleSource !== "fallback") return s.title;
  return s.firstText ?? s.title ?? null;
};

if (has("--json")) {
  console.log(
    JSON.stringify(
      enriched.map((s) => ({
        id: s.id,
        cwd: s.cwd,
        createdAt: s.createdAt,
        createdAtLocal: local(s.createdAt),
        lastWrite: s.mtime,
        lastWriteLocal: local(s.mtime),
        size: s.size,
        pid: s.pid ?? null,
        running: Boolean(s.pid),
        activeRecently: now - s.mtime < LIVE_MS,
        // `title` 是会话自带的标题；`titleSource` 说明它从哪来（`fallback` = DSH
        // 自己按字节截断的前缀，不好认）。`firstText` 是用户首句话。
        // `displayTitle` 是二者合一后的最终名字，面板直接用它当行标题。
        title: s.title ?? null,
        titleSource: s.titleSource ?? null,
        firstText: s.firstText ?? null,
        displayTitle: displayName(s),
        goal: s.goal ?? null,
        lastText: s.last ?? null,
        lastTool: s.lastTool ?? null,
        file: s.file,
      })),
      null,
      2
    )
  );
  process.exit(0);
}

console.log(
  `DSH 进程 ${procs.length} 个（其中无头 ${headlessProcs.length} 个）；会话文件共 ${sessions.length} 个（store: ${SESSIONS_ROOT}）`
);
console.log(
  `下面列出：正在运行的无头会话 + 最近 ${Math.round(LIVE_MS / 60000)} 分钟内活动过的会话${has("--all") ? "（--all：按 mtime 全部列出）" : ""}\n`
);
if (!enriched.length) {
  console.log("（当前没有正在跑、也没有近期活动的会话）");
} else {
  for (const s of enriched) {
    const tag = s.pid
      ? `RUNNING 无头 pid=${s.pid}`
      : now - s.mtime < LIVE_MS
        ? "ACTIVE  无运行中无头进程（交互会话在写，或刚退出）"
        : "idle";
    console.log(`- ${tag}  ${displayName(s) ?? "(无标题)"}  ${s.id}`);
    console.log(`    cwd       : ${s.cwd}`);
    console.log(`    起于      : ${local(s.createdAt)}    文件更新: ${local(s.mtime)} (${ago(s.mtime)})   压缩 ${(s.size / 1024).toFixed(0)} KiB`);
    if (s.title && s.titleSource !== "fallback") console.log(`    标题      : ${s.title}`);
    if (s.firstText) console.log(`    首句(名)  : ${s.firstText}`);
    else if (s.title) console.log(`    标题(截断): ${s.title}`);
    if (s.goal) console.log(`    目标      : ${s.goal.replace(/\s+/g, " ").slice(0, 200)}`);
    if (s.lastTool || s.last) console.log(`    最近动作  : ${s.lastTool ?? "?"}${s.last ? " — " + s.last : ""}`);
    console.log(`    文件      : ${s.file}`);
  }
}
if (headlessProcs.some((p) => !p.session)) {
  console.log("\n未对齐到会话文件的无头进程：");
  for (const p of headlessProcs.filter((x) => !x.session)) console.log(`- pid=${p.pid} 起于 ${local(p.start)}`);
}
console.log(`\n导出某个会话：node find-headless.mjs --dump <id前缀>   （或直接跑 find-headless.cmd --dump …）`);
