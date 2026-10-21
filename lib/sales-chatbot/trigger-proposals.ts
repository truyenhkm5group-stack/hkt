import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import type { SessionUser } from "@/lib/auth/session";
import { gate } from "@/lib/sales-chatbot/quick-replies";
import { mergeTriggers } from "@/lib/sales-chatbot/quick-replies-shared";
import { foldVi } from "@/lib/sales-chatbot/text";
import { addTriggerProposals, capTriggerProposals, parseTriggerProposals, TRIGGER_PROPOSALS_KEY, type TriggerProposal } from "@/lib/sales-chatbot/trigger-proposals-shared";
import { setSettingJson } from "@/lib/settings";

/**
 * ĐƯỜNG GHI DUY NHẤT của sổ đề xuất cách hỏi (`trigger-proposals-shared.ts`). Máy chỉ ĐỀ XUẤT (`proposeTriggers`); câu mẫu chỉ đổi
 * khi NGƯỜI duyệt từng cụm (`decideTriggerProposal`) hoặc gỡ một cụm đã duyệt (`removeApprovedTrigger`) — mỗi lượt một dòng nhật ký.
 */
const qr = schema.salesChatQuickReplies;

/**
 * Đọc sổ. KHÔNG qua `getSettingJson`: hàm đó GỘP giá trị đã lưu vào mặc định kiểu object (`{ ...fallback, ...parsed }`) nên một MẢNG
 * đã lưu thành object có khoá số ⇒ sổ trông rỗng (bài kiểm self-service-journey bắt được). Đọc dòng rồi `JSON.parse` thẳng.
 */
export async function loadTriggerProposals(): Promise<TriggerProposal[]> {
  const db = await getDb();
  const row = await db.query.settings.findFirst({ where: eq(schema.settings.key, TRIGGER_PROPOSALS_KEY) }).catch(() => null);
  if (!row) return [];
  try {
    return parseTriggerProposals(JSON.parse(row.value));
  } catch {
    return [];
  }
}

/** Máy đề xuất cách hỏi cho MỘT câu mẫu — KHÔNG đụng câu mẫu. Trả về các dòng mới (đã bỏ cụm có sẵn / đang chờ / đã bị bỏ). */
export async function proposeTriggers(entryId: string, proposed: readonly string[], meta: { by: string; at: Date }): Promise<TriggerProposal[]> {
  const db = await getDb();
  const [row] = await db.select({ title: qr.title, triggers: qr.triggers }).from(qr).where(eq(qr.id, entryId)).limit(1);
  if (!row) return [];
  const r = addTriggerProposals(await loadTriggerProposals(), { id: entryId, title: row.title, triggers: row.triggers ?? [] }, proposed, { by: meta.by, at: meta.at.toISOString() });
  if (r.added.length) await setSettingJson(TRIGGER_PROPOSALS_KEY, r.list);
  return r.added;
}

type Result = { ok: true; message: string } | { error: string };

async function decide(user: SessionUser, id: string, want: TriggerProposal["status"], to: TriggerProposal["status"], apply: (p: TriggerProposal, current: string[]) => { next: string[] } | { error: string }, action: string, done: (p: TriggerProposal) => string): Promise<Result> {
  const g = await gate(user);
  if (!g.ok) return { error: g.error };
  const list = await loadTriggerProposals();
  const p = list.find((x) => x.id === id);
  if (!p || p.status !== want) return { error: "Không còn đề xuất này (đã có người xử lý?) — tải lại trang." };
  const db = await getDb();
  const [row] = await db.select({ triggers: qr.triggers }).from(qr).where(eq(qr.id, p.entryId)).limit(1);
  const current = row?.triggers ?? [];
  if (to !== "REJECTED") {
    if (!row) return { error: "Câu mẫu của đề xuất này đã bị xoá." };
    const r = apply(p, current);
    if ("error" in r) return r;
    await db.update(qr).set({ triggers: r.next }).where(eq(qr.id, p.entryId));
    await audit({ userId: user.id, userEmail: user.email, action, entity: "SALES_QUICK_REPLY", entityId: p.entryId, before: { triggers: current }, after: { triggers: r.next, trigger: p.trigger, proposedBy: p.by, proposedAt: p.at }, reason: done(p) });
  } else {
    await audit({ userId: user.id, userEmail: user.email, action, entity: "SALES_QUICK_REPLY", entityId: p.entryId, before: { trigger: p.trigger, proposedBy: p.by, proposedAt: p.at }, reason: done(p) });
  }
  const now = new Date().toISOString();
  await setSettingJson(TRIGGER_PROPOSALS_KEY, capTriggerProposals(list.map((x) => (x.id === id ? { ...x, status: to, decidedAt: now, decidedBy: user.email } : x))));
  return { ok: true, message: done(p) };
}

/** Người DUYỆT (gắn cụm vào câu mẫu) hoặc BỎ (máy không đề xuất lại cụm này cho câu mẫu đó) MỘT đề xuất. */
export async function decideTriggerProposal(user: SessionUser, id: string, decision: "APPROVE" | "REJECT"): Promise<Result> {
  if (decision === "REJECT") return decide(user, id, "PENDING", "REJECTED", () => ({ next: [] }), "SALES_QUICK_REPLY_TRIGGER_REJECT", (p) => `Đã bỏ cách hỏi «${p.trigger}» — máy không đề xuất lại cho «${p.entryTitle}».`);
  return decide(
    user,
    id,
    "PENDING",
    "APPROVED",
    (p, current) => {
      const next = mergeTriggers(current, [p.trigger], 1);
      return next.length === current.length ? { error: `Không gắn được «${p.trigger}»: câu mẫu đã có cụm này, cụm giống câu đặt hàng / mua sỉ, hoặc đã đủ trần cách hỏi.` } : { next };
    },
    "SALES_QUICK_REPLY_TRIGGER_APPROVE",
    (p) => `Đã gắn cách hỏi «${p.trigger}» vào «${p.entryTitle}» — bot dùng từ tin kế tiếp.`,
  );
}

/** GỠ một cụm ĐÃ DUYỆT khỏi câu mẫu — dòng sổ giữ làm lịch sử (REMOVED). */
export async function removeApprovedTrigger(user: SessionUser, id: string): Promise<Result> {
  return decide(
    user,
    id,
    "APPROVED",
    "REMOVED",
    (p, current) => {
      const key = foldVi(p.trigger);
      const next = current.filter((t) => foldVi(t) !== key);
      return next.length === current.length ? { error: `Câu mẫu không còn cụm «${p.trigger}» (đã sửa tay?).` } : { next };
    },
    "SALES_QUICK_REPLY_TRIGGER_REMOVE",
    (p) => `Đã gỡ cách hỏi «${p.trigger}» khỏi «${p.entryTitle}».`,
  );
}
