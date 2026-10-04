import type { CopyFormula } from "@/lib/constants/copy-formulas";
import type { GeneKey, Genes, ImageEditLayout } from "@/lib/constants/creative-loop";

/**
 * ═══════════ GÓI NGÀNH CỦA THƯ VIỆN MEDIA — THỜI TRANG · THỰC PHẨM (chủ shop 04/10/2026) ═══════════
 *
 * Thư viện Media (gen ảnh + câu chữ quảng cáo) được dựng cho shop THỜI TRANG nữ: người mẫu mặc, selfie gương, ma-nơ-canh,
 * lưới nhiều màu, "chất vải → form dáng", thiết kế mới lai DNA váy áo, MOQ màu × size. Tổ chức khách «Hải Sản Làng Chài»
 * (chả cá thu, chả mực…) cần cùng bộ máy cho THỰC PHẨM: món ăn trên đĩa, mâm cơm gia đình, gói hút chân không, cận cảnh thớ
 * chả — và KHÔNG một chữ nào về người mẫu hay chất vải.
 *
 * Một bảng duy nhất cho mọi khác biệt theo ngành — câu lệnh vẽ, nhãn gen, kiểu ảnh, công thức câu chữ, luật khẳng định. Nơi
 * gọi chỉ hỏi "ngành nào" rồi tra bảng; không tệp nào được tự rẽ nhánh theo mã tổ chức.
 *
 * ─── NGÀNH CỦA MỘT TỔ CHỨC (`resolveCreativeIndustry`, hàm THUẦN) ───
 *
 *   tổ chức NHÀ                              ⇒ FASHION, LUÔN LUÔN — hành vi của nhà giữ nguyên từng byte.
 *   ghi đè `creative.industry` trong settings ⇒ đúng giá trị ấy (người quản trị chọn ở ① Tạo ảnh).
 *   mẫu ngành thực phẩm / hải sản            ⇒ FOOD.
 *   mẫu ngành thời trang                      ⇒ FASHION.
 *   còn lại (không mẫu, mẫu khác)             ⇒ FASHION — "không đổi hành vi của tổ chức không ai chọn" (cùng luật với gói
 *                                               chatbot `salesPackFor`); người quản trị đổi bằng ghi đè.
 *
 * ─── GEN VẪN LÀ MỘT TỪ VỰNG ĐÓNG ───
 *
 * Gen (`GENE_VOCAB`) là thứ máy HỌC từ số đo quảng cáo và là cột đã lưu — đổi từ vựng là làm mồ côi lịch sử. Gói FOOD không
 * thêm giá trị mới: nó GÁN NGHĨA THỰC PHẨM cho đúng các giá trị có sẵn (vd `HOME` = mâm cơm gia đình, `FLATLAY` = gói hàng nhìn
 * từ trên xuống) và LOẠI các giá trị vô nghĩa với món ăn (người mẫu, phố, chụp gương, lưới nhiều màu). Nghĩa ấy cố định trong
 * một tổ chức, nên phép đếm thắng / thua của tổ chức ấy vẫn đúng.
 *
 * ─── LUẬT KHẲNG ĐỊNH CỦA QUẢNG CÁO THỰC PHẨM (`foodClaimProblems`) ───
 *
 * Câu chữ không được BỊA: khối lượng / quy cách (chỉ đúng ô sản phẩm `package_size` · `net_weight`…), xuất xứ / "đặc sản"
 * (chỉ khi dữ kiện ghi), công dụng sức khoẻ / chữa bệnh (KHÔNG BAO GIỜ — quảng cáo thực phẩm không được nói như thuốc),
 * "100%", chứng nhận (VietGAP, HACCP, OCOP…) và "không chất bảo quản" khi dữ kiện không ghi. Ảnh cũng vậy: không logo, chữ,
 * giá, khối lượng, tem chứng nhận nào do máy vẽ thêm.
 */

export const CREATIVE_INDUSTRIES = ["FASHION", "FOOD"] as const;
export type CreativeIndustry = (typeof CREATIVE_INDUSTRIES)[number];

export const CREATIVE_INDUSTRY_LABEL: Record<CreativeIndustry, string> = { FASHION: "Thời trang", FOOD: "Thực phẩm / hải sản" };

