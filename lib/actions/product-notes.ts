"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import { productNoteDelete, productNoteInput } from "@/lib/validation/product-notes";

/**
 * ═══════════ GHI CHÚ VẬN HÀNH CHO SẢN PHẨM ═══════════
 *
 * Quyền `inventory:write`: ghi chú là thứ người kho và người mua hàng viết trong lúc làm việc, nên
 * gắn với quyền họ vốn đã có. Không mở cho người chỉ-xem — một ô chữ tự do trên trang sản phẩm mà
 * ai cũng viết được sẽ thành chỗ trao đổi, và không ai đọc nữa.
 *
 * TÊN NGƯỜI VIẾT DO MÁY CHỦ ĐỌC. Lược đồ đầu vào cố ý không có trường tên: nhận nó từ client thì
 * một lượt gọi sửa tên là đủ để dòng dữ liệu nói một đằng và quy kết một nẻo.
 */
type Result = { ok: true } | { error: string };

export async function addProductNote(input: unknown): Promise<Result> {
  const user = await requireUser();
  if (!can(user, "inventory:write")) return { error: "Không đủ quyền ghi chú sản phẩm" };
  const parsed = productNoteInput.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const d = parsed.data;

  const db = await getDb();
  const [sp] = await db.select({ id: schema.products.id, name: schema.products.name }).from(schema.products).where(eq(schema.products.id, d.productId)).limit(1);
  if (!sp) return { error: "Không tìm thấy sản phẩm" };

  // Mẫu mã phải THUỘC sản phẩm đang ghi chú. Không kiểm thì một khoá gửi nhầm sẽ gắn ghi chú của
  // sản phẩm này vào mẫu mã của sản phẩm khác, và nó hiện ra ở một trang không ai ngờ tới.
  if (d.variantId) {
    const [mm] = await db.select({ id: schema.productVariants.id, productId: schema.productVariants.productId }).from(schema.productVariants).where(eq(schema.productVariants.id, d.variantId)).limit(1);
    if (!mm || mm.productId !== d.productId) return { error: "Mẫu mã không thuộc sản phẩm này" };
  }

  const [row] = await db
    .insert(schema.productNotes)
    .values({ productId: d.productId, variantId: d.variantId, category: d.category, body: d.body, actorUserId: user.id, actorName: user.name || user.email })
    .returning({ id: schema.productNotes.id });

  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "PRODUCT_NOTE_ADD",
    entity: "PRODUCT",
    entityId: d.productId,
    before: null,
    after: { noteId: row?.id, category: d.category, variantId: d.variantId, body: d.body },
    reason: `Ghi chú vận hành cho "${sp.name}"`,
  });
  revalidatePath(`/products/${d.productId}`);
  revalidatePath("/products");
  return { ok: true };
}

/**
 * Xoá một ghi chú. Có, vì gõ nhầm là chuyện thường — nhưng đi qua nhật ký và giữ lại NỘI DUNG CŨ,
 * nên "xoá" ở đây nghĩa là gỡ khỏi màn hình, không phải xoá khỏi lịch sử.
 */
export async function removeProductNote(input: unknown): Promise<Result> {
  const user = await requireUser();
  if (!can(user, "inventory:write")) return { error: "Không đủ quyền xoá ghi chú" };
  const parsed = productNoteDelete.safeParse(input);
  if (!parsed.success) return { error: "Dữ liệu không hợp lệ" };

  const db = await getDb();
  const [cu] = await db.select().from(schema.productNotes).where(eq(schema.productNotes.id, parsed.data.id)).limit(1);
  if (!cu) return { error: "Không tìm thấy ghi chú" };
  await db.delete(schema.productNotes).where(eq(schema.productNotes.id, parsed.data.id));

  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "PRODUCT_NOTE_DELETE",
    entity: "PRODUCT",
    entityId: cu.productId,
    before: { noteId: cu.id, category: cu.category, body: cu.body, actorName: cu.actorName, createdAt: cu.createdAt.toISOString() },
    after: null,
    reason: "Gỡ ghi chú khỏi màn hình — nội dung cũ giữ lại trong nhật ký",
  });
  revalidatePath(`/products/${cu.productId}`);
  revalidatePath("/products");
  return { ok: true };
}
