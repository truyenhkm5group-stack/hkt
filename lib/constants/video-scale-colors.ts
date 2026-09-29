/**
 * ═══════════ VIDEO SCALE — ĐOẠN "BẢNG MÀU" CUỐI VIDEO (chủ shop 29/09/2026) ═══════════
 *
 * "Concept video sẽ là 1 video đoạn đầu ghép với đoạn sau là show ra các ảnh các SKU màu khác nhau (màu của mã)". Video =
 * các cảnh clip MỞ ĐẦU (như trước) + đoạn BẢNG MÀU: mỗi màu của mã một ảnh sản phẩm THẬT (ảnh mẫu mã trên Pancake), chuyển động
 * nhẹ, chữ "Màu …" lấy ĐÚNG tên màu trong ERP. Không máy AI nào vẽ đoạn này ⇒ không tốn tiền sinh video, và QC hình ảnh chỉ
 * kiểm đoạn mở đầu (so đoạn bảng màu với MỘT ảnh gốc thì màu nào khác màu gốc cũng bị chấm "sai màu").
 *
 * Đo production 29/09/2026: 5/7 mã có nhiều màu, 12/12 màu có ảnh mẫu mã; 4/5 mã mỗi màu một ảnh khác nhau.
 */

/** Một ô của bảng màu: nguồn `PRODUCT_PHOTO` (đã nhập từ ảnh mẫu mã Pancake) + tên màu ERP. */
export type ShowcaseItem = { sourceId: string; color: string };

export const SHOWCASE = {
  /** Nhiều hơn thế thì đoạn bảng màu dài hơn cả đoạn mở đầu — Reel thành catalogue. */
  maxColors: 6,
  /** Giây mỗi màu — đủ đọc chữ "Màu …" và thấy ảnh, không đủ để chán. */
  secondsPerColor: 1.8,
  colorMaxChars: 40,
} as const;

/** Tên thuộc tính màu trong `product_variants.attributes` (Pancake). */
const COLOR_ATTR = /^(màu|mau|màu sắc|mau sac|color|colour)$/i;

/** Màu của một mẫu mã: cột `color` nếu có, không thì thuộc tính "Màu" trong `attributes`. Rỗng = không biết. Hàm THUẦN. */
export function variantColor(color: string | null | undefined, attributes: unknown): string {
  const c = (color ?? "").replace(/\s+/g, " ").trim();
  if (c) return c.slice(0, SHOWCASE.colorMaxChars);
  if (!Array.isArray(attributes)) return "";
  for (const a of attributes) {
    if (!a || typeof a !== "object") continue;
    const r = a as Record<string, unknown>;
    if (typeof r.name === "string" && COLOR_ATTR.test(r.name.trim()) && typeof r.value === "string" && r.value.trim()) return r.value.replace(/\s+/g, " ").trim().slice(0, SHOWCASE.colorMaxChars);
  }
  return "";
}

export type ProductColor = { color: string; imageUrl: string | null; variants: number };

/**
 * Các màu của một mã từ các mẫu mã đang bán — hàm THUẦN, thứ tự ỔN ĐỊNH (lần đầu gặp theo thứ tự đầu vào). Trùng màu không phân
 * biệt hoa thường; ảnh = ảnh ĐẦU TIÊN của mẫu mã đầu tiên CÓ ảnh ở màu ấy. Mẫu mã đã xoá / ẩn không tính.
 */
export function productColorsFrom(rows: readonly { color: string | null; attributes: unknown; images: readonly string[] | null; isRemoved?: boolean; isHidden?: boolean }[]): ProductColor[] {
  const out: ProductColor[] = [];
  for (const r of rows) {
    if (r.isRemoved || r.isHidden) continue;
    const c = variantColor(r.color, r.attributes);
    if (!c) continue;
    const img = (r.images ?? []).map((x) => x.trim()).find((x) => /^https?:\/\//i.test(x)) ?? null;
    const hit = out.find((x) => x.color.toLowerCase() === c.toLowerCase());
    if (hit) {
      hit.variants += 1;
      if (!hit.imageUrl && img) hit.imageUrl = img;
    } else out.push({ color: c, imageUrl: img, variants: 1 });
  }
  return out;
}

/** Bảng màu từ nguồn không tin được — ô lạ bị BỎ, trùng nguồn bị bỏ, tối đa `maxColors`. `undefined` = không khai. Hàm THUẦN. */
export function normalizeShowcase(raw: unknown): ShowcaseItem[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: ShowcaseItem[] = [];
  for (const x of raw) {
    if (!x || typeof x !== "object") continue;
    const r = x as Record<string, unknown>;
    if (typeof r.sourceId !== "string" || !/^[\w-]{1,80}$/.test(r.sourceId) || typeof r.color !== "string") continue;
    const color = r.color.replace(/\s+/g, " ").trim().slice(0, SHOWCASE.colorMaxChars);
    if (!color || out.some((y) => y.sourceId === r.sourceId)) continue;
    out.push({ sourceId: r.sourceId, color });
    if (out.length >= SHOWCASE.maxColors) break;
  }
  return out;
}

/** Chữ trên hình của một ô bảng màu — tên màu ERP, không thêm lời hứa nào. Hàm THUẦN. */
export function showcaseLabel(color: string): string {
  return `Màu ${color.trim()}`;
}

/** Độ dài đoạn bảng màu (giây, trước chuyển cảnh). Hàm THUẦN. */
export function showcaseSeconds(n: number): number {
  return Math.round(Math.max(0, n) * SHOWCASE.secondsPerColor * 10) / 10;
}
