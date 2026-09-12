-- ═══════ BA CHIỀU CỦA QUYỀN TRUY CẬP: VAI TRÒ · CHỨC DANH · PHẠM VI ═══════
--
-- Đặc tả: phần đầu `lib/constants/access-scope.ts`.
--
-- CHỈ CỘNG THÊM. Hai bảng mới, ba cột mới trên `users`, không cột nào bị xoá hay đổi kiểu, không
-- dòng dữ liệu nào đang có bị viết lại. Không bảng nghiệp vụ nào bị đụng tới.
--
-- Viết tay và idempotent (`IF NOT EXISTS`) như 0033–0069: ảnh chụp `drizzle/meta/*_snapshot.json`
-- đã cũ từ 0032 nên `drizzle-kit generate` sinh ra một bản dựng lại TOÀN BỘ lược đồ, chạy lên
-- production sẽ hỏng ngay câu lệnh đầu tiên.
--
-- ─── ĐIỀU KIỆN TIÊN QUYẾT: KHÔNG MỘT TÀI KHOẢN NÀO MẤT QUYỀN VÌ BẢN NÀY ───
--
-- `data_scope` mặc định `'ALL'` cho mọi dòng đang có. `ALL` nghĩa là "không thu hẹp gì" — đúng
-- bằng hành vi hôm nay. Thu hẹp phạm vi của một người là một quyết định chủ shop phải BẤM, không
-- phải một tác dụng phụ của việc triển khai. Một bản phân quyền mà deploy xong có người không vào
-- được màn hình của mình là một bản phân quyền hỏng, dù mô hình có đẹp tới đâu.
--
-- ─── VÌ SAO PHẠM VI CÓ RÀNG BUỘC Ở MỨC CSDL ───
--
-- Danh sách năm giá trị là một danh sách ĐÓNG. Nếu một câu `UPDATE` gõ tay nhét được chuỗi
-- `'department'` (thường) hay `'DEPT'` vào đây thì code phải chọn: coi chuỗi lạ là cấm hết (khoá
-- nhầm người) hay cho qua (lộ dữ liệu). `CHECK` ở CSDL xoá hẳn trường hợp thứ ba — kiểm tra ở
-- tầng ứng dụng thôi thì chỉ chặn được đường đi qua ứng dụng.

CREATE TABLE IF NOT EXISTS "access_roles" (
  "id"            text PRIMARY KEY NOT NULL,
  "code"          text NOT NULL,
  "name"          text NOT NULL,
  "description"   text DEFAULT '' NOT NULL,
  "base_role"     "role" DEFAULT 'VIEWER' NOT NULL,
  "permissions"   jsonb DEFAULT '[]'::jsonb NOT NULL,
  "default_scope" text DEFAULT 'ALL' NOT NULL,
  "active"        boolean DEFAULT true NOT NULL,
  "sort_order"    integer DEFAULT 100 NOT NULL,
  "created_at"    timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at"    timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "access_roles_code_unique" ON "access_roles" ("code");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "access_roles_active_idx" ON "access_roles" ("active", "sort_order");--> statement-breakpoint

-- Vai trò tuỳ chỉnh KHÔNG được lấy `ADMIN` làm nền: `ADMIN` là toàn quyền vô điều kiện, nên một
-- vai trò nền `ADMIN` biến mọi giới hạn phía trên nó thành trang trí.
DO $$ BEGIN
  ALTER TABLE "access_roles" ADD CONSTRAINT "access_roles_base_role_check" CHECK ("base_role" <> 'ADMIN');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "access_roles" ADD CONSTRAINT "access_roles_scope_check"
    CHECK ("default_scope" IN ('SELF', 'ASSIGNED', 'TEAM', 'DEPARTMENT', 'ALL'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "positions" (
  "id"            text PRIMARY KEY NOT NULL,
  "code"          text NOT NULL,
  "name"          text NOT NULL,
  "description"   text DEFAULT '' NOT NULL,
  "department_id" text,
  "active"        boolean DEFAULT true NOT NULL,
  "sort_order"    integer DEFAULT 100 NOT NULL,
  "created_at"    timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at"    timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "positions_code_unique" ON "positions" ("code");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "positions_active_idx" ON "positions" ("active", "sort_order");--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "positions" ADD CONSTRAINT "positions_department_id_departments_id_fk"
    FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "access_role_id" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "position_id" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "data_scope" text DEFAULT 'ALL' NOT NULL;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "users" ADD CONSTRAINT "users_access_role_id_access_roles_id_fk"
    FOREIGN KEY ("access_role_id") REFERENCES "access_roles"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "users" ADD CONSTRAINT "users_position_id_positions_id_fk"
    FOREIGN KEY ("position_id") REFERENCES "positions"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "users" ADD CONSTRAINT "users_data_scope_check"
    CHECK ("data_scope" IN ('SELF', 'ASSIGNED', 'TEAM', 'DEPARTMENT', 'ALL'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

-- ─── CHỨC DANH GIEO SẴN ───
--
-- Chỉ là NHÃN: không dòng nào ở đây mở thêm một quyền nào cho ai. Gieo sẵn để màn Người dùng có
-- thứ để chọn ngay, chủ shop sửa / thêm / tắt thoải mái. Gắn với phòng ban tương ứng nếu phòng đó
-- đã tồn tại — `LEFT JOIN` chứ không `INNER`, vì phòng ban là dữ liệu chủ shop đổi được.
INSERT INTO "positions" ("id", "code", "name", "description", "department_id", "sort_order")
SELECT gen_random_uuid()::text, v.code, v.name, v.description, d.id, v.sort_order
FROM (VALUES
  ('OWNER',            'Chủ shop',              'Người quyết định cuối cùng',                      'MANAGEMENT', 10),
  ('OPS_MANAGER',      'Quản lý vận hành',      'Điều phối giữa các phòng, gỡ nút thắt',           'MANAGEMENT', 20),
  ('SALES_LEAD',       'Trưởng nhóm kinh doanh','Phụ trách chốt đơn và chăm khách',                'SALES',      30),
  ('SALES_STAFF',      'Nhân viên kinh doanh',  'Chốt đơn từ tin nhắn, chăm khách, xử lý case',    'SALES',      40),
  ('LOGISTICS_STAFF',  'Nhân viên vận đơn',     'Theo dõi vận đơn, làm việc với đơn vị vận chuyển','LOGISTICS',  50),
  ('WAREHOUSE_LEAD',   'Trưởng kho',            'Phụ trách xuất nhập và kiểm đếm',                 'WAREHOUSE',  60),
  ('WAREHOUSE_STAFF',  'Nhân viên kho',         'Đóng gói, xuất hàng, kiểm đếm hàng hoàn',         'WAREHOUSE',  70),
  ('ACCOUNTANT',       'Kế toán',               'Đối soát COD, chi phí, sổ ngân hàng',             'FINANCE',    80),
  ('MARKETER',         'Nhân viên marketing',   'Quảng cáo, nội dung, hiệu quả chi tiêu',          'MARKETING',  90),
  ('HR_STAFF',         'Nhân sự',               'Tuyển dụng, chấm công, lương',                    'HR',        100)
) AS v(code, name, description, dept_code, sort_order)
LEFT JOIN "departments" d ON d."code" = v.dept_code
WHERE NOT EXISTS (SELECT 1 FROM "positions" p WHERE p."code" = v.code);
