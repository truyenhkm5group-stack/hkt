/**
 * Đọc hội thoại Pancake (Pages API) → phát hiện case CSKH từ tin nhắn KHÁCH gửi và thẻ hội thoại:
 * tư vấn size chưa đúng, chốt sai giá, khách giục giao hàng, đổi size/màu, sai địa chỉ/SĐT, trả hàng, khiếu nại.
 */
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { CS_KIND_LABEL, type CsKind } from "@/lib/constants/cs";
import { loadCsRules, stripIgnored } from "@/lib/cs/detect";
import { env } from "@/lib/env";
import { getPancakePagesClient, type PancakeMessage } from "@/lib/integrations/pancake/pages";
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
  let sdt: { at: Date | null; text: string; value: string } | null = null;
  let diaChi: { at: Date | null; text: string } | null = null;

  for (const m of messages) {
    if (m.fromPage || !m.text) continue;
    const plain = stripHtml(m.text);
    const n = normalize(plain);
    const khopSdt = SDT.exec(plain);
    if (khopSdt && (!sdt || (m.insertedAt && (!sdt.at || m.insertedAt > sdt.at)))) {
      sdt = { at: m.insertedAt, text: plain.slice(0, 240), value: khopSdt[1].replace(/\D/g, "") };
    }
    if (DIA_CHI.test(n) && (!diaChi || (m.insertedAt && (!diaChi.at || m.insertedAt > diaChi.at)))) {
      diaChi = { at: m.insertedAt, text: plain.slice(0, 240) };
    }
  }

  // SĐT do Pancake tách sẵn cũng tính — nhưng KHÔNG thay được địa chỉ.
  const soPancake = convPhones.map((p) => p.replace(/\D/g, "")).find((p) => p.length >= 9);
  const soCuoi = sdt?.value ?? soPancake ?? "";
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
  const errors: string[] = [];
  for (const page of pages) {
    let conversations;
    try {
      conversations = await client.listConversations(page.id, since, until, options.limitPerPage ?? 200);
    } catch (e) {
      errors.push(`${page.name}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    log(`Page ${page.name}: ${conversations.length} hội thoại từ ${since.toISOString()}`);
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
      // Chỉ tạo case sau mua khi khách đã có đơn và tin nhắn gửi sau lúc lên đơn; câu hỏi tư vấn trước mua không phải case
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
          if (!hasNewOrder) {
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
      const hits = [...closeHits, ...tagHits.filter((t) => !closeHits.some((c) => c.kind === t.kind)), ...msgHits.filter((h) => ![...tagHits, ...closeHits].some((t) => t.kind === h.kind))];
      if (!hits.length) continue;
      withHits += 1;
      const weekKey = new Date().toISOString().slice(0, 10);
      const values = hits.map((h) => ({
        // "chưa tạo đơn" là việc gấp: mở lại case mỗi ngày nếu vẫn chưa có đơn; các loại khác gom theo tháng
        dedupeKey: `pk-chat:${conv.id}:${h.kind}:${h.kind === "ORDER_NOT_CREATED" ? weekKey : weekKey.slice(0, 7)}`,
        orderId: order?.id ?? null,
        customerId: order?.customerId ?? null,
        kind: h.kind,
        status: "OPEN",
        source: "PANCAKE_CHAT",
        title: `${CS_KIND_LABEL[h.kind]} · ${conv.customerName || order?.billFullName || "Khách"}${order ? ` · đơn #${order.systemId ?? ""}` : ""}`,
        detail: `${h.message}${h.keyword && !h.message.startsWith("Thẻ") ? ` (từ khoá: "${h.keyword}")` : ""}`.slice(0, 900),
        customerName: conv.customerName || order?.billFullName || "",
        customerPhone: phones[0] ?? order?.billPhone ?? "",
        chatUrl: pancakeChatUrl(page.id, conv.id),
        conversationId: conv.id,
        // Chỉ loại "đủ thông tin · chưa tạo đơn" mới có mốc này; loại khác để NULL = không áp dụng.
        infoCompleteAt: h.kind === "ORDER_NOT_CREATED" ? (duThongTin?.at ?? null) : null,
        createdBy: "pancake-chat",
      }));
      const inserted = await db.insert(schema.csCases).values(values).onConflictDoNothing({ target: schema.csCases.dedupeKey }).returning({ id: schema.csCases.id });
      created += inserted.length;
    }
  }
  return { pages: pages.length, scanned, withHits, created, infoComplete: duThongTinTong, alreadyOrdered: daCoDon, ambiguous: nhapNhang, errors: errors.slice(0, 20), errorCount: errors.length };
}
