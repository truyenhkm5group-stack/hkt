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
import { and, desc, eq, inArray, ne, or } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import type { AiToolDef } from "@/lib/ai/provider";
import { freeSlots, slotBookable, vnDayOffset, vnInstant, WEEKDAY_LABEL } from "@/lib/constants/booking";
import { isManualOrderId, manualOrderGaps, manualOrderShortCode, manualOrderTotals } from "@/lib/constants/manual-orders";
import { foldVnText, resolveRecipientPlace } from "@/lib/address/vn-address";
import { vanDonDaiDien } from "@/lib/constants/shipment-pick";
import { CARRIER_EVENT_SOURCES } from "@/lib/constants/truth";
import { formatVND } from "@/lib/format";
import type { OrderValidationReason } from "@/lib/constants/ops-signals";
import type { MetaFailure } from "@/lib/metadata/errors";
import { quoteUnitPrice, type PriceListBook, type PriceSource } from "@/lib/constants/price-lists";
import { priceBooksFor } from "@/lib/queries/price-lists";
import { createCustomerAsAgent, normalizeCustomerPhone } from "@/lib/records/customer-create";
import { activeAppointmentRanges, createAppointmentAsAgent } from "@/lib/records/appointments";
import { createOrderAsAgent, flagOrderForReviewAsAgent, noteCustomerReconfirmAsAgent, updateOrderAsAgent, type AgentOrderOptions, type OrderAgent } from "@/lib/records/order-create";
import { conversationCancelTargets, executeCustomerCancel, raiseCancelException, recordCustomerCancelRequest, recordCustomerKeptOrder } from "@/lib/records/order-cancel";
import { CANCEL_BLOCK_LABEL } from "@/lib/constants/order-cancel";
import { chatOrderAdId } from "@/lib/sales-chatbot/ad-referral";
import { markOrderWritten, omsValidationReason, orderSignalToolReason, OrderWriteError, recordOrderValidationFailure, recordOrderWriteFailure, sqlStateOf, type OrderWriteMark } from "@/lib/sales-chatbot/order-signals";
import { agentUnitPrice } from "@/lib/commerce/pricing";
import { notifySalesChatBooking, notifySalesChatHandoff } from "@/lib/sales-chatbot/alerts";
import { foldVi } from "@/lib/sales-chatbot/text";
import { buildQuote, computePriced, loadPricingContext, packChoiceMistake, packingIssues, packingRequestOf, verifiedUnitPrices, type AgentQuoteClaim, type Priced, type PricingContext } from "@/lib/sales-chatbot/quote";
import { priceUnverifiedReason, QUOTE_UNVERIFIED_INSTRUCTION, quoteSnapshotOf, type PriceDisputeState, type Quote, type QuoteSnapshot } from "@/lib/sales-chatbot/quote-shared";
import { CLAIM_SAFE_TEXT, orderValidityOf } from "@/lib/sales-chatbot/claim-guard";
import type { ObjectionTally } from "@/lib/sales-chatbot/handoff-routing-shared";
import { bindCommitment, commitmentViolation, customerHesitates, declinesAddOnOnly, lineBasisViolation, type CartCommitment } from "@/lib/sales-chatbot/cart-commitment";
import { acceptCustomerWard, addressQuestion, canAutoFill, legacyAddressUnmapped, namesOtherWard, parseCustomerAddress, sameDeliveryPlace, wardFromCustomerWords, type AddressConfidence, type AddressPart } from "@/lib/address/customer-address";
import { askedBefore, askMemoryFor, askMemoryParts, askParts, deliveryAddressDecision, hasChangeCue, type AddressAskMemory } from "@/lib/sales-chatbot/address-memory";
import { searchCatalog, sellableCatalog, stockFor, type CatalogItem } from "@/lib/sales-chatbot/catalog";
import { quotedInText } from "@/lib/sales-chatbot/text";
import { isMessagingChannel, type ChatChannel, type SalesChatbotConfig, type SalesTool } from "@/lib/sales-chatbot/config";
import { renderQuickReplyForSend } from "@/lib/sales-chatbot/quick-replies";
import { repeatsRecent } from "@/lib/sales-chatbot/quick-replies-shared";
import type { OrderSyncThreadState } from "@/lib/sales-chatbot/order-sync-shared";
import { customerOrderStatus } from "@/lib/sales-chatbot/order-status-shared";
import { classifyDeliveryQuestion, deliveryTimeAnswer, pickDeliveryOrder, staffDeliveryCommitment } from "@/lib/sales-chatbot/delivery-intent";
import { customerComplaintSignal, LIFECYCLE_ORDER_LOOKBACK_DAYS } from "@/lib/sales-chatbot/lifecycle";
import { OFFER_BLOCK_LABEL, offerWindow, withOfferDrops, type OfferBlock, type SentenceClass } from "@/lib/sales-chatbot/next-best-action";
import { fanpageVisitorKeyMirror } from "@/lib/pricing/ai-customer-identity";
import type { PromptStamp } from "@/lib/sales-chatbot/prompt-stamp";
import type { PancakeThreadProfile, ReturningCustomer } from "@/lib/sales-chatbot/returning";
import type { Customer360 } from "@/lib/sales-chatbot/customer-360";

export type CartLine = { variantId: string; quantity: number };
export { onlyAddOns, type Priced } from "@/lib/sales-chatbot/quote";
/** `ward` = xã / phường MỚI khách đã XÁC NHẬN (`acceptCustomerWard`) — trống ⇒ lõi đơn tự đọc từ dòng địa chỉ. */
export type Recipient = { name: string; phone: string; address: string; province: string; ward?: string };
import { SALES_STAGE_LABEL, type SalesStage } from "@/lib/sales-chatbot/stages";

export { SALES_STAGE_LABEL, SALES_STAGES, type SalesStage } from "@/lib/sales-chatbot/stages";

export type ChatState = {
  /** `at` = lần ĐẦU khách để lại SĐT này (02/10/2026 — báo cáo chi phí AI / SĐT theo ngày); dòng cũ không có mốc. */
  /** `savedAddress` = địa chỉ do MÁY CHỦ điền từ đơn cũ khớp qua SĐT (`use_saved_address`) — bot chỉ thấy bản đã che. */
  /**
   * `verifiedIdentity` = hồ sơ là CHÍNH người đang nhắn — khớp mã Facebook (`returning.ts`, mức FB_ID). Chỉ khi đó hội thoại được
   * đọc dữ liệu thuộc chủ hồ sơ: lịch sử mua, bảng giá riêng, hạn mức nợ. Khớp hồ sơ có sẵn qua SĐT gõ tay, hồ sơ dựng từ địa chỉ
   * máy điền (`savedAddress`), đơn đã lên trong chính hội thoại (ai cũng lên được đơn ghi SĐT người khác), hay state cũ ⇒ không
   * (review bảo mật 08/10/2026). `savedAddress` = địa chỉ / tên do MÁY CHỦ điền từ
   * hồ sơ chủ SĐT — mọi màn đọc cho khách phải che.
   */
  customer?: { id: string | null; name: string; phone: string; address: string; province: string; simulated: boolean; at?: string; savedAddress?: boolean; verifiedIdentity?: boolean };
  /**
   * `shownTurn` = lượt (seq tin khách) bot lên / sửa đơn nháp và đọc tóm tắt; `firstShownTurn` = lượt khách thấy tóm tắt LẦN
   * ĐẦU. Chưa từng thấy tóm tắt ⇒ chốt chỉ ở lượt SAU; đã thấy ở lượt trước rồi đồng ý thêm / sửa món ⇒ sửa và chốt luôn.
   */
  /** `quote` = báo giá máy chủ của đơn nháp (`quote.ts`) — chốt đơn đối chiếu đúng mã này; đơn nháp trước 11/10/2026 không có. */
  /**
   * `seenQuoteId` / `seenLines` = báo giá + dòng hàng khách ĐÃ THẤY ở lượt trước (đổi số lượng / quy cách trong lượt này ⇒ báo giá cũ hết
   * hiệu lực, phải xin xác nhận tổng mới). `packing` = NGUYÊN VĂN yêu cầu đóng gói riêng của khách — ghi vào ghi chú đơn cho kho.
   */
  /** Bộ đếm phản đối món của lượt mua hiện tại (P0 #855 — `nextObjectionTally`, handoff-routing-shared.ts). */
  objectionTally?: ObjectionTally;
  draft?: { orderId: string | null; lines: CartLine[]; unitPrices: Record<string, number>; recipient: Recipient; note: string; simulated: boolean; shownTurn?: number; firstShownTurn?: number; quote?: AgentQuoteClaim; seenQuoteId?: string; seenLines?: CartLine[]; seenTotal?: number; packing?: string | null };
  /** Khách PHẢN ĐỐI giá (PRICE_DISPUTED, 11/10/2026) — engine ghi khi phát hiện; chốt đơn bị chặn tới khi máy chủ báo lại và khách xác nhận. */
  priceDispute?: PriceDisputeState;
  /**
   * Lượt gửi lời mời thêm món — lượt khách ngay sau đó nói «không lấy thêm» là từ chối lời mời, không phải hoãn đơn. Đơn nháp lên trong
   * CHÍNH lượt đó không tự chốt; cửa sổ lời mời (#868) đóng ở mọi lượt lên đơn nên điều này không làm chậm đơn hợp lệ.
   */
  upsellTurn?: number;
  /**
   * `stamp` = dấu lời nhắc / cấu hình / model / bản mã ĐÚNG lúc chốt (`prompt-stamp.ts`); đơn chốt trước 08/10/2026 không có.
   * `valid` / `pending` = đơn vừa chốt có QUA KIỂM không (`orderValidityOf`, đọc lại ngay sau lượt ghi — P0 11/10/2026): `false` ⇒ bot
   * KHÔNG được nói «đã lên đơn» (claim-guard). Đơn chốt trước bản này không có ⇒ claim-guard đọc CSDL.
   */
  /** `auto` = máy chủ TỰ CHỐT (P0-A) — khách sửa món / SĐT / địa chỉ ngay sau đó thì bot sửa chính đơn đã chốt, không chuyển người. */
  confirmed?: { orderId: string | null; simulated: boolean; total: number; at: string; stamp?: PromptStamp; quoteId?: string; valid?: boolean; pending?: "ADDRESS" | "CHECK" | null; auto?: boolean };
  /** Báo giá máy chủ GẦN NHẤT của hội thoại (giỏ / đơn nháp / chốt) — hàng rào số tiền đọc `amounts` khi `verified`. */
  quote?: QuoteSnapshot;
  /** Mốc REVISION của giỏ — ghi cả khi giỏ bị XOÁ (lượt mua mới), để một lượt cũ chạy chậm không dựng lại giỏ đã xoá (review 15/10/2026). */
  cartRev?: string;
  /** Mọi TỔNG / tiền hàng máy chủ đã tính cho các giỏ / đơn nháp trong hội thoại (`noteSeenTotals`) — hàng rào chặn nói lại tổng của giỏ CŨ. */
  seenTotals?: number[];
  /** Giá ĐÃ XÁC THỰC công cụ đọc đã trả cho model trong hội thoại (search / get_product / get_current_price) — tối đa `PRICE_FACTS_MAX`. */
  priceFacts?: number[];
  /** Đơn đã chốt của các lượt mua TRƯỚC trong cùng hội thoại (khách mua lại sau `POST_ORDER_HANDOFF_MS`) — báo cáo vẫn đếm. */
  pastOrders?: { orderId: string | null; simulated: boolean; total: number; at: string }[];
  handoff?: { reason: string; at: string };
  stage?: SalesStage;
  /** Đã có MỘT lời mời mua thêm trong lượt mua này (câu mẫu UPSELL hoặc câu bot máy chủ nhận ra — #868); xoá khi sang lượt mua mới. */
  upsellSent?: boolean;
  /** Câu upsell không gửi được (thiếu số ERP) — chỉ để đo; từ 16/10/2026 câu upsell KHÔNG còn là điều kiện lên đơn (#868). */
  upsellUnavailable?: boolean;
  /** Lượt khách TỪ CHỐI lời mời mua thêm của lượt mua này (`offerDeclinedBy`, next-best-action.ts) — không mời lại trong lượt mua. */
  upsellDeclinedTurn?: number;
  /** Lời mời máy chủ đã BỎ (sai lúc / không đủ căn cứ — `guardReply` / cửa sổ của câu mẫu UPSELL), có trần — để đo, không để bot đọc. */
  offerDrops?: { turn: number | null; cls: SentenceClass; reason: OfferBlock; via: "TEXT" | "QUICK_REPLY" }[];
  declined?: { reason: string; at: string };
  /**
   * KHÁCH XIN HUỶ ĐƠN ĐÃ CÓ (chủ shop 10/10/2026 — `lib/constants/order-cancel.ts`): lượt GIỮ ĐƠN đang mở. `turn` = lượt khách xin huỷ
   * lần đầu — huỷ thật chỉ ở một lượt SAU (khách đã nghe lời giữ đơn mà vẫn huỷ). `orderIds` = đơn đang mở lúc khách xin huỷ.
   */
  cancelRequest?: { orderIds: string[]; at: string; turn: number | null; quote: string | null; reason: string };
  /** Đơn ĐÃ HUỶ theo yêu cầu khách trong hội thoại — chỉ ghi SAU KHI lõi đơn ghi «Đã huỷ» xong. */
  cancelledOrders?: { orderId: string | null; at: string; simulated: boolean }[];
  /** Lịch hẹn bot đã đặt trong hội thoại này (một hội thoại một lịch — đổi / huỷ là việc của người). */
  appointment?: { id: string | null; service: string; startsAt: string; name: string; phone: string; simulated: boolean; at: string };
  /** Mốc tin fanpage (page / khách bị bỏ qua) đã chép vào lịch sử của bot — `appendContextMessages`. */
  mirroredUntil?: string;
  /** Hồ sơ hội thoại đọc từ Pancake (SĐT đã ghi nhận, mã Facebook, tin cũ trước khi bot vào) — `lib/sales-chatbot/returning.ts`. */
  returning?: PancakeThreadProfile;
  /** Nội dung bài viết khách bình luận dưới (`null` = đã hỏi Pancake, không đọc được) — đọc một lần mỗi bài. */
  postContext?: { postId: string; text: string | null };
  /** Số lượt của hội thoại lúc lượt mua hiện tại bắt đầu — trần lượt (`turnsPerConversation`) đếm theo LƯỢT MUA, không theo đời hội thoại. */
  cycleStartTurns?: number;
  /**
   * ĐỊA CHỈ CHƯA CHUẨN HOÁ (P0 address-normalize 11/10/2026): lượt đầu tiên câu hỏi lại khách (`addressQuestion`) được đưa cho bot
   * cho ĐÚNG địa chỉ `key`. `confirm_order` chỉ chốt đơn có địa chỉ mơ hồ / không đọc được khi câu hỏi đã có ở một lượt TRƯỚC.
   * Từ 15/10/2026 nhớ theo PHẦN địa chỉ (`parts`) — phần đã hỏi ở lượt trước không bao giờ được hỏi lại (`AddressAskMemory`).
   */
  addressAsk?: AddressAskMemory;
  /** Nhật ký GHI ĐƠN TỪ HỘI THOẠI (`order-sync.ts`) — bot không bao giờ ghi khoá này; engine giữ bản trong CSDL khi lưu. */
  orderSync?: OrderSyncThreadState;
  /**
   * GIỎ CÓ THẨM QUYỀN (P0 12/10/2026 — `cart-commitment.ts`): món + số lượng khách nói TƯỜNG MINH (dính tới khi khách sửa tường minh) +
   * món bot đề xuất. Engine ghi từ tin khách; công cụ ghi đơn đối chiếu (từ chối hạ / bỏ) và gắn mẫu mã khi đơn nháp lên.
   */
  cart?: CartCommitment;
};

/** Công cụ QUY TRÌNH — luôn bật (không nằm trong `allowedTools` đã lưu của tổ chức, nên công cụ mới tới được mọi tổ chức). */
export const PROCESS_TOOLS = ["send_quick_reply", "set_sales_stage", "lookup_customer", "mark_declined", "get_order_status", "cancel_order"] as const;
export type ProcessTool = (typeof PROCESS_TOOLS)[number];

/** Công cụ ĐẶT LỊCH — chỉ khi shop bật «Nhận đặt lịch qua chat» VÀ tổ chức bật module Lịch hẹn (`ToolContext.bookingOn`). */
export const BOOKING_TOOLS = ["find_booking_slots", "book_appointment"] as const;
/** Nghĩa của `quantity` trên đơn — mẫu mã đã mang quy cách (vd «2kg») thì một đơn vị là CẢ gói đó (`packQuantityMistake`). */
export const QUANTITY_HINT = "Số GÓI / đơn vị của ĐÚNG mẫu mã này, KHÔNG phải số kg: mẫu mã «2kg» × 1 = 2kg; khách nói «2kg» ⇒ mẫu mã 2kg × 1 (hoặc 1kg × 2), KHÔNG BAO GIỜ 2kg × 2.";
export type BookingTool = (typeof BOOKING_TOOLS)[number];

