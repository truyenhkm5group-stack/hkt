/*
  ops `org-migrate-probe` — CHẨN ĐOÁN (CHỈ ĐỌC) vì sao MỘT tổ chức migrate chậm / hỏng.

  Vì sao có (sự cố 12/10/2026, sau deploy #792 = migration 0245 «turn_unhandled»): CSDL nhà + 6 tổ chức migrate xong (HSLC 41,7 s),
  riêng `qa` (dump chỉ 4,5 MB) chạy câu dẫn xuất tới trần 600 s rồi `canceling statement due to statement timeout`. Dữ liệu nhỏ mà
  chậm ⇒ nghi vế «tin mẫu cũ đọc chéo luồng 168 giờ» của định nghĩa #803 thành BẬC HAI khi một page có rất nhiều dòng PAGE_REPLY
  `sender_kind` NULL chữ dài (mỗi dòng như thế quét mọi PAGE_REPLY của page trong 168 giờ trước nó, so chữ đã chuẩn hoá — không chỉ
  mục nào đỡ được). Script này đo đúng các đại lượng quyết định giả thuyết đó, KHÔNG sửa gì:

   · sổ migration đã áp: số mục + tag cuối (đối chiếu drizzle/meta/_journal.json) · hàm / cột của 0245 đã có chưa;
   · số hội thoại theo kênh · số dòng sales_chat_inbound theo note · số dòng sales_chat_messages;
   · số PAGE_REPLY `sender_kind` NULL chữ ≥ 40 ký tự (dòng kích hoạt vế tin mẫu) · số page;
   · số dòng mỗi (page, luồng): lớn nhất / p95 · số PAGE_REPLY mỗi page trong cửa sổ 168 giờ (lớn nhất / p95, cửa sổ trượt theo dòng);
   · xấp xỉ số dòng PAGE_REPLY NULL dài nằm SAU lượt khách cuối của luồng (chính các dòng vế «đã trả lời» phải xét);
   · nếu hàm 0245 CHƯA có: bấm giờ câu ĐỌC tương đương (`latestCustomerTurnUnhandledFor` của lib — đúng thân hàm 0245) trên N luồng
     lớn nhất, `statement_timeout` 60 s MỖI câu (báo «quá 60 s» thay vì treo), dừng sau 2 lần quá trần.

  RÀNG BUỘC: ops lấy script từ main nhưng lib/ từ image đang chạy ⇒ chỉ nhập thứ đã có từ #803 (response-ownership-ledger) — không nhập lib
  của PR này. CHỈ ĐỌC do Postgres ép (`ERP_READ_ONLY=1` trước lần mở kết nối đầu tiên + hỏi lại phiên); CSDL tổ chức mở bằng
  `getDbForInspection` (KHÔNG migrate, không dọn). Kênh [ops:tom-tat] chỉ mang SỐ ĐẾM / thời gian / tag migration — không tên, SĐT, chữ
  tin, mã page / luồng / hội thoại. Vẫn MÃ HOÁ cả lượt (ops-vps `OPS_THAO_TAC_MA_HOA`).

  arg: `<mã tổ chức> [--top=1..50]` (mặc định 20 luồng lớn nhất).
*/
const CHAY_THANG = Boolean(process.argv[1] && process.argv[1].endsWith("org-migrate-probe.ts"));
if (CHAY_THANG) process.env.ERP_READ_ONLY = "1";

import "dotenv/config";
import { readFileSync } from "node:fs";
import { sql, type SQL } from "drizzle-orm";
import { getDbForInspection, type Db } from "@/db";
import { findOrganization } from "@/lib/platform/organizations";
import { latestCustomerTurnUnhandledFor } from "@/lib/sales-chatbot/response-ownership-ledger";
import { rowsOf } from "@/lib/sql-rows";

const tomTat = (s: string) => console.log(`[ops:tom-tat] ${s.slice(0, 300)}`);

