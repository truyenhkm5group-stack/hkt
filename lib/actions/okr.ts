"use server";

import { and, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import { DEPARTMENT_CODES } from "@/lib/constants/departments";
import { isMetricKey, metricBinding, METRIC_UNITS } from "@/lib/constants/metric-bindings";
import { BSC_PERSPECTIVES, DEFAULT_TEMPLATES } from "@/lib/queries/bsc";
import { krShapeOf, templateByKey } from "@/lib/constants/okr-templates";
import { KR_CONFIDENCES, OKR_LEVELS, OKR_STATUSES, quarterRange } from "@/lib/queries/okr";
import { buildSnapshot, periodRange, REVIEW_KINDS, SNAPSHOT_VERSION, type ReviewKind } from "@/lib/queries/reviews";

/**
 * Server Action cho MỤC TIÊU (OKR · BSC · kỳ review).
 *
 * Hai điều được ép ở đây, không phải ở giao diện:
 *  1. `metric_source` phải là `MANUAL` hoặc một khoá CÓ THẬT trong sổ đăng ký chỉ số. Nối vào một
 *     khoá tưởng tượng thì KR sẽ mãi mãi hiện "chưa đo được" mà không ai hiểu vì sao.
 *  2. Kỳ review đã `FINAL` thì KHÔNG dựng lại ảnh chụp. Chốt kỳ là đóng băng.
 */

type Result<T = object> = ({ ok: true } & T) | { error: string };

function revalidate() {
  for (const p of ["/work/okr", "/work/performance", "/work/department", "/work"]) revalidatePath(p);
}

async function authorize(permission: "okr:manage" | "review:manage") {
  const user = await requireUser();
  const label = permission === "okr:manage" ? "đặt và chấm mục tiêu" : "lập và chốt kỳ review";
  return { user, error: can(user, permission) ? null : `Bạn không có quyền ${label}` };
}

async function departmentIdOf(code: string | null | undefined): Promise<string | null> {
  if (!code) return null;
  const db = await getDb();
  const row = await db.query.departments.findFirst({ where: eq(schema.departments.code, code), columns: { id: true } });
  return row?.id ?? null;
}

/* ═══════════════════ OBJECTIVE ═══════════════════ */

const objectiveSchema = z.object({
  id: z.string().optional(),
  level: z.enum(OKR_LEVELS),
  department: z.enum(DEPARTMENT_CODES).nullable().optional(),
  ownerUserId: z.string().trim().min(1).nullable().optional(),
  parentId: z.string().trim().min(1).nullable().optional(),
  title: z.string().trim().min(3).max(300),
  description: z.string().trim().max(2000).optional(),
  period: z.string().trim().regex(/^\d{4}(-(Q[1-4]|\d{2}))?$/, "Kỳ phải dạng 2026-Q3, 2026-09 hoặc 2026"),
  status: z.enum(OKR_STATUSES).optional(),
  sortOrder: z.number().int().min(0).max(999).optional(),
});

export async function saveObjective(input: unknown): Promise<Result<{ id: string }>> {
  const { user, error } = await authorize("okr:manage");
  if (error) return { error };
  const parsed = objectiveSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const d = parsed.data;
  if (d.level !== "COMPANY" && !d.department && !d.ownerUserId) return { error: "Mục tiêu cấp phòng / cá nhân phải nói rõ của phòng nào hoặc của ai" };

  const db = await getDb();
  const departmentId = await departmentIdOf(d.department);
  const range = quarterRange(d.period);
  // Kỳ dạng tháng / năm không có `quarterRange`; suy từ chính chuỗi kỳ, giờ Việt Nam.
  const { start, end } = range ?? rangeOfPeriod(d.period);
  const values = {
    level: d.level,
    departmentId,
    ownerUserId: d.ownerUserId ?? null,
    parentId: d.parentId ?? null,
    title: d.title,
    description: d.description ?? "",
    period: d.period,
    periodStart: start,
    periodEnd: end,
    status: d.status ?? "ACTIVE",
    sortOrder: d.sortOrder ?? 100,
    updatedAt: new Date(),
  };
  if (d.id) {
    if (d.parentId === d.id) return { error: "Mục tiêu không thể là cha của chính nó" };
    await db.update(schema.okrObjectives).set(values).where(eq(schema.okrObjectives.id, d.id));
    await audit({ userId: user.id, userEmail: user.email, action: "OKR_OBJECTIVE_UPDATE", entity: "OKR_OBJECTIVE", entityId: d.id, detail: { title: d.title, period: d.period } });
    revalidate();
    return { ok: true, id: d.id };
  }
  const id = crypto.randomUUID();
  await db.insert(schema.okrObjectives).values({ id, ...values, createdBy: user.id });
  await audit({ userId: user.id, userEmail: user.email, action: "OKR_OBJECTIVE_CREATE", entity: "OKR_OBJECTIVE", entityId: id, detail: { title: d.title, period: d.period, level: d.level } });
  revalidate();
  return { ok: true, id };
}

function rangeOfPeriod(period: string): { start: Date; end: Date } {
  const m = /^(\d{4})(?:-(\d{2}))?$/.exec(period);
  const year = m ? Number(m[1]) : new Date().getFullYear();
  if (m?.[2]) {
    const mo = Number(m[2]) - 1;
    return { start: new Date(Date.UTC(year, mo, 1, -7)), end: new Date(Date.UTC(year, mo + 1, 1, -7) - 1) };
  }
  return { start: new Date(Date.UTC(year, 0, 1, -7)), end: new Date(Date.UTC(year + 1, 0, 1, -7) - 1) };
}

/**
 * BẬT / TẠM DỪNG MỘT MỤC TIÊU — hành động riêng, cố ý tách khỏi `saveObjective`.
 *
 * Mẫu sinh ra mục tiêu ở trạng thái `DRAFT`, và việc chuyển nó sang `ACTIVE` phải là một cú bấm
 * có chủ ý của người phụ trách: từ lúc đó nó chảy vào mọi bảng tổng hợp và vào thẻ điểm cá nhân.
 * Gộp vào `saveObjective` thì mỗi lần sửa một chữ trong tiêu đề cũng gửi kèm trạng thái, và một
 * bản nháp sẽ bật lên vì ai đó sửa chính tả.
 */
export async function setObjectiveStatus(input: unknown): Promise<Result> {
  const { user, error } = await authorize("okr:manage");
  if (error) return { error };
  const parsed = z.object({ id: z.string().min(1), status: z.enum(OKR_STATUSES) }).safeParse(input);
  if (!parsed.success) return { error: "Dữ liệu không hợp lệ" };
  const db = await getDb();
  const ob = await db.query.okrObjectives.findFirst({ where: eq(schema.okrObjectives.id, parsed.data.id), columns: { id: true, title: true, status: true } });
  if (!ob) return { error: "Không tìm thấy mục tiêu" };

  if (parsed.data.status === "ACTIVE") {
    // Một mục tiêu không có KR nào thì không đo được gì — bật nó lên chỉ làm bẩn bảng tổng hợp.
    const krs = await db.query.okrKeyResults.findMany({ where: eq(schema.okrKeyResults.objectiveId, ob.id), columns: { id: true } });
    if (!krs.length) return { error: "Mục tiêu chưa có Key Result nào — thêm ít nhất một KR có đích rồi mới bật được" };
  }

  await db.update(schema.okrObjectives).set({ status: parsed.data.status, updatedAt: new Date() }).where(eq(schema.okrObjectives.id, ob.id));
  await audit({ userId: user.id, userEmail: user.email, action: "OKR_OBJECTIVE_STATUS", entity: "OKR_OBJECTIVE", entityId: ob.id, detail: { from: ob.status, to: parsed.data.status, title: ob.title } });
  revalidate();
  return { ok: true };
}

export async function deleteObjective(id: string): Promise<Result> {
  const { user, error } = await authorize("okr:manage");
  if (error) return { error };
  const db = await getDb();
  await db.delete(schema.okrObjectives).where(eq(schema.okrObjectives.id, id));
  await audit({ userId: user.id, userEmail: user.email, action: "OKR_OBJECTIVE_DELETE", entity: "OKR_OBJECTIVE", entityId: id, detail: {} });
  revalidate();
  return { ok: true };
}

/* ═══════════════════ KEY RESULT ═══════════════════ */

const krSchema = z.object({
  id: z.string().optional(),
  objectiveId: z.string().min(1),
  title: z.string().trim().min(3).max(300),
  metricSource: z.string().trim().min(1).max(60),
  unit: z.enum(METRIC_UNITS).optional(),
  direction: z.enum(["UP", "DOWN"]).optional(),
  baseline: z.number().nullable().optional(),
  target: z.number(),
  ownerUserId: z.string().trim().min(1).nullable().optional(),
  sortOrder: z.number().int().min(0).max(999).optional(),
});

export async function saveKeyResult(input: unknown): Promise<Result<{ id: string }>> {
  const { user, error } = await authorize("okr:manage");
  if (error) return { error };
  const parsed = krSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const d = parsed.data;
  /*
    CHẶN Ở ĐÂY, KHÔNG PHẢI Ở GIAO DIỆN. Một KR nối vào khoá chỉ số không tồn tại sẽ hiện "chưa đo
    được" vĩnh viễn và trông y hệt một KR đang chờ số liệu — kiểu hỏng im lặng tệ nhất.
  */
  if (!isMetricKey(d.metricSource)) return { error: `Chỉ số "${d.metricSource}" không có trong sổ đăng ký. Chọn một chỉ số có sẵn hoặc để "Nhập tay".` };
  if (d.baseline !== null && d.baseline !== undefined && d.baseline === d.target) return { error: "Đích phải khác mốc xuất phát, nếu không không tính được phần trăm" };

  const db = await getDb();
  const values = {
    objectiveId: d.objectiveId,
    title: d.title,
    metricSource: d.metricSource,
    unit: d.unit ?? "NUMBER",
    direction: d.direction ?? "UP",
    baseline: d.baseline ?? null,
    target: d.target,
    ownerUserId: d.ownerUserId ?? null,
    sortOrder: d.sortOrder ?? 100,
    updatedAt: new Date(),
  };
  if (d.id) {
    await db.update(schema.okrKeyResults).set(values).where(eq(schema.okrKeyResults.id, d.id));
    revalidate();
    return { ok: true, id: d.id };
  }
  const id = crypto.randomUUID();
  await db.insert(schema.okrKeyResults).values({ id, ...values });
  await audit({ userId: user.id, userEmail: user.email, action: "OKR_KR_CREATE", entity: "OKR_KEY_RESULT", entityId: id, detail: { title: d.title, metricSource: d.metricSource, target: d.target } });
  revalidate();
  return { ok: true, id };
}

export async function deleteKeyResult(id: string): Promise<Result> {
  const { error } = await authorize("okr:manage");
  if (error) return { error };
  const db = await getDb();
  await db.delete(schema.okrKeyResults).where(eq(schema.okrKeyResults.id, id));
  revalidate();
  return { ok: true };
}

/** Chấm một KR: giá trị (nếu nhập tay) + mức tự tin + ghi chú. Mỗi lần chấm là một dòng lịch sử. */
export async function checkinKeyResult(input: unknown): Promise<Result> {
  const { user, error } = await authorize("okr:manage");
  if (error) return { error };
  const parsed = z.object({ keyResultId: z.string().min(1), value: z.number().nullable(), confidence: z.enum(KR_CONFIDENCES), note: z.string().trim().max(1000).optional() }).safeParse(input);
  if (!parsed.success) return { error: "Dữ liệu không hợp lệ" };
  const db = await getDb();
  const kr = await db.query.okrKeyResults.findFirst({ where: eq(schema.okrKeyResults.id, parsed.data.keyResultId) });
  if (!kr) return { error: "Không tìm thấy Key Result" };

  /*
    KR nối vào chỉ số ERP thì `current` đọc sống mỗi lần mở — ghi tay đè lên sẽ tạo hai sự thật.
    Vẫn cho chấm MỨC TỰ TIN và ghi chú: đó là nhận định của con người, chỉ số không thay được.
  */
  const isBound = kr.metricSource !== "MANUAL";
  const value = isBound ? null : parsed.data.value;
  await db.insert(schema.okrCheckins).values({
    keyResultId: kr.id,
    value,
    confidence: parsed.data.confidence,
    note: parsed.data.note ?? "",
    source: isBound ? "AUTO" : "MANUAL",
    actorId: user.id,
    actorName: user.name,
  });
  await db
    .update(schema.okrKeyResults)
    .set({ confidence: parsed.data.confidence, ...(isBound ? {} : { current: value, currentAt: new Date() }), updatedAt: new Date() })
    .where(eq(schema.okrKeyResults.id, kr.id));
  revalidate();
  return { ok: true };
}

/* ═══════════════════ BSC ═══════════════════ */

export async function createScorecard(input: unknown): Promise<Result<{ id: string }>> {
  const { user, error } = await authorize("okr:manage");
  if (error) return { error };
  const parsed = z.object({ scope: z.enum(["COMPANY", "DEPARTMENT"]), department: z.enum(DEPARTMENT_CODES).nullable().optional(), period: z.string().trim().min(4).max(20), name: z.string().trim().min(2).max(120), useTemplate: z.boolean().optional() }).safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const d = parsed.data;
  if (d.scope === "DEPARTMENT" && !d.department) return { error: "Thẻ điểm phòng ban phải chọn phòng" };
  const db = await getDb();
  const departmentId = d.scope === "DEPARTMENT" ? await departmentIdOf(d.department) : null;
  if (d.scope === "DEPARTMENT" && !departmentId) return { error: "Không tìm thấy phòng ban" };

  const dup = await db.query.bscScorecards.findFirst({
    where: and(eq(schema.bscScorecards.scope, d.scope), eq(schema.bscScorecards.period, d.period), departmentId ? eq(schema.bscScorecards.departmentId, departmentId) : isNull(schema.bscScorecards.departmentId)),
    columns: { id: true },
  });
  if (dup) return { error: "Kỳ này đã có thẻ điểm cho phạm vi đó" };

  const id = crypto.randomUUID();
  await db.insert(schema.bscScorecards).values({ id, scope: d.scope, departmentId, name: d.name, period: d.period, createdBy: user.id });

  // Mẫu gợi ý chỉ được dùng khi NGƯỜI bấm — không bao giờ áp ngầm (xem `DEFAULT_TEMPLATES`).
  if (d.useTemplate) {
    const tpl = d.department ? DEFAULT_TEMPLATES[d.department] : DEFAULT_TEMPLATES.MANAGEMENT;
    if (tpl?.length) {
      /*
        ĐƠN VỊ VÀ CHIỀU LẤY TỪ SỔ ĐĂNG KÝ CHỈ SỐ, KHÔNG ĐẶT CỨNG.

        Bản trước ghi cứng `UP`/`NUMBER` cho mọi ô mẫu. Với chỉ số càng-thấp-càng-tốt (tỷ lệ hoàn,
        việc quá hạn, dòng tiền chưa phân loại) điều đó làm điểm ô ĐẢO NGƯỢC: hoàn càng nhiều thì
        thẻ điểm càng đẹp. Sổ đăng ký đã khai đúng chiều của từng chỉ số — đọc lại từ đó.

        Đích vẫn để `null` một cách cố ý: chủ sở hữu phải tự đặt, và ô chưa có đích thì chưa ghi
        điểm (`metricScore` trả `null`, rơi khỏi cả tử lẫn mẫu). Đó chính là "mẫu không tự kích hoạt".
      */
      await db.insert(schema.bscMetrics).values(
        tpl.map((m, i) => {
          const b = metricBinding(m.metricSource);
          return {
            scorecardId: id,
            perspective: m.perspective,
            label: m.label,
            metricSource: m.metricSource,
            weight: m.weight,
            sortOrder: (i + 1) * 10,
            unit: b?.unit ?? ("NUMBER" as const),
            direction: b?.direction ?? ("UP" as const),
          };
        }),
      );
    }
  }
  await audit({ userId: user.id, userEmail: user.email, action: "BSC_SCORECARD_CREATE", entity: "BSC_SCORECARD", entityId: id, detail: { scope: d.scope, period: d.period, department: d.department ?? null, useTemplate: Boolean(d.useTemplate) } });
  revalidate();
  return { ok: true, id };
}

/**
 * ═══════ DÙNG MẪU OKR: SINH RA MỘT BẢN NHÁP, KHÔNG SINH RA MỘT MỤC TIÊU ĐANG CHẠY ═══════
 *
 * Ba điều kiện, và mã ở đây là chỗ thực thi cả ba (xem `lib/constants/okr-templates.ts`):
 *
 *  · Trạng thái luôn là `DRAFT`. Người phụ trách đọc lại, sửa, rồi tự bật `ACTIVE`.
 *  · ĐÍCH do người bấm nhập. KR nào không có đích thì KHÔNG được tạo — bỏ qua kèm lời nhắc, chứ
 *    không tự điền số gợi ý. Số gợi ý chỉ sống ở ô nhập trên màn hình.
 *  · `metricSource` đi qua đúng cửa `isMetricKey` như mọi KR khác.
 *
 * Trả về số KR đã tạo và số KR bị bỏ, để giao diện nói thật thay vì báo "đã tạo mẫu" chung chung.
 */
export async function applyOkrTemplate(input: unknown): Promise<Result<{ id: string; created: number; skipped: number }>> {
  const { user, error } = await authorize("okr:manage");
  if (error) return { error };
  const parsed = z
    .object({
      templateKey: z.string().trim().min(2).max(60),
      period: z.string().trim().min(4).max(20),
      ownerUserId: z.string().trim().min(1).nullable().optional(),
      /** Đích do người bấm nhập, theo thứ tự KR trong mẫu. `null` = bỏ qua KR đó. */
      targets: z.array(z.number().nullable()),
    })
    .safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const d = parsed.data;

  const tpl = templateByKey(d.templateKey);
  if (!tpl) return { error: "Không có mẫu nào mang khoá này" };
  if (d.targets.length !== tpl.krs.length) return { error: "Số ô đích không khớp với mẫu" };
  if (d.targets.every((t) => t === null)) return { error: "Phải đặt đích cho ít nhất một Key Result — mẫu không tự đặt đích thay bạn" };

  const objective = await saveObjective({
    title: tpl.title,
    description: tpl.description,
    level: "DEPARTMENT",
    department: tpl.department,
    ownerUserId: d.ownerUserId ?? null,
    period: d.period,
    // NHÁP. Mục tiêu tự bật `ACTIVE` là chấm điểm người ta bằng con số họ chưa đồng ý.
    status: "DRAFT",
  });
  if ("error" in objective) return objective;

  let created = 0;
  for (const [i, kr] of tpl.krs.entries()) {
    const target = d.targets[i];
    if (target === null) continue;
    const shape = krShapeOf(kr.metricSource);
    const r = await saveKeyResult({
      objectiveId: objective.id,
      title: kr.title,
      metricSource: kr.metricSource,
      unit: shape.unit,
      direction: shape.direction,
      target,
      sortOrder: (i + 1) * 10,
    });
    if (!("error" in r)) created += 1;
  }

  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "OKR_TEMPLATE_APPLY",
    entity: "OKR_OBJECTIVE",
    entityId: objective.id,
    detail: { templateKey: tpl.key, department: tpl.department, period: d.period, created, skipped: tpl.krs.length - created },
  });
  revalidate();
  return { ok: true, id: objective.id, created, skipped: tpl.krs.length - created };
}

