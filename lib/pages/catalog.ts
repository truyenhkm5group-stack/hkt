/**
 * SỔ NGUỒN DỮ LIỆU + SỔ ACTION của trang động (Phase 4) — thuần, client-safe (trình soạn đọc được).
 * Hợp đồng: docs/platform/phase-4-contracts.md G4, G5. Sổ ĐÓNG: chỉ khoá khai ở đây mới dùng được trong trang;
 * trình phân giải ở `lib/pages/data-sources.ts` / `lib/pages/actions.ts` (chỉ máy chủ) kiểm module + quyền +
 * phạm vi theo NGƯỜI XEM ở mọi lượt — sổ này chỉ là lời khai, không phải ranh giới an ninh.
 *
 * ─── QUYỀN LÀ QUYỀN CỔNG VÀO CỦA TRANG CŨ ───
 *
 * Mỗi nguồn khai ĐÚNG khoá quyền mà trang cũ cùng dữ liệu dùng làm cổng vào (`requireResource` /
 * `requirePermission` của trang đó). Mượn một khoá "gần đúng" là mở một lối vòng: người không vào được
 * `/reports` vẫn đọc được doanh thu giao thành công qua một khối KPI trên trang tự dựng.
 *
 * ─── MỌI SỐ ĐƠN / DOANH THU ĐI QUA HÀM CÓ SẴN ───
 *
 * Không nguồn nào ở đây có công thức riêng. Đơn lên / doanh thu lên đơn / đơn hoàn đọc `orderKpis` (chính
 * hàm của thẻ Tổng quan — `metricScope` + `orderMetricFacts`, kết quả đơn qua `ORDER_OUTCOME`); chỉ số của
 * sổ `METRIC_BINDINGS` đọc qua `resolveMetric`; tồn khả dụng đọc `availableStockExpr` + `stockKnownExpr` của
 * sổ kho (luật 10). CHƯA BIẾT ⇒ `null` ⇒ "—" (luật 42), không bao giờ 0.
 */
import { OBJECT_REGISTRY, type AnyObjectDef } from "@/lib/constants/object-registry";
import type { ModuleKey } from "@/lib/constants/platform-modules";
import { OBJECT_RECORD_PERMISSIONS, objectAccess } from "@/lib/metadata/permissions";
import type { ListSourceSpec, MetricSourceSpec, PageActionSpec, SeriesSourceSpec, TimelineSourceSpec } from "@/lib/pages/types";
import type { PeriodKey } from "@/lib/search-params";

/** Kỳ của một chỉ số tính THEO KỲ (ngày lên đơn). */
const PERIODS: PeriodKey[] = ["today", "yesterday", "7d", "30d", "month", "last_month", "90d", "year", "all", "custom"];
/** Chỉ số ẢNH CHỤP hiện tại (tồn, công nợ, tồn đọng) — không có kỳ; khai `all` để trình soạn không mời chọn kỳ. */
const SNAPSHOT: PeriodKey[] = ["all"];
/** Chuỗi theo NGÀY — có trần kỳ để một biểu đồ không thành hàng nghìn điểm. */
const DAILY: PeriodKey[] = ["7d", "30d", "month", "last_month", "90d", "custom"];

/** Chỉ số dùng được với tập module này (`requiresAnyModule` rỗng / vắng ⇒ luôn được) — MỘT luật cho trình soạn và AI. */
export function metricAvailableFor(spec: Pick<MetricSourceSpec, "requiresAnyModule">, modules: readonly string[] | ReadonlySet<string> | undefined): boolean {
  if (!spec.requiresAnyModule?.length || modules === undefined) return true;
  const has = (m: string) => (Array.isArray(modules) ? (modules as readonly string[]).includes(m) : (modules as ReadonlySet<string>).has(m));
  return spec.requiresAnyModule.some(has);
}

/**
 * Tiêu đề hiển thị của một khối KPI (pilot P1 #8) — hàm THUẦN cho renderer. Chỉ số SỔ (`labelLocked`): nhãn chính LUÔN là
 * nhãn gốc của sổ; tên trang / AI đặt (tiêu đề khối hoặc `label` của cấu hình) khác nhãn gốc thì hiện NHỎ ở dòng ghi chú,
 * không thay nhãn. KPI tổng hợp: tiêu đề khối (nếu có) thắng như trước.
 */
