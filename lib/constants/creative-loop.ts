/**
 * ═══════════ VÒNG MẪU QUẢNG CÁO — HỢP ĐỒNG CHUNG ═══════════
 *
 * Đặc tả: `docs/creative-loop.md`. Đây là Nấc 4 (NỘI DUNG) của `docs/marketing-ai-department.md`.
 *
 * Vòng một ngày:
 *
 *   ảnh đầu vào (ảnh sản phẩm thật · quảng cáo cũ của shop · tay · spy · R&D)
 *     → LẬP LÔ (hàm thuần `planBatch`)       → VIẾT câu lệnh + câu chữ (LLM)
 *     → SINH ẢNH (gpt-image)                  → NGƯỜI DUYỆT MỘT LẦN CHO CẢ LÔ
 *     → ĐĂNG (bài ẩn + nhóm + mẩu QC, chạy 6:00) → ĐO (chi cấp mẩu + đơn theo `ad_id`)
 *     → CHẤM (hàm thuần `judgeVariant`)       → THẮNG vào thư viện · THUA bị loại
 *     → HỌC (hàm thuần `geneStats`)           → quay lại LẬP LÔ ngày mai
 *
 * Tệp này giữ MỌI con số, MỌI trần và MỌI từ vựng của vòng. Không hằng số nào của vòng được nằm ở
 * chỗ khác — một cái trần rải ra hai nơi là một cái trần sẽ có hai giá trị.
 *
 * ─── BA RANH GIỚI KHÔNG ĐƯỢC XOÁ ───
 *
 *  1. **Mô hình không quyết định.** LLM chỉ VIẾT câu lệnh và câu chữ cho một bản giao việc đã được
 *     `planBatch()` chọn. Chọn gen nào, mẫu nào thắng, mẫu nào bị tắt đều là hàm thuần có kiểm thử
 *     (`docs/marketing-ai-department.md` §1).
 *  2. **Ảnh đối thủ không bao giờ đi vào máy sinh ảnh.** Ảnh SPY chỉ được đọc thành MÔ TẢ CHỮ (gen);
 *     điểm ảnh gửi sang OpenAI chỉ là ảnh CỦA SHOP: ảnh sản phẩm THẬT, ảnh mẫu thắng của vòng, và ảnh
 *     QUẢNG CÁO CŨ của shop (`OWN_AD` — nhập thẳng từ tài khoản quảng cáo của shop theo `ad_id`, không
 *     bao giờ tải tay). Ảnh tay / R&D cũng không: chúng có thể là ảnh chụp màn hình của bất kỳ ai.
 *     Chép lại ảnh người khác là rủi ro bản quyền và là lý do Facebook khoá tài khoản quảng cáo.
 *  3. **Ảnh sinh ra phải là sản phẩm thật.** Mọi ô trong lô bắt buộc có ảnh sản phẩm thật làm gốc
 *     (`PRODUCT_PHOTO`). Quảng cáo ra một chiếc váy không có trong kho thì đơn nào cũng thành đơn
 *     hoàn — tiền quảng cáo mua về tỷ lệ hoàn, không mua về doanh thu.
 *
 *     **NGOẠI LỆ CÓ CHỦ ĐÍCH — ô `DESIGN` (chủ shop 24/09/2026):** ô THIẾT KẾ MỚI quảng cáo một mẫu
 *     CHƯA SẢN XUẤT (lai "DNA" của các mã bán tốt, bắt buộc khác mọi mã đang có). Chủ shop tạo sản phẩm
 *     trên Pancake đúng mã `TK-…`, nhận đơn như hàng thường rồi mới sản xuất — shop bán trước. Ranh giới
 *     2 KHÔNG nới: ảnh tham chiếu gửi máy sinh ảnh vẫn chỉ là ảnh sản phẩm THẬT của mã cha (giữ chất ảnh,
 *     thương hiệu), `assertPixelSafe` vẫn đòi ít nhất một `PRODUCT_PHOTO`, và câu lệnh dặn rõ "thiết kế
 *     mới, KHÔNG sao chép mẫu tham chiếu". Ô khai thác / thăm dò / tự làm giữ nguyên ranh giới 3.
 */

// ───────────────────────────── PHIÊN BẢN ─────────────────────────────

/**
 * Tăng khi đổi LUẬT CHẤM (cách tính phán quyết) — không phải khi đổi ngưỡng trong cấu hình, vì
 * ngưỡng đã được chụp nguyên vào `creative_batches.config_snapshot` của từng lô.
 */
export const CREATIVE_RULE_VERSION = 1;

/**
 * Tăng khi đổi TỪ VỰNG GEN. Thống kê gen chỉ gộp các mẫu cùng phiên bản từ vựng: đổi nghĩa một
 * giá trị mà vẫn cộng dồn là trộn hai thứ khác nhau vào một tỷ lệ thắng.
 */
export const GENE_VOCAB_VERSION = 1;

// ───────────────────────────── TỪ VỰNG GEN ─────────────────────────────

/**
 * "Gen" là những thuộc tính của một mẫu mà máy HỌC ĐƯỢC. Chúng phải là một TỪ VỰNG ĐÓNG: câu lệnh
 * tự do thì không đếm được, và không đếm được thì không học được — hai câu lệnh "nền quán cà phê"
 * và "background coffee shop" là một ý, nhưng với phép đếm chúng là hai mẫu không liên quan.
 *
 * LLM chỉ được CHỌN trong từ vựng này (khi đọc ảnh đầu vào) và chỉ được DIỄN ĐẠT các gen đã chọn
 * (khi viết câu lệnh). Giá trị lạ bị bỏ, không bị ép về giá trị gần nhất.
 */
export const GENE_VOCAB = {
  /** Góc bán — lý do khách dừng lại. */
  angle: ["PRICE_DEAL", "QUALITY_DETAIL", "SOCIAL_PROOF", "LIFESTYLE", "PROBLEM_SOLUTION", "NEW_ARRIVAL", "COMBO"],
  /** Bối cảnh. */
  scene: ["STUDIO_PLAIN", "STREET", "HOME", "CAFE", "OFFICE", "OUTDOOR_NATURE", "FLATLAY"],
  /** Người mẫu. */
  model: ["NONE", "FEMALE_YOUNG", "FEMALE_MATURE", "MALE", "GROUP"],
  /** Bố cục. */
  composition: ["SINGLE_HERO", "COLOR_GRID", "DETAIL_CLOSEUP", "COLLAGE", "MIRROR_SELFIE"],
  /** Chữ trên ảnh. */
  textOverlay: ["NONE", "PRICE_BADGE", "HEADLINE", "PRICE_AND_HEADLINE"],
  /** Tông màu. */
  palette: ["WARM", "COOL", "NEUTRAL", "VIVID", "PASTEL"],
} as const;

export type GeneKey = keyof typeof GENE_VOCAB;
export type Genes = { [K in GeneKey]: (typeof GENE_VOCAB)[K][number] };
export const GENE_KEYS = Object.keys(GENE_VOCAB) as GeneKey[];

export const GENE_LABEL: Record<GeneKey, string> = {
  angle: "Góc bán",
  scene: "Bối cảnh",
  model: "Người mẫu",
  composition: "Bố cục",
  textOverlay: "Chữ trên ảnh",
  palette: "Tông màu",
};

export const GENE_VALUE_LABEL: Record<string, string> = {
  PRICE_DEAL: "Giá / ưu đãi",
  QUALITY_DETAIL: "Chất liệu, đường may",
  SOCIAL_PROOF: "Khách đã mua",
  LIFESTYLE: "Phong cách sống",
  PROBLEM_SOLUTION: "Giải quyết vấn đề",
  NEW_ARRIVAL: "Hàng mới về",
  COMBO: "Combo / set",
  STUDIO_PLAIN: "Phông trơn",
  STREET: "Đường phố",
  HOME: "Trong nhà",
  CAFE: "Quán cà phê",
  OFFICE: "Văn phòng",
  OUTDOOR_NATURE: "Ngoài trời",
  FLATLAY: "Trải phẳng",
  NONE: "Không",
  FEMALE_YOUNG: "Nữ trẻ",
  FEMALE_MATURE: "Nữ trung niên",
  MALE: "Nam",
  GROUP: "Nhóm người",
  SINGLE_HERO: "Một sản phẩm nổi bật",
  COLOR_GRID: "Lưới nhiều màu",
  DETAIL_CLOSEUP: "Cận chi tiết",
  COLLAGE: "Ghép ảnh",
  MIRROR_SELFIE: "Chụp gương",
  PRICE_BADGE: "Nhãn giá",
  HEADLINE: "Tiêu đề",
  PRICE_AND_HEADLINE: "Giá + tiêu đề",
  WARM: "Ấm",
  COOL: "Lạnh",
  NEUTRAL: "Trung tính",
  VIVID: "Rực",
  PASTEL: "Pastel",
};

/** Nhận một giá trị gen từ nguồn không tin được (LLM, JSON cũ). Lạ ⇒ `null`, không đoán. */
export function parseGeneValue<K extends GeneKey>(key: K, raw: unknown): Genes[K] | null {
  const vocab = GENE_VOCAB[key] as readonly string[];
  return typeof raw === "string" && vocab.includes(raw) ? (raw as Genes[K]) : null;
}

/** Nhận bộ gen MỘT PHẦN — gen nào đọc được thì giữ, gen nào lạ thì bỏ. */
export function parsePartialGenes(raw: unknown): Partial<Genes> {
  const out: Partial<Genes> = {};
  if (!raw || typeof raw !== "object") return out;
  const rec = raw as Record<string, unknown>;
  for (const k of GENE_KEYS) {
    const v = parseGeneValue(k, rec[k]);
    if (v !== null) (out as Record<string, string>)[k] = v;
  }
  return out;
}

/** Bộ gen ĐỦ sáu khoá, hoặc `null`. Một mẫu thiếu gen không vào được thống kê. */
export function parseGenes(raw: unknown): Genes | null {
  const p = parsePartialGenes(raw);
  return GENE_KEYS.every((k) => k in p) ? (p as Genes) : null;
}

/** Chữ ký để chống trùng: cùng mã hàng + cùng bộ gen = cùng một ý tưởng, dù câu chữ khác. */
export function geneSignature(productId: string, genes: Genes): string {
  return `${productId}|${GENE_KEYS.map((k) => genes[k]).join("|")}`;
}

// ───────────────────────────── NGUỒN ẢNH ĐẦU VÀO ─────────────────────────────

/**
 * `PRODUCT_PHOTO` — ảnh sản phẩm THẬT của shop. Bắt buộc cho mọi ô trong lô: máy SỬA ảnh này.
 * `OWN_AD`        — quảng cáo CŨ của shop đã chạy trên tài khoản của shop (mẫu thắng / mẫu tốt), nhập
 *                   từ Facebook theo `ad_id` — KHÔNG tải tay được (lược đồ đầu vào của form không nhận
 *                   loại này, CSDL bắt buộc `fb_ad_id`). Đủ gen + có mã hàng ⇒ làm MẪU CHA của ô khai
 *                   thác; câu chữ của nó dạy máy viết giọng văn đã bán được.
 * `MANUAL`        — ảnh tham khảo người đưa vào.
 * `SPY`           — ảnh quảng cáo của đối thủ. CHỈ được đọc thành gen + mô tả chữ.
 * `RND`           — ảnh từ phòng R&D (mẫu mới, bản phác).
 */
export const CREATIVE_SOURCE_KINDS = ["PRODUCT_PHOTO", "OWN_AD", "MANUAL", "SPY", "RND"] as const;
export type CreativeSourceKind = (typeof CREATIVE_SOURCE_KINDS)[number];

export const CREATIVE_SOURCE_KIND_LABEL: Record<CreativeSourceKind, string> = {
  PRODUCT_PHOTO: "Ảnh sản phẩm thật",
  OWN_AD: "Quảng cáo cũ của shop",
  MANUAL: "Tham khảo (tay)",
  SPY: "Đối thủ (spy)",
  RND: "R&D",
};

/**
 * Một câu cho từng loại: nó DÙNG VÀO VIỆC GÌ trong vòng mẫu. Chủ shop nói 24/09/2026 "chưa hiểu logic
 * dùng" — câu này in ở khối hướng dẫn đầu tab Nguồn ảnh và trên form tải ảnh, từ cùng một nguồn.
 */
export const CREATIVE_SOURCE_KIND_USE: Record<CreativeSourceKind, string> = {
  PRODUCT_PHOTO: "Gốc bắt buộc của mọi mẫu — máy SỬA chính ảnh này theo câu lệnh. Mã nào muốn test phải có ít nhất một ảnh loại này.",
  OWN_AD: "Mẫu cha để máy làm biến thể (giữ năm gen, đổi một) + học câu chữ đã bán được. Ảnh được gửi làm tham chiếu bố cục vì là quảng cáo của chính shop.",
  MANUAL: "Chỉ ĐỌC thành mô tả chữ + gen để lấy ý tưởng. Điểm ảnh không gửi sang máy sinh ảnh.",
  SPY: "Đối thủ: chỉ ĐỌC thành mô tả chữ + gen. Điểm ảnh KHÔNG BAO GIỜ gửi sang máy sinh ảnh.",
  RND: "Chỉ ĐỌC thành mô tả chữ + gen để lấy ý tưởng. Điểm ảnh không gửi sang máy sinh ảnh.",
};

/**
 * Loại nguồn NGƯỜI được tải tay qua form. `OWN_AD` cố ý vắng mặt: nó được gửi điểm ảnh sang máy sinh
 * ảnh, nên danh tính "quảng cáo của chính shop" phải đến từ `ad_id` trên tài khoản của shop — một ô
 * chọn loại trên form thì ai cũng bấm được cho một ảnh chụp quảng cáo đối thủ.
 */
export const MANUAL_UPLOAD_SOURCE_KINDS = ["PRODUCT_PHOTO", "MANUAL", "SPY", "RND"] as const satisfies readonly CreativeSourceKind[];

/**
 * Loại nguồn nào được gửi ĐIỂM ẢNH sang máy sinh ảnh — xem ranh giới 2 ở đầu tệp. `SPY` cố ý vắng mặt.
 * `MANUAL` và `RND` cũng vắng mặt: chúng có thể là ảnh chụp màn hình của bất kỳ ai, và máy không phân
 * biệt được. Chúng vẫn dạy được máy qua gen đọc ra.
 *
 * `OWN_AD` có mặt vì CÙNG lý do ảnh mẫu thắng của vòng được dùng: nó là quảng cáo CỦA SHOP đã chạy trên
 * tài khoản của shop. Nó đi sang `editImage` dưới nhãn `OWN_VARIANT` (ảnh của chính shop), LUÔN kèm ảnh
 * `PRODUCT_PHOTO` làm gốc (`assertPixelSafe`) — quảng cáo cũ chỉ là tham chiếu bố cục, không thay sản phẩm.
 */
