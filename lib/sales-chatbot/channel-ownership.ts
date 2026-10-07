/**
 * ═══════════ MỘT PAGE — MỘT ĐƯỜNG NHẬN TIN CANONICAL (docs/messaging-providers.md §3 · 0232) ═══════════
 *
 * Một shop có thể nối CÙNG một Facebook page qua Pancake VÀ qua Meta trực tiếp (Messenger / Instagram). Hai đường cùng nhận một
 * tin khách, mỗi đường mở một hội thoại riêng (Pancake khoá theo mã hội thoại của Pancake, Messenger theo PSID), hai bot cùng trả
 * lời, và câu của bot này về tới đường kia như «tin của nhân viên» ⇒ bot kia nhường. Luật TẤT ĐỊNH: mỗi page có ĐÚNG MỘT đường
 * được kích AI — `connection_mode` canonical LƯU ĐƯỢC (`channel_page_modes`):
 *  · `PANCAKE_WEBHOOK` ⇒ chỉ đường Pancake ghi tin + kích AI; Meta trực tiếp nhường MỌI gói tin của page.
 *  · `META_DIRECT`     ⇒ ngược lại.
 *  · Page CHƯA có dòng (page có trước 0232 mà backfill không thấy, hoặc đường vừa nối không qua `connectMessengerPages`) ⇒ LUẬT CŨ:
 *    Pancake thắng. Không đoán.
 *  · Đường canonical ĐÃ LƯU mà không chạy (gỡ kết nối…) ⇒ KHÔNG đường nào kích AI; đường kia vẫn GHI tin khách (người thấy ở hộp
 *    thư) với ghi chú `NON_CANONICAL_NOTE` — không tự đổi đường (chủ shop 07/10/2026: chuyển đường là thao tác tường minh).
 * Page MỚI nối Meta trực tiếp (Pancake không chạy page đó) ⇒ dòng `META_DIRECT` (nguồn `CONNECT`) — page mới ưu tiên Meta trực tiếp.
 *
 * KHỬ TRÙNG HAI NGUỒN (`insertCustomerInbound`): mã tin Pancake có trùng `mid` của Meta hay không CHƯA được chứng minh ở đâu trong
 * kho mã (fixture Pancake dùng mã tự đặt; không gói thật nào trong kho). Nếu trùng, chỉ mục UNIQUE `message_id` đã gộp sẵn. Nếu
 * không, khoá thứ hai: (page, PSID chuẩn, chữ chuẩn hoá) trong `DUP_WINDOW_MS`, KHÁC đường — đếm số bản của đường kia so với số bản
 * của chính đường này nên khách nhắn cùng một chữ hai lần vẫn là hai tin. Giới hạn: tin chỉ có ảnh (URL CDN hai đường khác nhau) và
 * gói Pancake thiếu mã người gửi KHÔNG khử trùng được theo khoá thứ hai — lớp chặn chính vẫn là luật một-đường ở trên.
 */