export async function saveBscMetric(input: unknown): Promise<Result<{ id: string }>> {
  const { error } = await authorize("okr:manage");
  if (error) return { error };
  const parsed = z
    .object({
      id: z.string().optional(),
      scorecardId: z.string().min(1),
      perspective: z.enum(BSC_PERSPECTIVES),
      label: z.string().trim().min(2).max(150),
      metricSource: z.string().trim().min(1).max(60),
      unit: z.enum(METRIC_UNITS).optional(),
      direction: z.enum(["UP", "DOWN"]).optional(),
      target: z.number().nullable().optional(),
      manualValue: z.number().nullable().optional(),
      weight: z.number().positive().max(100).optional(),
      sortOrder: z.number().int().min(0).max(999).optional(),
    })
    .safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const d = parsed.data;
  if (!isMetricKey(d.metricSource)) return { error: `Chỉ số "${d.metricSource}" không có trong sổ đăng ký` };
  const db = await getDb();
  const values = {
    scorecardId: d.scorecardId,
    perspective: d.perspective,
    label: d.label,
    metricSource: d.metricSource,
    unit: d.unit ?? "NUMBER",
    direction: d.direction ?? "UP",
    target: d.target ?? null,
    // Giá trị nhập tay chỉ có nghĩa với ô `MANUAL`; ô nối chỉ số đọc sống nên bỏ qua.
    manualValue: d.metricSource === "MANUAL" ? (d.manualValue ?? null) : null,
    manualValueAt: d.metricSource === "MANUAL" && d.manualValue !== null && d.manualValue !== undefined ? new Date() : null,
    weight: d.weight ?? 1,
    sortOrder: d.sortOrder ?? 100,
    updatedAt: new Date(),
  };
  if (d.id) {
    await db.update(schema.bscMetrics).set(values).where(eq(schema.bscMetrics.id, d.id));
    revalidate();
    return { ok: true, id: d.id };
  }
  const id = crypto.randomUUID();
  await db.insert(schema.bscMetrics).values({ id, ...values });
  revalidate();
  return { ok: true, id };
}

