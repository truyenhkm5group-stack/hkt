/**
 * ═══════════ BÁO CÁO HOÀN THEO MÃ HÀNG VÀ LÝ DO ═══════════
 *
 * ─── KHÔNG VIẾT CÔNG THỨC TỶ LỆ HOÀN MỚI ───
 *
 * Tệp này dùng lại NGUYÊN VẸN hợp đồng đang chạy production:
 *
 *   `REPORTABLE_ORDER`  — loại đơn "Mới" chưa xác nhận khỏi mẫu số
 *   `PRIMARY_ATTEMPT`   — mỗi đơn MỘT dòng, đơn gửi lại không đếm hai lần
 *   `outcomeColumn()`   — `ORDER_OUTCOME_FAST`, tức `ORDER_OUTCOME` đã vật chất hoá
 *   kỳ lọc theo `orders.inserted_at` — CÙNG cột mà mọi báo cáo GTC khác dùng
 *
 * Mọi luật loại trừ mà chủ shop nêu đã nằm sẵn trong hợp đồng đó, và báo cáo này thừa hưởng chúng
 * mà không cần khai lại:
 *
 *   · vận đơn chiều về (`…1P1`) có `order_id = NULL` nên `leftJoin` không bao giờ kéo chúng vào
 *     như một đơn riêng — 267 vận đơn chiều về trên production, không cái nào vào mẫu số;
 *   · "Shop hủy lấy" → `CANCELLED`; "Lấy không thành công" → `UNKNOWN`/`NOT_SHIPPED`. Cả ba đều
 *     NẰM NGOÀI cả tử số lẫn mẫu số vì mẫu số chỉ gồm ba kết quả kết thúc;
 *   · "Giao thành công một phần" không tự thành giao thành công — nó đi qua luật doanh thu của
 *     `ORDER_OUTCOME` như mọi đơn khác.
 *
 * Mẫu số = đơn CÓ KẾT QUẢ CUỐI (`DELIVERED` · `RETURNED` · `RETURNED_BY_RULE`), đúng bằng
 * `IS_FINISHED` của `lib/queries/metrics.ts`. Đơn đang giao, đơn huỷ, đơn chưa rõ không nằm ở đâu
 * cả — không ở tử, không ở mẫu.
 *
 * ─── ĐỘ MỊN: ĐƠN, KHÔNG PHẢI DÒNG HÀNG ───
 *
 * Một đơn hai mã hàng mà hoàn thì KHÔNG chứng minh được mã nào gây hoàn. Đơn đó được đếm cho CẢ
 * HAI mã (đúng: cả hai đều bị ảnh hưởng) và được đánh dấu `multiSku` để tổng theo mã cộng lại lớn
 * hơn tổng thật — con số đó phải hiện ra, không được giấu. Trên production: 34/2.382 đơn (1,4%).
 */
import { and, gte, lte, sql, type SQL } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { outcomeColumn, OUTCOME_FENCE, PRIMARY_ATTEMPT, REPORTABLE_ORDER } from "@/lib/queries/return-rate";
import { orderHasProductCode, variantIdsOfCodes } from "@/lib/queries/product-code";
import { reasonsForShipments } from "@/lib/queries/return-reason";
import { RETURN_REASON_LABEL, type ReasonConfidence, type ReturnReason } from "@/lib/constants/return-reason";
import type { Period } from "@/lib/search-params";

const o = schema.orders;
const s = schema.shipments;

export type ReturnReasonRow = { reason: ReturnReason; label: string; count: number; share: number; confidence: Record<ReasonConfidence, number> };

export type ProductReturnRow = {
  code: string;
  name: string;
  finished: number;
  delivered: number;
  returned: number;
  returnRate: number | null;
  successRate: number | null;
  topReason: { reason: ReturnReason; label: string; count: number; share: number } | null;
  multiSku: number;
};

export type ReturnReasonReport = {
  period: Period;
  finished: number;
  delivered: number;
  returned: number;
  returnRate: number | null;
  successRate: number | null;
  reasons: ReturnReasonRow[];
  products: ProductReturnRow[];
  /** Bao nhiêu % vận đơn hoàn xác định được lý do — in ra, không giấu. */
  reasonCoverage: { known: number; unknown: number; pct: number | null };
  /** Đơn nhiều mã hàng: được đếm cho mọi mã, nên tổng theo mã > tổng thật đúng bằng phần này. */
  multiSkuOrders: number;
};

