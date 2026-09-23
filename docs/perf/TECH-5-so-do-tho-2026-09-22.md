# TECH-5 · Số đo thô phía máy chủ — production, 22/09/2026

**Đây là SỐ ĐO THÔ, không phải kết luận.** Tệp này chỉ chép lại thứ `ops perf-probe` đo được trên
dữ liệu thật, để TECH-5 và TECH-7 có căn cứ mà phân tích. Phần suy luận nằm ở tài liệu của hai việc
đó, không nằm ở đây.

**Cách đo:** `ops perf-probe` (chỉ đọc) trên production, lượt chạy `35756…`, 22/09/2026.
Công cụ chạy `EXPLAIN (ANALYZE, BUFFERS, TIMING)` trên các truy vấn của những trang chậm.

---

## Tám câu chậm nhất — thời gian đo được

| Hạng | Thời gian | Câu lệnh (rút gọn) |
|---|---|---|
| 1 | **24.921 ms** | gộp sản phẩm/mẫu mã: `order_items` + `products` + `orders`, `count(distinct orders.id)` |
| 2 | 24.456 ms | `EXPLAIN` của chính câu trên |
| 3 | **9.227 ms** | CTE `don as (…)` với `CASE` dài trên `shipments.vtp_status` |
| 4 | **8.866 ms** | `count(*) filter (where ORDER_OUTCOME …)` |
| 5 | 8.828 ms | *(cùng hình dạng hạng 4)* |
| 6 | 8.693 ms | *(cùng hình dạng)* |
| 7 | 8.092 ms | *(cùng hình dạng)* |
| 8 | 8.086 ms | *(cùng hình dạng)* |

**Năm trong tám câu chậm nhất cùng một hình dạng:** `count(*) filter (where ORDER_OUTCOME …)`.

---

## Hai kế hoạch thực thi — nguyên văn phần quan trọng

### Kế hoạch A — `Execution Time: 8051 ms`

```
Aggregate                                                 actual time=7982.410..7982.446 rows=1
 └─ Hash Right Join                                       actual time=7949.022..7958.374 rows=1401
    Join Filter: ((NOT (SubPlan 156)) OR (shipments.id = (SubPlan 157)))
    ├─ Seq Scan on shipments   rows=2572                  actual time=0.025..1.851
    └─ Hash                                               actual time=7948.889..7948.890 rows=1401
       └─ Seq Scan on orders   cost=0.02..450.18 rows=1449  actual time=7946.141..7948.370 rows=1401
    SubPlan 156
     └─ Index Scan using shipments_order_idx on sh0       actual time=0.003..0.003 loops=1170
    SubPlan 157
     └─ Limit → Sort → Index Scan using shipments_order_idx  actual time=0.033 loops=85
    SubPlan 1
     └─ Index Scan using canonical_outcome_order_idx      actual time=0.003..0.003 rows=1
Planning Time: 15.085 ms
```

### Kế hoạch B — `Execution Time: 4665 ms`

```
 └─ Hash                                                  actual time=4195.424..4195.425 rows=1792
    └─ Seq Scan on orders  cost=0.00..441.64 rows=1885    actual time=4192.732..4194.858 rows=1792
 └─ Seq Scan on shipments  rows=2572                      actual time=0.033..2.351
Planning Time: 11.661 ms
```

---

## Ba con số đặt cạnh nhau — phần đáng nhìn nhất

| Phép quét | Số dòng | Thời gian |
|---|---|---|
| `Seq Scan on shipments` | **2.572** | **1,9 ms** |
| `Seq Scan on orders` (kế hoạch A) | **1.401** | **7.948 ms** |
| `Seq Scan on orders` (kế hoạch B) | **1.792** | **4.194 ms** |

Bảng `shipments` **nhiều dòng hơn** mà quét hết mất chưa tới 2 mili giây. Bảng `orders` **ít dòng
hơn** mà mất 4–8 **giây**. Chênh lệch ấy không giải thích được bằng việc đọc dòng.

Các `SubPlan` đều là Index Scan ở mức **0,003 ms**, nên chúng cũng không phải chỗ tốn.

---

## ⚠ BỔ SUNG 23/09/2026 — các thời gian EXPLAIN ở trên đo ĐƯỜNG CỦA CÔNG CỤ, không phải đường của người dùng