export async function deleteBscMetric(id: string): Promise<Result> {
  const { error } = await authorize("okr:manage");
  if (error) return { error };
  const db = await getDb();
  await db.delete(schema.bscMetrics).where(eq(schema.bscMetrics.id, id));
  revalidate();
  return { ok: true };
}

/* ═══════════════════ KỲ REVIEW ═══════════════════ */

export async function openReview(input: unknown): Promise<Result<{ id: string }>> {
  const { user, error } = await authorize("review:manage");
  if (error) return { error };
  const parsed = z.object({ kind: z.enum(REVIEW_KINDS), department: z.enum(DEPARTMENT_CODES).nullable().optional(), at: z.string().datetime().optional() }).safeParse(input);
  if (!parsed.success) return { error: "Dữ liệu không hợp lệ" };
  const d = parsed.data;
  const db = await getDb();
  const departmentId = d.department ? await departmentIdOf(d.department) : null;
  if (d.department && !departmentId) return { error: "Không tìm thấy phòng ban" };
  const scope = d.department ? "DEPARTMENT" : "COMPANY";
  const { period, start, end } = periodRange(d.kind as ReviewKind, d.at ? new Date(d.at) : new Date());

  const existing = await db.query.reviewCycles.findFirst({
    where: and(eq(schema.reviewCycles.kind, d.kind), eq(schema.reviewCycles.scope, scope), eq(schema.reviewCycles.period, period), departmentId ? eq(schema.reviewCycles.departmentId, departmentId) : isNull(schema.reviewCycles.departmentId)),
    columns: { id: true },
  });
  if (existing) return { ok: true, id: existing.id };

  const id = crypto.randomUUID();
  await db.insert(schema.reviewCycles).values({ id, kind: d.kind, scope, departmentId, period, periodStart: start, periodEnd: end, status: "DRAFT", createdBy: user.id });
  revalidate();
  return { ok: true, id };
}