export function kpiHeading(blockTitle: string | undefined, d: { label: string; note?: string; customLabel?: string; labelLocked?: boolean }): { label: string; note?: string } {
  if (!d.labelLocked) return { label: blockTitle ?? d.label, ...(d.note ? { note: d.note } : {}) };
  const title = blockTitle?.trim();
  const custom = title && title !== d.label ? title : d.customLabel;
  const note = [custom ? `Tên trên trang: ${custom}` : null, d.note ?? null].filter((x): x is string => Boolean(x)).join(" · ");
  return { label: d.label, ...(note ? { note } : {}) };
}

export const METRIC_SOURCES: readonly MetricSourceSpec[] = [
  {
    key: "orders_today",
    label: "Đơn lên hôm nay",
    module: "orders",
    permission: "orders:read",
    format: "number",
    periods: ["today"],
    why: "Đơn ĐÃ XÁC NHẬN lên hôm nay, trừ đơn huỷ theo ORDER_OUTCOME — cùng hàm `orderKpis` với thẻ Tổng quan. Kỳ luôn là hôm nay (tên nguồn nói vậy). Cổng `orders:read` = cổng của /orders.",
  },
  {
    key: "booked_revenue",
    label: "Doanh thu lên đơn",
    module: "orders",
    permission: "orders:read",
    format: "vnd",
    periods: PERIODS,
    why: "Giá trị đơn khách đã chốt (BOOKED_REVENUE qua `orderKpis`), chưa nói gì về giao được hay thu được tiền. /orders in cùng loại con số này dưới `orders:read`.",
  },
  {
    key: "delivered_orders",
    label: "Đơn giao thành công",
    module: "orders",
    permission: "orders:read",
    format: "number",
    periods: PERIODS,
    why: "Khoá `delivered_orders` của METRIC_BINDINGS (COUNT_DELIVERED — ORDER_OUTCOME: chứng từ ĐVVC trước, tiền sau). /orders in số đơn giao thành công dưới `orders:read`.",
  },
  {
    key: "delivered_revenue",
    label: "Doanh thu giao thành công",
    module: "finance",
    permission: "reports:delivered",
    format: "vnd",
    periods: PERIODS,
    why: "Khoá `delivered_revenue` của METRIC_BINDINGS qua `resolveMetric`. Là số TÀI CHÍNH: cổng `reports:delivered` = tab lợi nhuận theo đơn giao của /reports.",
  },
  {
    key: "returns_in_period",
    label: "Đơn hoàn trong kỳ",
    module: "returns",
    permission: "returns:view",
    format: "number",
    periods: PERIODS,
    why: "Đơn lên trong kỳ mà ORDER_OUTCOME kết luận hoàn (RETURNED + RETURNED_BY_RULE gộp) — `orderKpis().returnedOrders`. Không phải kiện kho đã nhận: hàng hoàn chỉ vào tồn khi kho lập phiếu (luật 4).",
  },
  {
    key: "return_rate",
    label: "Tỷ lệ hoàn",
    module: "returns",
    permission: "reports:returns",
    format: "percent",
    periods: PERIODS,
    why: "Khoá `return_rate` của METRIC_BINDINGS. Chưa đơn nào kết thúc ⇒ `null` (—), không phải 0%. Cổng `reports:returns` = cổng của /reports/returns.",
  },
  {
    key: "delivery_success_rate",
    label: "Tỷ lệ giao thành công",
    module: "returns",
    permission: "reports:returns",
    format: "percent",
    periods: PERIODS,
    why: "Khoá `delivery_success_rate` của METRIC_BINDINGS — phần bù của tỷ lệ hoàn trên cùng mẫu số (đơn đã kết thúc). Cùng cổng /reports/returns.",
  },
  {
    key: "available_stock",
    label: "Tồn khả dụng",
    module: "inventory",
    permission: "products:view",
    format: "number",
    periods: SNAPSHOT,
    why: "Sổ kho (luật 10): tổng DƯƠNG của `availableStockExpr` trên mẫu mã ĐÃ có phiếu RECEIPT. Mẫu chưa có phiếu nhập là CHƯA BIẾT — không cộng, khối ghi rõ bao nhiêu mẫu bị bỏ; không mẫu nào biết tồn ⇒ `null`. Cổng `products:view` = cổng của /inventory.",
  },
  {
    key: "return_inspection_backlog",
    label: "Kiện hoàn chờ kiểm đếm",
    module: "returns",
    permission: "returns:view",
    format: "number",
    periods: SNAPSHOT,
    why: "Khoá `return_inspection_backlog` của METRIC_BINDINGS — kiện ĐVVC đã trả về mà kho chưa lập phiếu (hàng hoàn không tự vào tồn).",
  },
  {
    key: "cod_outstanding",
    label: "COD đã giao mà tiền chưa về",
    module: "finance",
    permission: "cod:view",
    format: "vnd",
    periods: SNAPSHOT,
    why: "Khoá `cod_outstanding` của METRIC_BINDINGS — tiền THỰC THU có chứng từ, chưa tới PAID_TO_BANK. Cổng `cod:view` = cổng của /cod. Chỉ có nghĩa khi tổ chức có kết nối vận chuyển (COD do ĐVVC thu hộ) — tổ chức không có thì trình soạn và AI không gợi ý (pilot P1 #8).",
    requiresAnyModule: ["connector_viettelpost"],
  },
  {
    key: "unclassified_bank_txns",
    label: "Dòng tiền chưa phân loại",
    module: "finance",
    permission: "bank:view",
    format: "number",
    periods: SNAPSHOT,
    why: "Khoá `unclassified_bank_txns` của METRIC_BINDINGS. Cổng `bank:view` = cổng của /bank.",
  },
  {
    key: "ads_spend",
    label: "Chi quảng cáo",
    module: "marketing",
    permission: "expenses:view",
    format: "vnd",
    periods: PERIODS,
    why: "Khoá `ads_spend` của METRIC_BINDINGS (ad_spends theo ngày chi). Cổng `expenses:view` = cổng của /ads.",
  },
];