export type ToolContext = {
  conversationId: string;
  /**
   * Tin của KHÁCH (chữ thô, cũ ⇒ mới) trong cửa sổ lịch sử của lượt — căn cứ đọc ĐỊA CHỈ KHÁCH TỰ GÕ khi dòng địa chỉ model chép vào
   * công cụ mất phần xã / phường (`wardFromCustomerWords`) và căn cứ «khách đã nói tên xã» (`acceptCustomerWard`).
   */
  customerTexts?: readonly string[];
  /** CHỮ MUA của khách trong lượt mua hiện tại (`buyingText` — bỏ câu hỏi giá / câu từ chối) — căn cứ «khách đã gọi tên món» (`lineBasisViolation`). */
  customerSaid?: string;
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
  /** Hồ sơ Customer 360 của lượt (`customer-360.ts`) — nguồn của `saved_address_choice` khi khách có nhiều địa chỉ cũ. */
  customer360?: Customer360 | null;
  /** Câu shop vừa nói (`recentShopTexts`) — câu mẫu trùng một câu trong đó không gửi lại. */
  recentSaid?: readonly string[];
  /** Shop bật đặt lịch qua chat VÀ module Lịch hẹn đang bật — engine tính, công cụ đặt lịch chỉ chạy khi `true`. */
  bookingOn?: boolean;
  /** Đồng hồ của lượt (kiểm thử truyền vào; mặc định bây giờ). */
  now?: Date;
  /** Mã lượt = seq tin khách của lượt này (engine). Thiếu (bài kiểm gọi lẻ công cụ) ⇒ không xét «cùng lượt». */
  turn?: number;
  /** Seq tin khách NGAY TRƯỚC lượt này (engine) — «khách trả lời lời mời thêm món / tóm tắt ở lượt kế» (P0-A, giỏ có thẩm quyền). */
  prevTurn?: number;
  /** Tên Facebook của khách (kênh fanpage) — `create_customer` dùng khi AI không ghi tên. */
  customerName?: string | null;
  /** Lượt này trả lời BÌNH LUẬN công khai (engine — cùng gợi ý cổng Số dư AI dùng). Công cụ đọc đơn không chạy trong lượt này. */
  commentTurn?: boolean;
  /** Dấu lời nhắc của lượt (engine dựng, kèm model của ĐÚNG lần gọi ra lệnh này) — `confirm_order` gắn vào `state.confirmed`. */
  promptStamp?: PromptStamp;
  /** Do `executeTool` đặt (không phải engine): công cụ đánh dấu NGAY SAU KHI lõi đơn ghi xong ⇒ lỗi ném sau đó là lỗi SAU GHI. */
  writeMark?: OrderWriteMark;
  /**
   * TỰ CHỐT KHI ĐỦ ĐƠN (chủ shop ghi đè 11/10/2026, P0-A): engine bật khi tổ chức bật «đơn đủ thông tin = đã xác nhận»
   * (`AUTO_CONFIRM_COMPLETE_SETTING_KEY`). Đơn nháp vừa lên / sửa mà đủ điều kiện (`autoConfirmBlocker` = null) ⇒ máy chủ chốt luôn
   * trong cùng công cụ, KHÔNG hỏi khách xác nhận lại.
   */
  autoConfirm?: boolean;
  /** Do chính công cụ đặt khi gọi lượt chốt tự động — bỏ hai cổng «khách thấy tóm tắt» + «nguyên văn lời đồng ý». */
  autoConfirming?: boolean;
};

/**
 * `deliver` = câu mẫu máy chủ GỬI NGUYÊN VĂN cho khách (đã điền số ERP) + ảnh; `requireHuman` = công cụ thấy điều bất thường
 * (giá thiếu, tồn âm) ⇒ engine chuyển hội thoại sang CẦN NGƯỜI XỬ LÝ, không để AI tự quyết.
 */
export type ToolOutcome = {
  content: string;
  isError: boolean;
  summary: string;
  state: ChatState;
  deliver?: { text: string; imageIds: string[]; quickReplyId: string };
  requireHuman?: string;
  /**
   * ĐƠN KHÔNG HỢP LỆ (sứ mệnh saas-ops-signals): công cụ / lõi đơn từ chối vì DỮ LIỆU (thiếu SĐT / địa chỉ, mã không có, chưa có giá,
   * thiếu hàng, hạn mức nợ…) ⇒ `executeTool` ghi `order.validation_failed` (lib/sales-chatbot/order-signals.ts). Từ chối vì TRÌNH TỰ
   * hội thoại (chưa mời thêm món, khách chưa thấy tóm tắt, chưa có lời xác nhận) KHÔNG phải đơn hỏng — không gắn. Không gửi model.
   */
  orderSignal?: { reason: OrderValidationReason; fields?: readonly string[] };
};

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
      "Lưu thông tin người mua sau khi khách đã cho số điện thoại + địa chỉ giao (họ tên: bỏ trống ⇒ máy chủ dùng tên Facebook của khách). SĐT đã có trong sổ ⇒ dùng lại đúng khách đó. KHÁCH CŨ có địa chỉ ĐÃ CHE và khách vừa xác nhận giao như lần trước ⇒ use_saved_address = true + customer_confirmation = nguyên văn lời xác nhận (bỏ trống phone / address — máy chủ tự điền). Khối TRA LỊCH SỬ liệt kê nhiều địa chỉ cũ và khách chọn một ⇒ thêm saved_address_choice = số thứ tự khách chọn.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" }, phone: { type: "string" }, address: { type: "string" }, province: { type: "string" }, use_saved_address: { type: "boolean" }, saved_address_choice: { type: "integer", minimum: 1 }, customer_confirmation: { type: "string" } },
      required: [],
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
        items: { type: "array", items: { type: "object", properties: { variant_id: { type: "string" }, quantity: { type: "integer", minimum: 1, description: QUANTITY_HINT } }, required: ["variant_id", "quantity"], additionalProperties: false } },
        recipient_name: { type: "string" },
        recipient_phone: { type: "string" },
        address: { type: "string" },
        ward: { type: "string", description: "Xã / phường MỚI (sau 01/07/2025) — CHỈ khi KHÁCH vừa tự nói tên đó trong câu cuối (thường là trả lời câu hỏi address_check.ask_customer). Không tự chọn một ứng viên thay khách." },
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
        items: { type: "array", items: { type: "object", properties: { variant_id: { type: "string" }, quantity: { type: "integer", minimum: 1, description: QUANTITY_HINT } }, required: ["variant_id", "quantity"], additionalProperties: false } },
        recipient_name: { type: "string" },
        recipient_phone: { type: "string" },
        address: { type: "string" },
        ward: { type: "string", description: "Xã / phường MỚI (sau 01/07/2025) — CHỈ khi KHÁCH vừa tự nói tên đó trong câu cuối (thường là trả lời câu hỏi address_check.ask_customer). Không tự chọn một ứng viên thay khách." },
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
    description: "Kiểm tra KHÁCH CŨ theo số điện thoại khách vừa cho: có trong sổ không, tên gọi + khu vực địa chỉ cũ (đã che). CHỈ để hỏi lại khách «giao về địa chỉ cũ … phải không ạ?» — không tự điền khi khách chưa xác nhận, không nói lịch sử mua.",
    inputSchema: { type: "object", properties: { phone: { type: "string" } }, required: ["phone"], additionalProperties: false },
    kind: "read",
  },
  get_order_status: {
    name: "get_order_status",
    description:
      "Tra ĐƠN của CHÍNH hội thoại này (đơn đã lên / đã chốt trong hội thoại) khi khách hỏi «đơn của em tới đâu rồi», «đã gửi chưa» (TRẠNG THÁI) hoặc «hôm nào có hàng», «bao giờ nhận», «chiều nay giao được không», «giao gấp được không» (LỊCH GIAO) — CHỈ khi khách ĐÃ có đơn trong hội thoại; khách CHƯA đặt mà hỏi giao hôm nay / mai / gấp là câu BÁN HÀNG ⇒ KHÔNG gọi công cụ này, trả lời theo chính sách giao của shop, không hứa giờ cụ thể, ghi lời dặn vào delivery_note khi lên đơn. Trả từng đơn: mã, ngày đặt, «status» theo LỜI KHAI của đơn vị vận chuyển, mã vận đơn, needs_staff. Không có tham số. Câu hỏi LỊCH GIAO ⇒ máy chủ trả «delivery_answer»: làm ĐÚNG theo nó (nói nguyên câu «say», hoặc máy chủ đã chuyển nhân viên) — KHÔNG đọc «status» thay cho giờ giao, KHÔNG tự hứa hôm nay / ngày mai. Câu hỏi trạng thái ⇒ nói ĐÚNG «status», không hứa ngày giao, không nêu số tiền; needs_staff ⇒ hỏi khách có cần nhân viên shop hỗ trợ không. Không thấy đơn ⇒ máy chủ tự chuyển nhân viên — KHÔNG xin SĐT / mã đơn. Bình luận công khai ⇒ không đọc đơn.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    kind: "read",
  },
  mark_declined: {
    name: "mark_declined",
    description:
      "Ghi nhận khách TỪ CHỐI RÕ RÀNG không mua khi CHƯA có đơn (vd «thôi không lấy nữa», «không mua đâu»). Bot sẽ thôi nhắn follow-up. Không dùng khi khách chỉ phân vân / chê đắt. Khách muốn HUỶ ĐƠN ĐÃ ĐẶT ⇒ dùng cancel_order. Gọi công cụ này khi hội thoại đã có đơn ⇒ máy chủ KHÔNG huỷ đơn — chỉ ghi yêu cầu huỷ và mở lượt giữ đơn.",
    inputSchema: { type: "object", properties: { reason: { type: "string" } }, required: ["reason"], additionalProperties: false },
    kind: "write",
  },
  cancel_order: {
    name: "cancel_order",
    description:
      "Khách muốn HUỶ ĐƠN ĐÃ ĐẶT trong hội thoại này (đơn nháp hoặc đã chốt). decision = CANCEL khi câu cuối của khách đòi huỷ; KEEP khi khách đồng ý giữ đơn sau lời giữ đơn. customer_words = NGUYÊN VĂN lời khách trong câu cuối. Lần CANCEL đầu tiên máy chủ KHÔNG huỷ: nó trả step RESCUE ⇒ giữ đơn ĐÚNG MỘT lần (hỏi lý do / đề nghị đổi món, đổi ngày giao) rồi đợi khách trả lời. Khách vẫn huỷ ở tin SAU ⇒ gọi lại CANCEL. CHỈ nói «đơn đã huỷ» khi kết quả có cancelled = true; cancelled = false ⇒ KHÔNG BAO GIỜ nói đã huỷ. Khi gọi công cụ này KHÔNG viết chữ nào cho khách trong cùng tin — đọc kết quả trước.",
    inputSchema: {
      type: "object",
      properties: { decision: { type: "string", enum: ["CANCEL", "KEEP"] }, customer_words: { type: "string" }, reason: { type: "string", description: "Lý do khách nói (ngắn)" } },
      required: ["decision", "customer_words"],
      additionalProperties: false,
    },
    kind: "write",
  },
};

/**
 * Công cụ mà CHỮ model viết KÈM trong cùng tin KHÔNG được gửi khách (engine giữ lại): kết quả của chúng quyết câu được nói — «đã
 * huỷ» chỉ đúng khi lõi đơn GHI xong, và model viết câu đó TRƯỚC khi thấy kết quả (sự cố #189A435E, 10/10/2026).
 */
export const TOOLS_HOLDING_TEXT: ReadonlySet<string> = new Set(["cancel_order", "mark_declined"]);

/** Lời dặn model ở bước giữ đơn — một chỗ, công cụ nào mở lượt giữ đơn cũng trả đúng câu này. */
const RESCUE_INSTRUCTION =
  "ĐƠN CHƯA HUỶ. Giữ đơn ĐÚNG MỘT lần: hỏi ngắn lý do và đề nghị một phương án (đổi món / số lượng / ngày giao) — KHÔNG nói đã huỷ, KHÔNG nài. Khách vẫn muốn huỷ ở tin SAU ⇒ gọi cancel_order decision CANCEL; khách đồng ý giữ ⇒ cancel_order decision KEEP.";

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
/** Cấp hành chính đầu phần địa chỉ — phần mang nó được giữ khi che (không phải số nhà / tên đường). */
const ADMIN_PART = /^(phường|p\.|xã|thị trấn|tt\.?|quận|q\.|huyện|h\.|thị xã|tx\.?|thành phố|tp\.?|tỉnh)\s/i;

/**
 * Địa chỉ ĐÃ CHE cho người chưa xác minh danh tính: KHÔNG bao giờ phần đầu (số nhà · ngõ · đường), không phần nào mang chữ số
 * trừ cấp hành chính có tên («Quận 1»), chỉ giữ tối đa HAI cấp cuối — cấp hành chính có tên, hoặc phần cuối (tỉnh / thành).
 * «12 Hàng Bạc, Hoàn Kiếm» ⇒ «…, Hoàn Kiếm»; «12 Ngõ 5, Lê Lợi, Hà Đông» ⇒ «…, Hà Đông» (review bảo mật 08/10/2026: bản cũ
 * giữ hai phần cuối nên địa chỉ hai phần lộ nguyên, ba phần lộ tên đường). HÀM THUẦN.
 */
export function maskAddress(address: string): string {
  const parts = address.split(",").map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return "";
  const rest = parts.slice(1);
  const keep = rest.filter((p, i) => ADMIN_PART.test(`${p} `) || (i === rest.length - 1 && !/\d/.test(p)));
  return keep.length ? `…, ${keep.slice(-2).join(", ")}` : "…";
}

/** Tên gọi (chữ cuối) — người nhận lấy từ hồ sơ chủ SĐT chỉ được đọc cho khách ở dạng này. */
const givenName = (name: string) => name.trim().split(/\s+/).pop() ?? "";

/** Hồ sơ của hội thoại đã XÁC MINH là người đang nhắn ⇒ mã hồ sơ cho dữ liệu riêng (bảng giá riêng · lịch sử); không ⇒ `null`. */
function verifiedCustomerId(state: ChatState): string | null {
  return state.customer && state.customer.verifiedIdentity === true ? state.customer.id : null;
}

const price = (n: number | null) => (n === null ? "chưa có giá" : formatVND(n));

export const ADD_ON_ONLY_NOTE = "CHỈ BÁN KÈM — KHÔNG báo giá riêng, KHÔNG chào như món chính, KHÔNG lên đơn chỉ có mẫu mã này. Chỉ thêm khi đơn đã có một mẫu mã chính và khách muốn lấy thêm (vd 1,5kg = 1kg + 0,5kg).";

/**
 * `verified` = giá ĐÃ XÁC THỰC của một đơn vị (báo giá máy chủ của giỏ [mẫu mã × 1], `verifiedUnitPrices`) — giá gói 2kg là đúng số đơn
 * sẽ tính (đã quy gói + giảm theo khối lượng), không phải `retail_price` thô. Chưa xác thực ⇒ `price = null` + lý do: model không có
 * số để báo. Không truyền (bảng giá sỉ đang bật) ⇒ như cũ.
 */
function itemView(it: CatalogItem, verified?: { price: number | null; reason: string | null }) {
  const p = verified ? verified.price : it.price;
  return { variant_id: it.variantId, name: it.name, variant: it.variant || null, sku: it.sku, price: p, price_text: price(p), ...(verified?.reason ? { price_note: `Giá CHƯA XÁC THỰC (${verified.reason}) — không báo giá mẫu mã này, chuyển nhân viên.` } : {}), ...(it.addOnOnly ? { add_on_only: true, note: ADD_ON_ONLY_NOTE } : {}), ...it.fields };
}

/** Trần số giá đã xác thực nhớ trong một hội thoại. */
export const PRICE_FACTS_MAX = 120;

/** Nhớ các giá ĐÃ XÁC THỰC công cụ vừa trả cho model — hàng rào số tiền cho phép bot nói lại chúng. */
function rememberPrices(state: ChatState, amounts: readonly (number | null | undefined)[]) {
  const add = amounts.filter((n): n is number => typeof n === "number" && Number.isFinite(n) && n > 0);
  if (!add.length) return;
  const next = [...new Set([...(state.priceFacts ?? []), ...add])];
  state.priceFacts = next.slice(-PRICE_FACTS_MAX);
}

/** Ngữ cảnh tính giá của hội thoại — CÙNG chế độ giá với `priceLines` (bảng giá sỉ khi shop bật). */
async function pricingContextFor(cfg: SalesChatbotConfig, customerId: string | null): Promise<PricingContext> {
  return loadPricingContext(cfg, await booksForChat(cfg, customerId));
}
const ADD_ON_ONLY_ERROR = "Giỏ / đơn chỉ có mẫu mã CHỈ BÁN KÈM (vd 0,5kg) — không bán riêng. Báo khách quy cách nhỏ nhất bán riêng (vd 1kg) và giá; khách lấy món chính rồi mới thêm mẫu mã bán kèm.";

function ok(summary: string, data: unknown, state: ChatState): ToolOutcome {
  return { content: JSON.stringify(data), isError: false, summary, state };
}
function err(summary: string, message: string, state: ChatState, orderSignal?: ToolOutcome["orderSignal"]): ToolOutcome {
  return { content: JSON.stringify({ error: message }), isError: true, summary, state, ...(orderSignal ? { orderSignal } : {}) };
}

/**
 * Bảng giá áp cho khách của hội thoại khi shop BẬT báo giá sỉ (`wholesalePricing`); TẮT ⇒ `null` = giá lẻ như trước. Khách
 * chưa nhận ra là ai (chưa tạo / chưa tra được) ⇒ chỉ bảng mặc định.
 */
async function booksForChat(cfg: SalesChatbotConfig, customerId: string | null): Promise<{ customerList: PriceListBook | null; defaultList: PriceListBook | null } | null> {
  return cfg.wholesalePricing ? priceBooksFor(customerId) : null;
}

/**
 * Khối «giá sỉ» trả về cho AI khi shop BẬT báo giá theo bảng — HÀM THUẦN. Chủ shop HSLC 08/10/2026: «khách hỏi giá sỉ thì lấy
 * bảng giá sỉ để trả lời, không lấy bảng giá lẻ». `quoteUnitPrice` lùi về GIÁ LẺ khi số lượng chưa tới bậc hay mẫu mã không
 * có trong bảng — đúng cho tính tiền đơn, nhưng AI từng đọc `price` ấy và báo nó như giá sỉ. Nên nguồn giá phải đi kèm
 * một câu nói thẳng: chưa có bậc ⇒ KHÔNG có giá sỉ để báo (chuyển người), chưa tới bậc ⇒ nói bậc, không nói giá lẻ.
 */
export function wholesaleQuoteView(source: PriceSource | null, tiers: readonly { min_quantity: number; unit_price: number; text: string }[]): { available: boolean; from_quantity: number | null; note: string } {
  if (tiers.length === 0) return { available: false, from_quantity: null, note: "Mẫu mã này CHƯA CÓ trong bảng giá sỉ — không có giá sỉ để báo. KHÔNG đưa `price` (giá lẻ) ra như giá sỉ; khách hỏi sỉ ⇒ handoff_to_human với reason «Khách sỉ — <món>, chưa có giá sỉ»." };
  const from = tiers[0].min_quantity;
  if (source === "RETAIL") return { available: true, from_quantity: from, note: `Số lượng này CHƯA tới bậc sỉ thấp nhất — \`price\` là GIÁ LẺ. Khách hỏi sỉ ⇒ nói các bậc trong \`tiers\` («sỉ từ ${from} trở lên: …»), KHÔNG báo giá lẻ như giá sỉ.` };
  return { available: true, from_quantity: from, note: "`price` là giá theo bảng giá sỉ cho đúng số lượng này; các bậc khác ở `tiers`." };
}

/** Đơn giá của MỘT dòng: giá lẻ khi chưa bật bảng giá; bật ⇒ `quoteUnitPrice` — CÙNG hàm với form đơn tay. */
function unitPriceFor(it: CatalogItem, quantity: number, books: Awaited<ReturnType<typeof booksForChat>>): number | null {
  // MỘT công thức với lõi đơn (lib/commerce/pricing.ts) — lõi tính lại đúng hàm này và từ chối đơn lệch giá.
  return agentUnitPrice({ variantId: it.variantId, quantity, retailPrice: it.price, books });
}

