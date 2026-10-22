/*
  ops `vtp-reship-backfill` — VẬN ĐƠN TẠO LẠI TRÊN WEB VTP GẮN VỀ ĐƠN GỐC (P0 chủ shop 22/10/2026).

  Bối cảnh (đo 22/10, db-query 39809516912 · 39810118546 · 39810275325): từ 15/10 có 330 vận đơn Viettel Post mồ côi mà
  ORDER_REFERENCE = SỐ VẬN ĐƠN GỐC (PKE…) của một vận đơn CÓ đơn — hàng được gửi lại bằng vận đơn tạo trên web, đơn Pancake gốc
  «Đã hủy» ⇒ đơn hiện huỷ trong khi kết cục thật nằm trên vận đơn mới.

  MỘT luật ghép (lib/integrations/viettelpost/reship.ts, vtp-reship-relink): `reshipCandidates` gom ứng viên · `reshipParentOf`
  phán (ATTEMPT · NONE · HOLD) · `relinkOrphanShipment` ghi (khoá dòng, chỉ khi còn mồ côi, dựng lại trạng thái hai dòng, audit).
  Script KHÔNG có luật thứ hai và KHÔNG có câu ghi nào — chỉ gọi ba hàm ấy trên dòng mồ côi CÓ SẴN.

  THỨ TỰ CHẠY (Tech Lead 22/10/2026): `--apply` CHỈ sau khi #979 (vtp-reship-relink) VÀ PR2 vtp-reship-outcome đã deploy — trước
  PR2, `ERP_STOCK_SUB` (lib/queries/products.ts) nối MỌI lần gửi của đơn, nên gắn lần gửi kế cho ~73 đơn 15/10 còn vận đơn gốc
  PICKED_UP sẽ trừ tồn HAI lần. Chạy thử thì được ngay sau #979.

  MẶC ĐỊNH CHẠY THỬ (chỉ đọc do Postgres ép): mốc TRƯỚC + kế hoạch (bao nhiêu dòng gắn được, theo ngày, giữ lại vì sao).
  `--apply`: ghi qua `relinkOrphanShipment` với lý do «gắn vận đơn tạo lại trên web VTP vào đơn gốc — P0 22/10», rồi đo lại mốc
  SAU bằng đúng các phép đo ấy. Chạy lại lần hai: mọi dòng đã gắn ⇒ 0 lượt ghi.

  Phép đo (cả hai chế độ): GTC qua ĐÚNG hàm của /reports/returns (`returnsPageParams` + `loadReturnsPage`) cho kỳ 7 ngày và từ
  15/10 · đơn huỷ theo ngày lên đơn và phần là đơn GỐC của vận đơn tạo lại · cặp gốc ↔ tạo lại mà CẢ HAI cùng rời kho theo
  `SHIPMENT_LEFT_WAREHOUSE`.
  Không in mã đơn, mã vận đơn, tên hay SĐT; [ops:tom-tat] chỉ có số đếm. arg: rỗng | `--measure` (như nhau) | `--apply`.
*/
const CHAY_THANG = Boolean(process.argv[1] && process.argv[1].endsWith("vtp-reship-backfill.ts"));
// Chạy thử ⇒ CHỈ ĐỌC do Postgres ép (đặt trước lần mở kết nối đầu tiên). `--apply` mới mở đường ghi.
if (CHAY_THANG && !process.argv.slice(2).includes("--apply")) process.env.ERP_READ_ONLY = "1";

import "dotenv/config";
import { and, gte, inArray, isNull, sql } from "drizzle-orm";
import { getDb, schema, type Db } from "@/db";
import { clearMemo } from "@/lib/cache";
import { relinkOrphanShipment, reshipCandidates, reshipParentOf, type ReshipVerdict } from "@/lib/integrations/viettelpost/reship";
import { SHIPMENT_LEFT_WAREHOUSE } from "@/lib/queries/return-rate";
import { loadReturnsPage, returnsPageParams, withDefaultReturnsBasis } from "@/lib/queries/returns-report-page";
import { rowsOf } from "@/lib/sql-rows";

const tomTat = (s: string) => console.log(`[ops:tom-tat] ${s.slice(0, 300)}`);
export const RESHIP_FROM_DAY = "2026-10-15";
export const RESHIP_REASON = "gắn vận đơn tạo lại trên web VTP vào đơn gốc — P0 22/10";
export const RESHIP_SOURCE = "SCRIPT_RELINK";
export const RESHIP_ACTOR = "script:vtp-reship-backfill";

/** Ngày giờ Việt Nam (YYYY-MM-DD). HÀM THUẦN. */
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

