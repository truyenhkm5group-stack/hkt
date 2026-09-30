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
import { z } from "zod";
import { getDb, schema } from "@/db";
import type { AiToolDef } from "@/lib/ai/provider";
import { manualOrderShortCode, manualOrderTotals } from "@/lib/constants/manual-orders";
import { formatVND } from "@/lib/format";
import { createCustomerAsAgent } from "@/lib/records/customer-create";
import { createOrderAsAgent, updateOrderAsAgent, type OrderAgent } from "@/lib/records/order-create";
import { foldVi, searchCatalog, sellableCatalog, stockFor, type CatalogItem } from "@/lib/sales-chatbot/catalog";
import type { ChatChannel, SalesChatbotConfig, SalesTool } from "@/lib/sales-chatbot/config";

export type CartLine = { variantId: string; quantity: number };
export type Recipient = { name: string; phone: string; address: string; province: string };
export type ChatState = {
  customer?: { id: string | null; name: string; phone: string; address: string; province: string; simulated: boolean };
  draft?: { orderId: string | null; lines: CartLine[]; unitPrices: Record<string, number>; recipient: Recipient; note: string; simulated: boolean };
  confirmed?: { orderId: string | null; simulated: boolean; total: number; at: string };
  handoff?: { reason: string; at: string };
};

export type ToolContext = {
  conversationId: string;
  channel: ChatChannel;
  config: SalesChatbotConfig;
  state: ChatState;
  /** Câu CUỐI khách gõ (chữ thô) — `confirm_order` đối chiếu lời xác nhận với câu này. */
  lastUserText: string;
  agent: OrderAgent;
};

export type ToolOutcome = { content: string; isError: boolean; summary: string; state: ChatState };

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
    description: "Giá bán HIỆN TẠI của một mẫu mã, đọc từ ERP ngay lúc gọi. price = null nghĩa là mã chưa có giá — không được báo giá.",
    inputSchema: { type: "object", properties: { variant_id: { type: "string" } }, required: ["variant_id"], additionalProperties: false },
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
    description: "Lưu thông tin người mua sau khi khách đã cho: họ tên, số điện thoại, địa chỉ giao. SĐT đã có trong sổ ⇒ dùng lại đúng khách đó.",
    inputSchema: { type: "object", properties: { name: { type: "string" }, phone: { type: "string" }, address: { type: "string" }, province: { type: "string" } }, required: ["name", "phone", "address"], additionalProperties: false },
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
    description: "Chuyển hội thoại cho nhân viên: khách yêu cầu gặp người, khiếu nại, hỏi điều ERP không có dữ liệu, hoặc bot không chắc.",
    inputSchema: { type: "object", properties: { reason: { type: "string" } }, required: ["reason"], additionalProperties: false },
    kind: "write",
  },
};

export function toolDefsFor(cfg: SalesChatbotConfig): AiToolDef[] {
  return cfg.allowedTools.map((t) => DEFS[t]);
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

type Priced = { lines: { variantId: string; name: string; quantity: number; unitPrice: number; lineTotal: number }[]; subtotal: number; shippingFee: number | null; total: number | null; unpriced: string[]; missing: string[] };

async function priceLines(lines: readonly CartLine[], cfg: SalesChatbotConfig): Promise<Priced> {
  const catalog = await sellableCatalog([]);
  const byId = new Map(catalog.map((c) => [c.variantId, c]));
  const out: Priced["lines"] = [];
  const unpriced: string[] = [];
  const missing: string[] = [];
  for (const l of lines) {
    const it = byId.get(l.variantId);
    if (!it) missing.push(l.variantId);
    else if (it.price === null) unpriced.push(it.name);
    else out.push({ variantId: l.variantId, name: `${it.name}${it.variant ? ` (${it.variant})` : ""}`, quantity: l.quantity, unitPrice: it.price, lineTotal: it.price * l.quantity });
  }
  const subtotal = out.reduce((s, l) => s + l.lineTotal, 0);
  const shippingFee = cfg.shippingFee;
  return { lines: out, subtotal, shippingFee, total: shippingFee === null ? null : subtotal + shippingFee, unpriced, missing };
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
    shipping_text: p.shippingFee === null ? "Phí ship: nhân viên sẽ báo sau (shop chưa khai phí ship cố định)" : formatVND(p.shippingFee),
    cod_total: p.total,
    cod_total_text: p.total === null ? `${formatVND(p.subtotal)} + phí ship (báo sau)` : formatVND(p.total),
  };
}

