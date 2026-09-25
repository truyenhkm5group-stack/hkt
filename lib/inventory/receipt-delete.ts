import { and, eq, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { audit } from "@/lib/audit";
import type { Actor } from "@/lib/constants/actor";
import type { ApprovalDecision, ApprovalGroup } from "@/lib/constants/approval";
import { RECEIPT_DELETE_REASON_MIN, type StockReceiptKind } from "@/lib/validation/stock";

/**
 * ═══════════ XOÁ PHIẾU KHO — LÕI DỊCH VỤ (Company OS · Agent D) ═══════════
 *
 * Tệp này KHÔNG "use server": server action `deleteStockReceipt` gọi nó sau `requireUser` / `can`,
 * và kiểm thử gọi thẳng với một cổng duyệt giả lập ĐÚNG luật của cổng thật.
 *
 * Ba lỗ hổng mà đường xoá cũ để hở (đo trên mã nguồn origin/main bb6b860d):
 *
 *  1. XOÁ PHIẾU `RETURN` LÀM MỒ CÔI PHIẾU KIỂM HOÀN. `return_inspections.stock_receipt_id` là
 *     ON DELETE SET NULL, nên xoá phiếu tái nhập thì tồn biến mất còn phiếu kiểm vẫn ĐÃ ĐẾM và vận
 *     đơn vẫn mang `return_received_at` — hàng đợi nói "đã về kho" trong khi sổ kho nói "không có".
 *     Nay CHẶN. ERP không có đường gỡ một kiện ĐÃ ĐẾM (`undoReturnArrived` chỉ gỡ kiện CHƯA đếm —
 *     lib/returns/inspection.ts), và chủ đích đó là cố ý: sửa số đã đếm phải bằng phiếu Điều chỉnh
 *     kiểm kê có người ký, không bằng cách xoá ngược lịch sử. Thông điệp nói đúng điều ấy.
 *  2. XOÁ KHÔNG QUA DUYỆT HAI BƯỚC trong khi TẠO phiếu điều chỉnh / xuất tay thì phải qua. Xoá một
 *     phiếu nhập là ghi giảm hàng; xoá một phiếu xuất tay là tạo lại hàng không chứng từ — cùng rủi
 *     ro với hai nhóm đã có, nên đi ĐÚNG hai nhóm ấy (không đẻ nhóm mới).
 *  3. NHẬT KÝ CHỈ GHI SỐ DÒNG, không ghi phiếu. Nay ghi ẢNH CHỤP ĐẦY ĐỦ (đầu phiếu + từng dòng)
 *     TRƯỚC khi xoá, kèm LÝ DO bắt buộc — xoá cứng thì nhật ký là thứ duy nhất còn lại.
 *
 * Vẫn XOÁ CỨNG (giữ nguyên hành vi màn hình). Chuyển sang bút toán đảo là đổi cách người kho làm
 * việc — đề xuất nằm ở docs/company-os/handoff-d.md, không làm ở đây.
 */

/**
 * Xoá một phiếu thì đi nhóm duyệt nào — theo HƯỚNG tác động lên tồn khi xoá:
 *  · xoá phiếu làm TỒN GIẢM (nhập mới, tái nhập hoàn) = ghi giảm hàng ⇒ `INVENTORY_WRITE_OFF`
 *    (cùng ngưỡng tiền với phiếu xuất tay);
 *  · xoá phiếu làm TỒN TĂNG hoặc đảo một lời khai tay (xuất tay, điều chỉnh) ⇒ `INVENTORY_ADJUSTMENT`
 *    (nhóm không ngưỡng: một dòng có thể tạo ra hàng không tồn tại).
 */
export const RECEIPT_DELETE_GROUP: Record<StockReceiptKind, ApprovalGroup> = {
  RECEIPT: "INVENTORY_WRITE_OFF",
  RETURN: "INVENTORY_WRITE_OFF",
  ISSUE: "INVENTORY_ADJUSTMENT",
  ADJUSTMENT: "INVENTORY_ADJUSTMENT",
};

/** Đầu vào của cổng duyệt — cùng hình với `GuardInput` của lib/actions/approvals.ts. */
export type ReceiptDeleteGateInput = {
  group: ApprovalGroup;
  action: string;
  summary: string;
  entity?: string;
  entityId?: string;
  amount?: number | null;
  payload?: unknown;
};
export type ReceiptDeleteGate = (input: ReceiptDeleteGateInput) => Promise<ApprovalDecision>;

export type ReceiptSnapshot = {
  header: typeof schema.stockReceipts.$inferSelect;
  items: (typeof schema.stockReceiptItems.$inferSelect)[];
};

export type ReceiptDeleteBlocker = {
  inspections: { id: string; shipmentId: string; code: string | null; status: string }[];
  unidentified: string[];
  /**
   * Company OS · Agent E: dòng sổ kết cục "nhập lại sau sửa" đứng trên phiếu này (`return_dispositions.stock_receipt_id`).
   * Agent R: kể cả dòng neo vào món hàng hoàn KHÔNG NHÃN (không có phiếu kiểm) — `code` là mã `UR-…`.
   */
  reworkRestocks: { id: string; code: string | null; qty: number }[];
};

export type DeleteReceiptResult = { ok: true; snapshot: ReceiptSnapshot } | { error: string; blocker?: ReceiptDeleteBlocker; approval?: ApprovalDecision["mode"] };

/** Phiếu kho này có đang là chứng từ của phiếu kiểm hoàn / món hoàn không nhãn nào không. */
export async function receiptDeleteBlockers(db: Db, receiptId: string): Promise<ReceiptDeleteBlocker> {
  const ins = schema.returnInspections;
  const [inspections, unidentified, reworkRestocks] = await Promise.all([
    db
      .select({ id: ins.id, shipmentId: ins.shipmentId, status: ins.status, code: schema.shipments.vtpOrderNumber })
      .from(ins)
      .leftJoin(schema.shipments, eq(schema.shipments.id, ins.shipmentId))
      .where(eq(ins.stockReceiptId, receiptId)),
    db.select({ id: schema.returnUnidentified.id }).from(schema.returnUnidentified).where(eq(schema.returnUnidentified.stockReceiptId, receiptId)),
    /*
      NỐI NGOÀI, không nối trong (Agent R): dòng sổ của món KHÔNG NHÃN không có phiếu kiểm — nối trong làm
      nó rơi khỏi danh sách chặn, và lượt xoá đi tới cổng duyệt + nhật ký rồi mới bị câu xoá có điều kiện
      chặn lại với một thông điệp sai ("vừa gắn vào phiếu kiểm").
    */
    db
      .select({
        id: schema.returnDispositions.id,
        qty: schema.returnDispositions.qty,
        code: sql<string | null>`coalesce(${schema.returnUnidentified.code}, ${schema.shipments.vtpOrderNumber})`,
      })
      .from(schema.returnDispositions)
      .leftJoin(ins, eq(ins.id, schema.returnDispositions.inspectionId))
      .leftJoin(schema.shipments, eq(schema.shipments.id, ins.shipmentId))
      .leftJoin(schema.returnUnidentified, eq(schema.returnUnidentified.id, schema.returnDispositions.unidentifiedId))
      .where(eq(schema.returnDispositions.stockReceiptId, receiptId)),
  ]);
  return { inspections, unidentified: unidentified.map((u) => u.id), reworkRestocks };
}

function blockerMessage(b: ReceiptDeleteBlocker): string {
  const parts: string[] = [];
  if (b.inspections.length) {
    const codes = b.inspections.slice(0, 5).map((i) => i.code ?? i.shipmentId).join(", ");
    parts.push(`${b.inspections.length} phiếu kiểm hàng hoàn (${codes}${b.inspections.length > 5 ? "…" : ""})`);
  }
  if (b.unidentified.length) parts.push(`${b.unidentified.length} món hoàn không nhãn đã tái nhập`);
  if (b.reworkRestocks.length) {
    const mon = b.reworkRestocks.reduce((t, r) => t + r.qty, 0);
    const codes = [...new Set(b.reworkRestocks.map((r) => r.code).filter(Boolean))].slice(0, 5).join(", ");
    parts.push(`lượt NHẬP LẠI SAU SỬA / GIẶT của ${mon} món hàng hoàn${codes ? ` (${codes})` : ""}`);
  }
  if (!b.inspections.length && !b.unidentified.length) {
    return (
      `Không xoá được: phiếu tái nhập này là chứng từ của ${parts.join(" và ")} (khối "Hàng hoàn không tái nhập"). Xoá nó thì tồn biến mất còn sổ kết cục vẫn ghi "đã sửa xong, đã nhập lại". ` +
      `Sổ kết cục là sổ ghi thêm, không gỡ ngược — muốn sửa số, lập phiếu "Điều chỉnh kiểm kê" (đi qua duyệt hai bước).`
    );
  }
  return (
    `Không xoá được: phiếu tái nhập này là chứng từ của ${parts.join(" và ")}. Xoá nó thì tồn biến mất còn kiện vẫn ghi "đã đếm, đã về kho". ` +
    `ERP KHÔNG có đường gỡ một kiện đã đếm (trạm kiểm hoàn chỉ gỡ được kiện CHƯA đếm) — muốn sửa số, lập phiếu "Điều chỉnh kiểm kê" (đi qua duyệt hai bước).`
  );
}

/**
 * Xoá một phiếu kho: chặn phiếu đang làm chứng từ → cổng duyệt hai bước → nhật ký ảnh chụp đầy đủ
 * TRƯỚC khi xoá → xoá có điều kiện (không xoá nếu vừa có phiếu kiểm gắn vào giữa chừng).
 */
export async function deleteStockReceiptCore(
  db: Db,
  input: { id: string; reason: string; actor: Actor; actorEmail: string; gate: ReceiptDeleteGate },
): Promise<DeleteReceiptResult> {
  const reason = input.reason.trim();
  if (reason.length < RECEIPT_DELETE_REASON_MIN) return { error: `Nêu lý do xoá phiếu (ít nhất ${RECEIPT_DELETE_REASON_MIN} ký tự) — xoá cứng thì nhật ký là thứ duy nhất còn lại` };
  if (!input.id) return { error: "Thiếu mã phiếu" };

  const header = await db.query.stockReceipts.findFirst({ where: eq(schema.stockReceipts.id, input.id) });
  if (!header) return { error: "Không tìm thấy phiếu" };
  const items = await db.select().from(schema.stockReceiptItems).where(eq(schema.stockReceiptItems.receiptId, input.id));

  const blocker = await receiptDeleteBlockers(db, input.id);
  // Chặn TRƯỚC cổng duyệt và TRƯỚC nhật ký: lượt xoá không thể xảy ra thì không để lại dòng nào.
  if (blocker.inspections.length || blocker.unidentified.length || blocker.reworkRestocks.length) return { error: blockerMessage(blocker), blocker };

  const kind = (header.kind in RECEIPT_DELETE_GROUP ? header.kind : "ADJUSTMENT") as StockReceiptKind;
  const group = RECEIPT_DELETE_GROUP[kind];
  const cong = await input.gate({
    group,
    action: "stock.receipt_delete",
    entity: "STOCK_RECEIPT",
    entityId: header.id,
    summary: `Xoá phiếu ${kind} ngày ${header.receivedAt.toISOString().slice(0, 10)} · ${items.length} dòng · ${header.totalQuantity} món${header.reference ? ` · ${header.reference}` : ""} — ${reason}`,
    // Cùng cách tính với lúc TẠO phiếu: 0đ ⇒ CHƯA BIẾT ⇒ coi như vượt ngưỡng.
    amount: Math.abs(header.totalCost) || null,
    payload: { receiptId: header.id, reason },
  });
  if (cong.mode === "NEEDS_APPROVAL") return { error: `Xoá phiếu này cần người thứ hai duyệt (${cong.reason}). Đã gửi yêu cầu — xem ở trang Cảnh báo.`, approval: cong.mode };
  if (cong.mode === "BLOCKED_NO_APPROVER") return { error: `Xoá phiếu này cần người thứ hai duyệt (${cong.reason}), nhưng hệ thống chưa có ai khác đủ tư cách duyệt. Thêm một tài khoản ADMIN hoặc MANAGER trước.`, approval: cong.mode };

  const snapshot: ReceiptSnapshot = { header, items };
  // NHẬT KÝ TRƯỚC KHI XOÁ: xoá cứng rồi thì không còn gì để chụp.
  await audit({
    userId: input.actor.id,
    userEmail: input.actorEmail,
    action: "STOCK_RECEIPT_DELETE",
    entity: "STOCK_RECEIPT",
    entityId: header.id,
    before: snapshot,
    after: null,
    reason,
    detail: { kind: header.kind, approvalGroup: group, actorLabel: input.actor.label },
  });

  // Xoá CÓ ĐIỀU KIỆN: một phiếu kiểm vừa gắn vào giữa lúc kiểm và lúc xoá thì không xoá.
  const deleted = await db
    .delete(schema.stockReceipts)
    .where(
      and(
        eq(schema.stockReceipts.id, header.id),
        sql`not exists (select 1 from return_inspections ri where ri.stock_receipt_id = ${header.id})`,
        sql`not exists (select 1 from return_unidentified ru where ru.stock_receipt_id = ${header.id})`,
        sql`not exists (select 1 from return_dispositions rd where rd.stock_receipt_id = ${header.id})`,
      ),
    )
    .returning({ id: schema.stockReceipts.id });
  if (!deleted.length) {
    await audit({ userId: input.actor.id, userEmail: input.actorEmail, action: "STOCK_RECEIPT_DELETE_ABORTED", entity: "STOCK_RECEIPT", entityId: header.id, reason: "phiếu vừa được gắn làm chứng từ kiểm hoàn — không xoá" });
    return { error: "Phiếu vừa được gắn vào một phiếu kiểm hàng hoàn — không xoá. Tải lại trang để xem." };
  }
  return { ok: true, snapshot };
}
