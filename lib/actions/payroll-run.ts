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
 *
 * Từ 25/09/2026 khoá tên + đọc lại trong khoá nằm ở LÕI DÙNG CHUNG `lib/payroll/run-service.ts`,
 * vì lương tự động phải đi đúng cửa này cho hai bước nó được phép (tính · chuyển soát). Tệp này giữ
 * phần chỉ có nghĩa khi có một NGƯỜI bấm: quyền, lý do bắt buộc, cổng người thứ hai.
 */
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { guardSecondApproval } from "@/lib/actions/approvals";
import { withApprovalExecution } from "@/lib/approvals/execution";
import { can, requireUser } from "@/lib/auth/session";
import { canAdministerPayroll } from "@/lib/auth/payroll-scope";
import {
  PAYROLL_ACTION_SPEC,
  PAYROLL_RUN_ACTIONS,
  canTransition,
  normalizePayrollStatus,
  type PayrollRunAction,
} from "@/lib/constants/payroll-lifecycle";
import { PAYROLL_BASES, PAYROLL_BASIS_SHORT, type PayrollBasis } from "@/lib/constants/payroll";
import { transitionPayrollRunAs } from "@/lib/payroll/run-service";

export type RunActionResult = { ok: true; status: string; sideEffects: string[] } | { error: string };

const schemaIn = z.object({
  periodKey: z.string().regex(/^\d{4}-\d{2}-\d{2}\.\.\d{4}-\d{2}-\d{2}$/, "Khoá kỳ không hợp lệ"),
  basis: z.enum(PAYROLL_BASES as [PayrollBasis, ...PayrollBasis[]]),
  action: z.enum(PAYROLL_RUN_ACTIONS as unknown as [PayrollRunAction, ...PayrollRunAction[]]),
  reason: z.string().trim().max(500).default(""),
});

export async function movePayrollRun(input: unknown): Promise<RunActionResult> {
  return withApprovalExecution(async () => {
    const user = await requireUser();
    const parsed = schemaIn.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
    const { periodKey, basis, action, reason } = parsed.data;
    const spec = PAYROLL_ACTION_SPEC[action];

    // 1 · QUYỀN. Nút cũng ẩn theo đúng quyền này, nhưng máy chủ vẫn kiểm: một cái nút ẩn không phải
    //     một lớp bảo vệ, nó chỉ là một lời gợi ý.
    if (!can(user, spec.permission) || !canAdministerPayroll(user, true)) {
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

    /*
      KHOÁ TÊN, ĐỌC LẠI TRONG KHOÁ, BẢNG CHUYỂN TRẠNG THÁI và NHẬT KÝ nằm ở lõi dùng chung
      (`lib/payroll/run-service.ts`) — máy tự động đi CÙNG cửa ấy cho hai bước nó được phép.
      Phần ở trên (quyền · lý do · người thứ hai) chỉ có nghĩa khi có một NGƯỜI đang bấm.
    */
    const r = await transitionPayrollRunAs({ id: user.id, email: user.email }, { periodKey, basis, action, reason });
    if ("error" in r) return r;
    revalidatePath("/payroll");
    revalidatePath("/payroll/runs");
    revalidatePath("/payroll/autopilot");
    return { ok: true, status: r.status, sideEffects: r.sideEffects };
  });
}