function orderInput(state: ChatState, draft: NonNullable<ChatState["draft"]>, priced: Priced, stage: "NEW" | "CONFIRMED", cfg: SalesChatbotConfig) {
  const notes = [draft.note, cfg.shippingFee === null ? "Phí ship: CHƯA BÁO — nhân viên cập nhật trước khi giao." : ""].filter((x) => x.trim());
  return {
    customerId: state.customer?.id ?? "",
    stage,
    lines: priced.lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity, unitPrice: l.unitPrice, discount: 0 })),
    orderDiscount: 0,
    shippingFee: cfg.shippingFee ?? 0,
    note: notes.join("\n").slice(0, 2000),
    channel: "Chatbot web",
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

function failureText(r: { errors: { field: string; message: string }[] }): string {
  return r.errors.map((e) => e.message).join(" · ") || "Không ghi được.";
}

export async function executeTool(name: string, rawInput: unknown, ctx: ToolContext): Promise<ToolOutcome> {
  const state: ChatState = structuredClone(ctx.state);
  if (!(ctx.config.allowedTools as readonly string[]).includes(name)) return err(`${name}: không được bật`, `Công cụ «${name}» không được bật cho bot này.`, state);
  const input = (rawInput && typeof rawInput === "object" ? rawInput : {}) as Record<string, unknown>;
  const simulated = ctx.channel === "TEST";
  switch (name as SalesTool) {
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
      if (name === "get_current_price") return ok(`Giá ${it.name}: ${price(it.price)}`, { variant_id: it.variantId, name: it.name, price: it.price, price_text: price(it.price), as_of: new Date().toISOString() }, state);
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
      return ok(`Kiểm tồn ${rows.length} dòng${short ? ` · ${short} thiếu` : ""}${unknown ? ` · ${unknown} chưa biết tồn` : ""}`, { items: rows }, state);
    }
    case "calculate_cart": {
      const items = itemsZ.safeParse(input.items);
      if (!items.success) return err("Tính giỏ: sai đầu vào", "items phải là danh sách { variant_id, quantity ≥ 1 }.", state);
      const priced = await priceLines(mergeLines(items.data.map((i) => ({ variantId: i.variant_id, quantity: i.quantity }))), ctx.config);
      if (priced.missing.length) return err("Tính giỏ: mã không có", `Không có mẫu mã: ${priced.missing.join(", ")}.`, state);
      if (priced.unpriced.length) return err("Tính giỏ: mã chưa có giá", `Chưa có giá: ${priced.unpriced.join(", ")} — không báo giá, chuyển nhân viên.`, state);
      return ok(`Giỏ: ${formatVND(priced.subtotal)}${priced.total !== null ? ` · COD ${formatVND(priced.total)}` : ""}`, cartView(priced), state);
    }
    case "create_customer": {
      const v = z.object({ name: z.string().trim().min(2).max(200), phone: z.string().trim().min(8).max(30), address: z.string().trim().min(5).max(500), province: z.string().trim().max(100).optional() }).safeParse(input);
      if (!v.success) return err("Lưu khách: thiếu thông tin", "Cần họ tên, số điện thoại (8–15 số) và địa chỉ giao đầy đủ.", state);
      if (simulated) {
        state.customer = { id: null, name: v.data.name, phone: v.data.phone, address: v.data.address, province: v.data.province ?? "", simulated: true };
        return ok(`(Thử) lưu khách ${v.data.name}`, { customer_id: "thu-nghiem", simulated: true, note: "Khung thử: KHÔNG lưu khách thật." }, state);
      }
      const r = await createCustomerAsAgent(ctx.agent, { name: v.data.name, phone: v.data.phone, address: v.data.address, province: v.data.province });
      if (!r.ok) return err("Lưu khách: lỗi", failureText(r), state);
      state.customer = { id: r.id, name: v.data.name, phone: v.data.phone, address: v.data.address, province: v.data.province ?? "", simulated: false };
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
      if (state.confirmed) return err("Đơn đã chốt", "Đơn của hội thoại này đã chốt — muốn đổi thì chuyển nhân viên (handoff_to_human).", state);
      const base: Recipient = existing?.recipient ?? { name: state.customer.name, phone: state.customer.phone, address: state.customer.address, province: state.customer.province };
      const lines = v.data.items ? mergeLines(v.data.items.map((i) => ({ variantId: i.variant_id, quantity: i.quantity }))) : existing!.lines;
      const priced = await priceLines(lines, ctx.config);
      if (priced.missing.length) return err("Đơn nháp: mã không có", `Không có mẫu mã: ${priced.missing.join(", ")}.`, state);
      if (priced.unpriced.length) return err("Đơn nháp: mã chưa có giá", `Chưa có giá: ${priced.unpriced.join(", ")}.`, state);
      const draft = { orderId: existing?.orderId ?? null, lines, unitPrices: Object.fromEntries(priced.lines.map((l) => [l.variantId, l.unitPrice])), recipient: recipientFrom(v.data, base), note: v.data.delivery_note ?? existing?.note ?? "", simulated };
      if (!simulated) {
        const payload = orderInput(state, draft, priced, "NEW", ctx.config);
        const r = draft.orderId ? await updateOrderAsAgent(ctx.agent, draft.orderId, payload) : await createOrderAsAgent(ctx.agent, payload);
        if (!r.ok) return err("Đơn nháp: lỗi", failureText(r), state);
        draft.orderId = r.id;
      }
      state.draft = draft;
      const view = { order_code: draft.orderId ? `#${manualOrderShortCode(draft.orderId)}` : "(thử)", status: "Nháp — chưa chốt, chưa giữ hàng", simulated, ...cartView(priced), recipient: draft.recipient, delivery_note: draft.note || null };
      return ok(`${simulated ? "(Thử) " : ""}${existing ? "Sửa" : "Lên"} đơn nháp · ${formatVND(priced.subtotal)}`, view, state);
    }
    case "confirm_order": {
      const quote = z.string().trim().min(2).max(300).safeParse(input.customer_confirmation);
      if (!state.draft) return err("Chốt: chưa có đơn nháp", "Chưa có đơn nháp để chốt.", state);
      if (state.confirmed) return ok("Đơn đã chốt từ trước", { already_confirmed: true, order_code: state.confirmed.orderId ? `#${manualOrderShortCode(state.confirmed.orderId)}` : "(thử)" }, state);
      if (!quote.success || !foldVi(ctx.lastUserText).includes(foldVi(quote.data))) {
        return err("Chốt: chưa có lời xác nhận của khách", "customer_confirmation phải là nguyên văn lời đồng ý trong câu CUỐI của khách. Khách chưa xác nhận ⇒ đọc lại tóm tắt và hỏi khách có đồng ý không.", state);
      }
      const d = state.draft;
      if (!d.recipient.name || !d.recipient.phone || !d.recipient.address) return err("Chốt: thiếu người nhận", "Thiếu tên / SĐT / địa chỉ người nhận.", state);
      const priced = await priceLines(d.lines, ctx.config);
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
        const payload = orderInput(state, { ...d, note: unknownStock ? [d.note, "Tồn chưa xác nhận lúc chốt — kho kiểm trước khi giao."].filter(Boolean).join("\n") : d.note }, priced, "CONFIRMED", ctx.config);
        const r = await updateOrderAsAgent(ctx.agent, d.orderId, payload);
        if (!r.ok) return err("Chốt: lỗi", failureText(r), state);
        orderId = r.id;
      }
      state.confirmed = { orderId, simulated, total: priced.total ?? priced.subtotal, at: new Date().toISOString() };
      return ok(`${simulated ? "(Thử) " : ""}Đã chốt đơn · ${formatVND(priced.subtotal)}`, {
        confirmed: true,
        simulated,
        order_code: orderId ? `#${manualOrderShortCode(orderId)}` : "(thử — không tạo đơn thật, không báo nhóm)",
        ...cartView(priced),
        stock_note: unknownStock ? "Có mã kho chưa xác nhận tồn — nhân viên sẽ kiểm trước khi giao." : null,
      }, state);
    }
    case "handoff_to_human": {
      const reason = z.string().trim().min(2).max(300).safeParse(input.reason);
      state.handoff = { reason: reason.success ? reason.data : "Khách cần nhân viên", at: new Date().toISOString() };
      if (!simulated) {
        const db = await getDb();
        await db
          .insert(schema.notifications)
          .values({ kind: "SYSTEM", severity: "warning", title: `Chatbot chuyển khách cho nhân viên`, body: `${state.handoff.reason}${state.customer ? ` — ${state.customer.name} · ${state.customer.phone}` : ""}`, href: `/ai/sales-chatbot?conversation=${ctx.conversationId}`, entityType: "SALES_CHAT", entityId: ctx.conversationId, dedupeKey: `sales-chat:handoff:${ctx.conversationId}`, occurredAt: new Date() })
          .onConflictDoNothing({ target: schema.notifications.dedupeKey });
      }
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
