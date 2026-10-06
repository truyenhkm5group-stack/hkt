/**
 * ═══════════ HÀNG ĐỢI RÀ LỖI AI — ĐỌC SỔ + GHI QUYẾT ĐỊNH (luật ở `quality-shared.ts`) ═══════════
 *
 * Phát hiện TÍNH LÚC ĐỌC trên hội thoại thật bot đã trả lời trong kỳ (khung thử loại); quyết định của người là dòng
 * `sales_ai_reviews`. Ghi một quyết định chỉ được khi phát hiện ấy VẪN được luật tìm ra — không ai ghi được «đã rà» cho một
 * tin bất kỳ bằng cách sửa mã hội thoại / seq trên URL.
 */
import { and, asc, desc, eq, gte, inArray, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { dauNgayVN } from "@/lib/ai/budget";
import type { AiBlock } from "@/lib/ai/provider";
import { audit } from "@/lib/audit";
import { can, type SessionUser } from "@/lib/auth/session";
import { canUseModule } from "@/lib/platform/capabilities";
import { QUALITY_KINDS, QUALITY_SEVERITY, REVIEW_STATUSES, scanConversation, type QualityFinding, type QualityKind, type ReviewStatus, type ScanMessage } from "@/lib/sales-chatbot/quality-shared";
import { groundedPrices } from "@/lib/sales-chatbot/replay";
import { SALES_CHATBOT_MANAGE } from "@/lib/sales-chatbot/settings";

/** Trần số hội thoại quét mỗi lần mở màn (mới nhất trước) — màn rà không được làm chậm hộp thư. */
const SCAN_CAP = 300;

export type QualityItem = QualityFinding & {
  conversationId: string;
  channel: string;
  severity: "HIGH" | "MEDIUM" | "LOW";
  status: ReviewStatus | "OPEN";
  note: string | null;
  reviewerName: string | null;
  reviewedAt: string | null;
};

export type QualityQueue = {
  days: number;
  conversationsScanned: number;
  truncated: boolean;
  counts: Record<QualityKind, number>;
  open: number;
  confirmed: number;
  dismissed: number;
  items: QualityItem[];
};

async function loadMessages(ids: readonly string[]): Promise<Map<string, ScanMessage[]>> {
  const db = await getDb();
  const m = schema.salesChatMessages;
  const out = new Map<string, ScanMessage[]>();
  for (let i = 0; i < ids.length; i += 200) {
    const rows = await db
      .select({ conv: m.conversationId, seq: m.seq, role: m.role, content: m.content, at: m.createdAt })
      .from(m)
      .where(inArray(m.conversationId, ids.slice(i, i + 200)))
      .orderBy(asc(m.conversationId), asc(m.seq));
    for (const r of rows) {
      const list = out.get(r.conv) ?? [];
      list.push({ seq: r.seq, role: r.role === "assistant" ? "assistant" : "user", content: (Array.isArray(r.content) ? r.content : []) as AiBlock[], at: new Date(r.at) });
      out.set(r.conv, list);
    }
  }
  return out;
}

/** Hàng đợi rà của tổ chức NGỮ CẢNH. */
export async function loadQualityQueue(user: SessionUser, opts: { days?: number; now?: Date } = {}): Promise<{ ok: true; value: QualityQueue } | { error: string }> {
  if (!(await canUseModule("ai_sales"))) return { error: "Module AI bán hàng chưa bật." };
  if (!can(user, "ai_sales:view")) return { error: "Bạn không có quyền xem AI bán hàng." };
  const days = Math.min(Math.max(Math.trunc(opts.days ?? 7), 1), 30);
  const now = opts.now ?? new Date();
  const since = new Date(dauNgayVN(now).getTime() - (days - 1) * 86_400_000);
  const db = await getDb();
  const e = schema.salesConversationEvents;
  const c = schema.salesChatConversations;
  const convRows = await db
    .select({ id: e.conversationId, channel: sql<string>`max(${e.channel})`, last: sql<Date>`max(${e.occurredAt})` })
    .from(e)
    .where(and(gte(e.occurredAt, since), ne(e.channel, "TEST"), eq(e.type, "ai.replied")))
    .groupBy(e.conversationId)
    .orderBy(desc(sql`max(${e.occurredAt})`))
    .limit(SCAN_CAP + 1);
  const truncated = convRows.length > SCAN_CAP;
  const convs = convRows.slice(0, SCAN_CAP);
  const ids = convs.map((r) => r.id);
  const channelOf = new Map(convs.map((r) => [r.id, r.channel]));
  // Hội thoại đã bị xoá khỏi bảng hội thoại (sự kiện mồ côi) thì bỏ qua — không có gì để mở.
  const alive = ids.length ? new Set((await db.select({ id: c.id }).from(c).where(inArray(c.id, ids))).map((r) => r.id)) : new Set<string>();
  const messages = await loadMessages(ids.filter((id) => alive.has(id)));
  const grounded = await groundedPrices();
  const r = schema.salesAiReviews;
  const reviews = ids.length ? await db.select().from(r).where(inArray(r.conversationId, ids)) : [];
  const reviewOf = new Map(reviews.map((x) => [`${x.conversationId}:${x.messageSeq}:${x.kind}`, x]));

  const items: QualityItem[] = [];
  for (const [convId, msgs] of messages) {
    for (const f of scanConversation(msgs, grounded)) {
      if (f.at < since) continue;
      const rv = reviewOf.get(`${convId}:${f.seq}:${f.kind}`);
      items.push({ ...f, conversationId: convId, channel: channelOf.get(convId) ?? "", severity: QUALITY_SEVERITY[f.kind], status: (rv?.status as ReviewStatus | undefined) ?? "OPEN", note: rv?.note ?? null, reviewerName: rv?.reviewerName ?? null, reviewedAt: rv?.reviewedAt ? new Date(rv.reviewedAt).toISOString() : null });
    }
  }
  const rank = { HIGH: 0, MEDIUM: 1, LOW: 2 } as const;
  items.sort((a, b) => Number(a.status !== "OPEN") - Number(b.status !== "OPEN") || rank[a.severity] - rank[b.severity] || b.at.getTime() - a.at.getTime());
  const counts = Object.fromEntries(QUALITY_KINDS.map((k) => [k, items.filter((i) => i.kind === k).length])) as Record<QualityKind, number>;
  return {
    ok: true,
    value: {
      days,
      conversationsScanned: messages.size,
      truncated,
      counts,
      open: items.filter((i) => i.status === "OPEN").length,
      confirmed: items.filter((i) => i.status === "CONFIRMED").length,
      dismissed: items.filter((i) => i.status === "DISMISSED").length,
      items,
    },
  };
}

const reviewZ = z
  .object({
    conversationId: z.string().trim().min(1).max(200),
    seq: z.number().int().min(0),
    kind: z.enum(QUALITY_KINDS),
    status: z.enum(REVIEW_STATUSES),
    note: z.string().trim().max(500).default(""),
  })
  .strict();

/** Ghi quyết định rà. Chỉ người cấu hình bot (`ai_sales:manage`); phát hiện phải VẪN được luật tìm ra trên hội thoại đó. */
export async function reviewQualityFindingCore(user: SessionUser, raw: unknown, now: Date = new Date()): Promise<{ ok: true } | { error: string }> {
  if (!(await canUseModule("ai_sales"))) return { error: "Module AI bán hàng chưa bật." };
  if (!can(user, SALES_CHATBOT_MANAGE)) return { error: "Chỉ người cấu hình chatbot mới rà lỗi AI." };
  const parsed = reviewZ.safeParse(raw);
  if (!parsed.success) return { error: "Dữ liệu rà không hợp lệ." };
  const v = parsed.data;
  const db = await getDb();
  const [conv] = await db.select({ id: schema.salesChatConversations.id, channel: schema.salesChatConversations.channel }).from(schema.salesChatConversations).where(eq(schema.salesChatConversations.id, v.conversationId)).limit(1);
  if (!conv || conv.channel === "TEST") return { error: "Không có hội thoại này." };
  const msgs = (await loadMessages([conv.id])).get(conv.id) ?? [];
  const finding = scanConversation(msgs, await groundedPrices()).find((f) => f.seq === v.seq && f.kind === v.kind);
  if (!finding) return { error: "Luật rà không còn thấy lỗi này ở tin đó — tải lại trang." };
  // Tên người rà do MÁY CHỦ đọc từ `users` (AGENTS §34), không nhận từ client.
  const [me] = await db.select({ name: schema.users.name }).from(schema.users).where(eq(schema.users.id, user.id)).limit(1);
  const r = schema.salesAiReviews;
  const [before] = await db.select().from(r).where(and(eq(r.conversationId, conv.id), eq(r.messageSeq, v.seq), eq(r.kind, v.kind))).limit(1);
  const row = { status: v.status, note: v.note || null, reviewerUserId: user.id, reviewerName: me?.name ?? user.email, reviewedAt: now };
  await db
    .insert(r)
    .values({ conversationId: conv.id, messageSeq: v.seq, kind: v.kind, ...row })
    .onConflictDoUpdate({ target: [r.conversationId, r.messageSeq, r.kind], set: row });
  await audit({ userId: user.id, userEmail: user.email, action: "SALES_AI_REVIEW", entity: "SALES_CONVERSATION", entityId: conv.id, before: before ? { status: before.status, note: before.note } : null, after: { seq: v.seq, kind: v.kind, status: v.status, note: v.note || null }, reason: "Rà lỗi AI trên hội thoại thật" });
  return { ok: true };
}
