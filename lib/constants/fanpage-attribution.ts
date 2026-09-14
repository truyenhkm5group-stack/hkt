/**
 * ═══════════ FANPAGE → MARKETER → ĐƠN → DOANH THU XÁC NHẬN ═══════════
 *
 * ─── CÂU HỎI ───
 *
 * "Fanpage này do ai chạy, và tháng vừa rồi các fanpage của người đó mang về bao nhiêu đơn, bao
 * nhiêu doanh thu ĐÃ XÁC NHẬN trên Pancake?" Đây là câu hỏi MARKETING, đo ở mốc CHỐT ĐƠN.
 *
 * Nó KHÁC hai thứ đã có trong kho mã, và cố ý không trộn vào cả hai:
 *
 *   · `lib/constants/marketer-attribution.ts` đi bằng QUẢNG CÁO (`orders.ad_id` → chiến dịch →
 *     marketer). Chính xác tới từng mẩu quảng cáo, nhưng chỉ phủ được phần đơn có `ad_id`, và
 *     không trả lời được gì cho đơn khách tự nhắn vào fanpage. Tệp này đi bằng FANPAGE nên phủ
 *     được đúng phần kia. Hai đường KHÔNG ghi đè nhau, không cộng vào nhau.
 *   · `lib/constants/payroll.ts::attributionShares` chia DOANH SỐ CỦA MỘT MÃ HÀNG theo tỷ trọng
 *     (fanpage → tiền quảng cáo → chủ mã). Phép chia ấy đúng cho việc chia LỢI NHUẬN, nhưng nó
 *     không nói được đơn số 12345 thuộc về ai, và một đơn có thể bị xẻ cho ba người. Ở đây MỖI
 *     ĐƠN THUỘC ĐÚNG MỘT NGƯỜI hoặc không thuộc ai — không có phần trăm.
 *
 * ─── LUẬT BẤT BIẾN 1: ĐỔI NGƯỜI PHỤ TRÁCH KHÔNG ĐƯỢC VIẾT LẠI LỊCH SỬ ───
 *
 * Fanpage A giao cho An từ 01/09, chuyển cho Bình từ 10/09. Đơn ngày 05/09 là của An VĨNH VIỄN.
 * Nên KHÔNG có đường `đơn → page → người đang phụ trách page` ở bất kỳ đâu: một câu `join` như thế
 * làm mọi báo cáo tháng trước đổi số vào đúng cái ngày shop đổi người.
 *
 * Hai lớp cùng giữ điều đó:
 *   1. `fanpage_marketer_assignments` có KHOẢNG HIỆU LỰC — người phụ trách là hàm của (page, MỐC
 *      ĐƠN PHÁT SINH), không phải của (page, hôm nay);
 *   2. `order_attributions` là ẢNH CHỤP: mỗi đơn giữ lại page, người, và CHÍNH DÒNG PHÂN CÔNG đã
 *      dùng. Báo cáo đọc ảnh chụp, nên nó đứng yên cho tới khi có người bấm dựng lại.
 *
 * ─── LUẬT BẤT BIẾN 2: DOANH THU MARKETING ĐO Ở MỐC CHỐT ĐƠN, KHÔNG PHẢI MỐC GIAO HÀNG ───
 *
 * `Doanh thu xác nhận` = `orders.total_price_after_discount` của đơn có `stage ∈ CONFIRMED_STAGES`.
 * TUYỆT ĐỐI không đọc COD, không đọc tiền Viettel Post đã thu, không đọc `ORDER_OUTCOME`. Những
 * thứ đó là chỉ số LOGISTICS và đã có nhà riêng (`lib/queries/return-rate.ts`, AGENTS.md mục 3).
 * Marketer không quyết được việc shipper có giao được hay không; chấm họ bằng con số ấy là chấm
 * bằng thứ họ không quyết được (AGENTS.md mục 24).
 *
 * Đơn chưa xác nhận VẪN có dòng quy kết, chỉ là đóng góp 0đ vào doanh thu xác nhận — "chưa chốt"
 * khác hẳn "chốt rồi mà 0đ", và cả hai đều khác `NULL`.
 *
 * ─── LUẬT BẤT BIẾN 3: TRÙNG ĐƠN PHẢI CÓ BẰNG CHỨNG, KHÔNG PHẢI CÙNG KHÁCH ───
 *
 * Một khách được phép mua ở nhiều fanpage, mua nhiều mã, và mua lại chính mã cũ. Chỉ khi CÙNG
 * người nhận + CÙNG giỏ hàng (mẫu mã và số lượng) + TRONG MỘT CỬA SỔ NGẮN thì mới là một lần đặt
 * bị nhập hai lần. Lề an toàn nghiêng hẳn về BỎ SÓT hơn là BẮT NHẦM: bắt nhầm là lấy mất đơn của
 * một người thật và đưa cho người khác.
 */