type Filter = { period: Period; codes?: string[]; reasons?: ReturnReason[] };

/** Dòng thô: mỗi ĐƠN một dòng, kèm kết quả chuẩn và vận đơn quyết định. */
async function baseRows(f: Filter) {
  const db = await getDb();
  const conds: SQL[] = [REPORTABLE_ORDER];
  // NGÀY ĐẶT ĐƠN — cùng cột với mọi báo cáo GTC khác. Đổi sang ngày giao ở riêng báo cáo này sẽ
  // tạo ra hai con số "tỷ lệ hoàn" trong cùng một kỳ mà không ai đối chiếu được.
  if (f.period.from) conds.push(gte(o.insertedAt, f.period.from));
  if (f.period.to) conds.push(lte(o.insertedAt, f.period.to));
  if (f.codes?.length) {
    const { variantIds } = await variantIdsOfCodes(f.codes);
    conds.push(orderHasProductCode(sql`${o.id}`, variantIds));
  }

  const base = db
    // Bí danh TƯỜNG MINH: `orders.id` và `shipments.id` cùng tên "id", nên bảng dẫn xuất sẽ có hai
    // cột trùng tên và Postgres từ chối với "column reference id is ambiguous".
    .select({ orderId: sql<string>`${o.id}`.as("rr_order_id"), shipmentId: sql<string | null>`${s.id}`.as("rr_shipment_id"), outcome: outcomeColumn() })
    .from(o)
    .leftJoin(s, and(sql`${s.orderId} = ${o.id}`, PRIMARY_ATTEMPT))
    .where(and(...conds))
    .offset(OUTCOME_FENCE)
    .as("rr_base");

  return db
    .select({ orderId: base.orderId, shipmentId: base.shipmentId, outcome: base.outcome })
    .from(base)
    .where(sql`${base.outcome} in ('DELIVERED','RETURNED','RETURNED_BY_RULE')`);
}

