/**
 * ═══════════ PHẠM VI DỮ LIỆU: KHAI BÁO MỘT CHỖ, KHÔNG RẢI ĐIỀU KIỆN KHẮP NƠI ═══════════
 *
 * `lib/constants/access-scope.ts` định nghĩa NĂM MỨC phạm vi. Tệp này trả lời câu còn lại:
 * **với TỪNG loại dữ liệu, năm mức ấy thu hẹp được tới đâu.**
 *
 * ─── SỰ THẬT KHÓ CHỊU PHẢI NÓI TRƯỚC ───
 *
 * Kiểm kê `db/schema.ts` (13/09/2026): trong mười nhóm dữ liệu chủ shop nêu, **chỉ Công việc và
 * Chăm sóc vận đơn có khoá ngoại thật tới `users.id`.** Đơn hàng, khách hàng, vận đơn gốc, hàng
 * hoàn, tồn kho, báo cáo — không bảng nào biết ai là chủ của một dòng. `orders` có `seller_name`,
 * `care_name`, `marketer_name` nhưng cả ba là CHUỖI TÊN từ Pancake, không phải tài khoản ERP.
 *
 * Nghĩa là câu "SELF: chỉ dữ liệu thuộc chính user" **không thực hiện được** trên phần lớn dữ
 * liệu — không phải vì code lười, mà vì dữ liệu không mang thông tin đó.
 *
 * Có đúng ba cách xử lý, và hai trong ba là sai:
 *
 *   ✗ Cho xem hết.      → lỗ bảo mật im lặng. Đây CHÍNH LÀ trạng thái hôm nay: `users.data_scope`
 *                          tồn tại, hiện trên màn hình quản trị, và KHÔNG hàm truy vấn nào đọc nó.
 *                          Chủ shop đặt "Chỉ của mình" cho một người và tin rằng đã khoá.
 *   ✗ Trả rỗng lặng lẽ. → người dùng thấy màn hình trắng, không biết vì sao, và sẽ đi hỏi vòng
 *                          quanh cho tới khi có người tắt hẳn phạm vi đi.
 *   ✓ TỪ CHỐI VÀ NÓI RÕ. → màn hình báo đúng một câu: thu hẹp theo người trên dữ liệu này chưa
 *                          làm được vì thiếu cột nào. Lỗ hổng vô hình biến thành một việc thấy được.
 *
 * ─── HAI KIỂU THU HẸP ───
 *
 * 1. **THEO DÒNG** (`rowOwner` / `rowAssignee`): bảng có cột chỉ ra người của TỪNG DÒNG. Lọc được
 *    thật ở SQL.
 * 2. **THEO PHÒNG SỞ HỮU** (`ownedBy`): cả loại dữ liệu thuộc về một phòng. Sổ ngân hàng là việc
 *    của phòng Kế toán — không có "dòng tiền của riêng chị Lan". Ở đây thu hẹp nghĩa là: người
 *    KHÔNG thuộc phòng đó thì không vào, người thuộc phòng đó thì thấy đủ.
 *
 * Hai kiểu này không thay thế nhau. Bảng nào có cả hai thì dùng cả hai.
 */
import type { DepartmentCode } from "@/lib/constants/departments";

/** Cách một cột nối tới người dùng — quyết định độ tin cậy của phép lọc. */
export type OwnerLink =
  /** Khoá ngoại tới `users.id`. Khớp chính xác, không nhầm được. */
  | { by: "USER_ID"; column: string }
  /**
   * Cột CHUỖI chứa email tài khoản (lối cũ của kho mã này: `created_by`, `classified_by`,
   * `inspected_by`…). Khớp được, nhưng phải hạ chữ và cắt khoảng trắng, và một người đổi email
   * thì mất dấu dữ liệu cũ — nên độ tin cậy thấp hơn và phải nói ra.
   */
  | { by: "EMAIL"; column: string };

/**
 * CÁCH thu hẹp được thi hành cho loại dữ liệu này.
 *
 * Khai tường minh thay vì suy từ việc có cột hay không, vì "có một cột tên người" KHÔNG đồng
 * nghĩa với "thu hẹp theo người thì có nghĩa". `stock_receipts.created_by` nói AI ĐÃ GÕ phiếu —
 * lọc tồn kho theo đó sẽ giấu mất hàng của chính người đang cần đếm nó.
 */
