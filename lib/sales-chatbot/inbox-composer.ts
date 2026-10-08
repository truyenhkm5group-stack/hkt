/**
 * ═══════════ CÔNG CỤ Ô SOẠN CỦA HỘP THƯ: CÂU MẪU · SẢN PHẨM (Master Mission P0.2 «Unified Inbox») — CHỈ MÁY CHỦ ═══════════
 *
 * Nhân viên trả lời khách trong hộp thư (/ai/sales-chatbot/inbox) chèn được câu trả lời mẫu và một dòng sản phẩm vào Ô SOẠN thay
 * vì gõ tay. Tệp này CHỈ ĐỌC — không gửi, không ghi dòng nào: chữ vào ô soạn để người SỬA rồi bấm «Gửi» có sẵn (đường gửi duy
 * nhất vẫn là `sendStaffReplyCore`, cùng quyền, cùng khung gửi của kênh, cùng khoá chống gửi đôi).
 *
 *  · QUYỀN = đúng cổng của «Gửi» (`sendStaffReplyCore`): `ai_sales:view` + (`ai_sales:reply` hoặc `outreach:send`); module AI
 *    bán hàng tắt ⇒ từ chối. Mọi câu đọc chạy trên CSDL của tổ chức PHIÊN (`getDb()`) — không nhận mã tổ chức từ trình duyệt.
 *  · CÂU MẪU: chỉ câu ĐANG BẬT (`listQuickReplies` của màn quản lý câu mẫu). Lọc bỏ dấu bằng `foldVi` — cùng hàm gấp chữ của bot.
 *    Chỗ trống {{giá:SKU}} · {{tồn:SKU}} · {{ship}} điền LÚC BẤM bằng đúng hàm bot dùng khi gửi câu mẫu (`renderQuickAnswer`) với
 *    cấu hình của page của hội thoại (`loadSalesChatbotConfigFor` — page có thể đè phí ship). Thiếu một số ⇒ KHÔNG chèn: bot cũng
 *    không gửi câu mẫu thiếu số, và nhân viên không được nhận một câu có «{{giá:…}}» trần để lỡ tay gửi cho khách.
 *  · ẢNH CỦA CÂU MẪU KHÔNG ĐI KÈM — chỉ chữ. Đường gửi của nhân viên nhận tệp từ máy người bấm, nhưng gắn hộ ảnh câu mẫu vào đó
 *    KHÔNG an toàn: câu mẫu tới 6 ảnh × 3 MB trong khi một tin tối đa 4 ảnh và thân server action trần 8 MB (next.config.ts) ⇒
 *    lượt gửi vỡ ở tầng khung; chat web không nhận ảnh; Zalo chỉ JPG / PNG ≤ 1 MB. Màn hình nói rõ số ảnh và việc ảnh không đi kèm.
 *  · SẢN PHẨM: cùng danh mục + phép tìm của bot (`sellableCatalog` + `searchCatalog` — công cụ `search_products`), nên giá là MỘT
 *    nguồn: giá lẻ `retail_price` đọc lúc bấm, in bằng `formatVND` như bot; 0 / thiếu ⇒ dòng chèn KHÔNG có giá (không đoán).
 *    Mẫu mã đã gỡ / đang ẩn không ra. Tồn: chỉ «còn hàng» / «hết hàng» khi `stockFor` đọc được (đã có phiếu nhập) VÀ shop KHÔNG
 *    bật bán không kiểm tồn (`sellWithoutStockCheck` — bot cũng không nói còn / hết khi bật); còn lại không nói gì về tồn
 *    (CHƯA BIẾT không được in thành 0 hay «còn» — luật 42). Tồn khả dụng ÂM = sổ kho đang sai ⇒ cũng không nói.
 */
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { can, type SessionUser } from "@/lib/auth/session";
import { formatVND } from "@/lib/format";
import { canUseModule } from "@/lib/platform/capabilities";
import { searchCatalog, sellableCatalog, stockFor, type CatalogItem, type StockInfo } from "@/lib/sales-chatbot/catalog";
import { loadSalesChatbotConfigFor } from "@/lib/sales-chatbot/engine";
import type { InboxResult } from "@/lib/sales-chatbot/inbox";
import { listQuickReplies, renderQuickAnswer } from "@/lib/sales-chatbot/quick-replies";
import { parsePlaceholders } from "@/lib/sales-chatbot/quick-replies-shared";
import { foldVi } from "@/lib/sales-chatbot/text";

export const COMPOSER_LIMITS = {
  /** Số mẫu mã tối đa một lượt tìm trả về (bot lấy 8 đầu của CÙNG thứ tự). */
  productResults: 20,
  /** Từ khoá tìm tối đa — cùng trần với công cụ `search_products` của bot. */
  queryChars: 200,
  /** Đoạn đầu câu trả lời hiện trong danh sách câu mẫu. */
  previewChars: 140,
} as const;

