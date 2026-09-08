# Đo hiệu năng vòng 2 — sau roadmap V2

Vòng 1: `docs/erp-perf-audit.md` (đo trên production, kết luận: chưa có nút thắt nào ở quy mô vài
nghìn dòng).

## Blocker phải nói trước

**Phiên này không có `gh` CLI**, nên không chạy được ops `perf` / `db-query` để đo lại trên máy chủ
thật. Mọi con số production trong tài liệu này là số của vòng 1, không phải số mới.

Thay vì chép lại số cũ như thể vừa đo, vòng 2 làm việc **kiểm được mà không cần production**: soi
chính những truy vấn vừa thêm trong roadmap này, tìm chỗ tự mình làm chậm đi.

## Việc chậm do chính đợt này gây ra — đã sửa

**Hàng đợi việc chạy HAI LẦN trên mỗi lần tải bảng điều khiển.**

Bảng điều khiển nay có hai khối cùng cần hàng đợi: "Việc cần làm hôm nay" và "Tóm tắt & rủi ro". Hai
khối render song song nên mỗi khối tự gọi một lần. Nặng gấp đôi ở chỗ hàng đợi còn kéo theo **kế
hoạch tồn kho** để tính yếu tố "sắp cháy hàng".

Sửa bằng `cache` của React — khử trùng lặp trong **phạm vi một lần render**, không phải theo thời
gian. Cố ý **không** dùng bộ nhớ đệm theo TTL ở đây: người vừa bấm "Tôi nhận" phải thấy trạng thái
đổi ngay, đệm 30 giây sẽ khiến giao diện trông như hỏng.

## Đã kiểm, không phải nút thắt

| Truy vấn mới | Hình dạng | Kết luận |
|---|---|---|
| Hàng đợi việc | 1 truy vấn `notifications` + 2 tra cứu số tiền + kế hoạch tồn (có đệm) | Có index `notifications_open_idx`; giới hạn 60–300 dòng |
| Dòng thời gian đơn | N+1 theo **vận đơn** của một đơn | `shipments.order_id` là UNIQUE ⇒ N ≤ 1. Không phải N+1 thật |
| Hàng bán chậm | 4 truy vấn con gộp theo mẫu mã, đệm 120s | Chạy theo số mẫu mã, không theo số đơn |
| Phễu bán hàng | 1 truy vấn gộp | Một lần quét, không lặp |
| Hiệu suất nhân sự | 1 truy vấn gộp cho mỗi vai | Trang chỉ xem một vai mỗi lần |
| Độ phủ quy kết QC | 3 truy vấn gộp | — |
| Phát hiện QC bất thường | 2 lần gọi ROAS (đã đệm 90s) + 1 truy vấn | Chạy trong job cảnh báo, không trên đường render |
| Tìm kiếm ⌘K | 4 truy vấn song song, `LIKE '%…%'` | Xem rủi ro bên dưới |

## Rủi ro đã lường, chưa xử lý — kèm ngưỡng xem lại

1. **Tìm kiếm dùng `LIKE '%…%'` nên không dùng được index.** Ở quy mô hiện tại (`orders` vài nghìn
   dòng, `customers` ~4.000) một lần quét bảng vẫn dưới mili-giây. **Ngưỡng xem lại: `orders` vượt
   ~50.000 dòng** — khi đó cần index trigram (`pg_trgm`) trên `bill_phone`, `bill_full_name` và
   `vtp_order_number`. Không thêm bây giờ vì thêm một extension và ba index cho một vấn đề chưa tồn
   tại là thêm rủi ro không đổi lấy gì.

2. **Hàng đợi việc kéo theo kế hoạch tồn kho.** Chỉ khi có việc thuộc mẫu mã. Kế hoạch đã đệm 120s
   và dùng chung với trang Kế hoạch SX. **Ngưỡng xem lại: `product_variants` vượt ~5.000.**

3. **Trang Hiệu quả mẫu mã phân loại trong bộ nhớ** sau khi lấy tối đa 300 dòng. Phân loại là phép
   tính thuần, không chạm CSDL. **Ngưỡng xem lại: cần xem quá 300 mẫu mã một lúc.**

## Nguyên tắc giữ nguyên từ vòng 1

Đo trước, sửa sau. Tối ưu khi chưa đo được nút thắt là thêm rủi ro mà không đổi lấy gì — và trong
một kho mã mà lớp số liệu vừa mất rất nhiều công để làm cho đúng, mỗi tối ưu đoán mò là thêm một chỗ
có thể sai.

Việc duy nhất được sửa ở vòng này là việc **đo được bằng cách đọc mã**: một truy vấn chạy hai lần
cho cùng một dữ liệu trong cùng một lần render.

## Cách đo lại khi có `gh`

```
Actions → "Vận hành ERP trên VPS" → perf
```

In tài nguyên từng container, thời gian phản hồi vài trang, số kết nối CSDL và mười bảng lớn nhất.
Trang cần đo thêm sau đợt này: `/reports/funnel`, `/products/performance`, `/inventory/planning`
(đã có thêm khối vốn nằm chết) và bảng điều khiển (đã có thêm hai khối).