/**
 * PHIÊN BẢN LUẬT. Đổi công thức ⇒ tăng số này; dòng mang số cũ thành DÒNG CŨ và tìm ra được, thay
 * vì lẫn vào dòng mới mà không ai phân biệt nổi. Cùng tinh thần với `canonical_order_outcome.logic_version`.
 */
export const FANPAGE_ATTRIBUTION_RULE_VERSION = 1;

/**
 * ───────────── CỬA SỔ TÌM ỨNG VIÊN — KHÔNG PHẢI ĐIỀU KIỆN ĐỦ ─────────────
 *
 * NGƯỠNG NGHIỆP VỤ — chỉ chủ shop mới được đổi (AGENTS.md mục 7), và chỉ đổi ở ĐÂY.
 *
 * Con số này CHỈ dùng để THU HẸP chỗ phải tìm. Nó KHÔNG bao giờ tự mình kết luận trùng đơn: quá
 * cửa sổ thì thôi không xét nữa, còn trong cửa sổ thì mới bắt đầu xét CHỨNG CỨ (xem
 * `DUPLICATE_SIGNALS`). Hai đơn cùng khách, cùng giỏ hàng, cách nhau 3 tiếng mà không có một dấu
 * hiệu nguồn nào nối chúng lại thì vẫn là HAI LẦN BÁN.
 *
 * Vì sao vẫn cần một cửa sổ: nó là thứ chặn khách mua lại sau một tháng bị nuốt mất, và nó giữ cho
 * phép tìm ứng viên có biên (không phải so mọi đơn với mọi đơn).
 */
export const DUPLICATE_CANDIDATE_WINDOW_HOURS = 24;

/**
 * ═══════════ CHỨNG CỨ NÓI HAI ĐƠN LÀ MỘT LẦN ĐẶT BỊ NHẬP LẠI ═══════════
 *
 * ─── VÌ SAO KHÔNG DÙNG "CÙNG KHÁCH + CÙNG GIỎ + TRONG 24 GIỜ" LÀM KẾT LUẬN ───
 *
 * Vì mệnh đề đó mô tả ĐÚNG cả một chuyện hoàn toàn bình thường: khách đặt thêm một bộ giống hệt cho
 * người nhà trong cùng buổi chiều. Lấy nó làm kết luận là biến "ngăn đếm hai lần một đơn" thành
 * "ngăn khách mua lần thứ hai" — và người bán được lần thứ hai mất trắng đơn của mình.
 *
 * Nên nó chỉ là ỨNG VIÊN. Kết luận phải đứng trên một DẤU HIỆU NGUỒN: thứ mà chỉ một lần nhập lại
 * mới sinh ra được.
 *
 * ─── ĐO TRÊN PRODUCTION 14/09/2026 (2.830 đơn) — chọn dấu hiệu bằng số, không bằng cảm giác ───
 *
 *   `conversation_id`   2.156/2.830 (76%)  ✓ dùng — hai đơn từ CÙNG một cuộc trò chuyện
 *   `post_id`           2.127/2.830 (75%)  ✓ dùng — cùng một bài quảng cáo dẫn tới
 *   `customer_id`       2.802/2.830 (99%)  ✓ dùng — cùng một khách theo định danh Pancake
 *   `duplicated_phone`  186 đơn `true`     ✓ dùng — CHÍNH PANCAKE đánh dấu SĐT này trùng
 *   `duplicated_ip`     0 đơn `true`       ✗ BỎ — không có tín hiệu nào, giữ lại là tự lừa mình
 *   `pke_mkter`         0 đơn có giá trị   ✗ BỎ — shop không dùng trường này
 *
 * ─── HAI DẤU HIỆU QUYẾT ĐỊNH, VÀ VÌ SAO CHÚNG ĐỦ SỨC ĐỨNG MỘT MÌNH ───
 *
 * `CANCELLED_SIBLING` — một trong hai đơn đã huỷ/xoá, đơn kia còn sống, cùng giỏ cùng người nhận
 *   trong cửa sổ. Đây LÀ hình dạng của "huỷ rồi tạo lại", và nó là cách đơn bị nhập lại phổ biến
 *   nhất ở shop này. Một khách đặt lại y hệt ngay sau khi chính đơn đó bị huỷ là chuyện hiếm.
 *
 * `SAME_CONVERSATION` — hai đơn sinh ra từ CÙNG một cuộc trò chuyện. Không phải suy đoán: Pancake
 *   gắn `conversation_id` lúc nhân viên chốt đơn trong chat. Cùng một chat, cùng một giỏ, trong
 *   cùng một ngày mà thành hai đơn thì gần như chắc chắn là chốt nhầm hai lần.
 *
 * ─── ĐƯỜNG THỨ HAI: BỐN DẤU HIỆU YẾU CỘNG LẠI ───
 *
 * Không có dấu hiệu quyết định nào thì phải gom đủ **bốn** dấu hiệu yếu. Đó là một cái cổng cao có
 * chủ đích, vì đây là đường duy nhất có thể bắt nhầm một lần mua thật. Luật của đề bài: **không đủ
 * chắc thì tính cả hai đơn** — lề an toàn nghiêng hẳn về BỎ SÓT.
 *
 * Hệ quả phải nói thẳng: một đơn bị nhập lại ở PAGE KHÁC thường không có `conversation_id` chung
 * (hội thoại thuộc về một page), nên nó phải đi đường bốn-dấu-hiệu và có thể LỌT. Đo trên
 * production: 0 ca trùng khác page tồn tại, nên hôm nay điều đó không mất gì. Ngày nào có ca thật,
 * chỗ phải sửa là bảng này, không phải cửa sổ thời gian.
 */