/** Chữ về tồn được phép CHÈN cho khách — hai giá trị, không có giá trị thứ ba (không đọc được thì im lặng). */
export const COMPOSER_STOCK_SAY = { IN_STOCK: "còn hàng", OUT_OF_STOCK: "hết hàng" } as const;
export type ComposerStockSay = (typeof COMPOSER_STOCK_SAY)[keyof typeof COMPOSER_STOCK_SAY];

/**
 * Tồn của một mẫu mã theo mắt NHÂN VIÊN (luật 42 — ba trạng thái in ba cách): `IN_STOCK` / `OUT_OF_STOCK` = đọc được, có chữ chèn;
 * `UNKNOWN` = chưa có phiếu nhập / không đọc được (in «—»); `NEGATIVE` = khả dụng âm, sổ kho sai (in «—»); `NOT_CHECKED` = shop bán
 * không kiểm tồn — KHÔNG ÁP DỤNG (in «N/A»). Ba trạng thái sau không chèn chữ nào về tồn.
 */
export type ComposerStockState = "IN_STOCK" | "OUT_OF_STOCK" | "UNKNOWN" | "NEGATIVE" | "NOT_CHECKED";

/** Một câu mẫu trong danh sách của ô soạn — đủ để NHẬN RA câu, không phải chữ sẽ chèn (chữ chèn đọc lúc bấm). */
export type ComposerQuickReply = {
  id: string;
  title: string;
  /** Đoạn đầu câu trả lời, nguyên văn (chỗ trống còn dạng {{…}}). */
  preview: string;
  /** Số ảnh của câu mẫu — ảnh KHÔNG đi kèm khi chèn. */
  imageCount: number;
  /** Có chỗ trống {{giá}} / {{tồn}} / {{ship}} — điền bằng số ERP lúc bấm. */
  needsErp: boolean;
};

/** Một mẫu mã cho ô soạn. `line` là ĐÚNG dòng sẽ chèn. */
export type ComposerProduct = {
  variantId: string;
  name: string;
  variant: string;
  sku: string;
  /** Giá lẻ hiện tại (`retail_price`); `null` = ERP chưa có giá ⇒ dòng chèn không có giá. */
  price: number | null;
  /** Chữ giá đúng như bot in (`formatVND`); `null` khi chưa có giá. */
  priceText: string | null;
  stockState: ComposerStockState;
  /** Chữ về tồn được chèn; `null` = không nói gì về tồn. */
  stockSay: ComposerStockSay | null;
  /** Vì sao không nói tồn — cho NHÂN VIÊN đọc, không chèn; `null` khi đã nói. */
  stockNote: string | null;
  line: string;
};

const VIEW = "ai_sales:view";
const NO_VIEW = "Bạn không có quyền xem hội thoại (ai_sales:view).";
const NO_REPLY = "Bạn không có quyền trả lời khách (ai_sales:reply).";
const MODULE_OFF = "Module AI bán hàng chưa bật.";
const NO_CONVERSATION = "Không có hội thoại này.";

/**
 * Cổng của mọi công cụ ô soạn = cổng của «Gửi». Vị từ trả lời khách CHÉP từ `canReplyTo` (lib/sales-chatbot/inbox.ts — hàm nội bộ,
 * không export); `tests/inbox-composer.test.ts` so cổng này với `sendStaffReplyCore` trên một ma trận quyền để hai nơi không trôi.
 */
async function gate(user: SessionUser): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!(await canUseModule("ai_sales"))) return { ok: false, error: MODULE_OFF };
  if (!can(user, VIEW)) return { ok: false, error: NO_VIEW };
  if (!(can(user, "ai_sales:reply") || can(user, "outreach:send"))) return { ok: false, error: NO_REPLY };
  return { ok: true };
}

/** Hội thoại của hộp thư (không phải khung thử) trong CSDL của tổ chức phiên — chỉ để biết page ⇒ cấu hình bot của page đó. */
async function conversationPage(conversationId: unknown): Promise<{ pageId: string | null } | null> {
  if (typeof conversationId !== "string") return null;
  const db = await getDb();
  const c = schema.salesChatConversations;
  const [row] = await db.select({ pageId: c.pageId, channel: c.channel }).from(c).where(eq(c.id, conversationId)).limit(1);
  return row && row.channel !== "TEST" ? { pageId: row.pageId } : null;
}

