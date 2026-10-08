/**
 * ═══════════ LEVEL KHÁCH + SĐT CỦA HỘI THOẠI — CHỈ MÁY CHỦ ═══════════
 *
 * Phân loại thuần ở `levels-shared.ts`; tệp này ĐỌC dữ liệu của một hội thoại (tin khách của lượt mua đang xét, sổ trạng thái
 * bot, đơn còn sống) rồi ghi KẾT QUẢ vào `sales_chat_conversations.customer_level / customer_phone / level_at` để hộp thư lọc
 * và đếm nhanh. Ai gọi:
 *  · job `sales-followup` (5 phút) — `refreshConversationLevels()`: hội thoại có hoạt động mới hơn lần tính, cộng một ít hội
 *    thoại cũ chưa tính (lấp dần, không backfill một lần);
 *  · lượt trả lời của bot — `levelPromptFor()` tính lại NGAY rồi đưa kịch bản của level vào lời nhắc.
 * Không ném — level là phụ trợ, lỗi không được chặn bot hay job.
 */
import { and, desc, eq, gt, inArray, isNull, ne, notInArray, or, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { currentOrganization } from "@/lib/platform/context";
import { findOrganization } from "@/lib/platform/organizations";
import { getSettingJson, setSettingJson } from "@/lib/settings";
import { audit } from "@/lib/audit";
import { can, type SessionUser } from "@/lib/auth/session";
import { canUseModule } from "@/lib/platform/capabilities";
import { SALES_CHATBOT_MANAGE } from "@/lib/sales-chatbot/settings";
import { classifyCustomerLevel, levelScriptPrompt, LEVEL_SCRIPTS_SETTING_KEY, parseLevelScripts, type CustomerLevel, type LevelPack, type LevelScripts } from "@/lib/sales-chatbot/levels-shared";
import { salesPackFor } from "@/lib/sales-chatbot/packs";
import { normalizeVnPhone, vouchedOrder } from "@/lib/sales-chatbot/returning";
import type { ChatState } from "@/lib/sales-chatbot/tools";

/** Lượt mua đang xét: tin khách SAU đơn gần nhất của hội thoại, tối đa chừng này ngày. */
const CYCLE_DAYS = 7;
/** Đơn còn sống trong chừng này ngày ⇒ «Đã chốt đơn». */
const ORDERED_DAYS = 3;
export const LEVEL_REFRESH_LIMITS = { perRun: 200, backfillPerRun: 100, backfillDays: 30 } as const;

const SKIP_NOTES = ["BOT_SENT", "PAGE_REPLY", "MEDIA_ONLY"];
const PHONE_ALL = /(?:\+?84|0)(?:[\s.-]?\d){8,10}/g;

function lastPhone(texts: readonly string[]): string | null {
  for (let i = texts.length - 1; i >= 0; i--) {
    const all = [...texts[i].matchAll(PHONE_ALL)].map((m) => normalizeVnPhone(m[0])).filter((x): x is string => Boolean(x));
    const p = all[all.length - 1];
    if (p) return p.length === 11 && !p.startsWith("02") ? p.slice(0, 10) : p;
  }
  return null;
}

let packCache: { code: string; pack: LevelPack } | null = null;
async function orgPack(): Promise<LevelPack> {
  const org = await currentOrganization();
  if (packCache?.code === org.code) return packCache.pack;
  const row = await findOrganization(org.code);
  const pack = salesPackFor(row?.templateKey ?? null).key;
  packCache = { code: org.code, pack };
  return pack;
}

/** Gói ngành của tổ chức ngữ cảnh — trang hộp thư dùng để biết level nào hiện. */
export async function organizationLevelPack(): Promise<LevelPack> {
  return orgPack();
}

type ConvRow = { id: string; channel: string; pageId: string | null; threadId: string | null; customerId: string | null; state: unknown; lastBotAt: Date | null; lastCustomerAt: Date | null };

/** Tính level + SĐT của MỘT hội thoại (không ghi). */
async function computeLevel(c: ConvRow, pack: LevelPack, now: Date): Promise<{ level: CustomerLevel; phone: string | null }> {
  const db = await getDb();
  const st = (c.state ?? {}) as ChatState & { pancakePhones?: unknown };
  const o = schema.orders;
  // Đơn của hồ sơ khách chỉ tính khi có người đứng sau (`vouchedOrder`) — đơn máy của hội thoại KHÁC không nâng mức khách này
  // (review bảo mật #651, L4). Đơn của CHÍNH hội thoại luôn tính.
  const liveOrder = and(or(eq(o.salesConversationId, c.id), c.customerId ? and(eq(o.customerId, c.customerId), vouchedOrder(o)) : sql`false`), notInArray(o.stage, ["CANCELLED", "DELETED"]));
  const [lastOrder] = await db.select({ at: o.insertedAt }).from(o).where(liveOrder).orderBy(desc(o.insertedAt)).limit(1);
  const cycleFrom = new Date(Math.max(now.getTime() - CYCLE_DAYS * 86_400_000, lastOrder ? lastOrder.at.getTime() : 0));
  let customerTexts: string[] = [];
  if (c.pageId && c.threadId) {
    const t = schema.salesChatInbound;
    const rows = await db
      .select({ text: t.text, note: t.note })
      .from(t)
      .where(and(eq(t.pageId, c.pageId), eq(t.threadId, c.threadId), eq(t.kind, "INBOX"), gt(t.createdAt, cycleFrom)))
      .orderBy(t.createdAt)
      .limit(200);
    customerTexts = rows.filter((r) => !SKIP_NOTES.includes(r.note ?? "")).map((r) => r.text);
  } else {
    const m = schema.salesChatMessages;
    const rows = await db.select({ content: m.content }).from(m).where(and(eq(m.conversationId, c.id), eq(m.role, "user"), gt(m.createdAt, cycleFrom))).orderBy(m.seq).limit(200);
    customerTexts = rows.map((r) => (Array.isArray(r.content) ? (r.content as { type?: string; text?: string }[]).map((b) => (b.type === "text" ? (b.text ?? "") : "")).join(" ") : ""));
  }
  const hasOpenOrder = Boolean(lastOrder && now.getTime() - lastOrder.at.getTime() <= ORDERED_DAYS * 86_400_000 && !customerTexts.length) || Boolean(st.confirmed && st.confirmed.at && now.getTime() - Date.parse(st.confirmed.at) <= ORDERED_DAYS * 86_400_000 && !customerTexts.length);
  const level = classifyCustomerLevel({
    pack,
    customerTexts,
    statePhone: Boolean(st.customer?.phone),
    stateAddress: Boolean(st.customer?.address),
    stateItems: Boolean(st.draft?.lines?.length),
    stage: st.stage ?? null,
    hasOpenOrder,
    repliedAfterUpsell: Boolean(st.stage === "UPSELL" && c.lastCustomerAt && c.lastBotAt && c.lastCustomerAt > c.lastBotAt),
  });
  const pancake = Array.isArray(st.pancakePhones) ? (st.pancakePhones as unknown[]).map((x) => normalizeVnPhone(String(x ?? ""))).find(Boolean) ?? null : null;
  const phone = lastPhone(customerTexts) ?? (st.customer?.phone ? normalizeVnPhone(st.customer.phone) : null) ?? pancake;
  return { level, phone };
}

const COLS = { id: schema.salesChatConversations.id, channel: schema.salesChatConversations.channel, pageId: schema.salesChatConversations.pageId, threadId: schema.salesChatConversations.threadId, customerId: schema.salesChatConversations.customerId, state: schema.salesChatConversations.state, lastBotAt: schema.salesChatConversations.lastBotAt, lastCustomerAt: schema.salesChatConversations.lastCustomerAt };

async function save(id: string, r: { level: CustomerLevel; phone: string | null }, now: Date): Promise<void> {
  const db = await getDb();
  const c = schema.salesChatConversations;
  // KHÔNG chạm `updated_at` (đồng hồ «nhân viên đang trả lời» của bot) và không đẩy hội thoại lên đầu hộp thư.
  await db.execute(sql`update ${c} set customer_level = ${r.level}, customer_phone = ${r.phone}, level_at = ${now} where id = ${id}`);
}

/** Tính lại level của MỘT hội thoại và ghi. Trả level mới (`null` nếu không đọc được). Không ném. */
export async function refreshConversationLevel(conversationId: string, now: Date = new Date()): Promise<CustomerLevel | null> {
  try {
    const db = await getDb();
    const [row] = await db.select(COLS).from(schema.salesChatConversations).where(eq(schema.salesChatConversations.id, conversationId)).limit(1);
    if (!row) return null;
    const r = await computeLevel(row, await orgPack(), now);
    await save(row.id, r, now);
    return r.level;
  } catch {
    return null;
  }
}

/**
 * Lượt của job: hội thoại có tin / bot / nhân viên MỚI hơn lần tính level (tối đa `perRun`), rồi lấp dần hội thoại 30 ngày
 * chưa từng tính (`backfillPerRun`). Không ném.
 */
export async function refreshConversationLevels(now: Date = new Date()): Promise<{ refreshed: number; errors: number }> {
  const out = { refreshed: 0, errors: 0 };
  try {
    const db = await getDb();
    const c = schema.salesChatConversations;
    const pack = await orgPack();
    const activity = sql`greatest(coalesce(${c.lastCustomerAt}, 'epoch'), coalesce(${c.lastBotAt}, 'epoch'), coalesce(${c.lastStaffAt}, 'epoch'))`;
    const stale = await db
      .select(COLS)
      .from(c)
      .where(and(ne(c.channel, "TEST"), sql`${c.levelAt} is not null`, sql`${activity} > ${c.levelAt}`))
      .orderBy(desc(activity))
      .limit(LEVEL_REFRESH_LIMITS.perRun);
    const fresh = await db
      .select(COLS)
      .from(c)
      .where(and(ne(c.channel, "TEST"), isNull(c.levelAt), sql`${activity} > ${new Date(now.getTime() - LEVEL_REFRESH_LIMITS.backfillDays * 86_400_000)}`))
      .orderBy(desc(activity))
      .limit(LEVEL_REFRESH_LIMITS.backfillPerRun);
    for (const row of [...stale, ...fresh]) {
      try {
        await save(row.id, await computeLevel(row, pack, now), now);
        out.refreshed += 1;
      } catch {
        out.errors += 1;
      }
    }
  } catch {
    out.errors += 1;
  }
  return out;
}

/** Dòng kịch bản theo level cho lời nhắc của bot — tính lại level NGAY (tin khách vừa tới). '' khi shop chưa viết. Không ném. */
export async function levelPromptFor(conversationId: string, now: Date = new Date()): Promise<string> {
  try {
    const scripts = parseLevelScripts(await getSettingJson<unknown>(LEVEL_SCRIPTS_SETTING_KEY, {}));
    if (!Object.keys(scripts).length) return "";
    return levelScriptPrompt(await refreshConversationLevel(conversationId, now), scripts);
  } catch {
    return "";
  }
}

/** Đếm hội thoại theo level (trang hộp thư / cài đặt). */
export async function levelCounts(ids?: readonly string[]): Promise<Record<string, number>> {
  const db = await getDb();
  const c = schema.salesChatConversations;
  const rows = await db
    .select({ level: c.customerLevel, n: sql<number>`count(*)::int` })
    .from(c)
    .where(and(ne(c.channel, "TEST"), ids?.length ? inArray(c.id, [...ids]) : undefined))
    .groupBy(c.customerLevel);
  return Object.fromEntries(rows.map((r) => [r.level ?? "", Number(r.n)]));
}

/** Kịch bản theo level đang lưu của tổ chức ngữ cảnh. */
export async function loadLevelScripts(): Promise<LevelScripts> {
  return parseLevelScripts(await getSettingJson<unknown>(LEVEL_SCRIPTS_SETTING_KEY, {}));
}

/** Chủ shop lưu kịch bản theo level (ô trống = bỏ kịch bản của level đó). Quyền cấu hình chatbot. */
export async function saveLevelScripts(user: SessionUser, raw: unknown): Promise<{ ok: true; message: string } | { error: string }> {
  if (!(await canUseModule("ai_sales"))) return { error: "Module AI bán hàng chưa bật." };
  if (!can(user, SALES_CHATBOT_MANAGE)) return { error: "Bạn không có quyền cấu hình chatbot bán hàng (ai_sales:manage)." };
  const before = await loadLevelScripts();
  const next = parseLevelScripts(raw);
  await setSettingJson(LEVEL_SCRIPTS_SETTING_KEY, next);
  await audit({ userId: user.id, userEmail: user.email, action: "SALES_LEVEL_SCRIPTS", entity: "SETTINGS", entityId: LEVEL_SCRIPTS_SETTING_KEY, before, after: next, reason: "Sửa kịch bản chat theo level khách" });
  return { ok: true, message: `Đã lưu kịch bản cho ${Object.keys(next).length} level — bot dùng từ lượt trả lời kế tiếp.` };
}
