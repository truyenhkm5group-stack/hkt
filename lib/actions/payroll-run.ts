"use server";

/**
 * ═══════════ CHUYỂN TRẠNG THÁI MỘT KỲ LƯƠNG — MỘT CỬA DUY NHẤT ═══════════
 *
 * Bảy việc (tính · chuyển soát · duyệt · trả lại · khoá · mở khoá · đánh dấu đã trả) đi qua CÙNG
 * một hàm, đọc CÙNG một bảng chuyển trạng thái (`PAYROLL_RUN_TRANSITIONS`).
 *
 * ─── VÌ SAO MỘT CỬA CHỨ KHÔNG BẢY HÀM ───
 *
 * Bảy hàm nghĩa là bảy nơi tự viết lấy mệnh đề "từ trạng thái nào thì đi được". Chúng sẽ lệch
 * nhau — không phải có thể, mà sớm muộn — và lúc lệch thì một kỳ ĐÃ KHOÁ quay về nháp bằng một
 * lối không ai biết là có. Ở đây bảng chuyển trạng thái là DỮ LIỆU, và cả màn hình lẫn máy chủ đọc
 * chính nó.
 *
 * ─── KHOÁ TÊN CHO CẢ BẢY VIỆC ───
 *
 * Hai yêu cầu "duyệt" gửi cùng lúc đều đọc trạng thái `UNDER_REVIEW` rồi cùng ghi `APPROVED` —
 * hai chữ ký cho một kỳ, và không ai biết cái nào có hiệu lực. `pg_advisory_xact_lock` xếp hàng
 * chúng lại; chốt lương là việc mỗi tháng một lần nên xếp hàng ở đây không tốn gì.
 */