export const DUPLICATE_SIGNALS = {
  CANCELLED_SIBLING: { weight: 4, label: "Một đơn đã huỷ, đơn kia còn sống", hint: "Hình dạng của 'huỷ rồi tạo lại' — đơn còn hiệu lực giữ quy kết." },
  SAME_CONVERSATION: { weight: 4, label: "Cùng một cuộc trò chuyện", hint: "Pancake gắn conversation_id lúc chốt đơn trong chat; cùng chat + cùng giỏ = chốt nhầm hai lần." },
  SAME_CUSTOMER_ID: { weight: 1, label: "Cùng khách theo định danh Pancake", hint: "Mạnh hơn so khớp chuỗi SĐT, nhưng khách mua lại cũng cùng định danh." },
  SAME_POST: { weight: 1, label: "Cùng bài quảng cáo", hint: "Hai đơn cùng đến từ một bài viết." },
  SAME_VALUE: { weight: 1, label: "Cùng giá trị đơn", hint: "Một lần nhập lại mang đúng số tiền cũ." },
  PANCAKE_DUPLICATE_FLAG: { weight: 1, label: "Pancake đánh dấu SĐT trùng", hint: "duplicated_phone = true — chính nguồn đã nghi ngờ." },
  MINUTES_APART: { weight: 1, label: "Cách nhau dưới 30 phút", hint: "Khoảng cách của một lần gõ lại, không phải của một lần mua mới." },
} as const;

export type DuplicateSignal = keyof typeof DUPLICATE_SIGNALS;
export const DUPLICATE_SIGNAL_KEYS = Object.keys(DUPLICATE_SIGNALS) as DuplicateSignal[];

/**
 * ĐIỂM TỐI THIỂU ĐỂ KẾT LUẬN TRÙNG ĐƠN.
 *
 * Bằng đúng trọng số của một dấu hiệu quyết định — nên một dấu hiệu quyết định là đủ, còn không thì
 * phải gom bốn dấu hiệu yếu. Đổi con số này là đổi luật nghiệp vụ: chỉ chủ shop mới được đổi.
 */
export const DUPLICATE_SCORE_THRESHOLD = 4;

/** Tình trạng quy kết của một đơn. Đúng MỘT giá trị cho mỗi đơn — không có đơn nào mang hai. */
export const ATTRIBUTION_STATUSES = ["ATTRIBUTED", "NO_PAGE", "NO_ASSIGNMENT", "DUPLICATE"] as const;
export type AttributionStatus = (typeof ATTRIBUTION_STATUSES)[number];

