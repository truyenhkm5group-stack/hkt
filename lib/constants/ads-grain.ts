/**
 * ═══════════ HẠT CỦA CHI TIÊU QUẢNG CÁO — VÀ CÁI CỔNG GIỮ CHO NÓ KHÔNG CỘNG ĐÚP ═══════════
 *
 * Đặc tả: `docs/ads-measurement-audit-2026-09-22.md` mục 4 và mục 7.
 *
 * `ad_spends` là NGUỒN THẨM QUYỀN của tiền quảng cáo trong mọi báo cáo lợi nhuận, lương và marketer
 * (AGENTS.md mục 15). Hạ hạt của nó xuống cấp MẨU là thao tác nguy hiểm nhất của cả việc này: thêm
 * dòng cấp mẩu mà quên bỏ dòng cấp chiến dịch là **nhân đôi toàn bộ chi phí quảng cáo**, tức làm
 * sai mọi con số lợi nhuận và lương cùng một lúc.
 */

/** Ba hạt, và mỗi hạt có một đường ghi riêng. */
export type AdSpendGrain = "CAMPAIGN" | "AD" | "MANUAL";

export const AD_SPEND_GRAIN_LABEL: Record<AdSpendGrain, string> = {
  CAMPAIGN: "Chiến dịch × ngày",
  AD: "Mẩu quảng cáo × ngày",
  MANUAL: "Nhập tay",
};

/**
 * ───────────── DUNG SAI CỦA CỔNG ĐỐI CHIẾU ─────────────
 *
 * Facebook làm tròn tiền ở TỪNG DÒNG, nên tổng của nhiều dòng cấp mẩu lệch vài đồng so với một
 * dòng cấp chiến dịch là chuyện của phép làm tròn, không phải tiền biến mất. Lệch lớn hơn thì là
 * chuyện khác — thường là chiến dịch đặt chi tiêu ở cấp chiến dịch (Advantage+) nên không mẩu nào
 * gánh phần đó.
 *
 * 1.000 ₫ cho một (tài khoản × ngày): đủ rộng để nuốt làm tròn của hàng trăm dòng, đủ hẹp để một
 * chiến dịch bị bỏ sót (nhỏ nhất cũng vài chục nghìn) không lọt qua.
 *
 * > Con số này CHƯA được chủ shop chốt (AGENTS.md mục 7) — nhưng nó không phải một ngưỡng nghiệp
 * > vụ: nó là dung sai kỹ thuật của phép làm tròn, và hệ quả của việc đặt sai chỉ là lùi về hạt
 * > `CAMPAIGN` nhiều hơn cần thiết. Rơi về phía HẸP HƠN, đúng hướng.
 */
export const AD_GRAIN_TOLERANCE_VND = 1_000;

/**
 * ───────────── BA PHÁN QUYẾT CHO MỘT (TÀI KHOẢN × NGÀY) ─────────────
 *
 * Không phải hai. `NO_AD_DATA` tách khỏi `MISMATCH` vì hai thứ ấy sửa ở hai chỗ khác nhau: một cái
 * là Facebook không trả dòng nào (quyền token, hoặc ngày ấy thật sự không có mẩu nào chạy), cái
 * kia là trả nhưng không cộng đủ. Gộp lại là đẩy người đọc đi sửa nhầm chỗ.
 */
export type GrainVerdict = "AD_OK" | "MISMATCH" | "NO_AD_DATA";

export type GrainDecision = { verdict: GrainVerdict; grain: AdSpendGrain; delta: number; reason: string };

/**
 * Ngày này được ghi ở hạt nào. **Hàm THUẦN** — không đọc CSDL, không gọi mạng, nên bảng chân lý
 * kiểm được bằng vài con số.
 *
 * Nguyên tắc duy nhất: **thà một ngày ở hạt thô còn hơn một ngày sai tiền.** Mọi nhánh không chắc
 * chắn đều rơi về `CAMPAIGN` — hạt ấy vẫn cho tổng đúng, chỉ là không có chi tiết cấp mẩu.
 */
export function decideGrain(campaignTotal: number, adTotal: number, adRowCount: number): GrainDecision {
  if (adRowCount === 0) {
    return {
      verdict: "NO_AD_DATA",
      grain: "CAMPAIGN",
      delta: 0,
      reason: "Facebook không trả dòng nào ở cấp mẩu cho ngày này — giữ hạt chiến dịch.",
    };
  }
  const delta = adTotal - campaignTotal;
  if (Math.abs(delta) > AD_GRAIN_TOLERANCE_VND) {
    return {
      verdict: "MISMATCH",
      grain: "CAMPAIGN",
      delta,
      reason: `Σ cấp mẩu lệch ${delta >= 0 ? "+" : ""}${Math.round(delta).toLocaleString("vi-VN")}đ so với cấp chiến dịch (trần ${AD_GRAIN_TOLERANCE_VND.toLocaleString("vi-VN")}đ) — giữ hạt chiến dịch để tổng chi không đổi.`,
    };
  }
  return { verdict: "AD_OK", grain: "AD", delta, reason: "" };
}
