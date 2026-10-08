/**
 * ═══════════ CÔNG CỤ Ô SOẠN CỦA HỘP THƯ: CÂU MẪU · SẢN PHẨM (Master Mission P0.2 «Unified Inbox») — CHỈ MÁY CHỦ ═══════════
 *
 * Nhân viên trả lời khách trong hộp thư (/ai/sales-chatbot/inbox) chèn được câu trả lời mẫu và một dòng sản phẩm vào Ô SOẠN thay
 * vì gõ tay. Tệp này CHỈ ĐỌC — không gửi, không ghi dòng nào: chữ vào ô soạn để người SỬA rồi bấm «Gửi» có sẵn (đường gửi duy
 * nhất vẫn là `sendStaffReplyCore`, cùng quyền, cùng khung gửi của kênh, cùng khoá chống gửi đôi).
 *
 *  · QUYỀN = ĐÚNG cổng của «Gửi»: mọi hàm ở đây gọi `replyGate` (lib/sales-chatbot/inbox.ts) — một hàm, không phải bản chép (review
 *    PR #661: bản chép của vị từ trả lời trôi khỏi bản gốc mà bài kiểm vẫn xanh). Tệp này KHÔNG tự gọi `can(`. Module AI bán hàng
 *    tắt ⇒ cổng module của `can()` từ chối, như mọi action hộp thư khác. Mọi câu đọc chạy trên CSDL của tổ chức PHIÊN.
 *  · CÂU MẪU: chỉ câu ĐANG BẬT (`listQuickReplies` của màn quản lý câu mẫu). Lọc bỏ dấu bằng `foldVi` — cùng hàm gấp chữ của bot.
 *    Chỗ trống {{giá:SKU}} · {{tồn:SKU}} · {{ship}} điền LÚC BẤM bằng đúng hàm bot dùng khi gửi câu mẫu (`renderQuickAnswer`) với
 *    cấu hình của page của hội thoại (`loadSalesChatbotConfigFor` — page có thể đè phí ship). Thiếu một số (kể cả tồn ÂM) ⇒ KHÔNG
 *    chèn: nhân viên không được nhận một câu có «{{giá:…}}» trần hay «Còn -2 hộp» để lỡ tay gửi cho khách. Shop bán không kiểm tồn
 *    ⇒ câu có {{tồn}} cũng không chèn (ô soạn không nói số tồn khi chính shop đã chọn không nói còn / hết).
 *  · ẢNH CỦA CÂU MẪU KHÔNG ĐI KÈM — chỉ chữ. Gắn hộ ảnh câu mẫu vào đường gửi của nhân viên KHÔNG an toàn: câu mẫu tới 6 ảnh × 3 MB
 *    trong khi một tin tối đa 4 ảnh và thân server action trần 8 MB (next.config.ts); chat web không nhận ảnh; Zalo chỉ JPG / PNG
 *    ≤ 1 MB. Màn hình nói rõ số ảnh và việc ảnh không đi kèm.
 *  · SẢN PHẨM: cùng danh mục + phép tìm của bot (`sellableCatalog` + `searchCatalog` — công cụ `search_products`), nên giá là MỘT
 *    nguồn: giá lẻ `retail_price`, in bằng `formatVND` như bot; 0 / thiếu ⇒ dòng chèn KHÔNG có giá (không đoán). Shop bật giá sỉ ⇒
 *    dòng chèn ghi «(giá lẻ)» ngay cạnh giá. Lượt TÌM không đọc tồn; lúc BẤM đọc lại đích danh mẫu mã đó (giá + tồn). Tồn: chỉ
 *    «còn hàng» / «hết hàng» khi `stockFor` đọc được (đã có phiếu nhập) VÀ shop KHÔNG bật bán không kiểm tồn; còn lại không nói gì
 *    về tồn (CHƯA BIẾT không được in thành 0 hay «còn» — luật 42). Tồn khả dụng ÂM = sổ kho đang sai ⇒ cũng không nói.
 */
import type { SessionUser } from "@/lib/auth/session";
import { formatVND } from "@/lib/format";
import { searchCatalog, sellableCatalog, stockFor, type CatalogItem, type StockInfo } from "@/lib/sales-chatbot/catalog";
import { loadSalesChatbotConfigFor } from "@/lib/sales-chatbot/engine";
import { replyGate, type InboxResult } from "@/lib/sales-chatbot/inbox";
import { COMPOSER_QUERY } from "@/lib/sales-chatbot/inbox-composer-shared";
import { listQuickReplies, renderQuickAnswer } from "@/lib/sales-chatbot/quick-replies";
import { parsePlaceholders } from "@/lib/sales-chatbot/quick-replies-shared";
import { foldVi } from "@/lib/sales-chatbot/text";