/** Khoá `settings` (CSDL của CHÍNH tổ chức) — người quản trị chọn ngành cho Thư viện Media. */
export const CREATIVE_INDUSTRY_SETTING_KEY = "creative.industry";

/** Mẫu ngành (`platform_organizations.template_key`) ⇒ ngành. Mẫu không có ở đây ⇒ mặc định (xem đầu tệp). */
export const FOOD_TEMPLATE_KEYS: readonly string[] = ["food-commerce", "seafood-commerce"];
export const FASHION_TEMPLATE_KEYS: readonly string[] = ["fashion-commerce"];

export type CreativeIndustryBasis = "HOME" | "OVERRIDE" | "TEMPLATE" | "DEFAULT";
export type CreativeIndustryResolution = { industry: CreativeIndustry; basis: CreativeIndustryBasis; detail: string };

export function isCreativeIndustry(x: unknown): x is CreativeIndustry {
  return typeof x === "string" && (CREATIVE_INDUSTRIES as readonly string[]).includes(x);
}

/** Ngành của Thư viện Media cho MỘT tổ chức — hàm THUẦN. Thứ tự và lý do: đầu tệp. */
export function resolveCreativeIndustry(i: { isHome: boolean; templateKey: string | null; override?: unknown }): CreativeIndustryResolution {
  if (i.isHome) return { industry: "FASHION", basis: "HOME", detail: "Tổ chức nhà — luôn là thời trang." };
  if (isCreativeIndustry(i.override)) return { industry: i.override, basis: "OVERRIDE", detail: `Quản trị tổ chức đã chọn «${CREATIVE_INDUSTRY_LABEL[i.override]}».` };
  if (i.templateKey && FOOD_TEMPLATE_KEYS.includes(i.templateKey)) return { industry: "FOOD", basis: "TEMPLATE", detail: `Theo mẫu ngành «${i.templateKey}».` };
  if (i.templateKey && FASHION_TEMPLATE_KEYS.includes(i.templateKey)) return { industry: "FASHION", basis: "TEMPLATE", detail: `Theo mẫu ngành «${i.templateKey}».` };
  return { industry: "FASHION", basis: "DEFAULT", detail: i.templateKey ? `Mẫu ngành «${i.templateKey}» chưa có gói riêng — đang dùng mặc định thời trang.` : "Tổ chức không có mẫu ngành — đang dùng mặc định thời trang." };
}

// ───────────────────────────── TÍNH NĂNG CHỈ CÓ Ở THỜI TRANG ─────────────────────────────

/** Câu nói MỘT lần cho mọi chỗ chặn tính năng thời trang ở shop thực phẩm. */
export const FOOD_FASHION_ONLY_MESSAGE =
  "Tính năng này chỉ dành cho shop thời trang (thiết kế mới lai DNA váy áo, MOQ màu × size, biến thể màu, người mẫu / ma-nơ-canh). Shop thực phẩm dùng «Ảnh quảng cáo cho sản phẩm thật»: máy giữ đúng món hàng / bao bì trong ảnh thật, chỉ đổi cách bày, bối cảnh và ánh sáng.";

// ───────────────────────────── GEN THEO NGHĨA THỰC PHẨM ─────────────────────────────

/** Giá trị gen KHÔNG dùng cho thực phẩm (vô nghĩa với món ăn). Gen tay của shop thực phẩm không bao giờ mang chúng. */
export const FOOD_GENE_EXCLUDE: Partial<Record<GeneKey, readonly string[]>> = {
  scene: ["STREET"],
  model: ["FEMALE_YOUNG", "FEMALE_MATURE", "MALE", "GROUP"],
  composition: ["COLOR_GRID", "MIRROR_SELFIE"],
  textOverlay: ["PRICE_BADGE", "HEADLINE", "PRICE_AND_HEADLINE"],
};

