/**
 * ═══════════ MƯỜI CÔNG CỤ CỦA CHATBOT BÁN HÀNG (0180) — CHỈ MÁY CHỦ ═══════════
 *
 * Tập ĐÓNG. Model chỉ ĐỀ NGHỊ gọi; máy chủ kiểm đầu vào (zod), đọc / ghi CSDL của tổ chức ngữ cảnh, và trả kết quả dạng
 * JSON. Không công cụ nào nhận GIÁ từ model: đơn giá luôn đọc lại từ `product_variants.retail_price` lúc gọi — model gõ
 * sai giá cũng không đi vào đơn.
 *
 * KÊNH:
 *  · `WEB` (trang chat công khai của tổ chức đã xuất bản) — ghi THẬT qua lõi sẵn có: khách = `createCustomerAsAgent`, đơn =
 *    `createOrderAsAgent` / `updateOrderAsAgent` (cùng zod, cùng phép tính tiền, cùng sự kiện `order.*` với đơn tạo tay —
 *    chốt đơn ⇒ `order.confirmed` ⇒ luật «báo nhóm vận hành»). Tác nhân là MÁY (luật 36).
 *  · `TEST` (khung thử trong ERP) — lượt ĐỌC là thật (giá, tồn), lượt GHI chỉ MÔ PHỎNG trong `state` của hội thoại: không
 *    khách, không đơn, không tin nhóm nào sinh ra khi chủ shop đang thử bot.
 *
 * CHỐT ĐƠN (`confirm_order`) chỉ khi: đã có đơn nháp, đủ người nhận / SĐT / địa chỉ, giá không đổi kể từ lúc tóm tắt, không
 * dòng nào vượt tồn KHẢ DỤNG đã biết, và `customer_confirmation` là nguyên văn một đoạn trong câu CUỐI của khách — model
 * không tự chốt thay khách được.
 */
