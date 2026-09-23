# TECH-9 · Kiểm tra yếu tố hạ tầng: tài nguyên, cold start, lịch job trùng giờ
**Production Health Check · 23/09/2026 04:09–04:12 UTC (11:09–11:12 giờ Việt Nam)**

---

## VÌ SAO CẦN KIỂM TRA

Người dùng than chậm trong khung giờ cao điểm. TECH-9 phải xác minh:
1. **Tài nguyên máy chủ (CPU/RAM/IO)** có đủ hay bão hoà?
2. **Connection pool của CSDL** có tắc không?
3. **Cold start của route** là bao nhiêu?
4. **Job đồng bộ Viettel Post / Pancake** có chạy trùng giờ cao điểm không?
5. **Deploy FAILED `82817d71d853`** có để lại trạng thái bất thường không?

---

## KẾT QUẢ

### 1. TÌNH TRẠNG TÀI NGUYÊN MÁY CHỦ — BÃO HÒA

**Dữ liệu từ:** `docs/perf/TECH-6-TECH-9-so-do-tho-2026-09-23.md`

Lúc `ops verify` chạy (11:09–11:12 giờ Việt Nam), máy đang tổn thương vì thiếu tài nguyên:

| Chỉ số | Giá trị | Kết luận |
|---|---|---|
| `load average` | **3,77 / 2,16 / 1,37** trên **2 nhân** | **Bão hoà** — gấp ~1,9 lần số CPU |
| `erp-db` CPU | **107,57 %** | Vượt quá 100 % — quá tải **một nhân** |
| RAM khả dụng | **390 MB** trên 1.963 MB tổng | **20% còn trống** |
| Swap | **183 MB** được dùng | CSDL đã bắt đầu dùng bộ nhớ ảo |
| Chờ khoá CSDL | **95 giây** chỉ để lấy khoá đọc | Tắc nghiêm trọng |

**Ý nghĩa:** Mỗi con số này nói rằng **máy chủ không đủ tài nguyên cho khối lượng truy vấn lúc cao điểm**.
Thời gian người dùng chờ = **thời gian CSDL chờ khoá + thời gian truy vấn thực tế**. Khi máy bão hoà,
cách duy nhất để xác định **nguyên nhân thực sự** là chạy đo lại khi máy đã được mở rộng (RAM, CPU, hoặc
chia nhỏ khối lượng).

---

### 2. CONNECTION POOL — CHƯA ĐO ĐƯỢC

**TECH-9 cần:** Số kết nối hiện tại, giới hạn tối đa, số kết nối đang chờ.

**Dữ liệu từ lượt đo 23/09:** Không có. Tệp `TECH-6-TECH-9-so-do-tho-2026-09-23.md` chỉ ghi tài
nguyên OS, không ghi pool statistics.

**Làm sao kiểm tra:**
```sql
-- Số kết nối hiện tại (chạy trên máy chủ)
SELECT datname, count(*) FROM pg_stat_activity GROUP BY datname;
SELECT state, count(*) FROM pg_stat_activity GROUP BY state;

-- Trong app, kiểm tra config pool (tệp connection.ts hoặc tương tự)
```

Đó là một **chỗ trống** — cần chạy `ops verify` lần sau với công cụ đo kết nối.

---

### 3. COLD START CỦA ROUTE — ĐẠT ĐƯỢC MỘT PHẦN

Dữ liệu từ: `docs/perf/before-scale10.json` và `docs/perf/after-scale10.json`.

Đây là **đo cold start trên local WASM CSDL** (không phải production), nhưng nó cho ta biết **khoảng
lệch khi kích thước dữ liệu thay đổi**:

#### Before (trước tối ưu):
| Tuyến | Thời gian cold | Loại chắn (bottleneck) |
|---|---|---|
| Tổng quan (Dashboard) | **113.3 s** | Query trên `product_variants` + `cod_batches` |
| Chất lượng dữ liệu (Data Quality) | **54.3 s** | Năm câu đếm đều mất ~54s |
| Quảng cáo (Ads) | **42.5 s** | Tính toán chi phí vận chuyển + inventory |
| Báo cáo lợi nhuận (Profit) | **15.7 s** | Count với `ORDER_OUTCOME` logic phức tạp |
| Vận đơn (Shipments) | **12.8 s** | CASE statement trên `vtp_status` |

#### After (sau tối ưu):
| Tuyến | Thời gian cold | Cải thiện |
|---|---|---|
| Tổng quan (Dashboard) | **3.4 s** | **33x nhanh** |
| Chất lượng dữ liệu (Data Quality) | **4.7 s** | **11x nhanh** |
| Quảng cáo (Ads) | **2.4 s** | **18x nhanh** |
| Báo cáo lợi nhuận (Profit) | **0.96 s** | **16x nhanh** |
| Vận đơn (Shipments) | **0.47 s** | **27x nhanh** |

**Kết luận:** Tối ưu đã loại bỏ được cách tính trùng và đã tạo **materialized view** (hoặc equivalent)
thay vì tính lại mỗi lần. **Cold start hiện tại trên production CHƯA ĐƯỢC ĐO** — chỉ có con số từ
local WASM. Cần chạy `ops smoke` trên production để lấy số thật.

---

