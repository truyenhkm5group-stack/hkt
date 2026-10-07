import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import {
  ENROLLMENT_CODE_PATTERN,
  ENROLLMENT_CODE_PREFIX,
  enrollmentExpiry,
  isTechRepairCommand,
  sanitizeWorkerDiagnostics,
  type TechRepairCommand,
  type WorkerDiagnostics,
} from "@/lib/constants/tech-worker-onboarding";
import { WORKER_BRANCH_PATTERN } from "@/lib/constants/tech-worker";
import { agentGithubDisabledReason, mintAgentPushToken } from "@/lib/integrations/github/agent-identity";
import { rowsOf } from "@/lib/sql-rows";
import { recordTechEvent } from "@/lib/tech/control-plane";
import type { TechActor, TechResult } from "@/lib/tech/service";
import { fenced, reapExpiredTechLeases, type TechWorkerRow } from "@/lib/tech/worker-service";

/**
 * ═══════════ CÀI WORKER MỘT NÚT — MÃ GHI DANH · XOAY KHOÁ · GỠ · TỰ KIỂM · SỬA AN TOÀN ═══════════
 *
 * docs/tech-control-plane/README.md mục 15. Luật thuần ở `lib/constants/tech-worker-onboarding.ts`; tệp này chỉ đọc /
 * ghi. Ba bất biến:
 *
 *  1. KHOÁ WORKER KHÔNG BAO GIỜ ĐI QUA NGƯỜI. Người chỉ chạm MÃ GHI DANH (một lần, 30 phút, băm). Khoá sinh ra lúc đổi
 *     mã và đi thẳng vào thân phản hồi cho bộ cài — không URL, không nhật ký, không CSDL (chỉ băm).
 *  2. MỌI NHÁNH LỖI RƠI VỀ PHÍA HẸP (AGENTS.md 28–31): mã sai / hết hạn / đã dùng / đã thu hồi / worker đã gỡ ⇒ cùng
 *     MỘT câu trả lời `INVALID`, không nói mã nào tồn tại. Xoay khoá = khoá cũ chết NGAY (không có thời gian ân hạn).
 *  3. Mã dùng MỘT lần được bảo đảm bằng MỘT câu `UPDATE … WHERE used_at IS NULL … RETURNING` — hai bộ cài chạy cùng
 *     lúc với cùng mã thì đúng một cái thắng.
 */

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
/** Băm của một chuỗi ngẫu nhiên KHÔNG AI GIỮ — thoả CHECK `^[0-9a-f]{64}$` mà không khoá nào khớp được. */
const deadHash = () => sha256(`revoked:${randomBytes(32).toString("hex")}`);

const KHONG_TIM_THAY = "Không tìm thấy worker.";

function onlyHuman(actor: TechActor, viec: string): string | null {
  return actor.kind === "HUMAN" ? null : `Chỉ NGƯỜI ${viec}.`;
}

/* ═════════════════════ MÃ GHI DANH ═════════════════════ */

export type EnrollmentIssued = { code: string; expiresAt: Date; worker: { id: string; key: string; provider: string } };

/**
 * «Tải bộ cài»: tạo MỘT mã ghi danh mới cho worker và vô hiệu mọi mã CHƯA dùng trước đó (chỉ bộ cài mới nhất chạy được).
 * Mã trả về cho người gọi để NHÚNG VÀO TỆP bộ cài — không hiện ra màn hình, không vào URL.
 */
export async function createWorkerEnrollment(workerId: string, actor: TechActor, now = new Date()): Promise<TechResult<EnrollmentIssued>> {
  const cam = onlyHuman(actor, "tạo được bộ cài worker");
  if (cam) return { error: cam };
  const db = await getDb();
  const w = await db.query.techWorkers.findFirst({ where: eq(schema.techWorkers.id, workerId), columns: { id: true, key: true, provider: true } });
  if (!w) return { error: KHONG_TIM_THAY };
  const code = `${ENROLLMENT_CODE_PREFIX}${randomBytes(32).toString("base64url")}`;
  const expiresAt = enrollmentExpiry(now);
  const id = await db.transaction(async (tx) => {
    await tx
      .update(schema.techWorkerEnrollments)
      .set({ revokedAt: now })
      .where(and(eq(schema.techWorkerEnrollments.workerId, w.id), isNull(schema.techWorkerEnrollments.usedAt), isNull(schema.techWorkerEnrollments.revokedAt)));
    const [row] = await tx
      .insert(schema.techWorkerEnrollments)
      .values({ workerId: w.id, codeHash: sha256(code), expiresAt, createdById: actor.kind === "HUMAN" ? (actor.id ?? null) : null })
      .returning({ id: schema.techWorkerEnrollments.id });
    return row.id;
  });
  await recordTechEvent(db, { name: "worker.enrollment_created", subjectType: "WORKER", subjectId: w.id, payload: { enrollmentId: id, expiresAt: expiresAt.toISOString() } }, actor);
  return { ok: true, code, expiresAt, worker: w };
}

