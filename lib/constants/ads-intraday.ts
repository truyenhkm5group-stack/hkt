/**
 * ═══════════ LÀN NHANH: TĂNG NGÂN SÁCH THEO KHUNG GIỜ ═══════════
 *
 * Chủ shop chốt 24/09/2026: *"cứ ads rẻ, chỉ số tốt là có thể quyết định tăng ngân sách, scale camp
 * theo khung giờ được luôn rồi chứ không phải theo ngày nữa."*
 *
 * ─── VÌ SAO CẦN MỘT LÀN THỨ HAI, KHÔNG SỬA LÀN CŨ ───
 *
 * Làn cũ (sổ quyết định + độ bền) trả lời câu *"chiến dịch này có LÃI THẬT không"* — nên nó đứng trên
 * tiền đã về và đọc kỳ lùi 15 ngày (mô hình bán trước thu tiền sau). Đo production 24/09/2026: sổ bắt
 * đầu ghi 22/09 nên chưa dòng nào kịp "chín" (TĂNG cần giữ 4 ngày), và kết luận hôm nay đứng trên kỳ
 * 27/08 → 09/09 — một chiến dịch chạy từ 05/09 mới được thấy 5 ngày đầu. 586/594 chiến dịch là
 * "chưa đủ dữ liệu". Câu hỏi ấy đúng, nhưng nó không trả lời được câu chủ shop cần lúc 10 giờ sáng:
 * *"chiến dịch này HÔM NAY đang rẻ, có nên bơm thêm ngay không"*.
 *
 * Làn nhanh hỏi đúng câu đó, bằng số của HÔM NAY: chi tiêu (đồng bộ mỗi giờ) và DOANH SỐ CHỐT (đơn
 * Pancake, gần như tức thời). Nó KHÔNG thay làn cũ và không nới một luật nào của làn cũ: hai làn, hai
 * câu hỏi, hai căn cứ — và làn nhanh chỉ biết TĂNG. Cắt / tạm dừng vẫn chỉ đi qua làn có tiền thật.
 *
 * ─── NGƯỠNG LÀ QUYẾT ĐỊNH CỦA CHỦ SHOP (AGENTS.md mục 7, 38) ───
 *
 * Bốn con số dưới đây chủ shop chốt ngày 24/09/2026 qua bốn câu hỏi, không phải người dựng tự đặt.
 * Đổi chúng là đổi một quyết định kinh doanh — chỉ sửa ở đây và chỉ khi chủ shop yêu cầu.
 *
 * ─── RỦI RO ĐÃ BIẾT, NÓI RA CHỨ KHÔNG GIẤU ───
 *
 * Doanh số CHỐT chưa trừ hoàn. Một chiến dịch rẻ trên đơn chốt mà đổ vào mã hoàn cao vẫn có thể lỗ
 * thật. Làn nhanh chấp nhận rủi ro đó theo quyết định của chủ shop, và bù bằng ba thứ không đổi:
 * bước nhỏ (+20%), trần số lượt, và PHANH của đường ghi — ba lượt đổi đo được liên tiếp làm lợi nhuận
 * đi xuống thì cả đường ghi dừng lại.
 */

export const INTRADAY_SCALE_RULE = {
  /** "Rẻ, tốt": chi quảng cáo HÔM NAY ≤ 15% doanh số chốt HÔM NAY của chiến dịch. */
  maxCpqcPct: 0.15,
  /** Mẫu tối thiểu trong ngày — tránh một đơn may mắn làm %CPQC đẹp. */
  minSpendVnd: 300_000,
  minBookedOrders: 3,
  /** Mỗi lượt tăng. Nằm trong trần biên độ chung `ADS_WRITE_LIMITS.maxStepPct` (30%). */
  stepPct: 0.2,
  /** Hai lượt ĐÃ ÁP trên cùng chiến dịch phải cách nhau ít nhất ngần này giờ. */
  minGapHours: 2,
  /** Tối đa số lượt ĐÃ ÁP trên một chiến dịch trong một ngày (tính mọi làn). */
  maxPerDay: 3,
} as const;

/** Chữ ghi vào cột `decision` của sổ đổi ngân sách — tách hẳn khỏi `SCALE` của sổ quyết định. */
export const INTRADAY_DECISION = "SCALE_INTRADAY";

export type IntradayBlocker = "NO_SPEND_DATA" | "SMALL_SAMPLE" | "TOO_EXPENSIVE";

export const INTRADAY_BLOCKER_LABEL: Record<IntradayBlocker, string> = {
  NO_SPEND_DATA: "Chưa có số chi hôm nay",
  SMALL_SAMPLE: "Chưa đủ mẫu hôm nay",
  TOO_EXPENSIVE: "Chưa đủ rẻ",
};

