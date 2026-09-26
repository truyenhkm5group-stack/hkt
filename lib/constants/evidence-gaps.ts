import { MODEL_STATE_LABELS, type ModelState } from "@/lib/constants/model-lifecycle";
import { vnDateKey } from "@/lib/format";

/**
 * ═══════════ LỜI KHAI ≠ CHỨNG CỨ — HAI CHỖ HỞ GIỮA VIỆC THẬT VÀ ERP (Company OS · Agent P2) ═══════════
 *
 * Đo production 26/09/2026 (ops company-os-summary): 7 mẫu, chủ shop KHAI ĐỦ vòng đời (SAMPLING 1 ·
 * SELLING 3 · CLEARANCE 3) — nhưng production_topics 0, cost_sheets 0, samples 0, design_versions 0;
 * 1 lệnh SX không trỏ bản duyệt; 8 phiếu NHẬP HÀNG, 0 phiếu nối lệnh / lô. Nghĩa là người KHAI trạng
 * thái trong ERP còn việc sản xuất thật vẫn diễn ra ở ngoài, và phiếu nhập không nối về lần đặt xưởng.
 *
 * Tệp này chỉ trả lời "ERP có đang nói hai điều trái nhau không". Nó KHÔNG sửa gì:
 *  · không đổi `lifecycle_state` (chỉ `transitionModelCore`, luật của Agent A — máy ghi trạng thái là
 *    biến một phép đoán thành một lời khai có tên người);
 *  · không tạo topic / giá thành / mẫu (việc đó là của người, ở màn hình của C);
 *  · không nối phiếu nhập vào lệnh (AGENTS.md mục 35 — nối là một quy kết, NGƯỜI chọn).
 *
 * Cả hai là PHÉP CHIẾU tính lúc đọc (luật 19 / 26): không dòng nào được lưu, nên chỗ hở tự biến mất
 * đúng lúc người mở topic / ghi mẫu / sửa trạng thái / nối phiếu.
 *
 * Tệp THUẦN — không đọc/ghi CSDL, chạy hai lần ra cùng kết quả, không đọc đồng hồ.
 */

// ─────────────────────────── 1. TRẠNG THÁI KHAI MÀ ERP KHÔNG CÓ CHỨNG CỨ ───────────────────────────

/** Loại chứng từ sản xuất mà một trạng thái khai ngụ ý là đã có trong ERP. */
export const LIFECYCLE_EVIDENCE = ["TOPIC", "COST_SHEET", "SAMPLE", "DESIGN_VERSION", "OPEN_PRODUCTION_ORDER"] as const;
export type LifecycleEvidence = (typeof LIFECYCLE_EVIDENCE)[number];

/**
 * Trạng thái khai ⇒ ĐÚNG MỘT chứng từ phải có. Chỉ các trạng thái SẢN XUẤT (từ "Bàn sản xuất" tới
 * "Đang sản xuất").
 *
 * CỐ Ý KHÔNG có trong bảng:
 *  · trước "Bàn sản xuất" (IDEA … WINNER, LOSER): chưa hứa hẹn chứng từ sản xuất nào;
 *  · SELLING / CLEARANCE / DISCONTINUED: mẫu đang bán hợp lệ khi KHÔNG có topic — hàng nhập từ trước
 *    khi có ERP, hoặc mua sẵn, không đi qua bàn sản xuất. Đòi chứng cứ ở đây là biến 6/7 mẫu thật
 *    của shop thành "lỗi" chỉ vì chúng có trước tính năng.
 *
 * Mỗi trạng thái chỉ đòi chứng từ CỦA CHÍNH NÓ, không đòi cả chuỗi phía trước: mẫu được phép nhảy cóc
 * (lùi / nhảy cóc bắt buộc lý do ở lõi vòng đời), và một mẫu "Duyệt mẫu" không có topic vẫn có thể
 * đúng (mẫu xưởng tự làm, không bàn giá). Đòi cả chuỗi là tự sinh ra việc giả.
 */
export const LIFECYCLE_REQUIRED_EVIDENCE: Partial<Record<ModelState, LifecycleEvidence>> = {
  PRODUCTION_DISCUSSION: "TOPIC",
  COSTING: "COST_SHEET",
  SAMPLING: "SAMPLE",
  SAMPLE_REVIEW: "SAMPLE",
  APPROVED: "DESIGN_VERSION",
  PRODUCTION_PLANNING: "OPEN_PRODUCTION_ORDER",
  IN_PRODUCTION: "OPEN_PRODUCTION_ORDER",
};