/**
 * Chế độ giá + khoá LẦN MUA cho lõi đơn: lõi tính lại đơn giá theo đúng chế độ bot đang báo giá, và tạo đơn nháp hai lần
 * cho cùng một lượt mua (lỗi mạng, gọi lại) trả về ĐÚNG đơn đầu — không đơn thứ hai.
 */
function agentOrderOpts(ctx: ToolContext, state: ChatState, creating: boolean, quote?: AgentQuoteClaim, holdNew = false): AgentOrderOptions {
  // Bảng giá RIÊNG của khách chỉ khi danh tính đã xác minh — lõi đơn tính lại đúng chế độ này nên báo giá và đơn không lệch nhau.
  const pricing = !ctx.config.wholesalePricing ? "RETAIL" : verifiedCustomerId(state) ? "PRICE_BOOK" : "DEFAULT_BOOK";
  return { pricing, idempotencyKey: creating ? `sales-chat:${ctx.conversationId}:${state.pastOrders?.length ?? 0}` : null, allowShortStock: ctx.config.sellWithoutStockCheck, ...(quote ? { quote } : {}), ...(holdNew ? { holdNew: true } : {}) };
}

/** Giỏ đã tính + BÁO GIÁ MÁY CHỦ của chính giỏ đó (`quote.ts` — một phép tính, một mã báo giá). */
export type PricedQuote = Priced & { quote: Quote };

/**
 * `address` = địa chỉ giao (đơn nháp / khách đã lưu) — cho luật miễn ship theo khu vực; `null` khi chưa biết. Phép tính ở
 * `computePriced` (quote.ts) — nơi DUY NHẤT tính tiền cho đường agent; lõi đơn tính lại đúng hàm đó.
 */
export async function priceLines(lines: readonly CartLine[], cfg: SalesChatbotConfig, customerId: string | null = null, address: string | null = null, opts: { packing?: boolean } = {}): Promise<PricedQuote> {
  const ctx = await pricingContextFor(cfg, customerId);
  const priced = computePriced(lines, ctx, address);
  // Khách đòi đóng gói riêng ⇒ «tách gói có còn giá gói không» là quyết định của shop — chưa khai ⇒ chưa xác thực (packingIssues).
  if (opts.packing) priced.issues.push(...packingIssues(priced, cfg.volumeDiscount.enabled));
  return { ...priced, quote: buildQuote(priced, ctx) };
}

/** Báo giá mới ĐÃ XÁC THỰC sau lúc khách phản đối giá ⇒ hết «đang phản đối»; khách phải xác nhận ở lượt SAU (`requotedTurn`). */
function settleDispute(state: ChatState, turn: number | undefined) {
  if (state.priceDispute?.open) state.priceDispute = { ...state.priceDispute, open: false, requotedTurn: turn ?? null };
}

/** Báo giá mang vào lõi đơn — lõi tính lại phần hàng và đối chiếu (`verifyAgentQuote`). */
function quoteClaimOf(q: Quote): AgentQuoteClaim {
  return { id: q.quoteId, priceVersion: q.priceVersion, subtotal: q.subtotal, total: q.total };
}

/** Câu lý do của báo giá chưa xác thực — một chỗ cho ba công cụ. */
const quoteReasons = (q: Quote) => q.unverifiedReasons.map((r) => r.detail).join(" · ") || "báo giá chưa xác thực";

/** Mọi khối lượng khách nói trong câu, quy ra gram («2kg», «0,5 kg», «2 ký», «500g»). HÀM THUẦN. */
export function gramsMentioned(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/(\d+(?:[.,]\d+)?)\s*(kg|kí|ký|ki|ky|cân|can|gram|gr|g)(?![\p{L}])/giu)) {
    const n = Number(m[1].replace(",", "."));
    if (!Number.isFinite(n) || n <= 0) continue;
    out.push(Math.round(/^(?:gram|gr|g)$/i.test(m[2]) ? n : n * 1000));
  }
  return out;
}

/**
 * QUY CÁCH ≠ SỐ LƯỢNG (10/10/2026, HSLC «Việt Phệ»: khách «A lấy thử 2kg», danh mục có mẫu mã «2kg» = 540.000 ₫ ⇒ bot lên mẫu mã
 * 2kg × 2 = 1.080.000 ₫ và báo khách «2kg chả cá thu: 1.080.000 đ» — thật ra là 4kg, gấp đôi tiền). Bắt đúng mẫu lỗi đó: mẫu mã đã
 * mang khối lượng W, số lượng q ≥ 2, khách nói ĐÚNG W mà KHÔNG nói tổng q × W, cũng không nói rõ số gói («2 túi», «x2», «2 hộp»…)
 * ⇒ trả câu sửa cho model (quantity là SỐ GÓI của mẫu mã). Không bắt được thì `null` — không đoán ý khách. HÀM THUẦN.
 */
export function packQuantityMistake(lines: readonly { name: string; quantity: number; weightGrams?: number | null }[], customerText: string): string | null {
  const said = gramsMentioned(customerText);
  if (!said.length) return null;
  const folded = foldVi(customerText);
  // «lấy THÊM 1kg nữa» = cộng thêm vào phần đã có, không phải tổng khối lượng — không bắt (khối lượng mẫu mã nay luôn đọc được từ
  // field quy cách, P0 authoritative-quote 11/10/2026, nên câu này mới chạm tới đây).
  if (/(?:^|[^a-z])them\s+\d/.test(folded)) return null;
  const kg = (g: number) => (g % 1000 === 0 ? `${g / 1000}kg` : `${(g / 1000).toLocaleString("vi-VN")}kg`);
  for (const l of lines) {
    const w = l.weightGrams ?? null;
    if (!w || l.quantity < 2 || !said.includes(w) || said.includes(w * l.quantity)) continue;
    const packs = new RegExp(`(?:^|[^\\d])${l.quantity}\\s*(?:tui|goi|hop|set|phan|bich|khay|combo|suat|cai|hu|lo)(?![a-z])|x\\s*${l.quantity}(?!\\d)`);
    if (packs.test(folded)) continue;
    return `«${l.name}» đã là gói ${kg(w)} — khách nói ${kg(w)} nên quantity = 1, KHÔNG phải ${l.quantity} (${l.quantity} gói = ${kg(w * l.quantity)}, gấp ${l.quantity} lần tiền). quantity là SỐ GÓI của mẫu mã, không phải số kg. Sửa quantity rồi gọi lại; khách thật sự muốn ${kg(w * l.quantity)} thì hỏi lại khách trước.`;
  }
  return null;
}

export function mergeLines(lines: readonly CartLine[]): CartLine[] {
  const m = new Map<string, number>();
  for (const l of lines) m.set(l.variantId, (m.get(l.variantId) ?? 0) + l.quantity);
  return [...m.entries()].map(([variantId, quantity]) => ({ variantId, quantity }));
}

function cartView(p: Priced) {
  return {
    lines: p.lines.map((l) => ({ variant_id: l.variantId, name: l.name, quantity: l.quantity, unit_price: l.unitPrice, ...(l.discount ? { discount: l.discount } : {}), line_total: l.lineTotal, text: l.discount ? `${l.name}: ${l.quantity} × ${formatVND(l.unitPrice)} − giảm ${formatVND(l.discount)} = ${formatVND(l.lineTotal)}` : `${l.name}: ${l.quantity} × ${formatVND(l.unitPrice)} = ${formatVND(l.lineTotal)}` })),
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
    draft.packing ? `Đóng gói theo yêu cầu khách: «${draft.packing}»` : "",
    priced.ship.kind === "FREE_IF_AREA" ? "Miễn ship NẾU địa chỉ thuộc khu vực miễn ship — nhân viên kiểm địa chỉ trước khi giao." : priced.shippingFee === null ? "Phí ship: CHƯA BÁO — nhân viên cập nhật trước khi giao." : "",
  ].filter((x) => x.trim());
  return {
    customerId: state.customer?.id ?? "",
    stage,
    lines: priced.lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity, unitPrice: l.unitPrice, discount: l.discount })),
    orderDiscount: 0,
    shippingFee: priced.shippingFee ?? 0,
    note: notes.join("\n").slice(0, 2000),
    channel: channel === "FANPAGE" ? "Chatbot fanpage" : channel === "ZALO" ? "Chatbot Zalo" : "Chatbot web",
    recipient: { name: draft.recipient.name, phone: draft.recipient.phone, address: draft.recipient.address, province: draft.recipient.province, ward: draft.recipient.ward ?? "" },
  };
}

/**
 * KẾT QUẢ ĐỌC ĐỊA CHỈ cho bot (P0 address-normalize 11/10/2026) — cùng bộ đọc với lõi đơn (`vn-address.ts`), không luật thứ hai.
 * `ask_customer` = câu hỏi khách khi xã / tỉnh / số nhà chưa chắc — ứng viên là tên THẬT trong danh mục, không bao giờ bịa. Không
 * trả số nhà / tên đường (địa chỉ máy điền từ đơn cũ phải giữ bản ĐÃ CHE).
 */
export type AddressCheckView = { status: AddressConfidence | "CUSTOMER_CONFIRMED" | "CUSTOMER_STATED"; province: string | null; ward: string | null; candidates: string[]; missing: AddressPart[]; ask_customer: string | null; note: string };

/** Ngữ cảnh của lượt cho `addressCheckOf`: tin khách (đọc địa chỉ khách tự gõ) + trí nhớ đã hỏi + lượt hiện tại. Bỏ trống ⇒ như cũ. */
export type AddressCheckOpts = { customerTexts?: readonly string[]; asked?: AddressAskMemory; turn?: number };

const ASKED_ONCE_NOTE = "Phần địa chỉ này ĐÃ hỏi khách ở lượt trước — KHÔNG hỏi lại (kể cả khi chép lại địa chỉ khác đi). Đơn đi tiếp: ô xã để trống, đơn mang cờ cần kiểm địa chỉ, nhân viên xác nhận với khách. KHÔNG tự chọn xã, KHÔNG nói địa chỉ đã đúng.";

export function addressCheckOf(r: Pick<Recipient, "address" | "province" | "ward">, opts: AddressCheckOpts = {}): { key: string; view: AddressCheckView } {
  const out = addressCheckCore(r, opts);
  // HỎI MỘT LẦN (P0 15/10/2026): phần đã hỏi ở lượt trước ⇒ không đưa câu hỏi nữa — một máy chủ chặn, không trông vào lời dặn model.
  if (out.view.ask_customer && askedBefore(askMemoryFor(opts.asked, r.address), askParts(out.view.missing), opts.turn)) return { key: out.key, view: { ...out.view, ask_customer: null, note: ASKED_ONCE_NOTE } };
  return out;
}

/** Ghi chú công cụ cho địa chỉ cũ chưa ghép — nội bộ, model không được hỏi khách. */
export const LEGACY_UNMAPPED_NOTE = "Địa chỉ khách ghi ĐỦ theo địa giới CŨ; danh mục vận chuyển chưa ghép được một xã / phường mới — đây KHÔNG phải khách thiếu thông tin. KHÔNG hỏi khách tên phường / xã mới, KHÔNG chọn một ứng viên, KHÔNG sửa dòng địa chỉ. Ghi đúng nguyên văn; đơn đi với cờ cần kiểm địa chỉ, nhân viên đối chiếu nội bộ.";

function addressCheckCore(r: Pick<Recipient, "address" | "province" | "ward">, opts: AddressCheckOpts): { key: string; view: AddressCheckView } {
  const key = [r.address, r.province, r.ward ?? ""].map((x) => x.trim()).join("|");
  const a = parseCustomerAddress(r.address, r.province);
  const chosen = (r.ward ?? "").trim();
  if (chosen && a.province) {
    const missing = a.missing.filter((m) => m !== "ward");
    const ask = missing.includes("street") ? addressQuestion({ ...a, ward: chosen, confidence: "EXACT", candidates: [], missing }) : null;
    return { key, view: { status: "CUSTOMER_CONFIRMED", province: a.province, ward: chosen, candidates: [], missing, ask_customer: ask, note: "Xã / phường mới đã có từ lời khách — KHÔNG hỏi lại khách phường / xã." } };
  }
  // ĐỊA CHỈ KHÁCH TỰ GÕ thắng bản model chép (P0 15/10/2026, ca «Tuyet Nguyen Thi»): dòng công cụ chưa tự điền được mà tin của khách
  // ghi rõ một xã CÓ THẬT trong danh mục mới (cùng tỉnh, cùng số nhà) ⇒ dùng đúng xã đó, không hỏi khách nữa.
  const stated = wardFromCustomerWords(a, r.address, opts.customerTexts);
  if (stated) {
    const missing = a.missing.filter((m) => m !== "ward" && m !== "province");
    const ask = missing.includes("street") ? addressQuestion({ ...a, province: stated.province, provinceCode: stated.provinceCode, ward: stated.ward, confidence: "EXACT", candidates: [], legacy: null, provinceHint: null, missing }) : null;
    return { key, view: { status: "CUSTOMER_STATED", province: stated.province, ward: stated.ward, candidates: [], missing, ask_customer: ask, note: "Xã / phường đọc từ CHÍNH tin khách đã gửi — đã ghép theo địa giới mới. KHÔNG hỏi lại khách phường / xã." } };
  }
  // ĐỊA GIỚI CŨ ĐỦ MÀ DANH MỤC CHƯA GHÉP (#855 — chủ shop 16/10/2026: «không yêu cầu khách tự tìm hiểu tên phường mới», «không chọn ngẫu
  // nhiên», «không chắc ⇒ chuyển nhân viên»): KHÔNG có câu hỏi khách; ô xã để trống, đơn đi với cờ ADDRESS_UNRESOLVED cho nhân viên kiểm
  // nội bộ (không tạo vận đơn — lõi đơn giữ đơn ở hàng cần kiểm). Ứng viên chỉ nằm ở `candidates` cho người kiểm.
  if (legacyAddressUnmapped(r.address, r.province)) {
    return { key, view: { status: a.confidence, province: a.province, ward: null, candidates: a.candidates, missing: a.missing, ask_customer: null, note: LEGACY_UNMAPPED_NOTE } };
  }
  const ask = addressQuestion(a);
  const note = canAutoFill(a)
    ? ask
      ? "Tỉnh + xã / phường đã ghép theo địa giới mới; còn thiếu số nhà / tên đường — hỏi khách bằng ask_customer."
      : "Tỉnh + xã / phường đã ghép theo địa giới mới."
    : a.missing.includes("province")
      ? "CHƯA BIẾT TỈNH / THÀNH — ô tỉnh và xã để trống, đơn cần người kiểm. Hỏi khách ĐÚNG câu ask_customer (hỏi tỉnh trước, xã sau); khách nói tỉnh ⇒ update_draft_order với address thêm đúng tên tỉnh khách nói. KHÔNG tự thêm tỉnh, KHÔNG tự chọn xã, KHÔNG nói địa chỉ đã đúng."
      : "Địa chỉ CHƯA chuẩn hoá — ô xã / phường để trống, đơn cần người kiểm. Hỏi khách ĐÚNG câu ask_customer (gộp vào tin tóm tắt); khách trả lời tên xã / phường ⇒ update_draft_order với ward = tên khách nói. KHÔNG tự chọn, KHÔNG nói địa chỉ đã đúng.";
  return { key, view: { status: a.confidence, province: a.province, ward: a.ward, candidates: a.candidates, missing: a.missing, ask_customer: ask, note } };
}

/**
 * Địa chỉ mơ hồ / không đọc được mà khách CHƯA được hỏi ở một lượt TRƯỚC ⇒ `confirm_order` (bot gọi chốt) chưa chốt, hỏi đúng câu.
 * Gọi lẻ không có lượt (bài kiểm công cụ) ⇒ không xét. Lượt TỰ CHỐT của máy chủ không đi qua đây (luật P0-A: tự chốt kèm cờ cần kiểm).
 */
function addressAskPending(state: ChatState, chk: { key: string; view: AddressCheckView }, turn: number | undefined): boolean {
  const unsure = chk.view.status === "AMBIGUOUS" || chk.view.status === "NOT_FOUND";
  return unsure && Boolean(chk.view.ask_customer) && turn !== undefined && !askedBefore(askMemoryFor(state.addressAsk, chk.key.split("|")[0] ?? ""), askParts(chk.view.missing), turn);
}

/**
 * Câu hỏi địa chỉ vừa được đưa cho bot ở lượt này ⇒ ghi mốc (lượt sau `confirm_order` biết khách đã được hỏi).
 * GIỚI HẠN ĐÃ BIẾT: mốc ghi lúc CÔNG CỤ trả `ask_customer`, không đối chiếu chữ bot thật sự gửi — công cụ chạy trước khi model soạn
 * câu, và câu gửi đi còn qua bộ lọc / hàng rào khẳng định ở engine. Nếu model bỏ qua câu hỏi, lượt sau `confirm_order` vẫn cho chốt;
 * lưới đỡ khi đó là cờ cần kiểm ADDRESS_UNRESOLVED của lõi đơn (ô xã trống ⇒ người kiểm hỏi lại), không phải cổng này.
 */
function markAddressAsked(state: ChatState, chk: { key: string; view: AddressCheckView }, turn: number | undefined) {
  if (!chk.view.ask_customer || turn === undefined) return;
  // Địa chỉ khác hẳn câu hỏi trước ⇒ trí nhớ phần đã hỏi bắt đầu lại (askMemoryFor).
  const prev = askMemoryFor(state.addressAsk, chk.key.split("|")[0] ?? "");
  const parts = { ...askMemoryParts(prev) };
  for (const p of askParts(chk.view.missing)) parts[p] ??= turn;
  state.addressAsk = { key: chk.key, turn: prev?.key === chk.key && prev.turn <= turn ? prev.turn : turn, parts };
}

/** Ngữ cảnh đọc địa chỉ của một lượt công cụ (`addressCheckOf`). */
const addressOpts = (state: ChatState, ctx: Pick<ToolContext, "customerTexts" | "turn">): AddressCheckOpts => ({ customerTexts: ctx.customerTexts, asked: state.addressAsk, turn: ctx.turn });

function recipientFrom(input: { recipient_name?: string; recipient_phone?: string; address?: string }, base: Recipient): Recipient {
  const newAddress = Boolean(input.address?.trim()) && input.address!.trim() !== base.address;
  // Địa chỉ đổi ⇒ xã khách xác nhận cho địa chỉ CŨ không còn căn cứ (xã mới, nếu có, đặt lại ở bước kiểm `ward`).
  const ward = newAddress ? "" : (base.ward ?? "");
  return {
    name: input.recipient_name?.trim() || base.name,
    phone: input.recipient_phone?.trim() || base.phone,
    address: input.address?.trim() || base.address,
    province: input.address?.trim() ? "" : base.province,
    ...(ward ? { ward } : {}),
  };
}

