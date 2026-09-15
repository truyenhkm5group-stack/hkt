import { z } from "zod";
import { PROMISED_MAX_DAYS_AHEAD, PROMISED_MAX_DAYS_BEHIND } from "@/lib/constants/promised-delivery";
import { todayVN, addDays } from "@/lib/format";

/**
 * Lược đồ ở tệp riêng vì tệp `"use server"` KHÔNG được xuất hằng số.
 *
 * ─── NHẬN NGÀY THEO LỊCH, KHÔNG NHẬN MỐC ───
 *
 * Client gửi `YYYY-MM-DD` — đúng thứ người gõ vào ô ngày. Việc đổi nó thành một mốc thật (cuối ngày
 * giờ VN) là việc của MÁY CHỦ. Nhận một mốc ISO từ client thì máy khách nào ở múi giờ khác sẽ gửi
 * một mốc lệch nửa ngày, và lời hẹn "ngày 20" thành "ngày 19" mà không ai thấy.
 *
 * CỐ Ý không có trường nào cho người ghi: tên và khoá do máy chủ đọc từ phiên đăng nhập.
 */
export const promisedDeliveryInput = z.object({
  orderId: z.string().min(1),
  /** Ngày khách hẹn, theo lịch Việt Nam. */
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Ngày phải có dạng YYYY-MM-DD")
    .refine((d) => d >= addDays(todayVN(), -PROMISED_MAX_DAYS_BEHIND), {
      message: `Không ghi lùi quá ${PROMISED_MAX_DAYS_BEHIND} ngày — lời hẹn cũ hơn thế không còn là việc phải làm`,
    })
    .refine((d) => d <= addDays(todayVN(), PROMISED_MAX_DAYS_AHEAD), {
      message: `Không hẹn xa quá ${PROMISED_MAX_DAYS_AHEAD} ngày — xa hơn thế gần như chắc chắn là gõ nhầm năm`,
    }),
  /** Khách nói gì khi xin hẹn. Bắt buộc: một lời hẹn không có lý do thì người sau không kiểm được. */
  note: z.string().trim().min(3, "Ghi lại khách nói gì — một ngày hẹn không có lý do thì không ai dám tin").max(500),
});

export const promisedDeliveryClear = z.object({
  orderId: z.string().min(1),
  reason: z.string().trim().min(3, "Nói rõ vì sao bỏ lời hẹn — xoá im lặng thì người sau không biết đã có hẹn").max(500),
});