import { and, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import type { AiToolDef } from "@/lib/ai/provider";
import { freeSlots, slotBookable, vnDayOffset, vnInstant, WEEKDAY_LABEL } from "@/lib/constants/booking";
import { manualOrderShortCode, manualOrderTotals } from "@/lib/constants/manual-orders";
import { formatVND } from "@/lib/format";
import { quoteUnitPrice, type PriceListBook } from "@/lib/constants/price-lists";
import { priceBooksFor } from "@/lib/queries/price-lists";
import { createCustomerAsAgent, normalizeCustomerPhone } from "@/lib/records/customer-create";
import { activeAppointmentRanges, createAppointmentAsAgent } from "@/lib/records/appointments";
import { createOrderAsAgent, updateOrderAsAgent, type OrderAgent } from "@/lib/records/order-create";
import { notifySalesChatBooking, notifySalesChatHandoff } from "@/lib/sales-chatbot/alerts";
import { freeShipVerdict, variantWeightGrams, type ShipVerdict } from "@/lib/sales-chatbot/shipping";
import { foldVi, searchCatalog, sellableCatalog, stockFor, type CatalogItem } from "@/lib/sales-chatbot/catalog";
import type { ChatChannel, SalesChatbotConfig, SalesTool } from "@/lib/sales-chatbot/config";
import { renderQuickReplyForSend } from "@/lib/sales-chatbot/quick-replies";
import { repeatsRecent } from "@/lib/sales-chatbot/quick-replies-shared";
import type { PancakeThreadProfile, ReturningCustomer } from "@/lib/sales-chatbot/returning";

export type CartLine = { variantId: string; quantity: number };
export type Recipient = { name: string; phone: string; address: string; province: string };
import { SALES_STAGE_LABEL, type SalesStage } from "@/lib/sales-chatbot/stages";

export { SALES_STAGE_LABEL, SALES_STAGES, type SalesStage } from "@/lib/sales-chatbot/stages";

export type ChatState = {
  /** `at` = lần ĐẦU khách để lại SĐT này (02/10/2026 — báo cáo chi phí AI / SĐT theo ngày); dòng cũ không có mốc. */
  /** `savedAddress` = địa chỉ do MÁY CHỦ điền từ đơn cũ khớp qua SĐT (`use_saved_address`) — bot chỉ thấy bản đã che. */
  customer?: { id: string | null; name: string; phone: string; address: string; province: string; simulated: boolean; at?: string; savedAddress?: boolean };
  /** `shownTurn` = lượt (seq tin khách) bot lên / sửa đơn nháp và đọc tóm tắt — chốt chỉ ở lượt SAU (khách đã thấy tóm tắt). */
  draft?: { orderId: string | null; lines: CartLine[]; unitPrices: Record<string, number>; recipient: Recipient; note: string; simulated: boolean; shownTurn?: number };
  confirmed?: { orderId: string | null; simulated: boolean; total: number; at: string };
  handoff?: { reason: string; at: string };
  stage?: SalesStage;
  /** Đã gửi câu upsell (chỉ MỘT lần mỗi hội thoại). */
  upsellSent?: boolean;
  /** Câu upsell không gửi được (thiếu số ERP) — không chặn lên đơn mãi vì nó. */
  upsellUnavailable?: boolean;
  declined?: { reason: string; at: string };
  /** Lịch hẹn bot đã đặt trong hội thoại này (một hội thoại một lịch — đổi / huỷ là việc của người). */
  appointment?: { id: string | null; service: string; startsAt: string; name: string; phone: string; simulated: boolean; at: string };
  /** Mốc tin fanpage (page / khách bị bỏ qua) đã chép vào lịch sử của bot — `appendContextMessages`. */
  mirroredUntil?: string;
  /** Hồ sơ hội thoại đọc từ Pancake (SĐT đã ghi nhận, mã Facebook, tin cũ trước khi bot vào) — `lib/sales-chatbot/returning.ts`. */
  returning?: PancakeThreadProfile;
};

/** Công cụ QUY TRÌNH — luôn bật (không nằm trong `allowedTools` đã lưu của tổ chức, nên công cụ mới tới được mọi tổ chức). */
export const PROCESS_TOOLS = ["send_quick_reply", "set_sales_stage", "lookup_customer", "mark_declined"] as const;
export type ProcessTool = (typeof PROCESS_TOOLS)[number];

/** Công cụ ĐẶT LỊCH — chỉ khi shop bật «Nhận đặt lịch qua chat» VÀ tổ chức bật module Lịch hẹn (`ToolContext.bookingOn`). */
export const BOOKING_TOOLS = ["find_booking_slots", "book_appointment"] as const;
export type BookingTool = (typeof BOOKING_TOOLS)[number];

export type ToolContext = {
  conversationId: string;
  channel: ChatChannel;
  config: SalesChatbotConfig;
  state: ChatState;
  /** Câu mẫu đang bật, mã ngắn Q1… như trong lời nhắc (`quickReplyCatalog`). */
  quickReplies?: readonly { code: string; id: string; title: string; upsell: boolean }[];
  /** Câu CUỐI khách gõ (chữ thô) — `confirm_order` đối chiếu lời xác nhận với câu này. */
  lastUserText: string;
  agent: OrderAgent;
  /** Khách cũ máy chủ đã nhận ra (`findReturningCustomer`) — nguồn của `create_customer` + `use_saved_address`. */
  returning?: ReturningCustomer | null;
  /** Câu shop vừa nói (`recentShopTexts`) — câu mẫu trùng một câu trong đó không gửi lại. */
  recentSaid?: readonly string[];
  /** Shop bật đặt lịch qua chat VÀ module Lịch hẹn đang bật — engine tính, công cụ đặt lịch chỉ chạy khi `true`. */
  bookingOn?: boolean;
  /** Đồng hồ của lượt (kiểm thử truyền vào; mặc định bây giờ). */
  now?: Date;
  /** Mã lượt = seq tin khách của lượt này (engine). Thiếu (bài kiểm gọi lẻ công cụ) ⇒ không xét «cùng lượt». */
  turn?: number;
};

/**
 * `deliver` = câu mẫu máy chủ GỬI NGUYÊN VĂN cho khách (đã điền số ERP) + ảnh; `requireHuman` = công cụ thấy điều bất thường
 * (giá thiếu, tồn âm) ⇒ engine chuyển hội thoại sang CẦN NGƯỜI XỬ LÝ, không để AI tự quyết.
 */
export type ToolOutcome = { content: string; isError: boolean; summary: string; state: ChatState; deliver?: { text: string; imageIds: string[]; quickReplyId: string }; requireHuman?: string };

const itemsZ = z.array(z.object({ variant_id: z.string().min(1).max(200), quantity: z.number().int().min(1).max(10_000) }).strict()).min(1).max(30);

const DEFS: Record<SalesTool, AiToolDef> = {
  search_products: {
    name: "search_products",
    description: "Tìm sản phẩm ĐANG BÁN của shop theo tên / mô tả khách gõ (không dấu cũng được). Trả mã mẫu (variant_id), tên, quy cách, giá hiện tại. Luôn dùng trước khi báo giá hay lên đơn.",
    inputSchema: { type: "object", properties: { query: { type: "string", description: "Từ khoá khách gõ, vd «chả mực»" } }, required: ["query"], additionalProperties: false },
    kind: "read",
  },
  get_product: {
    name: "get_product",
    description: "Chi tiết MỘT mẫu mã: tên, quy cách, đơn vị bán, hướng dẫn bảo quản / sử dụng, giá hiện tại.",
    inputSchema: { type: "object", properties: { variant_id: { type: "string" } }, required: ["variant_id"], additionalProperties: false },
    kind: "read",
  },
  get_current_price: {
    name: "get_current_price",
    description: "Giá bán HIỆN TẠI của một mẫu mã, đọc từ ERP ngay lúc gọi. price = null nghĩa là mã chưa có giá — không được báo giá. Có quantity ⇒ giá cho đúng số lượng đó (bảng giá sỉ theo bậc, nếu shop bật); `tiers` = các bậc «mua từ» của mẫu mã.",
    inputSchema: { type: "object", properties: { variant_id: { type: "string" }, quantity: { type: "integer", minimum: 1 } }, required: ["variant_id"], additionalProperties: false },
    kind: "read",
  },
  check_inventory: {
    name: "check_inventory",
    description: "Kiểm tồn KHẢ DỤNG (đã trừ đơn đã chốt chưa giao) cho từng dòng. stock_known = false nghĩa là kho CHƯA xác nhận tồn — nói với khách là nhân viên sẽ kiểm, KHÔNG nói còn hàng hay hết hàng.",
    inputSchema: { type: "object", properties: { items: { type: "array", items: { type: "object", properties: { variant_id: { type: "string" }, quantity: { type: "integer", minimum: 1 } }, required: ["variant_id", "quantity"], additionalProperties: false } } }, required: ["items"], additionalProperties: false },
    kind: "read",
  },
  calculate_cart: {
    name: "calculate_cart",
    description: "Tính tiền giỏ hàng bằng GIÁ HIỆN TẠI của ERP: từng dòng (SL × đơn giá = thành tiền), tiền hàng, phí ship theo chính sách shop, tổng thu khi giao (COD). Không tự cộng nhẩm — luôn dùng công cụ này.",
    inputSchema: { type: "object", properties: { items: { type: "array", items: { type: "object", properties: { variant_id: { type: "string" }, quantity: { type: "integer", minimum: 1 } }, required: ["variant_id", "quantity"], additionalProperties: false } } }, required: ["items"], additionalProperties: false },
    kind: "read",
  },
  create_customer: {
    name: "create_customer",
    description:
      "Lưu thông tin người mua sau khi khách đã cho: họ tên, số điện thoại, địa chỉ giao. SĐT đã có trong sổ ⇒ dùng lại đúng khách đó. KHÁCH CŨ có địa chỉ ĐÃ CHE và khách vừa xác nhận giao như lần trước ⇒ use_saved_address = true + customer_confirmation = nguyên văn lời xác nhận (bỏ trống phone / address — máy chủ tự điền).",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" }, phone: { type: "string" }, address: { type: "string" }, province: { type: "string" }, use_saved_address: { type: "boolean" }, customer_confirmation: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    },
    kind: "write",
  },
  create_draft_order: {
    name: "create_draft_order",
    description: "Lên ĐƠN NHÁP (chưa chốt, chưa giữ hàng) cho khách đã lưu: các dòng hàng, người nhận / SĐT / địa chỉ giao (nếu khác người mua), ghi chú giao hàng. Đơn giá do ERP điền.",
    inputSchema: {
      type: "object",
      properties: {
        items: { type: "array", items: { type: "object", properties: { variant_id: { type: "string" }, quantity: { type: "integer", minimum: 1 } }, required: ["variant_id", "quantity"], additionalProperties: false } },
        recipient_name: { type: "string" },
        recipient_phone: { type: "string" },
        address: { type: "string" },
        delivery_note: { type: "string" },
      },
      required: ["items"],
      additionalProperties: false,
    },
    kind: "write",
  },
  update_draft_order: {
    name: "update_draft_order",
    description: "Sửa đơn nháp đang có (đổi hàng / số lượng, người nhận, địa chỉ, ghi chú). Chỉ gửi phần muốn đổi; items gửi lên là DANH SÁCH ĐẦY ĐỦ mới.",
    inputSchema: {
      type: "object",
      properties: {
        items: { type: "array", items: { type: "object", properties: { variant_id: { type: "string" }, quantity: { type: "integer", minimum: 1 } }, required: ["variant_id", "quantity"], additionalProperties: false } },
        recipient_name: { type: "string" },
        recipient_phone: { type: "string" },
        address: { type: "string" },
        delivery_note: { type: "string" },
      },
      additionalProperties: false,
    },
    kind: "write",
  },
  confirm_order: {
    name: "confirm_order",
    description: "CHỐT đơn nháp SAU KHI đã đọc lại tóm tắt đầy đủ và khách trả lời đồng ý. customer_confirmation = NGUYÊN VĂN câu / đoạn khách vừa gõ để đồng ý (vd «ok chốt đơn»). Không gọi khi khách chưa đồng ý.",
    inputSchema: { type: "object", properties: { customer_confirmation: { type: "string" } }, required: ["customer_confirmation"], additionalProperties: false },
    kind: "write",
  },
  handoff_to_human: {
    name: "handoff_to_human",
    description: "Chuyển hội thoại cho nhân viên: khách yêu cầu gặp người, khiếu nại, hỏi điều mà ERP, thông tin shop và hướng dẫn thêm đều không trả lời được. Chưa hiểu ý khách thì hỏi lại khách, KHÔNG chuyển.",
    inputSchema: { type: "object", properties: { reason: { type: "string" } }, required: ["reason"], additionalProperties: false },
    kind: "write",
  },
};

const PROCESS_DEFS: Record<ProcessTool, AiToolDef> = {
  send_quick_reply: {
    name: "send_quick_reply",
    description: "Gửi NGUYÊN VĂN một CÂU TRẢ LỜI MẪU của shop (chữ + ảnh, giá đã điền từ ERP) cho khách. code = mã trong danh sách CÂU MẪU (Q1, Q2…). Sau khi gửi, KHÔNG nhắc lại nội dung câu mẫu — chỉ viết thêm câu hỏi ngắn tiếp theo nếu cần.",
    inputSchema: { type: "object", properties: { code: { type: "string" } }, required: ["code"], additionalProperties: false },
    kind: "read",
  },
  set_sales_stage: {
    name: "set_sales_stage",
    description: "Ghi BƯỚC hiện tại của quy trình bán: QUOTE (báo giá + xác định sản phẩm) · CONSULT (tư vấn + xử lý phản đối) · INFO (lấy thông tin khách) · UPSELL · CONFIRM (xác nhận / chốt). Gọi mỗi khi chuyển bước.",
    inputSchema: { type: "object", properties: { stage: { type: "string", enum: ["QUOTE", "CONSULT", "INFO", "UPSELL", "CONFIRM"] } }, required: ["stage"], additionalProperties: false },
    kind: "read",
  },
  lookup_customer: {
    name: "lookup_customer",
    description: "Kiểm tra KHÁCH CŨ theo số điện thoại khách vừa cho: đã mua bao nhiêu đơn, gợi ý địa chỉ cũ (đã che một phần). CHỈ để hỏi lại khách «giao về địa chỉ cũ … phải không ạ?» — không tự điền khi khách chưa xác nhận.",
    inputSchema: { type: "object", properties: { phone: { type: "string" } }, required: ["phone"], additionalProperties: false },
    kind: "read",
  },
  mark_declined: {
    name: "mark_declined",
    description: "Ghi nhận khách TỪ CHỐI RÕ RÀNG không mua (vd «thôi không lấy nữa», «không mua đâu»). Bot sẽ thôi nhắn follow-up. Không dùng khi khách chỉ phân vân / chê đắt.",
    inputSchema: { type: "object", properties: { reason: { type: "string" } }, required: ["reason"], additionalProperties: false },
    kind: "write",
  },
};

const BOOKING_DEFS: Record<BookingTool, AiToolDef> = {
  find_booking_slots: {
    name: "find_booking_slots",
    description: "Giờ còn nhận đặt lịch của MỘT ngày (giờ Việt Nam). date = YYYY-MM-DD. Trả `times` (HH:MM còn chỗ), `closed_reason` nếu cả ngày không nhận, và `next_available` = ngày gần nhất còn chỗ. Luôn dùng trước khi hứa giờ với khách.",
    inputSchema: { type: "object", properties: { date: { type: "string", description: "YYYY-MM-DD" } }, required: ["date"], additionalProperties: false },
    kind: "read",
  },
  book_appointment: {
    name: "book_appointment",
    description:
      "ĐẶT LỊCH sau khi đã đọc lại tóm tắt (dịch vụ, ngày, giờ, họ tên, SĐT) và khách ĐỒNG Ý. variant_id = dịch vụ (từ search_products), date = YYYY-MM-DD, time = HH:MM nằm trong `times` của find_booking_slots. customer_confirmation = NGUYÊN VĂN lời đồng ý trong câu cuối của khách.",
    inputSchema: {
      type: "object",
      properties: { variant_id: { type: "string" }, date: { type: "string" }, time: { type: "string" }, name: { type: "string" }, phone: { type: "string" }, note: { type: "string" }, customer_confirmation: { type: "string" } },
      required: ["variant_id", "date", "time", "name", "phone", "customer_confirmation"],
      additionalProperties: false,
    },
    kind: "write",
  },
};

export function toolDefsFor(cfg: SalesChatbotConfig, opts: { bookingOn?: boolean } = {}): AiToolDef[] {
  return [...cfg.allowedTools.map((t) => DEFS[t]), ...PROCESS_TOOLS.map((t) => PROCESS_DEFS[t]), ...(opts.bookingOn ? BOOKING_TOOLS.map((t) => BOOKING_DEFS[t]) : [])];
}

/** Lịch ĐANG HIỆU LỰC của một ngày VN (đệm hai đầu một ngày — lịch dài vắt qua nửa đêm vẫn được đếm). */
async function busyOfDay(day: string) {
  const start = vnInstant(day, "00:00");
  if (!start) return [];
  return activeAppointmentRanges(new Date(start.getTime() - 86_400_000), new Date(start.getTime() + 2 * 86_400_000));
}

/** Địa chỉ cũ ĐÃ CHE cho khách xác nhận: chỉ hai phần cuối (vd «…, Hà Nam, Thành phố Hải Phòng») — người gõ SĐT của người khác không đọc được số nhà. */
export function maskAddress(address: string): string {
  const parts = address.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length <= 1) return parts.length ? "…" : "";
  return `…, ${parts.slice(-2).join(", ")}`;
}

