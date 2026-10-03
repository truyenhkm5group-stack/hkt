/**
 * ═══════════ BỘ MÁY HỘI THOẠI CỦA CHATBOT BÁN HÀNG (0180) — CHỈ MÁY CHỦ ═══════════
 *
 * Một lượt = khách gõ một câu ⇒ tối đa `toolRounds` vòng (model đề nghị công cụ → máy chủ chạy → trả kết quả) ⇒ một câu
 * trả lời. Mọi thứ trong CSDL của tổ chức NGỮ CẢNH (`getDb()`); nơi gọi (server action của trang thử / trang chat công
 * khai) đã đặt ngữ cảnh — trang công khai bằng `withOrganization(mã tổ chức của tên miền con)`, KHÔNG BAO GIỜ rơi về nhà.
 *
 * AI: kết nối BYOK ĐANG BẬT của CHÍNH tổ chức (`openActiveConnection`, khoá giải mã với AAD gắn tổ chức) → provider BYOK
 * (địa chỉ hằng, không đọc biến môi trường của nhà). Trước khi gọi model: công tắc AI của người vận hành, trần TIỀN của sổ
 * dùng AI (`checkAiQuota` — trần LƯỢT của gói không đếm lượt chatbot, xem `sourceUsage`), trần kỹ thuật của bot. Mỗi lượt
 * ghi MỘT dòng `platform_ai_usage` (feature `sales_chatbot`) — không lưu nội dung.
 *
 * Lời nhắc KHÔNG chứa giá hay tồn: bot phải gọi công cụ, và công cụ đọc ERP lúc gọi.
 *
 * Tin nhắn append-only (`sales_chat_messages`, `seq` UNIQUE trong hội thoại): hai lượt gửi đua nhau ⇒ lượt thua báo
 * "đang trả lời câu trước", không chen tin vào giữa.
 */
import { createHash } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { estimateCostUsd, type AiBlock, type AiMessage, type AiProvider } from "@/lib/ai/provider";
import { ByokAnthropicProvider, ByokGeminiProvider, ByokOpenAiProvider } from "@/lib/ai-builder/providers";
import { aiKillSwitchDenial } from "@/lib/ai-usage/control";
import { recordAiUsage } from "@/lib/ai-usage/ledger";
import { checkAiQuota } from "@/lib/ai-usage/quota";
import { AI_PROFILE_SETTING_KEY } from "@/lib/blueprints/types";
import { openActiveConnection } from "@/lib/connectors/service";
import { manualOrderShortCode } from "@/lib/constants/manual-orders";
import { canUseModule } from "@/lib/platform/capabilities";
import { notifySalesChatAiDown, notifySalesChatHandoff } from "@/lib/sales-chatbot/alerts";
import { currentOrganization } from "@/lib/platform/context";
import { findOrganization } from "@/lib/platform/organizations";
import { isPublicChannel, parseSalesChatbotConfig, SALES_CHATBOT_LIMITS, SALES_THINKING_BUDGET, salesBotError, SALES_CHATBOT_SETTING_KEY, SALES_TONE_LABEL, withinBusinessHours, type ChatChannel, type ChatView, type SalesChatbotConfig } from "@/lib/sales-chatbot/config";
import { parsePlaybookState, PLAYBOOK_LIMITS, PLAYBOOK_SETTING_KEY } from "@/lib/sales-chatbot/playbook-shared";
import { loadQuickReplySettings, markQuickReplyUsed, quickReplyByAi, quickReplyByKeyword, quickReplyCatalog, type QuickReplyPick, type QuickReplyStep } from "@/lib/sales-chatbot/quick-replies";
import { repeatsRecent } from "@/lib/sales-chatbot/quick-replies-shared";
import { findReturningCustomer, returningCustomerPrompt } from "@/lib/sales-chatbot/returning";
import { executeTool, orderTotalsOf, toolDefsFor, type ChatState } from "@/lib/sales-chatbot/tools";
import { vnDayOffset, WEEKDAY_LABEL } from "@/lib/constants/booking";

export const SALES_AGENT = { name: "Chatbot bán hàng", source: "lib/sales-chatbot/engine.ts" } as const;

/** `settings.value` là CHUỖI JSON; hỏng / thiếu ⇒ `null` (người đọc tự lùi về mặc định). */
export async function readJsonSetting(key: string): Promise<unknown> {
  const db = await getDb();
  const [row] = await db.select({ value: schema.settings.value }).from(schema.settings).where(eq(schema.settings.key, key)).limit(1);
  if (!row?.value) return null;
  try {
    return JSON.parse(row.value) as unknown;
  } catch {
    return null;
  }
}

export async function loadSalesChatbotConfig(): Promise<SalesChatbotConfig> {
  return parseSalesChatbotConfig(await readJsonSetting(SALES_CHATBOT_SETTING_KEY));
}

async function businessProfile(): Promise<string> {
  const v = (await readJsonSetting(AI_PROFILE_SETTING_KEY)) as { businessProfile?: unknown } | null;
  return typeof v?.businessProfile === "string" ? v.businessProfile.slice(0, 1500) : "";
}

/** Lời nhắc hệ thống — dựng từ cấu hình; KHÔNG có giá, tồn hay danh mục (bot phải hỏi công cụ). */
export type PromptQuickReply = { code: string; title: string; upsell: boolean };

/**
 * Đoạn lời nhắc ĐẶT LỊCH — chỉ khi `bookingOn` (shop bật + module Lịch hẹn bật). Có NGÀY HÔM NAY để bot hiểu «mai», «thứ 7».
 * Bot không hứa kỹ thuật viên; đổi / huỷ lịch đã đặt là việc của người.
 */
export function bookingPrompt(cfg: SalesChatbotConfig, now: Date): string {
  const b = cfg.booking;
  const today = vnDayOffset(now);
  const days = b.days.length === 7 ? "mọi ngày trong tuần" : [...b.days].sort((x, y) => x - y).map((d) => WEEKDAY_LABEL[d]).join(", ");
  return [
    `ĐẶT LỊCH HẸN — shop nhận đặt lịch qua chat: ${b.open}–${b.close}, ${days}; mỗi lịch ${b.slotMinutes} phút; nhận trước tối đa ${b.horizonDays} ngày. Hôm nay là ${WEEKDAY_LABEL[new Date(`${today}T00:00:00Z`).getUTCDay()]} ${today} (giờ Việt Nam).`,
    "  · Dịch vụ là sản phẩm của shop: search_products để biết đúng tên + giá. Hỏi DỊCH VỤ và NGÀY / GIỜ khách muốn (một câu).",
    "  · find_booking_slots(date) ⇒ giờ khách muốn có trong `times` thì giữ giờ đó; không có ⇒ đề xuất tối đa 3 giờ gần nhất trong `times` (hoặc `next_available`). KHÔNG hứa giờ chưa kiểm.",
    "  · Cần HỌ TÊN + SỐ ĐIỆN THOẠI (không cần địa chỉ). Rồi đọc lại TÓM TẮT: dịch vụ, ngày, giờ, họ tên, SĐT — hỏi «anh/chị xác nhận đặt lịch không ạ?».",
    "  · Khách đồng ý rõ ràng ⇒ book_appointment với customer_confirmation = nguyên văn lời đồng ý. Báo lỗi «vừa kín» ⇒ find_booking_slots lại và mời giờ khác.",
    "  · Không hứa kỹ thuật viên cụ thể. Khách muốn chọn người, đổi / huỷ lịch đã đặt, hay đặt cho nhiều người ⇒ handoff_to_human với reason «Lịch hẹn — <ý khách>».",
  ].join("\n");
}

