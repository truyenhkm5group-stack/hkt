/**
 * ═══════════ VIETTEL POST CỦA TỔ CHỨC — TẠO VẬN ĐƠN TỪ ĐƠN ERP (POS tự chủ · docs/verticals/pos-tu-chu.md) ═══════════
 *
 * Kết nối «viettelpost-carrier» (lib/connectors/registry.ts): tài khoản + mật khẩu Viettel Post CỦA CHÍNH tổ chức khách, để
 * ERP TẠO vận đơn cho đơn tạo trong ERP — shop không cần Pancake POS để đẩy đơn sang hãng. Tệp THUẦN: không đọc CSDL, không
 * đọc biến môi trường — dùng chung cho hàm kiểm tra kết nối, client (lib/integrations/viettelpost/carrier-org.ts) và lõi tạo
 * vận đơn (lib/carriers/vtp-shipments.ts), và để bài kiểm chạy không cần mạng.
 *
 * Tên trường đọc từ tài liệu chính thức partner2.viettelpost.vn/document (trang «Tạo đơn bằng địa chỉ chi tiết», «Tra cứu
 * giá cước bằng địa chỉ chi tiết», «Cập nhật trạng thái», «Lấy link in vận đơn») ngày 04/10/2026. Dùng biến thể «địa chỉ
 * chi tiết» (`…Nlp`): Viettel Post tự đọc địa chỉ dạng chữ, nên ERP KHÔNG phải giữ bộ mã tỉnh / xã của hãng — và không phải
 * đổi khi địa giới đổi (sáp nhập tỉnh 2025 đã bỏ cấp huyện).
 *
 * LOGISTICS ≠ TIỀN (ORDER_OUTCOME.md): tạo vận đơn chỉ ghi một dòng `shipments` ở chặng chờ lấy. Hành trình về qua webhook
 * của tổ chức (`viettelpost-org`); tiền thu hộ là chứng từ riêng. Tệp này không kết luận gì về giao / hoàn / tiền.
 */

export const VTP_CARRIER_CONNECTOR = "viettelpost-carrier";

/**
 * Địa chỉ API đối tác — HẰNG SỐ trong mã: người dùng chỉ nhập tài khoản, không nhập URL, nên không có đường nào đưa mật khẩu
 * của họ đi chỗ khác. (`VIETTELPOST_BASE_URL` là cấu hình của tổ chức nhà, không dùng ở đây.)
 */
export const VTP_PARTNER_API = "https://partner.viettelpost.vn/v2";

/** Mẫu link in của Viettel Post: thay mã in (API `printing-code`) vào `bill`. `type=1` là mẫu tài liệu dùng làm ví dụ. */
export const VTP_PRINT_URL = "https://digitalize.viettelpost.vn/DigitalizePrint/report.do";
/** Link in sống bấy lâu (tài liệu: EXPIRY_TIME là mốc hết hạn, epoch mili-giây). */
export const VTP_PRINT_TTL_MS = 60 * 60 * 1000;

/** Trần tài liệu cho địa chỉ / ghi chú / tên hàng: 150 BYTE (chữ có dấu tốn 2–3 byte). */
export const VTP_TEXT_MAX_BYTES = 150;
/** Tài liệu: không truyền trọng lượng ⇒ Viettel Post mặc định 50 g. ERP không để mặc định đó tự xảy ra. */
export const VTP_MIN_WEIGHT_G = 1;
export const VTP_MAX_WEIGHT_G = 100_000;
/** Trần tiền thu hộ ERP chấp nhận ở một vận đơn — chặn gõ thừa số 0, không phải luật của hãng. */
export const VTP_MAX_COD = 100_000_000;

/**
 * ORDER_PAYMENT theo tài liệu: 1 không thu hộ · 2 thu hộ tiền hàng VÀ tiền cước · 3 thu hộ tiền hàng, không thu cước ·
 * 4 thu hộ tiền cước, không thu tiền hàng. ERP chỉ dùng 1 và 3: phí ship khách trả đã nằm trong số tiền đơn (shop tự cộng),
 * cước của hãng do SHOP trả — nên số thu hộ là đúng số khách còn nợ, không bị hãng cộng thêm một lần cước thứ hai.
 */