const price = (n: number | null) => (n === null ? "chưa có giá" : formatVND(n));

function itemView(it: CatalogItem) {
  return { variant_id: it.variantId, name: it.name, variant: it.variant || null, sku: it.sku, price: it.price, price_text: price(it.price), ...it.fields };
}

function ok(summary: string, data: unknown, state: ChatState): ToolOutcome {
  return { content: JSON.stringify(data), isError: false, summary, state };
}
function err(summary: string, message: string, state: ChatState): ToolOutcome {
  return { content: JSON.stringify({ error: message }), isError: true, summary, state };
}

type Priced = { ship: ShipVerdict; lines: { variantId: string; name: string; quantity: number; unitPrice: number; lineTotal: number }[]; subtotal: number; shippingFee: number | null; total: number | null; unpriced: string[]; missing: string[] };

/**
 * Bảng giá áp cho khách của hội thoại khi shop BẬT báo giá sỉ (`wholesalePricing`); TẮT ⇒ `null` = giá lẻ như trước. Khách
 * chưa nhận ra là ai (chưa tạo / chưa tra được) ⇒ chỉ bảng mặc định.
 */
async function booksForChat(cfg: SalesChatbotConfig, customerId: string | null): Promise<{ customerList: PriceListBook | null; defaultList: PriceListBook | null } | null> {
  return cfg.wholesalePricing ? priceBooksFor(customerId) : null;
}

