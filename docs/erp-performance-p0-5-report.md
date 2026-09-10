# Hiệu năng P0.5 — bốn lần chẩn đoán sai, và thứ đã sửa được chúng

Ngày 10/09/2026. Mọi con số đo **trên production**, hệ thống rảnh, không phải lúc deploy.

---

## 1. Triệu chứng

```
[smoke] làm nóng /  → 76.292ms
[smoke] /           → QUÁ HẠN 60 giây
        → nuốt trọn ngân sách 300s, 8 màn hình còn lại KHÔNG kịp kiểm
```

Mọi trang khác: **49–320ms**. Chỉ trang chủ chậm.

## 2. Bốn lần chẩn đoán sai — và tất cả đều do THƯỚC ĐO, không do suy luận

| # | Giả thuyết | Đã làm gì | Kết quả |
| --- | --- | --- | --- |
| 1 | `getControlTower` (tôi vừa sửa hai luật ở đó) | đọc lại mã | **sai** — đo ra 300ms |
| 2 | Lớp tăng tốc P0.3 chỉ nối vào 2/25 tệp | chuyển 21 tệp sang bản nhanh | **không đổi** |
| 3 | `PRIMARY_ATTEMPT` nằm trong điều kiện nối | thêm đường tắt cho đơn một lần gửi | **không đổi** |
| 4 | `RETURN_PENDING_WAREHOUSE` dùng biểu thức sống | chuyển 11 vị trí sang bản nhanh | **không đổi** |

Bốn lần đều sửa **NỘI DUNG** biểu thức. Vấn đề nằm ở **HÌNH DẠNG**.

### Vì sao mất bốn vòng

Thước đo thiếu ba thứ, và mỗi thứ thiếu đều dẫn tới một kết luận sai:

1. **Không đo `getBusinessBrief`** — nó là thành phần ĐẮT NHẤT (46s) mà trang chủ cũng phải chờ.
   Nằm trong Suspense nên HTML đầu ra sớm, nhưng phản hồi HTTP chỉ kết thúc khi nó xong.
2. **Không in phần tách CSDL / ứng dụng** dù đã thu sẵn. Biết "40 giây" mà không biết nó nằm ở
   Postgres hay Node thì chỉ còn cách đoán.
3. **Không in câu lệnh SQL chậm nhất.** "46 giây trong 105 lượt gọi" chưa sửa được gì — phải biết
   lượt NÀO.

Vá cả ba, chạy MỘT lần, và nó chỉ thẳng thủ phạm:

```
39.960ms  select product_variants … received, out_shipped, sold_delivered …
39.284ms  (câu y hệt, chạy LẦN HAI trong cùng một lần mở trang chủ)
          toàn bộ trong Postgres · ứng dụng 0ms · ít lượt gọi
```

> **Bài học ghi lại:** một thước đo bỏ sót thì mọi kết luận rút ra từ nó đều thiếu — và nó thiếu một
> cách tự tin, vì phần bị bỏ sót không hiện ra ở đâu cả. Đầu tư vào thước đo trả lời được câu hỏi
> mình đặt ra rẻ hơn nhiều so với bốn vòng sửa mò.

## 3. Nguyên nhân gốc: bảng dẫn xuất sinh ra để NỐI, không phải để tra từng dòng

`EXPLAIN ANALYZE` (thao tác ops `explain-stock`) trả lời được câu mà bốn vòng trước phải đoán:

```
Seq Scan on orders  (actual time=9053.519..9055.475 rows=2443)
                    Buffers: shared hit=350
```

**350 buffer cho 2.443 dòng** — không phải đọc đĩa. Chín giây đó là biểu thức chạy trên từng dòng.

`ORDER_OUTCOME_FAST` là truy vấn con **tương quan**. Đọc bảng dẫn xuất bằng nó thì Postgres gắn cả
chuỗi dự phòng vào phép quét `orders`, và mỗi dòng phải đi qua chuỗi đó.

Bản thân việc tra bảng thì **rẻ**: `SubPlan 1` chạy 2.380 lượt, mỗi lượt **0,003ms**. Cái đắt là bị
gắn vào từng dòng của một câu gộp trên 2.495 dòng hàng.

### Bản vá

`variantSalesSubquery` nối thẳng `canonical_order_outcome` bằng `LEFT JOIN` — một phép nối băm, tính
một lần cho tất cả. Điều kiện tươi mới (phiên bản luật, `computed_at` so với `updated_at` của đơn và
vận đơn) đặt **ngay trong phép nối**, nên dòng cũ không khớp và `coalesce` rơi về biểu thức chuẩn.

