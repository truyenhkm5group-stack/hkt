"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import { storeCreativeImage } from "@/lib/creative/images";
import { creativeSourceInputSchema, creativeSourceToggleSchema } from "@/lib/validation/creative";

/**
 * ═══════════ VÒNG MẪU — GHI NGUỒN ẢNH ĐẦU VÀO ═══════════
 *
 * Chỉ LƯU nguồn. Việc đọc ảnh thành gen + mô tả chữ là của lượt chạy vòng mẫu (gói SINH): nguồn nào
 * còn `vision_at IS NULL` sẽ được đọc ở lượt kế tiếp. Không gọi mô hình ngay trong lần bấm này —
 * một lần tải ảnh không được phép chờ, và cũng không được phép hỏng, vì một dịch vụ bên ngoài.
 */

type Result<T = object> = ({ ok: true } & T) | { error: string };

const DUONG = "/marketing/creatives";

/** Tên người thao tác do MÁY CHỦ đọc từ `users` (AGENTS.md mục 34) — không nhận tên từ client. */
async function tenNguoiThaoTac(userId: string, fallback: string): Promise<string> {
  const db = await getDb();
  const row = await db.query.users.findFirst({ where: eq(schema.users.id, userId), columns: { name: true, email: true } });
  return row?.name?.trim() || row?.email || fallback;
}

/** Thêm một ảnh nguồn. Ảnh đã được thu nhỏ ở trình duyệt; máy chủ tự băm và tự đọc loại ảnh. */
export async function createCreativeSource(input: unknown): Promise<Result<{ id: string }>> {
  const user = await requireUser();
  if (!can(user, "ideas:write")) return { error: "Bạn không có quyền thêm ảnh nguồn cho vòng mẫu" };
  const parsed = creativeSourceInputSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const d = parsed.data;

  const db = await getDb();
  if (d.productId) {
    const sp = await db.query.products.findFirst({ where: eq(schema.products.id, d.productId), columns: { id: true } });
    if (!sp) return { error: "Không tìm thấy mã hàng đã chọn — tải lại trang rồi chọn lại." };
  }

  let stored: Awaited<ReturnType<typeof storeCreativeImage>>;
  try {
    stored = await storeCreativeImage(db, new Uint8Array(Buffer.from(d.imageBase64, "base64")));
  } catch (e) {
    return { error: e instanceof Error && e.message ? e.message : "Không lưu được ảnh" };
  }

  const createdByName = await tenNguoiThaoTac(user.id, user.email);
  const [row] = await db
    .insert(schema.creativeSources)
    .values({
      kind: d.kind,
      productId: d.productId || null,
      title: d.title,
      note: d.note,
      sourceUrl: d.sourceUrl,
      imageId: stored.id,
      createdByUserId: user.id,
      createdByName,
    })
    .returning({ id: schema.creativeSources.id });

  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "CREATIVE_SOURCE_CREATE",
    entity: "CREATIVE_SOURCE",
    entityId: row.id,
    after: { kind: d.kind, productId: d.productId || null, title: d.title, sourceUrl: d.sourceUrl, imageId: stored.id, sha256: stored.sha256, bytes: stored.bytes, contentType: stored.contentType },
  });
  revalidatePath(DUONG);
  return { ok: true, id: row.id };
}

/** Bật / tắt một nguồn. Tắt ⇒ lượt lập lô sau không chọn nó nữa; mẫu đã dựng từ nó không bị đụng. */
export async function setCreativeSourceActive(input: unknown): Promise<Result<{ active: boolean }>> {
  const user = await requireUser();
  if (!can(user, "ideas:write")) return { error: "Bạn không có quyền sửa ảnh nguồn của vòng mẫu" };
  const parsed = creativeSourceToggleSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const { id, active } = parsed.data;

  const db = await getDb();
  const cu = await db.query.creativeSources.findFirst({ where: eq(schema.creativeSources.id, id), columns: { id: true, active: true } });
  if (!cu) return { error: "Không tìm thấy ảnh nguồn" };
  if (cu.active === active) return { ok: true, active };

  await db.update(schema.creativeSources).set({ active, updatedAt: new Date() }).where(eq(schema.creativeSources.id, id));
  await audit({ userId: user.id, userEmail: user.email, action: "CREATIVE_SOURCE_TOGGLE", entity: "CREATIVE_SOURCE", entityId: id, before: { active: cu.active }, after: { active } });
  revalidatePath(DUONG);
  return { ok: true, active };
}
