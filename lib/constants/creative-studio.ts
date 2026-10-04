import { IMAGE_EDIT, IMAGE_EDIT_LAYOUT_PROMPT, IMAGE_QUALITIES, IMAGE_SIZES, MANUAL_GEN_RUN, type Genes, type ImageQuality, type ImageSize } from "@/lib/constants/creative-loop";
import type { CreativeIndustry } from "@/lib/constants/creative-industry";

/**
 * ═══════════ STUDIO TẠO ẢNH — KIỂU ẢNH ĐẦU RA · BIẾN THỂ MÀU · KHỔ · CHẤT LƯỢNG (chủ shop 29/09/2026) ═══════════
 *
 * "Chọn số lượng biến thể màu sắc, chọn kiểu ảnh đầu ra, hiển thị câu lệnh ở kết quả". Một lượt gen tay giờ là một LƯỚI:
 *
 *     số mẫu × số màu × số kiểu ảnh  =  số ảnh
 *
 * `MOCKUP`: "số mẫu" = số bố cục máy chọn cho mỗi tổ hợp; `DESIGN`: "số mẫu" = số THIẾT KẾ MỚI, mỗi thiết kế được vẽ ở
 * MỌI màu × kiểu đã chọn — nên cùng một thiết kế đứng cạnh nhau ở nhiều màu, so được thật. Không chọn màu = giữ màu gốc
 * (mockup) / màu của DNA (thiết kế); không chọn kiểu = `AUTO` (máy tự đa dạng như trước).
 *
 * Mọi câu lệnh tiếng Anh viết TẠI ĐÂY (bảng hằng), người chỉ chọn KHOÁ. Màu là chữ người gõ — đi vào câu lệnh như ý tưởng
 * (đã có tiền lệ ở hộp Sửa ảnh), trần `IMAGE_EDIT.colorMaxChars` ký tự.
 *
 * Kiểu ảnh GHI ĐÈ gen tương ứng (bối cảnh / bố cục / người mẫu) chứ không chỉ thêm một câu: gen là thứ máy HỌC từ số đo
 * quảng cáo — ảnh trải phẳng mà gen ghi "có người mẫu, ngoài phố" thì máy học sai. Ảnh chưa bao giờ có chữ trên ảnh
 * (`textOverlay = NONE`, cùng luật gen tay): không kiểu nào ở đây in chữ / giá lên ảnh.
 */

export const OUTPUT_STYLE_KEYS = ["AUTO", "STUDIO", "HERO", "LIFESTYLE", "UGC_SELFIE", "COLLAGE_4", "COLOR_VARIANTS", "DETAIL_CLOSEUPS", "FLATLAY", "MANNEQUIN"] as const;
export type OutputStyle = (typeof OUTPUT_STYLE_KEYS)[number];

type StyleDef = {
  label: string;
  hint: string;
  /** Dùng được cho kiểu `DESIGN` (thiết kế mới phải có người / ma-nơ-canh mặc — không trải phẳng). */
  designOk: boolean;
  genes: Partial<Genes>;
  /** Câu lệnh tiếng Anh; rỗng = không thêm gì (AUTO). */
  prompt: string;
};