export async function getReturnReasonReport(f: Filter): Promise<ReturnReasonReport> {
  const db = await getDb();
  const rows = await baseRows(f);

  const finished = rows.length;
  const delivered = rows.filter((r) => r.outcome === "DELIVERED").length;
  const hoanRows = rows.filter((r) => r.outcome !== "DELIVERED");
  const returned = hoanRows.length;

  // LÝ DO chỉ hỏi cho vận đơn HOÀN, và chỉ cho những dòng có vận đơn thật.
  const hoanShipmentIds = hoanRows.map((r) => r.shipmentId).filter((x): x is string => Boolean(x));
  const verdicts = await reasonsForShipments(hoanShipmentIds);

  const demLyDo = new Map<ReturnReason, { count: number; confidence: Record<ReasonConfidence, number> }>();
  const bump = (reason: ReturnReason, conf: ReasonConfidence) => {
    const cur = demLyDo.get(reason) ?? { count: 0, confidence: { CONFIRMED: 0, CARRIER_CODE: 0, CARRIER_TEXT: 0, NONE: 0 } };
    cur.count += 1;
    cur.confidence[conf] += 1;
    demLyDo.set(reason, cur);
  };
  const lyDoTheoVanDon = new Map<string, ReturnReason>();
  for (const r of hoanRows) {
    const v = r.shipmentId ? verdicts.get(r.shipmentId) : undefined;
    const reason = v?.reason ?? "UNKNOWN";
    // Đơn hoàn mà KHÔNG có vận đơn nào: kết luận đến từ luật doanh thu, ĐVVC không nêu lý do.
    bump(reason, v?.confidence ?? "NONE");
    if (r.shipmentId) lyDoTheoVanDon.set(r.shipmentId, reason);
  }

  const reasons: ReturnReasonRow[] = [...demLyDo.entries()]
    .map(([reason, v]) => ({ reason, label: RETURN_REASON_LABEL[reason], count: v.count, share: returned ? Math.round((v.count / returned) * 1000) / 10 : 0, confidence: v.confidence }))
    .sort((a, b) => b.count - a.count);

  const biet = returned - (demLyDo.get("UNKNOWN")?.count ?? 0);

  /* ═══ THEO MÃ HÀNG ═══ */
  const orderIds = rows.map((r) => r.orderId);
  const theoMa = new Map<string, { name: string; finished: number; delivered: number; returned: number; reasons: Map<ReturnReason, number> }>();
  let multiSkuOrders = 0;

  if (orderIds.length) {
    const maRows = await db
      .select({ orderId: schema.orderItems.orderId, code: schema.products.customId, name: schema.products.name })
      .from(schema.orderItems)
      .innerJoin(schema.productVariants, sql`${schema.productVariants.id} = ${schema.orderItems.variantId}`)
      .innerJoin(schema.products, sql`${schema.products.id} = ${schema.productVariants.productId} and coalesce(${schema.products.customId}, '') <> ''`)
      .where(sql`${schema.orderItems.orderId} in ${orderIds} and ${schema.orderItems.isBonus} = false`);

    const maCuaDon = new Map<string, Map<string, string>>();
    for (const m of maRows) {
      const cur = maCuaDon.get(m.orderId) ?? new Map<string, string>();
      cur.set(m.code as string, m.name);
      maCuaDon.set(m.orderId, cur);
    }

    for (const r of rows) {
      const ma = maCuaDon.get(r.orderId);
      if (!ma || ma.size === 0) continue;
      if (ma.size > 1) multiSkuOrders += 1;
      const reason = r.shipmentId ? lyDoTheoVanDon.get(r.shipmentId) : undefined;
      for (const [code, name] of ma) {
        const cur = theoMa.get(code) ?? { name, finished: 0, delivered: 0, returned: 0, reasons: new Map<ReturnReason, number>() };
        cur.finished += 1;
        if (r.outcome === "DELIVERED") cur.delivered += 1;
        else {
          cur.returned += 1;
          /*
            ĐƠN NHIỀU MÃ HÀNG: KHÔNG gán lý do riêng cho từng mã.

            Không có gì trong dữ liệu nói mã nào gây hoàn. Nếu đơn chỉ có một mã thì lý do thuộc về
            mã đó; nhiều mã thì lý do là của CẢ ĐƠN và được đánh dấu như vậy, chứ không chia đều
            hay gán cho mã đắt nhất.
          */
          const key: ReturnReason = ma.size > 1 ? "OTHER" : (reason ?? "UNKNOWN");
          cur.reasons.set(key, (cur.reasons.get(key) ?? 0) + 1);
        }
        theoMa.set(code, cur);
      }
    }
  }

  const products: ProductReturnRow[] = [...theoMa.entries()]
    .map(([code, v]) => {
      const top = [...v.reasons.entries()].sort((a, b) => b[1] - a[1])[0];
      return {
        code,
        name: v.name,
        finished: v.finished,
        delivered: v.delivered,
        returned: v.returned,
        returnRate: v.finished ? Math.round((v.returned / v.finished) * 1000) / 10 : null,
        successRate: v.finished ? Math.round((v.delivered / v.finished) * 1000) / 10 : null,
        topReason: top ? { reason: top[0], label: RETURN_REASON_LABEL[top[0]], count: top[1], share: v.returned ? Math.round((top[1] / v.returned) * 1000) / 10 : 0 } : null,
        multiSku: 0,
      };
    })
    .sort((a, b) => b.returned - a.returned);

  const locLyDo = f.reasons?.length ? new Set(f.reasons) : null;

  return {
    period: f.period,
    finished,
    delivered,
    returned,
    returnRate: finished ? Math.round((returned / finished) * 1000) / 10 : null,
    successRate: finished ? Math.round((delivered / finished) * 1000) / 10 : null,
    reasons: locLyDo ? reasons.filter((r) => locLyDo.has(r.reason)) : reasons,
    products,
    reasonCoverage: { known: biet, unknown: returned - biet, pct: returned ? Math.round((biet / returned) * 1000) / 10 : null },
    multiSkuOrders,
  };
}
