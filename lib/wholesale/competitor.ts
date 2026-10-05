/**
 * ═══════════ SĂN KHÁCH SỈ — LOẠI ĐỐI THỦ ═══════════
 *
 * Tệp THUẦN, client-safe. Chủ shop chốt 05/10/2026: từ khoá «chả mực Hạ Long» kéo về hàng chục CƠ SỞ LÀM / BÁN chả mực —
 * cùng mặt hàng với HSLC, nên họ là đối thủ chứ không phải khách nhập sỉ. Đo production cùng ngày: 36 lead có chữ «chả mực»
 * trong tên, điểm 89–98 — đứng đầu hàng đợi gọi.
 *
 * Một nơi là ĐỐI THỦ khi tên có MẶT HÀNG của HSLC (mặc định «chả mực») VÀ một trong hai:
 *   · nằm ở TỈNH GỐC của mặt hàng (mặc định Quảng Ninh) — ở đó bán chả mực gần như luôn là tự làm / lấy tận xưởng;
 *   · tên có dấu hiệu sản xuất / bán buôn («giã tay», «giá sỉ», «đại lý», «xưởng»…) — bất kể tỉnh nào.
 * Trừ khi tên là MÓN ĂN («bánh cuốn chả mực», «bún chả mực»): quán dùng chả mực làm món là KHÁCH, không phải đối thủ.
 *
 * Cửa hàng đặc sản ở tỉnh khác không có dấu hiệu sản xuất (vd «Chả mực Hạ Long tại Hà Nội») KHÔNG bị loại — có thể là
 * nơi bán lại, tức khách. Không đoán thêm: thiếu căn cứ thì giữ lead, để người gọi quyết.
 */
import { normalizeProvince } from "@/lib/constants/vn-regions";
import { nameWordHit } from "@/lib/wholesale/segments";

export type CompetitorFilter = {
  enabled: boolean;
  /** Mặt hàng HSLC tự làm — tên có từ này mới xét tiếp. */
  products: string[];
  /** Tỉnh gốc (khoá tỉnh không dấu, vd «quang ninh»): có mặt hàng trong tên là đủ để coi là đối thủ. */
  homeProvinces: string[];
  /** Dấu hiệu sản xuất / bán buôn — ở MỌI tỉnh. */
  sellerWords: string[];
  /** Tên là món ăn ⇒ quán dùng hàng ⇒ khách, không loại. */
  dishWords: string[];
};

export const DEFAULT_COMPETITOR_FILTER: CompetitorFilter = {
  enabled: true,
  products: ["chả mực"],
  homeProvinces: ["quang ninh"],
  sellerWords: ["giã tay", "giá sỉ", "đại lý", "xưởng", "sản xuất", "nhà máy", "chính gốc", "chính hãng"],
  dishWords: ["bánh cuốn", "bún", "phở", "cơm", "xôi", "miến", "bánh mì", "lẩu", "quán", "nhà hàng", "buffet"],
};

/** Căn cứ loại (để ghi vào nhật ký / hiện cho người xem), hoặc `null` nếu không phải đối thủ. HÀM THUẦN. */
export function competitorHit(name: string | null | undefined, provinceKey: string | null | undefined, f: CompetitorFilter): string | null {
  if (!f.enabled) return null;
  const product = nameWordHit(name, f.products);
  if (!product) return null;
  if (nameWordHit(name, f.dishWords)) return null;
  const prov = normalizeProvince(provinceKey);
  if (prov && f.homeProvinces.some((p) => normalizeProvince(p) === prov)) return `tên có «${product}», ở tỉnh gốc`;
  const seller = nameWordHit(name, f.sellerWords);
  return seller ? `tên có «${product}» + «${seller}»` : null;
}
