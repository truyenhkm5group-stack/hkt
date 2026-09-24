"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { can, requireUser } from "@/lib/auth/session";
import { canAdministerPayroll } from "@/lib/auth/payroll-scope";
import { PAYROLL_BASES, type PayrollBasis } from "@/lib/constants/payroll";
import { calculatePayrollPeriodAs } from "@/lib/payroll/run-service";

export type PeriodActionResult = { ok: true; key: string } | { error: string };

const finalizeSchema = z.object({
  /** `YYYY-MM-DD` — mốc đầu kỳ theo giờ Việt Nam. */
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Mốc đầu kỳ không hợp lệ"),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Mốc cuối kỳ không hợp lệ"),
  basis: z.enum(PAYROLL_BASES as [PayrollBasis, ...PayrollBasis[]]),
  note: z.string().max(500).default(""),
});

/**
 * ═══════════ CHỐT MỘT KỲ LƯƠNG ═══════════
 *
 * Chốt = CHỤP LẠI, không phải "đánh dấu xong". Sau lượt này màn hình đọc ảnh chụp và thôi truy vấn
 * lại, nên đổi tỷ lệ / đổi người phụ trách fanpage / nhập thêm phiếu kho về sau KHÔNG làm đổi số
 * của kỳ đã trả tiền (AGENTS.md mục 21).
 *
 * BỐN CỬA, và mỗi cửa chặn một cách hỏng khác nhau:
 *
 *  1. **Quyền `payroll:manage`** — chốt kỳ là một quyết định tiền bạc, không phải một lượt xem.
 *  2. **Kỳ phải có mốc đầu/cuối.** Kỳ "Toàn bộ" không có danh tính nào để chốt, và lương cứng của
 *     nó là CHƯA BIẾT — chốt một kỳ như thế là chốt một con số không tồn tại.
 *  3. **Cơ sở phải ĐỦ ĐIỀU KIỆN** (`PAYROLL_BASIS_ELIGIBILITY`). LN2 / dòng tiền / danh nghĩa xem
 *     được nhưng không phải căn cứ trả tiền — cho chốt bằng chúng là biến một lần bấm nhầm thành
 *     một kỳ lương đã chốt trên cơ sở sai.
 *  4. **Không con số nào được CHƯA BIẾT.** `totalSalary = null` nghĩa là còn một phần chưa tính
 *     được; chốt lúc đó là đóng băng một chỗ trống và gọi nó là kết quả.
 *
 * ─── TỪ BẢN VÒNG ĐỜI: HÀM NÀY LÀ BƯỚC "TÍNH", KHÔNG PHẢI BƯỚC "KHOÁ" ───
 *
 * Trước đây một lượt bấm đi thẳng từ chưa có gì tới BẤT BIẾN. Nó gộp mất chỗ để soát: không ai
 * nhìn con số trước khi nó đóng băng, và không ai ký tên vào nó.
 *
 * Nay hàm này đưa kỳ tới `CALCULATED` — đã có ảnh chụp, nhưng còn tính lại được. Đường đi tiếp
 * (`UNDER_REVIEW` → `APPROVED` → `LOCKED` → `PAID`) nằm ở `lib/actions/payroll-run.ts`, và bước
 * KHOÁ cần quyền `payroll:approve` chứ không phải `payroll:manage`.
 *
 * Hệ quả quan trọng: **sổ lỗ lũy kế nay ghi ở trạng thái NHÁP**, và chỉ thành chính thức khi kỳ
 * được KHOÁ. Ghi nó thành chính thức ngay ở bước tính là đóng băng một nghĩa vụ dựa trên con số
 * còn có thể đổi — và tháng sau sẽ đọc số dư ấy như thể nó đã được ai đó duyệt.
 *
 * Chứng từ về sau khi đã KHOÁ vẫn xử lý bằng ĐỀ XUẤT ĐIỀU CHỈNH (`payrollDrift`): ảnh chụp vẫn là
 * con số của kỳ, phần chênh đứng cạnh nó, và NGƯỜI quyết có sửa hay không.
 */
export async function finalizePayrollPeriod(input: unknown): Promise<PeriodActionResult> {
  const user = await requireUser();
  if (!canAdministerPayroll(user, can(user, "payroll:manage"))) return { error: "Việc này cần quyền khai báo lương VÀ phạm vi xem lương toàn công ty — không được phép NHÌN bảng lương thì cũng không sửa được nó." };
  const parsed = finalizeSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const { from, to, basis, note } = parsed.data;

  // Toàn bộ phép tính, khoá tên và nhật ký ở lõi dùng chung — máy tự động đi CÙNG đường này.
  const r = await calculatePayrollPeriodAs({ id: user.id, email: user.email }, { from, to, basis, note });
  if ("error" in r) return r;
  revalidatePath("/payroll");
  revalidatePath("/payroll/autopilot");
  return { ok: true, key: r.key };
}
