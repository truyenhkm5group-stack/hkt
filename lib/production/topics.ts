import { and, eq } from "drizzle-orm";
import { schema, type Db } from "@/db";
import type { Actor } from "@/lib/constants/actor";
import {
  checkTopicTransition,
  TOPIC_STATUS_LABEL,
  type TopicEvidenceSnapshot,
  type TopicMessageKind,
  type TopicRequirements,
  type TopicStatus,
} from "@/lib/constants/production-os";
import { emitDomainEvent } from "@/lib/events/emit";
import { followModelLifecycle, type LifecycleFollow } from "@/lib/production/lifecycle";

/**
 * ═══════════ LÕI DỊCH VỤ: TOPIC HỎI GIÁ / BÀN PHƯƠNG ÁN (Company OS · Agent C) ═══════════
 *
 * KHÔNG "use server": server action (`lib/actions/production-topics.ts`) và kiểm thử cùng gọi vào đây
 * với một `Actor`. Mỗi hàm ghi dữ liệu nghiệp vụ, phát sự kiện VÀ để vòng đời mẫu đi theo
 * (`followModelLifecycle`) trong CÙNG MỘT giao dịch — hỏng một bước là huỷ cả (Agent K).
 *
 * `production_topic_messages` là APPEND-ONLY: tệp này chỉ INSERT vào đó.
 */
type DbLike = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

const tp = schema.productionTopics;
const msg = schema.productionTopicMessages;

function humanError(actor: Actor): string | null {
  return actor.id ? null : "Thao tác trên topic sản xuất phải mang khoá tài khoản ERP (AGENTS.md mục 34)";
}

export type CreateTopicInput = {
  modelId: string;
  title: string;
  requirements: TopicRequirements;
  supplierId: string | null;
  evidence: TopicEvidenceSnapshot;
  /** Lời mở đầu (tuỳ chọn) — thành lượt trao đổi đầu tiên. */
  firstMessage?: string | null;
  actor: Actor;
};

export async function createTopicCore(db: Db, input: CreateTopicInput): Promise<{ ok: true; topicId: string; eventId: string | null; lifecycle: LifecycleFollow } | { error: string }> {
  const loi = humanError(input.actor);
  if (loi) return { error: loi };
  const title = input.title.trim();
  if (!title) return { error: "Topic cần tiêu đề" };
  const [m] = await db.select({ id: schema.productModels.id, code: schema.productModels.code }).from(schema.productModels).where(eq(schema.productModels.id, input.modelId)).limit(1);
  if (!m) return { error: "Không tìm thấy mẫu trong sổ" };

  const out = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(tp)
      .values({
        modelId: m.id,
        title,
        requirements: input.requirements,
        status: "WAITING_QUOTE",
        supplierId: input.supplierId,
        evidenceSnapshot: input.evidence,
        createdByUserId: input.actor.id,
        createdBy: input.actor.label,
        statusChangedAt: new Date(),
      })
      .returning({ id: tp.id });
    const eventId = await emitDomainEvent(tx, {
      name: "production_topic.created",
      subjectType: "production_topic",
      subjectId: row.id,
      modelId: m.id,
      payload: { code: m.code, title, supplierId: input.supplierId },
      actorKind: "USER",
      actorId: input.actor.id,
      source: "ui:/production/topics/new",
      dedupeKey: `production_topic.created:${row.id}`,
    });
    const first = (input.firstMessage ?? "").trim();
    if (first) await insertMessage(tx, { topicId: row.id, modelId: m.id, kind: "NOTE", body: first, attachments: [], quotedUnitPrice: null, actor: input.actor, causationId: eventId });
    const lifecycle = await followModelLifecycle(tx, { modelId: m.id, eventName: "production_topic.created", eventId, triggeredBy: input.actor, related: { type: "production_topic", id: row.id } });
    return { topicId: row.id, eventId, lifecycle };
  });

  return { ok: true, ...out };
}

type MessageRow = { topicId: string; modelId: string; kind: TopicMessageKind; body: string; attachments: string[]; quotedUnitPrice: number | null; actor: Actor; causationId?: string | null };

async function insertMessage(tx: DbLike, m: MessageRow): Promise<{ messageId: string; eventId: string | null }> {
  const [row] = await tx
    .insert(msg)
    .values({ topicId: m.topicId, authorUserId: m.actor.id, authorName: m.actor.label, kind: m.kind, body: m.body, attachments: m.attachments, quotedUnitPrice: m.kind === "QUOTE" ? m.quotedUnitPrice : null })
    .returning({ id: msg.id });
  const eventId = await emitDomainEvent(tx, {
    name: "production_topic.message_added",
    subjectType: "production_topic",
    subjectId: m.topicId,
    modelId: m.modelId,
    payload: { messageId: row.id, kind: m.kind, quotedUnitPrice: m.kind === "QUOTE" ? m.quotedUnitPrice : null },
    actorKind: m.actor.id ? "USER" : "SYSTEM",
    actorId: m.actor.id,
    source: "ui:/production/topics",
    causationId: m.causationId ?? null,
    dedupeKey: `production_topic.message_added:${row.id}`,
  });
  return { messageId: row.id, eventId };
}

