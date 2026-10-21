/**
 * ═══════════ CUSTOMER 360 — HỒ SƠ KHÁCH CÓ CẤU TRÚC CHO AI BÁN HÀNG (11/10/2026) — CHỈ MÁY CHỦ ═══════════
 *
 * Chủ shop 11/10/2026, ca «Nga Ho Thien» (HSLC, hội thoại 45c36073…): khách mua từ 03/2025, nhắn «Cho 0.5 kh nhé» + «Vẫn địa chỉ
 * cũ» ⇒ bot giải thích đúng chính sách 0,5kg nhưng rồi «chị cho em xin địa chỉ nhận hàng». Khung khách ERP: «Chưa có SĐT · Chưa
 * biết khách là ai». Bốn chỗ hở trong mã trước bản này (đọc mã — số đo production là việc của ops `customer-360-probe`):
 *
 *  1. Bot chỉ nhận ra khách cũ qua SĐT (`returning.ts::findReturningCustomer`: hồ sơ đang nhắn → mã Facebook → SĐT). Mã Facebook
 *     không dùng được ở HSLC (inbox-avatar-audit 10/10: 323/323 hồ sơ khách `fb_id` rỗng). Không ai nối HỘI THOẠI với ĐƠN của
 *     chính hội thoại đó, dù đơn đồng bộ từ Pancake mang sẵn `orders.conversation_id` (= mã hội thoại Pancake = `thread_id`).
 *  2. `recent_orders` Pancake gửi kèm phản hồi tin của hội thoại (lịch sử mua THẬT của khách, kể cả khi ERP chưa có đơn nào) không
 *     được đọc ở bất cứ đâu.
 *  3. Không có luật «khách nói địa chỉ cũ ⇒ TRA trước khi hỏi»: tra được thì lời nhắc có địa chỉ, tra không được thì bot xin lại
 *     từ đầu — và khối khách cũ còn khẳng định «khách CHƯA từng mua hàng của shop» chỉ vì ERP không thấy đơn (CHƯA BIẾT in ra
 *     thành KHÔNG — AGENTS.md mục 8.5).
 *  4. Khung khách của hộp thư không đọc SĐT Pancake đã ghi nhận (`state.returning.phones`) ⇒ «Chưa có SĐT» cả khi bot có SĐT.
 *
 * Mô-đun này dựng MỘT hồ sơ có cấu trúc, theo tổ chức NGỮ CẢNH (`getDb()` — CSDL riêng của tổ chức), chỉ từ dữ kiện gắn với
 * HỘI THOẠI NÀY:
 *  · NỐI KHÁCH (mạnh → yếu): `THREAD` = đơn của chính hội thoại (`orders.sales_conversation_id`, hoặc đơn Pancake mang
 *    `conversation_id` = mã hội thoại, hoặc `recent_orders` của Pancake cho hội thoại này) · `FB_ID` = hồ sơ khớp mã Facebook ·
 *    `PHONE` = SĐT xuất hiện trong hội thoại (khách gõ / Pancake ghi nhận / đơn Pancake của hội thoại) ⇒ khách / đơn ERP.
 *    `PHONE` = ai cũng gõ được SĐT người khác ⇒ bot chỉ thấy địa chỉ ĐÃ CHE (cùng luật `returning.ts`, review bảo mật 08/10).
 *  · SĐT trùng nhiều người (≥ 2 hồ sơ / người nhận) VÀ ≥ 2 địa chỉ khác nhau ⇒ `AMBIGUOUS`: không chọn, không liệt kê.
 *  · ĐỊA CHỈ ĐÃ XÁC MINH (`addressConfidence`): đơn GIAO THÀNH CÔNG theo `ORDER_OUTCOME` (chỉ đơn ERP — trạng thái Pancake không
 *    bao giờ là bằng chứng giao, AGENTS.md 3.2) ⇒ `DELIVERED`; đơn đã qua bước xác nhận, không huỷ / hoàn, có tỉnh + xã chuẩn hoá
 *    (ô xã của đơn, hoặc `normalizeVnAddress` ra MỘT đáp án) ⇒ `CONFIRMED_NORMALIZED`. Đơn hoàn / huỷ / nháp, địa chỉ chưa ghép
 *    được ⇒ KHÔNG BAO GIỜ là địa chỉ đề xuất.
 *  · KHÁCH CŨ HAY MỚI: `REPEAT` khi có đơn trước lượt mua này; `NEW` CHỈ khi đã hỏi Pancake và Pancake nói không có đơn nào; còn
 *    lại `UNKNOWN` — không bao giờ suy «khách mới» từ chỗ ERP vắng đơn.
 *
 * Mọi đề xuất chỉ là GỢI Ý (AGENTS.md 3.12): lời nhắc bảo bot hỏi khách xác nhận; địa chỉ chỉ vào đơn qua `create_customer`
 * + `use_saved_address` SAU khi khách đồng ý (máy chủ kiểm nguyên văn lời đồng ý — `tools.ts`). Lời nhắc chỉ nhận một khối tóm tắt
 * khi CẦN (khách nói dùng lại thông tin cũ, hoặc đơn đang mở đã thanh toán) — không nạp lịch sử chat.
 *
 * TIỀN theo đúng chiều `payment` của vòng đời dùng chung (`lifecycle.ts`, #801): «đã thanh toán» CHỈ khi chứng từ thu
 * `order_payments` CONFIRMED của đơn tạo tay phủ đủ số phải thu (`manualPaymentStatus` = PAID). Trả trước / chuyển khoản KHAI trên
 * đơn (`prepaid` · `transfer_money`, Pancake hay POS) KHÔNG phải tiền thật ⇒ không bao giờ làm `paid = true` (AGENTS 8.4).
 */
import { and, asc, desc, eq, gte, inArray, isNull, lt, ne, or, sql, type SQL } from "drizzle-orm";
import { getDb, schema, type Db } from "@/db";
import { foldVnText, fullAddressLine, normalizeVnAddress } from "@/lib/address/vn-address";
import { manualOrderAmountDue, manualPaymentStatus, sumConfirmedPayments } from "@/lib/constants/order-payments";
import { OUTCOME_GROUP } from "@/lib/constants/truth";
import type { OrderOutcome } from "@/lib/constants/returns";
import { formatDate } from "@/lib/format";
import { ORDER_OUTCOME, PRIMARY_ATTEMPT } from "@/lib/queries/return-rate";
import { normalizeVnPhone, promptDataText, vouchedOrder, type PancakeRecentOrder, type ReturningCustomer } from "@/lib/sales-chatbot/returning";
import { phonesInText } from "@/lib/sales-chatbot/known-contact";
import { maskAddress, type ChatState } from "@/lib/sales-chatbot/tools";
import { hasStreetDetail } from "@/lib/address/customer-address";
import type { ReuseIntent } from "@/lib/sales-chatbot/address-memory";

// ═══════════════════════════ KIỂU ═══════════════════════════