async function measureGtc(now: Date, moc: "TRƯỚC" | "SAU") {
  for (const w of measureWindows(now)) {
    // Shop có module vận chuyển ⇒ basis mặc định của trang là mốc gửi ĐVVC (withDefaultReturnsBasis).
    const p = returnsPageParams(withDefaultReturnsBasis(w.raw, true));
    const { summary } = await loadReturnsPage(p);
    tomTat(`${moc} · GTC ${w.label} (/reports/returns, basis ${p.basis}): đã gửi ${summary.shipped} · giao TC ${summary.delivered} · không TC ${summary.returned} · chưa kết thúc ${summary.inTransit} · GTC ${pct(summary.successRate)} · ước tính ${pct(summary.expectedSuccessRate)}`);
  }
}

type Pair = { origId: string; newId: string; orderId: string };

/** Cặp gốc ↔ tạo lại đang còn mồ côi — PHÉP ĐO (dùng cho đơn huỷ / tồn kho), không phải luật ghép. */
async function reshipPairs(db: Db): Promise<Pair[]> {
  return rowsOf<{ orig_id: string; new_id: string; order_id: string }>(
    await db.execute(sql`select g.id as orig_id, m.id as new_id, g.order_id from shipments m join shipments g on upper(g.vtp_order_number) = upper(m.order_reference) and g.id <> m.id
      where m.order_id is null and g.order_id is not null and m.created_at >= ${`${RESHIP_FROM_DAY}T00:00:00+07:00`}::timestamptz and m.carrier = 'Viettel Post'`),
  ).map((r) => ({ origId: String(r.orig_id), newId: String(r.new_id), orderId: String(r.order_id) }));
}

async function measureCancelsAndStock(db: Db, moc: "TRƯỚC" | "SAU") {
  const pairs = await reshipPairs(db);
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
  for (const [d, e] of [...byDay].sort()) tomTat(`${moc} · đơn huỷ ngày lên đơn ${d}: ${e.huy} · trong đó đơn GỐC của vận đơn tạo lại còn mồ côi ${e.goc}`);
  // Tồn kho: cặp mà CẢ HAI vận đơn đã rời kho theo đúng vị ngữ của sổ kho.
  const ids = [...new Set(pairs.flatMap((p) => [p.origId, p.newId]))];
  const left = new Set<string>();
  const s = schema.shipments;
  for (let i = 0; i < ids.length; i += 500) {
    for (const r of await db.select({ id: s.id }).from(s).where(and(inArray(s.id, ids.slice(i, i + 500)), SHIPMENT_LEFT_WAREHOUSE))) left.add(r.id);
  }
  const both = pairs.filter((p) => left.has(p.origId) && left.has(p.newId)).length;
  tomTat(`${moc} · tồn kho: ${pairs.length} cặp gốc ↔ tạo lại còn mồ côi (${goc.size} đơn) · CẢ HAI đã rời kho ${both} · chỉ vận đơn mới ${pairs.filter((p) => !left.has(p.origId) && left.has(p.newId)).length} · chỉ vận đơn gốc ${pairs.filter((p) => left.has(p.origId) && !left.has(p.newId)).length}`);
}

export type PlanRow = { shipmentId: string; day: string; verdict: ReshipVerdict; matchedBy: "VTP" | "TRACKING_ONLY" | null; phoneChecked: boolean };

/** Kế hoạch: mỗi dòng mồ côi từ 15/10 + phán quyết của ĐÚNG luật ghép. Chỉ đọc. */
export async function planReship(db: Db): Promise<PlanRow[]> {
  const s = schema.shipments;
  const orphans = await db
    .select({ id: s.id, code: s.vtpOrderNumber, ref: s.orderReference, phone: s.receiverPhone, createdAt: s.createdAt })
    .from(s)
    .where(and(isNull(s.orderId), sql`${s.carrier} = 'Viettel Post'`, gte(s.createdAt, new Date(`${RESHIP_FROM_DAY}T00:00:00+07:00`))));
  const cands = await reshipCandidates(db, orphans.map((o) => o.ref ?? ""));
  const up = (v: string | null | undefined) => String(v ?? "").trim().toUpperCase();
  return orphans.map((o) => {
    const pool = cands.get(up(o.ref)) ?? [];
    const verdict = reshipParentOf({ orderNumber: o.code ?? "", orderReference: o.ref, receiverPhone: o.phone }, pool);
    const parent = verdict.kind === "ATTEMPT" ? pool.find((c) => c.id === verdict.parentShipmentId) : undefined;
    return {
      shipmentId: o.id,
      day: vnToday(o.createdAt),
      verdict,
      matchedBy: parent ? (up(parent.vtpOrderNumber) === up(o.ref) ? "VTP" : "TRACKING_ONLY") : null,
      // Webhook VTP không gửi RECEIVER_PHONE (đo 22/10, run 39809848044): vế SĐT của luật chỉ kiểm được khi dòng MỚI có SĐT.
      phoneChecked: String(o.phone ?? "").replace(/\D/g, "").length >= 9,
    };
  });
}

