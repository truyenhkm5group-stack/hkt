/**
 * ═══════════ NHỊP ĐỐI CHIẾU VIETTEL POST — THEO ĐỘ NÓNG CỦA KIỆN, KHÔNG THEO MỘT CON SỐ ═══════════
 *
 * ─── VÌ SAO TỆP NÀY TỒN TẠI ───
 *
 * Trước bản này, bộ đối chiếu (`syncViettelPostShipments`) xếp hàng bằng đúng một câu:
 * `order by last_vtp_sync_at asc nulls first`. Nghĩa là một kiện ĐANG ĐI GIAO — mà kết quả phải có
 * trong ngày, và cửa sổ gọi lại khách chỉ vài giờ — đứng ngang hàng với một kiện CHỜ LẤY HÀNG, thứ
 * mà chậm ba ngày vẫn là bình thường. Với 300 kiện mỗi lượt, kiện nóng phải chờ hết lượt của kiện
 * nguội.
 *
 * ─── HAI ĐIỀU TỆP NÀY KHÔNG LÀM ───
 *
 * 1. KHÔNG kết luận gì về kiện hàng. Nhịp hỏi lại là chuyện của hạ tầng; im lặng lâu KHÔNG bao giờ
 *    được dịch thành "chắc đã giao" hay "chắc đã hoàn". Ranh giới đó đã được
 *    `lib/queries/logistics-freshness.ts` đặt ra và tệp này giữ nguyên.
 * 2. KHÔNG là bảng ngưỡng thứ hai. Ngưỡng ĐỘ TƯƠI (khi nào một con số bị coi là cũ) vẫn nằm ở
 *    `lib/constants/logistics-freshness.ts::FRESHNESS_BY_STAGE`. Ở đây là NHỊP HỎI LẠI — hai câu
 *    hỏi khác nhau: "số liệu này còn dùng được không" và "bao giờ nên hỏi lại".
 *
 * Toàn bộ là HÀM THUẦN: không đọc, không ghi, chạy hai lần ra cùng kết quả. Nhờ vậy kiểm thử được
 * mà không cần cơ sở dữ liệu, và bộ đối chiếu không thể lặng lẽ có một luật thứ hai.
 */
import type { CarrierSubstate } from "@/lib/constants/carrier-substate";

/** Nhóm nhịp. `TERMINAL` không bao giờ tự vào hàng đợi — chỉ đối chiếu khi người bấm. */
export const RECONCILE_TIERS = ["HOT", "WARM", "COLD", "TERMINAL"] as const;
export type ReconcileTier = (typeof RECONCILE_TIERS)[number];

export const RECONCILE_TIER_LABEL: Record<ReconcileTier, string> = {
  HOT: "Nóng — hỏi lại vài phút một lần",
  WARM: "Ấm — hỏi lại mỗi nửa giờ",
  COLD: "Nguội — hỏi lại vài giờ một lần",
  TERMINAL: "Đã kết thúc — chỉ đối chiếu khi người bấm",
};

/** Số PHÚT giữa hai lần hỏi khi lần trước thành công. */
export const RECONCILE_INTERVAL_MINUTES: Record<ReconcileTier, number> = {
  /*
    NĂM PHÚT, KHÔNG PHẢI HAI.

    Đề bài gợi ý 2–5 phút cho kiện nóng. Chọn cận trên vì hai lý do đo được: bộ lập lịch gọi
    `vtp-tracking` mỗi 10 phút (`scripts/scheduler.mjs`), nên nhịp 2 phút chỉ tồn tại trên giấy;
    và Viettel Post có giới hạn tần suất trên tài khoản đối tác. Muốn nhanh hơn thì phải hạ
    `SYNC_VTP_EVERY_MINUTES` trước — mà đổi lịch scheduler là việc phải hỏi chủ shop (AGENTS.md §7).
  */
  HOT: 5,
  WARM: 30,
  COLD: 240,
  // Kiện đã kết thúc không có gì để hỏi thêm. Không phải 0 (nghĩa là "hỏi ngay"), mà là KHÔNG XẾP HÀNG.
  TERMINAL: 0,
};

/**
 * ĐỘ NÓNG THEO TRẠNG THÁI CON CỦA ĐVVC, không theo `shipment_stage`.
 *
 * `stage` gộp "chờ phát lại" với "tồn - khách nghỉ" thành một nhãn, mà hai việc ấy có nhịp khác
 * hẳn nhau. Trạng thái con (`lib/constants/carrier-substate.ts`) là tầng đã có sẵn, dựng từ
 * `vtp_status` + `vtp_status_name` — dùng lại nó, không khai một bảng thứ hai.
 */
