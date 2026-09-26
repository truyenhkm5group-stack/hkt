import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import type { Actor } from "@/lib/constants/actor";
import { checkSampleReview, SAMPLE_OPEN_STATUSES, SAMPLE_STATUS_AFTER, SAMPLE_STATUS_LABEL, type SampleReviewDecision, type SampleStatus } from "@/lib/constants/production-os";
import { emitDomainEvent } from "@/lib/events/emit";
import { latestFinalCostSheet, loadCostLines } from "@/lib/production/costing";
import { followModelLifecycle, type LifecycleFollow } from "@/lib/production/lifecycle";

/**
 * ═══════════ LÕI DỊCH VỤ: MẪU (SAMPLE) · DUYỆT MẪU · BẢN THIẾT KẾ ĐÃ DUYỆT (Company OS · Agent C) ═══════════
 *
 * Một phiên bản mẫu đi: IN_PROGRESS → SUBMITTED → (REQUEST_CHANGES | REJECT | APPROVE). Cả ba phán quyết
 * KẾT THÚC phiên bản; sửa tiếp là phiên bản mới (V2…). Mỗi mẫu tối đa MỘT phiên bản đang mở.
 *
 * `sample_reviews` và `design_versions` là APPEND-ONLY: tệp này chỉ INSERT vào chúng. Bản thiết kế đã
 * duyệt sinh ra DUY NHẤT ở đây, trong CÙNG giao dịch với lượt duyệt — không có đường nào khác tạo nó.
 */
type DbLike = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

const sm = schema.samples;
const rv = schema.sampleReviews;
const dv = schema.designVersions;

function humanError(actor: Actor): string | null {
  return actor.id ? null : "Thao tác trên mẫu phải mang khoá tài khoản ERP (AGENTS.md mục 34)";
}

export type SampleFields = {
  supplierId: string | null;
  costVnd: number | null;
  images: string[];
  notes: string;
  problems: string;
};

export async function createSampleCore(
  db: Db,
  input: { modelId: string; topicId: string | null; fields: SampleFields; actor: Actor },
): Promise<{ ok: true; sampleId: string; version: number; eventId: string | null; lifecycle: LifecycleFollow } | { error: string }> {
  const loi = humanError(input.actor);
  if (loi) return { error: loi };
  const [m] = await db.select({ id: schema.productModels.id, code: schema.productModels.code }).from(schema.productModels).where(eq(schema.productModels.id, input.modelId)).limit(1);
  if (!m) return { error: "Không tìm thấy mẫu trong sổ" };
  if (input.topicId) {
    const [t] = await db.select({ modelId: schema.productionTopics.modelId }).from(schema.productionTopics).where(eq(schema.productionTopics.id, input.topicId)).limit(1);
    if (!t || t.modelId !== m.id) return { error: "Topic không thuộc mẫu này" };
  }

  const out = await db.transaction(async (tx): Promise<{ error: string } | { sampleId: string; version: number; eventId: string | null; lifecycle: LifecycleFollow }> => {
    const [mo] = await tx
      .select({ version: sm.version, status: sm.status })
      .from(sm)
      .where(and(eq(sm.modelId, m.id), inArray(sm.status, [...SAMPLE_OPEN_STATUSES])))
      .limit(1);
    if (mo) return { error: `Phiên bản mẫu V${mo.version} còn đang “${SAMPLE_STATUS_LABEL[mo.status as SampleStatus]}” — duyệt xong phiên bản đó rồi mới làm phiên bản mới` };
    const [{ n }] = await tx.select({ n: sql<number>`coalesce(max(${sm.version}), 0)::int` }).from(sm).where(eq(sm.modelId, m.id));
    const version = Number(n) + 1;
    const [row] = await tx
      .insert(sm)
      .values({
        modelId: m.id,
        topicId: input.topicId,
        version,
        supplierId: input.fields.supplierId,
        costVnd: input.fields.costVnd,
        images: input.fields.images,
        notes: input.fields.notes.trim(),
        problems: input.fields.problems.trim(),
        status: "IN_PROGRESS",
        createdByUserId: input.actor.id,
        createdBy: input.actor.label,
      })
      .returning({ id: sm.id });
    const eventId = await emitDomainEvent(tx, {
      name: "sample.created",
      subjectType: "sample",
      subjectId: row.id,
      modelId: m.id,
      payload: { code: m.code, version, supplierId: input.fields.supplierId, costVnd: input.fields.costVnd },
      actorKind: "USER",
      actorId: input.actor.id,
      source: "ui:/production",
      dedupeKey: `sample.created:${row.id}`,
    });
    const lifecycle = await followModelLifecycle(tx, { modelId: m.id, eventName: "sample.created", eventId, triggeredBy: input.actor, related: { type: "sample", id: row.id } });
    return { sampleId: row.id, version, eventId, lifecycle };
  });
  if ("error" in out) return { error: out.error };
  return { ok: true, ...out };
}

