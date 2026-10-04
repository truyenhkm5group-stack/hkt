import { clipBytes, normalizeVtpPhone, productNameOf, type DraftProblem } from "@/lib/constants/carrier-vtp";
import type { CarrierDraft, CarrierQuote } from "@/lib/carriers/types";

/**
 * ═══════════ GIAO HÀNG NHANH (GHN) CỦA TỔ CHỨC — HẰNG SỐ VÀ HÀM THUẦN (POS tự chủ · docs/verticals/pos-tu-chu.md) ═══════════
 *
 * Kết nối «ghn-carrier»: Token API + ShopId của CHÍNH tổ chức (shop tự lấy ở developer.ghn.vn → Quản lý token). Tệp THUẦN:
 * không CSDL, không biến môi trường — dùng chung cho hàm kiểm tra kết nối, client (lib/integrations/ghn/client.ts), adapter
 * (lib/carriers/adapters/ghn.ts) và bài kiểm không cần mạng.
 *
 * Tên trường đọc từ tài liệu chính thức developer.ghn.vn ngày 04/10/2026: Create Order · Preview Order · Cancel Order · Print
 * Order · Get Province (New) · Get Ward (New) · Get Shop · Order Status Callback.
 *
 * ĐỊA GIỚI MỚI: `is_new_to_address: true` ⇒ chỉ tỉnh + xã (bỏ cấp huyện, sau sáp nhập 01/07/2025). Tên tỉnh / xã phải là
 * tên CHUẨN của danh mục GHN — ERP so khớp tên trên đơn với `name` + `extension_names` của danh mục; không khớp DUY NHẤT thì
 * người bấm chọn, KHÔNG đoán.
 */

export const GHN_CARRIER_CONNECTOR = "ghn-carrier";

/** Địa chỉ API — HẰNG SỐ trong mã: người dùng chỉ nhập token + mã shop, không có đường nào đưa token đi chỗ khác. */
export const GHN_API = "https://online-gateway.ghn.vn/shiip/public-api";
/** Trang in nhãn của GHN: thay token in (gen-token, sống ~30 phút) vào `token`. */
export const GHN_PRINT_URL = "https://online-gateway.ghn.vn/a5/public-api/printA5";

export const GHN_TOKEN_PATTERN = /^[A-Za-z0-9-]{20,80}$/;
export const GHN_SHOP_ID_PATTERN = /^[0-9]{1,12}$/;

/** `required_note` — ba giá trị tài liệu cho phép. Mặc định: cho xem, không cho thử. */
export const GHN_REQUIRED_NOTES = ["CHOXEMHANGKHONGTHU", "KHONGCHOXEMHANG", "CHOTHUHANG"] as const;
export type GhnRequiredNote = (typeof GHN_REQUIRED_NOTES)[number];
export const GHN_REQUIRED_NOTE_LABEL: Record<GhnRequiredNote, string> = {
  CHOXEMHANGKHONGTHU: "Cho xem hàng, không cho thử",
  KHONGCHOXEMHANG: "Không cho xem hàng",
  CHOTHUHANG: "Cho thử hàng",
};

/** Trần tài liệu: cân ≤ 50.000 g; thu hộ ≤ 50.000.000; kích thước ≤ 200 cm. */
export const GHN_MAX_WEIGHT_G = 50_000;
export const GHN_MAX_COD = 50_000_000;
/** `service_type_id`: 2 = hàng nhẹ dưới 20 kg · 5 = hàng nặng từ 20 kg (tài liệu Create Order). */
export const GHN_HEAVY_FROM_G = 20_000;
/**
 * Kích thước gói bắt buộc với GHN nhưng ERP không giữ kích thước sản phẩm ⇒ một hộp quy ước 20×15×10 cm (dưới ngưỡng quy
 * đổi trọng lượng của hàng nhẹ thông thường). GHN cân / đo lại khi lấy hàng và báo `update_weight` nếu khác.
 */
export const GHN_DEFAULT_BOX_CM = { length: 20, width: 15, height: 10 } as const;

export function ghnServiceType(weightGrams: number): 2 | 5 {
  return weightGrams >= GHN_HEAVY_FROM_G ? 5 : 2;
}

