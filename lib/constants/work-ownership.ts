import { CASE_TYPES, CASE_TYPE_LABEL, type CaseType } from "@/lib/constants/action-queue";
import { departmentOfTeam, DEPARTMENT_CODES, type DepartmentCode } from "@/lib/constants/departments";
import { BOTTLENECK_REASON_LABEL, BOTTLENECK_TEAM, FULFILLMENT_BLOCK_REASONS } from "@/lib/constants/fulfillment-bottleneck";
import {
  ALERT_KINDS_OWNED_ELSEWHERE,
  departmentOfAlert,
  sourceOfAlert,
  WORK_SOURCES,
  WORK_SOURCE_SPEC,
  type WorkSource,
} from "@/lib/constants/work-sources";

/**
 * ═══════════ AI SỞ HỮU VIỆC NÀY: PHÒNG BAN TRƯỚC, NGƯỜI SAU ═══════════
 *
 * ─── LUẬT LỚN NHẤT: KHÔNG BAO GIỜ TỰ GÁN CHO MỘT CÁ NHÂN ───
 *
 * Bảng này chỉ ánh xạ được tới PHÒNG BAN. Không có cột "người mặc định", và đó là một quyết định
 * chứ không phải một thiếu sót.
 *
 * Máy biết loại việc, nhưng không biết hôm nay ai nghỉ, ai đang gánh 40 ca, ai vừa vào làm. Tự gán
 * cho một cá nhân theo một luật tĩnh sinh ra đúng hai hậu quả, cả hai đều tệ hơn "chưa ai nhận":
 *
 *  1. Việc mang tên một người không làm được nó ⇒ nó BIẾN MẤT khỏi hàng đợi phòng. Không ai coi nó
 *     là việc chung nữa, vì trên màn hình nó đã "có chủ".
 *  2. Con số quá hạn của người đó phồng lên vì việc họ chưa từng nhận — và thước hiệu suất hỏng.
 *
 * Nên: việc rơi về PHÒNG, hiện ở hàng đợi phòng là "chưa ai nhận", và một người CẦM nó bằng nút
 * "Nhận việc" hoặc trưởng phòng giao tay. Cả hai đều để lại dấu ở `work_item_events`.
 *
 * ─── MẶC ĐỊNH LẤY LẠI TỪ SỔ ĐĂNG KÝ, KHÔNG GÕ LẠI ───
 *
 * Nguồn chuyên biệt lấy `WORK_SOURCE_SPEC[...].department`; cảnh báo lấy `departmentOfAlert`
 * (tức `CASE_TEAM` → `TEAM_DEPARTMENT`). Bảng này không phát minh ra phân công mới — nó chỉ làm
 * cho phân công đang chạy TRỞ NÊN SỬA ĐƯỢC mà không cần deploy.
 */

export const WORK_OWNERSHIP_KEY = "work.ownership";

export type OwnershipRule = {
  /** `<sourceType>` hoặc `<sourceType>:<kind>`. Cùng hình dạng khoá với bảng hạn xử lý. */
  key: string;
  label: string;
  department: DepartmentCode;
  /** Vì sao phòng này, không phải phòng kia. */
  why: string;
};

const SOURCE_OWNERSHIP_WHY: Record<WorkSource, string> = {
  CS_CASE: "Khách nhắn tin là khâu chốt đơn — người trả lời chính là người bán.",
  SHIPMENT_CARE: "Làm việc với Viettel Post về một kiện đang mắc là nghề của giao vận, không phải của người chốt đơn.",
  RETURN_INSPECTION: "Chỉ người mở kiện và đếm hàng mới lập được phiếu tái nhập — hàng hoàn không tự vào tồn.",
  FULFILLMENT_EXCEPTION: "Đơn đã chốt mà chưa rời kho: hàng đang nằm trong tay kho, nên kho là nơi gỡ được.",
  BANK_EXCEPTION: "Phân loại dòng tiền là việc kế toán; gán cho phòng khác thì lợi nhuận sai mà không ai chịu trách nhiệm.",
  COD_EXCEPTION: "Tiền đã giao mà chưa về là việc đòi soát với ĐVVC — chứng từ nằm ở kế toán.",
  ADS_DECISION: "Cắt hay tăng một dòng quảng cáo là quyết định của người tiêu tiền quảng cáo.",
  INVENTORY_EXCEPTION: "Người quyết đặt bao nhiêu hàng ở shop này chính là người giữ kho.",
  ALERT: "Cảnh báo suy phòng ban theo NHÓM VIỆC của từng loại — xem bảng bên dưới, không phải một phòng cố định.",
  MANUAL_TASK: "Việc giao tay đi theo phòng mà người giao chọn; không có phòng mặc định nào đúng cho mọi việc.",
  RECURRING_TASK: "Việc định kỳ khai phòng ngay trong định nghĩa của nó.",
};