export const ATTRIBUTION_STATUS_LABEL: Record<AttributionStatus, string> = {
  ATTRIBUTED: "Đã quy kết",
  NO_PAGE: "Đơn không có fanpage",
  NO_ASSIGNMENT: "Fanpage chưa gán marketer",
  DUPLICATE: "Trùng đơn — không tính",
};

export const ATTRIBUTION_STATUS_HINT: Record<AttributionStatus, string> = {
  ATTRIBUTED: "Đơn phát sinh trên một fanpage đã có người phụ trách tại thời điểm đơn lên.",
  NO_PAGE: "Pancake không gửi `page_id` cho đơn này — đơn nhập tay, đơn landing, hoặc nguồn khác.",
  NO_ASSIGNMENT: "Đơn có fanpage nhưng tại MỐC ĐƠN LÊN chưa có ai được phân công fanpage đó.",
  DUPLICATE: "Có ĐỦ DẤU HIỆU NGUỒN nói đây là một lần đặt bị nhập lại (cùng hội thoại, hoặc huỷ rồi tạo lại, hoặc đủ bốn dấu hiệu yếu). Đơn còn hiệu lực sớm nhất giữ quy kết.",
};

/** Việc phải làm để lấp từng loại chỗ trống. Bảng chỉ in con số là bảng không ai mở lần thứ hai. */
export const ATTRIBUTION_STATUS_FIX: Record<AttributionStatus, string> = {
  ATTRIBUTED: "",
  NO_PAGE: "Không sửa được từ ERP: đơn vốn không sinh ra từ fanpage nào. Nếu đây là đơn landing, doanh thu của nó thuộc kênh landing chứ không thuộc marketer nào.",
  NO_ASSIGNMENT: "Vào Marketing → Fanpage & quy kết, gán marketer cho fanpage với mốc hiệu lực TRÙM được ngày đơn lên, rồi chạy lại đối soát.",
  DUPLICATE: "Không phải lỗi — đây là kết quả đúng. Mỗi dòng ghi rõ CĂN CỨ đã dùng; mở đơn gốc để đối chiếu nếu thấy căn cứ chưa thuyết phục.",
};

export const ATTRIBUTION_STATUS_TONE: Record<AttributionStatus, string> = {
  ATTRIBUTED: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300",
  NO_PAGE: "bg-muted text-muted-foreground",
  NO_ASSIGNMENT: "bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300",
  DUPLICATE: "bg-slate-100 text-slate-600 dark:bg-slate-900/60 dark:text-slate-300",
};

/** Chỉ MỘT tình trạng cho phép ghi tên một người lên đơn. */
export function isAttributed(status: AttributionStatus): boolean {
  return status === "ATTRIBUTED";
}

/* ─────────────────────── CHUẨN HOÁ ĐỂ SO KHỚP ───────────────────────
 *
 * Chuẩn hoá ở đây CỐ Ý nhạt: cắt khoảng trắng, bỏ dấu, chữ thường. Không có so khớp mờ, không có
 * khoảng cách Levenshtein, không có "địa chỉ gần giống". Mỗi nấc thông minh thêm là một nấc nữa
 * của khả năng gộp nhầm hai người thật thành một.
 */

/** SĐT Việt Nam về dạng `0xxxxxxxxx`. Cùng quy tắc với `lib/constants/landing.ts`. */
export function normalizeAttrPhone(v: string | null | undefined): string {
  let d = String(v ?? "").replace(/\D/g, "");
  if (d.startsWith("84") && d.length >= 11) d = `0${d.slice(2)}`;
  if (d.length === 9 && !d.startsWith("0")) d = `0${d}`;
  return d;
}

