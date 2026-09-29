import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb, schema } from "@/db";
import { adUploadPublishable } from "@/lib/creative/ad-video";
import { env } from "@/lib/env";
import { verifyAssetSignature } from "@/lib/video-scale/ad-spec";
import { getAssetMeta, readAssetRange } from "@/lib/video-scale/storage";

export const dynamic = "force-dynamic";

/**
 * LINK KÝ TÊN cho Facebook tải video quảng cáo (`POST act_{id}/advideos` với `file_url`). Không phiên đăng nhập: máy của
 * Facebook gọi tới. Chỉ mở khi ĐỦ cả bốn:
 *  · chữ ký HMAC (khoá `AUTH_SECRET`) trên (tệp, hạn) đúng — so hằng thời gian;
 *  · chưa hết hạn, và hạn không xa quá 2 giờ (không phát được link sống lâu);
 *  · tệp là BẢN HOÀN CHỈNH hoặc ẢNH BÌA của một biến thể ĐÃ DUYỆT, KHÔNG phải dữ liệu thử — HOẶC là VIDEO TỰ TẢI LÊN
 *    (`AD_UPLOAD`) của một mẫu ĐÃ DUYỆT / đã đăng ở trang Mẫu quảng cáo (`adUploadPublishable`).
 * Sai bất kỳ điều nào ⇒ 404 (không nói tệp có tồn tại hay không). `nosniff` + `sandbox`.
 */
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const url = new URL(request.url);
  const notFound = () => new NextResponse("Không tìm thấy", { status: 404 });
  if (!verifyAssetSignature(env.authSecret, id, url.searchParams.get("exp"), url.searchParams.get("sig"), new Date())) return notFound();
  const db = await getDb();
  const meta = await getAssetMeta(db, id);
  if (!meta || meta.isTest) return notFound();
  if (meta.kind === "AD_UPLOAD") {
    if (!(await adUploadPublishable(db, meta.id))) return notFound();
  } else {
    if ((meta.kind !== "FINAL" && meta.kind !== "THUMBNAIL") || !meta.variantId) return notFound();
    const V = schema.videoScaleVariants;
    const [v] = await db.select({ id: V.id }).from(V).where(and(eq(V.id, meta.variantId), eq(V.status, "APPROVED"), eq(V.isTest, false))).limit(1);
    if (!v) return notFound();
  }
  const body = await readAssetRange(db, meta.id, 0, meta.bytes - 1);
  return new NextResponse(new Uint8Array(body), {
    status: 200,
    headers: {
      "content-type": meta.contentType,
      "content-length": String(body.length),
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox; default-src 'none'",
      "cache-control": "private, no-store",
    },
  });
}
