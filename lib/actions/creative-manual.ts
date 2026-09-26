"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import { addUploadedDraft } from "@/lib/creative/manual-gen";
import { priceWarnings } from "@/lib/creative/copy-edit";
import { loadProductBrief } from "@/lib/queries/creative-plan";
import { manualCreativeInputSchema } from "@/lib/validation/creative";

/**
 * ═══════════ VÒNG MẪU — TẢI MẪU TỰ LÀM VÀO LÔ ═══════════
 *
 * Mọi luật nằm ở `lib/creative/manual.ts` (đường ghi duy nhất). Tệp này chỉ: kiểm quyền → lược đồ →
 * đọc tên người thao tác từ MÁY CHỦ (AGENTS.md mục 34) → gọi đường ghi → nhật ký.
 *
 * Quyền `ideas:write` — cùng quyền tải ảnh nguồn. Tải mẫu KHÔNG phải đăng: từ 26/09/2026 (chủ shop bỏ lô hằng ngày)
 * mẫu tự làm vào THẲNG hàng đợi đăng camp (`addUploadedDraft`); đăng vẫn cần bấm Đăng camp (thêm `expenses:write`).
 */

type Result<T = object> = ({ ok: true } & T) | { error: string };

export async function addManualCreative(input: unknown): Promise<Result<{ imageId: string; warnings: string[] }>> {
  const user = await requireUser();
  if (!can(user, "ideas:write")) return { error: "Bạn không có quyền tải mẫu vào vòng mẫu" };
  const parsed = manualCreativeInputSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const d = parsed.data;

  const db = await getDb();
  const product = await loadProductBrief(db, d.productId);
  if (!product) return { error: "Không tìm thấy mã hàng đã chọn — tải lại trang rồi chọn lại." };

  const who = await db.query.users.findFirst({ where: eq(schema.users.id, user.id), columns: { name: true, email: true } });
  const name = who?.name?.trim() || who?.email || user.email;

  const r = await addUploadedDraft(
    db,
    { productId: d.productId, genes: d.genes, primaryText: d.primaryText, headline: d.headline, note: d.note, imageBytes: new Uint8Array(Buffer.from(d.imageBase64, "base64")) },
    { id: user.id, name },
    new Date(),
  );
  if (!r.ok) return { error: r.error };

  // Giá trong câu chữ khác giá ERP: KHÔNG chặn (người viết có thể đang chạy giá khuyến mãi) nhưng
  // phải nói ra — câu chữ máy viết thì bị ép đúng giá, câu chữ người viết thì người tự chịu.
  const warnings = priceWarnings(`${d.headline}\n${d.primaryText}`, product.priceVnd);

  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "CREATIVE_MANUAL_ADD",
    entity: "CREATIVE_MANUAL_GEN_IMAGE",
    entityId: r.imageId,
    after: { genId: r.genId, productId: d.productId, genes: d.genes, queued: true, warnings },
  });
  revalidatePath("/marketing/creatives");
  return { ok: true, imageId: r.imageId, warnings };
}
