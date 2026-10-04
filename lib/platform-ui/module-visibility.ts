import { moduleOfPath, type ModuleKey } from "@/lib/constants/platform-modules";

/**
 * ═══════════ HIỆN HAY ẨN THEO MODULE — MỘT HÀM THUẦN CHO MỌI TẦNG GIAO DIỆN ═══════════
 *
 * Menu, ô lệnh ⌘K, chuông, trang tổng hợp (`/`, `/cockpit`, `/data-quality`) và danh sách công cụ AI
 * cùng hỏi MỘT câu: "thứ này thuộc module nào, và module đó có bật cho tổ chức của người xem không".
 * Câu trả lời nằm ở đây, không rải điều kiện theo TÊN tổ chức ở từng trang (phase-2-plan mục 3.3).
 *
 * Client-safe: chỉ import sổ module (thuần). Không đọc CSDL — tập module bật đã phân giải sẵn trong
 * `SessionUser.modules` (`resolveCurrentUser()` luôn điền).
 *
 * ─── ẨN KHÔNG PHẢI BẢO MẬT ───
 *
 * Cổng thật ở máy chủ (`resolveCurrentUser` theo đường dẫn, `can()` theo khoá quyền, `apiGuard`).
 * Hàm này để người dùng không gặp một khối trống, một con số 0 giả, hay một liên kết dẫn tới
 * `/module-disabled`.
 *
 * ─── `modules` VẮNG MẶT ───
 *
 * Chỉ người dùng dựng tay trong kiểm thử (cùng hợp đồng với `can()` và menu): không lọc gì. Mọi
 * `SessionUser` thật đều mang `modules`; một mảng RỖNG là "không module nào bật" ⇒ ẩn mọi thứ không
 * thuộc lõi — hỏng về phía HẸP.
 */

/** Tối thiểu để quyết định: tập module ĐANG BẬT (đã phân giải) của tổ chức người xem. */
export type ModuleViewer = { modules?: readonly string[] };

/** Module này có bật cho người xem không. */
export function moduleOn(viewer: ModuleViewer, key: ModuleKey): boolean {
  if (!viewer.modules) return true;
  return viewer.modules.includes(key);
}

/** Mọi module trong danh sách đều bật. Danh sách rỗng ⇒ `true` (không phụ thuộc module nào). */
export function modulesOn(viewer: ModuleViewer, keys: readonly ModuleKey[]): boolean {
  return keys.every((k) => moduleOn(viewer, k));
}

/**
 * Liên kết này có dẫn tới một trang MỞ ĐƯỢC không. Module của đường dẫn tra bằng `moduleOfPath`
 * (tiền tố dài nhất, bỏ query/fragment): `/inventory/planning` thuộc Sản xuất dù `/inventory` thuộc
 * Kho. Đường dẫn không thuộc module nào (tuyến máy-gọi-máy, `/login`, liên kết ngoài) ⇒ hiện.
 */
export function hrefVisible(viewer: ModuleViewer, href: string): boolean {
  const owner = moduleOfPath(href);
  return owner === null || moduleOn(viewer, owner);
}

// ═══════════ KHỐI CỦA TRANG TỔNG HỢP ═══════════

/**
 * Một khối trên trang tổng hợp: module NGUỒN của số liệu. Khối hiện ⇔ mọi module nguồn bật. Liên kết
 * bên trong khối đi qua `hrefVisible` riêng (thẻ `MetricCard` nhận `linkable`) — số liệu của một module mà liên kết tới trang
 * của module khác (vd thẻ "Doanh thu giao thành công" thuộc Đơn hàng nhưng mở báo cáo của Hàng hoàn).
 */
export type AggregateBlock = { modules: readonly ModuleKey[]; why: string };

/** Trang `/` — Tổng quan. Tổ chức bật mọi module thấy ĐỦ mọi khối như trước (bài kiểm). */
export const DASHBOARD_BLOCKS = {
  pancakeSync: { modules: ["connector_pancake"], why: "Nút «Đồng bộ ngay», dải «Chưa kết nối Pancake POS» và «Đồng bộ toàn bộ Pancake» — chạy job của connector Pancake." },
  bookedRevenue: { modules: ["orders"], why: "① Doanh thu lên đơn — đơn đã xác nhận." },
  deliveredRevenue: { modules: ["orders"], why: "② Doanh thu giao thành công — kết quả đơn theo ORDER_OUTCOME; liên kết sang Tỷ lệ hoàn chỉ bấm được khi Hàng hoàn bật." },
  cashReceived: { modules: ["finance"], why: "③ Tiền thực nhận — bảng kê + chuyển khoản, báo cáo Tài chính." },
  revenueChart: { modules: ["orders"], why: "Biểu đồ doanh thu theo ngày — lên đơn và giao thành công." },
  estimatedProfit: { modules: ["finance"], why: "Lợi nhuận ước tính — báo cáo lợi nhuận, trừ chi phí vận hành phân bổ." },
  contribution: { modules: ["finance"], why: "Lợi nhuận góp — báo cáo lợi nhuận." },
  carrierHolding: { modules: ["finance", "logistics"], why: "«Viettel Post còn giữ» — tiền đơn giao thành công chưa có trên bảng kê ĐVVC: cần cả Đối soát COD lẫn Vận chuyển." },
  attention: { modules: ["alerts"], why: "«Việc cần xử lý» — mở hàng đợi Cần xử lý (/alerts)." },
  adsRatios: { modules: ["marketing"], why: "Hai tỷ lệ QC / doanh thu — chi quảng cáo, mở /ads." },
  dataIssues: { modules: ["core"], why: "«Dữ liệu sai nghiêm trọng» — bộ luật đối soát, mở /data-quality (lõi)." },
  freshness: { modules: ["logistics"], why: "Dải độ tươi — kiện đang đi, webhook ĐVVC, mở tháp Giao vận." },
  brief: { modules: ["orders"], why: "Tóm tắt & rủi ro — câu tóm tắt đọc doanh thu đơn; từng rủi ro lọc theo liên kết của nó." },
  ownerDecisions: { modules: ["core"], why: "Cần anh quyết — loại quyết định đã lọc theo module ở `viewerKinds`." },
  todayActions: { modules: ["alerts"], why: "Việc cần làm hôm nay — hàng đợi của module Cần xử lý." },
  fulfillment: { modules: ["logistics"], why: "Hàng đang ở đâu — theo chứng từ ĐVVC." },
  orderFlow: { modules: ["orders"], why: "Luồng đơn hàng — số đơn theo giai đoạn." },
  channels: { modules: ["orders"], why: "Hiệu quả theo kênh bán — doanh thu đơn theo nguồn." },
  topProducts: { modules: ["orders", "products"], why: "Sản phẩm bán chạy — dòng hàng của đơn, mở /products." },
} as const satisfies Record<string, AggregateBlock>;

