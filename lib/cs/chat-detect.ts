/**
 * Đọc hội thoại Pancake (Pages API) → phát hiện case CSKH từ tin nhắn KHÁCH gửi và thẻ hội thoại:
 * tư vấn size chưa đúng, chốt sai giá, khách giục giao hàng, đổi size/màu, sai địa chỉ/SĐT, trả hàng, khiếu nại.
 */
import { and, desc, eq, gte, inArray, sql, type SQL } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { CS_KIND_LABEL, type CsKind } from "@/lib/constants/cs";
import { loadCsRules, stripIgnored } from "@/lib/cs/detect";
import { env } from "@/lib/env";
import { buildConversationFunnelRow, upsertConversationFunnel, type ConversationFunnelRow } from "@/lib/cs/conversation-funnel";
import { stillPendingOrderNotCreated } from "@/lib/cs/reconcile-order-created";
import { isOrderMaterialized } from "@/lib/constants/order-materialized";
import { NO_FACTS, type CaseFacts } from "@/lib/constants/case-semantics";
import { chatDedupeKey, decideCase, decideWithoutModel, toRecord, type CaseCandidate, type CaseDecision, type SemanticVerdict } from "@/lib/cs/semantic-case";
import { classifyConversationCached, pruneSemanticCache } from "@/lib/cs/semantic-cache";
import { getAiProvider } from "@/lib/ai/provider";
import { getPancakePagesClient, type PancakeMessage } from "@/lib/integrations/pancake/pages";
import { rowsOf } from "@/lib/sql-rows";
import { normalize, stripHtml } from "@/lib/text";

export type ChatHit = { kind: CsKind; keyword: string; message: string };

/**
 * ═══════════ "ĐÃ CHỐT" = KHÁCH ĐÃ CHO ĐỦ SĐT VÀ ĐỊA CHỈ ═══════════
 *
 * SỰ CỐ THẬT (10/09/2026, chủ shop báo kèm ảnh). Trang CSKH có **181 case** mang nhãn "Đã chốt
 * trong chat · chưa tạo đơn" mà phần lớn khách còn chưa cho số điện thoại. Vài dòng nguyên văn:
 *
 *   "Để hỗ trợ chị chốt đơn, em xin…"      ← shop ĐANG HỎI, không phải đã chốt
 *   "Chị cho em xin số điện thoại…"          ← shop đang đi xin SĐT
 *   "Dạ 1 đầm 499.000đ + 25.000…"            ← báo giá
 *
 * Nguyên nhân: luật cũ tìm từ khoá ("chot don", "em chot"…) trong tin của SHOP. Nhưng kịch bản bán
 * hàng của shop chứa sẵn chữ "chốt đơn" trong câu MỜI chốt, nên gần như mọi hội thoại có tư vấn đều
 * bị đánh dấu. Tìm từ khoá trong lời người bán để suy ra ý định của người mua là sai từ gốc.
 *
 * ĐỊNH NGHĨA ĐÚNG, chủ shop chốt 10/09/2026: **đơn đã chốt là đơn KHÁCH đã cho đủ SĐT và địa chỉ**
 * — tương đương trạng thái "đơn mới" trên Pancake. Đó là thứ quan sát được, không phải suy đoán:
 * có đủ hai thứ đó thì lên đơn được ngay; thiếu một thứ thì chưa.
 *
 * Nên hàm này đọc tin của KHÁCH (`!fromPage`), và chỉ báo khi thấy CẢ HAI.
 */

/** Số điện thoại Việt Nam trong một đoạn văn: 9–11 chữ số, cho phép dấu cách/chấm/gạch xen giữa. */
const SDT = /(?:^|[^\d])(0\d(?:[\s.\-]?\d){8,9})(?:[^\d]|$)/;

/**
 * Dấu hiệu ĐỊA CHỈ.
 *
 * Cố ý KHÔNG dùng "câu dài có dấu phẩy" làm tiêu chí: khách kể chuyện cũng dài và cũng có phẩy.
 * Chỉ nhận khi có từ chỉ đơn vị hành chính hoặc cách viết địa chỉ thật — thà bỏ sót vài ca hơn là
 * dựng lại đúng cái đống 181 case sai.
 */
const DIA_CHI = /\b(thon|xom|ap|to |khu pho|kp |so nha|sn |ngo |ngach |hem |duong |pho |xa |phuong |thi tran |tt |quan |huyen |thi xa |tp |thanh pho |tinh )/;

export type CustomerOrderInfo = {
  /** Lúc thông tin ĐỦ để lên đơn = tin muộn hơn trong hai tin. */
  at: Date | null;
  text: string;
  phone: string;
  /** Nguyên văn đoạn khách gửi địa chỉ — người xử lý dán thẳng vào đơn, khỏi mở lại chat. */
  address: string;
  /** Lúc khách gửi SĐT và lúc khách gửi địa chỉ, để tính được thời gian chờ của từng mảnh. */
  phoneAt: Date | null;
  addressAt: Date | null;
};

/**
 * ═══════════ BẰNG CHỨNG THÔ, TỪNG MẢNH RỜI ═══════════
 *
 * Tách khỏi `findCustomerOrderInfo` vì hai người dùng cần hai thứ khác nhau, trên CÙNG một phép
 * nhận diện:
 *
 *  · `findCustomerOrderInfo` hỏi "đã ĐỦ để lên đơn chưa" → chỉ trả lời khi có CẢ HAI mảnh;
 *  · phễu hội thoại hỏi "khách đi tới bước nào" → cần biết có SĐT mà chưa có địa chỉ, vì đó chính
 *    là một bước rơi có thật và là một loại ca thu hồi được.
 *
 * Hai biểu thức nhận diện (`SDT`, `DIA_CHI`) phải nằm đúng MỘT chỗ. Nhân bản chúng là cách chắc
 * chắn nhất để hai màn hình đếm ra hai con số khác nhau về cùng một hội thoại.
 *
 * MỐC SỚM NHẤT và MỐC MUỘN NHẤT đều được giữ, và chúng trả lời hai câu khác nhau:
 *  · sớm nhất — "khách cho SĐT lúc nào" (dùng cho phễu: bước này xảy ra khi nào);
 *  · muộn nhất — "số nào là số đúng" (dùng cho việc lên đơn: khách sửa lại số thì lấy số mới).
 */