export type EnrollmentRedeemed = { token: string; worker: { id: string; key: string; provider: string; capabilities: string[] } };

/**
 * Bộ cài đổi mã lấy khoá. Thành công ⇒ khoá worker được XOAY (khoá cũ — kể cả khoá đã lộ — chết ngay), worker bật lại,
 * mốc ghi danh được đặt, và khoá mới trả về ĐÚNG MỘT LẦN. Thất bại vì bất kỳ lý do nào ⇒ `INVALID` (một câu cho mọi
 * trường hợp — không lộ mã nào từng tồn tại).
 */
export async function redeemWorkerEnrollment(code: string, info: { host?: string; version?: string }, now = new Date()): Promise<{ ok: true; data: EnrollmentRedeemed } | { error: "INVALID" }> {
  if (typeof code !== "string" || !ENROLLMENT_CODE_PATTERN.test(code)) return { error: "INVALID" };
  const db = await getDb();
  const secret = randomBytes(24).toString("base64url");
  const host = (info.host ?? "").replace(/[^\w.-]/g, "").slice(0, 120);
  const res = await db.transaction(async (tx) => {
    const used = await tx
      .update(schema.techWorkerEnrollments)
      .set({ usedAt: now, usedFromHost: host })
      .where(
        and(
          eq(schema.techWorkerEnrollments.codeHash, sha256(code)),
          isNull(schema.techWorkerEnrollments.usedAt),
          isNull(schema.techWorkerEnrollments.revokedAt),
          gt(schema.techWorkerEnrollments.expiresAt, now),
        ),
      )
      .returning({ workerId: schema.techWorkerEnrollments.workerId });
    if (!used.length) return null;
    const [w] = await tx
      .update(schema.techWorkers)
      .set({
        secretHash: sha256(secret),
        secretRotatedAt: now,
        secretRevokedAt: null,
        enrolledAt: now,
        removedAt: null,
        enabled: true,
        disabledReason: "",
        host: host || sql`${schema.techWorkers.host}`,
        updatedAt: now,
      })
      .where(eq(schema.techWorkers.id, used[0].workerId))
      .returning({ id: schema.techWorkers.id, key: schema.techWorkers.key, provider: schema.techWorkers.provider, capabilities: schema.techWorkers.capabilities });
    return w ?? null;
  });
  if (!res) return { error: "INVALID" };
  await recordTechEvent(db, { name: "worker.enrolled", subjectType: "WORKER", subjectId: res.id, payload: { host, version: (info.version ?? "").slice(0, 60) } }, { kind: "SYSTEM", name: `enroll:${res.key}` });
  return { ok: true, data: { token: `tw_${res.id}.${secret}`, worker: { ...res, capabilities: (res.capabilities as string[]) ?? [] } } };
}

/* ═════════════════════ TẠO LẠI TOKEN · GỠ ═════════════════════ */

/**
 * «Tạo lại token»: khoá hiện tại chết NGAY (băm của chuỗi không ai giữ + `secret_revoked_at`) ⇒ tiến trình worker đang
 * chạy nhận 401 ở nhịp tim kế và dừng; rồi tạo bộ cài mới (mã ghi danh) để cài lại. Không hiện khoá nào.
 */
export async function rotateWorkerSecret(workerId: string, actor: TechActor, now = new Date()): Promise<TechResult<EnrollmentIssued>> {
  const cam = onlyHuman(actor, "tạo lại được token worker");
  if (cam) return { error: cam };
  const db = await getDb();
  const [row] = await db
    .update(schema.techWorkers)
    .set({ secretHash: deadHash(), secretRotatedAt: now, secretRevokedAt: now, updatedAt: now })
    .where(eq(schema.techWorkers.id, workerId))
    .returning({ id: schema.techWorkers.id });
  if (!row) return { error: KHONG_TIM_THAY };
  await recordTechEvent(db, { name: "worker.secret_rotated", subjectType: "WORKER", subjectId: row.id, payload: {} }, actor);
  return createWorkerEnrollment(workerId, actor, now);
}

