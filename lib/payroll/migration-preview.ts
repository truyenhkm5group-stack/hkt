/**
 * ═══════════ XEM TRƯỚC CHUYỂN MỘT NGƯỜI SANG MÁY TÍNH CHUNG ═══════════
 *
 * ─── VÌ SAO KHÔNG TỰ CHUYỂN ───
 *
 * Bốn ô trên hồ sơ nhân sự cũ (lương cứng · % LN tổng · % LN cá nhân · % doanh thu) ÁNH XẠ ĐƯỢC
 * sang bốn thành phần của máy chung. Việc ấy dễ tới mức cám dỗ: chạy một vòng lặp, sinh chính sách
 * cho tất cả, xong.
 *
 * Nhưng ánh xạ ĐÚNG VỀ HÌNH DẠNG không có nghĩa là đúng về TIỀN. Hai chỗ lệch, và cả hai đều là
 * quyết định kinh doanh chứ không phải chi tiết kỹ thuật:
 *
 *  1. **Bù lỗ lũy kế.** Đường cũ chỉ bù lỗ khi chủ shop đã bật sổ; máy chung bù lỗ khi thành phần
 *     khai `carryForward`. Bật hộ là đổi cách tính tiền của người thật.
 *  2. **Thưởng theo % lợi nhuận TOÀN SHOP.** Ở đường cũ nó luôn `max(LN, 0) × %`; ở máy chung nó
 *     là một thành phần tính trên `PROFIT_SHOP` và có thể khai bù lỗ, trần, sàn, làm tròn khác.
 *
 * Nên hàm này chỉ ĐỀ XUẤT và SO SÁNH. Người bấm quyết.
 *
 * Hàm THUẦN: nhận vào hồ sơ cũ và kết quả đã tính, trả ra bản đề xuất + bảng đối chiếu. Không đọc
 * CSDL, không ghi gì.
 */
import type { Employee } from "@/lib/constants/payroll";
import { defaultProrate, type PolicyComponent } from "@/lib/constants/payroll-components";

/** Khoá thành phần sinh ra từ mỗi ô cũ. Ổn định — phiếu lương và sổ lỗ lưu chúng. */
export const LEGACY_COMPONENT_CODES = {
  fixed: "BASE_SALARY",
  percentTotal: "SHOP_PROFIT_SHARE",
  percentPersonal: "PERSONAL_PROFIT_COMMISSION",
  percentRevenue: "REVENUE_COMMISSION",
} as const;

export type MigrationProposal = {
  employeeId: string;
  employeeName: string;
  /** Mã chính sách đề xuất — dẫn xuất từ khoá nhân sự nên nó ổn định và gõ lại được. */
  policyCode: string;
  policyName: string;
  components: PolicyComponent[];
  /**
   * Vì sao người này CHƯA chuyển được. Rỗng = chuyển được.
   * Đây là danh sách việc phải làm, không phải một lời từ chối.
   */
  blockers: string[];
  /** Điều người bấm phải biết trước khi bấm, dù không chặn. */
  notes: string[];
};

/**
 * ĐỀ XUẤT MỘT CHÍNH SÁCH TỪ BỐN Ô CŨ.
 *
 * Ô nào bằng 0 thì KHÔNG sinh thành phần: một thành phần khai 0 sẽ bị cổng chặn hỏi lại mãi, và
 * nó cũng không nói thêm được gì so với việc không có thành phần nào.
 */
