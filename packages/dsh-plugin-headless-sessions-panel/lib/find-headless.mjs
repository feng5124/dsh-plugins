#!/usr/bin/env node
// find-headless.mjs — 在本机找出 DSH 的「无头（headless）」会话，以及最近活动过的会话。
//
// 背景（2026-10-07 取证所得）：
//   1) 无头会话的会话文件在 ~/.dsh/sessions/<工作区编码目录>/session-<uuid>/session.v4.jsonl.zstd//      文件名固定 session.v4.jsonl.zstd，内容是 **多帧追加** 的 zstd；Node 的 zstdDecompressSync
//      只解第一帧，所以本脚本按帧边界贪心解码。
//   2) 会话文件的 mtime 一直在涨 = 那个会话正在跑；会话首行 JSON 里有 {id, cwd, createdAt}。
//   3) 本机正在跑的无头进程命令行含 "cli.js" ... "headless" ...，用 CreationDate 与会话 createdAt 对齐。
//
// 用法：
//   node find-headless.mjs                列出“正在跑 / 最近 LIVE_MS（默认 5 分钟）内活动过”的会话
//   node find-headless.mjs --all          列出全部会话（按 mtime 排列；--limit N 取前 N，0 = 不限）
//   node find-headless.mjs --json         机器可读输出
//   node find-headless.mjs --dump <id>    把某个会话导成可读 markdown，打印输出路径
//                                          （接受 session-xxx 与裸 uuid，精确优先、唯一前缀可用）
//   node find-headless.mjs --discover     只列出发现的会话文件（不解析内容）
//
// 时间窗口与检索（2026-11-07 第二轮重写，2026-11-08 定稿）：
//   读取粒度是「整个文件」——要拿标题/首帧就必须整读，所以真正的性能杠杆是**别打开冷文件**。
//   - **默认视图**只整读 mtime 落在 LIVE_MS 内的文件；冷文件一个字节都不读。
//   - **时间段**：--since / --until（YYYY-MM-DD 或 ISO），按 mtime 在读取前筛。
//     单次查询跨度上限 31 天（`--max-span-days N` 可调、`0` = 关闭）：超限**不报错、不丢数据**，
//     自动收窄并回报 `rangeClamped` / `nextAnchor`。两端都不给时默认只覆盖最近 30 天。
//     判定依据是**文件最后更新时间**：会话在该时间段内有过更新就算命中。
//   - **关键词**：--search 命中标题/显示名/首句/cwd（浅搜，只解首帧，快）；
//     加 --deep 连整份正文一起搜（要解压全部内容，慢一个量级）。--search-json 给面板用。
//   - `--all --limit N` 先按 mtime 排序后**只读前 N 个**；`--dump` 按目录名先筛、多义拒绝。
//   - 扫描会先 stat 全部文件；`DSH_SCAN_METRICS=1` 时向 stderr 打一行计数
//     {discovered,read,skipped,bytesRead,prefixProbes}（不含任何会话正文）。


import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// 会话根目录可用环境变量覆盖（离线测试/演练指向假目录用）；生产无此变量，行为不变。
const SESSIONS_ROOT = process.env.DSH_SESSIONS_ROOT ?? path.join(os.homedir(), ".dsh", "sessions");
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const argv = process.argv.slice(2);
const has = (n) => argv.includes(n);
const opt = (n) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};
const LIVE_MS = Number(process.env.DSH_LIVE_MS ?? 5 * 60 * 1000);
// dump 导出目录同样可覆盖（测试不污染真实 out/）；默认仍落在脚本旁边。
const OUT_DIR = process.env.DSH_FIND_HEADLESS_OUT ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "out");