export const OUTPUT_STYLES: Record<OutputStyle, StyleDef> = {
  AUTO: { label: "Tự động", hint: "Máy tự chọn bối cảnh / bố cục khác nhau cho từng ảnh (như trước)", designOk: true, genes: {}, prompt: "" },
  STUDIO: {
    label: "Studio nền trơn",
    hint: "Ảnh lookbook sạch, nền trơn, ánh sáng đều — hợp ảnh sản phẩm / catalogue",
    designOk: true,
    genes: { scene: "STUDIO_PLAIN", composition: "SINGLE_HERO" },
    prompt: "Clean e-commerce lookbook shot: full-body model on a plain seamless studio backdrop, soft even lighting, no props, the garment is the clear hero.",
  },
  HERO: { label: "Một ảnh lớn toàn thân", hint: "Một người mẫu toàn thân, không ghép khung", designOk: true, genes: { composition: "SINGLE_HERO" }, prompt: IMAGE_EDIT_LAYOUT_PROMPT.HERO },
  LIFESTYLE: { label: "Đời thường / ngoài phố", hint: "Người mẫu mặc ngoài phố, quán cà phê, công viên", designOk: true, genes: { scene: "STREET" }, prompt: IMAGE_EDIT_LAYOUT_PROMPT.LIFESTYLE },
  UGC_SELFIE: {
    label: "Selfie gương (kiểu khách thật)",
    hint: "Ảnh kiểu khách tự chụp bằng điện thoại — thường ra tin nhắn rẻ trên Facebook",
    designOk: true,
    genes: { scene: "HOME", composition: "MIRROR_SELFIE" },
    prompt: "Authentic customer-style mirror selfie taken with a smartphone at home: natural indoor light, casual candid pose, the phone partly visible, realistic everyday look (UGC style) — not a studio photo.",
  },
  COLLAGE_4: { label: "Ghép 4 khung", hint: "1 ảnh lớn + 3 khung chi tiết (cổ, tay, eo, vải)", designOk: true, genes: { composition: "COLLAGE" }, prompt: IMAGE_EDIT_LAYOUT_PROMPT.COLLAGE_4 },
  COLOR_VARIANTS: { label: "Ghép nhiều màu", hint: "Cùng mẫu ở 3–4 màu cạnh nhau trong MỘT ảnh", designOk: true, genes: { composition: "COLOR_GRID" }, prompt: IMAGE_EDIT_LAYOUT_PROMPT.COLOR_VARIANTS },
  DETAIL_CLOSEUPS: { label: "Cận cảnh chi tiết", hint: "Lưới ảnh cận cổ, tay, eo, chất vải", designOk: true, genes: { composition: "DETAIL_CLOSEUP" }, prompt: IMAGE_EDIT_LAYOUT_PROMPT.DETAIL_CLOSEUPS },
  FLATLAY: { label: "Trải phẳng (flat-lay)", hint: "Sản phẩm trải phẳng chụp từ trên xuống, không người mẫu", designOk: false, genes: { scene: "FLATLAY", model: "NONE", composition: "SINGLE_HERO" }, prompt: IMAGE_EDIT_LAYOUT_PROMPT.FLATLAY },
  MANNEQUIN: { label: "Ma-nơ-canh", hint: "Trên ma-nơ-canh trong cửa hàng sáng, không người mẫu", designOk: true, genes: { scene: "STUDIO_PLAIN", model: "NONE", composition: "SINGLE_HERO" }, prompt: IMAGE_EDIT_LAYOUT_PROMPT.MANNEQUIN },
};

/**
 * KIỂU ẢNH CỦA SHOP THỰC PHẨM (chủ shop 04/10/2026) — cùng KHOÁ với bảng thời trang (cột `output_style` đã lưu dùng chung),
 * nghĩa thực phẩm: không người mẫu, không selfie gương, không ma-nơ-canh, không lưới nhiều màu. Kiểu vắng mặt ở đây là kiểu
 * KHÔNG dùng được cho thực phẩm — `normalizeStudioOptions` bỏ nó, màn hình không hiện nó.
 */
