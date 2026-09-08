# Báo cáo phát hành — roadmap sau V2

Gộp **33 commit** từ `b067913` (bản V2 đang chạy trên production).

## ⚠ CHƯA DEPLOY — và vì sao

**Phiên làm việc này không có `gh` CLI**, nên không dispatch được workflow *Deploy ERP to VPS* và
cũng không chạy được ops `db-query` / `perf` trên máy chủ.

Toàn bộ mã đã ở trên `main` và đã qua cổng ra ở phần kiểm được. **Việc còn lại là chạy workflow
deploy** — xem mục cuối tài liệu.

## Cổng ra: 15/17 đạt tại chỗ, 2 mục cần production

| # | Mục | Kết quả |
|---|---|---|
| 1 | `git status` sạch | ✔ |
| 2 | Rà soát toàn bộ diff | ✔ 33 commit |
| 3 | Rà soát migration | ✔ `0037` — **11** câu lệnh có bảo vệ, **0** câu phá huỷ |
| 4 | `typecheck` | ✔ sạch |
| 5 | `lint` | ✔ **0 lỗi** (3 cảnh báo có từ trước) |
| 6–8 | Unit + tích hợp + bất biến nghiệp vụ | ✔ **82 khối**, **17/17 bất biến**, *TẤT CẢ KIỂM THỬ ĐẠT* |
| 9 | Nhất quán chỉ số | ✔ giao thành công 18 khớp ở 5 nơi |
| 10 | Production build | ✔ |
| 11 | Quét Chất lượng dữ liệu trên production | ⚠ **cần `gh`** — trên dữ liệu kiểm thử: 22 luật chạy đủ |
| 12 | Hồi quy phân bổ chi phí theo kỳ | ✔ |
| 13 | Kiểm tra chỉ số quảng cáo | ✔ + kiểm mới: bảng điều khiển và báo cáo **phải khớp nhau** |
| 14 | Kiểm tra bất biến tồn kho | ✔ |
| 15 | So sánh hiệu năng | ✔ `docs/erp-perf-audit-round2.md` |
| 16 | Rà soát an toàn | ✔ 0 bí mật trong kho mã, chỉ `.env.example` được theo dõi |
| 17 | Kế hoạch rollback | ✔ deploy lại `b067913` |

## Task đã hoàn thành

| Lô | Task | Trạng thái |
|---|---|---|
| **A** | A1–A5 · Hàng đợi việc hợp nhất | **XONG** |
| **B** | B1–B4 · CS / Sales intelligence | **XONG** |
| **C** | C1–C4 · Quảng cáo → giao thành công → lợi nhuận | **XONG** |
| **D** | D1–D3 · Mẫu mã × màu × size | **XONG** |
| **E** | E1–E5 · Tồn kho & dự báo sản xuất | **XONG** |
| **F** | F1–F3 · Bảng điều khiển quản trị | **XONG** |
| **G** | G1–G3 · Nền tảng trợ lý (chỉ đọc) | **XONG** |
| **H** | H1–H2 · Tìm kiếm & dòng thời gian | **XONG** |
| **I** | I1–I3 · Hiệu năng & độ tin cậy vòng 2 | **XONG** |
| **J** | J · Nhất quán giao diện | **XONG** |

## Ba lỗi THẬT phát hiện và sửa trong đợt này

Đây là phần đáng đọc nhất của báo cáo — cả ba đều là lỗi im lặng, không báo gì cả.

**1. ROAS theo mẩu quảng cáo tra chi tiêu sai không gian khoá.** Đường tính đã có sẵn trong mã nhưng
chưa từng được gọi từ giao diện. Bật lên là mọi mẩu quảng cáo hiện chi 0đ, và TOÀN BỘ tiền chiến
dịch bị xếp vào nhóm "tiền đã tiêu mà không đơn nào gắn vào" — một kết luận sai hoàn toàn, ở đúng
chỗ dễ tin nhất. Nguyên nhân gốc không phải lỗi khoá mà là **dữ liệu không tồn tại**: Facebook
Insights đồng bộ ở cấp chiến dịch/ngày. Sửa bằng cách nói **CHƯA BIẾT** thay vì nói 0.

**2. Ô tìm kiếm sập khi dán mã vận đơn.** `orders.system_id` là INTEGER 4 byte; mã vận đơn Viettel
Post cũng toàn chữ số nhưng dài hơn hẳn, nên so thẳng thì Postgres báo tràn số. Ca dùng phổ biến
nhất của ô tìm kiếm chính là dán một mã vận đơn. Kiểm thử bắt được trước khi lên production.

**3. Job treo tự chặn chính mình vĩnh viễn.** Khoá job nằm trong bộ nhớ tiến trình và chỉ nhả trong
`finally`. Job treo ⇒ `finally` không chạy ⇒ khoá không nhả ⇒ job đó không còn chạy được cho tới khi
khởi động lại container, mà giao diện vẫn báo "đang chạy". Phần dọn bản ghi mồ côi đã có chỉ sửa
dòng trong CSDL, không chạm khoá trong bộ nhớ.

## Thay đổi schema