export const PIXEL_SAFE_SOURCE_KINDS: readonly CreativeSourceKind[] = ["PRODUCT_PHOTO", "OWN_AD"];

/**
 * Nhãn mà từng loại nguồn gửi-được-điểm-ảnh mang khi sang `editImage` (`ImageEditKind`). Loại nào
 * không có ở đây thì không có nhãn — và không có nhãn thì `assertPixelSafe` chặn.
 */
export const PIXEL_SAFE_EDIT_LABEL: Readonly<Partial<Record<CreativeSourceKind, "PRODUCT_PHOTO" | "OWN_VARIANT">>> = { PRODUCT_PHOTO: "PRODUCT_PHOTO", OWN_AD: "OWN_VARIANT" };

// ───────────────────────────── NHẬP MẪU TỐT TỪ FACEBOOK ─────────────────────────────

/**
 * Ngưỡng chọn quảng cáo cũ của shop làm nguồn `OWN_AD`. Chủ shop nêu 24/09/2026: "giá tin nhắn < 4.000đ
 * là chỉ số tốt" — lấy luôn mẫu thắng và mẫu có chỉ số tốt làm nguồn ảnh ban đầu.
 *
 *  · `lookbackDays` — chỉ xét mẩu có dòng chi hạt `AD` trong bấy nhiêu ngày gần nhất.
 *  · `minMessages`  — dưới 5 tin nhắn thì "chi / tin" là may rủi, chưa phải chỉ số.
 *  · TỐT = chi / tin nhắn CẢ ĐỜI dưới `goodCostPerMessageBelowVnd` VÀ đã chi ít nhất `goodMinSpendVnd`
 *    (một mẩu chi 8.000đ ra 5 tin trông rẻ mà chưa chứng minh được gì).
 *  · THẮNG = đơn chốt quy về `ad_id` VƯỢT `winOrdersAbove` của cấu hình — cùng ngưỡng với mẫu của vòng.
 *  · `maxPerImport` — một lượt bấm nhập tối đa bấy nhiêu mẩu (mỗi mẩu 1–2 lời gọi Graph + tải một ảnh).
 */
export const OWN_AD_IMPORT = {
  lookbackDays: 60,
  minMessages: 5,
  goodCostPerMessageBelowVnd: 4_000,
  goodMinSpendVnd: 50_000,
  maxPerImport: 30,
} as const;

export type OwnAdReason = "WIN" | "GOOD";

export const OWN_AD_REASON_LABEL: Record<OwnAdReason, string> = { WIN: "Mẫu thắng", GOOD: "Chỉ số tốt" };

/**
 * Mẩu này có đủ điều kiện làm nguồn `OWN_AD` không — hàm thuần. Không có số chi hoặc dưới ngưỡng tin
 * nhắn thì KHÔNG phải "tốt": CHƯA BIẾT không bao giờ được coi là rẻ (mục 42).
 */
export function classifyOwnAd(m: { spendVnd: number | null; messages: number | null; bookedOrders: number }, winOrdersAbove: number): OwnAdReason | null {
  const messages = m.messages ?? 0;
  if (messages < OWN_AD_IMPORT.minMessages) return null;
  if (m.bookedOrders > winOrdersAbove) return "WIN";
  if (m.spendVnd === null || m.spendVnd < OWN_AD_IMPORT.goodMinSpendVnd) return null;
  return m.spendVnd / messages < OWN_AD_IMPORT.goodCostPerMessageBelowVnd ? "GOOD" : null;
}

/** Số đo chụp vào `creative_sources.metrics` lúc nhập một `OWN_AD`. `null` = CHƯA BIẾT, không phải 0. */
export type OwnAdMetrics = {
  reason: OwnAdReason | null;
  spendVnd: number | null;
  messages: number | null;
  costPerMessageVnd: number | null;
  impressions: number | null;
  clicks: number | null;
  ctrPct: number | null;
  cpcVnd: number | null;
  bookedOrders: number;
  deliveredOrders: number;
  returnedOrders: number;
  /** Kỳ đo — ngày VN đầu / cuối có dòng chi hạt `AD`. */
  periodFrom: string | null;
  periodTo: string | null;
  measuredAt: string | null;
  /** Mã hàng suy từ đâu: dòng đơn mang `ad_id` · `ad_spends.product_id` · không suy được. */
  productBasis: "ORDERS" | "AD_SPENDS" | "NONE";
};

/** Đọc `metrics` (JSON không tin được). Số hỏng ⇒ `null`, không điền 0. */
export function parseOwnAdMetrics(raw: unknown): OwnAdMetrics {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : null);
  const s = (x: unknown) => (typeof x === "string" && x ? x : null);
  return {
    reason: r.reason === "WIN" || r.reason === "GOOD" ? r.reason : null,
    spendVnd: n(r.spendVnd),
    messages: n(r.messages),
    costPerMessageVnd: n(r.costPerMessageVnd),
    impressions: n(r.impressions),
    clicks: n(r.clicks),
    ctrPct: n(r.ctrPct),
    cpcVnd: n(r.cpcVnd),
    bookedOrders: n(r.bookedOrders) ?? 0,
    deliveredOrders: n(r.deliveredOrders) ?? 0,
    returnedOrders: n(r.returnedOrders) ?? 0,
    periodFrom: s(r.periodFrom),
    periodTo: s(r.periodTo),
    measuredAt: s(r.measuredAt),
    productBasis: r.productBasis === "ORDERS" || r.productBasis === "AD_SPENDS" ? r.productBasis : "NONE",
  };
}

// ───────────────────────────── NHẬP ẢNH SẢN PHẨM TỪ PANCAKE ─────────────────────────────

/** Một lượt bấm "Nhập ảnh sản phẩm từ Pancake" tải tối đa bấy nhiêu ảnh; còn thiếu thì bấm lại. */
export const PANCAKE_PHOTO_IMPORT_MAX = 40;

// ───────────────────────────── VÒNG ĐỜI ─────────────────────────────

/**
 * Trạng thái của một LÔ (một ngày test).
 *
 * `PLANNED`          — đã lập lô, đang viết/sinh ảnh.
 * `PENDING_APPROVAL` — đủ ảnh, chờ người duyệt.
 * `APPROVED`         — người đã duyệt, chờ máy đăng.
 * `PUBLISHED`        — đã đăng hết các mẫu được duyệt (có thể một vài mẫu lỗi — xem từng mẫu).
 * `EXPIRED`          — quá hạn duyệt, KHÔNG có đồng nào được chi. Hướng an toàn của mọi nhánh lỗi.
 * `REJECTED`         — người từ chối cả lô.
 * `FAILED`           — hỏng khi lập/sinh; câu lỗi nằm ở `error`.
 */
export const BATCH_STATUSES = ["PLANNED", "PENDING_APPROVAL", "APPROVED", "PUBLISHED", "EXPIRED", "REJECTED", "FAILED"] as const;
export type BatchStatus = (typeof BATCH_STATUSES)[number];

export const BATCH_STATUS_LABEL: Record<BatchStatus, string> = {
  PLANNED: "Đang dựng",
  PENDING_APPROVAL: "Chờ duyệt",
  APPROVED: "Đã duyệt, chờ đăng",
  PUBLISHED: "Đã đăng",
  EXPIRED: "Quá hạn duyệt",
  REJECTED: "Bị từ chối",
  FAILED: "Lỗi",
};

/**
 * Trạng thái của một MẪU (một ô trong lô). Đây là SỰ KIỆN đã xảy ra, không phải phán quyết —
 * phán quyết là `CreativeVerdict`, tính lại lúc đọc từ số đo.
 *
 * `PLANNED`        — có bản giao việc, chưa có ảnh.
 * `GENERATED`      — có ảnh + câu chữ, chờ duyệt cùng lô.
 * `GEN_FAILED`     — viết hoặc sinh ảnh hỏng.
 * `REJECTED`       — người gạt khỏi lô lúc duyệt (không đăng, không tốn tiền QC).
 * `LIVE`           — đã có mẩu QC trên Facebook.
 * `PAUSED`         — máy hoặc người đã tắt sớm.
 * `ENDED`          — hết khung test, tự dừng theo `end_time` (không cần lời gọi ghi nào).
 * `PUBLISH_FAILED` — đăng hỏng; không có mẩu nào đang tiêu tiền (xem sổ `creative_fb_actions`).
 */
export const VARIANT_STATUSES = ["PLANNED", "GENERATED", "GEN_FAILED", "REJECTED", "LIVE", "PAUSED", "ENDED", "PUBLISH_FAILED"] as const;
export type VariantStatus = (typeof VARIANT_STATUSES)[number];

export const VARIANT_STATUS_LABEL: Record<VariantStatus, string> = {
  PLANNED: "Chờ sinh ảnh",
  GENERATED: "Có ảnh, chờ duyệt",
  GEN_FAILED: "Sinh ảnh lỗi",
  REJECTED: "Bị gạt khỏi lô",
  LIVE: "Đang chạy",
  PAUSED: "Đã tắt sớm",
  ENDED: "Hết khung test",
  PUBLISH_FAILED: "Đăng lỗi",
};

/**
 * `EXPLOIT` · `EXPLORE` — ô do máy lập (`planBatch`). Ô `EXPLOIT` là MOCKUP hằng ngày của một mẫu thắng
 *             chủ shop CHỌN (`mockupSourceIds` / `mockupProductIds`): giữ sản phẩm, đổi đúng một gen.
 * `MANUAL`  — mẫu NGƯỜI tự làm (vd vẽ trên web ChatGPT/Grok) rồi tải vào lô: không qua máy viết và máy
 *             sinh ảnh, nhưng đi qua ĐÚNG cổng duyệt · đăng · chấm · học như mẫu máy làm.
 * `DESIGN`  — THIẾT KẾ SẢN PHẨM MỚI (chủ shop 24/09/2026): mẫu chưa từng có, lai DNA của các mã bán tốt
 *             (`planDesigns`), nối về một dòng `design_concepts` (mã `TK-YYMMDD-NN`). Ngoại lệ có chủ đích
 *             của ranh giới 3 — xem đầu tệp.
 */
export type SlotMode = "EXPLOIT" | "EXPLORE" | "MANUAL" | "DESIGN";

export const SLOT_MODES: readonly SlotMode[] = ["EXPLOIT", "EXPLORE", "MANUAL", "DESIGN"];

export const SLOT_MODE_LABEL: Record<SlotMode, string> = { EXPLOIT: "Mockup mẫu thắng", EXPLORE: "Thăm dò", MANUAL: "Tự làm", DESIGN: "Thiết kế mới" };

/**
 * Thứ tự ĐĂNG theo chế độ ô (chủ shop 24/09/2026): mẫu tự làm → thiết kế mới (phần chính của lô) →
 * mockup mẫu thắng → thăm dò. Trần số mẫu cắt ở CUỐI thứ tự này.
 */
export const SLOT_MODE_PUBLISH_RANK: Record<SlotMode, number> = { MANUAL: 0, DESIGN: 1, EXPLOIT: 2, EXPLORE: 3 };

/**
 * Ô của mẫu tự làm đánh số từ đây (1001, 1002…), tách hẳn khỏi dải ô máy lập (1…13): hai đường ghi
 * vào cùng một lô không bao giờ tranh nhau một số ô (khoá `(batch_id, slot)`).
 */
export const MANUAL_SLOT_BASE = 1000;

// ───────────────────────────── LUẬT CHẤM ─────────────────────────────

/**
 * Chỉ số dùng được trong luật. Mọi tỷ số có mẫu số 0 là `null` (CHƯA BIẾT, mục 42) và luật trên
 * chỉ số `null` KHÔNG kích hoạt. Muốn nói "đã tiêu 150K mà không có tin nhắn nào thì tắt", viết
 * luật trên `messages` (một con số, không phải tỷ số): `{ metric: "messages", op: "lt", value: 1,
 * minSpendVnd: 150000 }`.
 */
export const RULE_METRICS = ["spend", "impressions", "clicks", "messages", "orders", "cpm", "ctr", "cpc", "costPerMessage", "costPerOrder"] as const;
export type RuleMetric = (typeof RULE_METRICS)[number];

export const RULE_METRIC_LABEL: Record<RuleMetric, string> = {
  spend: "Chi (đ)",
  impressions: "Lượt hiển thị",
  clicks: "Lượt nhấp",
  messages: "Tin nhắn",
  orders: "Đơn chốt",
  cpm: "CPM (đ / 1.000 hiển thị)",
  ctr: "CTR (%)",
  cpc: "CPC (đ)",
  costPerMessage: "Chi / tin nhắn (đ)",
  costPerOrder: "Chi / đơn (đ)",
};

export type RuleOp = "gt" | "gte" | "lt" | "lte";

export type CreativeRule = {
  metric: RuleMetric;
  op: RuleOp;
  value: number;
  /**
   * Luật chỉ được xét khi mẫu đã chi TỐI THIỂU bấy nhiêu. Không có sàn này thì mẫu nào cũng bị tắt ở
   * phút thứ năm vì CPM của 300 lượt hiển thị đầu tiên luôn trông tệ.
   */
  minSpendVnd: number;
  /** Tên người khai đặt cho luật, để màn hình nói "tắt vì: Đắt tin nhắn" thay vì in công thức. */
  label?: string;
};

/**
 * Phán quyết của một mẫu — tính lại lúc đọc (hàm thuần `judgeVariant`), sổ `creative_verdicts` chỉ
 * CHỤP LẠI để đọc được lịch sử.
 *
 * `PENDING`         — chưa chạy.
 * `RUNNING`         — đang trong khung test, chưa luật nào kích hoạt.
 * `AWAITING_ORDERS` — hết khung test nhưng đơn từ tin nhắn còn đang về (trong `verdictSettleHours`).
 * `KILL`            — một luật TẮT kích hoạt ⇒ máy tắt mẩu (đã được lô duyệt cho phép trước).
 * `PROMISING`       — qua mọi luật GIỮ ⇒ ĐỀ NGHỊ cho tiêu thêm (người bấm, không tự tiêu).
 * `WIN`             — đơn chốt vượt `winOrdersAbove` ⇒ vào thư viện, và KHÔNG bao giờ tự rơi ra.
 * `LOSE`            — đã ngã ngũ mà không thắng, không hứa hẹn ⇒ bị loại, ảnh bị xoá sau hạn giữ.
 * `UNJUDGED`        — đã ngã ngũ nhưng máy KHÔNG ĐƯỢC kết luận: chưa khai luật giữ, hoặc không có
 *                     số chi. Khác hẳn `LOSE` — đây là thiếu căn cứ, không phải mẫu kém.
 */
