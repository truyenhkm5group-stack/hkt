/**
 * Dựng danh sách khách cần nhắn:
 *  - NURTURE: hội thoại Pancake có khách nhắn trong N giờ (24h hoặc 7 ngày) mà chưa có đơn → kịch bản nhiều bước, mỗi ngày một tin.
 *    Trước khi dựng, rà lại các mục đang chạy: khách đã đặt đơn → CONVERTED; khách trả lời sau tin cuối → REPLIED (nhân viên tiếp quản).
 *  - CROSS_SELL: đơn giao thành công từ N1–N2 ngày trước → tin gợi ý sản phẩm kèm (một bước).
 * Mỗi khách một kịch bản trong cooldownDays; không tạo lại mục đã gửi.
 */
import { and, desc, eq, gte, inArray, lte, or, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { normalizeOutreachConfig, OUTREACH_KEY, renderTemplate, shortName, type OutreachConfig, type TemplateVars } from "@/lib/constants/outreach";
import { getPancakePagesClient } from "@/lib/integrations/pancake/pages";
import { ORDER_OUTCOME } from "@/lib/queries/return-rate";
import { getSettingJson } from "@/lib/settings";

export async function loadOutreachConfig(): Promise<OutreachConfig> {
  const cfg = await getSettingJson<Partial<OutreachConfig> | null>(OUTREACH_KEY, null);
  return normalizeOutreachConfig(cfg);
}

function periodKey(cooldownDays: number) {
  return String(Math.floor(Date.now() / (Math.max(1, cooldownDays) * 86_400_000)));
}

export function nurtureVars(cfg: OutreachConfig, ten: string, goiY: string): TemplateVars {
  return { ten, san_pham: "", goi_y: goiY, shop: cfg.shopName, discountCode: cfg.discountCode, giam: cfg.nurtureDiscount };
}

/** Top sản phẩm bán chạy 30 ngày (để gợi ý bán chéo khi chưa cấu hình) */
async function bestSellers(limit = 6) {
  const db = await getDb();
  const rows = await db
    .select({ productId: schema.orderItems.productId, name: sql<string>`max(${schema.orderItems.productName})`, qty: sql<number>`sum(${schema.orderItems.quantity})` })
    .from(schema.orderItems)
    .innerJoin(schema.orders, eq(schema.orders.id, schema.orderItems.orderId))
    .where(and(gte(schema.orders.insertedAt, new Date(Date.now() - 30 * 86_400_000)), sql`${schema.orders.stage} not in ('CANCELLED','DELETED')`, sql`${schema.orderItems.productId} is not null`))
    .groupBy(schema.orderItems.productId)
    .orderBy(desc(sql`sum(${schema.orderItems.quantity})`))
    .limit(limit);
  return rows.filter((r) => r.productId).map((r) => ({ id: r.productId as string, name: r.name ?? "" }));
}

/** Khách (theo hội thoại / SĐT) đã có đơn chưa huỷ trong 30 ngày? */
async function hasRecentOrder(conversationId: string, phones: string[]) {
  const db = await getDb();
  const clean = phones.map((p) => p.replace(/\D/g, "")).filter((p) => p.length >= 9);
  const row = await db.query.orders.findFirst({
    where: and(
      or(conversationId ? eq(schema.orders.conversationId, conversationId) : sql`false`, clean.length ? inArray(schema.orders.billPhone, clean) : sql`false`),
      gte(schema.orders.insertedAt, new Date(Date.now() - 30 * 86_400_000)),
      sql`${schema.orders.stage} not in ('CANCELLED','DELETED')`,
    ),
    columns: { id: true },
  });
  return row?.id ?? null;
}

/** Rà các kịch bản băn khoăn đang chạy: đã mua → CONVERTED, khách trả lời → REPLIED */
export async function refreshNurtureTargets(log: (m: string) => void = () => undefined) {
  const db = await getDb();
  const client = getPancakePagesClient();
  const t = schema.outreachTargets;
  const active = await db.select().from(t).where(and(eq(t.segment, "NURTURE"), eq(t.status, "PENDING")));
  let converted = 0;
  let replied = 0;
  for (const row of active) {
    const orderId = await hasRecentOrder(row.conversationId, [row.phone]);
    if (orderId) {
      await db.update(t).set({ status: "CONVERTED", orderId, error: "", updatedAt: new Date() }).where(eq(t.id, row.id));
      converted += 1;
      continue;
    }
    if (row.sentCount > 0 && row.sentAt && row.pageId && row.conversationId) {
      try {
        const msgs = await client.listMessages(row.pageId, row.conversationId, row.pancakeCustomerId, 5);
        const latest = msgs.filter((m) => m.insertedAt).sort((a, b) => (b.insertedAt as Date).getTime() - (a.insertedAt as Date).getTime())[0];
        if (latest && !latest.fromPage && latest.insertedAt && latest.insertedAt > row.sentAt) {
          await db.update(t).set({ status: "REPLIED", context: (latest.text || "(khách gửi ảnh/tệp)").slice(0, 300), lastActivityAt: latest.insertedAt, updatedAt: new Date() }).where(eq(t.id, row.id));
          replied += 1;
        }
      } catch {
        // bỏ qua lỗi đọc tin từng hội thoại
      }
    }
  }
  log(`Rà kịch bản đang chạy: ${active.length} · đã mua ${converted} · khách trả lời ${replied}`);
  return { active: active.length, converted, replied };
}

export async function buildOutreachTargets(options: { segments?: ("NURTURE" | "CROSS_SELL")[]; windowHours?: number; log?: (m: string) => void } = {}) {
  const db = await getDb();
  const cfg = await loadOutreachConfig();
  const segments = options.segments ?? ["NURTURE", "CROSS_SELL"];
  const log = options.log ?? (() => undefined);
  const cycle = periodKey(cfg.cooldownDays);
  const result = { nurture: 0, crossSell: 0, scanned: 0, converted: 0, replied: 0, windowHours: options.windowHours ?? cfg.nurtureWindowHours, errors: [] as string[] };
  const productNames = new Map((await db.select({ id: schema.products.id, name: schema.products.name }).from(schema.products)).map((p) => [p.id, p.name]));
  const top = await bestSellers();

  if (segments.includes("CROSS_SELL")) {
    const from = new Date(Date.now() - cfg.crossSellToDays * 86_400_000);
    const to = new Date(Date.now() - cfg.crossSellFromDays * 86_400_000);
    const o = schema.orders;
    const s = schema.shipments;
    const delivered = await db
      .select({ id: o.id, customerId: o.customerId, name: o.billFullName, phone: o.billPhone, pageId: o.pageId, conversationId: o.conversationId, deliveredAt: sql<Date>`coalesce(${s.deliveredAt}, ${o.lastUpdateStatusAt}, ${o.insertedAt})` })
      .from(o)
      .leftJoin(s, eq(s.orderId, o.id))
      .where(and(sql`${ORDER_OUTCOME} = 'DELIVERED'`, gte(sql`coalesce(${s.deliveredAt}, ${o.lastUpdateStatusAt}, ${o.insertedAt})`, from), lte(sql`coalesce(${s.deliveredAt}, ${o.lastUpdateStatusAt}, ${o.insertedAt})`, to)))
      .orderBy(desc(o.insertedAt))
      .limit(1000);
    const seenCustomer = new Set<string>();
    for (const ord of delivered) {
      const key = ord.phone || ord.conversationId || ord.id;
      if (seenCustomer.has(key)) continue;
      seenCustomer.add(key);
      const items = await db.select({ productId: schema.orderItems.productId, productName: schema.orderItems.productName }).from(schema.orderItems).where(eq(schema.orderItems.orderId, ord.id));
      const boughtIds = new Set(items.map((i) => i.productId).filter(Boolean) as string[]);
      const everBought = ord.customerId
        ? new Set((await db.select({ productId: schema.orderItems.productId }).from(schema.orderItems).innerJoin(o, eq(o.id, schema.orderItems.orderId)).where(eq(o.customerId, ord.customerId))).map((r) => r.productId).filter(Boolean) as string[])
        : boughtIds;
      let suggestions: string[] = [];
      for (const pid of boughtIds) for (const sid of cfg.crossSellMap[pid] ?? []) if (!everBought.has(sid) && productNames.get(sid)) suggestions.push(productNames.get(sid) as string);
      if (!suggestions.length) suggestions = top.filter((t) => !everBought.has(t.id)).slice(0, 2).map((t) => t.name);
      suggestions = [...new Set(suggestions)].slice(0, 3);
      const sanPham = [...new Set(items.map((i) => i.productName).filter(Boolean))].slice(0, 2).join(", ");
      const ten = shortName(ord.name ?? "");
      const message = renderTemplate(cfg.crossSellTemplate, { ten, san_pham: sanPham, goi_y: suggestions.join(", "), shop: cfg.shopName, discountCode: cfg.discountCode });
      const inserted = await db
        .insert(schema.outreachTargets)
        .values({ segment: "CROSS_SELL", pageId: ord.pageId ?? "", conversationId: ord.conversationId ?? "", pancakeCustomerId: "", customerId: ord.customerId, orderId: ord.id, customerName: ord.name ?? "", phone: ord.phone ?? "", context: sanPham, suggestions: suggestions.join(", "), message, lastActivityAt: ord.deliveredAt ? new Date(ord.deliveredAt) : null, dedupeKey: `cross:${key}:${cycle}` })
        .onConflictDoNothing({ target: schema.outreachTargets.dedupeKey })
        .returning({ id: schema.outreachTargets.id });
      result.crossSell += inserted.length;
    }
  }

  if (segments.includes("NURTURE")) {
    const refreshed = await refreshNurtureTargets(log);
    result.converted = refreshed.converted;
    result.replied = refreshed.replied;
    const client = getPancakePagesClient();
    const hours = Math.max(1, options.windowHours ?? cfg.nurtureWindowHours);
    const since = new Date(Date.now() - hours * 3_600_000);
    const pageRows = await db.select({ pageId: schema.orders.pageId }).from(schema.orders).where(sql`${schema.orders.pageId} is not null and ${schema.orders.insertedAt} >= now() - interval '90 days'`).groupBy(schema.orders.pageId);
    const allowed = new Set(pageRows.map((r) => r.pageId).filter(Boolean) as string[]);
    // hội thoại đã có kịch bản (đang chạy hoặc kết thúc trong cooldown) → không tạo lại
    const existing = await db
      .select({ conversationId: schema.outreachTargets.conversationId })
      .from(schema.outreachTargets)
      .where(and(eq(schema.outreachTargets.segment, "NURTURE"), or(eq(schema.outreachTargets.status, "PENDING"), gte(schema.outreachTargets.updatedAt, new Date(Date.now() - cfg.cooldownDays * 86_400_000)))));
    const skipConv = new Set(existing.map((e) => e.conversationId));
    let pages: { id: string; name: string }[] = [];
    try {
      pages = (await client.listPages()).filter((p) => allowed.has(p.id));
    } catch (e) {
      result.errors.push(e instanceof Error ? e.message : String(e));
    }
    const goiY = top.slice(0, 2).map((t) => t.name).join(", ");
    for (const page of pages) {
      let convs;
      try {
        convs = await client.listConversations(page.id, since, new Date(), 300);
      } catch (e) {
        result.errors.push(`${page.name}: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      log(`Page ${page.name}: ${convs.length} hội thoại`);
      for (const conv of convs) {
        result.scanned += 1;
        if (skipConv.has(conv.id)) continue;
        const phones = conv.phones.map((p) => p.replace(/\D/g, "")).filter((p) => p.length >= 9);
        if (await hasRecentOrder(conv.id, phones)) continue;
        // cần tin nhắn từ khách (không phải page) trong cửa sổ
        let lastCustomerText = conv.snippet;
        let lastCustomerAt = conv.updatedAt;
        if (conv.customerId) {
          try {
            const msgs = await client.listMessages(page.id, conv.id, conv.customerId, 20);
            const fromCustomer = msgs.filter((m) => !m.fromPage && m.text && (!m.insertedAt || m.insertedAt >= since));
            if (!fromCustomer.length) continue;
            const last = fromCustomer[fromCustomer.length - 1];
            lastCustomerText = last.text;
            lastCustomerAt = last.insertedAt ?? lastCustomerAt;
          } catch (e) {
            if (result.errors.length < 10) result.errors.push(`${conv.id}: ${e instanceof Error ? e.message : String(e)}`);
            continue;
          }
        }
        const ten = shortName(conv.customerName);
        const message = renderTemplate(cfg.nurtureSteps[0], nurtureVars(cfg, ten, goiY));
        const inserted = await db
          .insert(schema.outreachTargets)
          .values({ segment: "NURTURE", pageId: page.id, conversationId: conv.id, pancakeCustomerId: conv.customerId, customerName: conv.customerName, phone: phones[0] ?? "", context: lastCustomerText.slice(0, 300), suggestions: goiY, message, step: 0, nextAt: null, lastActivityAt: lastCustomerAt, dedupeKey: `nurture:${conv.id}:${cycle}` })
          .onConflictDoNothing({ target: schema.outreachTargets.dedupeKey })
          .returning({ id: schema.outreachTargets.id });
        result.nurture += inserted.length;
      }
    }
  }
  return result;
}
