# Rà soát an toàn & độ tin cậy — 08/09/2026

## Đã kiểm, đạt

| Hạng mục | Bằng chứng |
|---|---|
| **Không có bí mật trong kho mã** | quét toàn bộ tệp không phải `.md` theo mẫu `pk_`/`vtp_`/`gh*_`/`xox*`/`AIza`: **0 kết quả** |
| **`.env` không bị theo dõi** | chỉ có `.env.example` trong git |
| **Xác thực webhook** | thử trực tiếp trên production: token sai → **401**, không token → **401**, `GET` → 200 |
| **Che bí mật khi ghi nhật ký** | `lib/audit.ts::redactSecrets` che theo mẫu `token|secret|password|api_key|authorization|webhook|cookie|credential` |
| **Che bí mật khi in log vận hành** | ops workflow và `ops.sh` đều lọc `pk_`/`vtp_` trước khi in |
| **Xử lý lại idempotent** | sự kiện chống trùng theo (vận đơn, nguồn, trạng thái, mốc ĐVVC); webhook có `dedupe_key`; nhập tệp so ảnh chụp theo ý nghĩa |
| **Migration an toàn** | viết tay, idempotent (`IF NOT EXISTS`, `DROP … IF EXISTS`), ràng buộc mới đều `NOT VALID` nên không quét lại bảng lịch sử |
| **Job nền không chạy chồng** | `lib/sync/runner.ts` giữ danh sách job đang chạy, kèm dọn bản ghi `RUNNING` mồ côi sau khi container khởi động lại |

## Cố ý KHÔNG làm: giới hạn tần suất trên webhook

Kế hoạch có nhắc "rate limit relevant endpoints". **Không áp cho `/api/webhooks/*`**, vì:

- Viettel Post thử lại tối đa 5 lần rồi **bỏ hẳn** gói tin. Chặn một gói vì vượt ngưỡng là **mất
  chứng từ vĩnh viễn** — đúng loại thiệt hại mà cả bản Data Truth vừa rồi sinh ra để chống.
- Lưu lượng thật đo được: **~124 gói/giờ**. Xa mọi ngưỡng đáng lo.
- Điểm nhận đã có hai lớp chặn thật: bắt buộc secret, và chống trùng nên gói lặp không tạo tác dụng.

Nếu sau này cần, chỗ đúng để đặt giới hạn là **Caddy** (trước ứng dụng) với ngưỡng rộng và **trả 429
thay vì 4xx khác**, để bên gửi biết mà thử lại.

## Rủi ro còn lại — ghi nhận, chưa xử lý

1. **Khoá job nằm trong bộ nhớ tiến trình.** Đủ cho triển khai một container như hiện nay. Chạy hai
   bản ứng dụng cùng lúc thì phải đổi sang khoá cấp CSDL (`pg_advisory_lock`).
2. **Không có kế hoạch rollback tự động.** Rollback hiện là deploy lại nhánh cũ — chấp nhận được vì
   mọi migration đều cộng thêm, không phá dữ liệu, nên phiên bản cũ vẫn chạy được trên schema mới.
3. **Ops chạy bằng quyền `root` qua SSH.** Cần thiết cho `docker compose`, nhưng đồng nghĩa bất kỳ
   ai dispatch được workflow đều có toàn quyền máy chủ. Kiểm soát nằm ở quyền repo.

## Quyền và hành động thủ công

Server Actions đi qua `requireUser` / `can` trước khi chạm dữ liệu, và Next.js tự bảo vệ CSRF cho
Server Actions. Mọi hành động đổi sự thật nghiệp vụ đều ghi nhật ký sáu câu (ai · gì · trên cái gì ·
trước · sau · vì sao) — khoá bằng `tests/audit-trail.test.ts`.