import { and, desc, eq, gte, isNotNull, isNull, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { can, type SessionUser } from "@/lib/auth/session";
import { listChannelPages, messagingConnectionSummaries } from "@/lib/connectors/service";
import { CONNECTION_MODE_LABEL, CONNECTION_MODES, MODE_TRANSPORT, TRANSPORT_MODE, type ConnectionMode, type ModeSource, type PageRouteView, type TransportOwner } from "@/lib/sales-chatbot/channel-ownership-shared";

export { CONNECTION_MODE_LABEL, CONNECTION_MODES, MODE_TRANSPORT, TRANSPORT_MODE };
export type { ConnectionMode, ModeSource, PageRouteView, TransportOwner };

/** Khoá kết nối — giữ ở đây (không import từ fanpage.ts / messenger.ts) để hai tệp đó import được tệp này mà không vòng. */
export const PANCAKE_FANPAGE_KEY = "pancake-fanpage";
export const MESSENGER_DIRECT_KEY = "facebook-messenger";

export type TransportFacts = {
  pancake: { active: boolean; pageId: string | null };
  messenger: { active: boolean; pageIds: readonly string[] };
  /** Đường canonical ĐÃ LƯU theo page (0232). Thiếu ⇒ luật cũ cho mọi page. */
  modes?: Readonly<Record<string, ConnectionMode>>;
};

export const PANCAKE_OWNS_PAGE_REASON = "Page đang nối qua Pancake — tin đi đường Pancake, Messenger trực tiếp nhường để khách không nhận hai câu trả lời";
export const MESSENGER_OWNS_PAGE_REASON = "Page nhận tin qua Meta trực tiếp — đường Pancake nhường để khách không nhận hai câu trả lời";
/** Ghi chú của dòng tin khách do đường KHÔNG canonical ghi (đường canonical đã lưu mà không chạy) — lưu cho người đọc, không kích AI. */
export const NON_CANONICAL_NOTE = "Đường nhận tin chính của page chưa chạy — tin lưu cho người đọc, AI không trả lời qua đường phụ";
export const DUPLICATE_SOURCE_REASON = "Cùng tin khách đã tới qua đường nhận tin kia — không ghi lần hai, không gọi AI lần hai";
/** Cửa sổ khử trùng hai nguồn: Meta / Pancake chuyển một tin trong vài giây; 2 phút là dư mà vẫn đủ ngắn để không nuốt tin thật. */
export const DUP_WINDOW_MS = 120_000;

/** Đường nào đang CHẠY cho page (kết nối bật + page thuộc kết nối). HÀM THUẦN. */
export function liveTransportsOf(f: TransportFacts, pageId: string): Record<TransportOwner, boolean> {
  const id = pageId.trim();
  return { PANCAKE: Boolean(id) && f.pancake.active && f.pancake.pageId === id, MESSENGER: Boolean(id) && f.messenger.active && f.messenger.pageIds.includes(id) };
}

/**
 * Đường được KÍCH AI cho `pageId`. Có dòng canonical ⇒ đúng đường đó nếu nó đang chạy, không thì `null` (không tự đổi đường). Không
 * dòng ⇒ luật cũ: cả hai cùng bật ⇒ PANCAKE. Không đường nào ⇒ `null`. HÀM THUẦN.
 */
export function transportOwnerOf(f: TransportFacts, pageId: string): TransportOwner | null {
  const live = liveTransportsOf(f, pageId);
  const mode = f.modes?.[pageId.trim()];
  if (mode) return live[MODE_TRANSPORT[mode]] ? MODE_TRANSPORT[mode] : null;
  if (live.PANCAKE) return "PANCAKE";
  if (live.MESSENGER) return "MESSENGER";
  return null;
}

/** Page mà đường Messenger trực tiếp đang NHƯỜNG Pancake (cả hai cùng bật, Pancake canonical) — để màn hình báo. HÀM THUẦN. */
export function dualConnectedPages(f: TransportFacts): string[] {
  const id = f.pancake.pageId;
  return id && f.pancake.active && f.messenger.pageIds.includes(id) && transportOwnerOf(f, id) === "PANCAKE" ? [id] : [];
}

/**
 * Phán quyết cho MỘT gói tin tới qua đường `me`: `CANONICAL` (ghi + kích AI như thường) · `OTHER_OWNS` (đường kia canonical và đang
 * chạy ⇒ bỏ gói này, đường kia đã ghi) · `CANONICAL_DOWN` (đường canonical đã lưu mà không chạy ⇒ ghi tin khách cho người đọc,
 * KHÔNG kích AI). HÀM THUẦN.
 */
export type RouteVerdict = "CANONICAL" | "OTHER_OWNS" | "CANONICAL_DOWN";
export function routeVerdict(f: TransportFacts, pageId: string, me: TransportOwner): RouteVerdict {
  const owner = transportOwnerOf(f, pageId);
  if (owner === me) return "CANONICAL";
  return owner ? "OTHER_OWNS" : "CANONICAL_DOWN";
}

/** Đường canonical đã lưu của mọi page (bảng nhỏ — một dòng mỗi page). Lỗi đọc ⇒ `{}` (luật cũ — đường Pancake đang chạy không gãy). */
export async function loadPageModes(): Promise<Record<string, ConnectionMode>> {
  try {
    const rows = await (await getDb()).select({ pageId: schema.channelPageModes.pageId, mode: schema.channelPageModes.mode }).from(schema.channelPageModes);
    const out: Record<string, ConnectionMode> = {};
    for (const r of rows) if ((CONNECTION_MODES as readonly string[]).includes(r.mode)) out[r.pageId] = r.mode as ConnectionMode;
    return out;
  } catch {
    return {};
  }
}

/** Đọc trạng thái hai kết nối + đường canonical của tổ chức NGỮ CẢNH (chỉ đọc ô cài đặt không bí mật). */
export async function loadTransportFacts(): Promise<TransportFacts> {
  const rows = await messagingConnectionSummaries([PANCAKE_FANPAGE_KEY, MESSENGER_DIRECT_KEY]);
  const p = rows.find((r) => r.connectorKey === PANCAKE_FANPAGE_KEY);
  const m = rows.find((r) => r.connectorKey === MESSENGER_DIRECT_KEY);
  const ids = (s: Record<string, string>) => [s.pageId, s.igAccountId].map((x) => (x ?? "").trim()).filter(Boolean);
  // Nhiều page (0220): page đã nối thẳng = hàng page đang bật + page của hàng kết nối đơn cũ chưa có hàng riêng.
  const pageRows = await listChannelPages(MESSENGER_DIRECT_KEY);
  const known = new Set(pageRows.map((r) => r.pageId));
  const legacy = m?.status === "ACTIVE" ? ids(m.plainSettings).filter((x) => !known.has(x)) : [];
  const pageIds = [...new Set([...pageRows.filter((r) => r.status === "ACTIVE").map((r) => r.pageId), ...legacy])];
  return {
    pancake: { active: p?.status === "ACTIVE", pageId: (p?.plainSettings.pageId ?? "").trim() || null },
    messenger: { active: pageIds.length > 0, pageIds },
    modes: await loadPageModes(),
  };
}

/**
 * Ghi đường canonical của một page (nguồn + lý do + người). Trả đường TRƯỚC đó (`null` = chưa có dòng). Không kiểm quyền — chỉ gọi
 * từ đường đã kiểm (lõi nối / gỡ Messenger, `setPageConnectionModeCore`).
 */
export async function recordPageMode(pageId: string, mode: ConnectionMode, source: ModeSource, reason: string, userId: string | null): Promise<ConnectionMode | null> {
  const db = await getDb();
  const m = schema.channelPageModes;
  const [before] = await db.select({ mode: m.mode }).from(m).where(eq(m.pageId, pageId)).limit(1);
  await db
    .insert(m)
    .values({ pageId, mode, source, reason: reason.slice(0, 300), setByUserId: userId })
    .onConflictDoUpdate({ target: m.pageId, set: { mode, source, reason: reason.slice(0, 300), setByUserId: userId, updatedAt: new Date() } });
  return (before?.mode as ConnectionMode | undefined) ?? null;
}

/** Mọi page có dòng canonical hoặc đang nối qua ít nhất một đường — cho khung «Đường nhận tin» của hộp thư. */
export async function listPageRoutes(): Promise<PageRouteView[]> {
  const facts = await loadTransportFacts();
  const db = await getDb();
  const m = schema.channelPageModes;
  const rows = await db
    .select()
    .from(m)
    .catch(() => [] as (typeof m.$inferSelect)[]);
  const byId = new Map(rows.map((r) => [r.pageId, r]));
  const ids = new Set<string>([...byId.keys(), ...(facts.pancake.active && facts.pancake.pageId ? [facts.pancake.pageId] : []), ...facts.messenger.pageIds]);
  return [...ids].sort().map((pageId) => {
    const r = byId.get(pageId);
    const live = liveTransportsOf(facts, pageId);
    const owner = transportOwnerOf(facts, pageId);
    const mode = r && (CONNECTION_MODES as readonly string[]).includes(r.mode) ? (r.mode as ConnectionMode) : null;
    const warning =
      !owner && (live.PANCAKE || live.MESSENGER)
        ? `Đường chính (${mode ? CONNECTION_MODE_LABEL[mode] : "—"}) chưa chạy — AI KHÔNG trả lời page này; tin khách vẫn lưu ở hộp thư. Nối lại đường chính hoặc chuyển đường.`
        : live.PANCAKE && live.MESSENGER
          ? `Page nối cả hai đường — chỉ ${owner ? CONNECTION_MODE_LABEL[TRANSPORT_MODE[owner]] : "—"} được kích AI, đường kia bỏ qua tin của page.`
          : null;
    return { pageId, mode, source: (r?.source as ModeSource | undefined) ?? null, reason: r?.reason ?? null, updatedAt: r?.updatedAt?.toISOString() ?? null, live, owner, warning };
  });
}

const CHANNEL_MODE_MANAGE = "ai_sales:manage";

/**
 * NGƯỜI chuyển đường canonical của MỘT page (thao tác tường minh + nhật ký). Đường đích phải ĐANG CHẠY cho page đó — chuyển sang
 * đường chưa nối là làm AI im lặng mà không ai hay. Lý do bắt buộc.
 */
export async function setPageConnectionModeCore(user: SessionUser, pageId: unknown, mode: unknown, reason: unknown): Promise<{ ok: true; changed: boolean; from: ConnectionMode | null } | { ok: false; error: string }> {
  if (!can(user, CHANNEL_MODE_MANAGE)) return { ok: false, error: "Bạn không có quyền đổi đường nhận tin (ai_sales:manage)." };
  if (typeof pageId !== "string" || !/^[A-Za-z0-9_:.-]{1,80}$/.test(pageId)) return { ok: false, error: "Page không hợp lệ." };
  if (typeof mode !== "string" || !(CONNECTION_MODES as readonly string[]).includes(mode)) return { ok: false, error: "Đường nhận tin không hợp lệ." };
  const why = typeof reason === "string" ? reason.trim() : "";
  if (why.length < 3) return { ok: false, error: "Ghi lý do chuyển đường (ít nhất 3 ký tự) — vào nhật ký." };
  const target = mode as ConnectionMode;
  const facts = await loadTransportFacts();
  const live = liveTransportsOf(facts, pageId);
  if (!live[MODE_TRANSPORT[target]]) return { ok: false, error: `Page này chưa nối qua ${CONNECTION_MODE_LABEL[target]} — nối trước rồi mới chuyển, không thì AI im lặng.` };
  const current = facts.modes?.[pageId] ?? null;
  if (current === target) return { ok: true, changed: false, from: current };
  const legacyOwner = transportOwnerOf(facts, pageId);
  const from = await recordPageMode(pageId, target, "MANUAL", why, user.id);
  await audit({ userId: user.id, userEmail: user.email, action: "SALES_CHANNEL_MODE_SET", entity: "CHANNEL_PAGE", entityId: pageId, detail: { from: from ?? `LEGACY:${legacyOwner ?? "NONE"}`, to: target, reason: why.slice(0, 300) } });
  return { ok: true, changed: true, from };
}

// ─────────────────────────── Khử trùng hai nguồn ───────────────────────────

/** Chữ chuẩn hoá để so hai bản của một tin (gộp khoảng trắng). HÀM THUẦN. */
export function dedupeText(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 2000);
}

