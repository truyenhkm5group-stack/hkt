-- ═══════════ THU HỒI PHIÊN TỪ PHÍA MÁY CHỦ ═══════════
--
-- Trước bản này, đổi mật khẩu KHÔNG làm token cũ chết. Ai cầm được cookie thì dùng tiếp tới khi
-- hết hạn — tức là việc đổi mật khẩu vì nghi lộ KHÔNG có tác dụng gì trong tối đa 7 ngày (và tới
-- 30 ngày nếu phiên được gia hạn trượt). Cột này là thứ làm cho nó có tác dụng.
--
-- ─── VÌ SAO SO VỚI `lgn` CHỨ KHÔNG PHẢI `iat` ───
--
-- Gia hạn trượt (bản #12) ký lại token và đẩy `iat` lên ở MỖI lượt GET. Nếu luật so mốc thu hồi
-- với `iat` thì một phiên vừa bị thu hồi sẽ TỰ SỐNG LẠI ở lượt gia hạn kế tiếp — tức là tính năng
-- này im lặng không hoạt động, và không có gì báo cho ai biết. `lgn` (mốc đăng nhập GỐC) đi nguyên
-- vẹn qua mọi lần gia hạn, nên nó là mốc duy nhất dùng được.
--
-- ─── CHỈ TIẾN, KHÔNG BAO GIỜ LÙI ───
--
-- Mọi đường ghi phải dùng GREATEST(giá trị hiện tại, now()). Gán thẳng `= now()` để ngỏ khả năng
-- một lượt ghi tới muộn (đồng hồ lệch, giao dịch chậm) KÉO MỐC LÙI LẠI — tức GỠ THU HỒI. Đó là lỗi
-- an ninh im lặng nhất có thể có ở đây, nên ràng buộc nằm luôn trong trigger của CSDL chứ không chỉ
-- trong TypeScript: một câu `UPDATE` gõ tay ở ops cũng không lùi được.
--
-- ─── CHỈ CỘNG THÊM ───
--
-- Cột NULL = CHƯA TỪNG THU HỒI ⇒ mọi tài khoản đang chạy giữ nguyên hành vi hôm nay. KHÔNG backfill
-- (luật 35: không đoán người cho dòng lịch sử), KHÔNG mặc định. Lùi bản = deploy lại image cũ, cột
-- đơn giản không được đọc; không mất dữ liệu, không cần migration ngược.

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "session_invalid_before" timestamp with time zone;--> statement-breakpoint

-- Luật "chỉ tiến" ở tầng CSDL. Đặt ở trigger chứ không ở CHECK vì CHECK không thấy được giá trị cũ.
CREATE OR REPLACE FUNCTION "users_session_invalid_before_monotonic"() RETURNS trigger AS $$
BEGIN
	-- Xoá mốc (về NULL) là GỠ THU HỒI — không đường ghi nào được phép làm vậy, kể cả gõ tay.
	IF NEW."session_invalid_before" IS NULL THEN
		NEW."session_invalid_before" := OLD."session_invalid_before";
	ELSIF OLD."session_invalid_before" IS NOT NULL AND NEW."session_invalid_before" < OLD."session_invalid_before" THEN
		NEW."session_invalid_before" := OLD."session_invalid_before";
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS "users_session_invalid_before_monotonic" ON "users";--> statement-breakpoint

CREATE TRIGGER "users_session_invalid_before_monotonic"
	BEFORE UPDATE OF "session_invalid_before" ON "users"
	FOR EACH ROW
	WHEN (OLD."session_invalid_before" IS DISTINCT FROM NEW."session_invalid_before")
	EXECUTE FUNCTION "users_session_invalid_before_monotonic"();
