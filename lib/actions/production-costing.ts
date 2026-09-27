"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/db";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import type { Actor } from "@/lib/constants/actor";
import { COST_LINE_KINDS, COST_LINE_MAX_VND } from "@/lib/constants/production-os";
import { createCostSheetCore, finalizeCostSheetCore, updateCostSheetDraftCore } from "@/lib/production/costing";
import { describeFollow } from "@/lib/production/lifecycle";
import { startCostSheetFromTopicCore } from "@/lib/production/shortcuts";
import { loadTopicAccess } from "@/lib/production/topic-access";

/**
 * ═══════════ SERVER ACTION: BẢNG GIÁ THÀNH CÓ PHIÊN BẢN ═══════════
 *
 * Lập / sửa bảng NHÁP: `production:write`. Chốt (FINAL, bất biến): `production:approve` — quyền được đọc Ở
 * ĐÂY từ phiên đăng nhập và truyền vào lõi dưới tên `canApprove`; lõi từ chối khi `false`.
 *
 * KHÔNG có action nào ghi giá ước tính ở tệp này. Nút "Dùng làm giá ước tính" gọi thẳng
 * `setEstimatedCost` (lib/actions/estimated-cost.ts, quyền `reports:assumptions`) — một đường ghi, một khoá.
 */
type Result<T = object> = ({ ok: true } & T) | { error: string };

const lineSchema = z.object({
  kind: z.enum(COST_LINE_KINDS),
  description: z.string().trim().max(300).default(""),
  qty: z.number().min(0, "Số lượng phải ≥ 0").max(1_000_000),
  unit: z.string().trim().max(20).default(""),
  unitCost: z.number().int("Đơn giá là số nguyên VND").min(0).max(COST_LINE_MAX_VND),
});

const createSchema = z.object({
  modelId: z.string().min(1, "Chọn mẫu"),
  topicId: z.string().trim().min(1).nullable().default(null),
  lines: z.array(lineSchema).min(1, "Bảng giá thành cần ít nhất một dòng").max(60),
  notes: z.string().trim().max(3000).default(""),
});

const updateSchema = z.object({
  costSheetId: z.string().min(1),
  lines: z.array(lineSchema).min(1, "Bảng giá thành cần ít nhất một dòng").max(60),
  notes: z.string().trim().max(3000).default(""),
});

function actorOf(user: { id: string; name: string | null; email: string }): Actor {
  return { id: user.id, label: user.name || user.email };
}

function revalidateProduction() {
  revalidatePath("/production", "layout");
}

export async function createCostSheet(input: unknown): Promise<Result<{ costSheetId: string; version: number; totalUnitCost: number; lifecycle: string | null }>> {
  const user = await requireUser();
  if (!can(user, "production:write")) return { error: "Không có quyền lập bảng giá thành" };
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const db = await getDb();
  const r = await createCostSheetCore(db, { ...parsed.data, actor: actorOf(user) });
  if ("error" in r) return r;
  await audit({ userId: user.id, userEmail: user.email, action: "COST_SHEET_CREATE", entity: "COST_SHEET", entityId: r.costSheetId, after: { modelId: parsed.data.modelId, version: r.version, totalUnitCost: r.totalUnitCost }, detail: { lifecycle: r.lifecycle } });
  revalidateProduction();
  revalidatePath(`/models/${parsed.data.modelId}`);
  return { ok: true, costSheetId: r.costSheetId, version: r.version, totalUnitCost: r.totalUnitCost, lifecycle: describeFollow(r.lifecycle) };
}

export async function updateCostSheetDraft(input: unknown): Promise<Result<{ totalUnitCost: number }>> {
  const user = await requireUser();
  if (!can(user, "production:write")) return { error: "Không có quyền sửa bảng giá thành" };
  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const db = await getDb();
  const r = await updateCostSheetDraftCore(db, { ...parsed.data, actor: actorOf(user) });
  if ("error" in r) return r;
  await audit({ userId: user.id, userEmail: user.email, action: "COST_SHEET_UPDATE", entity: "COST_SHEET", entityId: parsed.data.costSheetId, after: { totalUnitCost: r.totalUnitCost, lines: parsed.data.lines.length } });
  revalidateProduction();
  return { ok: true, totalUnitCost: r.totalUnitCost };
}