/** Người nhận bot được đọc cho khách: địa chỉ máy chủ điền từ đơn cũ (khớp qua SĐT) chỉ hiện bản ĐÃ CHE. */
function recipientView(r: Recipient, state: ChatState): Recipient & { address_note?: string } {
  if (!state.customer?.savedAddress || r.address !== state.customer.address) return r;
  // Địa chỉ + họ tên do MÁY CHỦ điền từ hồ sơ chủ SĐT ⇒ cả hai đều che (họ tên đầy đủ cũng là dữ liệu của chủ hồ sơ).
  return { ...r, name: givenName(r.name) || r.name, address: maskAddress([r.address, r.province].filter((x) => x.trim()).join(", ")), province: "", address_note: "Địa chỉ cũ của khách (đã che) — đọc đúng như vậy, không đoán số nhà, không đọc họ tên đầy đủ." };
}

function failureText(r: { errors: { field: string; message: string }[] }): string {
  // Lỗi HẠN MỨC NỢ mang họ tên + dư nợ của chủ hồ sơ ⇒ model chỉ nhận câu chung (nhân viên xem chi tiết trên đơn).
  if (r.errors.some((e) => e.field === "customerId")) return "Đơn cần nhân viên duyệt trước khi chốt — chuyển nhân viên (handoff_to_human «Đơn cần duyệt»).";
  return r.errors.map((e) => e.message).join(" · ") || "Không ghi được.";
}

/** Lõi đơn từ chối (`MetaFailure`) ⇒ tín hiệu đơn không hợp lệ: lý do + TÊN trường (không câu lỗi — có thể mang tên / dư nợ khách). */
function omsSignal(r: { code: MetaFailure["code"]; errors: { field: string; message: string }[] }): NonNullable<ToolOutcome["orderSignal"]> {
  return { reason: omsValidationReason(r), fields: r.errors.map((e) => e.field) };
}

/**
 * Chạy MỘT công cụ. Bọc `executeToolCore` để tách hai loại «ghi đơn không thành» khỏi «AI hỏng» (sứ mệnh saas-ops-signals):
 *  · công cụ TRẢ VỀ lỗi kèm `orderSignal` ⇒ `order.validation_failed` (đơn không hợp lệ) — kết quả cho model KHÔNG đổi;
 *  · công cụ chạm lõi đơn (`ORDER_SIGNAL_TOOLS`) NÉM ⇒ `order.create_failed` rồi ném `OrderWriteError` — engine chuyển người với lý do
 *    ghi đơn, KHÔNG ghi lượt AI là ERROR. Lỗi ném từ công cụ khác đi nguyên như cũ.
 * Khung THỬ (`TEST`) ghi mô phỏng, không có đơn thật ⇒ không ghi tín hiệu nào.
 */
export async function executeTool(name: string, rawInput: unknown, ctx: ToolContext): Promise<ToolOutcome> {
  const live = ctx.channel !== "TEST";
  const base = { conversationId: ctx.conversationId, tool: name, channel: ctx.channel, turn: ctx.turn ?? null, agent: ctx.agent };
  let out: ToolOutcome;
  const mark: OrderWriteMark = { committed: false, orderId: null };
  try {
    out = await executeToolCore(name, rawInput, { ...ctx, writeMark: mark });
  } catch (error) {
    const toolReason = orderSignalToolReason(name);
    if (!toolReason || !live) throw error;
    const sqlState = sqlStateOf(error);
    // Ném SAU khi lõi đơn đã ghi (vd chốt CONFIRMED xong, ghi vết «khách xác nhận lại» mới ném) ⇒ đơn có thể ĐÃ có — lý do riêng,
    // câu báo nhân viên «kiểm trước, KHÔNG lên lần hai». Gộp vào «đơn CHƯA ghi» là mời nhân viên lên đơn hai lần.
    const postWrite = mark.committed;
    const reason = postWrite ? "ORDER_POSTWRITE_ERROR" : toolReason;
    const orderId = (postWrite ? mark.orderId : null) ?? ctx.state.confirmed?.orderId ?? ctx.state.draft?.orderId ?? null;
    await recordOrderWriteFailure({ ...base, orderId, reason, sqlState });
    throw new OrderWriteError(reason, name, sqlState, orderId, postWrite);
  }
  if (out.orderSignal && live) await recordOrderValidationFailure({ ...base, orderId: out.state.draft?.orderId ?? ctx.state.draft?.orderId ?? null, reason: out.orderSignal.reason, fields: out.orderSignal.fields });
  return out;
}