/**
 * Trang `/data-quality` — bảy ô vấn đề dữ liệu legacy và các khối đứng riêng. Bảng «Sổ lỗ hổng» và
 * «Trung tâm điều khiển» lọc theo liên kết của từng dòng, không khai ở đây.
 */
export const DATA_QUALITY_BLOCKS = {
  summary: { modules: ["orders"], why: "Hai thẻ đơn / COD chưa xác minh." },
  adsCoverage: { modules: ["marketing"], why: "Độ phủ quy kết quảng cáo 30 ngày — đơn có dấu vết Facebook." },
  "unlinked-shipment": { modules: ["logistics"], why: "Vận đơn chưa nối được với đơn." },
  "status-conflict": { modules: ["logistics"], why: "Pancake và Viettel Post nói khác nhau." },
  "pancake-declared": { modules: ["connector_pancake"], why: "Pancake báo giao nhưng không có tiền — nhãn trạng thái của Pancake." },
  "vtp-low-cash": { modules: ["logistics"], why: "Số tiền legacy của vận đơn Viettel Post dưới ngưỡng." },
  "return-not-received": { modules: ["returns"], why: "Hàng hoàn chưa xác nhận về kho." },
  "missing-cogs": { modules: ["orders"], why: "Đơn giao thành công thiếu giá vốn." },
  unverified: { modules: ["orders"], why: "Đơn không có số tiền nào để kết luận." },
} as const satisfies Record<string, AggregateBlock>;

/** Khối nào hiện với người xem — `{ khoá: boolean }`, cùng khoá với bảng khai. */
export function visibleBlocks<K extends string>(viewer: ModuleViewer, blocks: Record<K, AggregateBlock>): Record<K, boolean> {
  const out = {} as Record<K, boolean>;
  for (const key of Object.keys(blocks) as K[]) out[key] = modulesOn(viewer, blocks[key].modules);
  return out;
}

/**
 * Một liên kết nội bộ tới ô vấn đề của `/data-quality` (`?issue=<khoá>`) chỉ mở được khi ô ấy hiện —
 * đường dẫn thuộc lõi nhưng DANH SÁCH là của module nguồn. Liên kết khác đi theo `hrefVisible`.
 */
export function dataQualityHrefVisible(viewer: ModuleViewer, href: string): boolean {
  if (!hrefVisible(viewer, href)) return false;
  const issue = /^\/data-quality\?(?:[^#]*&)?issue=([a-z-]+)/.exec(href)?.[1];
  if (!issue) return true;
  const block = (DATA_QUALITY_BLOCKS as Record<string, AggregateBlock>)[issue];
  return block ? modulesOn(viewer, block.modules) : true;
}

// ═══════════ NÚT «ĐỒNG BỘ …» (pilot P1 #12) ═══════════

/**
 * Nút đồng bộ chạy job nào ⇒ job đó cần module nào. Nút hiện ⇔ mọi module của job bật cho tổ chức người xem — tổ chức
 * không có nguồn (Pancake / Viettel Post / Meta là connector HOME_ONLY) không thấy một nút bấm vào chỉ để nhận
 * «Không có quyền» hay «SKIPPED». Bảng PHẢI khớp `jobModules(JOB_DEFINITIONS[job])` (lib/sync/jobs.ts — chỉ máy chủ,
 * nên tệp client-safe này giữ bản khai; `tests/pilot-products.test.ts` so từng dòng, lệch là đỏ). Job không có trong
 * bảng ⇒ ẨN (hỏng về phía hẹp) — và bài kiểm đòi mọi `<ModuleSyncButton job=…>` trong `app/` có mặt ở đây.
 */
export const SYNC_JOB_MODULES = {
  "pancake-products": ["connector_pancake"],
  "pancake-customers": ["connector_pancake"],
  "pancake-orders": ["connector_pancake"],
  "pancake-inventory": ["connector_pancake"],
  "pancake-returns": ["connector_pancake"],
  "pancake-all": ["connector_pancake"],
  // Pancake POS của tổ chức khách (kết nối «pancake-pos-org», module Đơn hàng). Nút chỉ đặt ở khung kết nối của tổ chức khách.
  "pancake-org": ["orders"],
  "vtp-tracking": ["connector_viettelpost"],
  "vtp-import": ["connector_viettelpost"],
} as const satisfies Record<string, readonly ModuleKey[]>;

export function syncJobVisible(viewer: ModuleViewer, job: string): boolean {
  const mods = (SYNC_JOB_MODULES as Record<string, readonly ModuleKey[]>)[job];
  return mods ? modulesOn(viewer, mods) : false;
}
