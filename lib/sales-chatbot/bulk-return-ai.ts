import { and, desc, eq, inArray, ne, notInArray, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import type { SessionUser } from "@/lib/auth/session";
import { reviewFromValue } from "@/lib/constants/order-review";
import { ORDER_NEEDS_REVIEW } from "@/lib/queries/orders";
import { conversationAiBlocks, type BlockConv } from "@/lib/sales-chatbot/ai-status";
import type { AiBlock, AiBlockCode } from "@/lib/sales-chatbot/ai-status-shared";
import { canControlConversation, NO_CONTROL_PERMISSION, setConversationControlCore } from "@/lib/sales-chatbot/conversation-control";
import { classifyInboxState, HUMAN_HANDLING_KINDS, humanHandlingSql, PAGE_REPLY_AFTER_CUSTOMER_SQL, type HumanHandling } from "@/lib/sales-chatbot/inbox-states";
import { loadModeConfig } from "@/lib/sales-chatbot/operating-mode";

/**
 * ═══════════ «TRẢ TẤT CẢ CHO AI» — CẤP WORKSPACE (chủ shop 10/10/2026, mục D) ═══════════
 *
 * Trước: chỉ trả được TỪNG hội thoại. Lõi này đọc MỌI hội thoại đang do người xử lý của tổ chức hiện tại (`getDb()` — cách ly tenant
 * như mọi lõi; ĐÚNG điều kiện thẻ «Người đang xử lý»: tiếp quản · AI nhường sau câu tay · AI gợi ý) và chia hai nhóm:
 *
 *  · RESUMABLE — trả về AI an toàn về nghĩa.
 *  · BLOCKED   — KHÔNG lặng lẽ ghi đè: khách báo huỷ cần người quyết · đơn cần người xác minh · AI đã chuyển người vì lý do nghiệp vụ
 *                (khách đòi gặp người…) · AI không dùng được (lỗi · hết số dư / hạn mức · chưa có nguồn) · kênh / page không cho bot
 *                trả lời · cấu hình chặn (bot tắt · module tắt · Quan sát · chạy bóng · tạm dừng) · cả cửa hàng đang ở chế độ AI gợi ý.
 *                Lý do «AI / kênh / cấu hình» hỏi ĐÚNG các cổng của đường xử lý (`conversationAiBlocks`, ai-status.ts) — không luật thứ hai.
 *                Hội thoại bị chặn GIỮ NGUYÊN chế độ, và màn hình in đúng lý do.
 *
 * Áp dụng = với TỪNG hội thoại RESUMABLE gọi ĐÚNG đường của nút trả một hội thoại (`setConversationControlCore(…, "AUTO")` — quyền ·
 * ghi có điều kiện · sự kiện `ai.resumed` mang khoá người bấm · nhật ký trước → sau), kèm điều kiện «trạng thái chưa đổi kể từ lúc
 * phân loại». Mỗi hội thoại một lượt ghi riêng: một hội thoại hỏng không kéo cả lô. Chạy lại: hội thoại đã về AI không còn là ứng
 * viên ⇒ KHÔNG ghi thêm sự kiện / nhật ký nào (idempotent); bấm hai lần cùng lúc ⇒ ghi có điều kiện chỉ cho một lượt thắng.
 */

export const BULK_BLOCK_CODES = ["CUSTOMER_CANCELLED", "ORDER_NEEDS_VERIFICATION", "AI_HANDOFF", "AI_UNAVAILABLE", "CHANNEL_UNAVAILABLE", "CONFIG_BLOCKED", "ORG_COPILOT"] as const;
export type BulkBlockCode = (typeof BULK_BLOCK_CODES)[number];

export const BULK_BLOCK_LABEL: Record<BulkBlockCode, string> = {
  CUSTOMER_CANCELLED: "Khách báo huỷ đơn — người phải quyết huỷ hay cứu đơn",
  ORDER_NEEDS_VERIFICATION: "Đơn cần người xác minh (địa chỉ chưa ghép được xã / phường)",
  AI_HANDOFF: "AI đã chuyển người vì lý do nghiệp vụ (khách đòi gặp người, khách nhắn sau khi chốt đơn…)",
  AI_UNAVAILABLE: "AI không dùng được (AI lỗi · hết số dư / hạn mức · chưa có nguồn AI)",
  CHANNEL_UNAVAILABLE: "Kênh / page không cho bot trả lời (page chưa bật cho bot · AI tắt cho page)",
  CONFIG_BLOCKED: "Cấu hình chặn (bot tắt · module tắt · chế độ Quan sát / chạy bóng · workspace tạm dừng)",
  ORG_COPILOT: "Cả cửa hàng đang ở chế độ AI gợi ý — đổi ở Cấu hình chatbot",
};

/** Lý do của cổng đường xử lý ⇒ nhóm chặn. `Record` đủ khoá: thêm mã cổng mới mà quên xếp nhóm là lỗi biên dịch. */
const AI_BLOCK_GROUP: Record<AiBlockCode, BulkBlockCode> = {
  PAGE_OFF: "CHANNEL_UNAVAILABLE",
  PAGE_AI_OFF: "CHANNEL_UNAVAILABLE",
  PAGE_SHADOW: "CONFIG_BLOCKED",
  ORG_OBSERVE: "CONFIG_BLOCKED",
  ORG_COPILOT: "ORG_COPILOT",
  MODULE_OFF: "CONFIG_BLOCKED",
  BOT_DISABLED: "CONFIG_BLOCKED",
  WORKSPACE_SUSPENDED: "CONFIG_BLOCKED",
  KILL_SWITCH: "AI_UNAVAILABLE",
  TRIAL_EXPIRED: "AI_UNAVAILABLE",
  TRIAL_QUOTA_EXHAUSTED: "AI_UNAVAILABLE",
  BALANCE_EXHAUSTED: "AI_UNAVAILABLE",
  QUOTA: "AI_UNAVAILABLE",
  NO_AI_SOURCE: "AI_UNAVAILABLE",
  AI_PROVIDER_ERROR: "AI_UNAVAILABLE",
};

/** Lý do ghi vào nhật ký của từng hội thoại được trả (người đọc nhật ký biết lượt nào là «trả tất cả»). */
export const BULK_RETURN_REASON = "Trả tất cả cho AI từ hộp thư";
/** Trần một lượt — workspace lớn bấm lại lượt nữa; màn hình nói rõ khi bị cắt. */
export const BULK_RETURN_MAX = 2000;
const SAMPLES_PER_GROUP = 5;

export type BulkConvRef = { id: string; name: string };
export type BulkReturnGroup = { code: BulkBlockCode; label: string; count: number; samples: (BulkConvRef & { detail: string | null })[] };
export type BulkReturnPreview = {
  /** Số hội thoại đang do người xử lý (ứng viên). */
  total: number;
  resumable: number;
  blocked: number;
  byHandling: Record<HumanHandling, number>;
  /** Nhóm lý do chặn (một hội thoại có thể mang nhiều lý do ⇒ tổng các nhóm có thể lớn hơn `blocked`). */
  groups: BulkReturnGroup[];
  resumableSample: BulkConvRef[];
  /** Có nhiều hơn `BULK_RETURN_MAX` ứng viên — lượt này chỉ xét phần đầu. */
  truncated: boolean;
};
export type BulkReturnApplied = { resumed: number; unchanged: number; failed: { id: string; error: string }[]; preview: BulkReturnPreview };
export type BulkResult<T extends object> = ({ ok: true } & T) | { ok: false; error: string };

export type BulkDeps = {
  now?: Date;
  /** Cổng AI của đường xử lý cho MỘT hội thoại — mặc định `conversationAiBlocks` (bài kiểm thay để dựng từng lý do). */
  aiBlocks?: (conv: BlockConv) => Promise<AiBlock[]>;
};

type Candidate = {
  id: string;
  name: string;
  status: string;
  handoffReason: string | null;
  humanHandling: HumanHandling;
  blocks: { code: BulkBlockCode; detail: string | null }[];
};

/** Phân loại mọi hội thoại đang do người xử lý của tổ chức NGỮ CẢNH. Chỉ đọc. */
async function classifyCandidates(deps: BulkDeps): Promise<{ list: Candidate[]; truncated: boolean }> {
  const now = deps.now ?? new Date();
  const aiBlocks = deps.aiBlocks ?? conversationAiBlocks;
  const db = await getDb();
  const c = schema.salesChatConversations;
  const cu = schema.customers;
  const orgCopilot = (await loadModeConfig().catch(() => null))?.mode === "COPILOT";
  const rows = await db
    .select({ row: c, customerName: cu.name, pageReply: PAGE_REPLY_AFTER_CUSTOMER_SQL })
    .from(c)
    .leftJoin(cu, eq(cu.id, c.customerId))
    .where(and(ne(c.channel, "TEST"), humanHandlingSql(now, orgCopilot)))
    .orderBy(desc(c.lastCustomerAt), desc(c.id))
    .limit(BULK_RETURN_MAX + 1);
  const truncated = rows.length > BULK_RETURN_MAX;
  const picked = rows.slice(0, BULK_RETURN_MAX);
  // Cờ cần người kiểm của đơn — ĐÚNG biểu thức của trang Đơn (`ORDER_NEEDS_REVIEW`), đọc mã lý do để tách «khách huỷ» khỏi «xác minh».
  const o = schema.orders;
  const reviews = picked.length
    ? await db
        .select({ conv: o.salesConversationId, review: sql<unknown>`${o.raw}->'review'` })
        .from(o)
        .where(and(inArray(o.salesConversationId, picked.map((r) => r.row.id)), notInArray(o.stage, ["DELETED", "CANCELLED"]), ORDER_NEEDS_REVIEW))
    : [];
  const reviewCodes = new Map<string, Set<string>>();
  for (const r of reviews) {
    if (!r.conv) continue;
    const set = reviewCodes.get(r.conv) ?? new Set<string>();
    for (const e of reviewFromValue(r.review)?.entries ?? []) set.add(e.code);
    reviewCodes.set(r.conv, set);
  }
  const list: Candidate[] = [];
  for (const { row, customerName, pageReply } of picked) {
    const codes = reviewCodes.get(row.id);
    const cls = classifyInboxState({ ...row, pageReplyAfterCustomer: Boolean(pageReply), orderUnderReview: Boolean(codes?.size) }, now, orgCopilot);
    if (!cls.humanHandling) continue;
    const st = (row.state ?? {}) as { customer?: { name?: unknown } };
    const name = customerName || (typeof st.customer?.name === "string" && st.customer.name) || "Khách";
    const blocks: Candidate["blocks"] = [];
    if (orgCopilot) blocks.push({ code: "ORG_COPILOT", detail: null });
    if (codes?.has("CUSTOMER_CANCELLED")) blocks.push({ code: "CUSTOMER_CANCELLED", detail: null });
    if (codes && [...codes].some((x) => x !== "CUSTOMER_CANCELLED")) blocks.push({ code: "ORDER_NEEDS_VERIFICATION", detail: null });
    if (cls.needsHuman === "AI_HANDOFF") blocks.push({ code: "AI_HANDOFF", detail: row.handoffReason });
    if (cls.needsHuman === "AI_DOWN") blocks.push({ code: "AI_UNAVAILABLE", detail: row.handoffReason });
    // Cổng của đường xử lý (một phần đọc theo tổ chức, có đệm) — chỉ hỏi khi chưa có lý do chặn nào: thêm lý do không đổi kết luận.
    if (!blocks.length) {
      for (const b of await aiBlocks({ id: row.id, channel: row.channel, pageId: row.pageId, visitorKey: row.visitorKey, state: row.state, threadId: row.threadId })) {
        const code = AI_BLOCK_GROUP[b.code];
        if (!blocks.some((x) => x.code === code)) blocks.push({ code, detail: b.reason });
      }
    }
    list.push({ id: row.id, name: String(name).slice(0, 80), status: row.status, handoffReason: row.handoffReason, humanHandling: cls.humanHandling, blocks });
  }
  return { list, truncated };
}

function summarize(list: Candidate[], truncated: boolean): BulkReturnPreview {
  const byHandling = Object.fromEntries(HUMAN_HANDLING_KINDS.map((k) => [k, 0])) as Record<HumanHandling, number>;
  const groups = new Map<BulkBlockCode, BulkReturnGroup>();
  const resumableSample: BulkConvRef[] = [];
  let resumable = 0;
  for (const cand of list) {
    byHandling[cand.humanHandling] += 1;
    if (!cand.blocks.length) {
      resumable += 1;
      if (resumableSample.length < SAMPLES_PER_GROUP) resumableSample.push({ id: cand.id, name: cand.name });
      continue;
    }
    for (const b of cand.blocks) {
      const g = groups.get(b.code) ?? { code: b.code, label: BULK_BLOCK_LABEL[b.code], count: 0, samples: [] };
      g.count += 1;
      if (g.samples.length < SAMPLES_PER_GROUP) g.samples.push({ id: cand.id, name: cand.name, detail: b.detail });
      groups.set(b.code, g);
    }
  }
  return {
    total: list.length,
    resumable,
    blocked: list.length - resumable,
    byHandling,
    groups: BULK_BLOCK_CODES.filter((code) => groups.has(code)).map((code) => groups.get(code)!),
    resumableSample,
    truncated,
  };
}

/** Số hội thoại đang do người xử lý — để hiện nút. `null` = người xem không có quyền trả hội thoại cho AI. Một câu đếm. */
export async function countHumanHandled(user: SessionUser, now: Date = new Date()): Promise<number | null> {
  if (!canControlConversation(user)) return null;
  const db = await getDb();
  const c = schema.salesChatConversations;
  const orgCopilot = (await loadModeConfig().catch(() => null))?.mode === "COPILOT";
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(c)
    .where(and(ne(c.channel, "TEST"), humanHandlingSql(now, orgCopilot)));
  return Number(row?.n ?? 0);
}

/** XEM TRƯỚC (không ghi gì): bao nhiêu hội thoại trả được, bao nhiêu bị chặn và vì sao. */
export async function previewBulkReturnToAi(user: SessionUser, deps: BulkDeps = {}): Promise<BulkResult<{ preview: BulkReturnPreview }>> {
  if (!canControlConversation(user)) return { ok: false, error: NO_CONTROL_PERMISSION };
  const { list, truncated } = await classifyCandidates(deps);
  return { ok: true, preview: summarize(list, truncated) };
}

/** ÁP DỤNG: trả mọi hội thoại RESUMABLE về AI qua ĐÚNG đường của nút trả một hội thoại; hội thoại bị chặn giữ nguyên. */
export async function applyBulkReturnToAi(user: SessionUser, deps: BulkDeps = {}): Promise<BulkResult<BulkReturnApplied>> {
  if (!canControlConversation(user)) return { ok: false, error: NO_CONTROL_PERMISSION };
  const { list, truncated } = await classifyCandidates(deps);
  const preview = summarize(list, truncated);
  let resumed = 0;
  let unchanged = 0;
  const failed: { id: string; error: string }[] = [];
  for (const cand of list) {
    if (cand.blocks.length) continue;
    const r = await setConversationControlCore(user, cand.id, "AUTO", BULK_RETURN_REASON, { expect: { status: cand.status, handoffReason: cand.handoffReason } });
    if (!r.ok) failed.push({ id: cand.id, error: r.error });
    else if (r.changed) resumed += 1;
    else unchanged += 1;
  }
  // Nhật ký TỔNG của lượt bấm (mỗi hội thoại đã có nhật ký riêng mang người bấm). Không có gì đổi ⇒ không ghi (chạy lại vô hại).
  if (resumed > 0) {
    await audit({
      userId: user.id,
      userEmail: user.email,
      action: "SALES_INBOX_BULK_RETURN_AI",
      entity: "SALES_CONVERSATION",
      detail: { candidates: preview.total, resumable: preview.resumable, resumed, unchanged, failed: failed.length, blocked: preview.blocked, blockedBy: Object.fromEntries(preview.groups.map((g) => [g.code, g.count])), byHandling: preview.byHandling, truncated },
      reason: BULK_RETURN_REASON,
    });
  }
  return { ok: true, resumed, unchanged, failed, preview };
}