/**
 * BOT BIẾT BÂY GIỜ LÀ LÚC NÀO (03/10/2026). Trước đây chỉ khi bật đặt lịch bot mới biết «hôm nay» — khách nói «mai giao»,
 * «tối nay em qua lấy», «hôm qua chị đặt» thì bot không biết đó là ngày nào. Độ mịn là GIỜ, không phải phút: lời nhắc hệ
 * thống được đệm (cache) ở nhà cung cấp AI, ghi tới phút là mất đệm ở MỌI lượt; tới giờ thì mỗi giờ mất một lần.
 */
export function nowPromptLine(now: Date): string {
  const vn = new Date(now.getTime() + 7 * 3_600_000);
  const dd = String(vn.getUTCDate()).padStart(2, "0");
  const mm = String(vn.getUTCMonth() + 1).padStart(2, "0");
  return `${WEEKDAY_LABEL[vn.getUTCDay()]} ${dd}/${mm}/${vn.getUTCFullYear()}, khoảng ${vn.getUTCHours()} giờ`;
}

/** Hai tin cách nhau từ chừng này trở lên thì tin của khách mang mốc giờ khi gửi model — ngắn hơn là cùng một mạch chat. */
export const MESSAGE_TIME_GAP_MS = 3 * 3_600_000;

/** «[Gửi lúc 20:15 Thứ sáu 02/10]» — mốc của CHÍNH tin đó (giờ Việt Nam). */
export function messageTimeTag(at: Date): string {
  const vn = new Date(at.getTime() + 7 * 3_600_000);
  const hh = String(vn.getUTCHours()).padStart(2, "0");
  const mi = String(vn.getUTCMinutes()).padStart(2, "0");
  const dd = String(vn.getUTCDate()).padStart(2, "0");
  const mm = String(vn.getUTCMonth() + 1).padStart(2, "0");
  return `[Gửi lúc ${hh}:${mi} ${WEEKDAY_LABEL[vn.getUTCDay()]} ${dd}/${mm}]`;
}

