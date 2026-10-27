import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { rowsOf } from "@/lib/sql-rows";
import { legBaseCode } from "@/lib/integrations/viettelpost/statement";
import { VTP_DOCUMENT_SOURCES_SQL } from "@/lib/constants/truth";
import { RETURN_ARRIVAL_MAX_DAYS, RETURN_ARRIVAL_MAX_MS, RETURN_ARRIVAL_SKEW_SECONDS, type ReturnArrival } from "@/lib/constants/return-arrival";

/**
 * ═══════════ VẬN ĐƠN GỐC «HOÀN VỀ SHOP» — MỘT LUẬT, HAI BẢN (TS + SQL) ═══════════
 *
 * Bối cảnh, số đo và hai hằng số: `lib/constants/return-arrival.ts`.
 *
 * Vận đơn gốc là HOÀN VỀ SHOP ⇔ đủ cả ba:
 *  1. chặng hiện tại `DELIVERED`;
 *  2. có chứng từ VTP mã 501 CHIỀU ĐI (`leg_type = 'OUTBOUND'`, nguồn `VTP_DOCUMENT_SOURCES`) — mốc
 *     SỚM NHẤT là «mốc 501 gốc». Không có mốc ⇒ KHÔNG kết luận (không lùi về `delivered_at`, không
 *     lùi về giờ hiện tại);
 *  3. có một dòng CHIỀU HOÀN của chính mã đó — `order_reference` = mã gốc (đúng vế `HAS_RETURN_LEG`
 *     của `ORDER_OUTCOME`) VÀ mã có dạng chiều hoàn `legBaseCode(mã) = mã gốc` (regex lười giữ nguyên)
 *     — đứng ở chặng `DELIVERED` HOẶC `RETURNED`, mốc giao về nằm trong
 *     [mốc 501 gốc − RETURN_ARRIVAL_SKEW_SECONDS, mốc 501 gốc + RETURN_ARRIVAL_MAX_DAYS] (hai đầu
 *     đều tính). MỐC GIAO VỀ CHỌN THEO CHẶNG của dòng chiều hoàn:
 *       · `DELIVERED` (VTP gửi 501 trên kiện chiều hoàn KHÔNG mang cờ IS_RETURNING — ca đo 25/10)
 *         ⇒ `delivered_at`, thiếu thì `vtp_status_date`;
 *       · `RETURNED` (VTP gửi 501 trên kiện chiều hoàn CÓ cờ IS_RETURNING — ERP dịch thành
 *         «hàng về shop», xem tests/vtp-source-of-truth.test.ts mục 9) ⇒ `returned_at`, thiếu thì
 *         `vtp_status_date`.
 *     `RETURNING` (chiều hoàn còn trên đường) KHÔNG được nhận: hàng chưa về tới shop.
 *     Lead chốt 27/10/2026 nhận cả hai chặng — cùng một sự việc «kiện chiều hoàn đã phát về shop»,
 *     chỉ khác cờ VTP gửi kèm.
 *
 * Vế «mã có dạng chiều hoàn» chặn vận đơn GỬI LẠI tạo trên web VTP: chúng cũng mang
 * `order_reference` = mã gốc (22/10/2026) nhưng là một kiện đi tới khách, không phải kiện về shop.
 *
 * Nhiều kiện chiều hoàn cùng khớp ⇒ lấy kiện giao về SỚM NHẤT (hoà thì mã nhỏ hơn theo byte).
 *
 * KHÔNG ghi gì, KHÔNG đổi kết quả đơn: đây là nhãn của chiều LOGISTICS, đọc ra lúc xem.
 * `tests/shipment-return-arrival.test.ts` chạy cả hai bản trên cùng dữ liệu và so từng vận đơn.
 */

export type ReturnLegCandidate = {
  id: string;
  vtpOrderNumber: string | null;
  orderReference: string | null;
  stage: string | null;
  deliveredAt: Date | null;
  returnedAt: Date | null;
  vtpStatusDate: Date | null;
};

/** Chặng của dòng chiều hoàn được coi là «đã phát về shop». */
export const RETURN_LEG_ARRIVED_STAGES = ["DELIVERED", "RETURNED"] as const;