// ─────────────────────────── PHẦN THUẦN ───────────────────────────

/** Trần MỖI câu đọc nặng (giây). */
export const PROBE_STATEMENT_TIMEOUT_S = 60;
/** Dừng bấm giờ sau bấy nhiêu lần quá trần — 20 câu × 60 s là 20 phút đè lên máy hai nhân. */
export const PROBE_MAX_TIMEOUTS = 2;
export const PROBE_TOP_DEFAULT = 20;

export function parseProbeArgs(argv: readonly string[]): { code: string; top: number } | { error: string } {
  const rest = argv.map((a) => a.trim()).filter((a) => a !== "");
  let top = PROBE_TOP_DEFAULT;
  const codes: string[] = [];
  for (const a of rest) {
    const m = /^--top=(\d{1,3})$/.exec(a);
    if (m) {
      top = Number(m[1]);
      if (top < 1 || top > 50) return { error: "--top phải trong 1..50" };
      continue;
    }
    if (a.startsWith("--")) return { error: `không hiểu cờ ${a.slice(0, 20)}` };
    codes.push(a);
  }
  if (codes.length !== 1) return { error: "cần đúng MỘT mã tổ chức: <mã tổ chức> [--top=1..50]" };
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(codes[0])) return { error: "sai mã tổ chức" };
  return { code: codes[0], top };
}

/** Giá trị `note` in ra được: hằng số dạng MÃ (BOT_SENT, PAGE_REPLY…); thứ khác gộp «khác» để không lọt chữ tự do. */
export function safeNoteLabel(note: string | null): string {
  if (note === null || note === "") return "(trống)";
  return /^[A-Z][A-Z0-9_]{0,39}$/.test(note) ? note : "(khác)";
}

/** Nhãn kênh in được — cùng luật với note. */
export const safeChannelLabel = safeNoteLabel;

/** Tag migration cuối từ mốc `created_at` lớn nhất đã áp + sổ. HÀM THUẦN. */
export function lastAppliedTag(appliedMax: number, journal: readonly { tag: string; when: number }[]): string {
  if (!appliedMax) return "(chưa áp mục nào)";
  return journal.find((e) => e.when === appliedMax)?.tag ?? `(mốc ${appliedMax} không có trong sổ của mã đang chạy)`;
}

export type ThreadTiming = { rows: number; ms: number | null };

/** Tóm tắt bấm giờ: số câu đo · quá trần · lớn nhất · trung vị · tổng. HÀM THUẦN. */
export function timingSummary(t: readonly ThreadTiming[], skipped: number): string {
  const done = t.filter((x) => x.ms !== null).map((x) => x.ms as number).sort((a, b) => a - b);
  const over = t.filter((x) => x.ms === null).length;
  const med = done.length ? done[Math.floor((done.length - 1) / 2)] : null;
  const max = done.length ? done[done.length - 1] : null;
  const sum = done.reduce((a, b) => a + b, 0);
  const s = (ms: number | null) => (ms === null ? "—" : `${(ms / 1000).toFixed(2)} s`);
  const biggest = t.length ? Math.max(...t.map((x) => x.rows)) : 0;
  return `${t.length} luồng (lớn nhất ${biggest} dòng) · xong ${done.length} · quá ${PROBE_STATEMENT_TIMEOUT_S} s ${over}${skipped ? ` · bỏ ${skipped} (dừng sau ${PROBE_MAX_TIMEOUTS} lần quá trần)` : ""} · lớn nhất ${s(max)} · trung vị ${s(med)} · tổng ${s(done.length ? sum : null)}`;
}

/** Đọc số an toàn: NULL ⇒ null (CHƯA BIẾT), không thành 0. */
const num = (v: unknown): number | null => (v === null || v === undefined || v === "" ? null : Number(v));
const show = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? "—" : String(Math.round(v)));

// ─────────────────────────── ĐỌC CSDL ───────────────────────────

class QuaTran extends Error {}

