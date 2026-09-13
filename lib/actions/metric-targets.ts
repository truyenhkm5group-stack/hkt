"use server";

import { and, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import { canTargetPerson, metricOf } from "@/lib/constants/metric-registry";
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

  const spec = metricOf(d.metricKey);
  if (!spec) return { error: "Chỉ số không có trong sổ" };
  if (!spec.targetable) return { error: spec.missingWhat ?? `"${spec.label}" chưa đo được nên không đặt đích được` };
  if (d.scope === "COMPANY" && d.scopeRef) return { error: "Đích toàn công ty không gắn với phòng, chức danh hay cá nhân nào" };
  if (d.scope !== "COMPANY" && !d.scopeRef) return { error: "Phải chọn phòng ban, chức danh hoặc người" };
  /*
    ĐÍCH CHO MỘT CÁ NHÂN bị chặn ở đây VÀ ở lược đồ đầu vào. Chỉ số mức công ty gắn tên một người
    là chấm người đó bằng kết quả của cả shop; chỉ số mang cờ `shared` (ĐVVC giao được hay không)
    là chấm người bằng thứ họ không quyết được — AGENTS.md mục 24 và 27.
  */
  if (d.scope === "USER") {
    const duoc = canTargetPerson(d.metricKey);
    if (!duoc.ok) return { error: duoc.reason ?? "Chỉ số này không đặt đích cho một cá nhân được" };
  }
  if (spec.unit === "PERCENT" && (d.target < 0 || d.target > 100)) return { error: "Đích theo phần trăm phải nằm trong 0–100" };
  if (spec.unit === "PERCENT" && d.targetMax !== null && (d.targetMax < 0 || d.targetMax > 100)) return { error: "Cận trên theo phần trăm phải nằm trong 0–100" };

  const db = await getDb();
  const ref = d.scope === "COMPANY" ? null : d.scopeRef;

  /*
    Đặt lại đích cho ĐÚNG cùng một mốc hiệu lực VÀ cùng hình dạng kỳ là SỬA, không phải thêm dòng
    thứ hai.

    `periodKind` bắt buộc nằm trong mệnh đề tra: thiếu nó thì đặt "2.000 đơn mỗi THÁNG" sẽ tìm thấy
    dòng "500 đơn mỗi TUẦN" và SỬA ĐÈ lên nó — chủ shop mất một đích đã đặt mà không có cảnh báo
    nào. Khoá duy nhất `metric_targets_uq` khai đúng bốn cột này.
  */
  const [cu] = await db
    .select()
    .from(schema.metricTargets)
    .where(
      and(
        eq(schema.metricTargets.metricKey, d.metricKey),
        eq(schema.metricTargets.scope, d.scope),
        sql`coalesce(${schema.metricTargets.scopeRef}, '') = ${ref ?? ""}`,
        eq(schema.metricTargets.periodKind, d.periodKind),
        eq(schema.metricTargets.effectiveFrom, d.effectiveFrom),
      ),
    )
    .limit(1);

  const chung = {
    target: d.target,
    targetMax: d.targetMax,
    warningAt: d.warningAt,
    criticalAt: d.criticalAt,
    periodKind: d.periodKind,
    note: d.note,
    effectiveTo: d.effectiveTo,
    ownerDepartment: d.ownerDepartment,
  };

  if (cu) {
    // Sửa một đích ĐÃ CÓ là một quyết định mới về cùng một cam kết, nên số phiên bản đi lên —
    // nhật ký giữ lại cả con số cũ để kỳ sau đọc được vì sao nó đổi.
    await db.update(schema.metricTargets).set({ ...chung, version: cu.version + 1, setBy: user.id, setByEmail: user.email, updatedAt: new Date() }).where(eq(schema.metricTargets.id, cu.id));
  } else {
    await db.insert(schema.metricTargets).values({ ...chung, metricKey: d.metricKey, scope: d.scope, scopeRef: ref, effectiveFrom: d.effectiveFrom, setBy: user.id, setByEmail: user.email });
  }

  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "METRIC_TARGET_SET",
    entity: "METRIC_TARGET",
    entityId: `${d.metricKey}:${d.scope}:${ref ?? ""}`,
    before: cu ? { target: cu.target, targetMax: cu.targetMax, note: cu.note, periodKind: cu.periodKind, version: cu.version } : null,
    after: { ...chung, effectiveFrom: d.effectiveFrom.toISOString(), effectiveTo: d.effectiveTo?.toISOString() ?? null, unit: spec.unit, direction: spec.direction, version: (cu?.version ?? 0) + 1 },
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
    before: { target: cu.target, targetMax: cu.targetMax, note: cu.note, effectiveFrom: cu.effectiveFrom.toISOString(), version: cu.version },
    after: null,
    reason: "Bỏ đích — chỉ số quay về hiện thực tế mà không kết luận đạt/không đạt",
  });
  revalidatePath("/work/performance");
  revalidatePath("/work/settings");
  return { ok: true };
}