export function systemPrompt(cfg: SalesChatbotConfig, shopName: string, profile: string, channel: ChatChannel, playbook: string = "", quick: readonly PromptQuickReply[] = [], returning: string = "", booking: string = "", now: Date | null = null): string {
  const upsell = quick.find((q) => q.upsell);
  const shipping = cfg.shippingFee === null ? "Shop CHƯA khai phí ship cố định: nói với khách «phí ship nhân viên sẽ báo sau», KHÔNG tự đặt số." : "Phí ship theo chính sách shop — lấy đúng số trong kết quả calculate_cart / đơn nháp, không tự đặt.";
  return [
    `Bạn là «${cfg.botName}», nhân viên bán hàng qua chat của shop «${shopName}». Trả lời bằng tiếng Việt, giọng: ${SALES_TONE_LABEL[cfg.tone]}. Câu ngắn, rõ, không dùng markdown phức tạp.`,
    profile ? `Về shop: ${profile}` : "",
    "LUẬT BẮT BUỘC:",
    "1. GIÁ và TỒN chỉ lấy từ kết quả công cụ trong CHÍNH hội thoại này (search_products / get_current_price / check_inventory / calculate_cart). Không nhớ giá, không đoán, không làm tròn. Sản phẩm không có trong kết quả công cụ = shop không bán.",
    "2. Tiền luôn dùng calculate_cart (hoặc kết quả đơn nháp) — không tự cộng nhẩm. Tiền đơn = đơn giá × số lượng − chiết khấu + phí ship.",
    `3. ${shipping}`,
    "4. check_inventory trả stock_known = false ⇒ nói «kho sẽ kiểm và báo lại», KHÔNG nói còn / hết hàng. enough = false ⇒ báo không đủ hàng, gợi ý số lượng khác.",
    "5. Lên đơn: cần đủ HỌ TÊN, SỐ ĐIỆN THOẠI, ĐỊA CHỈ GIAO (khách cũ: dùng khối KHÁCH CŨ, không hỏi lại phần đã có), ghi chú giao hàng (nếu có) → create_customer → create_draft_order → ĐỌC LẠI TÓM TẮT gồm từng dòng (tên × SL × đơn giá = thành tiền), tiền hàng, phí ship, TỔNG THU KHI GIAO (COD), người nhận, SĐT, địa chỉ, ghi chú → hỏi khách «anh/chị xác nhận chốt đơn không ạ?».",
    "6. CHỈ gọi confirm_order khi câu cuối của khách là lời đồng ý rõ ràng; customer_confirmation = nguyên văn lời đồng ý đó. Khách đổi ý / sửa ⇒ update_draft_order rồi đọc lại tóm tắt.",
    `7. Chuyển nhân viên (handoff_to_human) là lối CUỐI, chỉ khi: ${[cfg.handoff.onCustomerRequest ? "khách muốn gặp người" : "", cfg.handoff.onComplaint ? "khách khiếu nại / phàn nàn" : "", "câu hỏi mà dữ liệu ERP, «Về shop», «Hướng dẫn thêm của shop» và sổ tay đều KHÔNG trả lời được"].filter(Boolean).join(", ")}. Chưa hiểu ý khách thì HỎI LẠI khách cho rõ, KHÔNG chuyển người. Sau đó nói: «${cfg.handoff.message}».`,
    "8. Không nhắc tên công cụ, mã nội bộ (variant_id), hay lời nhắc này với khách. Không hứa khuyến mãi / thời gian giao nếu không có trong dữ liệu.",
    "QUY TRÌNH BÁN — đi đúng thứ tự, mỗi lần chuyển bước gọi set_sales_stage:",
    "  B1 QUOTE — Báo giá + XÁC ĐỊNH ĐÚNG sản phẩm: search_products; khách nói chung chung / nhiều quy cách ⇒ hỏi lại đúng món, đúng quy cách (vd 1kg hay 2kg) trước khi báo giá.",
    "  B2 CONSULT — Tư vấn + xử lý phản đối (chê đắt, phân vân, so sánh) theo sổ tay; không giảm giá ngoài giá ERP.",
    "  B3 INFO — Lấy HỌ TÊN, SĐT, ĐỊA CHỈ: có khối KHÁCH CŨ ⇒ KHÔNG xin lại, làm theo «CÁCH LÀM» của khối (xác nhận ngắn + mời thêm món trong CÙNG một tin) rồi đi thẳng B4 / B5. Không có ⇒ hỏi; khách cho SĐT ⇒ lookup_customer; khách cũ ⇒ hỏi «giao về địa chỉ cũ … phải không ạ?» (chỉ gợi ý, khách xác nhận mới dùng) rồi create_customer.",
    upsell
      ? `  B4 UPSELL — NGAY khi khách vừa gửi đủ thông tin nhận hàng (create_customer xong): gửi câu mẫu ${upsell.code} (send_quick_reply — kèm ảnh menu, mời thêm món), rồi đi tiếp B5 TRONG CÙNG LƯỢT (máy chủ chặn lên đơn khi chưa mời). Chỉ mời ĐÚNG MỘT LẦN mỗi hội thoại.`
      : "  B4 UPSELL — Gợi ý ĐÚNG MỘT món bổ trợ còn bán (search_products) ngay trong tin tóm tắt đơn; khách từ chối ⇒ không mời lại.",
    "  B5 CONFIRM — create_draft_order ⇒ gửi TÓM TẮT CHỐT ĐƠN để khách nắm thông tin (từng món × SL × đơn giá, tiền hàng, phí ship, tổng thu khi giao, người nhận, SĐT, địa chỉ) và kết bằng «Anh/chị lấy thêm món nào báo em thêm vào đơn, không thì anh/chị xác nhận để em giao luôn ạ». Khách thêm món ⇒ update_draft_order rồi gửi lại tóm tắt; khách đồng ý ⇒ confirm_order.",
    "  Khách hẹn ngày / giờ giao ⇒ ghi vào delivery_note, KHÔNG cần chuyển người. Khách TỪ CHỐI RÕ RÀNG ⇒ mark_declined, chào lịch sự, không nài.",
    "HIỂU KHÁCH:",
    "  · Tin bắt đầu bằng «[Shop đã nhắn]» là của nhân viên / trả lời tự động của page — khách đang nói tiếp về đúng món, đúng giá trong đó. KHÔNG hỏi lại khách muốn món gì nếu lịch sử đã rõ.",
    "  · «nguyên chất», «tươi», «loại ngon», «thật»… là MÔ TẢ, không phải tên sản phẩm khác; «1kí», «1 ký», «1 cân», «1kg» đều là 1kg; «nửa ký» = 0,5kg. Chọn sản phẩm có TÊN khớp món khách nói (vd «chả cá thu») trong kết quả search_products — không kết luận «không có» khi kết quả có sản phẩm cùng tên chính.",
    "  · Khách nhắn NHIỀU câu liên tiếp (mỗi dòng một tin) ⇒ trả lời ĐỦ từng câu, theo thứ tự, gộp trong MỘT tin. Câu nào ERP / «Về shop» không có dữ liệu (vd địa chỉ cửa hàng) ⇒ nói nhân viên sẽ báo, KHÔNG bịa.",
    "  · KHÔNG hỏi lại câu bạn / shop VỪA hỏi: khách vừa trả lời (vd shop hỏi «lấy bao nhiêu kg», khách đáp «lấy lần 20-30 kg») ⇒ dùng câu trả lời đó và đi tiếp.",
    "  · ĐỌC HIỂU TRƯỚC KHI BỎ CUỘC (chủ shop 02/10/2026): khách hay gõ không dấu, viết tắt («khg» / «ko» = không, «dc» = được, «sp» = sản phẩm, «ship cod» = giao nhận tiền) — đọc theo nghĩa. Hiểu được thì trả lời; CHƯA chắc ý khách ⇒ hỏi lại MỘT câu ngắn cho rõ (vd «Dạ ý mình là … phải không ạ?»), tối đa 2 lần.",
    "  · Câu hỏi về CHÍNH SÁCH (kiểm hàng khi nhận, ăn thử, đổi trả, thanh toán, giao hàng): «Về shop» / «Hướng dẫn thêm của shop» / sổ tay có nói ⇒ trả lời ĐÚNG theo đó, không thêm điều shop chưa hứa. Không có ở đâu cả ⇒ mới chuyển người («Ngoài chính sách»).",
    "  · Khách đã nói món + số lượng ⇒ đi tiếp bước kế (xin họ tên / SĐT / địa chỉ còn thiếu), không hỏi lại điều khách đã nói. Khách gửi địa chỉ ⇒ ghi nhận và chỉ hỏi phần còn thiếu.",
    cfg.wholesalePricing
      ? "KHÁCH SỈ — shop ĐÃ BẬT báo giá theo bảng giá: hỏi số lượng nếu chưa biết (ĐÚNG MỘT lần), rồi get_current_price với variant_id + quantity ⇒ báo ĐÚNG đơn giá công cụ trả về; có `tiers` thì nói rõ bậc («từ 10 trở lên giá …»). Đơn giá trong đơn do máy chủ tính theo cùng bảng. KHÔNG tự giảm ngoài bảng; khách đòi giá thấp hơn bảng, hay số lượng vượt bậc cao nhất mà muốn giá riêng ⇒ handoff_to_human với reason «Khách sỉ — <số lượng / ý khách>»."
      : "KHÁCH SỈ — khách hỏi giá sỉ / lấy về bán / đại lý / số lượng lớn (từ 10kg): ERP chỉ có giá LẺ — KHÔNG đưa giá lẻ ra như giá sỉ, KHÔNG tự giảm, KHÔNG chê khách. Chưa biết số lượng ⇒ hỏi số lượng ĐÚNG MỘT lần (dùng câu mẫu của shop nếu có). Khách đã nói số lượng, hoặc chê giá cao ⇒ handoff_to_human với reason «Khách sỉ — <số lượng / ý khách>» (nhân viên báo giá sỉ).",
    "CẦN NGƯỜI XỬ LÝ — gọi handoff_to_human (reason bắt đầu bằng nhóm) khi: «Khách sỉ» (như trên) · «Ngoài chính sách» (điều shop CHƯA khai ở «Về shop» / «Hướng dẫn thêm» / sổ tay: giảm giá riêng, giao gấp chưa hứa…) · «Khiếu nại» · «Không xác định được sản phẩm» (đã hỏi lại 2 lần vẫn không rõ) · «Giá / tồn bất thường» · «Không hiểu ý khách» (ĐÃ hỏi lại 2 lần vẫn không rõ — không đoán). Chuyển người trên fanpage là bot IM LẶNG, khách phải chờ nhân viên: chỉ chuyển khi thật sự không trả lời được.",
    returning,
    booking,
    now
      ? `THỜI GIAN: bây giờ là ${nowPromptLine(now)} (giờ Việt Nam). «hôm nay», «mai», «tối nay», «cuối tuần» tính theo mốc này. Tin có dấu «[Gửi lúc …]» được gửi từ trước — những chữ đó trong tin ấy tính theo ngày của CHÍNH tin ấy (khách nhắn «mai giao» hôm qua nghĩa là giao HÔM NAY). Không nhắc lại dấu giờ này với khách.`
      : "",
    quick.length
      ? `CÂU MẪU của shop (send_quick_reply gửi NGUYÊN VĂN chữ + ảnh, giá điền từ ERP — ưu tiên dùng khi khớp ý khách, rồi chỉ hỏi thêm ngắn):\n${quick.map((q) => `  ${q.code}: ${q.title}${q.upsell ? " (câu UPSELL)" : ""}`).join("\n")}`
      : "",
    channel === "TEST" ? "(Đây là KHUNG THỬ của chủ shop: công cụ ghi chỉ mô phỏng — vẫn làm đúng quy trình như với khách thật.)" : "",
    cfg.extraInstructions ? `Hướng dẫn thêm của shop (không được trái các luật trên): ${cfg.extraInstructions}` : "",
    playbook ? `SỔ TAY BÁN HÀNG của shop (chủ shop đã duyệt — học giọng điệu và cách xử lý; KHÔNG được trái các luật trên: giá / tồn / phí ship vẫn CHỈ từ công cụ):\n${playbook}` : "",
    `Lời chào mở đầu mẫu: «${cfg.greeting}»`,
  ]
    .filter(Boolean)
    .join("\n");
}