/**
 * «Gỡ worker»: vô hiệu (tắt + thu hồi khoá + huỷ mã ghi danh chưa dùng + xoá lệnh sửa đang chờ) và THU HỒI lease ngay
 * (việc đang giữ về hàng đợi qua đúng đường thu hồi của hàng đợi — không viết luật thứ hai). Không xoá dòng: lượt chạy
 * cũ vẫn trỏ tới worker này. Dọn máy (Scheduled Task · credential · thư mục) là tệp gỡ cài đặt người tải về chạy.
 */
export async function removeTechWorker(workerId: string, actor: TechActor, now = new Date()): Promise<TechResult<{ key: string; released: number }>> {
  const cam = onlyHuman(actor, "gỡ được worker");
  if (cam) return { error: cam };
  const db = await getDb();
  const [row] = await db
    .update(schema.techWorkers)
    .set({ enabled: false, disabledReason: "Đã gỡ từ /tech/workers", removedAt: now, secretHash: deadHash(), secretRevokedAt: now, repairCommand: "", updatedAt: now })
    .where(eq(schema.techWorkers.id, workerId))
    .returning({ id: schema.techWorkers.id, key: schema.techWorkers.key });
  if (!row) return { error: KHONG_TIM_THAY };
  await db
    .update(schema.techWorkerEnrollments)
    .set({ revokedAt: now })
    .where(and(eq(schema.techWorkerEnrollments.workerId, row.id), isNull(schema.techWorkerEnrollments.usedAt), isNull(schema.techWorkerEnrollments.revokedAt)));
  // Lease còn hạn của worker này ⇒ cho hết hạn NGAY rồi để bộ thu hồi chuẩn làm phần còn lại (đóng lượt, đếm lần thử, lùi dần).
  await db
    .update(schema.techTasks)
    .set({ leaseExpiresAt: now })
    .where(and(eq(schema.techTasks.leaseWorkerId, row.id), gt(schema.techTasks.leaseExpiresAt, now)));
  const { reaped } = await reapExpiredTechLeases(now);
  await recordTechEvent(db, { name: "worker.removed", subjectType: "WORKER", subjectId: row.id, payload: { key: row.key, released: reaped } }, actor);
  return { ok: true, key: row.key, released: reaped };
}

/* ═════════════════════ TỰ KIỂM · SỬA AN TOÀN ═════════════════════ */

/** Lưu báo cáo tự kiểm ĐÃ LỌC + CHE. Đầu vào hỏng ⇒ bỏ qua (không xoá báo cáo cũ). */
export async function recordWorkerDiagnostics(workerId: string, raw: unknown, now = new Date()): Promise<WorkerDiagnostics | null> {
  const d = sanitizeWorkerDiagnostics(raw);
  if (!d) return null;
  const db = await getDb();
  await db.update(schema.techWorkers).set({ diagnostics: d as unknown as Record<string, unknown>, diagnosticsAt: now }).where(eq(schema.techWorkers.id, workerId));
  return d;
}

/** «Sửa lỗi tự động»: ghi MỘT lệnh trong danh sách đóng; worker lấy ở nhịp tim kế. Lệnh lạ ⇒ từ chối. */
export async function requestWorkerRepair(input: { workerId: string; command: string }, actor: TechActor, now = new Date()): Promise<TechResult> {
  const cam = onlyHuman(actor, "yêu cầu được sửa lỗi worker");
  if (cam) return { error: cam };
  if (!isTechRepairCommand(input.command)) return { error: "Lệnh sửa không nằm trong danh sách an toàn." };
  const db = await getDb();
  const [row] = await db
    .update(schema.techWorkers)
    .set({ repairCommand: input.command, repairRequestedAt: now })
    .where(and(eq(schema.techWorkers.id, input.workerId), isNull(schema.techWorkers.removedAt)))
    .returning({ id: schema.techWorkers.id });
  if (!row) return { error: "Không tìm thấy worker (hoặc worker đã gỡ)." };
  await recordTechEvent(db, { name: "worker.repair_requested", subjectType: "WORKER", subjectId: row.id, payload: { command: input.command } }, actor);
  return { ok: true };
}