/** Bỏ dấu, chữ thường, gộp khoảng trắng. Dùng chung cho tên người nhận và địa chỉ. */
export function normalizeAttrText(v: string | null | undefined): string {
  return String(v ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * KHOÁ MẪU MÃ của một dòng hàng, theo thứ tự tin cậy giảm dần:
 * mẫu mã ERP (`variant_id`, khoá chuẩn) → SKU → mã sản phẩm → tên đã chuẩn hoá.
 *
 * Tên là nấc CUỐI và chỉ để đơn cũ thiếu mẫu mã vẫn so khớp được với chính nó; nó không bao giờ
 * làm hai mẫu mã khác nhau trông giống nhau, vì tên khác thì khoá khác.
 */
export function itemKey(item: { variantId?: string | null; sku?: string | null; productId?: string | null; productName?: string | null }): string {
  const variant = String(item.variantId ?? "").trim();
  if (variant) return `v:${variant}`;
  const sku = String(item.sku ?? "").trim();
  if (sku) return `s:${sku.toLowerCase()}`;
  const product = String(item.productId ?? "").trim();
  if (product) return `p:${product}`;
  return `n:${normalizeAttrText(item.productName)}`;
}

export type DedupeItem = { variantId?: string | null; sku?: string | null; productId?: string | null; productName?: string | null; quantity: number };

/**
 * KHOÁ TRÙNG ĐƠN — hai đơn có cùng khoá này thì CÓ THỂ là một lần đặt bị nhập hai lần. Cùng khoá
 * vẫn CHƯA đủ: còn phải nằm trong cửa sổ thời gian (xem `resolveDuplicateChains`).
 *
 * Gồm: người nhận đã chuẩn hoá (SĐT · tên · địa chỉ) + GIỎ HÀNG (mẫu mã và số lượng, đã sắp xếp).
 *
 * Giỏ hàng nằm TRONG khoá là điều làm tình huống 3 của đặc tả chạy đúng mà không cần luật riêng:
 * cùng khách mua Q001 ở page A và Q004 ở page B ra hai khoá khác nhau, nên hai đơn không bao giờ
 * gặp nhau, nên cả hai marketer đều được tính.
 *
 * `null` = KHÔNG ĐỦ CĂN CỨ để xét trùng (không có SĐT, hoặc đơn không có dòng hàng nào). Đơn như
 * thế không bao giờ bị loại vì trùng — đúng chiều lề an toàn.
 */
export function buildDedupeKey(input: { phone: string | null | undefined; name: string | null | undefined; address: string | null | undefined; items: DedupeItem[] }): string | null {
  const phone = normalizeAttrPhone(input.phone);
  if (!phone) return null;
  const merged = new Map<string, number>();
  for (const it of input.items) {
    const qty = Math.trunc(Number(it.quantity) || 0);
    if (qty <= 0) continue;
    const k = itemKey(it);
    merged.set(k, (merged.get(k) ?? 0) + qty);
  }
  if (!merged.size) return null;
  const basket = [...merged.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, q]) => `${k}#${q}`)
    .join("|");
  return [phone, normalizeAttrText(input.name), normalizeAttrText(input.address), basket].join("~");
}

/* ─────────────────────── XẾP THỨ TỰ VÀ CHỌN ĐƠN THẮNG ─────────────────────── */

export type DedupeCandidate = {
  orderId: string;
  /** MỐC ĐƠN PHÁT SINH TẠI NGUỒN (`orders.inserted_at` = `inserted_at` của Pancake), KHÔNG phải mốc ERP đọc được. */
  sourceOrderAt: Date;
  /** Khoá ỨNG VIÊN: người nhận + giỏ hàng. `null` = không đủ căn cứ ⇒ đơn không bao giờ bị loại. */
  dedupeKey: string | null;
  /**
   * Đơn còn SỐNG (chưa huỷ, chưa xoá) — vừa là một DẤU HIỆU (`CANCELLED_SIBLING`), vừa là thứ
   * quyết định ai thắng trong một cụm: đơn đã huỷ đóng góp 0đ, nên để nó thắng là làm một đơn có
   * thật biến mất khỏi báo cáo của cả hai người.
   */
  alive: boolean;
  /* ── Dấu hiệu nguồn, chép thô từ Pancake. Rỗng/null = KHÔNG CÓ dấu hiệu, không phải dấu hiệu âm. ── */
  conversationId: string | null;
  postId: string | null;
  customerId: string | null;
  /** `total_price_after_discount`. 0 ⇒ không dùng làm dấu hiệu (không phân biệt được gì). */
  orderValue: number;
  /** `raw->duplicated_phone` của Pancake. */
  pancakeDuplicateFlag: boolean;
};

export type DuplicateEvidence = { score: number; signals: DuplicateSignal[] };

/** Khoảng cách để dấu hiệu `MINUTES_APART` bật. */
const MINUTES_APART_MS = 30 * 60_000;

