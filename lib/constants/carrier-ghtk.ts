import { clipBytes, normalizeVtpPhone, type DraftProblem } from "@/lib/constants/carrier-vtp";
import type { CarrierDraft, CarrierQuote, CarrierServiceQuote } from "@/lib/carriers/types";

/**
 * ═══════════ GIAO HÀNG TIẾT KIỆM (GHTK) CỦA TỔ CHỨC — HẰNG SỐ VÀ HÀM THUẦN (POS tự chủ · docs/verticals/pos-tu-chu.md) ═══════════
 *
 * Kết nối «ghtk-carrier»: Token API + mã shop (X-Client-Source) của CHÍNH tổ chức (shop tự lấy ở khachhang.giaohangtietkiem.vn
 * → Thông tin shop → Cấu hình API). Tệp THUẦN: không CSDL, không biến môi trường — dùng chung cho hàm kiểm tra kết nối, client
 * (lib/integrations/ghtk/client.ts), adapter (lib/carriers/adapters/ghtk.ts) và bài kiểm không cần mạng.
 *
 * Tên trường đọc từ tài liệu chính thức api.ghtk.vn ngày 04/10/2026: Môi trường & xác thực · Xử lý mã lỗi · Đăng đơn (ver 1.5)
 * · Tính phí · In nhãn · Huỷ đơn · Danh sách kho hàng · Webhook.
 *
 * ĐỊA GIỚI MỚI: tài liệu đăng đơn khai `province` + `ward` BẮT BUỘC, `district` KHÔNG bắt buộc (2 cấp sau sáp nhập 01/07/2025),
 * và đòi `street` HOẶC `hamlet`. GHTK không công bố danh mục tỉnh / xã qua API — hãng tự đọc tên, nên ERP gửi đúng tên người
 * bấm xác nhận ở ô «Tỉnh / thành» + «Xã / phường» (mặc định lấy từ đơn), KHÔNG tự sửa tên.
 */

export const GHTK_CARRIER_CONNECTOR = "ghtk-carrier";

/** Địa chỉ API — HẰNG SỐ trong mã (tài liệu «Môi trường»): người dùng chỉ nhập token + mã shop. */
export const GHTK_API = "https://services.giaohangtietkiem.vn";

export const GHTK_TOKEN_PATTERN = /^[A-Za-z0-9._-]{20,120}$/;
/** Mã shop / mã đối tác gửi ở `X-Client-Source` (tài liệu: «mã shop hoặc mã đối tác»). */
export const GHTK_CLIENT_SOURCE_PATTERN = /^[A-Za-z0-9._-]{1,40}$/;

/** Hai cách chở (tài liệu: `transport` = road | fly; sai giá trị ⇒ GHTK lấy mặc định). */
export const GHTK_TRANSPORTS = ["road", "fly"] as const;
export type GhtkTransport = (typeof GHTK_TRANSPORTS)[number];
export const GHTK_TRANSPORT_LABEL: Record<GhtkTransport, string> = { road: "Đường bộ", fly: "Đường bay" };
/** Mã dịch vụ trong ERP (lõi nhận mã CHỮ HOA) ⇄ `transport` của GHTK. */
export function ghtkServiceCode(t: GhtkTransport): string {
  return t.toUpperCase();
}
export function ghtkTransportOf(serviceCode: string): GhtkTransport {
  return serviceCode.trim().toUpperCase() === "FLY" ? "fly" : "road";
}

/** Trần đối chiếu cho ô nhập (GHTK từ chối cụ thể theo gói dịch vụ của shop — trần ở đây chỉ chặn lỗi gõ). */
export const GHTK_MAX_WEIGHT_G = 50_000;
export const GHTK_MAX_COD = 20_000_000;
/** Ghi chú tối đa 120 ký tự (tài liệu Đăng đơn). */
export const GHTK_NOTE_MAX = 120;
/**
 * `hamlet` bắt buộc khi không có `street`. ERP không tách tên đường khỏi địa chỉ một dòng ⇒ gửi «Khác» (giá trị tài liệu dùng
 * cho địa chỉ không thuộc thôn / ấp cụ thể); địa chỉ chi tiết đi ở `address`.
 */
export const GHTK_HAMLET_OTHER = "Khác";

export type GhtkSender = { name: string; phone: string; address: string; province: string; ward: string };

// ───────────────────────────── YÊU CẦU / PHẢN HỒI ─────────────────────────────