export const FOOD_OUTPUT_STYLES: Partial<Record<OutputStyle, StyleDef>> = {
  AUTO: { label: "Tự động", hint: "Máy tự chọn cách bày / bối cảnh khác nhau cho từng ảnh", designOk: false, genes: {}, prompt: "" },
  STUDIO: {
    label: "Đĩa trình bày nền trơn",
    hint: "Món đã nấu bày trên đĩa, nền trơn sạch, ánh sáng đều — ảnh sản phẩm / catalogue",
    designOk: false,
    genes: { scene: "STUDIO_PLAIN", composition: "SINGLE_HERO", model: "NONE" },
    prompt: "Clean food product shot: the cooked product plated on a simple dish on a plain seamless backdrop, soft even lighting, minimal props, the food is the clear hero.",
  },
  HERO: { label: "Một món lớn nổi bật", hint: "Một đĩa món ăn lớn, không ghép khung", designOk: false, genes: { composition: "SINGLE_HERO", model: "NONE" }, prompt: "ONE single large hero photo of the dish — no collage, no split panels." },
  LIFESTYLE: {
    label: "Mâm cơm gia đình",
    hint: "Món trên mâm cơm / bàn ăn gia đình cùng cơm và món phụ",
    designOk: false,
    genes: { scene: "HOME", model: "NONE" },
    prompt: "A natural Vietnamese family meal: the dish on a wooden dinner table (mâm cơm) with steamed rice and simple side dishes, warm homely atmosphere, no person in focus.",
  },
  COLLAGE_4: {
    label: "Ghép 4 khung",
    hint: "Gói hàng thật + món đã nấu + cận cảnh thớ + gợi ý ăn kèm",
    designOk: false,
    genes: { composition: "COLLAGE", model: "NONE" },
    prompt: "A 4-panel collage of the SAME product: the real package, the cooked dish, a close-up of its texture and a serving suggestion.",
  },
  DETAIL_CLOSEUPS: {
    label: "Cận cảnh thớ / miếng chả",
    hint: "Cận mặt cắt, độ dai, màu vàng của món",
    designOk: false,
    genes: { composition: "DETAIL_CLOSEUP", model: "NONE" },
    prompt: "Close-up shots of the cut surface and texture of the product (slices, cross-section), shallow depth of field, appetizing.",
  },
  FLATLAY: {
    label: "Gói hàng + món (nhìn từ trên)",
    hint: "Hộp / túi hút chân không thật cạnh đĩa món đã nấu, chụp từ trên xuống",
    designOk: false,
    genes: { scene: "FLATLAY", model: "NONE", composition: "SINGLE_HERO" },
    prompt: "A clean top-down flat lay: the REAL package (box / vacuum-sealed bag, exactly as photographed) next to the cooked, sliced product on a table, with a few fresh ingredients.",
  },
};

/** Bảng kiểu ảnh của MỘT ngành. Hàm THUẦN. */
export function outputStylesFor(industry: CreativeIndustry = "FASHION"): Partial<Record<OutputStyle, StyleDef>> {
  return industry === "FOOD" ? FOOD_OUTPUT_STYLES : OUTPUT_STYLES;
}

/** Kiểu ảnh dùng được cho ngành (theo thứ tự `OUTPUT_STYLE_KEYS`). Hàm THUẦN. */
export function outputStyleKeysFor(industry: CreativeIndustry = "FASHION"): OutputStyle[] {
  const t = outputStylesFor(industry);
  return OUTPUT_STYLE_KEYS.filter((k) => t[k] !== undefined);
}

export const STUDIO_LIMITS = { maxStyles: 4, maxColors: 6 } as const;

/** Màu gợi ý — chỉ là giá trị điền sẵn, người gõ màu khác được. */
export const STUDIO_COLOR_CHIPS: { label: string; css: string }[] = [
  { label: "Đen", css: "#111111" },
  { label: "Trắng kem", css: "#F4EFE3" },
  { label: "Be", css: "#D9C4A5" },
  { label: "Nâu", css: "#7A4E2D" },
  { label: "Đỏ đô", css: "#7B1E2B" },
  { label: "Đỏ tươi", css: "#D62828" },
  { label: "Hồng pastel", css: "#F6C1CF" },
  { label: "Cam đất", css: "#C8643B" },
  { label: "Vàng mù tạt", css: "#D4A017" },
  { label: "Xanh bạc hà", css: "#A8E6CF" },
  { label: "Xanh rêu", css: "#556B2F" },
  { label: "Xanh pastel", css: "#AFCBEA" },
  { label: "Xanh navy", css: "#1F2A55" },
  { label: "Tím", css: "#6A4C93" },
  { label: "Xám", css: "#8A8A8A" },
];

export type StudioOptions = {
  /** Kiểu ảnh đầu ra; rỗng ⇒ `["AUTO"]`. */
  styles: OutputStyle[];
  /** Biến thể màu (chữ người gõ); rỗng ⇒ giữ màu gốc / màu DNA. */
  colors: string[];
  size: ImageSize | null;
  quality: ImageQuality | null;
};

export const EMPTY_STUDIO: StudioOptions = { styles: [], colors: [], size: null, quality: null };

function isStyle(x: unknown): x is OutputStyle {
  return typeof x === "string" && (OUTPUT_STYLE_KEYS as readonly string[]).includes(x);
}