/** Nhãn tiếng Việt của gen theo nghĩa thực phẩm — chỉ những giá trị đổi nghĩa; còn lại dùng nhãn chung. */
export const FOOD_GENE_VALUE_LABEL: Record<string, string> = {
  QUALITY_DETAIL: "Nguyên liệu, thớ chả",
  SOCIAL_PROOF: "Món cả nhà thích",
  LIFESTYLE: "Bữa cơm gia đình",
  PROBLEM_SOLUTION: "Tiện — nấu nhanh",
  NEW_ARRIVAL: "Mẻ mới",
  COMBO: "Combo nhiều món",
  STUDIO_PLAIN: "Đĩa trình bày, nền trơn",
  HOME: "Mâm cơm gia đình",
  CAFE: "Bếp nhà — đang chế biến",
  OFFICE: "Hộp cơm / bữa tiện lợi",
  OUTDOOR_NATURE: "Nguyên liệu tươi",
  FLATLAY: "Đóng gói: hộp / túi hút chân không",
  NONE: "Không người",
  SINGLE_HERO: "Một món nổi bật",
  DETAIL_CLOSEUP: "Cận cảnh thớ / miếng chả",
  COLLAGE: "Ghép: gói hàng + món đã nấu",
  WARM: "Ánh sáng ấm",
  COOL: "Ánh sáng tươi mát",
  NEUTRAL: "Ánh sáng tự nhiên",
  VIVID: "Màu rực, bắt mắt",
  PASTEL: "Nhẹ nhàng, sáng",
};

const NO_PERSON_FOOD = "No person in the image — only the food and the real package (a hand holding chopsticks is the most that may appear).";

/** Chỉ thị tiếng Anh của gen theo nghĩa thực phẩm — tất định, MỘT câu cho mỗi gen (thứ tự theo `GENE_KEYS`). */
export const FOOD_GENE_PROMPT_EN: { [K in Exclude<GeneKey, "textOverlay">]: Record<Genes[K], string> } = {
  angle: {
    PRICE_DEAL: "Selling angle: good value — a generous, appetizing portion (no price text anywhere).",
    QUALITY_DETAIL: "Selling angle: quality — show the real texture of the food up close: firm, springy, freshly cooked.",
    SOCIAL_PROOF: "Selling angle: a family favourite — a dish people happily share at the table (no reviews, no numbers).",
    LIFESTYLE: "Selling angle: an everyday family meal — the product served as part of a warm Vietnamese home meal.",
    PROBLEM_SOLUTION: "Selling angle: convenience — quick and easy to cook for a busy weekday meal.",
    NEW_ARRIVAL: "Selling angle: a fresh batch — just cooked, appetizing.",
    COMBO: "Selling angle: combo — several packs or dishes of the shop's own products arranged together.",
  },
  scene: {
    STUDIO_PLAIN: "Scene: the cooked product plated on a simple dish against a clean, plain backdrop — an appetizing product shot.",
    STREET: "Scene: the cooked product plated on a simple dish against a clean, plain backdrop — an appetizing product shot.",
    HOME: "Scene: a Vietnamese family dinner tray (mâm cơm) on a wooden table, with steamed rice and simple side dishes.",
    CAFE: "Scene: a home kitchen while cooking — the product being pan-fried or steamed, light steam rising.",
    OFFICE: "Scene: a neat lunch box / quick weekday meal featuring the product.",
    OUTDOOR_NATURE: "Scene: fresh raw ingredients around the product (fresh fish, herbs, chilli, garlic) on a rustic wooden board — no claim about where they come from.",
    FLATLAY: "Scene: top-down flat lay of the REAL package (box / vacuum-sealed bag) next to the cooked, sliced product.",
  },
  model: { NONE: NO_PERSON_FOOD, FEMALE_YOUNG: NO_PERSON_FOOD, FEMALE_MATURE: NO_PERSON_FOOD, MALE: NO_PERSON_FOOD, GROUP: NO_PERSON_FOOD },
  composition: {
    SINGLE_HERO: "Composition: one hero dish, centered, the product clearly dominant.",
    COLOR_GRID: "Composition: one hero dish, centered, the product clearly dominant.",
    DETAIL_CLOSEUP: "Composition: close-up on the cut surface and texture of the product (slices, cross-section), shallow depth of field.",
    COLLAGE: "Composition: a clean collage of the SAME product — the real package, the cooked dish, a close-up of its texture and a serving suggestion.",
    MIRROR_SELFIE: "Composition: one hero dish, centered, the product clearly dominant.",
  },
  palette: {
    WARM: "Lighting: warm, golden, appetizing light.",
    COOL: "Lighting: bright, clean daylight with fresh, cool tones.",
    NEUTRAL: "Lighting: soft natural window light, neutral tones.",
    VIVID: "Lighting: bright and vivid, saturated appetizing colours.",
    PASTEL: "Lighting: soft, airy light with gentle light-coloured props.",
  },
};

