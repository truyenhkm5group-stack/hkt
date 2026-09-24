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
 * `EXPLOIT` · `EXPLORE` — ô do máy lập (`planBatch`).
 * `MANUAL`  — mẫu NGƯỜI tự làm (vd vẽ trên web ChatGPT/Grok) rồi tải vào lô: không qua máy viết và máy
 *             sinh ảnh, nhưng đi qua ĐÚNG cổng duyệt · đăng · chấm · học như mẫu máy làm.
 */
export type SlotMode = "EXPLOIT" | "EXPLORE" | "MANUAL";

export const SLOT_MODE_LABEL: Record<SlotMode, string> = { EXPLOIT: "Khai thác", EXPLORE: "Thăm dò", MANUAL: "Tự làm" };

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
 * Ba con số đầu là quyết định của chủ shop ngày 24/09/2026 (10 mẫu × 200.000đ × 1 ngày, chạy lúc
 * 6:00). Nâng chúng là một lần sửa mã có người đọc — không phải một dòng JSON ai đó gõ lúc nửa đêm.
 */
export const CREATIVE_HARD_LIMITS = {
  /** Số mẫu tối đa được ĐĂNG trong một lô. */
  maxBatchSize: 10,
  /** Ngân sách trọn đời tối đa của MỘT mẫu trong khung test. */
  maxBudgetPerVariantVnd: 200_000,
  /** Khung test tối đa (ngày). */
  maxTestDays: 1,
  /**
   * Tổng ngân sách test được CAM KẾT cho một ngày chạy. = 10 × 200.000đ. Đếm trên sổ
   * `creative_fb_actions` (lượt tạo nhóm ĐÃ ÁP), không đếm trên cấu hình — cấu hình có thể đổi
   * giữa hai lượt đăng, sổ thì không.
   */
  maxDailyTestSpendVnd: 2_000_000,
  /**
   * Một lượt "cho tiêu thêm" (người bấm trên mẫu HỨA HẸN) được cộng tối đa bấy nhiêu.
   * Chủ shop chốt 24/09/2026: 200.000đ — đúng bằng MỘT ngày test nữa của một mẫu.
   */
  maxExtensionPerClickVnd: 200_000,
  /** Tổng tiền "tiêu thêm" được bấm trong một ngày, toàn shop. Chủ shop chốt 24/09/2026: 1.000.000đ (≤ 5 lượt). */
  maxDailyExtensionVnd: 1_000_000,
  /** Số ảnh sinh tối đa trong một ngày — kể cả ảnh sinh lại. Chặn một vòng lặp hỏng đốt credit. */
  maxImagesPerDay: 30,
  /**
   * Trần chi sinh ảnh / ngày (USD). Chủ shop chốt 24/09/2026: 2 USD — một lô 13 ảnh chất lượng vừa
   * tốn ~0,55 USD, phần còn lại cho sinh lại. Cấu hình chỉ hạ được.
   */
  maxImageUsdPerDay: 2,
} as const;

// ───────────────────────────── CẤU HÌNH (settings `creative.config`) ─────────────────────────────

export const CREATIVE_CONFIG_KEY = "creative.config";

export type ImageSize = "1024x1024" | "1024x1536";
export type ImageQuality = "low" | "medium" | "high";

export type CreativeLoopConfig = {
  /** Công tắc mềm. Job vẫn cần `CREATIVE_LOOP_EVERY_MINUTES` ở env mới có trong lịch. */
  enabled: boolean;
  /** Fanpage đứng tên bài quảng cáo (id Facebook). */
  pageId: string;
  /** Tài khoản quảng cáo, dạng số không kèm `act_`. */
  adAccountId: string;
  /**
   * Chiến dịch TEST do NGƯỜI dựng sẵn trên Ads Manager. Máy chỉ tạo nhóm + mẩu BÊN TRONG chiến dịch
   * này, và cổng từ chối mọi lượt ghi nhắm vào chiến dịch khác. Máy KHÔNG tạo chiến dịch.
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
  /** Sinh dư bấy nhiêu mẫu để người duyệt gạt bớt mà lô vẫn đủ. */
  extraCandidates: number;
  /** Tỷ lệ ô THĂM DÒ (gen mới / nguồn mới). Phần còn lại KHAI THÁC (biến thể của mẫu tốt). */
  exploreShare: number;
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
  imageDailyCapUsd: number;
  /** Ảnh của mẫu bị LOẠI được giữ bấy nhiêu ngày cho người xem lại, rồi xoá điểm ảnh (giữ gen + số đo). */
  loserImageRetentionDays: number;
};

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
  extraCandidates: 3,
  exploreShare: 0.4,
  winOrdersAbove: 100,
  verdictSettleHours: 24,
  killRules: [],
  keepRules: [],
  focusProductIds: [],
  imageModel: "gpt-image-1",
  imageSize: "1024x1024",
  imageQuality: "medium",
  imageDailyCapUsd: 2,
  loserImageRetentionDays: 7,
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
    exploreShare: num(r.exploreShare, d.exploreShare, 0, 1),
    winOrdersAbove: Math.round(num(r.winOrdersAbove, d.winOrdersAbove, 1, 100_000)),
    verdictSettleHours: Math.round(num(r.verdictSettleHours, d.verdictSettleHours, 0, 14 * 24)),
    killRules: rules("killRules"),
    keepRules: rules("keepRules"),
    focusProductIds: Array.isArray(r.focusProductIds) ? (r.focusProductIds as unknown[]).map(str).filter(Boolean) : [],
    imageModel: str(r.imageModel) || d.imageModel,
    imageSize: r.imageSize === "1024x1536" ? "1024x1536" : "1024x1024",
    imageQuality: r.imageQuality === "low" || r.imageQuality === "high" ? r.imageQuality : "medium",
    imageDailyCapUsd: num(r.imageDailyCapUsd, d.imageDailyCapUsd, 0, L.maxImageUsdPerDay),
    loserImageRetentionDays: Math.round(num(r.loserImageRetentionDays, d.loserImageRetentionDays, 0, 90)),
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
 * Cố ý KHÔNG có: tạo / sửa / tắt CHIẾN DỊCH · sửa đối tượng · đụng mẩu QC không do vòng này tạo.
 */