/** Làm sạch một danh sách màu: cắt khoảng trắng, bỏ rỗng / trùng (không phân biệt hoa thường), cắt độ dài, tối đa `maxColors`. Hàm THUẦN. */
export function normalizeColors(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const x of raw) {
    if (typeof x !== "string") continue;
    const c = x.replace(/\s+/g, " ").trim().slice(0, IMAGE_EDIT.colorMaxChars);
    if (!c || out.some((y) => y.toLowerCase() === c.toLowerCase())) continue;
    out.push(c);
    if (out.length >= STUDIO_LIMITS.maxColors) break;
  }
  return out;
}

/**
 * Tuỳ chọn studio từ nguồn không tin được — khoá lạ bị BỎ (không đoán), `AUTO` đi cùng kiểu khác thì bỏ `AUTO` (chọn kiểu
 * cụ thể nghĩa là không muốn máy tự chọn), kiểu không hợp `DESIGN` bị bỏ ở lượt thiết kế. Hàm THUẦN.
 */
export function normalizeStudioOptions(raw: unknown, kind: "MOCKUP" | "DESIGN" = "MOCKUP", industry: CreativeIndustry = "FASHION"): StudioOptions {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  let styles = [...new Set((Array.isArray(r.styles) ? r.styles : []).filter(isStyle))];
  if (kind === "DESIGN") styles = styles.filter((s) => OUTPUT_STYLES[s].designOk);
  // Thực phẩm: kiểu thời trang (selfie gương, ma-nơ-canh, lưới màu) bị BỎ; không có biến thể màu (đổi màu một món ăn là
  // quảng cáo một món shop không có).
  if (industry === "FOOD") styles = styles.filter((s) => FOOD_OUTPUT_STYLES[s] !== undefined);
  if (styles.length > 1) styles = styles.filter((s) => s !== "AUTO");
  styles = styles.slice(0, STUDIO_LIMITS.maxStyles);
  const size = IMAGE_SIZES.find((x) => x === r.size) ?? null;
  const quality = IMAGE_QUALITIES.find((x) => x === r.quality) ?? null;
  return { styles, colors: industry === "FOOD" ? [] : normalizeColors(r.colors), size, quality };
}

/** Một ô của lưới: mẫu thứ `unit` (0…) ở kiểu `style`, màu `color` ("" = giữ màu). */
export type StudioCell = { unit: number; style: OutputStyle; color: string };

/**
 * Lưới ảnh của một lượt — hàm THUẦN, thứ tự ỔN ĐỊNH: theo mẫu → màu → kiểu, để các biến thể của CÙNG một mẫu đứng liền
 * nhau trên màn hình (so màu ngay trong một hàng).
 */
export function planStudioCells(units: number, o: Pick<StudioOptions, "styles" | "colors">): StudioCell[] {
  const styles: OutputStyle[] = o.styles.length ? o.styles : ["AUTO"];
  const colors = o.colors.length ? o.colors : [""];
  const out: StudioCell[] = [];
  for (let unit = 0; unit < Math.max(0, units); unit += 1) for (const color of colors) for (const style of styles) out.push({ unit, style, color });
  return out;
}

/** Tổng số ảnh của lưới. Hàm THUẦN. */
export function studioTotal(units: number, o: Pick<StudioOptions, "styles" | "colors">): number {
  return Math.max(0, units) * Math.max(1, o.styles.length) * Math.max(1, o.colors.length);
}

/** Lưới vượt trần MỘT lần bấm ⇒ câu lỗi; vừa ⇒ `null`. Kiểm ở CẢ màn hình lẫn đường ghi. Hàm THUẦN. */
export function studioProblem(units: number, o: Pick<StudioOptions, "styles" | "colors">): string | null {
  const total = studioTotal(units, o);
  if (units < 1) return "Chọn ít nhất 1 mẫu.";
  if (total > MANUAL_GEN_RUN.maxImagesPerRun) return `${units} mẫu × ${Math.max(1, o.colors.length)} màu × ${Math.max(1, o.styles.length)} kiểu = ${total} ảnh — vượt trần ${MANUAL_GEN_RUN.maxImagesPerRun} ảnh một lần bấm. Bớt màu / kiểu / số mẫu.`;
  return null;
}

