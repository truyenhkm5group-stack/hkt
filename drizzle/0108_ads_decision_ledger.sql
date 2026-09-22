-- ═══════════ SỔ QUYẾT ĐỊNH QUẢNG CÁO — TRÍ NHỚ CỦA PHÒNG MARKETING ═══════════
--
-- Đặc tả: `docs/marketing-ai-department.md` · luật và ngưỡng: `lib/constants/marketing-decision-ledger.ts`.
--
-- ─── VÌ SAO CẦN MỘT BẢNG, TRONG KHI BẢNG QUYẾT ĐỊNH TRÊN `/ads` ĐÃ CHẠY TỐT ───
--
-- `lib/queries/ads-decision.ts` tính lại từ đầu mỗi lần ai đó mở trang. Nó trả lời rất tốt câu
-- "lúc này nên làm gì", và cố ý không trả lời ba câu còn lại: hôm qua nó khuyên gì · sau lời khuyên
-- có ai làm gì không · làm rồi thì kết quả ra sao.
--
-- Với NGƯỜI, ba câu ấy là tiện nghi. Với một AGENT thì chúng là điều kiện tồn tại: một cỗ máy không
-- có trí nhớ sẽ đề nghị lại đúng thứ vừa bị từ chối, mỗi ngày, mãi mãi. Phòng Tech đã cắn đúng lớp
-- lỗi này — dây chuyền chạy được nửa ĐI rồi đứng, vì việc không bao giờ biết PR của nó đã mở.
--
-- ─── BẢNG NÀY KHÔNG SINH RA MỘT CON SỐ NÀO ───
--
-- Nó CHÉP LẠI đầu ra của `decideAction()`. Không có công thức thứ hai, không có ngưỡng thứ hai, và
-- KHÔNG báo cáo tiền nào được đọc từ đây — doanh thu/lợi nhuận vẫn tính ở đường cũ. Vì vậy bảng này
-- không thể làm lệch một con số tài chính nào, kể cả khi job ghi sổ hỏng.
--
-- ─── KHOÁ TỰ NHIÊN: (ngày quyết định, chiều, mục) ───
--
-- Job ghi sổ chạy nhiều lượt mỗi ngày để không bỏ lỡ một ngày nào khi máy chủ khởi động lại. Khoá
-- duy nhất biến mọi lượt sau thành CẬP NHẬT đúng dòng ấy. Đây là một BẢO ĐẢM ở tầng dữ liệu, không
-- phải một mệnh đề `where not exists` trong mã — mệnh đề ấy luôn có cửa sổ đua giữa lúc đọc và ghi.
--
-- ─── THUẦN BỔ SUNG, KHÔNG BACKFILL ───
--
-- Không câu lệnh nào đụng tới bảng đang chạy, và sổ bắt đầu RỖNG. Dựng lại quá khứ là bất khả về
-- nguyên tắc: kết luận của ngày 12/09 phải tính trên dữ liệu NHƯ NÓ CÓ ngày 12/09, mà đơn hôm ấy
-- còn treo nay đã ngã ngũ. Một chuỗi "đã giữ 30 ngày" dựng ngược là một lời nói dối có vẻ thuyết
-- phục (AGENTS.md mục 8.8 và mục 35).

CREATE TABLE IF NOT EXISTS "ads_decision_ledger" (
  "id" text PRIMARY KEY NOT NULL,
  "decision_day" text NOT NULL,
  "dimension" text NOT NULL,
  "entity_key" text NOT NULL,
  "entity_name" text DEFAULT '' NOT NULL,
  "action" text NOT NULL,
  "action_class" text NOT NULL,
  "reason" text DEFAULT '' NOT NULL,
  "period_from" text NOT NULL,
  "period_to" text NOT NULL,
  "rule_version" integer NOT NULL,
  "rule_snapshot" jsonb NOT NULL,
  "spend_known" boolean NOT NULL,
  "spend" integer DEFAULT 0 NOT NULL,
  "booked_orders" integer DEFAULT 0 NOT NULL,
  "delivered_orders" integer DEFAULT 0 NOT NULL,
  "returned_orders" integer DEFAULT 0 NOT NULL,
  "open_orders" integer DEFAULT 0 NOT NULL,
  "delivered_revenue" integer DEFAULT 0 NOT NULL,
  "profit_after_ads" integer DEFAULT 0 NOT NULL,
  "success_rate" double precision,
  "maturity" double precision,
  "headroom" double precision,
  "break_even_booked_roas" double precision,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "ads_decision_ledger_class_check" CHECK ("action_class" IN ('ACTIONABLE', 'NO_CHANGE', 'NO_OPINION')),
  -- Ngày phải là ngày. Một chuỗi lạ ở đây làm mọi phép so chuỗi theo thứ tự nói sai mà không gì đỏ.
  CONSTRAINT "ads_decision_ledger_day_format_check" CHECK ("decision_day" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')
);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "ads_decision_ledger_day_uq" ON "ads_decision_ledger" ("decision_day","dimension","entity_key");--> statement-breakpoint

-- Đường truy vấn nóng nhất: đọc chuỗi của MỘT mục để tính độ bền.
CREATE INDEX IF NOT EXISTS "ads_decision_ledger_entity_idx" ON "ads_decision_ledger" ("dimension","entity_key","decision_day");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "ads_decision_ledger_day_idx" ON "ads_decision_ledger" ("decision_day","action_class");