/** Chữ cho người đọc: thiếu gì · việc phải làm · nút dẫn tới đâu. */
export const LIFECYCLE_EVIDENCE_TEXT: Record<LifecycleEvidence, { missing: string; action: string }> = {
  TOPIC: { missing: "ERP chưa có topic sản xuất nào", action: "Mở topic sản xuất" },
  COST_SHEET: { missing: "ERP chưa có bảng giá thành nào", action: "Lập giá thành" },
  SAMPLE: { missing: "ERP chưa có mẫu xưởng nào", action: "Ghi mẫu xưởng" },
  DESIGN_VERSION: { missing: "ERP chưa có bản thiết kế đã duyệt nào", action: "Duyệt mẫu xưởng" },
  OPEN_PRODUCTION_ORDER: { missing: "ERP chưa có lệnh sản xuất đang mở (nháp / đã gửi xưởng) nào", action: "Lập lệnh sản xuất" },
};

/**
 * Chứng cứ sản xuất của MỘT mẫu — chỉ là CÓ / KHÔNG. Hai đường đọc (cả shop ở trang Chất lượng dữ liệu,
 * một mẫu ở trang 360) dựng ra đúng kiểu này rồi cùng gọi `lifecycleEvidenceGap`; bài kiểm so hai đường
 * trên cùng dữ liệu.
 *
 * "Lệnh đang mở" = `DRAFT` / `SENT` của sản phẩm của mẫu — đúng định nghĩa `openOrders` của
 * `getModelProductionSummary` (Agent C), không phải định nghĩa thứ hai.
 */
export type ModelEvidenceFacts = {
  modelId: string;
  code: string;
  state: ModelState | null;
  productId: string | null;
  hasTopic: boolean;
  hasCostSheet: boolean;
  hasSample: boolean;
  hasDesignVersion: boolean;
  hasOpenProductionOrder: boolean;
};

export type LifecycleEvidenceGap = {
  modelId: string;
  code: string;
  state: ModelState;
  missing: LifecycleEvidence;
  /** Câu in trên màn hình: "Trạng thái khai 'Làm mẫu' nhưng ERP chưa có mẫu xưởng nào — …". */
  text: string;
  actionLabel: string;
  actionHref: string;
  /** Chỗ sửa trạng thái khai — trang 360 của mẫu. */
  fixStateHref: string;
};

const HAS: Record<LifecycleEvidence, (f: ModelEvidenceFacts) => boolean> = {
  TOPIC: (f) => f.hasTopic,
  COST_SHEET: (f) => f.hasCostSheet,
  SAMPLE: (f) => f.hasSample,
  DESIGN_VERSION: (f) => f.hasDesignVersion,
  OPEN_PRODUCTION_ORDER: (f) => f.hasOpenProductionOrder,
};

function actionHrefOf(missing: LifecycleEvidence, f: ModelEvidenceFacts): string {
  const m = encodeURIComponent(f.modelId);
  if (missing === "TOPIC") return `/production/topics/new?model=${m}`;
  if (missing === "OPEN_PRODUCTION_ORDER") return f.productId ? `/inventory/planning/orders/new?product=${encodeURIComponent(f.productId)}` : `/inventory/planning/orders`;
  // Giá thành, mẫu xưởng, duyệt mẫu: đều nằm ở bàn sản xuất của mẫu (Agent C).
  return `/production/models/${m}`;
}

/**
 * `null` = không có chỗ hở (trạng thái không đòi chứng từ nào, hoặc chứng từ đã có). Chưa khai (`null`)
 * KHÔNG phải một chỗ hở ở đây — thiếu lời khai đã có ô "Chưa khai" riêng trên /models.
 */
export function lifecycleEvidenceGap(f: ModelEvidenceFacts): LifecycleEvidenceGap | null {
  if (!f.state) return null;
  const missing = LIFECYCLE_REQUIRED_EVIDENCE[f.state];
  if (!missing) return null;
  if (HAS[missing](f)) return null;
  const t = LIFECYCLE_EVIDENCE_TEXT[missing];
  const khongSanPham = missing === "OPEN_PRODUCTION_ORDER" && !f.productId ? " (mẫu chưa có sản phẩm Pancake nên chưa đặt được lệnh)" : "";
  return {
    modelId: f.modelId,
    code: f.code,
    state: f.state,
    missing,
    text: `Trạng thái khai “${MODEL_STATE_LABELS[f.state]}” nhưng ${t.missing}${khongSanPham} — ${t.action.toLowerCase()} hoặc sửa trạng thái`,
    actionLabel: t.action,
    actionHref: actionHrefOf(missing, f),
    fixStateHref: `/models/${encodeURIComponent(f.modelId)}`,
  };
}