export function ghtkProblems(d: CarrierDraft, sender: GhtkSender, opts: { needService: boolean }): DraftProblem[] {
  const out: DraftProblem[] = [];
  if (!sender.name.trim() || !sender.address.trim() || !sender.province.trim() || !sender.ward.trim()) out.push({ field: "sender", message: "Chưa khai đủ nơi lấy hàng (tên · địa chỉ · tỉnh · xã) ở kết nối GHTK của tổ chức." });
  if (!/^0\d{9,10}$/.test(normalizeVtpPhone(sender.phone))) out.push({ field: "sender", message: "Số điện thoại lấy hàng ở kết nối GHTK không hợp lệ." });
  if (!d.receiver.name.trim()) out.push({ field: "receiver", message: "Đơn chưa có tên người nhận." });
  if (!/^0\d{9,10}$/.test(normalizeVtpPhone(d.receiver.phone))) out.push({ field: "receiver", message: "Số điện thoại người nhận không hợp lệ (10–11 chữ số, bắt đầu bằng 0)." });
  if (d.receiver.address.trim().length < 5) out.push({ field: "receiver", message: "Địa chỉ người nhận quá ngắn — cần số nhà / đường." });
  if (!d.receiver.province.trim()) out.push({ field: "province", message: "GHTK cần tỉnh / thành của người nhận — điền ô «Tỉnh / thành»." });
  if (!d.receiver.ward.trim()) out.push({ field: "ward", message: "GHTK cần xã / phường của người nhận (địa giới mới) — điền ô «Xã / phường»." });
  if (!Number.isInteger(d.weightGrams) || d.weightGrams < 1 || d.weightGrams > GHTK_MAX_WEIGHT_G) out.push({ field: "weightGrams", message: `Trọng lượng phải là số gam nguyên từ 1 tới ${GHTK_MAX_WEIGHT_G}.` });
  if (!Number.isInteger(d.cod) || d.cod < 0 || d.cod > GHTK_MAX_COD) out.push({ field: "cod", message: "Tiền thu hộ phải là số nguyên VND từ 0 tới 20.000.000." });
  if (opts.needService && !GHTK_TRANSPORTS.map(ghtkServiceCode).includes(d.serviceCode)) out.push({ field: "serviceCode", message: "Chọn dịch vụ từ bảng cước." });
  return out;
}

/** Tham số tính phí (GET /services/shipment/fee — cân tính bằng GAM theo tài liệu). */
export function ghtkFeeQuery(d: CarrierDraft, sender: GhtkSender, transport: GhtkTransport): Record<string, string | number> {
  return {
    pick_province: sender.province,
    pick_ward: sender.ward,
    pick_address: sender.address,
    province: d.receiver.province,
    ward: d.receiver.ward,
    address: d.receiver.address,
    weight: d.weightGrams,
    value: d.goodsValue,
    transport,
    deliver_option: "none",
  };
}

/**
 * Thân Đăng đơn (POST /services/shipment/order/?ver=1.5).
 *  · `id` = mã ERP của LẦN GỬI — GHTK chặn trùng bằng nó (`ORDER_ID_EXIST` kèm mã GHTK của đơn đã có).
 *  · Cân tính bằng GAM (`weight_option: "gram"`) để khớp đúng số người nhập; `total_weight` đè tổng các dòng.
 *  · `is_freeship = 1`: cước do SHOP trả — phí ship khách trả đã nằm trong tiền đơn, `pick_money` là đúng số khách còn nợ.
 *  · `value` = giá trị hàng (GHTK tính bảo hiểm theo nó — tài liệu); không khai thêm thẻ / dịch vụ cộng thêm nào.
 */