export const VTP_ORDER_PAYMENT = { NO_COD: 1, COD_GOODS_ONLY: 3 } as const;

/** UpdateOrder TYPE 4 = huỷ — tài liệu: chỉ áp dụng khi ORDER_STATUS < 200 (hãng chưa nhận hàng). */
export const VTP_CANCEL_TYPE = 4;
export const VTP_CANCELLABLE_BELOW_STATUS = 200;

/** Ghi chú mặc định gửi kèm vận đơn khi tổ chức chưa khai. */
export const VTP_DEFAULT_NOTE = "Cho xem hàng, không cho thử";

const utf8 = new TextEncoder();

/** Cắt chuỗi theo BYTE UTF-8 (không cắt đôi một ký tự). `TextEncoder` thay `Buffer` vì màn hình trình duyệt cũng gọi. */
export function clipBytes(text: string, maxBytes = VTP_TEXT_MAX_BYTES): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (utf8.encode(clean).length <= maxBytes) return clean;
  let out = "";
  let used = 0;
  for (const ch of clean) {
    const size = utf8.encode(ch).length;
    if (used + size > maxBytes) break;
    out += ch;
    used += size;
  }
  return out.trim();
}

/** Số điện thoại người nhận / người gửi: giữ chữ số, đầu «+84» ⇒ «0». */
export function normalizeVtpPhone(raw: string): string {
  const digits = raw.replace(/[^\d+]/g, "").replace(/^\+?84/, "0");
  return digits.replace(/\D/g, "");
}

export function isVtpPhone(phone: string): boolean {
  return /^0\d{9,10}$/.test(phone);
}

/**
 * Mã đơn của ERP gửi sang hãng (ORDER_NUMBER) — mỗi LẦN GỬI một mã: «ERP<8 ký tự mã đơn>-<lần gửi>». Gửi kèm
 * `CHECK_UNIQUE: true` nên Viettel Post từ chối mã trùng: bấm hai lần, hay bấm lại sau một lượt mạng không rõ kết quả, không
 * bao giờ đẻ ra hai vận đơn cho cùng một lần gửi.
 */
export function vtpReferenceFor(orderShortCode: string, attemptNo: number): string {
  return `ERP${orderShortCode.toUpperCase()}-${attemptNo}`;
}

/** Địa chỉ nhận một dòng: ưu tiên địa chỉ đầy đủ đã lưu, không thì ghép các phần còn thiếu (không lặp tỉnh đã có). */
export function receiverAddressLine(o: { shipFullAddress?: string | null; shipAddress?: string | null; shipCommune?: string | null; shipDistrict?: string | null; shipProvince?: string | null }): string {
  const full = (o.shipFullAddress ?? "").trim();
  if (full) return full;
  const parts = [o.shipAddress, o.shipCommune, o.shipDistrict, o.shipProvince].map((p) => (p ?? "").trim()).filter(Boolean);
  return parts.join(", ");
}

export type VtpShipmentLine = { name: string; quantity: number; unitPrice: number; weightGrams: number };

/** Tổng trọng lượng từ dòng hàng — `null` khi có dòng thiếu cân nặng (không đoán, người nhập tay). */
export function linesWeight(lines: readonly VtpShipmentLine[]): number | null {
  if (!lines.length) return null;
  let total = 0;
  for (const l of lines) {
    if (!(l.weightGrams > 0)) return null;
    total += l.weightGrams * l.quantity;
  }
  return total;
}

/** Tên hàng gộp «Áo A ×2, Quần B ×1» — cắt theo trần byte của hãng. */
export function productNameOf(lines: readonly VtpShipmentLine[]): string {
  return clipBytes(lines.map((l) => (l.quantity > 1 ? `${l.name} ×${l.quantity}` : l.name)).join(", ")) || "Hàng hoá";
}

export type VtpSender = { name: string; phone: string; address: string };