/**
 * Lấy-và-xoá lệnh sửa đang chờ trong MỘT câu (hai nhịp tim chen nhau không nhận cùng một lệnh hai lần). Giá trị ngoài
 * danh sách đóng (không thể có nhờ CHECK, nhưng phòng hờ) ⇒ `null`.
 */
export async function takeWorkerRepair(workerId: string): Promise<TechRepairCommand | null> {
  const db = await getDb();
  const r = await db.execute(sql`
    UPDATE tech_workers w SET repair_command = ''
    FROM (SELECT id, repair_command AS cmd FROM tech_workers WHERE id = ${workerId} FOR UPDATE) o
    WHERE w.id = o.id AND o.cmd <> ''
    RETURNING o.cmd AS cmd
  `);
  const cmd = rowsOf<{ cmd: string }>(r)[0]?.cmd;
  return isTechRepairCommand(cmd) ? cmd : null;
}

/* ═════════════════════ TOKEN ĐẨY NHÁNH (D) ═════════════════════ */

export type PushTokenResult = { ok: true; token: string; expiresAt: string } | { error: string; detail?: string };

/**
 * Cấp token đẩy NGẮN HẠN cho ĐÚNG một lượt chạy đang giữ lease: worker bật, lượt còn mở + đúng generation (fencing), và
 * nhánh của lượt là nhánh `ai/worker/*` MÁY CHỦ đã cấp lúc nhận việc — worker không tự chọn nhánh. Token đi trong thân
 * phản hồi, KHÔNG ghi CSDL; sự kiện chỉ ghi "đã cấp" + hạn.
 */
export async function issueWorkerPushToken(worker: TechWorkerRow, fence: { runId: string; leaseGeneration: number }, now = new Date()): Promise<PushTokenResult> {
  if (!worker.enabled) return { error: "WORKER_DISABLED" };
  const db = await getDb();
  const f = await fenced(db, worker, fence);
  if (!f.ok) return { error: f.reason };
  if (!WORKER_BRANCH_PATTERN.test(f.run.branch)) return { error: "BRANCH_NOT_ALLOWED" };
  const chua = agentGithubDisabledReason();
  if (chua) return { error: "NOT_CONFIGURED", detail: "Máy chủ chưa có danh tính bot erp-agent — không cấp được token đẩy nhánh." };
  try {
    const t = await mintAgentPushToken({ branch: f.run.branch, now });
    await recordTechEvent(
      db,
      { name: "worker.push_token_issued", subjectType: "WORKER", subjectId: worker.id, taskId: f.task.id, payload: { runId: f.run.id, branch: f.run.branch, expiresAt: t.expiresAt } },
      { kind: "SYSTEM", name: `worker:${worker.key}` },
    );
    return { ok: true, token: t.token, expiresAt: t.expiresAt };
  } catch (e) {
    return { error: "GITHUB_ERROR", detail: e instanceof Error ? e.message.slice(0, 200) : "lỗi" };
  }
}

/** Máy chủ có cấp được token đẩy không — cho trang worker nói đúng câu (không bắt chủ shop dán PAT). */
export function workerPushReadiness(): { ready: boolean; detail: string } {
  const chua = agentGithubDisabledReason();
  return chua
    ? { ready: false, detail: "Máy chủ chưa có danh tính bot erp-agent nên chưa cấp được token đẩy nhánh. Worker vẫn làm việc nhưng dừng ở bước đẩy (BLOCKED) — nhờ kỹ thuật chạy ops apply-agent-env. Không cần (và không nên) dán token GitHub cá nhân." }
    : { ready: true, detail: "Đẩy nhánh bằng token ngắn hạn của bot erp-agent, máy chủ cấp cho từng lượt — máy của bạn không cần cấu hình Git." };
}

/** Các mã ghi danh còn đổi được của một nhóm worker — cho bước 2 của bốn bước. */
export async function pendingEnrollmentWorkerIds(now = new Date()): Promise<Set<string>> {
  const db = await getDb();
  const rows = await db
    .select({ workerId: schema.techWorkerEnrollments.workerId })
    .from(schema.techWorkerEnrollments)
    .where(and(isNull(schema.techWorkerEnrollments.usedAt), isNull(schema.techWorkerEnrollments.revokedAt), gt(schema.techWorkerEnrollments.expiresAt, now)));
  return new Set(rows.map((r) => r.workerId));
}
