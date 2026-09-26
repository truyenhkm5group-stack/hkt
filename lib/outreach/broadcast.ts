/**
 * ═══════════ GỬI TIN HÀNG LOẠT — ĐƯỜNG GHI ═══════════
 *
 * Luật chọn người nhận: `lib/constants/outreach-broadcast.ts`. Truy vấn: `lib/queries/outreach-broadcast.ts`.
 *
 * ─── BA ĐIỀU BOOKMARKLET CŨ KHÔNG LÀM ĐƯỢC ───
 *
 *  1. MỖI KHÁCH MỘT LẦN. Danh sách được chụp lúc bấm, mỗi hội thoại một dòng (chỉ mục duy nhất). Vòng gửi
 *     giữ chỗ TỪNG dòng bằng `UPDATE … WHERE status = 'PENDING'` — hai vòng chạy song song (bấm "tiếp tục"
 *     khi vòng cũ chưa chết hẳn) vẫn không gửi một khách hai lần.
 *  2. KIỂM LẠI NGAY TRƯỚC KHI GỬI. Đọc lại tin nhắn thật từ Pancake: khách vừa nhắn thì để nhân viên trả
 *     lời; khách vừa trôi ra ngoài 24 giờ thì không gửi; khách vừa lên đơn thì không gửi.
 *  3. ĐỂ LẠI VẾT. Mỗi dòng mang kết quả (đã gửi · bỏ qua vì sao · lỗi gì), nên đo được "khách nhắn lại"
 *     và "có đơn sau tin" cho từng lượt.
 *
 * ─── TIẾN TRÌNH CHẾT GIỮA CHỪNG ───
 *
 * Vòng gửi chạy trong `after()` trên tiến trình Node; deploy hay khởi động lại là nó chết. Dòng còn `PENDING`
 * thì bấm "Tiếp tục" là chạy nốt. Dòng đang `SENDING` lúc chết thì KHÔNG gửi lại: tin có thể đã tới khách
 * rồi, gửi lại là khách nhận hai lần. Nó được đóng thành `FAILED` với lý do nói rõ "không biết đã đi chưa".
 */
