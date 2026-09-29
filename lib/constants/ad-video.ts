import { VIDEO_ASSET_CHUNK_BYTES, VIDEO_SCALE_HARD_LIMITS } from "@/lib/constants/video-scale";

/**
 * ═══════════ VIDEO TỰ TẢI LÊN ⇒ ĐĂNG CAMP (chủ shop 29/09/2026) ═══════════
 *
 * "ảnh/video tự tải lên sẽ mix với content, tiêu đề do AI tạo để tạo thành 1 bài post hoàn chỉnh". Video đi vào kho tệp của
 * Video Scale (`video_scale_assets`, loại `AD_UPLOAD`) — cùng trần một tệp / tổng, cùng khúc 2 MB — vì máy chủ chỉ nhận ≤ 8 MB
 * mỗi lượt gọi. Ảnh bìa là MỘT khung hình người chọn ở trình duyệt, lưu như ảnh mẫu tự làm: AI viết content nhìn ảnh ấy, và
 * Facebook bắt buộc `video_data` có ảnh bìa.
 *
 *  · `contentTypes` — hai định dạng Facebook nhận chắc chắn cho quảng cáo (mp4 · mov). Định dạng khác: đổi ở máy trước.
 *  · `maxBytes` — trần một tệp của kho (60 MB); `chunkBytes` — cỡ khúc của kho.
 *  · `staleHours` — lượt tải dở (đóng tab giữa chừng) quá từng ấy giờ bị dọn ở lượt xin chỗ kế tiếp.
 *  · `waitTries` × `waitMs` — lượt bấm "Đăng camp" chờ Facebook xử lý video tối đa bấy nhiêu; chưa xong thì dừng ở câu
 *    "đang xử lý — bấm lại sau ít phút" (video KHÔNG tải lại, chưa tạo camp nào).
 */
export const AD_VIDEO_UPLOAD = {
  contentTypes: ["video/mp4", "video/quicktime"] as readonly string[],
  maxBytes: VIDEO_SCALE_HARD_LIMITS.maxAssetBytes,
  chunkBytes: VIDEO_ASSET_CHUNK_BYTES,
  staleHours: 6,
  waitTries: 6,
  waitMs: 5_000,
} as const;

/** Chuỗi `accept` của ô chọn tệp: ảnh như cũ + hai định dạng video. */
export const AD_MEDIA_ACCEPT = `image/png,image/jpeg,image/webp,${AD_VIDEO_UPLOAD.contentTypes.join(",")}`;

/** Kiểm kiểu + cỡ TRƯỚC khi xin chỗ — hàm THUẦN, dùng ở cả trình duyệt lẫn máy chủ. */
export function checkAdVideo(input: { contentType: string; bytes: number }): { ok: true; chunkCount: number } | { ok: false; error: string } {
  const type = input.contentType.toLowerCase();
  if (!AD_VIDEO_UPLOAD.contentTypes.includes(type)) return { ok: false, error: "Video phải là MP4 hoặc MOV." };
  if (!Number.isInteger(input.bytes) || input.bytes <= 0) return { ok: false, error: "Tệp video rỗng." };
  if (input.bytes > AD_VIDEO_UPLOAD.maxBytes) return { ok: false, error: `Video ${(input.bytes / 1048576).toFixed(1)} MB vượt trần ${AD_VIDEO_UPLOAD.maxBytes / 1048576} MB — nén lại rồi tải.` };
  return { ok: true, chunkCount: Math.ceil(input.bytes / AD_VIDEO_UPLOAD.chunkBytes) };
}

/** Cỡ ĐÚNG của khúc `seq` — mọi khúc đủ cỡ trừ khúc cuối. Hàm THUẦN. */
export function adVideoChunkBytes(fileBytes: number, chunkCount: number, seq: number): number {
  return seq < chunkCount - 1 ? AD_VIDEO_UPLOAD.chunkBytes : fileBytes - AD_VIDEO_UPLOAD.chunkBytes * (chunkCount - 1);
}
