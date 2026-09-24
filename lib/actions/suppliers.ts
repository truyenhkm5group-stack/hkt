"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import { keysOf } from "@/lib/constants/suppliers";
import { listSuppliers } from "@/lib/queries/suppliers";

/**
 * ═══════════ DANH MỤC XƯỞNG — GHI ═══════════
 *
 * Một luật chặn ở đây: KHÔNG hai xưởng nào được giữ cùng một khoá (tên hoặc tên gọi khác, so không
 * dấu, không hoa thường). Để lọt thì mọi dòng lịch sử gõ khoá ấy thành NHẬP NHẰNG và rơi khỏi mọi con
 * số theo xưởng — danh mục sinh ra để gom lại, không phải để tách thêm.
 *
 * Không xoá: ngừng dùng (`active = false`) để lịch sử vẫn quy về được. Xoá một xưởng là làm mồ côi
 * mọi lô đã ghi `supplier_id` của nó.
 */

const PATHS = ["/inventory/purchasing", "/inventory/planning/orders", "/inventory/receipts"];

const supplierSchema = z.object({
  name: z.string().trim().min(1, "Cần tên xưởng").max(120),
  aliases: z.array(z.string().trim().min(1).max(120)).max(30).default([]),
  phone: z.string().trim().max(40).default(""),
  note: z.string().trim().max(500).default(""),
  active: z.boolean().default(true),
});

type Result = { ok: true; id: string } | { error: string };

async function vaChamVoi(input: { name: string; aliases: string[] }, boQuaId: string | null): Promise<string | null> {
  const mine = keysOf(input);
  for (const other of await listSuppliers()) {
    if (other.id === boQuaId) continue;
    const trung = keysOf(other).find((k) => mine.includes(k));
    if (trung) return `Tên "${trung}" đã thuộc xưởng "${other.name}" — một cách gõ chỉ được thuộc về MỘT xưởng, nếu không mọi lô gõ tên ấy sẽ không quy về được xưởng nào.`;
  }
  return null;
}

export async function createSupplier(raw: unknown): Promise<Result> {
  const user = await requireUser();
  if (!can(user, "planning:write")) return { error: "Không có quyền sửa danh mục xưởng" };
  const parsed = supplierSchema.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const d = parsed.data;
  const loi = await vaChamVoi(d, null);
  if (loi) return { error: loi };
  const db = await getDb();
  const [row] = await db
    .insert(schema.suppliers)
    .values({ name: d.name, aliases: d.aliases, phone: d.phone, note: d.note, active: d.active, createdByUserId: user.id })
    .returning({ id: schema.suppliers.id });
  await audit({ userId: user.id, userEmail: user.email, action: "SUPPLIER_CREATE", entity: "SUPPLIER", entityId: row.id, after: d });
  for (const p of PATHS) revalidatePath(p);
  return { ok: true, id: row.id };
}

export async function updateSupplier(id: string, raw: unknown): Promise<Result> {
  const user = await requireUser();
  if (!can(user, "planning:write")) return { error: "Không có quyền sửa danh mục xưởng" };
  const parsed = supplierSchema.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const d = parsed.data;
  const db = await getDb();
  const cu = await db.query.suppliers.findFirst({ where: eq(schema.suppliers.id, id) });
  if (!cu) return { error: "Không tìm thấy xưởng" };
  const loi = await vaChamVoi(d, id);
  if (loi) return { error: loi };
  await db.update(schema.suppliers).set({ name: d.name, aliases: d.aliases, phone: d.phone, note: d.note, active: d.active, updatedAt: new Date() }).where(eq(schema.suppliers.id, id));
  await audit({ userId: user.id, userEmail: user.email, action: "SUPPLIER_UPDATE", entity: "SUPPLIER", entityId: id, before: { name: cu.name, aliases: cu.aliases, active: cu.active }, after: d });
  for (const p of PATHS) revalidatePath(p);
  return { ok: true, id };
}
