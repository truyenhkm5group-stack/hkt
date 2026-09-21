/**
 * ═══════════ "CÓ NHẬN ĐƯỢC" VÀ "NHẬN ĐƯỢC CÒN KỊP KHÔNG" LÀ HAI CÂU HỎI ═══════════
 *
 * ─── SỰ CỐ 21/09/2026 ───
 *
 * Chủ shop mở PKE1521276709: viettelpost.vn ghi "Đã duyệt hoàn", ERP chưa biết. Tra ra: Viettel
 * Post CÓ gửi gói tin "Chuyển hoàn bưu cục gốc" — sự kiện lúc 17:02:43, ERP nhận lúc 17:35:22.
 * **Trễ 32 phút 39 giây.** Gói trước đó trong ngày trễ 24 phút 48 giây.
 *
 * Đo cả ngày hôm đó: 738 gói, **trung vị 1.679 giây (28 phút)**, p90 41 phút, chậm nhất 59 phút,
 * **548/738 gói trễ quá 5 phút**. Trong khi 13 ngày trước đó trung vị là **31–37 giây**.
 *
 * ─── VÌ SAO KHÔNG MÀN HÌNH NÀO BÁO ───
 *
 * `liveness` đếm SỐ GÓI trong giờ và so với nền cùng khung giờ. Hôm ấy số gói vẫn bình thường —
 * còn cao hơn mọi hôm — nên nó kết luận `HEALTHY`. Đúng theo định nghĩa của nó, và vô dụng với
 * loại hỏng này: gói tin vẫn về đều, chỉ là mỗi gói đều nói về chuyện của nửa tiếng trước.
 *
 * Đó là loại hỏng NGUY HIỂM NHẤT trong bốn loại đã biết, vì nó không để lại dấu vết nào: không
 * gói nào lỗi, không gói nào phải gửi lại (`delivery_count = 1` ở 736/738 gói — ERP trả lời ngay
 * từ lần đầu, nên chỗ dồn ứ nằm ở phía Viettel Post, không phải ở mình), không lần rơi nào.
 * Nhân viên care vẫn thấy màn hình xanh và vẫn gọi khách theo một tình trạng đã cũ.
 *
 * ─── VÌ SAO KHÔNG SỬA ĐƯỢC Ở PHÍA MÌNH, VÀ VÌ SAO VẪN PHẢI ĐO ───
 *
 * Đo 21/09/2026: **2.329 vận đơn `WEBHOOK_ONLY` + 132 chưa xét, KHÔNG MỘT VẬN ĐƠN NÀO tra được
 * qua API.** Không có kênh thứ hai để bù, nên ERP không thể làm dữ liệu tới sớm hơn. Thứ ERP làm
 * được là NÓI RA rằng dữ liệu đang cũ, để người trực biết mà đừng tin màn hình như thường ngày,
 * và để chủ shop có số liệu mà làm việc với Viettel Post.
 *
 * ─── HAI NGƯỠNG, VÀ MỘT PHÉP BẤT ĐỐI XỨNG CÓ CHỦ Ý ───
 *
 * So với NỀN cùng khung giờ (như `liveness`), vì độ trễ bình thường của mỗi shop mỗi khác. Nhưng
 * nền một mình không đủ: nền 5 giây mà hôm nay 30 giây là gấp 6 lần mà chẳng đổi quyết định nào.
 * Nên `LAGGING` đòi CẢ HAI — vượt nền nhiều lần VÀ vượt một sàn tuyệt đối.
 *
 * Bất đối xứng: thiếu nền thì vẫn được kết luận XẤU (một quan sát 30 phút tự nó đã đủ nói), nhưng
 * KHÔNG được kết luận TỐT — khẳng định "khoẻ" mà không có gì để so là đúng cái lỗi mà mục 52 đã
 * cấm. Thiếu nền và không vượt sàn ⇒ `UNKNOWN`.
 */

/**
 * Dưới ngần này gói trong một giờ thì trung vị không nói lên điều gì — hai gói lẻ của 3 giờ sáng
 * không được quyền kết luận về đường truyền.
 */
export const WEBHOOK_LATENCY_MIN_SAMPLE = 5;

/** Cùng kỷ luật với nền của `liveness`: dưới 5 ngày thì nền là CHƯA BIẾT. */
export const WEBHOOK_LATENCY_BASELINE_MIN_DAYS = 5;