/** Sửa thông tin phiên bản mẫu khi xưởng CÒN ĐANG LÀM. Đã gửi duyệt ⇒ khoá (người duyệt đang xem đúng thứ đó). */
export async function updateSampleCore(db: Db, input: { sampleId: string; fields: SampleFields; actor: Actor }): Promise<{ ok: true } | { error: string }> {
  const loi = humanError(input.actor);
  if (loi) return { error: loi };
  const doi = await db
    .update(sm)
    .set({ supplierId: input.fields.supplierId, costVnd: input.fields.costVnd, images: input.fields.images, notes: input.fields.notes.trim(), problems: input.fields.problems.trim(), updatedAt: new Date() })
    .where(and(eq(sm.id, input.sampleId), eq(sm.status, "IN_PROGRESS")))
    .returning({ id: sm.id });
  if (!doi.length) return { error: "Chỉ sửa được mẫu xưởng đang làm — mẫu đã gửi duyệt thì giữ nguyên thứ người duyệt đang xem" };
  return { ok: true };
}

export async function submitSampleCore(db: Db, input: { sampleId: string; actor: Actor }): Promise<{ ok: true; noop: boolean; lifecycle: LifecycleFollow | null } | { error: string }> {
  const loi = humanError(input.actor);
  if (loi) return { error: loi };
  const [s] = await db.select({ id: sm.id, modelId: sm.modelId, status: sm.status, version: sm.version }).from(sm).where(eq(sm.id, input.sampleId)).limit(1);
  if (!s) return { error: "Không tìm thấy mẫu" };
  // Bấm hai lần không ghi thêm gì (cùng bài học với AGENTS.md mục 61).
  if (s.status === "SUBMITTED") return { ok: true, noop: true, lifecycle: null };
  if (s.status !== "IN_PROGRESS") return { error: `Mẫu đang “${SAMPLE_STATUS_LABEL[s.status as SampleStatus]}” — không gửi duyệt lại được` };
  const out = await db.transaction(async (tx): Promise<{ error: string } | { eventId: string | null; lifecycle: LifecycleFollow }> => {
    const now = new Date();
    const doi = await tx.update(sm).set({ status: "SUBMITTED", submittedAt: now, updatedAt: now }).where(and(eq(sm.id, s.id), eq(sm.status, "IN_PROGRESS"))).returning({ id: sm.id });
    if (!doi.length) return { error: "Mẫu vừa được đổi ở chỗ khác — tải lại trang" };
    const eventId = await emitDomainEvent(tx, {
      name: "sample.submitted",
      subjectType: "sample",
      subjectId: s.id,
      modelId: s.modelId,
      payload: { version: s.version },
      actorKind: "USER",
      actorId: input.actor.id,
      source: "ui:/production",
      dedupeKey: `sample.submitted:${s.id}`,
      occurredAt: now,
    });
    const lifecycle = await followModelLifecycle(tx, { modelId: s.modelId, eventName: "sample.submitted", eventId, triggeredBy: input.actor, related: { type: "sample", id: s.id } });
    return { eventId, lifecycle };
  });
  if ("error" in out) return { error: out.error };
  return { ok: true, noop: false, lifecycle: out.lifecycle };
}

export type ReviewResult = { ok: true; reviewId: string; status: SampleStatus; designVersionId: string | null; designVersion: number | null; lifecycle: LifecycleFollow | null } | { error: string };