export async function addTopicMessageCore(
  db: Db,
  input: { topicId: string; kind: TopicMessageKind; body: string; attachments: string[]; quotedUnitPrice: number | null; actor: Actor },
): Promise<{ ok: true; messageId: string } | { error: string }> {
  const loi = humanError(input.actor);
  if (loi) return { error: loi };
  const body = input.body.trim();
  if (!body) return { error: "Nội dung trao đổi đang trống" };
  if (input.kind === "QUOTE" && input.quotedUnitPrice === null) return { error: "Lượt báo giá cần ghi giá mỗi sản phẩm (VND)" };
  const [t] = await db.select({ id: tp.id, modelId: tp.modelId }).from(tp).where(eq(tp.id, input.topicId)).limit(1);
  if (!t) return { error: "Không tìm thấy topic" };
  return db.transaction(async (tx) => {
    // `updated_at` của topic đi theo lượt trao đổi mới nhất — để danh sách xếp đúng "vừa có tin".
    await tx.update(tp).set({ updatedAt: new Date() }).where(eq(tp.id, t.id));
    const r = await insertMessage(tx, { topicId: t.id, modelId: t.modelId, kind: input.kind, body, attachments: input.attachments, quotedUnitPrice: input.quotedUnitPrice, actor: input.actor });
    return { ok: true as const, messageId: r.messageId };
  });
}

/**
 * Đổi trạng thái topic. Cùng trạng thái ⇒ không ghi gì (bấm hai lần). Ghi chú kèm theo thành một lượt
 * trao đổi (`DECISION` khi chốt phương án, `NOTE` còn lại) — lý do đổi không sống trong một cột bị ghi đè.
 * Hàng rào trạng thái cũ: hai người cùng đổi thì người sau nhận lỗi.
 */
export async function setTopicStatusCore(
  db: Db,
  input: { topicId: string; to: TopicStatus; note?: string | null; selectedOption?: string | null; actor: Actor },
): Promise<{ ok: true; noop: boolean; from: TopicStatus; to: TopicStatus } | { error: string }> {
  const loi = humanError(input.actor);
  if (loi) return { error: loi };
  const [t] = await db.select({ id: tp.id, modelId: tp.modelId, status: tp.status }).from(tp).where(eq(tp.id, input.topicId)).limit(1);
  if (!t) return { error: "Không tìm thấy topic" };
  const from = t.status as TopicStatus;
  const kiem = checkTopicTransition(from, input.to, { selectedOption: input.selectedOption, note: input.note });
  if (!kiem.ok) return { error: kiem.error };
  if (kiem.noop) return { ok: true, noop: true, from, to: input.to };
  const note = (input.note ?? "").trim();
  const selected = input.to === "SELECTED" ? (input.selectedOption ?? "").trim() : undefined;

  return db.transaction(async (tx) => {
    const now = new Date();
    const doi = await tx
      .update(tp)
      .set({ status: input.to, statusChangedAt: now, updatedAt: now, ...(selected !== undefined ? { selectedOption: selected } : {}) })
      .where(and(eq(tp.id, t.id), eq(tp.status, from)))
      .returning({ id: tp.id });
    if (!doi.length) return { error: "Topic vừa được người khác đổi trạng thái — tải lại trang rồi thử lại" };
    const eventId = await emitDomainEvent(tx, {
      name: "production_topic.status_changed",
      subjectType: "production_topic",
      subjectId: t.id,
      modelId: t.modelId,
      payload: { from, to: input.to, selectedOption: selected ?? null, note: note || null },
      actorKind: "USER",
      actorId: input.actor.id,
      source: "ui:/production/topics",
      occurredAt: now,
    });
    const body = [
      `${TOPIC_STATUS_LABEL[from]} → ${TOPIC_STATUS_LABEL[input.to]}`,
      selected ? `Phương án chốt: ${selected}` : "",
      note,
    ]
      .filter(Boolean)
      .join("\n");
    await insertMessage(tx, { topicId: t.id, modelId: t.modelId, kind: input.to === "SELECTED" ? "DECISION" : "NOTE", body, attachments: [], quotedUnitPrice: null, actor: input.actor, causationId: eventId });
    return { ok: true as const, noop: false, from, to: input.to };
  });
}
