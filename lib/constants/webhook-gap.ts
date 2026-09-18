/**
 * ═══════════ ĐO ĐỘ TIN CẬY CỦA WEBHOOK BẰNG CHÍNH TỆP ĐỐI CHIẾU ═══════════
 *
 * ─── VÌ SAO PHẢI ĐO, VÀ VÌ SAO CHỈ ĐO ĐƯỢC LÚC NHẬP TỆP ───
 *
 * Đo production 16/09/2026: **2.138/2.151 vận đơn là `WEBHOOK_ONLY`** — tài khoản API không đọc
 * được chúng, nên webhook là NGUỒN TIN DUY NHẤT. Một nguồn duy nhất mà không ai biết nó rơi bao
 * nhiêu phần trăm là một nguồn không dùng để ra quyết định được.
 *
 * Và không có cách nào tự đo: ERP không thể biết mình đang thiếu một gói tin chưa từng tới. Chỉ
 * khi một NGUỒN ĐỘC LẬP nói lại cùng một sự việc thì mới lộ ra chỗ hụt — và nguồn độc lập duy
 * nhất hôm nay là tệp "Danh sách vận đơn" tải từ viettelpost.vn.
 *
 * Nên mỗi lần nhập tệp, ngoài việc vá dữ liệu, ERP còn ghi lại MỘT PHÉP ĐO: trong số những dòng
 * tệp nói về kiện ERP đã biết, bao nhiêu dòng ERP đã biết rồi (webhook làm đúng việc) và bao nhiêu
 * dòng ERP chưa hề biết (webhook đã rơi).
 *
 * ─── VÌ SAO CÓ NGƯỠNG, VÀ VÌ SAO LÀ HAI GIỜ ───
 *
 * Một sự kiện vừa xảy ra vài phút trước lúc nhập tệp thì webhook có thể đang trên đường tới. Đếm
 * nó là "hụt" là vu oan cho webhook và làm tỷ lệ tin cậy tụt vì một cuộc đua vô hại.
 *
 * Đo được trên production: độ trễ THẬT của webhook Viettel Post là **36–41 giây** (sáu kiện, đo
 * 16/09). Hai giờ là gấp hơn 150 lần con số đó — đủ rộng để không một gói tin bình thường nào bị
 * kết tội, và vẫn đủ hẹp để bắt được mọi lần rơi thật (những lần rơi quan sát được tính bằng
 * chục giờ: ca thật ngày 12/09 ERP chậm 20 giờ).
 *
 * ─── ĐÂY KHÔNG PHẢI SLA VÀ KHÔNG ĐƯỢC DÙNG NHƯ SLA ───
 *
 * Viettel Post không cam kết gửi đủ webhook, nên con số này KHÔNG phải một cam kết bị vi phạm.
 * Nó là CHỈ SỐ VẬN HÀNH: đo để biết phải nhập tệp dày hay thưa, và để biết việc trỏ ERP về đúng
 * tài khoản API đáng giá bao nhiêu. Mẫu nhỏ thì nói mẫu nhỏ, không làm tròn thành một lời khẳng định.
 */

/**
 * Dưới ngưỡng này thì KHÔNG kết tội webhook: sự kiện quá mới, gói tin có thể đang trên đường.
 * 120 phút = hơn 150 lần độ trễ thật đo được (36–41 giây).
 */
export const WEBHOOK_GAP_MIN_MINUTES = 120;

/**
 * Mẫu tối thiểu để phát biểu một tỷ lệ. Dưới mức này chỉ in số tuyệt đối — "1/1 hụt" không phải
 * "webhook rơi 100%", và in ra như thế là bịa một kết luận từ một quan sát.
 */
export const WEBHOOK_MATCH_MIN_SAMPLE = 30;

export const GAP_SEVERITIES = ["MINOR", "MAJOR", "CRITICAL"] as const;
export type GapSeverity = (typeof GAP_SEVERITIES)[number];

export const GAP_SEVERITY_LABEL: Record<GapSeverity, string> = {
  MINOR: "Chậm vài giờ",
  MAJOR: "Chậm hơn một ngày",
  CRITICAL: "Chậm hơn ba ngày",
};

/**
 * Mức nghiêm trọng theo ĐỘ DÀI khoảng hụt, không theo chặng: một kiện ERP không biết gì suốt ba
 * ngày là nghiêm trọng dù nó đang ở chặng nào.
 */
export function gapSeverity(minutes: number): GapSeverity {
  if (minutes >= 3 * 24 * 60) return "CRITICAL";
  if (minutes >= 24 * 60) return "MAJOR";
  return "MINOR";
}

export type GapMeasureInput = {
  /** Mốc của ĐVVC trên dòng tệp. */
  carrierEventAt: Date;
  /** Mốc ĐVVC mà ERP đang giữ TRƯỚC khi nhập. `null` = ERP chưa biết gì về kiện này. */
  erpKnewAt: Date | null;
  /** Lúc chạy lần nhập. */
  importedAt: Date;
};

export type GapMeasure =
  | { isGap: false; reason: "TOO_FRESH" | "ERP_ALREADY_AHEAD"; minutes: number }
  | { isGap: true; minutes: number; severity: GapSeverity };

/**
 * Dòng tệp này có phải bằng chứng webhook đã rơi không.
 *
 * Hàm THUẦN: không đọc, không ghi, chạy hai lần ra cùng kết quả — nên kiểm thử được mà không cần
 * cơ sở dữ liệu, và không có đường nào để một luật thứ hai lẻn vào.
 *
 * Ba câu trả lời, và hai trong số đó KHÔNG phải lỗi của webhook:
 *  · `ERP_ALREADY_AHEAD` — ERP đã biết bằng hoặc mới hơn. Webhook làm đúng việc của nó.
 *  · `TOO_FRESH`        — sự kiện quá mới so với lúc nhập; gói tin có thể đang trên đường.
 *  · `isGap`            — ĐVVC ghi nhận sự việc từ lâu mà tới lúc nhập ERP vẫn chưa hề biết.
 */
export function measureWebhookGap(input: GapMeasureInput): GapMeasure {
  const minutes = Math.round((input.importedAt.getTime() - input.carrierEventAt.getTime()) / 60_000);
  // ERP đã biết bằng hoặc mới hơn ⇒ không có gì hụt. So bằng mốc ĐVVC, không bằng lúc ERP nhận:
  // câu hỏi là "ERP có biết sự việc này chưa", không phải "ERP có bận không".
  if (input.erpKnewAt && input.erpKnewAt.getTime() >= input.carrierEventAt.getTime()) {
    return { isGap: false, reason: "ERP_ALREADY_AHEAD", minutes };
  }
  if (minutes < WEBHOOK_GAP_MIN_MINUTES) return { isGap: false, reason: "TOO_FRESH", minutes };
  return { isGap: true, minutes, severity: gapSeverity(minutes) };
}

/**
 * Tỷ lệ webhook nói đúng: trong số dòng tệp ERP ĐÃ BIẾT hoặc LẼ RA phải biết, bao nhiêu phần trăm
 * ERP đã biết thật.
 *
 * `null` khi mẫu chưa đủ — CHƯA ĐỦ DỮ LIỆU khác hẳn 0%, và in 0% ở đây là vu cho webhook một lần
 * rơi chưa từng được chứng minh.
 */
export function webhookMatchRate(input: { known: number; gaps: number }): number | null {
  const total = input.known + input.gaps;
  if (total < WEBHOOK_MATCH_MIN_SAMPLE) return null;
  return input.known / total;
}
