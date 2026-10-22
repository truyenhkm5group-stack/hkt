/**
 * ═══════════ LÕI CỦA HAI VIỆC "TÍNH KỲ" VÀ "CHUYỂN TRẠNG THÁI KỲ" — MỘT ĐƯỜNG CHO NGƯỜI VÀ MÁY ═══════════
 *
 * ─── VÌ SAO TÁCH RA KHỎI SERVER ACTION ───
 *
 * Lương tự động (`lib/payroll/autopilot.ts`) phải TÍNH kỳ và GỬI phiếu mà không có ai bấm. Nó có
 * hai lựa chọn: viết lại phép tính + bảng chuyển trạng thái lần thứ hai (và hai bản sẽ trôi xa nhau —
 * không phải có thể, mà sớm muộn), hoặc đi CÙNG đường với người. Tệp này là đường chung ấy.
 *
 * Ranh giới được giữ nguyên, chỉ dời chỗ:
 *   · Server Action (`lib/actions/payroll-period.ts`, `lib/actions/payroll-run.ts`) giữ QUYỀN, LÝ DO
 *     bắt buộc và CỔNG NGƯỜI THỨ HAI — những thứ chỉ có nghĩa khi có một người đang bấm.
 *   · Tệp này giữ PHÉP TÍNH, KHOÁ TÊN, ĐỌC LẠI TRONG KHOÁ, BẢNG CHUYỂN TRẠNG THÁI và NHẬT KÝ.
 *
 * Tệp này KHÔNG phải "use server": hàm ở đây không kiểm quyền, nên nó KHÔNG ĐƯỢC gọi thẳng được từ
 * trình duyệt. Chỉ server action (đã kiểm quyền) và job (đã xác thực bằng bí mật cron) gọi vào.
 *
 * ─── MÁY ĐƯỢC LÀM GÌ ───
 *
 * `actor.id = null` là MÁY (AGENTS.md mục 34 — khác hẳn "chưa biết ai"). Máy chỉ được đi hai bước
 * không làm đổi một đồng nào đã trả: TÍNH và CHUYỂN SOÁT (`MACHINE_RUN_ACTIONS`). Duyệt, khoá, mở khoá
 * là chữ ký — máy không ký thay ai. Bước "đã trả" của máy đi đường riêng, bằng CHỨNG TỪ NGÂN HÀNG
 * (`lib/payroll/payout.ts::completePaidPeriods`), không đi qua `MARK_PAID` vốn là một lời khẳng định.
 */
import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import type { GuardInput, GuardResult } from "@/lib/approvals/service";
import {
  PAYROLL_BASIS_ELIGIBILITY,
  PAYROLL_BASIS_SHORT,
  PAYROLL_CALC_VERSION,
  payrollPeriodKey,
  type PayrollBasis,
} from "@/lib/constants/payroll";
import { vnEndOfDay, vnStartOfDay } from "@/lib/format";
import { getPayrollReport, profitGateReadiness } from "@/lib/queries/payroll";
import { getMonthReconciliation, parseSignoffs } from "@/lib/queries/payroll-reconciliation";
import { profitApprovalProblem, reconFingerprintKey, signableFingerprint } from "@/lib/payroll/profit-reconciliation";
import { isOrgOwner } from "@/lib/auth/org-owner";
import { OWNER_SELF_APPROVAL_REASON } from "@/lib/constants/org-owner";
import { PAYROLL_PROFIT_SIGNOFF_KEY } from "@/lib/constants/payroll-reconciliation";
import { LEGACY_CARRY_COMPONENT, monthKeyOf, rateToBp, wholeMonthKey } from "@/lib/constants/payroll-carryover";
import { getProfitGateConfig } from "@/lib/queries/payroll-profit-gate";
import { PAYROLL_PROFIT_GATE_KEY } from "@/lib/constants/payroll-profit-gate";
import type { PayrollSnapshot } from "@/lib/queries/payroll-period";
import { payrollFinalizeBlockers } from "@/lib/constants/payroll-readiness";
import { PAYROLL_ACTION_SPEC, canTransition, isFrozen, normalizePayrollStatus, type PayrollRunAction } from "@/lib/constants/payroll-lifecycle";
import { buildPayrollSnapshot } from "@/lib/queries/payroll-period";
import { validatePolicyBookForPeriod } from "@/lib/queries/payroll-policies";
import { deliverPayslips } from "@/lib/payroll/payslip-delivery";
import { ensurePayoutLines } from "@/lib/payroll/payout";
import type { Period } from "@/lib/search-params";