export function ghtkOrderBody(d: CarrierDraft, sender: GhtkSender, defaultNote: string): Record<string, unknown> {
  const transport = ghtkTransportOf(d.serviceCode);
  const products = d.lines.map((l) => ({
    name: clipBytes(l.name, 300) || "Hàng hoá",
    quantity: Math.max(1, l.quantity),
    price: Math.max(0, l.unitPrice),
    weight: l.weightGrams > 0 ? l.weightGrams : Math.max(1, Math.round(d.weightGrams / Math.max(1, d.lines.length) / Math.max(1, l.quantity))),
  }));
  return {
    products: products.length ? products : [{ name: "Hàng hoá", quantity: 1, price: d.goodsValue, weight: d.weightGrams }],
    order: {
      id: d.reference.slice(0, 50),
      pick_name: clipBytes(sender.name, 200),
      pick_address: clipBytes(sender.address, 300),
      pick_province: sender.province,
      pick_ward: sender.ward,
      pick_tel: normalizeVtpPhone(sender.phone),
      name: clipBytes(d.receiver.name, 200),
      address: clipBytes(d.receiver.address, 300),
      province: d.receiver.province,
      ward: d.receiver.ward,
      hamlet: GHTK_HAMLET_OTHER,
      tel: normalizeVtpPhone(d.receiver.phone),
      note: (d.note.trim() || defaultNote).slice(0, GHTK_NOTE_MAX),
      is_freeship: 1,
      pick_money: d.cod,
      value: d.goodsValue,
      transport,
      pick_option: "cod",
      weight_option: "gram",
      total_weight: d.weightGrams,
    },
  };
}

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.round(n) : 0;
}

/** Một dòng bảng cước từ phản hồi Tính phí; GHTK nói tuyến KHÔNG phục vụ (`delivery: false`) ⇒ `null`. */
export function ghtkServiceOf(body: unknown, transport: GhtkTransport): CarrierServiceQuote | null {
  const fee = rec(rec(body).fee);
  if (fee.delivery !== true) return null;
  const total = num(fee.fee) + num(fee.insurance_fee);
  if (!(total > 0)) return null;
  const extras = Array.isArray(fee.extFees) ? fee.extFees.map((x) => rec(x)).map((x) => ({ code: String(x.type ?? ""), name: `${String(x.title ?? "Phụ phí")}: ${num(x.amount).toLocaleString("vi-VN")} ₫` })) : [];
  return { code: ghtkServiceCode(transport), name: GHTK_TRANSPORT_LABEL[transport], fee: total, eta: "", extras };
}

export function ghtkQuoteOf(services: readonly (CarrierServiceQuote | null)[], d: CarrierDraft, sender: GhtkSender): CarrierQuote {
  return {
    services: services.filter((s): s is CarrierServiceQuote => s !== null),
    receiverAddressAsRead: `${d.receiver.ward}, ${d.receiver.province}`,
    senderAddressAsRead: `${sender.ward}, ${sender.province}`,
  };
}

/**
 * Phản hồi Đăng đơn ⇒ mã GHTK (`label`). Hai đường hợp lệ:
 *  · `success: true` + `order.label`;
 *  · `success: false` + `error.code = ORDER_ID_EXIST` + `error.ghtk_label` — mã ERP này ĐÃ tạo đơn ở GHTK (lượt trước mất phản
 *    hồi giữa đường) ⇒ đó CHÍNH là đơn của lần gửi này, không phải lỗi (thử lại an toàn — `idempotentRetry`).
 * Không đọc được mã ⇒ `null`.
 */
export function ghtkCreatedOf(body: unknown): { trackingCode: string; fee: number; existed: boolean } | null {
  const r = rec(body);
  if (r.success === true) {
    const o = rec(r.order);
    const label = typeof o.label === "string" ? o.label.trim() : "";
    return label ? { trackingCode: label, fee: num(o.fee) + num(o.insurance_fee), existed: false } : null;
  }
  const e = rec(r.error);
  const existing = typeof e.ghtk_label === "string" ? e.ghtk_label.trim() : "";
  return e.code === "ORDER_ID_EXIST" && existing ? { trackingCode: existing, fee: 0, existed: true } : null;
}

/** Huỷ được ở GHTK khi hãng CHƯA cầm hàng (tài liệu Huỷ đơn: chỉ trạng thái 1 · 2 · 12) — theo chặng của CHÍNH bảng GHTK. */
export function ghtkCancellable(a: { stage: string }): boolean {
  return a.stage === "PENDING" || a.stage === "UNKNOWN";
}

/** Đường dẫn webhook của tổ chức (token «<mã tổ chức>.<chữ ký>» do máy chủ cấp — lib/platform/webhooks.ts). */
export function ghtkOrgWebhookPath(token: string): string {
  return `/api/webhooks/ghtk-org/${token}`;
}

/** Mã GHTK hợp lệ để đặt vào đường dẫn in / huỷ: chữ, số, dấu chấm, gạch (vd «S1.A1.17373471»). */
export const GHTK_LABEL_PATTERN = /^[A-Za-z0-9.-]{4,60}$/;