Vẫn đúng luật **"chậm chứ không sai"** — chỉ khác là phần chậm nay chỉ trả cho những dòng thật sự
cũ, thay vì cho cả 2.443 dòng.

## 4. Việc đi kèm, có giá trị riêng

Bốn bản vá "không ăn thua" ở mục 2 **không phải công cốc** — chúng sửa những lỗi thật, chỉ là không
phải lỗi đang gây ra 40 giây:

- **Lớp tăng tốc chỉ nối vào 2/25 tệp.** 21 tệp còn lại vẫn tính lại kết quả đơn mỗi lần. Nay đã nối
  hết, và `tests/fast-path-wiring.test.ts` canh đường tiền nóng.
- **`PRIMARY_ATTEMPT` trong điều kiện nối** vẫn là hình dạng xấu; đường tắt cho đơn một lần gửi giữ
  nguyên tính đúng và bỏ được phần sắp xếp lại cho từng cặp dòng.
- **Miễn trừ quá rộng.** Lá chắn miễn cả tệp `return-rate.ts` vì "đây là nơi định nghĩa" — đúng, nhưng
  cùng tệp còn chứa các vị ngữ dẫn xuất dùng khắp nơi. Đây là lần thứ hai trong hai ngày một danh
  sách miễn trừ che mất lỗi thật; lá chắn nay kiểm riêng từng vị ngữ.

## 5. KẾT QUẢ — và mắt xích thật sự cuối cùng

```
[smoke] 19/25 đạt · 0 lỗi ứng dụng · 0 sai quyền · 1 chậm · 0 QUÁ HẠN
  ✓ /                    99ms      (trước: QUÁ HẠN 60 giây)
  ✓ /orders              97ms
  ✓ /inventory/planning  52ms
  ✓ /ads                 59ms
  ⚠ /customers/retention 2.368ms   ← còn lại, không chặn deploy
```

Sau khi vá xong hình dạng phép nối và bật giữ ấm, trang chủ VẪN quá hạn. Nhật ký cho thấy job giữ
ấm chạy đúng lịch. Mắt xích cuối nằm ở chỗ không ai ngờ:

```
lib/audit.ts   clearMemo()   ← xoá SẠCH đệm sau MỌI thao tác ghi, kể cả ĐĂNG NHẬP
```

Smoke đăng nhập lại trước mỗi màn hình (thêm vào từ trước để tránh hết hạn JWT), nên nó **xoá đệm 25
lần trong một lượt chạy**. Trang chủ luôn rơi vào lượt tính nguội.

Và đó không chỉ là chuyện của smoke: mỗi lần bất kỳ ai đăng nhập, toàn bộ đệm báo cáo của cả hệ
thống bị san phẳng. Đăng nhập không đổi doanh thu, không đổi tồn kho, không đổi lợi nhuận.

### Ba tầng cùng lúc mới đủ

| Tầng | Việc nó làm |
| --- | --- |
| **Đăng nhập thôi xoá đệm** | bỏ LOGIN/LOGOUT khỏi đường làm mới đệm — danh sách cố ý HẸP |
| **Job nền đánh dấu cũ, không xoá hẳn** | `staleMemo()` thay `clearMemo()` khi `runJob` đang chạy; người đọc nhận ngay số lượt trước |
| **Trả số cũ ngay, làm mới phía sau** | `memo()` phục vụ stale-while-revalidate, trần 15 phút |

Cộng thêm `dashboard-warm` mỗi 4 phút để cả lượt nguội đầu tiên cũng do bộ lập lịch trả giá.

**Điểm quan trọng: không tầng nào giấu chi phí thật.** `perf-probe` xoá đệm trước mỗi phép đo nên nó
vẫn báo đúng 33–40 giây cho `getDashboardData`. Cái đổi là AI trả giá đó.

## 6. Còn lại

Cùng hình dạng xấu còn ở các hàm khác, xếp theo chi phí đo được:

| Hàm | Đo được |
| --- | ---: |
| `getFinancialTruth` | 9.926ms |
| `getReturnRateByVariant` | 7.926ms |
| `getReturnRateSummary` | 6.921ms |
| `adsRoas` (30 ngày) | 4.487ms |
| `getOperatingCost` | 3.679ms |

Sửa theo đúng cách của mục 3: nối bảng dẫn xuất thay vì tra từng dòng. **Không** đụng tới định nghĩa
kết quả đơn — chỉ đổi *lúc nào* và *bằng hình dạng nào* nó được đọc.