export const SERIES_SOURCES: readonly SeriesSourceSpec[] = [
  {
    key: "orders_by_day",
    label: "Đơn lên theo ngày",
    module: "orders",
    permission: "orders:read",
    kinds: ["bar", "line"],
    format: "number",
    periods: DAILY,
    why: "COUNT_BOOKED theo ngày lên đơn (giờ VN) trên `orderMetricFacts` — cộng các ngày ra ĐÚNG số của `orderKpis` cùng kỳ. Ngày không có đơn là 0 thật (đếm được), không phải chưa biết.",
  },
  {
    key: "booked_revenue_by_day",
    label: "Doanh thu lên đơn theo ngày",
    module: "orders",
    permission: "orders:read",
    kinds: ["line", "bar"],
    format: "vnd",
    periods: DAILY,
    why: "BOOKED_REVENUE theo ngày lên đơn trên `orderMetricFacts` — cùng population, cùng kết quả đơn với thẻ Tổng quan.",
  },
  {
    key: "orders_by_stage",
    label: "Đơn theo trạng thái Pancake",
    module: "orders",
    permission: "orders:read",
    kinds: ["bar", "pie"],
    format: "number",
    periods: PERIODS,
    why: "Phân bố `orders.stage` — NHÃN do người bán bấm trên Pancake, KHÔNG phải kết quả đơn (ORDER_OUTCOME). Nhãn theo cấu hình trạng thái của tổ chức (Phase 2 `resolveStatusOptions`).",
  },
];

/** Đối tượng có trang danh sách / chi tiết cũ; quyền xem lấy từ `OBJECT_RECORD_PERMISSIONS` (= cổng trang cũ). */
const LIST_OBJECTS: { objectKey: "customer" | "order" | "product" | "shipment" | "return"; why: string }[] = [
  { objectKey: "customer", why: "Cổng /customers (`customers:view`). Cột = field hệ thống `listable` của sổ đối tượng + field custom người xem được xem." },
  { objectKey: "order", why: "Cổng /orders (`orders:read`). Chỉ HIỂN THỊ cột thật của đơn — trạng thái là nhãn Pancake, không phải kết quả đơn." },
  { objectKey: "product", why: "Cổng /products (`products:view`)." },
  { objectKey: "shipment", why: "Cổng /shipments (`shipments:view`). Trạng thái vận đơn không cấu hình được; chỉ cột hệ thống + custom." },
  { objectKey: "return", why: "Cổng /returns (`returns:view`). Phiếu hoàn Pancake — không phải số kho đã nhận." },
];

export const LIST_SOURCES: readonly ListSourceSpec[] = LIST_OBJECTS.map(({ objectKey, why }) => {
  const def = OBJECT_REGISTRY.find((o) => o.key === objectKey)!;
  return { objectKey, label: def.labelPlural, module: def.module, permission: OBJECT_RECORD_PERMISSIONS[objectKey].view, why };
});

/** Tiền tố khoá nguồn dòng thời gian của field custom — một nguồn cho mỗi đối tượng có field custom. */
export const CUSTOM_RECORD_TIMELINE_PREFIX = "custom_record_";