/** Một câu trong giao dịch có trần riêng; quá trần ⇒ `QuaTran` (bên gọi in «quá 60 s»), lỗi khác ném nguyên. */
async function timed<T>(db: Db, q: SQL): Promise<{ rows: T[]; ms: number }> {
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql.raw(`set local statement_timeout = '${PROBE_STATEMENT_TIMEOUT_S}s'`));
      const t = performance.now();
      const rows = rowsOf<T>(await tx.execute(q));
      return { rows, ms: performance.now() - t };
    });
  } catch (e) {
    const code = (e as { code?: string; cause?: { code?: string } }).code ?? (e as { cause?: { code?: string } }).cause?.code;
    const msg = e instanceof Error ? e.message : String(e);
    if (code === "57014" || /statement timeout/i.test(msg)) throw new QuaTran(msg);
    throw e;
  }
}

/** Chạy một phép đo; quá trần ⇒ trả `null` và in dòng «quá 60 s» thay vì làm hỏng cả lượt. */
async function measure<T>(label: string, org: string, db: Db, q: SQL): Promise<{ rows: T[]; ms: number } | null> {
  try {
    return await timed<T>(db, q);
  } catch (e) {
    if (e instanceof QuaTran) {
      tomTat(`org-migrate-probe ${org} ${label}: quá ${PROBE_STATEMENT_TIMEOUT_S} s — chưa đo được`);
      return null;
    }
    throw e;
  }
}

const CUSTOMER = sql`(i.imported_at is null and coalesce(i.note, '') not in ('BOT_SENT', 'PAGE_REPLY'))`;
const TPL_KEY = (a: string) => sql.raw(`btrim(regexp_replace(${a}."text", '[[:space:]]+', ' ', 'g'))`);

