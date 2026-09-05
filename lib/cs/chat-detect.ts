/**
 * Đọc hội thoại Pancake (Pages API) → phát hiện case CSKH từ tin nhắn KHÁCH gửi và thẻ hội thoại:
 * tư vấn size chưa đúng, chốt sai giá, khách giục giao hàng, đổi size/màu, sai địa chỉ/SĐT, trả hàng, khiếu nại.
 */
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { CS_KIND_LABEL, type CsKind } from "@/lib/constants/cs";
import { loadCsRules, stripIgnored } from "@/lib/cs/detect";
import { env } from "@/lib/env";
import { getPancakePagesClient, type PancakeMessage } from "@/lib/integrations/pancake/pages";
import { normalize, stripHtml } from "@/lib/text";

export type ChatHit = { kind: CsKind; keyword: string; message: string };

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
      // gắn đơn: theo conversation_id, nếu không thì theo SĐT gần nhất (đơn chưa huỷ/xoá)
      const phones = conv.phones.map((p) => p.replace(/\D/g, "")).filter((p) => p.length >= 9);
      const order = await db.query.orders.findFirst({
        where: and(or(eq(schema.orders.conversationId, conv.id), phones.length ? inArray(schema.orders.billPhone, phones) : sql`false`), sql`${schema.orders.stage} not in ('CANCELLED','DELETED')`),
        orderBy: [desc(schema.orders.insertedAt)],
        columns: { id: true, customerId: true, billFullName: true, billPhone: true, systemId: true, insertedAt: true, stage: true },
      });
      // Chỉ tạo case sau mua khi khách đã có đơn và tin nhắn gửi sau lúc lên đơn; câu hỏi tư vấn trước mua không phải case
      const msgHits = detectFromMessages(recent, rules.chatRules, rules.ignorePatterns, { requireOrder: true, orderInsertedAt: order?.insertedAt ?? null, orderStage: order?.stage ?? null });
      const hits = [...tagHits, ...msgHits.filter((h) => !tagHits.some((t) => t.kind === h.kind))];
      if (!hits.length) continue;
      withHits += 1;
      const weekKey = new Date().toISOString().slice(0, 10);
      const values = hits.map((h) => ({
        dedupeKey: `pk-chat:${conv.id}:${h.kind}:${weekKey.slice(0, 7)}`,
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
        createdBy: "pancake-chat",
      }));
      const inserted = await db.insert(schema.csCases).values(values).onConflictDoNothing({ target: schema.csCases.dedupeKey }).returning({ id: schema.csCases.id });
      created += inserted.length;
    }
  }
  return { pages: pages.length, scanned, withHits, created, errors: errors.slice(0, 20), errorCount: errors.length };
}
