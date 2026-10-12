import { and, eq, like, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { readConversationControl } from "@/lib/sales-chatbot/conversation-control-shared";
import { recordConversationEvent } from "@/lib/sales-chatbot/events";
import { HANDOFF_QUEUE_CLEAR } from "@/lib/sales-chatbot/handoff-routing-shared";

/**
 * ═══════════ TRẢ CHO AI CÁC HỘI THOẠI KẸT VÌ LUẬT CŨ «KHÁCH NHẮN SAU KHI CHỐT ĐƠN» (HOTFIX P0 12/10/2026) ═══════════
 *
 * Bản vá engine bỏ luật chuyển người MẶC ĐỊNH sau khi chốt đơn (AI trả lời theo giai đoạn khách — lifecycle.ts::customerPhaseOf). Hội
 * thoại đã bị chuyển người bằng luật cũ vẫn nằm `HANDOFF` với lý do ấy: không đường nào tự trả về AI (lý do này không tự hết hạn), và
 * đo 11/10 có 248 hội thoại HSLC treo «KHÔNG CHỦ». Watchdog của lượt quét KHÔNG đụng chúng: trả hàng loạt về AI là lượt ghi hàng loạt
 * trên production — chủ shop duyệt (AGENTS §7). Tệp này là lõi CHẠY THỬ mặc định của ops `sales-postorder-handoff-release`.
 *
 * Chỉ trả về AI hội thoại KHÔNG AI ĐANG CẦM: không người phụ trách còn hoạt động, không câu nhân viên nào sau mốc chuyển người, không
 * chế độ «Tiếp quản». Có người đang làm ⇒ để nguyên (người đó bấm «Trả lại cho AI» khi xong). Lý do chuyển người KHÁC (khách báo
 * chuyển khoản, khiếu nại, ghi đơn hỏng…) không bao giờ khớp tiền tố nên không bao giờ bị đụng. KHÔNG gửi tin cho khách, KHÔNG đụng
 * đơn. Ghi có điều kiện (trạng thái + lý do y như lúc đọc) ⇒ chạy lại / chạy chồng không ghi đôi.
 */

/** Tiền tố lý do của luật cũ (engine.ts trước 12/10/2026) — chuỗi ĐÃ LƯU trong CSDL, không đổi. */
export const LEGACY_POST_ORDER_REASON_PREFIX = "Khách nhắn sau khi đã chốt đơn";

export const RELEASE_VERDICTS = ["RELEASE", "HELD_BY_PERSON", "STAFF_REPLIED", "TAKEOVER"] as const;
export type ReleaseVerdict = (typeof RELEASE_VERDICTS)[number];
export const RELEASE_VERDICT_LABEL: Record<ReleaseVerdict, string> = {
  RELEASE: "trả cho AI được (không ai đang cầm)",
  HELD_BY_PERSON: "có người phụ trách — để nguyên",
  STAFF_REPLIED: "nhân viên đã trả lời sau khi chuyển — để nguyên",
  TAKEOVER: "đang «Tiếp quản» — để nguyên",
};

/** Một hội thoại được trả về AI hay để nguyên. HÀM THUẦN. */
export function releaseVerdict(r: { state: unknown; assigneeUserId: string | null; assigneeActive: boolean; lastStaffAt: Date | null; since: Date | null }): ReleaseVerdict {
  if (readConversationControl(r.state)?.mode === "HUMAN") return "TAKEOVER";
  if (r.assigneeUserId && r.assigneeActive) return "HELD_BY_PERSON";
  if (r.lastStaffAt && (!r.since || r.lastStaffAt.getTime() >= r.since.getTime())) return "STAFF_REPLIED";
  return "RELEASE";
}

export type ReleaseReport = { candidates: number; byVerdict: Record<ReleaseVerdict, number>; released: number; apply: boolean };

const C = schema.salesChatConversations;
const MACHINE_EMAIL = "job:sales-postorder-handoff-release";

export async function releaseLegacyPostOrderHandoffs(opts: { apply: boolean; now?: Date }): Promise<ReleaseReport> {
  const now = opts.now ?? new Date();
  const db = await getDb();
  const rows = await db
    .select({
      id: C.id,
      handoffReason: C.handoffReason,
      state: C.state,
      assigneeUserId: C.assigneeUserId,
      assigneeActive: schema.users.active,
      lastStaffAt: C.lastStaffAt,
      queuedAt: C.handoffQueuedAt,
      handoffAt: sql<Date | null>`case when ${C.state}->'handoff'->>'at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' then (${C.state}->'handoff'->>'at')::timestamptz end`,
    })
    .from(C)
    .leftJoin(schema.users, eq(schema.users.id, C.assigneeUserId))
    .where(and(eq(C.status, "HANDOFF"), sql`${C.channel} <> 'TEST'`, like(C.handoffReason, `${LEGACY_POST_ORDER_REASON_PREFIX}%`)))
    .limit(5000);
  const report: ReleaseReport = { candidates: rows.length, byVerdict: Object.fromEntries(RELEASE_VERDICTS.map((v) => [v, 0])) as Record<ReleaseVerdict, number>, released: 0, apply: opts.apply };
  for (const r of rows) {
    const since = r.handoffAt ? new Date(r.handoffAt) : r.queuedAt;
    const v = releaseVerdict({ state: r.state, assigneeUserId: r.assigneeUserId, assigneeActive: Boolean(r.assigneeActive), lastStaffAt: r.lastStaffAt, since });
    report.byVerdict[v] += 1;
    if (v !== "RELEASE" || !opts.apply || !r.handoffReason) continue;
    const done = await db
      .update(C)
      .set({ status: "OPEN", handoffReason: null, state: sql`${C.state} - 'handoff'`, humanCooldownUntil: null, ...HANDOFF_QUEUE_CLEAR, updatedAt: now })
      .where(and(eq(C.id, r.id), eq(C.status, "HANDOFF"), eq(C.handoffReason, r.handoffReason), sql`coalesce(${C.state}->'control'->>'mode', '') <> 'HUMAN'`))
      .returning({ id: C.id });
    if (!done.length) continue;
    report.released += 1;
    await recordConversationEvent(r.id, { type: "ai.resumed", actorKind: "SYSTEM", actorUserId: null, occurredAt: now, reasonCode: "RETURNED", payload: { via: "POSTORDER_RELEASE", reason: r.handoffReason.slice(0, 200) }, key: `postorder-release:${r.id}` });
    await audit({ userId: null, userEmail: MACHINE_EMAIL, action: "SALES_CHAT_POSTORDER_RELEASE", entity: "SALES_CONVERSATION", entityId: r.id, before: { status: "HANDOFF", handoffReason: r.handoffReason }, after: { status: "OPEN" }, reason: "Luật cũ «khách nhắn sau khi chốt đơn ⇒ chuyển người» đã bỏ (12/10/2026); không ai đang cầm hội thoại" });
  }
  return report;
}

/** Dòng tóm tắt chỉ số đếm. HÀM THUẦN. */
export function releaseSummaryLines(code: string, r: ReleaseReport): string[] {
  return [
    `${code}: hội thoại kẹt luật cũ «sau khi chốt đơn» ${r.candidates} · ${RELEASE_VERDICTS.map((v) => `${RELEASE_VERDICT_LABEL[v]} ${r.byVerdict[v]}`).join(" · ")}`,
    `${code}: ${r.apply ? `ĐÃ trả cho AI ${r.released}` : "CHẠY THỬ — chưa ghi gì (thêm --apply sau khi chủ shop duyệt)"}`,
  ];
}