/** Vượt nền bấy nhiêu lần mới gọi là dồn ứ. Nền thật của shop là 31–37 giây, nên 5 lần ≈ 3 phút. */
export const WEBHOOK_LATENCY_MULTIPLIER = 5;

/**
 * Sàn tuyệt đối của `LAGGING`. Dưới 3 phút thì không quyết định nào của đội đổi đi: hạn xử lý của
 * care tính bằng giờ. Có sàn này thì một shop có nền 2 giây không bị hét vì hôm nay nền là 12 giây.
 */
export const WEBHOOK_LATENCY_LAGGING_FLOOR_SECONDS = 180;

/**
 * Quá ngần này thì XẤU bất kể nền là bao nhiêu. 15 phút là khoảng thời gian đủ để một nhân viên
 * gọi cho khách theo một tình trạng đã thay đổi — tức đã đủ để gây ra một việc làm sai.
 */
export const WEBHOOK_LATENCY_STALLED_SECONDS = 900;

export const WEBHOOK_LATENCY_VERDICTS = ["FRESH", "LAGGING", "STALLED", "UNKNOWN"] as const;
export type WebhookLatencyVerdict = (typeof WEBHOOK_LATENCY_VERDICTS)[number];

export type LatencyInput = {
  /** Trung vị độ trễ trong 1 giờ qua, tính bằng giây. `null` = chưa đo được. */
  medianSeconds: number | null;
  /** Trung vị của CÙNG KHUNG GIỜ trong 14 ngày gần nhất. `null` = chưa đủ ngày để nói. */
  baselineSeconds: number | null;
  /** Số gói tin đã vào phép đo của giờ này. */
  sample: number;
};

export type LatencyVerdict = { verdict: WebhookLatencyVerdict; note: string };

const phut = (giay: number) => `${Math.round(giay / 60)} phút`;
const doDai = (giay: number) => (giay < 90 ? `${Math.round(giay)} giây` : phut(giay));

/**
 * Webhook đang tới còn kịp không? Hàm THUẦN — cùng đầu vào cho cùng câu trả lời, không đọc CSDL,
 * không đọc đồng hồ.
 */
export function webhookLatencyVerdict(input: LatencyInput): LatencyVerdict {
  const { medianSeconds, baselineSeconds, sample } = input;
  if (medianSeconds === null || sample < WEBHOOK_LATENCY_MIN_SAMPLE) {
    return {
      verdict: "UNKNOWN",
      note: `Giờ qua mới có ${sample} gói tin — chưa đủ để nói về độ trễ (cần ${WEBHOOK_LATENCY_MIN_SAMPLE}). CHƯA BIẾT, không phải “kịp”.`,
    };
  }
  if (medianSeconds >= WEBHOOK_LATENCY_STALLED_SECONDS) {
    return {
      verdict: "STALLED",
      note:
        `Gói tin đang về chậm ${doDai(medianSeconds)} so với lúc sự việc xảy ra` +
        (baselineSeconds === null ? "" : ` (giờ này mọi hôm ${doDai(baselineSeconds)})`) +
        ". Hàng đợi gửi của Viettel Post đang dồn — số trên màn hình vận đơn là tình trạng của " +
        `${doDai(medianSeconds)} trước, đừng gọi khách theo nó mà không tra lại viettelpost.vn.`,
    };
  }
  // BẤT ĐỐI XỨNG CÓ CHỦ Ý: không có nền thì được kết luận XẤU (nhánh trên), không được kết luận TỐT.
  if (baselineSeconds === null) {
    return {
      verdict: "UNKNOWN",
      note: `Trung vị giờ qua ${doDai(medianSeconds)}, nhưng chưa đủ ${WEBHOOK_LATENCY_BASELINE_MIN_DAYS} ngày nền cho khung giờ này để nói nhanh hay chậm. CHƯA BIẾT.`,
    };
  }
  if (medianSeconds >= WEBHOOK_LATENCY_LAGGING_FLOOR_SECONDS && medianSeconds > baselineSeconds * WEBHOOK_LATENCY_MULTIPLIER) {
    return {
      verdict: "LAGGING",
      note: `Gói tin về chậm ${doDai(medianSeconds)}, trong khi giờ này mọi hôm chỉ ${doDai(baselineSeconds)} — đang dồn ứ ở phía Viettel Post.`,
    };
  }
  return { verdict: "FRESH", note: `Gói tin về sau ${doDai(medianSeconds)}, ngang mức thường thấy của khung giờ này (${doDai(baselineSeconds)}).` };
}