/** Dòng tóm tắt của kế hoạch — chỉ số đếm. HÀM THUẦN. */
export function planSummaryLines(plan: readonly PlanRow[]): string[] {
  const count = (f: (r: PlanRow) => boolean) => plan.filter(f).length;
  const att = plan.filter((r) => r.verdict.kind === "ATTEMPT");
  const reasons = new Map<string, number>();
  for (const r of plan) {
    if (r.verdict.kind === "ATTEMPT") continue;
    const k = `${r.verdict.kind}/${r.verdict.reason}`;
    reasons.set(k, (reasons.get(k) ?? 0) + 1);
  }
  const lines = [
    `kế hoạch: ${plan.length} vận đơn mồ côi từ ${RESHIP_FROM_DAY} · gắn được (ATTEMPT) ${att.length} (${new Set(att.map((r) => (r.verdict.kind === "ATTEMPT" ? r.verdict.orderId : ""))).size} đơn) · khớp mã VTP cấp ${count((r) => r.matchedBy === "VTP")} · chỉ khớp mã tra cứu của dòng chưa có mã VTP ${count((r) => r.matchedBy === "TRACKING_ONLY")}`,
    `kế hoạch: giữ lại / không gắn — ${[...reasons].sort().map(([k, n]) => `${k} ${n}`).join(" · ") || "không"}`,
    `kế hoạch: PHONE_MISMATCH ${count((r) => r.verdict.kind === "HOLD" && r.verdict.reason === "PHONE_MISMATCH")} · KHÔNG KIỂM ĐƯỢC ở ${count((r) => !r.phoneChecked)}/${plan.length} dòng (vận đơn mới không có SĐT — webhook VTP không gửi)`,
  ];
  for (const d of [...new Set(plan.map((r) => r.day))].sort()) {
    const ofDay = plan.filter((r) => r.day === d);
    lines.push(`kế hoạch ngày ${d}: mồ côi ${ofDay.length} · gắn được ${ofDay.filter((r) => r.verdict.kind === "ATTEMPT").length} · giữ lại ${ofDay.filter((r) => r.verdict.kind === "HOLD").length}`);
  }
  return lines;
}

/** Ghi kế hoạch qua ĐÚNG đường ghi của ứng dụng. Trả số đếm theo kết quả. */
export async function applyPlan(db: Db, plan: readonly PlanRow[], now: Date): Promise<Record<string, number>> {
  const out: Record<string, number> = { LINKED: 0 };
  for (const r of plan) {
    if (r.verdict.kind !== "ATTEMPT") continue;
    const res = await relinkOrphanShipment(db, { shipmentId: r.shipmentId, verdict: r.verdict, source: RESHIP_SOURCE, reason: RESHIP_REASON, actor: RESHIP_ACTOR, now });
    const k = res.ok ? "LINKED" : res.why;
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

async function main() {
  const parsed = parseBackfillArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(`vtp-reship-backfill: ${parsed.error}. Dùng: (rỗng) | --measure | --apply`);
    process.exit(2);
  }
  const db = await getDb();
  if (!parsed.apply) {
    const [ro] = rowsOf<{ transaction_read_only?: string }>(await db.execute(sql`show transaction_read_only`));
    if (ro?.transaction_read_only !== "on") throw new Error("chạy thử nhưng phiên CSDL không ở chế độ chỉ đọc — dừng");
  }
  const now = new Date();
  tomTat(`vtp-reship-backfill · ${parsed.apply ? "GHI THẬT" : "CHẠY THỬ (thêm --apply để ghi)"} · ${now.toISOString()}`);
  await measureGtc(now, "TRƯỚC");
  await measureCancelsAndStock(db, "TRƯỚC");
  const plan = await planReship(db);
  for (const l of planSummaryLines(plan)) tomTat(l);
  if (!parsed.apply) {
    tomTat("CHẠY THỬ — không ghi gì");
    process.exit(0);
  }
  const res = await applyPlan(db, plan, now);
  tomTat(`đã ghi: ${Object.entries(res).map(([k, n]) => `${k} ${n}`).join(" · ")} · lý do audit «${RESHIP_REASON}»`);
  // Báo cáo đọc qua bộ đệm 60–120 giây — xoá để mốc SAU đo đúng dữ liệu vừa ghi.
  clearMemo();
  await measureGtc(new Date(), "SAU");
  await measureCancelsAndStock(db, "SAU");
  process.exit(0);
}

if (CHAY_THANG) {
  main().catch((error) => {
    console.error("vtp-reship-backfill hỏng:", error instanceof Error ? error.message.slice(0, 300) : error);
    process.exit(1);
  });
}