export type CustomerEvidence = {
  /** Chỉ chữ số. '' = chưa thấy trong cửa sổ quét (CHƯA BIẾT, không phải không có). */
  phone: string;
  /** Mốc khách cho SĐT LẦN ĐẦU — dùng cho phễu. */
  phoneFirstAt: Date | null;
  /** Mốc lần CUỐI, đi kèm `phone` (số mới nhất khách đưa). */
  phoneAt: Date | null;
  phoneText: string;
  /**
   * `true` khi SĐT lấy từ danh sách Pancake tách sẵn chứ không từ tin trong cửa sổ quét — nghĩa là
   * KHÔNG có mốc thời gian cho nó. Không đánh dấu thì một mốc `null` sẽ bị hiểu là "chưa cho số".
   */
  phoneFromPancakeList: boolean;
  address: string;
  addressFirstAt: Date | null;
  addressAt: Date | null;
};

/** Nhận diện SĐT và địa chỉ trong tin của KHÁCH. Thuần, không chạm CSDL — kiểm thử được trực tiếp. */
export function extractCustomerEvidence(messages: PancakeMessage[], convPhones: string[] = []): CustomerEvidence {
  let sdt: { at: Date | null; text: string; value: string } | null = null;
  let sdtDau: Date | null = null;
  let diaChi: { at: Date | null; text: string } | null = null;
  let diaChiDau: Date | null = null;

  for (const m of messages) {
    if (m.fromPage || !m.text) continue;
    const plain = stripHtml(m.text);
    const n = normalize(plain);
    const khopSdt = SDT.exec(plain);
    if (khopSdt) {
      if (!sdt || (m.insertedAt && (!sdt.at || m.insertedAt > sdt.at))) {
        sdt = { at: m.insertedAt, text: plain.slice(0, 240), value: khopSdt[1].replace(/\D/g, "") };
      }
      if (m.insertedAt && (!sdtDau || m.insertedAt < sdtDau)) sdtDau = m.insertedAt;
    }
    if (DIA_CHI.test(n)) {
      if (!diaChi || (m.insertedAt && (!diaChi.at || m.insertedAt > diaChi.at))) {
        diaChi = { at: m.insertedAt, text: plain.slice(0, 240) };
      }
      if (m.insertedAt && (!diaChiDau || m.insertedAt < diaChiDau)) diaChiDau = m.insertedAt;
    }
  }

  // SĐT do Pancake tách sẵn cũng tính — nhưng KHÔNG thay được địa chỉ, và KHÔNG có mốc thời gian.
  const soPancake = convPhones.map((p) => p.replace(/\D/g, "")).find((p) => p.length >= 9);
  return {
    phone: sdt?.value ?? soPancake ?? "",
    phoneFirstAt: sdtDau,
    phoneAt: sdt?.at ?? null,
    phoneText: sdt?.text ?? "",
    phoneFromPancakeList: !sdt?.value && Boolean(soPancake),
    address: diaChi?.text ?? "",
    addressFirstAt: diaChiDau,
    addressAt: diaChi?.at ?? null,
  };
}

/**
 * Khách đã cho ĐỦ SĐT và ĐỊA CHỈ trong hội thoại này chưa.
 *
 * Hai thứ có thể nằm ở HAI tin nhắn khác nhau (khách thường gửi SĐT trước, địa chỉ sau) nên xét
 * trên toàn bộ tin của khách, rồi lấy mốc thời gian của tin MUỘN hơn trong hai tin — đó mới là lúc
 * thông tin đủ để lên đơn.
 *
 * `phones` của hội thoại (do Pancake tự tách) được dùng làm nguồn bổ sung cho số điện thoại: khách
 * có thể đã cho SĐT ở lần nhắn trước cửa sổ quét.
 */
export function findCustomerOrderInfo(messages: PancakeMessage[], convPhones: string[] = []): CustomerOrderInfo | null {
  const bang = extractCustomerEvidence(messages, convPhones);
  const sdt = bang.phoneText ? { at: bang.phoneAt, text: bang.phoneText } : null;
  const diaChi = bang.address ? { at: bang.addressAt, text: bang.address } : null;
  const soCuoi = bang.phone;
  if (!soCuoi || !diaChi) return null;

  // Mốc = tin MUỘN hơn trong hai tin: trước đó thông tin chưa đủ để lên đơn.
  const moc = [sdt?.at ?? null, diaChi.at].filter((d): d is Date => d instanceof Date).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
  return {
    at: moc,
    text: (sdt?.at && diaChi.at && sdt.at > diaChi.at ? sdt.text : diaChi.text) || diaChi.text,
    phone: soCuoi,
    address: diaChi.text,
    phoneAt: sdt?.at ?? null,
    addressAt: diaChi.at,
  };
}

/** Loại case chỉ có nghĩa SAU khi khách đã đặt đơn (trước đó chỉ là câu hỏi tư vấn, không phải việc cần xử lý) */
export const POST_PURCHASE_KINDS = new Set<CsKind>(["EXCHANGE_SIZE", "EXCHANGE_COLOR", "WRONG_ADDRESS", "WRONG_PHONE", "RETURN", "SIZE_ADVICE", "WRONG_PRICE", "URGE_DELIVERY", "COMPLAINT"]);