export const CREATIVE_VERDICTS = ["PENDING", "RUNNING", "AWAITING_ORDERS", "KILL", "PROMISING", "WIN", "LOSE", "UNJUDGED"] as const;
export type CreativeVerdict = (typeof CREATIVE_VERDICTS)[number];

export const CREATIVE_VERDICT_LABEL: Record<CreativeVerdict, string> = {
  PENDING: "Chưa chạy",
  RUNNING: "Đang test",
  AWAITING_ORDERS: "Chờ đơn về",
  KILL: "Tắt sớm",
  PROMISING: "Hứa hẹn",
  WIN: "THẮNG",
  LOSE: "Loại",
  UNJUDGED: "Chưa kết luận được",
};

/** Phán quyết đã NGÃ NGŨ — dùng làm quan sát cho việc học. */
export const SETTLED_VERDICTS: readonly CreativeVerdict[] = ["KILL", "PROMISING", "WIN", "LOSE"];

// ───────────────────────────── TRẦN CỨNG CỦA MÃ NGUỒN ─────────────────────────────

/**
 * Cấu hình ở `settings` chỉ được LÀM HẸP các trần này, không bao giờ nới ra.
 *
 * Chủ shop chốt 24/09/2026 (lần một): 10 mẫu × 200.000đ × 1 ngày, chạy lúc 6:00. Chủ shop 24/09 (lần
 * hai, cùng lúc mở ô THIẾT KẾ MỚI): trần mới **20 mẫu / 4.000.000đ mỗi ngày chạy** — lô = 10 thiết kế mới
 * + 1 mockup cho mỗi mẫu thắng chủ shop chọn, mỗi mẫu vẫn 200.000đ. Nâng chúng là một lần sửa mã có
 * người đọc — không phải một dòng JSON ai đó gõ lúc nửa đêm.
 */
export const CREATIVE_HARD_LIMITS = {
  /** Số mẫu tối đa được ĐĂNG trong một lô. Chủ shop 24/09: 20 (trước đó 10). */
  maxBatchSize: 20,
  /** Ngân sách trọn đời tối đa của MỘT mẫu trong khung test. */
  maxBudgetPerVariantVnd: 200_000,
  /** Khung test tối đa (ngày). */
  maxTestDays: 1,
  /**
   * Tổng ngân sách test được CAM KẾT cho một ngày chạy. Chủ shop 24/09: 4.000.000đ = 20 × 200.000đ. Đếm trên sổ
   * `creative_fb_actions` (lượt tạo nhóm ĐÃ ÁP), không đếm trên cấu hình — cấu hình có thể đổi
   * giữa hai lượt đăng, sổ thì không.
   */
  maxDailyTestSpendVnd: 4_000_000,
  /**
   * Một lượt "cho tiêu thêm" (người bấm trên mẫu HỨA HẸN) được cộng tối đa bấy nhiêu.
   * Chủ shop chốt 24/09/2026: 200.000đ — đúng bằng MỘT ngày test nữa của một mẫu.
   */
  maxExtensionPerClickVnd: 200_000,
  /** Tổng tiền "tiêu thêm" được bấm trong một ngày, toàn shop. Chủ shop chốt 24/09/2026: 1.000.000đ (≤ 5 lượt). */
  maxDailyExtensionVnd: 1_000_000,
  /**
   * Số ảnh sinh tối đa trong một ngày CỦA LÔ HẰNG NGÀY — kể cả ảnh sinh lại. Chặn một vòng lặp hỏng đốt credit.
   * Ảnh gen tay không tính vào đây (chủ shop 26/09/2026 gỡ trần gen tay — xem `MANUAL_GEN_RUN`).
   */
  maxImagesPerDay: 30,
  /**
   * Trần chi sinh ảnh / ngày (USD). Chủ shop chốt 24/09/2026: 2 USD, và GIỮ NGUYÊN khi chuyển sang
   * "Cao + Batch": một lô 13 ảnh chất lượng cao khổ 4:5 qua Batch ƯỚC TÍNH ~1,4 USD (`estimateImageUsd`).
   * Lô đầy trần 20 mẫu (chủ shop 24/09, lần hai) ở cấu hình đang chạy (gọi ngay · vừa · 4:5) ≈ 1,7 USD — vừa
   * trần; ở "Cao + Batch" thì 20 ảnh ≈ 2,2 USD, VƯỢT — ô vượt thành "Sinh ảnh lỗi" có lý do. Cấu hình chỉ hạ được.
   */
  maxImageUsdPerDay: 2,
  /**
   * SCALE MẪU THẮNG (§5g) — ngân sách NGÀY tối đa của MỘT chiến dịch nháp do vòng sao chép.
   * Chủ shop chốt 24/09/2026: 500.000đ/ngày mỗi chiến dịch nháp. Cấu hình chỉ hạ được.
   */
  maxScaleDailyBudgetVnd: 500_000,
  /**
   * Tổng ngân sách NGÀY của mọi chiến dịch scale ĐANG BẬT do vòng tạo (đếm trên bảng
   * `creative_scale_drafts`, trạng thái `ACTIVE`). **ĐỀ XUẤT, CHỜ CHỦ SHOP CHỐT** (AGENTS.md mục 7):
   * 5.000.000đ = 10 chiến dịch × 500.000đ. Chặn một chuỗi bấm "Duyệt chạy" liên tiếp thành một
   * khoản chi ngày không ai cộng lại.
   */
  maxScaleActiveDailyTotalVnd: 5_000_000,
  /** Mỗi mẫu thắng tối đa bấy nhiêu chiến dịch nháp — đúng một cho mỗi loại (`SCALE_KINDS`). */
  maxScaleDraftsPerVariant: 2,
} as const;

// ───────────────────────────── CẤU HÌNH (settings `creative.config`) ─────────────────────────────

export const CREATIVE_CONFIG_KEY = "creative.config";

/**
 * Khổ ảnh. Hai khổ đầu là khổ chuẩn của gpt-image; `1088x1360` là khổ DỌC 4:5 của bảng tin Facebook
 * (chủ shop chốt 24/09/2026). Mô hình gpt-image-2.x nhận kích thước tuỳ ý khi hai cạnh là bội số 16,
 * tỷ lệ trong 1:3–3:1 và không cạnh nào quá 3840 (developers.openai.com/api/docs/guides/image-generation,
 * đọc 24/09/2026): 1088 = 68 × 16, 1360 = 85 × 16, 1088 / 1360 = 0,8 đúng 4:5.
 */
export const IMAGE_SIZES = ["1024x1024", "1024x1536", "1088x1360"] as const;
export type ImageSize = (typeof IMAGE_SIZES)[number];
export const IMAGE_SIZE_LABEL: Record<ImageSize, string> = { "1024x1024": "Vuông 1:1 · 1024×1024", "1024x1536": "Dọc 2:3 · 1024×1536", "1088x1360": "Dọc 4:5 · 1088×1360 (bảng tin Facebook)" };

export const IMAGE_QUALITIES = ["low", "medium", "high"] as const;
export type ImageQuality = (typeof IMAGE_QUALITIES)[number];
export const IMAGE_QUALITY_LABEL: Record<ImageQuality, string> = { low: "Thấp", medium: "Vừa", high: "Cao" };

/**
 * Cách gửi yêu cầu vẽ ảnh.
 *
 * `BATCH` — gom mọi ô của lô thành MỘT lô Batch API của OpenAI (giảm 50%, OpenAI hứa xong trong 24 giờ)
 *           ngay lúc dựng lô. Tới `batchFallbackHourVn` của ngày chạy mà còn ô chưa có ảnh ⇒ huỷ lô
 *           Batch và vẽ nốt bằng gọi ngay ở `fallbackImageQuality`, vẫn trong trần ngày.
 * `SYNC`  — gọi ngay từng ảnh (hành vi trước 24/09/2026).
 */
export const IMAGE_MODES = ["BATCH", "SYNC"] as const;
export type ImageMode = (typeof IMAGE_MODES)[number];
export const IMAGE_MODE_LABEL: Record<ImageMode, string> = { BATCH: "Batch (rẻ 50%, chậm)", SYNC: "Gọi ngay (giá đủ)" };

export type CreativeLoopConfig = {
  /** Công tắc mềm. Job vẫn cần `CREATIVE_LOOP_EVERY_MINUTES` ở env mới có trong lịch. */
  enabled: boolean;
  /** Fanpage đứng tên bài quảng cáo (id Facebook). */
  pageId: string;
  /** Tài khoản quảng cáo, dạng số không kèm `act_`. */
  adAccountId: string;
  /**
   * Chiến dịch TEST do NGƯỜI dựng sẵn trên Ads Manager, chứa MẨU QC MẪU. Từ 25/09/2026 (§5i) mỗi bài được
   * đăng thành MỘT chiến dịch RIÊNG tạo từ các trường của chiến dịch này (mục tiêu · hạng mục đặc biệt ·
   * kiểu mua), luôn TẮT tới bước cuối; nhóm + mẩu nằm trong chiến dịch riêng ấy. Cổng từ chối mọi lượt ghi
   * nhắm vào chiến dịch KHÁC chiến dịch test và chiến dịch riêng vòng đã tạo cho chính bài. Mẫu đăng dở
   * theo cấu trúc cũ (nhóm nằm trong chính chiến dịch này) đi tiếp đường cũ.
   */
  testCampaignId: string;
  /**
   * Mẩu QC MẪU nằm trong chiến dịch test. Máy chép từ nó: đối tượng, mục tiêu tối ưu, nút kêu gọi,
   * đích tin nhắn — tức mọi thứ đòi phán đoán mà ERP không có dữ liệu để tự quyết. Máy chỉ thay
   * ẢNH, CÂU CHỮ, TIÊU ĐỀ, NGÂN SÁCH và KHUNG GIỜ.
   */
  templateAdId: string;
  currency: "VND" | "USD";
  batchSize: number;
  budgetPerVariantVnd: number;
  testDays: number;
  /** Giờ Việt Nam bắt đầu chạy (chủ shop chốt 6:00). */
  startHourVn: number;
  /** Lô phải được duyệt TRƯỚC giờ chạy bấy nhiêu phút; quá hạn ⇒ `EXPIRED`, không tiêu đồng nào. */
  approvalLeadMinutes: number;
  /** Giờ Việt Nam bắt đầu dựng lô cho NGÀY MAI. */
  genHourVn: number;
  /** Sinh dư bấy nhiêu ô THIẾT KẾ để người duyệt gạt bớt mà lô vẫn đủ. Chủ shop 24/09: mặc định 0. */
  extraCandidates: number;
  /**
   * Số ô THIẾT KẾ MỚI mỗi lô (chủ shop 24/09/2026: 10 — phần chính của lô). Không đủ mã bán tốt có DNA
   * hoặc không đủ thiết kế đủ MỚI LẠ ⇒ lô ít ô hơn và `shortfall` nói vì sao, không nhồi.
   */
  designSlots: number;
  /**
   * Số ô THĂM DÒ (gen mới / nguồn cảm hứng). Chủ shop 24/09: thăm dò giờ là việc của ô thiết kế ⇒ mặc
   * định 0; mã vẫn giữ để bật lại được.
   */
  exploreSlots: number;
  /**
   * MOCKUP hằng ngày — nguồn `OWN_AD` (quảng cáo cũ của shop) mà chủ shop bật "Chạy mockup hằng ngày".
   * Mỗi nguồn = 1 ô khai thác mỗi lô (giữ sản phẩm, đổi một gen). Nguồn chưa đủ sáu gen / chưa có mã có
   * ảnh thật ⇒ không lập được, `shortfall` nói ra.
   */
  mockupSourceIds: string[];
  /**
   * MOCKUP hằng ngày theo MÃ HÀNG (công tắc trên thẻ ảnh sản phẩm thật): mỗi mã = 1 ô khai thác từ mẫu
   * cha tốt nhất của chính mã ấy (mẫu thắng / hứa hẹn của vòng hoặc quảng cáo cũ của shop).
   */
  mockupProductIds: string[];
  /** THẮNG khi đơn chốt (không huỷ) quy về mẫu VƯỢT con số này. Chủ shop chốt: > 100. */
  winOrdersAbove: number;
  /**
   * Hết khung test rồi đợi bấy nhiêu giờ mới kết luận LOẠI: khách nhắn tin hôm nay có thể chốt đơn
   * ngày mai. Luật TẮT vẫn chạy ngay trong ngày.
   */
  verdictSettleHours: number;
  /** Luật TẮT SỚM — BẤT KỲ luật nào kích hoạt ⇒ tắt. Rỗng ⇒ máy KHÔNG tự tắt gì. */
  killRules: CreativeRule[];
  /** Luật GIỮ — qua TẤT CẢ ⇒ hứa hẹn ⇒ đề nghị tiêu thêm. Rỗng ⇒ máy không kết luận hứa hẹn/loại. */
  keepRules: CreativeRule[];
  /**
   * CHỈ test các mã này (cả ô thăm dò lẫn ô khai thác). Rỗng ⇒ mọi mã có ảnh sản phẩm thật.
   * Lọc cả hai loại ô là chủ ý: người khai "chỉ chạy mã A, B" không muốn thấy biến thể của mã C lọt vào lô.
   */
  focusProductIds: string[];
  imageModel: string;
  imageSize: ImageSize;
  imageQuality: ImageQuality;
  /** `BATCH` (mặc định) hay gọi ngay — xem `IMAGE_MODES`. */
  imageMode: ImageMode;
  /**
   * Giờ Việt Nam (đêm trước giờ chạy) mà lô Batch còn chưa xong thì bị huỷ và vẽ nốt bằng gọi ngay.
   * Là mốc `HH:00` gần nhất ĐỨNG TRƯỚC hạn duyệt — xem `imageBatchFallbackAt()`.
   */
  batchFallbackHourVn: number;
  /** Chất lượng của lượt vẽ nốt bằng gọi ngay — thấp hơn để không vượt trần ngày (giá đủ, không giảm 50%). */
  fallbackImageQuality: ImageQuality;
  imageDailyCapUsd: number;
  /** Ảnh của mẫu bị LOẠI được giữ bấy nhiêu ngày cho người xem lại, rồi xoá điểm ảnh (giữ gen + số đo). */
  loserImageRetentionDays: number;
  /**
   * SCALE MẪU THẮNG (§5g): hai chiến dịch MẪU do NGƯỜI dựng sẵn trên Ads Manager, mỗi chiến dịch
   * ĐÚNG một nhóm + một mẩu, mục tiêu đặt sẵn. Máy chỉ SAO CHÉP đúng hai id này — id khác bị chặn.
   * Rỗng ⇒ loại scale ấy không dựng được nháp.
   */
  scaleTemplates: ScaleTemplates;
  /** Ngân sách NGÀY đặt cho mỗi chiến dịch nháp. Chủ shop chốt 500.000đ (24/09/2026); trần `maxScaleDailyBudgetVnd`. */
  scaleDailyBudgetVnd: number;
};

