"use server";

import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
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
import { LEGACY_CARRY_COMPONENT, rateToBp } from "@/lib/constants/payroll-carryover";
import { payrollFinalizeBlockers } from "@/lib/constants/payroll-readiness";
import { isFrozen, normalizePayrollStatus } from "@/lib/constants/payroll-lifecycle";
// `finalizedPeriodsOverlapping` không còn dùng ở đây: phép kiểm chồng lấn nay chạy BÊN TRONG giao
// dịch đã cầm khoá (xem dưới), vì kiểm ngoài rồi ghi trong là đúng cái khe mà hai yêu cầu đồng
// thời lọt qua. Hàm cũ vẫn phục vụ `lib/queries/payroll-period.ts` cho phần chỉ ĐỌC.
import { buildPayrollSnapshot } from "@/lib/queries/payroll-period";
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
  /*
    TÍNH LẠI ĐƯỢC, TRỪ KHI ĐÃ ĐÓNG BĂNG.

    `CALCULATED` / `UNDER_REVIEW` / `APPROVED` đều tính lại được — đó chính là lý do có chúng: chỗ
    để phát hiện sai trước khi đóng băng. `LOCKED` / `PAID` thì không, và `FINAL` cũ đọc như
    `LOCKED`.
  */
  if (existing && isFrozen(normalizePayrollStatus(existing.status))) {
    return { error: "Kỳ này đã KHOÁ. Kỳ đã khoá là bất biến — chứng từ về sau xử lý bằng khoản điều chỉnh ở kỳ kế tiếp, hoặc mở khoá (cần quyền duyệt lương và một lý do)." };
  }

  const period: Period = { key: "custom", from: fromAt, to: toAt, fromKey: from, toKey: to, label: `${from} → ${to}` };
  const report = await getPayrollReport(period, basis);
  /*
    ĐIỀU KIỆN CHỐT ĐỌC TỪ MỘT CHỖ DUY NHẤT.

    Bản trước kiểm đúng hai thứ ở đây (cơ sở hợp lệ, `totalSalary` khác null) và coi đó là "đủ căn
    cứ". Nhưng "tổng lương tính ra được một con số" KHÔNG đồng nghĩa với "con số ấy đã trừ đủ chi
    phí": một khoản cước gõ tay bị loại vì trùng nguồn, hay phần nhóm lương chưa đối chiếu được,
    đều làm tổng vẫn ra số mà số ấy thiếu. Và từ bản này còn thêm một cửa nữa — số dư lỗ đầu kỳ.

    `payrollFinalizeBlockers` là hàm THUẦN và màn hình gọi CHÍNH nó để quyết định có hiện nút hay
    không, nên không còn cảnh nút hiện rồi server từ chối.
  */
  const blockers = payrollFinalizeBlockers({
    bounded: true,
    basisEligible: eligibility.eligible,
    basisWhy: eligibility.why,
    basisLabel: PAYROLL_BASIS_SHORT[basis],
    totalSalary: report.totalSalary,
    costWarnings: report.marketers.costWarnings,
    lines: report.lines.map((l) => ({
      name: l.employee.shortName || l.employee.name,
      carryEstablished: l.carry ? l.carry.openingEstablished : null,
      carryReason: l.carry?.openingReason ?? null,
      engineMissing: l.engine?.result.missing.map((m) => ({ label: m.label, message: m.message })) ?? [],
      engineProblems: l.engine?.result.problems ?? [],
    })),
  });
  if (blockers.length) {
    return { error: `Chưa đủ căn cứ để chốt kỳ này:\n· ${blockers.map((b) => b.message).join("\n· ")}` };
  }

  const snapshot = buildPayrollSnapshot(report, period, key);
  const luc = new Date();
  /** Các dòng sổ lỗ sẽ ghi cùng lượt chốt — rỗng khi sổ không áp dụng cho kỳ này. */
  const soLo = report.lines
    .filter((l) => l.carry && l.carry.openingEstablished && l.carry.closingBalance !== null)
    .map((l) => {
      const c = l.carry!;
      return {
        employeeId: l.employee.id,
        monthKey: c.monthKey,
        // Đường tính cũ có đúng một khoản bù lỗ; khoá thành phần của nó là hằng số này.
        componentCode: LEGACY_CARRY_COMPONENT,
        openingBalance: c.openingBalance ?? 0,
        openingSource: c.openingBasis === "OPENING_DECLARATION" ? "OPENING_DECLARATION" : "PREV_MONTH",
        realProfit: c.realProfit ?? 0,
        lossApplied: c.lossApplied ?? 0,
        commissionBase: c.commissionBase ?? 0,
        commissionRateBp: rateToBp(l.employee.percentPersonal),
        signedCommission: c.signedCommission ?? 0,
        payableCommission: l.bonusPersonal ?? 0,
        closingBalance: c.closingBalance ?? 0,
        // Ghi NHÁP: nghĩa vụ chỉ thành chính thức khi kỳ được KHOÁ (xem `lib/actions/payroll-run.ts`).
        status: "DRAFT" as const,
        snapshot: {
          nhanSu: { id: l.employee.id, ten: l.employee.name, tenNgan: l.employee.shortName },
          tyLeCaNhanLucChot: l.employee.percentPersonal,
          canCuSoDu: c.openingBasis,
          lyDoSoDu: c.openingReason,
          kyLuong: key,
          coSo: basis,
        },
        calcVersion: PAYROLL_CALC_VERSION,
        note,
        // `finalizedAt`/`finalizedBy` để TRỐNG ở bước tính: chúng là dấu vết của lượt KHOÁ, và
        // điền sẵn là khai rằng ai đó đã chốt trong khi chưa ai chốt.
        createdBy: user.id,
      };
    });

  /*
    ═══ MỘT GIAO DỊCH, MỘT KHOÁ TÊN — KHÔNG PHẢI HAI THAO TÁC RỜI ═══

    Kiểm chồng lấn rồi INSERT là HAI lượt đi CSDL. Hai yêu cầu chốt gửi cùng lúc thì cả hai cùng
    đọc "chưa có kỳ nào chồng lấn", rồi cả hai cùng ghi — ra hai kỳ FINAL phủ lên nhau, và cộng
    chúng lại là trả lương hai lần cho những ngày nằm trong cả hai. Khoá tự nhiên (period_key,
    basis) KHÔNG chặn được: hai khoá khác nhau.

    Khoá một DÒNG cũng không cứu được, vì dòng cần khoá là dòng CHƯA TỒN TẠI. Nên dùng khoá TÊN
    (`pg_advisory_xact_lock`): nó khoá một cái tên chứ không khoá một dòng, tự nhả khi giao dịch
    kết thúc, và không cần thêm extension nào (`btree_gist` cho ràng buộc loại trừ khoảng thời gian
    không chắc có trên mọi môi trường).

    Mọi lượt chốt đi qua CÙNG một tên nên chúng xếp hàng. Chốt lương là việc mỗi tháng một lần —
    xếp hàng ở đây không tốn gì.
  */
  const ketQua = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('erp:payroll-period-finalize'))`);

    /*
      HAI KỲ ĐÃ CHỐT KHÔNG ĐƯỢC CHỒNG LẤN NGÀY.

      Chốt "Tháng này" ngày 14 ra khoá `2026-09-01..2026-09-14`; chốt lại ngày 30 ra
      `2026-09-01..2026-09-30`. Hai khoá khác nhau nên khoá tự nhiên không chặn — nhưng mười bốn
      ngày đầu tháng nằm trong CẢ HAI. Kiểm TRONG giao dịch, sau khi đã cầm khoá.
    */
    const chongLan = await tx
      .select({ periodKey: p.periodKey, basis: p.basis })
      .from(p)
      // Chỉ kỳ ĐÃ ĐÓNG BĂNG mới chặn: hai bản NHÁP chồng lấn là chuyện bình thường khi đang thử
      // các mốc kỳ khác nhau, và chặn chúng là chặn chính việc soát.
      .where(and(inArray(p.status, ["FINAL", "LOCKED", "PAID"]), lte(p.periodStart, toAt), gte(p.periodEnd, fromAt)));
    const trung = chongLan.find((k) => k.basis === basis);
    if (trung) {
      return {
        error: `Kỳ ${from} → ${to} chồng lấn ngày với kỳ ĐÃ KHOÁ ${trung.periodKey} (cùng cơ sở ${PAYROLL_BASIS_SHORT[basis]}). Chốt tiếp là trả lương hai lần cho những ngày nằm trong cả hai kỳ.`,
      } as const;
    }

    await tx
      .insert(p)
      .values({
        periodKey: key,
        periodStart: fromAt,
        periodEnd: toAt,
        basis,
        status: "CALCULATED",
        snapshot,
        calcVersion: PAYROLL_CALC_VERSION,
        note,
        finalizedAt: luc,
        finalizedBy: user.id,
        createdBy: user.id,
        calcRuns: 1,
      })
      .onConflictDoUpdate({
        target: [p.periodKey, p.basis],
        // Chỉ nâng một dòng NHÁP lên FINAL. Mệnh đề `where` là lớp chặn thứ hai ngay tại CSDL.
        set: {
          status: "CALCULATED",
          snapshot,
          calcVersion: PAYROLL_CALC_VERSION,
          note,
          finalizedAt: luc,
          finalizedBy: user.id,
          updatedAt: luc,
          // Đếm số lượt tính lại: một kỳ tính lại năm lần trước khi duyệt là tín hiệu đáng đọc.
          calcRuns: sql`${p.calcRuns} + 1`,
        },
        // Ghi đè được ở mọi trạng thái CÒN SỬA ĐƯỢC — đó chính là lý do bốn trạng thái ấy tồn tại.
        // `LOCKED`/`PAID`/`FINAL` bị chặn từ trước khi vào giao dịch, và bị chặn lại ở đây.
        setWhere: inArray(p.status, ["DRAFT", "CALCULATED", "UNDER_REVIEW", "APPROVED"]),
      });

    /*
      SỐ DƯ MỚI GHI CÙNG LƯỢT CHỐT, TRONG CÙNG GIAO DỊCH.

      Không có phần này thì không tháng nào bao giờ thành FINAL trong sổ lỗ, nên chuỗi số dư không
      bao giờ tiến: tháng sau mãi mãi đọc "tháng trước mới là nháp" và mãi mãi không chốt được.

      `setWhere` chặn đúng chuyện hai yêu cầu cùng dùng một số dư cũ để ghi hai kết quả: dòng đã
      FINAL không bị lượt thứ hai ghi đè.
    */
    if (soLo.length) {
      const c = schema.marketerProfitCarryover;
      for (const dong of soLo) {
        await tx
          .insert(c)
          .values(dong)
          .onConflictDoUpdate({
            target: [c.employeeId, c.monthKey, c.componentCode],
            set: { ...dong, updatedAt: luc },
            setWhere: eq(c.status, "DRAFT"),
          });
      }
    }
    return { ok: true } as const;
  });
  // Suy kiểu của drizzle làm nhánh lỗi mang `string | undefined`; kiểm cả hai để không lọt một
  // chuỗi rỗng thành "chốt thành công".
  if ("error" in ketQua && ketQua.error) return { error: ketQua.error };

  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "PAYROLL_PERIOD_CALCULATE",
    entity: "PAYROLL_PERIOD",
    entityId: `${key}:${basis}`,
    detail: { key, basis, calcVersion: PAYROLL_CALC_VERSION, totalSalary: report.totalSalary, totalProfit: report.totalProfit, people: report.lines.length, soLoGhi: soLo.length, note },
  });
  revalidatePath("/payroll");
  return { ok: true, key };
}
