import { z } from "zod";

/**
 * Quản trị thu hồi phiên của NGƯỜI KHÁC — lý do là BẮT BUỘC.
 *
 * Chặn ở đây là lớp thứ nhất; `applySessionRevocation()` chặn lại lần nữa ở tầng dịch vụ, để một
 * đường gọi mới không đi qua zod vẫn gặp cùng một luật. Hai lớp cho cùng một câu, vì bỏ sót ở đây
 * thì ba tháng sau không ai giải thích được vì sao một người bị đá ra khỏi hệ thống.
 */
export const revokeSessionsSchema = z.object({
  id: z.string().min(1),
  reason: z.string().trim().min(5, "Nêu lý do thu hồi (tối thiểu 5 ký tự)").max(500, "Lý do tối đa 500 ký tự"),
});
export type RevokeSessionsInput = z.infer<typeof revokeSessionsSchema>;