/** Đơn giá của MỘT dòng: giá lẻ khi chưa bật bảng giá; bật ⇒ `quoteUnitPrice` — CÙNG hàm với form đơn tay. */
function unitPriceFor(it: CatalogItem, quantity: number, books: Awaited<ReturnType<typeof booksForChat>>): number | null {
  if (!books) return it.price;
  return quoteUnitPrice({ variantId: it.variantId, quantity, retailPrice: it.price, customerList: books.customerList, defaultList: books.defaultList })?.unitPrice ?? null;
}

/** `address` = địa chỉ giao (đơn nháp / khách đã lưu) — cho luật miễn ship theo khu vực; `null` khi chưa biết. */
async function priceLines(lines: readonly CartLine[], cfg: SalesChatbotConfig, customerId: string | null = null, address: string | null = null): Promise<Priced> {
  // Hai field quy cách của mẫu thực phẩm — nguồn khối lượng cho luật miễn ship khi cột weight chưa nhập.
  const catalog = await sellableCatalog(cfg.freeShipping.enabled ? ["net_weight", "package_size"] : []);
  const books = await booksForChat(cfg, customerId);
  const byId = new Map(catalog.map((c) => [c.variantId, c]));
  const out: Priced["lines"] = [];
  const unpriced: string[] = [];
  const missing: string[] = [];
  for (const l of lines) {
    const it = byId.get(l.variantId);
    const unit = it ? unitPriceFor(it, l.quantity, books) : null;
    if (!it) missing.push(l.variantId);
    else if (unit === null) unpriced.push(it.name);
    else out.push({ variantId: l.variantId, name: `${it.name}${it.variant ? ` (${it.variant})` : ""}`, quantity: l.quantity, unitPrice: unit, lineTotal: unit * l.quantity });
  }
  const subtotal = out.reduce((s, l) => s + l.lineTotal, 0);
  // Khối lượng đơn: một dòng không biết khối lượng ⇒ cả đơn KHÔNG xét ngưỡng khối lượng (không đoán).
  let weight: number | null = 0;
  for (const l of out) {
    const it = byId.get(l.variantId);
    const w = it ? variantWeightGrams(it.weightGrams, it.variant, it.name, it.fields.net_weight ?? "", it.fields.package_size ?? "") : null;
    weight = weight === null || w === null ? null : weight + w * l.quantity;
  }
  const ship = freeShipVerdict(cfg.freeShipping, subtotal, weight, address, formatVND);
  const shippingFee = ship.kind === "FREE" ? 0 : cfg.shippingFee;
  return { ship, lines: out, subtotal, shippingFee, total: shippingFee === null ? null : subtotal + shippingFee, unpriced, missing };
}

function mergeLines(lines: readonly CartLine[]): CartLine[] {
  const m = new Map<string, number>();
  for (const l of lines) m.set(l.variantId, (m.get(l.variantId) ?? 0) + l.quantity);
  return [...m.entries()].map(([variantId, quantity]) => ({ variantId, quantity }));
}

function cartView(p: Priced) {
  return {
    lines: p.lines.map((l) => ({ variant_id: l.variantId, name: l.name, quantity: l.quantity, unit_price: l.unitPrice, line_total: l.lineTotal, text: `${l.name}: ${l.quantity} × ${formatVND(l.unitPrice)} = ${formatVND(l.lineTotal)}` })),
    subtotal: p.subtotal,
    subtotal_text: formatVND(p.subtotal),
    shipping_fee: p.shippingFee,
    shipping_text:
      p.ship.kind === "FREE"
        ? "Miễn phí ship"
        : p.ship.kind === "FREE_IF_AREA"
          ? p.ship.text
          : `${p.shippingFee === null ? "Phí ship: nhân viên sẽ báo sau (shop chưa khai phí ship cố định)" : formatVND(p.shippingFee)}${p.ship.kind === "BELOW" ? ` · ${p.ship.text}` : ""}`,
    cod_total: p.total,
    cod_total_text: p.total !== null ? formatVND(p.total) : p.ship.kind === "FREE_IF_AREA" ? `${formatVND(p.subtotal)} (miễn ship nếu giao trong khu vực miễn ship; ngoài khu vực + phí ship báo sau)` : `${formatVND(p.subtotal)} + phí ship (báo sau)`,
  };
}

function orderInput(state: ChatState, draft: NonNullable<ChatState["draft"]>, priced: Priced, stage: "NEW" | "CONFIRMED", cfg: SalesChatbotConfig, channel: ChatChannel) {
  const notes = [
    draft.note,
    priced.ship.kind === "FREE_IF_AREA" ? "Miễn ship NẾU địa chỉ thuộc khu vực miễn ship — nhân viên kiểm địa chỉ trước khi giao." : priced.shippingFee === null ? "Phí ship: CHƯA BÁO — nhân viên cập nhật trước khi giao." : "",
  ].filter((x) => x.trim());
  return {
    customerId: state.customer?.id ?? "",
    stage,
    lines: priced.lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity, unitPrice: l.unitPrice, discount: 0 })),
    orderDiscount: 0,
    shippingFee: priced.shippingFee ?? 0,
    note: notes.join("\n").slice(0, 2000),
    channel: channel === "FANPAGE" ? "Chatbot fanpage" : "Chatbot web",
    recipient: { name: draft.recipient.name, phone: draft.recipient.phone, address: draft.recipient.address, province: draft.recipient.province },
  };
}

function recipientFrom(input: { recipient_name?: string; recipient_phone?: string; address?: string }, base: Recipient): Recipient {
  return {
    name: input.recipient_name?.trim() || base.name,
    phone: input.recipient_phone?.trim() || base.phone,
    address: input.address?.trim() || base.address,
    province: input.address?.trim() ? "" : base.province,
  };
}

/** Người nhận bot được đọc cho khách: địa chỉ máy chủ điền từ đơn cũ (khớp qua SĐT) chỉ hiện bản ĐÃ CHE. */
function recipientView(r: Recipient, state: ChatState): Recipient & { address_note?: string } {
  if (!state.customer?.savedAddress || r.address !== state.customer.address) return r;
  return { ...r, address: maskAddress([r.address, r.province].filter((x) => x.trim()).join(", ")), province: "", address_note: "Địa chỉ cũ của khách (đã che) — đọc đúng như vậy, không đoán số nhà." };
}

function failureText(r: { errors: { field: string; message: string }[] }): string {
  return r.errors.map((e) => e.message).join(" · ") || "Không ghi được.";
}