/** Mốc giao về của dòng chiều hoàn — chọn cột theo chặng (xem chú thích đầu tệp). HÀM THUẦN. */
export function returnLegArrivedAt(leg: Pick<ReturnLegCandidate, "stage" | "deliveredAt" | "returnedAt" | "vtpStatusDate">): Date | null {
  if (leg.stage === "DELIVERED") return leg.deliveredAt ?? leg.vtpStatusDate;
  if (leg.stage === "RETURNED") return leg.returnedAt ?? leg.vtpStatusDate;
  return null;
}

export type ReturnArrivalInput = {
  id: string;
  stage: string | null;
  vtpOrderNumber: string | null;
  /** Mốc 501 chiều đi SỚM NHẤT của chính vận đơn này (chứng từ VTP); `null` khi không có. */
  outbound501At: Date | null;
  /** Các dòng vận đơn khác có thể là chiều hoàn — hàm tự lọc, truyền thừa không sao. */
  legs: readonly ReturnLegCandidate[];
};

/** Mã `legCode` là vận đơn chiều hoàn của `baseCode` theo ĐÚNG `legBaseCode` (không viết regex thứ hai). HÀM THUẦN. */
export function isReturnLegCodeOf(legCode: string | null, baseCode: string | null): boolean {
  const base = (baseCode ?? "").trim().toUpperCase();
  return base !== "" && legBaseCode(legCode ?? "") === base;
}

/** Bản TypeScript của luật. HÀM THUẦN — không đọc CSDL, chạy hai lần ra cùng kết quả. */
export function detectReturnArrival(input: ReturnArrivalInput): ReturnArrival | null {
  if (input.stage !== "DELIVERED" || !input.outbound501At || !input.vtpOrderNumber) return null;
  const anchor = input.outbound501At.getTime();
  const lo = anchor - RETURN_ARRIVAL_SKEW_SECONDS * 1000;
  const hi = anchor + RETURN_ARRIVAL_MAX_MS;
  let best: { code: string; at: Date } | null = null;
  for (const leg of input.legs) {
    if (leg.id === input.id || leg.orderReference !== input.vtpOrderNumber) continue;
    if (!(RETURN_LEG_ARRIVED_STAGES as readonly (string | null)[]).includes(leg.stage)) continue;
    if (!leg.vtpOrderNumber || !isReturnLegCodeOf(leg.vtpOrderNumber, input.vtpOrderNumber)) continue;
    const at = returnLegArrivedAt(leg);
    if (!at || at.getTime() < lo || at.getTime() > hi) continue;
    if (!best || at.getTime() < best.at.getTime() || (at.getTime() === best.at.getTime() && leg.vtpOrderNumber < best.code)) best = { code: leg.vtpOrderNumber, at };
  }
  return best ? { outbound501At: input.outbound501At, legCode: best.code, legDeliveredAt: best.at } : null;
}

/*
  ─── BẢN SQL ───

  Vế dạng mã là phép dịch CHÍNH XÁC của `legBaseCode(code) = B` (B = upper(trim(mã gốc)), n = độ dài B):
  regex lười `^([A-Z0-9]{8,}?)[0-9]?P[0-9]+$` lấy tiền tố NGẮN NHẤT (≥ 8) mà phần còn lại khớp
  `[0-9]?P[0-9]+`. Nên kết quả bằng B ⇔ B toàn chữ-số dài ≥ 8 · mã bắt đầu bằng B · phần còn lại khớp
  `[0-9]?P[0-9]+` · và KHÔNG có tiền tố ngắn hơn khớp — điều chỉ xảy ra khi n ≥ 9, B tận cùng bằng
  một chữ số và phần còn lại bắt đầu ngay bằng P (khi ấy `legBaseCode` cắt chữ số cuối của B làm
  `[0-9]?`: «PKE1535736615P1» ra gốc PKE153573661, không phải PKE1535736615). Bài kiểm so hai bản
  trên một loạt mã biên.
*/
function legShapeSql(code: string, base: string): string {
  const baseUp = `upper(btrim(${base}))`;
  const codeUp = `upper(btrim(${code}))`;
  const rest = `substr(${codeUp}, length(${baseUp}) + 1)`;
  return `(${baseUp} ~ '^[A-Z0-9]{8,}$' and left(${codeUp}, length(${baseUp})) = ${baseUp} and ${rest} ~ '^[0-9]?P[0-9]+$' and not (length(${baseUp}) >= 9 and ${baseUp} ~ '[0-9]$' and ${rest} ~ '^P'))`;
}