/** Id chiến dịch MẪU cho từng loại scale — xem `SCALE_KINDS`. */
export type ScaleTemplates = { purchaseMessagingCampaignId: string; leadsCampaignId: string };

/**
 * Mặc định. Mọi trường TIỀN và NGƯỠNG THẮNG lấy thẳng từ quyết định của chủ shop; hai bộ luật để
 * RỖNG vì chủ shop nói sẽ tự điền — máy không có bộ ngưỡng mặc định nào (cùng tinh thần mục 38/43).
 */
export const DEFAULT_CREATIVE_CONFIG: CreativeLoopConfig = {
  enabled: false,
  pageId: "",
  adAccountId: "",
  testCampaignId: "",
  templateAdId: "",
  currency: "VND",
  batchSize: CREATIVE_HARD_LIMITS.maxBatchSize,
  budgetPerVariantVnd: CREATIVE_HARD_LIMITS.maxBudgetPerVariantVnd,
  testDays: 1,
  startHourVn: 6,
  approvalLeadMinutes: 30,
  genHourVn: 14,
  // Chủ shop 24/09/2026: lô = 10 thiết kế + 1 mockup / mẫu thắng được chọn — không sinh dư mặc định.
  extraCandidates: 0,
  designSlots: 10,
  exploreSlots: 0,
  mockupSourceIds: [],
  mockupProductIds: [],
  winOrdersAbove: 100,
  verdictSettleHours: 24,
  killRules: [],
  keepRules: [],
  focusProductIds: [],
  // Chủ shop chốt 24/09/2026 (lần hai): "Sunburst vừa, gọi ngay, giữ 2 USD". Lần đầu chọn "Cao + Batch"
  // nhưng tài liệu OpenAI ghi sunburst KHÔNG nhận Batch (`imageModelBatchSupport`). Đường Batch vẫn giữ
  // cho mô hình nhận nó (vd gpt-image-2) — đổi ở tab Cấu hình. gpt-image-1 bị ngừng ngày 23/10/2026.
  imageModel: "gpt-image-2.5-sunburst",
  imageSize: "1088x1360",
  imageQuality: "medium",
  imageMode: "SYNC",
  batchFallbackHourVn: 2,
  fallbackImageQuality: "medium",
  imageDailyCapUsd: 2,
  loserImageRetentionDays: 7,
  scaleTemplates: { purchaseMessagingCampaignId: "", leadsCampaignId: "" },
  scaleDailyBudgetVnd: CREATIVE_HARD_LIMITS.maxScaleDailyBudgetVnd,
};

/** Trường nào còn thiếu thì vòng KHÔNG ĐĂNG được — màn hình in đúng danh sách này. */
export type ConfigProblem = { field: keyof CreativeLoopConfig | "rules"; message: string };

function num(raw: unknown, fallback: number, min: number, max: number): number {
  const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : Number.NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function str(raw: unknown): string {
  return typeof raw === "string" ? raw.trim() : "";
}

/** Danh sách id (chuỗi khác rỗng, không trùng, giữ thứ tự nhập). Phần tử lạ bị bỏ. */
function idList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set((raw as unknown[]).map(str).filter(Boolean))].slice(0, 200);
}

function parseRule(raw: unknown): CreativeRule | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const metric = RULE_METRICS.find((m) => m === r.metric);
  const op = (["gt", "gte", "lt", "lte"] as const).find((o) => o === r.op);
  const value = typeof r.value === "number" && Number.isFinite(r.value) ? r.value : null;
  const minSpendVnd = typeof r.minSpendVnd === "number" && Number.isFinite(r.minSpendVnd) && r.minSpendVnd >= 0 ? Math.round(r.minSpendVnd) : null;
  if (!metric || !op || value === null || minSpendVnd === null) return null;
  const label = str(r.label);
  return { metric, op, value, minSpendVnd, ...(label ? { label } : {}) };
}

/** Hai id mẫu scale: chỉ nhận chuỗi SỐ (id Facebook). Chuỗi lạ ⇒ rỗng — không đoán, không sửa hộ. */
export function parseScaleTemplates(raw: unknown): ScaleTemplates {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const id = (x: unknown) => {
    const t = str(x);
    return /^[0-9]{5,25}$/.test(t) ? t : "";
  };
  return { purchaseMessagingCampaignId: id(r.purchaseMessagingCampaignId), leadsCampaignId: id(r.leadsCampaignId) };
}

/**
 * Đọc cấu hình từ nguồn không tin được (bảng `settings`), KẸP vào trần cứng, và nói ra thứ còn thiếu.
 *
 * Luật hỏng bị BỎ nguyên dòng và được báo, không bị sửa hộ: sửa hộ một ngưỡng là đoán ý người nhập
 * (cùng tinh thần mục 54) — và ở đây đoán sai là tắt nhầm mẫu hoặc để chảy tiền.
 */
export function normalizeCreativeConfig(raw: unknown): { config: CreativeLoopConfig; problems: ConfigProblem[] } {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const d = DEFAULT_CREATIVE_CONFIG;
  const L = CREATIVE_HARD_LIMITS;
  const problems: ConfigProblem[] = [];

  const rules = (key: "killRules" | "keepRules"): CreativeRule[] => {
    const arr = Array.isArray(r[key]) ? (r[key] as unknown[]) : [];
    const out: CreativeRule[] = [];
    arr.forEach((x, i) => {
      const p = parseRule(x);
      if (p) out.push(p);
      else problems.push({ field: "rules", message: `${key === "killRules" ? "Luật tắt" : "Luật giữ"} #${i + 1} không đọc được — đã bỏ nguyên dòng.` });
    });
    return out;
  };

  const config: CreativeLoopConfig = {
    enabled: r.enabled === true,
    pageId: str(r.pageId),
    adAccountId: str(r.adAccountId).replace(/^act_/, ""),
    testCampaignId: str(r.testCampaignId),
    templateAdId: str(r.templateAdId),
    currency: r.currency === "USD" ? "USD" : "VND",
    batchSize: Math.round(num(r.batchSize, d.batchSize, 1, L.maxBatchSize)),
    budgetPerVariantVnd: Math.round(num(r.budgetPerVariantVnd, d.budgetPerVariantVnd, 1, L.maxBudgetPerVariantVnd)),
    testDays: Math.round(num(r.testDays, d.testDays, 1, L.maxTestDays)),
    startHourVn: Math.round(num(r.startHourVn, d.startHourVn, 0, 23)),
    approvalLeadMinutes: Math.round(num(r.approvalLeadMinutes, d.approvalLeadMinutes, 10, 12 * 60)),
    genHourVn: Math.round(num(r.genHourVn, d.genHourVn, 0, 23)),
    extraCandidates: Math.round(num(r.extraCandidates, d.extraCandidates, 0, 10)),
    designSlots: Math.round(num(r.designSlots, d.designSlots, 0, L.maxBatchSize)),
    exploreSlots: Math.round(num(r.exploreSlots, d.exploreSlots, 0, L.maxBatchSize)),
    mockupSourceIds: idList(r.mockupSourceIds),
    mockupProductIds: idList(r.mockupProductIds),
    winOrdersAbove: Math.round(num(r.winOrdersAbove, d.winOrdersAbove, 1, 100_000)),
    verdictSettleHours: Math.round(num(r.verdictSettleHours, d.verdictSettleHours, 0, 14 * 24)),
    killRules: rules("killRules"),
    keepRules: rules("keepRules"),
    focusProductIds: Array.isArray(r.focusProductIds) ? (r.focusProductIds as unknown[]).map(str).filter(Boolean) : [],
    imageModel: str(r.imageModel) || d.imageModel,
    imageSize: IMAGE_SIZES.find((x) => x === r.imageSize) ?? d.imageSize,
    imageQuality: IMAGE_QUALITIES.find((x) => x === r.imageQuality) ?? d.imageQuality,
    imageMode: IMAGE_MODES.find((x) => x === r.imageMode) ?? d.imageMode,
    batchFallbackHourVn: Math.round(num(r.batchFallbackHourVn, d.batchFallbackHourVn, 0, 23)),
    fallbackImageQuality: IMAGE_QUALITIES.find((x) => x === r.fallbackImageQuality) ?? d.fallbackImageQuality,
    imageDailyCapUsd: num(r.imageDailyCapUsd, d.imageDailyCapUsd, 0, L.maxImageUsdPerDay),
    loserImageRetentionDays: Math.round(num(r.loserImageRetentionDays, d.loserImageRetentionDays, 0, 90)),
    scaleTemplates: parseScaleTemplates(r.scaleTemplates),
    scaleDailyBudgetVnd: Math.round(num(r.scaleDailyBudgetVnd, d.scaleDailyBudgetVnd, 1, L.maxScaleDailyBudgetVnd)),
  };

  // Tổng cam kết một ngày KHÔNG được vượt trần — kẹp số mẫu chứ không kẹp ngân sách từng mẫu, vì
  // ngân sách từng mẫu là thứ quyết định số đo có nghĩa hay không.
  const maxBySpend = Math.floor(L.maxDailyTestSpendVnd / config.budgetPerVariantVnd);
  if (config.batchSize > maxBySpend) config.batchSize = maxBySpend;

  if (!config.pageId) problems.push({ field: "pageId", message: "Chưa khai fanpage đứng tên bài quảng cáo." });
  if (!config.adAccountId) problems.push({ field: "adAccountId", message: "Chưa khai tài khoản quảng cáo." });
  if (!config.testCampaignId) problems.push({ field: "testCampaignId", message: "Chưa khai chiến dịch TEST (người dựng sẵn trên Ads Manager)." });
  if (!config.templateAdId) problems.push({ field: "templateAdId", message: "Chưa khai mẩu QC mẫu để máy chép đối tượng và nút kêu gọi." });
  return { config, problems };
}

/** Những trường mà THIẾU thì không ĐĂNG được (vẫn lập lô và sinh ảnh được để xem trước). */
export const PUBLISH_REQUIRED_FIELDS: readonly (keyof CreativeLoopConfig)[] = ["pageId", "adAccountId", "testCampaignId", "templateAdId"];

// ───────────────────────────── ĐƯỜNG GHI FACEBOOK CỦA VÒNG ─────────────────────────────

/**
 * Hành động ghi mà vòng mẫu được làm. Đi qua ĐÚNG cửa ghi đã có (`lib/integrations/facebook/ads-write.ts`)
 * và cùng chốt cứng `ADS_WRITE_ENABLED` + nấc `COPILOT`.
 *
 * Cố ý KHÔNG có: sửa đối tượng · đụng mẩu QC / chiến dịch không do vòng này tạo.
 *
 * MỖI BÀI MỘT CHIẾN DỊCH (chủ shop chốt 25/09/2026, `docs/creative-loop.md` §5i): `CREATE_CAMPAIGN` tạo
 * một chiến dịch riêng cho MỘT bài, mọi trường (mục tiêu · hạng mục đặc biệt · kiểu mua) chép NGUYÊN từ
 * chiến dịch của mẩu mẫu — luôn ở trạng thái TẮT; nhóm (ngân sách TRỌN ĐỜI + `end_time`) và mẩu tạo bên
 * trong; `ACTIVATE_CAMPAIGN` bật công tắc tổng CUỐI CÙNG. Chiến dịch mẫu để ngân sách ở cấp chiến dịch
 * (CBO) thì KHÔNG tạo — tiền phải nằm ở nhóm để trần 200.000đ/bài còn là trần trọn đời trên Facebook.
 *
 * NGOẠI LỆ CÓ CHỦ ĐÍCH — SCALE MẪU THẮNG (chủ shop quyết 24/09/2026, `docs/creative-loop.md` §5g): vòng
 * được tạo chiến dịch, nhưng CHỈ bằng cách SAO CHÉP một trong hai chiến dịch MẪU do NGƯỜI dựng (id khai ở
 * `scaleTemplates`), bản sao LUÔN ở trạng thái TẮT (`status_option=PAUSED`), và chỉ BẬT khi người bấm
 * "Duyệt chạy" với phiếu HMAC khoá đúng (chiến dịch nháp · ngân sách · bài quảng cáo). Sáu hành động
 * `*_SCALE*` dưới đây là toàn bộ ngoại lệ ấy; cổng của chúng là `gateScaleWrite`.
 */
export const CREATIVE_WRITE_ACTIONS = [
  "UPLOAD_IMAGE",
  "CREATE_CREATIVE",
  "CREATE_ADSET",
  "CREATE_AD",
  "PAUSE_ADSET",
  "EXTEND_ADSET",
  "CREATE_CAMPAIGN",
  "ACTIVATE_CAMPAIGN",
  "COPY_SCALE_CAMPAIGN",
  "CREATE_SCALE_CREATIVE",
  "SET_SCALE_AD_CREATIVE",
  "SET_SCALE_BUDGET",
  "ACTIVATE_SCALE",
  "PAUSE_SCALE",
] as const;
export type CreativeWriteAction = (typeof CREATIVE_WRITE_ACTIONS)[number];

export const CREATIVE_WRITE_ACTION_LABEL: Record<CreativeWriteAction, string> = {
  UPLOAD_IMAGE: "Tải ảnh lên tài khoản QC",
  CREATE_CREATIVE: "Tạo bài quảng cáo (bài ẩn trên fanpage)",
  CREATE_ADSET: "Tạo nhóm quảng cáo test",
  CREATE_AD: "Tạo mẩu quảng cáo",
  PAUSE_ADSET: "Tắt sớm",
  EXTEND_ADSET: "Cho tiêu thêm",
  CREATE_CAMPAIGN: "Tạo chiến dịch riêng của bài (TẮT)",
  ACTIVATE_CAMPAIGN: "Bật chiến dịch riêng của bài",
  COPY_SCALE_CAMPAIGN: "Sao chép chiến dịch mẫu scale (TẮT)",
  CREATE_SCALE_CREATIVE: "Tạo bài quảng cáo cho nháp scale",
  SET_SCALE_AD_CREATIVE: "Gắn bài mẫu thắng vào mẩu của nháp",
  SET_SCALE_BUDGET: "Đặt ngân sách ngày cho nháp scale",
  ACTIVATE_SCALE: "Bật chiến dịch scale (người duyệt)",
  PAUSE_SCALE: "Tắt chiến dịch scale",
};

