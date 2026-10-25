/**
 * ═══ ops `app-log-evt-count` — ĐẾM DÒNG SỰ KIỆN JSON TRONG LOG CỦA APP (CHỈ ĐỌC, 25/10/2026) ═══
 *
 * Vì sao: vài hàng rào chỉ để lại vết ở log — câu bot BỊ CHẶN không bao giờ được gửi nên không có dòng nào trong CSDL để 2B đếm (vd
 * `{"evt":"address_ask_dropped","code":"KNOWN_ADDRESS_REASKED","source":"COMMENT"}` của comment-facts.ts, #1060). Thao tác cũ `logs`
 * chỉ in 200 dòng cuối — không trả lời được «24 giờ qua chặn bao nhiêu lần».
 *
 * Đầu vào: STDIN = `docker logs -t --since 72h erp-app` (mỗi dòng mang mốc RFC3339 của docker ở đầu). Script KHÔNG mở CSDL, không gọi mạng.
 * Chỉ đếm theo bộ (evt · code · source) — ba trường ấy là TÊN trong mã nguồn ([A-Za-z0-9_.:-], ≤ 64 ký tự), không bao giờ là dữ liệu
 * khách; mọi trường khác của dòng (mã hội thoại, số…) bị bỏ, không in. Kèm PHỦ: mốc dòng đầu / cuối đọc được — container khởi động lại
 * sau mỗi deploy nên log có thể không phủ hết cửa sổ hỏi, và «0 lần» chỉ có nghĩa trong khoảng log thật sự có.
 * arg: "[--hours=1..72 | --since=<ISO>] [--evt=<tên>]" (mặc định 24 giờ, mọi evt).
 */
import { splitSummaryLine } from "@/lib/ops/summary-lines";

const tomTat = (s: string) => {
  for (const line of splitSummaryLine(s)) console.log(`[ops:tom-tat] ${line}`);
};

export type LogEvt = { at: number | null; evt: string; code: string | null; source: string | null };
export type EvtArgs = { sinceMs: number; evt: string | null };

const NAME = /^[A-Za-z0-9_.:-]{1,64}$/;
const field = (line: string, key: string): string | null => {
  const m = new RegExp(`"${key}":"([^"\\\\]{1,64})"`).exec(line);
  return m && NAME.test(m[1]) ? m[1] : null;
};

/** Một dòng log ⇒ sự kiện (hoặc `null` khi không có `"evt"` hợp lệ). Mốc docker ở đầu dòng; thiếu ⇒ `at = null`. HÀM THUẦN. */
export function parseLogLine(line: string): LogEvt | null {
  const evt = field(line, "evt");
  if (!evt) return null;
  const ts = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s/.exec(line);
  const at = ts ? Date.parse(ts[1]) : NaN;
  return { at: Number.isFinite(at) ? at : null, evt, code: field(line, "code"), source: field(line, "source") };
}

export const MAX_HOURS = 72;
export const DEFAULT_HOURS = 24;

/** Đọc arg. HÀM THUẦN. */
export function parseEvtArgs(argv: readonly string[], now: Date): EvtArgs | { error: string } {
  const hoursRaw = argv.find((a) => a.startsWith("--hours="))?.slice(8);
  const sinceRaw = argv.find((a) => a.startsWith("--since="))?.slice(8);
  const evtRaw = argv.find((a) => a.startsWith("--evt="))?.slice(6);
  if (hoursRaw !== undefined && sinceRaw !== undefined) return { error: "--hours và --since không đi cùng nhau" };
  if (evtRaw !== undefined && !NAME.test(evtRaw)) return { error: "--evt chỉ nhận tên [A-Za-z0-9_.:-]" };
  let sinceMs = now.getTime() - DEFAULT_HOURS * 3_600_000;
  if (hoursRaw !== undefined) {
    const h = Number(hoursRaw);
    if (!Number.isInteger(h) || h < 1 || h > MAX_HOURS) return { error: `--hours phải là số nguyên 1..${MAX_HOURS}` };
    sinceMs = now.getTime() - h * 3_600_000;
  }
  if (sinceRaw !== undefined) {
    const t = Date.parse(sinceRaw);
    if (!Number.isFinite(t) || t > now.getTime() || now.getTime() - t > MAX_HOURS * 3_600_000) return { error: `--since phải là mốc ISO trong ${MAX_HOURS} giờ qua` };
    sinceMs = t;
  }
  return { sinceMs, evt: evtRaw ?? null };
}

export type EvtTally = { lines: number; firstAt: number | null; lastAt: number | null; undated: number; counts: Map<string, number> };

/** Đếm theo (evt · code · source) trong cửa sổ. Dòng không mốc KHÔNG được tính vào cửa sổ (đếm riêng). HÀM THUẦN. */
export function tallyEvents(lines: Iterable<string>, args: EvtArgs): EvtTally {
  const t: EvtTally = { lines: 0, firstAt: null, lastAt: null, undated: 0, counts: new Map() };
  for (const line of lines) {
    t.lines += 1;
    const ts = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s/.exec(line);
    const at = ts ? Date.parse(ts[1]) : NaN;
    if (Number.isFinite(at)) {
      if (t.firstAt === null || at < t.firstAt) t.firstAt = at;
      if (t.lastAt === null || at > t.lastAt) t.lastAt = at;
    }
    const e = parseLogLine(line);
    if (!e) continue;
    if (e.at === null) {
      t.undated += 1;
      continue;
    }
    if (e.at < args.sinceMs || (args.evt && e.evt !== args.evt)) continue;
    const key = `${e.evt} · ${e.code ?? "—"} · ${e.source ?? "—"}`;
    t.counts.set(key, (t.counts.get(key) ?? 0) + 1);
  }
  return t;
}

const iso = (ms: number | null) => (ms === null ? "—" : new Date(ms).toISOString().slice(0, 19) + "Z");

/** Dòng tóm tắt (chỉ tên + số + mốc). HÀM THUẦN. */
export function evtLines(t: EvtTally, args: EvtArgs, top = 30): string[] {
  const covered = t.firstAt !== null && t.firstAt <= args.sinceMs;
  const out = [
    `cửa sổ từ ${iso(args.sinceMs)}${args.evt ? ` · evt=${args.evt}` : ""} · log đọc được ${t.lines} dòng, ${iso(t.firstAt)} → ${iso(t.lastAt)} · ${covered ? "PHỦ đủ cửa sổ" : "KHÔNG phủ đủ cửa sổ (log bắt đầu muộn hơn — container khởi động lại): số dưới chỉ tính từ dòng đầu"} · dòng evt không mốc ${t.undated}`,
  ];
  const rows = [...t.counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (!rows.length) out.push("0 dòng sự kiện khớp trong cửa sổ");
  for (const [k, n] of rows.slice(0, top)) out.push(`${n} × ${k}`);
  if (rows.length > top) out.push(`… và ${rows.length - top} bộ khác`);
  return out;
}

async function readStdin(): Promise<string[]> {
  if (process.stdin.isTTY) return [];
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8").split(/\r?\n/).filter(Boolean);
}

async function main() {
  const args = parseEvtArgs(process.argv.slice(2), new Date());
  if ("error" in args) {
    tomTat(`app-log-evt-count: ${args.error}`);
    process.exit(64);
  }
  const t = tallyEvents(await readStdin(), args);
  for (const l of evtLines(t, args)) tomTat(l);
  process.exit(t.lines ? 0 : 1);
}

if (process.argv[1]?.endsWith("app-log-evt-count.ts")) void main();