export async function saveReviewNotes(input: unknown): Promise<Result> {
  const { error } = await authorize("review:manage");
  if (error) return { error };
  const parsed = z.object({ id: z.string().min(1), highlights: z.string().trim().max(4000), issues: z.string().trim().max(4000), nextActions: z.string().trim().max(4000) }).safeParse(input);
  if (!parsed.success) return { error: "Dữ liệu không hợp lệ" };
  const db = await getDb();
  const row = await db.query.reviewCycles.findFirst({ where: eq(schema.reviewCycles.id, parsed.data.id), columns: { status: true } });
  if (!row) return { error: "Không tìm thấy kỳ review" };
  // Nhận xét của một kỳ đã chốt cũng là một phần của biên bản đã chốt.
  if (row.status === "FINAL") return { error: "Kỳ đã chốt — không sửa được nữa" };
  await db.update(schema.reviewCycles).set({ highlights: parsed.data.highlights, issues: parsed.data.issues, nextActions: parsed.data.nextActions, updatedAt: new Date() }).where(eq(schema.reviewCycles.id, parsed.data.id));
  revalidate();
  return { ok: true };
}

/**
 * CHỐT KỲ — dựng ảnh chụp rồi đóng băng.
 *
 * Sau lệnh này, mở lại kỳ đó sẽ đọc `snapshot` và KHÔNG truy vấn lại gì. Sửa công thức tháng sau
 * không làm đổi con số của kỳ này. Đó là toàn bộ mục đích của việc chốt.
 */