async function executeToolCore(name: string, rawInput: unknown, ctx: ToolContext): Promise<ToolOutcome> {
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
      if (!quotedInText(v.data.customer_confirmation, ctx.lastUserText)) return err("Đặt lịch: khách chưa xác nhận", "customer_confirmation phải là nguyên văn lời đồng ý trong câu CUỐI của khách. Khách chưa xác nhận ⇒ đọc lại tóm tắt lịch và hỏi.", state);
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
      const vp = await verifiedViewPrices(found, ctx.config, state);
      rememberPrices(state, found.map((it) => (vp ? vp.get(it.variantId)?.price : null)));
      return ok(`Tìm «${q.data}»: ${found.length} kết quả`, { results: found.map((it) => itemView(it, vp?.get(it.variantId))), note: found.length ? undefined : "Không có sản phẩm nào khớp — hỏi lại khách hoặc gợi ý sản phẩm khác." }, state);
    }
    case "get_product":
    case "get_current_price": {
      const id = z.string().min(1).max(200).safeParse(input.variant_id);
      if (!id.success) return err(`${name}: thiếu mã`, "Thiếu variant_id.", state);
      const it = (await sellableCatalog(ctx.config.productFields)).find((c) => c.variantId === id.data);
      if (!it) return err(`${name}: không có mã`, "Không có mẫu mã này (hoặc đã thôi bán).", state);
      if (name === "get_current_price") {
        const qty = z.number().int().min(1).max(100_000).safeParse(input.quantity);
        const books = await booksForChat(ctx.config, verifiedCustomerId(state));
        if (!books) {
          // Giá lẻ: giá ĐÃ XÁC THỰC của một đơn vị (cùng phép tính với đơn) — chưa xác thực ⇒ null + lý do, không có số để báo.
          const v = verifiedUnitPrices([it.variantId], await loadPricingContext(ctx.config, null)).get(it.variantId) ?? { price: null, reason: null };
          rememberPrices(state, [v.price]);
          return ok(`Giá ${it.name}: ${price(v.price)}`, { variant_id: it.variantId, name: it.name, price: v.price, price_text: price(v.price), ...(v.reason ? { price_note: `Giá CHƯA XÁC THỰC (${v.reason}) — không báo giá, chuyển nhân viên.` } : {}), as_of: new Date().toISOString() }, state);
        }
        const quantity = qty.success ? qty.data : 1;
        const unit = unitPriceFor(it, quantity, books);
        // Bậc của bảng đang áp cho mẫu mã này: bảng của khách nếu bảng ấy có mẫu mã, không thì bảng mặc định.
        const list = [books.customerList, books.defaultList].find((b) => b?.tiers.some((t) => t.variantId === it.variantId)) ?? null;
        const tiers = (list?.tiers ?? []).filter((t) => t.variantId === it.variantId).sort((a, b) => a.minQuantity - b.minQuantity).map((t) => ({ min_quantity: t.minQuantity, unit_price: t.unitPrice, text: `từ ${t.minQuantity}: ${formatVND(t.unitPrice)}` }));
        const quote = quoteUnitPrice({ variantId: it.variantId, quantity, retailPrice: it.price, customerList: books.customerList, defaultList: books.defaultList });
        const wholesale = wholesaleQuoteView(quote?.source ?? null, tiers);
        rememberPrices(state, [unit, ...tiers.map((t) => t.unit_price)]);
        return ok(`Giá ${it.name} × ${quantity}: ${price(unit)}${wholesale.available ? "" : " · chưa có giá sỉ"}`, { variant_id: it.variantId, name: it.name, quantity, price: unit, price_text: price(unit), price_source: quote?.source ?? null, retail_price: it.price, tiers, wholesale, as_of: new Date().toISOString() }, state);
      }
      const vp = await verifiedViewPrices([it], ctx.config, state);
      rememberPrices(state, [vp?.get(it.variantId)?.price]);
      return ok(`Chi tiết ${it.name}`, itemView(it, vp?.get(it.variantId)), state);
    }
    case "check_inventory": {
      const items = itemsZ.safeParse(input.items);
      if (!items.success) return err("Kiểm tồn: sai đầu vào", "items phải là danh sách { variant_id, quantity ≥ 1 }.", state);
      const stock = await stockFor(items.data.map((i) => i.variant_id));
      if (ctx.config.sellWithoutStockCheck) {
        // Shop nhập hàng liên tục ⇒ không đưa con số tồn cho AI (nó sẽ nói «hết hàng»); chỉ báo mã có thật hay không.
        const sell = mergeLines(items.data.map((i) => ({ variantId: i.variant_id, quantity: i.quantity }))).map((l) => (stock.get(l.variantId) ? { variant_id: l.variantId, quantity: l.quantity, can_sell: true } : { variant_id: l.variantId, exists: false }));
        return ok(`Kiểm tồn ${sell.length} dòng · shop nhập hàng liên tục`, { items: sell, note: "Shop nhập hàng liên tục — cứ lên đơn, KHÔNG nói còn / hết hàng." }, state);
      }
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
      const packingAsk = packingRequestOf(ctx.lastUserText) ?? state.draft?.packing ?? null;
      const priced = await priceLines(mergeLines(items.data.map((i) => ({ variantId: i.variant_id, quantity: i.quantity }))), ctx.config, verifiedCustomerId(state), knownAddress, { packing: Boolean(packingAsk) });
      if (priced.missing.length) return err("Tính giỏ: mã không có", `Không có mẫu mã: ${priced.missing.join(", ")}.`, state);
      if (priced.unpriced.length) return { ...err("Tính giỏ: mã chưa có giá", `Chưa có giá: ${priced.unpriced.join(", ")} — không báo giá, chuyển nhân viên.`, state), requireHuman: `Giá bất thường: ${priced.unpriced.join(", ")} chưa có giá` };
      if (priced.addOnOnly) return err("Tính giỏ: chỉ có món bán kèm", ADD_ON_ONLY_ERROR, state);
      const choice = packChoiceMistake(priced, ctx.config, ctx.lastUserText);
      if (choice) return err("Tính giỏ: nhầm gói", choice, state);
      // BÁO GIÁ MÁY CHỦ (P0 11/10/2026): giỏ là một báo giá có mã; chưa xác thực (catalog mâu thuẫn) ⇒ không có số để báo, người xác minh.
      state.quote = quoteSnapshotOf(priced.quote, now);
      if (!priced.quote.verified) return { ...err("Tính giỏ: giá chưa xác thực", `${QUOTE_UNVERIFIED_INSTRUCTION} (${quoteReasons(priced.quote)})`, state), requireHuman: priceUnverifiedReason(quoteReasons(priced.quote)) };
      settleDispute(state, ctx.turn);
      return ok(`Giỏ: ${formatVND(priced.subtotal)}${priced.total !== null ? ` · COD ${formatVND(priced.total)}` : ""}`, cartView(priced), state);
    }
    case "create_customer": {
      // Đơn chốt qua LỜI ĐỒNG Ý: đổi SĐT / địa chỉ lúc này là SỬA ĐƠN — hồ sơ khách đổi mà đơn vẫn giữ địa chỉ cũ (review #821 vòng 3, ca
      // «Đỗ Là»). Máy chủ ép chuyển người như update_draft_order trên đơn đã chốt; không để tuỳ model.
      if (state.confirmed && !state.confirmed.auto) return { ...err("Đơn đã chốt", "Đơn của hội thoại này đã chốt — đổi SĐT / địa chỉ là sửa đơn: KHÔNG nói đã cập nhật; máy chủ đã chuyển nhân viên.", state), requireHuman: `Sửa đơn đã chốt — khách đổi thông tin nhận hàng: «${ctx.lastUserText.trim().slice(0, 120)}»` };
      // KHÁCH CŨ: máy chủ điền SĐT + địa chỉ của lần mua trước — chỉ khi khách VỪA xác nhận (luật 3.12: gợi ý, không tự điền).
      let saved = false;
      let fields: Record<string, unknown> = input;
      if (input.use_saved_address === true) {
        // Nhiều địa chỉ cũ (Customer 360): khách chọn số mấy trong danh sách máy chủ đã đọc cho bot — sai số ⇒ hỏi lại, không đoán.
        const choice = input.saved_address_choice;
        const hasChoice = choice !== undefined && choice !== null;
        // Nạp động: customer-360.ts nạp tệp này (maskAddress) — nạp tĩnh là thành vòng (cùng cách `lookup_customer` nạp returning.ts).
        const c360 = await import("@/lib/sales-chatbot/customer-360");
        const picked = hasChoice ? c360.savedAddressChoice(ctx.customer360, choice) : null;
        if (hasChoice && !picked) return err("Lưu khách: số địa chỉ cũ không có", "saved_address_choice phải là số thứ tự trong danh sách địa chỉ cũ của khối TRA LỊCH SỬ. Hỏi lại khách chọn địa chỉ nào.", state);
        const r = picked ?? ctx.returning;
        if (!r) return err("Lưu khách: không có địa chỉ cũ", "Shop không có địa chỉ cũ của khách này — hỏi khách SĐT và địa chỉ.", state);
        const quote = z.string().trim().min(2).max(300).safeParse(input.customer_confirmation);
        if (!quote.success || !quotedInText(quote.data, ctx.lastUserText)) return err("Lưu khách: khách chưa xác nhận địa chỉ cũ", "customer_confirmation phải là nguyên văn lời khách xác nhận giao về địa chỉ cũ, trong câu CUỐI của khách. Khách chưa xác nhận ⇒ hỏi lại.", state);
        const typed = typeof input.name === "string" ? input.name.trim() : "";
        // Khách ĐỔI SĐT mà giữ địa chỉ cũ (Customer 360): số mới phải là một CỤM SĐT trong câu cuối của khách, và địa chỉ phải nối
        // bằng đơn của chính hội thoại / mã Facebook. Không xác minh được ⇒ hỏi lại, KHÔNG lặng lẽ dùng số cũ.
        const phone = c360.savedAddressPhone(r, input.phone, ctx.lastUserText);
        if ("error" in phone) return err("Lưu khách: SĐT mới chưa xác minh", phone.error, state);
        fields = { name: typed.length >= 2 ? typed : r.name, phone: phone.phone, address: r.address, province: r.province };
        // Mức PHONE — và THREAD mà chính nó đã là địa chỉ máy điền (`returning.ts` trả về mức PHONE) — đều là dữ liệu chủ SĐT.
        saved = r.trust === "PHONE";
      }
      // Địa chỉ ĐƠN CŨ (Customer 360) chỉ là gợi ý (AGENTS 3.12): gõ lại nó mà không qua use_saved_address ⇒ bỏ qua kiểm lời xác nhận.
      if (!saved && ctx.returning?.fromHistory && input.use_saved_address !== true && (await import("@/lib/sales-chatbot/customer-360")).historyAddressWithoutConsent(ctx.returning, input.address, ctx.lastUserText))
        return err("Lưu khách: địa chỉ đơn cũ chưa được khách xác nhận", "Địa chỉ này lấy từ ĐƠN CŨ — hỏi khách xác nhận dùng lại, rồi gọi create_customer với use_saved_address = true + customer_confirmation = nguyên văn lời xác nhận.", state);
      // Họ tên: AI ghi ⇒ dùng; trống / quá ngắn ⇒ tên Facebook của khách (kênh fanpage) — không bắt khách khai lại tên.
      const typedName = typeof fields.name === "string" && fields.name.trim().length >= 2 ? fields.name : "";
      const v = z.object({ name: z.string().trim().min(2).max(200), phone: z.string().trim().min(8).max(30), address: z.string().trim().min(5).max(500), province: z.string().trim().max(100).optional() }).safeParse({ name: typedName || ctx.customerName || "", phone: fields.phone, address: fields.address, province: fields.province || undefined });
      if (!v.success) return err("Lưu khách: thiếu thông tin", "Cần họ tên, số điện thoại (8–15 số) và địa chỉ giao đầy đủ.", state, { reason: "MISSING_CONTACT", fields: v.error.issues.map((i) => i.path.map(String).join(".")) });
      // Giữ mốc lần đầu khi khách sửa tên / địa chỉ mà vẫn cùng SĐT — một SĐT chỉ «để lại» một lần.
      const firstAt = state.customer?.phone === v.data.phone && state.customer.at ? state.customer.at : new Date().toISOString();
      if (simulated) {
        state.customer = { id: null, name: v.data.name, phone: v.data.phone, address: v.data.address, province: v.data.province ?? "", simulated: true, at: firstAt, ...(saved ? { savedAddress: true } : {}) };
        const chkSim = addressCheckOf({ address: v.data.address, province: v.data.province ?? "" }, addressOpts(state, ctx));
        markAddressAsked(state, chkSim, ctx.turn);
        return ok(`(Thử) lưu khách ${v.data.name}`, { customer_id: "thu-nghiem", simulated: true, note: "Khung thử: KHÔNG lưu khách thật.", address_check: chkSim.view }, state);
      }
      const r = await createCustomerAsAgent(ctx.agent, { name: v.data.name, phone: v.data.phone, address: v.data.address, province: v.data.province });
      if (!r.ok) return err("Lưu khách: lỗi", failureText(r), state, omsSignal(r));
      // XÁC MINH = hồ sơ chính là hồ sơ khớp mã Facebook của người đang nhắn (FB_ID) — DUY NHẤT. Không đủ: hồ sơ «mới» (khoá theo
      // SĐT — ai gõ trước SĐT của người chưa có hồ sơ thì đơn sau này của chủ SĐT gắn vào hồ sơ ấy, review bảo mật L1), và «hội
      // thoại từng có đơn của hồ sơ» (đặt một đơn ghi SĐT X không chứng minh là chủ SĐT X: kẻ gian tự lên đơn nháp mang SĐT nạn
      // nhân ngay trong hội thoại của mình — review bảo mật vòng 3, CRITICAL). Đã xác minh ở lượt trước của CHÍNH hội thoại và vẫn
      // là hồ sơ ấy (khách đổi địa chỉ giữa chừng — lượt sau `ctx.returning` đã là mức THREAD) ⇒ giữ cờ, không thì báo giá riêng
      // rồi đơn tính bảng mặc định (review vòng 4 L-a). Cờ trong state chỉ máy chủ ghi, và chỉ ở vế FB_ID.
      const verifiedIdentity = (ctx.returning?.trust === "FB_ID" && ctx.returning.customerId === r.id) || (state.customer?.verifiedIdentity === true && state.customer.id === r.id);
      // Địa chỉ máy điền giữ nhãn khi khách gọi lại công cụ với ĐÚNG thông tin đó — không để lượt sau bỏ che (review bảo mật H1).
      const keepSaved = saved || (state.customer?.savedAddress === true && state.customer.phone === v.data.phone && state.customer.address === v.data.address);
      state.customer = { id: r.id, name: v.data.name, phone: v.data.phone, address: v.data.address, province: v.data.province ?? "", simulated: false, at: firstAt, ...(keepSaved ? { savedAddress: true } : {}), ...(verifiedIdentity ? { verifiedIdentity: true } : {}) };
      const chk = addressCheckOf({ address: v.data.address, province: v.data.province ?? "" }, addressOpts(state, ctx));
      markAddressAsked(state, chk, ctx.turn);
      return ok(r.existing ? `Khách cũ (${v.data.phone})` : `Đã lưu khách ${v.data.name}`, { customer_id: r.id, existing_customer: r.existing, address_check: chk.view }, state);
    }
    case "create_draft_order":
    case "update_draft_order": {
      if (!state.customer) return err("Đơn nháp: chưa có khách", "Chưa lưu thông tin khách — gọi create_customer trước.", state);
      const v = z
        .object({ items: itemsZ.optional(), recipient_name: z.string().trim().max(120).optional(), recipient_phone: z.string().trim().max(30).optional(), address: z.string().trim().max(300).optional(), ward: z.string().trim().max(120).optional(), delivery_note: z.string().trim().max(500).optional() })
        .safeParse(input);
      if (!v.success) return err("Đơn nháp: sai đầu vào", "Đầu vào đơn nháp không hợp lệ.", state, { reason: "BAD_INPUT", fields: v.error.issues.map((i) => i.path.map(String).join(".")) });
      const existing = state.draft;
      if (name === "create_draft_order" && !v.data.items) return err("Đơn nháp: thiếu hàng", "Đơn nháp cần items.", state, { reason: "BAD_INPUT", fields: ["items"] });
      if (name === "update_draft_order" && !existing) return err("Sửa đơn: chưa có đơn nháp", "Chưa có đơn nháp — gọi create_draft_order.", state);
      // LỜI MỜI KHÔNG BAO GIỜ LÀ ĐIỀU KIỆN LÊN ĐƠN (chủ shop 16/10/2026, #868): cổng cũ (02/10/2026) từ chối lên đơn khi chưa gửi câu
      // upsell — khách đã đủ món + SĐT + địa chỉ vẫn phải nghe menu trước. Lời mời nay là cơ hội do `next-best-action.ts` quyết, đơn hợp
      // lệ lên ngay.
      // Đơn máy TỰ CHỐT (P0-A): khách sửa ngay sau đó ⇒ update_draft_order sửa chính đơn đã chốt (giữ «Đã xác nhận»). Còn lại như cũ.
      const editingConfirmed = Boolean(state.confirmed?.auto) && name === "update_draft_order" && Boolean(state.draft?.orderId || state.confirmed?.simulated);
      // Đơn chốt qua LỜI ĐỒNG Ý (không phải máy tự chốt) ⇒ sửa / thêm vào đơn là việc của NHÂN VIÊN — máy chủ ép chuyển người, không để tuỳ
      // model (HOTFIX 12/10/2026: engine bỏ chuyển người mặc định sau chốt nên đây là lớp chặn ca «Đỗ Là» — bot hứa đổi địa chỉ / lịch giao).
      if (state.confirmed && !editingConfirmed) return { ...err("Đơn đã chốt", "Đơn của hội thoại này đã chốt — KHÔNG nói đã sửa / đã thêm; máy chủ đã chuyển nhân viên.", state), ...(state.confirmed.auto ? {} : { requireHuman: `Sửa đơn đã chốt — khách muốn ${name === "create_draft_order" ? "thêm đơn / thêm món" : "đổi đơn"}: «${ctx.lastUserText.trim().slice(0, 120)}»` }) };
      const base: Recipient = existing?.recipient ?? { name: state.customer.name, phone: state.customer.phone, address: state.customer.address, province: state.customer.province };
      const lines = v.data.items ? mergeLines(v.data.items.map((i) => ({ variantId: i.variant_id, quantity: i.quantity }))) : existing!.lines;
      const recipient = recipientFrom(v.data, base);
      // Yêu cầu đóng gói riêng («2 gói riêng», «chia 2 túi») — giữ qua các lượt sửa đơn, ghi vào ghi chú đơn cho kho.
      const packing = packingRequestOf(ctx.lastUserText) ?? existing?.packing ?? null;
      // Xã / phường khách vừa xác nhận: phải có trong danh mục của tỉnh đã đọc được VÀ TIN CUỐI của khách nói đúng tên đó, không nêu xã
      // nào khác (không đoán thay). Tên xã ở một tin TRƯỚC chỉ nhận khi nằm trong một địa chỉ đầy đủ KHỚP dòng đơn (`wardFromCustomerWords`:
      // cùng đường, cùng số nhà, quận cũ, không lời sửa). Review độc lập PR #848: nối mọi tin khách lại, hay nhận «lời trả lời phường» ở tin
      // trước, đều để phường của địa chỉ CŨ lọt vào đơn của địa chỉ MỚI.
      if (v.data.ward) {
        const parsedWard = parseCustomerAddress(recipient.address, recipient.province);
        const okWard = acceptCustomerWard(parsedWard, v.data.ward, ctx.lastUserText);
        const lastNamesOther = okWard.ok && Boolean(parsedWard.province) && ctx.lastUserText.split(/\n+/).some((l) => namesOtherWard(l, parsedWard.province!, okWard.ward));
        if (okWard.ok && !lastNamesOther) recipient.ward = okWard.ward;
        else {
          const wardCore = (x: string) => foldVnText(x).replace(/^(phuong|xa|thi tran|dac khu) /, "");
          const stated = wardFromCustomerWords(parsedWard, recipient.address, ctx.customerTexts);
          if (stated && wardCore(stated.ward) === wardCore(v.data.ward)) {
            recipient.ward = stated.ward;
            if (!parsedWard.province) recipient.province = stated.province;
          } else return err("Đơn nháp: xã / phường chưa xác nhận", okWard.ok ? `Tin khách nêu cả một phường khác ngoài «${okWard.ward}» — hỏi lại khách đúng một câu, không tự chọn.` : okWard.error, state);
        }
      }
      // ĐỊA CHỈ KHÁCH TỰ GÕ (P0 15/10/2026): dòng model chép mất phần xã mà tin khách ghi rõ một xã có thật (cùng tỉnh, cùng số nhà) ⇒
      // ghi đúng xã đó vào đơn (dòng địa chỉ giữ nguyên chữ) — không bắt khách khai lại điều đã nói.
      if (!recipient.ward) {
        const parsed = parseCustomerAddress(recipient.address, recipient.province);
        const stated = wardFromCustomerWords(parsed, recipient.address, ctx.customerTexts);
        if (stated) {
          recipient.ward = stated.ward;
          if (!parsed.province) recipient.province = stated.province;
        }
      }
      // KHÁCH ĐỔI ĐỊA CHỈ (#855, ca «ThuyNgo»; review độc lập): máy chủ CHỈ tự ghi địa chỉ mới khi CHẮC — chính tin khách MỚI NHẤT mang một
      // địa chỉ đọc được KHÁC địa chỉ đang giữ, kèm lời đổi TƯỜNG MINH («giao về …», «đổi địa chỉ», «chuyển nhà»…). Khi đó ghi NGUYÊN VĂN
      // chữ khách, xã đọc lại từ chính địa chỉ đó, và cờ cần người đi CÙNG GIAO DỊCH ghi đơn (`AgentOrderOptions.review`) — đơn không bao giờ
      // «có xã mà không cờ», kể cả đơn mới. Không chắc (khách đang gõ dở / không có lời đổi tường minh / model chép một địa chỉ KHÁC chữ
      // khách) ⇒ KHÔNG ghi đè, gắn cờ đơn đang có + chuyển người. Chỉ sửa món / ghi chú ⇒ không đụng địa chỉ (không có địa chỉ khác mới hơn).
      const texts = ctx.customerTexts ?? [];
      const change = deliveryAddressDecision({ draft: existing, customer: state.customer }, texts);
      const pending = change.status === "CHANGE_PENDING_VERIFICATION" && change.use ? change.use : null;
      const explicitChange = pending !== null && pending.messageIndex === texts.length - 1 && hasChangeCue(texts[texts.length - 1] ?? "");
      const modelWroteNew = pending !== null && Boolean(v.data.address?.trim()) && sameDeliveryPlace(recipient.address, pending.raw);
      const changeFrom = (change.previous?.raw ?? "").slice(0, 120);
      const unsure = change.status === "CHANGE_INCOMPLETE" || (pending !== null && !modelWroteNew && (!explicitChange || Boolean(v.data.address?.trim())));
      if (unsure) {
        // Gắn cờ hỏng (lỗi / ném) vẫn đi nhánh chuyển người — không bao giờ ghi đè khi không chắc.
        if (existing?.orderId && !simulated) {
          await flagOrderForReviewAsAgent(ctx.agent, existing.orderId, { code: "ADDRESS_UNRESOLVED", note: `Khách có thể đã đổi địa chỉ giao — máy KHÔNG tự ghi; địa chỉ đang giữ: «${changeFrom}»; cần người xác minh`, quote: (texts[texts.length - 1] ?? "").slice(0, 300) || null }, now).catch(() => null);
        }
        return { ...err("Đơn nháp: địa chỉ chưa chắc", "Khách có vẻ đổi nơi giao nhưng máy chủ chưa chắc địa chỉ mới — KHÔNG ghi đè địa chỉ, đã chuyển nhân viên xác minh. KHÔNG nói đã đổi địa chỉ, KHÔNG hỏi lại khách.", state), requireHuman: "Khách đổi địa chỉ giao chưa rõ — nhân viên xác minh địa chỉ (máy không tự ghi đè)" };
      }
      const addressChange = pending && (explicitChange || modelWroteNew) ? { to: pending.raw, from: changeFrom } : null;
      if (addressChange && !modelWroteNew && !sameDeliveryPlace(recipient.address, addressChange.to)) {
        recipient.address = addressChange.to;
        recipient.province = "";
        delete recipient.ward;
        const parsedNew = parseCustomerAddress(recipient.address);
        if (canAutoFill(parsedNew) && parsedNew.ward) recipient.ward = parsedNew.ward;
      }
      const changeFlag = addressChange ? { code: "ADDRESS_UNRESOLVED" as const, note: `Khách đổi địa chỉ giao — địa chỉ trước: «${addressChange.from}»; cần người xác minh địa chỉ mới`, quote: addressChange.to.slice(0, 300) } : null;
      const priced = await priceLines(lines, ctx.config, verifiedCustomerId(state), [recipient.address, recipient.province].join(", "), { packing: Boolean(packing) });
      if (priced.missing.length) return err("Đơn nháp: mã không có", `Không có mẫu mã: ${priced.missing.join(", ")}.`, state, { reason: "UNKNOWN_SKU" });
      if (priced.unpriced.length) return { ...err("Đơn nháp: mã chưa có giá", `Chưa có giá: ${priced.unpriced.join(", ")}.`, state, { reason: "UNPRICED_SKU" }), requireHuman: `Giá bất thường: ${priced.unpriced.join(", ")} chưa có giá` };
      if (priced.addOnOnly) return err("Đơn nháp: chỉ có món bán kèm", ADD_ON_ONLY_ERROR, state);
      // Số lượng chỉ xét khi lượt này GỬI items (sửa người nhận / ghi chú không kiểm lại số lượng đã lên).
      const packMistake = v.data.items ? packQuantityMistake(priced.asked, ctx.lastUserText) : null;
      if (packMistake) return err("Đơn nháp: nhầm quy cách thành số lượng", packMistake, state, { reason: "BAD_INPUT", fields: ["items.quantity"] });
      const choice = v.data.items ? packChoiceMistake(priced, ctx.config, ctx.lastUserText) : null;
      if (choice) return err("Đơn nháp: nhầm gói", choice, state, { reason: "BAD_INPUT", fields: ["items"] });
      // GIỎ CÓ THẨM QUYỀN (P0 12/10/2026): hạ / bỏ món khách đã nói tường minh mà khách chưa sửa tường minh ⇒ từ chối (trình tự hội
      // thoại, không phải đơn hỏng ⇒ không gắn tín hiệu đơn không hợp lệ).
      const cartBreak = v.data.items ? commitmentViolation(state.cart, priced.asked, ctx.turn ?? null) : null;
      if (cartBreak) return err("Đơn nháp: hạ số lượng khách đã chốt", cartBreak, state);
      // DÒNG HÀNG PHẢI CÓ CĂN CỨ TỪ KHÁCH (P0 14/10/2026, ca «Châu Dương»: món upsell × 3 khách chưa đồng ý vào đơn, đơn tự chốt 640.000 ₫).
      // Sản phẩm ĐÃ nằm trong đơn nháp hiện có đã qua kiểm này lúc được ghi ⇒ chỉ kiểm sản phẩm MỚI (review 14/10: không bắt bỏ món chính).
      const grounded = v.data.items && existing ? new Set((await priceLines(existing.lines, ctx.config, verifiedCustomerId(state))).asked.map((l) => l.productId ?? l.variantId)) : new Set<string>();
      const noBasis = v.data.items ? lineBasisViolation(state.cart, priced.asked, ctx.turn ?? null, ctx.customerSaid ?? "", grounded) : null;
      if (noBasis) return err("Đơn nháp: dòng hàng không có căn cứ từ khách", noBasis, state);
      // Giá chưa xác thực ⇒ KHÔNG tạo / sửa đơn tự động, người xác minh (yêu cầu 5 của chủ shop).
      if (!priced.quote.verified) {
        state.quote = quoteSnapshotOf(priced.quote, now);
        return { ...err("Đơn nháp: giá chưa xác thực", `${QUOTE_UNVERIFIED_INSTRUCTION} (${quoteReasons(priced.quote)})`, state, { reason: "PRICE_UNVERIFIED" }), requireHuman: priceUnverifiedReason(quoteReasons(priced.quote)) };
      }
      const firstShown = existing?.firstShownTurn ?? existing?.shownTurn ?? ctx.turn;
      // Đơn nháp giữ dòng ĐÃ QUY GÓI (đúng những dòng ghi vào đơn) — chốt đơn tính lại trên chính chúng.
      const quoteClaim = quoteClaimOf(priced.quote);
      // Báo giá + dòng khách ĐÃ THẤY = của đơn nháp ở lượt TRƯỚC (sửa nhiều lần trong một lượt vẫn giữ bản khách đã thấy).
      const carrySeen = existing && existing.shownTurn !== ctx.turn;
      const seen = carrySeen ? { seenQuoteId: existing.quote?.id, seenLines: existing.lines, seenTotal: existing.quote ? (existing.quote.total ?? existing.quote.subtotal) : undefined } : { seenQuoteId: existing?.seenQuoteId, seenLines: existing?.seenLines, seenTotal: existing?.seenTotal };
      const draft = { ...(ctx.turn !== undefined ? { shownTurn: ctx.turn } : {}), ...(firstShown !== undefined ? { firstShownTurn: firstShown } : {}), orderId: existing?.orderId ?? null, lines: priced.lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity })), unitPrices: Object.fromEntries(priced.lines.map((l) => [l.variantId, l.unitPrice])), recipient, note: v.data.delivery_note ?? existing?.note ?? "", simulated, quote: quoteClaim, ...(seen.seenQuoteId ? seen : {}), packing };
      if (!simulated) {
        const payload = orderInput(state, draft, priced, editingConfirmed ? "CONFIRMED" : "NEW", ctx.config, ctx.channel);
        // Đơn MỚI mang mã quảng cáo đã dẫn khách vào hội thoại (trong cửa sổ quy kết — máy chủ quyết); sửa đơn KHÔNG đổi nó.
        // Tổ chức tự chốt mà bot quyết CHƯA chốt (khách hoãn / phản đối giá / vừa mời thêm món) ⇒ lõi giữ «Mới» (`holdNew`).
        const holdNew = ctx.autoConfirm === true && autoConfirmBlocker({ ...state, draft }, ctx) !== null;
        // Cờ «khách đổi địa chỉ» ghi CÙNG giao dịch với đơn (tạo / sửa) — hỏng thì cả lượt ghi hỏng, không có đơn «có xã mà không cờ».
        const review = changeFlag ? { review: changeFlag } : {};
        const r = draft.orderId
          ? await updateOrderAsAgent(ctx.agent, draft.orderId, payload, { ...agentOrderOpts(ctx, state, false, quoteClaim, holdNew), ...review })
          : await createOrderAsAgent(ctx.agent, payload, { ...agentOrderOpts(ctx, state, true, quoteClaim, holdNew), adId: await chatOrderAdId(ctx.conversationId, now), ...review });
        if (!r.ok) return err("Đơn nháp: lỗi", failureText(r), state, omsSignal(r));
        markOrderWritten(ctx.writeMark, r.id);
        draft.orderId = r.id;
      }
      state.draft = draft;
      state.cart = bindCommitment(state.cart, priced.asked, ctx.turn ?? null, now);
      state.quote = quoteSnapshotOf(priced.quote, now);
      settleDispute(state, ctx.turn);
      const addr = addressCheckOf(draft.recipient, addressOpts(state, ctx));
      markAddressAsked(state, addr, ctx.turn);
      const view = { order_code: draft.orderId ? `#${manualOrderShortCode(draft.orderId)}` : "(thử)", status: "Nháp — chưa chốt, chưa giữ hàng", simulated, ...cartView(priced), recipient: recipientView(draft.recipient, state), delivery_note: draft.note || null, address_check: addr.view };
      if (editingConfirmed && state.confirmed) {
        const validity = simulated || !draft.orderId ? null : await confirmedValidity(draft.orderId);
        state.confirmed = { ...state.confirmed, total: priced.total ?? priced.subtotal, quoteId: priced.quote.quoteId, ...(validity ? { valid: validity.valid, pending: validity.pending } : {}) };
        const pendingText = validity && !validity.valid ? (validity.pending === "ADDRESS" ? CLAIM_SAFE_TEXT.ORDER_PENDING_ADDRESS : CLAIM_SAFE_TEXT.ORDER_PENDING_CHECK) : null;
        return ok(`${simulated ? "(Thử) " : ""}Sửa đơn đã chốt · ${formatVND(priced.subtotal)}`, { ...view, status: "Đã chốt — đã cập nhật theo ý khách", auto_confirmed: true, say_to_customer: pendingText ?? autoConfirmText(priced.lines), instruction: "Đơn ĐÃ CHỐT vừa được cập nhật theo ý khách. Gửi khách ĐÚNG MỘT câu say_to_customer — không hỏi xác nhận lại." }, state);
      }
      // TỰ CHỐT KHI ĐỦ ĐƠN (P0-A): đủ sáu điều kiện ⇒ chốt NGAY bằng chính lượt chốt của confirm_order (cùng kiểm giá · tồn · địa chỉ của lõi),
      // không hỏi khách «có chốt không / lấy thêm gì không». Thiếu ⇒ nói đúng phần thiếu cho model hỏi khách.
      if (ctx.autoConfirm && !state.confirmed) {
        const blocker = autoConfirmBlocker(state, ctx);
        if (!blocker) {
          const c = await executeToolCore("confirm_order", { customer_confirmation: "" }, { ...ctx, state, autoConfirming: true });
          if (c.isError) {
            // Lượt chốt hỏng mà lõi đã nâng đơn lên «Đã xác nhận» (công tắc) ⇒ đơn thật thắng: ghi state.confirmed theo đơn.
            const synced = simulated ? null : await confirmedFromOrder(c.state, now).catch(() => null);
            return { ...c, ...(synced ? { state: synced } : {}), content: JSON.stringify({ ...view, auto_confirm_error: (JSON.parse(c.content) as { error?: string }).error ?? "Chưa chốt được", ...(synced ? { order_confirmed_in_erp: true } : {}) }) };
          }
          return { ...c, summary: `${c.summary} · tự chốt` };
        }
        return ok(`${simulated ? "(Thử) " : ""}${existing ? "Sửa" : "Lên"} đơn nháp · ${formatVND(priced.subtotal)} · chưa tự chốt`, { ...view, auto_confirm: false, missing: blocker }, state);
      }
      return ok(`${simulated ? "(Thử) " : ""}${existing ? "Sửa" : "Lên"} đơn nháp · ${formatVND(priced.subtotal)}`, view, state);
    }
    case "confirm_order": {
      const quote = z.string().trim().min(2).max(300).safeParse(input.customer_confirmation);
      // KHÁCH PHẢI THẤY TÓM TẮT RỒI MỚI ĐỒNG Ý (03/10/2026, «Trần Nguyễn»): bot lên đơn + đọc tóm tắt + CHỐT trong cùng lượt,
      // lấy «Phải ngon nhé» — câu khách gõ TRƯỚC khi thấy tóm tắt — làm lời đồng ý. Đơn LẦN ĐẦU lên ở lượt này ⇒ chưa chốt.
      // Khách đã thấy tóm tắt ở lượt TRƯỚC rồi «Ok» món mời thêm (04/10/2026, «Nguyễn Lộc»: bot thêm chả mực rồi lại hỏi «Em
      // gửi đơn luôn nhé?», khách dặn dò thay vì «ok» ⇒ đơn không chốt, nhóm không có tin) ⇒ sửa và chốt luôn trong lượt này.
      if (!ctx.autoConfirming && state.draft && !state.confirmed && ctx.turn !== undefined && state.draft.shownTurn === ctx.turn && (state.draft.firstShownTurn ?? state.draft.shownTurn) === ctx.turn) {
        return err("Chốt: khách chưa thấy tóm tắt", "Đơn vừa lên / vừa sửa trong lượt này — khách CHƯA đọc tóm tắt. Gửi tóm tắt đơn rồi DỪNG, đợi khách trả lời đồng ý ở tin SAU mới gọi confirm_order.", state);
      }
      if (state.confirmed) return ok("Đơn đã chốt từ trước", { already_confirmed: true, order_code: state.confirmed.orderId ? `#${manualOrderShortCode(state.confirmed.orderId)}` : "(thử)" }, state);
      if (!state.draft) return err("Chốt: chưa có đơn nháp", "Chưa có đơn nháp để chốt.", state);
      if (!ctx.autoConfirming && (!quote.success || !quotedInText(quote.data, ctx.lastUserText))) {
        return err("Chốt: chưa có lời xác nhận của khách", "customer_confirmation phải là nguyên văn lời đồng ý trong câu CUỐI của khách. Khách chưa xác nhận ⇒ đọc lại tóm tắt và hỏi khách có đồng ý không.", state);
      }
      const d = state.draft;
      if (!d.recipient.name || !d.recipient.phone || !d.recipient.address) return err("Chốt: thiếu người nhận", "Thiếu tên / SĐT / địa chỉ người nhận.", state, { reason: "MISSING_CONTACT", fields: (["name", "phone", "address"] as const).filter((k) => !d.recipient[k]).map((k) => `recipient.${k}`) });
      // KHÁCH PHẢN ĐỐI GIÁ (PRICE_DISPUTED, ca «Chị Hoàn» 11/10/2026): không chốt khi khách chưa đồng ý lại một báo giá máy chủ.
      const pd = state.priceDispute;
      if (pd && (pd.open || (ctx.turn !== undefined && pd.requotedTurn === ctx.turn))) {
        return err("Chốt: khách đang phản đối giá", "KHÁCH ĐANG PHẢN ĐỐI GIÁ — KHÔNG chốt trong lượt này. Báo lại ĐÚNG số tiền máy chủ trả (calculate_cart / đơn nháp) và hỏi khách xác nhận; khách đồng ý ở tin SAU mới gọi confirm_order. Số khách nói không có trong báo giá máy chủ ⇒ handoff_to_human «Giá / tồn bất thường — PRICE_DISPUTED».", state);
      }
      // ĐỔI SỐ LƯỢNG / QUY CÁCH trong CHÍNH lượt này làm TỔNG TĂNG so với tổng khách đã thấy (dòng khách đã thấy bị đổi, không phải chỉ
      // thêm món) ⇒ báo giá cũ hết hiệu lực: khách phải thấy và đồng ý TỔNG MỚI (BỔ SUNG 11/10 (5), ca «Chị Hoàn»). Giữ luật 6 / 04/10/2026:
      // khách tự GIẢM («không phải 2kg, lấy 1kg thôi») hay nói «lấy THÊM …» / nhận món mời thêm (dòng mới) ⇒ sửa và chốt luôn.
      if (!ctx.autoConfirming && ctx.turn !== undefined && d.shownTurn === ctx.turn && d.seenLines && d.quote && d.seenQuoteId && d.seenQuoteId !== d.quote.id) {
        const changedExisting = d.seenLines.some((s) => d.lines.find((l) => l.variantId === s.variantId)?.quantity !== s.quantity);
        const raised = d.seenTotal === undefined || (d.quote.total ?? d.quote.subtotal) > d.seenTotal;
        if (changedExisting && raised && !/(?:^|[^a-z])them(?![a-z])/.test(foldVi(ctx.lastUserText))) {
          return err("Chốt: tổng mới chưa xác nhận", `Khách vừa đổi số lượng / quy cách — báo giá cũ hết hiệu lực, tổng mới ${formatVND(d.quote.total ?? d.quote.subtotal)}. Gửi tóm tắt với tổng mới và hỏi khách xác nhận; khách đồng ý ở tin SAU mới chốt.`, state);
        }
      }
      // ĐỊA CHỈ CHƯA CHUẨN HOÁ (P0 11/10/2026, đơn #463DEBAE «phường Cổ Nhuế 2» cũ): khách chưa từng được hỏi phần thiếu ⇒ chưa chốt,
      // hỏi ĐÚNG câu của bộ đọc rồi dừng. Đã hỏi ở lượt trước mà khách vẫn đồng ý ⇒ chốt theo luật chủ shop 08/10 (máy chốt + cờ
      // CẦN NGƯỜI KIỂM «địa chỉ chưa ghép» — ô xã vẫn trống, không đoán). Bài kiểm gọi lẻ (không có lượt) ⇒ không xét.
      const addrChk = addressCheckOf(d.recipient, addressOpts(state, ctx));
      if (!ctx.autoConfirming && ctx.turn !== undefined && addressAskPending(state, addrChk, ctx.turn)) {
        markAddressAsked(state, addrChk, ctx.turn);
        const noProvince = addrChk.view.missing.includes("province");
        const next = noProvince ? "Khách nói tỉnh / thành ⇒ update_draft_order với address thêm đúng tên tỉnh khách nói (KHÔNG tự thêm)" : "Khách nói tên xã / phường ⇒ update_draft_order với ward = tên đó rồi confirm_order";
        return err("Chốt: địa chỉ chưa chuẩn hoá — hỏi khách", `Địa chỉ giao chưa ghép được ${noProvince ? "TỈNH / THÀNH (và xã / phường)" : "xã / phường"} theo địa giới mới (${addrChk.view.status}). CHƯA chốt. Hỏi khách đúng câu: «${addrChk.view.ask_customer}» rồi DỪNG, đợi khách trả lời. ${next}. KHÔNG nói đã lên đơn.`, state);
      }
      // Phường đọc từ CHÍNH tin khách (đơn nháp lên trước khi có tin đó) ⇒ ghi vào đơn lúc chốt, dòng địa chỉ giữ nguyên chữ.
      if (addrChk.view.status === "CUSTOMER_STATED" && addrChk.view.ward && !(d.recipient.ward ?? "").trim()) {
        d.recipient = { ...d.recipient, ward: addrChk.view.ward, ...(parseCustomerAddress(d.recipient.address, d.recipient.province).province ? {} : { province: addrChk.view.province ?? "" }) };
      }
      const priced = await priceLines(d.lines, ctx.config, verifiedCustomerId(state), [d.recipient.address, d.recipient.province].join(", "), { packing: Boolean(d.packing) });
      if (priced.missing.length || priced.unpriced.length) return err("Chốt: mã không bán được", "Có mẫu mã không còn bán hoặc chưa có giá — chuyển nhân viên.", state, { reason: priced.missing.length ? "UNKNOWN_SKU" : "UNPRICED_SKU" });
      if (priced.addOnOnly) return err("Chốt: chỉ có món bán kèm", ADD_ON_ONLY_ERROR, state);
      // Đơn nháp có dòng hàng không có căn cứ từ khách ⇒ KHÔNG chốt — kể cả máy tự chốt (P0-A đi qua đúng nhánh này).
      // Đơn nháp khách đã thấy ở lượt TRƯỚC ⇒ dòng của nó đã qua kiểm lúc ghi; lên + chốt trong cùng lượt (máy tự chốt) ⇒ kiểm lại cả đơn.
      const seenBefore = d.shownTurn !== undefined && ctx.turn !== undefined && d.shownTurn < ctx.turn;
      const noBasis = lineBasisViolation(state.cart, priced.asked, ctx.turn ?? null, ctx.customerSaid ?? "", seenBefore ? new Set(priced.asked.map((l) => l.productId ?? l.variantId)) : new Set<string>());
      if (noBasis) return err("Chốt: dòng hàng không có căn cứ từ khách", `${noBasis} Sửa đơn nháp (update_draft_order) cho đúng món khách chọn rồi mới chốt.`, state);
      // Giá chưa xác thực ⇒ KHÔNG chốt, người xác minh (yêu cầu 4–5 của chủ shop).
      if (!priced.quote.verified) {
        state.quote = quoteSnapshotOf(priced.quote, now);
        return { ...err("Chốt: giá chưa xác thực", `${QUOTE_UNVERIFIED_INSTRUCTION} (${quoteReasons(priced.quote)})`, state, { reason: "PRICE_UNVERIFIED" }), requireHuman: priceUnverifiedReason(quoteReasons(priced.quote)) };
      }
      const changed = priced.lines.filter((l) => d.unitPrices[l.variantId] !== l.unitPrice);
      // Báo giá đã đọc cho khách (mã của đơn nháp) ≠ báo giá lúc chốt (giảm theo khối lượng / phí ship / giá đổi) ⇒ đọc lại, không chốt.
      const quoteMoved = Boolean(d.quote && d.quote.id !== priced.quote.quoteId);
      if (changed.length || quoteMoved) {
        state.draft = { ...d, unitPrices: Object.fromEntries(priced.lines.map((l) => [l.variantId, l.unitPrice])), quote: quoteClaimOf(priced.quote) };
        state.quote = quoteSnapshotOf(priced.quote, now);
        const what = changed.length ? changed.map((l) => `${l.name} nay ${formatVND(l.unitPrice)}`).join("; ") : `tổng nay ${formatVND(priced.quote.total ?? priced.subtotal)}`;
        return err("Chốt: giá vừa đổi", `Giá vừa đổi: ${what}. Đọc lại tóm tắt với giá mới và hỏi khách xác nhận lại.`, state);
      }
      const stock = await stockFor(d.lines.map((l) => l.variantId));
      const short = d.lines.filter((l) => {
        const s = stock.get(l.variantId);
        return s?.stockKnown && (s.available ?? 0) < l.quantity;
      });
      const shortNames = short.map((l) => priced.lines.find((p) => p.variantId === l.variantId)?.name ?? l.variantId).join(", ");
      if (short.length && !ctx.config.sellWithoutStockCheck) return err("Chốt: không đủ hàng", `Không đủ hàng khả dụng cho: ${shortNames}.`, state, { reason: "STOCK_SHORT" });
      const unknownStock = d.lines.some((l) => !stock.get(l.variantId)?.stockKnown);
      const stockNotes = [unknownStock ? "Tồn chưa xác nhận lúc chốt — kho kiểm trước khi giao." : "", short.length ? `Sổ kho đang thiếu lúc chốt (${shortNames}) — shop bật «chốt không cần kiểm tồn», kho chuẩn bị hàng trước khi giao.` : ""].filter(Boolean);
      let orderId: string | null = null;
      let validity: { valid: boolean; pending: "ADDRESS" | "CHECK" | null } | null = null;
      if (!simulated) {
        const payload = orderInput(state, { ...d, note: stockNotes.length ? [d.note, ...stockNotes].filter(Boolean).join("\n") : d.note }, priced, "CONFIRMED", ctx.config, ctx.channel);
        const r = await updateOrderAsAgent(ctx.agent, d.orderId, payload, agentOrderOpts(ctx, state, false, quoteClaimOf(priced.quote)));
        if (!r.ok) return err("Chốt: lỗi", failureText(r), state, omsSignal(r));
        markOrderWritten(ctx.writeMark, r.id);
        orderId = r.id;
        validity = await confirmedValidity(r.id);
        // Khách từng báo huỷ rồi nay đồng ý lại ⇒ một dòng vết «khách xác nhận lại» trên đơn; cờ cần kiểm GIỮ NGUYÊN (người quyết).
        if (state.declined && !ctx.autoConfirming) await noteCustomerReconfirmAsAgent(ctx.agent, r.id, quote.success ? ctx.lastUserText.trim().slice(0, 300) || null : null, now);
        // Khách đang được giữ đơn (đã xin huỷ) mà nay chốt lại ⇒ lượt giữ đơn THÀNH CÔNG (10/10/2026).
        if (state.cancelRequest?.orderIds.includes(r.id)) await recordCustomerKeptOrder(ctx.agent, r.id, ctx.lastUserText.trim().slice(0, 300) || null, now);
      }
      delete state.cancelRequest;
      state.confirmed = { orderId, simulated, total: priced.total ?? priced.subtotal, at: new Date().toISOString(), ...(ctx.promptStamp ? { stamp: ctx.promptStamp } : {}), quoteId: priced.quote.quoteId, ...(validity ? { valid: validity.valid, pending: validity.pending } : {}), ...(ctx.autoConfirming ? { auto: true } : {}) };
      state.quote = quoteSnapshotOf(priced.quote, now);
      state.stage = "DONE";
      // Đơn ĐÃ GHI nhưng CHƯA QUA KIỂM (địa chỉ chưa ghép · tổng lệch · cờ cần kiểm) ⇒ «khách đồng ý» ≠ «đơn đã tạo hợp lệ»: model nói
      // đúng câu ghi nhận, KHÔNG «đã lên đơn» (claim-guard chặn lần nữa nếu model vẫn viết).
      const pendingText = validity && !validity.valid ? (validity.pending === "ADDRESS" ? CLAIM_SAFE_TEXT.ORDER_PENDING_ADDRESS : CLAIM_SAFE_TEXT.ORDER_PENDING_CHECK) : null;
      return ok(`${simulated ? "(Thử) " : ""}Đã chốt đơn · ${formatVND(priced.subtotal)}${pendingText ? " · CHƯA qua kiểm" : ""}`, {
        confirmed: true,
        simulated,
        order_code: orderId ? `#${manualOrderShortCode(orderId)}` : "(thử — không tạo đơn thật, không báo nhóm)",
        ...cartView(priced),
        order_valid: validity ? validity.valid : null,
        ...(pendingText ? { say_to_customer: pendingText, instruction: "Đơn ĐÃ GHI nhưng CHƯA qua kiểm — TUYỆT ĐỐI KHÔNG nói «đã lên đơn», «đặt hàng thành công», «đã chốt đơn». Gửi khách ĐÚNG câu say_to_customer." } : {}),
        // Tự chốt (P0-A): một câu ngắn, không đọc lại cả đơn, không hỏi thêm.
        ...(ctx.autoConfirming ? { auto_confirmed: true, ...(pendingText ? {} : { say_to_customer: autoConfirmText(priced.lines), instruction: "ĐƠN ĐÃ TỰ CHỐT. Gửi khách ĐÚNG MỘT câu say_to_customer — KHÔNG đọc lại cả đơn, KHÔNG hỏi «lấy thêm gì không», «có chốt không», «xác nhận giúp em»." }) } : {}),
        stock_note: unknownStock ? "Có mã kho chưa xác nhận tồn — nhân viên sẽ kiểm trước khi giao." : null,
        address_check: addrChk.view,
      }, state);
    }
    case "send_quick_reply": {
      const code = z.string().trim().min(1).max(20).safeParse(input.code);
      const entry = code.success ? ctx.quickReplies?.find((q) => q.code.toLowerCase() === code.data.toLowerCase()) : undefined;
      if (!entry) return err("Câu mẫu: không có mã", "Không có câu mẫu với mã này — chỉ dùng mã trong danh sách CÂU MẪU.", state);
      if (entry.upsell && state.upsellSent) return err("Câu upsell đã gửi", "Câu upsell đã gửi trong hội thoại này — không gửi lại.", state);
      // CỬA SỔ LỜI MỜI (#868): câu mẫu UPSELL chỉ đi khi máy chủ cho phép — không lúc khách gửi SĐT / địa chỉ, đơn đang lên, đã chốt,
      // khách phàn nàn / từ chối / xin huỷ, đã chuyển người. Bị chặn ⇒ đi tiếp bước bán, không chặn đơn.
      if (entry.upsell) {
        const w = offerWindow({ state, lastUserText: ctx.lastUserText, complaint: customerComplaintSignal(ctx.lastUserText), returningPending: returningPendingOf(ctx.returning, state, ctx.turn) });
        if (!w.open) {
          state.offerDrops = withOfferDrops(state.offerDrops, ctx.turn, [{ cls: "CROSS_SELL", reason: w.reason }], "QUICK_REPLY");
          return err("Câu upsell: chưa đúng lúc", `KHÔNG mời thêm món lúc này — ${OFFER_BLOCK_LABEL[w.reason]}. Đi tiếp bước bán (lên / chốt đơn, hoặc hỏi đúng phần còn thiếu); không nhắc tới lời mời.`, state);
        }
      }
      const pick = await renderQuickReplyForSend(entry.id, ctx.config);
      if (!pick && entry.upsell) state.upsellUnavailable = true;
      if (!pick) return err(`Câu mẫu ${entry.code}: thiếu số ERP`, "Câu mẫu này đang thiếu giá / tồn từ ERP — tự trả lời bằng công cụ giá / tồn, không dùng câu mẫu.", state);
      if (repeatsRecent(pick.text, ctx.recentSaid ?? [])) return err(`Câu mẫu ${entry.code}: vừa gửi`, "Câu mẫu này shop VỪA gửi — khách đang trả lời nó. Đọc câu khách và đi tiếp, không gửi lại.", state);
      if (entry.upsell) {
        state.upsellSent = true;
        if (ctx.turn !== undefined) state.upsellTurn = ctx.turn;
      }
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
      // Hồ sơ do MÁY tạo: tên / địa chỉ của HỒ SƠ có thể do người lạ gõ cho SĐT này — không gợi ý gì từ nó, kể cả khi hồ sơ đã có đơn
      // (chủ thật có đơn được nhận ra ở khối «khách cũ», vốn đọc chữ của ĐƠN — review bảo mật #654). Trả ĐÚNG câu của khách mới: câu
      // khác là để lộ «có ai đó đã nhắn bot bằng SĐT này» (review #656, INFO). Nạp động: `returning.ts` đã nạp tệp này, nạp tĩnh là
      // thành vòng.
      const { agentCreatedCustomer } = await import("@/lib/sales-chatbot/returning");
      if (await agentCreatedCustomer(c.id)) return ok("Khách mới (chưa có SĐT trong sổ)", { returning_customer: false }, state);
      // SĐT gõ tay ⇒ chỉ GỢI Ý tên gọi + địa chỉ ĐÃ CHE; KHÔNG số đơn / lịch sử mua của chủ SĐT (kể cả trong `__summary` model đọc).
      const nameHint = c.name.trim().split(/\s+/).pop() ?? "";
      return ok("Khách cũ (SĐT có trong sổ)", { returning_customer: true, name_hint: nameHint, previous_address_hint: maskAddress(c.address) || null, note: "Chỉ GỢI Ý — hỏi khách xác nhận địa chỉ, không tự điền. Không nói lịch sử mua của SĐT này." }, state);
    }
    case "get_order_status": {
      // TRẠNG THÁI ĐƠN CỦA CHÍNH KHÁCH NÀY (Commerce Truth · Master Mission mục V). PHẠM VI: CHỈ đơn gắn với hội thoại này
      // (`sales_conversation_id`) + đơn bot đã chốt trong hội thoại (`state.confirmed` / `pastOrders`). KHÔNG theo SĐT khách tự gõ
      // và KHÔNG theo `state.customer.id` (id ấy có thể đến từ SĐT khách gõ — review độc lập 08/10/2026, CRITICAL). Câu trạng
      // thái theo thứ tự căn cứ ở `order-status-shared.ts`; giao lỗi / hoàn ⇒ việc của người.
      if (simulated) return ok("(Thử) Tra đơn", { orders: [], note: "Khung thử không có đơn thật — đơn mô phỏng không có vận chuyển." }, state);
      const r = await orderStatusFor(ctx.conversationId, state, ctx.commentTurn === true, { text: ctx.lastUserText, shopTexts: ctx.recentSaid ?? [], now: ctx.now ?? new Date() });
      const out = ok(r.summary, r.data, state);
      // CHỈ «không thấy đơn» — và câu hỏi LỊCH GIAO mà ERP không có lịch đã xác minh (P0 #855) — mới chuyển người ngay. Đơn có vấn
      // đề giao: bot nói đúng lời khai rồi hỏi khách.
      return r.needsHuman ? { ...out, requireHuman: r.needsHuman } : out;
    }
    case "mark_declined": {
      const reason = z.string().trim().min(2).max(300).safeParse(input.reason);
      state.declined = { reason: reason.success ? reason.data : "Khách từ chối", at: new Date().toISOString() };
      state.stage = "DECLINED";
      // Khách từ chối ⇒ giỏ cũ hết thẩm quyền: không được chặn một đơn MỚI khách nói sau đó (giỏ có thẩm quyền, review 12/10/2026).
      delete state.cart;
      // KHÁCH TỪ CHỐI KHI ĐÃ CÓ ĐƠN = YÊU CẦU HUỶ (chủ shop 10/10/2026, thay luật 08/10): KHÔNG huỷ ở đây — ghi yêu cầu (nguyên văn +
      // mốc) lên MỌI đơn đang mở của hội thoại (đơn bot chốt, đơn nháp, đơn nhân viên / bộ ghi đơn lên cho hội thoại — sự cố #189A435E:
      // đơn không nằm trong `state` thì bản cũ không gắn gì và trả «khách từ chối» trơn), gắn cờ «khách huỷ», mở lượt GIỮ ĐƠN. Huỷ thật
      // chỉ qua `cancel_order` ở lượt sau. Khung thử không ghi gì.
      if (simulated) return ok("Khách từ chối — thôi follow-up", { declined: true }, state);
      const targets = await conversationCancelTargets(ctx.conversationId, [state.confirmed?.orderId, state.draft?.orderId]);
      if (!targets.length) return ok("Khách từ chối — thôi follow-up", { declined: true }, state);
      const flagged = await openCancelRequest(ctx, state, targets.map((t) => t.id), state.declined.reason, now);
      return ok(`Khách huỷ — đơn ${flagged.join(", ") || targets.map((t) => `#${manualOrderShortCode(t.id)}`).join(", ")} đang giữ đơn`, { declined: true, cancelled: false, order_flagged: flagged, step: "RESCUE", instruction: RESCUE_INSTRUCTION }, state);
    }
    case "cancel_order": {
      // KHÁCH HUỶ ĐƠN ĐÃ ĐẶT (chủ shop 10/10/2026): bước 1 giữ đơn · bước 2 (lượt SAU, khách vẫn huỷ) huỷ theo vòng đời vận đơn
      // (`lib/records/order-cancel.ts`). Model chỉ được nói «đã huỷ» khi kết quả có cancelled = true — kết quả đọc từ CSDL sau khi ghi.
      const decision = z.enum(["CANCEL", "KEEP"]).safeParse(input.decision);
      if (!decision.success) return err("Huỷ đơn: sai quyết định", "decision phải là CANCEL hoặc KEEP.", state);
      const words = z.string().trim().min(2).max(300).safeParse(input.customer_words);
      if (!words.success || !quotedInText(words.data, ctx.lastUserText)) return err("Huỷ đơn: chưa có lời khách", "customer_words phải là NGUYÊN VĂN lời khách trong câu CUỐI. Chưa rõ khách muốn huỷ hay giữ ⇒ hỏi lại khách — KHÔNG nói đơn đã huỷ.", state);
      const why = z.string().trim().min(2).max(300).safeParse(input.reason);
      const reason = why.success ? why.data : "Khách huỷ đơn";
      const quote = ctx.lastUserText.trim().slice(0, 300) || null;
      const sameTurn = (r: NonNullable<ChatState["cancelRequest"]>) => ctx.turn !== undefined && r.turn === ctx.turn;
      if (simulated) {
        if (decision.data === "KEEP") {
          delete state.cancelRequest;
          return ok("(Thử) Khách giữ đơn", { cancelled: false, kept: true, simulated: true }, state);
        }
        if (!state.cancelRequest || sameTurn(state.cancelRequest)) {
          state.cancelRequest ??= { orderIds: [], at: now.toISOString(), turn: ctx.turn ?? null, quote, reason };
          return ok("(Thử) Khách muốn huỷ — giữ đơn một lần", { cancelled: false, step: "RESCUE", simulated: true, instruction: RESCUE_INSTRUCTION }, state);
        }
        delete state.cancelRequest;
        state.cancelledOrders = [...(state.cancelledOrders ?? []), { orderId: null, at: now.toISOString(), simulated: true }];
        state.declined = { reason, at: now.toISOString() };
        state.stage = "DECLINED";
        delete state.cart;
        return ok("(Thử) Huỷ đơn — mô phỏng", { cancelled: true, simulated: true, note: "Khung thử: không có đơn thật nào bị huỷ." }, state);
      }
      const targets = await conversationCancelTargets(ctx.conversationId, [state.confirmed?.orderId, state.draft?.orderId]);
      if (!targets.length) return ok("Huỷ đơn: hội thoại không có đơn đang mở", { cancelled: false, no_open_order: true, instruction: "Hội thoại không có đơn đang mở để huỷ — khách không mua nữa thì gọi mark_declined. KHÔNG nói «đã huỷ đơn»." }, state);
      const ids = targets.map((t) => t.id);
      const codes = ids.map((id) => `#${manualOrderShortCode(id)}`);
      const pending = state.cancelRequest && state.cancelRequest.orderIds.some((id) => ids.includes(id)) ? state.cancelRequest : undefined;
      if (decision.data === "KEEP") {
        if (!pending) return ok("Không có yêu cầu huỷ đang chờ", { cancelled: false, kept: true }, state);
        for (const id of pending.orderIds.filter((x) => ids.includes(x))) {
          if (await recordCustomerKeptOrder(ctx.agent, id, quote, now)) markOrderWritten(ctx.writeMark, id);
          await noteCustomerReconfirmAsAgent(ctx.agent, id, quote, now);
        }
        delete state.cancelRequest;
        delete state.declined;
        return ok(`Khách giữ đơn ${codes.join(", ")} — không huỷ`, { cancelled: false, kept: true, order_codes: codes, instruction: "Đơn VẪN GIỮ NGUYÊN, không huỷ. Cảm ơn khách một câu ngắn." }, state);
      }
      // Bước 1 — chưa có lượt giữ đơn (hoặc model gọi lại ngay trong CÙNG lượt để bỏ qua bước giữ) ⇒ ghi yêu cầu, giữ đơn.
      if (!pending || sameTurn(pending)) {
        if (!pending) await openCancelRequest(ctx, state, ids, reason, now);
        return ok(`Khách muốn huỷ ${codes.join(", ")} — giữ đơn một lần`, { cancelled: false, step: "RESCUE", order_codes: codes, instruction: RESCUE_INSTRUCTION }, state);
      }
      // Bước 2 — đã giữ ở lượt trước, khách vẫn huỷ. Nhiều đơn đang mở ⇒ không đoán đơn nào: người xác định.
      if (ids.length > 1) {
        for (const id of ids) await raiseCancelException(id, "AMBIGUOUS_ORDER", `${ids.length} đơn đang mở`, { agent: ctx.agent, actor: { kind: "AI", userId: null, name: ctx.agent.name }, conversationId: ctx.conversationId, quote, reason, rescue: "FAILED", now });
        return { ...ok("Huỷ đơn chưa xong — nhiều đơn đang mở, chuyển nhân viên", { cancelled: false, handed_to_staff: true, reason: CANCEL_BLOCK_LABEL.AMBIGUOUS_ORDER, instruction: CANCEL_NOT_DONE }, state), requireHuman: `Khách huỷ đơn — ${CANCEL_BLOCK_LABEL.AMBIGUOUS_ORDER}` };
      }
      const r = await executeCustomerCancel({ orderId: ids[0], agent: ctx.agent, actorKind: "AI", conversationId: ctx.conversationId, quote, reason: pending.reason || reason, rescue: "FAILED", now });
      if (r.status === "EXCEPTION") {
        return {
          ...ok(`Huỷ đơn #${r.shortCode} chưa xong — chuyển nhân viên`, { cancelled: false, handed_to_staff: true, reason: CANCEL_BLOCK_LABEL[r.code], instruction: CANCEL_NOT_DONE }, state),
          requireHuman: `Khách huỷ đơn #${r.shortCode} — ${CANCEL_BLOCK_LABEL[r.code]}`,
        };
      }
      markOrderWritten(ctx.writeMark, r.orderId);
      delete state.cancelRequest;
      state.declined = { reason: pending.reason || reason, at: now.toISOString() };
      state.stage = "DECLINED";
      if (!state.cancelledOrders?.some((x) => x.orderId === r.orderId)) state.cancelledOrders = [...(state.cancelledOrders ?? []), { orderId: r.orderId, at: now.toISOString(), simulated: false }];
      if (state.draft?.orderId === r.orderId) delete state.draft;
      delete state.cart;
      return ok(`Đã huỷ đơn #${r.shortCode}`, { cancelled: true, order_code: `#${r.shortCode}`, carrier_cancelled: r.carrier ? true : undefined, instruction: "Đơn ĐÃ HUỶ trong hệ thống. Báo khách MỘT câu ngắn: shop đã huỷ đơn theo yêu cầu." }, state);
    }
    case "handoff_to_human": {
      const reason = z.string().trim().min(2).max(300).safeParse(input.reason);
      state.handoff = { reason: reason.success ? reason.data : "Khách cần nhân viên", at: new Date().toISOString() };
      if (!simulated) await notifySalesChatHandoff(ctx.conversationId, state.handoff.reason, state.customer, new Date());
      // Fanpage: nhân viên trả lời trực tiếp trên page ⇒ bot không nói gì thêm (lượt này cũng không được gửi đi).
      if (isMessagingChannel(ctx.channel)) return ok("Chuyển nhân viên", { handed_off: true, simulated, say_to_customer: null, instruction: "KHÔNG viết gì cho khách — nhân viên sẽ trả lời trực tiếp." }, state);
      return ok(`${simulated ? "(Thử) " : ""}Chuyển nhân viên`, { handed_off: true, simulated, say_to_customer: ctx.config.handoff.message }, state);
    }
  }
  return err(`${name}: không có`, `Không có công cụ «${name}».`, state);
}

