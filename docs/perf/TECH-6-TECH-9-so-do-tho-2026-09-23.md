# TECH-6 · TECH-9 — Số đo thô production, 23/09/2026

**Đây là SỐ ĐO THÔ, không phải kết luận.** Tệp này chép lại thứ `ops verify` đo được trên dữ liệu
thật, để TECH-6 và TECH-9 có căn cứ mà phân tích. Phần suy luận nằm ở tài liệu của hai việc đó.

**Cách đo:** `ops verify` (chỉ đọc), lượt chạy `35817182554`, 23/09/2026 04:09–04:12 UTC
(11:09–11:12 giờ Việt Nam). Công cụ mở thật từng màn hình bằng một phiên đăng nhập hợp lệ.

---

## ⚠ ĐIỀU KIỆN ĐO — PHẢI ĐỌC TRƯỚC MỌI CON SỐ DƯỚI

Máy đang **bão hoà** lúc đo:

| | |
|---|---|
| `load average` | **3,77** / 2,16 / 1,37 trên **2 nhân** — gấp ~1,9 lần số nhân |
| `erp-db` CPU | **107,57 %** — hơn trọn một nhân |
| RAM | 1.963 MB tổng · 1.194 dùng · **390 khả dụng** · swap đã chạm 183 MB |
| Chờ khoá | chính lượt đo này **chờ 95 giây** mới lấy được khoá đọc |

Nên mọi con số thời gian dưới đây là **CẬN TRÊN dưới tranh chấp**, không phải nền sạch. Cùng bài
học đã ghi khi đo lần trước: số đo lúc máy bão hoà nói về **cái máy**, không nói về mã nguồn.

Trên máy còn ba container `vnx-ai-staging-*` (~370 MB) chạy song song với ERP.

---

## TECH-6 — Thời gian từng trang, và chỗ thời gian nằm

Công cụ tách **đầu phản hồi** (byte đầu tiên) khỏi **thân** (phần mang dữ liệu). Chênh lệch giữa
hai cột ấy là phần đáng nhìn nhất của lượt đo này.

### Mười trang chậm nhất

| Trang | Payload | Đầu phản hồi | Thân | Tổng |
|---|---|---|---|---|
| `/data-quality?issue=unlinked-shipment` | 610 kB | **866 ms** | **53,1 s** | 53.979 ms |
| `/cod?recon=unproven` | 407 kB | **91 ms** | **30,2 s** | 30.243 ms |
| `/customers` | 243 kB | **111 ms** | **24,6 s** | 24.690 ms |
| `/ads` | **5.840 kB** | **1.803 ms** | 20,7 s | 22.501 ms |
| `/cod` | 407 kB | **96 ms** | 18,2 s | 18.263 ms |
| `/cod?recon=stale` | 407 kB | 176 ms | 10,6 s | 10.742 ms |
| `/reports/cashflow` | 220 kB | — | — | 9.448 ms |
| `/reports/returns` | 597 kB | 598 ms | 8,8 s | 9.425 ms |
| `/products` | 235 kB | **96 ms** | 8,7 s | 8.840 ms |
| `/landing` | **2.911 kB** | **89 ms** | 5,2 s | 5.300 ms |

Còn `/reports/scenario` 3.405 ms · `/inventory/returns` 3.888 ms · `/cs?view=theo-case` 2.405 ms ·
`/ads/daily` 2.122 ms · `/data-quality?issue=return-not-received` 2.037 ms ·
`/inventory/planning` 2.013 ms.

### Hình dạng lặp lại ở gần như mọi trang chậm

**Đầu phản hồi dưới 200 ms, thân hàng chục giây.** `/cod?recon=unproven` trả byte đầu sau 91 ms
rồi mất thêm **30 giây** cho phần thân — tỷ lệ 1 : 332.

Ngoại lệ duy nhất là `/ads`: đầu phản hồi **1.803 ms**, và payload **5,8 MB** — lớn gấp 14 lần
trang trung bình.

### Payload lớn nhất

`/ads` 5.840 kB · `/landing` 2.911 kB · `/inventory/returns` 1.622 kB · `/shipments` 1.333 kB ·
`/inventory/receipts` 1.204 kB.

`/shipments` 1.333 kB nhưng chỉ **545 ms** — payload lớn tự nó không làm trang chậm.

### Các trang nhanh, để đối chiếu

`/` 201 ms · `/orders` 203 ms · `/shipments` 545 ms · `/tech/tasks` 601 ms · `/payroll` 622 ms.
Tổng cộng 45 trong 59 tuyến đo được nằm dưới ngưỡng 2 giây.

