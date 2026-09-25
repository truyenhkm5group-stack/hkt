import { and, eq, isNull } from "drizzle-orm";
import { schema, type Db } from "@/db";
import type { Actor } from "@/lib/constants/actor";
import { registerModelCore } from "@/lib/models/service";

/**
 * ═══════════ Ý TƯỞNG → MẪU (Company OS · A2) ═══════════
 *
 * Lõi dịch vụ, KHÔNG `"use server"`. Một giao dịch:
 *   1. ý tưởng phải tồn tại và CHƯA nối mẫu nào (hàng rào `model_id IS NULL` ở chính câu UPDATE);
 *   2. đăng ký mẫu bằng ĐÚNG `registerModelCore` của Agent A (mẫu ở `IDEA`, lịch sử `NULL → IDEA`,
 *      sự kiện `model.registered` + `model.state_changed`) — không đường thứ hai;
 *   3. ghi `marketing_ideas.model_id`.
 * Bước 3 không khớp dòng nào (người khác vừa nối) ⇒ ném lỗi ⇒ CẢ mẫu vừa đăng ký cũng lùi lại —
 * không để lại một mẫu mồ côi.
 *
 * KHÔNG đổi trạng thái, người duyệt hay quyền của ý tưởng.
 */
export type RegisterFromIdeaResult = { ok: true; modelId: string; code: string } | { error: string };

class IdeaRaceError extends Error {}

export async function registerModelFromIdeaCore(db: Db, input: { ideaId: string; code: string; name?: string | null; actor: Actor }): Promise<RegisterFromIdeaResult> {
  const mi = schema.marketingIdeas;
  const [idea] = await db.select({ id: mi.id, modelId: mi.modelId }).from(mi).where(eq(mi.id, input.ideaId)).limit(1);
  if (!idea) return { error: "Không tìm thấy ý tưởng" };
  if (idea.modelId) return { error: "Ý tưởng này đã được đăng ký thành mẫu" };

  try {
    return await db.transaction(async (tx) => {
      const r = await registerModelCore(tx as unknown as Db, { code: input.code, name: input.name, actor: input.actor, source: `ui:/ideas/${input.ideaId}` });
      if ("error" in r) return r;
      const noi = await tx
        .update(mi)
        .set({ modelId: r.modelId })
        .where(and(eq(mi.id, input.ideaId), isNull(mi.modelId)))
        .returning({ id: mi.id });
      if (!noi.length) throw new IdeaRaceError("Ý tưởng vừa được nối với một mẫu khác — tải lại trang");
      return { ok: true as const, modelId: r.modelId, code: r.code };
    });
  } catch (e) {
    if (e instanceof IdeaRaceError) return { error: e.message };
    throw e;
  }
}
