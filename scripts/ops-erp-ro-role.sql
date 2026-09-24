-- ═══════════ ROLE CHỈ ĐỌC `erp_ro` CHO THAO TÁC ops `db-query` ═══════════
--
-- Chạy bằng role CHỦ (`erp`, superuser của container) NGAY TRƯỚC mỗi lượt `db-query`. Idempotent:
-- chạy lại bao nhiêu lần cũng ra cùng một trạng thái, nên không cần migration và không cần ai
-- "nhớ tạo role" trên máy chủ mới.
--
-- VÌ SAO KHÔNG CÒN TIN `default_transaction_read_only`:
--   Bản cũ đặt `PGOPTIONS='-c default_transaction_read_only=on'` ở shell MÁY CHỦ rồi gọi
--   `docker compose exec db psql -U erp`. `docker compose exec` KHÔNG chuyển biến môi trường của
--   máy chủ vào container (phải có `-e`), nên biến ấy chưa bao giờ tới psql — và `erp` là
--   SUPERUSER. Kể cả khi tới được, một câu `SET default_transaction_read_only = off;` ở đầu ô
--   "arg" là tắt được nó: đó là một GUC người dùng tự đặt lại được.
--
-- HÀNG RÀO THẬT LÀ QUYỀN, KHÔNG PHẢI CỜ:
--   · `erp_ro` KHÔNG có quyền INSERT/UPDATE/DELETE/TRUNCATE trên bảng nào, không CREATE ở schema
--     nào. `SET default_transaction_read_only = off; INSERT …` vẫn chết vì "permission denied".
--   · Cờ chỉ-đọc + trần thời gian vẫn đặt ở mức ROLE — lớp thứ hai, và là mặc định an toàn.
--
-- VÌ SAO KHÔNG DÙNG `pg_read_all_data`:
--   Đã đo trên Postgres thật (PGlite 0.5.8 = PostgreSQL 18, 24/09/2026): role mang
--   `pg_read_all_data` đọc được `pg_authid.rolpassword` — tức bản băm SCRAM mật khẩu của `erp`.
--   Role chỉ cần đọc DỮ LIỆU NGHIỆP VỤ, nên nó nhận SELECT trên từng schema của ứng dụng, không
--   hơn. `tests/ops-log-leak.test.ts` chạy chính tệp này trên PGlite và khẳng định cả hai điều.
--
-- XÁC THỰC: `PASSWORD NULL` ⇒ không đăng nhập được qua TCP (pg_hba của ảnh postgres chính thức
-- đòi scram-sha-256 cho `host`). Chỉ vào được qua socket CỤC BỘ TRONG container `db`
-- (`local all all trust` — cùng giả định `scripts/install-vps.sh` đã dựa vào cho `ALTER USER`).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_ro') THEN
    CREATE ROLE erp_ro LOGIN;
  END IF;
END
$$;

ALTER ROLE erp_ro WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT
  CONNECTION LIMIT 3 PASSWORD NULL;

-- Gỡ mọi role dựng sẵn có thể mở đường ghi / đọc tệp / chạy lệnh trên máy chủ, kể cả khi ai đó đã
-- lỡ cấp tay. REVOKE một quyền chưa từng cấp chỉ là NO-OP, không phải lỗi.
REVOKE pg_read_all_data, pg_write_all_data, pg_execute_server_program, pg_read_server_files,
  pg_write_server_files, pg_signal_backend FROM erp_ro;

ALTER ROLE erp_ro SET default_transaction_read_only = on;
ALTER ROLE erp_ro SET statement_timeout = '60s';
ALTER ROLE erp_ro SET idle_in_transaction_session_timeout = '60s';

-- SELECT trên MỌI schema của ứng dụng (public + drizzle hôm nay), dò theo danh mục chứ không liệt
-- kê tay: schema mới thêm tháng sau tự vào, không ai phải nhớ sửa tệp này. Bảng tạo SAU lượt này
-- được phủ bởi DEFAULT PRIVILEGES — và dù sao lượt `db-query` kế tiếp cũng cấp lại.
DO $$
DECLARE s text;
BEGIN
  FOR s IN
    SELECT nspname FROM pg_namespace
    WHERE nspname NOT LIKE 'pg\_%' AND nspname <> 'information_schema'
  LOOP
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO erp_ro', s);
    EXECUTE format('REVOKE CREATE ON SCHEMA %I FROM erp_ro', s);
    EXECUTE format('GRANT SELECT ON ALL TABLES IN SCHEMA %I TO erp_ro', s);
    EXECUTE format('GRANT SELECT ON ALL SEQUENCES IN SCHEMA %I TO erp_ro', s);
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I GRANT SELECT ON TABLES TO erp_ro', current_user, s);
  END LOOP;
END
$$;
