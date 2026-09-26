import { IDEA_IMAGE_MAX_EDGE, IDEA_IMAGE_QUALITY } from "@/lib/constants/ideas";

export type AnhDaThuNho = { base64: string; contentType: string; preview: string; kb: number };

/**
 * THU NHỎ ẢNH NGAY TRÊN MÁY NGƯỜI DÙNG, trước khi tải lên.
 *
 * Ảnh mẫu marketing chụp bằng điện thoại thường 3–8 MB. Lưu nguyên vào cơ sở dữ liệu thì bảng phình
 * rất nhanh và mỗi lần mở trang lại tải cả chục MB. Thu về cạnh dài tối đa `IDEA_IMAGE_MAX_EDGE`px
 * là đủ nhìn rõ bố cục, màu sắc và chữ trên ảnh mẫu.
 *
 * ĐỂ Ở ĐÂY, KHÔNG ĐỂ TRONG COMPONENT: hai màn hình cùng cần nó — form đăng ý tưởng mới và khung bổ
 * sung ảnh cho ý tưởng đã đăng. Chép sang bản thứ hai thì sớm muộn hai bên thu nhỏ theo hai kích
 * thước khác nhau, và không ai phát hiện vì cả hai đều "chạy được".
 *
 * `opts` cho màn hình cần cỡ khác (ảnh topic sản xuất cần rõ chất vải hơn — `TOPIC_IMAGE_MAX_EDGE`); bỏ
 * trống là đúng cỡ của ý tưởng như cũ.
 *
 * CHỈ CHẠY TRÊN TRÌNH DUYỆT (dùng `createImageBitmap` + canvas). Tệp này không import gì phía máy
 * chủ nên client component nhập được.
 */
export function thuNhoAnh(file: File): Promise<AnhDaThuNho> {
  return thuNhoAnhTheoCo(file, {});
}

/** Như `thuNhoAnh`, cho màn hình cần cỡ khác — tách hàm để `files.map(thuNhoAnh)` không nhận nhầm chỉ số làm tuỳ chọn. */
export async function thuNhoAnhTheoCo(file: File, opts: { maxEdge?: number; quality?: number }): Promise<AnhDaThuNho> {
  const maxEdge = opts.maxEdge ?? IDEA_IMAGE_MAX_EDGE;
  const bitmap = await createImageBitmap(file);
  const tyLe = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * tyLe));
  const h = Math.max(1, Math.round(bitmap.height * tyLe));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Trình duyệt không xử lý được ảnh này");
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();
  const dataUrl = canvas.toDataURL("image/jpeg", opts.quality ?? IDEA_IMAGE_QUALITY);
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  return { base64, contentType: "image/jpeg", preview: dataUrl, kb: Math.round((base64.length * 3) / 4 / 1024) };
}