export const GHN_SERVICE_LABEL: Record<2 | 5, string> = { 2: "Hàng nhẹ (dưới 20 kg)", 5: "Hàng nặng (từ 20 kg)" };

// ───────────────────────────── ĐỌC TÊN ĐỊA GIỚI ─────────────────────────────

/** Bỏ dấu, chữ thường, gộp khoảng trắng — «Thành phố Hồ Chí Minh» ⇒ «thanh pho ho chi minh». */
export function foldName(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "d")
    .toLowerCase()
    .replace(/[.,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const PREFIXES = ["thanh pho", "tinh", "tp", "phuong", "xa", "thi tran", "dac khu", "p", "x", "tt"];

/** Bỏ tiền tố hành chính ở đầu («phường 10», «tp hcm», «x. tân phú») — so khớp phần tên. */
export function coreName(text: string): string {
  let s = foldName(text);
  for (const p of PREFIXES) if (s.startsWith(`${p} `)) {
    s = s.slice(p.length + 1);
    break;
  }
  return s.trim();
}

export type GhnPlace = { id: number; name: string; aliases: string[] };

/** Một tên (tỉnh / xã) có khớp mục danh mục không — theo `name` và mọi `extension_names`, bỏ dấu + bỏ tiền tố. */
function placeMatches(place: GhnPlace, text: string): boolean {
  const want = coreName(text);
  if (!want) return false;
  return [place.name, ...place.aliases].some((n) => coreName(n) === want || foldName(n) === foldName(text));
}

/**
 * Tìm MỘT mục khớp tên. Nhiều mục / không mục nào ⇒ `null` (người chọn).
 *  · Có tên người bấm gõ / đơn lưu (`hint`) ⇒ CHỈ dùng tên đó. Không khớp thì báo — KHÔNG lặng lẽ thay bằng tên đọc được
 *    ở địa chỉ: người đã nói một xã thì đổi sang xã khác là đoán thay người.
 *  · Không có ⇒ thử từng phần của địa chỉ một dòng (tách dấu phẩy, từ CUỐI lên — tỉnh thường ở cuối, xã đứng trước).
 */
export function matchPlace(places: readonly GhnPlace[], hint: string, address = ""): GhnPlace | null {
  const tries = (hint.trim() ? [hint] : address.split(",").map((x) => x.trim()).reverse()).filter((x) => x && x.trim());
  for (const t of tries) {
    const hit = places.filter((p) => placeMatches(p, t));
    if (hit.length === 1) return hit[0];
  }
  return null;
}

export function parsePlaces(data: unknown): GhnPlace[] {
  if (!Array.isArray(data)) return [];
  return data
    .map((x) => {
      const r = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
      const id = typeof r._id === "number" ? r._id : Number(r._id);
      const status = r.status === undefined ? 1 : Number(r.status);
      return { id, name: typeof r.name === "string" ? r.name : "", aliases: Array.isArray(r.extension_names) ? r.extension_names.filter((a): a is string => typeof a === "string") : [], status };
    })
    .filter((p) => Number.isFinite(p.id) && p.name && p.status === 1)
    .map(({ id, name, aliases }) => ({ id, name, aliases }));
}

// ───────────────────────────── YÊU CẦU / PHẢN HỒI ─────────────────────────────

export function ghnProblems(d: CarrierDraft, opts: { needService: boolean }): DraftProblem[] {
  const out: DraftProblem[] = [];
  if (!d.receiver.name.trim()) out.push({ field: "receiver", message: "Đơn chưa có tên người nhận." });
  if (!/^0\d{9,10}$/.test(normalizeVtpPhone(d.receiver.phone))) out.push({ field: "receiver", message: "Số điện thoại người nhận không hợp lệ (10–11 chữ số, bắt đầu bằng 0)." });
  if (d.receiver.address.trim().length < 5) out.push({ field: "receiver", message: "Địa chỉ người nhận quá ngắn — cần số nhà / đường." });
  if (!Number.isInteger(d.weightGrams) || d.weightGrams < 1 || d.weightGrams > GHN_MAX_WEIGHT_G) out.push({ field: "weightGrams", message: `Trọng lượng phải là số gam nguyên từ 1 tới ${GHN_MAX_WEIGHT_G} (trần của GHN).` });
  if (!Number.isInteger(d.cod) || d.cod < 0 || d.cod > GHN_MAX_COD) out.push({ field: "cod", message: "Tiền thu hộ phải là số nguyên VND từ 0 tới 50.000.000 (trần của GHN)." });
  if (opts.needService && !["2", "5"].includes(d.serviceCode)) out.push({ field: "serviceCode", message: "Chọn dịch vụ từ bảng cước." });
  return out;
}

/** Thân yêu cầu Create / Preview (cùng một thân — Preview là chạy thử của Create, tài liệu GHN). */
export function ghnOrderBody(d: CarrierDraft, place: { province: string; ward: string }, opts: { requiredNote: GhnRequiredNote; defaultNote: string }): Record<string, unknown> {
  const service = d.serviceCode === "5" ? 5 : ghnServiceType(d.weightGrams);
  return {
    client_order_code: d.reference.slice(0, 50),
    // Cước do SHOP trả (1): phí ship khách trả đã nằm trong tiền đơn, thu hộ là đúng số khách còn nợ — không cộng cước lần hai.
    payment_type_id: 1,
    required_note: opts.requiredNote,
    note: clipBytes(d.note || opts.defaultNote, 500),
    to_name: clipBytes(d.receiver.name, 200),
    to_phone: normalizeVtpPhone(d.receiver.phone),
    to_address: clipBytes(d.receiver.address, 500),
    to_ward_name: place.ward,
    to_province_name: place.province,
    is_new_to_address: true,
    cod_amount: d.cod,
    // Khai giá trị đơn, KHÔNG mua bảo hiểm (bảo hiểm tính phí riêng — shop bật ở GHN nếu muốn).
    order_value: d.goodsValue,
    insurance_value: 0,
    weight: d.weightGrams,
    ...GHN_DEFAULT_BOX_CM,
    service_type_id: service,
    content: productNameOf(d.lines),
    items: d.lines.map((l) => ({ name: clipBytes(l.name, 300), quantity: Math.max(1, l.quantity), price: Math.max(0, l.unitPrice), ...(l.weightGrams > 0 ? { weight: l.weightGrams } : {}), ...(service === 5 ? { ...GHN_DEFAULT_BOX_CM, weight: Math.max(1, l.weightGrams) } : {}) })),
  };
}

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** Phản hồi Preview ⇒ «bảng cước» một dòng (GHN chọn dịch vụ theo cân — tài liệu). */
export function ghnQuoteOf(data: unknown, d: CarrierDraft, place: { province: string; ward: string }): CarrierQuote {
  const r = rec(data);
  const fee = typeof r.total_fee === "number" ? Math.round(r.total_fee) : 0;
  const service = ghnServiceType(d.weightGrams);
  const eta = typeof r.expected_delivery_time === "string" && r.expected_delivery_time ? `dự kiến ${r.expected_delivery_time.slice(0, 10).split("-").reverse().join("/")}` : "";
  return {
    services: fee > 0 ? [{ code: String(service), name: GHN_SERVICE_LABEL[service], fee, eta, extras: [] }] : [],
    receiverAddressAsRead: `${place.ward}, ${place.province}`,
    senderAddressAsRead: null,
  };
}

/** Phản hồi Create ⇒ mã đơn GHN. Không có `order_code` ⇒ `null`. */
export function ghnCreatedOf(data: unknown): { trackingCode: string; fee: number } | null {
  const r = rec(data);
  const code = typeof r.order_code === "string" ? r.order_code.trim() : "";
  if (!code) return null;
  return { trackingCode: code, fee: typeof r.total_fee === "number" ? Math.round(r.total_fee) : 0 };
}

export function ghnPrintUrl(token: string): string {
  return `${GHN_PRINT_URL}?token=${encodeURIComponent(token)}`;
}

/** Huỷ được ở GHN khi hãng CHƯA cầm hàng — chặng chờ lấy (tài liệu: trạng thái đã qua thì `result: false`). */
export function ghnCancellable(a: { stage: string }): boolean {
  return a.stage === "PENDING" || a.stage === "UNKNOWN";
}

/** Đường dẫn webhook của tổ chức (token «<mã tổ chức>.<chữ ký>» do máy chủ cấp — lib/platform/webhooks.ts). */
export function ghnOrgWebhookPath(token: string): string {
  return `/api/webhooks/ghn-org/${token}`;
}
