import type { CodStatus } from "@/db/schema";

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