/**
 * Khách CŨ đang ở bước xác nhận địa chỉ lần trước (khối KHÁCH CŨ của lời nhắc): giỏ đã có món khách nói từ một lượt TRƯỚC, chưa lưu hồ
 * sơ nhận hàng ⇒ lượt này là lượt LÊN ĐƠN, cửa sổ lời mời đóng (#868). Lượt khách VỪA chọn món (câu hỏi xác nhận địa chỉ gộp lời mời —
 * khối KHÁCH CŨ) vẫn mở. HÀM THUẦN.
 */
export function returningPendingOf(returning: ReturningCustomer | null | undefined, state: Pick<ChatState, "customer" | "cart">, turn?: number): boolean {
  const explicit = state.cart?.selectedItems.filter((x) => x.customerExplicit) ?? [];
  return Boolean(returning) && !state.customer && explicit.length > 0 && !explicit.some((x) => turn !== undefined && x.sourceMessageId === turn);
}

/** Câu cuối khách đang hoãn / từ chối — một định nghĩa ở `cart-commitment.ts` (điều kiện (1) của tự chốt P0-A). */
export { customerHesitates };

/**
 * Còn thiếu gì để TỰ CHỐT (P0-A) — `null` = đủ sáu điều kiện: (1) ý định mua (khách đã gửi SĐT + địa chỉ giao — `state.customer` — và câu cuối
 * không hoãn / từ chối), (2) mẫu mã chắc + (6) giá máy chủ đã xác thực (đơn nháp chỉ có khi báo giá verified, `packChoiceMistake` đã qua),
 * (3) số lượng > 0, (4) SĐT hợp lệ, (5) địa chỉ đủ giao (đọc được tỉnh / thành; xã / phường chưa ghép ⇒ vẫn chốt, lõi gắn cờ cần kiểm).
 * Không tự chốt khi: khách đang phản đối giá, đang xin huỷ / đã từ chối, hay vừa nhận lời mời thêm món trong CHÍNH lượt này. HÀM THUẦN.
 */