export const COMPOSER_LIMITS = {
  /** Số mẫu mã tối đa một lượt tìm trả về (bot lấy 8 đầu của CÙNG thứ tự). */
  productResults: 20,
  /** Đoạn đầu câu trả lời hiện trong danh sách câu mẫu. */
  previewChars: 140,
} as const;

/** Chữ về tồn được phép CHÈN cho khách — hai giá trị, không có giá trị thứ ba (không đọc được thì im lặng). */
export const COMPOSER_STOCK_SAY = { IN_STOCK: "còn hàng", OUT_OF_STOCK: "hết hàng" } as const;
export type ComposerStockSay = (typeof COMPOSER_STOCK_SAY)[keyof typeof COMPOSER_STOCK_SAY];

/**
 * Tồn của một mẫu mã theo mắt NHÂN VIÊN (luật 42 — ba trạng thái in ba cách): `IN_STOCK` / `OUT_OF_STOCK` = đọc được, có chữ chèn;
 * `UNKNOWN` = chưa có phiếu nhập / không đọc được; `NEGATIVE` = khả dụng âm, sổ kho sai; `NOT_CHECKED` = shop bán không kiểm tồn —
 * KHÔNG ÁP DỤNG. Ba trạng thái sau không chèn chữ nào về tồn.
 */
export type ComposerStockState = "IN_STOCK" | "OUT_OF_STOCK" | "UNKNOWN" | "NEGATIVE" | "NOT_CHECKED";

/** Ghi cạnh giá khi shop bật báo giá sỉ — giá ở ô soạn là giá LẺ niêm yết, bậc sỉ / giá riêng của khách không áp. */
export const COMPOSER_RETAIL_MARK = "(giá lẻ)";

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

/** Một mẫu mã trong kết quả TÌM — chưa đọc tồn (tồn chỉ đọc lúc bấm). `line` = dòng sẽ chèn, chưa có vế tồn. */
export type ComposerProductHit = {
  variantId: string;
  name: string;
  variant: string;
  sku: string;
  /** Giá lẻ hiện tại (`retail_price`); `null` = ERP chưa có giá ⇒ dòng chèn không có giá. */
  price: number | null;
  /** Chữ giá đúng như bot in (`formatVND`); `null` khi chưa có giá. */
  priceText: string | null;
  line: string;
};

/** Một mẫu mã lúc BẤM chèn: giá + tồn đọc lại ngay lúc đó. `line` là ĐÚNG dòng sẽ chèn. */
export type ComposerProduct = ComposerProductHit & {
  stockState: ComposerStockState;
  /** Chữ về tồn được chèn; `null` = không nói gì về tồn. */
  stockSay: ComposerStockSay | null;
  /** Vì sao không nói tồn — cho NHÂN VIÊN đọc, không chèn; `null` khi đã nói. */
  stockNote: string | null;
};