// ─────────────────────────── 2. PHIẾU NHẬP CHƯA NỐI MÀ CÓ LỆNH SX KHỚP ───────────────────────────

/** Một phiếu kho, đủ để xét có lệnh SX nào khớp không. `productIds` = sản phẩm của các dòng phiếu. */
export type ReceiptLinkFacts = {
  receiptId: string;
  kind: string;
  productionOrderId: string | null;
  productionBatchId: string | null;
  receivedAt: Date;
  supplierId: string | null;
  productIds: readonly string[];
};

/** Một lệnh sản xuất ứng viên. */
export type ProductionOrderLinkFacts = {
  id: string;
  code: string;
  status: string;
  productId: string | null;
  supplierId: string | null;
  sentAt: Date | null;
};

/**
 * Lệnh SX nào CÓ THỂ là nguồn của phiếu nhập này. Chỉ ĐỀ XUẤT — người chọn và bấm nối; một lệnh khớp
 * thì ô chọn được điền sẵn, nhiều lệnh khớp thì liệt kê hết và người chọn (máy chọn bừa trông y hệt máy
 * biết). Điều kiện, tất cả đều phải đúng:
 *
 *  1. phiếu là NHẬP HÀNG (`RECEIPT`) và CHƯA nối lệnh lẫn lô — phiếu đã nối không bao giờ bị đề xuất lại;
 *  2. lệnh ĐANG MỞ theo nghĩa của sổ kho: `SENT` (đã gửi xưởng). `DRAFT` chưa gửi thì hàng chưa thể về;
 *     `RECEIVED` / `CANCELLED` đã đóng. Cùng định nghĩa "đang mở" với `openPoQtyByVariant` và ô chọn
 *     trên form nhập hàng (`listOpenProductionLinks`);
 *  3. cùng SẢN PHẨM: một dòng phiếu mang mẫu mã của sản phẩm trong lệnh;
 *  4. ngày nhận (giờ VN) KHÔNG sớm hơn ngày gửi xưởng (giờ VN). Lệnh `SENT` mà thiếu `sent_at` (lệnh cũ)
 *     ⇒ không chứng minh được thứ tự ⇒ KHÔNG đề xuất: hàng về trước khi đặt thì không phải hàng của lệnh;
 *  5. cùng XƯỞNG khi CẢ HAI bên biết khoá xưởng (`supplier_id`). Một bên chưa chọn xưởng trong danh mục
 *     thì không loại — thiếu thông tin không phải bằng chứng ngược.
 *
 * Thứ tự ra: gửi xưởng GẦN nhất trước, rồi theo mã — ổn định, chạy hai lần ra cùng kết quả.
 */
export function matchReceiptToOrders(r: ReceiptLinkFacts, orders: readonly ProductionOrderLinkFacts[]): ProductionOrderLinkFacts[] {
  if (r.kind !== "RECEIPT") return [];
  if (r.productionOrderId || r.productionBatchId) return [];
  const ngayNhan = vnDateKey(r.receivedAt);
  return orders
    .filter((o) => o.status === "SENT")
    .filter((o) => o.productId !== null && r.productIds.includes(o.productId))
    .filter((o) => o.sentAt !== null && ngayNhan >= vnDateKey(o.sentAt))
    .filter((o) => !(r.supplierId && o.supplierId) || r.supplierId === o.supplierId)
    .sort((a, b) => (b.sentAt?.getTime() ?? 0) - (a.sentAt?.getTime() ?? 0) || a.code.localeCompare(b.code));
}

/** Lệnh điền sẵn vào ô chọn: lệnh người đã chỉ (nếu nó là ứng viên), không thì lệnh DUY NHẤT; nhiều lệnh ⇒ để trống. */
export function prefilledOrderId(candidates: readonly { id: string }[], requested: string | null | undefined): string {
  if (requested && candidates.some((c) => c.id === requested)) return requested;
  return candidates.length === 1 ? candidates[0].id : "";
}