export function autoConfirmBlocker(state: ChatState, ctx: Pick<ToolContext, "lastUserText" | "turn" | "prevTurn">): string | null {
  const d = state.draft;
  if (!d || !d.lines.length || d.lines.some((l) => l.quantity <= 0)) return "Chưa có món / số lượng — hỏi khách món và số lượng";
  if (!d.quote) return "Chưa có báo giá máy chủ — gọi lại create_draft_order";
  if (!state.customer) return "Chưa có thông tin người mua — xin SĐT + địa chỉ giao";
  if (state.declined || state.cancelRequest) return "Khách đang từ chối / xin huỷ — không tự chốt";
  if (state.priceDispute && (state.priceDispute.open || (ctx.turn !== undefined && state.priceDispute.requotedTurn === ctx.turn))) return "Khách đang phản đối giá — báo lại giá máy chủ, đợi khách đồng ý";
  if (ctx.turn !== undefined && state.upsellTurn === ctx.turn) return "Vừa mời thêm món trong lượt này — đợi khách trả lời rồi chốt";
  // «Không lấy thêm» / «để lần sau» chỉ là TỪ CHỐI LỜI MỜI khi đó là lượt khách NGAY SAU lời mời thêm món (hoặc ngay sau tóm tắt «lấy thêm
  // gì không») VÀ giỏ có món khách đã nói tường minh; câu còn vế hoãn khác («…, để chị bàn với chồng») vẫn là hoãn (review 12/10/2026).
  const justInvited = ctx.prevTurn !== undefined && (state.upsellTurn === ctx.prevTurn || d.shownTurn === ctx.prevTurn);
  const declinedAddOn = justInvited && Boolean(state.cart?.selectedItems.some((x) => x.customerExplicit)) && declinesAddOnOnly(ctx.lastUserText);
  if (!declinedAddOn && customerHesitates(ctx.lastUserText, { justInvited })) return "Khách chưa quyết mua (đang hoãn / cân nhắc) — không tự chốt";
  const gaps = manualOrderGaps({ phone: d.recipient.phone, address: d.recipient.address, province: d.recipient.province || resolveRecipientPlace({ address: d.recipient.address, province: d.recipient.province, ward: "" }).province }, d.lines.length);
  if (gaps.includes("SĐT")) return "SĐT chưa hợp lệ — hỏi lại khách SĐT";
  if (gaps.includes("địa chỉ") || gaps.includes("tỉnh / thành")) return "Địa chỉ chưa đủ để giao (chưa đọc được tỉnh / thành) — hỏi khách đúng phần còn thiếu";
  // Xã / phường chưa ghép (biết tỉnh) KHÔNG chặn tự chốt — luật P0-A: đơn tự chốt kèm cờ ADDRESS_UNRESOLVED, câu ghi nhận
  // ORDER_PENDING_ADDRESS, nhân viên hỏi lại. Tỉnh chỉ suy từ viết tắt («P13 GV») là CHƯA BIẾT TỈNH ⇒ đã dừng ở dòng trên.
  return null;
}

