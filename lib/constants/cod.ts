import type { CodStatus } from "@/db/schema";

/**
 * Ý NGHĨA TRẠNG THÁI COD — chiều TIỀN của vận đơn, tách hẳn khỏi chiều giao hàng.
 *
 *   NOT_APPLICABLE  Vận đơn KHÔNG THU HỘ. Đây là thuộc tính của vận đơn (COD khai báo = 0),
 *                   KHÔNG phải kết luận "sẽ không thu được tiền". Chỉ được đặt khi cod_amount = 0.
 *   PENDING         Có thu hộ, ERP chưa có chứng từ tiền nào. Đây là CHƯA BIẾT, không phải thu 0đ.
 *   COLLECTED       ĐVVC báo đã giao tới khách ⇒ tiền đang nằm ở ĐVVC. Chưa phải tiền về tài khoản.
 *   RECONCILED      ĐVVC xác nhận số tiền, chờ chuyển khoản.
 *   PAID_TO_BANK    Có dòng bảng kê chứng minh tiền đã về tài khoản.
 *   DISPUTED        Chứng từ lệch với số ERP ghi nhận, cần đối chiếu.
 *
 * Đơn hoàn / huỷ KHÔNG được hạ về NOT_APPLICABLE: vận đơn đó vẫn có thu hộ, chỉ là không thu
 * được. Việc "không còn khả năng thu" đọc từ trạng thái giao hàng (COD_COLLECTABLE), không phải
 * bằng cách xoá dấu vết thu hộ — làm thế thì ERP hiện "Không thu hộ" trong khi Viettel Post vẫn
 * ghi số tiền cần thu, đúng kiểu số liệu không dùng để vận hành được.
 */
export function codStatusForAmount(codAmount: number, current: CodStatus): CodStatus {
  if (codAmount > 0) return current === "NOT_APPLICABLE" ? "PENDING" : current;
  return "NOT_APPLICABLE";
}

/** Tab trên trang đối soát COD — `value` là tham số `cod` trên URL ("waiting" = mặc định, không cần ghi lên URL) */
export type CodTab = { value: string; label: string; statuses: CodStatus[] | "all"; description: string };

export const COD_DEFAULT_TAB = "waiting";
export const COD_DEFAULT_STATUSES: CodStatus[] = ["COLLECTED", "RECONCILED"];
const ALL_STATUSES: CodStatus[] = ["NOT_APPLICABLE", "PENDING", "COLLECTED", "RECONCILED", "PAID_TO_BANK", "DISPUTED"];

export const COD_TABS: CodTab[] = [
  { value: COD_DEFAULT_TAB, label: "Chờ tiền về", statuses: COD_DEFAULT_STATUSES, description: "Đã giao thành công, ĐVVC chưa chuyển tiền" },
  { value: "PENDING", label: "Chưa thu", statuses: ["PENDING"], description: "Đang giao, chưa thu tiền khách" },
  { value: "COLLECTED", label: "Đã thu", statuses: ["COLLECTED"], description: "Đã giao, chờ ĐVVC đối soát" },
  { value: "RECONCILED", label: "ĐVVC đã đối soát", statuses: ["RECONCILED"], description: "ĐVVC xác nhận số tiền, chờ chuyển khoản" },
  { value: "PAID_TO_BANK", label: "Đã về ngân hàng", statuses: ["PAID_TO_BANK"], description: "Tiền đã về tài khoản" },
  { value: "DISPUTED", label: "Có chênh lệch", statuses: ["DISPUTED"], description: "Cần đối chiếu lại với ĐVVC" },
  { value: "all", label: "Tất cả", statuses: "all", description: "Mọi vận đơn có thu hộ" },
];

/** Chuyển giá trị tham số `cod` (có thể nhiều giá trị, phân cách dấu phẩy) thành danh sách trạng thái */
export function codStatusesFromFilter(values: string[] | undefined): CodStatus[] | "all" {
  if (!values?.length || values.includes(COD_DEFAULT_TAB)) return COD_DEFAULT_STATUSES;
  if (values.includes("all")) return "all";
  const valid = values.filter((v): v is CodStatus => (ALL_STATUSES as string[]).includes(v));
  return valid.length ? valid : COD_DEFAULT_STATUSES;
}

/** Tab khớp với tham số hiện tại (mặc định "Chờ tiền về"); trả về null nếu là tổ hợp trạng thái không có tab */
export function activeCodTab(values: string[] | undefined): CodTab | null {
  const statuses = codStatusesFromFilter(values);
  const key = statuses === "all" ? "all" : [...statuses].sort().join(",");
  return COD_TABS.find((t) => (t.statuses === "all" ? key === "all" : [...t.statuses].sort().join(",") === key)) ?? null;
}

/**
 * Giới hạn một lượt nhập danh sách vận đơn / bảng kê Viettel Post.
 * Bảng kê xuất theo từng đợt đối soát nên một lần nhập vài chục tệp là bình thường;
 * giới hạn 10 tệp trước đây chặn nhầm việc dùng thật (chủ shop có 11 tệp).
 * Trần dung lượng phải nằm dưới serverActions.bodySizeLimit trong next.config.ts.
 */
export const MAX_LIST_FILES = 40;
/** Tổng base64 tối đa (base64 ≈ 4/3 dung lượng gốc). 6 MB base64 ≈ 4,5 MB tệp gốc. */
export const MAX_LIST_BASE64 = 6_000_000;
/** Dung lượng gốc tương ứng, dùng cho kiểm tra phía trình duyệt trước khi gửi. */
export const MAX_LIST_RAW_BYTES = Math.floor(MAX_LIST_BASE64 * 3 / 4);