export type ScopeEnforcement =
  /** Có mệnh đề SQL lọc theo dòng, áp trong `lib/queries/*`. */
  | "SQL_ROWS"
  /** Hàng đợi công việc là PHÉP CHIẾU trên nhiều nguồn; lớp chiếu tự lọc (`isMine`, phòng ban). */
  | "PROJECTION"
  /** Đã có luật "chỉ dòng của mình" riêng từ trước (lương). */
  | "OWN_LINE"
  /** Không có chủ theo dòng — chỉ chặn / mở theo PHÒNG SỞ HỮU. */
  | "DEPARTMENT_ONLY";

export type ScopeResource = {
  key: string;
  enforcement: ScopeEnforcement;
  label: string;
  /**
   * MỌI khoá quyền mở được một tuyến của loại dữ liệu này.
   *
   * Là một DANH SÁCH vì một loại dữ liệu trải trên nhiều tuyến với nhiều khoá (`/bank` dùng
   * `bank:view`, `/cod` dùng `cod:view`, `/reports/cashflow` dùng `reports:cash`). Có MỘT trong
   * số đó là đọc được loại dữ liệu này — nên màn xem trước phải hỏi "có khoá nào không", không
   * phải "có đúng khoá đại diện không".
   */
  readPermissions: readonly string[];
  /** Khoá quyền SỬA. `null` = loại dữ liệu này chỉ đọc (đơn hàng, khách hàng đến từ đồng bộ). */
  writePermission: string | null;
  /** Các tuyến thuộc loại dữ liệu này. Dùng cho kiểm thử phủ và cho màn xem trước. */
  routes: string[];
  /** Bảng chính, để câu từ chối nói được thiếu cột ở đâu. */
  table: string;
  /** Người CHỦ của từng dòng — `null` = bảng không biết. */
  rowOwner: OwnerLink | null;
  /** Người ĐƯỢC GIAO từng dòng — `null` = bảng không biết. */
  rowAssignee: OwnerLink | null;
  /** Cột phòng ban của từng dòng (`work_items.department_id`…) — `null` = không có. */
  rowDepartmentColumn: string | null;
  /** Phòng SỞ HỮU cả loại dữ liệu này. */
  ownedBy: DepartmentCode;
  /** Vùng nhạy cảm: tiền, nhân sự, điều hành. Xem `SENSITIVE_AREAS`. */
  sensitive: boolean;
  /** Vì sao không thu hẹp theo người được — chỉ khai khi `rowOwner` và `rowAssignee` đều `null`. */
  noRowOwnerReason?: string;
};