export type VtpShipmentDraft = {
  reference: string;
  sender: VtpSender;
  receiver: { name: string; phone: string; address: string };
  lines: readonly VtpShipmentLine[];
  /** Giá trị hàng khai với hãng (khai giá / bồi thường) — tổng tiền hàng sau giảm. */
  goodsValue: number;
  weightGrams: number;
  cod: number;
  serviceCode: string;
  note: string;
};

export type DraftProblem = { field: string; message: string };

/** Kiểm bản nháp TRƯỚC khi gọi hãng — lỗi nói đúng ô, tiếng Việt. Rỗng ⇒ gửi được. */
export function draftProblems(d: Omit<VtpShipmentDraft, "serviceCode"> & { serviceCode?: string }, opts: { needService: boolean }): DraftProblem[] {
  const out: DraftProblem[] = [];
  if (!d.sender.name.trim() || !d.sender.address.trim()) out.push({ field: "sender", message: "Chưa khai người gửi (tên + địa chỉ lấy hàng) ở kết nối Viettel Post của tổ chức." });
  if (!isVtpPhone(d.sender.phone)) out.push({ field: "sender", message: "Số điện thoại người gửi ở kết nối Viettel Post không hợp lệ." });
  if (!d.receiver.name.trim()) out.push({ field: "receiver", message: "Đơn chưa có tên người nhận." });
  if (!isVtpPhone(d.receiver.phone)) out.push({ field: "receiver", message: "Số điện thoại người nhận không hợp lệ (10–11 chữ số, bắt đầu bằng 0)." });
  if (d.receiver.address.trim().length < 10) out.push({ field: "receiver", message: "Địa chỉ người nhận quá ngắn — cần số nhà / đường, xã / phường, tỉnh / thành." });
  if (!Number.isInteger(d.weightGrams) || d.weightGrams < VTP_MIN_WEIGHT_G || d.weightGrams > VTP_MAX_WEIGHT_G) out.push({ field: "weightGrams", message: `Trọng lượng phải là số gam nguyên từ ${VTP_MIN_WEIGHT_G} tới ${VTP_MAX_WEIGHT_G}.` });
  if (!Number.isInteger(d.cod) || d.cod < 0 || d.cod > VTP_MAX_COD) out.push({ field: "cod", message: "Tiền thu hộ phải là số nguyên VND từ 0 tới 100.000.000." });
  if (!Number.isInteger(d.goodsValue) || d.goodsValue < 0) out.push({ field: "goodsValue", message: "Giá trị hàng không hợp lệ." });
  if (opts.needService && !/^[A-Z0-9]{2,10}$/.test(d.serviceCode ?? "")) out.push({ field: "serviceCode", message: "Chọn một dịch vụ từ bảng cước." });
  return out;
}

/** Thân yêu cầu `order/getPriceAllNlp` — TYPE 1 = bảng giá trong nước. */
export function vtpQuoteBody(d: Pick<VtpShipmentDraft, "sender" | "receiver" | "goodsValue" | "weightGrams" | "cod">): Record<string, unknown> {
  return {
    SENDER_ADDRESS: clipBytes(d.sender.address),
    RECEIVER_ADDRESS: clipBytes(d.receiver.address),
    PRODUCT_TYPE: "HH",
    PRODUCT_WEIGHT: d.weightGrams,
    PRODUCT_PRICE: d.goodsValue,
    MONEY_COLLECTION: d.cod,
    PRODUCT_LENGTH: 0,
    PRODUCT_WIDTH: 0,
    PRODUCT_HEIGHT: 0,
    TYPE: 1,
  };
}

