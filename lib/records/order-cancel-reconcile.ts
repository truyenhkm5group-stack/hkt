/**
 * ═══════════ ĐỐI SOÁT «KHÁCH ĐÃ HUỶ MÀ ĐƠN VẪN SỐNG» (chủ shop 10/10/2026 — sự cố #189A435E) — CHỈ MÁY CHỦ ═══════════
 *
 * Tìm đơn tay `erp-` còn mở (Mới / Chờ hàng / Đã xác nhận) mà có DẤU VẾT khách huỷ, phân loại bằng ĐÚNG luật của bot
 * (`customerCancelPlan` trên `loadCancelFacts`) thành: huỷ được ngay · cần ĐVVC · cần người. Năm loại dấu vết, xét theo thứ tự:
 *  · `EXCEPTION_OPEN`  — máy đã thử, đơn đang nằm ở hàng ngoại lệ (người đang xử lý) — xét TRƯỚC để `apply` không gọi hãng lần hai;
 *  · `RESCUE_FAILED`   — lời khai huỷ ghi lượt giữ đơn THẤT BẠI (khách vẫn huỷ) mà đơn chưa huỷ, chưa vào hàng ngoại lệ;
 *  · `AI_AGREED`       — hội thoại ghi khách từ chối (`state.declined`) SAU khi đơn đã lên, không có lời chốt / xác nhận lại sau đó —
 *                        đúng dáng #189A435E (bot «đồng ý», đơn không đổi, không cờ);
 *  · `CUSTOMER_FLAG`   — cờ «khách huỷ» theo luật 08/10 đang chờ người quyết;
 *  · `RESCUE_PENDING`  — bot đang giữ đơn, khách chưa trả lời.
 *
 * CHẠY THỬ mặc định: chỉ ĐỌC, không gọi hãng, không ghi gì, chỉ trả SỐ ĐẾM. `apply` CHỈ chạm hai loại mà QUYẾT ĐỊNH CUỐI của khách
 * đã rõ (`RESCUE_FAILED`, `AI_AGREED`) — đi ĐÚNG đường của bot (`executeCustomerCancel`: huỷ ngay / gọi hãng / hàng ngoại lệ + cảnh
 * báo), tác nhân là JOB (`SYSTEM`, `userId = null` — luật 36). Ba loại còn lại đã có người cầm: chỉ đếm. Ghi hàng loạt trên
 * production cần chủ shop duyệt (AGENTS §7).
 */
