"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import { MODEL_STATES } from "@/lib/constants/model-lifecycle";
import { assignModelCodeCore, registerModelCore, setModelOwnerCore, transitionModelCore } from "@/lib/models/service";
import { runModelRegistryJob } from "@/lib/models/registry-job";

/**
 * ═══════════ SERVER ACTION CỦA SỔ MẪU (Company OS · Agent A) ═══════════
 *
 * requireUser → can → zod → lõi dịch vụ (`lib/models/service.ts`, nhận `Actor`) → audit → revalidatePath.
 * Lỗi nghiệp vụ trả `{ error }`.
 *
 * TÊN NGƯỜI THAO TÁC DO MÁY CHỦ ĐỌC từ phiên (mục 34) — lược đồ đầu vào không có trường tên.
 */
type Result = { ok: true } | { error: string };

const transitionInput = z.object({
  modelId: z.string().min(1),
  to: z.enum(MODEL_STATES),
  reason: z.string().max(1000).optional().nullable(),
});

const ownerInput = z.object({
  modelId: z.string().min(1),
  ownerUserId: z.string().min(1).nullable(),
});

const registerInput = z.object({
  code: z.string().trim().min(1, "Nhập mã mẫu").max(40, "Mã mẫu quá dài"),
  name: z.string().max(200).optional().nullable(),
});

function modelPaths(modelId?: string) {
  revalidatePath("/models");
  if (modelId) revalidatePath(`/models/${modelId}`);
}

export async function transitionModel(input: unknown): Promise<Result> {
  const user = await requireUser();
  if (!can(user, "models:write")) return { error: "Không đủ quyền đổi trạng thái vòng đời mẫu" };
  const parsed = transitionInput.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const d = parsed.data;

  const db = await getDb();
  const r = await transitionModelCore(db, {
    modelId: d.modelId,
    to: d.to,
    reason: d.reason ?? "",
    actor: { id: user.id, label: user.name || user.email },
    actorKind: "USER",
    source: `ui:/models/${d.modelId}`,
  });
  if ("error" in r) return { error: r.error };

  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "MODEL_STATE_CHANGE",
    entity: "PRODUCT_MODEL",
    entityId: d.modelId,
    before: { lifecycleState: r.from },
    after: { lifecycleState: r.to, historyId: r.historyId },
    reason: (d.reason ?? "").trim() || undefined,
  });
  modelPaths(d.modelId);
  return { ok: true };
}

export async function setModelOwner(input: unknown): Promise<Result> {
  const user = await requireUser();
  if (!can(user, "models:write")) return { error: "Không đủ quyền đổi người phụ trách mẫu" };
  const parsed = ownerInput.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const d = parsed.data;

  const db = await getDb();
  // Người phụ trách phải là một tài khoản ĐANG HOẠT ĐỘNG — gán cho tài khoản đã khoá là giao việc cho không ai.
  if (d.ownerUserId) {
    const [nguoi] = await db.select({ id: schema.users.id, active: schema.users.active }).from(schema.users).where(eq(schema.users.id, d.ownerUserId)).limit(1);
    if (!nguoi || !nguoi.active) return { error: "Người phụ trách phải là một tài khoản đang hoạt động" };
  }
  const r = await setModelOwnerCore(db, {
    modelId: d.modelId,
    ownerUserId: d.ownerUserId,
    actor: { id: user.id, label: user.name || user.email },
    actorKind: "USER",
    source: `ui:/models/${d.modelId}`,
  });
  if ("error" in r) return { error: r.error };
  if (!r.changed) {
    // Không đổi gì vẫn làm mới: trang có thể đang cũ (người khác vừa làm) — lượt gọi mang luôn giao diện mới, client không cần router.refresh().
    modelPaths(d.modelId);
    return { ok: true };
  }

  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "MODEL_OWNER_CHANGE",
    entity: "PRODUCT_MODEL",
    entityId: d.modelId,
    before: { ownerUserId: r.from },
    after: { ownerUserId: r.to },
  });
  modelPaths(d.modelId);
  return { ok: true };
}