export type IntradayInput = {
  /** `false` = đồng bộ Facebook chưa chạy tới hôm nay cho chiến dịch này ⇒ CHƯA BIẾT, không phải 0đ. */
  spendKnown: boolean;
  spend: number;
  bookedOrders: number;
  bookedRevenue: number;
};

export type IntradayVerdict = {
  eligible: boolean;
  /** Chi / doanh số chốt. `null` = chưa tính được (chưa có số chi, hoặc chưa có doanh số). */
  cpqcPct: number | null;
  blocker: IntradayBlocker | null;
  reason: string;
};

const vnd = (n: number) => `${Math.round(n).toLocaleString("vi-VN")}đ`;
const pct = (n: number) => `${(n * 100).toFixed(1).replace(".", ",")}%`;

/** Chiến dịch HÔM NAY có đủ "rẻ, tốt" để đề nghị tăng không. Hàm THUẦN. */
export function intradayScaleVerdict(r: IntradayInput, rule = INTRADAY_SCALE_RULE): IntradayVerdict {
  if (!r.spendKnown) return { eligible: false, cpqcPct: null, blocker: "NO_SPEND_DATA", reason: "Chưa có số chi hôm nay của chiến dịch này — CHƯA BIẾT, không phải 0đ." };
  const cpqc = r.bookedRevenue > 0 ? r.spend / r.bookedRevenue : null;
  if (r.spend < rule.minSpendVnd || r.bookedOrders < rule.minBookedOrders) {
    return {
      eligible: false,
      cpqcPct: cpqc,
      blocker: "SMALL_SAMPLE",
      reason: `Hôm nay mới chi ${vnd(r.spend)} · ${r.bookedOrders} đơn chốt — cần ≥ ${vnd(rule.minSpendVnd)} và ≥ ${rule.minBookedOrders} đơn.`,
    };
  }
  if (cpqc === null || cpqc > rule.maxCpqcPct) {
    return {
      eligible: false,
      cpqcPct: cpqc,
      blocker: "TOO_EXPENSIVE",
      reason: cpqc === null ? "Có đơn mà chưa có doanh số chốt — chưa tính được %CPQC." : `%CPQC hôm nay ${pct(cpqc)} > ngưỡng ${pct(rule.maxCpqcPct)}.`,
    };
  }
  return {
    eligible: true,
    cpqcPct: cpqc,
    blocker: null,
    reason: `Hôm nay chi ${vnd(r.spend)} cho ${r.bookedOrders} đơn chốt · ${vnd(r.bookedRevenue)} — %CPQC ${pct(cpqc)} ≤ ${pct(rule.maxCpqcPct)}.`,
  };
}

export type IntradayRate = { ok: true } | { ok: false; kind: "MAX_PER_DAY" | "GAP"; reason: string; nextAt: Date | null };

/**
 * Nhịp: tối đa `maxPerDay` lượt ĐÃ ÁP trong ngày, hai lượt cách nhau ≥ `minGapHours` giờ.
 *
 * `appliedToday` là mốc các lượt đã áp HÔM NAY trên chiến dịch này, TÍNH MỌI LÀN — một lượt làn cũ
 * cũng là một lần Facebook phải học lại, nên nó chiếm chỗ trong nhịp như mọi lượt khác.
 */
export function intradayRateCheck(appliedToday: Date[], now: Date, rule = INTRADAY_SCALE_RULE): IntradayRate {
  if (appliedToday.length >= rule.maxPerDay) {
    return { ok: false, kind: "MAX_PER_DAY", reason: `Chiến dịch đã tăng ${appliedToday.length} lượt hôm nay (tối đa ${rule.maxPerDay}).`, nextAt: null };
  }
  const last = appliedToday.reduce<Date | null>((m, d) => (m === null || d.getTime() > m.getTime() ? d : m), null);
  if (last) {
    const nextAt = new Date(last.getTime() + rule.minGapHours * 3_600_000);
    if (nextAt.getTime() > now.getTime()) {
      return { ok: false, kind: "GAP", reason: `Lượt gần nhất lúc ${last.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Ho_Chi_Minh" })} — phải cách ≥ ${rule.minGapHours} giờ.`, nextAt };
    }
  }
  return { ok: true };
}

/** Ngân sách đích của một lượt tăng. `null` = chưa đọc được ngân sách hiện tại. */
export function intradayNextBudget(currentVnd: number | null, rule = INTRADAY_SCALE_RULE): number | null {
  return currentVnd === null ? null : Math.round(currentVnd * (1 + rule.stepPct));
}
