# Hiệu năng P0.2 — hotspot đo trên production thật

Ngày 09/09/2026. Mọi con số BEFORE đo bằng `ops perf-probe` **trên dữ liệu production**
(2.426 đơn · 1.824 vận đơn · 24.127 sự kiện), không phải trên fixture nhỏ.

---

## 1. Vì sao phải đo lại, và vì sao lần đoán đầu tiên sai

Deploy `#172` đỏ vì smoke báo 5 màn hình quá hạn 60 giây. Tôi đoán đó là tranh CPU với scheduler
đang đồng bộ lúc container vừa khởi động.

**Đoán đó sai.** Chạy lại smoke trên hệ thống ĐANG RẢNH: vẫn đúng 5 màn hình đó quá hạn, riêng trang
chủ mất **100 giây**. Đây là lỗi hiệu năng thật, lặp lại được — không phải hiện tượng lúc deploy.

Bài học ghi lại: một phép đo trong lúc hệ thống đang bận không kết luận được gì. Đã thêm lệnh ops
`smoke` và `perf-probe` để đo được trên hệ thống ổn định.

## 2. BEFORE — đo trên production

| Hàm | Thời gian | Dữ liệu trả về |
| --- | ---: | --- |
| `getDashboardData` | **30.000–47.300ms** | 12kB |
| ├─ `getFinancialTruth` | **20.503ms** | 2kB |
| ├─ `getOperatingCost` | 2.855ms | 1kB |
| ├─ `getControlTower` | 331ms | 15kB |
| └─ `codCashSummary` | 15ms | 0kB |
| `adsRoas` (30 ngày) | **25.075ms** | 459kB |
| `adsRoas` (toàn kỳ) | **26.641ms** | 661kB |
| `getReturnRateByVariant` | 6.707ms | 43kB |
| `getReturnRateSummary` | 5.945ms | 0kB |
| `codSettlementSummary` | 1.626ms | 0kB |
| các hàm còn lại của `/cod` | 6–217ms | — |

**Manh mối quyết định:** `adsRoas` mất **như nhau** cho 30 ngày và toàn kỳ. Chi phí **không đi theo
lượng dữ liệu** — nó đi theo số lần tính LẶP.

## 3. Nguyên nhân gốc

`ORDER_OUTCOME` là một biểu thức `CASE` chứa nhiều truy vấn con tương quan (sự kiện ĐVVC, vận đơn
chiều hoàn, dòng bảng kê COD). Postgres **không gộp lại được** khi nó nằm trong `filter (where ...)`
của từng cột gộp — mỗi cột kéo theo một bản sao.

- `getFinancialTruth`: **12 cột gộp** ⇒ mỗi đơn tính kết quả 12 lần.
- `adsRoas`: **8 cột gộp**, cộng thêm khoá nhóm chứa `ORDER_CAMPAIGN_ID` (một truy vấn con nữa) bị
  tính ở **cả** `SELECT` lẫn `GROUP BY`.

Đây đúng là bệnh mà rào `OUTCOME_FENCE` đã chữa cho các truy vấn khác từ trước — chỉ là **đường tiền
và đường quảng cáo chưa được chữa**.

Không phải lỗi cơ sở dữ liệu: cùng lúc đó, `EXPLAIN ANALYZE` của phép nối đơn ↔ vận đơn kèm hai truy
vấn con chạy hết **32ms**, và mọi chỉ mục cần thiết đều có sẵn.

## 4. Đã sửa

| Hàm | Cách sửa | Bằng chứng không đổi số |
| --- | --- | --- |
| `getFinancialTruth` | bảng dẫn xuất + `OUTCOME_FENCE`; 12 cột đọc lại cột `outcome` đã tính | `tests/metric-shape-consistency.test.ts` tính lại **6 con số tiền** theo đúng cách nội tuyến cũ rồi so từng con số — **khớp 6/6** |
| `adsRoas` | bảng dẫn xuất + rào; khoá nhóm dựng một lần | `tests/ads-roas.test.ts` + `tests/ads-attribution.test.ts` giữ nguyên ba nhóm quy kết |

**Đổi HÌNH DẠNG truy vấn, KHÔNG đổi công thức.** Cùng `ORDER_OUTCOME`, cùng phép nối, cùng bộ lọc.