/**
 * Ghi phán quyết cho MỘT phiên bản mẫu. Luật ở `checkSampleReview` (thuần): APPROVE / REJECT cần
 * `production:approve` (action truyền `canApprove = can(user, "production:approve")`), REQUEST_CHANGES /
 * REJECT bắt buộc ghi chú, người duyệt là một `users.id`.
 *
 * APPROVE ⇒ trong CÙNG giao dịch: đóng băng bản thiết kế (`design_versions`) với ảnh chụp trường mẫu +
 * yêu cầu topic + bản sao dòng giá thành CHỐT mới nhất (hoặc câu "chưa có bảng chốt" — không bịa số).
 */
export async function reviewSampleCore(
  db: Db,
  input: { sampleId: string; decision: SampleReviewDecision; note: string | null; actor: Actor; canApprove: boolean },
): Promise<ReviewResult> {
  const note = (input.note ?? "").trim();
  type Ra = { reviewId: string; status: SampleStatus; designVersionId: string | null; designVersion: number | null; followEvent: { name: string; id: string | null } | null; modelId: string };
  // Vòng đời đi theo phán quyết TRONG cùng giao dịch với nó (Agent K): phần thân ghi phán quyết chạy
  // trước, rồi đi theo sự kiện nó trả về trước khi giao dịch chốt.
  const out = await db.transaction(async (tx): Promise<{ error: string } | (Ra & { lifecycle: LifecycleFollow | null })> => {
    const ra = await reviewInTx(tx);
    if ("error" in ra) return ra;
    const lifecycle = ra.followEvent
      ? await followModelLifecycle(tx, { modelId: ra.modelId, eventName: ra.followEvent.name, eventId: ra.followEvent.id, triggeredBy: input.actor, related: { type: "sample", id: input.sampleId } })
      : null;
    return { ...ra, lifecycle };
  });
  if ("error" in out) return { error: out.error };
  return { ok: true, reviewId: out.reviewId, status: out.status, designVersionId: out.designVersionId, designVersion: out.designVersion, lifecycle: out.lifecycle };

  async function reviewInTx(tx: DbLike): Promise<{ error: string } | Ra> {
    const [s] = await tx.select().from(sm).where(eq(sm.id, input.sampleId)).for("update").limit(1);
    if (!s) return { error: "Không tìm thấy mẫu" };
    const kiem = checkSampleReview({ status: s.status as SampleStatus, decision: input.decision, note, reviewerUserId: input.actor.id, canApprove: input.canApprove });
    if ("error" in kiem) return { error: kiem.error };
    const reviewer = input.actor.id as string;
    const now = new Date();
    const status = SAMPLE_STATUS_AFTER[input.decision];

    const [r] = await tx.insert(rv).values({ sampleId: s.id, decision: input.decision, note, reviewerUserId: reviewer, reviewerName: input.actor.label, reviewedAt: now }).returning({ id: rv.id });
    const doi = await tx
      .update(sm)
      .set({ status, decidedAt: now, updatedAt: now, ...(input.decision === "REQUEST_CHANGES" ? { requestedChanges: note } : {}) })
      .where(and(eq(sm.id, s.id), eq(sm.status, "SUBMITTED")))
      .returning({ id: sm.id });
    if (!doi.length) throw new Error("Mẫu vừa được duyệt ở chỗ khác");

    const reviewedEvent = await emitDomainEvent(tx, {
      name: "sample.reviewed",
      subjectType: "sample",
      subjectId: s.id,
      modelId: s.modelId,
      payload: { version: s.version, decision: input.decision, reviewId: r.id, note: note || null },
      actorKind: "USER",
      actorId: reviewer,
      source: "ui:/production",
      dedupeKey: `sample.reviewed:${r.id}`,
      occurredAt: now,
    });
    if (input.decision !== "APPROVE") return { reviewId: r.id, status, designVersionId: null, designVersion: null, followEvent: input.decision === "REQUEST_CHANGES" ? { name: "sample.reviewed", id: reviewedEvent } : null, modelId: s.modelId };

    const approvedEvent = await emitDomainEvent(tx, {
      name: "sample.approved",
      subjectType: "sample",
      subjectId: s.id,
      modelId: s.modelId,
      payload: { version: s.version, reviewId: r.id },
      actorKind: "USER",
      actorId: reviewer,
      source: "ui:/production",
      causationId: reviewedEvent,
      dedupeKey: `sample.approved:${s.id}`,
      occurredAt: now,
    });

    const spec = await buildDesignSpec(tx, s, now);
    const [{ n }] = await tx.select({ n: sql<number>`coalesce(max(${dv.version}), 0)::int` }).from(dv).where(eq(dv.modelId, s.modelId));
    const version = Number(n) + 1;
    const [d] = await tx
      .insert(dv)
      .values({ modelId: s.modelId, sampleId: s.id, reviewId: r.id, costSheetId: spec.costSheetId, version, spec: spec.spec, approvedByUserId: reviewer, approvedBy: input.actor.label, approvedAt: now })
      .returning({ id: dv.id });
    await emitDomainEvent(tx, {
      name: "design_version.approved",
      subjectType: "design_version",
      subjectId: d.id,
      modelId: s.modelId,
      payload: { version, sampleId: s.id, sampleVersion: s.version, costSheetId: spec.costSheetId },
      actorKind: "USER",
      actorId: reviewer,
      source: "ui:/production",
      causationId: approvedEvent,
      dedupeKey: `design_version.approved:${d.id}`,
      occurredAt: now,
    });
    return { reviewId: r.id, status, designVersionId: d.id, designVersion: version, followEvent: { name: "sample.approved", id: approvedEvent }, modelId: s.modelId };
  }
}

