import { eq } from "drizzle-orm";
import { schema, type Db } from "@/db";
import type { AuditParams } from "@/lib/audit";
import { flushApprovalAudits, guardInTransaction } from "@/lib/approvals/execution";
import { recordApprovalExecutionError, type ApprovalUser, type GuardInput, type GuardResult } from "@/lib/approvals/service";
import type { Actor } from "@/lib/constants/actor";
import { settleReturnsForReceipt } from "@/lib/returns/warehouse";
import type { StockReceiptKind } from "@/lib/validation/stock";

/**
 * ═══════════ GHI PHIẾU KHO — LÕI DỊCH VỤ (Company OS · Agent K, tách từ `createStockReceipt`) ═══════════
 *
 * KHÔNG "use server". Server action `createStockReceipt` kiểm quyền, kiểm đầu vào, định giá, dựng đầu
 * phiếu (xưởng theo danh mục, nối lệnh SX) rồi gọi vào đây; kiểm thử gọi thẳng.
 *
 * MỘT GIAO DỊCH: cổng duyệt hai bước (nếu phiếu cần) · phiếu · dòng phiếu · đóng kiện hoàn · giá nhập gần
 * nhất. Cổng đứng TRONG giao dịch (`IN_TRANSACTION`, lib/approvals/service.ts điểm 4): lời duyệt được
 * tiêu thụ và `approval.executed` được phát cùng lượt với phiếu — phiếu hỏng ⇒ lượt tiêu thụ huỷ theo,
 * lời duyệt còn `APPROVED`, câu lỗi vào `execution_error`. Trước bản này lời duyệt lật `EXECUTED` ở
 * cổng rồi phiếu mới ghi — phiếu hỏng là mất lời duyệt (handoff-g mục 4).
 */

/** Lỗi nghiệp vụ khi đóng kiện hoàn — ném ra để huỷ giao dịch rồi trả `{ error }`, không phải lỗi hệ thống. */
class SettleError extends Error {}

export type ReceiptLineInput = { variantId: string; quantity: number; unitCost: number; shipmentId: string | null };

export type WriteReceiptInput = {
  kind: StockReceiptKind;
  /** Đầu phiếu do server action dựng (xưởng theo danh mục, nối lệnh SX / lô đã kiểm tồn tại). */
  receipt: Omit<typeof schema.stockReceipts.$inferInsert, "id" | "kind">;
  lines: ReceiptLineInput[];
  note: string;
  actor: Actor;
  /** Người thao tác theo góc nhìn của cổng duyệt (khoá + email). */
  approver: ApprovalUser;
  /** Cổng duyệt hai bước cho loại phiếu cần nó; `null` = không cần. */
  gate: GuardInput | null;
};

export type WriteReceiptResult =
  | { ok: true; receiptId: string; settledShipmentIds: string[]; gate: GuardResult | null }
  | { error: string; gate: GuardResult | null };

export async function writeStockReceiptCore(db: Db, input: WriteReceiptInput): Promise<WriteReceiptResult> {
  // Kết quả cổng đọc được cả ở nhánh lỗi (khối `catch`) — giữ trong một hộp, không trong biến `let`.
  const giu: { cong: GuardResult | null; nhatKy: AuditParams[] } = { cong: null, nhatKy: [] };
  try {
    const out = await db.transaction(async (tx): Promise<{ blocked: string } | { receiptId: string; settledShipmentIds: string[] }> => {
      if (input.gate) {
        const g = await guardInTransaction(tx, input.approver, input.gate);
        giu.cong = g.result;
        giu.nhatKy = g.audits;
        if (g.result.mode === "NEEDS_APPROVAL") return { blocked: `Việc này cần người thứ hai duyệt (${g.result.reason}). Đã gửi yêu cầu — xem ở trang Cảnh báo.` };
        if (g.result.mode === "BLOCKED_NO_APPROVER") {
          return { blocked: `Việc này cần người thứ hai duyệt (${g.result.reason}), nhưng hệ thống chưa có ai khác đủ tư cách duyệt. Thêm một tài khoản ADMIN hoặc MANAGER trước.` };
        }
      }
      const [receipt] = await tx
        .insert(schema.stockReceipts)
        .values({ ...input.receipt, kind: input.kind })
        .returning({ id: schema.stockReceipts.id });
      await tx.insert(schema.stockReceiptItems).values(input.lines.map((l) => ({ receiptId: receipt.id, ...l })));
      let settledShipmentIds: string[] = [];
      if (input.kind === "RETURN") {
        /*
          Đóng ĐÚNG những vận đơn mà dòng phiếu chỉ tên — không đoán kiện nào theo mẫu mã (FIFO) như
          trước. Dòng không nêu vận đơn thì phiếu vẫn cộng tồn theo số đếm, nhưng KHÔNG gạch kiện nào
          khỏi hàng chờ: ERP không biết kiện nào đã về, và nói bừa còn tệ hơn nói "chưa biết".
        */
        const settled = await settleReturnsForReceipt(tx, { receiptId: receipt.id, lines: input.lines, actor: input.actor, note: input.note });
        if ("error" in settled) throw new SettleError(settled.error);
        settledShipmentIds = settled.settledShipmentIds;
      }
      if (input.kind === "RECEIPT") {
        for (const l of input.lines) {
          if (l.unitCost > 0) await tx.update(schema.productVariants).set({ lastImportedPrice: l.unitCost, updatedAt: new Date() }).where(eq(schema.productVariants.id, l.variantId));
        }
      }
      return { receiptId: receipt.id, settledShipmentIds };
    });
    // Giao dịch đã chốt: giờ mới ghi nhật ký của cổng (PGlite một kết nối — xem lib/approvals/execution.ts).
    await flushApprovalAudits(giu.nhatKy);
    if ("blocked" in out) return { error: out.blocked, gate: giu.cong };
    return { ok: true, ...out, gate: giu.cong };
  } catch (e) {
    // Giao dịch đổ: lượt tiêu thụ (nếu có) đã huỷ theo, lời duyệt còn APPROVED — ghi vì sao việc chưa xong.
    if (giu.cong?.consumed && giu.cong.requestId) {
      await recordApprovalExecutionError(db, giu.cong.requestId, e instanceof Error ? e.message : String(e), input.approver).catch((loi) => console.error("[approval] không ghi được execution_error:", loi));
    }
    if (e instanceof SettleError) return { error: e.message, gate: giu.cong };
    throw e;
  }
}