export const CREATIVE_WRITE_ACTIONS = ["UPLOAD_IMAGE", "CREATE_CREATIVE", "CREATE_ADSET", "CREATE_AD", "PAUSE_ADSET", "EXTEND_ADSET"] as const;
export type CreativeWriteAction = (typeof CREATIVE_WRITE_ACTIONS)[number];

export const CREATIVE_WRITE_ACTION_LABEL: Record<CreativeWriteAction, string> = {
  UPLOAD_IMAGE: "Tải ảnh lên tài khoản QC",
  CREATE_CREATIVE: "Tạo bài quảng cáo (bài ẩn trên fanpage)",
  CREATE_ADSET: "Tạo nhóm quảng cáo test",
  CREATE_AD: "Tạo mẩu quảng cáo",
  PAUSE_ADSET: "Tắt sớm",
  EXTEND_ADSET: "Cho tiêu thêm",
};

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
  | "NO_KILL_RULE";

export const CREATIVE_WRITE_DENIAL_REASON: Record<CreativeWriteDenial, string> = {
  HARD_DISABLED: "Đường ghi quảng cáo đang TẮT ở cấp máy chủ (ADS_WRITE_ENABLED).",
  MODE_OFF: "Nấc quyền hạn đang OFF.",
  CONFIG_INCOMPLETE: "Cấu hình vòng mẫu còn thiếu (fanpage / tài khoản / chiến dịch test / mẩu mẫu).",
  NOT_APPROVED: "Lô chưa được người duyệt. Nấc COPILOT: không có phiếu duyệt thì không ghi.",
  APPROVAL_MISMATCH: "Nội dung mẫu đã đổi SAU khi duyệt (ảnh, câu chữ, ngân sách hoặc khung giờ). Phiếu duyệt khoá đúng thứ người đã xem.",
  WRONG_CAMPAIGN: "Lượt ghi nhắm vào một chiến dịch KHÁC chiến dịch test đã khai. Máy chỉ được làm việc bên trong chiến dịch test.",
  NOT_OUR_AD: "Nhóm/mẩu này không do vòng mẫu tạo. Máy không được đụng vào quảng cáo của người.",
  OVER_VARIANT_BUDGET: `Ngân sách một mẫu vượt trần ${CREATIVE_HARD_LIMITS.maxBudgetPerVariantVnd.toLocaleString("vi-VN")}đ.`,
  OVER_DAILY_CAP: `Tổng ngân sách test đã cam kết cho ngày chạy sẽ vượt trần ${CREATIVE_HARD_LIMITS.maxDailyTestSpendVnd.toLocaleString("vi-VN")}đ.`,
  OVER_BATCH_SIZE: `Lô đã có ${CREATIVE_HARD_LIMITS.maxBatchSize} mẫu được đăng.`,
  TOO_LATE: "Đã qua giờ bắt đầu chạy của lô. Đăng muộn là chạy một khung giờ khác với khung đã duyệt.",
  OVER_EXTENSION_CAP: "Vượt trần tiền 'tiêu thêm' (một lượt bấm hoặc cả ngày).",
  NOT_PROMISING: "Mẫu không ở trạng thái HỨA HẸN theo luật giữ — không có căn cứ để tiêu thêm.",
  NO_KILL_RULE: "Không luật tắt nào kích hoạt cho mẫu này.",
};

// ───────────────────────────── GIÁ SINH ẢNH ─────────────────────────────

/**
 * Giá ƯỚC TÍNH một ảnh (USD) theo chất lượng × khổ, theo bảng giá công bố của OpenAI cho
 * gpt-image-1. Dùng để CHẶN TRƯỚC khi gọi; chi phí THẬT ghi theo `usage` OpenAI trả về. Model khác
 * không có trong bảng ⇒ ước tính theo mức `high` (hướng an toàn: chặn sớm hơn, không muộn hơn).
 */
export const IMAGE_PRICE_USD: Record<ImageQuality, Record<ImageSize, number>> = {
  low: { "1024x1024": 0.011, "1024x1536": 0.016 },
  medium: { "1024x1024": 0.042, "1024x1536": 0.063 },
  high: { "1024x1024": 0.167, "1024x1536": 0.25 },
};

export function estimateImageUsd(model: string, quality: ImageQuality, size: ImageSize): number {
  return model.startsWith("gpt-image-1") ? IMAGE_PRICE_USD[quality][size] : IMAGE_PRICE_USD.high[size];
}
