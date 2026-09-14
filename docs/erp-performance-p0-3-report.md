# Hiệu năng P0.3 — vật chất hoá kết quả đơn và giá vốn

Ngày 09/09/2026. Mọi con số đo **trên production**, không phải fixture.

---

## 1. Kết quả cuối — trang thật, người dùng thật

Smoke test sau bản `e019cac`, đo bằng cách **mở thật 25 màn hình** bằng một phiên đăng nhập hợp lệ:

| Màn hình | TRƯỚC P0.2 | SAU P0.2 (`ea7091a`) | SAU P0.3 (`e019cac`) | Mục tiêu |
| --- | ---: | ---: | ---: | ---: |
| **`/` trang chủ** | **quá hạn 60s** | quá hạn 60s | **108ms** | <1.500ms ✅ |
| `/cod` | quá hạn 60s | 152ms | **147ms** | — ✅ |
| `/reports/returns` | quá hạn 60s | 116ms | **170ms** | <800ms ✅ |
| `/ads` | quá hạn 60s | 70ms | **88ms** | <2.000ms ✅ |
| `/reports` | 2.965ms | 219ms | **122ms** | <1.500ms ✅ |
| `/alerts` | — | 82ms | **73ms** | <1.000ms ✅ |
| `/products` | — | 113ms | **174ms** | — ✅ |
| `/data-quality` | — | 163ms | **94ms** | — ✅ |

```
[smoke] 25/25 đạt · 0 lỗi ứng dụng · 0 sai quyền · 0 chậm · 0 quá hạn · 0 hết phiên
[smoke] ✓ Không có lỗi thật.
```

**Toàn bộ mục tiêu hiệu năng đã đạt.** Deploy xanh hoàn toàn.

Chi phí NGUỘI của trang chủ (lần dựng đầu tiên sau khi container khởi động lại) còn **34,6 giây** —
giảm từ 80–100 giây, nhưng vẫn là một con số phải xử lý riêng (mục 5).

## 2. Đối chiếu trên TOÀN BỘ dân số production

```
TOTAL_ORDERS      2431      (grain đơn × vận đơn — đúng grain báo cáo đang dùng)
MATCHED           2431
MISMATCHED           0   ✅
MISSING_FACT         0   ✅
STALE_VERSION        0   ✅
ELIGIBLE          2431
CURRENT_VERSION   2431      → độ phủ 100%
FALLBACK_RATE       0%   ✅  → lớp dự phòng là lưới an toàn, không phải đường chạy chính
```

Kiểm **cả kết quả đơn lẫn giá vốn**, từng dòng một, bằng chính biểu thức chuẩn. Không sample.

## 3. Việc đã làm

| Bước | Nội dung |
| --- | --- |
| **P0.3B-1** | Bảng `canonical_order_outcome` (grain đơn × vận đơn), migration 0047 |
| **P0.3B-2** | Giá vốn vào **cùng bảng**, migration 0048, `logic_version` = 2 |
| **An toàn** | `ORDER_OUTCOME_FAST` / `ORDER_COGS_FAST` = `coalesce(bảng, tính trực tiếp)` |
| **Tăng dần** | `rematerializeStale()` nhặt đơn theo **đầu vào đã đổi**, không rebuild toàn bảng |

Bộ vật chất hoá **dùng lại chính biểu thức chuẩn** đã import — không chép công thức sang. Hai bên
khớp theo cấu trúc, không nhờ ai nhớ đồng bộ hai bản.

## 4. Hai giả định của tôi đã sai, và cách phát hiện

### 4.1 "ORDER_OUTCOME là phần đắt nhất" — sai sau bước 1

Sau khi vật chất hoá kết quả đơn, `EXPLAIN ANALYZE` cho thấy đọc **toàn bộ 2.431 dòng chỉ mất 48ms**.
Nhưng báo cáo vẫn 5–10 giây. Nên phần đắt nhất đã chuyển sang chỗ khác.

### 4.2 "ORDER_COGS là phần còn lại" — cũng không đủ