/** Cụm phủ định theo loại: khớp từ khoá nhưng ngữ cảnh là câu hỏi chính sách / còn hàng → không phải case */
const NEGATIVE: Partial<Record<CsKind, RegExp[]>> = {
  RETURN: [/kiem tra/, /kiem hang/, /nhan duoc/, /chinh sach/, /(co|duoc|dc) (doi )?tra/, /tra hang (khong|ko|k|dc|duoc)/, /doi tra (khong|ko|k|the nao|sao)/],
  EXCHANGE_COLOR: [/(co|con) mau/, /mau khac (khong|ko|k|ha|hem|a|ak|hok|hong)/, /mau (nao|gi|ntn|the nao)/, /may mau/, /nhung mau/],
  EXCHANGE_SIZE: [/(co|con) size/, /size (nao|gi|ntn|the nao|bao nhieu)/, /bang size/, /size khac (khong|ko|k)/],
  SIZE_ADVICE: [/(co|con) size/, /size (nao|gi|ntn|the nao|bao nhieu)/, /bang size/, /cao .* nang/, /nang .* cao/, /(m|kg) (thi )?(mac|lay) size/],
  URGE_DELIVERY: [/bao lau (thi )?(nhan|giao|toi|ve)/, /may ngay (thi )?(nhan|giao|toi|ve)/, /ship (bao lau|may ngay)/, /dat (bay gio|hom nay|gio)/],
  WRONG_PRICE: [/gia bao nhieu/, /bao nhieu (tien|1|mot)/, /gia (the nao|sao|ntn)/, /co giam/, /freeship/, /free ship/],
  COMPLAINT: [/chat luong (the nao|sao|ok|tot|co tot|ntn)/, /co tot (khong|ko|k)/, /vai gi/, /chat vai/],
};

/** Câu hỏi tư vấn / chính sách trước khi mua (không có ý muốn đổi, trả, khiếu nại) */
export function isInquiry(normalized: string) {
  const n = normalized;
  const intent = /\b(muon|xin|cho (em|chi|minh|toi|e|c|a|anh)|lam on|giup (em|chi|minh|toi)|tra lai|gui tra|hoan lai|doi giup|doi cho|khong nhan nua|ko nhan nua|khong lay nua|huy (don|giup|cho))\b/;
  if (intent.test(n)) return false;
  const question = /\b(co duoc|duoc (khong|ko|k|hong|hem|hok)|dc (khong|ko|k)|(co|con) (mau|size|hang|san|mau nao|size nao)|mau khac (khong|ko|k|ha|hem|a)|(khong|ko) (a|ak|shop|em|chi)?\s*\?|bao nhieu|the nao|nhu the nao|ntn|(co|duoc) kiem (tra|hang))\b/;
  return question.test(n) || /\?\s*$/.test(n.trim());
}

export type DetectOptions = {
  /** Đơn gần nhất của khách: chỉ tạo case sau mua khi có đơn và tin nhắn gửi sau lúc lên đơn */
  orderInsertedAt?: Date | null;
  /** Giai đoạn đơn: giục giao chỉ có nghĩa khi đơn chưa kết thúc */
  orderStage?: string | null;
  /** Bật gác theo đơn (mặc định tắt để giữ tương thích) */
  requireOrder?: boolean;
};

const FINAL_ORDER_STAGES = new Set(["DELIVERED", "PAID", "RETURNED", "CANCELLED", "DELETED", "PARTIAL_RETURN"]);

/** Tìm loại case trong danh sách tin nhắn khách (ưu tiên từ khoá dài, mỗi loại lấy tin đầu tiên khớp) */
export function detectFromMessages(messages: { text: string; fromPage: boolean; insertedAt?: Date | null }[], rules: { keyword: string; kind: CsKind }[], ignore: string[] = [], options: DetectOptions = {}): ChatHit[] {
  const sorted = [...rules].sort((a, b) => b.keyword.length - a.keyword.length);
  const hits = new Map<CsKind, ChatHit>();
  const hasOrder = Boolean(options.orderInsertedAt);
  for (const m of messages) {
    if (m.fromPage || !m.text) continue;
    const plain = stripHtml(m.text);
    const cleaned = stripIgnored(plain, ignore);
    if (!cleaned) continue;
    const n = normalize(cleaned);
    const inquiry = isInquiry(n);
    const afterOrder = !options.orderInsertedAt || !m.insertedAt || m.insertedAt >= options.orderInsertedAt;
    for (const r of sorted) {
      const k = normalize(r.keyword).trim();
      if (!k || hits.has(r.kind)) continue;
      if (!(n.includes(` ${k} `) || (k.length >= 7 && n.includes(k)))) continue;
      if ((NEGATIVE[r.kind] ?? []).some((re) => re.test(n))) continue;
      if (inquiry && POST_PURCHASE_KINDS.has(r.kind)) continue;
      if (options.requireOrder && POST_PURCHASE_KINDS.has(r.kind) && (!hasOrder || !afterOrder)) continue;
      if (r.kind === "URGE_DELIVERY" && options.requireOrder && options.orderStage && FINAL_ORDER_STAGES.has(options.orderStage)) continue;
      hits.set(r.kind, { kind: r.kind, keyword: r.keyword, message: plain.slice(0, 300) });
    }
  }
  return [...hits.values()];
}

/**
 * ═══════════ GHÉP ĐƠN TRƯỚC KHI KẾT LUẬN "CHƯA TẠO ĐƠN" ═══════════
 *
 * Kết luận "khách đủ thông tin mà chưa có đơn" chỉ đúng khi ta THẬT SỰ biết là chưa có. Ghép sai
 * theo hướng nào cũng tệ:
 *
 *  · ghép hụt  ⇒ báo "chưa tạo đơn" trong khi đơn đã có, CSKH gọi lại khách đã mua rồi;
 *  · ghép bừa  ⇒ im lặng bỏ sót một đơn thật.
 *
 * BA MỨC CHẮC CHẮN, xét theo đúng thứ tự:
 *
 *  1. `conversation_id` — Pancake gắn thẳng đơn với hội thoại. Chắc chắn, dùng ngay.
 *  2. SĐT + đúng MỘT đơn trong cửa sổ thời gian — đủ chắc.
 *  3. SĐT + NHIỀU đơn ⇒ **NHẬP NHẰNG**. Không chọn đại, và cũng không kết luận "chưa tạo đơn".
 *
 * Mức 3 là chỗ luật cũ sai: nó lấy đơn mới nhất theo SĐT rồi coi như xong. Một số điện thoại có
 * nhiều đơn là chuyện thường (khách mua nhiều lần, hoặc SĐT của người nhận hộ), và chọn đại một
 * đơn để so mốc thời gian là dựng ra một kết luận không có căn cứ.
 */
export type OrderMatch =
  | { kind: "BY_CONVERSATION"; order: MatchedOrder }
  | { kind: "BY_PHONE_UNIQUE"; order: MatchedOrder }
  | { kind: "AMBIGUOUS"; candidates: number; order: MatchedOrder | null }
  | { kind: "NONE"; order: null };