/**
 * CHẤM CHỨNG CỨ CHO MỘT CẶP ĐƠN — hàm THUẦN, không đọc CSDL, không đọc đồng hồ.
 *
 * Nơi gọi đã bảo đảm hai đơn cùng khoá ứng viên và trong cửa sổ; hàm này chỉ trả lời một câu: có
 * dấu hiệu NGUỒN nào nói chúng là một lần đặt bị nhập lại không.
 *
 * Trả về cả danh sách dấu hiệu chứ không chỉ điểm số, vì một kết luận "trùng đơn" mà không nói
 * được VÌ SAO là một kết luận không ai kiểm chứng lại được — và nó đang lấy doanh thu khỏi tên
 * một người thật.
 */
export function scoreDuplicatePair(a: DedupeCandidate, b: DedupeCandidate): DuplicateEvidence {
  const signals: DuplicateSignal[] = [];
  if (a.alive !== b.alive) signals.push("CANCELLED_SIBLING");
  if (a.conversationId && b.conversationId && a.conversationId === b.conversationId) signals.push("SAME_CONVERSATION");
  if (a.customerId && b.customerId && a.customerId === b.customerId) signals.push("SAME_CUSTOMER_ID");
  if (a.postId && b.postId && a.postId === b.postId) signals.push("SAME_POST");
  if (a.orderValue > 0 && a.orderValue === b.orderValue) signals.push("SAME_VALUE");
  // Cờ của Pancake trên BẤT KỲ đơn nào trong cặp: nó nói "SĐT này còn ở đơn khác", và ở đây đơn
  // khác đó chính là đơn kia.
  if (a.pancakeDuplicateFlag || b.pancakeDuplicateFlag) signals.push("PANCAKE_DUPLICATE_FLAG");
  if (Math.abs(a.sourceOrderAt.getTime() - b.sourceOrderAt.getTime()) <= MINUTES_APART_MS) signals.push("MINUTES_APART");
  const score = signals.reduce((t, k) => t + DUPLICATE_SIGNALS[k].weight, 0);
  return { score, signals };
}

export type DedupeVerdict = {
  orderId: string;
  duplicateOfOrderId: string | null;
  /** Điểm chứng cứ so với đơn ĐẠI DIỆN của cụm. `null` với đơn không bị loại. */
  score: number | null;
  /** Các dấu hiệu đã bật, theo thứ tự trong sổ đăng ký. `[]` với đơn không bị loại. */
  signals: DuplicateSignal[];
};

/**
 * ĐƠN NÀO THẮNG QUY KẾT — ba bước, và mỗi bước trả lời một câu khác nhau.
 *
 * ─── BƯỚC 1 · ỨNG VIÊN, bằng KHOÁ và THỜI GIAN ───
 *
 * Cùng người nhận + cùng giỏ hàng + trong cửa sổ. Khác mã hàng hay khác số lượng ⇒ khác khoá ⇒
 * KHÔNG BAO GIỜ gặp nhau, nên "khác SKU thì tính cả hai" đúng mà không cần một luật riêng.
 *
 * ─── BƯỚC 2 · CHỨNG CỨ, và đây mới là chỗ kết luận ───
 *
 * Ứng viên chỉ thành cụm khi `scoreDuplicatePair` với ĐƠN GIỮ QUY KẾT của cụm đạt ngưỡng. Không
 * đạt ⇒ mở cụm MỚI ⇒ cả hai đơn đều được tính. Đó là điều làm "khách mua lại trong cùng buổi
 * chiều" không bị nuốt mất.
 *
 * ĐƠN GIỮ QUY KẾT, KHÔNG PHẢI ĐƠN SỚM NHẤT — và đây là chỗ đã có một lỗi thật (xem BƯỚC 3). Chứng
 * cứ phải chấm với chính đơn mà dòng kết luận sẽ trỏ tới; chấm với một đơn thứ ba rồi ghi kết luận
 * về một cặp khác là ghi một điều chưa ai chứng minh.
 *
 * Cửa sổ thời gian vẫn đo từ đơn SỚM NHẤT của cụm, không đo từ đơn giữ quy kết: đo từ đơn giữ quy
 * kết là mở đường cho cụm trượt dài mỗi lần đơn ấy đổi.
 *
 * So với một mốc CỐ ĐỊNH của cụm chứ không so với đơn liền trước: nếu so với đơn liền trước thì
 * một dãy đơn mỗi cái cách nhau 23 giờ sẽ trượt dài vô tận thành "một lần đặt".
 *
 * ─── BƯỚC 3 · AI GIỮ QUY KẾT TRONG CỤM ───
 *
 * Đơn còn SỐNG sớm nhất giữ; cả cụm đã huỷ thì đơn sớm nhất giữ. "Sớm nhất" đo bằng mốc của
 * NGUỒN (Pancake), và bằng giây thì chốt hạ bằng `order_id` so như CHUỖI (id Pancake vượt 2^53).
 * Cần cái chốt hạ đó, nếu không hai lần chạy đối soát có thể đổi chỗ doanh thu của hai người mà
 * không ai làm gì cả.
 *
 * Vì các đơn vào cụm theo thứ tự thời gian tăng dần, người giữ quy kết đổi NHIỀU NHẤT MỘT LẦN:
 * từ đơn đã huỷ mở cụm sang đơn còn sống đầu tiên. Nên nó tính được ngay trong lúc dựng cụm, và
 * chứng cứ nhận vào cụm chính là chứng cứ ghi ra — một con số duy nhất, không có "điểm lúc nhận"
 * khác "điểm lúc ghi".
 *
 * TẤT ĐỊNH và IDEMPOTENT: kết quả là hàm thuần của dữ liệu vào; chạy lại bao nhiêu lần cũng thế.
 */