/** Cách một đơn được nối về người đang nhắn — mạnh → yếu. */
export type C360Link = "THREAD" | "FB_ID" | "PHONE";
const LINK_RANK: Record<C360Link, number> = { THREAD: 0, FB_ID: 1, PHONE: 2 };

/** Mức tin của một địa chỉ cũ — chỉ hai mức được đề xuất; mọi thứ còn lại không phải địa chỉ đã xác minh. */
export type AddressConfidence = "DELIVERED" | "CONFIRMED_NORMALIZED";
export const ADDRESS_CONFIDENCE_LABEL: Record<AddressConfidence, string> = { DELIVERED: "đã giao thành công", CONFIRMED_NORMALIZED: "đơn đã xác nhận, địa chỉ đã chuẩn hoá" };

/** Một đơn của khách (ERP hoặc Pancake) — dữ kiện thô cho phần thuần. `at = null` = nguồn không cho mốc. */
export type OrderFact = {
  orderId: string;
  source: "ERP" | "PANCAKE";
  at: string | null;
  stage: string;
  /** `ORDER_OUTCOME` — chỉ đơn ERP có; đơn Pancake luôn `null`. */
  outcome: OrderOutcome | null;
  link: C360Link;
  customerId: string | null;
  name: string;
  phone: string;
  address: string;
  province: string;
  ward: string;
  items: string[];
  /** Chứng từ thu CONFIRMED phủ đủ số phải thu (đơn tạo tay `erp-`). Đơn Pancake / số trả trước khai trên đơn ⇒ `false`. */
  paid: boolean;
  /** Đơn của LƯỢT MUA đang diễn ra (đơn nháp / đơn vừa chốt, hoặc tạo sau mốc `before`) — không phải «lần trước». */
  currentCycle: boolean;
};

export type AddressCandidate = { address: string; province: string; ward: string; phone: string; name: string; confidence: AddressConfidence; orderId: string; at: string | null; link: C360Link; customerId: string | null };

/** Kết quả nối khách: mức mạnh nhất có đơn, `NONE` = không đơn nào, `AMBIGUOUS` = SĐT trùng nhiều người. */
export type C360Match = C360Link | "NONE" | "AMBIGUOUS";
export type C360Suggestion = "ONE" | "MANY" | "NONE" | "AMBIGUOUS";
export type C360Buyer = "REPEAT" | "NEW" | "UNKNOWN";

export type Customer360 = {
  conversationId: string;
  identity: {
    /** Hội thoại có mã page + mã hội thoại (nối được đơn Pancake của chính hội thoại). */
    threadBound: boolean;
    /** Hồ sơ Pancake của hội thoại: chưa đọc · đọc rồi nhưng không biết đơn (bản cũ / Pancake không gửi khoá) · đọc và biết đơn. */
    pancake: "MISSING" | "NO_ORDERS_KEY" | "ORDERS_KNOWN";
    fbIds: number;
    phones: { phone: string; source: "THREAD" | "PANCAKE" | "ORDER" }[];
    erpCustomerIds: string[];
    match: C360Match;
  };
  buyer: C360Buyer;
  /** Đếm trên các đơn TRƯỚC lượt này của mức nối mạnh nhất. `null` = không đơn nào để đếm (khác 0). */
  history: { orders: number; delivered: number; returned: number; cancelled: number; open: number } | null;
  lastOrder: { orderId: string; at: string | null; stage: string; outcome: OrderOutcome | null; link: C360Link; source: "ERP" | "PANCAKE" } | null;
  /** Địa chỉ cũ ĐÃ XÁC MINH, mới nhất trước, đã gộp trùng, tối đa `C360_LIMITS.addresses`. */
  addresses: AddressCandidate[];
  suggestion: C360Suggestion;
  /** Mức nối mạnh nhất là `PHONE` ⇒ mọi địa chỉ đọc cho bot / khách phải che. */
  masked: boolean;
  /** Lý do không có địa chỉ đề xuất (cho lời nhắc + phép đo) — `null` khi có. */
  noAddressReason: "NO_LINK" | "ONLY_UNVERIFIED" | "AMBIGUOUS" | null;
  previousPhones: string[];
  topProducts: { name: string; count: number }[];
  /** `optedOut`: khách đã từ chối mua / thôi nhận tin (`mark_declined`); `null` = chưa có sổ đồng ý riêng ⇒ CHƯA BIẾT. */
  consent: { optedOut: boolean | null };
  currentOrder: { orderId: string | null; paid: boolean; hasContact: boolean } | null;
  /** Lượt mua này ĐÃ có SĐT + địa chỉ nhận (`state.customer`) — khách nói «như cũ» lần nữa thì không hỏi xác nhận lại. */
  contactKnown: boolean;
  /**
   * SĐT của các đơn nối CHẮC với hội thoại (mức THREAD — kể cả đơn nhân viên lên «nối khoá bot» và đơn Pancake mang mã luồng — và FB_ID),
   * MỌI lượt mua. Mức PHONE KHÔNG BAO GIỜ vào đây (ai cũng gõ được SĐT người khác). Đầu vào của `knownPhoneOf` (known-contact.ts).
   */
  certainPhones: { phone: string; link: "THREAD" | "FB_ID" }[];
};

export const C360_LIMITS = { orders: 20, addresses: 3, products: 3, phones: 5 } as const;

// ═══════════════════════════ PHẦN THUẦN ═══════════════════════════

const DEAD_STAGES = new Set(["RETURNING", "PARTIAL_RETURN", "RETURNED", "CANCELLED", "DELETED"]);
const UNCONFIRMED_STAGES = new Set(["NEW", "WAITING"]);
const RETURN_STAGES = new Set(["RETURNING", "PARTIAL_RETURN", "RETURNED"]);

/**
 * Địa chỉ của MỘT đơn có phải địa chỉ ĐÃ XÁC MINH không. LUẬT (khai cho bài kiểm):
 *  · Đơn ERP giao thành công theo `ORDER_OUTCOME` ⇒ `DELIVERED`.
 *  · Đơn hoàn / huỷ (nhóm kết quả RETURNED · CANCELLED, hoặc khâu hoàn / huỷ) ⇒ `null` — hàng chưa từng tới tay khách ở địa chỉ đó,
 *    nên địa chỉ ấy KHÔNG BAO GIỜ được đề xuất «như đơn trước».
 *  · Đơn chưa qua bước xác nhận (NEW · WAITING) ⇒ `null`.
 *  · Còn lại: có tỉnh + xã chuẩn hoá (ô xã + ô tỉnh của đơn, hoặc dòng địa chỉ đọc ra MỘT đáp án) ⇒ `CONFIRMED_NORMALIZED`.
 *  · Dòng địa chỉ không có số nhà / ngõ / đường / thôn / tổ thật (chỉ tên vùng — «Khương Đình») ⇒ `null` (#855).
 *  · Không thì `null`. Trạng thái Pancake không bao giờ nâng lên `DELIVERED`. HÀM THUẦN.
 */
