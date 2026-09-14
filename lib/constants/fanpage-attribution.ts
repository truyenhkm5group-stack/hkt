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
 * ───────────── CỬA SỔ TRÙNG ĐƠN ─────────────
 *
 * NGƯỠNG NGHIỆP VỤ — chỉ chủ shop mới được đổi (AGENTS.md mục 7), và chỉ đổi ở ĐÂY.
 *
 * Vì sao phải có một cửa sổ: nếu không có, "cùng khách + cùng mã + cùng số lượng" sẽ gộp luôn cả
 * lần khách mua lại sau một tháng — và người bán được lần thứ hai mất trắng đơn của mình. Đó là
 * tình huống 4 trong đặc tả, và nó là tình huống THẬT với shop thời trang bán hàng lặp lại.
 *
 * Vì sao là 24 giờ: một đơn bị nhập lại do nhầm lẫn vận hành (khách nhắn lại page khác, nhân viên
 * khác chốt lại) xảy ra trong cùng ca hoặc cùng ngày. Qua một đêm mà khách vẫn đặt đúng giỏ ấy thì
 * khả năng là một lần mua thật cao hơn hẳn — và khi không chắc, luật là KHÔNG loại.
 */
export const DUPLICATE_WINDOW_HOURS = 24;

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
  DUPLICATE: "Cùng người nhận, cùng giỏ hàng, trong cửa sổ trùng đơn với một đơn có trước. Đơn trước giữ quy kết.",
};

/** Việc phải làm để lấp từng loại chỗ trống. Bảng chỉ in con số là bảng không ai mở lần thứ hai. */
export const ATTRIBUTION_STATUS_FIX: Record<AttributionStatus, string> = {
  ATTRIBUTED: "",
  NO_PAGE: "Không sửa được từ ERP: đơn vốn không sinh ra từ fanpage nào. Nếu đây là đơn landing, doanh thu của nó thuộc kênh landing chứ không thuộc marketer nào.",
  NO_ASSIGNMENT: "Vào Marketing → Fanpage & quy kết, gán marketer cho fanpage với mốc hiệu lực TRÙM được ngày đơn lên, rồi chạy lại đối soát.",
  DUPLICATE: "Không phải lỗi — đây là kết quả đúng. Mở đơn gốc để đối chiếu nếu nghi ngờ.",
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
  dedupeKey: string | null;
  /**
   * Đơn còn SỐNG (chưa huỷ, chưa xoá).
   *
   * Vì sao cờ này tồn tại — và đây là chỗ luật "đơn trước thắng" phải được nói cho đủ. Cách đơn bị
   * nhập lại PHỔ BIẾN NHẤT ở shop này không phải hai page cùng chốt một khách, mà là: nhân viên huỷ
   * đơn cũ rồi tạo lại đơn mới. Nếu đơn ĐÃ HUỶ thắng quy kết thì nó đóng góp 0đ (đơn huỷ không nằm
   * trong `CONFIRMED_STAGES`) còn đơn thật bị đánh dấu trùng và cũng 0đ — một đơn có thật biến mất
   * khỏi báo cáo của cả hai người.
   *
   * Nên trong một chuỗi, người thắng là đơn SỐNG sớm nhất. Cả chuỗi đều đã huỷ thì đơn sớm nhất
   * thắng như thường — chuỗi vẫn gộp lại, chỉ là gộp về một con số 0 đúng nghĩa.
   */
  alive: boolean;
};

export type DedupeVerdict = { orderId: string; duplicateOfOrderId: string | null };

/**
 * ĐƠN NÀO THẮNG QUY KẾT — hai bước, và hai bước ấy trả lời hai câu hỏi khác nhau.
 *
 * ─── BƯỚC 1 · CHIA CHUỖI, bằng THỜI GIAN ───
 *
 * Cùng khoá trùng đơn vẫn chưa đủ: còn phải gần nhau về thời gian. Đo cửa sổ từ đơn ĐẦU CHUỖI giữ
 * cho chuỗi có biên — đo từ đơn liền trước sẽ cho một dãy đơn cách nhau 23 giờ trượt dài vô tận
 * thành "một lần đặt". Quá cửa sổ thì mở chuỗi MỚI, và đó chính là điều làm khách mua lại sau một
 * tháng không bao giờ bị nuốt mất.
 *
 * ─── BƯỚC 2 · CHỌN NGƯỜI THẮNG TRONG CHUỖI, bằng ĐƠN SỐNG SỚM NHẤT ───
 *
 * Bằng giây thì so tiếp bằng `order_id` (khoá Pancake, so như CHUỖI để id vượt 2^53 vẫn đúng). Cần
 * một cái chốt hạ như thế, nếu không hai lần chạy đối soát có thể ra hai kết quả khác nhau và doanh
 * thu của hai người đổi chỗ cho nhau mà không ai làm gì cả.
 *
 * Đơn thứ ba trong chuỗi trỏ về ĐƠN THẮNG, không trỏ về đơn liền trước — chuỗi truy ngược luôn sâu
 * đúng một bậc.
 */
export function resolveDuplicateChains(candidates: DedupeCandidate[], windowHours = DUPLICATE_WINDOW_HOURS): DedupeVerdict[] {
  const windowMs = Math.max(0, windowHours) * 3_600_000;
  const byKey = new Map<string, DedupeCandidate[]>();
  const out: DedupeVerdict[] = [];
  for (const c of candidates) {
    if (!c.dedupeKey) {
      out.push({ orderId: c.orderId, duplicateOfOrderId: null });
      continue;
    }
    const list = byKey.get(c.dedupeKey);
    if (list) list.push(c);
    else byKey.set(c.dedupeKey, [c]);
  }
  const earlier = (a: DedupeCandidate, b: DedupeCandidate) => a.sourceOrderAt.getTime() - b.sourceOrderAt.getTime() || (a.orderId < b.orderId ? -1 : a.orderId > b.orderId ? 1 : 0);
  for (const list of byKey.values()) {
    const sorted = [...list].sort(earlier);
    // Bước 1 — chia chuỗi theo cửa sổ, mốc là đơn đầu chuỗi.
    const chains: DedupeCandidate[][] = [];
    for (const c of sorted) {
      const current = chains[chains.length - 1];
      if (current && c.sourceOrderAt.getTime() - current[0].sourceOrderAt.getTime() <= windowMs) current.push(c);
      else chains.push([c]);
    }
    // Bước 2 — đơn SỐNG sớm nhất thắng; cả chuỗi đã huỷ thì đơn sớm nhất thắng.
    for (const chain of chains) {
      const winner = chain.find((c) => c.alive) ?? chain[0];
      for (const c of chain) out.push({ orderId: c.orderId, duplicateOfOrderId: c.orderId === winner.orderId ? null : winner.orderId });
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
