# JIT bật / JIT tắt — số đo production, 23/09/2026

**Đây là SỐ ĐO, kèm đúng một kết luận mà số đo chứng minh được.** Phần còn lại ghi là ứng viên
chưa đo.

**Cách đo:** `ops perf-probe` (chỉ đọc), lượt chạy `35873756396`, ngay sau deploy commit
`1b5ec49c`. Với mỗi câu trong ba câu chậm nhất: chạy `EXPLAIN (ANALYZE, BUFFERS, TIMING)` dưới hai
điều kiện, **xen kẽ** bật–tắt–bật–tắt, **3 lượt mỗi bên**, lấy trung vị.

- **JIT mặc định** — như công cụ đo cũ.
- **JIT tắt** — `begin; set local jit = off; … rollback`, tức **đúng** câu mà `chayKhongJit()`
  (`db/index.ts`) phát ra, không thêm không bớt.

---

## Ba câu chậm nhất

| # | Đường ứng dụng thật | JIT bật (trung vị) | JIT tắt (trung vị) | Phần do JIT |
|---|---|---|---|---|
| 1 | **19.945 ms** | 8.425 ms `[8.425 · 8.383 · 8.575]` | **43 ms** `[43 · 39 · 66]` | **99 %** |
| 2 | **19.720 ms** | 10.650 ms `[10.924 · 8.880 · 10.650]` | **39 ms** `[63 · 39 · 37]` | **100 %** |
| 3 | **11.366 ms** | 8.507 ms `[9.087 · 8.040 · 8.507]` | **37 ms** `[37 · 37 · 49]` | **100 %** |

Cả ba cùng một hình dạng: `select count(*) filter (where coalesce((select m.outcome from
canonical_order_outcome m …`.

Khối `JIT:` của lượt bật, câu #1:

```
Functions: 672
Timing: Generation 70.778 ms, Inlining 98.823 ms, Optimization 4512.006 ms,
        Emission 3667.915 ms, Total 8349.523 ms
```

**Thời gian là Postgres BIÊN DỊCH câu lệnh, không phải chạy nó.** Tắt JIT, cùng câu chạy trong
~40 ms.

---

## Kết luận duy nhất mà số đo chứng minh được

**Ba câu này chạy trên đường ứng dụng thật mà KHÔNG tắt JIT.**

Cột "đường ứng dụng thật" (11–20 s) khớp với JIT **bật** (8–11 s, cộng tranh chấp trên máy 2 nhân),
không khớp với JIT tắt (~40 ms — muốn ra 20 s thì phải chậm đi 460 lần vì tranh chấp, không hợp
lý). Và mã nguồn xác nhận:

| Hàm (trang) | Thời gian hàm | Câu phát ra ở | Tệp có dùng `chayKhongJit`? |
|---|---|---|---|
| `getScorecard` (`/work/okr`) | 19.967 ms | `outcomeAggregate` | **KHÔNG** |
| `listObjectives` (`/work/okr`) | 11.428 ms | `outcomeAggregate` | **KHÔNG** |

`outcomeAggregate` ở `lib/queries/metric-resolver.ts` bị gọi **năm lần** mỗi lượt tải — tỷ lệ giao,
tỷ lệ hoàn, doanh thu, giá vốn, biên lợi nhuận — mỗi lần biên dịch lại từ đầu. `getScorecard` cộng
dồn **71 giây** thời gian CSDL cho một lượt tải trang.

→ Đã sửa: bọc câu ấy trong `chayKhongJit`.

---

## Ứng viên CHƯA ĐO — cùng hình dạng, cùng thiếu `chayKhongJit`

**20 tệp** trong `lib/queries/` dùng biểu thức kết quả đơn (`COUNT_DELIVERED` · `COUNT_RETURNED` ·
`ORDER_OUTCOME_FAST` · `IS_DELIVERED`) mà không tắt JIT. Đối chiếu với bảng hàm chậm của cùng lượt
đo:

| Hàm | Thời gian | Tệp |
|---|---|---|
| `getReturnIntelligence 90d` | 12.910 ms | `return-intelligence.ts` |
| `listCustomers` | 8.910 ms | `customers.ts` |
| `getReturnReasonReport 90d` | 4.979 ms | `return-reason-report.ts` |
| `codSettlementSummary` | 3.555 ms | `cod-settlement.ts` |

**Đây là TƯƠNG QUAN, không phải phép đo.** Chậm + thiếu `chayKhongJit` + cùng hình dạng biểu thức
thì đáng ngờ, nhưng chưa chạy EXPLAIN bật/tắt cho câu nào trong số này. Không phải mọi câu dùng
biểu thức kết quả đơn đều bị JIT biên dịch: Postgres chỉ bật JIT khi chi phí ước lượng vượt ngưỡng,
và một câu tra MỘT đơn thì không vượt. Sửa theo tương quan là đúng lỗi đã bắt đặc tả TECH-10 sửa
hôm nay.

---

## Những gì tệp này KHÔNG kết luận

- **Không** nói trang nào sẽ nhanh bao nhiêu sau bản vá. Đo lại sau deploy mới biết.
- **Không** nói JIT là nguyên nhân của các trang chậm khác (`/cod`, `/customers`, `/data-quality`…).
  Chúng nằm ở bảng ứng viên, chưa đo.
- **Không** đề xuất tắt JIT cho toàn CSDL. `chayKhongJit` tắt theo TỪNG giao dịch — có chủ đích:
  câu ngắn chạy nhiều lần có thể hưởng lợi từ JIT, và chưa ai đo điều ngược lại.