export function resolveDuplicates(candidates: DedupeCandidate[], windowHours = DUPLICATE_CANDIDATE_WINDOW_HOURS): DedupeVerdict[] {
  const windowMs = Math.max(0, windowHours) * 3_600_000;
  const byKey = new Map<string, DedupeCandidate[]>();
  const out: DedupeVerdict[] = [];
  const notDuplicate = (orderId: string): DedupeVerdict => ({ orderId, duplicateOfOrderId: null, score: null, signals: [] });

  for (const c of candidates) {
    if (!c.dedupeKey) {
      out.push(notDuplicate(c.orderId));
      continue;
    }
    const list = byKey.get(c.dedupeKey);
    if (list) list.push(c);
    else byKey.set(c.dedupeKey, [c]);
  }

  const earlier = (a: DedupeCandidate, b: DedupeCandidate) =>
    a.sourceOrderAt.getTime() - b.sourceOrderAt.getTime() || (a.orderId < b.orderId ? -1 : a.orderId > b.orderId ? 1 : 0);

  /**
   * Đơn GIỮ QUY KẾT của một cụm: đơn còn SỐNG sớm nhất, không có thì đơn sớm nhất. Cụm luôn được
   * xếp theo thời gian tăng dần nên phần tử đầu khớp với danh sách đã sắp.
   */
  const holder = (cluster: DedupeCandidate[]) => cluster.find((m) => m.alive) ?? cluster[0];

  for (const list of byKey.values()) {
    const sorted = [...list].sort(earlier);
    /** Mỗi cụm: mốc cửa sổ (phần tử đầu, sớm nhất) + các thành viên, theo thứ tự thời gian. */
    const clusters: DedupeCandidate[][] = [];
    for (const c of sorted) {
      let joined = false;
      for (const cl of clusters) {
        // Cửa sổ: luôn đo từ đơn SỚM NHẤT của cụm — cụm không được trượt dài theo người giữ.
        if (c.sourceOrderAt.getTime() - cl[0].sourceOrderAt.getTime() > windowMs) continue;
        /*
          CHỨNG CỨ: chấm với ĐƠN GIỮ QUY KẾT, không phải với đơn sớm nhất.

          SỰ CỐ THẬT (rà soát 14/09/2026): A đã huỷ 09:00 · B còn sống 09:05 · C còn sống 10:00,
          cùng khoá và cùng giá trị. A–B đạt ngưỡng nhờ `CANCELLED_SIBLING`; A–C cũng đạt nhờ chính
          dấu hiệu đó. Nhưng B mới là đơn giữ quy kết, và B–C chỉ có đúng một điểm `SAME_VALUE`.
          Chấm với đơn sớm nhất tức là để một ĐƠN ĐÃ HUỶ làm CẦU NỐI giữa hai đơn còn sống không có
          quan hệ gì với nhau — và C, một lần bán có thật, bị xoá khỏi doanh thu của người bán nó.
        */
        if (scoreDuplicatePair(holder(cl), c).score < DUPLICATE_SCORE_THRESHOLD) continue;
        cl.push(c);
        joined = true;
        break;
      }
      if (!joined) clusters.push([c]);
    }
    for (const members of clusters) {
      const winner = holder(members);
      for (const m of members) {
        if (m.orderId === winner.orderId) {
          out.push(notDuplicate(m.orderId));
          continue;
        }
        /*
          CHẤM VỚI ĐƠN THẮNG — cùng một cặp mà dòng này khẳng định.

          Đơn mở cụm không phải chấm với ai (nó mở cụm). Khi nó là đơn đã huỷ và một đơn còn sống
          đến sau giành lấy quy kết, chính nó thành đơn trùng; ghi lại "điểm lúc nhận vào cụm" thì
          nó mang điểm 0 với căn cứ RỖNG. Đo trên production 14/09: 46/83 dòng trùng đơn rơi đúng
          vào ca đó, tức hơn một nửa kết luận không nói được vì sao.

          LƯỚI AN TOÀN CUỐI: chứng cứ với đơn thắng chưa đạt ngưỡng thì KHÔNG kết luận trùng — tính
          cả hai đơn. Với bộ trọng số hiện hành nhánh này không bao giờ chạy (thành viên vào cụm
          trước lúc người giữ đổi đều là đơn ĐÃ HUỶ, nên `CANCELLED_SIBLING` tự bật với người giữ
          còn sống). Nó đứng đây để một lần đổi trọng số trong `DUPLICATE_SIGNALS` không lặng lẽ
          biến thành một dòng kết luận không có chứng cứ — lề an toàn nghiêng về BỎ SÓT.
        */
        const ev = scoreDuplicatePair(winner, m);
        if (ev.score < DUPLICATE_SCORE_THRESHOLD) {
          out.push(notDuplicate(m.orderId));
          continue;
        }
        out.push({ orderId: m.orderId, duplicateOfOrderId: winner.orderId, score: ev.score, signals: ev.signals });
      }
    }
  }
  return out;
}

