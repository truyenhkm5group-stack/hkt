/**
 * ═══════════ ĐƠN ĐÃ XÁC NHẬN THẮNG SỔ HỘI THOẠI CŨ (chủ shop ghi đè 11/10/2026 · P0-B / P0-C / P0-H) ═══════════
 *
 * Production: khung đơn «ĐÃ XÁC NHẬN» mà bot vẫn nhắn «có muốn tiếp tục chốt đơn không?» (ca Kiều Văn Lệ, cùng gốc với KimThu Le).
 * Cổng follow-up đã CHẶN gửi (`ORDER_EXISTS` trong `decideFollowup`), nhưng hội thoại vẫn nằm `WAITING` với lịch nhắc còn đó và
 * bước bán hàng `CONFIRM` — sổ hội thoại tiếp tục nói «khách chưa chốt» với mọi nơi đọc nó. Chủ shop chốt: đơn trong CSDL THẮNG
 * `state` cũ — phát hiện đơn đã xác nhận ở đâu thì DỌN NGAY TẠI ĐÓ:
 *
 *  · lúc XẾP LỊCH (`markWaitingForCustomer`, sau mỗi lần bot trả lời) — không xếp lịch nữa;
 *  · lúc JOB CHẠY (`runSalesFollowups`, cổng ra `ORDER_EXISTS` với đơn CONFIRMED) — huỷ lịch còn lại;
 *  · lượt SỬA DỮ LIỆU (`repairStaleConfirmed`, ops `sales-stale-confirmed-repair`) — cho các dòng đã kẹt từ trước.
 *
 * «Dọn» = huỷ lịch (`next_followup_at` · `waiting_since` = NULL), `WAITING` ⇒ `OPEN` (đúng phép của `stopFollowups`), bước bán hàng
 * `state.stage` = `DONE`, và MỘT dòng vết `stage.changed` (SYSTEM · lý do `CONFIRMED_ORDER` · nơi phát hiện · mã đơn). KHÔNG đụng
 * đơn, KHÔNG gửi tin, KHÔNG ghi `state.confirmed` (đó là sổ của công cụ `confirm_order` — bịa nó là bịa một hành động của bot).
 *
 * «Đã xác nhận» đọc từ `lifecycle.ts` (chiều `order` = `CONFIRMED`: đơn sống nối với hội thoại ở stage ngoài NEW / WAITING /
 * huỷ / hoàn — tức đã xác nhận hoặc đi xa hơn). Không định nghĩa lại ở đây. Đơn «Mới» (CREATED) vẫn bị cổng chặn gửi như cũ
 * nhưng KHÔNG bị dọn: chưa xác nhận thì bước bán hàng chưa xong.
 *
 * IDEMPOTENT: lệnh ghi chỉ chạm dòng còn bẩn (còn lịch · còn `WAITING` · bước ≠ `DONE`) và vết mang khoá chống trùng theo
 * (đơn · nơi phát hiện) — chạy hai lần = chạy một lần.
 */