import { and, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { guardSecondApproval } from "@/lib/actions/approvals";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import {
  PAYROLL_ACTION_SPEC,
  PAYROLL_RUN_ACTIONS,
  canTransition,
  normalizePayrollStatus,
  type PayrollRunAction,
} from "@/lib/constants/payroll-lifecycle";
import { PAYROLL_BASES, PAYROLL_BASIS_SHORT, type PayrollBasis } from "@/lib/constants/payroll";
import { monthKeyOf } from "@/lib/constants/payroll-carryover";

export type RunActionResult = { ok: true; status: string } | { error: string };

const schemaIn = z.object({
  periodKey: z.string().regex(/^\d{4}-\d{2}-\d{2}\.\.\d{4}-\d{2}-\d{2}$/, "Khoá kỳ không hợp lệ"),
  basis: z.enum(PAYROLL_BASES as [PayrollBasis, ...PayrollBasis[]]),
  action: z.enum(PAYROLL_RUN_ACTIONS as unknown as [PayrollRunAction, ...PayrollRunAction[]]),
  reason: z.string().trim().max(500).default(""),
});

export async function movePayrollRun(input: unknown): Promise<RunActionResult> {
  const user = await requireUser();
  const parsed = schemaIn.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const { periodKey, basis, action, reason } = parsed.data;
  const spec = PAYROLL_ACTION_SPEC[action];

  // 1 · QUYỀN. Nút cũng ẩn theo đúng quyền này, nhưng máy chủ vẫn kiểm: một cái nút ẩn không phải
  //     một lớp bảo vệ, nó chỉ là một lời gợi ý.
  if (!can(user, spec.permission)) {
    return {
      error:
        spec.permission === "payroll:approve"
          ? `“${spec.label}” cần quyền DUYỆT LƯƠNG. Quyền khai báo lương không tự mang theo quyền duyệt — người khai số và người duyệt số không nên là một.`
          : `“${spec.label}” cần quyền khai báo lương.`,
    };
  }

  // 2 · LÝ DO BẮT BUỘC cho những việc làm đổi một kỳ đã có số.
  if (spec.requiresReason && reason.length < 3) {
    return { error: `“${spec.label}” bắt buộc ghi LÝ DO. Không có lý do thì người đọc sau chỉ biết là “có gì đó đã đổi”.` };
  }

  const db = await getDb();
  const p = schema.payrollPeriods;
  const [row] = await db.select().from(p).where(and(eq(p.periodKey, periodKey), eq(p.basis, basis))).limit(1);
  if (!row) return { error: "Kỳ này chưa có bản ghi nào. Bấm “Tính & chụp ảnh kỳ” trước." };
  const current = normalizePayrollStatus(row.status);

  // 3 · BẢNG CHUYỂN TRẠNG THÁI — cùng một bảng mà màn hình dùng để quyết định hiện nút nào.
  if (!canTransition(current, action)) {
    return { error: `Kỳ đang ở trạng thái “${current}” nên không làm được việc “${spec.label}”.` };
  }

  // 4 · NGƯỜI THỨ HAI, cho ba việc mà một mình quyết là quá nhiều quyền.
  if (spec.secondApproval) {
    const cong = await guardSecondApproval({
      group: "PAYROLL_EDIT",
      action: `payroll.run.${action.toLowerCase()}`,
      entity: "PAYROLL_PERIOD",
      entityId: `${periodKey}:${basis}`,
      summary: `${spec.label} — kỳ ${periodKey}, cơ sở ${PAYROLL_BASIS_SHORT[basis]}${reason ? ` · lý do: ${reason}` : ""}`,
      amount: null,
      payload: { periodKey, basis, action, reason },
    });
    if (cong.mode === "NEEDS_APPROVAL") return { error: `Việc này cần người thứ hai duyệt (${cong.reason}). Đã gửi yêu cầu — xem ở trang Cảnh báo.` };
    if (cong.mode === "BLOCKED_NO_APPROVER") return { error: `Việc này cần người thứ hai duyệt (${cong.reason}), nhưng chưa có ai khác đủ tư cách duyệt.` };
  }

  const luc = new Date();
  const ketQua = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('erp:payroll-run:' || ${`${periodKey}:${basis}`}))`);
    // Đọc LẠI bên trong khoá: trạng thái có thể đã đổi giữa lượt đọc ở trên và lượt ghi này.
    const [again] = await tx.select({ status: p.status }).from(p).where(and(eq(p.periodKey, periodKey), eq(p.basis, basis))).limit(1);
    const now = normalizePayrollStatus(again?.status);
    if (!canTransition(now, action)) {
      return { error: `Kỳ vừa đổi sang trạng thái “${now}” (một người khác vừa thao tác) nên “${spec.label}” không còn hợp lệ. Mở lại trang để xem trạng thái mới.` } as const;
    }

    /*
      MỘT LƯỢT MỞ KHOÁ PHẢI XOÁ CHỮ KÝ DUYỆT.

      Mở khoá đưa kỳ về `APPROVED`, nhưng chữ ký cũ được ký trên một con số CÓ THỂ SẮP ĐỔI. Giữ
      nguyên `approved_by` là để một người mang tiếng đã duyệt thứ họ chưa từng nhìn thấy. Nên mở
      khoá giữ nguyên mốc duyệt cũ để tra lịch sử, nhưng trạng thái phải đi qua vòng soát lại —
      bảng chuyển trạng thái đã ép điều đó: `APPROVED` chỉ đi tiếp được khi có người bấm `LOCK`.
    */
    const set: Record<string, unknown> = { status: spec.to, updatedAt: luc, statusReason: spec.requiresReason ? reason : "" };
    if (action === "APPROVE") {
      set.approvedAt = luc;
      set.approvedBy = user.id;
    }
    if (action === "LOCK") {
      set.lockedAt = luc;
      set.lockedBy = user.id;
    }
    if (action === "UNLOCK") {
      // Giữ `locked_at` cũ để tra được "kỳ này từng khoá lúc nào"; ràng buộc CHECK chỉ đòi nó khi
      // trạng thái là LOCKED/PAID, nên để lại không vi phạm gì.
      set.lockedAt = null;
      set.lockedBy = null;
    }
    if (action === "MARK_PAID") {
      set.paidAt = luc;
      set.paidBy = user.id;
    }
    await tx.update(p).set(set).where(and(eq(p.periodKey, periodKey), eq(p.basis, basis)));

    /*
      ═══ SỔ LỖ LŨY KẾ THÀNH CHÍNH THỨC ĐÚNG LÚC KHOÁ, KHÔNG SỚM HƠN ═══

      Số dư mang sang là một NGHĨA VỤ. Đóng băng nó ở bước TÍNH là khẳng định một nghĩa vụ dựa
      trên con số còn sửa được — và tháng sau sẽ đọc số dư ấy như thể đã có người duyệt. Nên nó ở
      trạng thái NHÁP suốt vòng soát, và chỉ thành `FINAL` khi kỳ đóng băng.

      Chiều ngược lại cũng phải đúng: MỞ KHOÁ đưa sổ về NHÁP. Không hạ thì tháng sau tiếp tục đọc
      một số dư "đã chốt" của một kỳ vừa được mở ra để sửa.
    */
    const c = schema.marketerProfitCarryover;
    const thangCuaKy = monthKeyOf(new Date(`${periodKey.slice(0, 10)}T00:00:00+07:00`));
    if (action === "LOCK") {
      await tx
        .update(c)
        .set({ status: "FINAL", finalizedAt: luc, finalizedBy: user.id, updatedAt: luc })
        .where(and(eq(c.monthKey, thangCuaKy), eq(c.status, "DRAFT")));
    }
    if (action === "UNLOCK") {
      await tx
        .update(c)
        .set({ status: "DRAFT", finalizedAt: null, finalizedBy: null, updatedAt: luc })
        .where(and(eq(c.monthKey, thangCuaKy), eq(c.status, "FINAL")));
    }
    return { ok: true, from: now } as const;
  });
  if ("error" in ketQua && ketQua.error) return { error: ketQua.error };

  await audit({
    userId: user.id,
    userEmail: user.email,
    action: spec.auditAction,
    entity: "PAYROLL_PERIOD",
    entityId: `${periodKey}:${basis}`,
    before: { status: current },
    after: { status: spec.to },
    reason: reason || undefined,
    detail: { periodKey, basis, action },
  });
  revalidatePath("/payroll");
  revalidatePath("/payroll/runs");
  return { ok: true, status: spec.to };
}
