/**
 * Màu / cỡ của một lần chụp giá (SRC-3) — CHỮ như trên trang nguồn, chỉ để người đọc; không vào phép tính nào. HÀM THUẦN.
 * Đọc / ghi jsonb `sourcing_offer_snapshots.skus` chỉ qua hai hàm này.
 */
export type OfferSkus = { colors: string[]; sizes: string[] };

const MAX_ITEMS = 40;
const MAX_LEN = 60;

/** «黑色 / đen, 白色» ⇒ danh sách: tách theo dấu phẩy / chấm phẩy / xuống dòng, bỏ trống, bỏ trùng, cắt độ dài. */
export function splitSkuList(raw: string): string[] {
  const out: string[] = [];
  for (const part of raw.split(/[,;，；\n]/)) {
    const v = part.trim().slice(0, MAX_LEN);
    if (v && !out.includes(v)) out.push(v);
    if (out.length >= MAX_ITEMS) break;
  }
  return out;
}

/** Cả hai rỗng ⇒ `null` (không khai), không phải `{ colors: [], sizes: [] }`. */
export function serializeSkus(colors: string, sizes: string): OfferSkus | null {
  const c = splitSkuList(colors);
  const s = splitSkuList(sizes);
  return c.length || s.length ? { colors: c, sizes: s } : null;
}

export function parseSkus(raw: unknown): OfferSkus | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const out = { colors: list(r.colors), sizes: list(r.sizes) };
  return out.colors.length || out.sizes.length ? out : null;
}