// ---------- 扫描指标（DSH_SCAN_METRICS=1 时向 stderr 输出一行 JSON） ----------
// 只统计「打开过多少文件、读了多少字节」，不含任何会话正文：这些数字是
// 「预过滤到底省没省」的唯一可信证据，也是测试断言默认不读冷文件的依据。
const METRICS_ON = process.env.DSH_SCAN_METRICS === "1";
const metrics = { discovered: 0, read: 0, skipped: 0, bytesRead: 0, prefixProbes: 0 };
function emitMetrics() {
  if (!METRICS_ON) return;
  process.stderr.write(`${JSON.stringify(metrics)}\n`);
}

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
// 只 stat 不读内容：返回 {file, mtimeMs, size, birthtimeMs, dirId}。
// dirId 来自目录名 `session-<uuid>`——它让 --dump 在打开任何文件前就能按 id 筛选。
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
      let st = null;
      try {
        st = fs.statSync(f);
      } catch {
        // stat 失败等价于旧版 existsSync=false（文件被并发删掉），直接跳过
        continue;
      }
      out.push({
        file: f,
        mtimeMs: st.mtimeMs,
        size: st.size,
        // NTFS 上 birthtime≈创建时刻，可零读取地与无头进程启动时间比对。
        birthtimeMs: st.birthtimeMs,
        dirId: s.name.slice("session-".length),
      });
    }
  }
  return out;
}

function readSession(file) {
  // 单个会话文件在 stat 之后仍可能被删/被锁/截断坏掉——它坏了不能拖垮
  // 整个扫描（面板会把整列表回落到旧缓存）。跳过并留一行警告。
  try {
    const st = fs.statSync(file);
    const buf = fs.readFileSync(file);
    metrics.read += 1;
    metrics.bytesRead += buf.length;
    const starts = frameStarts(buf);
    const head = decodeFrames(buf, starts, 0, 1);
    const ev = parseLines(head.text).find((e) => e.type === "session");
    // id 一律以 `session-` 前缀输出：它既是面板行的标识，也是回传给 --dump 的键。
    // 首帧里的 id 不一定带前缀（取决于写入方），而目录名恒为 `session-<uuid>`；
    // 两者不统一就会出现“列表里点导出、dump 却找不到”（2026-11-07 回归）。
    const dirId = path.basename(path.dirname(file));
    const rawId = typeof ev?.id === "string" && ev.id !== "" ? ev.id : dirId;
    const id = rawId.startsWith("session-") ? rawId : `session-${rawId}`;
    return {
      file,
      size: st.size,
      mtime: st.mtimeMs,
      id,
      dirId,
      cwd: ev?.cwd ?? "?",
      createdAt: ev?.createdAt ?? 0,
      buf,
      starts,
    };
  } catch (e) {
    console.error(`[warn] 跳过会话文件 ${path.basename(path.dirname(file))}：${String(e.message).split("\n")[0]}`);
    return null;
  }
}

/**
 * 只读文件前缀、解第一帧，拿 `{id, cwd, createdAt}`——用于「运行中但文件很久
 * 没写」的会话候选探测。它与 readSession 的区别是**不整读**：读 64KB 起，
 * 解不出第一帧再倍增到上限；命中后调用方才用 readSession 正式读入。
 *
 * @param {string} file 绝对路径
 * @returns {{id: string, cwd: string, createdAt: number}|null}
 */
