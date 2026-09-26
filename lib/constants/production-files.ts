/**
 * ═══════════ ẢNH / VIDEO ĐÍNH KÈM TOPIC SẢN XUẤT ═══════════
 *
 * Chủ shop 26/09/2026: topic sản xuất phải đính kèm được ảnh, video. Tệp THUẦN — client import được.
 *
 * Tệp nằm trong CSDL (`production_topic_files` + khúc `production_topic_file_chunks`), nên mỗi con số dưới
 * đây là một quyết định về DUNG LƯỢNG CSDL và BẢN SAO LƯU hằng ngày, không chỉ về giao diện:
 *
 *  · Ảnh được thu nhỏ NGAY TRÊN MÁY người dùng (cạnh dài `TOPIC_IMAGE_MAX_EDGE`, JPEG) — ảnh điện thoại
 *    3–8 MB còn vài trăm KB mà vẫn đọc rõ chất vải, đường may.
 *  · Video KHÔNG nén lại được trên trình duyệt ⇒ trần `TOPIC_VIDEO_MAX_BYTES`. Video dài hơn thì dán link
 *    (Drive / YouTube) vào lượt trao đổi như trước.
 */

/** Một khúc nội dung. 2 MB: thân Server Action (trần 8 MB) còn dư chỗ, và phát video theo `Range` đọc ít. */
export const TOPIC_FILE_CHUNK_BYTES = 2 * 1024 * 1024;

export const TOPIC_IMAGE_MAX_EDGE = 2000;
export const TOPIC_IMAGE_QUALITY = 0.85;
/** Trần ảnh SAU khi thu nhỏ — chỉ để chặn ảnh bất thường, ảnh thật nằm dưới rất xa. */
export const TOPIC_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
export const TOPIC_VIDEO_MAX_BYTES = 50 * 1024 * 1024;
/** Tối đa tệp đã tải xong trên một topic. */
export const TOPIC_FILES_MAX_PER_TOPIC = 40;
/** Lượt tải dở quá lâu (đóng tab giữa chừng) thì dọn khúc — không hiện ở đâu cả nên không ai khác dọn. */
export const TOPIC_FILE_STALE_UPLOAD_HOURS = 6;

export const TOPIC_FILE_KINDS = ["IMAGE", "VIDEO"] as const;
export type TopicFileKind = (typeof TOPIC_FILE_KINDS)[number];
export const TOPIC_FILE_KIND_LABEL: Record<TopicFileKind, string> = { IMAGE: "Ảnh", VIDEO: "Video" };

/**
 * DANH SÁCH ĐÓNG kiểu nội dung. Máy chủ phục vụ tệp với ĐÚNG kiểu đã lưu, nên nhận một kiểu tuỳ ý
 * (`text/html`, `image/svg+xml`) là mở cửa cho một trang chạy mã trên tên miền ERP.
 */
export const TOPIC_FILE_TYPES: Record<string, TopicFileKind> = {
  "image/jpeg": "IMAGE",
  "image/png": "IMAGE",
  "image/webp": "IMAGE",
  "video/mp4": "VIDEO",
  "video/quicktime": "VIDEO",
  "video/webm": "VIDEO",
};

/** Chuỗi `accept` cho ô chọn tệp. Ảnh nhận mọi kiểu vì trình duyệt sẽ chuyển sang JPEG trước khi tải. */
export const TOPIC_FILE_ACCEPT = "image/*,video/mp4,video/quicktime,video/webm";

export function topicFileKindOf(contentType: string): TopicFileKind | null {
  return TOPIC_FILE_TYPES[contentType.toLowerCase()] ?? null;
}

export function topicFileMaxBytes(kind: TopicFileKind): number {
  return kind === "VIDEO" ? TOPIC_VIDEO_MAX_BYTES : TOPIC_IMAGE_MAX_BYTES;
}

export function topicFileChunkCount(bytes: number): number {
  return Math.max(1, Math.ceil(bytes / TOPIC_FILE_CHUNK_BYTES));
}

/** Kiểm một lượt xin tải lên: hợp lệ thì trả loại tệp + số khúc, không thì câu lỗi đọc được. */
export function checkTopicFileUpload(input: { contentType: string; bytes: number; readyCount: number }): { ok: true; kind: TopicFileKind; chunkCount: number } | { ok: false; error: string } {
  const kind = topicFileKindOf(input.contentType);
  if (!kind) return { ok: false, error: `Không nhận kiểu tệp “${input.contentType || "không rõ"}” — chỉ ảnh (JPEG/PNG/WebP) và video (MP4/MOV/WebM)` };
  if (!Number.isInteger(input.bytes) || input.bytes <= 0) return { ok: false, error: "Tệp rỗng" };
  const max = topicFileMaxBytes(kind);
  if (input.bytes > max) return { ok: false, error: `${TOPIC_FILE_KIND_LABEL[kind]} ${formatMb(input.bytes)} vượt trần ${formatMb(max)}${kind === "VIDEO" ? " — video dài hơn thì dán link Drive / YouTube vào lượt trao đổi" : ""}` };
  if (input.readyCount >= TOPIC_FILES_MAX_PER_TOPIC) return { ok: false, error: `Topic đã có ${TOPIC_FILES_MAX_PER_TOPIC} tệp — gỡ bớt tệp cũ trước khi thêm` };
  return { ok: true, kind, chunkCount: topicFileChunkCount(input.bytes) };
}

/**
 * Cỡ tệp để người đọc: dưới 1 MB in KB (ảnh đã thu nhỏ thường vài trăm KB — in "0 MB" là nói sai). MB làm
 * tròn LÊN một chữ số thập phân, để tệp vượt trần một chút không in ra đúng bằng con số trần.
 */
export function formatMb(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.ceil(bytes / 1024)).toLocaleString("vi-VN")} KB`;
  return `${(Math.ceil((bytes / 1024 / 1024) * 10) / 10).toLocaleString("vi-VN", { maximumFractionDigits: 1 })} MB`;
}

/**
 * Đọc header `Range: bytes=a-b` (một khoảng — trình duyệt phát video chỉ xin một khoảng mỗi lượt).
 * `null` = không có / không đọc được ⇒ trả cả tệp; `"UNSATISFIABLE"` ⇒ 416.
 */
export function parseByteRange(header: string | null, size: number): { start: number; end: number } | "UNSATISFIABLE" | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  let start: number;
  let end: number;
  if (m[1] === "") {
    // `bytes=-N` — N byte CUỐI.
    const n = Number(m[2]);
    if (n <= 0) return "UNSATISFIABLE";
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || start > end) return "UNSATISFIABLE";
  return { start, end };
}

/** Khúc nào chứa byte `start`…`end` (bao gồm hai đầu). */
export function chunkSpan(start: number, end: number): { first: number; last: number } {
  return { first: Math.floor(start / TOPIC_FILE_CHUNK_BYTES), last: Math.floor(end / TOPIC_FILE_CHUNK_BYTES) };
}
