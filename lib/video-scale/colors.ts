import { and, eq } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { SHOWCASE, productColorsFrom, type ProductColor, type ShowcaseItem } from "@/lib/constants/video-scale-colors";
import { downloadImage, type DownloadDeps } from "@/lib/creative/import";
import { storeCreativeImage } from "@/lib/creative/images";

/**
 * ═══════════ VIDEO SCALE — ẢNH TỪNG MÀU CHO ĐOẠN BẢNG MÀU ═══════════
 *
 * Màu + ảnh lấy từ các MẪU MÃ đang bán của mã (`product_variants`, đồng bộ từ Pancake) — `productColorsFrom`. Ảnh được nhập
 * thành nguồn `PRODUCT_PHOTO` của ĐÚNG mã (một URL ⇒ một nguồn, cùng khoá lũy đẳng với bộ nhập ảnh Pancake: mã + `source_url`),
 * để đường dựng đọc nó qua `loadSourceImage` như mọi ảnh gốc — không có đường điểm ảnh thứ hai. Lỗi từng màu không làm hỏng cả
 * lượt: màu tải hỏng được NÓI RA và bỏ khỏi bảng màu, không lặng lẽ biến mất.
 */

export type ColorOption = ProductColor & { sourceId: string | null; imageId: string | null };

/** Các màu của mã + nguồn ảnh đã nhập (nếu có) cho từng màu. Chỉ đọc. */
export async function listProductColors(db: Db, productId: string): Promise<ColorOption[]> {
  const v = schema.productVariants;
  const rows = await db.select({ color: v.color, attributes: v.attributes, images: v.images, isRemoved: v.isRemoved, isHidden: v.isHidden }).from(v).where(eq(v.productId, productId)).orderBy(v.id);
  const colors = productColorsFrom(rows);
  const s = schema.creativeSources;
  const have = await db.select({ id: s.id, url: s.sourceUrl, imageId: s.imageId, active: s.active }).from(s).where(and(eq(s.kind, "PRODUCT_PHOTO"), eq(s.productId, productId)));
  return colors.map((c) => {
    const src = c.imageUrl ? have.find((h) => h.url === c.imageUrl && h.active && h.imageId) : undefined;
    return { ...c, sourceId: src?.id ?? null, imageId: src?.imageId ?? null };
  });
}

export type EnsureColorsResult = { items: ShowcaseItem[]; failed: { color: string; reason: string }[] };

/**
 * Bảng màu cho các màu người chọn (theo thứ tự người chọn): màu đã có nguồn thì dùng lại, chưa có thì tải ảnh mẫu mã → lưu →
 * nguồn `PRODUCT_PHOTO`. Màu không có trong mã / không có ảnh / tải hỏng ⇒ vào `failed` kèm lý do.
 */
export async function ensureColorPhotos(db: Db, productId: string, wanted: readonly string[], actor: { id: string | null; name: string }, deps: DownloadDeps = {}): Promise<EnsureColorsResult> {
  const out: EnsureColorsResult = { items: [], failed: [] };
  if (!wanted.length) return out;
  const [prod] = await db.select({ name: schema.products.name }).from(schema.products).where(eq(schema.products.id, productId)).limit(1);
  if (!prod) return { items: [], failed: wanted.map((color) => ({ color, reason: "Không tìm thấy mã." })) };
  const options = await listProductColors(db, productId);
  const s = schema.creativeSources;
  for (const w of wanted.slice(0, SHOWCASE.maxColors)) {
    const o = options.find((x) => x.color.toLowerCase() === w.trim().toLowerCase());
    if (!o) {
      out.failed.push({ color: w, reason: "Mã không có màu này (mẫu mã đang bán)." });
      continue;
    }
    if (o.sourceId) {
      out.items.push({ sourceId: o.sourceId, color: o.color });
      continue;
    }
    if (!o.imageUrl) {
      out.failed.push({ color: o.color, reason: "Mẫu mã màu này chưa có ảnh trên Pancake." });
      continue;
    }
    try {
      const stored = await storeCreativeImage(db, await downloadImage(o.imageUrl, deps));
      const [row] = await db
        .insert(s)
        .values({
          kind: "PRODUCT_PHOTO",
          productId,
          title: `${prod.name} · màu ${o.color}`,
          note: "Ảnh mẫu mã theo màu trên Pancake — nhập cho đoạn bảng màu của Video Scale.",
          sourceUrl: o.imageUrl,
          imageId: stored.id,
          createdByUserId: actor.id,
          createdByName: actor.name,
        })
        .returning({ id: s.id });
      out.items.push({ sourceId: row.id, color: o.color });
    } catch (e) {
      out.failed.push({ color: o.color, reason: (e instanceof Error ? e.message : String(e)).slice(0, 200) });
    }
  }
  return out;
}

/** Ô bảng màu phải là ẢNH SẢN PHẨM THẬT đang bật của ĐÚNG mã (kiểm ở mọi đường ghi). Trả câu lỗi hoặc `null`. */
export async function showcaseProblem(db: Db, productId: string, items: readonly ShowcaseItem[]): Promise<string | null> {
  if (!items.length) return null;
  const s = schema.creativeSources;
  const rows = await db.select({ id: s.id, kind: s.kind, productId: s.productId, active: s.active, imageId: s.imageId }).from(s).where(eq(s.productId, productId));
  const bad = items.find((it) => {
    const r = rows.find((x) => x.id === it.sourceId);
    return !r || r.kind !== "PRODUCT_PHOTO" || !r.active || !r.imageId;
  });
  return bad ? `Ảnh bảng màu "${bad.color}" không phải ảnh sản phẩm thật đang bật của mã này.` : null;
}