export const FOOD_NO_TEXT_DIRECTIVE = "No text, letters or numbers anywhere in the image.";

/** Sáu câu chỉ thị gen theo nghĩa thực phẩm. Chữ trên ảnh LUÔN `NONE` — không giá, không khối lượng do máy vẽ in. Hàm THUẦN. */
export function foodGeneDirectives(genes: Genes): string[] {
  return (["angle", "scene", "model", "composition", "textOverlay", "palette"] as const).map((k) => (k === "textOverlay" ? FOOD_NO_TEXT_DIRECTIVE : (FOOD_GENE_PROMPT_EN[k] as Record<string, string>)[genes[k]]));
}

// ───────────────────────────── CÂU LỆNH VẼ ẢNH THỰC PHẨM ─────────────────────────────

/** Câu mở đầu của ảnh quảng cáo thực phẩm — sản phẩm là ĐÚNG món trong ảnh thật. */
export function foodAdHead(productName: string): string {
  return `Facebook feed advertising photo for a Vietnamese food shop (seafood / packaged food). Product: "${productName}" — exactly the food product shown in the attached REAL product photo.`;
}

/**
 * Giữ ĐÚNG sản phẩm thật (món + bao bì) — bản thực phẩm của `PRESERVE_PRODUCT_CLAUSE`. Thêm điều thực phẩm hay bị máy vẽ bịa:
 * tem chứng nhận, khối lượng, giá, logo trên bao bì.
 */
export const FOOD_PRESERVE_PRODUCT_CLAUSE =
  "IMPORTANT: keep the REAL product EXACTLY as in the reference product photo(s) — the same food (shape, colour, texture) and, where the package is visible, the same package with its label and printed text exactly as photographed. " +
  "Do not replace it with a different food and do not redesign the package. Do not invent or add any logo, brand name, text, price, weight, quality seal, certification mark or award badge. " +
  "Appetizing, realistic commercial food photography.";

/** Ảnh quảng cáo cũ của shop đính kèm — chỉ lấy bố cục. */
export const FOOD_OWN_AD_LINE = "Another attached image is one of the shop's OWN previous ads — use it only as a layout and style reference, never copy its product.";

export function foodUploadsLine(n: number): string {
  if (n <= 0) return "";
  const which = n === 1 ? "1 attached image was" : `${n} attached images were`;
  return `${which} uploaded by the shop owner as extra reference(s) — use them the way the owner's direction says (setting, props, plating, mood, composition); if the direction does not mention them, use them only as mood / style references. Never copy any logo, text or watermark from them.`;
}

/** Phạm vi ý tưởng người được đè — bản thực phẩm (không có người mẫu, không đổi món). */
export const FOOD_IDEA_OVERRIDES = "every default direction below (scene, props, plating, composition, lighting) — but never the product or its package itself";

/** Kiểu trình bày của hộp Sửa ảnh dùng được cho thực phẩm + câu lệnh của nó. Kiểu khác (nhiều màu, ma-nơ-canh) bị chặn. */
export const FOOD_EDIT_LAYOUT: Partial<Record<ImageEditLayout, { label: string; prompt: string }>> = {
  HERO: { label: "Một món lớn nổi bật", prompt: "Present it as ONE single large hero photo of the dish — no collage, no split panels." },
  COLLAGE_4: { label: "Ghép 4 khung (gói hàng + món nấu + cận cảnh)", prompt: "Present it as a 4-panel collage of the SAME product: the real package, the cooked dish, a close-up of its texture and a serving suggestion." },
  FLATLAY: { label: "Gói hàng nhìn từ trên xuống", prompt: "Present it as a clean top-down flat lay: the real package next to the cooked, sliced product on a table." },
  DETAIL_CLOSEUPS: { label: "Cận cảnh thớ / miếng chả", prompt: "Present it as close-up shots of the cut surface and texture of the product arranged in a tidy grid." },
  LIFESTYLE: { label: "Mâm cơm gia đình", prompt: "Present it as a natural lifestyle photo: the dish on a Vietnamese family dinner table (mâm cơm) with rice and side dishes, no person in focus." },
};

