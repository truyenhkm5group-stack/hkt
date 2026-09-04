/**
 * Đọc hội thoại Pancake (Pages API) → phát hiện case CSKH từ tin nhắn KHÁCH gửi và thẻ hội thoại:
 * tư vấn size chưa đúng, chốt sai giá, khách giục giao hàng, đổi size/màu, sai địa chỉ/SĐT, trả hàng, khiếu nại.
 */
import { desc, eq, inArray, or, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { CS_KIND_LABEL, type CsKind } from "@/lib/constants/cs";
import { loadCsRules, stripIgnored } from "@/lib/cs/detect";
import { env } from "@/lib/env";
import { getPancakePagesClient, type PancakeMessage } from "@/lib/integrations/pancake/pages";
import { normalize } from "@/lib/text";

export type ChatHit = { kind: CsKind; keyword: string; message: string };

/** Tìm loại case trong danh sách tin nhắn khách (ưu tiên từ khoá dài, mỗi loại lấy tin đầu tiên khớp) */
export function detectFromMessages(messages: { text: string; fromPage: boolean }[], rules: { keyword: string; kind: CsKind }[], ignore: string[] = []): ChatHit[] {
  const sorted = [...rules].sort((a, b) => b.keyword.length - a.keyword.length);
  const hits = new Map<CsKind, ChatHit>();
  for (const m of messages) {
    if (m.fromPage || !m.text) continue;
    const cleaned = stripIgnored(m.text, ignore);
    if (!cleaned) continue;
    const n = normalize(cleaned);
    for (const r of sorted) {
      const k = normalize(r.keyword).trim();
      if (!k) continue;
      if (n.includes(` ${k} `) || (k.length >= 7 && n.includes(k))) {
        if (!hits.has(r.kind)) hits.set(r.kind, { kind: r.kind, keyword: r.keyword, message: m.text.slice(0, 300) });
      }
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
      const msgHits = detectFromMessages(recent, rules.chatRules, rules.ignorePatterns);
      const hits = [...tagHits, ...msgHits.filter((h) => !tagHits.some((t) => t.kind === h.kind))];
      if (!hits.length) continue;
      withHits += 1;
      // gắn đơn: theo conversation_id, nếu không thì theo SĐT gần nhất
      const phones = conv.phones.map((p) => p.replace(/\D/g, "")).filter((p) => p.length >= 9);
      const order = await db.query.orders.findFirst({
        where: or(eq(schema.orders.conversationId, conv.id), phones.length ? inArray(schema.orders.billPhone, phones) : sql`false`),
        orderBy: [desc(schema.orders.insertedAt)],
        columns: { id: true, customerId: true, billFullName: true, billPhone: true, systemId: true },
      });
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