export async function registerModel(input: unknown): Promise<{ ok: true; modelId: string } | { error: string }> {
  const user = await requireUser();
  if (!can(user, "models:write")) return { error: "Không đủ quyền đăng ký mẫu mới" };
  const parsed = registerInput.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const d = parsed.data;

  const db = await getDb();
  const r = await registerModelCore(db, { code: d.code, name: d.name, actor: { id: user.id, label: user.name || user.email }, source: "ui:/models" });
  if ("error" in r) return { error: r.error };

  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "MODEL_REGISTER",
    entity: "PRODUCT_MODEL",
    entityId: r.modelId,
    before: null,
    after: { code: r.code, name: (d.name ?? "").trim(), lifecycleState: "IDEA", registeredBy: "USER" },
  });
  modelPaths(r.modelId);
  return { ok: true, modelId: r.modelId };
}

const assignCodeInput = z.object({
  modelId: z.string().min(1),
  code: z.string().trim().min(1, "Nhập mã chính thức").max(40, "Mã mẫu quá dài"),
});

/**
 * Chốt MÃ CHÍNH THỨC cho mẫu đang mang mã tạm (`TEST-…`). Không khai THẮNG hộ — đó là ô trạng thái riêng.
 * Trang sản xuất cũng in mã mẫu nên làm mới cả nhánh ấy.
 */
export async function assignModelCode(input: unknown): Promise<{ ok: true; code: string } | { error: string }> {
  const user = await requireUser();
  if (!can(user, "models:write")) return { error: "Không đủ quyền chốt mã mẫu" };
  const parsed = assignCodeInput.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const d = parsed.data;
  const db = await getDb();
  const r = await assignModelCodeCore(db, { modelId: d.modelId, code: d.code, actor: { id: user.id, label: user.name || user.email }, source: `ui:/models/${d.modelId}` });
  if ("error" in r) return { error: r.error };
  if (!r.noop) {
    await audit({ userId: user.id, userEmail: user.email, action: "MODEL_CODE_ASSIGN", entity: "PRODUCT_MODEL", entityId: r.modelId, before: { code: r.from }, after: { code: r.to } });
  }
  modelPaths(r.modelId);
  revalidatePath("/production", "layout");
  return { ok: true, code: r.to };
}

/**
 * Chạy job `model-registry` NGAY (có bản ghi `sync_runs`). Không có lịch tự động — đưa vào bộ lập lịch là
 * việc chủ shop duyệt (AGENTS.md mục 7).
 */
export async function runModelRegistrySync(): Promise<{ ok: true; inserted: number; linked: number; ambiguous: number; failed: number } | { error: string }> {
  const user = await requireUser();
  if (!can(user, "models:write")) return { error: "Không đủ quyền đồng bộ sổ mẫu" };
  let ket: Awaited<ReturnType<typeof runModelRegistryJob>>;
  try {
    ket = await runModelRegistryJob({ trigger: "MANUAL", actor: user.email });
  } catch (e) {
    return { error: `Đồng bộ sổ mẫu thất bại: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (ket.skippedBecauseRunning) return { error: "Đang có một lượt đồng bộ sổ mẫu chạy — đợi vài giây rồi tải lại trang" };
  if (!ket.result) return { error: "Đồng bộ sổ mẫu thất bại — xem trang Kết nối dữ liệu" };

  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "MODEL_REGISTRY_SYNC",
    entity: "PRODUCT_MODEL",
    after: { inserted: ket.result.inserted, linked: ket.result.linked, ambiguous: ket.result.ambiguous.length, failed: ket.result.failed.length },
  });
  modelPaths();
  return { ok: true, inserted: ket.result.inserted, linked: ket.result.linked, ambiguous: ket.result.ambiguous.length, failed: ket.result.failed.length };
}