type ConvRow = typeof schema.salesChatConversations.$inferSelect;

export function visitorKeyOf(raw: string): string {
  return createHash("sha256").update(`sales-chat-visitor:${raw}`).digest("hex").slice(0, 40);
}

export async function openConversation(channel: ChatChannel, opts: { visitorKey?: string | null; createdBy?: string | null } = {}): Promise<{ id: string; greeting: string; botName: string }> {
  const cfg = await loadSalesChatbotConfig();
  const db = await getDb();
  const [row] = await db
    .insert(schema.salesChatConversations)
    .values({ channel, visitorKey: opts.visitorKey ?? null, createdBy: opts.createdBy ?? null, state: {} })
    .returning({ id: schema.salesChatConversations.id });
  await db.insert(schema.salesChatMessages).values({ conversationId: row.id, seq: 1, role: "assistant", content: [{ type: "text", text: cfg.greeting }] satisfies AiBlock[] });
  return { id: row.id, greeting: cfg.greeting, botName: cfg.botName };
}

async function loadConversation(id: string): Promise<ConvRow | null> {
  const db = await getDb();
  const [row] = await db.select().from(schema.salesChatConversations).where(eq(schema.salesChatConversations.id, id)).limit(1);
  return row ?? null;
}

async function loadMessages(conversationId: string): Promise<{ seq: number; role: "user" | "assistant"; content: AiBlock[]; at: Date }[]> {
  const db = await getDb();
  const rows = await db.select().from(schema.salesChatMessages).where(eq(schema.salesChatMessages.conversationId, conversationId)).orderBy(asc(schema.salesChatMessages.seq));
  return rows.map((r) => ({ seq: r.seq, role: r.role === "assistant" ? "assistant" : "user", content: (Array.isArray(r.content) ? r.content : []) as AiBlock[], at: r.createdAt }));
}

class SeqConflict extends Error {}

async function appendMessage(conversationId: string, seq: number, role: "user" | "assistant", content: AiBlock[]) {
  const db = await getDb();
  const rows = await db.insert(schema.salesChatMessages).values({ conversationId, seq, role, content }).onConflictDoNothing().returning({ id: schema.salesChatMessages.id });
  if (rows.length === 0) throw new SeqConflict("Đang trả lời câu trước — đợi một chút rồi gửi lại.");
}

/**
 * Lịch sử gửi model: tin CUỐI `historyMessages`, cắt ở ranh giới câu của KHÁCH (tin `user` chỉ có chữ) để không bao giờ
 * mở đầu bằng một `tool_result` mồ côi. Lời chào của bot (tin đầu, `assistant`) bỏ đi — Anthropic đòi tin đầu là `user`.
 *
 * MỐC GIỜ (03/10/2026): tin chữ của khách cách tin trước đó từ `MESSAGE_TIME_GAP_MS` trở lên được gắn `messageTimeTag` ở
 * BẢN GỬI MODEL (không ghi vào CSDL, khách không thấy) — để «mai giao» nhắn hôm qua không bị hiểu là ngày mai của hôm nay.
 * Mốc dựng TẤT ĐỊNH từ `at` đã lưu, nên cùng lịch sử luôn ra cùng chữ và đệm (cache) tin nhắn ở nhà cung cấp không vỡ.
 * Tin không có `at` (bài kiểm cũ) ⇒ không gắn gì.
 */
export function historyForModel(msgs: readonly { role: "user" | "assistant"; content: AiBlock[]; at?: Date }[], limit: number): AiMessage[] {
  const tagged = msgs.map((m, i) => {
    const prev = i > 0 ? msgs[i - 1].at : undefined;
    const isCustomerText = m.role === "user" && m.content.length > 0 && m.content.every((b) => b.type === "text");
    if (!isCustomerText || !m.at || !prev || m.at.getTime() - prev.getTime() < MESSAGE_TIME_GAP_MS) return { role: m.role, content: m.content };
    const [first, ...rest] = m.content as Extract<AiBlock, { type: "text" }>[];
    return { role: m.role, content: [{ ...first, text: `${messageTimeTag(m.at)}\n${first.text}` }, ...rest] as AiBlock[] };
  });
  const tail = tagged.slice(-limit);
  let start = tail.findIndex((m) => m.role === "user" && m.content.every((b) => b.type === "text"));
  if (start < 0) start = tail.length;
  return tail.slice(start).map((m) => ({ role: m.role, content: m.content }));
}