/**
 * Gen của một ảnh sau khi áp kiểu — kiểu cụ thể GHI ĐÈ bối cảnh / bố cục / người mẫu tương ứng (xem đầu tệp). Giữ bộ gen
 * hợp lệ: không người mẫu thì không "selfie gương". Hàm THUẦN.
 */
export function applyStyleGenes(genes: Genes, style: OutputStyle, industry: CreativeIndustry = "FASHION"): Genes {
  if (industry === "FOOD") {
    // Thực phẩm: không người, không chụp gương / lưới màu, không chữ — gen luôn ở tập con thực phẩm (`FOOD_GENE_EXCLUDE`).
    const f: Genes = { ...genes, ...(FOOD_OUTPUT_STYLES[style]?.genes ?? {}), model: "NONE", textOverlay: "NONE" };
    if (f.composition === "MIRROR_SELFIE" || f.composition === "COLOR_GRID") f.composition = "SINGLE_HERO";
    if (f.scene === "STREET") f.scene = "STUDIO_PLAIN";
    return f;
  }
  const g: Genes = { ...genes, ...OUTPUT_STYLES[style].genes };
  // Selfie gương cần người cầm máy: gốc không người mẫu (trải phẳng) ⇒ thêm người TRƯỚC khi kiểm cặp gen.
  if (style === "UGC_SELFIE" && g.model === "NONE") g.model = "FEMALE_YOUNG";
  if (g.model === "NONE" && g.composition === "MIRROR_SELFIE") g.composition = "SINGLE_HERO";
  return g;
}

/**
 * Câu lệnh ĐỔI MÀU cho ảnh mockup — thay cho "giữ ĐÚNG màu sản phẩm": giữ mọi thứ của sản phẩm TRỪ màu. Ảnh mockup đổi màu
 * là một màu shop CÓ THỂ chưa có hàng — người chọn màu là người quyết điều đó (như hộp Sửa ảnh).
 */
export const PRESERVE_PRODUCT_RECOLOR_CLAUSE =
  "IMPORTANT: keep the product EXACTLY as in the reference product photo(s) — same cut, silhouette, pattern placement, fabric texture and every detail — EXCEPT its colour, which must be the requested colour variant. " +
  "Do not redesign or add details to the product. Do not add any logo, brand name or watermark. Photorealistic advertising photo.";

/** Các dòng câu lệnh của MỘT ô lưới (kiểu + màu). Rỗng khi `AUTO` và giữ màu. Hàm THUẦN. */
export function studioDirectives(cell: Pick<StudioCell, "style" | "color">, kind: "MOCKUP" | "DESIGN", industry: CreativeIndustry = "FASHION"): string[] {
  const out: string[] = [];
  if (industry === "FOOD") {
    // Không có câu biến thể màu: `normalizeStudioOptions` đã bỏ màu của shop thực phẩm.
    const fp = FOOD_OUTPUT_STYLES[cell.style]?.prompt ?? "";
    if (fp) out.push(`OUTPUT STYLE (chosen by the shop owner — follow it; it overrides the default scene / composition directions below): ${fp}`);
    return out;
  }
  const p = OUTPUT_STYLES[cell.style].prompt;
  if (p) out.push(`OUTPUT STYLE (chosen by the shop owner — follow it; it overrides the default scene / composition / model directions below): ${p}`);
  const c = cell.color.trim();
  if (c) {
    out.push(
      kind === "MOCKUP"
        ? `COLOUR VARIANT (chosen by the shop owner, may be written in Vietnamese): render the garment in this colour: ${c}. Only the colour changes — the garment's cut, details, fabric texture and print placement stay exactly as in the real product photo.`
        : `COLOUR VARIANT (chosen by the shop owner, may be written in Vietnamese): the new garment design is rendered in this colour: ${c} (overrides the design's default colour; every other design attribute stays).`,
    );
  }
  return out;
}

/** Nhãn ngắn của một ô cho thẻ ảnh: "Studio nền trơn · Đỏ đô". Hàm THUẦN. */
export function studioCellLabel(style: string, color: string, industry: CreativeIndustry = "FASHION"): string {
  const s = isStyle(style) && style !== "AUTO" ? (outputStylesFor(industry)[style]?.label ?? OUTPUT_STYLES[style].label) : "";
  return [s, color.trim()].filter(Boolean).join(" · ");
}