export const SCOPE_RESOURCES: readonly ScopeResource[] = [
  {
    key: "ORDERS",
    enforcement: "DEPARTMENT_ONLY",
    label: "Đơn hàng",
    readPermissions: ["orders:read"],
    writePermission: null,
    routes: ["/orders", "/orders/verify"],
    table: "orders",
    rowOwner: null,
    rowAssignee: null,
    rowDepartmentColumn: null,
    ownedBy: "SALES",
    sensitive: false,
    noRowOwnerReason:
      "`orders` chỉ có `seller_name` / `care_name` / `marketer_name` — CHUỖI TÊN từ Pancake, không phải tài khoản ERP. Ghép tên với tài khoản là đoán, và đoán sai ở đây nghĩa là cho người này xem đơn của người kia.",
  },
  {
    key: "CUSTOMERS",
    enforcement: "DEPARTMENT_ONLY",
    label: "Khách hàng",
    readPermissions: ["customers:view"],
    writePermission: null,
    routes: ["/customers", "/customers/retention"],
    table: "customers",
    rowOwner: null,
    rowAssignee: null,
    rowDepartmentColumn: null,
    ownedBy: "SALES",
    sensitive: false,
    noRowOwnerReason: "`customers` không có một cột người nào. Khách là của shop, không của một nhân viên.",
  },
  {
    key: "CS",
    enforcement: "SQL_ROWS",
    label: "Chăm sóc khách hàng",
    readPermissions: ["cs:view"],
    writePermission: "cs:manage",
    routes: ["/cs"],
    table: "cs_cases",
    /*
      KHOÁ TÀI KHOẢN, KHÔNG PHẢI Ô CHỮ. `cs_cases.assignee` là TÊN HIỂN THỊ ("Linh CSKH"), không
      phải email — nối theo email ở đó thì mệnh đề không khớp dòng nào và người phạm vi "Chỉ của
      mình" mở trang lên thấy trống. `assignee_user_id` / `created_by_user_id` là khoá thật
      (migration 0073). Dòng cũ chưa nối khoá thì KHÔNG hiện với phạm vi hẹp — đó là sự thật của
      dữ liệu (AGENTS.md mục 35: không đoán người cho dòng lịch sử), không phải lỗi của bộ lọc.
    */
    rowOwner: { by: "USER_ID", column: "created_by_user_id" },
    rowAssignee: { by: "USER_ID", column: "assignee_user_id" },
    rowDepartmentColumn: null,
    ownedBy: "SALES",
    sensitive: false,
  },
  {
    key: "SHIPMENTS",
    enforcement: "DEPARTMENT_ONLY",
    label: "Vận đơn",
    readPermissions: ["shipments:view"],
    writePermission: "shipments:manage",
    routes: ["/shipments", "/shipments/stock-wait"],
    table: "shipments",
    rowOwner: null,
    rowAssignee: null,
    rowDepartmentColumn: null,
    ownedBy: "LOGISTICS",
    sensitive: false,
    noRowOwnerReason:
      "`shipments` không có cột người. Người phụ trách nằm ở bảng CHĂM SÓC (`shipment_care.owner_id`) và chỉ tồn tại cho kiện ĐÃ MỞ ca care — phần lớn vận đơn không có ca nào, nên lọc theo đó sẽ giấu mất gần hết danh sách.",
  },
  {
    key: "WORK",
    enforcement: "PROJECTION",
    label: "Công việc",
    readPermissions: ["work:view", "work:department", "work:all"],
    writePermission: "work:manage",
    routes: ["/work", "/work/today", "/work/department", "/work/all"],
    table: "work_items",
    /*
      KHÔNG khai cột dòng dù `work_items` có `owner_id` / `assignee_id`: hai cột đó chỉ phủ việc
      tay và việc định kỳ, còn mười nguồn kia không có dòng nào ở bảng này. Một mệnh đề SQL trên
      `work_items` sẽ trông như "đã thu hẹp" trong khi hàng đợi thật không đi qua nó — sổ khai một
      luật không nơi nào thi hành là đúng lỗ hổng mà tệp này sinh ra để đóng.

      Thu hẹp thật nằm ở `decideScope`: người phạm vi SELF / ASSIGNED chỉ được vào hàng đợi CÁ NHÂN
      (`/work`, lọc bằng `isMine` trên khoá tài khoản), còn hàng đợi phòng / toàn shop và quyền giao
      việc bị TỪ CHỐI kèm lý do — vì danh sách "việc chưa giao cho ai" không thu hẹp được theo người.
    */
    rowOwner: null,
    rowAssignee: null,
    rowDepartmentColumn: null,
    ownedBy: "MANAGEMENT",
    sensitive: false,
    noRowOwnerReason:
      "Hàng đợi là PHÉP CHIẾU trên mười một nguồn; `work_items.assignee_id` chỉ phủ việc tay / định kỳ. Phạm vi hẹp được thi hành ở lớp chiếu: hàng đợi cá nhân lọc bằng khoá tài khoản (`isMine`), hàng đợi phòng / toàn shop từ chối người phạm vi SELF / ASSIGNED.",
  },
  {
    key: "FINANCE",
    enforcement: "DEPARTMENT_ONLY",
    label: "Tài chính",
    readPermissions: ["bank:view", "cod:view", "expenses:view", "reports:cash"],
    writePermission: "bank:write",
    routes: ["/bank", "/cod", "/expenses", "/finance", "/finance-ops", "/reports/cashflow"],
    table: "bank_transactions",
    rowOwner: null,
    rowAssignee: null,
    rowDepartmentColumn: null,
    ownedBy: "FINANCE",
    sensitive: true,
    noRowOwnerReason:
      "`bank_transactions.classified_by` nói AI ĐÃ PHÂN LOẠI dòng tiền, không phải dòng tiền đó THUỘC VỀ ai. Không có \"tiền của riêng chị Lan\" trong sổ ngân hàng của shop. Thu hẹp có nghĩa ở đây là theo PHÒNG: người không thuộc Kế toán thì không vào.",
  },
  {
    key: "INVENTORY",
    enforcement: "DEPARTMENT_ONLY",
    label: "Kho & tồn",
    readPermissions: ["products:view"],
    writePermission: "inventory:write",
    routes: ["/inventory", "/inventory/receipts", "/inventory/packing", "/products"],
    table: "stock_receipts",
    rowOwner: null,
    rowAssignee: null,
    rowDepartmentColumn: null,
    ownedBy: "WAREHOUSE",
    sensitive: false,
    noRowOwnerReason:
      "`stock_receipts.created_by` là AI ĐÃ GÕ phiếu. Lọc tồn kho theo đó sẽ giấu mất hàng của chính người đang cần đếm — tồn kho là con số của cả shop, không của người nhập phiếu.",
  },
  {
    key: "RETURNS",
    enforcement: "DEPARTMENT_ONLY",
    label: "Hàng hoàn",
    readPermissions: ["returns:view", "products:view"],
    writePermission: "inventory:write",
    routes: ["/returns", "/inventory/returns"],
    table: "return_inspections",
    rowOwner: null,
    rowAssignee: null,
    rowDepartmentColumn: null,
    ownedBy: "WAREHOUSE",
    sensitive: false,
    noRowOwnerReason:
      "`received_by` / `inspected_by` là AI ĐÃ ĐẾM kiện hàng, không phải kiện hàng đó thuộc về ai. Hàng hoàn là hàng của shop; giấu bớt kiện khỏi người kho là cách làm sai số tồn.",
  },
  {
    key: "ADS",
    enforcement: "DEPARTMENT_ONLY",
    label: "Quảng cáo",
    readPermissions: ["expenses:view"],
    writePermission: "expenses:write",
    routes: ["/ads"],
    table: "ad_spends",
    rowOwner: null,
    rowAssignee: null,
    rowDepartmentColumn: null,
    ownedBy: "MARKETING",
    sensitive: false,
    noRowOwnerReason:
      "`ad_spends.marketer_id` KHÔNG phải tài khoản ERP — nó trỏ tới nhân sự khai trong bảng lương. Dùng nó làm phạm vi là nối hai sổ danh tính khác nhau.",
  },
  {
    key: "REPORTS",
    enforcement: "DEPARTMENT_ONLY",
    label: "Báo cáo lợi nhuận",
    readPermissions: ["reports:delivered", "reports:cash", "reports:nominal", "reports:returns"],
    writePermission: "reports:assumptions",
    routes: ["/reports", "/reports/returns", "/reports/funnel", "/reports/scenario", "/products/performance"],
    table: "orders",
    rowOwner: null,
    rowAssignee: null,
    rowDepartmentColumn: null,
    ownedBy: "MANAGEMENT",
    sensitive: true,
    noRowOwnerReason:
      "Báo cáo là số TỔNG HỢP trên toàn shop. Một tổng đã cộng xong thì không tách lại thành phần của từng người được; muốn bản theo người thì phải là một báo cáo khác, không phải bản này bị lọc đi.",
  },
  {
    key: "PAYROLL",
    enforcement: "OWN_LINE",
    label: "Lương & hoa hồng",
    readPermissions: ["payroll:view", "payroll:view-own"],
    writePermission: "payroll:manage",
    routes: ["/payroll"],
    table: "settings",
    rowOwner: null,
    rowAssignee: null,
    rowDepartmentColumn: null,
    ownedBy: "HR",
    sensitive: true,
    noRowOwnerReason:
      "Bảng lương không phải một bảng CSDL mà là báo cáo dựng từ nhân sự khai trong `settings`. Luật \"chỉ dòng của mình\" đã có sẵn ở quyền `payroll:view-own`, khớp theo email / tên nhân sự — phạm vi không dựng lại luật đó.",
  },
] as const;

export const SCOPE_RESOURCE_BY_KEY: Record<string, ScopeResource> = Object.fromEntries(SCOPE_RESOURCES.map((r) => [r.key, r]));

/** Tuyến → loại dữ liệu. Tuyến không khai ở đây nghĩa là chưa có luật phạm vi cho nó. */
export const SCOPE_RESOURCE_BY_ROUTE: Record<string, ScopeResource> = Object.fromEntries(
  SCOPE_RESOURCES.flatMap((r) => r.routes.map((route) => [route, r])),
);

/** Loại dữ liệu có thu hẹp được theo TỪNG DÒNG không (dù chỉ bằng email)? */
export function hasRowOwnership(r: ScopeResource) {
  return r.rowOwner !== null || r.rowAssignee !== null;
}