export async function finalizeReview(id: string): Promise<Result> {
  const { user, error } = await authorize("review:manage");
  if (error) return { error };
  const db = await getDb();
  const row = await db.query.reviewCycles.findFirst({ where: eq(schema.reviewCycles.id, id) });
  if (!row) return { error: "Không tìm thấy kỳ review" };
  if (row.status === "FINAL") return { error: "Kỳ này đã chốt rồi" };
  const dept = row.departmentId ? await db.query.departments.findFirst({ where: eq(schema.departments.id, row.departmentId), columns: { code: true } }) : null;
  const snapshot = await buildSnapshot({
    from: row.periodStart,
    to: row.periodEnd,
    department: (dept?.code as never) ?? null,
    departmentId: row.departmentId,
    okrPeriod: row.period,
  });
  await db
    .update(schema.reviewCycles)
    .set({ status: "FINAL", snapshot: snapshot as never, snapshotVersion: SNAPSHOT_VERSION, finalizedAt: new Date(), finalizedBy: user.id, updatedAt: new Date() })
    .where(eq(schema.reviewCycles.id, id));
  await audit({ userId: user.id, userEmail: user.email, action: "REVIEW_FINALIZE", entity: "REVIEW_CYCLE", entityId: id, detail: { kind: row.kind, period: row.period, snapshotVersion: SNAPSHOT_VERSION } });
  revalidate();
  return { ok: true };
}