/** Câu lệnh SỬA ảnh thực phẩm — hàm THUẦN. Không có đổi màu (đổi màu một món ăn là quảng cáo một món không có). */
export function foodEditPrompt(i: { layout: ImageEditLayout | null; detail: string; productName: string | null }): string {
  const asks = [i.layout ? (FOOD_EDIT_LAYOUT[i.layout]?.prompt ?? "") : "", i.detail.trim() ? `Owner's edit request (may be written in Vietnamese) — apply it faithfully: ${i.detail.trim()}` : ""].filter(Boolean);
  return [
    "TOP PRIORITY — EDIT REQUEST FROM THE SHOP OWNER. Produce a NEW version of the FIRST attached image (a Facebook feed advertising photo the shop already made) applying ONLY these change(s):",
    ...asks.map((a, k) => `${k + 1}. ${a}`),
    `Keep everything the request does not mention exactly as in the first attached image: the food product ("${i.productName ?? "—"}") and its package, the plating, the scene and the lighting${i.layout ? " (except the requested presentation)" : ""}.`,
    "The second attached image is the REAL product photo — the food and its package must stay exactly that product.",
    FOOD_PRESERVE_PRODUCT_CLAUSE,
  ].join("\n");
}

// ───────────────────────────── DỮ KIỆN SẢN PHẨM (field tuỳ biến của mẫu ngành thực phẩm) ─────────────────────────────

/** Ô sản phẩm của mẫu `food-commerce` được đưa vào câu chữ làm DỮ KIỆN — chỉ những gì in trên bao bì / shop tự khai. */
export const FOOD_FACT_FIELDS = ["package_size", "net_weight", "selling_unit", "food_category", "storage_instruction", "usage_instruction"] as const;
export const FOOD_FACT_LABEL: Record<(typeof FOOD_FACT_FIELDS)[number], string> = {
  package_size: "Quy cách đóng gói",
  net_weight: "Khối lượng tịnh",
  selling_unit: "Đơn vị bán",
  food_category: "Nhóm thực phẩm",
  storage_instruction: "Hướng dẫn bảo quản",
  usage_instruction: "Hướng dẫn sử dụng / chế biến",
};

/** Field tuỳ biến ⇒ dòng dữ kiện "Nhãn: giá trị" (rỗng bỏ). Hàm THUẦN. */
export function foodFactLines(values: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const k of FOOD_FACT_FIELDS) {
    const v = values[k];
    const s = typeof v === "string" ? v.trim() : typeof v === "number" && Number.isFinite(v) ? String(v) : "";
    if (s) out.push(`${FOOD_FACT_LABEL[k]}: ${s.slice(0, 300)}`);
  }
  return out;
}

// ───────────────────────────── CÂU CHỮ QUẢNG CÁO THỰC PHẨM ─────────────────────────────

/** Dàn ý bắt buộc của câu chữ thực phẩm — chủ shop 04/10/2026. */
export const FOOD_COPY_STRUCTURE = [
  "Dàn ý câu chữ (theo đúng thứ tự, bước nào KHÔNG có dữ kiện thì BỎ bước đó — không bịa cho đủ):",
  "1. Hook: ngon / tiện / món đặc trưng của shop (chỉ nói «đặc sản» khi DỮ KIỆN SẢN PHẨM ghi rõ).",
  "2. Nguyên liệu / xuất xứ — CHỈ khi DỮ KIỆN SẢN PHẨM hoặc tên sản phẩm có; không có thì bỏ.",
  "3. Cách chế biến / bảo quản — theo hướng dẫn trong DỮ KIỆN SẢN PHẨM; không có thì chỉ gợi ý chung (chiên, hấp, kho) không kèm con số.",
  "4. Quy cách / khối lượng — ĐÚNG như DỮ KIỆN SẢN PHẨM ghi; không có thì KHÔNG viết con số khối lượng / số miếng nào.",
  "5. Ưu đãi — chỉ khi dữ kiện có; không có thì bỏ, không bịa giảm giá / quà / freeship.",
  "6. CTA: mời nhắn tin cho shop để đặt hàng hoặc hỏi cách chế biến.",
].join("\n");

