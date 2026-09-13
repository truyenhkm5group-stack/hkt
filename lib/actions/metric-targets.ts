"use server";

import { and, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import { METRIC_BY_KEY } from "@/lib/constants/metric-catalog";
import { targetDelete, targetInput } from "@/lib/validation/metric-targets";

/**
 * ═══════════ ĐẶT ĐÍCH CHO MỘT CHỈ SỐ ═══════════
 *
 * Đích là con số dùng để nói với một người rằng họ đạt hay không đạt. Nên mỗi lần đặt đều ghi
 * NGƯỜI ĐẶT, LÝ DO và MỐC HIỆU LỰC vào nhật ký — và mốc hiệu lực không được lùi về quá khứ để
 * chấm lại một kỳ đã chốt.
 *
 * Quyền: `work:admin` (quản trị bàn làm việc). Không mở cho trưởng phòng tự đặt đích cho phòng
 * mình: đích là cam kết giữa phòng và chủ shop, không phải thứ một phía đặt lấy.
 */
type Result = { ok: true } | { error: string };

export async function setMetricTarget(input: unknown): Promise<Result> {
  const user = await requireUser();
  if (!can(user, "work:admin")) return { error: "Không đủ quyền đặt đích chỉ số" };
  const parsed = targetInput.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const d = parsed.data;

  const spec = METRIC_BY_KEY[d.metricKey];
  if (!spec) return { error: "Chỉ số không có trong danh mục" };
  if (spec.direction === "CONTEXT") return { error: `"${spec.label}" là chỉ số đọc bối cảnh, không có chiều tốt/xấu nên không đặt đích được` };
  if (d.scope === "COMPANY" && d.scopeRef) return { error: "Đích toàn công ty không gắn với phòng hay chức danh nào" };
  if (d.scope !== "COMPANY" && !d.scopeRef) return { error: "Phải chọn phòng ban hoặc chức danh" };
  if (spec.unit === "PERCENT" && (d.target < 0 || d.target > 100)) return { error: "Đích theo phần trăm phải nằm trong 0–100" };

  const db = await getDb();
  const ref = d.scope === "COMPANY" ? null : d.scopeRef;

  // Đặt lại đích cho ĐÚNG cùng một mốc hiệu lực là SỬA, không phải thêm dòng thứ hai.
  const [cu] = await db
    .select()
    .from(schema.metricTargets)
    .where(and(eq(schema.metricTargets.metricKey, d.metricKey), eq(schema.metricTargets.scope, d.scope), sql`coalesce(${schema.metricTargets.scopeRef}, '') = ${ref ?? ""}`, eq(schema.metricTargets.effectiveFrom, d.effectiveFrom)))
    .limit(1);

  if (cu) {
    await db.update(schema.metricTargets).set({ target: d.target, note: d.note, setBy: user.id, setByEmail: user.email, updatedAt: new Date() }).where(eq(schema.metricTargets.id, cu.id));
  } else {
    await db.insert(schema.metricTargets).values({ metricKey: d.metricKey, scope: d.scope, scopeRef: ref, target: d.target, note: d.note, effectiveFrom: d.effectiveFrom, setBy: user.id, setByEmail: user.email });
  }

  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "METRIC_TARGET_SET",
    entity: "METRIC_TARGET",
    entityId: `${d.metricKey}:${d.scope}:${ref ?? ""}`,
    before: cu ? { target: cu.target, note: cu.note } : null,
    after: { target: d.target, note: d.note, effectiveFrom: d.effectiveFrom.toISOString(), unit: spec.unit, direction: spec.direction },
    reason: "Đặt đích cho chỉ số hiệu suất",
  });
  revalidatePath("/work/performance");
  revalidatePath("/work/settings");
  return { ok: true };
}

export async function deleteMetricTarget(input: unknown): Promise<Result> {
  const user = await requireUser();
  if (!can(user, "work:admin")) return { error: "Không đủ quyền đặt đích chỉ số" };
  const parsed = targetDelete.safeParse(input);
  if (!parsed.success) return { error: "Dữ liệu không hợp lệ" };

  const db = await getDb();
  const [cu] = await db.select().from(schema.metricTargets).where(eq(schema.metricTargets.id, parsed.data.id)).limit(1);
  if (!cu) return { error: "Không tìm thấy đích" };
  await db.delete(schema.metricTargets).where(eq(schema.metricTargets.id, parsed.data.id));

  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "METRIC_TARGET_DELETE",
    entity: "METRIC_TARGET",
    entityId: `${cu.metricKey}:${cu.scope}:${cu.scopeRef ?? ""}`,
    before: { target: cu.target, note: cu.note, effectiveFrom: cu.effectiveFrom.toISOString() },
    after: null,
    reason: "Bỏ đích — chỉ số quay về hiện thực tế mà không kết luận đạt/không đạt",
  });
  revalidatePath("/work/performance");
  revalidatePath("/work/settings");
  return { ok: true };
}
