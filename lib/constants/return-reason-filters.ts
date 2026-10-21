/**
 * ═══════════ 2b — BỘ LỌC CỦA KHỐI LÝ DO HOÀN (21/10/2026) — HẰNG SỐ DÙNG CHUNG MÁY CHỦ + MÀN HÌNH ═══════════
 *
 * Sáu bộ lọc đi vào `baseRows` của `lib/queries/return-reason-report.ts` (nên cả drilldown, bảng «Nguyên nhân · giải pháp» và tầng quyết
 * định đi theo) và vào khoá nhớ đệm. Chúng KHÔNG áp cho KPI tổng quan / bảng theo mã hàng / bảng theo nguồn — màn hình nói rõ phạm vi.
 * Đo trước khi dựng (db-query run 39525595681, 3.255 kiện đã có kết quả):
 *  · nguồn đơn / ĐVVC chỉ 2 giá trị ⇒ ô chọn;
 *  · tỉnh 67 giá trị chữ LẪN tên cũ + mới ⇒ quy về tỉnh MỚI bằng `findProvince` (lib/address — không bảng thứ hai); không nhận ra ⇒
 *    «Chưa xác định tỉnh», một lựa chọn lọc có đếm, không bỏ ca;
 *  · bưu cục (vị trí lần phát cuối) chỉ 37% kiện có, 671 giá trị chữ tự do của ĐVVC, có thể mang tên / SĐT bưu tá ⇒ ô TÌM chữ, KHÔNG danh
 *    sách gợi ý, độ phủ in cạnh ô, không in chuỗi vào log;
 *  · nhân viên care = `shipment_care.owner_id` (users.id, luật 34) của đợt mới nhất; «chưa ai cầm» là một lựa chọn;
 *  · trạng thái theo `ORDER_OUTCOME` (nhóm `OUTCOME_GROUP`), không theo `shipments.stage` hay Pancake.
 */
import type { OutcomeGroup } from "@/lib/constants/truth";

/** Khoá URL (nuqs) của từng bộ lọc — khai MỘT chỗ cho trang, bộ dựng tham số và bài kiểm. */
export const REASON_FILTER_KEYS = { source: "rsrc", carrier: "rcarrier", care: "rcare", province: "rprov", postOffice: "rpo", outcome: "rkq" } as const;

/** Kiện có ca care mà đợt mới nhất chưa ai nhận. */
export const CARE_UNOWNED = "UNOWNED";
/** Kiện chưa từng có ca care nào. */
export const CARE_NONE = "NONE";
export const CARE_FILTER_LABEL: Record<typeof CARE_UNOWNED | typeof CARE_NONE, string> = { UNOWNED: "Chưa ai cầm", NONE: "Không có ca chăm sóc" };

/** Tỉnh không quy được về tỉnh mới (ô tỉnh trống / chữ lạ). */
export const PROVINCE_UNKNOWN = "UNKNOWN";
export const PROVINCE_UNKNOWN_LABEL = "Chưa xác định tỉnh";

/** Kiện không có vận đơn chính (chưa gắn ĐVVC). */
export const CARRIER_NONE = "NONE";
export const CARRIER_NONE_LABEL = "Chưa có vận đơn";

/** Nhóm trạng thái lọc được — chỉ các nhóm có trong tập «đã gửi» của báo cáo (đơn huỷ không có ở đây). */
export const REASON_OUTCOME_FILTERS: readonly OutcomeGroup[] = ["SUCCESS", "RETURNED", "OPEN"];

/** Trần độ dài chữ tìm bưu cục — đầu vào của người ngoài. */
export const POST_OFFICE_QUERY_MAX = 60;