/** Các hành động của ngoại lệ scale — cổng riêng `gateScaleWrite`, không đi qua `gateCreativeWrite`. */
export const SCALE_WRITE_ACTIONS = ["COPY_SCALE_CAMPAIGN", "CREATE_SCALE_CREATIVE", "SET_SCALE_AD_CREATIVE", "SET_SCALE_BUDGET", "ACTIVATE_SCALE", "PAUSE_SCALE"] as const satisfies readonly CreativeWriteAction[];
export type ScaleWriteAction = (typeof SCALE_WRITE_ACTIONS)[number];

// ───────────────────────────── SCALE MẪU THẮNG (§5g) ─────────────────────────────

/**
 * Hai loại chiến dịch scale chủ shop chọn (24/09/2026): tối đa hoá lượt MUA qua tin nhắn · khách hàng
 * TIỀM NĂNG. Mục tiêu, đối tượng, tối ưu, biểu mẫu đều nằm trong chiến dịch MẪU người dựng — máy chép
 * NGUYÊN, chỉ thay bài quảng cáo và ngân sách ngày.
 */
export const SCALE_KINDS = ["PURCHASE_MESSAGING", "LEADS"] as const;
export type ScaleKind = (typeof SCALE_KINDS)[number];

export const SCALE_KIND_LABEL: Record<ScaleKind, string> = {
  PURCHASE_MESSAGING: "Tối đa lượt mua qua tin nhắn",
  LEADS: "Khách hàng tiềm năng",
};

/** Khoá cấu hình của chiến dịch mẫu theo loại. */
export const SCALE_TEMPLATE_FIELD: Record<ScaleKind, keyof ScaleTemplates> = {
  PURCHASE_MESSAGING: "purchaseMessagingCampaignId",
  LEADS: "leadsCampaignId",
};

/**
 * Mục tiêu (`objective`) mà chiến dịch mẫu của từng loại PHẢI mang. Đọc lại trước khi sao chép: dán
 * nhầm id (mẫu khách tiềm năng vào ô mua qua tin nhắn) thì chặn, không sao chép một thứ khác loại.
 * `LEAD_GENERATION` là tên mục tiêu cũ trước bộ ODAX của Facebook.
 */
export const SCALE_KIND_OBJECTIVES: Record<ScaleKind, readonly string[]> = {
  PURCHASE_MESSAGING: ["OUTCOME_SALES"],
  LEADS: ["OUTCOME_LEADS", "LEAD_GENERATION"],
};

/** Phán quyết đủ căn cứ để ĐỀ NGHỊ scale. */
export const SCALE_ELIGIBLE_VERDICTS: readonly CreativeVerdict[] = ["WIN", "PROMISING"];

/**
 * Vòng đời một dòng `creative_scale_drafts`:
 *
 * `PROPOSED`  — máy ĐỀ NGHỊ (mẫu vừa đạt THẮNG / HỨA HẸN). Chưa một lời gọi Facebook nào.
 * `DRAFTING`  — người bấm "Dựng nháp", máy đang sao chép / thay bài / đặt ngân sách.
 * `DRAFT`     — nháp đã dựng xong trên Facebook, đang TẮT, chờ người "Duyệt chạy".
 * `ACTIVE`    — người đã duyệt, mẩu + nhóm + chiến dịch đã BẬT.
 * `PAUSED`    — người tắt lại chiến dịch scale qua ERP.
 * `FAILED`    — dựng nháp hỏng giữa chừng. Bản sao (nếu có) vẫn TẮT; id nằm ở `error` để người xoá tay.
 * `DISMISSED` — người bấm "Bỏ qua" đề nghị.
 */
export const SCALE_DRAFT_STATUSES = ["PROPOSED", "DRAFTING", "DRAFT", "ACTIVE", "PAUSED", "FAILED", "DISMISSED"] as const;
export type ScaleDraftStatus = (typeof SCALE_DRAFT_STATUSES)[number];

export const SCALE_DRAFT_STATUS_LABEL: Record<ScaleDraftStatus, string> = {
  PROPOSED: "Đề nghị",
  DRAFTING: "Đang dựng nháp",
  DRAFT: "Nháp — đang TẮT",
  ACTIVE: "Đang chạy",
  PAUSED: "Đã tắt",
  FAILED: "Dựng nháp lỗi",
  DISMISSED: "Đã bỏ qua",
};

/** Cấp đặt ngân sách của bản sao — đọc từ CHÍNH bản sao: chiến dịch (CBO) hay nhóm (ABO). */
export type ScaleBudgetLevel = "CAMPAIGN" | "ADSET";

export type CreativeWriteDenial =
  | "HARD_DISABLED"
  | "MODE_OFF"
  | "CONFIG_INCOMPLETE"
  | "NOT_APPROVED"
  | "APPROVAL_MISMATCH"
  | "WRONG_CAMPAIGN"
  | "NOT_OUR_AD"
  | "OVER_VARIANT_BUDGET"
  | "OVER_DAILY_CAP"
  | "OVER_BATCH_SIZE"
  | "TOO_LATE"
  | "OVER_EXTENSION_CAP"
  | "NOT_PROMISING"
  | "NO_KILL_RULE"
  | "KILL_SWITCH"
  | "NOT_SCALE_TEMPLATE"
  | "NOT_WINNER"
  | "SCALE_DUPLICATE"
  | "OVER_SCALE_BUDGET"
  | "OVER_SCALE_DAILY_CAP";

export const CREATIVE_WRITE_DENIAL_REASON: Record<CreativeWriteDenial, string> = {
  HARD_DISABLED: "Đường ghi quảng cáo đang TẮT ở cấp máy chủ (ADS_WRITE_ENABLED).",
  MODE_OFF: "Nấc quyền hạn đang OFF.",
  CONFIG_INCOMPLETE: "Cấu hình vòng mẫu còn thiếu (fanpage / tài khoản / chiến dịch test / mẩu mẫu).",
  NOT_APPROVED: "Lô chưa được người duyệt. Nấc COPILOT: không có phiếu duyệt thì không ghi.",
  APPROVAL_MISMATCH: "Nội dung mẫu đã đổi SAU khi duyệt (ảnh, câu chữ, ngân sách hoặc khung giờ). Phiếu duyệt khoá đúng thứ người đã xem.",
  WRONG_CAMPAIGN: "Lượt ghi nhắm vào một chiến dịch KHÁC chiến dịch test đã khai và khác chiến dịch riêng vòng mẫu vừa tạo cho chính bài này. Máy chỉ được làm việc trong hai chỗ ấy.",
  NOT_OUR_AD: "Nhóm/mẩu này không do vòng mẫu tạo. Máy không được đụng vào quảng cáo của người.",
  OVER_VARIANT_BUDGET: `Ngân sách một mẫu vượt trần ${CREATIVE_HARD_LIMITS.maxBudgetPerVariantVnd.toLocaleString("vi-VN")}đ.`,
  OVER_DAILY_CAP: `Tổng ngân sách test đã cam kết cho ngày chạy sẽ vượt trần ${CREATIVE_HARD_LIMITS.maxDailyTestSpendVnd.toLocaleString("vi-VN")}đ.`,
  OVER_BATCH_SIZE: `Lô đã có ${CREATIVE_HARD_LIMITS.maxBatchSize} mẫu được đăng.`,
  TOO_LATE: "Đã qua giờ bắt đầu chạy của lô. Đăng muộn là chạy một khung giờ khác với khung đã duyệt.",
  OVER_EXTENSION_CAP: "Vượt trần tiền 'tiêu thêm' (một lượt bấm hoặc cả ngày).",
  NOT_PROMISING: "Mẫu không ở trạng thái HỨA HẸN theo luật giữ — không có căn cứ để tiêu thêm.",
  NO_KILL_RULE: "Không luật tắt nào kích hoạt cho mẫu này.",
  KILL_SWITCH:
    "Công tắc tắt khẩn cấp đường ghi quảng cáo đang KÉO (settings `ads.write.kill`, hoặc không đọc được công tắc). Lô giữ nguyên trạng thái ĐÃ DUYỆT: nhả công tắc trước giờ chạy thì lượt kế tiếp đăng tiếp, quá giờ thì lô hết hạn mà không đồng nào được chi.",
  NOT_SCALE_TEMPLATE: "Chiến dịch nguồn KHÔNG phải chiến dịch mẫu scale đã khai trong cấu hình. Máy chỉ sao chép đúng hai chiến dịch mẫu do người dựng.",
  NOT_WINNER: "Mẫu không ở phán quyết THẮNG hoặc HỨA HẸN — không có căn cứ để scale.",
  SCALE_DUPLICATE: `Mẫu này đã có nháp cho loại chiến dịch này, hoặc đã đủ ${CREATIVE_HARD_LIMITS.maxScaleDraftsPerVariant} nháp. Không dựng nháp thứ hai.`,
  OVER_SCALE_BUDGET: `Ngân sách ngày của một chiến dịch scale vượt trần ${CREATIVE_HARD_LIMITS.maxScaleDailyBudgetVnd.toLocaleString("vi-VN")}đ (hoặc không hợp lệ).`,
  OVER_SCALE_DAILY_CAP: `Tổng ngân sách ngày của các chiến dịch scale đang bật sẽ vượt trần ${CREATIVE_HARD_LIMITS.maxScaleActiveDailyTotalVnd.toLocaleString("vi-VN")}đ (ĐỀ XUẤT, chờ chủ shop chốt).`,
};

// ───────────────────────────── GIÁ SINH ẢNH ─────────────────────────────

/**
 * ═══ BẢNG GIÁ TOKEN THEO MÔ HÌNH — MỘT BẢNG DUY NHẤT ═══
 *
 * USD / 1 triệu token, giá gọi ngay (không cache). Nguồn: developers.openai.com/api/docs/pricing và
 * trang từng mô hình (`/api/docs/models/<id>`), đọc 24/09/2026. `lib/integrations/openai/images.ts`
 * dùng lại ĐÚNG bảng này để ghi chi phí sau khi gọi — hai bảng là hai con số cho cùng một ảnh.
 *
 * Khớp tên: đúng tên, hoặc tên kèm hậu tố NGÀY (`gpt-image-2.5-sunburst-2026-09-08`). Không khớp theo
 * tiền tố trần: `gpt-image-1-mini` là mô hình khác, giá khác.
 */
export const IMAGE_MODEL_TOKEN_PRICE_PER_MTOK: Readonly<Record<string, { textInput: number; imageInput: number; imageOutput: number }>> = {
  "gpt-image-2.5-sunburst": { textInput: 5, imageInput: 8, imageOutput: 30 },
  "gpt-image-2.5-flare": { textInput: 5, imageInput: 8, imageOutput: 30 },
  "gpt-image-2": { textInput: 5, imageInput: 8, imageOutput: 30 },
  "gpt-image-1.5": { textInput: 5, imageInput: 8, imageOutput: 32 },
  "gpt-image-1": { textInput: 5, imageInput: 10, imageOutput: 40 },
};

/**
 * Batch API giảm 50% so với gọi ngay (developers.openai.com/api/docs/guides/batch, đọc 24/09/2026).
 * Trang giá CHƯA niêm yết giá Batch riêng cho gpt-image-2.5-* — hệ số này là của hướng dẫn Batch chung.
 */
export const IMAGE_BATCH_PRICE_FACTOR = 0.5;

/**
 * Mô hình có nhận Batch không, theo bảng "Endpoints" trên trang từng mô hình (đọc 24/09/2026):
 * `gpt-image-2.5-sunburst` và `-flare` ghi "Batch · v1/batch · Not supported"; `gpt-image-2` và
 * `gpt-image-1` ghi "Supported". Mô hình không có ở đây là CHƯA ĐỌC (`null`), không phải "không hỗ trợ".
 * Bảng này chỉ để MÀN HÌNH cảnh báo — đường sinh vẫn gửi thử và đọc câu trả lời THẬT của OpenAI (tài
 * liệu của một mô hình mới có thể đi sau API); gửi hỏng thì vẽ nốt bằng gọi ngay ngay lập tức.
 */
export const IMAGE_MODEL_BATCH_SUPPORT: Readonly<Record<string, boolean>> = {
  "gpt-image-2.5-sunburst": false,
  "gpt-image-2.5-flare": false,
  "gpt-image-2": true,
  "gpt-image-1": true,
};

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Khoá bảng giá của một tên mô hình, hoặc `null`. Xem luật khớp tên ở trên. */
export function imagePriceKeyOf(model: string): string | null {
  for (const k of Object.keys(IMAGE_MODEL_TOKEN_PRICE_PER_MTOK)) {
    if (model === k || new RegExp(`^${escapeRegExp(k)}-\\d{4}`).test(model)) return k;
  }
  return null;
}

/** `true` / `false` theo tài liệu; `null` = chưa đọc được tài liệu của mô hình này. */
export function imageModelBatchSupport(model: string): boolean | null {
  const k = imagePriceKeyOf(model);
  return k !== null && k in IMAGE_MODEL_BATCH_SUPPORT ? IMAGE_MODEL_BATCH_SUPPORT[k] : null;
}

/**
 * Số token ẢNH ĐẦU RA cho khổ 1024×1024 theo chất lượng — bảng "Cost and latency" OpenAI công bố cho
 * gpt-image-1 (low 272 · medium 1056 · high 4160). Trang của gpt-image-2.x KHÔNG công bố bảng này (đọc
 * 24/09/2026), nên đây là ƯỚC TÍNH dùng tạm cho mọi mô hình. Khổ khác quy theo DIỆN TÍCH (bảng gốc:
 * 1024×1536 = đúng 1,5 lần ở cả ba mức).
 */
export const IMAGE_OUTPUT_TOKENS_1024_SQUARE: Readonly<Record<ImageQuality, number>> = { low: 272, medium: 1056, high: 4160 };

/**
 * Phần ĐẦU VÀO của một lượt sửa ảnh — ước tính rộng tay: câu lệnh ~1.000 token chữ, tối đa 3 ảnh tham
 * chiếu (sản phẩm · mẫu cha · quảng cáo cũ của shop) × 1.500 token ảnh. Với một cái phanh, ước tính
 * THỪA làm chặn sớm hơn; ước tính THIẾU làm vượt trần.
 */
