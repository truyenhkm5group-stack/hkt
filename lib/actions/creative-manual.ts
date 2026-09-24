"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import { addManualVariant } from "@/lib/creative/manual";
import { assignBatchNames } from "@/lib/creative/naming";
import { priceWarnings } from "@/lib/creative/copy-edit";
import { loadProductBrief } from "@/lib/queries/creative-plan";
import { readCurrentCreativeConfig } from "@/lib/queries/creative-loop";
import { manualCreativeInputSchema } from "@/lib/validation/creative";

/**
 * ═══════════ VÒNG MẪU — TẢI MẪU TỰ LÀM VÀO LÔ ═══════════
 *
 * Mọi luật nằm ở `lib/creative/manual.ts` (đường ghi duy nhất). Tệp này chỉ: kiểm quyền → lược đồ →
 * đọc tên người thao tác từ MÁY CHỦ (AGENTS.md mục 34) → gọi đường ghi → nhật ký.
 *
 * Quyền `ideas:write` — cùng quyền tải ảnh nguồn. Tải mẫu KHÔNG phải duyệt: mẫu vẫn phải qua lượt
 * duyệt lô (quyền `expenses:write`) mới được đăng, và thêm một mẫu làm phiếu duyệt cũ mất hiệu lực.
 */

type Result<T = object> = ({ ok: true } & T) | { error: string };

export async function addManualCreative(input: unknown): Promise<Result<{ batchDay: string; slot: number; warnings: string[] }>> {
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
  const { config } = await readCurrentCreativeConfig(db);

  const r = await addManualVariant(
    db,
    { productId: d.productId, genes: d.genes, primaryText: d.primaryText, headline: d.headline, note: d.note, imageBytes: new Uint8Array(Buffer.from(d.imageBase64, "base64")) },
    config,
    { id: user.id, name },
    new Date(),
  );
  if (!r.ok) return { error: r.error };
  // Tên chiến dịch / nhóm / quảng cáo theo khuôn (§5i) — điền ngay để người thấy tên sẽ đăng.
  await assignBatchNames(db, r.batchId, new Date());

  // Giá trong câu chữ khác giá ERP: KHÔNG chặn (người viết có thể đang chạy giá khuyến mãi) nhưng
  // phải nói ra — câu chữ máy viết thì bị ép đúng giá, câu chữ người viết thì người tự chịu.
  const warnings = priceWarnings(`${d.headline}\n${d.primaryText}`, product.priceVnd);

  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "CREATIVE_MANUAL_ADD",
    entity: "CREATIVE_VARIANT",
    entityId: r.variantId,
    after: { batchDay: r.batchDay, batchId: r.batchId, slot: r.slot, productId: d.productId, genes: d.genes, createdBatch: r.createdBatch, warnings },
  });
  revalidatePath("/marketing/creatives");
  return { ok: true, batchDay: r.batchDay, slot: r.slot, warnings };
}