| | |
|---|---|
| Migration | **`0037`** — 5 cột hàng đợi việc (`started_*`, `ignored_*`), 2 khoá ngoại, 1 CHECK, 1 index |
| An toàn | **11** câu lệnh có bảo vệ idempotent · **0** câu phá huỷ · CHECK để `NOT VALID` |
| Ràng buộc mới | "Bỏ qua việc" **bắt buộc có lý do** — gạt một việc đi mà không nói vì sao là xoá bằng chứng lặng lẽ |

Ngoài ra `PlanningAssumptions` thêm mức đặt tối thiểu của xưởng (lưu trong `settings`, không cần
migration).

## Bốn thứ KHÔNG LÀM ĐƯỢC — nêu tên thay vì im lặng

Kế hoạch đề nghị, ERP không có nguồn dữ liệu. Im lặng bỏ qua thì người sau sẽ đi tìm, không thấy,
rồi tự dựng một con số thay thế.

1. **Phễu "Đã liên hệ" / "Đủ điều kiện"** — ERP không đồng bộ hội thoại Pancake. Hệ quả phải nói
   thẳng: **ERP không đo được tỷ lệ chốt từ khách nhắn tin.**
2. **Nội dung quảng cáo (creative)** — không có bảng nào lưu.
3. **Chi tiêu cấp nhóm và cấp mẩu quảng cáo** — Insights đồng bộ ở cấp chiến dịch/ngày.
4. **"Khách cũ đủ điều kiện mua lại"** — chưa có luật nghiệp vụ nào định nghĩa; tự đặt ngưỡng là ra
   quyết định kinh doanh thay chủ shop.

## Độ phủ dữ liệu — đo được trong ứng dụng, không phải số chép tay

Vì không chạy được truy vấn production, mọi phép đo độ phủ được làm thành **hàm chạy trong ứng
dụng**, có kiểm thử, mở trang là thấy:

- **Độ phủ gán người** (5 vai) — trang Phễu bán hàng;
- **Độ phủ quy kết quảng cáo** (9 mắt xích) — trang Quảng cáo, đặt ngay cạnh bảng ROAS;
- **Độ phủ giá vốn** — trang Phễu bán hàng và Hiệu quả mẫu mã.

Nguyên tắc chung: **độ phủ thấp thì hiện cảnh báo, không giấu**. "ROAS 4,2" khi chỉ 30% đơn có mã
quảng cáo là ROAS của 30% đó — con số vẫn đúng, nhưng đọc như thể nó nói về toàn shop là tự lừa
mình.

## Hiệu chuẩn có đổi hành vi

**Trần mức nghiêm trọng trong công thức ưu tiên hạ 40 → 30.** Việc "nghiêm trọng nhưng không ai chờ,
không dính tiền" không còn tự động là GẤP. Mức GẤP nay đòi đúng hồ sơ của việc gấp thật: nghiêm
trọng + có khách đang chờ + còn cứu được.

## KPI: dự kiến KHÔNG đổi

Không thay đổi nào chạm `ORDER_OUTCOME` hay bất kỳ công thức tiền nào. Hai tỷ lệ quảng cáo lên bảng
điều khiển dùng **chung một hàm** với Báo cáo lợi nhuận, và kiểm thử hợp đồng chỉ số so trực tiếp
hai nơi, bắt lỗi nếu lệch quá 0,05 điểm phần trăm.

## Giới hạn đã biết

- **Đơn ↔ vận đơn vẫn là 1:1** (`shipments.order_id` UNIQUE). Cố ý chưa gỡ — mọi báo cáo tính ở
  grain *đơn × vận đơn*, gắn N vận đơn vào một đơn khi chưa đổi grain là **nhân đôi doanh thu**.
- **Khoá job ở mức tiến trình** — đủ cho một container; chạy hai bản ứng dụng thì phải đổi sang khoá
  cấp CSDL.
- **Tìm kiếm dùng `LIKE '%…%'`** — không dùng được index; ngưỡng xem lại: `orders` vượt ~50.000 dòng.

## Không bật, đúng lệnh

`PENDING_DIRECT_VTP_FULFILLMENT` · WRITE BACKFILL toàn cục · xoay secret · tự động đổi ngân sách
quảng cáo / tạo đơn sản xuất / đổi COD / đổi trạng thái đơn hay vận đơn.

## Cách deploy khi có `gh` (hoặc bấm trên GitHub)

```
Actions → "Deploy ERP to VPS" → Run workflow → nhánh main
```

Sau khi chạy xong, xác minh:

1. `GET /api/health` trả `commit` là `912dfeb` (hoặc commit cuối của `main`);
2. Migration `0037` đã áp: `notifications` có cột `started_at`, `ignored_at`, `ignored_reason`;
3. Quét Chất lượng dữ liệu — kỳ vọng **0 nghiêm trọng**, đúng như trước phát hành;
4. Đối chiếu KPI trước/sau: giao thành công · hoàn · đang giao · chưa rõ · chưa gửi · huỷ đều
   **không được đổi**;
5. Mở bảng điều khiển: hai khối mới ("Việc cần làm hôm nay", "Tóm tắt & rủi ro") và hai thẻ tỷ lệ
   quảng cáo phải hiện đúng.

**Rollback:** deploy lại `b067913`. Migration `0037` chỉ **cộng thêm** cột nên bản cũ chạy được
nguyên vẹn trên schema mới.