export type AssignmentWindow = {
  id: string;
  fanpageId: string;
  marketerId: string;
  effectiveFrom: Date;
  /** `null` = còn hiệu lực tới hiện tại. */
  effectiveTo: Date | null;
  active: boolean;
};

/**
 * AI PHỤ TRÁCH FANPAGE NÀY TẠI MỐC ẤY — nửa mở `[from, to)`.
 *
 * Nửa mở là chủ đích: người cũ kết thúc đúng lúc người mới bắt đầu thì không có một giây nào mà
 * một đơn thuộc về cả hai, và cũng không có kẽ hở nào mà nó không thuộc về ai.
 *
 * Dòng đã tắt (`active = false`) KHÔNG được tính: tắt là lời khẳng định "dòng này khai sai", và một
 * dòng khai sai không được quyết định doanh thu của ai cả. Nhiều dòng còn chồng lấn thì lấy dòng có
 * `effective_from` MUỘN NHẤT — khai sau là khai đúng hơn; chồng lấn vốn đã bị chặn lúc ghi.
 */
export function pickAssignment(windows: AssignmentWindow[], at: Date): AssignmentWindow | null {
  const t = at.getTime();
  let best: AssignmentWindow | null = null;
  for (const w of windows) {
    if (!w.active) continue;
    if (w.effectiveFrom.getTime() > t) continue;
    if (w.effectiveTo && w.effectiveTo.getTime() <= t) continue;
    if (!best || w.effectiveFrom.getTime() > best.effectiveFrom.getTime() || (w.effectiveFrom.getTime() === best.effectiveFrom.getTime() && w.id > best.id)) best = w;
  }
  return best;
}

/** Hai khoảng hiệu lực có chồng lấn nhau không (nửa mở `[from, to)`). Dùng để CHẶN lúc ghi. */
export function windowsOverlap(a: { from: Date; to: Date | null }, b: { from: Date; to: Date | null }): boolean {
  const aTo = a.to ? a.to.getTime() : Number.POSITIVE_INFINITY;
  const bTo = b.to ? b.to.getTime() : Number.POSITIVE_INFINITY;
  return a.from.getTime() < bTo && b.from.getTime() < aTo;
}
