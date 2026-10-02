# Hạ tầng cho nhiều tổ chức — từ 3 lên 100 lên 1.000 (Vertical SaaS Factory)

> Viết 02/10/2026, đọc từ mã nguồn của `main` (14c563f9). Số đo production lấy từ tài liệu sẵn có, chỉ ghi lại, không đo mới.
> Mục tiêu kinh doanh: khoảng 1.000 tổ chức khách × 499k–1,99tr mỗi tháng. Tài liệu này trả lời hai câu: cái gì gãy trước,
> và mỗi ngưỡng cần quyết định gì.

## 1. Hiện trạng

| Thứ | Giá trị | Nguồn |
|---|---|---|
| Máy | VPS 2 vCPU · 2 GB RAM · 40 GB đĩa. Postgres, app, scheduler, chatbot, Caddy cùng một máy | `docs/TRIEN-KHAI-VPS.md:9` |
| Tải đo được | load 3,77; `erp-db` 107% CPU; còn 390 MB RAM trống (23/09) | `TECH-9…md:29-32` |
| Mô hình tổ chức | SILO: mỗi tổ chức một CSDL Postgres `erp_org_<mã>` trên CÙNG một cụm | `db/index.ts`, `lib/platform/provision.ts` |
| Bể kết nối | Nhà `max 5`. Mỗi tổ chức một bể `max 2`; bể không bị gỡ nhưng `pg` tự đóng kết nối nhàn rỗi sau 10 giây ⇒ tổ chức im lặng giữ **0** kết nối. Postgres `max_connections` mặc định 100 | `db/index.ts:111, :302`; `docker-compose.prod.yml` |
| Migration tổ chức | **Lười**: chạy khi tiến trình mở CSDL tổ chức lần đầu, nằm trong request / job đầu tiên sau deploy | `db/index.ts:304-306` |
| Lịch job cho tổ chức khách | 4 job tự động chạy **tuần tự từng tổ chức một**, khoảng 58 lời gọi / tổ chức / giờ; nhịp trùng thì bỏ lượt | `scripts/scheduler-fanout.mjs`, `scheduler.mjs` |
| Sao lưu tổ chức | Mỗi giờ: `pg_dump` + 3 lời gọi Drive cho **mọi** CSDL `erp_org_*`, tuần tự, kể cả tổ chức đã đình chỉ. Diễn tập khôi phục 1 tổ chức / tuần | `scripts/erp-backup.sh:937-1040` |
| Đệm trong tiến trình | `memo` dùng chung cho mọi tổ chức, không trần kích thước. `clearMemo()` xoá đệm của **mọi** tổ chức. Nhiều Map theo tổ chức không bao giờ dọn khoá | `lib/cache.ts`, `db/index.ts:16` |

## 2. Cái gì gãy trước — theo số

| # | Giới hạn | Gãy khi | Triệu chứng |
|---|---|---|---|
| 1 | CPU / RAM của máy 2 nhân | **đã sát giới hạn** chỉ với tổ chức nhà | trang chậm, job trễ |
| 2 | Diễn tập khôi phục 1 tổ chức / tuần | **từ tổ chức thứ 6** (thẻ vàng sau 35 ngày) | không biết bản sao của khách có khôi phục được không |
| 3 | Hàng đợi lịch tuần tự | khoảng **60–250 tổ chức đang chạy** (0,25–1 giây mỗi lời gọi) | luật tự động / nhắc tin / gửi lại tin bị trễ hàng giờ |
| 4 | Kết nối Postgres (100) | khoảng **15 tổ chức** (ước tính trong tài liệu) đến **46 tổ chức** cùng truy vấn MỘT LÚC — giới hạn đi theo độ đồng thời, không theo tổng số tổ chức | «too many clients», chờ 15 giây rồi lỗi |
| 5 | Sao lưu mỗi giờ tuần tự | khi một vòng vượt 60 phút, lượt kế tiếp bị bỏ ⇒ RPO gấp đôi | khách mất tới 2 giờ dữ liệu khi sự cố |
| 6 | Đĩa 40 GB | khoảng **1.000 tổ chức nhỏ**: riêng bản sao giờ tại máy đã khoảng 35 GB | đĩa đầy ⇒ Postgres dừng |
| 7 | Deploy | mọi tổ chức migrate lười ⇒ request đầu tiên của mỗi khách sau deploy chịu migration; lỗi migration của một tổ chức chỉ lộ khi có người chạm | khách thấy lỗi trước người vận hành |

## 3. Kế hoạch theo ngưỡng

### Ngưỡng 0 — trước khi mở bán rộng (≤ 5 tổ chức): sửa trong mã, KHÔNG tốn tiền