export function proposePolicyFromLegacy(e: Employee, carryoverEnabled: boolean): MigrationProposal {
  const components: PolicyComponent[] = [];
  const notes: string[] = [];
  const blockers: string[] = [];

  const fixed = Math.max(0, Math.round(Number(e.fixed) || 0));
  if (fixed > 0) {
    components.push({
      code: LEGACY_COMPONENT_CODES.fixed,
      label: "Lương cứng",
      kind: "FIXED",
      calc: { type: "FIXED_AMOUNT", amount: fixed },
      // Đường cũ chia lương tháng theo số ngày của kỳ (`prorateMonthlyAmount`). Giữ nguyên luật ấy
      // là điều kiện để con số không đổi.
      prorate: defaultProrate("FIXED"),
      rounding: "ROUND",
      minAmount: null,
      maxAmount: null,
      carryForward: false,
      sortOrder: 10,
      note: "Sinh từ ô “Lương cứng” trên hồ sơ nhân sự cũ.",
    });
  }

  if (e.percentTotal > 0) {
    components.push({
      code: LEGACY_COMPONENT_CODES.percentTotal,
      label: "Thưởng % lợi nhuận toàn shop",
      kind: "PROFIT_SHARE",
      calc: { type: "RATE_OF_BASIS", basisKey: "PROFIT_SHOP", ratePercent: e.percentTotal },
      prorate: "NONE",
      rounding: "ROUND",
      minAmount: null,
      maxAmount: null,
      // Đường cũ KHÔNG bù lỗ cho khoản này — nó luôn `max(LN toàn shop, 0) × %`. Bật hộ là đổi
      // cách tính tiền, nên để tắt và nói ra.
      carryForward: false,
      sortOrder: 20,
      note: "Sinh từ ô “% lợi nhuận tổng”. Đường cũ không bù lỗ cho khoản này.",
    });
  }

  if (e.percentPersonal > 0) {
    components.push({
      code: LEGACY_COMPONENT_CODES.percentPersonal,
      label: "Hoa hồng % lợi nhuận cá nhân",
      kind: "COMMISSION",
      calc: { type: "RATE_OF_BASIS", basisKey: "PROFIT_PERSONAL", ratePercent: e.percentPersonal },
      prorate: "NONE",
      rounding: "ROUND",
      minAmount: null,
      maxAmount: null,
      /*
        BÙ LỖ BẬT ĐÚNG BẰNG TRẠNG THÁI HIỆN TẠI CỦA SỔ.

        Đây là chỗ dễ làm sai số tiền nhất trong cả phép chuyển: sổ đang bật mà thành phần khai
        tắt thì người ấy bỗng ăn hoa hồng trên đủ lợi nhuận như chưa từng lỗ; sổ đang tắt mà khai
        bật thì ngược lại. Nên nó CHÉP trạng thái hiện tại, không đoán.
      */
      carryForward: carryoverEnabled,
      sortOrder: 30,
      note: carryoverEnabled
        ? "Sinh từ ô “% lợi nhuận cá nhân”. Bù lỗ lũy kế BẬT — đúng bằng trạng thái sổ lỗ hiện tại."
        : "Sinh từ ô “% lợi nhuận cá nhân”. Bù lỗ lũy kế TẮT — đúng bằng trạng thái sổ lỗ hiện tại.",
    });
    if (!carryoverEnabled) {
      notes.push("Sổ lỗ lũy kế đang TẮT nên thành phần hoa hồng cũng khai tắt bù lỗ. Bật nó là một quyết định riêng, và nó sẽ đổi số tiền.");
    }
  }

  if (e.percentRevenue > 0) {
    components.push({
      code: LEGACY_COMPONENT_CODES.percentRevenue,
      label: "Hoa hồng % doanh thu cá nhân",
      kind: "COMMISSION",
      calc: { type: "RATE_OF_BASIS", basisKey: "REVENUE_PERSONAL", ratePercent: e.percentRevenue },
      prorate: "NONE",
      rounding: "ROUND",
      minAmount: null,
      maxAmount: null,
      carryForward: false,
      sortOrder: 40,
      note: "Sinh từ ô “% doanh thu cá nhân”.",
    });
  }

  if (!components.length) {
    blockers.push(
      `${e.shortName || e.name} chưa khai ô nào trên hồ sơ nhân sự cũ (lương cứng và cả ba tỷ lệ đều bằng 0), nên không có gì để ánh xạ. Khai chính sách tay ở tab “Chính sách lương”.`,
    );
  }

  return {
    employeeId: e.id,
    employeeName: e.shortName || e.name,
    // Khoá nhân sự là UUID; lấy 8 ký tự đầu, viết hoa, cho mã đọc được mà vẫn không đụng nhau.
    policyCode: `LEGACY_${e.id.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8).toUpperCase()}`,
    policyName: `${e.shortName || e.name} — chuyển từ hồ sơ cũ`,
    components,
    blockers,
    notes,
  };
}

