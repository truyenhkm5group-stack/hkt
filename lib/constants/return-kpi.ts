import { CASE_SLA_HOURS } from "@/lib/constants/action-queue";
import { RETURN_STAGE_BY_KEY } from "@/lib/constants/return-pipeline";

/**
 * ═══════════ ĐO HIỆU SUẤT KHO HÀNG HOÀN — HAI CHẶNG, KHÔNG PHẢI MỘT ═══════════
 *
 * Một kiện hàng hoàn đi qua hai khoảng chờ do HAI việc khác nhau tạo ra, và gộp chúng lại là mất
 * đúng thông tin cần để đi giục đúng người:
 *
 *   received_at ──(A)──► inspected_at ──(B)──► phiếu tái nhập
 *   kho cầm kiện        đã mở ra đếm          hàng vào lại tồn
 *
 *  · Chặng (A) là việc MỞ RA ĐẾM. Tắc ở đây nghĩa là kho đang ôm vốn mà sổ chưa biết.
 *  · Chặng (B) là việc LẬP PHIẾU. Tắc ở đây nghĩa là đã biết bán lại được bao nhiêu mà tồn vẫn
 *    chưa đổi — một khoảng trống ngắn nhưng làm kế hoạch sản xuất đặt thừa.
 *
 * ─── MẶC ĐỊNH LẤY LẠI TỪ HẰNG SỐ ĐANG CHẠY, KHÔNG GÕ LẠI SỐ ───
 *
 * AGENTS.md mục 22: gõ lại một con số là mở đường cho hai nơi nói hai số khác nhau. Nên (A) đọc
 * thẳng `CASE_SLA_HOURS.RETURN_RECEIVED_PENDING_INSPECTION` — cùng con số mà hàng đợi việc và luật
 * cảnh báo đang dùng — và (B) đọc `RETURN_STAGE_BY_KEY.INSPECTED.slaHours`. Đổi hạn ở một chỗ là
 * đổi ở mọi chỗ.
 *
 * Ghi đè của chủ shop vẫn nằm ở `settings` (`work.sla`) và đọc qua `getWorkConfig()`; ở đây chỉ là
 * mặc định khi chưa ai khai.
 */

/** Chặng (A): kho cầm kiện → mở ra đếm xong. */
export const RECEIVE_TO_INSPECT_SLA_HOURS: number = CASE_SLA_HOURS.RETURN_RECEIVED_PENDING_INSPECTION ?? 72;

/** Chặng (B): đếm xong → lập phiếu tái nhập. Khâu `INSPECTED` của đường ống sở hữu con số này. */
export const INSPECT_TO_RESTOCK_SLA_HOURS: number = RETURN_STAGE_BY_KEY.INSPECTED.slaHours ?? 24;

export const RETURN_SLA_LEGS = ["RECEIVE_TO_INSPECT", "INSPECT_TO_RESTOCK"] as const;
export type ReturnSlaLeg = (typeof RETURN_SLA_LEGS)[number];

export const SLA_LEG_LABEL: Record<ReturnSlaLeg, string> = {
  RECEIVE_TO_INSPECT: "Nhận → đếm xong",
  INSPECT_TO_RESTOCK: "Đếm xong → vào lại tồn",
};

export const SLA_LEG_HOURS: Record<ReturnSlaLeg, number> = {
  RECEIVE_TO_INSPECT: RECEIVE_TO_INSPECT_SLA_HOURS,
  INSPECT_TO_RESTOCK: INSPECT_TO_RESTOCK_SLA_HOURS,
};

/**
 * ═══════════ BỐN NHÓM TUỔI ═══════════
 *
 * Ranh giới tính bằng GIỜ, không phải ngày: một kiện nằm 23 giờ và một kiện nằm 25 giờ thuộc hai
 * nhóm khác nhau, và người quản lý cần thấy đúng chỗ đó. Nhóm cuối cùng `>72h` trùng với hạn chặng
 * (A) nên "quá hạn" và "nhóm cuối" luôn nói cùng một tập kiện — cố ý, để hai con số trên màn hình
 * không bao giờ đá nhau.
 */
export const AGE_BUCKETS = [
  { key: "H0_24", label: "< 24 giờ", fromHours: 0, toHours: 24 },
  { key: "H24_48", label: "24 – 48 giờ", fromHours: 24, toHours: 48 },
  { key: "H48_72", label: "48 – 72 giờ", fromHours: 48, toHours: 72 },
  { key: "H72_PLUS", label: "> 72 giờ", fromHours: 72, toHours: null },
] as const;

export type AgeBucketKey = (typeof AGE_BUCKETS)[number]["key"];

export const AGE_BUCKET_TONE: Record<AgeBucketKey, "green" | "amber" | "rose"> = {
  H0_24: "green",
  H24_48: "amber",
  H48_72: "amber",
  H72_PLUS: "rose",
};

/**
 * ═══════════ KIỆN NÀO ĐƯỢC TÍNH VÀO SLA ĐẾM, KIỆN NÀO KHÔNG ═══════════
 *
 * Yêu cầu vận hành (§3): *"Không tính các case unresolved tracking vào SLA inspection nếu chưa xác
 * định được kiện hợp lệ."*
 *
 * Ở ERP này điều đó ĐÃ đúng theo cấu trúc chứ không cần thêm bộ lọc: một dòng `return_inspections`
 * chỉ tồn tại khi đã có `shipment_id` THẬT (khoá ngoại `NOT NULL` về `shipments`). Ba nhóm ngoại lệ
 * của sổ giấy — mã lần ra nhiều kiện, mã không có trong ERP, mã chỉ có ở sheet tổng — **chưa bao
 * giờ sinh ra dòng kiểm đếm**, nên chúng nằm ngoài mẫu số của SLA một cách tự nhiên.
 *
 * Giữ hằng số này để bài kiểm khẳng định được điều đó, và để người đọc sau không đi thêm một bộ lọc
 * thừa rồi tưởng mình vừa sửa một lỗ hổng.
 */