/** `opts.forceTiming` — CHỈ cho bài kiểm (CSDL thử đã có hàm 0245 nên nhánh bấm giờ không tự chạy); ops không có cờ này. */
export async function probeOrganization(db: Db, org: string, top: number, opts: { forceTiming?: boolean } = {}): Promise<void> {
  // 1. Sổ migration + 0245.
  let journal: { tag: string; when: number }[] = [];
  try {
    journal = (JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8")) as { entries: { tag: string; when: number }[] }).entries;
  } catch {
    // Không có sổ (chạy ngoài thư mục ứng dụng) ⇒ tag in «không có trong sổ».
  }
  const [mig] = rowsOf<{ n: number; maxwhen: string | null }>(
    await db.execute(sql`select count(*)::int as n, max(created_at)::text as maxwhen from "drizzle"."__drizzle_migrations"`),
  );
  const [f245] = rowsOf<{ fn: boolean; col: boolean }>(
    await db.execute(sql`select exists (select 1 from pg_proc where proname = 'sales_chat_turn_unhandled_thread') as fn,
      exists (select 1 from information_schema.columns where table_schema = current_schema() and table_name = 'sales_chat_conversations' and column_name = 'turn_unhandled') as col`),
  );
  const maxWhen = Number(mig?.maxwhen ?? 0);
  tomTat(`org-migrate-probe ${org}: sổ CSDL đã áp ${show(num(mig?.n))} mục · tag cuối ${lastAppliedTag(maxWhen, journal)} · sổ của mã đang chạy ${journal.length} mục · hàm 0245 ${f245?.fn ? "CÓ" : "CHƯA"} · cột turn_unhandled ${f245?.col ? "CÓ" : "CHƯA"}`);

  // 2. Kích thước theo kênh / note.
  const ch = rowsOf<{ channel: string | null; n: number }>(await db.execute(sql`select channel, count(*)::int as n from "sales_chat_conversations" group by channel order by 2 desc`));
  const byCh = new Map<string, number>();
  for (const r of ch) byCh.set(safeChannelLabel(r.channel), (byCh.get(safeChannelLabel(r.channel)) ?? 0) + Number(r.n));
  const notes = rowsOf<{ note: string | null; n: number }>(await db.execute(sql`select note, count(*)::int as n from "sales_chat_inbound" group by note order by 2 desc`));
  const byNote = new Map<string, number>();
  for (const r of notes) byNote.set(safeNoteLabel(r.note), (byNote.get(safeNoteLabel(r.note)) ?? 0) + Number(r.n));
  const [msg] = rowsOf<{ n: number }>(await db.execute(sql`select count(*)::int as n from "sales_chat_messages"`));
  tomTat(`org-migrate-probe ${org} hội thoại theo kênh: ${[...byCh].map(([k, v]) => `${k} ${v}`).join(" · ") || "0"} · sales_chat_messages ${show(num(msg?.n))} dòng`);
  tomTat(`org-migrate-probe ${org} sales_chat_inbound theo loại dòng: ${[...byNote].map(([k, v]) => `${k} ${v}`).join(" · ") || "0"}`);

  // 3. Vế tin mẫu: dòng PAGE_REPLY NULL dài + page + phân bố luồng.
  const shape = await measure<{ pages: number; null_long: number; thr_max: number | null; thr_p95: number | null; threads: number }>(
    "phân bố luồng",
    org,
    db,
    sql`select (select count(distinct page_id)::int from "sales_chat_inbound") as pages,
        (select count(*)::int from "sales_chat_inbound" i where i.note = 'PAGE_REPLY' and i.sender_kind is null and char_length(${TPL_KEY("i")}) >= 40) as null_long,
        max(t.n)::int as thr_max, percentile_cont(0.95) within group (order by t.n) as thr_p95, count(*)::int as threads
      from (select count(*) as n from "sales_chat_inbound" group by page_id, thread_id) t`,
  );
  const sh = shape?.rows[0];
  if (sh) tomTat(`org-migrate-probe ${org}: ${show(num(sh.pages))} page · ${show(num(sh.threads))} luồng · dòng/luồng lớn nhất ${show(num(sh.thr_max))} · p95 ${show(num(sh.thr_p95))} · PAGE_REPLY sender_kind NULL chữ ≥ 40: ${show(num(sh.null_long))}`);

  const win = await measure<{ w_max: number | null; w_p95: number | null; heavy_pages: number }>(
    "cửa sổ 168 giờ",
    org,
    db,
    sql`select max(w.n)::int as w_max, percentile_cont(0.95) within group (order by w.n) as w_p95,
        count(distinct w.page_id) filter (where w.n >= 1000)::int as heavy_pages
      from (select i.page_id, count(*) over (partition by i.page_id order by i.created_at range between interval '168 hours' preceding and current row) as n
        from "sales_chat_inbound" i where i.note = 'PAGE_REPLY') w`,
  );
  const w = win?.rows[0];
  if (w) tomTat(`org-migrate-probe ${org} PAGE_REPLY mỗi page trong cửa sổ 168 giờ (trượt theo dòng): lớn nhất ${show(num(w.w_max))} · p95 ${show(num(w.w_p95))} · số page có cửa sổ ≥ 1000 dòng ${show(num(w.heavy_pages))}`);

  const after = await measure<{ n: number; threads: number }>(
    "dòng sau lượt khách cuối",
    org,
    db,
    sql`select count(*)::int as n, count(distinct (o.page_id, o.thread_id))::int as threads
      from "sales_chat_inbound" o
      join (select i.page_id, i.thread_id, max(i.created_at) as last_at from "sales_chat_inbound" i where ${CUSTOMER} group by i.page_id, i.thread_id) lc
        on lc.page_id = o.page_id and lc.thread_id = o.thread_id
      where o.note = 'PAGE_REPLY' and o.sender_kind is null and o.created_at > lc.last_at and char_length(${TPL_KEY("o")}) >= 40`,
  );
  const a = after?.rows[0];
  if (a) {
    const cost = w?.w_max != null && a.n != null ? Number(a.n) * Number(w.w_max) : null;
    tomTat(`org-migrate-probe ${org} PAGE_REPLY NULL dài nằm SAU lượt khách cuối (xấp xỉ, vế «đã trả lời» phải xét): ${show(num(a.n))} dòng / ${show(num(a.threads))} luồng · trần phép so chéo luồng ≈ ${show(cost)} cặp (dòng × cửa sổ lớn nhất)`);
  }

  // 4. Bấm giờ câu đọc tương đương — chỉ khi hàm 0245 CHƯA có (có rồi thì migration đã qua, không cần đè thêm tải).
  if (f245?.fn && !opts.forceTiming) {
    tomTat(`org-migrate-probe ${org} bấm giờ: BỎ QUA — hàm 0245 đã có (migration đã áp)`);
    return;
  }
  const big = rowsOf<{ page_id: string; thread_id: string; n: number }>(
    await db.execute(sql`select page_id, thread_id, count(*)::int as n from "sales_chat_inbound" group by page_id, thread_id order by 3 desc limit ${top}`),
  );
  const timings: ThreadTiming[] = [];
  let over = 0;
  let skipped = 0;
  for (const t of big) {
    if (over >= PROBE_MAX_TIMEOUTS) {
      skipped++;
      continue;
    }
    try {
      const r = await timed<{ v: boolean | null }>(db, sql`select ${latestCustomerTurnUnhandledFor(sql`${t.page_id}::text`, sql`${t.thread_id}::text`, sql`null::timestamptz`)} as v`);
      timings.push({ rows: Number(t.n), ms: r.ms });
    } catch (e) {
      if (!(e instanceof QuaTran)) throw e;
      over++;
      timings.push({ rows: Number(t.n), ms: null });
    }
  }
  tomTat(`org-migrate-probe ${org} bấm giờ định nghĩa #803 (≡ thân hàm 0245) trên luồng lớn nhất: ${timingSummary(timings, skipped)}`);
}

async function main() {
  const args = parseProbeArgs(process.argv.slice(2));
  if ("error" in args) {
    tomTat(`org-migrate-probe: DỪNG · cách dùng sai — ${args.error}`);
    return 1;
  }
  const org = await findOrganization(args.code);
  if (!org) {
    tomTat(`org-migrate-probe: DỪNG · không có tổ chức «${args.code}»`);
    return 1;
  }
  console.log(`org-migrate-probe · ${org.code} · lúc ${new Date().toISOString()} · trần ${PROBE_STATEMENT_TIMEOUT_S} s mỗi câu · top ${args.top}`);
  const db: Db = await getDbForInspection(org);
  const [ro] = rowsOf<Record<string, unknown>>(await db.execute(sql`show default_transaction_read_only`));
  if (String(ro?.default_transaction_read_only ?? "") !== "on") {
    tomTat(`org-migrate-probe ${org.code}: DỪNG · phiên CSDL KHÔNG ở chế độ chỉ đọc — không đọc gì`);
    return 1;
  }
  await probeOrganization(db, org.code, args.top);
  return 0;
}

/** Xả stdout trước khi thoát — `process.exit` ngay sau `console.log` có thể cắt mất dòng tóm tắt cuối khi stdout là ống. */
async function flushThenExit(code: number): Promise<never> {
  await new Promise<void>((r) => process.stdout.write("", () => r()));
  process.exit(code);
}

// Chỉ chạy khi được gọi THẲNG từ dòng lệnh — `import` từ bài kiểm không được kéo theo `process.exit`.
if (CHAY_THANG) {
  main()
    .then((code) => flushThenExit(code))
    .catch(async (e) => {
      console.error("org-migrate-probe lỗi:", e instanceof Error ? e.message : e);
      tomTat("org-migrate-probe: LỖI ngoài phép đo — chi tiết trong phần mã hoá");
      await flushThenExit(1);
    });
}