export const IMAGE_ESTIMATE_INPUT = { promptTextTokens: 1_000, references: 3, imageTokensPerReference: 1_500 } as const;

export function imageOutputTokensEstimate(quality: ImageQuality, size: ImageSize): number {
  const [w, h] = size.split("x").map(Number);
  return Math.ceil((IMAGE_OUTPUT_TOKENS_1024_SQUARE[quality] * w * h) / (1024 * 1024));
}

/**
 * Giá ƯỚC TÍNH một ảnh (USD) — dùng để CHẶN TRƯỚC khi gọi; chi phí THẬT ghi theo `usage` OpenAI trả về.
 * = (token chữ × giá chữ + token ảnh vào × giá ảnh vào + token ảnh ra × giá ảnh ra) / 1 triệu,
 * × `IMAGE_BATCH_PRICE_FACTOR` khi đi Batch. Mô hình không có trong bảng ⇒ tính theo mô hình ĐẮT NHẤT
 * của bảng (chặn sớm hơn, không muộn hơn).
 */
export function estimateImageUsd(model: string, quality: ImageQuality, size: ImageSize, mode: ImageMode = "SYNC"): number {
  const k = imagePriceKeyOf(model);
  const p = k ? IMAGE_MODEL_TOKEN_PRICE_PER_MTOK[k] : Object.values(IMAGE_MODEL_TOKEN_PRICE_PER_MTOK).reduce((a, b) => (b.imageOutput > a.imageOutput ? b : a));
  const inp = IMAGE_ESTIMATE_INPUT;
  const usd = (inp.promptTextTokens * p.textInput + inp.references * inp.imageTokensPerReference * p.imageInput + imageOutputTokensEstimate(quality, size) * p.imageOutput) / 1_000_000;
  return Math.round(usd * (mode === "BATCH" ? IMAGE_BATCH_PRICE_FACTOR : 1) * 1_000_000) / 1_000_000;
}

// ───────────────────────────── THIẾT KẾ SẢN PHẨM MỚI — DNA (chủ shop 24/09/2026) ─────────────────────────────

/**
 * Tăng khi đổi TỪ VỰNG DNA SẢN PHẨM. Tách hẳn khỏi `GENE_VOCAB_VERSION`: gen là thuộc tính của một
 * MẨU QUẢNG CÁO (bối cảnh, bố cục…), DNA là thuộc tính của CHIẾC ÁO / VÁY. Đổi nghĩa một giá trị DNA mà
 * vẫn so khác biệt với DNA đọc theo từ vựng cũ là so hai thứ khác nhau — dòng DNA khác phiên bản bị bỏ
 * qua ở mọi phép so, và mã ấy được đọc lại.
 */
export const DESIGN_DNA_VERSION = 1;

/**
 * "DNA" của một sản phẩm thời trang — một TỪ VỰNG ĐÓNG, cùng lý do với `GENE_VOCAB`: không đếm được thì
 * không học được, và không so được thì không kiểm được "mẫu mới có thật sự KHÁC mẫu cũ không".
 *
 * `NONE` ở cổ / tay = không có hoặc không áp dụng (quần, chân váy). Mô hình đọc ảnh chỉ được CHỌN trong
 * từ vựng; giá trị lạ bị BỎ (thuộc tính ấy thành CHƯA BIẾT), không bị ép về giá trị gần nhất.
 */
export const DESIGN_DNA_VOCAB = {
  /** Nhóm hàng. */
  category: ["DRESS", "BLOUSE", "SHIRT", "TEE", "KNIT_TOP", "OUTERWEAR", "PANTS", "SHORTS", "SKIRT", "SET", "JUMPSUIT"],
  /** Dáng. */
  silhouette: ["A_LINE", "BODYCON", "SHIFT", "FIT_FLARE", "WRAP", "OVERSIZED", "STRAIGHT", "MERMAID", "BABYDOLL"],
  /** Độ dài. */
  length: ["CROP", "HIP", "MINI", "KNEE", "MIDI", "MAXI"],
  /** Cổ. */
  neckline: ["ROUND", "V_NECK", "SQUARE", "SHIRT_COLLAR", "BOAT", "OFF_SHOULDER", "HALTER", "HIGH_NECK", "SWEETHEART", "NONE"],
  /** Tay. */
  sleeve: ["SLEEVELESS", "CAP", "SHORT", "ELBOW", "LONG", "PUFF", "BELL", "NONE"],
  /** Chất liệu. */
  material: ["COTTON", "LINEN", "SILK_SATIN", "CHIFFON", "DENIM", "KNIT", "TWEED", "LACE", "VELVET", "POLY_BLEND"],
  /** Hoạ tiết. */
  pattern: ["SOLID", "FLORAL", "STRIPE", "CHECK", "POLKA_DOT", "PRINT", "ANIMAL"],
  /** Họ màu. */
  colorFamily: ["BLACK", "WHITE_CREAM", "BEIGE_BROWN", "PINK", "RED", "BLUE", "GREEN", "YELLOW_ORANGE", "PURPLE", "GREY", "MULTI"],
  /** Chi tiết nổi bật. */
  detail: ["BOW", "RUFFLE", "PLEAT", "BUTTONS", "EMBROIDERY", "LACE_TRIM", "BELTED", "NONE"],
  /** Phong cách – dịp dùng. */
  style: ["OFFICE", "CASUAL", "PARTY", "BEACH", "ELEGANT", "STREET"],
} as const;

export type DesignDnaKey = keyof typeof DESIGN_DNA_VOCAB;
export type DesignDna = { [K in DesignDnaKey]: (typeof DESIGN_DNA_VOCAB)[K][number] };
export const DESIGN_DNA_KEYS = Object.keys(DESIGN_DNA_VOCAB) as DesignDnaKey[];

export const DESIGN_DNA_LABEL: Record<DesignDnaKey, string> = {
  category: "Nhóm hàng",
  silhouette: "Dáng",
  length: "Độ dài",
  neckline: "Cổ",
  sleeve: "Tay",
  material: "Chất liệu",
  pattern: "Hoạ tiết",
  colorFamily: "Họ màu",
  detail: "Chi tiết",
  style: "Phong cách",
};

/** Nhãn tiếng Việt THEO TỪNG KHOÁ — hai khoá dùng chung chữ `NONE` với hai nghĩa khác nhau. */
export const DESIGN_DNA_VALUE_LABEL: { [K in DesignDnaKey]: Record<DesignDna[K], string> } = {
  category: { DRESS: "Đầm / váy liền", BLOUSE: "Áo kiểu", SHIRT: "Áo sơ mi", TEE: "Áo thun", KNIT_TOP: "Áo len / dệt kim", OUTERWEAR: "Áo khoác / vest", PANTS: "Quần dài", SHORTS: "Quần short", SKIRT: "Chân váy", SET: "Set bộ", JUMPSUIT: "Jumpsuit" },
  silhouette: { A_LINE: "Chữ A", BODYCON: "Ôm body", SHIFT: "Suông", FIT_FLARE: "Chiết eo xoè", WRAP: "Vạt đắp chéo", OVERSIZED: "Rộng oversize", STRAIGHT: "Đứng", MERMAID: "Đuôi cá", BABYDOLL: "Babydoll" },
  length: { CROP: "Lửng (croptop)", HIP: "Ngang hông", MINI: "Ngắn (mini)", KNEE: "Ngang gối", MIDI: "Qua gối (midi)", MAXI: "Dài (maxi)" },
  neckline: { ROUND: "Cổ tròn", V_NECK: "Cổ V", SQUARE: "Cổ vuông", SHIRT_COLLAR: "Cổ sơ mi", BOAT: "Cổ thuyền", OFF_SHOULDER: "Trễ vai", HALTER: "Cổ yếm", HIGH_NECK: "Cổ cao", SWEETHEART: "Cổ trái tim", NONE: "Không có / không áp dụng" },
  sleeve: { SLEEVELESS: "Sát nách", CAP: "Tay con", SHORT: "Tay ngắn", ELBOW: "Tay lỡ", LONG: "Tay dài", PUFF: "Tay bồng", BELL: "Tay loe", NONE: "Không áp dụng" },
  material: { COTTON: "Cotton", LINEN: "Linen / đũi", SILK_SATIN: "Lụa / satin", CHIFFON: "Voan", DENIM: "Denim / bò", KNIT: "Len / dệt kim", TWEED: "Tweed / dạ", LACE: "Ren", VELVET: "Nhung", POLY_BLEND: "Vải tổng hợp" },
  pattern: { SOLID: "Trơn", FLORAL: "Hoa", STRIPE: "Kẻ sọc", CHECK: "Kẻ caro", POLKA_DOT: "Chấm bi", PRINT: "Hoạ tiết in", ANIMAL: "Da thú" },
  colorFamily: { BLACK: "Đen", WHITE_CREAM: "Trắng / kem", BEIGE_BROWN: "Be / nâu", PINK: "Hồng", RED: "Đỏ", BLUE: "Xanh dương", GREEN: "Xanh lá", YELLOW_ORANGE: "Vàng / cam", PURPLE: "Tím", GREY: "Xám", MULTI: "Nhiều màu" },
  detail: { BOW: "Nơ", RUFFLE: "Bèo", PLEAT: "Xếp ly", BUTTONS: "Cúc", EMBROIDERY: "Thêu", LACE_TRIM: "Viền ren", BELTED: "Thắt eo", NONE: "Không" },
  style: { OFFICE: "Công sở", CASUAL: "Dạo phố", PARTY: "Dự tiệc", BEACH: "Đi biển", ELEGANT: "Thanh lịch", STREET: "Cá tính" },
};

/**
 * Câu tiếng Anh cố định cho từng giá trị DNA — gắn TẤT ĐỊNH vào câu lệnh ảnh của ô `DESIGN` (như chỉ
 * thị gen của `writer.ts`): mô tả thiết kế mới không được giao cho trí nhớ của LLM. Chuỗi rỗng = không
 * nói gì (cổ / tay không áp dụng).
 */
export const DESIGN_DNA_PROMPT_EN: { [K in DesignDnaKey]: Record<DesignDna[K], string> } = {
  category: { DRESS: "a dress", BLOUSE: "a feminine blouse", SHIRT: "a shirt", TEE: "a T-shirt", KNIT_TOP: "a knit top", OUTERWEAR: "a jacket / blazer", PANTS: "long trousers", SHORTS: "shorts", SKIRT: "a skirt", SET: "a matching two-piece set", JUMPSUIT: "a jumpsuit" },
  silhouette: { A_LINE: "A-line silhouette", BODYCON: "bodycon fitted silhouette", SHIFT: "straight shift silhouette", FIT_FLARE: "fit-and-flare silhouette with a defined waist", WRAP: "wrap silhouette", OVERSIZED: "relaxed oversized silhouette", STRAIGHT: "straight cut", MERMAID: "mermaid silhouette", BABYDOLL: "babydoll silhouette" },
  length: { CROP: "cropped length", HIP: "hip length", MINI: "mini length", KNEE: "knee length", MIDI: "midi length", MAXI: "maxi length" },
  neckline: { ROUND: "round neckline", V_NECK: "V-neckline", SQUARE: "square neckline", SHIRT_COLLAR: "shirt collar", BOAT: "boat neckline", OFF_SHOULDER: "off-the-shoulder neckline", HALTER: "halter neckline", HIGH_NECK: "high neckline", SWEETHEART: "sweetheart neckline", NONE: "" },
  sleeve: { SLEEVELESS: "sleeveless", CAP: "cap sleeves", SHORT: "short sleeves", ELBOW: "elbow-length sleeves", LONG: "long sleeves", PUFF: "puff sleeves", BELL: "bell sleeves", NONE: "" },
  material: { COTTON: "cotton fabric", LINEN: "linen fabric", SILK_SATIN: "silk satin fabric", CHIFFON: "flowing chiffon", DENIM: "denim", KNIT: "soft knit", TWEED: "tweed", LACE: "lace fabric", VELVET: "velvet", POLY_BLEND: "smooth woven fabric" },
  pattern: { SOLID: "solid color, no print", FLORAL: "floral print", STRIPE: "stripes", CHECK: "check / plaid pattern", POLKA_DOT: "polka dots", PRINT: "abstract print", ANIMAL: "animal print" },
  colorFamily: { BLACK: "black", WHITE_CREAM: "white / cream", BEIGE_BROWN: "beige / brown", PINK: "pink", RED: "red", BLUE: "blue", GREEN: "green", YELLOW_ORANGE: "yellow / orange", PURPLE: "purple", GREY: "grey", MULTI: "multicolor" },
  detail: { BOW: "a bow detail", RUFFLE: "ruffle details", PLEAT: "pleats", BUTTONS: "a button placket", EMBROIDERY: "embroidery", LACE_TRIM: "lace trim", BELTED: "a belted waist", NONE: "clean minimal details" },
  style: { OFFICE: "office-ready style", CASUAL: "casual everyday style", PARTY: "party / evening style", BEACH: "beach vacation style", ELEGANT: "elegant refined style", STREET: "bold streetwear style" },
};

/** Nhóm hàng không có cổ / tay — cổ và tay của chúng luôn là `NONE` (không áp dụng). */
export const DNA_NO_UPPER_BODY: readonly DesignDna["category"][] = ["PANTS", "SHORTS", "SKIRT"];

/** Nhận một giá trị DNA từ nguồn không tin được. Lạ ⇒ `null`, không đoán. */
export function parseDnaValue<K extends DesignDnaKey>(key: K, raw: unknown): DesignDna[K] | null {
  const vocab = DESIGN_DNA_VOCAB[key] as readonly string[];
  return typeof raw === "string" && vocab.includes(raw) ? (raw as DesignDna[K]) : null;
}

/** DNA MỘT PHẦN — thuộc tính đọc được thì giữ, lạ thì bỏ (thành CHƯA BIẾT). */
export function parsePartialDna(raw: unknown): Partial<DesignDna> {
  const out: Partial<DesignDna> = {};
  if (!raw || typeof raw !== "object") return out;
  const rec = raw as Record<string, unknown>;
  for (const k of DESIGN_DNA_KEYS) {
    const v = parseDnaValue(k, rec[k]);
    if (v !== null) (out as Record<string, string>)[k] = v;
  }
  return out;
}