export type MatchedOrder = { id: string; customerId: string | null; billFullName: string | null; billPhone: string | null; systemId: number | null; insertedAt: Date | null; stage: string | null };

/**
 * Đơn ứng với hội thoại này, kèm MỨC CHẮC CHẮN.
 *
 * `since` giới hạn cửa sổ khi ghép bằng SĐT: đơn của ba tháng trước không nói gì về lần chốt hôm
 * nay. Ghép bằng `conversation_id` thì không cần cửa sổ — nó đã là bằng chứng trực tiếp.
 */
export async function matchOrderForConversation(
  db: Awaited<ReturnType<typeof getDb>>,
  conversationId: string,
  phones: string[],
  since: Date,
): Promise<OrderMatch> {
  const cols = { id: true, customerId: true, billFullName: true, billPhone: true, systemId: true, insertedAt: true, stage: true } as const;
  const conNguyen = sql`${schema.orders.stage} not in ('CANCELLED','DELETED')`;

  const theoHoiThoai = await db.query.orders.findFirst({
    where: and(eq(schema.orders.conversationId, conversationId), conNguyen),
    orderBy: [desc(schema.orders.insertedAt)],
    columns: cols,
  });
  if (theoHoiThoai) return { kind: "BY_CONVERSATION", order: theoHoiThoai };

  const so = phones.map((p) => p.replace(/\D/g, "")).filter((p) => p.length >= 9);
  if (!so.length) return { kind: "NONE", order: null };

  const theoSdt = await db.query.orders.findMany({
    where: and(inArray(schema.orders.billPhone, so), conNguyen, gte(schema.orders.insertedAt, since)),
    orderBy: [desc(schema.orders.insertedAt)],
    columns: cols,
    limit: 5,
  });
  if (!theoSdt.length) return { kind: "NONE", order: null };
  if (theoSdt.length === 1) return { kind: "BY_PHONE_UNIQUE", order: theoSdt[0] };
  return { kind: "AMBIGUOUS", candidates: theoSdt.length, order: theoSdt[0] };
}

/**
 * ═══════════ CHỨNG TỪ NGHIỆP VỤ CỦA MỘT HỘI THOẠI ═══════════
 *
 * Toàn bộ là thứ ĐỌC ĐƯỢC TỪ CSDL. Không ô nào là suy đoán, và model không ghi được vào đây —
 * đó chính là lý do khối này thắng mọi kết luận ngôn ngữ (`decideCase`).
 *
 * "Đơn đã tồn tại thật" hỏi qua `isOrderMaterialized` chứ không tự liệt kê chặng: bản khai nằm ở
 * `lib/constants/order-materialized.ts` và bám MÃ SỐ Pancake, không bám chuỗi hiển thị.
 *
 * `AMBIGUOUS` (một SĐT nhiều đơn) cố ý KHÔNG được coi là "có đơn": ghép không chắc thì không kết
 * luận theo hướng nào, và bộ gác của từng loại tự xử ca này.
 */
async function collectCaseFacts(db: Awaited<ReturnType<typeof getDb>>, match: OrderMatch, phones: string[]): Promise<CaseFacts> {
  const order = match.kind === "AMBIGUOUS" ? null : match.order;
  const so = phones.map((p) => p.replace(/\D/g, "")).filter((p) => p.length >= 9);
  /*
    VẬN ĐƠN TRA THEO CẢ ĐƠN LẪN SỐ NGƯỜI NHẬN.

    Đơn có vận đơn là bằng chứng trực tiếp. Nhưng đơn có thể lên bằng đường khác (nhân viên gõ tay,
    một hội thoại khác) mà kiện vẫn gửi tới đúng số này — và khi ấy "chưa tạo đơn" chắc chắn sai.
  */
  const dieu = [
    order ? sql`s.order_id = ${order.id}` : null,
    so.length ? sql`s.receiver_phone in ${so}` : null,
  ].filter((x): x is SQL => Boolean(x));
  let hasShipment = false;
  let hasActiveShipment = false;
  if (dieu.length) {
    const rows = rowsOf<{ tong: number; dang_chay: number }>(
      await db.execute(sql`select count(*)::int as tong, count(*) filter (where s.is_final = false)::int as dang_chay from shipments s where ${sql.join(dieu, sql` or `)}`),
    );
    hasShipment = Number(rows[0]?.tong ?? 0) > 0;
    hasActiveShipment = Number(rows[0]?.dang_chay ?? 0) > 0;
  }
  if (!order) return { ...NO_FACTS, orderMatch: match.kind, hasShipment, hasActiveShipment };
  return {
    orderMatch: match.kind,
    orderMaterialized: isOrderMaterialized({ stage: order.stage }),
    orderStage: order.stage,
    orderSystemId: order.systemId,
    orderInsertedAt: order.insertedAt,
    orderFinal: FINAL_ORDER_STAGES.has(order.stage ?? ""),
    hasShipment,
    hasActiveShipment,
  };
}

function pancakeChatUrl(pageId: string, conversationId: string) {
  return `https://pancake.vn/${pageId}?c_id=${conversationId}`;
}