type InboundInsert = typeof schema.salesChatInbound.$inferInsert;

/**
 * Ghi MỘT dòng tin KHÁCH (không phải tin phía page) của đường `transport`, KHỬ TRÙNG với đường kia: cùng page + cùng PSID chuẩn +
 * cùng chữ chuẩn hoá trong `DUP_WINDOW_MS`. Đếm bản sao của đường kia so với số bản đường này đã ghi (khách nhắn cùng chữ hai lần
 * vẫn là hai tin):
 *  · Đường đang ghi là CANONICAL: chỉ bản đường kia ĐÃ XỬ LÝ (không còn `PENDING`) mới là «đã có» ⇒ không ghi. Bản đường kia còn
 *    `PENDING` là bản MẮC KẸT (đường đó không còn được kích AI — vừa chuyển đường) ⇒ ghi bản này để AI trả lời ĐÚNG MỘT lần, và
 *    đánh dấu bản mắc kẹt `SKIPPED` + `DUPLICATE_SOURCE_REASON` (giữ làm lịch sử, không bao giờ vào lượt AI).
 *  · Đường đang ghi KHÔNG canonical (chỉ ghi cho người đọc): mọi bản đường kia đều là «đã có».
 * Khoá tư vấn theo (page, PSID) xếp hàng hai webhook tới cùng lúc. Không có PSID / chữ ⇒ chỉ chống trùng theo `message_id` như cũ.
 */