const CUSTOM_RECORD_OBJECTS = ["customer", "order", "product", "shipment", "return", "production_order"] as const;

export const TIMELINE_SOURCES: readonly TimelineSourceSpec[] = [
  {
    key: "order",
    label: "Dòng thời gian đơn hàng",
    module: "orders",
    permission: "orders:read",
    recordObject: "order",
    why: "`getOrderTimeline` — năm chiều sự thật (Pancake, ĐVVC, bảng kê, phiếu hoàn, nhật ký), mỗi mốc mang nguồn.",
  },
  {
    key: "shipment",
    label: "Nhật ký vận đơn",
    module: "logistics",
    permission: "shipments:view",
    recordObject: "shipment",
    why: "`getShipmentTimeline` — bốn chiều tách rời (ĐVVC · người · hệ thống · kết luận), lời khai ĐVVC không bị sửa (luật 47).",
  },
  {
    key: "model",
    label: "Dòng thời gian mẫu",
    module: "production",
    permission: "models:view",
    // Mẫu (`product_models`) chưa có trong sổ đối tượng; khoá bản ghi là id mẫu của /models/[id].
    recordObject: "model",
    why: "`getModelTimeline` — sự kiện sổ mẫu + phép chiếu nhật ký lệnh SX / phiếu kho / đơn đầu. Cổng `models:view` = cổng của /models.",
  },
  ...CUSTOM_RECORD_OBJECTS.map((objectKey): TimelineSourceSpec => {
    const def = OBJECT_REGISTRY.find((o) => o.key === objectKey)!;
    return {
      key: `${CUSTOM_RECORD_TIMELINE_PREFIX}${objectKey}`,
      label: `Lịch sử dữ liệu bổ sung · ${def.label}`,
      module: def.module,
      permission: OBJECT_RECORD_PERMISSIONS[objectKey].view,
      recordObject: objectKey,
      why: `\`domain_events\` (subject \`custom_record\`, id đúng bằng "${objectKey}:<id>") + \`audit_logs\` entity_id bằng đúng — chỉ field người xem được xem. Một khoá cho mỗi đối tượng vì cấu hình khối dòng thời gian không mang khoá đối tượng.`,
    };
  }),
];

export const PAGE_ACTIONS: readonly PageActionSpec[] = [
  {
    key: "open_page",
    label: "Mở trang",
    module: null,
    permission: null,
    sideEffect: "NONE",
    requiresApproval: false,
    why: "Chỉ điều hướng tới `/p/<slug>` của CÙNG tổ chức; trang đích tự kiểm module + quyền khi mở.",
  },
  {
    key: "open_record",
    label: "Mở bản ghi",
    module: null,
    permission: null,
    sideEffect: "NONE",
    requiresApproval: false,
    why: "Điều hướng tới trang chi tiết có sẵn của đối tượng; máy chủ kiểm module + quyền xem của ĐÚNG đối tượng đó trước khi trả đường dẫn, trang đích kiểm lại.",
  },
  {
    key: "create_record",
    label: "Tạo khách hàng",
    module: "customers",
    permission: "customers:write",
    objectKey: "customer",
    sideEffect: "WRITE",
    requiresApproval: false,
    why: "Cùng cổng `customerCreateGate` + lõi `createCustomerCore` của Phase 2 (form `create` đã xuất bản quyết định ô nhận ghi; tổ chức bật Pancake không tạo tay).",
  },
  {
    key: "update_safe_field",
    label: "Sửa field bổ sung",
    // Module / quyền đi theo ĐỐI TƯỢNG khai trong cấu hình nút (hoặc khối kanban): `saveCustomValues` kiểm
    // module của đối tượng, quyền ghi `OBJECT_RECORD_PERMISSIONS[..].edit` và `editPermission` từng field.
    module: null,
    permission: null,
    sideEffect: "WRITE",
    requiresApproval: false,
    why: "CHỈ field custom, qua `saveCustomValues` (quyền theo field, luật chuyển trạng thái, khoá lạc quan, nhật ký). Không bao giờ chạm cột hệ thống (đơn, vận đơn, COD, kho).",
  },
  {
    key: "run_workflow",
    label: "Chạy luật tự động ngay",
    module: "work",
    permission: "workflow:manage",
    sideEffect: "WRITE",
    requiresApproval: false,
    why: "Bọc `runWorkflows()` của Phase 3 trong tổ chức hiện hành — cùng một lượt với bộ hẹn giờ, không engine thứ hai. Luật đã được người có `workflow:manage` khai và bật.",
  },
  {
    key: "request_approval",
    label: "Gửi yêu cầu duyệt",
    module: "customers",
    permission: "customers:write",
    objectKey: "customer",
    sideEffect: "WRITE",
    requiresApproval: true,
    why: "Map qua luật workflow CÓ CỬA DUYỆT: nút khai `ruleKey`; máy chủ chỉ nhận luật ĐANG BẬT, chạy thật, trigger `custom_status` trên khách và có `gate: approval`, rồi chuyển field trạng thái sang giá trị kích hoạt qua `saveCustomValues` (luật chuyển của field vẫn áp) và gọi `runWorkflows()` — yêu cầu duyệt do CHÍNH bộ máy Phase 3 tạo. Từ chối nếu một luật đang bật khác KHÔNG có cửa duyệt cũng khớp lượt đổi ấy (nút sẽ thành đường chạy hành động không qua duyệt).",
  },
];

