import { FASHION_TEMPLATE_KEYS, FOOD_TEMPLATE_KEYS } from "@/lib/constants/creative-industry";

/**
 * ═══════════ HỒ SƠ TRẢI NGHIỆM CỦA TỔ CHỨC — MỘT LÕI SAAS, GIAO DIỆN THEO NGÀNH (chủ shop 09/10/2026) ═══════════
 *
 * Lỗi kiến trúc được báo: shop hải sản / thực phẩm (chả cá thu, chả mực…) mở form sản phẩm vẫn thấy «Size» / «Màu». Giao
 * diện sản phẩm được dựng cho thời trang rồi dùng chung cho mọi ngành. Tệp này là MỘT bảng cho mọi khác biệt giao diện
 * theo ngành — nơi gọi chỉ hỏi "hồ sơ nào" rồi tra bảng. **Không tệp nào được rẽ nhánh theo mã tổ chức** (bài kiểm
 * `tests/experience-profile.test.ts` quét mã nguồn).
 *
 * ─── HỒ SƠ CỦA MỘT TỔ CHỨC (`resolveExperienceProfile`, hàm THUẦN) ───
 *
 *   tổ chức NHÀ                                   ⇒ FASHION, LUÔN LUÔN — giao diện của nhà giữ nguyên từng byte.
 *   ghi đè `experience.preset` trong settings     ⇒ đúng bộ ấy (quản trị tổ chức chọn, không cần sửa mã).
 *   mẫu ngành thực phẩm / hải sản                 ⇒ FOOD_SEAFOOD.
 *   mẫu ngành thời trang                          ⇒ FASHION.
 *   còn lại                                       ⇒ GENERIC_COMMERCE — cùng ô Size / Màu như trước hôm nay, nên tổ chức
 *                                                   chưa ai chọn KHÔNG đổi giao diện sau lần deploy này.
 *
 * ─── DỮ LIỆU KHÔNG BỊ ĐỘNG TỚI ───
 *
 * Hồ sơ chỉ quyết định Ô NÀO HIỆN và GỌI NÓ LÀ GÌ. Cột `product_variants.size` / `color` vẫn còn nguyên; bộ ẩn khỏi giao
 * diện thì không xoá dữ liệu cũ. Ô "Quy cách" của thực phẩm ghi vào `attributes.spec` + dòng chữ `detail` (thứ chatbot,
 * phiếu in và tìm kiếm đã đọc), KHÔNG ghi vào cột `size` — "2kg" không phải một cỡ áo.
 */

export const EXPERIENCE_PRESETS = ["GENERIC_COMMERCE", "FASHION", "FOOD_SEAFOOD"] as const;
export type ExperiencePreset = (typeof EXPERIENCE_PRESETS)[number];

export const EXPERIENCE_PRESET_LABEL: Record<ExperiencePreset, string> = {
  GENERIC_COMMERCE: "Bán lẻ chung",
  FASHION: "Thời trang",
  FOOD_SEAFOOD: "Thực phẩm / hải sản",
};

/** Khoá `settings` (CSDL của CHÍNH tổ chức). Giá trị: một `ExperiencePreset` dạng chuỗi JSON. */
export const EXPERIENCE_PRESET_SETTING_KEY = "experience.preset";

/**
 * Ô thuộc tính của một mẫu mã. `storage` nói ô ghi vào đâu — tập ĐÓNG, để không ai thêm một ô ghi vào chỗ lạ:
 *   `size` / `color` — hai cột cũ (thời trang).
 *   `spec`          — `attributes.spec` + chữ `detail` (quy cách, dung tích, mùi…).
 *   `weight`        — `product_variants.weight` (gam) — cột phí ship đã đọc.
 */
export type VariantFieldStorage = "size" | "color" | "spec" | "weight";
export type VariantField = { storage: VariantFieldStorage; label: string; placeholder: string };

export type ExperienceProfile = {
  preset: ExperiencePreset;
  label: string;
  /** Tên gọi một dòng mẫu mã: «Mẫu mã» (thời trang) · «Quy cách» (thực phẩm). */
  variantTerm: string;
  variantFields: readonly VariantField[];
  /** Ma trận Màu × Size (tồn, hiệu quả, thiếu đúng size) — chỉ có nghĩa khi mẫu mã thật sự là màu × cỡ. */
  sizeColorMatrix: boolean;
  /** Đơn vị bán gợi ý đầu tiên của form sản phẩm. */
  defaultUnit: string;
  /** Câu ví dụ trong form — đúng ngành, để người mới không phải đoán phải nhập gì. */
  examples: { productName: string; code: string; searchHint: string };
};

