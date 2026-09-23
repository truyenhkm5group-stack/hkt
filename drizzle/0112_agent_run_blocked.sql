-- Lượt chạy agent có thêm trạng thái BLOCKED: "không làm được ở đây", tách khỏi FAILED và CANCELLED.
--
-- FAILED = đã làm và không ra kết quả  ⇒ đi sửa MÃ.
-- CANCELLED = bị cắt ngang từ bên ngoài ⇒ không có gì phải sửa.
-- BLOCKED = việc không thuộc môi trường của agent ⇒ đi sửa ĐỀ BÀI hoặc MÔI TRƯỜNG.
--
-- Chỉ NỚI danh sách cho phép, không đụng một dòng dữ liệu nào: mọi dòng đang có đều còn hợp lệ.
-- KHÔNG backfill (AGENTS.md mục 8.8) — không lượt chạy cũ nào được đổi nhãn, vì không ai biết
-- lượt nào trong số chúng đáng lẽ là BLOCKED.
ALTER TABLE "tech_agent_runs" DROP CONSTRAINT IF EXISTS "tech_agent_runs_status_check";
--> statement-breakpoint
ALTER TABLE "tech_agent_runs" ADD CONSTRAINT "tech_agent_runs_status_check" CHECK ("tech_agent_runs"."status" IN ('RUNNING','SUCCEEDED','FAILED','CANCELLED','BLOCKED'));