/** Thân yêu cầu `order/createOrderNlp`. */
export function vtpCreateBody(d: VtpShipmentDraft): Record<string, unknown> {
  return {
    ORDER_NUMBER: d.reference,
    CHECK_UNIQUE: true,
    SENDER_FULLNAME: clipBytes(d.sender.name, 100),
    SENDER_PHONE: normalizeVtpPhone(d.sender.phone),
    SENDER_ADDRESS: clipBytes(d.sender.address),
    RECEIVER_FULLNAME: clipBytes(d.receiver.name, 100),
    RECEIVER_PHONE: normalizeVtpPhone(d.receiver.phone),
    RECEIVER_ADDRESS: clipBytes(d.receiver.address),
    PRODUCT_NAME: productNameOf(d.lines),
    PRODUCT_QUANTITY: Math.max(1, d.lines.reduce((s, l) => s + l.quantity, 0)),
    PRODUCT_PRICE: d.goodsValue,
    PRODUCT_WEIGHT: d.weightGrams,
    PRODUCT_LENGTH: 0,
    PRODUCT_WIDTH: 0,
    PRODUCT_HEIGHT: 0,
    PRODUCT_TYPE: "HH",
    ORDER_PAYMENT: d.cod > 0 ? VTP_ORDER_PAYMENT.COD_GOODS_ONLY : VTP_ORDER_PAYMENT.NO_COD,
    ORDER_SERVICE: d.serviceCode,
    ORDER_SERVICE_ADD: "",
    ORDER_NOTE: clipBytes(d.note || VTP_DEFAULT_NOTE),
    MONEY_COLLECTION: d.cod,
    EXTRA_MONEY: 0,
    PRODUCT_DETAIL: d.lines.map((l) => ({ PRODUCT_NAME: clipBytes(l.name, 100), PRODUCT_QUANTITY: l.quantity, PRODUCT_PRICE: l.unitPrice, PRODUCT_WEIGHT: l.weightGrams })),
    ENABLE_SORT_CODE: true,
  };
}

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function n(v: unknown): number {
  const x = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(x) ? Math.round(x) : 0;
}
function s(v: unknown): string {
  return typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "";
}

export type VtpServiceQuote = { code: string; name: string; fee: number; eta: string; extras: { code: string; name: string }[] };
export type VtpQuote = { services: VtpServiceQuote[]; receiverAddressAsRead: string | null; senderAddressAsRead: string | null };

/**
 * Đọc phản hồi tra cước. Tài liệu in mẫu `{ SENDER_ADDRESS:{…ADDRESS}, RECEIVER_ADDRESS:{…ADDRESS}, RESULT:[{ MA_DV_CHINH,
 * TEN_DICHVU, GIA_CUOC, THOI_GIAN, EXTRA_SERVICE:[…] }] }`; bản API cũ trả thẳng một mảng dịch vụ — đọc được cả hai. «Địa chỉ
 * Viettel Post hiểu» được trả về để người bấm nhìn thấy TRƯỚC khi tạo đơn: hãng đọc sai xã thì sửa địa chỉ, đừng tạo.
 */
export function parseVtpQuote(data: unknown): VtpQuote {
  const root = rec(data);
  const list = Array.isArray(data) ? data : Array.isArray(root.RESULT) ? root.RESULT : Array.isArray(rec(root.data).RESULT) ? (rec(root.data).RESULT as unknown[]) : [];
  const services = list
    .map((x) => {
      const r = rec(x);
      return {
        code: s(r.MA_DV_CHINH),
        name: s(r.TEN_DICHVU),
        fee: n(r.GIA_CUOC),
        eta: s(r.THOI_GIAN),
        extras: (Array.isArray(r.EXTRA_SERVICE) ? r.EXTRA_SERVICE : []).map((e) => ({ code: s(rec(e).SERVICE_CODE), name: s(rec(e).SERVICE_NAME) })).filter((e) => e.code),
      };
    })
    .filter((x) => x.code && x.fee > 0)
    .sort((a, b) => a.fee - b.fee);
  const addr = (v: unknown) => s(rec(v).ADDRESS) || null;
  return { services, receiverAddressAsRead: addr(root.RECEIVER_ADDRESS), senderAddressAsRead: addr(root.SENDER_ADDRESS) };
}

export type VtpCreated = { orderNumber: string; moneyTotal: number; moneyCollection: number; moneyCollectionFee: number; exchangeWeight: number; kpiHours: number | null; sortCode: string };

