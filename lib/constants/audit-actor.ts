/**
 * Loại TÁC NHÂN của một dòng nhật ký (`audit_logs.actor_kind`) — Company OS · Agent G.
 *
 * Cùng từ vựng với `domain_events.actor_kind` (docs/company-os/shared-contracts.md mục 2), để hai
 * sổ nói cùng một ngôn ngữ về "ai làm". `NULL` ở cột nghĩa là CHƯA BIẾT (dòng cũ trước 0134, hoặc
 * không suy được) — không bao giờ in thành "người dùng".
 *
 * Tệp thuần: bảng nhật ký phía trình duyệt đọc được nhãn mà không kéo `getDb` vào gói client.
 */
export const AUDIT_ACTOR_KINDS = ["USER", "SYSTEM", "AGENT", "WEBHOOK"] as const;
export type AuditActorKind = (typeof AUDIT_ACTOR_KINDS)[number];

export const AUDIT_ACTOR_KIND_LABEL: Record<AuditActorKind, string> = {
  USER: "Người dùng",
  SYSTEM: "Máy (job / script)",
  AGENT: "Agent AI",
  WEBHOOK: "Webhook",
};
