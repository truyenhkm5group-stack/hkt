import { createHash } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { schema, type Db } from "@/db";
import type { Actor } from "@/lib/constants/actor";
import { checkOverride, type CellDiff, type SuggestedCellsSnapshot } from "@/lib/constants/production-os";
import { emitDomainEvent } from "@/lib/events/emit";
import { followModelLifecycle, type LifecycleFollow } from "@/lib/production/lifecycle";

/**
 * ═══════════ LỆNH SẢN XUẤT: BẢN DUYỆT · GỢI Ý MÁY · LÝ DO NGƯỜI CHỐT (Company OS · Agent C) ═══════════
 *
 * Ba cột mới trên `production_orders` (`design_version_id`, `suggested_cells`, `override_reason`) được ghi
 * DUY NHẤT qua tệp này, trong cùng giao dịch với hai sự kiện của nó:
 *
 *  · `production_order.linked_design` — lệnh trỏ sang một bản thiết kế đã duyệt KHÁC trước (vòng đời mẫu
 *    đi theo: APPROVED / SELLING → PRODUCTION_PLANNING, chỉ cạnh tiến).
 *  · `production_plan.overridden` — số chốt khác gợi ý của máy ở ít nhất một ô (kèm lý do, bắt buộc).
 *
 * Hai bước: `validatePoPlan` (chỉ đọc) chạy TRƯỚC khi action ghi bất cứ gì — lỗi thì không ô nào bị lưu;
 * `persistPoPlanTx` chạy trong giao dịch của action. `savePoPlanCore` ghép hai bước cho nơi chỉ đổi ba
 * cột này (và cho kiểm thử) — cùng một đường, không phải đường thứ hai.
 */
type DbLike = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

const po = schema.productionOrders;
const dv = schema.designVersions;

export type PoPlanInput = {
  productId: string | null;
  designVersionId: string | null;
  /** Gợi ý của máy mà số chốt được so với — do MÁY CHỦ tính / đọc lại, không nhận từ trình duyệt. */
  suggestion: SuggestedCellsSnapshot | null;
  finalCells: Record<string, number>;
  overrideReason: string | null;
};

export type ValidatedPoPlan = {
  /** Mẫu của sản phẩm trong lệnh (`null` = sản phẩm chưa vào sổ mẫu) — để sự kiện hiện trên dòng thời gian của mẫu. */
  modelId: string | null;
  designVersion: { id: string; version: number; modelId: string } | null;
  diff: CellDiff[];
  overrideReason: string | null;
};

/** Mẫu (sổ Agent A) của một sản phẩm Pancake — `null` khi sản phẩm chưa vào sổ mẫu. */
export async function modelOfProduct(db: DbLike, productId: string | null) {
  if (!productId) return null;
  const [m] = await db
    .select({ id: schema.productModels.id, code: schema.productModels.code, state: schema.productModels.lifecycleState })
    .from(schema.productModels)
    .where(eq(schema.productModels.productId, productId))
    .limit(1);
  return m ?? null;
}

/** Bản thiết kế đã duyệt chọn được cho lệnh của sản phẩm này (mới nhất trước). */
export async function designOptionsForProduct(db: DbLike, productId: string | null) {
  const m = await modelOfProduct(db, productId);
  if (!m) return [];
  return db
    .select({ id: dv.id, version: dv.version, approvedAt: dv.approvedAt, approvedBy: dv.approvedBy, costSheetId: dv.costSheetId })
    .from(dv)
    .where(eq(dv.modelId, m.id))
    .orderBy(desc(dv.version));
}

export async function validatePoPlan(db: DbLike, input: PoPlanInput): Promise<{ ok: true; plan: ValidatedPoPlan } | { error: string; diff?: CellDiff[] }> {
  let designVersion: ValidatedPoPlan["designVersion"] = null;
  const m = await modelOfProduct(db, input.productId);
  if (input.designVersionId) {
    const [d] = await db.select({ id: dv.id, version: dv.version, modelId: dv.modelId }).from(dv).where(eq(dv.id, input.designVersionId)).limit(1);
    if (!d) return { error: "Không tìm thấy bản thiết kế đã duyệt" };
    if (!m || m.id !== d.modelId) return { error: "Bản thiết kế này thuộc một mẫu khác — lệnh chỉ trỏ được bản duyệt của CHÍNH mẫu đang đặt" };
    designVersion = d;
  }
  const o = checkOverride(input.suggestion?.cells ?? null, input.finalCells, input.overrideReason);
  if ("error" in o) return { error: o.error, diff: o.diff };
  return { ok: true, plan: { modelId: m?.id ?? null, designVersion, diff: o.diff, overrideReason: o.reason } };
}

function hashOf(v: unknown): string {
  return createHash("sha1").update(JSON.stringify(v)).digest("hex").slice(0, 16);
}

function sortedCells(c: Record<string, number>): [string, number][] {
  return Object.entries(c)
    .filter(([, v]) => Number(v) > 0)
    .sort(([a], [b]) => a.localeCompare(b));
}