function parseQuery(raw: unknown, min: number): { ok: true; query: string } | { ok: false; error: string } {
  const query = typeof raw === "string" ? raw.trim() : "";
  if (query.length < min) return { ok: false, error: `Gõ ít nhất ${min} ký tự tên sản phẩm (không dấu cũng được).` };
  if (query.length > COMPOSER_QUERY.max) return { ok: false, error: `Từ khoá tối đa ${COMPOSER_QUERY.max} ký tự.` };
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

/**
 * Dòng chèn — HÀM THUẦN: «Tên · quy cách — giá · tồn». Thiếu giá / không nói tồn ⇒ bỏ đúng vế đó, không thay bằng chữ đoán. Shop bật
 * giá sỉ (`retailOnly`) ⇒ «(giá lẻ)» đứng NGAY cạnh giá: dòng đã rời bảng thì chân bảng không còn đi theo nó.
 */
export function composerProductLine(item: Pick<CatalogItem, "name" | "variant" | "price">, stockSay: ComposerStockSay | null, retailOnly = false): string {
  const head = item.variant ? `${item.name} · ${item.variant}` : item.name;
  const price = item.price !== null ? `${formatVND(item.price)}${retailOnly ? ` ${COMPOSER_RETAIL_MARK}` : ""}` : null;
  const tail = [price, stockSay].filter((x): x is string => Boolean(x));
  return tail.length ? `${head} — ${tail.join(" · ")}` : head;
}

function hitOf(item: CatalogItem, retailOnly: boolean): ComposerProductHit {
  return {
    variantId: item.variantId,
    name: item.name,
    variant: item.variant,
    sku: item.sku,
    price: item.price,
    priceText: item.price !== null ? formatVND(item.price) : null,
    line: composerProductLine(item, null, retailOnly),
  };
}

/** Câu mẫu ĐANG BẬT của tổ chức phiên, lọc theo chữ gõ (bỏ dấu). `total` = số câu đang bật trước khi lọc. */
export async function composerQuickReplies(user: SessionUser, conversationId: unknown, rawQuery: unknown = ""): Promise<InboxResult<{ items: ComposerQuickReply[]; total: number }>> {
  const g = await replyGate(user, conversationId);
  if (!g.ok) return g;
  const query = typeof rawQuery === "string" ? rawQuery.trim() : "";
  if (query.length > COMPOSER_QUERY.max) return { ok: false, error: `Từ khoá tối đa ${COMPOSER_QUERY.max} ký tự.` };
  const active = (await listQuickReplies()).filter((r) => r.active);
  const items = matchComposerQuickReplies(active, query).map((r) => ({ id: r.id, title: r.title, preview: previewOf(r.answer), imageCount: r.images.length, needsErp: parsePlaceholders(r.answer).length > 0 }));
  return { ok: true, items, total: active.length };
}

/**
 * Chữ của MỘT câu mẫu để chèn vào ô soạn của MỘT hội thoại — số ERP điền lúc bấm, bằng đúng hàm + cấu hình bot dùng cho hội thoại
 * đó. Câu đã tắt / đã xoá / thuộc tổ chức khác ⇒ không có; thiếu số (kể cả tồn âm) ⇒ không chèn; shop bán không kiểm tồn mà câu
 * có {{tồn}} ⇒ không chèn.
 */
export async function composerQuickReplyText(user: SessionUser, conversationId: unknown, quickReplyId: unknown): Promise<InboxResult<{ text: string; title: string; imageCount: number }>> {
  const g = await replyGate(user, conversationId);
  if (!g.ok) return g;
  const entry = (await listQuickReplies()).find((r) => r.id === quickReplyId && r.active);
  if (!entry) return { ok: false, error: "Câu mẫu này không còn bật — mở lại danh sách câu mẫu." };
  const cfg = await loadSalesChatbotConfigFor(g.conv.pageId);
  if (cfg.sellWithoutStockCheck && parsePlaceholders(entry.answer).some((h) => h.kind === "stock")) {
    return { ok: false, error: "Shop bán không cần kiểm tồn — câu mẫu có chỗ trống {{tồn}} không chèn (không nói số tồn với khách). Gõ tay, hoặc sửa câu mẫu." };
  }
  const text = await renderQuickAnswer(entry.answer, cfg);
  if (text === null) return { ok: false, error: "Câu mẫu cần số đọc từ ERP (giá / tồn / phí ship) mà ERP chưa có — không chèn để khỏi báo sai cho khách. Gõ tay, hoặc sửa câu mẫu." };
  return { ok: true, text, title: entry.title, imageCount: entry.images.length };
}

/**
 * Tìm mẫu mã ĐANG BÁN bằng đúng danh mục + phép tìm của bot (`search_products`), với cấu hình bot của page của hội thoại. KHÔNG đọc
 * tồn (đọc lúc bấm). `priceNote` ≠ `null` khi shop bật báo giá sỉ.
 */
export async function composerProductSearch(user: SessionUser, conversationId: unknown, rawQuery: unknown): Promise<InboxResult<{ items: ComposerProductHit[]; priceNote: string | null }>> {
  const g = await replyGate(user, conversationId);
  if (!g.ok) return g;
  const q = parseQuery(rawQuery, COMPOSER_QUERY.productMin);
  if (!q.ok) return q;
  const cfg = await loadSalesChatbotConfigFor(g.conv.pageId);
  const found = searchCatalog(await sellableCatalog(cfg.productFields), q.query, COMPOSER_LIMITS.productResults);
  return {
    ok: true,
    items: found.map((it) => hitOf(it, cfg.wholesalePricing)),
    priceNote: cfg.wholesalePricing ? "Giá LẺ niêm yết — bậc giá sỉ / giá riêng của khách không áp ở đây." : null,
  };
}

/**
 * MỘT mẫu mã lúc bấm chèn: đọc ĐÍCH DANH mẫu mã đó (cùng luật «đang bán» + cách đọc giá của danh mục bot) và tồn của nó ngay lúc
 * đó — không dùng số của lượt tìm. Đã gỡ / ẩn từ lúc tìm ⇒ không chèn.
 */
export async function composerProductPick(user: SessionUser, conversationId: unknown, variantId: unknown): Promise<InboxResult<{ product: ComposerProduct }>> {
  const g = await replyGate(user, conversationId);
  if (!g.ok) return g;
  const [item] = typeof variantId === "string" ? await sellableCatalog([], [variantId]) : [];
  if (!item) return { ok: false, error: "Mẫu mã này không còn bán (đã gỡ hoặc đang ẩn) — tìm lại." };
  const cfg = await loadSalesChatbotConfigFor(g.conv.pageId);
  const s = composerStockOf((await stockFor([item.variantId])).get(item.variantId), cfg.sellWithoutStockCheck);
  return { ok: true, product: { ...hitOf(item, cfg.wholesalePricing), stockState: s.state, stockSay: s.say, stockNote: s.note, line: composerProductLine(item, s.say, cfg.wholesalePricing) } };
}