export function addressConfidence(f: Pick<OrderFact, "source" | "stage" | "outcome" | "address" | "province" | "ward">): AddressConfidence | null {
  if (!f.address.trim()) return null;
  // Dòng địa chỉ chỉ là tên vùng / phường («Khương Đình») KHÔNG phải địa chỉ đầy đủ để giao lại, dù ô xã + tỉnh của đơn có điền (#855,
  // ca «ThuyNgo»): «địa chỉ cũ» chỉ được dùng khi có số nhà / ngõ / đường / thôn / tổ thật.
  if (!hasStreetDetail(f.address)) return null;
  const group = f.outcome ? OUTCOME_GROUP[f.outcome] : null;
  if (group === "RETURNED" || group === "CANCELLED" || DEAD_STAGES.has(f.stage)) return null;
  if (f.source === "ERP" && f.outcome === "DELIVERED") return "DELIVERED";
  if (UNCONFIRMED_STAGES.has(f.stage)) return null;
  if (f.ward.trim() && f.province.trim()) return "CONFIRMED_NORMALIZED";
  return normalizeVnAddress([f.address, f.ward, f.province].filter((x) => x.trim()).join(", ")).status === "MATCHED" ? "CONFIRMED_NORMALIZED" : null;
}

const addressKey = (a: Pick<AddressCandidate, "address" | "ward" | "province">) => foldVnText(fullAddressLine(a.address, a.ward, a.province));
// Đuôi 4 số — cùng cách khối KHÁCH CŨ (`returning.ts`) đọc SĐT, để hai khối không nói hai đuôi khác nhau cho cùng một số.
const tail4 = (phone: string) => phone.replace(/\D/g, "").slice(-4);
const itemName = (s: string) => s.replace(/\s*×\s*\d+\s*$/, "").trim();

export type AssembleInput = {
  conversationId: string;
  state: ChatState;
  threadBound: boolean;
  facts: readonly OrderFact[];
  /** Hồ sơ khách ERP khớp qua SĐT của hội thoại (kể cả hồ sơ chưa có đơn). */
  phoneCustomerIds: readonly string[];
};