import { and, desc, gte, inArray, or, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { isManualOrderId } from "@/lib/constants/manual-orders";
import { CANCEL_BLOCK_CODES, customerCancelPlan, orderCancellationOf, type CancelBlockCode } from "@/lib/constants/order-cancel";
import { orderReviewLogOf, reviewFromValue } from "@/lib/constants/order-review";
import { executeCustomerCancel, loadCancelFacts } from "@/lib/records/order-cancel";

export const RECONCILE_EVIDENCE = ["EXCEPTION_OPEN", "RESCUE_FAILED", "AI_AGREED", "CUSTOMER_FLAG", "RESCUE_PENDING"] as const;
export type ReconcileEvidence = (typeof RECONCILE_EVIDENCE)[number];
/** Loại mà quyết định cuối của khách đã rõ — chỉ chúng được `apply`. */
export const RECONCILE_APPLYABLE: ReadonlySet<ReconcileEvidence> = new Set(["RESCUE_FAILED", "AI_AGREED"]);
export const RECONCILE_CLASSES = ["CANCEL_NOW", "NEEDS_CARRIER", "NEEDS_HUMAN", "ALREADY_CANCELLED"] as const;
export type ReconcileClass = (typeof RECONCILE_CLASSES)[number];

export const RECONCILE_DEFAULT_DAYS = 30;
export const RECONCILE_MAX_DAYS = 365;
/** Trần số đơn đọc một lượt — có trần để không quét vô hạn. */
export const RECONCILE_SCAN_MAX = 5000;
export const RECONCILE_AGENT = { name: "Đối soát huỷ đơn", source: "scripts/order-cancel-reconcile.ts" } as const;

export type ReconcileRow = {
  id: string;
  stage: string;
  insertedAt: Date;
  review: unknown;
  reviewLog: unknown;
  cancellation: unknown;
  declinedAt: string | null;
  confirmedAt: string | null;
};

/** Dấu vết MẠNH NHẤT của một đơn; không có ⇒ `null` (không phải ứng viên). HÀM THUẦN. */
export function cancelEvidenceOf(r: ReconcileRow): ReconcileEvidence | null {
  const c = orderCancellationOf({ cancellation: r.cancellation });
  if (c?.status === "CANCELLED") return null;
  // Đã ở hàng ngoại lệ ⇒ người đang cầm — đứng TRƯỚC «giữ đơn thất bại» (ngoại lệ nào cũng mang lượt giữ thất bại): `apply` gọi lại
  // hãng cho một lệnh huỷ «không rõ đã nhận chưa» là gửi lệnh hai lần mù.
  if (c?.status === "EXCEPTION") return "EXCEPTION_OPEN";
  if (c?.rescue.result === "FAILED") return "RESCUE_FAILED";
  const declined = r.declinedAt ? Date.parse(r.declinedAt) : NaN;
  if (Number.isFinite(declined) && declined > r.insertedAt.getTime()) {
    const confirmedAfter = r.confirmedAt ? Date.parse(r.confirmedAt) > declined : false;
    const reconfirmedAfter = orderReviewLogOf({ reviewLog: r.reviewLog }).some((x) => x.action !== "CANCELLED" && Date.parse(x.at) > declined);
    const keptAfter = c?.rescue.result === "SUCCEEDED" && c.rescue.decidedAt !== null && Date.parse(c.rescue.decidedAt) > declined;
    if (!confirmedAfter && !reconfirmedAfter && !keptAfter) return "AI_AGREED";
  }
  if (reviewFromValue(r.review)?.entries.some((e) => e.code === "CUSTOMER_CANCELLED" || e.code === "CANCEL_BLOCKED")) return "CUSTOMER_FLAG";
  if (c?.rescue.result === "PENDING") return "RESCUE_PENDING";
  return null;
}

export type ReconcileReport = {
  apply: boolean;
  days: number;
  scanned: number;
  truncated: boolean;
  candidates: number;
  byEvidence: Record<ReconcileEvidence, number>;
  byClass: Record<ReconcileClass, number>;
  /** `<dấu vết>:<loại>` — bảng chéo để biết `apply` sẽ chạm bao nhiêu. */
  matrix: Record<string, number>;
  /** Lý do «cần người» theo mã. */
  byBlock: Partial<Record<CancelBlockCode, number>>;
  /** Chỉ khi `apply`: kết cục của các đơn đủ điều kiện. */
  applied: { cancelled: number; already: number; exceptions: number; carrier: number; skipped: number };
};

const zero = <K extends string>(keys: readonly K[]) => Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;

/** Đối soát MỘT tổ chức (ngữ cảnh hiện hành). `apply = false` ⇒ không một lượt ghi nào, không gọi hãng. */
export async function reconcileOrderCancels(opts: { apply: boolean; days?: number; now?: Date }): Promise<ReconcileReport> {
  const now = opts.now ?? new Date();
  const days = Math.min(RECONCILE_MAX_DAYS, Math.max(1, Math.floor(opts.days ?? RECONCILE_DEFAULT_DAYS)));
  const db = await getDb();
  const o = schema.orders;
  const c = schema.salesChatConversations;
  const since = new Date(now.getTime() - days * 86_400_000);
  const rows = await db
    .select({
      id: o.id,
      stage: o.stage,
      insertedAt: o.insertedAt,
      review: sql<unknown>`${o.raw}->'review'`,
      reviewLog: sql<unknown>`${o.raw}->'reviewLog'`,
      cancellation: sql<unknown>`${o.raw}->'cancellation'`,
      declinedAt: sql<string | null>`(select c2."state"->'declined'->>'at' from "sales_chat_conversations" c2 where c2."id" = "orders"."sales_conversation_id" or c2."order_id" = "orders"."id" or c2."draft_order_id" = "orders"."id" order by c2."last_customer_at" desc nulls last limit 1)`,
      confirmedAt: sql<string | null>`(select c3."state"->'confirmed'->>'at' from "sales_chat_conversations" c3 where c3."id" = "orders"."sales_conversation_id" or c3."order_id" = "orders"."id" or c3."draft_order_id" = "orders"."id" order by c3."last_customer_at" desc nulls last limit 1)`,
    })
    .from(o)
    .where(
      and(
        inArray(o.stage, ["NEW", "WAITING", "CONFIRMED"]),
        gte(o.insertedAt, since),
        sql`${o.id} like 'erp-%'`,
        or(sql`jsonb_typeof(${o.raw}->'review') = 'object'`, sql`jsonb_typeof(${o.raw}->'cancellation') = 'object'`, sql`exists (select 1 from ${c} cx where (cx."id" = "orders"."sales_conversation_id" or cx."order_id" = "orders"."id" or cx."draft_order_id" = "orders"."id") and cx."state" ? 'declined')`),
      ),
    )
    .orderBy(desc(o.insertedAt))
    .limit(RECONCILE_SCAN_MAX + 1);
  const truncated = rows.length > RECONCILE_SCAN_MAX;
  const report: ReconcileReport = {
    apply: opts.apply,
    days,
    scanned: Math.min(rows.length, RECONCILE_SCAN_MAX),
    truncated,
    candidates: 0,
    byEvidence: zero(RECONCILE_EVIDENCE),
    byClass: zero(RECONCILE_CLASSES),
    matrix: {},
    byBlock: {},
    applied: { cancelled: 0, already: 0, exceptions: 0, carrier: 0, skipped: 0 },
  };
  for (const r of rows.slice(0, RECONCILE_SCAN_MAX)) {
    if (!isManualOrderId(r.id)) continue;
    const evidence = cancelEvidenceOf(r);
    if (!evidence) continue;
    const facts = await loadCancelFacts(r.id);
    if (!facts) continue;
    const plan = customerCancelPlan(facts.input);
    const cls: ReconcileClass = plan.kind === "CANCEL_NOW" ? "CANCEL_NOW" : plan.kind === "CARRIER_CANCEL" ? "NEEDS_CARRIER" : plan.kind === "ALREADY_CANCELLED" ? "ALREADY_CANCELLED" : "NEEDS_HUMAN";
    report.candidates += 1;
    report.byEvidence[evidence] += 1;
    report.byClass[cls] += 1;
    report.matrix[`${evidence}:${cls}`] = (report.matrix[`${evidence}:${cls}`] ?? 0) + 1;
    if (plan.kind === "NEEDS_HUMAN") report.byBlock[plan.code] = (report.byBlock[plan.code] ?? 0) + 1;
    if (!opts.apply) continue;
    if (!RECONCILE_APPLYABLE.has(evidence) || cls === "ALREADY_CANCELLED") {
      report.applied.skipped += 1;
      continue;
    }
    const cx = orderCancellationOf({ cancellation: r.cancellation });
    const out = await executeCustomerCancel({
      orderId: r.id,
      agent: RECONCILE_AGENT,
      actorKind: "SYSTEM",
      conversationId: cx?.conversationId ?? null,
      quote: cx?.requestQuote ?? null,
      reason: cx?.reason || "Khách huỷ (đối soát hội thoại)",
      rescue: evidence === "RESCUE_FAILED" ? "FAILED" : "NOT_ATTEMPTED",
      now,
    });
    if (out.status === "CANCELLED") {
      report.applied.cancelled += 1;
      if (out.carrier) report.applied.carrier += 1;
    } else if (out.status === "ALREADY_CANCELLED") report.applied.already += 1;
    else report.applied.exceptions += 1;
  }
  return report;
}

/** Các dòng tóm tắt — CHỈ SỐ ĐẾM (không mã đơn, không tên / SĐT / chữ khách). HÀM THUẦN. */
export function reconcileSummaryLines(code: string, r: ReconcileReport): string[] {
  const kv = (m: Record<string, number>) =>
    Object.entries(m)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${k}=${n}`)
      .join(" ") || "0";
  const blocks = CANCEL_BLOCK_CODES.filter((k) => (r.byBlock[k] ?? 0) > 0).map((k) => `${k}=${r.byBlock[k]}`).join(" ") || "0";
  return [
    `${code}: ${r.apply ? "ÁP DỤNG" : "CHẠY THỬ (không ghi)"} · ${r.days} ngày · đọc ${r.scanned} đơn${r.truncated ? " (CHẠM TRẦN — tăng --days nhỏ hơn)" : ""} · ứng viên ${r.candidates}`,
    `${code}: dấu vết ${kv(r.byEvidence)}`,
    `${code}: phân loại huỷ-được-ngay=${r.byClass.CANCEL_NOW} cần-ĐVVC=${r.byClass.NEEDS_CARRIER} cần-người=${r.byClass.NEEDS_HUMAN} đã-huỷ=${r.byClass.ALREADY_CANCELLED}`,
    `${code}: bảng chéo ${kv(r.matrix)}`,
    `${code}: lý do cần người ${blocks}`,
    r.apply ? `${code}: đã huỷ=${r.applied.cancelled} (qua hãng ${r.applied.carrier}) · đã huỷ từ trước=${r.applied.already} · vào hàng ngoại lệ=${r.applied.exceptions} · bỏ qua (người đang cầm)=${r.applied.skipped}` : `${code}: --apply sẽ chỉ chạm RESCUE_FAILED + AI_AGREED (huỷ ngay / gọi hãng / hàng ngoại lệ)`,
  ];
}