export async function finalizeCostSheet(costSheetId: string): Promise<Result<{ version: number; totalUnitCost: number }>> {
  const user = await requireUser();
  if (!can(user, "production:write")) return { error: "Không có quyền" };
  if (!costSheetId) return { error: "Thiếu bảng giá thành" };
  const db = await getDb();
  const r = await finalizeCostSheetCore(db, { costSheetId, actor: actorOf(user), canApprove: can(user, "production:approve") });
  if ("error" in r) return r;
  await audit({ userId: user.id, userEmail: user.email, action: "COST_SHEET_FINALIZE", entity: "COST_SHEET", entityId: costSheetId, after: { status: "FINAL", version: r.version, totalUnitCost: r.totalUnitCost } });
  revalidateProduction();
  return { ok: true, version: r.version, totalUnitCost: r.totalUnitCost };
}

/**
 * Lối tắt "Lập giá thành V1" trên trang topic ĐÃ CHỐT (Company OS · Agent SC). Dòng khởi tạo do MÁY CHỦ
 * dựng từ topic (lib/production/shortcuts.ts) rồi đi qua ĐÚNG `createCostSheetCore` — cùng quyền
 * `production:write`, cùng nhật ký `COST_SHEET_CREATE` với nút "Phiên bản giá thành mới". Bấm hai lần ⇒ lần
 * sau nhận lại V1 đã có (`EXISTING`), không đẻ V2. Topic chưa có giá nào ⇒ không ghi gì (`EMPTY_EDITOR`).
 */
export async function startCostSheetFromTopic(topicId: string): Promise<Result<{ mode: "CREATED" | "EXISTING" | "EMPTY_EDITOR"; version: number | null; totalUnitCost: number | null; note: string; lifecycle: string | null }>> {
  const user = await requireUser();
  if (!can(user, "production:write")) return { error: "Không có quyền lập bảng giá thành" };
  const id = z.string().trim().min(1).safeParse(topicId);
  if (!id.success) return { error: "Thiếu topic" };
  const db = await getDb();
  // Topic RIÊNG (0153): chỉ người trong topic đọc được yêu cầu / báo giá của nó — kể cả để điền sẵn giá thành.
  if (!(await loadTopicAccess(db, id.data, user))?.view) return { error: "Không tìm thấy topic" };
  const r = await startCostSheetFromTopicCore(db, { topicId: id.data, actor: actorOf(user), canWrite: true });
  if ("error" in r) return r;
  if (r.mode === "CREATED") {
    await audit({ userId: user.id, userEmail: user.email, action: "COST_SHEET_CREATE", entity: "COST_SHEET", entityId: r.costSheetId, after: { version: r.version, totalUnitCost: r.totalUnitCost, source: r.prefill.source, topicId: id.data }, detail: { lifecycle: r.lifecycle, shortcut: "COST_V1_FROM_TOPIC" } });
  }
  // Mọi nhánh thành công đều làm mới trang (kể cả EXISTING: người khác vừa tạo ⇒ trang đang cũ thật).
  revalidateProduction();
  if (r.mode === "CREATED") revalidatePath(`/models/${r.modelId}`);
  return {
    ok: true,
    mode: r.mode,
    version: r.mode === "EMPTY_EDITOR" ? null : r.version,
    totalUnitCost: r.mode === "CREATED" ? r.totalUnitCost : null,
    note: r.mode === "EXISTING" ? "" : r.prefill.note,
    lifecycle: r.mode === "CREATED" ? describeFollow(r.lifecycle) : null,
  };
}
