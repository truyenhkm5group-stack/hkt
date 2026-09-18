-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- BẢN CHẠY THỬ ĐANG XÁC THỰC BẰNG CÁI GÌ — và có tài khoản nào để đăng nhập không.
--
-- Chạy: Actions → "Vận hành ERP trên VPS" → ai-staging-sql → arg = ai-staging-auth-check.sql
--
-- TUYỆT ĐỐI KHÔNG IN: `password_hash`, khoá ký phiên, token, bất cứ bí mật nào. Kho mã là kho
-- CÔNG KHAI và log Actions đọc được. Ở đây chỉ in: có tồn tại không · vai trò · còn hiệu lực không.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

\echo '=== 1. CÓ BAO NHIÊU TÀI KHOẢN TRONG CSDL BẢN CHẠY THỬ ==='
select count(*)::int                                          as tong_tai_khoan,
       count(*) filter (where active)::int                    as dang_bat,
       count(*) filter (where role::text = 'ADMIN')::int       as quan_tri,
       count(*) filter (where last_login_at is not null)::int as da_tung_dang_nhap
from users;

\echo ''
\echo '=== 2. TỪNG TÀI KHOẢN (KHÔNG in mật khẩu, không in băm) ==='
-- `co_mat_khau` chỉ nói CÓ hay KHÔNG có chuỗi băm, không nói chuỗi ấy là gì.
select email,
       name,
       role::text                                     as vai_tro,
       active                                         as con_hieu_luc,
       (password_hash is not null and password_hash <> '') as co_mat_khau,
       coalesce(jsonb_array_length(permissions), 0)::int as so_quyen_rieng,
       (permissions @> '["ai:send"]'::jsonb)            as co_quyen_ai_send_rieng,
       coalesce(data_scope, '')                        as pham_vi,
       created_at,
       last_login_at
from users
order by created_at
limit 50;

\echo ''
\echo '=== 3. MẪU QUYỀN VAI TRÒ CÓ BỊ SỬA KHÔNG (settings.auth.rolePermissions) ==='
-- Chỉ in ĐỘ DÀI và các vai trò có mặt; không in nội dung để tránh in nhầm thứ khác trong settings.
select key,
       length(value)::int as do_dai,
       updated_at
from settings
where key in ('auth.rolePermissions', 'auth.userPermissionSnapshots')
order by key;

\echo ''
\echo '=== 4. VAI TRÒ NÀO ĐANG ĐƯỢC DÙNG ==='
select role::text as vai_tro, count(*)::int as so_nguoi, count(*) filter (where active)::int as dang_bat
from users group by 1 order by 2 desc;

\echo ''
\echo '=== 5. LẦN ĐĂNG NHẬP GẦN NHẤT ĐÃ GHI VÀO SỔ VẾT ==='
-- Sổ vết cho biết đã từng có ai đăng nhập được vào bản chạy thử chưa.
select action, count(*)::int as so_lan, max(created_at) as gan_nhat
from audit_logs
where action in ('LOGIN', 'LOGOUT')
group by 1 order by 1;