export const FOOD_CAPTION_INSTRUCTIONS = [
  "Bạn viết câu chữ quảng cáo Facebook (chiến dịch tin nhắn) cho một shop THỰC PHẨM / HẢI SẢN chế biến Việt Nam (chả cá, chả mực, đồ đóng gói…).",
  "Ảnh đính kèm là ĐÚNG ảnh sẽ được đăng. Câu chữ phải khớp với thứ NHÌN THẤY trong ảnh: món ăn, cách bày, bao bì, bối cảnh.",
  "Luật:",
  "- Không nhắc món, nguyên liệu, đồ ăn kèm hay bối cảnh KHÔNG có trong ảnh.",
  "- KHÔNG bịa khối lượng, quy cách, số miếng / số cái: chỉ dùng đúng DỮ KIỆN SẢN PHẨM. Không có dữ kiện ⇒ không viết con số khối lượng nào.",
  "- KHÔNG bịa xuất xứ, nguồn gốc, vùng miền, «đặc sản» trừ khi DỮ KIỆN SẢN PHẨM hoặc tên sản phẩm ghi rõ.",
  "- KHÔNG nói công dụng sức khoẻ / chữa bệnh / bổ dưỡng / giảm cân / tăng đề kháng — quảng cáo thực phẩm không được nói như thuốc.",
  "- KHÔNG viết «100%», «nguyên chất», «không chất bảo quản», «không hàn the», chứng nhận (VietGAP, HACCP, ISO, OCOP, ATTP…) trừ khi DỮ KIỆN SẢN PHẨM ghi đúng điều đó.",
  "- Không bịa khuyến mãi, giảm giá, quà tặng, miễn phí vận chuyển, số khách đã mua, số lượng còn lại.",
  "- Nếu nhắc giá thì CHỈ dùng đúng giá được cung cấp. Không có giá thì KHÔNG viết con số giá nào.",
  "- Không nhắc thương hiệu khác, không chép câu chữ của đối thủ. Mời khách nhắn tin để đặt hàng / được tư vấn cách chế biến.",
  "- Xưng «shop» / «em», gọi khách «anh chị» / «cả nhà» — giọng ấm, gần gũi như bữa cơm nhà.",
].join("\n");

/** Lời dặn công thức theo nghĩa thực phẩm — cùng khoá `COPY_FORMULAS`, khác nội dung. */
export const FOOD_COPY_FORMULAS: Record<CopyFormula, { label: string; hint: string; instruction: string }> = {
  HOOK_QUESTION: { label: "Câu hỏi mở đầu", hint: "«Tối nay ăn gì?» — dừng lướt, tăng CTR", instruction: "Mở đầu bằng MỘT câu hỏi ngắn chạm đúng băn khoăn của người nấu (tối nay ăn gì, bận không kịp nấu, con kén ăn), rồi trả lời bằng món trong ảnh và mời nhắn tin." },
  AIDA: { label: "AIDA", hint: "Chú ý → Thích thú → Mong muốn → Hành động", instruction: "Theo AIDA: câu đầu gây CHÚ Ý; tiếp theo làm THÍCH THÚ bằng điều nhìn thấy trong ảnh (vàng ruộm, thớ chả dai); khơi MONG MUỐN (bữa cơm cả nhà); kết bằng lời kêu gọi nhắn tin đặt hàng." },
  PAS: { label: "PAS", hint: "Vấn đề → Khuấy động → Giải pháp", instruction: "Theo PAS: nêu một VẤN ĐỀ quen thuộc khi lo bữa ăn (bận, ít thời gian, ngại đi chợ); KHUẤY ĐỘNG một câu; đưa món trong ảnh làm GIẢI PHÁP tiện, ngon; mời nhắn tin." },
  BAB: { label: "Trước – Sau – Cầu nối", hint: "Trước khi có → sau khi có → món là cầu nối", instruction: "Theo Before–After–Bridge: tả TRƯỚC (bữa cơm vội, nhạt), SAU (có món này thì mâm cơm thế nào), món là CẦU NỐI; mời nhắn tin để đặt." },
  FAB: { label: "Đặc điểm – Lợi ích", hint: "Điều nhìn thấy → lợi ích cho bữa ăn", instruction: "Theo FAB: nêu 2–3 ĐẶC ĐIỂM nhìn thấy rõ trong ảnh (màu, thớ, cách bày, bao bì), mỗi cái kèm LỢI ÍCH cụ thể cho bữa ăn; không nêu thành phần / khối lượng nếu dữ kiện không ghi." },
  STORY: { label: "Kể chuyện ngắn", hint: "Một khoảnh khắc bữa cơm nhà — tăng CR", instruction: "Kể một CÂU CHUYỆN rất ngắn (2–4 câu) về một bữa cơm nhà / buổi nhậu cuối tuần có món trong ảnh, giọng ấm, kết bằng lời mời nhắn tin." },
  UGC: { label: "Giọng khách thật", hint: "Như lời một khách tâm sự — gần gũi, tin cậy", instruction: "Viết như lời một khách hàng TÂM SỰ tự nhiên về bữa ăn có món này (ngôi thứ nhất, giọng đời thường). KHÔNG bịa tên người, số sao, số lượt mua hay lời khen có thật — chỉ là giọng văn." },
  LISTICLE: { label: "3 lý do", hint: "Danh sách ngắn, dễ đọc lướt", instruction: "Viết dạng DANH SÁCH: câu mở + 3 lý do ngắn (mỗi lý do một dòng, có thể dùng ✔️) vì sao nên chọn món trong ảnh, dựa đúng thứ nhìn thấy và DỮ KIỆN SẢN PHẨM; kết bằng lời mời nhắn tin." },
  OCCASION: { label: "Theo dịp", hint: "Bữa cơm nhà, nhậu cuối tuần, Tết, quà biếu…", instruction: "Gắn món với MỘT dịp cụ thể hợp với ảnh (cơm nhà, nhậu cuối tuần, đãi khách, Tết, quà biếu), tạo lý do nên có ngay — không bịa khuyến mãi hay số lượng có hạn." },
};