function parseQuery(raw: unknown, required: boolean): { ok: true; query: string } | { ok: false; error: string } {
  const query = typeof raw === "string" ? raw.trim() : "";
  if (required && !query) return { ok: false, error: "Gõ tên sản phẩm cần tìm (không dấu cũng được)." };
  if (query.length > COMPOSER_LIMITS.queryChars) return { ok: false, error: `Từ khoá tối đa ${COMPOSER_LIMITS.queryChars} ký tự.` };
  return { ok: true, query };
}

/**
 * Lọc câu mẫu theo chữ nhân viên gõ — HÀM THUẦN. Bỏ dấu bằng `foldVi`; MỌI từ của câu gõ phải có mặt (một phần chữ cũng được — đang
 * gõ dở «bao qu» vẫn ra «Bảo quản») trong tên + câu khách hay hỏi + câu trả lời. Câu khớp ngay ở TÊN đứng trước; còn lại giữ thứ tự
 * gốc (dùng nhiều trước). Không gõ gì ⇒ nguyên danh sách.
 */
export function matchComposerQuickReplies<T extends { title: string; triggers: readonly string[]; answer: string }>(rows: readonly T[], query: string): T[] {
  const words = foldVi(query).split(" ").filter(Boolean);
  if (words.length === 0) return [...rows];
  const hits: { row: T; i: number; rank: number }[] = [];
  rows.forEach((row, i) => {
    const title = foldVi(row.title);
    const hay = `${title} ${foldVi(row.triggers.join(" "))} ${foldVi(row.answer)}`;
    if (!words.every((w) => hay.includes(w))) return;
    hits.push({ row, i, rank: words.every((w) => title.includes(w)) ? 0 : 1 });
  });
  return hits.sort((a, b) => a.rank - b.rank || a.i - b.i).map((h) => h.row);
}

function previewOf(answer: string): string {
  const flat = answer.replace(/\s+/g, " ").trim();
  const chars = Array.from(flat);
  return chars.length > COMPOSER_LIMITS.previewChars ? `${chars.slice(0, COMPOSER_LIMITS.previewChars).join("").trimEnd()}…` : flat;
}

/**
 * Tồn của một mẫu mã ⇒ chữ được chèn cho khách — HÀM THUẦN. Shop bán không kiểm tồn ⇒ không nói (bot cũng không). Chưa có phiếu
 * nhập / không đọc được ⇒ CHƯA BIẾT ⇒ không nói. Khả dụng ÂM = sổ kho sai (bot chuyển người) ⇒ không nói. > 0 ⇒ «còn hàng»; = 0 ⇒
 * «hết hàng».
 */
export function composerStockOf(info: StockInfo | undefined, sellWithoutStockCheck: boolean): { state: ComposerStockState; say: ComposerStockSay | null; note: string | null } {
  if (sellWithoutStockCheck) return { state: "NOT_CHECKED", say: null, note: "Shop bán không cần kiểm tồn — không nói còn / hết hàng." };
  if (!info) return { state: "UNKNOWN", say: null, note: "Chưa đọc được tồn — không nói còn / hết hàng." };
  if (!info.stockKnown || info.available === null) return { state: "UNKNOWN", say: null, note: "Chưa xác nhận được tồn (mẫu mã chưa có phiếu nhập) — không nói còn / hết hàng." };
  if (info.available < 0) return { state: "NEGATIVE", say: null, note: "Tồn khả dụng đang ÂM — sổ kho cần kiểm, chưa nói tồn với khách." };
  return info.available > 0 ? { state: "IN_STOCK", say: COMPOSER_STOCK_SAY.IN_STOCK, note: null } : { state: "OUT_OF_STOCK", say: COMPOSER_STOCK_SAY.OUT_OF_STOCK, note: null };
}

/** Dòng chèn — HÀM THUẦN: «Tên · quy cách — giá · tồn». Thiếu giá / không nói tồn ⇒ bỏ đúng vế đó, không thay bằng chữ đoán. */
export function composerProductLine(item: Pick<CatalogItem, "name" | "variant" | "price">, stockSay: ComposerStockSay | null): string {
  const head = item.variant ? `${item.name} · ${item.variant}` : item.name;
  const tail = [item.price !== null ? formatVND(item.price) : null, stockSay].filter((x): x is string => Boolean(x));
  return tail.length ? `${head} — ${tail.join(" · ")}` : head;
}

function productView(item: CatalogItem, stock: StockInfo | undefined, sellWithoutStockCheck: boolean): ComposerProduct {
  const s = composerStockOf(stock, sellWithoutStockCheck);
  return {
    variantId: item.variantId,
    name: item.name,
    variant: item.variant,
    sku: item.sku,
    price: item.price,
    priceText: item.price !== null ? formatVND(item.price) : null,
    stockState: s.state,
    stockSay: s.say,
    stockNote: s.note,
    line: composerProductLine(item, s.say),
  };
}