export async function executeTool(name: string, rawInput: unknown, ctx: ToolContext): Promise<ToolOutcome> {
  const state: ChatState = structuredClone(ctx.state);
  const isBooking = (BOOKING_TOOLS as readonly string[]).includes(name);
  if (isBooking ? !ctx.bookingOn : !(ctx.config.allowedTools as readonly string[]).includes(name) && !(PROCESS_TOOLS as readonly string[]).includes(name)) return err(`${name}: không được bật`, `Công cụ «${name}» không được bật cho bot này.`, state);
  const input = (rawInput && typeof rawInput === "object" ? rawInput : {}) as Record<string, unknown>;
  const simulated = ctx.channel === "TEST";
  const now = ctx.now ?? new Date();
  switch (name as SalesTool | ProcessTool | BookingTool) {
    case "find_booking_slots": {
      const day = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).safeParse(input.date);
      if (!day.success) return err("Giờ trống: sai ngày", "date phải dạng YYYY-MM-DD (giờ Việt Nam).", state);
      const cfg = ctx.config.booking;
      const slots = freeSlots(cfg, day.data, now, await busyOfDay(day.data));
      let next: { date: string; weekday: string; times: string[] } | null = null;
      if (!slots.times.length) {
        for (let i = 0; i <= cfg.horizonDays && !next; i++) {
          const d = vnDayOffset(now, i);
          if (d <= day.data) continue;
          const s = freeSlots(cfg, d, now, await busyOfDay(d));
          if (s.times.length) next = { date: d, weekday: s.weekday, times: s.times.slice(0, 6) };
        }
      }
      return ok(`Giờ trống ${day.data}: ${slots.times.length}`, { date: day.data, weekday: slots.weekday, times: slots.times, closed_reason: slots.closedReason, next_available: next, today: vnDayOffset(now), duration_minutes: cfg.slotMinutes }, state);
    }
    case "book_appointment": {
      if (state.appointment) return err("Đặt lịch: đã đặt", `Hội thoại này đã đặt lịch «${state.appointment.service}» lúc ${state.appointment.startsAt} — muốn đổi / huỷ thì chuyển nhân viên (handoff_to_human «Lịch hẹn — …»).`, state);
      const v = z
        .object({ variant_id: z.string().trim().min(1).max(200), date: z.string().trim(), time: z.string().trim(), name: z.string().trim().min(2).max(200), phone: z.string().trim().min(8).max(30), note: z.string().trim().max(500).optional(), customer_confirmation: z.string().trim().min(2).max(300) })
        .safeParse(input);
      if (!v.success) return err("Đặt lịch: thiếu thông tin", "Cần dịch vụ, ngày, giờ, họ tên, số điện thoại và lời đồng ý của khách.", state);
      if (!foldVi(ctx.lastUserText).includes(foldVi(v.data.customer_confirmation))) return err("Đặt lịch: khách chưa xác nhận", "customer_confirmation phải là nguyên văn lời đồng ý trong câu CUỐI của khách. Khách chưa xác nhận ⇒ đọc lại tóm tắt lịch và hỏi.", state);
      const phone = normalizeCustomerPhone(v.data.phone);
      if (!phone) return err("Đặt lịch: SĐT không hợp lệ", "Số điện thoại chỉ gồm 8–15 chữ số.", state);
      const service = (await sellableCatalog([])).find((c) => c.variantId === v.data.variant_id);
      if (!service) return err("Đặt lịch: không có dịch vụ", "Không có dịch vụ này (hoặc đã thôi bán) — search_products lại.", state);
      const start = vnInstant(v.data.date, v.data.time);
      if (!start) return err("Đặt lịch: sai ngày giờ", "date = YYYY-MM-DD, time = HH:MM.", state);
      const cfg = ctx.config.booking;
      const okSlot = slotBookable(cfg, v.data.date, v.data.time, now, await busyOfDay(v.data.date));
      if (!okSlot.ok) return err("Đặt lịch: giờ không nhận", `${okSlot.reason} Gọi find_booking_slots và đề xuất giờ khác.`, state);
      const label = `${service.name}${service.variant ? ` (${service.variant})` : ""}`;
      const when = `${v.data.time} ${WEEKDAY_LABEL[new Date(`${v.data.date}T00:00:00Z`).getUTCDay()]} ${v.data.date}`;
      let appointmentId: string | null = null;
      if (!simulated) {
        const c = await createCustomerAsAgent(ctx.agent, { name: v.data.name, phone, address: state.customer?.phone === phone ? state.customer.address : "", province: state.customer?.phone === phone ? state.customer.province : "" }, { addressOptional: true });
        if (!c.ok) return err("Đặt lịch: lỗi lưu khách", failureText(c), state);
        const r = await createAppointmentAsAgent(ctx.agent, { customerId: c.id, variantId: service.variantId, startsAt: start, durationMin: cfg.slotMinutes, note: ["Đặt qua chatbot.", v.data.note ?? ""].filter(Boolean).join(" ") }, cfg.capacity);
        if (!r.ok) return err("Đặt lịch: không giữ được chỗ", `${failureText(r)} Gọi find_booking_slots và đề xuất giờ khác.`, state);
        appointmentId = r.id;
        await notifySalesChatBooking(r.id, ctx.conversationId, `${label} · ${when} · ${v.data.name} · ${phone}`, now).catch(() => undefined);
      }
      state.appointment = { id: appointmentId, service: label, startsAt: when, name: v.data.name, phone, simulated, at: now.toISOString() };
      state.stage = "DONE";
      return ok(`${simulated ? "(Thử) " : ""}Đã đặt lịch · ${label} · ${when}`, { booked: true, simulated, service: label, when, name: v.data.name, phone, duration_minutes: cfg.slotMinutes, note: simulated ? "Khung thử: KHÔNG ghi lịch thật." : "Lễ tân sẽ xếp kỹ thuật viên; nói với khách shop sẽ liên hệ xác nhận nếu cần." }, state);
    }
    case "search_products": {
      const q = z.string().trim().min(1).max(200).safeParse(input.query);
      if (!q.success) return err("Tìm: thiếu từ khoá", "Thiếu từ khoá tìm.", state);
      const found = searchCatalog(await sellableCatalog(ctx.config.productFields), q.data);
      return ok(`Tìm «${q.data}»: ${found.length} kết quả`, { results: found.map(itemView), note: found.length ? undefined : "Không có sản phẩm nào khớp — hỏi lại khách hoặc gợi ý sản phẩm khác." }, state);
    }
    case "get_product":
    case "get_current_price": {
      const id = z.string().min(1).max(200).safeParse(input.variant_id);
      if (!id.success) return err(`${name}: thiếu mã`, "Thiếu variant_id.", state);
      const it = (await sellableCatalog(ctx.config.productFields)).find((c) => c.variantId === id.data);
      if (!it) return err(`${name}: không có mã`, "Không có mẫu mã này (hoặc đã thôi bán).", state);
      if (name === "get_current_price") {
        const qty = z.number().int().min(1).max(100_000).safeParse(input.quantity);
        const books = await booksForChat(ctx.config, state.customer?.id ?? null);
        if (!books) return ok(`Giá ${it.name}: ${price(it.price)}`, { variant_id: it.variantId, name: it.name, price: it.price, price_text: price(it.price), as_of: new Date().toISOString() }, state);
        const quantity = qty.success ? qty.data : 1;
        const unit = unitPriceFor(it, quantity, books);
        // Bậc của bảng đang áp cho mẫu mã này: bảng của khách nếu bảng ấy có mẫu mã, không thì bảng mặc định.
        const list = [books.customerList, books.defaultList].find((b) => b?.tiers.some((t) => t.variantId === it.variantId)) ?? null;
        const tiers = (list?.tiers ?? []).filter((t) => t.variantId === it.variantId).sort((a, b) => a.minQuantity - b.minQuantity).map((t) => ({ min_quantity: t.minQuantity, unit_price: t.unitPrice, text: `từ ${t.minQuantity}: ${formatVND(t.unitPrice)}` }));
        return ok(`Giá ${it.name} × ${quantity}: ${price(unit)}`, { variant_id: it.variantId, name: it.name, quantity, price: unit, price_text: price(unit), retail_price: it.price, tiers, as_of: new Date().toISOString() }, state);
      }
      return ok(`Chi tiết ${it.name}`, itemView(it), state);
    }
    case "check_inventory": {
      const items = itemsZ.safeParse(input.items);
      if (!items.success) return err("Kiểm tồn: sai đầu vào", "items phải là danh sách { variant_id, quantity ≥ 1 }.", state);
      const stock = await stockFor(items.data.map((i) => i.variant_id));
      const rows = mergeLines(items.data.map((i) => ({ variantId: i.variant_id, quantity: i.quantity }))).map((l) => {
        const s = stock.get(l.variantId);
        if (!s) return { variant_id: l.variantId, exists: false };
        return { variant_id: l.variantId, quantity: l.quantity, stock_known: s.stockKnown, available: s.available, enough: s.stockKnown ? (s.available ?? 0) >= l.quantity : null };
      });
      const short = rows.filter((r) => "enough" in r && r.enough === false).length;
      const unknown = rows.filter((r) => "stock_known" in r && r.stock_known === false).length;
      const negative = rows.filter((r) => "available" in r && typeof r.available === "number" && r.available < 0).length;
      const out = ok(`Kiểm tồn ${rows.length} dòng${short ? ` · ${short} thiếu` : ""}${unknown ? ` · ${unknown} chưa biết tồn` : ""}`, { items: rows }, state);
      // Tồn ÂM = sổ kho đang sai (xuất nhiều hơn nhập) — không bán tiếp theo con số đó, người kiểm.
      return negative ? { ...out, requireHuman: `Tồn kho bất thường: ${negative} mã tồn khả dụng âm` } : out;
    }
    case "calculate_cart": {
      const items = itemsZ.safeParse(input.items);
      if (!items.success) return err("Tính giỏ: sai đầu vào", "items phải là danh sách { variant_id, quantity ≥ 1 }.", state);
      const knownAddress = state.draft ? [state.draft.recipient.address, state.draft.recipient.province].join(", ") : state.customer ? [state.customer.address, state.customer.province].join(", ") : null;
      const priced = await priceLines(mergeLines(items.data.map((i) => ({ variantId: i.variant_id, quantity: i.quantity }))), ctx.config, state.customer?.id ?? null, knownAddress);
      if (priced.missing.length) return err("Tính giỏ: mã không có", `Không có mẫu mã: ${priced.missing.join(", ")}.`, state);
      if (priced.unpriced.length) return { ...err("Tính giỏ: mã chưa có giá", `Chưa có giá: ${priced.unpriced.join(", ")} — không báo giá, chuyển nhân viên.`, state), requireHuman: `Giá bất thường: ${priced.unpriced.join(", ")} chưa có giá` };
      return ok(`Giỏ: ${formatVND(priced.subtotal)}${priced.total !== null ? ` · COD ${formatVND(priced.total)}` : ""}`, cartView(priced), state);
    }
    case "create_customer": {
      // KHÁCH CŨ: máy chủ điền SĐT + địa chỉ của lần mua trước — chỉ khi khách VỪA xác nhận (luật 3.12: gợi ý, không tự điền).
      let saved = false;
      let fields: Record<string, unknown> = input;
      if (input.use_saved_address === true) {
        const r = ctx.returning;
        if (!r) return err("Lưu khách: không có địa chỉ cũ", "Shop không có địa chỉ cũ của khách này — hỏi khách SĐT và địa chỉ.", state);
        const quote = z.string().trim().min(2).max(300).safeParse(input.customer_confirmation);
        if (!quote.success || !foldVi(ctx.lastUserText).includes(foldVi(quote.data))) return err("Lưu khách: khách chưa xác nhận địa chỉ cũ", "customer_confirmation phải là nguyên văn lời khách xác nhận giao về địa chỉ cũ, trong câu CUỐI của khách. Khách chưa xác nhận ⇒ hỏi lại.", state);
        const typed = typeof input.name === "string" ? input.name.trim() : "";
        fields = { name: typed.length >= 2 ? typed : r.name, phone: r.phone, address: r.address, province: r.province };
        saved = r.trust === "PHONE";
      }
      const v = z.object({ name: z.string().trim().min(2).max(200), phone: z.string().trim().min(8).max(30), address: z.string().trim().min(5).max(500), province: z.string().trim().max(100).optional() }).safeParse({ name: fields.name, phone: fields.phone, address: fields.address, province: fields.province || undefined });
      if (!v.success) return err("Lưu khách: thiếu thông tin", "Cần họ tên, số điện thoại (8–15 số) và địa chỉ giao đầy đủ.", state);
      // Giữ mốc lần đầu khi khách sửa tên / địa chỉ mà vẫn cùng SĐT — một SĐT chỉ «để lại» một lần.
      const firstAt = state.customer?.phone === v.data.phone && state.customer.at ? state.customer.at : new Date().toISOString();
      if (simulated) {
        state.customer = { id: null, name: v.data.name, phone: v.data.phone, address: v.data.address, province: v.data.province ?? "", simulated: true, at: firstAt, ...(saved ? { savedAddress: true } : {}) };
        return ok(`(Thử) lưu khách ${v.data.name}`, { customer_id: "thu-nghiem", simulated: true, note: "Khung thử: KHÔNG lưu khách thật." }, state);
      }
      const r = await createCustomerAsAgent(ctx.agent, { name: v.data.name, phone: v.data.phone, address: v.data.address, province: v.data.province });
      if (!r.ok) return err("Lưu khách: lỗi", failureText(r), state);
      state.customer = { id: r.id, name: v.data.name, phone: v.data.phone, address: v.data.address, province: v.data.province ?? "", simulated: false, at: firstAt, ...(saved ? { savedAddress: true } : {}) };
      return ok(r.existing ? `Khách cũ (${v.data.phone})` : `Đã lưu khách ${v.data.name}`, { customer_id: r.id, existing_customer: r.existing }, state);
    }
    case "create_draft_order":
    case "update_draft_order": {
      if (!state.customer) return err("Đơn nháp: chưa có khách", "Chưa lưu thông tin khách — gọi create_customer trước.", state);
      const v = z
        .object({ items: itemsZ.optional(), recipient_name: z.string().trim().max(120).optional(), recipient_phone: z.string().trim().max(30).optional(), address: z.string().trim().max(300).optional(), delivery_note: z.string().trim().max(500).optional() })
        .safeParse(input);
      if (!v.success) return err("Đơn nháp: sai đầu vào", "Đầu vào đơn nháp không hợp lệ.", state);
      const existing = state.draft;
      if (name === "create_draft_order" && !v.data.items) return err("Đơn nháp: thiếu hàng", "Đơn nháp cần items.", state);
      if (name === "update_draft_order" && !existing) return err("Sửa đơn: chưa có đơn nháp", "Chưa có đơn nháp — gọi create_draft_order.", state);
      // MỜI THÊM MÓN TRƯỚC KHI LÊN ĐƠN (chủ shop 02/10/2026, ảnh «Nguyễn Nga» / «Xuantra Tâm An»): shop đã chọn câu upsell
      // (kèm ảnh menu) ⇒ khách vừa gửi thông tin nhận hàng là lúc gửi nó, RỒI tóm tắt chốt đơn trong cùng lượt để khách nắm
      // thông tin. Máy chủ chặn lên đơn khi chưa mời — lời dặn trong lời nhắc thôi thì AI hay nhảy thẳng sang tóm tắt.
      const upsellEntry = ctx.quickReplies?.find((q) => q.upsell);
      if (name === "create_draft_order" && !existing && upsellEntry && !state.upsellSent && !state.upsellUnavailable) {
        return err("Đơn nháp: chưa mời thêm món", `Trước khi lên đơn phải mời thêm món ĐÚNG MỘT LẦN: gọi send_quick_reply với mã ${upsellEntry.code} (câu upsell kèm ảnh menu), rồi gọi lại create_draft_order và gửi tóm tắt chốt đơn trong cùng lượt.`, state);
      }
      if (state.confirmed) return err("Đơn đã chốt", "Đơn của hội thoại này đã chốt — muốn đổi thì chuyển nhân viên (handoff_to_human).", state);
      const base: Recipient = existing?.recipient ?? { name: state.customer.name, phone: state.customer.phone, address: state.customer.address, province: state.customer.province };
      const lines = v.data.items ? mergeLines(v.data.items.map((i) => ({ variantId: i.variant_id, quantity: i.quantity }))) : existing!.lines;
      const recipient = recipientFrom(v.data, base);
      const priced = await priceLines(lines, ctx.config, state.customer?.id ?? null, [recipient.address, recipient.province].join(", "));
      if (priced.missing.length) return err("Đơn nháp: mã không có", `Không có mẫu mã: ${priced.missing.join(", ")}.`, state);
      if (priced.unpriced.length) return { ...err("Đơn nháp: mã chưa có giá", `Chưa có giá: ${priced.unpriced.join(", ")}.`, state), requireHuman: `Giá bất thường: ${priced.unpriced.join(", ")} chưa có giá` };
      const draft = { ...(ctx.turn !== undefined ? { shownTurn: ctx.turn } : {}), orderId: existing?.orderId ?? null, lines, unitPrices: Object.fromEntries(priced.lines.map((l) => [l.variantId, l.unitPrice])), recipient, note: v.data.delivery_note ?? existing?.note ?? "", simulated };
      if (!simulated) {
        const payload = orderInput(state, draft, priced, "NEW", ctx.config, ctx.channel);
        const r = draft.orderId ? await updateOrderAsAgent(ctx.agent, draft.orderId, payload) : await createOrderAsAgent(ctx.agent, payload);
        if (!r.ok) return err("Đơn nháp: lỗi", failureText(r), state);
        draft.orderId = r.id;
      }
      state.draft = draft;
      const view = { order_code: draft.orderId ? `#${manualOrderShortCode(draft.orderId)}` : "(thử)", status: "Nháp — chưa chốt, chưa giữ hàng", simulated, ...cartView(priced), recipient: recipientView(draft.recipient, state), delivery_note: draft.note || null };
      return ok(`${simulated ? "(Thử) " : ""}${existing ? "Sửa" : "Lên"} đơn nháp · ${formatVND(priced.subtotal)}`, view, state);
    }
    case "confirm_order": {
      const quote = z.string().trim().min(2).max(300).safeParse(input.customer_confirmation);
      // KHÁCH PHẢI THẤY TÓM TẮT RỒI MỚI ĐỒNG Ý (03/10/2026, «Trần Nguyễn»): bot lên đơn + đọc tóm tắt + CHỐT trong cùng lượt,
      // lấy «Phải ngon nhé» — câu khách gõ TRƯỚC khi thấy tóm tắt — làm lời đồng ý. Đơn nháp / sửa đơn ở lượt này ⇒ chưa chốt.
      if (state.draft && !state.confirmed && ctx.turn !== undefined && state.draft.shownTurn === ctx.turn) {
        return err("Chốt: khách chưa thấy tóm tắt", "Đơn vừa lên / vừa sửa trong lượt này — khách CHƯA đọc tóm tắt. Gửi tóm tắt đơn rồi DỪNG, đợi khách trả lời đồng ý ở tin SAU mới gọi confirm_order.", state);
      }
      if (!state.draft) return err("Chốt: chưa có đơn nháp", "Chưa có đơn nháp để chốt.", state);
      if (state.confirmed) return ok("Đơn đã chốt từ trước", { already_confirmed: true, order_code: state.confirmed.orderId ? `#${manualOrderShortCode(state.confirmed.orderId)}` : "(thử)" }, state);
      if (!quote.success || !foldVi(ctx.lastUserText).includes(foldVi(quote.data))) {
        return err("Chốt: chưa có lời xác nhận của khách", "customer_confirmation phải là nguyên văn lời đồng ý trong câu CUỐI của khách. Khách chưa xác nhận ⇒ đọc lại tóm tắt và hỏi khách có đồng ý không.", state);
      }
      const d = state.draft;
      if (!d.recipient.name || !d.recipient.phone || !d.recipient.address) return err("Chốt: thiếu người nhận", "Thiếu tên / SĐT / địa chỉ người nhận.", state);
      const priced = await priceLines(d.lines, ctx.config, state.customer?.id ?? null, [d.recipient.address, d.recipient.province].join(", "));
      if (priced.missing.length || priced.unpriced.length) return err("Chốt: mã không bán được", "Có mẫu mã không còn bán hoặc chưa có giá — chuyển nhân viên.", state);
      const changed = priced.lines.filter((l) => d.unitPrices[l.variantId] !== l.unitPrice);
      if (changed.length) {
        state.draft = { ...d, unitPrices: Object.fromEntries(priced.lines.map((l) => [l.variantId, l.unitPrice])) };
        return err("Chốt: giá vừa đổi", `Giá vừa đổi: ${changed.map((l) => `${l.name} nay ${formatVND(l.unitPrice)}`).join("; ")}. Đọc lại tóm tắt với giá mới và hỏi khách xác nhận lại.`, state);
      }
      const stock = await stockFor(d.lines.map((l) => l.variantId));
      const short = d.lines.filter((l) => {
        const s = stock.get(l.variantId);
        return s?.stockKnown && (s.available ?? 0) < l.quantity;
      });
      if (short.length) return err("Chốt: không đủ hàng", `Không đủ hàng khả dụng cho: ${short.map((l) => priced.lines.find((p) => p.variantId === l.variantId)?.name ?? l.variantId).join(", ")}.`, state);
      const unknownStock = d.lines.some((l) => !stock.get(l.variantId)?.stockKnown);
      let orderId: string | null = null;
      if (!simulated) {
        const payload = orderInput(state, { ...d, note: unknownStock ? [d.note, "Tồn chưa xác nhận lúc chốt — kho kiểm trước khi giao."].filter(Boolean).join("\n") : d.note }, priced, "CONFIRMED", ctx.config, ctx.channel);
        const r = await updateOrderAsAgent(ctx.agent, d.orderId, payload);
        if (!r.ok) return err("Chốt: lỗi", failureText(r), state);
        orderId = r.id;
      }
      state.confirmed = { orderId, simulated, total: priced.total ?? priced.subtotal, at: new Date().toISOString() };
      state.stage = "DONE";
      return ok(`${simulated ? "(Thử) " : ""}Đã chốt đơn · ${formatVND(priced.subtotal)}`, {
        confirmed: true,
        simulated,
        order_code: orderId ? `#${manualOrderShortCode(orderId)}` : "(thử — không tạo đơn thật, không báo nhóm)",
        ...cartView(priced),
        stock_note: unknownStock ? "Có mã kho chưa xác nhận tồn — nhân viên sẽ kiểm trước khi giao." : null,
      }, state);
    }
    case "send_quick_reply": {
      const code = z.string().trim().min(1).max(20).safeParse(input.code);
      const entry = code.success ? ctx.quickReplies?.find((q) => q.code.toLowerCase() === code.data.toLowerCase()) : undefined;
      if (!entry) return err("Câu mẫu: không có mã", "Không có câu mẫu với mã này — chỉ dùng mã trong danh sách CÂU MẪU.", state);
      if (entry.upsell && state.upsellSent) return err("Câu upsell đã gửi", "Câu upsell đã gửi trong hội thoại này — không gửi lại.", state);
      const pick = await renderQuickReplyForSend(entry.id, ctx.config);
      if (!pick && entry.upsell) state.upsellUnavailable = true;
      if (!pick) return err(`Câu mẫu ${entry.code}: thiếu số ERP`, "Câu mẫu này đang thiếu giá / tồn từ ERP — tự trả lời bằng công cụ giá / tồn, không dùng câu mẫu.", state);
      if (repeatsRecent(pick.text, ctx.recentSaid ?? [])) return err(`Câu mẫu ${entry.code}: vừa gửi`, "Câu mẫu này shop VỪA gửi — khách đang trả lời nó. Đọc câu khách và đi tiếp, không gửi lại.", state);
      if (entry.upsell) state.upsellSent = true;
      return { ...ok(`Gửi câu mẫu «${entry.title}»${pick.imageIds.length ? ` + ${pick.imageIds.length} ảnh` : ""}`, { sent: true, note: "Khách đã nhận nguyên văn câu mẫu (và ảnh). Không nhắc lại nội dung." }, state), deliver: { text: pick.text, imageIds: pick.imageIds, quickReplyId: entry.id } };
    }
    case "set_sales_stage": {
      const st = z.enum(["QUOTE", "CONSULT", "INFO", "UPSELL", "CONFIRM"]).safeParse(input.stage);
      if (!st.success) return err("Bước: sai mã", "stage phải là QUOTE / CONSULT / INFO / UPSELL / CONFIRM.", state);
      if (state.confirmed) return ok("Đơn đã chốt — giữ bước Đã chốt", { stage: "DONE" }, state);
      state.stage = st.data;
      return ok(`Bước: ${SALES_STAGE_LABEL[st.data]}`, { stage: st.data }, state);
    }
    case "lookup_customer": {
      const phone = normalizeCustomerPhone(String(input.phone ?? ""));
      if (!phone) return err("Khách cũ: SĐT không hợp lệ", "Số điện thoại chỉ gồm 8–15 chữ số.", state);
      const db = await getDb();
      const [c] = await db.select({ id: schema.customers.id, name: schema.customers.name, address: schema.customers.address }).from(schema.customers).where(eq(schema.customers.phone, phone)).limit(1);
      if (!c) return ok("Khách mới (chưa có SĐT trong sổ)", { returning_customer: false }, state);
      const [n] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.orders).where(and(eq(schema.orders.customerId, c.id), ne(schema.orders.stage, "DELETED")));
      const nameHint = c.name.trim().split(/\s+/).pop() ?? "";
      return ok(`Khách cũ · ${Number(n?.n ?? 0)} đơn`, { returning_customer: true, orders: Number(n?.n ?? 0), name_hint: nameHint, previous_address_hint: maskAddress(c.address) || null, note: "Chỉ GỢI Ý — hỏi khách xác nhận địa chỉ, không tự điền." }, state);
    }
    case "mark_declined": {
      const reason = z.string().trim().min(2).max(300).safeParse(input.reason);
      state.declined = { reason: reason.success ? reason.data : "Khách từ chối", at: new Date().toISOString() };
      state.stage = "DECLINED";
      return ok("Khách từ chối — thôi follow-up", { declined: true }, state);
    }
    case "handoff_to_human": {
      const reason = z.string().trim().min(2).max(300).safeParse(input.reason);
      state.handoff = { reason: reason.success ? reason.data : "Khách cần nhân viên", at: new Date().toISOString() };
      if (!simulated) await notifySalesChatHandoff(ctx.conversationId, state.handoff.reason, state.customer, new Date());
      // Fanpage: nhân viên trả lời trực tiếp trên page ⇒ bot không nói gì thêm (lượt này cũng không được gửi đi).
      if (ctx.channel === "FANPAGE") return ok("Chuyển nhân viên", { handed_off: true, simulated, say_to_customer: null, instruction: "KHÔNG viết gì cho khách — nhân viên sẽ trả lời trực tiếp." }, state);
      return ok(`${simulated ? "(Thử) " : ""}Chuyển nhân viên`, { handed_off: true, simulated, say_to_customer: ctx.config.handoff.message }, state);
    }
  }
  return err(`${name}: không có`, `Không có công cụ «${name}».`, state);
}

/** Tổng tiền đơn đã chốt / nháp để màn hình in (không gọi lại công cụ). */
export function orderTotalsOf(state: ChatState): number | null {
  if (state.confirmed) return state.confirmed.total;
  if (!state.draft) return null;
  const t = manualOrderTotals(
    state.draft.lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity, unitPrice: state.draft!.unitPrices[l.variantId] ?? 0, discount: 0 })),
    0,
    0,
  );
  return t.ok ? t.totals.totalPriceAfterDiscount : null;
}
