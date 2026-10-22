/*
  ops `vtp-reship-backfill` — VẬN ĐƠN TẠO LẠI TRÊN WEB VTP GẮN VỀ ĐƠN GỐC (P0 chủ shop 22/10/2026).

  Bối cảnh (đo 22/10, db-query 39809516912 · 39810118546 · 39810275325): từ 15/10 có 330 vận đơn Viettel Post mồ côi mà
  ORDER_REFERENCE = SỐ VẬN ĐƠN GỐC (PKE…) của một vận đơn CÓ đơn — hàng được gửi lại bằng vận đơn tạo trên web, đơn Pancake gốc
  «Đã hủy» ⇒ đơn hiện huỷ trong khi kết cục thật nằm trên vận đơn mới. Phép gắn (lần gửi kế của CÙNG đơn) là việc của
  `vtp-reship-relink` (code-erp-56); script này sẽ gọi ĐÚNG hàm ghép ấy khi nó vào main — không viết luật thứ hai.

  Bản này chỉ có PHẦN ĐO (mốc TRƯỚC / SAU), CHỈ ĐỌC do Postgres ép:
   · GTC theo ĐÚNG hàm của /reports/returns (`returnsPageParams` + `loadReturnsPage`) cho kỳ 7 ngày và từ 15/10;
   · đơn huỷ theo ngày lên đơn, và bao nhiêu trong đó là đơn GỐC của vận đơn tạo lại;
   · tồn kho: số cặp (vận đơn gốc, vận đơn tạo lại) mà CẢ HAI cùng rời kho theo `SHIPMENT_LEFT_WAREHOUSE` — nguy cơ trừ hai lần
     khi vận đơn tạo lại được gắn vào đơn.
  Cặp «gốc ↔ tạo lại» ở đây là PHÉP ĐO (ORDER_REFERENCE của mồ côi = vtp_order_number của vận đơn có đơn), không phải luật ghép.

  `--apply` bị TỪ CHỐI cho tới khi hàm ghép của vtp-reship-relink có trên main.
  Không in mã đơn, mã vận đơn, tên hay SĐT; [ops:tom-tat] chỉ có số đếm. arg: rỗng | `--measure` (như nhau) | `--apply` (chưa mở).
*/
const CHAY_THANG = Boolean(process.argv[1] && process.argv[1].endsWith("vtp-reship-backfill.ts"));
if (CHAY_THANG) process.env.ERP_READ_ONLY = "1";

import "dotenv/config";
import { and, inArray, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { SHIPMENT_LEFT_WAREHOUSE } from "@/lib/queries/return-rate";
import { loadReturnsPage, returnsPageParams, withDefaultReturnsBasis } from "@/lib/queries/returns-report-page";
import { rowsOf } from "@/lib/sql-rows";

const tomTat = (s: string) => console.log(`[ops:tom-tat] ${s.slice(0, 300)}`);
export const RESHIP_FROM_DAY = "2026-10-15";

/** Ngày giờ Việt Nam hôm nay (YYYY-MM-DD). HÀM THUẦN. */
export const vnToday = (now: Date) => new Date(now.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);

/** Tham số trang /reports/returns cho hai kỳ đo — đúng dạng URL người dùng mở. HÀM THUẦN. */
export function measureWindows(now: Date): { label: string; raw: Record<string, string> }[] {
  return [
    { label: "7 ngày", raw: { period: "7d" } },
    { label: `từ ${RESHIP_FROM_DAY}`, raw: { period: "custom", from: RESHIP_FROM_DAY, to: vnToday(now) } },
  ];
}

export function parseBackfillArgs(argv: readonly string[]): { ok: true; apply: boolean } | { ok: false; error: string } {
  let apply = false;
  for (const a of argv.map((x) => x.trim()).filter(Boolean)) {
    if (a === "--measure") continue;
    if (a === "--apply") apply = true;
    else return { ok: false, error: `cờ lạ: ${a}` };
  }
  return { ok: true, apply };
}

const pct = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? "—" : `${v.toFixed(1)}%`);