/** Câu mẫu ĐANG BẬT của tổ chức phiên, lọc theo chữ gõ (bỏ dấu). `total` = số câu đang bật trước khi lọc. */
export async function composerQuickReplies(user: SessionUser, rawQuery: unknown = ""): Promise<InboxResult<{ items: ComposerQuickReply[]; total: number }>> {
  const g = await gate(user);
  if (!g.ok) return g;
  const q = parseQuery(rawQuery, false);
  if (!q.ok) return q;
  const active = (await listQuickReplies()).filter((r) => r.active);
  const items = matchComposerQuickReplies(active, q.query).map((r) => ({ id: r.id, title: r.title, preview: previewOf(r.answer), imageCount: r.images.length, needsErp: parsePlaceholders(r.answer).length > 0 }));
  return { ok: true, items, total: active.length };
}

/**
 * Chữ của MỘT câu mẫu để chèn vào ô soạn của MỘT hội thoại — số ERP điền lúc bấm, bằng đúng hàm + cấu hình bot dùng cho hội thoại
 * đó. Câu đã tắt / đã xoá / thuộc tổ chức khác ⇒ không có; thiếu số ⇒ không chèn.
 */
export async function composerQuickReplyText(user: SessionUser, conversationId: unknown, quickReplyId: unknown): Promise<InboxResult<{ text: string; title: string; imageCount: number }>> {
  const g = await gate(user);
  if (!g.ok) return g;
  const conv = await conversationPage(conversationId);
  if (!conv) return { ok: false, error: NO_CONVERSATION };
  const entry = (await listQuickReplies()).find((r) => r.id === quickReplyId && r.active);
  if (!entry) return { ok: false, error: "Câu mẫu này không còn bật — mở lại danh sách câu mẫu." };
  const text = await renderQuickAnswer(entry.answer, await loadSalesChatbotConfigFor(conv.pageId));
  if (text === null) return { ok: false, error: "Câu mẫu cần số đọc từ ERP (giá / tồn / phí ship) mà ERP chưa có — không chèn để khỏi báo sai cho khách. Gõ tay, hoặc sửa câu mẫu." };
  return { ok: true, text, title: entry.title, imageCount: entry.images.length };
}

/**
 * Tìm mẫu mã ĐANG BÁN bằng đúng danh mục + phép tìm của bot (`search_products`), với cấu hình bot của page của hội thoại.
 * `priceNote` ≠ `null` khi shop bật báo giá sỉ: giá ở đây là giá LẺ niêm yết, bậc sỉ / giá riêng của khách không áp.
 */
export async function composerProductSearch(user: SessionUser, conversationId: unknown, rawQuery: unknown): Promise<InboxResult<{ items: ComposerProduct[]; priceNote: string | null }>> {
  const g = await gate(user);
  if (!g.ok) return g;
  const q = parseQuery(rawQuery, true);
  if (!q.ok) return q;
  const conv = await conversationPage(conversationId);
  if (!conv) return { ok: false, error: NO_CONVERSATION };
  const cfg = await loadSalesChatbotConfigFor(conv.pageId);
  const found = searchCatalog(await sellableCatalog(cfg.productFields), q.query, COMPOSER_LIMITS.productResults);
  const stock = await stockFor(found.map((f) => f.variantId));
  return {
    ok: true,
    items: found.map((it) => productView(it, stock.get(it.variantId), cfg.sellWithoutStockCheck)),
    priceNote: cfg.wholesalePricing ? "Giá LẺ niêm yết — bậc giá sỉ / giá riêng của khách không áp ở đây." : null,
  };
}

/** MỘT mẫu mã lúc bấm chèn: đọc lại giá + tồn ngay lúc đó (không dùng số của lượt tìm). Đã gỡ / ẩn từ lúc tìm ⇒ không chèn. */
export async function composerProductPick(user: SessionUser, conversationId: unknown, variantId: unknown): Promise<InboxResult<{ product: ComposerProduct }>> {
  const g = await gate(user);
  if (!g.ok) return g;
  const conv = await conversationPage(conversationId);
  if (!conv) return { ok: false, error: NO_CONVERSATION };
  const item = (await sellableCatalog([])).find((c) => c.variantId === variantId);
  if (!item) return { ok: false, error: "Mẫu mã này không còn bán (đã gỡ hoặc đang ẩn) — tìm lại." };
  const cfg = await loadSalesChatbotConfigFor(conv.pageId);
  const stock = (await stockFor([item.variantId])).get(item.variantId);
  return { ok: true, product: productView(item, stock, cfg.sellWithoutStockCheck) };
}