import { and, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { renderTemplate, shortName } from "@/lib/constants/outreach";
import { classifyOutreachError } from "@/lib/constants/outreach-errors";
import { broadcastStartSchema, conversationVerdict, isBroadcastStale, SENDING_STALE_MINUTES, timesFromMessages, type BroadcastFilters, type BroadcastStartInput } from "@/lib/constants/outreach-broadcast";
import type { Actor } from "@/lib/constants/actor";
import { vnShortStamp } from "@/lib/format";
import { getPancakePagesClient, type PancakeMessage } from "@/lib/integrations/pancake/pages";
import { loadOutreachConfig, nurtureVars } from "@/lib/outreach/build";
import { previewBroadcast, recentOrderExists } from "@/lib/queries/outreach-broadcast";
import { rowsOf } from "@/lib/sql-rows";

/** Phần của client Pancake mà vòng gửi dùng — bài kiểm thay bằng bản giả, không gửi tin thật. */
export type BroadcastClient = {
  listMessages(pageId: string, conversationId: string, customerId: string, count?: number): Promise<PancakeMessage[]>;
  sendMessage(pageId: string, conversationId: string, customerId: string, text: string): Promise<{ ok: boolean; error?: string; id?: string }>;
  sendAttachment(pageId: string, conversationId: string, customerId: string, mediaUrl: string): Promise<{ ok: boolean; error?: string }>;
};

export type BroadcastDeps = { client?: BroadcastClient; sleep?: (ms: number) => Promise<void>; now?: () => Date };

const B = schema.outreachBroadcasts;
const R = schema.outreachBroadcastRecipients;
const realSleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

export type StartResult = { ok: true; broadcastId: string; total: number } | { ok: false; error: string };

/** Có lượt nào đang THẬT SỰ chạy không (trạng thái RUNNING và nhịp tim còn mới). */
async function liveRunning(now: Date) {
  const db = await getDb();
  const running = await db.select({ id: B.id, heartbeatAt: B.heartbeatAt }).from(B).where(eq(B.status, "RUNNING"));
  return running.find((b) => !isBroadcastStale(b.heartbeatAt, now)) ?? null;
}

/**
 * Chụp danh sách người nhận theo bộ lọc và ghi lượt. KHÔNG gửi — người gọi chạy `runBroadcast` sau phản hồi.
 * Danh sách là ĐÚNG danh sách `previewBroadcast` trả về cho cùng bộ lọc tại cùng thời điểm.
 */
export async function createBroadcast(raw: BroadcastStartInput, actor: Actor, now = new Date()): Promise<StartResult> {
  const parsed = broadcastStartSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const input = parsed.data;
  if (await liveRunning(now)) return { ok: false, error: "Đang có một lượt gửi chạy. Đợi lượt đó xong hoặc bấm Dừng rồi mới tạo lượt mới — hai lượt song song dễ nhắn một khách hai lần." };

  const preview = await previewBroadcast(input.filters, now);
  if (!preview.eligible.length) return { ok: false, error: "Không có khách nào khớp bộ lọc và còn trong 24 giờ Meta cho nhắn." };

  const db = await getDb();
  const broadcastId = await db.transaction(async (tx) => {
    // Hai cú bấm gần như cùng lúc: khoá giao dịch buộc cú thứ hai đợi, rồi thấy lượt của cú đầu đang chạy.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('outreach_broadcast_create'))`);
    const running = await tx.select({ id: B.id, heartbeatAt: B.heartbeatAt }).from(B).where(eq(B.status, "RUNNING"));
    if (running.some((r) => !isBroadcastStale(r.heartbeatAt, now))) return null;
    const [b] = await tx
      .insert(B)
      .values({
        name: `Gửi hàng loạt ${vnShortStamp(now)}`,
        filters: input.filters satisfies BroadcastFilters,
        messages: input.messages,
        mediaUrls: input.mediaUrls,
        gapSeconds: Math.round(input.gapSeconds),
        total: preview.eligible.length,
        status: "RUNNING",
        createdByUserId: actor.id,
        createdByName: actor.label,
        heartbeatAt: now,
      })
      .returning({ id: B.id });
    const values = preview.eligible.map((c, seq) => ({
      broadcastId: b.id,
      seq,
      pageId: c.pageId,
      conversationId: c.conversationId,
      pancakeCustomerId: c.pancakeCustomerId,
      customerName: c.customerName,
      phone: c.phone,
      tags: c.tags,
      lastCustomerMessageAt: c.lastCustomerMessageAt,
      lastShopMessageAt: c.lastShopMessageAt,
    }));
    for (let i = 0; i < values.length; i += 500) await tx.insert(R).values(values.slice(i, i + 500)).onConflictDoNothing();
    return b.id;
  });
  if (!broadcastId) return { ok: false, error: "Vừa có một lượt gửi khác được tạo. Tải lại trang để xem." };
  return { ok: true, broadcastId, total: preview.eligible.length };
}

/** Giành đúng MỘT dòng tiếp theo. Postgres chỉ cho một lượt thắng trên mỗi dòng. */
async function claimNext(broadcastId: string, now: Date) {
  const db = await getDb();
  const [row] = await db
    .update(R)
    .set({ status: "SENDING", claimedAt: now, updatedAt: now })
    .where(sql`${R.id} = (select id from outreach_broadcast_recipients where broadcast_id = ${broadcastId} and status = 'PENDING' order by seq limit 1 for update skip locked) and ${R.status} = 'PENDING'`)
    .returning();
  return row ?? null;
}

async function finish(id: string, patch: Partial<typeof R.$inferInsert>, now: Date) {
  const db = await getDb();
  await db.update(R).set({ ...patch, updatedAt: now }).where(eq(R.id, id));
}

/**
 * Chạy nốt các dòng `PENDING` của một lượt, lần lượt từng khách. Dừng khi hết dòng (→ `DONE`) hoặc khi người
 * bấm Dừng (trạng thái lượt khác `RUNNING`). Gọi lại trên cùng một lượt là an toàn.
 */
export async function runBroadcast(broadcastId: string, deps: BroadcastDeps = {}) {
  const client = deps.client ?? getPancakePagesClient();
  const sleep = deps.sleep ?? realSleep;
  const clock = deps.now ?? (() => new Date());
  const db = await getDb();
  const cfg = await loadOutreachConfig();
  const counts = { sent: 0, skipped: 0, failed: 0 };
  // Nhận lượt: từ đây vòng nào khác đang chạy trên lượt này sẽ thấy mã khác mã của nó và tự thoát.
  const runId = crypto.randomUUID();
  const took = await db.update(B).set({ runId, heartbeatAt: clock() }).where(and(eq(B.id, broadcastId), eq(B.status, "RUNNING"))).returning({ id: B.id });
  if (!took.length) return counts;

  for (;;) {
    const now = clock();
    const [b] = await db.select().from(B).where(eq(B.id, broadcastId));
    if (!b || b.status !== "RUNNING" || b.runId !== runId) break;
    await db.update(B).set({ heartbeatAt: now }).where(eq(B.id, broadcastId));

    const row = await claimNext(broadcastId, now);
    if (!row) {
      await closeStaleSending(broadcastId, now);
      await db.update(B).set({ status: "DONE", finishedAt: now, heartbeatAt: now }).where(and(eq(B.id, broadcastId), eq(B.status, "RUNNING"), eq(B.runId, runId)));
      break;
    }
    const filters = b.filters as BroadcastFilters;

    // ── Kiểm lại bằng tin nhắn thật ──
    let messages: PancakeMessage[];
    try {
      messages = await client.listMessages(row.pageId, row.conversationId, row.pancakeCustomerId, 20);
    } catch (e) {
      const raw = (e instanceof Error ? e.message : String(e)).slice(0, 300);
      await finish(row.id, { status: "FAILED", reason: "TRANSIENT", error: `Không đọc lại được hội thoại trước khi gửi: ${raw}` }, now);
      counts.failed += 1;
      continue;
    }
    const live = timesFromMessages(messages);
    // Tin nhắn đọc lại chỉ gồm 20 tin cuối; thiếu mốc của một bên thì giữ mốc đã chụp — mới hơn thì thắng.
    const times = {
      lastCustomerAt: latest(live.lastCustomerAt, row.lastCustomerMessageAt),
      lastShopAt: latest(live.lastShopAt, row.lastShopMessageAt),
    };
    const verdict = conversationVerdict(times, filters, clock());
    if (verdict) {
      await finish(row.id, { status: "SKIPPED", reason: verdict }, now);
      counts.skipped += 1;
      continue;
    }
    // Cùng khách trong một lượt KHÁC vừa được gửi / đang gửi ⇒ không nhắn lần hai.
    const recentCut = new Date(now.getTime() - Math.max(filters.skipRecentHours, 1) * 3_600_000);
    const [dup] = rowsOf<{ has: boolean }>(
      await db.execute(sql`select exists (
        select 1 from outreach_broadcast_recipients r2
        where r2.page_id = ${row.pageId} and r2.conversation_id = ${row.conversationId} and r2.id <> ${row.id}
          and (r2.status = 'SENDING' or (r2.status = 'SENT' and r2.sent_at >= ${recentCut.toISOString()}::timestamptz))
      ) as has`),
    );
    if (dup?.has) {
      await finish(row.id, { status: "SKIPPED", reason: "RECENTLY_BROADCAST" }, now);
      counts.skipped += 1;
      continue;
    }
    if (filters.order === "NO_ORDER") {
      const [o] = rowsOf<{ has: boolean }>(await db.execute(sql`select ${recentOrderExists(sql`${row.conversationId}::text`, sql`${row.phone}::text`)} as has`));
      if (o?.has) {
        await finish(row.id, { status: "SKIPPED", reason: "HAS_ORDER" }, now);
        counts.skipped += 1;
        continue;
      }
    }

    // ── Gửi ──
    const vars = nurtureVars(cfg, shortName(row.customerName), "");
    let sentTexts = 0;
    let providerId: string | null = null;
    let error = "";
    for (const [i, template] of (b.messages as string[]).entries()) {
      if (i > 0) await sleep(800);
      const r = await client.sendMessage(row.pageId, row.conversationId, row.pancakeCustomerId, renderTemplate(template, vars));
      if (!r.ok) {
        error = (r.error ?? "Gửi thất bại").slice(0, 300);
        break;
      }
      sentTexts += 1;
      providerId = providerId ?? r.id ?? null;
    }
    if (!error) {
      const mediaFails: string[] = [];
      for (const url of b.mediaUrls as string[]) {
        await sleep(800);
        const a = await client.sendAttachment(row.pageId, row.conversationId, row.pancakeCustomerId, url);
        if (!a.ok) mediaFails.push(a.error ?? "lỗi");
      }
      if (mediaFails.length) error = `Ảnh/video: ${mediaFails.length}/${(b.mediaUrls as string[]).length} gửi lỗi (${mediaFails[0].slice(0, 120)})`;
    }
    const at = clock();
    if (sentTexts > 0) {
      // Tin đầu đã tới khách ⇒ SENT, kể cả khi tin sau / ảnh lỗi (ghi ở `error`, `messages_sent` nói gửi được mấy tin).
      await finish(row.id, { status: "SENT", messagesSent: sentTexts, providerMessageId: providerId, sentAt: at, error, reason: error ? "PARTIAL" : null }, at);
      counts.sent += 1;
    } else {
      await finish(row.id, { status: "FAILED", reason: classifyOutreachError(error).kind, error }, at);
      counts.failed += 1;
    }
    await sleep(Math.max(1, b.gapSeconds) * 1000);
  }
  return counts;
}

/** Dòng kẹt `SENDING` quá lâu ⇒ vòng giữ nó đã chết giữa lúc gửi. Đóng lại, KHÔNG gửi lại. */
async function closeStaleSending(broadcastId: string, now: Date) {
  const db = await getDb();
  await db
    .update(R)
    .set({ status: "FAILED", reason: "UNKNOWN", error: "Máy chủ dừng giữa lúc gửi — không biết tin đã tới khách chưa, nên không gửi lại", updatedAt: now })
    .where(and(eq(R.broadcastId, broadcastId), eq(R.status, "SENDING"), sql`${R.claimedAt} < ${new Date(now.getTime() - SENDING_STALE_MINUTES * 60_000).toISOString()}::timestamptz`));
}

function latest(a: Date | null, b: Date | null) {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

/** Dừng lượt: vòng gửi thoát ở khách kế tiếp. Dòng chưa gửi giữ nguyên `PENDING` để tiếp tục được. */
export async function stopBroadcast(broadcastId: string, actor: Actor, now = new Date()) {
  const db = await getDb();
  const r = await db.update(B).set({ status: "STOPPED", stoppedByUserId: actor.id, heartbeatAt: now }).where(and(eq(B.id, broadcastId), eq(B.status, "RUNNING"))).returning({ id: B.id });
  return r.length > 0;
}

/**
 * Tiếp tục lượt đã dừng, hoặc lượt RUNNING mà vòng gửi đã chết (nhịp tim cũ). Dòng kẹt `SENDING` quá
 * `SENDING_STALE_MINUTES` được đóng thành `FAILED` — KHÔNG gửi lại (xem đầu tệp).
 */
export async function resumeBroadcast(broadcastId: string, now = new Date()): Promise<{ ok: true } | { ok: false; error: string }> {
  const db = await getDb();
  const [b] = await db.select().from(B).where(eq(B.id, broadcastId));
  if (!b) return { ok: false, error: "Không tìm thấy lượt gửi" };
  if (b.status === "DONE") return { ok: false, error: "Lượt này đã xong" };
  if (b.status === "RUNNING" && !isBroadcastStale(b.heartbeatAt, now)) return { ok: false, error: "Lượt này đang chạy" };
  const other = await liveRunning(now);
  if (other && other.id !== broadcastId) return { ok: false, error: "Đang có một lượt gửi khác chạy" };
  await closeStaleSending(broadcastId, now);
  await db.update(B).set({ status: "RUNNING", heartbeatAt: now, finishedAt: null }).where(eq(B.id, broadcastId));
  return { ok: true };
}
