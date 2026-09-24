import { createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { schema, type Db } from "@/db";

/**
 * ═══════════ ĐIỂM ẢNH CỦA VÒNG MẪU — ĐƯỜNG GHI / ĐỌC DUY NHẤT ═══════════
 *
 * Ảnh nằm trong CSDL (`creative_images`) vì ổ đĩa của CSDL là thứ duy nhất bền qua mỗi lần deploy —
 * cùng lý do với `marketing_idea_images`.
 *
 * Băm tính từ CHÍNH các byte nhận được. Phiếu duyệt lô khoá trên băm này (`lib/creative/approval.ts`),
 * nên nếu nhận băm từ nơi gọi thì một ảnh bị tráo sau khi duyệt vẫn mang băm cũ và lọt qua phiếu.
 */

/** Trần kích thước một ảnh lưu vào CSDL (byte, trước base64). Ảnh gpt-image JPEG ~ 200–600 KB. */
export const CREATIVE_IMAGE_MAX_BYTES = 6 * 1024 * 1024;

export type CreativeImageType = "image/jpeg" | "image/png" | "image/webp";

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Nhận diện loại ảnh từ chữ ký byte — không tin `content-type` do nơi gọi khai. */
export function sniffImageType(bytes: Uint8Array): CreativeImageType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return "image/webp";
  return null;
}

/** Kích thước ảnh PNG / JPEG đọc từ tiêu đề tệp. Không đọc được ⇒ `null` (CHƯA BIẾT). */
export function imageDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  const type = sniffImageType(bytes);
  if (type === "image/png" && bytes.length >= 24) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: dv.getUint32(16), height: dv.getUint32(20) };
  }
  if (type === "image/jpeg") {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) return null;
      const marker = bytes[i + 1];
      const len = dv.getUint16(i + 2);
      // SOF0..SOF15 trừ DHT(C4), JPG(C8), DAC(CC) — nơi JPEG khai chiều cao/rộng.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: dv.getUint16(i + 5), width: dv.getUint16(i + 7) };
      }
      i += 2 + len;
    }
  }
  return null;
}

export type StoredImage = { id: string; sha256: string; contentType: CreativeImageType; bytes: number };

/** Lưu một ảnh. Ném lỗi nghiệp vụ (tiếng Việt) nếu không phải ảnh hoặc quá lớn. */
export async function storeCreativeImage(db: Db, bytes: Uint8Array): Promise<StoredImage> {
  if (bytes.length === 0) throw new Error("Ảnh rỗng.");
  if (bytes.length > CREATIVE_IMAGE_MAX_BYTES) throw new Error(`Ảnh quá lớn (${Math.round(bytes.length / 1024)} KB) — tối đa ${CREATIVE_IMAGE_MAX_BYTES / 1024 / 1024} MB.`);
  const contentType = sniffImageType(bytes);
  if (!contentType) throw new Error("Tệp không phải ảnh JPEG / PNG / WEBP.");
  const sha256 = sha256Hex(bytes);
  const dim = imageDimensions(bytes);
  const [row] = await db
    .insert(schema.creativeImages)
    .values({ sha256, contentType, bytes: bytes.length, width: dim?.width ?? null, height: dim?.height ?? null, data: Buffer.from(bytes).toString("base64") })
    .returning({ id: schema.creativeImages.id });
  return { id: row.id, sha256, contentType, bytes: bytes.length };
}

/** Đọc điểm ảnh. Đã xoá điểm ảnh hoặc không tồn tại ⇒ `null`. */
export async function readCreativeImage(db: Db, id: string): Promise<{ contentType: string; sha256: string; bytes: Buffer } | null> {
  const [row] = await db
    .select({ contentType: schema.creativeImages.contentType, sha256: schema.creativeImages.sha256, data: schema.creativeImages.data })
    .from(schema.creativeImages)
    .where(and(eq(schema.creativeImages.id, id), isNull(schema.creativeImages.purgedAt)))
    .limit(1);
  if (!row || !row.data) return null;
  return { contentType: row.contentType, sha256: row.sha256, bytes: Buffer.from(row.data, "base64") };
}

/** Xoá ĐIỂM ẢNH, giữ dòng (băm, kích thước, mốc) — mẫu thua vẫn là một quan sát của việc học. */
export async function purgeCreativeImage(db: Db, id: string): Promise<boolean> {
  const rows = await db
    .update(schema.creativeImages)
    .set({ data: "", purgedAt: new Date() })
    .where(and(eq(schema.creativeImages.id, id), isNull(schema.creativeImages.purgedAt)))
    .returning({ id: schema.creativeImages.id });
  return rows.length > 0;
}