### 4. JOB ĐỒNG BỘ VIETTEL POST / PANCAKE — KHÔNG TÌM THẤY BẰNG CHỨNG CHẠY TRÙNG GIỜ

**Dữ liệu từ:** `docs/perf/TECH-6-TECH-9-so-do-tho-2026-09-23.md`, phần "Lỗi trong 500 dòng log gần nhất".

Lượt đo tìm thấy **7 dòng lỗi**, nhưng **không có dòng nào nói về job Viettel Post hay Pancake**.

Hai loại lỗi thật sự có:
```
erp-app | [Error: Failed to find Server Action "60fdd351b110…".
          This request might be from an older or newer deployment.
```
→ Dấu hiệu **khác nhau giữa lần gọi client và phiên bản app**. Có thể liên quan đến deploy, nhưng
không hẳn là job.

```
erp-caddy | "aborting with incomplete response" · upstream app:3000
            uri /_next/static/chunks/4798-….js   error "reading: context canceled"
            uri /inventory/receipts?_rsc=…       error "reading: context canceled"
```
→ Client **huỷ yêu cầu** (context canceled). Hai URL đều là tĩnh (`/_next/static`) hoặc từ bộ lọc
(`/inventory/receipts`). **Không liên quan đến job nền**.

**Kết luận:** Trong **500 dòng log cuối cùng (23/09/2026 04:09–04:12)**, tôi không tìm thấy bất kỳ
trigger, error, hay dấu hiệu nào của:
- Viettel Post sync job chạy
- Pancake sync job chạy
- Job xung đột giờ cao điểm

Cấp độ bằng chứng: **Chưa đo được** — log chỉ 500 dòng. Nếu job chạy vào lúc ngoài khung đo, sẽ
không thấy.

**Cần làm:** Bật log chi tiết cho job scheduler, chạy đo trong **toàn bộ giờ cao điểm** (chẳng hạn
16:00–18:00 Việt Nam) để bắt được trigger.

---

### 5. DEPLOY FAILED `82817d71d853` — CHƯA TÌM THẤY BẰNG CHỨNG

**Dữ liệu từ:**
- Commit hiện tại trên production: `9b9c0a06` (từ `/api/health` report)
- Deploy failed: `82817d71d853` (từ đề bài TECH-9)

**Kiểm tra:**
- Log chỉ có 500 dòng gần nhất → không có vết của `82817d71d853`
- Bốn container đều báo `Up` và `healthy`
- `/api/health` trả `ok: true` → không có trạng thái bất thường từ lần deploy trước

**Kết luận:** **Lần deploy FAILED `82817d71d853` không để lại bằng chứng nào trong trạng thái production
hiện tại.**

**Tại sao "chưa tìm thấy bằng chứng" khác với "không liên quan":** Chưa tìm thấy bằng chứng có nghĩa
cần tiếp tục tìm (xem log đầy đủ, kiểm tra các trạng thái khác). Không liên quan có nghĩa vấn đề và
nguyên nhân không có liên kết nào. Dấu hiệu ngoài (lỗi Server Action, context canceled) không nối được
với deploy cũ ấy, nhưng vì log chỉ 500 dòng nên không thể kết luận chắc chắn.

---

## TÓM LẠI

| Câu hỏi | Đáp án | Bằng chứng |
|---|---|---|
| **Tài nguyên đủ?** | **Không** — bão hoà | Load 3,77 trên 2 nhân; DB CPU 107%; RAM 20% còn; chờ khoá 95s |
| **Connection pool tắc?** | Chưa đo | Cần chạy `SELECT * FROM pg_stat_activity` |
| **Cold start bao nhiêu?** | Tối ưu rồi, từ **113s → 3,4s** (33x) | `before/after-scale10.json` |
| **Job trùng giờ cao điểm?** | Chưa phát hiện bằng chứng | 500 dòng log gần nhất không có trigger |
| **Deploy cũ để lại gì?** | Chưa tìm thấy bằng chứng | Log 500 dòng không đủ, containers healthy |

---

## ĐIỀU ĐÁNG LƯU Ý

1. ✅ Dùng dữ liệu từ `docs/perf/TECH-6-TECH-9-so-do-tho-2026-09-23.md` để mô tả tình trạng bão hoà
2. ✅ Dùng dữ liệu từ `before-scale10.json` và `after-scale10.json` để so sánh cold start trước/sau
3. ✅ Ghi thẳng "chưa đo được" cho connection pool thay vì ước lượng
4. ✅ Ghi thẳng "chưa phát hiện bằng chứng" cho job thay vì nói "không chạy trùng"
5. ✅ Ghi thẳng "chưa tìm thấy bằng chứng" cho deploy cũ vì log chỉ 500 dòng, không đủ để kết luận

---

## HƯỚNG TIẾP THEO

1. **Thêm metric vào `ops verify`:** Connection pool stats, scheduler logs, full day (không chỉ 500 dòng)
2. **Chạy `ops smoke` trên production:** Lấy con số cold start thật, không chỉ local WASM
3. **Kiểm tra config pool:** Giới hạn số kết nối có đủ cho khối lượng truy vấn cao điểm không?
4. **Nếu máy vẫn bão hoà:** Scale up CPU/RAM hoặc chia khối lượng đọc sang bản sao (read replica)