/** DNA ĐỦ mười thuộc tính, hoặc `null`. Thiết kế mới luôn phải đủ. */
export function parseDna(raw: unknown): DesignDna | null {
  const p = parsePartialDna(raw);
  return DESIGN_DNA_KEYS.every((k) => k in p) ? (p as DesignDna) : null;
}

/**
 * Số thuộc tính mà `a` KHÁC `b`. Thuộc tính CHƯA BIẾT ở một bên KHÔNG được tính là khác: không biết mã
 * cũ cổ gì thì không được khẳng định mẫu mới khác nó ở cổ — mới lạ phải CHỨNG MINH được, không suy từ
 * chỗ trống (mục 42).
 */
export function dnaDifference(a: Partial<DesignDna>, b: Partial<DesignDna>): number {
  let n = 0;
  for (const k of DESIGN_DNA_KEYS) if (a[k] !== undefined && b[k] !== undefined && a[k] !== b[k]) n += 1;
  return n;
}

/** Chữ ký để chống trùng hai thiết kế trong cùng một lượt lập. */
export function dnaSignature(dna: DesignDna): string {
  return DESIGN_DNA_KEYS.map((k) => dna[k]).join("|");
}

/**
 * LUẬT MỚI LẠ (chủ shop 24/09/2026: "mẫu mới PHẢI KHÁC các mẫu cũ, không phải ảnh chụp khác của mẫu
 * cũ"): DNA của một thiết kế phải khác DNA của MỌI mã đang có và MỌI thiết kế trong
 * `recentDesignDays` ngày gần nhất ở ÍT NHẤT `minDiffAttributes` thuộc tính.
 */
export const DESIGN_NOVELTY = { minDiffAttributes: 2, recentDesignDays: 30 } as const;

/**
 * Chọn MÃ CHA cho thiết kế — ĐỀ XUẤT của người dựng (chủ shop chưa chốt con số; sửa ở đây là một lần
 * sửa mã có người đọc):
 *  · `lookbackDays` — cửa sổ đo "bán tốt": đơn giao thành công (theo `ORDER_OUTCOME`) và chi / tin nhắn
 *    của các mẩu QC hạt `AD` của mã trong bấy nhiêu ngày.
 *  · Mã đủ điều kiện làm cha khi có ít nhất `minDelivered` đơn giao thành công, HOẶC chi / tin nhắn dưới
 *    `OWN_AD_IMPORT.goodCostPerMessageBelowVnd` trên ít nhất `OWN_AD_IMPORT.minMessages` tin (mẫu quảng
 *    cáo lịch sử có chỉ số tốt — chủ shop 24/09) — và PHẢI có DNA đọc được.
 *  · `mutationRate` — xác suất mỗi thuộc tính (trừ nhóm hàng) bị ĐỘT BIẾN thay vì lấy của cha / mẹ.
 */
export const DESIGN_PARENT_RULES = { lookbackDays: 90, minDelivered: 3, mutationRate: 0.25 } as const;

/** Điểm "bán tốt" của một mã — trọng số khi chọn cha mẹ. Hàm thuần. `null` = không đủ điều kiện làm cha. */
export function designParentScore(m: { delivered: number; returned: number; spendVnd: number | null; messages: number | null }): number | null {
  const cpmOk = m.spendVnd !== null && m.messages !== null && m.messages >= OWN_AD_IMPORT.minMessages && m.spendVnd / m.messages < OWN_AD_IMPORT.goodCostPerMessageBelowVnd;
  if (m.delivered < DESIGN_PARENT_RULES.minDelivered && !cpmOk) return null;
  // Đơn giao thành công × tỷ lệ giao (đơn hoàn kéo điểm xuống); mã chỉ có chỉ số QC tốt mà chưa có đơn
  // giao vẫn được trọng số tối thiểu 1 — đủ để được chọn, không đủ để lấn mã đã bán được thật.
  const settled = m.delivered + m.returned;
  const score = settled > 0 ? (m.delivered * m.delivered) / settled : 0;
  return Math.max(1, Math.round(score * 100) / 100);
}

/** Trạng thái một thiết kế. `PRODUCTION` chỉ NGƯỜI đặt (đưa vào sản xuất); máy không bao giờ chạm. */
export const DESIGN_STATUSES = ["DRAFT", "TESTING", "WIN", "LOSE", "PRODUCTION"] as const;
export type DesignStatus = (typeof DESIGN_STATUSES)[number];
export const DESIGN_STATUS_LABEL: Record<DesignStatus, string> = { DRAFT: "Chờ test", TESTING: "Đang test", WIN: "THẮNG", LOSE: "Loại", PRODUCTION: "Đưa vào sản xuất" };

/**
 * Mã thiết kế `TK-YYMMDD-NN` — YYMMDD là NGÀY CHẠY của lô, NN là thứ tự trong lô. Chủ shop tạo sản phẩm
 * trên Pancake ĐÚNG mã này để nhân viên chốt đơn được như hàng thường.
 */
export function designCode(batchDay: string, n: number): string {
  return `TK-${batchDay.slice(2, 4)}${batchDay.slice(5, 7)}${batchDay.slice(8, 10)}-${String(n).padStart(2, "0")}`;
}

export const DESIGN_CODE_RE = /^TK-[0-9]{6}-[0-9]{2,}$/;

// ───────────────────────────── MOQ — THIẾT KẾ ĐỦ ĐƠN ⇒ NHÁP LỆNH SẢN XUẤT (§5h) ─────────────────────────────

/**
 * Chủ shop chốt 24/09/2026: thiết kế mới gom đủ **50 ĐƠN** thì máy dựng NHÁP lệnh sản xuất. Đếm ĐƠN (không
 * đếm sản phẩm) — một khách mua 3 cái vẫn là một đơn; số lượng sản phẩm đi vào `total_qty` của nháp.
 * Đơn = đơn ĐÃ XÁC NHẬN (`CONFIRMED_ORDER`, không huỷ theo `ORDER_OUTCOME`) — cùng định nghĩa "đơn chốt" của
 * vòng mẫu. KHÔNG phải đơn giao thành công: hàng chưa sản xuất thì chưa giao được.
 * Chỉ sửa ở đây, và chỉ khi chủ shop đổi (AGENTS.md mục 7).
 */
export const DESIGN_MOQ = { minOrders: 50 } as const;

/** Đủ MOQ chưa — hàm thuần, ranh giới `>=` (50 đơn là đủ, 49 thì chưa). */
export function designMoqReached(orders: number, minOrders: number = DESIGN_MOQ.minOrders): boolean {
  return Number.isFinite(orders) && orders >= minOrders;
}

/**
 * Căn cứ lúc máy dựng / nối lệnh, lưu ở `design_concepts.moq_snapshot`. Hai đường đếm khai RIÊNG:
 *  · `viaCode` — đơn có dòng hàng (không phải quà) là sản phẩm Pancake mã = mã TK;
 *  · `viaAd`   — đơn mang `orders.ad_id` của một mẩu QC mang thiết kế;
 *  · `orders`  — HỢP hai tập theo id đơn (đơn thấy ở cả hai đường tính MỘT lần — `both`);
 *  · `adOnly`  — đơn chỉ thấy qua quảng cáo, không có dòng mã TK ⇒ số lượng CHƯA BIẾT, không cộng vào tổng.
 */
export type DesignMoqSnapshot = {
  minOrders: number;
  orders: number;
  viaCode: number;
  viaAd: number;
  /**
   * Căn cứ của `viaAd`: số đơn mang `ad_id` Pancake gửi · số đơn nối qua bài viết của ĐÚNG MỘT mẩu
   * (`ORDER_AD_ID`, từ B2 26/09/2026). `null` = ảnh chụp dựng TRƯỚC B2 — khi ấy `viaAd` chỉ đếm `ad_id`
   * và chưa tách, KHÔNG phải "0 đơn qua bài viết".
   */
  viaAdDirect: number | null;
  viaAdPost: number | null;
  both: number;
  adOnly: number;
  /** Tổng số lượng các dòng mã TK (bỏ quà) — `total_qty` của nháp. */
  qtyKnown: number;
  /** Phần của `qtyKnown` chưa rõ màu hoặc size — không chia vào ma trận, không đoán. */
  qtyNoVariant: number;
  /** Có sản phẩm Pancake mang đúng mã TK hay không. */
  pancakeProduct: boolean;
  /** `true` = nối vào lệnh NGƯỜI đã lập sẵn cho mã này, máy không dựng nháp. */
  linkedExisting: boolean;
  countedAt: string;
};

/** Đọc `moq_snapshot` (JSON không tin được). Hỏng / rỗng ⇒ `null`. */
export function parseDesignMoqSnapshot(raw: unknown): DesignMoqSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : null);
  const orders = n(r.orders);
  if (orders === null) return null;
  return {
    minOrders: n(r.minOrders) ?? DESIGN_MOQ.minOrders,
    orders,
    viaCode: n(r.viaCode) ?? 0,
    viaAd: n(r.viaAd) ?? 0,
    viaAdDirect: n(r.viaAdDirect),
    viaAdPost: n(r.viaAdPost),
    both: n(r.both) ?? 0,
    adOnly: n(r.adOnly) ?? 0,
    qtyKnown: n(r.qtyKnown) ?? 0,
    qtyNoVariant: n(r.qtyNoVariant) ?? 0,
    pancakeProduct: r.pancakeProduct === true,
    linkedExisting: r.linkedExisting === true,
    countedAt: typeof r.countedAt === "string" ? r.countedAt : "",
  };
}

// ───────────────────────────── ĐỌC DNA CỦA SẢN PHẨM ĐANG CÓ ─────────────────────────────

/** Route ghi sổ `ai_interactions` của lượt đọc DNA. */
export const PRODUCT_DNA_ROUTE = "creative.dna";
/** Một lượt dựng lô đọc DNA tối đa bấy nhiêu mã (mỗi mã một lời gọi mô hình đọc ảnh). */
export const PRODUCT_DNA_PER_BUILD = 5;
/** Đọc hỏng thì bấy nhiêu giờ sau mới thử lại mã ấy — không đốt tiền AI mỗi mười phút cho một ảnh hỏng. */
export const PRODUCT_DNA_RETRY_HOURS = 24;

// ───────────────────────────── LUẬT RIÊNG THEO MÃ CHO Ô MOCKUP (chủ shop 24/09/2026) ─────────────────────────────

/**
 * Ô MOCKUP của MÃ CŨ không chấm bằng luật chung: mã bán giá 199K và mã 599K có "chi / tin nhắn" tự nhiên
 * khác nhau cả lần. Chủ shop 24/09/2026:
 *  · lịch sử = `lookbackDays` ngày các mẩu QC (hạt `AD`) của CHÍNH mã ấy, mẩu có tin nhắn;
 *  · TẮT khi chi / tin nhắn TỆ HƠN phân vị `killQuantile` (p75) của lịch sử mã, sau khi đã chi `killMinSpendVnd`;
 *  · GIỮ khi chi / tin nhắn ≤ trung vị (`keepQuantile`) của mã;
 *  · mã có dưới `minSamples` mẩu lịch sử có tin nhắn ⇒ dùng LUẬT CHUNG của lô (không đủ căn cứ cho luật riêng).
 */
export const MOCKUP_RULES = { lookbackDays: 60, killQuantile: 0.75, keepQuantile: 0.5, killMinSpendVnd: 50_000, minSamples: 5 } as const;

/**
 * Ảnh chụp luật của MỘT ô, lưu ở `creative_variants.rules_snapshot` lúc lập lô và khoá trong phiếu duyệt.
 *  · `PRODUCT_HISTORY` — luật riêng suy từ lịch sử của mã (hai bộ luật THAY luật chung của lô).
 *  · `GLOBAL`          — ô mockup mà mã chưa đủ lịch sử ⇒ dùng luật chung; vẫn chụp để người duyệt thấy vì sao.
 */
export type VariantRulesSnapshot =
  | { basis: "PRODUCT_HISTORY"; productId: string; lookbackDays: number; samples: number; p75CostPerMessageVnd: number; medianCostPerMessageVnd: number; killRules: CreativeRule[]; keepRules: CreativeRule[] }
  | { basis: "GLOBAL"; productId: string; lookbackDays: number; samples: number; reason: string };

/** Phân vị nội suy tuyến tính (kiểu 7, như `percentile_cont`). Mảng rỗng ⇒ `null`. */
export function quantile(xs: readonly number[], q: number): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

/**
 * Luật riêng của một mã từ chi / tin nhắn của các mẩu lịch sử — hàm THUẦN. `samples` = chi / tin nhắn của
 * TỪNG mẩu (chỉ mẩu có tin nhắn: mẫu số 0 là CHƯA BIẾT, không phải vô cực — không vào mẫu).
 */
export function mockupRulesFromHistory(productId: string, samples: readonly number[]): VariantRulesSnapshot {
  const R = MOCKUP_RULES;
  const clean = samples.filter((x) => Number.isFinite(x) && x > 0);
  if (clean.length < R.minSamples) {
    return { basis: "GLOBAL", productId, lookbackDays: R.lookbackDays, samples: clean.length, reason: `Mã chỉ có ${clean.length} mẩu QC có tin nhắn trong ${R.lookbackDays} ngày (cần ${R.minSamples}) — dùng luật chung của lô.` };
  }
  const p75 = Math.round(quantile(clean, R.killQuantile) as number);
  const med = Math.round(quantile(clean, R.keepQuantile) as number);
  const vnd = (n: number) => `${n.toLocaleString("vi-VN")}đ`;
  return {
    basis: "PRODUCT_HISTORY",
    productId,
    lookbackDays: R.lookbackDays,
    samples: clean.length,
    p75CostPerMessageVnd: p75,
    medianCostPerMessageVnd: med,
    killRules: [{ metric: "costPerMessage", op: "gt", value: p75, minSpendVnd: R.killMinSpendVnd, label: `Chi/tin nhắn tệ hơn p75 lịch sử của mã (${vnd(p75)})` }],
    keepRules: [{ metric: "costPerMessage", op: "lte", value: med, minSpendVnd: 0, label: `Chi/tin nhắn ≤ trung vị lịch sử của mã (${vnd(med)})` }],
  };
}