Ba nhóm quy kết quảng cáo giữ nguyên: `UNIQUE_DETERMINISTIC` · `AMBIGUOUS` · `UNMAPPED`. **Không hề
suy đoán mapping để chạy nhanh hơn** — độ phủ ~49% là giới hạn dữ liệu, không phải thứ để tối ưu đi.

## 5. Smoke test: CHẬM không còn bị gọi là LỖI

Deploy `#172` đỏ vì gộp hai chuyện khác hẳn nhau. Nay tách:

- `APP_ERROR` / `REDIRECT` / `TIMEOUT` → **chặn deploy**;
- `SLOW` (mở được, chậm hơn ngưỡng 2s) → **không chặn**, nhưng in riêng một mục xếp theo thời gian
  giảm dần.

Vì sao không chặn: chặn bản mới vì nó chậm có thể đang chặn **đúng bản vá làm nó nhanh hơn**.

## 6. Còn nợ, đã đo và đã khoanh vùng

`getReturnRateSummary` (5,9s) và `getReturnRateByVariant` (6,7s) **đã có rào từ trước**. Thời gian
đó là **sàn của việc tính `ORDER_OUTCOME` một lần cho mỗi đơn**: ~2,4ms/đơn × 2.426 đơn.

Nghĩa là rào đã hết tác dụng ở đây, và muốn xuống dưới mục tiêu 1,5s thì phải đổi kiến trúc chứ
không phải đổi hình dạng truy vấn:

> **Vật chất hoá kết quả đơn** — lưu `outcome` đã tính cho mỗi (đơn, vận đơn) kèm dấu vân tay dữ
> liệu đầu vào, dựng lại **tăng dần** theo ngày bị ảnh hưởng khi có sự kiện mới. Báo cáo đọc bảng đã
> vật chất hoá; sự kiện thô chỉ dùng cho đối soát, dựng lại và truy vết.

**Cố ý chưa làm trong lượt này.** `ORDER_OUTCOME` là luật nghiệp vụ được bảo vệ chặt nhất trong kho
mã (`tests/contract-order-outcome.test.ts` chặn deploy). Vật chất hoá nó cần một lượt riêng có đối
chiếu trước/sau trên production cho từng trạng thái, không phải một bước cuối phiên.

Mục tiêu hiệu năng chủ shop đặt (trang chủ nguội < 1,5s) **chưa đạt** — sẽ đạt khi làm xong lớp vật
chất hoá đó.

## 7. AFTER — đo bằng smoke trên production, bản `ea7091a`

Bốn trong năm màn hình quá hạn đã hết. Đây là thời gian mở trang thật, đo trên chính máy chủ:

| Màn hình | TRƯỚC (`d8b290d`) | SAU (`ea7091a`) | Cải thiện |
| --- | ---: | ---: | ---: |
| `/cod` | **quá hạn 60s** | **152ms** | ≥ 395× |
| `/cod?recon=unproven` | quá hạn 60s | 196ms | ≥ 306× |
| `/cod?recon=stale` | quá hạn 60s | 191ms | ≥ 314× |
| `/reports/returns` | quá hạn 60s | 116ms | ≥ 517× |
| `/ads` | quá hạn 60s | 70ms | ≥ 857× |
| `/reports` | 2.965ms | 219ms | 13,5× |
| **`/` (trang chủ)** | quá hạn 60s | **vẫn quá hạn** (làm nóng 80s) | — |

Toàn lượt: **24/25 màn hình đạt · 0 lỗi ứng dụng · 0 sai quyền · 1 quá hạn**.

### Trang chủ vẫn là điểm còn lại

Đúng như dự đoán từ phần đo: `getDashboardData` là hàm nặng nhất, và phần lớn chi phí nằm ở việc
tính `ORDER_OUTCOME` một lần cho mỗi đơn — thứ mà rào không hạ thêm được nữa.

Đó chính là việc của **P0.3B: vật chất hoá kết quả đơn** (commit `c4f8865`, chưa deploy).

### Ghi chú trung thực về lần deploy

Deploy `ea7091a` vẫn bị đánh **ĐỎ** dù ứng dụng lên đúng bản và 24/25 màn hình tốt — vì trang chủ
quá hạn. Đã thêm ngân sách cho cả lượt smoke để một trang chậm không còn đốt hết thời gian và kéo
sập cả lần phát hành; nhưng `TIMEOUT` vẫn **cố ý** bị coi là lỗi thật, không hạ xuống mức cảnh báo.