/** Dữ kiện ⇒ hồ sơ 360. HÀM THUẦN — mọi luật nằm ở đây để kiểm không cần CSDL. */
export function assembleCustomer360(input: AssembleInput): Customer360 {
  const { state } = input;
  const profile = state.returning;
  const prior = input.facts.filter((f) => !f.currentCycle && (f.at !== null || f.source === "ERP"));
  const bestRank = prior.length ? Math.min(...prior.map((f) => LINK_RANK[f.link])) : null;
  // THREAD + FB_ID cùng là «chính người đang nhắn» ⇒ dùng chung; chỉ khi không có hai mức đó mới xuống PHONE.
  const usable = bestRank === null ? [] : prior.filter((f) => (bestRank <= LINK_RANK.FB_ID ? LINK_RANK[f.link] <= LINK_RANK.FB_ID : f.link === "PHONE"));
  const bestLink: C360Link | null = bestRank === null ? null : bestRank === 0 ? "THREAD" : bestRank === 1 ? "FB_ID" : "PHONE";

  const byAt = (a: { at: string | null }, b: { at: string | null }) => (b.at ?? "").localeCompare(a.at ?? "");
  const eligible: AddressCandidate[] = [];
  const seen = new Set<string>();
  for (const f of [...usable].sort(byAt)) {
    const confidence = addressConfidence(f);
    if (!confidence) continue;
    const cand: AddressCandidate = { address: f.address.trim(), province: f.province.trim(), ward: f.ward.trim(), phone: f.phone.trim(), name: f.name.trim(), confidence, orderId: f.orderId, at: f.at, link: f.link, customerId: f.customerId };
    const key = `${addressKey(cand)}|${cand.phone.replace(/\D/g, "")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    eligible.push(cand);
  }
  // SĐT trùng nhiều NGƯỜI (hồ sơ khác nhau, hoặc đơn không gắn hồ sơ mang tên người nhận khác nhau) VÀ địa chỉ khác nhau ⇒ không
  // biết ai là người đang nhắn: không chọn, không liệt kê (liệt kê là đọc địa chỉ người khác cho người lạ).
  const persons = new Set(eligible.map((c) => (c.customerId ? `id:${c.customerId}` : `ten:${foldVnText(c.name)}`)));
  const places = new Set(eligible.map((c) => addressKey(c)));
  const ambiguous = bestLink === "PHONE" && persons.size >= 2 && places.size >= 2;
  const addresses = ambiguous ? [] : eligible.slice(0, C360_LIMITS.addresses);
  const suggestion: C360Suggestion = ambiguous ? "AMBIGUOUS" : addresses.length === 1 ? "ONE" : addresses.length > 1 ? "MANY" : "NONE";

  const phones: Customer360["identity"]["phones"] = [];
  const addPhone = (raw: string, source: "THREAD" | "PANCAKE" | "ORDER") => {
    const p = normalizeVnPhone(raw);
    if (p && !phones.some((x) => x.phone === p)) phones.push({ phone: p, source });
  };
  if (state.customer?.phone && state.customer.savedAddress !== true) addPhone(state.customer.phone, "THREAD");
  for (const p of profile?.phones ?? []) addPhone(p, "PANCAKE");
  for (const o of profile?.recentOrders ?? []) addPhone(o.phone, "ORDER");

  const pancake: Customer360["identity"]["pancake"] = !profile ? "MISSING" : profile.recentOrders === undefined ? "NO_ORDERS_KEY" : "ORDERS_KNOWN";
  const buyer: C360Buyer = ambiguous ? "UNKNOWN" : usable.length > 0 ? "REPEAT" : pancake === "ORDERS_KNOWN" && input.threadBound ? "NEW" : "UNKNOWN";

  const history = usable.length
    ? {
        orders: usable.length,
        delivered: usable.filter((f) => f.outcome === "DELIVERED").length,
        // Đơn Pancake không có ORDER_OUTCOME ⇒ khâu hoàn của Pancake chỉ dùng để KHÔNG đếm nó là «đang mở» / «đã mua» — không bao
        // giờ để kết luận giao thành công.
        returned: usable.filter((f) => (f.outcome ? OUTCOME_GROUP[f.outcome] === "RETURNED" : RETURN_STAGES.has(f.stage))).length,
        cancelled: usable.filter((f) => (f.outcome && OUTCOME_GROUP[f.outcome] === "CANCELLED") || f.stage === "CANCELLED").length,
        open: 0,
      }
    : null;
  if (history) history.open = history.orders - history.delivered - history.returned - history.cancelled;
  const last = [...usable].sort(byAt)[0] ?? null;
  const current = state.customer?.phone ? normalizeVnPhone(state.customer.phone) : null;
  const previousPhones = [...new Set(usable.map((f) => normalizeVnPhone(f.phone)).filter((p): p is string => Boolean(p) && p !== current))].slice(0, C360_LIMITS.phones);
  const counts = new Map<string, number>();
  for (const f of usable) for (const it of f.items) counts.set(itemName(it), (counts.get(itemName(it)) ?? 0) + 1);
  const topProducts = [...counts.entries()]
    .filter(([n]) => n)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, C360_LIMITS.products)
    .map(([name, count]) => ({ name, count }));

  const openId = state.confirmed?.orderId ?? state.draft?.orderId ?? null;
  const currentFacts = input.facts.filter((f) => f.currentCycle);
  const currentOrder =
    state.confirmed || state.draft
      ? { orderId: openId, paid: currentFacts.some((f) => f.paid && (openId === null || f.orderId === openId)), hasContact: Boolean(state.customer?.phone && state.customer.address) }
      : null;

  return {
    conversationId: input.conversationId,
    identity: {
      threadBound: input.threadBound,
      pancake,
      fbIds: profile?.fbIds.length ?? 0,
      phones,
      erpCustomerIds: [...new Set([...input.phoneCustomerIds, ...usable.map((f) => f.customerId).filter((x): x is string => Boolean(x))])],
      match: ambiguous ? "AMBIGUOUS" : (bestLink ?? "NONE"),
    },
    buyer,
    history,
    lastOrder: last ? { orderId: last.orderId, at: last.at, stage: last.stage, outcome: last.outcome, link: last.link, source: last.source } : null,
    addresses,
    suggestion,
    masked: bestLink === "PHONE",
    noAddressReason: addresses.length ? null : ambiguous ? "AMBIGUOUS" : usable.length ? "ONLY_UNVERIFIED" : "NO_LINK",
    previousPhones,
    topProducts,
    consent: { optedOut: state.declined ? true : null },
    currentOrder,
    contactKnown: Boolean(state.customer?.phone && state.customer.address),
    certainPhones: certainPhonesOf(input.facts),
  };
}

/** SĐT của đơn mức THREAD / FB_ID (đã chuẩn hoá, gộp trùng). HÀM THUẦN. */
export function certainPhonesOf(facts: readonly Pick<OrderFact, "phone" | "link">[]): { phone: string; link: "THREAD" | "FB_ID" }[] {
  const out: { phone: string; link: "THREAD" | "FB_ID" }[] = [];
  for (const f of facts) {
    if (f.link === "PHONE") continue;
    const p = normalizeVnPhone(f.phone);
    if (p && !out.some((x) => x.phone === p)) out.push({ phone: p, link: f.link });
  }
  return out;
}

// ─────────────── Ý ĐỊNH «DÙNG LẠI THÔNG TIN CŨ» ───────────────

// Luật đọc ý định sống ở `address-memory.ts` (hàng rào chữ gửi khách dùng CHÍNH nó — #855); re-export để nơi gọi cũ giữ nguyên.
export { NO_REUSE_INTENT, reuseIntentOf, type ReuseIntent, type ReuseSignal } from "@/lib/sales-chatbot/address-memory";

// ─────────────── LỜI NHẮC ───────────────

const ADDR_MAX = 140;
/** Địa chỉ đọc cho bot: mức PHONE ⇒ ĐÃ CHE (`maskAddress`); còn lại ⇒ dòng đầy đủ có trần. HÀM THUẦN. */
export function candidateText(c: AddressCandidate, masked: boolean): string {
  const full = fullAddressLine(c.address, c.ward, c.province);
  return masked ? maskAddress(full) || "…" : promptDataText(full, ADDR_MAX);
}

const ORDER_FIRST =
  "Thứ tự trong CÙNG MỘT tin: trả lời đúng điều khách hỏi về món / số lượng trước (mẫu mã chỉ bán kèm ⇒ nói chính sách + phương án hợp lệ; mời thêm món KHÔNG thay nhu cầu chính), rồi mới tới địa chỉ.";

/**
 * Khối «TRA LỊCH SỬ» của lời nhắc — `""` khi không cần (khách không nói gì về địa chỉ / SĐT cũ và đơn đang mở chưa thanh toán):
 * lời nhắc của mọi hội thoại khác giữ nguyên từng chữ. HÀM THUẦN.
 */
export function customer360Prompt(c: Customer360 | null, intent: ReuseIntent): string {
  const lines: string[] = [];
  if (c?.currentOrder?.paid && c.currentOrder.hasContact) {
    lines.push("ĐƠN ĐANG MỞ của khách ĐÃ THANH TOÁN và đã có SĐT + địa chỉ nhận: KHÔNG hỏi lại họ tên / SĐT / địa chỉ / thanh toán. Khách hỏi về đơn ⇒ get_order_status.");
  }
  const knownPhone = c?.identity.phones[0]?.phone ?? null;
  if (intent.address === "NEW") {
    // #855 (ca «ThuyNgo»): khách nói «địa chỉ cũ» rồi gửi một địa chỉ giao MỚI — địa chỉ mới thắng, không lặng lẽ để bản cũ thắng.
    lines.push(`TRA LỊCH SỬ (máy chủ): sau lời «địa chỉ cũ», khách VỪA GỬI MỘT ĐỊA CHỈ GIAO MỚI trong tin — địa chỉ mới THẮNG địa chỉ cũ / đơn nháp. Ghi đúng NGUYÊN VĂN địa chỉ khách vừa gửi (đơn nháp có ⇒ update_draft_order với address = địa chỉ mới; chưa có ⇒ create_customer), KHÔNG dùng / nhắc lại địa chỉ cũ, KHÔNG hỏi lại địa chỉ, KHÔNG tự thêm phường / tỉnh. Đơn đang giữ địa chỉ khác thì nói «em cập nhật địa chỉ mới cho mình» chỉ SAU khi công cụ ghi thành công.${knownPhone && intent.phone !== "DECLINE" ? ` SĐT khách đã có trong hội thoại (đuôi ${tail4(knownPhone)}) — không xin lại.` : ""}`);
  } else if (intent.address === "DECLINE") {
    lines.push(`TRA LỊCH SỬ (máy chủ): khách KHÔNG dùng lại địa chỉ cũ ⇒ xin địa chỉ MỚI, KHÔNG nhắc lại địa chỉ cũ.${intent.phone === "DECLINE" ? " Khách cũng đổi SĐT ⇒ xin SĐT mới." : knownPhone ? ` SĐT khách đã có trong hội thoại (đuôi ${tail4(knownPhone)}) — không xin lại.` : ""}`);
  } else if (intent.address === "REUSE" && c?.contactKnown) {
    // Thông tin nhận hàng của lượt này đã lưu (khách đã xác nhận / đã khai) — tin «như cũ» còn trong 3 tin gần nhất không được làm
    // bot hỏi xác nhận lần nữa: không thêm gì, khối KHÁCH CŨ đã dặn «KHÔNG xin lại».
  } else if (intent.address === "REUSE") {
    const said = intent.phone === "REUSE" ? "dùng lại địa chỉ + SĐT cũ" : "dùng lại địa chỉ cũ";
    // Khách đổi SĐT: địa chỉ cũ vẫn dùng được khi nối bằng ĐƠN của chính hội thoại; nối bằng SĐT thì đổi số là mất căn cứ.
    const newPhone =
      intent.phone === "DECLINE"
        ? c?.masked
          ? " Khách ĐỔI SĐT: địa chỉ cũ ĐÃ CHE nối theo SĐT cũ nên không dùng được — xin SĐT mới + địa chỉ đầy đủ."
          : " Khách ĐỔI SĐT: giữ địa chỉ cũ, dùng SĐT MỚI khách gửi — create_customer với use_saved_address = true + phone = SĐT mới (chưa có số mới thì xin số mới)."
        : "";
    if (!c) {
      lines.push(`TRA LỊCH SỬ (máy chủ): khách muốn ${said} nhưng máy chủ CHƯA tra được lịch sử lúc này. Nói ngắn «em kiểm tra lại thông tin lần trước của mình nhé», KHÔNG khẳng định khách chưa từng mua; cần lên đơn ngay thì chỉ xin phần còn thiếu.`);
    } else if (c.suggestion === "AMBIGUOUS") {
      lines.push(`TRA LỊCH SỬ (máy chủ): khách muốn ${said}, nhưng SĐT trong hội thoại khớp NHIỀU người nhận khác nhau — máy chủ KHÔNG chọn hộ và KHÔNG đọc địa chỉ nào ra. Nói «số này em thấy có nhiều địa chỉ trên hệ thống ạ» rồi nhờ khách gửi lại địa chỉ nhận lần này. ${ORDER_FIRST}`);
    } else if (c.suggestion === "ONE") {
      const a = c.addresses[0];
      const text = candidateText(a, c.masked);
      const tail = tail4(a.phone) || "…";
      lines.push(
        `TRA LỊCH SỬ (máy chủ) — khách muốn ${said}. Shop CÓ đúng MỘT địa chỉ cũ (${ADDRESS_CONFIDENCE_LABEL[a.confidence]})${c.masked ? " ĐÃ CHE — bạn không biết số nhà, không đoán" : ""}: «${text}» · SĐT đuôi ${tail}. KHÔNG xin lại địa chỉ / SĐT. Hỏi xác nhận MỘT câu, vd «Dạ em gửi về ${text}, SĐT đuôi ${tail} như đơn trước được không ạ?». Đây CHỈ là GỢI Ý: khách đồng ý ⇒ create_customer với use_saved_address = true + customer_confirmation = nguyên văn lời đồng ý (máy chủ tự điền đầy đủ); khách đổi ⇒ xin địa chỉ mới.${newPhone} ${ORDER_FIRST}`,
      );
    } else if (c.suggestion === "MANY") {
      lines.push(`TRA LỊCH SỬ (máy chủ) — khách muốn ${said}. Shop có ${c.addresses.length} địa chỉ cũ đã xác minh${c.masked ? " (ĐÃ CHE)" : ""}:`);
      c.addresses.forEach((a, i) => lines.push(`  ${i + 1}) «${candidateText(a, c.masked)}» · SĐT đuôi ${tail4(a.phone) || "…"} · ${ADDRESS_CONFIDENCE_LABEL[a.confidence]}${a.at ? ` · ${formatDate(a.at)}` : ""}`));
      lines.push(`KHÔNG xin lại từ đầu: hỏi khách chọn địa chỉ số mấy (hoặc gửi địa chỉ khác). Khách chọn ⇒ create_customer với use_saved_address = true + saved_address_choice = số khách chọn + customer_confirmation = nguyên văn lời chọn.${newPhone} ${ORDER_FIRST}`);
    } else {
      const reason = c.noAddressReason === "ONLY_UNVERIFIED" ? "đơn cũ không có địa chỉ đã xác minh — đơn hoàn / huỷ / chưa xác nhận / địa chỉ chưa chuẩn hoá thì không dùng" : "chưa nối được hội thoại này với đơn cũ nào";
      const missing =
        knownPhone && intent.phone !== "DECLINE" ? `địa chỉ nhận (SĐT khách đã có trong hội thoại, đuôi ${tail4(knownPhone)} — chỉ hỏi «vẫn số đuôi ${tail4(knownPhone)} phải không ạ?», không xin số mới)` : "địa chỉ nhận + SĐT";
      lines.push(`TRA LỊCH SỬ (máy chủ) — khách muốn ${said}: shop CHƯA tìm thấy địa chỉ cũ dùng được (${reason}). Nói thật ngắn «em chưa tìm thấy địa chỉ cũ của mình trên hệ thống ạ» rồi CHỈ xin ${missing} — MỘT LẦN DUY NHẤT. KHÔNG suy ra địa chỉ từ một tên vùng / phường khách hay hồ sơ nhắc tới, KHÔNG tự thêm số nhà / đường / phường / tỉnh. Đã xin rồi mà khách vẫn nói «địa chỉ cũ» / «khách cũ mà hỏi gì» / phàn nàn ⇒ handoff_to_human (lý do: khách muốn dùng địa chỉ cũ, không có địa chỉ đã xác minh), KHÔNG xin lại lần hai. KHÔNG nói như thể khách chưa từng mua. ${ORDER_FIRST}`);
    }
  } else if (intent.phone === "REUSE") {
    const phone = c?.suggestion === "ONE" ? c.addresses[0].phone : knownPhone;
    lines.push(
      phone
        ? `TRA LỊCH SỬ (máy chủ): khách muốn dùng lại SĐT cũ — shop có SĐT đuôi ${tail4(phone)}: KHÔNG xin số mới, chỉ hỏi «vẫn số đuôi ${tail4(phone)} phải không ạ?» khi cần lên đơn.`
        : "TRA LỊCH SỬ (máy chủ): khách muốn dùng lại SĐT cũ nhưng shop CHƯA tìm thấy SĐT nào của khách — nói «em chưa thấy số cũ của mình trên hệ thống ạ» rồi xin SĐT.",
    );
  } else if (intent.phone === "DECLINE") {
    lines.push("TRA LỊCH SỬ (máy chủ): khách ĐỔI SĐT ⇒ xin SĐT mới; KHÔNG xin lại địa chỉ / thông tin khác đã có.");
  }
  return lines.join("\n");
}

// ─────────────── CẦU NỐI SANG `ReturningCustomer` (công cụ `create_customer`) ───────────────

function returningOf(c: Customer360, a: AddressCandidate): ReturningCustomer {
  return {
    // Đơn của chính hội thoại = thông tin khách đã để lại cho CHÍNH hội thoại này (mức THREAD của returning.ts: không che, không
    // phải «đã xác minh danh tính» cho bảng giá riêng). PHONE giữ nguyên che + `savedAddress`.
    trust: a.link === "PHONE" ? "PHONE" : a.link === "FB_ID" ? "FB_ID" : "THREAD",
    customerId: a.customerId,
    name: a.name,
    phone: a.phone,
    address: fullAddressLine(a.address, a.ward, ""),
    province: a.province,
    // «Đã mua N đơn»: chỉ đơn KHÔNG huỷ / hoàn (đơn hoàn chưa từng tới tay khách).
    orders: c.history ? c.history.orders - c.history.returned - c.history.cancelled : null,
    lastOrderAt: c.lastOrder?.at ?? null,
    lastItems: c.topProducts.map((p) => p.name),
    repeat: c.buyer === "REPEAT",
    // Địa chỉ dựng từ ĐƠN CŨ ⇒ khối KHÁCH CŨ chỉ được GỢI Ý, ghi vào đơn qua use_saved_address + lời xác nhận (AGENTS 3.12).
    fromHistory: true,
  };
}

/** Đúng MỘT địa chỉ đề xuất ⇒ khách cũ cho `create_customer` + `use_saved_address`; còn lại `null`. HÀM THUẦN. */
export function returningFrom360(c: Customer360 | null): ReturningCustomer | null {
  return c && c.suggestion === "ONE" ? returningOf(c, c.addresses[0]) : null;
}

/** Khách chọn địa chỉ số `n` (1-based) trong danh sách đã đọc cho bot ⇒ khách cũ tương ứng; sai số ⇒ `null`. HÀM THUẦN. */
export function savedAddressChoice(c: Customer360 | null | undefined, n: unknown): ReturningCustomer | null {
  if (!c || c.suggestion !== "MANY" || typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > c.addresses.length) return null;
  return returningOf(c, c.addresses[n - 1]);
}

// Tách SĐT theo cụm sống ở known-contact.ts — re-export cho nơi gọi cũ.
export { phonesInText };

/**
 * SĐT ghi vào hồ sơ khi khách dùng lại địa chỉ cũ (`use_saved_address`). Không có `phone` hoặc trùng số cũ ⇒ số cũ. Số KHÁC số cũ ⇒
 * chỉ nhận khi địa chỉ nối bằng đơn của chính hội thoại / mã Facebook (nối bằng SĐT thì đổi số là mất căn cứ) VÀ số đó nằm nguyên
 * trong câu cuối của khách; không thì `error` để bot hỏi lại — KHÔNG BAO GIỜ lặng lẽ lùi về số cũ. HÀM THUẦN.
 */
export function savedAddressPhone(r: Pick<ReturningCustomer, "trust" | "phone">, inputPhone: unknown, lastUserText: string): { phone: string } | { error: string } {
  const typed = typeof inputPhone === "string" ? inputPhone.trim() : "";
  if (!typed) return { phone: r.phone };
  const next = normalizeVnPhone(typed);
  if (next && next === normalizeVnPhone(r.phone)) return { phone: r.phone };
  if (r.trust === "PHONE") return { error: "Địa chỉ cũ ĐÃ CHE nối theo SĐT cũ — khách đổi số thì không dùng được địa chỉ đó: xin SĐT mới + địa chỉ đầy đủ, gọi create_customer KHÔNG có use_saved_address." };
  if (!next) return { error: "SĐT mới không hợp lệ — hỏi khách gửi lại số điện thoại mới." };
  if (!phonesInText(lastUserText).includes(next)) return { error: "SĐT mới không có trong câu cuối của khách — hỏi khách gửi lại số mới (không tự điền số, không dùng số cũ)." };
  return { phone: next };
}

/**
 * Model gõ lại ĐÚNG địa chỉ của đơn cũ vào `create_customer` mà không qua `use_saved_address` (bỏ qua kiểm lời xác nhận) ⇒ `true`,
 * trừ khi khách tự gõ địa chỉ đó trong câu cuối. HÀM THUẦN.
 */
export function historyAddressWithoutConsent(r: Pick<ReturningCustomer, "address" | "fromHistory"> | null | undefined, typedAddress: unknown, lastUserText: string): boolean {
  if (!r?.fromHistory || typeof typedAddress !== "string") return false;
  const key = (s: string) => foldVnText(s).replace(/[^a-z0-9]/g, "");
  const old = key(r.address);
  const typed = key(typedAddress);
  if (old.length < 6 || typed.length < 6 || !(typed.includes(old) || old.includes(typed))) return false;
  return !key(lastUserText).includes(typed);
}

/**
 * Khách cũ dùng cho lượt: hồ sơ của `findReturningCustomer` thắng khi nó là khách tự khai trong hội thoại (THREAD) hoặc khớp mã
 * Facebook; khi nó trống hoặc chỉ ở mức PHONE mà hồ sơ 360 nối được qua đơn của CHÍNH hội thoại ⇒ dùng hồ sơ 360. HÀM THUẦN.
 */
export function preferReturning(base: ReturningCustomer | null, c: Customer360 | null): ReturningCustomer | null {
  const fromThread = returningFrom360(c);
  if (!fromThread) return base;
  if (!base) return fromThread;
  return base.trust === "PHONE" && fromThread.trust !== "PHONE" ? fromThread : base;
}

// ═══════════════════════════ ĐỌC CSDL ═══════════════════════════

export type Customer360Source = { conversationId: string; pageId: string | null; threadId: string | null; state: ChatState };

function textArray(values: readonly string[]): SQL {
  return sql`array[${sql.join(values.map((v) => sql`${v}`), sql`, `)}]::text[]`;
}

/**
 * Đọc dữ kiện + dựng hồ sơ 360 của MỘT hội thoại. `db` mặc định = CSDL của tổ chức ngữ cảnh; ops chỉ-đọc truyền CSDL tổ chức đang
 * soát. `before` (phép đo lịch sử) = mốc bắt đầu hội thoại: đơn tạo từ mốc đó trở đi là của lượt này, không phải «lần trước».
 */
export async function loadCustomer360(src: Customer360Source, opts: { db?: Db; before?: Date } = {}): Promise<Customer360> {
  const db = opts.db ?? (await getDb());
  const o = schema.orders;
  const c = schema.customers;
  const st = src.state;
  const currentIds = new Set([st.draft?.orderId, st.confirmed?.orderId].filter((x): x is string => typeof x === "string" && x.length > 0));
  const beforeIso = opts.before?.toISOString() ?? null;
  const isCurrent = (id: string, at: string | null) => currentIds.has(id) || (beforeIso !== null && at !== null && at >= beforeIso);
  const cols = {
    id: o.id,
    at: o.insertedAt,
    stage: o.stage,
    outcome: ORDER_OUTCOME,
    customerId: o.customerId,
    name: o.shipFullName,
    billName: o.billFullName,
    phone: o.shipPhone,
    billPhone: o.billPhone,
    address: o.shipAddress,
    full: o.shipFullAddress,
    province: o.shipProvince,
    ward: o.shipCommune,
    total: o.totalPriceAfterDiscount,
    ship: o.shippingFee,
  };
  type Row = { id: string; at: Date; stage: string; outcome: OrderOutcome | null; customerId: string | null; name: string; billName: string; phone: string; billPhone: string; address: string; full: string; province: string; ward: string; total: number | null; ship: number | null };
  const rowsWhere = async (where: SQL): Promise<Row[]> =>
    (await db
      .select(cols)
      .from(o)
      .leftJoin(schema.shipments, and(eq(schema.shipments.orderId, o.id), PRIMARY_ATTEMPT))
      .where(and(where, ne(o.stage, "DELETED")))
      .orderBy(desc(o.insertedAt))
      .limit(C360_LIMITS.orders)) as Row[];

  const facts = new Map<string, OrderFact>();
  const dueOf = new Map<string, number>();
  const add = (r: Row, link: C360Link) => {
    if (facts.has(r.id)) return;
    const at = r.at.toISOString();
    dueOf.set(r.id, manualOrderAmountDue({ totalPriceAfterDiscount: Number(r.total ?? 0), shippingFee: Number(r.ship ?? 0) }));
    facts.set(r.id, {
      orderId: r.id,
      source: "ERP",
      at,
      stage: r.stage,
      outcome: r.outcome ?? null,
      link,
      customerId: r.customerId,
      name: r.name.trim() || r.billName.trim(),
      phone: r.phone.trim() || r.billPhone.trim(),
      address: r.address.trim() || r.full.trim(),
      province: r.province.trim(),
      ward: r.ward.trim(),
      items: [],
      paid: false,
      currentCycle: isCurrent(r.id, at),
    });
  };

  // 1. THREAD — đơn của chính hội thoại (bot / ghi đơn từ hội thoại / đơn Pancake mang mã hội thoại này).
  const threadBound = Boolean(src.pageId && src.threadId);
  const threadConds: SQL[] = [eq(o.salesConversationId, src.conversationId)];
  if (src.threadId) threadConds.push(and(eq(o.conversationId, src.threadId), src.pageId ? or(isNull(o.pageId), eq(o.pageId, src.pageId)) : undefined)!);
  for (const r of await rowsWhere(or(...threadConds)!)) add(r, "THREAD");
  for (const p of st.returning?.recentOrders ?? []) {
    if (facts.has(p.id)) continue;
    facts.set(p.id, pancakeFact(p, isCurrent(p.id, p.at)));
  }
  // ĐƠN PANCAKE MÀ ERP CŨNG CÓ (đồng bộ từ Pancake nhưng `conversation_id` rỗng / lệch nên bước trên không bắt được): dòng ERP mang
  // ORDER_OUTCOME LUÔN đè bản Pancake (`outcome = null`) — không thì đơn HOÀN mà Pancake còn ghi «Đã gửi» / «Đã nhận» thành địa chỉ
  // «đã xác nhận» và được đề xuất. Đơn ERP đã xoá ⇒ bỏ luôn bản Pancake.
  const pancakeIds = [...facts.values()].filter((f) => f.source === "PANCAKE").map((f) => f.orderId);
  if (pancakeIds.length) {
    for (const d of await db.select({ id: o.id }).from(o).where(and(inArray(o.id, pancakeIds), eq(o.stage, "DELETED")))) facts.delete(d.id);
    for (const r of await rowsWhere(inArray(o.id, pancakeIds))) {
      facts.delete(r.id);
      add(r, "THREAD");
    }
  }

  // 2. FB_ID — hồ sơ khớp mã Facebook của người đang nhắn; chỉ đơn có người đứng sau (`vouchedOrder`).
  const fbIds = st.returning?.fbIds ?? [];
  if (fbIds.length) {
    const ids = (await db.select({ id: c.id }).from(c).where(inArray(c.fbId, fbIds)).limit(5)).map((r) => r.id);
    if (ids.length) for (const r of await rowsWhere(and(inArray(o.customerId, ids), vouchedOrder(o))!)) add(r, "FB_ID");
  }

  // 3. PHONE — SĐT xuất hiện trong hội thoại ⇒ hồ sơ / đơn ERP (che địa chỉ, không lịch sử chi tiết).
  const phones = [
    ...new Set(
      [st.customer && st.customer.savedAddress !== true ? st.customer.phone : "", ...(st.returning?.phones ?? []), ...(st.returning?.recentOrders ?? []).map((x) => x.phone)]
        .map((p) => normalizeVnPhone(p ?? ""))
        .filter((p): p is string => Boolean(p)),
    ),
  ].slice(0, C360_LIMITS.phones);
  let phoneCustomerIds: string[] = [];
  if (phones.length) {
    phoneCustomerIds = (await db.select({ id: c.id }).from(c).where(or(inArray(c.phone, phones), sql`${c.phones} && ${textArray(phones)}`)).limit(10)).map((r) => r.id);
    const who = or(phoneCustomerIds.length ? inArray(o.customerId, phoneCustomerIds) : undefined, inArray(o.shipPhone, phones), inArray(o.billPhone, phones))!;
    for (const r of await rowsWhere(and(who, vouchedOrder(o))!)) add(r, "PHONE");
  }

  // Tiền của đơn đang mở: CHỈ chứng từ thu của đơn tạo tay (cùng luật chiều `payment` của lifecycle.ts) — một câu.
  const manualCurrent = [...facts.values()].filter((f) => f.source === "ERP" && f.currentCycle && f.orderId.startsWith("erp-")).map((f) => f.orderId);
  if (manualCurrent.length) {
    const p = schema.orderPayments;
    const prow = await db.select({ orderId: p.orderId, kind: p.kind, amount: p.amount, status: p.status }).from(p).where(inArray(p.orderId, manualCurrent));
    for (const id of manualCurrent) {
      const sums = sumConfirmedPayments(prow.filter((r) => r.orderId === id).map((r) => ({ kind: r.kind, amount: Number(r.amount), status: r.status })));
      const f = facts.get(id);
      if (f) f.paid = manualPaymentStatus(sums, dueOf.get(id) ?? 0).status === "PAID";
    }
  }

  // Món của các đơn ERP (một câu cho mọi đơn).
  const erpIds = [...facts.values()].filter((f) => f.source === "ERP").map((f) => f.orderId);
  if (erpIds.length) {
    const it = schema.orderItems;
    const items = await db.select({ orderId: it.orderId, name: it.productName, detail: it.variationDetail, qty: it.quantity }).from(it).where(inArray(it.orderId, erpIds)).orderBy(asc(it.orderId));
    for (const i of items) {
      const f = facts.get(i.orderId);
      if (f && i.name.trim() && f.items.length < 5) f.items.push(`${i.name.trim()}${i.detail.trim() ? ` (${i.detail.trim()})` : ""} × ${i.qty}`);
    }
  }
  return assembleCustomer360({ conversationId: src.conversationId, state: st, threadBound, facts: [...facts.values()], phoneCustomerIds });
}

function pancakeFact(p: PancakeRecentOrder, currentCycle: boolean): OrderFact {
  return { orderId: p.id, source: "PANCAKE", at: p.at, stage: p.stage, outcome: null, link: "THREAD", customerId: null, name: p.name, phone: p.phone, address: p.address, province: p.province, ward: p.ward, items: p.items, paid: false, currentCycle };
}

// ═══════════════════════════ THƯỚC ĐO ═══════════════════════════
//
// Ba con số (chủ shop 11/10/2026): Returning Customer Recognition Rate · Repeat Purchase Conversion · số khách cũ bị hỏi lại thông
// tin thừa. Tính lại từ dữ liệu có sẵn (đơn + tin bot), không thêm cột, không backfill (mục 8.8). «Nhận ra» đọc từ CHỮ của bot
// (bot có đề xuất địa chỉ / thông tin cũ trước khi xin lại không) ⇒ mức ƯỚC TÍNH, luôn in kèm nhãn. Mẫu < `RETURNING_MIN_SAMPLE`
// ⇒ tỷ lệ `null` (mục 57: dưới 10 ca không in trung bình).

export const RETURNING_MIN_SAMPLE = 10;

const ASK_CONTACT_RE = /\b(xin|cho em|gui|de lai|cung cap|nhan|ib)\b.*\b(dia chi|sdt|so dien thoai|so dt|thong tin nhan hang|thong tin giao hang)\b/;
const OFFER_OLD_RE = /\bdia chi cu\b|\bnhu (lan|don) truoc\b|\bduoi (so |sdt )?\d{3,4}\b|\bthong tin (lan|don) truoc\b/;

/** Tin của bot (theo thứ tự) ⇒ số lần xin SĐT / địa chỉ, và bot có đề xuất thông tin cũ TRƯỚC lần xin đầu tiên không. HÀM THUẦN. */
export function botContactFacts(botTexts: readonly string[]): { askedContact: number; offeredOldFirst: boolean } {
  let asked = 0;
  let offeredOldFirst = false;
  for (const raw of botTexts) {
    const t = foldVnText(raw).replace(/\s+/g, " ");
    const offer = OFFER_OLD_RE.test(t);
    if (offer && asked === 0) offeredOldFirst = true;
    if (!offer && ASK_CONTACT_RE.test(t)) asked += 1;
  }
  return { askedContact: asked, offeredOldFirst };
}

/**
 * Một hội thoại cho phép đo. `priorOrder`: `true` = có đơn trước hội thoại (mức nối THREAD / FB_ID / PHONE không mơ hồ); `false` =
 * Pancake đã nói hội thoại không có đơn nào và ERP cũng không; `null` = CHƯA BIẾT (ngoài mẫu số).
 */
export type ReturningConversationFact = { priorOrder: boolean | null; askedContact: number; offeredOldFirst: boolean; converted: boolean };

export type ReturningMetrics = {
  conversations: number;
  unknown: number;
  returning: number;
  /** ƯỚC TÍNH (đọc từ chữ bot): khách cũ mà bot đề xuất thông tin cũ trước, hoặc không xin lại lần nào. */
  recognized: number;
  recognitionRate: number | null;
  converted: number;
  repeatConversion: number | null;
  /** Khách cũ bị bot xin lại SĐT / địa chỉ ít nhất một lần (và tổng số tin xin lại). */
  reAskedCustomers: number;
  reAskedMessages: number;
};

/** Gộp các hội thoại ⇒ ba thước đo. HÀM THUẦN. */
export function returningMetrics(facts: readonly ReturningConversationFact[]): ReturningMetrics {
  const returning = facts.filter((f) => f.priorOrder === true);
  const recognized = returning.filter((f) => f.offeredOldFirst || f.askedContact === 0).length;
  const converted = returning.filter((f) => f.converted).length;
  const rate = (n: number) => (returning.length >= RETURNING_MIN_SAMPLE ? n / returning.length : null);
  return {
    conversations: facts.length,
    unknown: facts.filter((f) => f.priorOrder === null).length,
    returning: returning.length,
    recognized,
    recognitionRate: rate(recognized),
    converted,
    repeatConversion: rate(converted),
    reAskedCustomers: returning.filter((f) => f.askedContact > 0).length,
    reAskedMessages: returning.reduce((s, f) => s + f.askedContact, 0),
  };
}

/** Câu đọc của ba thước đo — in ở ops / màn sau này. HÀM THUẦN. */
export function returningMetricsSentence(m: ReturningMetrics): string {
  const pct = (x: number | null) => (x === null ? `— (mẫu < ${RETURNING_MIN_SAMPLE})` : `${Math.round(x * 1000) / 10}%`);
  return `${m.conversations} hội thoại · khách có đơn trước ${m.returning} · chưa biết ${m.unknown} · nhận ra (ước tính, đọc chữ bot) ${m.recognized} = ${pct(m.recognitionRate)} · mua lại ${m.converted} = ${pct(m.repeatConversion)} · khách cũ bị hỏi lại SĐT/địa chỉ ${m.reAskedCustomers} (${m.reAskedMessages} tin)`;
}

function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (b && typeof b === "object" && (b as { type?: unknown }).type === "text" ? String((b as { text?: unknown }).text ?? "") : ""))
    .filter(Boolean)
    .join("\n");
}

/**
 * Đo trên CSDL một tổ chức: hội thoại (không phải khung thử) mở trong `[since, until)` có ít nhất một tin khách. Mỗi hội thoại dựng
 * hồ sơ 360 với `before = mốc mở` (đơn trước mốc đó mới là «lần trước»); «mua lại» = có đơn của CHÍNH hội thoại từ mốc mở trở đi.
 */
export async function measureReturningMetrics(opts: { db?: Db; since: Date; until: Date; limit?: number }): Promise<{ metrics: ReturningMetrics; byMatch: Record<string, number> }> {
  const db = opts.db ?? (await getDb());
  const cv = schema.salesChatConversations;
  const m = schema.salesChatMessages;
  const convs = await db
    .select({ id: cv.id, pageId: cv.pageId, threadId: cv.threadId, state: cv.state, createdAt: cv.createdAt })
    .from(cv)
    .where(and(ne(cv.channel, "TEST"), gte(cv.createdAt, opts.since), lt(cv.createdAt, opts.until), sql`exists (select 1 from ${m} where ${m.conversationId} = ${cv.id} and ${m.role} = 'user')`))
    .orderBy(desc(cv.createdAt))
    .limit(opts.limit ?? 3000);
  const facts: ReturningConversationFact[] = [];
  const byMatch: Record<string, number> = {};
  for (const conv of convs) {
    const state = (conv.state ?? {}) as ChatState;
    const c = await loadCustomer360({ conversationId: conv.id, pageId: conv.pageId, threadId: conv.threadId, state }, { db, before: conv.createdAt });
    byMatch[c.identity.match] = (byMatch[c.identity.match] ?? 0) + 1;
    // `NEW` chỉ khi Pancake đã nói «không có đơn»; ERP vắng đơn mà Pancake chưa nói ⇒ CHƯA BIẾT (ngoài mẫu số), không phải «khách mới».
    const priorOrder = c.buyer === "REPEAT" ? true : c.buyer === "NEW" ? false : null;
    const bot = await db.select({ content: m.content }).from(m).where(and(eq(m.conversationId, conv.id), eq(m.role, "assistant"))).orderBy(asc(m.seq));
    const { askedContact, offeredOldFirst } = botContactFacts(bot.map((r) => blockText(r.content)));
    const own = await db.select({ id: schema.orders.id }).from(schema.orders).where(and(eq(schema.orders.salesConversationId, conv.id), ne(schema.orders.stage, "DELETED"), gte(schema.orders.insertedAt, conv.createdAt))).limit(1);
    facts.push({ priorOrder, askedContact, offeredOldFirst, converted: own.length > 0 });
  }
  return { metrics: returningMetrics(facts), byMatch };
}