/**
 * Ghi ba cột + phát sự kiện, TRONG giao dịch của nơi gọi. `before` là giá trị bản duyệt đang có của
 * lệnh (lệnh mới: `null`) — chỉ phát `linked_design` khi bản duyệt ĐỔI sang một bản khác trước.
 */
export async function persistPoPlanTx(
  tx: DbLike,
  input: { poId: string; poCode: string; beforeDesignVersionId: string | null; plan: ValidatedPoPlan; suggestion: SuggestedCellsSnapshot | null; finalCells: Record<string, number>; actor: Actor },
): Promise<{ linkedEventId: string | null; overriddenEventId: string | null; modelId: string | null }> {
  const { plan } = input;
  await tx
    .update(po)
    .set({ designVersionId: plan.designVersion?.id ?? null, suggestedCells: input.suggestion, overrideReason: plan.overrideReason })
    .where(eq(po.id, input.poId));

  const modelId = plan.modelId;
  const actorKind = input.actor.id ? ("USER" as const) : ("SYSTEM" as const);
  let linkedEventId: string | null = null;
  if (plan.designVersion && plan.designVersion.id !== input.beforeDesignVersionId) {
    linkedEventId = await emitDomainEvent(tx, {
      name: "production_order.linked_design",
      subjectType: "production_order",
      subjectId: input.poId,
      modelId,
      payload: { code: input.poCode, designVersionId: plan.designVersion.id, designVersion: plan.designVersion.version, before: input.beforeDesignVersionId },
      actorKind,
      actorId: input.actor.id,
      source: "ui:/inventory/planning/orders",
      dedupeKey: `production_order.linked_design:${input.poId}:${plan.designVersion.id}`,
    });
  }
  let overriddenEventId: string | null = null;
  if (plan.diff.length && input.suggestion) {
    overriddenEventId = await emitDomainEvent(tx, {
      name: "production_plan.overridden",
      subjectType: "production_order",
      subjectId: input.poId,
      modelId,
      payload: { code: input.poCode, reason: plan.overrideReason, diff: plan.diff, suggestionComputedAt: input.suggestion.computedAt, basis: input.suggestion.basis },
      actorKind,
      actorId: input.actor.id,
      source: "ui:/inventory/planning/orders",
      // Lưu lại cùng số, cùng gợi ý, cùng lý do ⇒ cùng một lần ghi đè, không đẻ sự kiện thứ hai.
      dedupeKey: `production_plan.overridden:${input.poId}:${hashOf([sortedCells(input.finalCells), sortedCells(input.suggestion.cells), plan.overrideReason])}`,
    });
  }
  return { linkedEventId, overriddenEventId, modelId };
}

/**
 * Vòng đời mẫu đi theo lượt nối bản duyệt — gọi TRONG giao dịch đã ghi lệnh (`tx` của nơi gọi, ngay sau
 * `persistPoPlanTx`), để lệnh và lượt chuyển vòng đời sống chết cùng nhau (Agent K).
 */
export async function followPoLink(tx: DbLike, r: { linkedEventId: string | null; modelId: string | null; poId: string; actor: Actor }): Promise<LifecycleFollow | null> {
  if (!r.linkedEventId || !r.modelId) return null;
  return followModelLifecycle(tx, { modelId: r.modelId, eventName: "production_order.linked_design", eventId: r.linkedEventId, triggeredBy: r.actor, related: { type: "production_order", id: r.poId } });
}

/** Đổi ba cột của MỘT lệnh đã có mà không đụng ô số lượng — và là đường kiểm thử dùng. */
export async function savePoPlanCore(
  db: Db,
  input: { poId: string; designVersionId: string | null; suggestion: SuggestedCellsSnapshot | null; overrideReason: string | null; actor: Actor },
): Promise<{ ok: true; diff: CellDiff[]; lifecycle: LifecycleFollow | null } | { error: string; diff?: CellDiff[] }> {
  const [o] = await db.select({ id: po.id, code: po.code, productId: po.productId, cells: po.cells, designVersionId: po.designVersionId }).from(po).where(eq(po.id, input.poId)).limit(1);
  if (!o) return { error: "Không tìm thấy lệnh sản xuất" };
  const v = await validatePoPlan(db, { productId: o.productId, designVersionId: input.designVersionId, suggestion: input.suggestion, finalCells: o.cells, overrideReason: input.overrideReason });
  if ("error" in v) return v;
  const lifecycle = await db.transaction(async (tx) => {
    const r = await persistPoPlanTx(tx, { poId: o.id, poCode: o.code, beforeDesignVersionId: o.designVersionId, plan: v.plan, suggestion: input.suggestion, finalCells: o.cells, actor: input.actor });
    return followPoLink(tx, { ...r, poId: o.id, actor: input.actor });
  });
  return { ok: true, diff: v.plan.diff, lifecycle };
}
