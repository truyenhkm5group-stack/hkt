-- ═══════ SỐ DƯ LUỸ KẾ 0 TRÊN GIAO DỊCH TIỀN VÀO LÀ KHÔNG THỂ CÓ ═══════
--
-- ĐO TRÊN PRODUCTION 11/09/2026: gói tin thật đầu tiên từ MB qua SePay (2.000₫ tiền vào, mã
-- FT26255929554527) mang `accumulated: 0`, trong khi tài khoản đang có ~70.420₫. SePay không lấy
-- được số dư luỹ kế của MB nên gửi 0 thay cho "không có", và ERP đã lưu 0 như một số dư ĐÃ BIẾT.
--
-- ĐÂY KHÔNG PHẢI SILENT BACKFILL. Không có số liệu nào bị bịa thêm; ngược lại, một giá trị BỊA
-- (0) đang giả làm dữ liệu thật được trả về đúng trạng thái CHƯA BIẾT. Bằng chứng không thể chối:
-- với giao dịch TIỀN VÀO, số dư sau giao dịch bắt buộc ≥ số tiền vào, nên 0 là trạng thái không
-- tồn tại được.
--
-- CỐ Ý chỉ chạm dòng `amount > 0`: với giao dịch tiền RA, số dư 0 là có thật (tài khoản bị rút cạn),
-- nên không được đụng tới. Bộ đọc gói tin đã chặn từ đầu vào (`accumulatedBalance` trong
-- `lib/integrations/bank/sepay.ts`); migration này chỉ dọn những dòng đã lỡ ghi trước khi có luật.

UPDATE "bank_transactions"
   SET "balance_after" = NULL
 WHERE "balance_after" = 0
   AND "amount" > 0;
