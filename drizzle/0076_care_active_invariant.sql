-- ═══════════ ĐÓNG ⇔ KHÔNG CÒN ĐANG MỞ — MỘT MỆNH ĐỀ, HAI CỘT KHÔNG ĐƯỢC NÓI HAI ĐIỀU ═══════════
--
-- Migration 0075 thêm cột `active` với mặc định `true` cho MỌI dòng đang có, kể cả 13 đợt mà người
-- đã bấm RESOLVED / CANCELLED từ trước (đo production 13/09/2026: 7 RESOLVED + 6 CANCELLED, tất cả
-- `active = true`). Từ đó "đã đóng" có hai nghĩa: theo `care_status` thì đóng, theo `active` thì
-- vẫn mở — và chỉ mục duy nhất từng phần `shipment_care_active_uidx` chặn không cho kiện đó mở
-- đợt mới khi hỏng lần hai.
--
-- Đây là SỬA CỜ cho đúng bất biến "trạng thái kết thúc ⇔ active = false", KHÔNG phải backfill:
-- không đoán người, không đoán kết quả. `care_outcome`, `owner_at_resolution`, `resolution` giữ
-- nguyên; `done_at` chỉ điền khi đang rỗng, bằng chính mốc cập nhật cuối của dòng — mốc đã có sẵn.
UPDATE "shipment_care"
   SET "active" = false,
       "done_at" = coalesce("done_at", "updated_at")
 WHERE "care_status" IN ('RESOLVED', 'CANCELLED')
   AND "active" = true;