/**
 * Ảnh chụp bản thiết kế. Chép GIÁ TRỊ (không chép tham chiếu) để sửa topic / mẫu / giá thành về sau
 * không làm đổi thứ đã duyệt.
 */
async function buildDesignSpec(tx: DbLike, s: typeof schema.samples.$inferSelect, now: Date) {
  const [topic] = s.topicId
    ? await tx
        .select({ id: schema.productionTopics.id, title: schema.productionTopics.title, requirements: schema.productionTopics.requirements, selectedOption: schema.productionTopics.selectedOption, status: schema.productionTopics.status })
        .from(schema.productionTopics)
        .where(eq(schema.productionTopics.id, s.topicId))
        .limit(1)
    : [];
  const [supplier] = s.supplierId ? await tx.select({ name: schema.suppliers.name }).from(schema.suppliers).where(eq(schema.suppliers.id, s.supplierId)).limit(1) : [];
  const sheet = await latestFinalCostSheet(tx, s.modelId);
  const lines = sheet ? await loadCostLines(tx, sheet.id) : [];
  const spec = {
    snapshotAt: now.toISOString(),
    sample: {
      id: s.id,
      version: s.version,
      supplierId: s.supplierId,
      supplierName: supplier?.name ?? null,
      costVnd: s.costVnd,
      images: s.images,
      notes: s.notes,
      problems: s.problems,
      submittedAt: s.submittedAt ? s.submittedAt.toISOString() : null,
    },
    topic: topic ? { id: topic.id, title: topic.title, requirements: topic.requirements, selectedOption: topic.selectedOption, statusAtApproval: topic.status } : null,
    costSheet: sheet
      ? {
          id: sheet.id,
          version: sheet.version,
          totalUnitCost: sheet.totalUnitCost,
          finalizedAt: sheet.finalizedAt ? sheet.finalizedAt.toISOString() : null,
          finalizedBy: sheet.finalizedBy,
          lines: lines.map((l) => ({ kind: l.kind, description: l.description, qty: l.qty, unit: l.unit, unitCost: l.unitCost, amount: l.amount })),
        }
      : null,
    costSheetNote: sheet ? null : "Lúc duyệt mẫu CHƯA có bảng giá thành nào được chốt — bản duyệt này không mang giá thành.",
  };
  return { spec, costSheetId: sheet?.id ?? null };
}

/** Các bản thiết kế đã duyệt của một mẫu, mới nhất trước. */
export async function listDesignVersions(db: DbLike, modelId: string) {
  return db.select().from(dv).where(eq(dv.modelId, modelId)).orderBy(desc(dv.version));
}