/**
 * Luật mức NGUỒN. Bỏ qua những nguồn mà phòng ban suy theo từng dòng (`department === null`):
 * cảnh báo suy theo loại việc, việc tay và việc định kỳ suy theo người khai.
 */
const SOURCE_RULES: OwnershipRule[] = WORK_SOURCES.filter(
  /*
    Hai nguồn bị loại khỏi luật mức nguồn vì chúng gom nhiều LOẠI việc:
     · `FULFILLMENT_EXCEPTION` — bốn lý do tắc, một trong bốn thuộc phòng khác (xem ngay dưới).
     · `INVENTORY_EXCEPTION`   — hai loại cảnh báo tồn kho; khai theo loại để bảng cấu hình có
       ĐÚNG MỘT dòng cho mỗi loại việc, trùng khớp với bảng hạn xử lý. Một bên khai mức nguồn còn
       bên kia khai mức loại thì màn hình cấu hình phải ghép hai lưới lệch nhau.
  */
  (s) => WORK_SOURCE_SPEC[s].department !== null && s !== "FULFILLMENT_EXCEPTION" && s !== "INVENTORY_EXCEPTION",
).map((s) => ({
  key: s,
  label: WORK_SOURCE_SPEC[s].label,
  department: WORK_SOURCE_SPEC[s].department!,
  why: SOURCE_OWNERSHIP_WHY[s],
}));

/**
 * NÚT THẮT TRƯỚC KHI RỜI KHO: BA LÝ DO LÀ VIỆC CỦA KHO, MỘT LÝ DO KHÔNG PHẢI.
 *
 * `DATA_BLOCKED` (thiếu SĐT / địa chỉ) cần GỌI KHÁCH — kho không gọi khách. `BOTTLENECK_TEAM` đã
 * chốt điều đó từ trước; ở đây chỉ tái dùng, không phân loại lại. Một luật mức nguồn "kho giữ hết"
 * sẽ đẩy việc gọi khách sang phòng không có số điện thoại của ai.
 */
const FULFILLMENT_RULES: OwnershipRule[] = FULFILLMENT_BLOCK_REASONS.map((reason) => ({
  key: `FULFILLMENT_EXCEPTION:${reason}`,
  label: `Chưa rời kho · ${BOTTLENECK_REASON_LABEL[reason]}`,
  department: departmentOfTeam(BOTTLENECK_TEAM[reason]),
  why:
    reason === "DATA_BLOCKED"
      ? "Phải gọi khách xác nhận lại SĐT / địa chỉ trước khi tạo được vận đơn — đó là việc của người bán, không phải của kho."
      : "Hàng còn nguyên trong kho, chỉ thiếu thao tác đóng gói / giục ĐVVC.",
}));

/** Luật cho từng loại cảnh báo còn thuộc nguồn `ALERT`. Khoá giống bảng hạn: `ALERT:<CaseType>`. */
const ALERT_RULES: OwnershipRule[] = CASE_TYPES.filter((t) => !ALERT_KINDS_OWNED_ELSEWHERE.includes(t) && sourceOfAlert(t) === "ALERT").map((t) => ({
  key: `ALERT:${t}`,
  label: CASE_TYPE_LABEL[t],
  department: departmentOfAlert(t),
  why: "Suy theo nhóm việc của loại cảnh báo (CASE_TEAM → TEAM_DEPARTMENT). Đổi ở đây chỉ đổi hàng đợi công việc.",
}));