// ─── Đối tượng tuỳ biến (Phase 6 · hợp đồng §7) — mục ĐỘNG, dựng từ `ObjectDef` của tổ chức ───
//
// Sổ tĩnh ở trên KHÔNG đổi. Đối tượng tuỳ biến ACTIVE của tổ chức hiện hành được NỐI THÊM vào sổ hiệu lực
// (`effectivePageCatalog` — lib/pages/custom-sources.ts, chỉ máy chủ) bằng hai hàm thuần dưới đây. Khoá `x_…` không bao
// giờ trùng khoá hệ thống (ràng buộc CSDL), nên nối thêm không che mất mục nào của sổ tĩnh.

/**
 * Nguồn danh sách của MỘT đối tượng tuỳ biến. `module`: `apps`, hoặc module ĐANG TẮT mà đối tượng cần (nhóm menu) — để
 * phép kiểm module của `validatePageSchema` nói đúng module phải bật (cảnh báo khi lưu nháp, chặn khi xuất bản).
 */
export function customObjectListSource(def: AnyObjectDef, module: ModuleKey): ListSourceSpec {
  const permissions = objectAccess(def).view;
  return {
    objectKey: def.key,
    label: def.labelPlural,
    module,
    permission: permissions[0],
    permissions,
    why: `Đối tượng tuỳ biến của tổ chức (${def.key}) — bản ghi ở custom_records (lọc đúng khoá đối tượng + chưa xoá), giá trị ở custom_values; phạm vi CUSTOM_RECORDS theo người phụ trách. Cổng = cổng của /o/${def.key}.`,
  };
}

/**
 * Dòng thời gian của MỘT đối tượng tuỳ biến: khoá `custom_record_<x_khoá>` — cùng tiền tố với nguồn "lịch sử dữ liệu bổ
 * sung" của đối tượng hệ thống (cấu hình khối dòng thời gian không mang khoá đối tượng, nên một khoá cho mỗi đối tượng),
 * không bao giờ trùng vì khoá đối tượng tuỳ biến luôn bắt đầu bằng `x_`.
 */
export function customObjectTimelineSource(def: AnyObjectDef, module: ModuleKey): TimelineSourceSpec {
  const permissions = objectAccess(def).view;
  return {
    key: `${CUSTOM_RECORD_TIMELINE_PREFIX}${def.key}`,
    label: `Dòng thời gian · ${def.label}`,
    module,
    permission: permissions[0],
    permissions,
    recordObject: def.key,
    why: "Cùng dòng thời gian của trang chi tiết /o/… (`recordTimeline`): nhật ký ghi + sự kiện miền của bản ghi; mốc chạm field người xem không được xem không hiện.",
  };
}

export function metricSource(key: string): MetricSourceSpec | null {
  return METRIC_SOURCES.find((s) => s.key === key) ?? null;
}
export function seriesSource(key: string): SeriesSourceSpec | null {
  return SERIES_SOURCES.find((s) => s.key === key) ?? null;
}
export function listSource(objectKey: string): ListSourceSpec | null {
  return LIST_SOURCES.find((s) => s.objectKey === objectKey) ?? null;
}
export function timelineSource(key: string): TimelineSourceSpec | null {
  return TIMELINE_SOURCES.find((s) => s.key === key) ?? null;
}
export function pageAction(key: string): PageActionSpec | null {
  return PAGE_ACTIONS.find((a) => a.key === key) ?? null;
}