function probeSessionHead(file) {
  let fd = null;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    let cap = Math.min(64 * 1024, size);
    while (cap > 0) {
      const buf = Buffer.allocUnsafe(cap);
      const read = fs.readSync(fd, buf, 0, cap, 0);
      const chunk = buf.subarray(0, read);
      metrics.prefixProbes += 1;
      metrics.bytesRead += read;
      const starts = frameStarts(chunk);
      // 只有切出第一帧的边界才可能解码成功；最后一帧没写完时长度对不上，
      // 那就倍增继续读。
      if (starts.length >= 2) {
        const head = decodeFrames(chunk, starts, 0, 1);
        const ev = parseLines(head.text).find((e) => e.type === "session");
        if (ev && typeof ev.createdAt === "number") {
          return { id: ev.id ?? path.basename(path.dirname(file)), cwd: ev.cwd ?? "?", createdAt: ev.createdAt };
        }
      }
      if (cap >= size) return null;
      cap = Math.min(cap * 2, size);
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* 关不掉也不影响结果 */ }
    }
  }
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
  // 测试注入点：给出进程列表就不再调 PowerShell（否则每个用例都要 1-2 秒，
  // 且单位测试会依赖本机真实进程）。格式与下面的返回值完全一致。
  const injected = process.env.DSH_PROCS_JSON;
  if (typeof injected === "string" && injected.trim() !== "") {
    try {
      const parsed = JSON.parse(injected);
      return (Array.isArray(parsed) ? parsed : []).map((p) => ({
        pid: p.pid ?? 0,
        start: typeof p.start === "number" ? p.start : Date.parse(p.start) || 0,
        cmd: p.cmd ?? "",
        headless: p.headless === true,
      }));
    } catch (e) {
      console.error(`[warn] DSH_PROCS_JSON 解析失败（${String(e.message).split("\n")[0]}）；改走真实进程枚举`);
    }
  }
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
//
// 预过滤原则（2026-11-07 第二轮，验收打回后重写）：
//   1. 先 stat 全部会话文件（每个 ~0.1ms），**在打开任何文件之前**决定读哪些；
//   2. 默认视图只读 mtime 在 LIVE_MS 内的文件——那正是面板要显示的
//      「运行中 + 最近 5 分钟活动」；冷文件一个字节都不读；
//   3. 运行中但文件很久没写的会话不能漏：先用 birthtime 零读取匹配无头进程，
//      仍有未匹配进程时才对冷文件做**首帧前缀探测**（只读几十 KB），命中才整读；
//   4. --all --limit N 先按 mtime 排序，只读前 N 个；
//   5. --dump 按目录名 session-<id> 先筛，只读目标候选。
function runCli() {
  const procs = dshProcesses();
  const headlessProcs = procs.filter((p) => p.headless);
  const now = Date.now();

  const entries = allSessionFiles(SESSIONS_ROOT);
  metrics.discovered = entries.length;

  // ---- --dump：按目录名先筛，绝不整读全库 -------------------------------
  // ⚠ 面板与 `--json` 的 `id` 都带 `session-` 前缀，而目录名不带；这里必须
  // 同时接受「session-<uuid>」与裸 uuid 两种写法，否则面板点导出永远
  // “没有匹配”（2026-11-07 真机回归）。
  const dumpMode = has("--dump");
  if (dumpMode) {
    const raw = (opt("--dump") ?? "").trim().toLowerCase();
    if (raw === "") {
      console.error("--dump 需要一个会话 id（或唯一前缀）");
      emitMetrics();
      process.exit(2);
    }
    const want = raw.startsWith("session-") ? raw.slice("session-".length) : raw;
    const exact = entries.filter((e) => e.dirId.toLowerCase() === want);
    const prefixed = exact.length === 0 ? entries.filter((e) => e.dirId.toLowerCase().startsWith(want)) : [];
    const picked = exact.length > 0 ? exact : prefixed;
    if (picked.length > 1) {
      console.error(`"${raw}" 匹配到 ${picked.length} 个会话，请用更长的前缀：`);
      for (const candidate of picked) console.error(`- session-${candidate.dirId}`);
      emitMetrics();
      process.exit(2);
    }
    if (picked.length === 0) {
      console.error(`没有匹配 "${raw}" 的会话`);
      emitMetrics();
      process.exit(2);
    }
    metrics.skipped = entries.length - 1;
    const session = readSession(picked[0].file);
    if (session === null) {
      console.error(`会话 ${picked[0].dirId} 的文件无法读取`);
      process.exit(2);
    }
    dump(session);
    emitMetrics();
    process.exit(0);
  }

  // ---- 选择要读取的文件 -------------------------------------------------
  const allMode = has("--all");
  const ageArg = opt("--max-age-days");
  const extraWindowMs = ageArg === undefined ? 0 : Number(ageArg) * 24 * 3600 * 1000;
  const limitArg = opt("--limit");
  // --limit 0 是「不限量」的显式写法（面板的“全部会话”用它）；
  // 未给 --limit 时才回落到默认 50 行。
  const limit = allMode && limitArg !== undefined
    ? (Number(limitArg) > 0 ? Math.trunc(Number(limitArg)) : Number.POSITIVE_INFINITY)
    : 0;

  // 时间段筛选（面板的历史浏览用）：--since / --until 接受 ISO 或 YYYY-MM-DD。
  // 按**文件系统时间**筛（mtime），因此在读文件之前就能把候选砍到窗口内。
  const parseTime = (text, endOfDay) => {
    if (typeof text !== "string" || text.trim() === "") return null
    const trimmed = text.trim()
    const bare = /^\d{4}-\d{2}-\d{2}$/
    const iso = bare.test(trimmed) ? `${trimmed}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}` : trimmed
    const ms = Date.parse(iso)
    return Number.isFinite(ms) ? ms : null
  }
  const sinceRaw = parseTime(opt("--since"), false)
  const untilRaw = parseTime(opt("--until"), true)
  const rangeActive = sinceRaw !== null || untilRaw !== null

  // 关键词：--search 匹配「标题 / 首句 / cwd」，--deep 连正文一起搜。
  // --search-json 是给面板用的机器可读形态（带命中片段与匹配字段）。
  const keyword = (opt("--search") ?? "").trim()
  const deepSearch = has("--deep")
  const searchJson = has("--search-json")
  // 「用了检索形态」与「有关键词」是两件事：面板只选时间段、关键词留空时，
  // 传的是 --search-json（不带 --search），此时必须读全量历史再按时间段筛，
  // 不能退回 5 分钟默认窗口（2026-11-07 实测：否则只列出 2 个会话）。
  const searchMode = searchJson || has("--search")

  // 单次查询的跨度上限（默认 31 天）。
  //
  // 语义要分清两件事：
  //   - **会话记录永久保留**（DSH 不清理 sessions，面板也能翻到最早那条）；
  //   - **单次查询的时间跨度有上限**，避免一次拉出几百 MB 做深搜。
  // 超限时不报错、不丢数据，而是把窗口收敛到锚点那一端的 31 天内，
  // 并在结果里回报 `rangeClamped` + `nextAnchor`，供面板提示并翻下一页。
  // `--max-span-days 0` 可关闭该限制（取证/全量排查用）。
  //
  // 两个天数要分开：
  //   span = 单次查询最多覆盖多久（31 天，保证“整整一个自然月”不被切断）；
  //   defaultWindow = 检索时两端都没给，默认往前看多久（30 天）。
  const spanArg = opt("--max-span-days")
  const parsedSpan = spanArg === undefined ? 31 : Number(spanArg)
  const maxSpanDays = Number.isFinite(parsedSpan) ? Math.max(0, parsedSpan) : 31
  const spanMs = maxSpanDays * 24 * 3600 * 1000
  const defaultSinceMs = now - 30 * 24 * 3600 * 1000

  let sinceMs = sinceRaw
  let untilMs = untilRaw
  let rangeClamped = false
  let nextAnchor = null
  if (maxSpanDays > 0) {
    if (rangeActive) {
      // 一端缺失时用另一端推算，这样「只选到某天」也仍然只覆盖 31 天，
      // 而不是悄悄退化成“从很早以前到现在”的全量扫描（2026-11-07 实测抓到）。
      if (sinceMs !== null && untilMs !== null) {
        // 两端都给：只有真的超过上限才收窄；否则**原样保留用户窗口**。
        // （单日查询、同一日查询必须精确命中那一天，不能被动扩成 31 天。）
        if (untilMs - sinceMs > spanMs) {
          rangeClamped = true
          // 锚在 until（最近端）往回取一段，而不是从 since 往后推。
          sinceMs = untilMs - spanMs
          nextAnchor = new Date(sinceMs).toISOString()
        }
      } else {
        // 只给一端：向另一端推满一个上限窗口。
        const start = sinceMs !== null ? sinceMs : untilMs - spanMs
        const end = untilMs !== null ? untilMs : sinceMs + spanMs
        sinceMs = start
        untilMs = end
        rangeClamped = true
        nextAnchor = new Date(sinceMs).toISOString()
      }
    } else if (searchMode) {
      // 检索但两端都没给：默认只覆盖最近 30 天。
      // 想看更早：显式给 since（或 --max-span-days 0 / --all）。
      sinceMs = defaultSinceMs
      untilMs = now
      rangeClamped = true
      nextAnchor = new Date(sinceMs).toISOString()
    }
  }

  // 关键词与检索形态的定义已提前到时间段收敛之前（收窄逻辑要用 searchMode）。

  /** @type {Map<string, object>} 已读入的会话，按 file 去重。 */
  const loaded = new Map();
  const load = (entry) => {
    if (loaded.has(entry.file)) return loaded.get(entry.file)
    const session = readSession(entry.file)
    loaded.set(entry.file, session)
    return session
  }

  /** 文本里找关键词，返回一段上下文（深搜用）。 */
  const snippetOf = (text, needle) => {
    const at = text.toLowerCase().indexOf(needle.toLowerCase())
    if (at < 0) return null
    const from = Math.max(0, at - 50)
    return text.slice(from, at + needle.length + 70).replace(/\s+/g, " ").trim()
  }

  // 关键词搜索必须能命中历史：不能只有 5 分钟窗口内那两三个文件可搜。
  // 检索（含“自动收窄到最近 31 天”）都走「时间段」分支，只读窗口内的文件。
  // ⚠ 判断依据是**收窄后的有效窗口**（effectiveRange），不是用户是否填了日期：
  // 用户什么都不填时，上面的收窄逻辑会把窗口设成最近 31 天，那也是按时间段读
  //（2026-11-07 实测：曾按 rangeActive 判断，导致无端点时仍全量读 234 个）。
  const effectiveRange = sinceMs !== null || untilMs !== null
  const searchAll = searchMode && !effectiveRange && !allMode

  if (effectiveRange) {
    // ---- 时间段：按 mtime 过滤后读窗口内的文件 ----
    const ordered = [...entries]
      .filter((entry) => (sinceMs === null || entry.mtimeMs >= sinceMs) && (untilMs === null || entry.mtimeMs <= untilMs))
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
    metrics.skipped = entries.length - ordered.length
    for (const entry of ordered) load(entry)
  } else if (allMode || searchAll) {
    // --all / 关掉跨度限制的检索：按 mtime 新→旧；--all 有 --limit 就只读前 N 个。
    const ordered = [...entries].sort((a, b) => b.mtimeMs - a.mtimeMs)
    const target = allMode && Number.isFinite(limit) && limit > 0 ? ordered.slice(0, limit) : ordered
    metrics.skipped = ordered.length - target.length
    for (const entry of target) load(entry)
  } else {
    // 默认视图：只读 LIVE_MS 内（以及被 --max-age-days 显式放宽的）文件。
    const windowMs = extraWindowMs > 0 ? extraWindowMs : LIVE_MS
    const hot = entries.filter((entry) => now - entry.mtimeMs <= windowMs)
    metrics.skipped = entries.length - hot.length
    for (const entry of hot) load(entry)

    // 进程↔会话对齐：先用手头（热文件）的 createdAt 匹配。
    const sessionsNow = () => [...loaded.values()].filter(Boolean)
    const align = () => {
      for (const p of headlessProcs) {
        if (p.session !== null && p.session !== undefined) continue
        let best = null
        for (const s of sessionsNow()) {
          const d = Math.abs(s.createdAt - p.start)
          if (d < 20000 && (best === null || d < best.d)) best = { s, d }
        }
        if (best !== null) {
          p.session = best.s
          best.s.pid = p.pid
        }
      }
    }
    align()

    // 仍有未匹配的无头进程 ⇒ 该会话可能「进程活着但文件很久没写」。
    // 分层匹配，全部在冷文件上零/低读取：
    //   ① birthtime 与本进程启动时间对齐（NTFS 创建时间，不用读文件）；
    //   ② 仍不中则首帧前缀探测（只读 64KB 起的前缀）。
    const unmatched = () => headlessProcs.filter((p) => p.session === null || p.session === undefined)
    if (unmatched().length > 0) {
      const cold = entries.filter((entry) => !loaded.has(entry.file))
      for (const p of unmatched()) {
        const byBirth = cold.find((entry) => Math.abs(entry.birthtimeMs - p.start) < 20000 && !loaded.has(entry.file))
        if (byBirth !== undefined) {
          const session = load(byBirth)
          if (session !== null) {
            p.session = session
            session.pid = p.pid
          }
        }
      }
      for (const p of unmatched()) {
        for (const entry of cold) {
          if (loaded.has(entry.file)) continue
          const head = probeSessionHead(entry.file)
          if (head === null) continue
          if (Math.abs(head.createdAt - p.start) >= 20000) continue
          const session = load(entry)
          if (session !== null) {
            p.session = session
            session.pid = p.pid
          }
          break
        }
      }
    }
  }

  let sessions = [...loaded.values()].filter(Boolean)
  // --all 之外的进程对齐（--all 也要标注运行中，但不再额外读文件）。
  if (allMode) {
    for (const p of headlessProcs) {
      let best = null
      for (const s of sessions) {
        const d = Math.abs(s.createdAt - p.start)
        if (d < 20000 && (best === null || d < best.d)) best = { s, d }
      }
      if (best !== null) {
        p.session = best.s
        best.s.pid = p.pid
      }
    }
  }

  const running = sessions.filter((s) => s.pid)
  const live = sessions.filter((s) => now - s.mtime < LIVE_MS)

  // 选了时间段 = 用户要看这段历史，此时「近期活跃」窗口不再参与过滤。
  const widened = extraWindowMs > 0 || rangeActive
  const visible = widened ? sessions : live
  // 50 只是「--all 没给 limit」时的默认页大小；搜索与时间段查询要结果集完整，
  // 否则搜出来的东西会被这条默认上限悄悄截掉（2026-11-07 实证：深搜 95 命中只剩 1）。
  const findMode = searchMode || rangeActive
  // limit === 0 → 未指定（走默认页大小）；limit === Infinity → 显式不限量。
  // 只有「有限且 > 0」才是真的限量。
  const explicitLimit = Number.isFinite(limit) && limit > 0
  const cap = explicitLimit ? limit : (findMode || limit === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY : 50)
  const rows = allMode || rangeActive || searchMode
    ? sessions.sort((a, b) => b.mtime - a.mtime).slice(0, cap)
    : [...new Set([...running, ...visible])].sort((a, b) => b.mtime - a.mtime)

  const detailed = has("--full") || !allMode
  const enriched = rows.map((s) => ({ ...s, ...headInfo(s), ...(detailed ? tailInfo(s) : {}) }))
  /**
   * Final display name. A true title (user rename / model-generated) wins; DSH's
   * deterministic `fallback` title is a byte-truncated prefix, so the full first
   * sentence of the user reads better for telling sessions apart.
   */
  const displayName = (s) => {
    if (s.title && s.titleSource !== "fallback") return s.title
    return s.firstText ?? s.title ?? null
  }

  // ---- 关键词筛选 -------------------------------------------------------
  // shallow（默认）：标题 / 首句 / cwd——这些都已经解出来了，零额外 I/O。
  // deep（--deep）：整份会话解码后搜正文，贵但准（实测 234 个文件约 3.5s）。
  let results = enriched
  if (keyword !== "") {
    const needle = keyword.toLowerCase()
    results = []
    for (const session of enriched) {
      const metaFields = [
        ["title", session.title],
        ["displayTitle", displayName(session)],
        ["firstText", session.firstText],
        ["cwd", session.cwd],
      ]
      const hit = metaFields.find(([, value]) => typeof value === "string" && value.toLowerCase().includes(needle))
      let snippet = hit === undefined ? null : String(hit[1]).slice(0, 140)
      let field = hit === undefined ? null : hit[0]
      if (field === null && deepSearch) {
        const full = decodeFrames(session.buf, session.starts, 0, Infinity).text
        const found = snippetOf(full, keyword)
        if (found !== null) {
          snippet = found
          field = "body"
        }
      }
      if (field !== null) results.push({ ...session, searchField: field, snippet })
    }
  }

  if (searchJson) {
    console.log(JSON.stringify({
      ok: true,
      keyword,
      deep: deepSearch,
      since: sinceMs === null ? null : new Date(sinceMs).toISOString(),
      until: untilMs === null ? null : new Date(untilMs).toISOString(),
      // 跨度上限相关的回报：面板据此提示「已收窄到 N 天，点下一页继续」。
      maxSpanDays,
      rangeClamped,
      nextAnchor,
      discovered: entries.length,
      read: [...loaded.values()].filter(Boolean).length,
      matched: results.length,
      results: results.map((s) => ({
        id: s.id,
        displayTitle: displayName(s),
        cwd: s.cwd,
        createdAt: s.createdAt,
        createdAtLocal: local(s.createdAt),
        lastWrite: s.mtime,
        lastWriteLocal: local(s.mtime),
        size: s.size,
        running: Boolean(s.pid),
        searchField: s.searchField ?? null,
        snippet: s.snippet ?? null,
      })),
    }, null, 2))
    emitMetrics()
    process.exit(0)
  }

  if (has("--json")) {
    console.log(
      JSON.stringify(
        results.map((s) => ({
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
          ...(s.searchField === undefined ? {} : { searchField: s.searchField, snippet: s.snippet }),
          file: s.file,
        })),
        null,
        2
      )
    )
    emitMetrics()
    process.exit(0)
  }

  console.log(
    `DSH 进程 ${procs.length} 个（其中无头 ${headlessProcs.length} 个）；会话文件共 ${entries.length} 个，本次读取 ${[...loaded.values()].filter(Boolean).length} 个（store: ${SESSIONS_ROOT}）`
  )
  console.log(
    `下面列出：正在运行的无头会话 + 最近 ${Math.round(LIVE_MS / 60000)} 分钟内活动过的会话${allMode ? "（--all：按 mtime 排列）" : ""}\n`
  )
  if (!enriched.length) {
    console.log("（当前没有正在跑、也没有近期活动的会话）")
  } else {
    for (const s of enriched) {
      const tag = s.pid
        ? `RUNNING 无头 pid=${s.pid}`
        : now - s.mtime < LIVE_MS
          ? "ACTIVE  无运行中无头进程（交互会话在写，或刚退出）"
          : "idle"
      console.log(`- ${tag}  ${displayName(s) ?? "(无标题)"}  ${s.id}`)
      console.log(`    cwd       : ${s.cwd}`)
      console.log(`    起于      : ${local(s.createdAt)}    文件更新: ${local(s.mtime)} (${ago(s.mtime)})   压缩 ${(s.size / 1024).toFixed(0)} KiB`)
      if (s.title && s.titleSource !== "fallback") console.log(`    标题      : ${s.title}`)
      if (s.firstText) console.log(`    首句(名)  : ${s.firstText}`)
      else if (s.title) console.log(`    标题(截断): ${s.title}`)
      if (s.goal) console.log(`    目标      : ${s.goal.replace(/\s+/g, " ").slice(0, 200)}`)
      if (s.lastTool || s.last) console.log(`    最近动作  : ${s.lastTool ?? "?"}${s.last ? " — " + s.last : ""}`)
      console.log(`    文件      : ${s.file}`)
    }
  }
  if (headlessProcs.some((p) => !p.session)) {
    console.log("\n未对齐到会话文件的无头进程：")
    for (const p of headlessProcs.filter((x) => !x.session)) console.log(`- pid=${p.pid} 起于 ${local(p.start)}`)
  }
  emitMetrics()
}

// import 本模块不得执行 CLI：只有直接 `node find-headless.mjs …` 才跑。
const invokedDirectly = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (invokedDirectly) runCli()

export { allSessionFiles, readSession, probeSessionHead, headInfo, tailInfo, runCli, dshProcesses }