/** Một dòng đối chiếu CŨ vs MỚI. `null` ở một bên = chưa biết, không so được. */
export type ReconLine = {
  key: string;
  label: string;
  old: number | null;
  next: number | null;
  diff: number | null;
  /** Vì sao lệch. Rỗng khi không lệch. */
  explanation: string;
  /** Lệch có GIẢI THÍCH ĐƯỢC không. `false` ⇒ không được kích hoạt chính sách. */
  explained: boolean;
};

export type ReconResult = {
  employeeId: string;
  employeeName: string;
  lines: ReconLine[];
  /** Tổng lệch ở dòng NET. `null` = một bên chưa biết. */
  netDiff: number | null;
  /** Có lệch nào CHƯA giải thích được không — điều kiện chặn kích hoạt. */
  hasUnexplained: boolean;
};

/**
 * ═══ ĐỐI CHIẾU TỪNG KHOẢN, KHÔNG CHỈ TỔNG ═══
 *
 * Hai tổng bằng nhau KHÔNG có nghĩa là đúng: một khoản thừa và một khoản thiếu bằng nhau sẽ triệt
 * tiêu, và bảng vẫn xanh. Nên so theo TỪNG khoản.
 *
 * Mỗi lệch phải mang một câu giải thích. Lệch không giải thích được là điều kiện CHẶN — đúng theo
 * yêu cầu: không kích hoạt chính sách khi còn chênh chưa rõ nguyên nhân, trừ khi đó là một sửa
 * đúng có chủ ý và được ghi rõ.
 */
