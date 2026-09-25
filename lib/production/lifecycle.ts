import { eq } from "drizzle-orm";
import { schema, type Db } from "@/db";
import type { Actor } from "@/lib/constants/actor";
import { isModelState, MODEL_STATE_LABELS, type ModelState } from "@/lib/constants/model-lifecycle";
import { lifecycleTarget, LIFECYCLE_FOLLOW } from "@/lib/constants/production-os";
import { transitionModelCore } from "@/lib/models/service";

/**
 * ═══════════ VÒNG ĐỜI MẪU ĐI THEO MỘT HÀNH ĐỘNG Ở MIỀN SẢN XUẤT ═══════════
 *
 * target-architecture.md Q3: người đã quyết ở miền sản xuất (mở topic, lập giá thành, duyệt mẫu, nối lệnh
 * SX vào bản duyệt), nên lượt chuyển vòng đời đi theo được MÁY ghi với `actor_kind = SYSTEM` và trỏ về
 * sự kiện gây ra nó (`sourceEventId`). Người bấm nằm ở `metadata.triggeredBy*` — không đứng tên lượt
 * chuyển, vì họ không bấm "đổi vòng đời".
 *
 * Chỉ đi theo CẠNH TIẾN từ trạng thái hiện tại (`lifecycleTarget`). Mẫu chưa khai / đang ở chỗ khác ⇒
 * KHÔNG chuyển, không lỗi: lùi bước hay nhảy cóc là việc của người, có lý do (`/models/[id]`).
 *
 * GỌI SAU KHI giao dịch nghiệp vụ đã chốt: `transitionModelCore` (Agent A) nhận `Db` và tự mở giao dịch
 * riêng. Sự kiện gây ra đã nằm trong CSDL nên lượt này lũy đẳng theo `sourceEventId` — gọi lại không
 * ghi dòng thứ hai. Hỏng ở bước này KHÔNG huỷ hành động nghiệp vụ (vòng đời là hệ quả, không phải điều
 * kiện); kết quả trả về để action báo lên màn hình.
 */
export type LifecycleFollow =
  | { moved: true; from: ModelState; to: ModelState }
  | { moved: false; reason: "NO_EVENT" | "NOT_FORWARD" | "UNDECLARED"; current: ModelState | null }
  | { moved: false; reason: "ERROR"; error: string; current: ModelState | null };

export async function followModelLifecycle(
  db: Db,
  input: { modelId: string; eventName: keyof typeof LIFECYCLE_FOLLOW | string; eventId: string | null; triggeredBy: Actor; related: { type: string; id: string } },
): Promise<LifecycleFollow> {
  const [m] = await db.select({ state: schema.productModels.lifecycleState }).from(schema.productModels).where(eq(schema.productModels.id, input.modelId)).limit(1);
  const current: ModelState | null = m && isModelState(m.state) ? m.state : null;
  // Sự kiện bị bỏ vì trùng (`dedupeKey`) ⇒ đây là lượt gửi lại, lượt đầu đã lo vòng đời rồi.
  if (!input.eventId) return { moved: false, reason: "NO_EVENT", current };
  if (current === null) return { moved: false, reason: "UNDECLARED", current };
  const to = lifecycleTarget(current, input.eventName);
  if (!to) return { moved: false, reason: "NOT_FORWARD", current };
  const r = await transitionModelCore(db, {
    modelId: input.modelId,
    to,
    reason: `Tự đi theo sự kiện ${input.eventName} (người thao tác: ${input.triggeredBy.label})`,
    actor: { id: null, label: "Luật vòng đời · sản xuất" },
    actorKind: "SYSTEM",
    source: `event:${input.eventName}`,
    sourceEventId: input.eventId,
    related: input.related,
    metadata: { triggeredByUserId: input.triggeredBy.id, triggeredBy: input.triggeredBy.label },
  });
  if ("error" in r) return { moved: false, reason: "ERROR", error: r.error, current };
  return { moved: true, from: current, to };
}

/** Một câu cho toast / nhật ký. */
export function describeFollow(f: LifecycleFollow): string | null {
  if (f.moved) return `Vòng đời mẫu: ${MODEL_STATE_LABELS[f.from]} → ${MODEL_STATE_LABELS[f.to]}`;
  if (f.reason === "ERROR") return `Không chuyển được vòng đời mẫu: ${f.error}`;
  return null;
}
