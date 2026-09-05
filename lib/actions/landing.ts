"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import { clearMemo } from "@/lib/cache";
import { DEFAULT_LANDING_CONFIG, LANDING_CONFIG_KEY, LANDING_STATUSES, type LandingConfig } from "@/lib/constants/landing";
import { pushLandingToPos } from "@/lib/landing/pos";
import { importLandingSheet, loadLandingConfig, previewSheet, refreshLandingChecks } from "@/lib/landing/sheet";
import { setSettingJson } from "@/lib/settings";

export type ActionResult<T = object> = ({ ok: true } & T) | { error: string };

function revalidate() {
  clearMemo();
  revalidatePath("/landing");
}

export async function setLandingStatus(id: string, status: string): Promise<ActionResult> {
  const user = await requireUser();
  if (!can(user, "landing:manage")) return { error: "Không có quyền" };
  if (!(LANDING_STATUSES as string[]).includes(status)) return { error: "Trạng thái không hợp lệ" };
  const db = await getDb();
  const row = await db.query.landingOrders.findFirst({ where: eq(schema.landingOrders.id, id), columns: { id: true, status: true, pancakeOrderId: true } });
  if (!row) return { error: "Không tìm thấy đơn" };
  if (status === "PUSHED" && !row.pancakeOrderId) return { error: "Dùng nút “Gửi POS” để tạo đơn nháp" };
  await db.update(schema.landingOrders).set({ status, assignee: user.name || user.email, updatedAt: new Date() }).where(eq(schema.landingOrders.id, id));
  await audit({ userId: user.id, userEmail: user.email, action: "LANDING_STATUS", entity: "LANDING_ORDER", entityId: id, detail: { before: row.status, after: status } });
  revalidate();
  return { ok: true };
}

export async function setLandingVariant(id: string, variantId: string | null): Promise<ActionResult> {
  const user = await requireUser();
  if (!can(user, "landing:manage")) return { error: "Không có quyền" };
  const db = await getDb();
  await db.update(schema.landingOrders).set({ variantId: variantId || null, variantMatchScore: variantId ? 99 : 0, updatedAt: new Date() }).where(eq(schema.landingOrders.id, id));
  revalidate();
  return { ok: true };
}

export async function setLandingNote(id: string, note: string): Promise<ActionResult> {
  const user = await requireUser();
  if (!can(user, "landing:manage")) return { error: "Không có quyền" };
  const db = await getDb();
  await db.update(schema.landingOrders).set({ internalNote: note.slice(0, 1000), updatedAt: new Date() }).where(eq(schema.landingOrders.id, id));
  revalidate();
  return { ok: true };
}

export async function pushLanding(id: string): Promise<ActionResult<{ systemId: number }>> {
  const user = await requireUser();
  if (!can(user, "landing:manage")) return { error: "Không có quyền" };
  const r = await pushLandingToPos(id, user.name || user.email);
  if ("error" in r) return r;
  await audit({ userId: user.id, userEmail: user.email, action: "LANDING_PUSH_POS", entity: "LANDING_ORDER", entityId: id, detail: { pancakeOrderId: r.pancakeOrderId, systemId: r.systemId } });
  revalidate();
  return { ok: true, systemId: r.systemId };
}

export async function recheckLanding(id: string): Promise<ActionResult> {
  const user = await requireUser();
  if (!can(user, "landing:manage")) return { error: "Không có quyền" };
  await refreshLandingChecks(id);
  revalidate();
  return { ok: true };
}

export async function runLandingImport(): Promise<ActionResult<{ summary: string }>> {
  const user = await requireUser();
  if (!can(user, "landing:manage")) return { error: "Không có quyền" };
  try {
    const r = await importLandingSheet();
    revalidate();
    return { ok: true, summary: `${r.tabs.map((t) => `${t.label} ${t.rows} dòng${t.error ? ` (lỗi: ${t.error})` : ""}`).join(", ")} · mới ${r.inserted} · cập nhật ${r.updated} · ghép mẫu mã ${r.matchedVariants} · trùng ${r.duplicates} · rủi ro ${r.risky} · ghép đơn Pancake ${r.linked}${r.errors.length ? ` · lỗi: ${r.errors.join("; ")}` : ""}` };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

const configSchema = z.object({
  sheetUrl: z.string().trim().max(500),
  gid: z.string().trim().max(20),
  tabs: z.string().trim().max(300).default(""),
  columns: z.record(z.string(), z.string().trim().max(120)).default({}),
  hasHeader: z.enum(["auto", "yes", "no"]).default("auto"),
  dedupeDays: z.number().int().min(1).max(90).default(7),
  autoPush: z.boolean().default(false),
  shippingFee: z.number().int().min(0).max(1_000_000).default(25_000),
  posNote: z.string().trim().max(200).default("Đơn landing page"),
  warehouseId: z.string().trim().max(80).default(""),
});

export async function saveLandingConfig(input: unknown): Promise<ActionResult<{ preview?: string }>> {
  const user = await requireUser();
  if (!can(user, "landing:config")) return { error: "Không có quyền" };
  const parsed = configSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const before = await loadLandingConfig();
  const next: LandingConfig = { ...DEFAULT_LANDING_CONFIG, ...parsed.data, columns: Object.fromEntries(Object.entries(parsed.data.columns).filter(([, v]) => v)) as LandingConfig["columns"] };
  await setSettingJson(LANDING_CONFIG_KEY, next);
  await audit({ userId: user.id, userEmail: user.email, action: "SETTINGS_UPDATE", entity: "SETTINGS", entityId: LANDING_CONFIG_KEY, detail: { before: { ...before, sheetUrl: before.sheetUrl ? "(đã đặt)" : "" }, after: { ...next, sheetUrl: next.sheetUrl ? "(đã đặt)" : "" } } });
  revalidate();
  let preview: string | undefined;
  if (next.sheetUrl) {
    try {
      const pv = await previewSheet(next);
      preview = pv.tabs.map((t) => (t.error ? `${t.label}: ${t.error}` : `${t.label}: ${t.rows} dòng, ${Object.keys(t.detected).length} cột dò được${!t.detected.phone ? " (CHƯA có cột SĐT)" : ""}`)).join(" · ");
    } catch (e) {
      preview = `Không đọc được sheet: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  return { ok: true, preview };
}

export type TabPreviewDto = { label: string; headers: string[]; detected: Record<string, string>; sample: string[][]; rows: number; hasHeader: boolean; error?: string };
export async function previewLandingSheet(): Promise<ActionResult<{ tabs: TabPreviewDto[] }>> {
  const user = await requireUser();
  if (!can(user, "landing:config")) return { error: "Không có quyền" };
  try {
    const pv = await previewSheet();
    return { ok: true, tabs: pv.tabs.map((t) => ({ label: t.label, headers: t.headers, detected: t.detected as Record<string, string>, sample: t.sample, rows: t.rows, hasHeader: t.hasHeader, error: t.error })) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
