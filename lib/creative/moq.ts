import { and, asc, eq, inArray, isNotNull, isNull, ne, notInArray, or, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { DESIGN_MOQ, designMoqReached, parseDesignMoqSnapshot, type DesignMoqSnapshot } from "@/lib/constants/creative-loop";
import { vnDay } from "@/lib/constants/marketing-decision-ledger";
import { cellKey, sizeRank } from "@/lib/constants/production";
import type { CreativeNotice } from "@/lib/creative/notify";
import { designMoqCounts, type DesignMoqCount } from "@/lib/queries/creative-moq";

/**
 * ═══════════ MOQ — THIẾT KẾ ĐỦ ĐƠN ⇒ NHÁP LỆNH SẢN XUẤT (docs/creative-loop.md §5h) ═══════════
 *
 * Chủ shop chốt 24/09/2026: thiết kế mới gom đủ `DESIGN_MOQ.minOrders` (50) ĐƠN đã xác nhận thì máy dựng
 * MỘT nháp `production_orders` (trạng thái `DRAFT` — đúng trạng thái nháp của trang Kế hoạch đặt hàng) và
 * gửi MỘT tin báo.
 *
 * ─── MÁY KHÔNG LÀM GÌ HƠN THẾ ───
 *
 *  · KHÔNG gửi xưởng: `DRAFT → SENT` chỉ đi qua `setProductionStatus` (người bấm, quyền `planning:write`).
 *  · KHÔNG đặt `design_concepts.status = 'PRODUCTION'` — nút "Đưa vào sản xuất" là của người.
 *  · KHÔNG đoán: màu / size chưa rõ nằm ở `note`, giá gia công `NULL` (chưa biết — mục 42), xưởng trống.
 *
 * ─── LŨY ĐẲNG: MỘT THIẾT KẾ, MỘT NHÁP, MÃI MÃI ───
 *
 * Khoá là `design_concepts.moq_reached_at`: máy chỉ xét thiết kế còn trống mốc này, và ghi mốc CÙNG giao
 * dịch với nháp (cập nhật có điều kiện `moq_reached_at IS NULL`; không trúng dòng ⇒ huỷ cả giao dịch). Người
 * xoá nháp thì `production_order_id` về `NULL` nhưng mốc vẫn còn ⇒ máy không dựng lại — xoá nháp là một
 * quyết định, không phải một chỗ trống để lấp. Mã nháp `PO-<mã TK>` còn là khoá duy nhất thứ hai ở CSDL.
 *
 * Người đã lập sẵn lệnh cho đúng mã TK (trang Kế hoạch đặt hàng) ⇒ máy NỐI vào lệnh ấy, không dựng thêm.
 */

/** Tên đứng ở `production_orders.created_by` của nháp máy dựng (cột chữ; không phải một tài khoản). */
export const MOQ_DRAFT_CREATED_BY = "Máy · vòng mẫu (MOQ)";

/** Mã lệnh của nháp — suy thẳng từ mã thiết kế nên cũng là khoá duy nhất (`production_orders.code`). */
export function moqDraftCode(designCode: string): string {
  return `PO-${designCode}`;
}

export type MoqDraftValues = {
  code: string;
  productId: string | null;
  productCode: string;
  productName: string;
  colors: string[];
  sizes: string[];
  cells: Record<string, number>;
  totalQty: number;
  note: string;
};

/** Căn cứ lúc dựng — hàm thuần. */
export function moqSnapshotOf(count: DesignMoqCount, at: Date, linkedExisting: boolean, minOrders: number = DESIGN_MOQ.minOrders): DesignMoqSnapshot {
  return {
    minOrders,
    orders: count.orders,
    viaCode: count.viaCode,
    viaAd: count.viaAd,
    viaAdDirect: count.viaAdDirect,
    viaAdPost: count.viaAdPost,
    both: count.both,
    adOnly: count.adOnly,
    qtyKnown: count.qtyKnown,
    qtyNoVariant: count.qtyNoVariant,
    pancakeProduct: count.productIds.length > 0,
    linkedExisting,
    countedAt: at.toISOString(),
  };
}

/**
 * Câu "x đơn = a qua mã TK + b chỉ qua quảng cáo (c trùng)" — dùng chung cho ghi chú nháp và tin báo.
 *
 * Căn cứ của đường quảng cáo LUÔN được nói ra (B2): bao nhiêu đơn mang `ad_id`, bao nhiêu nối qua bài viết
 * của đúng một mẩu — người nhận tin biết con số MOQ đứng trên bằng chứng nào trước khi bấm gửi xưởng. Ảnh
 * chụp cũ chưa tách (`viaAdDirect = null`) ⇒ giữ nguyên câu cũ "(ad_id)", vì hồi ấy chỉ đếm `ad_id` thật.
 */
export function moqCountSentence(
  s: Pick<DesignMoqSnapshot, "orders" | "viaCode" | "adOnly" | "both" | "minOrders"> & Partial<Pick<DesignMoqSnapshot, "viaAd" | "viaAdDirect" | "viaAdPost">>,
): string {
  const split = s.viaAdDirect != null && s.viaAdPost != null;
  const adBasis = split
    ? (s.viaAd ?? 0) > 0
      ? ` (đường quảng cáo ${s.viaAd} đơn: ${s.viaAdDirect} mang ad_id · ${s.viaAdPost} qua bài viết của đúng một mẩu)`
      : ""
    : " (ad_id)";
  return `${s.orders}/${s.minOrders} đơn đã xác nhận = ${s.viaCode} qua sản phẩm mã TK + ${s.adOnly} chỉ qua quảng cáo${adBasis}${s.both ? ` — ${s.both} đơn thấy ở cả hai đường, tính một lần` : ""}`;
}

/**
 * Giá trị của nháp lệnh sản xuất — hàm THUẦN. `total_qty` = tổng số lượng dòng mã TK (bỏ quà); ma trận chỉ
 * chứa ô biết đủ màu + size; phần chưa biết và đơn chỉ-qua-quảng-cáo được KỂ RA ở `note`, không chia hộ.
 */
export function buildMoqDraft(design: { code: string }, count: DesignMoqCount, at: Date, minOrders: number = DESIGN_MOQ.minOrders): MoqDraftValues {
  const byColor = new Map<string, number>();
  const sizeSet = new Set<string>();
  const cells: Record<string, number> = {};
  for (const l of count.lines) {
    if (!(l.qty > 0)) continue;
    byColor.set(l.color, (byColor.get(l.color) ?? 0) + l.qty);
    sizeSet.add(l.size);
    cells[cellKey(l.color, l.size)] = (cells[cellKey(l.color, l.size)] ?? 0) + l.qty;
  }
  // Màu bán nhiều đứng trước; size theo thứ tự size của trang đặt hàng. Tất định (hoà thì theo tên).
  const colors = [...byColor.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([c]) => c);
  const sizes = [...sizeSet].sort((a, b) => sizeRank(a) - sizeRank(b) || a.localeCompare(b));
  const snap = moqSnapshotOf(count, at, false, minOrders);
  const vnAt = new Date(at.getTime() + 7 * 3_600_000).toISOString();
  const parts = [
    `Nháp do máy dựng khi thiết kế ${design.code} đủ MOQ (đếm lúc ${vnAt.slice(11, 16)} ${vnAt.slice(8, 10)}/${vnAt.slice(5, 7)}): ${moqCountSentence(snap)}.`,
    `Số lượng = ${count.qtyKnown} sp (tổng dòng hàng mã TK, không tính quà).`,
    count.qtyNoVariant > 0 ? `${count.qtyNoVariant} sp chưa rõ màu hoặc size — KHÔNG đoán, chưa chia vào ma trận.` : "",
    count.adOnly > 0 ? `${count.adOnly} đơn chỉ nối qua quảng cáo, không có dòng hàng mã TK — số lượng CHƯA BIẾT, chưa cộng.` : "",
    count.productIds.length === 0 ? `Chưa có sản phẩm Pancake mã ${design.code} — màu, size, số lượng đều CHƯA BIẾT.` : "",
    "Giá gia công và xưởng chưa có căn cứ — để trống. Máy KHÔNG gửi xưởng: người kiểm rồi bấm gửi.",
  ].filter(Boolean);
  return {
    code: moqDraftCode(design.code),
    productId: count.productIds[0] ?? null,
    productCode: design.code,
    productName: count.productName ?? `Thiết kế ${design.code}`,
    colors,
    sizes,
    cells,
    totalQty: count.qtyKnown,
    // `saveProductionOrder` nhận ghi chú tối đa 1.000 ký tự — người sửa nháp không được vấp lỗi độ dài.
    note: parts.join(" ").slice(0, 1000),
  };
}

export type DesignMoqReport = {
  designId: string;
  code: string;
  orders: number;
  productionOrderId: string;
  productionOrderCode: string;
  /** `false` = nối vào lệnh người đã lập sẵn. */
  created: boolean;
};

/**
 * Một lượt MOQ: đếm mọi thiết kế chưa từng đủ MOQ, dựng / nối lệnh cho cái vừa đủ. Lỗi của MỘT thiết kế
 * không chặn thiết kế khác (vào `warnings`).
 */
export async function runDesignMoq(db: Db, now: Date, minOrders: number = DESIGN_MOQ.minOrders): Promise<{ reports: DesignMoqReport[]; warnings: string[] }> {
  const dc = schema.designConcepts;
  const po = schema.productionOrders;
  const warnings: string[] = [];
  const reports: DesignMoqReport[] = [];
  const pending = await db.select({ id: dc.id, code: dc.code }).from(dc).where(isNull(dc.moqReachedAt)).orderBy(asc(dc.code));
  if (pending.length === 0) return { reports, warnings };
  const counts = await designMoqCounts(db, pending);

  for (const d of pending) {
    const count = counts.get(d.id);
    if (!count || !designMoqReached(count.orders, minOrders)) continue;
    try {
      const report = await db.transaction(async (tx) => {
        // Lệnh người đã lập cho ĐÚNG mã này (theo mã hoặc theo sản phẩm Pancake mang mã) và chưa nối thiết kế nào.
        const linked = tx.select({ id: dc.productionOrderId }).from(dc).where(isNotNull(dc.productionOrderId));
        const match = count.productIds.length ? or(sql`upper(trim(${po.productCode})) = ${d.code.toUpperCase()}`, inArray(po.productId, count.productIds)) : sql`upper(trim(${po.productCode})) = ${d.code.toUpperCase()}`;
        const [existing] = await tx
          .select({ id: po.id, code: po.code })
          .from(po)
          .where(and(match, ne(po.status, "CANCELLED"), ne(po.code, moqDraftCode(d.code)), notInArray(po.id, linked)))
          .orderBy(asc(po.createdAt), asc(po.id))
          .limit(1);

        let orderId: string;
        let orderCode: string;
        let created = false;
        if (existing) {
          orderId = existing.id;
          orderCode = existing.code;
        } else {
          const v = buildMoqDraft(d, count, now, minOrders);
          const [ins] = await tx
            .insert(po)
            .values({ ...v, status: "DRAFT", images: [], unitCost: null, supplier: "", dueDate: null, createdBy: MOQ_DRAFT_CREATED_BY })
            .onConflictDoNothing({ target: po.code })
            .returning({ id: po.id, code: po.code });
          if (ins) {
            orderId = ins.id;
            orderCode = ins.code;
            created = true;
          } else {
            // Mã `PO-<TK>` đã có (lượt trước chết sau khi ghi lệnh?) ⇒ nối vào đúng dòng ấy, không dựng dòng thứ hai.
            const [same] = await tx.select({ id: po.id, code: po.code }).from(po).where(eq(po.code, v.code)).limit(1);
            if (!same) throw new Error(`không ghi được nháp ${v.code}`);
            orderId = same.id;
            orderCode = same.code;
          }
        }
        const done = await tx
          .update(dc)
          .set({ productionOrderId: orderId, moqReachedAt: now, moqSnapshot: moqSnapshotOf(count, now, !created && Boolean(existing), minOrders), updatedAt: now })
          .where(and(eq(dc.id, d.id), isNull(dc.moqReachedAt)))
          .returning({ id: dc.id });
        if (done.length === 0) throw new Error("thiết kế đã được xét MOQ ở lượt khác");
        return { designId: d.id, code: d.code, orders: count.orders, productionOrderId: orderId, productionOrderCode: orderCode, created };
      });
      reports.push(report);
    } catch (e) {
      warnings.push(`MOQ ${d.code}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { reports, warnings };
}

/** Thiết kế đã đủ MOQ mà tin báo chưa gửi được — kèm lệnh đang nối (có thể đã bị người xoá). */
export async function unnotifiedMoq(db: Db): Promise<{ id: string; code: string; reachedAt: Date; snapshot: DesignMoqSnapshot | null; orderCode: string | null; orderStatus: string | null }[]> {
  const dc = schema.designConcepts;
  const po = schema.productionOrders;
  const rows = await db
    .select({ id: dc.id, code: dc.code, reachedAt: dc.moqReachedAt, snapshot: dc.moqSnapshot, orderCode: po.code, orderStatus: po.status })
    .from(dc)
    .leftJoin(po, eq(po.id, dc.productionOrderId))
    .where(and(isNotNull(dc.moqReachedAt), isNull(dc.moqNotifiedAt)))
    .orderBy(asc(dc.code));
  return rows.map((r) => ({ id: r.id, code: r.code, reachedAt: r.reachedAt as Date, snapshot: parseDesignMoqSnapshot(r.snapshot), orderCode: r.orderCode ?? null, orderStatus: r.orderStatus ?? null }));
}

export async function markMoqNotified(db: Db, ids: string[], now: Date): Promise<void> {
  if (ids.length === 0) return;
  await db.update(schema.designConcepts).set({ moqNotifiedAt: now }).where(inArray(schema.designConcepts.id, ids));
}

/** Tin báo của MỘT thiết kế — khoá chống lặp theo mã thiết kế (bắt đầu bằng ngày đủ MOQ để sổ tự dọn). */
export function moqNotice(d: { code: string; reachedAt: Date; snapshot: DesignMoqSnapshot | null; orderCode: string | null }): CreativeNotice {
  const day = vnDay(d.reachedAt);
  const s = d.snapshot;
  const linked = s?.linkedExisting === true;
  return {
    kind: "MOQ",
    batchDay: day,
    dedupeKey: `${day}:${d.code}`,
    title: linked
      ? `Vòng mẫu: thiết kế ${d.code} đủ ${s?.minOrders ?? DESIGN_MOQ.minOrders} đơn — đã nối lệnh sản xuất có sẵn ${d.orderCode ?? ""}`.trim()
      : `Vòng mẫu: thiết kế ${d.code} đủ ${s?.minOrders ?? DESIGN_MOQ.minOrders} đơn — đã dựng NHÁP lệnh sản xuất ${d.orderCode ?? "(nháp đã bị xoá)"}`,
    lines: [
      s ? `${moqCountSentence(s)}.` : "",
      s ? `Số lượng biết được: ${s.qtyKnown} sp${s.qtyNoVariant ? ` (${s.qtyNoVariant} sp chưa rõ màu/size)` : ""}${s.adOnly ? ` · ${s.adOnly} đơn chỉ qua quảng cáo chưa rõ số lượng` : ""}.` : "",
      "Máy KHÔNG gửi xưởng và không đổi trạng thái thiết kế — người kiểm màu/size, giá gia công, xưởng rồi mới gửi (Kho → Kế hoạch đặt hàng).",
    ].filter(Boolean),
  };
}