export async function insertCustomerInbound(row: InboundInsert & { transport: TransportOwner; senderId: string | null }, now: Date, opts: { canonical: boolean }): Promise<{ inserted: boolean; duplicate: boolean; superseded: number }> {
  const db = await getDb();
  const t = schema.salesChatInbound;
  const sender = (row.senderId ?? "").trim() || null;
  const key = dedupeText(row.text ?? "");
  const values = { ...row, senderId: sender };
  if (!sender || !key) {
    const ins = await db.insert(t).values(values).onConflictDoNothing({ target: t.messageId }).returning({ id: t.id });
    return { inserted: ins.length > 0, duplicate: false, superseded: 0 };
  }
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`inbound-dedupe:${row.pageId}:${sender}`}, 0))`);
    const match = and(eq(t.pageId, row.pageId), eq(t.senderId, sender), eq(t.kind, "INBOX"), gte(t.createdAt, new Date(now.getTime() - DUP_WINDOW_MS)), sql`regexp_replace(btrim(${t.text}), '[[:space:]]+', ' ', 'g') = ${key}`);
    const [n] = await tx
      .select({
        handled: sql<number>`count(*) filter (where ${t.transport} <> ${row.transport} and ${t.status} <> 'PENDING')::int`,
        stranded: sql<number>`count(*) filter (where ${t.transport} <> ${row.transport} and ${t.status} = 'PENDING')::int`,
        same: sql<number>`count(*) filter (where ${t.transport} = ${row.transport})::int`,
      })
      .from(t)
      .where(match);
    const handled = Number(n?.handled ?? 0);
    const stranded = Number(n?.stranded ?? 0);
    const same = Number(n?.same ?? 0);
    const already = opts.canonical ? handled : handled + stranded;
    if (already > same) return { inserted: false, duplicate: true, superseded: 0 };
    const ins = await tx.insert(t).values(values).onConflictDoNothing({ target: t.messageId }).returning({ id: t.id });
    let superseded = 0;
    if (ins.length && opts.canonical && stranded > 0) {
      const done = await tx
        .update(t)
        .set({ status: "SKIPPED", processedAt: now, note: DUPLICATE_SOURCE_REASON })
        .where(and(match, sql`${t.transport} <> ${row.transport}`, eq(t.status, "PENDING"), isNull(t.claimId)))
        .returning({ id: t.id });
      superseded = done.length;
    }
    return { inserted: ins.length > 0, duplicate: false, superseded };
  });
}

/** Đường đã ghi tin KHÁCH gần nhất của một luồng (0232) — `null` = dòng cũ chưa có cột. */
export async function threadTransport(pageId: string, threadId: string): Promise<TransportOwner | null> {
  const db = await getDb();
  const t = schema.salesChatInbound;
  const [r] = await db
    .select({ transport: t.transport })
    .from(t)
    .where(and(eq(t.pageId, pageId), eq(t.threadId, threadId), isNotNull(t.transport)))
    .orderBy(desc(t.createdAt))
    .limit(1);
  return r?.transport === "PANCAKE" || r?.transport === "MESSENGER" ? r.transport : null;
}
