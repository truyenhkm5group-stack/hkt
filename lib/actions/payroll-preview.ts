"use server";

/**
 * ═══════════ XEM THỬ PHÉP TÍNH CỦA MỘT CHÍNH SÁCH — CHẠY KHÔ, KHÔNG GHI GÌ ═══════════
 *
 * ─── VÌ SAO KHÔNG VIẾT CÔNG THỨC RIÊNG Ở TRÌNH DUYỆT ───
 *
 * Một bản xem thử tính bằng JavaScript phía màn hình sẽ khớp với bảng lương thật đúng tới lúc một
 * trong hai bên đổi — và lúc ấy nó còn tệ hơn không có: người khai chính sách tin vào một con số
 * không phải con số sẽ được trả. Nên đường này gọi CHÍNH `calculatePayrollItem`, cùng hàm mà bảng
 * lương và tệp xuất gọi. `tests/payroll-preview.test.ts` khoá điều đó ở mức mã nguồn.
 *
 * ─── CHẠY KHÔ NGHĨA LÀ KHÔNG GHI MỘT DÒNG NÀO ───
 *
 * Không `payroll_periods`, không sổ lỗ lũy kế, không `payroll_inputs`, không `payroll_adjustments`,
 * không phát hành phiên bản. Hàm này KHÔNG mở một giao dịch nào và không import `schema` — bài kiểm
 * quét mã nguồn để giữ điều đó, vì "tôi nhớ là nó không ghi" không phải một đảm bảo.
 */
import { z } from "zod";
import { can, requireUser } from "@/lib/auth/session";
import { PAYROLL_INPUT_KEYS } from "@/lib/constants/payroll-components";
import { calculatePayrollItem, type PayrollItemResult } from "@/lib/payroll/engine";
import { resolveSegments } from "@/lib/payroll/policy-resolve";
import { findCycles } from "@/lib/payroll/policy-graph";
import { componentSchema } from "@/lib/validation/payroll-policy";
import { vnEndOfDay, vnStartOfDay } from "@/lib/format";

export type PreviewResult = { ok: true; result: PayrollItemResult; days: number } | { error: string };

const previewSchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Mốc đầu kỳ không hợp lệ"),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Mốc cuối kỳ không hợp lệ"),
  components: z.array(componentSchema).min(1, "Chưa có thành phần nào để xem thử"),
  /** Giá trị mẫu cho từng đại lượng. Thiếu một đại lượng ⇒ máy trả CHƯA BIẾT, đúng như khi chạy thật. */
  basis: z.record(z.enum(PAYROLL_INPUT_KEYS as [string, ...string[]]), z.number().nullable()).default({}),
  /** Số dư lỗ đầu kỳ mẫu theo khoá thành phần. `null` = chưa xác lập. */
  carryOpening: z.record(z.string(), z.number().nullable()).default({}),
  /** Khoản điều chỉnh mẫu — để thấy chúng ảnh hưởng thực nhận thế nào. */
  adjustments: z
    .array(z.object({ kind: z.enum(["BONUS", "ALLOWANCE", "ADJUSTMENT", "ADVANCE", "DEDUCTION", "REIMBURSEMENT"]), label: z.string().max(120), amount: z.number().int().min(0) }))
    .max(10)
    .default([]),
});

export async function previewPolicyCalculation(input: unknown): Promise<PreviewResult> {
  const user = await requireUser();
  /*
    XEM THỬ CŨNG CẦN QUYỀN KHAI BÁO LƯƠNG.

    Nó không ghi gì, nhưng nó TIẾT LỘ cách tính tiền của shop: đưa vào một bộ đại lượng rồi đọc ra
    con số. Một cửa chỉ-đọc vẫn là một cửa.
  */
  if (!can(user, "payroll:manage")) return { error: "Xem thử phép tính cần quyền khai báo lương" };

  const parsed = previewSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const d = parsed.data;

  const from = vnStartOfDay(d.from);
  const to = vnEndOfDay(d.to);
  if (to < from) return { error: "Mốc cuối kỳ phải từ mốc đầu kỳ trở đi" };

  // Vòng tròn phải chặn TRƯỚC khi tính — nếu không máy đọc rỗng, nhân ra NaN, và NaN in thành "—".
  const vong = findCycles(d.components);
  if (vong.length) return { error: vong.map((v) => v.message).join("\n") };

  /*
    MỘT ĐOẠN DUY NHẤT PHỦ TRỌN KỲ MẪU.

    Xem thử trả lời câu "chính sách này tính ra bao nhiêu", không phải "người này vào làm ngày nào".
    Dựng một phân công mẫu phủ trọn kỳ để phép chia theo ngày vẫn chạy đúng như thật, mà không phải
    bịa ra một hồ sơ nhân sự không tồn tại.
  */
  const segments = resolveSegments({
    from,
    to,
    employments: [
      {
        id: "preview",
        employeeId: "preview",
        departmentId: null,
        departmentName: "",
        positionId: null,
        positionName: "",
        managerUserId: null,
        employmentType: "FULL_TIME",
        workMode: "ONSITE",
        status: "ACTIVE",
        standardWorkDays: null,
        effectiveFrom: from,
        effectiveTo: null,
      },
    ],
    policyAssignments: [{ id: "preview", employeeId: "preview", policyId: "preview", policyCode: "XEM_THU", policyName: "Xem thử", effectiveFrom: from, effectiveTo: null }],
    policyVersions: [{ id: "preview-v", policyId: "preview", version: 1, effectiveFrom: from, effectiveTo: null, status: "ACTIVE" }],
  });

  const result = calculatePayrollItem({
    employeeId: "preview",
    employeeName: "Mẫu",
    segments: segments.map((segment) => ({
      segment,
      components: d.components,
      basis: { ...d.basis, PERIOD_DAYS: segment.days },
    })),
    adjustments: d.adjustments.map((a, i) => ({ id: `preview-${i}`, kind: a.kind, label: a.label || "Khoản mẫu", amount: a.amount, reason: "Giá trị mẫu để xem thử" })),
    carryOpening: d.carryOpening,
  });

  return { ok: true, result, days: segments.reduce((t, s) => t + s.days, 0) };
}