/** Đọc `rules_snapshot` (JSON không tin được). Hỏng / rỗng ⇒ `null` (ô không có luật riêng). */
export function parseVariantRules(raw: unknown): VariantRulesSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : null);
  const productId = typeof r.productId === "string" ? r.productId : "";
  const lookbackDays = n(r.lookbackDays) ?? MOCKUP_RULES.lookbackDays;
  const samples = n(r.samples) ?? 0;
  if (r.basis === "GLOBAL") return { basis: "GLOBAL", productId, lookbackDays, samples, reason: typeof r.reason === "string" ? r.reason : "" };
  if (r.basis !== "PRODUCT_HISTORY") return null;
  const rules = (x: unknown) => (Array.isArray(x) ? x.map(parseRule).filter((y): y is CreativeRule => y !== null) : []);
  const killRules = rules(r.killRules);
  const keepRules = rules(r.keepRules);
  const p75 = n(r.p75CostPerMessageVnd);
  const med = n(r.medianCostPerMessageVnd);
  // Luật riêng hỏng KHÔNG rơi về "không luật" (mẫu chạy hết tiền) mà về luật chung của lô: nơi gọi nhận `null`.
  if (killRules.length === 0 || keepRules.length === 0 || p75 === null || med === null) return null;
  return { basis: "PRODUCT_HISTORY", productId, lookbackDays, samples, p75CostPerMessageVnd: p75, medianCostPerMessageVnd: med, killRules, keepRules };
}

/**
 * Bộ luật dùng cho MỘT ô: luật riêng của ô nếu có (`PRODUCT_HISTORY`), không thì luật chung của lô.
 * Hàm THUẦN — lượt chấm, màn hình và đường TẮT (`pauseCreativeVariant`) đều đi qua đây.
 */
export function variantRuleSet(rulesSnapshotRaw: unknown, batch: { killRules: CreativeRule[]; keepRules: CreativeRule[] }): { killRules: CreativeRule[]; keepRules: CreativeRule[]; own: boolean } {
  const r = parseVariantRules(rulesSnapshotRaw);
  return r && r.basis === "PRODUCT_HISTORY" ? { killRules: r.killRules, keepRules: r.keepRules, own: true } : { killRules: batch.killRules, keepRules: batch.keepRules, own: false };
}

// ───────────────────────────── ĐẶT TÊN CHIẾN DỊCH · NHÓM · QUẢNG CÁO (chủ shop 25/09/2026, §5i) ─────────────────────────────

/**
 * Khuôn tên MẶC ĐỊNH (người sửa được từng tên trước khi duyệt — tên nằm trong phiếu duyệt):
 *  · Chiến dịch: `<Tên TKQC>_<dd/MM ngày đăng>_TEST_<tên fanpage>_<số thứ tự>`
 *  · Nhóm QC:    `<Mục tiêu tối ưu>_<vị trí địa lý>_<độ tuổi>_<giới tính>_<autobid|bidcap|costcap>` — đọc từ
 *                CÀI ĐẶT THẬT của nhóm QC mẫu trên Ads Manager (đường đọc `readTemplateAd`).
 *  · Quảng cáo:  `<tên fanpage>_<ảnh|video>_<số thứ tự>_TXT`
 *
 * Bảng quy đổi mã Facebook → nhãn ngắn ở dưới. MÃ LẠ ⇒ in NGUYÊN mã (không đoán); thiếu hẳn ⇒ `?` và nói ra.
 */
export const NAMING_TEMPLATE_KEY = "creative.naming.template";

/** Nhãn ngắn của `optimization_goal`. Không có ở đây ⇒ in nguyên mã. */
export const OPTIMIZATION_GOAL_LABEL: Readonly<Record<string, string>> = {
  CONVERSATIONS: "MESS",
  MESSAGING_PURCHASE_CONVERSION: "MESSMUA",
  MESSAGING_APPOINTMENT_CONVERSION: "MESSHEN",
  OFFSITE_CONVERSIONS: "CONV",
  LINK_CLICKS: "CLICK",
  LANDING_PAGE_VIEWS: "LPV",
  LEAD_GENERATION: "LEAD",
  QUALITY_LEAD: "LEAD",
  REACH: "REACH",
  IMPRESSIONS: "IMPR",
  POST_ENGAGEMENT: "ENG",
  THRUPLAY: "VIEW",
  VALUE: "VALUE",
};

/** Nhãn của `bid_strategy`. Ba mã chủ shop nêu; mã khác in nguyên. */
export const BID_STRATEGY_LABEL: Readonly<Record<string, string>> = {
  LOWEST_COST_WITHOUT_CAP: "autobid",
  LOWEST_COST_WITH_BID_CAP: "bidcap",
  COST_CAP: "costcap",
};

/** `targeting.genders`: 1 = nam, 2 = nữ; vắng / rỗng / cả hai = mọi giới tính. */
export const GENDER_LABEL: Readonly<Record<string, string>> = { "1": "Nam", "2": "Nữ", ALL: "All" };

/** Facebook trả `age_max = 65` cho "65 trở lên". */
export const AGE_MAX_OPEN = 65;

/** Loại media của quảng cáo — hiện vòng mẫu chỉ chạy ảnh, nhưng hàm đặt tên nhận cả video. */
export type CreativeMediaKind = "IMAGE" | "VIDEO";
export const MEDIA_NAME_LABEL: Record<CreativeMediaKind, string> = { IMAGE: "ảnh", VIDEO: "video" };

/** Trần độ dài MỘT tên (ký tự) — trần của lược đồ đầu vào và của cột. */
export const CAMPAIGN_NAME_MAX_CHARS = 255;

// ───────────────────────────── GEN ẢNH BẰNG TAY (chủ shop 25/09/2026, §5i) ─────────────────────────────

/**
 * `imagesPerRun` — số ảnh CHỌN SẴN của mỗi lần bấm (chủ shop chốt: 10); người đổi được trong khoảng
 * `MANUAL_GEN_RUN.minImagesPerRun…maxImagesPerRun` (chủ shop 26/09/2026). KHÔNG còn tính vào trần ảnh / ngày
 * của lô hằng ngày — xem `MANUAL_GEN_RUN`.
 * `drawPerTick` — lượt vòng mẫu vẽ nốt tối đa bấy nhiêu ảnh (lượt `after()` của nút bấm vẽ trước).
 * `staleDrawMinutes` — ảnh "đang vẽ" quá bấy nhiêu phút ⇒ tiến trình đã chết giữa chừng ⇒ KHÔNG vẽ lại
 * (OpenAI có thể đã tính tiền) mà đánh lỗi có lý do.
 * `ideaMaxChars` — ô ý tưởng tự do.
 */
export const MANUAL_GEN = { imagesPerRun: 10, drawPerTick: 4, staleDrawMinutes: 15, ideaMaxChars: 1000 } as const;

/**
 * Gen tay KHÔNG CÒN TRẦN ẢNH / NGÀY (chủ shop 26/09/2026: "gỡ giới hạn trong phần gen ảnh, thêm tính tiền trên
 * mỗi lượt gen và mỗi ảnh"). Thay cho trần là hai thứ người bấm thấy TRƯỚC khi bấm: số ảnh do chính họ chọn
 * (`minImagesPerRun`…`maxImagesPerRun`) và tiền ước tính của lượt ấy; sau khi vẽ là tiền THẬT từng ảnh và cả lượt.
 * Trần ngày của LÔ hằng ngày (`maxImagesPerDay` / `maxImageUsdPerDay`) vẫn giữ và chỉ đếm ảnh CỦA LÔ — gen tay
 * không ăn vào chỗ của lô, nếu không một buổi gen tay nhiều làm lô ngày mai thiếu ảnh.
 *
 * `maxImagesPerRun` là TRẦN CỦA MỘT LẦN BẤM, không phải trần ngày: chặn một lần gõ nhầm 200 thành một hoá đơn,
 * không chặn người bấm tiếp. `maxUploads`: ảnh đầu vào người tải lên ngay trong khối gen tay (đã thu nhỏ ở trình
 * duyệt — 4 × 1,4 MB base64 vẫn dưới trần 8 MB của server action).
 */
export const MANUAL_GEN_RUN = { minImagesPerRun: 1, maxImagesPerRun: 20, maxUploads: 4 } as const;

/** Tiền USD quy ra đồng — hàm THUẦN. `null` (CHƯA BIẾT) giữ nguyên `null`, không thành 0 (mục 42). */
export function usdToVndRounded(usd: number | null, rate: number): number | null {
  return usd === null || !Number.isFinite(usd) || !Number.isFinite(rate) || rate <= 0 ? null : Math.round(usd * rate);
}

/**
 * ĐĂNG CAMP LẺ — "bấm Đăng camp là camp lên ngay, hoặc hẹn giờ chạy" (chủ shop 26/09/2026).
 *
 * Mỗi lần bấm là MỘT lô riêng loại `INSTANT` chỉ chứa đúng một bài (`creative_batches.kind`, migration 0145):
 * cùng phiếu duyệt / digest, cùng cổng ghi, cùng bốn lớp chặn tiêu quá (ngân sách trọn đời · `end_time` ·
 * trần cam kết / ngày · công tắc khẩn) với lô hằng ngày — chỉ khác là người bấm CHÍNH LÀ lượt duyệt, và
 * khung giờ do người chọn thay vì 6:00 hôm sau.
 *
 *  · `leadSeconds` — "chạy ngay" = `start_time` sau lúc bấm từng này giây: đủ cho sáu lời gọi Facebook đi
 *    xong TRƯỚC giờ chạy (cổng chặn mọi lời gọi tạo sau `start_at`), đủ ngắn để người đọc là "ngay".
 *  · `minScheduleLeadMinutes` / `maxScheduleDays` — hẹn giờ phải sau lúc bấm ít nhất từng ấy phút và không
 *    quá từng ấy ngày. Hẹn giờ vẫn ĐĂNG LÊN FACEBOOK NGAY lúc bấm với `start_time` = giờ hẹn: Facebook tự giữ
 *    lịch, nên ERP có chết lúc tới giờ thì camp vẫn chạy đúng giờ và vẫn tự dừng ở `end_time`.
 */
export const INSTANT_PUBLISH = { leadSeconds: 120, minScheduleLeadMinutes: 5, maxScheduleDays: 30 } as const;

/** Loại lô: `LOOP` = lô hằng ngày (một lô một ngày chạy) · `INSTANT` = một bài người bấm "Đăng camp". */
export const CREATIVE_BATCH_KINDS = ["LOOP", "INSTANT"] as const;
export type CreativeBatchKind = (typeof CREATIVE_BATCH_KINDS)[number];

/**
 * LỌC THEO NGÀY ở tab "Duyệt mẫu" (chủ shop 26/09/2026: "chỉ hiển thị kết quả ngày hôm nay, các ngày trước tạm ẩn,
 * lọc ngày nào hiển thị kết quả ngày đó"). Tham số URL `?ngay=YYYY-MM-DD` (giờ Việt Nam); vắng / hỏng ⇒ HÔM NAY.
 * Lọc áp cho "Kết quả gen tay" (ngày TẠO lượt) và "Lịch sử lô" (NGÀY CHẠY của lô). Lô chờ duyệt và "Mẫu tự làm"
 * là việc phải làm, không phải kết quả — luôn hiện. `stripDays`: dải các ngày gần nhất CÓ kết quả, mới → cũ.
 */
export const REVIEW_DAY = { param: "ngay", stripDays: 14 } as const;

/** `?ngay=` ⇒ ngày hợp lệ `YYYY-MM-DD` (có thật trên lịch), không thì `today`. Hàm THUẦN. */
export function parseReviewDay(raw: string | null | undefined, today: string): string {
  const s = (raw ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return today;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s ? s : today;
}

/**
 * Kiểu một lượt gen tay (migration 0143). `DESIGN` là mặc định của khối gen tay (chủ shop 25/09/2026: "gen
 * các mẫu MỚI HOÀN TOÀN từ các mẫu đã win / có chỉ số tốt, không phải mockup mới cho mẫu cũ"); `MOCKUP` còn
 * lại cho đề xuất đẩy tồn — xả hàng đang có cần ảnh mới của CHÍNH mẫu ấy.
 */
export const MANUAL_GEN_KINDS = ["DESIGN", "MOCKUP"] as const;
export type ManualGenKind = (typeof MANUAL_GEN_KINDS)[number];
export const MANUAL_GEN_KIND_LABEL: Record<ManualGenKind, string> = { DESIGN: "Thiết kế mới", MOCKUP: "Ảnh mới cho mẫu đang có" };

/**
 * Gen tay kiểu THIẾT KẾ MỚI:
 *  · `maxInspirations` — số mã cảm hứng tối đa một lượt (nhiều hơn thì mỗi thiết kế vẫn chỉ lai hai mã, phần
 *    còn lại chỉ làm loãng phép chọn có trọng số).
 *  · `preselect` — số mã điểm cao nhất được TÍCH SẴN khi mở khối (chỉ là giá trị khởi đầu của ô chọn).
 *  · `refPhotos` — số ảnh sản phẩm thật (của mã cha) gửi máy vẽ cho MỘT thiết kế: cha trội + mẹ.
 *  · `codeBase` — mã `TK-YYMMDD-NN` của thiết kế NGƯỜI đưa vào lô bắt đầu từ `codeBase + 1` (101…), tách khỏi
 *    dải 01…(`maxBatchSize` + 10) của ô thiết kế máy lập: lô dựng SAU cú bấm vẫn cấp 01 cho ô của nó, và
 *    trùng mã thì ô của máy bị bỏ (`insertComposed` không ghi đè thiết kế đã có).
 */
export const MANUAL_DESIGN = { maxInspirations: 6, preselect: 3, refPhotos: 2, codeBase: 100 } as const;

/**
 * Vòng đời một ảnh gen tay:
 * `PLANNED` (chờ vẽ) → `DRAWING` (đang vẽ) → `GENERATED` (chờ người duyệt ảnh) → `APPROVED` (đã duyệt,
 * máy viết câu chữ) → `PROMOTED` (đã vào lô chờ duyệt đăng). `REJECTED` = người loại; `GEN_FAILED` = vẽ
 * hỏng / vượt trần (lý do ở `error`).
 */
export const MANUAL_GEN_IMAGE_STATUSES = ["PLANNED", "DRAWING", "GENERATED", "GEN_FAILED", "APPROVED", "REJECTED", "PROMOTED"] as const;
export type ManualGenImageStatus = (typeof MANUAL_GEN_IMAGE_STATUSES)[number];
export const MANUAL_GEN_IMAGE_STATUS_LABEL: Record<ManualGenImageStatus, string> = {
  PLANNED: "Chờ vẽ",
  DRAWING: "Đang vẽ",
  GENERATED: "Chờ duyệt ảnh",
  GEN_FAILED: "Vẽ lỗi",
  APPROVED: "Đã duyệt — soạn bài",
  REJECTED: "Đã loại",
  PROMOTED: "Đã vào lô / đã đăng",
};