function textOf(blocks: readonly AiBlock[]): string {
  return blocks
    .filter((b): b is Extract<AiBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

/** `n` câu GẦN NHẤT phía shop (chữ của bot, câu mẫu đã gửi, tin page chép vào) — mới nhất cuối. */
export function recentShopTexts(msgs: readonly { role: "user" | "assistant"; content: AiBlock[] }[], n: number): string[] {
  const out: string[] = [];
  for (const m of msgs) {
    if (m.role === "assistant") {
      const t = textOf(m.content);
      if (t) out.push(t);
      continue;
    }
    for (const b of m.content) if (b.type === "tool_result") {
      const d = deliveredText(b.content);
      if (d) out.push(d);
    }
  }
  return out.slice(-n);
}

function deliveredText(content: string): string | null {
  try {
    const d = (JSON.parse(content) as { __deliver?: unknown }).__deliver;
    return typeof d === "string" && d.trim() ? d : null;
  } catch {
    return null;
  }
}

export async function conversationView(id: string): Promise<ChatView | null> {
  const conv = await loadConversation(id);
  if (!conv) return null;
  const msgs = await loadMessages(id);
  const results = new Map<string, { ok: boolean; summary: string }>();
  for (const m of msgs)
    for (const b of m.content)
      if (b.type === "tool_result") {
        let summary = "";
        try {
          summary = String((JSON.parse(b.content) as { __summary?: string }).__summary ?? "");
        } catch {
          summary = "";
        }
        results.set(b.toolUseId, { ok: !b.isError, summary });
      }
  const out: ChatView["messages"] = [];
  for (const m of msgs) {
    if (m.role === "user") {
      const t = textOf(m.content);
      if (t) out.push({ role: "user", text: t });
      // Câu mẫu AI chọn gửi (`send_quick_reply`) — nằm trong kết quả công cụ, hiện ra (và gửi đi) như một tin của bot.
      for (const b of m.content) if (b.type === "tool_result") {
        const d = deliveredText(b.content);
        if (d) out.push({ role: "assistant", text: d });
      }
      continue;
    }
    const tools = m.content.filter((b): b is Extract<AiBlock, { type: "tool_use" }> => b.type === "tool_use").map((b) => ({ name: b.name, ...(results.get(b.id) ?? { ok: true, summary: "" }) }));
    const t = textOf(m.content);
    const last = out[out.length - 1];
    if (!t && tools.length && last?.role === "assistant") last.tools = [...(last.tools ?? []), ...tools];
    else if (t || tools.length) out.push({ role: "assistant", text: t, ...(tools.length ? { tools } : {}) });
  }
  const state = (conv.state ?? {}) as ChatState;
  const orderId = state.confirmed?.orderId ?? state.draft?.orderId ?? null;
  const simulated = Boolean(state.confirmed?.simulated ?? state.draft?.simulated);
  return {
    conversationId: conv.id,
    status: conv.status as ChatView["status"],
    messages: out,
    order: state.draft || state.confirmed ? { id: orderId ? `#${manualOrderShortCode(orderId)}` : null, stage: state.confirmed ? "CONFIRMED" : "NEW", simulated, total: orderTotalsOf(state) } : null,
  };
}

let providerOverride: ((cfg: SalesChatbotConfig) => AiProvider | null) | null = null;

/** Nhà cung cấp AI của chatbot (khoá BYOK của tổ chức; bài kiểm thay được) — dùng chung cho «Học từ hội thoại cũ». */
export async function salesChatProvider(): Promise<{ ok: true; provider: AiProvider } | { ok: false; error: string }> {
  return providerFor(await loadSalesChatbotConfig());
}

/** Sổ tay ĐÃ XUẤT BẢN (`lib/sales-chatbot/playbook.ts`) — '' khi chưa có. Đọc thẳng settings, không import vòng. */
async function publishedPlaybook(): Promise<string> {
  return (parsePlaybookState(await readJsonSetting(PLAYBOOK_SETTING_KEY)).published?.text ?? "").slice(0, PLAYBOOK_LIMITS.playbookChars);
}
/** Chỉ bài kiểm: provider giả (luật 65 — không gọi mạng thật). `null` để gỡ. */
export function setSalesChatProviderForTests(fn: ((cfg: SalesChatbotConfig) => AiProvider | null) | null) {
  providerOverride = fn;
}

async function providerFor(cfg: SalesChatbotConfig): Promise<{ ok: true; provider: AiProvider } | { ok: false; error: string }> {
  if (providerOverride) {
    const p = providerOverride(cfg);
    return p ? { ok: true, provider: p } : { ok: false, error: "Không có AI (kiểm thử)." };
  }
  const conn = await openActiveConnection(cfg.connectorKey);
  if (!conn.ok) return { ok: false, error: `Chưa dùng được khoá AI «${cfg.connectorKey}»: ${conn.reason}` };
  const apiKey = conn.secrets.apiKey ?? "";
  if (!apiKey) return { ok: false, error: "Kết nối AI thiếu khoá." };
  const model = cfg.model || conn.settings.model || null;
  const provider = cfg.connectorKey === "anthropic-byok" ? new ByokAnthropicProvider({ apiKey, model }) : cfg.connectorKey === "gemini-byok" ? new ByokGeminiProvider({ apiKey, model }) : new ByokOpenAiProvider({ apiKey, model });
  return { ok: true, provider };
}

/**
 * `media` = ảnh của CÂU TRẢ LỜI MẪU vừa gửi (0183) — kênh fanpage gửi qua Pancake ngay sau tin có chữ `afterText` (chữ của
 * chính câu mẫu đó); thiếu ⇒ sau toàn bộ phần chữ.
 */
export type TurnResult = { ok: true; view: ChatView; media?: { quickReplyId: string; imageIds: string[]; afterText?: string } } | { ok: false; error: string; view?: ChatView | null };

async function reply(conv: ConvRow, seq: number, text: string): Promise<void> {
  await appendMessage(conv.id, seq, "assistant", [{ type: "text", text }]);
}

/** Trần tin của một khách truy cập (WEB) trong 10 phút và của cả tổ chức trong ngày — chống bão tin làm tốn tiền của shop. */
async function webRateProblem(conv: ConvRow): Promise<string | null> {
  const db = await getDb();
  const m = schema.salesChatMessages;
  const c = schema.salesChatConversations;
  if (conv.visitorKey) {
    const [r] = await db
      .select({ n: sql<number>`count(*)` })
      .from(m)
      .innerJoin(c, eq(c.id, m.conversationId))
      .where(and(eq(c.visitorKey, conv.visitorKey), eq(m.role, "user"), gte(m.createdAt, new Date(Date.now() - 10 * 60_000)), sql`${m.content}->0->>'type' = 'text'`));
    if (Number(r?.n ?? 0) >= SALES_CHATBOT_LIMITS.webMessagesPerVisitorPer10Min) return "Anh/chị nhắn nhanh quá — đợi vài phút rồi nhắn tiếp giúp em nhé.";
  }
  const [d] = await db.select({ n: sql<number>`coalesce(sum(${c.turns}), 0)` }).from(c).where(and(inArray(c.channel, ["WEB", "FANPAGE"]), gte(c.updatedAt, new Date(Date.now() - 24 * 3_600_000))));
  if (Number(d?.n ?? 0) >= SALES_CHATBOT_LIMITS.webTurnsPerOrgPerDay) return "Shop đang quá tải tin nhắn — nhân viên sẽ liên hệ lại sớm ạ.";
  return null;
}

/**
 * Khoá AI của shop hỏng kiểu KHÔNG tự khỏi (hết credit · bị từ chối) ⇒ MỘT thông báo cho chủ shop mỗi lớp lỗi mỗi ngày (giờ
 * VN) — không phải một thông báo cho mỗi khách đâm vào tường. Lỗi tự khỏi (quá tải) không báo: nó chỉ đổ nhiễu.
 */
async function notifyProviderFailure(lastError: string | null, now: Date): Promise<void> {
  const e = salesBotError(lastError);
  if (e?.notify) await notifySalesChatAiDown(e.kind, e.label, now);
}

/**
 * AI KHÔNG TRẢ LỜI ĐƯỢC ⇒ CHUYỂN NGƯỜI (UAT U29). Khách chỉ nhận câu xin lỗi + câu chuyển người shop đã khai; hội thoại
 * sang `HANDOFF`; nhân viên nhận MỘT thông báo gọi lại khách cho hội thoại đó (cùng khoá với công cụ `handoff_to_human`).
 * Khung THỬ không sinh thông báo — nó là của chủ shop, không có khách thật nào chờ.
 */
export const AI_DOWN_HANDOFF_REASON = "AI tạm không trả lời được — nhân viên liên hệ lại khách";

function aiDownReply(cfg: SalesChatbotConfig): string {
  return `Xin lỗi, em đang gặp trục trặc. ${cfg.handoff.message}`;
}

async function notifyAiDownHandoff(conv: ConvRow, state: ChatState, channel: ChatChannel, now: Date): Promise<void> {
  if (!isPublicChannel(channel)) return;
  await notifySalesChatHandoff(conv.id, AI_DOWN_HANDOFF_REASON, state.customer, now);
}

/**
 * MỘT lượt khách gõ. `channel` và `visitorKey` do nơi gọi (máy chủ) quyết — hội thoại phải đúng kênh, và kênh WEB phải
 * đúng khách truy cập đã mở nó (không đọc / gõ tiếp hội thoại của người khác bằng cách đoán id).
 */
export async function chatTurn(conversationId: string, rawText: string, opts: { channel: ChatChannel; visitorKey?: string | null; actorId?: string | null; now?: Date }): Promise<TurnResult> {
  const text = rawText.trim().slice(0, SALES_CHATBOT_LIMITS.messageMax);
  if (!text) return { ok: false, error: "Tin nhắn trống." };
  if (!(await canUseModule("ai_sales"))) return { ok: false, error: "Module AI bán hàng chưa bật cho tổ chức này." };
  const conv = await loadConversation(conversationId);
  if (!conv || conv.channel !== opts.channel || (isPublicChannel(opts.channel) && conv.visitorKey !== (opts.visitorKey ?? null))) return { ok: false, error: "Không có hội thoại này." };
  const cfg = await loadSalesChatbotConfig();
  if (isPublicChannel(opts.channel) && !cfg.enabled) return { ok: false, error: "Shop chưa mở chat." };
  const now = opts.now ?? new Date();
  const msgs = await loadMessages(conv.id);
  let seq = (msgs[msgs.length - 1]?.seq ?? 0) + 1;
  try {
    await appendMessage(conv.id, seq++, "user", [{ type: "text", text }]);
    const db = await getDb();
    const bump = async (patch: Partial<typeof schema.salesChatConversations.$inferInsert>) => {
      await db.update(schema.salesChatConversations).set({ ...patch, updatedAt: new Date() }).where(eq(schema.salesChatConversations.id, conv.id));
    };
    if (conv.status === "HANDOFF") {
      await reply(conv, seq, "Nhân viên của shop đang tiếp nhận hội thoại này — anh/chị đợi chút nhé.");
      await bump({ turns: conv.turns + 1 });
      return { ok: true, view: (await conversationView(conv.id))! };
    }
    if (isPublicChannel(opts.channel) && !withinBusinessHours(cfg.businessHours, now)) {
      await reply(conv, seq, cfg.businessHours.outsideMessage);
      await bump({ turns: conv.turns + 1 });
      return { ok: true, view: (await conversationView(conv.id))! };
    }
    if (conv.turns >= SALES_CHATBOT_LIMITS.turnsPerConversation) {
      await reply(conv, seq, cfg.handoff.message);
      await bump({ status: "HANDOFF", handoffReason: "Hội thoại quá dài", turns: conv.turns + 1 });
      return { ok: true, view: (await conversationView(conv.id))! };
    }
    if (isPublicChannel(opts.channel)) {
      const limited = await webRateProblem(conv);
      if (limited) {
        await reply(conv, seq, limited);
        return { ok: true, view: (await conversationView(conv.id))! };
      }
    }
    // CÂU TRẢ LỜI MẪU (0183 · lib/sales-chatbot/quick-replies.ts): khớp CHỮ trước — 0 token. Khách đang có đơn nháp chưa
    // chốt ⇒ bỏ qua câu mẫu (chốt đơn cần công cụ của AI). Bước AI ĐỌC HIỂU chạy SAU công tắc / hạn mức / khoá bên dưới.
    const qrSettings = await loadQuickReplySettings();
    const st0 = (conv.state ?? {}) as ChatState;
    // Câu bot / page vừa nói — câu mẫu TRÙNG một câu trong số này thì không gửi lại (khách đang trả lời nó).
    const recentSaid = recentShopTexts(msgs, 4);
    const quick: QuickReplyStep = qrSettings.enabled ? await quickReplyByKeyword(text, { ordering: Boolean(st0.draft && !st0.confirmed), cfg, recent: recentSaid }) : { kind: "SKIP", reason: "Câu mẫu đang tắt" };
    const sendQuick = async (pick: QuickReplyPick, ai: { calls: number; inTok: number; outTok: number } | null): Promise<TurnResult> => {
      await reply(conv, seq, pick.text);
      await markQuickReplyUsed(pick.entry.id, now).catch(() => undefined);
      await bump({
        turns: conv.turns + 1,
        quickReplies: conv.quickReplies + 1,
        ...(ai ? { aiCalls: conv.aiCalls + ai.calls, inputTokens: conv.inputTokens + ai.inTok, outputTokens: conv.outputTokens + ai.outTok } : {}),
      });
      return { ok: true, view: (await conversationView(conv.id))!, media: { quickReplyId: pick.entry.id, imageIds: pick.imageIds } };
    };
    if (quick.kind === "ANSWER") return sendQuick(quick.pick, null);
    const org = await currentOrganization();
    // Trang công khai: khách KHÔNG BAO GIỜ đọc lý do nội bộ (công tắc, hạn mức gói, khoá) — chuyển người, báo chủ shop.
    // Khung THỬ của chủ shop giữ nguyên câu lỗi để họ sửa được.
    const blocked = async (key: string, ownerLabel: string, internal: string): Promise<TurnResult> => {
      if (!isPublicChannel(opts.channel)) return { ok: false, error: internal };
      const st = (conv.state ?? {}) as ChatState;
      await reply(conv, seq, aiDownReply(cfg));
      await bump({ turns: conv.turns + 1, status: "HANDOFF", handoffReason: AI_DOWN_HANDOFF_REASON });
      await notifyAiDownHandoff(conv, st, opts.channel, now).catch(() => undefined);
      await notifySalesChatAiDown(key, ownerLabel, now).catch(() => undefined);
      return { ok: true, view: (await conversationView(conv.id))! };
    };
    const killed = await aiKillSwitchDenial(org.code);
    if (killed) return blocked("DISABLED", "AI đang bị người vận hành nền tảng tạm tắt cho tổ chức này — liên hệ người vận hành", `AI đang tắt: ${killed}`);
    const quota = await checkAiQuota(org.code, "BYOK");
    if (!quota.ok) {
      await recordAiUsage({ orgCode: org.code, feature: "sales_chatbot", source: "BYOK", provider: null, model: null, requests: 0, inputTokens: null, outputTokens: null, costUsd: null, status: "BLOCKED_QUOTA", actorId: opts.actorId ?? null, ref: conv.id }).catch(() => undefined);
      return blocked("QUOTA", "Tổ chức đã dùng hết hạn mức AI của gói dịch vụ — nâng gói hoặc chờ kỳ sau", quota.error);
    }
    const prov = await providerFor(cfg);
    if (!prov.ok) return blocked("CONNECTION", "Kết nối AI của shop chưa dùng được — mở Cài đặt → Kết nối, kiểm tra lại khoá AI", prov.error);
    // AI ĐỌC HIỂU (0183): một lời gọi NHỎ chỉ chọn mã câu mẫu — chọn được ⇒ trả lời bằng câu mẫu, khỏi lượt chatbot đầy đủ.
    // Lỗi ở bước này không chặn khách: đi tiếp đường chatbot đầy đủ (nó tự xử lý lỗi nhà cung cấp).
    const pre = { calls: 0, inTok: 0, outTok: 0 };
    if (quick.kind === "NO_MATCH" && qrSettings.aiMatch) {
      try {
        const lastShop = [...msgs].reverse().find((m) => m.role === "assistant" && textOf(m.content));
        const { pick, res } = await quickReplyByAi(prov.provider, text, lastShop ? textOf(lastShop.content) : "", quick.candidates, cfg);
        const inT = res.usage.inputTokens + res.usage.cacheReadTokens + res.usage.cacheWriteTokens;
        await recordAiUsage({ orgCode: org.code, feature: "sales_chatbot", source: "BYOK", provider: prov.provider.name, model: res.model || prov.provider.model, requests: 1, inputTokens: inT, outputTokens: res.usage.outputTokens, costUsd: estimateCostUsd(res.model || prov.provider.model, res.usage), status: "OK", actorId: opts.actorId ?? null, ref: conv.id }).catch(() => undefined);
        Object.assign(pre, { calls: 1, inTok: inT, outTok: res.usage.outputTokens });
        if (pick && !repeatsRecent(pick.text, recentSaid)) return sendQuick(pick, pre);
      } catch (error) {
        if (error instanceof SeqConflict) throw error;
      }
    }
    const orgRow = await findOrganization(org.code);
    const quickCatalog = await quickReplyCatalog();
    // KHÁCH CŨ (02/10/2026): những gì shop đã biết về khách — không bắt khách khai lại SĐT / địa chỉ. Lỗi đọc ⇒ như khách mới.
    const known = (conv.state ?? {}) as ChatState;
    const returning = await findReturningCustomer(known).catch(() => null);
    // ĐẶT LỊCH: shop bật trong cấu hình bot VÀ tổ chức bật module Lịch hẹn — thiếu một trong hai thì bot không có công cụ đặt lịch.
    const bookingOn = cfg.booking.enabled && (await canUseModule("appointments"));
    const system = systemPrompt(cfg, orgRow?.name ?? org.code, await businessProfile(), opts.channel, await publishedPlaybook(), quickCatalog, returningCustomerPrompt(returning, known.returning), bookingOn ? bookingPrompt(cfg, now) : "", now);
    const deliveredImages: string[] = [];
    let deliveredReplyId: string | null = null;
    let deliveredText: string | null = null;
    const tools = toolDefsFor(cfg, { bookingOn });
    const history = historyForModel([...msgs, { role: "user", content: [{ type: "text", text }], at: now }], SALES_CHATBOT_LIMITS.historyMessages);
    let state = (conv.state ?? {}) as ChatState;
    let calls = 0;
    let inTok = 0;
    let outTok = 0;
    let cost: number | null = 0;
    let model = prov.provider.model;
    let status: "OK" | "ERROR" = "OK";
    let lastError: string | null = null;
    try {
      for (let round = 0; round < SALES_CHATBOT_LIMITS.toolRounds; round++) {
        // Mức suy nghĩ theo cấu hình (Kỹ = suy luận vừa, Nhanh = thấp) — ngân sách đủ rộng để phần suy luận không ăn hết câu
        // trả lời (01/10/2026: suy luận ăn chung `max_output_tokens`).
        const res = await prov.provider.complete({ system, messages: history, tools, ...SALES_THINKING_BUDGET[cfg.thinking] });
        calls += 1;
        inTok += res.usage.inputTokens + res.usage.cacheReadTokens + res.usage.cacheWriteTokens;
        outTok += res.usage.outputTokens;
        model = res.model || model;
        const c = estimateCostUsd(res.model || prov.provider.model, res.usage);
        cost = cost === null || c === null ? null : cost + c;
        const content = res.content.length ? res.content : [{ type: "text" as const, text: "Dạ, anh/chị nói rõ hơn giúp em nhé." }];
        history.push({ role: "assistant", content });
        await appendMessage(conv.id, seq++, "assistant", content);
        const uses = content.filter((b): b is Extract<AiBlock, { type: "tool_use" }> => b.type === "tool_use");
        if (uses.length === 0) break;
        const results: AiBlock[] = [];
        for (const u of uses) {
          const r = await executeTool(u.name, u.input, { conversationId: conv.id, channel: opts.channel, config: cfg, state, lastUserText: text, agent: SALES_AGENT, quickReplies: quickCatalog, returning, recentSaid, bookingOn, now });
          state = r.state;
          if (r.deliver) {
            deliveredImages.push(...r.deliver.imageIds);
            deliveredReplyId = r.deliver.quickReplyId;
            deliveredText = r.deliver.text;
            await markQuickReplyUsed(r.deliver.quickReplyId, now).catch(() => undefined);
          }
          // Công cụ thấy điều bất thường (giá thiếu, tồn âm) ⇒ CẦN NGƯỜI XỬ LÝ — không để AI tự quyết bán tiếp.
          if (r.requireHuman && !state.handoff) {
            state = { ...state, handoff: { reason: `Cần người xử lý — ${r.requireHuman}`, at: now.toISOString() } };
            if (isPublicChannel(opts.channel)) await notifySalesChatHandoff(conv.id, state.handoff!.reason, state.customer, now).catch(() => undefined);
          }
          const payload = (() => {
            try {
              return JSON.stringify({ ...(JSON.parse(r.content) as Record<string, unknown>), __summary: r.summary, ...(r.deliver ? { __deliver: r.deliver.text } : {}) });
            } catch {
              return r.content;
            }
          })();
          results.push({ type: "tool_result", toolUseId: u.id, content: payload, isError: r.isError });
        }
        history.push({ role: "user", content: results });
        await appendMessage(conv.id, seq++, "user", results);
        await bump({ state: state as Record<string, unknown> });
        if (state.handoff) break;
        if (round === SALES_CHATBOT_LIMITS.toolRounds - 1) {
          await reply(conv, seq++, "Dạ em cần kiểm thêm — anh/chị đợi nhân viên hỗ trợ giúp em nhé.");
          state = { ...state, handoff: { reason: "Quá số vòng công cụ", at: new Date().toISOString() } };
        }
      }
    } catch (error) {
      status = "ERROR";
      lastError = error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
      if (error instanceof SeqConflict) throw error;
      await reply(conv, seq++, aiDownReply(cfg)).catch(() => undefined);
      state = { ...state, handoff: { reason: AI_DOWN_HANDOFF_REASON, at: now.toISOString() } };
      await notifyAiDownHandoff(conv, state, opts.channel, now).catch(() => undefined);
      await notifyProviderFailure(lastError, now).catch(() => undefined);
    }
    await recordAiUsage({ orgCode: org.code, feature: "sales_chatbot", source: "BYOK", provider: prov.provider.name, model, requests: calls, inputTokens: inTok, outputTokens: outTok, costUsd: calls ? cost : null, status, actorId: opts.actorId ?? null, ref: conv.id }).catch(() => undefined);
    await bump({
      state: state as Record<string, unknown>,
      turns: conv.turns + 1,
      aiCalls: conv.aiCalls + pre.calls + calls,
      inputTokens: conv.inputTokens + pre.inTok + inTok,
      outputTokens: conv.outputTokens + pre.outTok + outTok,
      lastError,
      ...(state.handoff && conv.status !== "HANDOFF" ? { status: "HANDOFF", handoffReason: state.handoff.reason } : {}),
      ...(state.customer?.id ? { customerId: state.customer.id } : {}),
      ...(state.draft?.orderId ? { draftOrderId: state.draft.orderId } : {}),
      ...(state.confirmed?.orderId ? { orderId: state.confirmed.orderId } : {}),
    });
    return { ok: true, view: (await conversationView(conv.id))!, ...(deliveredImages.length && deliveredReplyId ? { media: { quickReplyId: deliveredReplyId, imageIds: deliveredImages, ...(deliveredText ? { afterText: deliveredText } : {}) } } : {}) };
  } catch (error) {
    if (error instanceof SeqConflict) return { ok: false, error: error.message, view: await conversationView(conv.id) };
    throw error;
  }
}

/** Thêm MỘT tin của bot vào cuối hội thoại (follow-up · 0185) — seq kế tiếp; va seq (lượt khác vừa ghi) ⇒ thử lại một lần. */
export async function appendBotMessage(conversationId: string, text: string): Promise<void> {
  for (let i = 0; i < 2; i++) {
    const msgs = await loadMessages(conversationId);
    try {
      await appendMessage(conversationId, (msgs[msgs.length - 1]?.seq ?? 0) + 1, "assistant", [{ type: "text", text }]);
      return;
    } catch (error) {
      if (!(error instanceof SeqConflict) || i === 1) throw error;
    }
  }
}

/** Số hội thoại đang CHỜ KHÁCH (follow-up · 0185). */
export async function countWaitingConversations(): Promise<number> {
  const db = await getDb();
  const c = schema.salesChatConversations;
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(c).where(eq(c.status, "WAITING"));
  return Number(r?.n ?? 0);
}

/**
 * Đưa những gì PAGE đã nói (trả lời tự động của Meta, nhân viên) và tin khách bot đã bỏ qua vào LỊCH SỬ hội thoại trước lượt
 * AI — đo 01/10/2026: khách «Ship c 1kí» ngay sau trả lời tự động báo giá chả cá thu, bot không thấy tin ấy nên hỏi lại «chị
 * lấy món nào». Tin của page mang tiền tố «[Shop đã nhắn]» (để AI phân biệt với câu của chính nó). Chỉ GHI LỊCH SỬ — nơi gọi
 * phải chèn TRƯỚC khi chụp số tin «trước lượt», nên những dòng này không bao giờ bị gửi lại cho khách.
 */
export async function appendContextMessages(conversationId: string, items: readonly { role: "user" | "assistant"; text: string }[]): Promise<void> {
  for (const it of items) {
    const text = it.text.trim();
    if (!text) continue;
    for (let i = 0; i < 2; i++) {
      const msgs = await loadMessages(conversationId);
      try {
        await appendMessage(conversationId, (msgs[msgs.length - 1]?.seq ?? 0) + 1, it.role, [{ type: "text", text: it.role === "assistant" ? `${SHOP_SAID} ${text}` : text }]);
        break;
      } catch (error) {
        if (!(error instanceof SeqConflict) || i === 1) throw error;
      }
    }
  }
}

/** Tiền tố tin của page / nhân viên trong lịch sử của bot. */
export const SHOP_SAID = "[Shop đã nhắn]";

/** Hội thoại gần đây cho màn hình quản trị. */
export async function listConversations(limit = 30) {
  const db = await getDb();
  const c = schema.salesChatConversations;
  return db
    .select({ id: c.id, channel: c.channel, status: c.status, turns: c.turns, customerId: c.customerId, orderId: c.orderId, draftOrderId: c.draftOrderId, handoffReason: c.handoffReason, lastError: c.lastError, updatedAt: c.updatedAt, stage: sql<string | null>`${c.state}->>'stage'` })
    .from(c)
    .orderBy(desc(c.updatedAt))
    .limit(limit);
}

/**
 * CẦN NGƯỜI XỬ LÝ ⇒ người xử lý xong TRẢ LẠI CHO AI (chủ shop 01/10/2026): hội thoại về `OPEN`, xoá lý do chuyển — tin khách
 * kế tiếp bot trả lời lại. Gọi từ server action (đã kiểm `ai_sales:manage`). `false` = không có / không ở trạng thái chuyển.
 */
export async function resumeConversationToAi(id: string): Promise<boolean> {
  const db = await getDb();
  const c = schema.salesChatConversations;
  const [row] = await db
    .update(c)
    .set({ status: "OPEN", handoffReason: null, state: sql`${c.state} - 'handoff'`, updatedAt: new Date() })
    .where(and(eq(c.id, id), eq(c.status, "HANDOFF")))
    .returning({ id: c.id });
  return Boolean(row);
}