/** Đọc phản hồi tạo đơn. Không có ORDER_NUMBER ⇒ `null` (không có vận đơn nào để lưu). */
export function parseVtpCreated(data: unknown): VtpCreated | null {
  const r = rec(data);
  const orderNumber = s(r.ORDER_NUMBER);
  if (!orderNumber) return null;
  const kpi = typeof r.KPI_HT === "number" && Number.isFinite(r.KPI_HT) ? r.KPI_HT : null;
  return { orderNumber, moneyTotal: n(r.MONEY_TOTAL), moneyCollection: n(r.MONEY_COLLECTION), moneyCollectionFee: n(r.MONEY_COLLECTION_FEE), exchangeWeight: n(r.EXCHANGE_WEIGHT), kpiHours: kpi, sortCode: s(r.SORT_CODE) };
}

/** Link in nhãn từ mã in (`printing-code` trả trong `message`). */
export function vtpPrintUrl(printCode: string): string {
  return `${VTP_PRINT_URL}?type=1&bill=${encodeURIComponent(printCode)}&showPostage=1`;
}

/**
 * Trạng thái lượt TẠO vận đơn của ERP, lưu ở `shipments.raw.carrierCreate`:
 *  · REQUESTED — đã giữ chỗ (dòng shipments) và đang gọi hãng; người bấm thứ hai thấy chỗ đã giữ, không gửi lần hai.
 *  · CREATED — hãng trả mã vận đơn.
 *  · UNKNOWN — lượt gọi đứt giữa chừng (mạng / quá giờ): KHÔNG BIẾT hãng đã tạo hay chưa. Không tự xoá, không tự gửi lại —
 *    người tra trên viettelpost.vn theo mã ERP rồi bấm «Tạo lại» (hãng chặn trùng mã) hoặc «Bỏ lượt tạo».
 */
export const CARRIER_CREATE_STATES = ["REQUESTED", "CREATED", "UNKNOWN"] as const;
export type CarrierCreateState = (typeof CARRIER_CREATE_STATES)[number];

export type CarrierCreateRaw = { state: CarrierCreateState; reference: string; by: string | null; at: string; message?: string; service?: string; sortCode?: string };
export type CarrierCancelRaw = { state: "ACCEPTED"; by: string | null; at: string; reason: string; message: string };

export function carrierCreateOf(raw: unknown): CarrierCreateRaw | null {
  const c = rec(rec(raw).carrierCreate);
  const state = s(c.state);
  if (!(CARRIER_CREATE_STATES as readonly string[]).includes(state)) return null;
  return { state: state as CarrierCreateState, reference: s(c.reference), by: s(c.by) || null, at: s(c.at), message: s(c.message) || undefined, service: s(c.service) || undefined, sortCode: s(c.sortCode) || undefined };
}

export function carrierCancelOf(raw: unknown): CarrierCancelRaw | null {
  const c = rec(rec(raw).carrierCancel);
  if (s(c.state) !== "ACCEPTED") return null;
  return { state: "ACCEPTED", by: s(c.by) || null, at: s(c.at), reason: s(c.reason), message: s(c.message) };
}

/**
 * Lần gửi này còn GIỮ đơn không (chặn tạo lần gửi mới). Đã huỷ theo chứng từ hãng (stage CANCELLED) hoặc hãng ĐÃ NHẬN lệnh
 * huỷ của ERP (chờ webhook 107) ⇒ không giữ. Mọi trường hợp khác — kể cả lượt tạo không rõ kết quả — đều giữ: thà bắt người
 * kiểm tra còn hơn đẻ vận đơn thứ hai.
 */
export function attemptHoldsOrder(a: { stage: string; raw: unknown }): boolean {
  if (a.stage === "CANCELLED") return false;
  if (carrierCancelOf(a.raw)) return false;
  return true;
}

/** Huỷ được ở hãng khi: do ERP tạo, có mã vận đơn, chưa có lệnh huỷ được nhận, hãng chưa nhận hàng (mã < 200, hoặc chưa có mã nào). */
export function canCancelAtCarrier(a: { vtpOrderNumber: string | null; vtpStatus: number | null; stage: string; raw: unknown }): boolean {
  if (!a.vtpOrderNumber || a.stage === "CANCELLED" || carrierCancelOf(a.raw)) return false;
  if (carrierCreateOf(a.raw)?.state !== "CREATED") return false;
  return a.vtpStatus === null || a.vtpStatus < VTP_CANCELLABLE_BELOW_STATUS;
}