export async function syncPancakeChatCases(options: { hours?: number; limitPerPage?: number; log?: (m: string) => void } = {}) {
  if (!env.pancake.pagesAccessToken) throw new Error("Chưa cấu hình PANCAKE_ACCESS_TOKEN");
  const db = await getDb();
  const rules = await loadCsRules();
  const client = getPancakePagesClient();
  const hours = options.hours ?? rules.chatLookbackHours ?? 48;
  const since = new Date(Date.now() - hours * 3_600_000);
  const until = new Date();
  const log = options.log ?? (() => undefined);

  // Chỉ quét các page thuộc shop: cấu hình chatPageIds, nếu trống thì lấy các page có đơn Pancake trong 90 ngày
  let allowed = new Set(rules.chatPageIds ?? []);
  if (!allowed.size) {
    const rows = await db
      .select({ pageId: schema.orders.pageId })
      .from(schema.orders)
      .where(sql`${schema.orders.pageId} is not null and ${schema.orders.insertedAt} >= now() - interval '90 days'`)
      .groupBy(schema.orders.pageId);
    allowed = new Set(rows.map((r) => r.pageId).filter((x): x is string => Boolean(x)));
  }
  const allPages = await client.listPages();
  const pages = allowed.size ? allPages.filter((p) => allowed.has(p.id)) : allPages;
  log(`Quét ${pages.length}/${allPages.length} page: ${pages.map((p) => p.name).join(", ")}`);
  let scanned = 0;
  let withHits = 0;
  /*
    BA CON SỐ PHẢI BÁO RA, KHÔNG ĐƯỢC NUỐT.

    Một lượt quét trả về "tạo 12 case" mà không nói đã bỏ qua bao nhiêu và vì sao thì không kiểm
    chứng được. Hai lý do bỏ qua dưới đây có nghĩa hoàn toàn khác nhau:

     · `daCoDon`   — khách đủ thông tin VÀ đơn đã có. Hệ thống chạy đúng, không có việc gì.
     · `nhapNhang` — một SĐT nhiều đơn, không ghép chắc được. Đây là nợ dữ liệu, không phải "ổn".
  */
  let daCoDon = 0;
  let nhapNhang = 0;
  let duThongTinTong = 0;
  let created = 0;
  /*
    ĐO CẢ PHẦN **KHÔNG** SINH RA VIỆC.

    Một lượt quét báo "tạo 12 case" mà không nói đã bác bao nhiêu ứng viên thì không kiểm chứng
    được tầng ngữ nghĩa đang làm việc hay đang ngủ. Ba con số dưới đây có nghĩa khác hẳn nhau:

     · `semanticCalls`     — số lượt GỌI MODEL thật (mỗi lượt là tiền);
     · `semanticCacheHits` — số hội thoại dùng lại kết luận đã trả tiền vì đầu vào không đổi
                             (`lib/cs/semantic-cache.ts`). Tổng hai số = số hội thoại được đọc hiểu;
     · `semanticRejected`  — ứng viên bị bác (giả định · lời shop · chứng từ nói khác · chưa đủ chắc);
     · `aiOff`             — hội thoại có dấu hiệu bằng CHỮ nhưng không có tầng ngữ nghĩa để xét.
                             Đây là NỢ, không phải "sạch": chúng KHÔNG được tạo việc bằng từ khoá.
  */
  let semanticCalls = 0;
  let semanticCacheHits = 0;
  let phanhChan = 0;
  let phanhLy = "";
  let boQuaNgheNghia = 0;
  let aiTat = 0;
  let needsReview = 0;
  let evidenceAppended = 0;
  /*
    LẤY PROVIDER MỘT LẦN CHO CẢ LƯỢT QUÉT. `null` = AI chưa cấu hình trên máy chủ này — và khi ấy
    đường lui là KHÔNG TẠO VIỆC từ chữ, chứ không phải quay về luật từ khoá cũ.
  */
  const provider = getAiProvider("routine");
  const semanticCachePruned = provider ? await pruneSemanticCache(db) : 0;
  /*
    ═══ GIỮ LẠI BẰNG CHỨNG PHỄU — KHÔNG THÊM MỘT LƯỢT GỌI API NÀO ═══

    Job này đã có trong tay hội thoại, thẻ và tới 50 tin nhắn mỗi hội thoại. Trước đây tất cả bị ném
    đi trừ ca sinh case, nên MẪU SỐ của mọi tỷ lệ chuyển đổi biến mất (ca đã có đơn không sinh case).
    Gom dòng ở đây rồi ghi một lượt mỗi page — xem `lib/cs/conversation-funnel.ts`.
  */
  const funnelRows: ConversationFunnelRow[] = [];
  let funnelSaved = 0;
  const errors: string[] = [];
  for (const page of pages) {
    let conversations;
    try {
      conversations = await client.listConversations(page.id, since, until, options.limitPerPage ?? 200);
    } catch (e) {
      errors.push(`${page.name}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    /*
      CHẠM TRẦN = CÒN HỘI THOẠI CHƯA ĐỌC.

      `listConversations` cắt ở `limitPerPage` (mặc định 200). Một page chạm trần nghĩa là số đếm của
      nó BỊ CẮT, và một con số bị cắt trông y hệt một con số đầy đủ nếu không ghi cờ. Cờ này đi theo
      từng dòng phễu để mọi tỷ lệ dựng trên nó biết mình đang đứng trên dữ liệu thiếu.
    */
    const chamTran = conversations.length >= (options.limitPerPage ?? 200);
    log(`Page ${page.name}: ${conversations.length} hội thoại từ ${since.toISOString()}${chamTran ? " (CHẠM TRẦN — còn hội thoại chưa đọc)" : ""}`);
    for (const conv of conversations) {
      scanned += 1;
      // thẻ hội thoại theo quy tắc thẻ
      const tagHits: ChatHit[] = [];
      for (const tag of conv.tags) {
        const n = normalize(tag);
        const rule = [...rules.tagRules].sort((a, b) => b.keyword.length - a.keyword.length).find((r) => n.includes(` ${normalize(r.keyword).trim()} `));
        if (rule && !tagHits.some((h) => h.kind === rule.kind)) tagHits.push({ kind: rule.kind, keyword: tag, message: `Thẻ hội thoại: ${tag}` });
      }
      let messages: PancakeMessage[] = [];
      if (conv.customerId) {
        try {
          messages = await client.listMessages(page.id, conv.id, conv.customerId, 50);
        } catch (e) {
          if (errors.length < 20) errors.push(`${conv.id}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      const recent = messages.filter((m) => !m.insertedAt || m.insertedAt >= since);
      const phones = conv.phones.map((p) => p.replace(/\D/g, "")).filter((p) => p.length >= 9);
      // Ghép đơn KÈM MỨC CHẮC CHẮN — xem `matchOrderForConversation`. Cửa sổ 90 ngày khi ghép bằng
      // SĐT: đơn của quý trước không nói gì về lần chốt hôm nay.
      const match = await matchOrderForConversation(db, conv.id, phones, new Date(Date.now() - 90 * 86_400_000));
      const order = match.order;
      /*
        GHI PHỄU CHO **MỌI** HỘI THOẠI QUÉT ĐƯỢC, kể cả hội thoại không sinh case nào.

        Đây chính là chỗ mẫu số từng biến mất: hội thoại đã có đơn thì không sinh case, nên trước đây
        nó không để lại dấu vết gì — và không có mẫu số thì không có tỷ lệ chuyển đổi nào.

        Cố ý dùng `messages` (toàn bộ tin đọc được) chứ không dùng `recent`: bằng chứng càng đầy càng
        tốt, và `scan_window_from` ghi lại đúng mốc sớm nhất thật sự đọc được.
      */
      funnelRows.push(
        buildConversationFunnelRow({
          pageId: page.id,
          conversationId: conv.id,
          pancakeCustomerId: conv.customerId,
          customerName: conv.customerName,
          tags: conv.tags,
          messages,
          convPhones: conv.phones,
          match,
          since,
          truncated: chamTran,
          customerSeenAt: conv.customerSeenAt,
        }),
      );
      // Chỉ tạo case sau mua khi khách đã có đơn và tin nhắn gửi sau lúc lên đơn; câu hỏi tư vấn trước mua không phải case
      /*
        ═══ TỪ KHOÁ VÀ THẺ CHỈ LÀ ỨNG VIÊN ═══

        `detectFromMessages` trả về những chỗ ĐÁNG XEM, không phải kết luận. Ai kết luận: tầng ngữ
        nghĩa (`lib/cs/semantic-case.ts`) đọc CẢ hội thoại có phân vai, rồi chứng từ nghiệp vụ bác
        bỏ nếu thực tế nói khác.
      */
      const msgHits = detectFromMessages(recent, rules.chatRules, rules.ignorePatterns, { requireOrder: true, orderInsertedAt: order?.insertedAt ?? null, orderStage: order?.stage ?? null });
      /*
        KHÁCH ĐÃ CHO ĐỦ SĐT + ĐỊA CHỈ MÀ CHƯA THẤY ĐƠN → đây mới là đơn sắp bị sót.

        Luật cũ tìm từ khoá "chốt đơn" trong tin của SHOP, và kịch bản bán hàng có sẵn câu "để hỗ
        trợ chị chốt đơn, em xin…" nên gần như mọi hội thoại có tư vấn đều bị đánh dấu: 181 case
        mà phần lớn khách còn chưa cho số điện thoại.

        Nay dùng thứ QUAN SÁT ĐƯỢC: khách đã đưa đủ hai thứ để lên đơn hay chưa.
      */
      const closeHits: ChatHit[] = [];
      const duThongTin = findCustomerOrderInfo(recent, conv.phones);
      if (duThongTin) {
        duThongTinTong += 1;
        /*
          NHẬP NHẰNG THÌ KHÔNG KẾT LUẬN.

          Một SĐT có nhiều đơn là chuyện thường (khách mua nhiều lần, hoặc số của người nhận hộ).
          Chọn đại một đơn rồi so mốc thời gian là dựng ra kết luận không có căn cứ — theo cả hai
          hướng: báo "chưa tạo đơn" cho khách đã mua, hoặc im lặng bỏ sót một đơn thật.
        */
        if (match.kind === "AMBIGUOUS") {
          nhapNhang += 1;
        } else {
          // Đơn tạo trước lúc khách cho đủ thông tin 30 phút trở về trước = đơn của lần mua CŨ.
          const from = duThongTin.at ? new Date(duThongTin.at.getTime() - 30 * 60_000) : null;
          const hasNewOrder = Boolean(order?.insertedAt && from && new Date(order.insertedAt) >= from);
          if (hasNewOrder) daCoDon += 1;
          /*
            HỎI LẠI ĐÚNG VỊ TỪ CỦA MÁY ĐỐI CHIẾU, NGAY TRƯỚC KHI GHI.

            `hasNewOrder` ở trên chỉ nhìn ĐƠN GẦN NHẤT mà lượt quét này lần ra. Máy đối chiếu
            (`lib/cs/reconcile-order-created.ts`) biết thêm hai bậc nữa — đơn của cùng SĐT lên bằng
            đường khác, và VẬN ĐƠN gửi tới chính số đó. Không hỏi lại thì mỗi lượt quét đẻ ra đúng
            những case mà lượt đối chiếu ngay sau đó phải đóng: `dedupe_key` của loại này mang NGÀY
            nên hôm sau là một khoá mới và không có gì chặn.

            Đây cũng là chỗ chặn CUỘC ĐUA giữa máy quét và người lên đơn: vị từ chạy TẠI THỜI ĐIỂM
            GHI, nên một đơn vừa được tạo giữa lúc quét và lúc ghi vẫn được nhìn thấy.
          */
          const conTreo = !hasNewOrder && (await stillPendingOrderNotCreated([{ key: conv.id, conversationId: conv.id, phone: duThongTin.phone || phones[0] || "", infoCompleteAt: duThongTin.at }])).has(conv.id);
          if (!hasNewOrder && !conTreo) daCoDon += 1;
          if (conTreo) {
          /*
            CASE PHẢI MANG ĐỦ BẰNG CHỨNG ĐỂ LÀM ĐƯỢC NGAY.

            Người xử lý cần: SĐT · địa chỉ nguyên văn · lúc thông tin đủ · đã chờ bao lâu · việc
            cần làm. Thiếu một trong số đó là họ phải mở lại chat đọc từ đầu, và một hàng đợi bắt
            người ta làm thế thì sớm muộn cũng bị bỏ.
          */
          const cuLabel = order?.systemId ? ` Đơn gần nhất #${order.systemId} là của lần mua trước.` : "";
          const luc = duThongTin.at
            ? duThongTin.at.toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" })
            : "không rõ";
          const choGio = duThongTin.at ? Math.max(0, Math.round((Date.now() - duThongTin.at.getTime()) / 3_600_000)) : null;
          const choLabel = choGio === null ? "" : choGio < 24 ? ` · đã chờ ${choGio} giờ` : ` · đã chờ ${Math.floor(choGio / 24)} ngày`;
          closeHits.push({
            kind: "ORDER_NOT_CREATED",
            keyword: duThongTin.phone,
            message:
              `SĐT ${duThongTin.phone} · địa chỉ: “${duThongTin.address}” · đủ thông tin lúc ${luc}${choLabel}. ` +
              `Chưa thấy đơn tương ứng trên Pancake${match.kind === "BY_CONVERSATION" ? " (đã đối chiếu theo hội thoại)" : match.kind === "BY_PHONE_UNIQUE" ? " (đã đối chiếu theo SĐT)" : ""}.` +
              `${cuLabel} VIỆC CẦN LÀM: tạo đơn trên Pancake, hoặc kiểm tra lại với khách nếu đã đổi ý.`,
          });
          }
        }
      }
      /*
        ═══════════ ỨNG VIÊN → NGỮ NGHĨA → CHỨNG TỪ → VIỆC ═══════════

        Ba nguồn ứng viên, hai thẩm quyền khác nhau:

         · `TAG` / `KEYWORD`     — dấu hiệu bằng CHỮ. Không bao giờ tự thành việc; phải qua tầng
                                   ngữ nghĩa. Tắt AI ⇒ chúng KHÔNG tạo việc (xem `decideWithoutModel`).
         · `DETERMINISTIC`       — "khách đã cho đủ SĐT và địa chỉ mà chưa thấy đơn". Kết luận của
                                   nó KHÔNG đứng trên chữ nghĩa mà trên QUAN SÁT cộng CHỨNG TỪ, nên
                                   nó chạy cả khi không có AI. Đây cũng là loại case duy nhất trực
                                   tiếp cứu được doanh thu — tắt nó đi vì "cho an toàn" là mất đơn.

        MỘT LƯỢT GỌI MODEL CHO MỘT HỘI THOẠI, không phải một lượt cho mỗi từ khoá: một hội thoại có
        đúng một ý định đang còn hiệu lực, và hỏi ba lần về ba từ khoá của cùng đoạn chat là ba lần
        trả tiền cho cùng một câu trả lời — rồi lại phải tự xử ba câu trả lời mâu thuẫn nhau.
      */
      const ungVien: CaseCandidate[] = [];
      for (const t of tagHits) ungVien.push({ kind: t.kind, evidence: t.message, from: "TAG", signal: t.keyword });
      for (const h of msgHits) if (!ungVien.some((x) => x.kind === h.kind)) ungVien.push({ kind: h.kind, evidence: h.message, from: "KEYWORD", signal: h.keyword });
      for (const c of closeHits) if (!ungVien.some((x) => x.kind === c.kind)) ungVien.push({ kind: c.kind, evidence: c.message, from: "DETERMINISTIC", signal: c.keyword });
      if (!ungVien.length) continue;

      const facts = await collectCaseFacts(db, match, phones);
      const canNgheNghia = ungVien.some((c) => c.from !== "DETERMINISTIC");
      let verdict: SemanticVerdict | null = null;
      if (canNgheNghia) {
        if (!provider) {
          aiTat += 1;
        } else {
          try {
            const r = await classifyConversationCached(db, conv.id, { customerName: conv.customerName, tags: conv.tags, candidates: ungVien, facts, messages }, provider);
            verdict = r.verdict;
            if (r.cached) semanticCacheHits += 1;
            else if (r.blocked) {
              // Chạm trần tiền AI ngày: như AI tắt — chữ không thành việc, ứng viên xác định vẫn chạy.
              phanhChan += 1;
              phanhLy = r.blocked;
            } else semanticCalls += 1;
          } catch (e) {
            if (errors.length < 20) errors.push(`ngữ nghĩa (${conv.id}): ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      }

      /*
        HAI ĐƯỜNG RA, KHÔNG TRỘN.

        Ứng viên xác định đi bằng chứng từ; ứng viên từ chữ đi bằng kết luận của model. Trộn hai
        đường là để một kết luận ngôn ngữ quyết định số phận của một quan sát — hoặc ngược lại.
      */
      const quyetDinh: { kind: CsKind; decision: CaseDecision; ungVien: CaseCandidate }[] = [];
      for (const c of ungVien.filter((x) => x.from === "DETERMINISTIC")) {
        const [d] = decideWithoutModel([c], facts);
        quyetDinh.push({ kind: c.kind, decision: d, ungVien: c });
      }
      if (canNgheNghia) {
        const d = verdict ? decideCase(verdict, facts) : decideWithoutModel(ungVien.filter((x) => x.from !== "DETERMINISTIC"), facts)[0];
        const kind = d.kind;
        // Model có thể kết luận một loại KHÁC mọi ứng viên — đó là chuyện bình thường và đúng ý đồ:
        // từ khoá chỉ đưa chỗ đáng xem, không đưa đáp án. Chỉ bỏ khi nó trùng một dòng đã quyết.
        if (kind && !quyetDinh.some((q) => q.kind === kind)) {
          const nguon = ungVien.find((x) => x.kind === kind) ?? ungVien.find((x) => x.from !== "DETERMINISTIC")!;
          quyetDinh.push({ kind, decision: d, ungVien: nguon });
        } else if (!kind) {
          boQuaNgheNghia += 1;
        }
      }

      const tao = quyetDinh.filter((q) => q.decision.action === "CREATE" || q.decision.action === "REVIEW");
      boQuaNgheNghia += quyetDinh.filter((q) => q.decision.action === "SKIP").length;
      if (!tao.length) continue;
      withHits += 1;

      const values = tao.map((q) => {
        const h = q.ungVien;
        const d = q.decision;
        /*
          KHOÁ CHỐNG TRÙNG BÁM **ĐOẠN SỰ VIỆC**, KHÔNG BÁM NGÀY CHẠY JOB.

          Bản cũ nhét NGÀY HÔM NAY vào khoá của "chưa tạo đơn", nên mỗi ngày job quét lại đẻ một
          case mới cho CÙNG một lần khách đưa thông tin — và máy đối chiếu ngay sau đó lại phải
          đóng chúng. Hàng đợi vì thế luôn có một tầng case cũ mà không ai hiểu từ đâu ra.

          Nay khoá bám mốc khách ĐƯA ĐỦ THÔNG TIN (đoạn sự việc thật). Khách đưa thông tin lần nữa
          vào hôm khác ⇒ đoạn mới ⇒ case mới, đúng như phải thế.
        */
        const tuKhoa = h.from === "KEYWORD" && h.signal ? ` (dấu hiệu: "${h.signal}")` : "";
        const ketLuan = d.verdict ? `\n— Máy đọc hội thoại: ${d.reason}` : "";
        return {
          dedupeKey: chatDedupeKey(conv.id, q.kind, duThongTin?.at ?? null),
          orderId: order?.id ?? null,
          customerId: order?.customerId ?? null,
          kind: q.kind,
          // MEDIUM không được thành việc phải làm — nó nằm ở làn "chờ người xem lại" (lib/constants/cs.ts).
          status: d.action === "REVIEW" ? "NEEDS_REVIEW" : "OPEN",
          source: "PANCAKE_CHAT",
          title: `${CS_KIND_LABEL[q.kind]} · ${conv.customerName || order?.billFullName || "Khách"}${order ? ` · đơn #${order.systemId ?? ""}` : ""}`,
          detail: `${h.evidence}${tuKhoa}${ketLuan}`.slice(0, 900),
          customerName: conv.customerName || order?.billFullName || "",
          customerPhone: phones[0] ?? order?.billPhone ?? "",
          chatUrl: pancakeChatUrl(page.id, conv.id),
          conversationId: conv.id,
          // Chỉ loại "đủ thông tin · chưa tạo đơn" mới có mốc này; loại khác để NULL = không áp dụng.
          infoCompleteAt: q.kind === "ORDER_NOT_CREATED" ? (duThongTin?.at ?? null) : null,
          semantic: toRecord(d) as unknown as Record<string, unknown>,
          createdBy: "pancake-chat",
        };
      });
      const inserted = await db.insert(schema.csCases).values(values).onConflictDoNothing({ target: schema.csCases.dedupeKey }).returning({ id: schema.csCases.id, kind: schema.csCases.kind, status: schema.csCases.status });
      created += inserted.length;
      needsReview += inserted.filter((r) => r.status === "NEEDS_REVIEW").length;
      /*
        KHÁCH NHẮC LẠI CÙNG MỘT VIỆC KHÔNG ĐẺ RA VIỆC THỨ HAI — nhưng cũng không được rơi vào im
        lặng. Khoá đã có ⇒ không chèn dòng mới; bằng chứng mới ghi vào LỊCH SỬ của chính case đó.

        Cố ý là `EVIDENCE` chứ không phải `NOTE`: ghi chú là thứ NGƯỜI xử lý viết ra và nó có cột
        riêng trên hàng đợi. Đổ bằng chứng máy vào đó là xoá đúng ranh giới vừa dựng lên.
      */
      const daCo = values.filter((v) => !inserted.some((i) => i.kind === v.kind));
      if (daCo.length) {
        const cu = await db.query.csCases.findMany({ where: inArray(schema.csCases.dedupeKey, daCo.map((v) => v.dedupeKey)), columns: { id: true, dedupeKey: true } });
        const themBangChung = cu.map((c) => {
          const v = daCo.find((x) => x.dedupeKey === c.dedupeKey)!;
          return { caseId: c.id, actorId: null, actorEmail: "", actorName: "Máy quét Pancake", source: "SYSTEM" as const, action: "EVIDENCE" as const, note: v.detail.slice(0, 900) };
        });
        if (themBangChung.length) {
          await db.insert(schema.csCaseEvents).values(themBangChung);
          evidenceAppended += themBangChung.length;
        }
      }
    }
    /*
      GHI PHỄU SAU MỖI PAGE, VÀ KHÔNG ĐƯỢC LÀM VỠ VIỆC CHÍNH.

      Bọc `.catch()` cố ý: việc chính của job này là tạo case CSKH. Nếu phép ghi phễu lỗi (ràng buộc,
      kiểu dữ liệu, mất kết nối) thì nó phải tự báo lỗi rồi nhường đường, KHÔNG được kéo theo cả lượt
      quét — mất case là mất đơn, còn mất một dòng phễu chỉ là mất một dòng thống kê.
    */
    if (funnelRows.length) {
      const loat = funnelRows.splice(0, funnelRows.length);
      funnelSaved += await upsertConversationFunnel(db, loat).catch((e) => {
        if (errors.length < 20) errors.push(`phễu hội thoại (${page.name}): ${e instanceof Error ? e.message : String(e)}`);
        return 0;
      });
    }
  }
  return {
    pages: pages.length,
    scanned,
    withHits,
    created,
    infoComplete: duThongTinTong,
    alreadyOrdered: daCoDon,
    ambiguous: nhapNhang,
    /** Số dòng phễu hội thoại đã ghi — đây là MẪU SỐ mà trước đây bị ném đi mỗi lượt quét. */
    funnelSaved,
    /** Số lượt gọi model THẬT — mỗi lượt là tiền. */
    semanticCalls,
    /** Hội thoại dùng lại kết luận cũ vì đầu vào không đổi — không tốn lượt gọi nào. */
    semanticCacheHits,
    /** Kết luận cũ quá hạn giữ đã dọn khỏi bộ nhớ đệm trong lượt này. */
    semanticCachePruned,
    /** Hội thoại KHÔNG được đọc hiểu vì chạm trần tiền AI ngày — là NỢ như `aiOff`, không phải "sạch". */
    semanticBudgetBlocked: phanhChan,
    budgetBlockedReason: phanhLy || null,
    /** Ứng viên bị bác — giả định / lời shop / chứng từ nói khác / chưa đủ chắc. */
    semanticRejected: boQuaNgheNghia,
    /** Hội thoại có dấu hiệu bằng chữ nhưng KHÔNG có tầng ngữ nghĩa để xét ⇒ không tạo việc. */
    aiOff: aiTat,
    /** Case ghi vào làn "chờ người xem lại" (mức tin cậy GIỮA) — không nằm trong hàng đợi phải làm. */
    needsReview,
    /** Bằng chứng mới nối vào case đã có, thay vì đẻ ra một việc thứ hai cho cùng đoạn sự việc. */
    evidenceAppended,
    errors: errors.slice(0, 20),
    errorCount: errors.length,
  };
}
