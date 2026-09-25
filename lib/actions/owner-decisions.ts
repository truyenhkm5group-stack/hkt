"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/db";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import { OWNER_DECISION_KINDS, OWNER_DECISION_KIND_SPEC, RECOMMENDATION_DECISIONS } from "@/lib/constants/owner-decisions";
import { vnStartOfDay } from "@/lib/format";
import { recordRecommendationDecisionCore } from "@/lib/owner-decisions/service";
import { findOwnerDecisionItem } from "@/lib/queries/owner-decisions";

/**
 * ═══════════ GHI PHẢN ỨNG VỚI ĐỀ XUẤT "CẦN ANH QUYẾT" (Company OS · Agent H) ═══════════
 *
 * requireUser → can(dashboard:view) → zod → MÁY CHỦ dựng lại đúng đề xuất (quyền màn hình chủ của loại
 * được kiểm ở đó: không quyền ⇒ không thấy ⇒ không ghi được) → lõi dịch vụ (dòng sổ + sự kiện cùng
 * giao dịch) → audit → revalidatePath.
 *
 * Tên người quyết do MÁY CHỦ đọc từ phiên (luật 34) — lược đồ đầu vào không có trường tên, và không có
 * trường ảnh chụp: ảnh chụp là thứ ERP đề xuất, không phải thứ trình duyệt gửi lên.
 */
type Result = { ok: true; skipped: boolean } | { error: string };

const input = z.object({
  kind: z.enum(OWNER_DECISION_KINDS),
  sourceKey: z.string().trim().min(1).max(300),
  decision: z.enum(RECOMMENDATION_DECISIONS),
  reason: z.string().max(1000).optional().nullable(),
  /** Ngày nhắc lại, `YYYY-MM-DD` giờ Việt Nam — ẩn tới 00:00 ngày đó. */
  snoozeUntil: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Ngày nhắc lại không hợp lệ")
    .optional()
    .nullable(),
  /** Nơi bấm — chỉ để ghi nguồn sự kiện. */
  from: z.enum(["home", "cockpit"]).optional(),
});

export async function decideRecommendation(raw: unknown): Promise<Result> {
  const user = await requireUser();
  if (!can(user, "dashboard:view")) return { error: "Không đủ quyền xem buồng lái" };
  const parsed = input.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const d = parsed.data;
  const now = new Date();

  const found = await findOwnerDecisionItem(d.kind, d.sourceKey, user, { now });
  if ("error" in found) {
    if (found.error === "FORBIDDEN") return { error: `Không đủ quyền với “${OWNER_DECISION_KIND_SPEC[d.kind].label}” — cần quyền của màn hình ${OWNER_DECISION_KIND_SPEC[d.kind].home}` };
    if (found.error === "SOURCE_FAILED") return { error: `Chưa đọc lại được nguồn để chụp đề xuất (${found.detail ?? "lỗi"}). Thử lại sau ít giây.` };
    return { error: "Đề xuất này không còn trong nguồn (điều kiện đã đổi hoặc đã được xử lý) — tải lại trang." };
  }

  const snoozeUntil = d.decision === "SNOOZED" && d.snoozeUntil ? vnStartOfDay(d.snoozeUntil) : null;
  const db = await getDb();
  const r = await recordRecommendationDecisionCore(db, {
    item: found.item,
    decision: d.decision,
    reason: d.reason ?? "",
    snoozeUntil,
    actor: { id: user.id, label: user.name || user.email },
    source: d.from === "cockpit" ? "ui:/cockpit" : "ui:/",
    now,
  });
  if ("error" in r) return { error: r.error };
  if (r.skipped) return { ok: true, skipped: true };

  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "RECOMMENDATION_DECIDED",
    entity: "RECOMMENDATION",
    entityId: d.sourceKey,
    after: { decisionId: r.id, kind: d.kind, decision: d.decision, snoozeUntil: snoozeUntil?.toISOString() ?? null },
    reason: (d.reason ?? "").trim() || undefined,
  });
  revalidatePath("/");
  revalidatePath("/cockpit");
  return { ok: true, skipped: false };
}