/** Câu chốt ngắn khi máy chủ tự chốt — «Dạ em lên đơn 2 × Chả cá thu (1kg) cho mình rồi ạ, shop giao theo thông tin mình vừa gửi nhé.» */
export function autoConfirmText(lines: readonly { name: string; quantity: number }[]): string {
  return `Dạ em lên đơn ${lines.map((l) => `${l.quantity} × ${l.name}`).join(", ")} cho mình rồi ạ, shop giao theo thông tin mình vừa gửi nhé.`;
}

/** Giai đoạn đơn coi là ĐÃ CHỐT (đã xác nhận trở đi, chưa huỷ) — đọc từ đơn THẬT. */
const CONFIRMED_STAGES = new Set(["CONFIRMED", "PACKING", "READY_TO_SHIP", "SHIPPED", "DELIVERED", "PAID", "RETURNING", "PARTIAL_RETURN", "RETURNED"]);

/**
 * ĐƠN TRONG CSDL THẮNG STATE CŨ (P0-A/B 11/10/2026): đơn nháp của bot đã được XÁC NHẬN ngoài lượt chốt của bot (công tắc «đơn đủ thông tin
 * = đã xác nhận» của lõi, nhân viên bấm, lượt tự chốt hỏng giữa chừng) mà `state.confirmed` còn trống ⇒ dựng `state.confirmed` từ đơn thật
 * (`auto: true` — khách chưa từng bị hỏi «có chốt không», sửa ngay sau đó bot làm được). Không có / chưa xác nhận / lỗi đọc ⇒ `null`.
 */
export async function confirmedFromOrder(state: ChatState, now: Date = new Date()): Promise<ChatState | null> {
  const id = state.draft?.orderId;
  if (state.confirmed || !id || state.draft?.simulated) return null;
  const db = await getDb();
  const o = schema.orders;
  const [row] = await db.select({ stage: o.stage, total: o.totalPriceAfterDiscount, ship: o.shippingFee, at: o.lastUpdateStatusAt }).from(o).where(eq(o.id, id)).limit(1);
  if (!row || !CONFIRMED_STAGES.has(String(row.stage))) return null;
  const v = await confirmedValidity(id);
  return { ...state, confirmed: { orderId: id, simulated: false, total: Number(row.total ?? 0) + Number(row.ship ?? 0), at: (row.at ?? now).toISOString(), auto: true, valid: v.valid, pending: v.pending }, stage: "DONE" };
}

/** Câu dặn model khi huỷ CHƯA xong — một chỗ. */
const CANCEL_NOT_DONE = "ĐƠN CHƯA HUỶ. TUYỆT ĐỐI KHÔNG nói đã huỷ. Nói ngắn: shop đã ghi nhận yêu cầu huỷ, nhân viên sẽ xử lý và báo lại.";

/**
 * Mở lượt GIỮ ĐƠN cho các đơn khách vừa xin huỷ: gắn cờ «khách huỷ» (một đường gắn cờ — `flagOrderForReviewAsAgent`) + ghi yêu cầu
 * huỷ lên `raw.cancellation` + nhớ trong `state.cancelRequest`. Đơn ĐÃ XÁC NHẬN (đang giữ hàng, nhóm vận hành đã nhận tin đơn) ⇒ báo
 * người ngay (review #675, L1) — kho có thể đang đóng gói. Trả mã đơn đã gắn cờ.
 */
async function openCancelRequest(ctx: ToolContext, state: ChatState, ids: readonly string[], reason: string, now: Date): Promise<string[]> {
  const quote = ctx.lastUserText.trim().slice(0, 300) || null;
  const flagged: string[] = [];
  for (const id of ids) {
    const r = await flagOrderForReviewAsAgent(ctx.agent, id, { code: "CUSTOMER_CANCELLED", note: reason, quote }, now);
    const req = await recordCustomerCancelRequest(ctx.agent, id, { quote, reason, conversationId: ctx.conversationId }, now);
    if ((r.ok && r.flagged) || req.changed) markOrderWritten(ctx.writeMark, id);
    if (!r.ok || !r.flagged) continue;
    flagged.push(`#${manualOrderShortCode(id)}`);
    if (r.stage === "CONFIRMED") await notifySalesChatHandoff(ctx.conversationId, `Khách báo huỷ đơn ĐÃ XÁC NHẬN #${manualOrderShortCode(id)}${quote ? ` — «${quote.slice(0, 120)}»` : ""} (bot đang giữ đơn)`, state.customer, now).catch(() => undefined);
  }
  state.cancelRequest = { orderIds: [...ids], at: now.toISOString(), turn: ctx.turn ?? null, quote, reason };
  return flagged;
}

/** Giá đã xác thực cho các mẫu mã công cụ đọc trả ra — chỉ ở chế độ giá lẻ (bảng giá sỉ bật ⇒ `null`, giữ giá theo bảng như cũ). */
async function verifiedViewPrices(items: readonly CatalogItem[], cfg: SalesChatbotConfig, state: ChatState): Promise<Map<string, { price: number | null; reason: string | null }> | null> {
  if (!items.length || cfg.wholesalePricing) return null;
  void state;
  return verifiedUnitPrices(items.map((i) => i.variantId), await loadPricingContext(cfg, null));
}

/** Đơn vừa chốt có QUA KIỂM không — đọc lại dòng đơn SAU lượt ghi (lõi có thể vừa gắn cờ «địa chỉ chưa ghép»). Lỗi đọc ⇒ chưa qua. */
async function confirmedValidity(orderId: string): Promise<{ valid: boolean; pending: "ADDRESS" | "CHECK" | null }> {
  try {
    const db = await getDb();
    const o = schema.orders;
    const [row] = await db.select({ raw: o.raw, phone: o.shipPhone, address: o.shipAddress, province: o.shipProvince, ward: o.shipCommune, itemsCount: o.itemsCount, total: o.totalPriceAfterDiscount, ship: o.shippingFee }).from(o).where(eq(o.id, orderId)).limit(1);
    if (!row) return { valid: false, pending: "CHECK" };
    const v = orderValidityOf({ id: orderId, raw: row.raw, phone: row.phone ?? "", address: row.address ?? "", province: row.province ?? "", ward: row.ward ?? "", itemsCount: Number(row.itemsCount ?? 0), total: Number(row.total ?? 0), shippingFee: Number(row.ship ?? 0) });
    return { valid: v.valid, pending: v.pending };
  } catch {
    return { valid: false, pending: "CHECK" };
  }
}

const ORDER_STATUS_MAX = 3;

/**
 * Chặn đọc đơn ở hội thoại không chắc là của MỘT người. BÌNH LUẬN công khai: hội thoại bình luận của Pancake có thể là của CẢ BÀI (mọi người bình luận chung một mã —
 * `lib/pricing/ai-customer-identity.ts`), nên đơn / đơn đã chốt gắn với nó không chắc là của NGƯỜI đang hỏi ⇒ không đọc đơn ở đó.
 * Lớp 1 là loại tin của LƯỢT (`commentTurn`, engine). Lớp 2 đọc CSDL, và mọi nhánh không chắc rơi về phía ĐÓNG (AGENTS mục 31):
 *  · hội thoại page thiếu page / mã luồng ⇒ đóng;
 *  · `visitor_key` không còn khớp (page, mã luồng) ⇒ mã luồng đã bị đổi sang mã hộp thư sau khi trả lời bình luận
 *    (`markWaitingForCustomer`) — hội thoại gốc là luồng bình luận ⇒ đóng (review độc lập 08/10/2026);
 *  · luồng có tin BÌNH LUẬN ⇒ đóng.
 */
async function orderLookupBlock(conversationId: string): Promise<"COMMENT" | "UNVERIFIED" | null> {
  const db = await getDb();
  const c = schema.salesChatConversations;
  const [conv] = await db.select({ channel: c.channel, pageId: c.pageId, threadId: c.threadId, visitorKey: c.visitorKey }).from(c).where(eq(c.id, conversationId)).limit(1);
  if (!conv || conv.channel !== "FANPAGE") return null;
  // Không xác định được luồng (hội thoại cũ thiếu khoá) hoặc mã luồng đã bị đổi ⇒ KHÔNG CHẮC là ai — đóng, chuyển người.
  if (!conv.pageId || !conv.threadId) return "UNVERIFIED";
  if (conv.visitorKey && conv.visitorKey !== fanpageVisitorKeyMirror(conv.pageId, conv.threadId)) return "UNVERIFIED";
  const t = schema.salesChatInbound;
  const [hit] = await db.select({ id: t.id }).from(t).where(and(eq(t.pageId, conv.pageId), eq(t.threadId, conv.threadId), eq(t.kind, "COMMENT"))).limit(1);
  return hit ? "COMMENT" : null;
}

/** Đơn của CHÍNH khách trong hội thoại + câu trạng thái (thứ tự căn cứ ở `order-status-shared.ts`). Chỉ đọc. */
async function orderStatusFor(conversationId: string, state: ChatState, commentTurn: boolean, ask: { text: string; shopTexts: readonly string[]; now: Date } = { text: "", shopTexts: [], now: new Date() }): Promise<{ summary: string; data: unknown; needsHuman: string | null }> {
  const block = commentTurn ? "COMMENT" : await orderLookupBlock(conversationId);
  if (block === "COMMENT") {
    return { summary: "Tra đơn: bình luận công khai", data: { orders: [], note: "Đây là luồng BÌNH LUẬN công khai — không đọc đơn ở đây. Mời khách nhắn tin riêng cho page để kiểm tra đơn." }, needsHuman: null };
  }
  if (block === "UNVERIFIED") {
    // Hội thoại hộp thư không xác định chắc được người (khoá thiếu / đã đổi) — không bảo khách «nhắn riêng» khi họ đang nhắn riêng.
    return { summary: "Tra đơn: chưa xác định được hội thoại", data: { orders: [], note: "Chưa tra được đơn ở hội thoại này — máy chủ chuyển nhân viên kiểm tra." }, needsHuman: "Khách hỏi đơn nhưng hội thoại chưa xác định chắc người (khoá luồng thiếu / đã đổi) — cần nhân viên tra" };
  }
  const db = await getDb();
  const o = schema.orders;
  const ids = [state.confirmed?.orderId, ...(state.pastOrders ?? []).map((p) => p.orderId)].filter((x): x is string => typeof x === "string" && x.length > 0);
  const scope = [eq(o.salesConversationId, conversationId), ...(ids.length ? [inArray(o.id, ids)] : [])];
  const rows = await db
    .select({ id: o.id, at: o.insertedAt, stage: o.stage, displayId: o.displayId, promisedAt: o.customerPromisedAt })
    .from(o)
    .where(and(or(...scope), ne(o.stage, "DELETED")))
    .orderBy(desc(o.insertedAt), desc(o.id))
    .limit(ORDER_STATUS_MAX);
  if (!rows.length) {
    return {
      summary: "Tra đơn: không thấy",
      data: { orders: [], note: "Không thấy đơn nào gắn với hội thoại này. Nói ngắn rằng nhân viên shop sẽ kiểm tra đơn giúp — KHÔNG xin SĐT để tự tra, KHÔNG gọi lookup_customer / create_customer để tìm đơn, KHÔNG đoán trạng thái." },
      needsHuman: "Khách hỏi đơn đã đặt nhưng hội thoại không gắn đơn nào — cần nhân viên tra",
    };
  }
  const sh = schema.shipments;
  const ships = await db
    .select({ id: sh.id, orderId: sh.orderId, stage: sh.stage, statusName: sh.vtpStatusName, statusCode: sh.vtpStatus, statusAt: sh.vtpStatusDate, vtpOrderNumber: sh.vtpOrderNumber, trackingCode: sh.trackingCode, direction: sh.direction, attemptNo: sh.attemptNo, createdAt: sh.createdAt, syncSource: sh.vtpSyncSource, expectedDelivery: sh.expectedDelivery })
    .from(sh)
    .where(inArray(sh.orderId, rows.map((r) => r.id)));
  const view = rows.map((r) => {
    // Lần gửi ĐẠI DIỆN — cùng luật `PRIMARY_ATTEMPT` của mọi báo cáo, bỏ chiều hoàn (không tự đặt luật chọn vận đơn thứ hai).
    const s = vanDonDaiDien(ships.filter((x) => x.orderId === r.id));
    const carrierEvidence = Boolean(s?.syncSource && (CARRIER_EVENT_SOURCES as readonly string[]).includes(s.syncSource));
    const st = customerOrderStatus({ orderStage: r.stage, manual: isManualOrderId(r.id), shipment: s ? { stage: s.stage, carrierEvidence, statusCode: s.statusCode, statusName: s.statusName } : null });
    return {
      id: r.id,
      stage: r.stage,
      insertedAt: r.at,
      promisedAt: r.promisedAt,
      ship: s ? { stage: s.stage, carrierEvidence, expectedDelivery: s.expectedDelivery } : null,
      row: {
        // Đơn Pancake: mã HIỂN THỊ (khách thấy trên tin xác nhận / POS), không phải id nội bộ dài (review #645, L2).
        order_code: isManualOrderId(r.id) || r.displayId === null ? `#${manualOrderShortCode(r.id)}` : `#${r.displayId}`,
        ordered_at: formatVnDate(r.at),
        status: st.text,
        // Nguyên văn của ĐVVC chỉ đi kèm khi câu ĐÚNG là lời khai của ĐVVC.
        carrier_status: st.carrierSaid ? s?.statusName || null : null,
        carrier_status_at: st.carrierSaid && s?.statusAt ? formatVnDate(s.statusAt) : null,
        tracking_code: s ? s.vtpOrderNumber || s.trackingCode || null : null,
        needs_staff: st.needsStaff !== null,
      },
    };
  });
  const anyStaff = view.some((v) => v.row.needs_staff);
  // HỎI LỊCH GIAO ≠ HỎI TRẠNG THÁI (P0 #855, ca 16/10/2026 «Hôm nào có hàng?» ⇒ AI đọc «Shop đã nhận đơn — chưa có thông tin vận
  // chuyển»). Máy chủ quyết câu trả lời từ dữ kiện thật (`delivery-intent.ts`); không có lịch xác minh ⇒ chuyển nhân viên và KHÔNG
  // đưa câu trạng thái cho model đọc thay giờ giao.
  const question = classifyDeliveryQuestion(ask.text);
  if (question?.intent === "DELIVERY_TIME") {
    // Chỉ đơn của LƯỢT MUA HIỆN TẠI; có đơn nháp đang mở / chỉ có đơn cũ ⇒ không áp (luồng bán hàng / câu trạng thái như cũ).
    const pick = pickDeliveryOrder(view, { confirmedId: state.confirmed?.orderId ?? null, pastIds: (state.pastOrders ?? []).map((p) => p.orderId).filter((x): x is string => typeof x === "string"), now: ask.now, windowDays: LIFECYCLE_ORDER_LOOKBACK_DAYS });
    if (pick.kind === "TARGET") {
      const target = pick.target;
      const answer = deliveryTimeAnswer({
        question,
        customerText: ask.text,
        orderStage: target.stage,
        manual: isManualOrderId(target.id),
        shipment: target.ship,
        promisedAt: target.promisedAt ?? null,
        // ERP chưa đọc phân bổ tồn cho từng đơn ở đây ⇒ CHƯA BIẾT (không phải «đủ hàng»).
        stock: null,
        staffSaid: staffDeliveryCommitment(ask.shopTexts),
        liveOrders: pick.liveOrders,
        now: ask.now,
      });
      if (answer.kind === "DIRECT") {
        return {
          summary: `Hỏi lịch giao: ${answer.basis}`,
          data: {
            orders: view.map((v) => v.row),
            delivery_answer: { kind: "DIRECT", order_code: target.row.order_code, say: answer.text },
            note: "Khách hỏi LỊCH GIAO: nói ĐÚNG câu «delivery_answer.say» (không thêm mốc giờ nào khác, không đọc «status» thay câu ấy). KHÔNG báo giá, KHÔNG hỏi lại địa chỉ / SĐT, KHÔNG mời mua thêm.",
          },
          needsHuman: null,
        };
      }
      if (answer.kind === "HANDOFF") {
        return {
          summary: "Hỏi lịch giao: chưa có lịch xác minh — chuyển nhân viên",
          data: {
            orders: view.map((v) => ({ order_code: v.row.order_code, ordered_at: v.row.ordered_at, tracking_code: v.row.tracking_code })),
            delivery_answer: { kind: "HANDOFF", say_to_customer: answer.text },
            note: "Khách hỏi LỊCH GIAO mà ERP chưa có lịch giao xác minh — máy chủ đã chuyển nhân viên xác nhận giờ giao. KHÔNG đọc trạng thái đơn thay giờ giao, KHÔNG hứa hôm nay / ngày mai, KHÔNG báo giá / hỏi địa chỉ / mời mua thêm.",
          },
          needsHuman: answer.reason,
        };
      }
    }
  }
  return {
    summary: `Tra đơn: ${view.length}`,
    data: {
      orders: view.map((v) => v.row),
      note: `Tối đa ${ORDER_STATUS_MAX} đơn gần nhất của hội thoại. Nói ĐÚNG «status» — không hứa ngày giao / giao lại, không suy «đã giao» khi chưa thấy chữ đó, không nêu số tiền.${anyStaff ? " Đơn có needs_staff = true: nói đúng «status» rồi HỎI khách có cần nhân viên shop hỗ trợ đơn này không — khách cần ⇒ handoff_to_human (lý do: tra đơn + mã đơn). Không tự hứa nhân viên sẽ gọi." : ""}`,
    },
    needsHuman: null,
  };
}

const formatVnDate = (d: Date) => new Intl.DateTimeFormat("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", day: "2-digit", month: "2-digit", year: "numeric" }).format(d);

/** Tổng tiền đơn đã chốt / nháp để màn hình in (không gọi lại công cụ). */
export function orderTotalsOf(state: ChatState): number | null {
  if (state.confirmed) return state.confirmed.total;
  if (!state.draft) return null;
  // Đơn nháp mang báo giá máy chủ ⇒ tiền hàng SAU giảm theo khối lượng (bản cũ cộng đơn giá × SL, bỏ mất phần giảm).
  if (state.draft.quote) return state.draft.quote.subtotal;
  const t = manualOrderTotals(
    state.draft.lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity, unitPrice: state.draft!.unitPrices[l.variantId] ?? 0, discount: 0 })),
    0,
    0,
  );
  return t.ok ? t.totals.totalPriceAfterDiscount : null;
}