**Thiếu sót của tệp này, không phải của người đọc.** Khi viết tệp ngày 22/09 tôi đã biết điều dưới
đây mà không ghi vào. Việc TECH-10 (lượt chạy #48) dựng **ưu tiên số 1** — "thêm index
`orders.stage`, cải thiện 75 %" — lên con số `7.948 ms` ở trên, và cái bẫy nằm sẵn trong chính tệp
chứng từ nó được chỉ tới.

**Điều kiểm được:**

- `scripts/perf-probe.ts` chạy `pool.query("explain (analyze, buffers, timing) …")` **thẳng trên
  bể kết nối**, ngoài mọi giao dịch.
- Ứng dụng thì chạy các báo cáo này bên trong `chayKhongJit()` (`db/index.ts`), mở giao dịch với
  `set local jit = off`. `lib/queries/return-rate.ts` gọi nó ở **6** chỗ.

Tức là **thời gian EXPLAIN ở tệp này đo trong một điều kiện KHÁC với đường mà người dùng đi**: JIT
bật ở phía công cụ đo, tắt ở phía ứng dụng.

**Điều KHÔNG kiểm được — và phải nói ra:**

Tệp toàn văn `TECH-5-perf-probe-raw-2026-09-22.txt` chỉ có **47 dòng, đã bị CẮT**. Nó không có khối
`JIT:` nào. Nên **từ các tệp này không xác định được JIT góp bao nhiêu** vào `7.948 ms` — có thể phần
lớn, có thể không đáng kể. Đó là **CHƯA ĐO ĐƯỢC**, không phải "không có JIT".

**Hệ quả cho người dùng tệp này:**

1. Đừng dựng ưu tiên tối ưu trên riêng các thời gian EXPLAIN ở đây. Chúng chỉ ra **hình dạng** kế
   hoạch (Seq Scan, số `loops`, SubPlan nào chạy bao nhiêu lần) — vẫn đúng. Chúng **không** chỉ ra
   người dùng chờ bao lâu.
2. Người dùng chờ bao lâu thì đo bằng `ops smoke`, chạy **đúng đường ứng dụng** — xem
   `docs/perf/TECH-6-smoke-tho-2026-09-23.txt`.
3. Chính tệp này đã ghi ở trên: bảng `orders` **ít dòng hơn** mà chậm hơn `shipments` hàng nghìn
   lần, nên *"chênh lệch ấy không giải thích được bằng việc đọc dòng"*. Một index giảm số dòng phải
   đọc — tức nhắm đúng vào thứ mà dòng ấy nói **không phải** nguyên nhân.

Muốn trả lời câu JIT cho dứt điểm: chạy lại EXPLAIN **trong** `chayKhongJit`, giữ **nguyên văn đầy
đủ** kế hoạch (không cắt), và lấy trung vị 3–5 lượt — một mẫu trên máy 2 nhân đang phục vụ người
thật không nói được gì.

---

## Những gì tệp này KHÔNG kết luận

- **Không** khẳng định nguyên nhân. Ba con số trên nói rằng chi phí nằm ở phép quét `orders`, nhưng
  chỉ ra *biểu thức nào* trên từng dòng mới là việc của TECH-7 — và nó phải kèm plan làm bằng chứng.
- **Không** nói trang nào chậm bao nhiêu. `perf-probe` đo THỜI GIAN TỪNG TRUY VẤN, không đo thời
  gian dựng trang. Số "người dùng chờ bao lâu" phải lấy từ `ops smoke` (AGENTS.md — hai công cụ trả
  lời hai câu hỏi khác nhau).
- **Không** đếm số truy vấn mỗi lần tải trang, cũng không đo thời gian server action tổng. TECH-5
  đòi hai số đó; lượt đo này chưa có, và đó là một chỗ trống phải nói ra chứ không lấp bằng suy đoán.
- Câu chậm nhất (24,9 giây) là phép gộp `order_items` + `products`, **không phải** truy vấn của
  trang vận đơn. Nó nằm ở đây vì nó là câu chậm nhất production đo được, không vì nó thuộc TECH-5.

---

## Nguồn

Toàn văn đầu ra của lượt đo nằm ở `docs/perf/TECH-5-perf-probe-raw-2026-09-22.txt` cùng thư mục.