---

## TECH-9 — Sức khoẻ máy chủ

### Dịch vụ

Bốn container ERP đều `Up`; `erp-db` báo `healthy`. `/api/health` trả `ok:true`, commit `9b9c0a06`.
`erp-app` và `erp-scheduler` mới dựng lại 2 giờ trước; `erp-db` và `erp-caddy` đã chạy 2 tuần.

### Tài nguyên

Số liệu ở khối cảnh báo đầu tệp. Thêm: ổ đĩa **65 %** đã dùng (26 GB / 39 GB), còn 14 GB.
Docker giữ 16,86 GB ảnh, trong đó **10,68 GB (63 %) thu hồi được**, cộng 2,29 GB build cache.

### Lỗi trong 500 dòng log gần nhất — 7 dòng

Hai loại, và chúng khác nhau:

```
erp-app | [Error: Failed to find Server Action "60fdd351b110…".
          This request might be from an older or newer deployment.
```

```
erp-caddy | "aborting with incomplete response" · upstream app:3000
            uri /_next/static/chunks/4798-….js   error "reading: context canceled"
            uri /inventory/receipts?_rsc=…       error "reading: context canceled"
```

Cả hai dòng Caddy mang `Referer: /inventory/receipts` và cùng một `remote_ip`.

### Về lần deploy FAILED `82817d71d853` mà đề bài TECH-9 hỏi

**Lượt đo này KHÔNG có bằng chứng nào nối nó với các dấu hiệu trên.** Đề bài yêu cầu
*"nếu không có bằng chứng thì ghi thẳng là không liên quan"* — nhưng "chưa tìm thấy bằng chứng
trong 500 dòng log gần nhất" **không** giống "không liên quan", nên tệp này dừng ở câu thứ nhất.

---

## Những gì tệp này KHÔNG kết luận

- **Không** nói vì sao thân chậm. Tỷ lệ đầu-phản-hồi / thân chỉ ra thời gian nằm ở phần chờ dữ
  liệu, chứ không chỉ ra **truy vấn nào** — đó là việc của TECH-7, và nó phải kèm plan làm bằng chứng.
- **Không** đếm số truy vấn mỗi lần tải, không đo số lần fetch khi đổi bộ lọc, không kiểm có
  refetch thừa hay render lại toàn bảng không, không mô tả ranh giới server/client component.
  TECH-6 đòi cả bốn; lượt đo này **không có**, và đó là chỗ trống phải nói ra chứ không lấp bằng
  suy đoán. Bốn thứ ấy cần một trình duyệt thật, `ops verify` không có.
- **Không** đo connection pool, không đo cold start từng tuyến, không kiểm job đồng bộ Viettel
  Post / Pancake có trùng giờ cao điểm không. TECH-9 đòi cả ba; lượt đo này chưa có.
- **Không** coi các con số trên là nền so sánh. Máy đang bão hoà — xem khối cảnh báo đầu tệp.

---

## Nguồn

Toàn văn phần smoke nằm ở `docs/perf/TECH-6-smoke-tho-2026-09-23.txt` cùng thư mục — **81 dòng,
đủ 59 tuyến**, để đọc lại số gốc mà không phải tin bảng tóm tắt ở trên.

Tệp ấy đã LỌC trước khi vào kho: log gốc còn có dòng Caddy mang **địa chỉ IP thật của người dùng**
và tiêu đề cookie. Kho mã này PUBLIC (AGENTS.md mục 5).

**Vì sao thêm tệp thô, sau khi bản tóm tắt đã có:** bảng "Mười trang chậm nhất" ở trên CỐ Ý chỉ
liệt kê trang chậm, nên `/orders` — nhanh, 203 ms — chỉ có mặt ở dòng văn xuôi và **không kèm
kích thước phản hồi**. Ngày 23/09 tôi đưa cho agent con số `/orders 276 kB` trong một lượt phản
hồi review; agent TỪ CHỐI dùng nó, và nó đúng: con số ấy không có trong tệp nó được chỉ tới. Nó
nằm ở đầu ra thô mà tôi chưa bao giờ đưa vào kho.

Một con số chỉ dùng được khi nó ĐỌC LẠI ĐƯỢC. Tệp thô này làm cả 59 tuyến trích dẫn được.

Lượt chạy `ops verify` số **35817182554**. Toàn văn đầu ra nằm trong log của lượt chạy ấy trên
GitHub Actions.