export const FOOD_COPY_CONVERSION_RULES = [
  "- Dòng ĐẦU TIÊN phải đủ sức dừng lướt (ngắn, cụ thể, gợi cảm giác ngon / tiện) — Facebook chỉ hiện 1–2 dòng trước chữ 'Xem thêm'.",
  "- Câu ngắn, xuống dòng hợp lý, 1–3 emoji vừa phải; xưng «shop», gọi «anh chị» / «cả nhà».",
  "- Kết bằng lời kêu gọi nhắn tin RÕ và cụ thể (vd 'Nhắn shop để đặt hàng và được chỉ cách chế biến ngon nhất').",
  "- headline: câu ngắn nêu cái ngon / cái tiện chính, không lặp y dòng đầu của primaryText.",
].join("\n");

// ───────────────────────────── LUẬT KHẲNG ĐỊNH ─────────────────────────────

/** Bỏ dấu + chữ thường + chỉ giữ chữ, số, % — so cụm khẳng định với dữ kiện. Hàm THUẦN. */
function fold(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .replace(/[^a-z0-9%]+/g, " ")
    .trim();
}

/** Khối lượng / thể tích / số miếng: "500g", "1 kg", "2 lạng", "10 cái"… (đã bỏ dấu). */
const QUANTITY_RE = /\b(\d+(?:[.,]\d+)?)\s?(kg|ki|ky|kgs|g|gr|gram|gam|grams|lang|ml|lit|l|cai|mieng|vien|chiec|khoanh)\b/g;
/** Xuất xứ / vùng miền — chỉ được khi dữ kiện có đúng cụm ấy. */
const ORIGIN_TERMS = ["xuat xu", "nguon goc", "chinh goc", "dac san", "phu quoc", "nha trang", "quang ninh", "ha long", "vung tau", "phan thiet", "co to", "binh dinh", "quy nhon", "ca mau", "kien giang", "da nang", "nghe an", "thanh hoa", "hai phong", "cat ba", "phu yen", "khanh hoa", "ly son", "con dao", "nhap khau"];
/** Công dụng sức khoẻ / y tế — KHÔNG BAO GIỜ được, kể cả khi dữ kiện ghi. */
const HEALTH_TERMS = ["chua benh", "tri benh", "phong benh", "chua khoi", "tot cho suc khoe", "bo duong", "bo than", "bo nao", "tang de khang", "tang suc de khang", "tang cuong mien dich", "mien dich", "giam can", "an kieng", "chong ung thu", "ung thu", "giai doc", "thanh nhiet", "ha huyet ap", "tieu duong", "duong huyet", "cholesterol", "khong gay hai", "an toan tuyet doi", "thay thuoc", "nhu thuoc"];
/** Chứng nhận / cam kết tuyệt đối — chỉ được khi dữ kiện có đúng cụm ấy. */
const CERT_TERMS = ["vietgap", "globalgap", "haccp", "iso", "ocop", "fda", "brc", "halal", "chung nhan", "giay phep", "kiem dinh", "dat chuan", "ve sinh an toan thuc pham", "an toan ve sinh thuc pham", "attp", "vsattp", "bo y te"];
const PURITY_TERMS = ["100%", "100 %", "nguyen chat", "khong chat bao quan", "khong phu gia", "khong pham mau", "khong han the", "tu nhien 100", "sach 100"];

