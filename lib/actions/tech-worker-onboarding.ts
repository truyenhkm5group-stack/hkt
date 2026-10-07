"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import { TECH_REPAIR_COMMANDS } from "@/lib/constants/tech-worker-onboarding";
import { TECH_QUEUE_PROVIDERS, type TechExecutionProvider } from "@/lib/constants/tech-worker";
import { env } from "@/lib/env";
import { githubConfig } from "@/lib/integrations/github/client";
import type { TechActor, TechResult } from "@/lib/tech/service";
import { createWorkerEnrollment, removeTechWorker, requestWorkerRepair, rotateWorkerSecret, type EnrollmentIssued } from "@/lib/tech/worker-onboarding";
import { buildWorkerInstaller, buildWorkerUninstaller, installerFileName, uninstallerFileName, validateInstallerInput } from "@/lib/tech/worker-installer";
import { registerTechWorker } from "@/lib/tech/worker-service";

/**
 * ───────────── SERVER ACTION — CÀI WORKER MỘT NÚT (docs/tech-control-plane/README.md mục 15) ─────────────
 *
 * Vỏ mỏng: **quyền `tech:manage` → zod → `lib/tech/worker-onboarding.ts` → `audit()` → làm mới**. Tệp bộ cài đi về
 * trình duyệt trong THÂN phản hồi của Server Action (trình duyệt tự lưu thành tệp) — không có URL tải nào mang mã.
 * Không lượt audit nào ghi mã ghi danh hay khoá: chỉ ghi "đã tạo bộ cài, hết hạn lúc …".
 */

const KHONG_QUYEN = "Bạn không có quyền quản trị Phòng Tech AI";

async function nguoiQuanTri() {
  const user = await requireUser();
  if (!can(user, "tech:manage")) return null;
  return user;
}

const actorOf = (user: { id: string; name: string; email: string }): TechActor => ({ kind: "HUMAN", id: user.id, name: user.name || user.email });