const SIZE: VariantField = { storage: "size", label: "Size", placeholder: "S, M, L…" };
const COLOR: VariantField = { storage: "color", label: "Màu", placeholder: "Đen, Trắng…" };
/** Ô cũ khi hồ sơ không có nhưng lối gọi máy vẫn gửi giá trị — ghi lại đúng như trước (chữ `detail` «Size: …» / «Màu: …»). */
export const LEGACY_SIZE_FIELD = SIZE;
export const LEGACY_COLOR_FIELD = COLOR;

export const EXPERIENCE_PROFILES: Record<ExperiencePreset, ExperienceProfile> = {
  GENERIC_COMMERCE: {
    preset: "GENERIC_COMMERCE",
    label: EXPERIENCE_PRESET_LABEL.GENERIC_COMMERCE,
    variantTerm: "Mẫu mã",
    variantFields: [SIZE, COLOR],
    sizeColorMatrix: true,
    defaultUnit: "cái",
    examples: { productName: "Vd: Nước suối 500ml", code: "Vd: NS-500", searchHint: "Tên, mã hàng, SKU…" },
  },
  FASHION: {
    preset: "FASHION",
    label: EXPERIENCE_PRESET_LABEL.FASHION,
    variantTerm: "Mẫu mã",
    variantFields: [SIZE, COLOR],
    sizeColorMatrix: true,
    defaultUnit: "cái",
    examples: { productName: "Vd: Đầm Tulip Frame", code: "Vd: DAM-TULIP", searchHint: "Tên, mã hàng, SKU, màu, size…" },
  },
  FOOD_SEAFOOD: {
    preset: "FOOD_SEAFOOD",
    label: EXPERIENCE_PRESET_LABEL.FOOD_SEAFOOD,
    variantTerm: "Quy cách",
    variantFields: [
      { storage: "spec", label: "Quy cách", placeholder: "500g/gói, hộp 1kg…" },
      { storage: "weight", label: "Khối lượng (g)", placeholder: "500" },
    ],
    sizeColorMatrix: false,
    defaultUnit: "gói",
    examples: { productName: "Vd: Chả cá thu", code: "Vd: CCT500", searchHint: "Tên, mã hàng, SKU, quy cách…" },
  },
};

export type ExperienceBasis = "HOME" | "OVERRIDE" | "TEMPLATE" | "DEFAULT";
export type ExperienceResolution = { profile: ExperienceProfile; basis: ExperienceBasis; detail: string };

export function isExperiencePreset(x: unknown): x is ExperiencePreset {
  return typeof x === "string" && (EXPERIENCE_PRESETS as readonly string[]).includes(x);
}

/** Hồ sơ của MỘT tổ chức — hàm THUẦN. Thứ tự và lý do: đầu tệp. */
export function resolveExperienceProfile(i: { isHome: boolean; templateKey: string | null; override?: unknown }): ExperienceResolution {
  const of = (preset: ExperiencePreset, basis: ExperienceBasis, detail: string): ExperienceResolution => ({ profile: EXPERIENCE_PROFILES[preset], basis, detail });
  if (i.isHome) return of("FASHION", "HOME", "Tổ chức nhà — luôn là thời trang.");
  if (isExperiencePreset(i.override)) return of(i.override, "OVERRIDE", `Quản trị tổ chức đã chọn «${EXPERIENCE_PRESET_LABEL[i.override]}».`);
  if (i.templateKey && FOOD_TEMPLATE_KEYS.includes(i.templateKey)) return of("FOOD_SEAFOOD", "TEMPLATE", `Theo mẫu ngành «${i.templateKey}».`);
  if (i.templateKey && FASHION_TEMPLATE_KEYS.includes(i.templateKey)) return of("FASHION", "TEMPLATE", `Theo mẫu ngành «${i.templateKey}».`);
  return of("GENERIC_COMMERCE", "DEFAULT", "Chưa chọn ngành — dùng bộ bán lẻ chung (giữ nguyên giao diện cũ).");
}

/** Dòng chữ `detail` của một mẫu mã theo đúng ô của hồ sơ — thứ chatbot, phiếu in, tìm kiếm đọc. Hàm THUẦN. */
export function variantDetailText(fields: readonly VariantField[], v: { size?: string; color?: string; spec?: string; weight?: number | null }): string {
  const parts: string[] = [];
  for (const f of fields) {
    if (f.storage === "weight") continue; // khối lượng là số cho phí ship, không phải tên quy cách
    const value = (f.storage === "size" ? v.size : f.storage === "color" ? v.color : v.spec)?.trim();
    if (value) parts.push(`${f.label}: ${value}`);
  }
  // Thứ tự cũ của thời trang là Màu trước, Size sau — giữ nguyên để chữ của mẫu mã cũ không đổi khi sửa.
  if (fields.some((f) => f.storage === "size") && fields.some((f) => f.storage === "color")) parts.reverse();
  return parts.join(", ");
}

