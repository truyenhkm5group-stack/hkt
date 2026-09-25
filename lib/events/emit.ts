import type { Db } from "@/db";
import { schema } from "@/db";
import { DOMAIN_EVENT_BY_NAME, DOMAIN_EVENT_NAME_PATTERN, type DomainActorKind, type DomainEventName } from "@/lib/constants/domain-events";

/**
 * ═══════════ PHÁT MỘT SỰ KIỆN MIỀN (Company OS) ═══════════
 *
 * Hợp đồng: docs/company-os/shared-contracts.md mục 2.
 *
 * Nhận `db` HOẶC giao dịch đang mở: nơi gọi ghi dữ liệu nghiệp vụ và phát sự kiện trong CÙNG một giao
 * dịch, để không bao giờ có dòng nghiệp vụ mà thiếu sự kiện (hay ngược lại).
 *
 *  · Tên không có trong sổ khai (`lib/constants/domain-events.ts`) ⇒ NÉM LỖI. Đây là lỗi lập trình.
 *  · `subjectType` khác sổ khai ⇒ NÉM LỖI — một sự kiện `model.*` gắn vào subject khác sẽ không bao giờ
 *    hiện trên dòng thời gian nó thuộc về.
 *  · `dedupeKey` trùng ⇒ `ON CONFLICT DO NOTHING`, trả `null`. Nguồn gửi lại (job chạy lại, người bấm
 *    hai lần) không đẻ ra sự kiện thứ hai.
 *
 * KHÔNG gọi hàm này trong giao dịch của webhook Pancake / Viettel Post hay job đồng bộ nóng
 * (target-architecture.md Q5, AGENTS.md mục 51).
 *
 * APPEND-ONLY: tệp này chỉ INSERT. Không ở đâu được UPDATE / DELETE `domain_events`.
 */
type DbLike = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

export type DomainEventInput = {
  name: DomainEventName;
  subjectType: string;
  subjectId: string;
  modelId?: string | null;
  payload?: Record<string, unknown>;
  actorKind: DomainActorKind;
  /** `users.id`; bắt buộc khi `actorKind = 'USER'` (CHECK ở CSDL). */
  actorId?: string | null;
  source: string;
  correlationId?: string | null;
  causationId?: string | null;
  dedupeKey?: string | null;
  /** Giờ NGHIỆP VỤ. Mặc định: lúc gọi. */
  occurredAt?: Date;
};

export async function emitDomainEvent(db: DbLike, input: DomainEventInput): Promise<string | null> {
  const spec = DOMAIN_EVENT_BY_NAME[input.name];
  if (!spec || !DOMAIN_EVENT_NAME_PATTERN.test(input.name)) {
    throw new Error(`Sự kiện "${String(input.name)}" chưa khai trong lib/constants/domain-events.ts — không phát tên chưa khai`);
  }
  if (spec.subjectType !== input.subjectType) {
    throw new Error(`Sự kiện "${input.name}" khai subject "${spec.subjectType}" nhưng được phát với subject "${input.subjectType}"`);
  }
  const [row] = await db
    .insert(schema.domainEvents)
    .values({
      name: input.name,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      modelId: input.modelId ?? null,
      payload: input.payload ?? {},
      actorKind: input.actorKind,
      actorId: input.actorId ?? null,
      source: input.source,
      correlationId: input.correlationId ?? null,
      causationId: input.causationId ?? null,
      dedupeKey: input.dedupeKey ?? null,
      occurredAt: input.occurredAt ?? new Date(),
    })
    .onConflictDoNothing({ target: schema.domainEvents.dedupeKey })
    .returning({ id: schema.domainEvents.id });
  return row?.id ?? null;
}
