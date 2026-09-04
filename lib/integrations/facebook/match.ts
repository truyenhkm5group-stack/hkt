/**
 * Ghép tên chiến dịch quảng cáo với mã sản phẩm.
 * Mã sản phẩm được lấy từ: mã tuỳ chỉnh Pancake (custom_id), các token dạng chữ+số trong tên sản phẩm
 * (vd "Đầm Q002" → Q002) và phần chữ+số đầu tiên của SKU mẫu mã (vd "Q003-XANH-M" → Q003).
 */
export type ProductCodeEntry = { productId: string; code: string };

const TOKEN_RE = /[A-Za-zÀ-ỹ]{0,3}\d{2,5}[A-Za-z]{0,2}/g;

export function extractCodes(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(TOKEN_RE)) {
    const token = m[0].toUpperCase();
    if (/^\d+$/.test(token) && token.length < 4) continue; // số thuần quá ngắn (002) dễ trùng ngày/size
    if (/^\d{4,}$/.test(token) && Number(token) >= 1900 && Number(token) <= 2100) continue; // năm
    out.add(token);
  }
  return [...out];
}

export function buildProductCodeIndex(products: { id: string; name: string; customId: string | null; skus: string[] }[]): ProductCodeEntry[] {
  const entries: ProductCodeEntry[] = [];
  const seen = new Set<string>();
  const add = (productId: string, code: string) => {
    const key = `${productId}:${code}`;
    if (!code || seen.has(key)) return;
    seen.add(key);
    entries.push({ productId, code });
  };
  for (const p of products) {
    if (p.customId) for (const c of extractCodes(p.customId)) add(p.id, c);
    for (const c of extractCodes(p.name)) add(p.id, c);
    for (const sku of p.skus) {
      const first = sku.split(/[\s\-_/|]+/)[0] ?? "";
      for (const c of extractCodes(first)) add(p.id, c);
    }
  }
  // token dài ưu tiên trước để "Q0021" không bị bắt bởi "Q002"
  return entries.sort((a, b) => b.code.length - a.code.length);
}

/** Trả về productId đầu tiên có mã xuất hiện trong tên chiến dịch (không phân biệt hoa thường, theo ranh giới từ) */
export function matchCampaignToProduct(campaignName: string, index: ProductCodeEntry[]): string | null {
  const name = ` ${campaignName.toUpperCase().replace(/[^\p{L}\p{N}]+/gu, " ")} `;
  for (const entry of index) {
    if (name.includes(` ${entry.code} `)) return entry.productId;
  }
  // thử không cần ranh giới từ (vd "Q002xanh")
  for (const entry of index) {
    if (entry.code.length >= 4 && name.includes(entry.code)) return entry.productId;
  }
  return null;
}