/** Tồn kho: hai loại cảnh báo, cùng một phòng — khai riêng để trùng khớp với bảng hạn xử lý. */
const INVENTORY_RULES: OwnershipRule[] = (["LOW_STOCK_RISK", "STOCKOUT_RISK"] as const).map((kind) => ({
  key: `INVENTORY_EXCEPTION:${kind}`,
  label: CASE_TYPE_LABEL[kind],
  department: WORK_SOURCE_SPEC.INVENTORY_EXCEPTION.department!,
  why: SOURCE_OWNERSHIP_WHY.INVENTORY_EXCEPTION,
}));

export const DEFAULT_OWNERSHIP_RULES: OwnershipRule[] = [...SOURCE_RULES, ...FULFILLMENT_RULES, ...INVENTORY_RULES, ...ALERT_RULES];

export const DEFAULT_OWNERSHIP_MAP: Record<string, OwnershipRule> = Object.fromEntries(DEFAULT_OWNERSHIP_RULES.map((r) => [r.key, r]));

/** Phần chủ shop ghi đè, lưu ở `settings` khoá `work.ownership`. */
export type OwnershipOverrides = Record<string, DepartmentCode>;

export function isDepartmentCode(v: string): v is DepartmentCode {
  return (DEPARTMENT_CODES as readonly string[]).includes(v);
}

/**
 * Phòng ban của một việc, CÀNG CỤ THỂ CÀNG THẮNG — cùng thứ tự với bảng hạn xử lý:
 * ghi đè `type:kind` → ghi đè `type` → mặc định `type:kind` → mặc định `type` → phòng do adapter suy.
 *
 * `fallback` là phòng mà chính adapter suy được từ dữ liệu của dòng (ví dụ nút thắt fulfillment suy
 * theo `CASE_TEAM` của từng đơn). Nó đứng cuối vì nó là thứ duy nhất không sửa được trên màn hình
 * cấu hình — nhưng nó cũng không bao giờ để một việc rơi vào khoảng trống.
 */
export function departmentFor(sourceType: string, kind: string | null, fallback: DepartmentCode, overrides: OwnershipOverrides | null | undefined): DepartmentCode {
  const cuThe = kind ? `${sourceType}:${kind}` : null;
  if (cuThe && overrides?.[cuThe]) return overrides[cuThe];
  if (overrides?.[sourceType]) return overrides[sourceType];
  if (cuThe && DEFAULT_OWNERSHIP_MAP[cuThe]) return DEFAULT_OWNERSHIP_MAP[cuThe].department;
  if (DEFAULT_OWNERSHIP_MAP[sourceType]) return DEFAULT_OWNERSHIP_MAP[sourceType].department;
  return fallback;
}

/** Luật đang hiệu lực, để vẽ màn hình cấu hình. */
export function effectiveOwnershipRules(overrides: OwnershipOverrides | null | undefined): (OwnershipRule & { overridden: boolean; defaultDepartment: DepartmentCode })[] {
  return DEFAULT_OWNERSHIP_RULES.map((r) => {
    const ov = overrides?.[r.key];
    return { ...r, defaultDepartment: r.department, department: ov ?? r.department, overridden: Boolean(ov) };
  });
}

/**
 * Lá chắn khai báo: loại cảnh báo nào còn thuộc nguồn `ALERT` mà không có luật sở hữu.
 * Phải luôn rỗng — kiểm ở `tests/work-os.test.ts`.
 */
export const ALERT_TYPES_WITHOUT_OWNER: CaseType[] = CASE_TYPES.filter(
  (t) => !ALERT_KINDS_OWNED_ELSEWHERE.includes(t) && sourceOfAlert(t) === "ALERT" && !DEFAULT_OWNERSHIP_MAP[`ALERT:${t}`],
);

/**
 * Nguồn nào KHÔNG có luật sở hữu mức nguồn — và điều đó có cố ý không.
 * `ALERT` · `MANUAL_TASK` · `RECURRING_TASK` cố ý không có: phòng ban của chúng suy theo từng dòng.
 */
export const SOURCES_WITHOUT_OWNER: WorkSource[] = WORK_SOURCES.filter(
  (s) => WORK_SOURCE_SPEC[s].department !== null && !DEFAULT_OWNERSHIP_MAP[s] && !DEFAULT_OWNERSHIP_RULES.some((r) => r.key.startsWith(`${s}:`)),
);