/** Quy cách đã lưu của một mẫu mã (`attributes.spec`) — "" khi không có. */
export function specOf(attributes: unknown): string {
  const spec = attributes && typeof attributes === "object" && !Array.isArray(attributes) ? (attributes as Record<string, unknown>).spec : undefined;
  return typeof spec === "string" ? spec : "";
}

/**
 * ─── THUẬT NGỮ HIỂN THỊ CỦA DỮ LIỆU CŨ (chủ shop 10/10/2026, mục J) ───
 *
 * Form sản phẩm đã đúng ngành từ #755, nhưng chữ «Size: …» vẫn lọt ra ở dòng đơn (trang chi tiết sản phẩm, khung «Đơn đang
 * chốt» của hộp thư) và ở nhãn bộ lọc. Nguồn của chữ đó KHÔNG phải màn hình mà là DỮ LIỆU ĐÃ LƯU:
 *   · trước #755, `lib/records/product-create.ts` ghi `product_variants.detail = "Size: <quy cách>"` cho MỌI ngành (ô form
 *     thời trang dùng chung), và lõi đơn (`lib/records/order-create.ts::variationText`) chép nguyên chữ ấy vào
 *     `order_items.variation_detail` mỗi lần lên đơn;
 *   · tổ chức đồng bộ Pancake thì chữ là tên thuộc tính shop tự đặt trên Pancake (`mapper.ts`: `${a.name}: ${a.value}`) —
 *     nhiều shop thực phẩm đặt tên thuộc tính là «Size» cho quy cách.
 * Cả hai đều là dữ liệu đã ghi ⇒ KHÔNG sửa dữ liệu (không backfill, mục 8.8); chỉ ĐỔI NHÃN lúc hiển thị, giữ nguyên GIÁ TRỊ.
 */

/** Nhãn của hai cột cũ `size` / `color` theo hồ sơ. Ngành không có ô Size thì cột `size` cũ đang giữ QUY CÁCH (dữ liệu trước
 *  #755) ⇒ gọi nó bằng nhãn ô quy cách của hồ sơ. Cột `color` không có ô tương đương ⇒ giữ nhãn cũ (nếu có giá trị thì đó là
 *  dữ liệu thật). Hàm THUẦN. */
export function legacyAttributeLabels(profile: Pick<ExperienceProfile, "variantFields">): { size: string; color: string } {
  const by = (s: VariantFieldStorage) => profile.variantFields.find((f) => f.storage === s)?.label;
  return { size: by("size") ?? by("spec") ?? SIZE.label, color: by("color") ?? COLOR.label };
}

/** Tên cột «mẫu mã» của một bảng: thời trang «Màu / Size», ngành khác dùng tên gọi mẫu mã của hồ sơ («Quy cách»). */
export function variantColumnLabel(profile: Pick<ExperienceProfile, "sizeColorMatrix" | "variantTerm">): string {
  return profile.sizeColorMatrix ? `${COLOR.label} / ${SIZE.label}` : profile.variantTerm;
}

/** Tên thuộc tính trong chữ biến thể mà ngành không có ô Size phải gọi lại. Nhóm bắt TIỀN TỐ (đầu chuỗi hoặc sau dấu phân
 *  cách) thay cho nhìn-ngược: tệp này được client component nạp, nhìn-ngược làm sập trang trên Safari < 16.4. */
const SIZE_ATTRIBUTE_NAME = /(^|[,;|]\s*)(?:size|kích cỡ|cỡ)\s*:/giu;

/**
 * Chữ biến thể của một dòng đơn / mẫu mã để IN RA, theo hồ sơ ngành. Hồ sơ có ô Size (thời trang, bán lẻ chung) ⇒ trả
 * NGUYÊN chuỗi. Hồ sơ không có ô Size (thực phẩm) ⇒ đổi đúng phần TÊN thuộc tính «Size:» thành nhãn quy cách — giá trị
 * phía sau giữ nguyên từng ký tự («Size: 1kg (2 túi 0,5kg)» ⇒ «Quy cách: 1kg (2 túi 0,5kg)»; dấu phẩy trong «0,5kg» không
 * bị coi là ranh giới vì sau nó không có tên thuộc tính). Hàm THUẦN — không ghi gì.
 */
export function displayVariationText(text: string, profile: Pick<ExperienceProfile, "variantFields">): string {
  if (!text || profile.variantFields.some((f) => f.storage === "size")) return text;
  const label = legacyAttributeLabels(profile).size;
  return text.replace(SIZE_ATTRIBUTE_NAME, (_m, prefix: string) => `${prefix}${label}:`);
}