export const SLA_COUNTS_ONLY_RESOLVED_PARCELS = true;

/**
 * ═══════════ BA CHỖ ERP CHƯA ĐO ĐƯỢC — KHAI RA, KHÔNG IN THÀNH 0 ═══════════
 *
 * AGENTS.md mục 37 và 45: chưa có nguồn thì khai `UNAVAILABLE` kèm `missingWhat` cụ thể tới mức
 * sửa được, và **không** thay bằng một truy vấn gần đúng. Ba con số dưới đây đo trên production
 * ngày 14/09/2026; chúng là lý do vì sao vài ô trên màn hình hiện "chưa đo được" thay vì một số.
 */
export const RETURN_KPI_GAPS = [
  {
    key: "ITEM_GRAIN_CONDITION",
    label: "Kết luận theo TỪNG MÓN",
    /** Đo 14/09/2026: 4 dòng món / 2 kiện, trên tổng 672 kiện. */
    measured: "4 dòng món trên 2 kiện, trong tổng 672 kiện",
    why: "Trạm đếm một chạm (`recordInspection`) chỉ ghi kết luận cho CẢ KIỆN. Chỉ đường đếm từng món (`recordItemInspection`) mới sinh dòng `return_inspection_items`, và kho hầu như không dùng nó.",
    missingWhat: "Kho đếm qua đường từng món, hoặc trạm một chạm ghi kèm dòng món khi kiện chỉ có một mẫu mã.",
    blocks: "Tỷ lệ hỏng/thiếu/sai hàng theo MẪU MÃ, và phân rã 7 mức `ITEM_CONDITIONS`.",
  },
  {
    key: "RECEIVER_IDENTITY",
    label: "Ai NHẬN kiện",
    /** Đo 14/09/2026: 0/672 dòng có `received_by_user_id`. */
    measured: "0 trên 672 kiện có khoá tài khoản người nhận",
    why: "Kiện được ghi nhận đã về qua đường đối soát sổ giấy và xác nhận hàng loạt — máy làm, nên `received_by_user_id` là NULL đúng nghĩa 'MÁY làm' (AGENTS.md mục 34).",
    missingWhat: "Người kho bấm nhận từng kiện ở màn hình, thay vì nhận hàng loạt qua đối soát.",
    blocks: "Chấm công đoạn NHẬN theo người. Đoạn ĐẾM thì đo được — 610/610 kiện đã đếm đều có khoá người đếm.",
  },
  {
    key: "INSPECTION_IN_PROGRESS",
    label: "Đang kiểm (dở dang)",
    measured: "không có cột nào lưu mốc bắt đầu đếm",
    why: "`return_inspections.status` cố ý chỉ có HAI giá trị `RECEIVED` và `INSPECTED` (`lib/constants/return-lifecycle.ts`): đếm một kiện là việc của vài phút, nên một trạng thái 'đang làm' sẽ gần như luôn rỗng mà vẫn phải giữ đồng bộ.",
    missingWhat: "Một quyết định nghiệp vụ rằng đếm là việc đủ dài để đáng theo dõi dở dang — chưa có thì đừng thêm cột.",
    blocks: "Ô 'Đang kiểm' trong bộ KPI điều hành.",
  },
] as const;

export type ReturnKpiGapKey = (typeof RETURN_KPI_GAPS)[number]["key"];

/**
 * ═══════════ HAI TỶ LỆ, HAI MẪU SỐ KHÁC NHAU ═══════════
 *
 * Đây là chỗ dễ sai nhất của cả bản này, nên viết ra thành chữ:
 *
 *  · **Tỷ lệ bán lại được** = kiện kết luận `RESTOCKABLE` / kiện ĐÃ ĐẾM.
 *    Mẫu số là kiện đã đếm, KHÔNG phải kiện đã nhận: kiện chưa đếm thì chưa ai biết nó thuộc về
 *    tử số hay không, và ném nó vào mẫu số là khẳng định "không bán lại được" cho thứ chưa ai mở ra.
 *
 *  · **Tỷ lệ thu hồi tồn** = món ĐÃ vào lại tồn / món của kiện đã đếm.
 *    Mẫu số là kiện ĐÃ VỀ VÀ ĐÃ ĐẾM, KHÔNG phải vận đơn mang trạng thái `RETURNED` — yêu cầu §7
 *    nói thẳng điều này. ĐVVC báo "đã hoàn" chỉ nói hàng rời kho của họ; lấy nó làm mẫu số là chia
 *    cho một lượng hàng có thể còn đang trên đường, và tỷ lệ sẽ thấp giả tạo đúng bằng phần đang
 *    đi đường.
 *
 * Mẫu số 0 ⇒ `null` (chưa đo được), không phải 0% — dùng `pctOrNull` (AGENTS.md mục 42).
 */
export const RESTOCKABLE_RATE_BASIS = "Kiện kết luận bán lại được ÷ kiện đã đếm";
export const RECOVERY_RATE_BASIS = "Món đã vào lại tồn ÷ món đếm được của kiện đã đếm";
