import { IMAGE_EDIT, IMAGE_EDIT_LAYOUT_PROMPT, IMAGE_QUALITIES, IMAGE_SIZES, MANUAL_GEN_RUN, type Genes, type ImageQuality, type ImageSize } from "@/lib/constants/creative-loop";

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
export function normalizeStudioOptions(raw: unknown, kind: "MOCKUP" | "DESIGN" = "MOCKUP"): StudioOptions {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  let styles = [...new Set((Array.isArray(r.styles) ? r.styles : []).filter(isStyle))];
  if (kind === "DESIGN") styles = styles.filter((s) => OUTPUT_STYLES[s].designOk);
  if (styles.length > 1) styles = styles.filter((s) => s !== "AUTO");
  styles = styles.slice(0, STUDIO_LIMITS.maxStyles);
  const size = IMAGE_SIZES.find((x) => x === r.size) ?? null;
  const quality = IMAGE_QUALITIES.find((x) => x === r.quality) ?? null;
  return { styles, colors: normalizeColors(r.colors), size, quality };
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
export function applyStyleGenes(genes: Genes, style: OutputStyle): Genes {
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
export function studioDirectives(cell: Pick<StudioCell, "style" | "color">, kind: "MOCKUP" | "DESIGN"): string[] {
  const out: string[] = [];
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
export function studioCellLabel(style: string, color: string): string {
  const s = isStyle(style) && style !== "AUTO" ? OUTPUT_STYLES[style].label : "";
  return [s, color.trim()].filter(Boolean).join(" · ");
}