Vật chất hoá giá vốn xong, `EXPLAIN ANALYZE` xác nhận nhánh dự phòng **`never executed`** và cả biểu
thức chạy hết **33ms** cho 2.431 dòng. Nhưng `perf-probe` vẫn báo 5–14 giây.

### 4.3 Thứ thật sự sai: THƯỚC ĐO

`perf-probe` gọi `clearMemo()` **trước mỗi phép đo** — cố ý, để không đo trúng bộ đệm. Nhưng điều đó
biến nó thành phép đo **trường hợp xấu nhất tuyệt đối**: mọi lớp đệm rỗng, kể cả những thứ có TTL 5
phút và người dùng gần như không bao giờ trả giá.

Ví dụ cụ thể: `getReturnRateSummary` gọi `failedToReturnRate()` — một truy vấn quét sự kiện 180 ngày
bằng `ILIKE`, **có nhớ tạm 300 giây**. Probe xoá đệm nên lần nào cũng trả giá; người dùng thật thì
mỗi 5 phút mới một lần.

Số của người dùng là **170ms**, không phải 5.549ms. Cả hai đều đúng — nhưng chỉ một cái là thứ chủ
shop trải nghiệm.

**Bài học ghi lại:** một phép đo cố tình dựng điều kiện xấu nhất thì phải được đọc như điều kiện xấu
nhất, không phải như hiệu năng thường ngày. Tôi đã suýt đi tối ưu tiếp dựa trên con số sai thước.

## 5. Còn lại, đã đo và đã khoanh vùng

| Việc | Số đo | Đánh giá |
| --- | ---: | --- |
| Chi phí NGUỘI trang chủ | 34,6s | Chỉ xảy ra ở lần mở đầu tiên sau khi container khởi động lại — tức sau mỗi lần deploy. Người dùng gặp một lần/ngày, hoặc không gặp. |
| `failedToReturnRate` khi đệm nguội | vài giây | Quét `shipment_events` 180 ngày bằng `ILIKE`. Có nhớ tạm 300s. Sửa được bằng chỉ mục hoặc cột đã chuẩn hoá — **chưa làm vì chưa đo được là nó ảnh hưởng người dùng thật**. |
| `getOperatingCost` khi đệm nguội | ~3s | Cùng lý do. |

**Không materialize thêm theo cảm tính.** Ba mục trên chỉ nên đụng tới khi đo được là chúng ảnh hưởng
trang thật — hiện tại 25/25 màn hình đều dưới 400ms.

## 6. Giá vốn: một cái bẫy tìm ra khi viết hợp đồng ghi nhận

`ORDER_COGS` lấy giá trên **phiếu nhập gần nhất**, và "gần nhất" tính theo **thời điểm hiện tại**,
không theo ngày lên đơn. Nghĩa là nhập một phiếu hôm nay **đổi giá vốn của mọi đơn lịch sử** có mẫu
mã đó.

Bộ dò dòng cũ ban đầu của tôi chỉ nhìn đơn · vận đơn · sự kiện ĐVVC · dòng bảng kê — **không nhìn
phiếu nhập**. Kết quả đơn vẫn đúng mà giá vốn thành cũ, và lợi nhuận sai trong im lặng.

Đã vá: bộ dò nay theo dõi cả phiếu nhập (theo **mẫu mã**, vì một phiếu ảnh hưởng nhiều đơn) và thay
đổi dòng hàng. Kiểm thử dựng đúng kịch bản đó.

Chi tiết phương pháp: `docs/cogs-recognition-contract.md`. Hai việc còn bỏ ngỏ cần chủ shop quyết
được nêu ở mục 6 của tài liệu đó.

## 7. KPI trước → sau

Không đổi. Cùng `ORDER_OUTCOME`, cùng `ORDER_COGS`, cùng phép nối, cùng bộ lọc — chỉ đổi *lúc nào*
chúng được tính. Ba lớp bằng chứng:

1. `tests/metric-shape-consistency.test.ts` — sáu con số tiền tính lại theo cách nội tuyến cũ,
   **khớp 6/6**;
2. đối chiếu toàn bộ dân số production — **0 lệch**;
3. `tests/contract-order-outcome.test.ts` — hợp đồng luật nghiệp vụ, chạy trong mọi lần deploy.
