import { and, asc, desc, eq, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import type { Actor } from "@/lib/constants/actor";
import { checkCostFinalize, computeCostSheet, type CostLineInput } from "@/lib/constants/production-os";
import { emitDomainEvent } from "@/lib/events/emit";
import { followModelLifecycle, type LifecycleFollow } from "@/lib/production/lifecycle";

/**
 * ═══════════ LÕI DỊCH VỤ: BẢNG GIÁ THÀNH CÓ PHIÊN BẢN (Company OS · Agent C) ═══════════
 *
 * Mỗi phiên bản là MỘT dòng `cost_sheets` (V1, V2… theo mẫu). Tổng giá thành TÍNH Ở MÁY CHỦ bằng
 * `computeCostSheet` — không nhận tổng từ trình duyệt.
 *
 * ─── FINAL BẤT BIẾN — BA LỚP CHẶN ───
 *
 *  1. Mọi `UPDATE cost_sheets` ở tệp này mang điều kiện `status = 'DRAFT'` (bài kiểm quét mã nguồn).
 *  2. Dòng chi phí chỉ được thay SAU KHI khoá dòng cha (`FOR UPDATE`) và thấy nó còn DRAFT — trong cùng
 *     giao dịch, nên người chốt ở tab bên cạnh không lọt vào giữa.
 *  3. CHECK `cost_sheets_final_check`: FINAL phải có người chốt + mốc chốt.
 * Tệp này là nơi DUY NHẤT ghi hai bảng giá thành. Muốn đổi bảng đã chốt ⇒ tạo phiên bản mới; bản cũ ở lại.
 *
 * Giá thành tạm tính KHÔNG vào lợi nhuận ở đây. Đường sang giá ước tính của BCLN là nút "Dùng làm giá
 * ước tính" gọi ĐÚNG `setEstimatedCost` (lib/actions/estimated-cost.ts) — không có người ghi thứ hai.
 */
type DbLike = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

const cs = schema.costSheets;
const cl = schema.costSheetLines;

function humanError(actor: Actor): string | null {
  return actor.id ? null : "Thao tác trên bảng giá thành phải mang khoá tài khoản ERP (AGENTS.md mục 34)";
}

async function writeLines(tx: DbLike, sheetId: string, lines: ReturnType<typeof okLines>) {
  if (!lines.length) return;
  await tx.insert(cl).values(lines.map((l, i) => ({ costSheetId: sheetId, kind: l.kind, description: l.description, qty: l.qty, unit: l.unit, unitCost: l.unitCost, amount: l.amount, sortOrder: i })));
}

function okLines(c: Exclude<ReturnType<typeof computeCostSheet>, { error: string }>) {
  return c.lines;
}

export async function createCostSheetCore(
  db: Db,
  input: { modelId: string; topicId: string | null; lines: CostLineInput[]; notes: string; actor: Actor },
): Promise<{ ok: true; costSheetId: string; version: number; totalUnitCost: number; eventId: string | null; lifecycle: LifecycleFollow } | { error: string }> {
  const loi = humanError(input.actor);
  if (loi) return { error: loi };
  const c = computeCostSheet(input.lines);
  if ("error" in c) return { error: c.error };
  const [m] = await db.select({ id: schema.productModels.id, code: schema.productModels.code }).from(schema.productModels).where(eq(schema.productModels.id, input.modelId)).limit(1);
  if (!m) return { error: "Không tìm thấy mẫu trong sổ" };
  if (input.topicId) {
    const [t] = await db.select({ modelId: schema.productionTopics.modelId }).from(schema.productionTopics).where(eq(schema.productionTopics.id, input.topicId)).limit(1);
    if (!t || t.modelId !== m.id) return { error: "Topic không thuộc mẫu này" };
  }

  const out = await db.transaction(async (tx) => {
    // Số phiên bản tiếp theo của mẫu. UNIQUE (model_id, version) chặn hai người cùng tạo V2.
    const [{ n }] = await tx.select({ n: sql<number>`coalesce(max(${cs.version}), 0)::int` }).from(cs).where(eq(cs.modelId, m.id));
    const version = Number(n) + 1;
    const [row] = await tx
      .insert(cs)
      .values({ modelId: m.id, topicId: input.topicId, version, status: "DRAFT", totalUnitCost: c.total, notes: input.notes.trim(), createdByUserId: input.actor.id, createdBy: input.actor.label })
      .returning({ id: cs.id });
    await writeLines(tx, row.id, okLines(c));
    const eventId = await emitDomainEvent(tx, {
      name: "costing.version_created",
      subjectType: "cost_sheet",
      subjectId: row.id,
      modelId: m.id,
      payload: { code: m.code, version, totalUnitCost: c.total, topicId: input.topicId },
      actorKind: "USER",
      actorId: input.actor.id,
      source: "ui:/production",
      dedupeKey: `costing.version_created:${row.id}`,
    });
    return { costSheetId: row.id, version, totalUnitCost: c.total, eventId };
  });

  const lifecycle = await followModelLifecycle(db, { modelId: m.id, eventName: "costing.version_created", eventId: out.eventId, triggeredBy: input.actor, related: { type: "cost_sheet", id: out.costSheetId } });
  return { ok: true, ...out, lifecycle };
}

/** Sửa một bảng NHÁP: thay toàn bộ dòng + ghi chú. Bảng đã chốt ⇒ từ chối. */
export async function updateCostSheetDraftCore(
  db: Db,
  input: { costSheetId: string; lines: CostLineInput[]; notes: string; actor: Actor },
): Promise<{ ok: true; totalUnitCost: number } | { error: string }> {
  const loi = humanError(input.actor);
  if (loi) return { error: loi };
  const c = computeCostSheet(input.lines);
  if ("error" in c) return { error: c.error };
  return db.transaction(async (tx) => {
    // Khoá dòng cha: người chốt ở tab bên cạnh phải đợi lượt sửa này xong (hoặc ngược lại).
    const [cha] = await tx.select({ id: cs.id, status: cs.status }).from(cs).where(eq(cs.id, input.costSheetId)).for("update").limit(1);
    if (!cha) return { error: "Không tìm thấy bảng giá thành" };
    if (cha.status !== "DRAFT") return { error: "Bảng này đã chốt — không sửa được. Tạo phiên bản mới nếu cần đổi." };
    const doi = await tx
      .update(cs)
      .set({ totalUnitCost: c.total, notes: input.notes.trim(), updatedAt: new Date() })
      .where(and(eq(cs.id, cha.id), eq(cs.status, "DRAFT")))
      .returning({ id: cs.id });
    if (!doi.length) return { error: "Bảng này đã chốt — không sửa được." };
    await tx.delete(cl).where(eq(cl.costSheetId, cha.id));
    await writeLines(tx, cha.id, okLines(c));
    return { ok: true as const, totalUnitCost: c.total };
  });
}

/**
 * Chốt một phiên bản — một CHỮ KÝ (Q7a): cần `production:approve` (`canApprove`, action truyền vào từ
 * `can(user, "production:approve")`) và một người thật. Chốt lại bảng đã chốt ⇒ lỗi, không ghi gì.
 */
export async function finalizeCostSheetCore(
  db: Db,
  input: { costSheetId: string; actor: Actor; canApprove: boolean },
): Promise<{ ok: true; version: number; totalUnitCost: number; eventId: string | null } | { error: string }> {
  return db.transaction(async (tx) => {
    const [cha] = await tx
      .select({ id: cs.id, status: cs.status, modelId: cs.modelId, version: cs.version, total: cs.totalUnitCost })
      .from(cs)
      .where(eq(cs.id, input.costSheetId))
      .for("update")
      .limit(1);
    if (!cha) return { error: "Không tìm thấy bảng giá thành" };
    const kiem = checkCostFinalize({ status: cha.status as "DRAFT" | "FINAL", finalizerUserId: input.actor.id, canApprove: input.canApprove });
    if ("error" in kiem) return { error: kiem.error };
    const [{ soDong }] = await tx.select({ soDong: sql<number>`count(*)::int` }).from(cl).where(eq(cl.costSheetId, cha.id));
    if (!Number(soDong)) return { error: "Bảng chưa có dòng chi phí nào — không chốt một bảng rỗng" };
    const now = new Date();
    const doi = await tx
      .update(cs)
      .set({ status: "FINAL", finalizedAt: now, finalizedByUserId: input.actor.id, finalizedBy: input.actor.label, updatedAt: now })
      .where(and(eq(cs.id, cha.id), eq(cs.status, "DRAFT")))
      .returning({ id: cs.id });
    if (!doi.length) return { error: "Bảng này vừa được chốt ở chỗ khác" };
    const eventId = await emitDomainEvent(tx, {
      name: "costing.finalized",
      subjectType: "cost_sheet",
      subjectId: cha.id,
      modelId: cha.modelId,
      payload: { version: cha.version, totalUnitCost: cha.total },
      actorKind: "USER",
      actorId: input.actor.id,
      source: "ui:/production",
      dedupeKey: `costing.finalized:${cha.id}`,
      occurredAt: now,
    });
    return { ok: true as const, version: cha.version, totalUnitCost: cha.total, eventId };
  });
}

/** Dòng của một bảng — dùng cho ảnh chụp bản duyệt và màn hình. */
export async function loadCostLines(db: DbLike, costSheetId: string) {
  return db.select().from(cl).where(eq(cl.costSheetId, costSheetId)).orderBy(asc(cl.sortOrder));
}

/** Bảng CHỐT mới nhất của một mẫu (theo số phiên bản), hoặc `null` khi chưa có bảng chốt nào. */
export async function latestFinalCostSheet(db: DbLike, modelId: string) {
  const [r] = await db.select().from(cs).where(and(eq(cs.modelId, modelId), eq(cs.status, "FINAL"))).orderBy(desc(cs.version)).limit(1);
  return r ?? null;
}
