import type { AiMessage } from "@/lib/ai/provider";

/**
 * ẢNH ĐÍNH KÈM tin `user` CUỐI CÙNG của một yêu cầu AI (`AiRequest.images`, base64, đúng bốn kiểu ảnh cả ba nhà cung cấp
 * nhận). Chỉ dùng cho lời gọi MỘT LƯỢT (mô tả ảnh khách gửi — `lib/sales-chatbot/vision.ts`); ảnh KHÔNG vào lịch sử hội
 * thoại, nên `AiBlock` không có khối ảnh và mọi chỗ đọc / lưu hội thoại không đổi. Tệp riêng (không nằm trong
 * `lib/ai/provider.ts`) để `lib/ai/providers/openai.ts` dùng được mà không thành vòng import lúc chạy.
 */
export type AiImageMime = "image/jpeg" | "image/png" | "image/webp" | "image/gif";
export type AiImage = { mimeType: AiImageMime; data: string };

/** Vị trí tin `user` cuối cùng — nơi gắn ảnh. `-1` = không có. HÀM THUẦN. */
export function lastUserIndex(messages: readonly AiMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "user") return i;
  return -1;
}

/** Ảnh ⇒ khối ảnh Anthropic (đặt TRƯỚC chữ của tin — Anthropic khuyên ảnh đứng trước câu hỏi). HÀM THUẦN. */
export function anthropicImageBlocks(images: readonly AiImage[] | undefined) {
  return (images ?? []).map((img) => ({ type: "image" as const, source: { type: "base64" as const, media_type: img.mimeType, data: img.data } }));
}

/** Ảnh ⇒ phần nội dung OpenAI Responses (`input_image` dạng data URL, độ phân giải thấp — đủ nhận ra món hàng, rẻ). HÀM THUẦN. */
export function openAiImageParts(images: readonly AiImage[] | undefined) {
  return (images ?? []).map((img) => ({ type: "input_image" as const, image_url: `data:${img.mimeType};base64,${img.data}`, detail: "low" as const }));
}

/** Ảnh ⇒ phần `inlineData` của Gemini. HÀM THUẦN. */
export function geminiImageParts(images: readonly AiImage[] | undefined) {
  return (images ?? []).map((img) => ({ inlineData: { mimeType: img.mimeType, data: img.data } }));
}
