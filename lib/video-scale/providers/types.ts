import type { ClipSeconds, VideoErrorKind, VideoProviderId, VideoResolution } from "@/lib/constants/video-scale";

/**
 * ═══════════ HỢP ĐỒNG NHÀ CUNG CẤP VIDEO ═══════════
 *
 * Luồng nghiệp vụ chỉ biết ba động từ: BẮT ĐẦU một clip (trả mã thao tác), HỎI mã thao tác, TẢI kết quả. Thêm nhà cung
 * cấp (vd Seedance) = thêm một tệp cài `VideoProvider` và một dòng ở `videoProviderFor` — không sửa hàng đợi, hậu kỳ,
 * QC hay màn hình.
 *
 * Mọi lỗi đi ra dưới dạng `ProviderError` mang LOẠI lỗi — hàng đợi quyết định thử lại hay không theo loại, không đoán
 * từ câu chữ:
 *  · `TRANSIENT` — chắc chắn CHƯA tạo gì (HTTP 429 / 5xx có phản hồi, hoặc lỗi của một lời gọi CHỈ ĐỌC) ⇒ tự thử lại.
 *  · `AMBIGUOUS` — lời gọi TẠO không có phản hồi (mất mạng, hết giờ) ⇒ có thể đã tạo và đã tính tiền ⇒ KHÔNG tự thử lại.
 *  · `PERMANENT` — nhà cung cấp từ chối (câu lệnh, ảnh, bộ lọc an toàn, khoá sai) ⇒ không thử lại.
 *  · `BLOCKED` — thiếu điều kiện phía ERP (khoá chưa khai) ⇒ đứng chờ người.
 */

/** Ảnh đầu vào — chỉ ảnh sản phẩm THẬT của shop (ranh giới 1). */
export type ClipImage = { kind: "PRODUCT_PHOTO"; bytes: Uint8Array; contentType: string };

export type ClipRequest = {
  model: string;
  prompt: string;
  negativePrompt: string;
  image: ClipImage;
  seconds: ClipSeconds;
  resolution: VideoResolution;
};

export type PollResult =
  | { state: "RUNNING" }
  | { state: "DONE"; videoUri: string }
  | { state: "FAILED"; error: string; kind: Exclude<VideoErrorKind, "AMBIGUOUS"> };

export interface VideoProvider {
  readonly id: VideoProviderId;
  /** Gửi lời gọi TẠO. Trả mã thao tác — nơi gọi PHẢI lưu ngay. */
  start(req: ClipRequest): Promise<{ ref: string }>;
  /** Hỏi một mã thao tác. CHỈ ĐỌC — lỗi mạng ở đây luôn là `TRANSIENT`. */
  poll(ref: string): Promise<PollResult>;
  /** Tải video của một thao tác đã xong. */
  download(videoUri: string): Promise<Uint8Array>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly kind: VideoErrorKind,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

/** Ranh giới 1 kiểm LÚC CHẠY: kiểu TypeScript biến mất khi chạy, một `as` ở nơi gọi là đủ để lọt. */
export function assertVideoPixelSafe(image: { kind: string; bytes: Uint8Array }): void {
  if (image.kind !== "PRODUCT_PHOTO") throw new ProviderError(`Ảnh loại "${image.kind}" không được gửi sang máy sinh video — chỉ ảnh sản phẩm thật của shop.`, "PERMANENT");
  if (!image.bytes.byteLength) throw new ProviderError("Ảnh gốc rỗng.", "PERMANENT");
}

/** Phân loại một phản hồi HTTP không thành công. Hàm THUẦN. */
export function httpErrorKind(status: number): "TRANSIENT" | "PERMANENT" {
  return status === 408 || status === 429 || status >= 500 ? "TRANSIENT" : "PERMANENT";
}
