import { and, inArray } from "drizzle-orm";
import { schema, type Db } from "@/db";
import type { ModelSignal } from "@/lib/constants/model-signal";
import { TOPIC_OPEN_STATUSES } from "@/lib/constants/production-os";
import { getModelSignalsBatch } from "@/lib/queries/model-signal";

/**
 * ═══════════ ĐỌC CHO LỐI VÀO "MỞ TOPIC SẢN XUẤT SỚM" (Company OS · Agent T) ═══════════
 *
 * Luật: `lib/constants/early-topic.ts`. Tệp này chỉ đọc — không công thức, không ngưỡng.
 */

export type DesignModelLink = { modelId: string; openTopicId: string | null };

/**
 * Thiết kế (tab Thiết kế của /marketing/creatives) ⇒ mẫu trong sổ (`product_models.design_concept_id`) và
 * topic sản xuất ĐANG MỞ mới nhất của mẫu đó. Thiết kế chưa có trong sổ ⇒ KHÔNG có trong Map: màn hình
 * nhắc "đồng bộ sổ mẫu trước", không tự đăng ký (đăng ký là việc của `runModelRegistrySync`).
 */
export async function designModelLinks(db: Db, designIds: readonly string[]): Promise<Map<string, DesignModelLink>> {
  const out = new Map<string, DesignModelLink>();
  if (!designIds.length) return out;
  const pm = schema.productModels;
  const models = await db.select({ id: pm.id, designConceptId: pm.designConceptId }).from(pm).where(inArray(pm.designConceptId, [...designIds]));
  if (!models.length) return out;
  const t = schema.productionTopics;
  const topics = await db
    .select({ id: t.id, modelId: t.modelId, updatedAt: t.updatedAt })
    .from(t)
    .where(
      and(
        inArray(
          t.modelId,
          models.map((m) => m.id),
        ),
        inArray(t.status, [...TOPIC_OPEN_STATUSES]),
      ),
    );
  const moiNhat = new Map<string, { id: string; at: number }>();
  for (const x of topics) {
    const cur = moiNhat.get(x.modelId);
    if (!cur || x.updatedAt.getTime() > cur.at) moiNhat.set(x.modelId, { id: x.id, at: x.updatedAt.getTime() });
  }
  for (const m of models) if (m.designConceptId) out.set(m.designConceptId, { modelId: m.id, openTopicId: moiNhat.get(m.id)?.id ?? null });
  return out;
}

/**
 * Tín hiệu mẫu cho ô chọn mẫu của biểu mẫu mở topic — lấy từ lô của Agent S (`getModelSignalsBatch`, đệm
 * 90 giây, cùng lô buồng lái đọc). Có hạn giờ: lô chưa ấm mà quá hạn thì trả `null` và biểu mẫu vẫn dùng
 * được, chỉ thiếu nhãn tín hiệu (lượt gọi chạy tiếp và làm ấm đệm cho lần mở sau).
 */
export async function modelSignalsForPicker(timeoutMs = 2_500): Promise<Map<string, ModelSignal> | null> {
  let hetGio: ReturnType<typeof setTimeout> | undefined;
  try {
    const batch = await Promise.race([
      getModelSignalsBatch(),
      new Promise<null>((resolve) => {
        hetGio = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
    if (!batch) return null;
    return new Map(batch.rows.map((r) => [r.model.id, r.signal.signal]));
  } catch {
    return null;
  } finally {
    if (hetGio) clearTimeout(hetGio);
  }
}