import { and, desc, eq, gte, isNotNull, ne, or, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { recordConversationEvent } from "@/lib/sales-chatbot/events";
import { loadLifecycle, type LifecycleConvRow, type LifecycleSnapshot } from "@/lib/sales-chatbot/lifecycle";

/** Nơi phát hiện — ghi vào vết. */
export type SettleVia = "SCHEDULE" | "FOLLOWUP_JOB" | "REPAIR";

export type ConfirmedStaleness = {
  /** Hội thoại có đơn đã xác nhận (chiều `order` của vòng đời). */
  confirmed: boolean;
  orderId: string | null;
  /** Còn lịch follow-up. */
  followupScheduled: boolean;
  /** Còn trạng thái `WAITING` (chờ khách). */
  waiting: boolean;
  /** Bước bán hàng chưa phải `DONE` (`CONFIRM` / khác / trống). */
  stageStale: boolean;
  /** Bước bán hàng hiện tại (để đếm `CONFIRM` riêng). */
  stage: string | null;
  /** Đã xác nhận VÀ còn ít nhất một chỗ bẩn ⇒ cần dọn. */
  stale: boolean;
};

type ConvForSettle = Pick<LifecycleConvRow, "status" | "nextFollowupAt" | "state">;

/** HÀM THUẦN — hội thoại này có đơn đã xác nhận mà sổ còn bẩn không. */
export function confirmedStaleness(conv: ConvForSettle, lc: Pick<LifecycleSnapshot, "order" | "orderId">): ConfirmedStaleness {
  const confirmed = lc.order === "CONFIRMED";
  const stage = typeof conv.state.stage === "string" ? conv.state.stage : null;
  const followupScheduled = conv.nextFollowupAt !== null;
  const waiting = conv.status === "WAITING";
  const stageStale = stage !== "DONE";
  return { confirmed, orderId: confirmed ? lc.orderId : null, followupScheduled, waiting, stageStale, stage, stale: confirmed && (followupScheduled || waiting || stageStale) };
}

/** Khoá vết theo (đơn · nơi phát hiện): cùng đơn, cùng nơi phát hiện bao nhiêu lần cũng MỘT dòng. */
export const settleEventKey = (orderId: string | null, via: SettleVia) => `confirmed-settle:${orderId ?? "state"}:${via}`;

/**
 * Dọn MỘT hội thoại có đơn đã xác nhận. `true` = lượt này vừa ghi (dòng còn bẩn); `false` = không có gì để dọn / không xác nhận.
 * Không ném lỗi nghiệp vụ; lỗi CSDL ném lên người gọi (người gọi quyết — job / xếp lịch bọc `catch`).
 */
export async function settleConfirmedConversation(conv: Pick<LifecycleConvRow, "id" | "status" | "nextFollowupAt" | "state">, lc: LifecycleSnapshot, now: Date, via: SettleVia): Promise<boolean> {
  const s = confirmedStaleness(conv, lc);
  if (!s.stale) return false;
  const db = await getDb();
  const c = schema.salesChatConversations;
  const dirty = or(isNotNull(c.nextFollowupAt), eq(c.status, "WAITING"), sql`coalesce(${c.state}->>'stage', '') <> 'DONE'`);
  const done = await db
    .update(c)
    .set({
      status: sql`case when ${c.status} = 'WAITING' then 'OPEN' else ${c.status} end`,
      nextFollowupAt: null,
      waitingSince: null,
      state: sql`jsonb_set(coalesce(${c.state}, '{}'::jsonb), '{stage}', '"DONE"'::jsonb)`,
    })
    .where(and(eq(c.id, conv.id), dirty))
    .returning({ id: c.id });
  if (!done.length) return false;
  await recordConversationEvent(conv.id, {
    type: "stage.changed",
    actorKind: "SYSTEM",
    occurredAt: now,
    orderId: s.orderId,
    reasonCode: "CONFIRMED_ORDER",
    payload: {
      from: s.stage,
      to: "DONE",
      reason: "CONFIRMED_ORDER",
      via,
      prevStatus: conv.status,
      cancelledFollowupAt: conv.nextFollowupAt?.toISOString() ?? null,
      lifecycleVersion: lc.version,
      orderSource: lc.sources.order,
    },
    key: settleEventKey(s.orderId, via),
  });
  return true;
}

// ═══ LƯỢT SỬA DỮ LIỆU (ops `sales-stale-confirmed-repair`) ═══

export const STALE_REPAIR_DEFAULT_DAYS = 30;
export const STALE_REPAIR_MAX_DAYS = 120;
/** Trần hội thoại xét một lượt — đủ cho một shop, có trần để không quét vô hạn. */
export const STALE_REPAIR_MAX_CONVERSATIONS = 5000;

export type StaleRepairReport = {
  apply: boolean;
  days: number;
  /** Hội thoại ứng viên đã xét (còn lịch, hoặc hoạt động trong kỳ mà còn `WAITING` / bước ≠ DONE). */
  scanned: number;
  capped: boolean;
  /** Không đọc được vòng đời / đơn ⇒ KHÔNG đụng (phía hẹp). */
  unreadable: number;
  /** Có đơn đã xác nhận. */
  confirmed: number;
  /** (a) có đơn đã xác nhận mà còn lịch follow-up. */
  confirmedWithFollowup: number;
  /** (b) có đơn đã xác nhận mà còn `WAITING` hoặc bước ≠ DONE — tách bước `CONFIRM`. */
  confirmedStaleStage: number;
  staleStageConfirm: number;
  staleWaiting: number;
  /** Đã xác nhận và còn ít nhất một chỗ bẩn. */
  stale: number;
  /** Đã dọn ở lượt này (`apply`). */
  repaired: number;
};

/**
 * Đếm (mặc định) hoặc dọn (`apply`) các hội thoại có đơn đã xác nhận mà sổ còn bẩn — trên tổ chức NGỮ CẢNH. Chạy thử KHÔNG ghi một
 * dòng nào. Dọn dùng ĐÚNG `settleConfirmedConversation` của đường chạy — không có luật thứ hai.
 */
export async function repairStaleConfirmed(opts: { apply: boolean; days?: number; now?: Date }): Promise<StaleRepairReport> {
  const now = opts.now ?? new Date();
  const days = opts.days ?? STALE_REPAIR_DEFAULT_DAYS;
  const since = new Date(now.getTime() - days * 86_400_000);
  const db = await getDb();
  const c = schema.salesChatConversations;
  const rows = await db
    .select({ id: c.id })
    .from(c)
    .where(and(ne(c.channel, "TEST"), or(isNotNull(c.nextFollowupAt), and(gte(c.updatedAt, since), or(eq(c.status, "WAITING"), sql`coalesce(${c.state}->>'stage', '') <> 'DONE'`)))))
    .orderBy(desc(c.updatedAt))
    .limit(STALE_REPAIR_MAX_CONVERSATIONS + 1);
  const capped = rows.length > STALE_REPAIR_MAX_CONVERSATIONS;
  const report: StaleRepairReport = { apply: opts.apply, days, scanned: 0, capped, unreadable: 0, confirmed: 0, confirmedWithFollowup: 0, confirmedStaleStage: 0, staleStageConfirm: 0, staleWaiting: 0, stale: 0, repaired: 0 };
  for (const { id } of rows.slice(0, STALE_REPAIR_MAX_CONVERSATIONS)) {
    report.scanned += 1;
    const loaded = await loadLifecycle(id, now).catch(() => null);
    if (!loaded || loaded.facts.orders === null) {
      report.unreadable += 1;
      continue;
    }
    const s = confirmedStaleness(loaded.conv, loaded.snapshot);
    if (!s.confirmed) continue;
    report.confirmed += 1;
    if (!s.stale) continue;
    report.stale += 1;
    if (s.followupScheduled) report.confirmedWithFollowup += 1;
    if (s.waiting || s.stageStale) report.confirmedStaleStage += 1;
    if (s.stage === "CONFIRM") report.staleStageConfirm += 1;
    if (s.waiting) report.staleWaiting += 1;
    if (opts.apply && (await settleConfirmedConversation(loaded.conv, loaded.snapshot, now, "REPAIR"))) report.repaired += 1;
  }
  return report;
}

/** Dòng tóm tắt cho ops — chỉ SỐ ĐẾM, không mã hội thoại / tên / SĐT. */
export function staleRepairSummaryLines(code: string, r: StaleRepairReport): string[] {
  return [
    `${code}: xét ${r.scanned}${r.capped ? "+" : ""} hội thoại (kỳ ${r.days} ngày) · không đọc được ${r.unreadable} · có đơn đã xác nhận ${r.confirmed}`,
    `${code}: (a) đơn đã xác nhận mà còn lịch follow-up ${r.confirmedWithFollowup} · (b) còn WAITING / bước ≠ DONE ${r.confirmedStaleStage} (bước CONFIRM ${r.staleStageConfirm} · WAITING ${r.staleWaiting}) · cần dọn ${r.stale}`,
    `${code}: ${r.apply ? `ĐÃ DỌN ${r.repaired}/${r.stale}` : "CHẠY THỬ — chưa ghi gì"}`,
  ];
}
