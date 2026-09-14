"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import {
  PAYROLL_BASES,
  PAYROLL_BASIS_ELIGIBILITY,
  PAYROLL_BASIS_SHORT,
  PAYROLL_CALC_VERSION,
  payrollPeriodKey,
  type PayrollBasis,
} from "@/lib/constants/payroll";
import { vnEndOfDay, vnStartOfDay } from "@/lib/format";
import { getPayrollReport } from "@/lib/queries/payroll";
import { buildPayrollSnapshot, finalizedPeriodsOverlapping } from "@/lib/queries/payroll-period";
import type { Period } from "@/lib/search-params";

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
 * ĐÃ CHỐT THÌ KHÔNG CHỐT LẠI, và cố ý KHÔNG có đường "mở lại": chứng từ về sau được xử lý bằng ĐỀ
 * XUẤT ĐIỀU CHỈNH (`payrollDrift`) — ảnh chụp vẫn là con số của kỳ, phần chênh đứng cạnh nó, và
 * NGƯỜI quyết có sửa hay không.
 */
export async function finalizePayrollPeriod(input: unknown): Promise<PeriodActionResult> {
  const user = await requireUser();
  if (!can(user, "payroll:manage")) return { error: "Chỉ người có quyền khai báo lương mới được chốt kỳ" };
  const parsed = finalizeSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const { from, to, basis, note } = parsed.data;

  const fromAt = vnStartOfDay(from);
  const toAt = vnEndOfDay(to);
  if (toAt < fromAt) return { error: "Mốc cuối kỳ phải sau mốc đầu kỳ" };
  const key = payrollPeriodKey(fromAt, toAt);
  if (!key) return { error: "Kỳ không có mốc đầu/cuối nên không chốt được" };

  const eligibility = PAYROLL_BASIS_ELIGIBILITY[basis];
  if (!eligibility.eligible) {
    return { error: `Cơ sở “${PAYROLL_BASIS_SHORT[basis]}” không dùng để chốt lương được. ${eligibility.why}` };
  }

  const db = await getDb();
  const p = schema.payrollPeriods;
  const [existing] = await db.select({ status: p.status }).from(p).where(and(eq(p.periodKey, key), eq(p.basis, basis))).limit(1);
  if (existing?.status === "FINAL") return { error: "Kỳ này đã chốt rồi. Kỳ đã chốt là bất biến — chứng từ về sau xử lý bằng đề xuất điều chỉnh." };

  /*
    HAI KỲ ĐÃ CHỐT KHÔNG ĐƯỢC CHỒNG LẤN NGÀY.

    Chốt "Tháng này" ngày 14 ra khoá `2026-09-01..2026-09-14`; chốt lại ngày 30 ra
    `2026-09-01..2026-09-30`. Hai khoá khác nhau nên khoá tự nhiên không chặn — nhưng mười bốn ngày
    đầu tháng nằm trong CẢ HAI, và cộng hai bản chốt lại là trả lương hai lần cho những ngày ấy.
    Khoá tự nhiên chặn TRÙNG KHOÁ; mệnh đề này chặn TRÙNG NGÀY, và đó là hai chuyện khác nhau.
  */
  const chongLan = await finalizedPeriodsOverlapping(fromAt, toAt);
  const trung = chongLan.find((k) => k.basis === basis);
  if (trung) {
    return {
      error: `Kỳ ${from} → ${to} chồng lấn ngày với kỳ ĐÃ CHỐT ${trung.periodKey} (cùng cơ sở ${PAYROLL_BASIS_SHORT[basis]}). Chốt tiếp là trả lương hai lần cho những ngày nằm trong cả hai kỳ.`,
    };
  }

  const period: Period = { key: "custom", from: fromAt, to: toAt, fromKey: from, toKey: to, label: `${from} → ${to}` };
  const report = await getPayrollReport(period, basis);
  if (report.totalSalary === null) {
    return { error: "Còn con số CHƯA BIẾT trong kỳ (lương cứng hoặc thưởng theo LN cá nhân), nên chưa chốt được. Chốt lúc này là đóng băng một chỗ trống và gọi nó là kết quả." };
  }
  const snapshot = buildPayrollSnapshot(report, period, key);

  await db
    .insert(p)
    .values({
      periodKey: key,
      periodStart: fromAt,
      periodEnd: toAt,
      basis,
      status: "FINAL",
      snapshot,
      calcVersion: PAYROLL_CALC_VERSION,
      note,
      finalizedAt: new Date(),
      finalizedBy: user.id,
      createdBy: user.id,
    })
    .onConflictDoUpdate({
      target: [p.periodKey, p.basis],
      // Chỉ nâng một dòng NHÁP lên FINAL. Dòng đã FINAL không bao giờ tới đây (đã chặn ở trên), và
      // mệnh đề `where` là lớp chặn thứ hai ngay tại CSDL — phòng hai lượt bấm cùng lúc.
      set: { status: "FINAL", snapshot, calcVersion: PAYROLL_CALC_VERSION, note, finalizedAt: new Date(), finalizedBy: user.id, updatedAt: new Date() },
      setWhere: eq(p.status, "DRAFT"),
    });

  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "PAYROLL_PERIOD_FINALIZE",
    entity: "PAYROLL_PERIOD",
    entityId: `${key}:${basis}`,
    detail: { key, basis, calcVersion: PAYROLL_CALC_VERSION, totalSalary: report.totalSalary, totalProfit: report.totalProfit, people: report.lines.length, note },
  });
  revalidatePath("/payroll");
  return { ok: true, key };
}