function parse<T extends z.ZodTypeAny>(s: T, input: unknown): { data: z.infer<T> } | { error: string } {
  const r = s.safeParse(input);
  return r.success ? { data: r.data } : { error: r.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
}

export type InstallerFile = { fileName: string; content: string; expiresAt: string | null };

/** URL kho PUBLIC cho bộ cài — từ cấu hình GitHub của máy chủ, không gõ cứng. */
function repoUrl(): string | null {
  const r = githubConfig().repo;
  return r ? `https://github.com/${r}.git` : null;
}

function installerOf(issued: EnrollmentIssued): TechResult<InstallerFile> {
  const repo = repoUrl();
  if (!repo) return { error: "Máy chủ chưa biết kho mã (ERP_GITHUB_REPO) — chưa sinh được bộ cài." };
  const input = { origin: env.appUrl, workerKey: issued.worker.key, provider: issued.worker.provider as TechExecutionProvider, enrollmentCode: issued.code, repoUrl: repo, expiresAt: issued.expiresAt };
  const sai = validateInstallerInput(input);
  if (sai) return { error: sai };
  return { ok: true, fileName: installerFileName(issued.worker.key), content: buildWorkerInstaller(input), expiresAt: issued.expiresAt.toISOString() };
}

const createSchema = z
  .object({
    key: z.string().trim().min(3).max(40),
    name: z.string().trim().max(120),
    provider: z.enum(TECH_QUEUE_PROVIDERS as unknown as [TechExecutionProvider, ...TechExecutionProvider[]]),
    capabilities: z.array(z.string().max(60)).min(1).max(20),
    maxConcurrency: z.number().int().min(1).max(4),
    /** Đường API trả tiền theo token — người tạo phải xác nhận đã đọc cảnh báo tiền. */
    acknowledgeApiCost: z.boolean().optional(),
  })
  .refine((v) => v.provider !== "ANTHROPIC_API" || v.acknowledgeApiCost === true, { message: "Đường Anthropic API tốn tiền theo token — đánh dấu đã đọc cảnh báo trước khi tạo." });

/**
 * Bước 1 — tạo worker. KHÔNG trả khoá: khoá sinh lúc tạo bị bỏ ngay (CSDL chỉ giữ băm của một chuỗi không ai giữ);
 * khoá thật chỉ sinh khi bộ cài đổi mã ghi danh.
 */
export async function createTechWorkerAction(input: unknown): Promise<TechResult<{ id: string }>> {
  const user = await nguoiQuanTri();
  if (!user) return { error: KHONG_QUYEN };
  const p = parse(createSchema, input);
  if ("error" in p) return p;
  const res = await registerTechWorker({ key: p.data.key, name: p.data.name, provider: p.data.provider, capabilities: p.data.capabilities, maxConcurrency: p.data.maxConcurrency }, actorOf(user));
  if ("error" in res) return res;
  await audit({ userId: user.id, userEmail: user.email, action: "TECH_WORKER_REGISTERED", entity: "TECH_WORKER", entityId: res.id, after: { key: p.data.key, provider: p.data.provider, capabilities: p.data.capabilities, maxConcurrency: p.data.maxConcurrency } });
  revalidatePath("/tech/workers");
  return { ok: true, id: res.id };
}

const workerIdSchema = z.object({ workerId: z.string().min(1).max(64) });

/** Bước 2 — «Cài worker trên máy Windows này» / «Tải bộ cài»: mã ghi danh mới (mã cũ chưa dùng chết) + tệp bộ cài. */
export async function downloadWorkerInstallerAction(input: unknown): Promise<TechResult<InstallerFile>> {
  const user = await nguoiQuanTri();
  if (!user) return { error: KHONG_QUYEN };
  const p = parse(workerIdSchema, input);
  if ("error" in p) return p;
  if (!repoUrl()) return { error: "Máy chủ chưa biết kho mã (ERP_GITHUB_REPO) — chưa sinh được bộ cài." };
  const issued = await createWorkerEnrollment(p.data.workerId, actorOf(user));
  if ("error" in issued) return issued;
  await audit({ userId: user.id, userEmail: user.email, action: "TECH_WORKER_INSTALLER_CREATED", entity: "TECH_WORKER", entityId: p.data.workerId, after: { expiresAt: issued.expiresAt.toISOString() } });
  revalidatePath("/tech/workers");
  return installerOf(issued);
}

/** «Tạo lại token»: khoá hiện tại chết NGAY + bộ cài mới. */
export async function rotateWorkerTokenAction(input: unknown): Promise<TechResult<InstallerFile>> {
  const user = await nguoiQuanTri();
  if (!user) return { error: KHONG_QUYEN };
  const p = parse(workerIdSchema, input);
  if ("error" in p) return p;
  const issued = await rotateWorkerSecret(p.data.workerId, actorOf(user));
  if ("error" in issued) return issued;
  await audit({ userId: user.id, userEmail: user.email, action: "TECH_WORKER_TOKEN_ROTATED", entity: "TECH_WORKER", entityId: p.data.workerId, after: { expiresAt: issued.expiresAt.toISOString() } });
  revalidatePath("/tech/workers");
  return installerOf(issued);
}

/** «Gỡ worker»: vô hiệu + thu hồi lease + tệp gỡ cài đặt cho máy. */
export async function removeTechWorkerAction(input: unknown): Promise<TechResult<InstallerFile & { released: number }>> {
  const user = await nguoiQuanTri();
  if (!user) return { error: KHONG_QUYEN };
  const p = parse(workerIdSchema, input);
  if ("error" in p) return p;
  const res = await removeTechWorker(p.data.workerId, actorOf(user));
  if ("error" in res) return res;
  await audit({ userId: user.id, userEmail: user.email, action: "TECH_WORKER_REMOVED", entity: "TECH_WORKER", entityId: p.data.workerId, after: { key: res.key, released: res.released } });
  revalidatePath("/tech/workers");
  revalidatePath("/tech");
  return { ok: true, fileName: uninstallerFileName(res.key), content: buildWorkerUninstaller({ workerKey: res.key }), expiresAt: null, released: res.released };
}

const repairSchema = z.object({ workerId: z.string().min(1).max(64), command: z.enum(TECH_REPAIR_COMMANDS) });

/** «Sửa lỗi tự động»: một lệnh trong danh sách ĐÓNG, worker nhận ở nhịp tim kế. */
export async function requestWorkerRepairAction(input: unknown): Promise<TechResult> {
  const user = await nguoiQuanTri();
  if (!user) return { error: KHONG_QUYEN };
  const p = parse(repairSchema, input);
  if ("error" in p) return p;
  const res = await requestWorkerRepair(p.data, actorOf(user));
  if ("error" in res) return res;
  await audit({ userId: user.id, userEmail: user.email, action: "TECH_WORKER_REPAIR", entity: "TECH_WORKER", entityId: p.data.workerId, after: { command: p.data.command } });
  revalidatePath("/tech/workers");
  return { ok: true };
}
