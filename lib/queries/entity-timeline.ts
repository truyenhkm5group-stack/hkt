import { desc, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { AUDIT_ACTION_LABEL } from "@/lib/constants/audit";
import { pancakeStatusName } from "@/lib/constants/pancake";
import type { TimelineDimension } from "@/lib/constants/timeline";

/**
 * ───────────── DÒNG THỜI GIAN CỦA MỘT ĐƠN ─────────────
 *
 * Trước đây trang chi tiết đơn chỉ hiện HÀNH TRÌNH VẬN ĐƠN. Khi số liệu của một đơn trông sai, muốn
 * biết vì sao thì phải mở lần lượt: lịch sử trạng thái Pancake, sự kiện Viettel Post, sổ chi tiết
 * bảng kê, phiếu hoàn, nhật ký truy vết — năm nơi, và tự xếp chúng theo thời gian trong đầu.
 *
 * Ở đây tất cả nằm trên MỘT dòng thời gian, mỗi mốc mang theo NGUỒN của nó.
 *
 * VÌ SAO NGUỒN LÀ BẮT BUỘC: "đã giao" do Pancake nói và "đã giao" do Viettel Post nói là hai loại
 * bằng chứng có sức nặng hoàn toàn khác nhau — cái sau quyết định kết quả đơn, cái trước thì không.
 * Một dòng thời gian trộn chúng lại mà không ghi nguồn sẽ khiến người đọc kết luận sai, và đó đúng
 * là loại sai lầm mà cả lớp Data Truth sinh ra để chống.
 */

export type TimelineEntry = {
  id: string;
  at: Date;
  dimension: TimelineDimension;
  /** Nguồn của bằng chứng — Pancake, Viettel Post, bảng kê, người dùng… */
  source: string;
  title: string;
  detail: string;
  /** Số tiền của mốc này, nếu có. */
  amount: number | null;
};

/**
 * Toàn bộ mốc thời gian của một đơn, gộp từ NĂM chiều sự thật riêng biệt.
 * Không chiều nào được suy ra từ chiều nào — đó là luật gốc của ERP này.
 */
export async function getOrderTimeline(orderId: string): Promise<TimelineEntry[]> {
  const db = await getDb();
  const entries: TimelineEntry[] = [];

  const [order] = await db
    .select({ id: schema.orders.id, insertedAt: schema.orders.insertedAt, systemId: schema.orders.systemId, total: schema.orders.totalPriceAfterDiscount })
    .from(schema.orders)
    .where(eq(schema.orders.id, orderId));
  if (!order) return [];

  entries.push({
    id: `order-created-${order.id}`,
    at: order.insertedAt,
    dimension: "ORDER",
    source: "Pancake",
    title: "Đơn được tạo",
    detail: `Đơn #${order.systemId ?? order.id}`,
    amount: Number(order.total ?? 0),
  });

  /*
    NĂM CHIỀU ĐỌC SONG SONG, MỖI CHIỀU MỘT CÂU.

    Trước đây: lịch sử → vận đơn → (mỗi vận đơn: sự kiện, rồi dòng bảng kê) → giao dịch → nhật ký,
    tất cả nối đuôi — 5 + 2×N vòng đi-về cho một trang. Nay vận đơn đọc trước (các chiều khác cần
    danh sách id của nó), rồi bốn chiều còn lại chạy cùng lúc; sự kiện và dòng bảng kê gom theo
    `in (…)` thay vì lặp từng vận đơn.
  */
  const shipments = await db
    .select({ id: schema.shipments.id, code: schema.shipments.vtpOrderNumber, tracking: schema.shipments.trackingCode, createdAt: schema.shipments.createdAt, returnReceivedAt: schema.shipments.returnReceivedAt, returnReceivedBy: schema.shipments.returnReceivedBy })
    .from(schema.shipments)
    .where(eq(schema.shipments.orderId, orderId));
  const shipmentIds = shipments.map((s) => s.id);

  const [history, allEvents, allLines, payments, audits] = await Promise.all([
    db
      .select({ id: schema.orderStatusHistory.id, status: schema.orderStatusHistory.status, old: schema.orderStatusHistory.oldStatus, editor: schema.orderStatusHistory.editorName, at: schema.orderStatusHistory.updatedAt })
      .from(schema.orderStatusHistory)
      .where(eq(schema.orderStatusHistory.orderId, orderId))
      .orderBy(desc(schema.orderStatusHistory.updatedAt))
      .limit(50),
    shipmentIds.length
      ? db
          .select({ id: schema.shipmentEvents.id, shipmentId: schema.shipmentEvents.shipmentId, source: schema.shipmentEvents.source, status: schema.shipmentEvents.status, statusName: schema.shipmentEvents.statusName, location: schema.shipmentEvents.location, note: schema.shipmentEvents.note, legType: schema.shipmentEvents.legType, at: schema.shipmentEvents.occurredAt })
          .from(schema.shipmentEvents)
          .where(inArray(schema.shipmentEvents.shipmentId, shipmentIds))
          .orderBy(desc(schema.shipmentEvents.occurredAt))
          .limit(60 * shipmentIds.length)
      : Promise.resolve([]),
    shipmentIds.length
      ? db
          .select({ id: schema.codStatementLines.id, shipmentId: schema.codStatementLines.shipmentId, cod: schema.codStatementLines.cod, fee: schema.codStatementLines.fee, net: schema.codStatementLines.net, key: schema.codStatementLines.statementKey, at: schema.codStatementLines.createdAt })
          .from(schema.codStatementLines)
          .where(inArray(schema.codStatementLines.shipmentId, shipmentIds))
          .limit(20 * shipmentIds.length)
      : Promise.resolve([]),
    db
      .select({ id: schema.paymentTransactions.id, type: schema.paymentTransactions.transactionType, amount: schema.paymentTransactions.amount, status: schema.paymentTransactions.verificationStatus, source: schema.paymentTransactions.source, at: schema.paymentTransactions.occurredAt, reason: schema.paymentTransactions.reason })
      .from(schema.paymentTransactions)
      .where(eq(schema.paymentTransactions.orderId, orderId))
      .limit(30),
    db
      .select({ id: schema.auditLogs.id, action: schema.auditLogs.action, email: schema.auditLogs.userEmail, at: schema.auditLogs.createdAt, detail: schema.auditLogs.detail })
      .from(schema.auditLogs)
      .where(inArray(schema.auditLogs.entityId, [orderId, ...shipmentIds]))
      .orderBy(desc(schema.auditLogs.createdAt))
      .limit(30),
  ]);

  // ── 1. TRẠNG THÁI ĐƠN (Pancake) — KHÔNG phải bằng chứng giao vận ──
  for (const h of history) {
    entries.push({
      id: `status-${h.id}`,
      at: h.at,
      dimension: "ORDER",
      source: "Pancake",
      title: `Trạng thái → ${pancakeStatusName(h.status)}`,
      detail: `${h.old !== null ? `từ ${pancakeStatusName(h.old)} · ` : ""}${h.editor || "không rõ người đổi"}`,
      amount: null,
    });
  }

  // ── 2. VẬN ĐƠN & SỰ KIỆN ĐVVC — bằng chứng giao vận, có sức nặng cao nhất ──
  for (const s of shipments) {
    entries.push({
      id: `shipment-${s.id}`,
      at: s.createdAt,
      dimension: "SHIPMENT",
      source: "ERP",
      title: `Vận đơn ${s.code || s.tracking || s.id}`,
      detail: "Vận đơn được ghi nhận trong ERP",
      amount: null,
    });
    if (s.returnReceivedAt) {
      // Hàng hoàn CHỈ vào tồn khi kho xác nhận thực nhận — mốc này là ranh giới đó.
      entries.push({
        id: `return-received-${s.id}`,
        at: s.returnReceivedAt,
        dimension: "INVENTORY",
        source: "Kho",
        title: "Kho xác nhận nhận hàng hoàn",
        detail: `${s.returnReceivedBy || "không rõ người nhận"} · từ mốc này hàng mới được cộng lại tồn`,
        amount: null,
      });
    }

    const events = allEvents.filter((e) => e.shipmentId === s.id).slice(0, 60);
    for (const e of events) {
      entries.push({
        id: `event-${e.id}`,
        at: e.at,
        dimension: "SHIPMENT",
        source: e.source,
        // Chiều đi và chiều hoàn phải phân biệt được: "phát thành công" ở chiều hoàn nghĩa là hàng
        // đã về tới shop, tức là đơn HOÀN — ngược hẳn với ý nghĩa ở chiều đi.
        title: `${e.statusName || e.status}${e.legType === "RETURN" ? " (chiều hoàn)" : ""}`,
        detail: [e.location, e.note].filter(Boolean).join(" · ") || `Mã ${e.status}`,
        amount: null,
      });
    }

    // ── 3. TIỀN — chứng từ bảng kê, tách hẳn khỏi giao vận ──
    const lines = allLines.filter((l) => l.shipmentId === s.id).slice(0, 20);
    for (const l of lines) {
      entries.push({
        id: `statement-${l.id}`,
        at: l.at,
        dimension: "MONEY",
        source: `Bảng kê ${l.key}`,
        title: "Dòng chứng từ bảng kê Viettel Post",
        detail: `Thu hộ ${Math.round(Number(l.cod ?? 0)).toLocaleString("vi-VN")}đ · cước ${Math.round(Number(l.fee ?? 0)).toLocaleString("vi-VN")}đ`,
        amount: Number(l.net ?? 0),
      });
    }
  }

  // ── 4. GIAO DỊCH TIỀN đã ghi sổ ──
  for (const p of payments) {
    entries.push({
      id: `payment-${p.id}`,
      at: p.at,
      dimension: "MONEY",
      source: p.source,
      title: `${p.type} · ${p.status}`,
      // Số tiền NULL nghĩa là CHƯA BIẾT, không phải 0 — nói ra thay vì hiện "0đ".
      detail: p.amount === null ? "Chưa xác minh được số tiền" : (p.reason ?? "Đã ghi sổ"),
      amount: p.amount === null ? null : Number(p.amount),
    });
  }

  // ── 5. NGƯỜI DÙNG CAN THIỆP — nhật ký truy vết ──
  for (const a of audits) {
    entries.push({
      id: `audit-${a.id}`,
      at: a.at,
      dimension: "MANUAL",
      source: a.email,
      title: AUDIT_ACTION_LABEL[a.action] ?? a.action,
      detail: typeof a.detail === "object" && a.detail !== null && "reason" in a.detail ? String((a.detail as Record<string, unknown>).reason ?? "") : "Thao tác của người dùng",
      amount: null,
    });
  }

  // Mới nhất lên trước.
  return entries.sort((x, y) => y.at.getTime() - x.at.getTime());
}