export function reconcile(input: {
  employeeId: string;
  employeeName: string;
  old: { fixed: number | null; bonusTotal: number; bonusPersonal: number | null; bonusRevenue: number; salary: number | null };
  next: { components: readonly { code: string; amount: number | null }[]; grossEarnings: number | null; totalDeductions: number | null; netPay: number | null };
  /** Khoản điều chỉnh tay của kỳ — chúng KHÔNG có ở đường cũ nên lệch do chúng là giải thích được. */
  adjustmentTotal: number;
}): ReconResult {
  /*
    KHÔNG CÓ THÀNH PHẦN ẤY ≠ CHƯA BIẾT SỐ CỦA NÓ.

    Bản đề xuất KHÔNG sinh thành phần cho ô cũ bằng 0 (một thành phần khai 0 sẽ bị cổng chặn hỏi
    lại mãi). Nên "chính sách không có khoản này" là câu trả lời ĐÃ BIẾT, và nó bằng 0 — trong khi
    "khoản này có nhưng chưa tính được" mới là CHƯA BIẾT.

    Gộp hai thứ ấy vào một `null` làm mọi dòng khớp-ở-mức-0 bị đánh dấu là chưa giải thích được, và
    rồi không ai chuyển được ai.
  */
  const lay = (code: string): number | null => {
    const c = input.next.components.find((x) => x.code === code);
    return c ? c.amount : 0;
  };
  const so = (key: string, label: string, old: number | null, next: number | null, explain: (d: number) => { text: string; ok: boolean }): ReconLine => {
    if (old === null || next === null) {
      return {
        key,
        label,
        old,
        next,
        diff: null,
        explanation: "Một bên CHƯA BIẾT nên không so được. Chưa biết khác hẳn bằng 0 — đừng đọc dòng này là “không lệch”.",
        explained: false,
      };
    }
    const d = next - old;
    if (d === 0) return { key, label, old, next, diff: 0, explanation: "", explained: true };
    const e = explain(d);
    return { key, label, old, next, diff: d, explanation: e.text, explained: e.ok };
  };

  const lines: ReconLine[] = [
    so("base", "Lương cứng", input.old.fixed, lay(LEGACY_COMPONENT_CODES.fixed), (d) => ({
      text: `Lệch ${d.toLocaleString("vi-VN")} ₫. Cả hai đường đều chia lương tháng theo số ngày của kỳ bằng CÙNG một hàm (\`prorateMonthlyAmount\`), nên lệch ở đây KHÔNG giải thích được bằng cách làm tròn — nhiều khả năng mốc hiệu lực của phân công không phủ trọn kỳ.`,
      ok: false,
    })),
    so("shopProfit", "Thưởng % lợi nhuận toàn shop", input.old.bonusTotal, lay(LEGACY_COMPONENT_CODES.percentTotal), (d) => ({
      text: `Lệch ${d.toLocaleString("vi-VN")} ₫ — kiểm lại tỷ lệ khai trong chính sách so với ô “% lợi nhuận tổng” cũ.`,
      ok: false,
    })),
    so("personalProfit", "Hoa hồng % lợi nhuận cá nhân", input.old.bonusPersonal, lay(LEGACY_COMPONENT_CODES.percentPersonal), (d) => ({
      text: `Lệch ${d.toLocaleString("vi-VN")} ₫. Nguyên nhân thường gặp: thành phần khai bù lỗ lũy kế khác với trạng thái sổ lỗ hiện tại, hoặc tỷ lệ khai khác.`,
      ok: false,
    })),
    so("revenue", "Hoa hồng % doanh thu cá nhân", input.old.bonusRevenue, lay(LEGACY_COMPONENT_CODES.percentRevenue), (d) => ({
      text: `Lệch ${d.toLocaleString("vi-VN")} ₫ — kiểm lại tỷ lệ khai trong chính sách.`,
      ok: false,
    })),
  ];

  /*
    KHOẢN ĐIỀU CHỈNH LÀ LỆCH GIẢI THÍCH ĐƯỢC.

    Đường cũ không có chỗ nào để ghi thưởng nóng hay tạm ứng, nên chúng CHỈ xuất hiện ở đường mới.
    Đây là lệch có chủ ý — một tính năng mới, không phải một sai số.
  */
  lines.push(
    so("net", "Thực nhận", input.old.salary, input.next.netPay, (d) => {
      const conLai = d - input.adjustmentTotal;
      if (conLai === 0) {
        return {
          text: `Lệch ${d.toLocaleString("vi-VN")} ₫, và đúng bằng tổng khoản điều chỉnh tay của kỳ (${input.adjustmentTotal.toLocaleString("vi-VN")} ₫). Đường cũ không có chỗ nào ghi thưởng nóng / tạm ứng, nên đây là lệch CÓ CHỦ Ý: một tính năng mới, không phải một sai số.`,
          ok: true,
        };
      }
      return {
        text: `Lệch ${d.toLocaleString("vi-VN")} ₫; khoản điều chỉnh tay giải thích được ${input.adjustmentTotal.toLocaleString("vi-VN")} ₫, còn ${conLai.toLocaleString("vi-VN")} ₫ CHƯA rõ nguyên nhân. Xem các dòng trên để biết khoản nào lệch.`,
        ok: false,
      };
    }),
  );

  const net = lines.find((l) => l.key === "net")!;
  return {
    employeeId: input.employeeId,
    employeeName: input.employeeName,
    lines,
    netDiff: net.diff,
    hasUnexplained: lines.some((l) => !l.explained && (l.diff === null || l.diff !== 0)),
  };
}
