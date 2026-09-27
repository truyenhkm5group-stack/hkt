import { and, asc, count, eq } from "drizzle-orm";
import { schema, type Db } from "@/db";
import type { Actor } from "@/lib/constants/actor";
import { EMPTY_REQUIREMENTS, type TopicRequirements } from "@/lib/constants/production-os";
import { costV1Prefill, costV1ShortcutState, type CostV1Prefill } from "@/lib/constants/production-shortcuts";
import { createCostSheetCore } from "@/lib/production/costing";
import type { LifecycleFollow } from "@/lib/production/lifecycle";

/**
 * ═══════════ LỐI TẮT "LẬP GIÁ THÀNH V1" TỪ TOPIC (Company OS · Agent SC) ═══════════
 *
 * KHÔNG phải đường ghi thứ hai của giá thành: tệp này chỉ ĐỌC topic, dựng dòng khởi tạo bằng hàm thuần
 * `costV1Prefill` (chỉ từ giá topic đang giữ), rồi gọi ĐÚNG `createCostSheetCore` với `onlyFirst` —
 * bảng giá thành vẫn chỉ được ghi ở `lib/production/costing.ts` (bài kiểm quét mã nguồn).
 *
 * Dòng dựng LẠI ở máy chủ từ CSDL, không nhận từ trình duyệt: gửi dòng từ client là đường để một cú bấm
 * "lối tắt" ghi một con số chưa từng có trong topic.
 */
export type CostV1Result =
  | { ok: true; mode: "CREATED"; modelId: string; costSheetId: string; version: number; totalUnitCost: number; lifecycle: LifecycleFollow; prefill: CostV1Prefill }
  | { ok: true; mode: "EXISTING"; costSheetId: string; version: number }
  | { ok: true; mode: "EMPTY_EDITOR"; prefill: CostV1Prefill }
  | { error: string };

/** Dữ kiện topic mà lối tắt được phép đọc — một chỗ, dùng chung cho trang (hiển thị) và lõi (ghi). */
export async function topicCostFacts(db: Db, topicId: string) {
  const tp = schema.productionTopics;
  const [t] = await db.select({ id: tp.id, modelId: tp.modelId, status: tp.status, requirements: tp.requirements }).from(tp).where(eq(tp.id, topicId)).limit(1);
  if (!t) return null;
  const msg = schema.productionTopicMessages;
  const [quotes, [{ n }]] = await Promise.all([
    db.select({ price: msg.quotedUnitPrice }).from(msg).where(and(eq(msg.topicId, topicId), eq(msg.kind, "QUOTE"))).orderBy(asc(msg.createdAt), asc(msg.id)),
    db.select({ n: count() }).from(schema.costSheets).where(eq(schema.costSheets.modelId, t.modelId)),
  ]);
  const req: TopicRequirements = { ...EMPTY_REQUIREMENTS, ...(t.requirements as Partial<TopicRequirements>) };
  return { topicId: t.id, modelId: t.modelId, status: t.status, costSheetCount: Number(n), prefill: costV1Prefill({ quotes, targetPrice: req.targetPrice }) };
}

export async function startCostSheetFromTopicCore(db: Db, input: { topicId: string; actor: Actor; canWrite: boolean }): Promise<CostV1Result> {
  const f = await topicCostFacts(db, input.topicId);
  if (!f) return { error: "Không tìm thấy topic" };
  const st = costV1ShortcutState({ canWrite: input.canWrite, topicStatus: f.status, costSheetCount: 0 });
  if (!st.enabled) return { error: st.reason };
  if (f.prefill.source === "NONE") {
    // Không có giá nào để điền ⇒ không ghi gì; màn hình mở bảng trống cho người gõ.
    if (f.costSheetCount > 0) return existingOf(db, f.modelId);
    return { ok: true, mode: "EMPTY_EDITOR", prefill: f.prefill };
  }
  const r = await createCostSheetCore(db, { modelId: f.modelId, topicId: f.topicId, lines: f.prefill.lines, notes: f.prefill.note, actor: input.actor, onlyFirst: true });
  if ("error" in r) return r.existing ? { ok: true, mode: "EXISTING", ...r.existing } : { error: r.error };
  return { ok: true, mode: "CREATED", modelId: f.modelId, costSheetId: r.costSheetId, version: r.version, totalUnitCost: r.totalUnitCost, lifecycle: r.lifecycle, prefill: f.prefill };
}

async function existingOf(db: Db, modelId: string): Promise<CostV1Result> {
  const cs = schema.costSheets;
  const [co] = await db.select({ id: cs.id, version: cs.version }).from(cs).where(eq(cs.modelId, modelId)).orderBy(asc(cs.version)).limit(1);
  return co ? { ok: true, mode: "EXISTING", costSheetId: co.id, version: co.version } : { error: "Không tìm thấy bảng giá thành" };
}