/** Ai làm. `id: null` = MÁY; `email` là chuỗi đi vào nhật ký (`job:payroll-autopilot` với máy). */
export type PayrollActor = { id: string | null; email: string };

/** Hai bước máy được tự đi — không bước nào làm đổi một đồng đã trả, không bước nào là chữ ký. */
export const MACHINE_RUN_ACTIONS: readonly PayrollRunAction[] = ["CALCULATE", "SUBMIT_REVIEW"];

export type PeriodActionResult = { ok: true; key: string } | { error: string };
export type RunActionResult = { ok: true; status: string; sideEffects: string[] } | { error: string };

export type CalculateInput = { from: string; to: string; basis: PayrollBasis; note: string };

/**
 * TÍNH & CHỤP ẢNH MỘT KỲ (→ `CALCULATED`). Toàn bộ luật nằm ở chú thích của
 * `lib/actions/payroll-period.ts::finalizePayrollPeriod` — hàm ấy nay chỉ kiểm quyền rồi gọi vào đây.
 */
export async function calculatePayrollPeriodAs(actor: PayrollActor, input: CalculateInput): Promise<PeriodActionResult> {
  const { from, to, basis, note } = input;
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
    // Cùng phép kiểm mà màn hình dùng — hai nơi không thể nói hai điều khác nhau về một sổ khai.
    policyIssues: await validatePolicyBookForPeriod(
      fromAt,
      toAt,
      report.lines.map((l) => ({ id: l.employee.id, name: l.employee.shortName || l.employee.name })),
    ),
    profitGate: profitGateReadiness(report),
  });
  if (blockers.length) {
    return { error: `Chưa đủ căn cứ để chốt kỳ này:\n· ${blockers.map((b) => b.message).join("\n· ")}` };
  }

  const snapshot = buildPayrollSnapshot(report, period, key);
  /*
    ẢNH CHỤP MANG BẢNG ĐỐI SOÁT CỦA THÁNG (Payroll V2 vận hành, `docs/payroll-code-ledger.md` §9.3).
    Chữ ký cấp 1 ký ĐÚNG bảng này — không ký số sống, vì số sống đổi theo từng webhook và ký → tính →
    duyệt sẽ không bao giờ khớp. Tính kỳ KHÔNG bị chặn ở đây: chặn nằm ở bước DUYỆT / KHOÁ, và chỉ khi
    kỳ có thưởng % lợi nhuận đủ điều kiện > 0.
  */
  const thangKy = basis === "profit1" ? wholeMonthKey(fromAt, toAt) : null;
  if (thangKy) {
    try {
      const rc = await getMonthReconciliation(thangKy, { report });
      const fp = signableFingerprint(rc.fingerprint, report.profitGate.result);
      snapshot.profitRecon = {
        status: rc.status,
        fingerprint: fp,
        fingerprintKey: reconFingerprintKey(fp),
        issues: rc.issues.map((i) => ({ code: i.code, label: i.label, amount: i.amount, count: i.count })),
        lines: rc.lines.map((l) => ({ key: l.key, label: l.label, basis: l.basis, source: l.source, diff: l.diff, status: l.status, cls: l.cls, note: l.note })),
        coverage: rc.coverage,
        classes: rc.classes,
        codes: rc.codes,
      };
    } catch (e) {
      /*
        Chỉ CHẶN khi tháng có thưởng % lợi nhuận đủ điều kiện (review vòng 2): tháng không có khoản nào thì
        bước duyệt không cần bảng này, và giữ lương cứng của cả công ty vì một truy vấn đối soát hết giờ là
        đúng thứ luật 78 cấm. Ảnh chụp khi ấy không mang bảng — duyệt vẫn qua vì không có gì phải ký.
      */
      if ((report.profitGate.result.allocatedTotal ?? 0) > 0) {
        return { error: `Không dựng được bảng đối soát lợi nhuận tháng ${thangKy} — tháng có thưởng % lợi nhuận đủ điều kiện nên phải có bảng: ${e instanceof Error ? e.message : String(e)}` };
      }
    }
  }
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
        // Tiền hoa hồng PHẢI TRẢ là phần ĐỦ ĐIỀU KIỆN qua cổng lợi nhuận toàn công ty, không phải số
        // tạm tính — sổ ghi đúng con số đi vào phiếu lương.
        payableCommission: l.profitShare.claims.find((c) => c.key === `${l.employee.id}:PERSONAL`)?.eligible ?? 0,
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
        createdBy: actor.id,
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
        finalizedBy: actor.id,
        createdBy: actor.id,
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
          finalizedBy: actor.id,
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
    userId: actor.id,
    userEmail: actor.email,
    action: "PAYROLL_PERIOD_CALCULATE",
    entity: "PAYROLL_PERIOD",
    entityId: `${key}:${basis}`,
    detail: { key, basis, calcVersion: PAYROLL_CALC_VERSION, totalSalary: report.totalSalary, totalProfit: report.totalProfit, people: report.lines.length, soLoGhi: soLo.length, note },
  });
  return { ok: true, key };
}