export const RECONCILE_TIER_BY_SUBSTATE: Record<CarrierSubstate, ReconcileTier> = {
  // Đang đi giao: kết quả phải có trong ngày, và mỗi giờ chậm là một cuộc gọi khách bị lỡ.
  OUT_FOR_DELIVERY: "HOT",
  // Vừa phát hụt / đang chờ một quyết định ở bưu cục: đây là lúc đội care đang cầm kiện trong tay.
  DELIVERY_EXCEPTION: "HOT",
  WAITING_REDELIVERY: "HOT",
  WAITING_PROCESSING: "HOT",
  // Đã cầm hàng, đang chạy tuyến: mỗi chặng thường có một mốc mỗi ngày.
  PICKED_UP: "WARM",
  IN_TRANSIT: "WARM",
  RETURNING: "WARM",
  // Chờ lấy hàng / lấy hụt: chậm vài ngày là bình thường, hỏi dày không đổi được gì.
  AWAITING_PICKUP: "COLD",
  PICKUP_FAILED: "COLD",
  /*
    CHƯA RÕ LÀ NÓNG, KHÔNG PHẢI NGUỘI.

    Kiện mà ERP không đọc được trạng thái là kiện ERP KHÔNG BIẾT GÌ. Xếp nó vào nhóm nguội là lấy
    sự thiếu hiểu biết của mình làm bằng chứng rằng không có gì đáng lo — đúng thứ mà luật
    "CHƯA BIẾT không được in ra thành 0" cấm. Hỏi lại nhanh là cách duy nhất để hết chưa rõ.
  */
  UNKNOWN: "HOT",
  DELIVERED: "TERMINAL",
  RETURNED: "TERMINAL",
  CANCELLED: "TERMINAL",
};

/**
 * LÙI DẦN KHI HỎI HỤT — nhân đôi, chặn trần ở 24 giờ.
 *
 * Lỗi của lượt hỏi (mạng, 5xx, tài khoản không đọc được kiện) không phải lỗi của kiện hàng. Cứ hỏi
 * đều đặn với nhịp cũ là biến một sự cố phía ĐVVC thành một cơn bão request, và làm log đầy tiếng
 * ồn che mất lỗi thật. Trần 24 giờ để một kiện không bao giờ bị bỏ quên vĩnh viễn.
 */
export const RECONCILE_BACKOFF_CAP_MINUTES = 24 * 60;

export function backoffMinutes(base: number, attempts: number): number {
  if (base <= 0) return 0;
  if (attempts <= 0) return base;
  const grown = base * 2 ** Math.min(attempts, 10);
  return Math.min(grown, RECONCILE_BACKOFF_CAP_MINUTES);
}

export type NextSyncInput = {
  substate: CarrierSubstate;
  /** `true` khi vận đơn đã mang chặng kết thúc — không xếp hàng nữa. */
  isFinal: boolean;
  /** Số lượt hỏi hụt LIÊN TIẾP tính cả lượt vừa rồi. 0 = lượt vừa rồi thành công. */
  failedAttempts: number;
  now: Date;
};

/**
 * Bao giờ hỏi lại kiện này. `null` = KHÔNG xếp hàng nữa (đã kết thúc) — khác hẳn "hỏi ngay".
 *
 * Hàm thuần, xác định: cùng đầu vào luôn ra cùng mốc.
 */
export function nextSyncAt(input: NextSyncInput): Date | null {
  // CHỈ CỜ KẾT THÚC mới đưa một kiện ra khỏi hàng đợi. Cố ý KHÔNG dùng trạng thái con để làm việc
  // đó: một kiện mang trạng thái con `DELIVERED` mà `is_final` vẫn `false` là một MÂU THUẪN trong
  // chính dữ liệu của ERP — và mâu thuẫn thì phải đi hỏi lại, chứ không phải được coi là xong.
  // Trước khi tách hai điều kiện này, kiện như vậy nhận `next_sync_at = NULL` rồi nằm mãi ở đầu
  // hàng đợi (NULL được đọc là "chưa xếp lịch"), tức là bị hỏi lại ở MỌI lượt, mãi mãi.
  if (input.isFinal) return null;
  const tier = RECONCILE_TIER_BY_SUBSTATE[input.substate];
  const base = RECONCILE_INTERVAL_MINUTES[tier] || RECONCILE_INTERVAL_MINUTES.COLD;
  const minutes = backoffMinutes(base, input.failedAttempts);
  return new Date(input.now.getTime() + minutes * 60_000);
}

export function reconcileTierOf(substate: CarrierSubstate, isFinal: boolean): ReconcileTier {
  return isFinal ? "TERMINAL" : RECONCILE_TIER_BY_SUBSTATE[substate];
}