function hasTerm(text: string, term: string): boolean {
  return ` ${text} `.includes(` ${term} `) || (term.includes("%") && text.includes(term));
}

/**
 * Những khẳng định câu chữ thực phẩm đang BỊA so với dữ kiện — rỗng là đạt. `facts` = tên sản phẩm + dòng dữ kiện + tên shop
 * (mọi thứ shop tự khai). Hàm THUẦN: dùng chung cho bộ viết (viết lại / bỏ phương án) và bài kiểm.
 */
export function foodClaimProblems(text: string, facts: string): string[] {
  const t = fold(text);
  const f = fold(facts);
  const fCompact = f.replace(/\s+/g, "");
  const out: string[] = [];
  for (const m of t.matchAll(QUANTITY_RE)) {
    const num = m[1].replace(",", ".");
    const unit = m[2];
    const compact = `${num}${unit}`;
    if (!fCompact.includes(compact) && !fCompact.includes(`${num.replace(".", "")}${unit}`)) out.push(`khối lượng / quy cách "${m[0]}" không có trong dữ kiện sản phẩm`);
  }
  for (const term of ORIGIN_TERMS) if (hasTerm(t, term) && !hasTerm(f, term)) out.push(`xuất xứ / vùng miền "${term}" không có trong dữ kiện sản phẩm`);
  for (const term of HEALTH_TERMS) if (hasTerm(t, term)) out.push(`công dụng sức khoẻ / y tế "${term}" — quảng cáo thực phẩm không được nói`);
  for (const term of CERT_TERMS) if (hasTerm(t, term) && !hasTerm(f, term)) out.push(`chứng nhận "${term}" không có trong dữ kiện sản phẩm`);
  for (const term of PURITY_TERMS) if (hasTerm(t, term) && !hasTerm(f, term)) out.push(`khẳng định "${term}" không có trong dữ kiện sản phẩm`);
  return [...new Set(out)];
}

// ───────────────────────────── GỢI Ý Ý TƯỞNG ─────────────────────────────

export type FoodIdeaGroup = { key: string; label: string; options: readonly string[] };

/** Gợi ý chọn nhanh cho ô ý tưởng — bản thực phẩm (không người mẫu, không chất vải). */
export const FOOD_IDEA_PRESET_GROUPS: readonly FoodIdeaGroup[] = [
  { key: "scene", label: "Bối cảnh", options: ["mâm cơm gia đình ấm cúng", "bếp nhà đang chiên vàng", "đang hấp, khói bốc nhẹ", "bàn nhậu cuối tuần", "đĩa trình bày nền gỗ", "nền trơn sáng sạch", "hộp cơm trưa văn phòng", "bày cùng rau thơm, ớt, tỏi", "mâm cỗ ngày Tết"] },
  { key: "plating", label: "Cách bày", options: ["cắt lát xếp quạt trên đĩa", "cận cảnh thớ chả cắt đôi", "chấm tương ớt", "kèm cơm trắng nóng", "kèm bún / bánh mì", "gói hút chân không cạnh đĩa đã chiên", "hộp quà biếu"] },
  { key: "light", label: "Ánh sáng", options: ["nắng sớm dịu qua cửa sổ", "ánh vàng ấm buổi tối", "sáng tươi tự nhiên", "đèn bếp ấm", "tương phản mạnh, bắt mắt"] },
  { key: "season", label: "Dịp", options: ["bữa cơm tối", "nhậu cuối tuần", "đãi khách", "Tết Nguyên đán", "quà biếu", "trung thu", "mùa mưa lạnh"] },
];
