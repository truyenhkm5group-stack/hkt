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
 * CHỈ CHẠY TRÊN TRÌNH DUYỆT (dùng `createImageBitmap` + canvas). Tệp này không import gì phía máy
 * chủ nên client component nhập được.
 */
export async function thuNhoAnh(file: File): Promise<AnhDaThuNho> {
  const bitmap = await createImageBitmap(file);
  const tyLe = Math.min(1, IDEA_IMAGE_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * tyLe));
  const h = Math.max(1, Math.round(bitmap.height * tyLe));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Trình duyệt không xử lý được ảnh này");
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();
  const dataUrl = canvas.toDataURL("image/jpeg", IDEA_IMAGE_QUALITY);
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  return { base64, contentType: "image/jpeg", preview: dataUrl, kb: Math.round((base64.length * 3) / 4 / 1024) };
}