export type TransitionInput = { periodKey: string; basis: PayrollBasis; action: PayrollRunAction; reason: string };

/**
 * CHUYỂN TRẠNG THÁI MỘT KỲ — khoá tên, đọc lại trong khoá, bảng chuyển trạng thái, nhật ký.
 *
 * Quyền, lý do bắt buộc và cổng người thứ hai đã được server action kiểm TRƯỚC khi gọi vào đây. Máy
 * (`actor.id = null`) chỉ được đi `MACHINE_RUN_ACTIONS` — chặn ở chính cửa này, không dựa vào việc
 * nơi gọi nhớ.
 *
 * VIỆC ĐI KÈM SAU KHI CHUYỂN (ngoài giao dịch, lỗi không huỷ lượt chuyển nhưng được BÁO RA):
 *   · `SUBMIT_REVIEW` → gửi phiếu lương vào hộp thư từng người (`deliverPayslips`);
 *   · `LOCK`          → lập lệnh chuyển lương từ ảnh chụp (`ensurePayoutLines`).
 */
export async function transitionPayrollRunAs(actor: PayrollActor, input: TransitionInput): Promise<RunActionResult> {
  const { periodKey, basis, action, reason } = input;
  const spec = PAYROLL_ACTION_SPEC[action];
  if (actor.id === null && !MACHINE_RUN_ACTIONS.includes(action)) {
    return { error: `Máy không được tự làm việc “${spec.label}” — đó là chữ ký của người.` };
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
  /*
    MỞ KHOÁ ĐI TỪ THÁNG KHOÁ MỚI NHẤT TRỞ VỀ (cổng lỗ lũy kế, `docs/payroll-profit-gate.md` §5).

    Lũy kế toàn công ty là một CHUỖI: tháng sau đã khoá đứng trên số dư cuối của tháng này. Mở khoá
    rồi tính lại tháng này khi tháng sau vẫn khoá là đổi nền dưới chân một kỳ đã chốt — và một điều
    chỉnh lũy kế đã ghi ở tháng sau cho chứng từ của tháng này sẽ bị đếm hai lần.
  */
  /*
    DUYỆT / KHOÁ PHẢI KÝ TRÊN ĐÚNG TẬP ĐIỀU CHỈNH LŨY KẾ (review độc lập vòng 5).

    Ảnh chụp dựng lúc TÍNH; khoá chỉ đóng băng ảnh ấy. Một điều chỉnh ghi vào tháng này SAU lần tính
    (thường là lúc soát — đúng lúc người ta phát hiện chứng từ muộn) không có trong ảnh, và khi tháng
    đã khoá thì sổ thôi đọc cấu hình cho nó: khoản ấy biến mất im lặng. Nên tập mã điều chỉnh trong
    ảnh phải BẰNG tập trong sổ, không thì bắt tính lại trước.
  */
  const thangCong = basis === "profit1" ? wholeMonthKey(row.periodStart, row.periodEnd) : null;
  if (action === "UNLOCK" && basis === "profit1") {
    const [sau] = await db
      .select({ periodKey: p.periodKey })
      .from(p)
      .where(and(eq(p.basis, "profit1"), inArray(p.status, ["LOCKED", "PAID", "FINAL"]), sql`${p.periodStart} > ${row.periodEnd}`))
      .limit(1);
    if (sau) return { error: `Kỳ sau (${sau.periodKey}) đã khoá. Lũy kế lợi nhuận toàn công ty là một chuỗi theo tháng — mở khoá kỳ mới nhất trước rồi mới tới kỳ này.` };
    /*
      ĐIỀU CHỈNH LŨY KẾ VỀ CHÍNH THÁNG NÀY đang chờ ở một tháng còn mở (review độc lập vòng 6): mở khoá
      rồi tính lại tháng này thì bản tính mới đã gồm chứng từ ấy, và tháng ghi vẫn cộng điều chỉnh —
      đếm hai lần. Muốn mở khoá thì ghi một dòng NGƯỢC DẤU trước để tổng chờ về 0.
    */
    if (thangCong) {
      const cho = (await getProfitGateConfig()).adjustments.filter((a) => a.aboutMonth === thangCong).reduce((t, a) => t + (Number(a.amount) || 0), 0);
      if (cho !== 0) {
        return { error: `Đang có điều chỉnh lũy kế ${cho.toLocaleString("vi-VN")} ₫ về chứng từ của tháng ${thangCong}, ghi ở một tháng còn mở. Mở khoá rồi tính lại tháng ${thangCong} sẽ đếm chứng từ ấy hai lần — ghi một dòng ngược dấu (Lương → Cấu hình) trước.` };
      }
    }
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
      DUYỆT / KHOÁ PHẢI KÝ TRÊN ĐÚNG TẬP ĐIỀU CHỈNH LŨY KẾ (review độc lập vòng 5–6).

      Ảnh chụp dựng lúc TÍNH; khoá chỉ đóng băng ảnh ấy. Một điều chỉnh ghi vào tháng này SAU lần tính
      (thường là lúc soát) không có trong ảnh, và khi tháng đã khoá thì sổ thôi đọc cấu hình cho nó:
      khoản ấy biến mất im lặng. Nên tập mã trong ảnh phải BẰNG tập trong sổ. Kiểm TRONG giao dịch, dưới
      CÙNG khoá tên với lượt ghi sổ (`ghiSoCong`) — kiểm ở ngoài thì một điều chỉnh lọt vào giữa lượt
      kiểm và lượt khoá. Thứ tự khoá cố định (kỳ lương → sổ cổng) nên không tự khoá chéo.
    */
    if ((action === "APPROVE" || action === "LOCK") && thangCong) {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('erp:payroll-profit-gate'))`);
      const [cfgRow] = await tx.select({ value: schema.settings.value }).from(schema.settings).where(eq(schema.settings.key, PAYROLL_PROFIT_GATE_KEY)).limit(1);
      let dieuChinh: { id: string; monthKey: string }[] = [];
      try {
        const raw = cfgRow ? (JSON.parse(cfgRow.value) as { adjustments?: { id: string; monthKey: string }[] }) : {};
        dieuChinh = Array.isArray(raw.adjustments) ? raw.adjustments : [];
      } catch {
        return { error: "Ô cấu hình quy chế chia thưởng không đọc được — không duyệt / khoá trên một sổ không đọc được." } as const;
      }
      const [anhRow] = await tx.select({ snapshot: p.snapshot }).from(p).where(and(eq(p.periodKey, periodKey), eq(p.basis, basis))).limit(1);
      const trongSo = dieuChinh.filter((a) => a.monthKey === thangCong).map((a) => a.id).sort();
      const trongAnh = ((anhRow?.snapshot as PayrollSnapshot | null)?.profitGate?.lateAdjustments ?? []).map((a) => a.id).sort();
      if (trongSo.join(",") !== trongAnh.join(",")) {
        return { error: `Có điều chỉnh lũy kế ghi vào tháng ${thangCong} SAU lần tính gần nhất (sổ ${trongSo.length} dòng, ảnh chụp ${trongAnh.length} dòng). Bấm “Tính lại” để ảnh chụp mang đủ điều chỉnh rồi mới ${spec.label.toLowerCase()}.` } as const;
      }
    }
    /*
      MỞ KHOÁ: kiểm LẠI tổng điều chỉnh đang chờ về tháng này TRONG giao dịch, dưới khoá tên của sổ —
      một điều chỉnh về tháng này lưu đúng lúc người khác mở khoá không được lọt qua (review vòng 7).
    */
    if (action === "UNLOCK" && thangCong) {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('erp:payroll-profit-gate'))`);
      const [cfgRow] = await tx.select({ value: schema.settings.value }).from(schema.settings).where(eq(schema.settings.key, PAYROLL_PROFIT_GATE_KEY)).limit(1);
      let cho = 0;
      try {
        const raw = cfgRow ? (JSON.parse(cfgRow.value) as { adjustments?: { aboutMonth: string | null; amount: number }[] }) : {};
        cho = (Array.isArray(raw.adjustments) ? raw.adjustments : []).filter((a) => a.aboutMonth === thangCong).reduce((t, a) => t + (Number(a.amount) || 0), 0);
      } catch {
        return { error: "Ô cấu hình quy chế chia thưởng không đọc được — không mở khoá trên một sổ không đọc được." } as const;
      }
      if (cho !== 0) {
        return { error: `Đang có điều chỉnh lũy kế ${cho.toLocaleString("vi-VN")} ₫ về chứng từ của tháng ${thangCong}. Ghi một dòng ngược dấu (Lương → Cấu hình) trước khi mở khoá.` } as const;
      }
    }

    /*
      MỘT LƯỢT MỞ KHOÁ PHẢI XOÁ CHỮ KÝ DUYỆT.

      Mở khoá đưa kỳ về `APPROVED`, nhưng chữ ký cũ được ký trên một con số CÓ THỂ SẮP ĐỔI. Giữ
      nguyên `approved_by` là để một người mang tiếng đã duyệt thứ họ chưa từng nhìn thấy. Nên mở
      khoá giữ nguyên mốc duyệt cũ để tra lịch sử, nhưng trạng thái phải đi qua vòng soát lại —
      bảng chuyển trạng thái đã ép điều đó: `APPROVED` chỉ đi tiếp được khi có người bấm `LOCK`.
    */
    let chuShopDuyet = false;
    /*
      DUYỆT HAI CẤP CHO THƯỞNG % LỢI NHUẬN (chủ shop 19/10/2026). Kỳ có thưởng đủ điều kiện > 0 thì:
        · DUYỆT đòi chữ ký cấp 1 CÒN HIỆU LỰC ký đúng ảnh chụp này, và người duyệt KHÁC người ký;
        · KHOÁ đòi chữ ký ấy VẪN còn hiệu lực — huỷ chữ ký sau khi duyệt thì không khoá được.
      Đọc chữ ký TRONG giao dịch (không qua `getDb()` — PGlite một kết nối tự khoá), dưới khoá tên của sổ.
    */
    if ((action === "APPROVE" || action === "LOCK") && thangCong) {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('erp:payroll-profit-signoff'))`);
      const [anh2] = await tx.select({ snapshot: p.snapshot }).from(p).where(and(eq(p.periodKey, periodKey), eq(p.basis, basis))).limit(1);
      const snap = anh2?.snapshot as PayrollSnapshot | null;
      const [soKy] = await tx.select({ value: schema.settings.value }).from(schema.settings).where(eq(schema.settings.key, PAYROLL_PROFIT_SIGNOFF_KEY)).limit(1);
      chuShopDuyet = action === "APPROVE" && (await isOrgOwner(tx, actor.id));
      const loi = profitApprovalProblem({
        allocatedTotal: snap?.profitGate?.allocatedTotal,
        monthKey: thangCong,
        snapshotFingerprint: snap?.profitRecon?.fingerprint,
        signoffs: parseSignoffs(soKy?.value ?? null),
        actorId: actor.id,
        requireDifferentPerson: action === "APPROVE",
        actorIsOwner: chuShopDuyet,
      });
      if (loi) return { error: loi } as const;
    }
    const set: Record<string, unknown> = { status: spec.to, updatedAt: luc, statusReason: spec.requiresReason ? reason : "" };
    if (action === "APPROVE") {
      set.approvedAt = luc;
      set.approvedBy = actor.id;
    }
    /*
      TRẢ LẠI ĐỂ SỬA THÌ CHỮ KÝ DUYỆT PHẢI BIẾN MẤT.

      Giữ `approved_by` trên một kỳ vừa bị trả về là để màn hình in "đã duyệt bởi X" cạnh một con
      số mà chính X vừa nói là sai. Lịch sử của lượt duyệt ấy KHÔNG mất — nó nằm trong nhật ký,
      cùng với lý do trả lại.
    */
    if (action === "REJECT") {
      set.approvedAt = null;
      set.approvedBy = null;
    }
    if (action === "LOCK") {
      set.lockedAt = luc;
      set.lockedBy = actor.id;
    }
    if (action === "UNLOCK") {
      // Giữ `locked_at` cũ để tra được "kỳ này từng khoá lúc nào"; ràng buộc CHECK chỉ đòi nó khi
      // trạng thái là LOCKED/PAID, nên để lại không vi phạm gì.
      set.lockedAt = null;
      set.lockedBy = null;
    }
    if (action === "MARK_PAID") {
      set.paidAt = luc;
      set.paidBy = actor.id;
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
        .set({ status: "FINAL", finalizedAt: luc, finalizedBy: actor.id, updatedAt: luc })
        .where(and(eq(c.monthKey, thangCuaKy), eq(c.status, "DRAFT")));
    }
    if (action === "UNLOCK") {
      await tx
        .update(c)
        .set({ status: "DRAFT", finalizedAt: null, finalizedBy: null, updatedAt: luc })
        .where(and(eq(c.monthKey, thangCuaKy), eq(c.status, "FINAL")));
    }
    return { ok: true, from: now, chuShopDuyet } as const;
  });
  if ("error" in ketQua && ketQua.error) return { error: ketQua.error };

  await audit({
    userId: actor.id,
    userEmail: actor.email,
    action: spec.auditAction,
    entity: "PAYROLL_PERIOD",
    entityId: `${periodKey}:${basis}`,
    before: { status: current },
    after: { status: spec.to },
    reason: ("chuShopDuyet" in ketQua && ketQua.chuShopDuyet ? [reason, OWNER_SELF_APPROVAL_REASON].filter(Boolean).join(" · ") : reason) || undefined,
    detail: { periodKey, basis, action, ...("chuShopDuyet" in ketQua && ketQua.chuShopDuyet ? { ownerSelfApproval: true } : {}) },
  });

  const sideEffects: string[] = [];
  if (action === "SUBMIT_REVIEW") {
    try {
      const r = await deliverPayslips({ periodKey, basis, actor });
      sideEffects.push(r.summary);
    } catch (e) {
      sideEffects.push(`Chưa gửi được phiếu lương: ${e instanceof Error ? e.message : String(e)} — bấm “Gửi lại phiếu” ở trang Trả lương tự động.`);
    }
  }
  if (action === "LOCK") {
    try {
      const r = await ensurePayoutLines({ periodKey, basis, actor });
      sideEffects.push(r.summary);
    } catch (e) {
      sideEffects.push(`Chưa lập được lệnh chuyển: ${e instanceof Error ? e.message : String(e)} — mở trang Trả lương tự động để lập lại.`);
    }
  }
  return { ok: true, status: spec.to, sideEffects };
}

/**
 * CHUYỂN TRẠNG THÁI MỘT KỲ KÈM CÁC KIỂM TRA CỦA NGƯỜI BẤM — lý do bắt buộc · bảng chuyển trạng thái · cổng người
 * thứ hai — rồi vào `transitionPayrollRunAs`. `lib/actions/payroll-run.ts::movePayrollRun` (nút trên màn hình, sau
 * khi kiểm QUYỀN) và `scripts/payroll-owner-apply.ts` (Tech Lead theo ủy quyền chủ shop) đi qua ĐÚNG hàm này.
 */
export async function movePayrollRunAs(actor: PayrollActor, input: TransitionInput, opts: { guard: (input: GuardInput) => Promise<GuardResult> }): Promise<RunActionResult> {
  const { periodKey, basis, action, reason } = input;
  const spec = PAYROLL_ACTION_SPEC[action];
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
    const cong = await opts.guard({
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
  return transitionPayrollRunAs(actor, { periodKey, basis, action, reason });
}