async function measureGtc(now: Date) {
  for (const w of measureWindows(now)) {
    // Shop có module vận chuyển ⇒ basis mặc định của trang là mốc gửi ĐVVC (withDefaultReturnsBasis).
    const p = returnsPageParams(withDefaultReturnsBasis(w.raw, true));
    const { summary } = await loadReturnsPage(p);
    tomTat(`GTC ${w.label} (/reports/returns, basis ${p.basis}): đã gửi ${summary.shipped} · giao TC ${summary.delivered} · không TC ${summary.returned} · chưa kết thúc ${summary.inTransit} · GTC ${pct(summary.successRate)} · ước tính ${pct(summary.expectedSuccessRate)}`);
  }
}

type Pair = { origId: string; newId: string; orderId: string };

async function reshipPairs(): Promise<Pair[]> {
  const db = await getDb();
  return rowsOf<{ orig_id: string; new_id: string; order_id: string }>(
    await db.execute(sql`select g.id as orig_id, m.id as new_id, g.order_id from shipments m join shipments g on g.vtp_order_number = m.order_reference and g.id <> m.id
      where m.order_id is null and g.order_id is not null and m.created_at >= ${`${RESHIP_FROM_DAY}T00:00:00+07:00`}::timestamptz and m.carrier = 'Viettel Post'`),
  ).map((r) => ({ origId: String(r.orig_id), newId: String(r.new_id), orderId: String(r.order_id) }));
}

async function measureCancelsAndStock(pairs: Pair[]) {
  const db = await getDb();
  const goc = new Set(pairs.map((p) => p.orderId));
  const rows = rowsOf<{ ngay: string; id: string }>(
    await db.execute(sql`select to_char(o.inserted_at at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD') as ngay, o.id from orders o
      where o.stage::text = 'CANCELLED' and o.inserted_at >= ${"2026-10-13T00:00:00+07:00"}::timestamptz`),
  );
  const byDay = new Map<string, { huy: number; goc: number }>();
  for (const r of rows) {
    const e = byDay.get(r.ngay) ?? { huy: 0, goc: 0 };
    e.huy += 1;
    if (goc.has(String(r.id))) e.goc += 1;
    byDay.set(r.ngay, e);
  }
  for (const [d, e] of [...byDay].sort()) tomTat(`đơn huỷ ngày lên đơn ${d}: ${e.huy} · trong đó đơn GỐC của vận đơn tạo lại ${e.goc}`);

  // Tồn kho: cặp mà CẢ HAI vận đơn đã rời kho theo đúng vị ngữ của sổ kho.
  const ids = [...new Set(pairs.flatMap((p) => [p.origId, p.newId]))];
  const left = new Set<string>();
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const s = schema.shipments;
    for (const r of await db.select({ id: s.id }).from(s).where(and(inArray(s.id, chunk), SHIPMENT_LEFT_WAREHOUSE))) left.add(r.id);
  }
  const both = pairs.filter((p) => left.has(p.origId) && left.has(p.newId)).length;
  const onlyNew = pairs.filter((p) => !left.has(p.origId) && left.has(p.newId)).length;
  const onlyOrig = pairs.filter((p) => left.has(p.origId) && !left.has(p.newId)).length;
  tomTat(`tồn kho: ${pairs.length} cặp gốc ↔ tạo lại (${goc.size} đơn) · CẢ HAI đã rời kho ${both} (nguy cơ trừ hai lần khi gắn) · chỉ vận đơn mới ${onlyNew} · chỉ vận đơn gốc ${onlyOrig}`);
}

async function main() {
  const parsed = parseBackfillArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(`vtp-reship-backfill: ${parsed.error}. Dùng: (rỗng) | --measure`);
    process.exit(2);
  }
  if (parsed.apply) {
    console.error("vtp-reship-backfill: --apply CHƯA MỞ — cần hàm ghép của vtp-reship-relink (code-erp-56) trên main; bản này chỉ đo.");
    process.exit(2);
  }
  const db = await getDb();
  const [ro] = rowsOf<{ transaction_read_only?: string }>(await db.execute(sql`show transaction_read_only`));
  if (ro?.transaction_read_only !== "on") throw new Error("phiên CSDL không ở chế độ chỉ đọc — dừng");
  const now = new Date();
  tomTat(`vtp-reship-backfill · CHỈ ĐO (mốc trước / sau) · ${now.toISOString()}`);
  await measureGtc(now);
  const pairs = await reshipPairs();
  await measureCancelsAndStock(pairs);
  process.exit(0);
}

if (CHAY_THANG) {
  main().catch((error) => {
    console.error("vtp-reship-backfill hỏng:", error instanceof Error ? error.message.slice(0, 300) : error);
    process.exit(1);
  });
}