/** Mốc 501 chiều đi sớm nhất của vận đơn bí danh `alias` (một cột `at`). */
function outbound501Sql(alias: string): string {
  return `select min(ra_e.occurred_at) as at from shipment_events ra_e
    where ra_e.shipment_id = ${alias}.id and ra_e.source in (${VTP_DOCUMENT_SOURCES_SQL}) and ra_e.status = '501' and ra_e.leg_type = 'OUTBOUND'`;
}

/** Kiện chiều hoàn khớp luật của vận đơn bí danh `alias`, mốc 501 gốc ở `anchor` (giao về sớm nhất trước). */
function arrivedReturnLegSql(alias: string, anchor: string): string {
  // Mốc giao về theo chặng — bản SQL của `returnLegArrivedAt`.
  const legAt = `(case when ra_l.stage = 'RETURNED' then coalesce(ra_l.returned_at, ra_l.vtp_status_date) else coalesce(ra_l.delivered_at, ra_l.vtp_status_date) end)`;
  const stages = RETURN_LEG_ARRIVED_STAGES.map((st) => `'${st}'`).join(", ");
  return `select ra_l.vtp_order_number as code, ${legAt} as at from shipments ra_l
    where ra_l.order_reference = ${alias}.vtp_order_number and ra_l.id <> ${alias}.id and ra_l.stage in (${stages})
      and ra_l.vtp_order_number is not null and ${legShapeSql("ra_l.vtp_order_number", `${alias}.vtp_order_number`)}
      and ${legAt} >= ${anchor} - interval '${RETURN_ARRIVAL_SKEW_SECONDS} seconds'
      and ${legAt} <= ${anchor} + interval '${RETURN_ARRIVAL_MAX_DAYS} days'
    order by ${legAt} asc, ra_l.vtp_order_number collate "C" asc
    limit 1`;
}

type Row = { id: string; anchor_ms: number | string; leg_code: string; leg_ms: number | string };

/**
 * Bản SQL của luật, cho một tập vận đơn. Trả về CHỈ những vận đơn khớp (Map rỗng khi không có). Một
 * câu cho cả trang: mỗi vận đơn `DELIVERED` tra sự kiện theo `shipment_id` và chiều hoàn theo
 * `order_reference` — cả hai có chỉ mục.
 */
export async function returnArrivalsOf(ids: readonly string[]): Promise<Map<string, ReturnArrival>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return new Map();
  const db = await getDb();
  const idList = sql.join(unique.map((id) => sql`${id}`), sql`, `);
  const res = await db.execute(sql`
    select s.id, (extract(epoch from a.at) * 1000)::float8 as anchor_ms, l.code as leg_code, (extract(epoch from l.at) * 1000)::float8 as leg_ms
    from shipments s
    cross join lateral (${sql.raw(outbound501Sql("s"))}) a
    join lateral (${sql.raw(arrivedReturnLegSql("s", "a.at"))}) l on true
    where s.id in (${idList}) and s.stage = 'DELIVERED' and s.vtp_order_number is not null and a.at is not null`);
  const out = new Map<string, ReturnArrival>();
  for (const r of rowsOf<Row>(res)) {
    out.set(r.id, { outbound501At: new Date(Number(r.anchor_ms)), legCode: r.leg_code, legDeliveredAt: new Date(Number(r.leg_ms)) });
  }
  return out;
}

/** Một vận đơn. `null` = không khớp luật (kể cả khi thiếu căn cứ). */
export async function returnArrivalOf(id: string): Promise<ReturnArrival | null> {
  return (await returnArrivalsOf([id])).get(id) ?? null;
}

/** Chỉ để bài kiểm so bản SQL của vế dạng mã với `legBaseCode` trên từng cặp mã. */
export function legShapeSqlForTest(code: string, base: string): string {
  return legShapeSql(code, base);
}
