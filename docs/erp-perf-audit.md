# Đo hiệu năng ERP — 08/09/2026

## Nguyên tắc: đo trước, sửa sau

Kho mã này đã theo nguyên tắc đó (xem `drizzle/0034_perf_indexes.sql`). Tối ưu khi chưa đo được nút
thắt là thêm rủi ro mà không đổi lấy gì.

## Số đo trên production

| | |
|---|---|
| CPU | 2 nhân · load 0,20 / 0,20 / 0,47 |
| RAM | **556 MB / 1.963 MB** dùng · 1.097 MB còn trống |
| `erp-app` | 8,2% CPU · 236 MB |
| `erp-db` | 6,7% CPU · 225 MB |
| `erp-scheduler` | 0,0% CPU · 20 MB |
| `erp-caddy` | 0,0% CPU · 22 MB |
| Kết nối CSDL | 2 mở · 1 đang chạy |

Thời gian phản hồi nội bộ `/api/health`, `/login`, `/api/notifications`: **dưới ngưỡng đo được**
(< 1 ms). Máy chủ chạy liên tục 4 ngày.

## Quy mô dữ liệu

| Bảng | Số dòng |
|---|---|
| `inventory_histories` | 6.463 |
| `notifications` | 4.656 |
| `webhook_events` | 4.633 |
| `customers` | 4.009 |
| `sync_runs` | 3.678 |
| `ad_spends` | 2.686 |
| `cod_statement_lines` | 2.493 |
| `order_items` | 2.465 |
| `shipments` | 1.773 |

## Kết luận: **không có nút thắt nào để tối ưu lúc này**

Ở quy mô vài nghìn dòng, mọi truy vấn đều nằm trong bộ nhớ và chạy dưới mili-giây. Viết thêm tối ưu
bây giờ là **đoán**, và mỗi tối ưu đoán mò là thêm một chỗ có thể sai trong lớp số liệu vừa mất
nhiều công để làm cho đúng.

Các nút thắt **đã đo được** trước đây đã được xử lý ở migration `0034`: hai truy vấn chạy cho TỪNG
vận đơn (chi phí tăng theo bình phương khi shop lớn dần) nay có index riêng phần.

## Rủi ro khi lớn lên — theo dõi, chưa sửa

1. **RAM 1,9 GB là trần thật.** Đang dùng 556 MB. Khi `webhook_events` và `shipment_events` lớn dần,
   Postgres sẽ cần nhiều bộ nhớ đệm hơn. Ngưỡng nên xem lại: **vượt 1,4 GB**.
2. **Trung tâm điều khiển chạy 22 câu truy vấn**, mỗi luật một câu. Hiện chạy song song và mỗi câu
   dưới mili-giây. Khi `shipments` vượt ~50.000 dòng nên đo lại từng luật, đặc biệt các luật có
   truy vấn con tương quan.
3. **`inventory_histories` là bảng lớn nhất** và chỉ tăng. Chưa ảnh hưởng gì, nhưng là bảng đầu tiên
   cần phân vùng hoặc dọn nếu shop chạy nhiều năm.

## Cách đo lại

```
Actions → "Vận hành ERP trên VPS" → perf
```

In tài nguyên từng container, thời gian phản hồi vài trang, số kết nối CSDL và mười bảng lớn nhất.
