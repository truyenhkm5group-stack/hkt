/**
 * ═══════════ SẢN PHẨM TẠO TAY — CHO TỔ CHỨC KHÔNG CÓ NGUỒN SẢN PHẨM ĐỒNG BỘ (pilot P0 #1/#2) — THUẦN, CLIENT-SAFE ═══════════
 *
 * Tổ chức nhà nhận sản phẩm từ Pancake (`products.id` / `product_variants.id` = uuid Pancake, đồng bộ ghi đè mỗi
 * lượt). Tổ chức KHÔNG bật `connector_pancake` không có đường nào đưa một mã hàng vào ERP — trang Nhập hàng trống
 * trơn và gợi ý "đồng bộ từ Pancake" mà họ không có. Tệp này khai phần THUẦN của đường tạo tay:
 *
 *  · LUẬT "tổ chức không có nguồn sản phẩm": đúng như khách hàng — năng lực `create` của đối tượng `product` trong
 *    sổ đối tượng khai `requiresModuleOff: "connector_pancake"`. MỘT điều kiện, đọc qua `canUseModule`; không
 *    `if` theo tên tổ chức ở đâu cả. Tổ chức nhà luôn bật Pancake ⇒ không có nút, action từ chối.
 *  · ĐỊNH DANH: id sản phẩm / mẫu mã tạo tay mang tiền tố `erp-` (uuid Pancake không bao giờ bắt đầu bằng chữ đó), nên
 *    (a) lượt đồng bộ không bao giờ va vào bản ghi tay, (b) "bản ghi này tạo tay hay đồng bộ" đọc được từ CHÍNH id —
 *    không cần cột mới, không cần đoán. Sửa chỉ được bản ghi tạo tay: sửa bản ghi Pancake thì lượt đồng bộ kế tiếp
 *    ghi đè lại, người sửa tưởng đã lưu mà dữ liệu tự quay về.
 *  · ĐƠN VỊ tính nằm ở `products.raw` (`{ origin: "ERP_MANUAL", unit }`) — cột `raw` là "lời khai gốc" của bản ghi;
 *    với bản ghi Pancake nó là payload Pancake, với bản ghi tay nó là lời khai của người tạo. Không migration.
 *  · GIÁ VỐN khai tay đi vào `product_variants.last_imported_price` — đúng BẬC CUỐI của thang giá vốn "sống"
 *    (AGENTS mục 3.13: phiếu nhập ERP gần nhất → giá vốn Pancake → giá nhập mẫu mã). Phiếu nhập có đơn giá thì thắng
 *    nó, như mọi mẫu mã khác. Bỏ trống = CHƯA BIẾT (`NULL`), không phải 0 (mục 42).
 */

export const MANUAL_ID_PREFIX = "erp-";

/** Bản ghi (sản phẩm / mẫu mã) do người tạo trên ERP — không phải bản đồng bộ. */
export function isManualRecordId(id: string | null | undefined): boolean {
  return typeof id === "string" && id.startsWith(MANUAL_ID_PREFIX);
}

/** Id mới cho bản ghi tạo tay. `crypto.randomUUID` có ở Node ≥ 19 và mọi trình duyệt hiện hành. */
export function newManualId(): string {
  return `${MANUAL_ID_PREFIX}${globalThis.crypto.randomUUID()}`;
}

export const MANUAL_PRODUCT_ORIGIN = "ERP_MANUAL" as const;

export type ManualProductRaw = { origin: typeof MANUAL_PRODUCT_ORIGIN; unit: string };

/** Đơn vị tính khai lúc tạo tay; bản ghi đồng bộ / hỏng ⇒ `null` (không hiện gì, không đoán). */
export function manualProductUnit(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<ManualProductRaw>;
  return r.origin === MANUAL_PRODUCT_ORIGIN && typeof r.unit === "string" && r.unit.trim() ? r.unit.trim() : null;
}

/** Gợi ý cho ô đơn vị — chỉ là gợi ý, ô vẫn nhận chữ tự do (bán buôn có "thùng 24 lon", "bao 50 kg"…). */
export const PRODUCT_UNIT_SUGGESTIONS = ["cái", "chiếc", "bộ", "đôi", "hộp", "thùng", "bao", "kg", "mét", "cuộn", "gói", "chai"] as const;

export const SKU_MAX = 60;
/** Mã SKU: chữ/số Latin, `.` `_` `-` `/`; không khoảng trắng (mã in lên tem, gõ vào máy quét). */
export const SKU_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._\-/]*$/;

/** Khoá so trùng SKU trong MỘT tổ chức: bỏ khoảng trắng hai đầu, không phân biệt hoa thường. */
export function skuKey(sku: string): string {
  return sku.trim().toLowerCase();
}

/** SKU trùng nhau trong CHÍNH danh sách gửi lên (trước khi hỏi CSDL). Trả các SKU bị lặp, theo thứ tự xuất hiện. */
export function duplicateSkus(skus: readonly string[]): string[] {
  const seen = new Set<string>();
  const dup: string[] = [];
  for (const s of skus) {
    const k = skuKey(s);
    if (!k) continue;
    if (seen.has(k) && !dup.some((d) => skuKey(d) === k)) dup.push(s.trim());
    seen.add(k);
  }
  return dup;
}
