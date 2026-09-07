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

/**
 * TÌNH TRẠNG THANH TOÁN CỦA MỘT VẬN ĐƠN — Viettel Post đã trả tiền thu hộ của đơn đó chưa.
 *
 * Khác `CodStatus` (ảnh chụp trạng thái tiền trên vận đơn): đây là kết quả ĐỐI SOÁT, tính bằng
 * cách so tiền thu hộ khai báo với các dòng bảng kê thật đã nhận.
 */
export type SettlementStatus = "DA_TRA_DU" | "TRA_THIEU" | "CHUA_TRA" | "QUA_HAN" | "CHUA_GIAO" | "GIAO_NHUNG_HOAN" | "KHONG_PHAI_TRA";

export const SETTLEMENT_LABEL: Record<SettlementStatus, string> = {
  DA_TRA_DU: "Đã trả đủ",
  TRA_THIEU: "Trả thiếu",
  CHUA_TRA: "Chờ trả",
  QUA_HAN: "Quá hạn chưa trả",
  CHUA_GIAO: "Chưa giao xong",
  GIAO_NHUNG_HOAN: "Giao nhưng thu không đủ",
  KHONG_PHAI_TRA: "Không phải trả",
};

export const SETTLEMENT_TONE: Record<SettlementStatus, string> = {
  DA_TRA_DU: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300",
  TRA_THIEU: "bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300",
  CHUA_TRA: "bg-sky-50 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300",
  QUA_HAN: "bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300",
  CHUA_GIAO: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300",
  GIAO_NHUNG_HOAN: "bg-orange-100 text-orange-800 dark:bg-orange-950/60 dark:text-orange-300",
  KHONG_PHAI_TRA: "bg-muted text-muted-foreground",
};

export const SETTLEMENT_HINT: Record<SettlementStatus, string> = {
  DA_TRA_DU: "Bảng kê đã trả đủ tiền thu hộ khai báo.",
  TRA_THIEU: "Bảng kê có trả nhưng ít hơn tiền thu hộ khai báo — thường là đơn khách chỉ trả một phần, hoặc bưu tá sửa doanh thu lúc phát.",
  CHUA_TRA: "Đã phát thành công, chưa thấy trên bảng kê nào — còn trong hạn trả tiền.",
  QUA_HAN: "Đã phát thành công quá hạn mà chưa đồng nào về theo bảng kê — cần đòi Viettel Post.",
  CHUA_GIAO: "Vận đơn chưa kết thúc nên chưa tới lượt đối soát.",
  GIAO_NHUNG_HOAN: "Viettel Post báo phát thành công nhưng bảng kê chỉ trả một phần nhỏ — khách không nhận hàng, chỉ trả tiền ship để xem. Theo quy tắc của shop đây là ĐƠN HOÀN, không phải Viettel Post còn nợ.",
  KHONG_PHAI_TRA: "Đơn hoàn / huỷ hoặc đơn không thu hộ — Viettel Post không thu được tiền của khách nên không phải trả.",
};

/**
 * Số ngày kể từ khi phát thành công mà chưa thấy tiền trên bảng kê thì coi là QUÁ HẠN.
 *
 * Đo trên dữ liệu thật của shop: bảng kê chốt ngày 04/09 chi trả cho đơn phát 03/09, bảng kê chốt
 * 03/09 chi trả cho đơn phát 28/08–02/09 — tức Viettel Post trả trong vòng vài ngày. Để 5 ngày
 * cho rộng rãi; đổi ở đây, không rải số ra nơi khác.
 */
export const COD_OVERDUE_DAYS = 5;