| Việc | Vì sao | Rủi ro |
|---|---|---|
| B. **Migrate mọi tổ chức ngay sau deploy** — **ĐÃ LÀM**: `scripts/verify-migrations.ts` (bước kiểm của deploy) mở + migrate + đối chiếu sổ cho mọi tổ chức khách `ACTIVE`, in tên tổ chức hỏng, mã thoát 1 | khách không chịu migration trong request; lỗi lộ ra cho người vận hành trước | thấp |
| D. **Sao lưu giờ chỉ cho tổ chức `ACTIVE`**; diễn tập xoay vòng nhiều tổ chức mỗi tuần (trần thời gian, không trần số) | giảm việc thừa; đủ vòng diễn tập ≤ 35 ngày tới khoảng 20 tổ chức | thấp, nhưng chạm script ops ⇒ chạy thử trước |
| E. **Lịch tổ chức khách chạy song song có trần** (vd 3 tổ chức một lúc), thay cho tuần tự hoàn toàn | gấp khoảng 3 sức chứa của hàng đợi | **đổi cách scheduler chạy ⇒ chủ shop duyệt (AGENTS.md §7)** |

### Ngưỡng 1 — khoảng 15–30 tổ chức (khoảng 15–30 triệu MRR)

- **Tách máy CSDL** khỏi máy app, hoặc nâng VPS. Postgres có RAM riêng, `shared_buffers` khai tường minh, giới hạn RAM cho từng container.
- **PgBouncer** chế độ transaction trước Postgres, để số kết nối thật không còn tăng theo số bể. Cần kiểm lại mọi chỗ dùng
  khoá tư vấn mức phiên (`pg_advisory_lock` của migration), vì khoá mức phiên không đi qua chế độ transaction.
- Scheduler tách thành tiến trình worker riêng.
- **Quyết định của chủ shop:** nhà cung cấp và cấu hình máy. Giá máy **chưa tra** ở tài liệu này, cần báo giá thật.

### Ngưỡng 2 — khoảng 100–200 tổ chức

- **Nhiều cụm Postgres, mỗi cụm khoảng 100–150 tổ chức.** Đây vẫn là SILO, chỉ thêm cột «cụm» cho tổ chức. `getDb()` chọn
  URL theo cụm. Không viết lại truy vấn nào.
  - Lý do không chuyển sang schema-per-tenant: hướng đó đang bị chặn vì 48 migration ghi cứng `"public".` (xem
    `current-state-audit.md:55`).
- **Sao lưu chuyển sang PITR theo cụm** (đã có cho CSDL nhà), thay cho `pg_dump` từng tổ chức mỗi giờ. Dump từng tổ chức chỉ
  còn để xuất dữ liệu cho khách.
- App chạy 2 instance trở lên sau Caddy.

### Ngưỡng 3 — khoảng 1.000 tổ chức

- Khoảng 7–10 cụm Postgres, hoặc dịch vụ Postgres được quản lý.
- Vận hành theo đội:
  - cấp tổ chức tự động có chọn cụm;
  - theo dõi theo cụm;
  - khách lớn có thể có cụm riêng, bán như gói cao hơn.
- Doanh thu ở mức này (khoảng 0,5–1 tỷ MRR) trả được hạ tầng dư thừa. Cái khó là **vận hành và hỗ trợ khách**, không phải
  chi phí máy.

## 4. Quyết định cần chủ shop

1. **Duyệt việc E** (lịch tổ chức khách chạy song song có trần): đổi cách scheduler chạy.
2. **Thời điểm và ngân sách** tách máy CSDL / nâng VPS. Đề xuất làm trước khi có khoảng 15 khách trả tiền, không đợi tới
   lúc khách kêu chậm.
3. **Postgres tự quản hay thuê dịch vụ được quản lý** từ ngưỡng 2.

Việc D không đổi hành vi nghiệp vụ, không tốn tiền; chạm script sao lưu trên VPS ⇒ làm thành PR riêng và chạy thử trên VPS
trước.

**Hai việc đã xét và CỐ Ý KHÔNG làm lúc này:**
- *Gỡ bể kết nối tổ chức nhàn rỗi* — `pg` đã tự đóng kết nối nhàn rỗi sau 10 giây, bể im lặng không giữ kết nối nào; gỡ hẳn bể
  còn bắt lần mở sau chạy lại phép kiểm migration (khoảng 190 tệp).
- *Đệm theo tổ chức* — `clearMemo()` xoá đệm của mọi tổ chức là đánh đổi có chủ đích (hợp đồng mục 9: an toàn, chỉ tốn hiệu
  năng). Tách theo tổ chức phải viết lại cơ chế phiên bản đệm dùng chung; đáng làm khi có khoảng 20 tổ chức đang dùng hằng
  ngày và đo được tỷ lệ trúng đệm tụt.
