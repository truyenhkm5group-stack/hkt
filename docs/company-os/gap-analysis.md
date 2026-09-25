# Company OS — Phân tích khoảng trống

> Từng mục của yêu cầu "ERP all-in-one" (bản 25/09/2026), xếp loại theo audit
> (`current-state-audit.md`). **KEEP** giữ · **FIX** sửa lỗi/hở · **EXTEND** mở rộng · **BUILD** xây mới ·
> **DEFER** để sau có lý do. Cột "Ai" là agent trong `parallel-work-plan.md`.

## 1. Bảng xếp loại

| # | Yêu cầu | Loại | Việc cụ thể | Ai | Ưu tiên |
|---|---|---|---|---|---|
| 2 | Mẫu là trục, định danh ổn định | **BUILD** | sổ `product_models` dùng mã chủ shop, nối `products` + `design_concepts` | A | P0 |
| 3 | Máy trạng thái vòng đời + lịch sử | **BUILD** | `model-lifecycle.ts`, lịch sử append-only, `transitionModelCore` | A | P0 |
| 4 | Hệ sự kiện | **BUILD** | `domain_events` + `emitDomainEvent` + sổ khai tên | A | P0 |
| 5 | Creative / R&D: nguồn, tài sản, metadata | KEEP | đã có đủ trừ video | — | — |
| 5 | Thư viện creative lọc theo mẫu/ngày | EXTEND | lọc ở tab thư viện | B | P1 |
| 5 | Video | DEFER | chưa có nhà cung cấp video; chủ shop chưa chọn | — | — |
| 5 | `/ideas` nối mẫu | EXTEND | ý tưởng → đăng ký mẫu IDEA | A2 | P1 |
| 6 | Chuỗi MODEL→creative→post→campaign→adset→ad | EXTEND | có đến ad; thiếu nối mẫu. Sửa đếm đơn creative qua `ORDER_AD_ID` | B | P1 |
| 6 | Chỉ số CPM/CTR/CPC/CPO/ROAS/lợi nhuận | KEEP | `buildDecisionRow`, `/ads/daily` | — | — |
| 6 | Adset/ad trên `/ads/daily` in "chưa biết" | **FIX** | bật chi tiêu theo độ mịn ad | B | P1 |
| 7 | Chấm thắng/thua giải thích được | EXTEND | `getModelSignal` GỘP phán quyết có sẵn, không thêm ngưỡng | A2 | P1 |
| 7 | Rào scale: trần, %, người duyệt | KEEP | đã có; 4 trần chờ chủ shop xác nhận | — | HUMAN GATE |
| 8 | Tự tạo Production Topic khi thắng | BUILD (đề xuất) | máy đẩy việc `MODEL_SUGGESTION`, người bấm tạo topic | C + A2 | P1 |
| 8 | Topic + trao đổi có lịch sử | **BUILD** | `production_topics` + tin nhắn append-only | C | P1 |
| 9 | Costing có phiên bản | **BUILD** | `cost_sheets` + dòng; FINAL bất biến; đẩy sang giá ước tính | C | P1 |
| 10 | Lợi nhuận ước tính vs thực | EXTEND | có cả hai; thiếu CẠNH NHAU theo mẫu + ảnh chụp dự phóng | F | P3 |
| 10 | CPO hoà vốn, trần QC/đơn, biên/đơn | EXTEND | có ở báo cáo danh nghĩa; đưa lên `/ads` + trang 360 | F | P1 |
| 11 | Sample V1/V2 + duyệt | **BUILD** | `samples`, `sample_reviews` | C | P1 |
| 11 | Bản thiết kế duyệt bất biến | **BUILD** | `design_versions`; PO tham chiếu (cờ) | C | P1 |
| 12 | Kế hoạch: gợi ý máy vs số người + lý do | EXTEND | có gợi ý; lưu `suggested_cells` + `override_reason` | C | P1 |
| 12 | Dự báo 3/7/14/30 ngày | DEFER | máy hiện dùng tốc độ, có backtest; mô hình dự báo cần dữ liệu tích luỹ | — | — |
| 13 | Lệnh sản xuất | EXTEND | có `production_orders` + sổ xưởng; thêm liên kết bản duyệt; KHÔNG thay | C | P1 |
| 13 | Số kế hoạch/xác nhận/SX/nhận/lỗi/hỏng + chênh lệch | CONSOLIDATE | đọc gộp PO + lô + `production_deliveries` | C | P2 |
| 14 | Mua vải/vật tư | KEEP (vải) / DEFER (BOM) | yêu cầu tự ghi không cần MRP phase đầu | — | — |
| 15 | Trạng thái tồn nhiều ngăn | EXTEND | ngăn DẪN XUẤT: đang hoàn, chờ kiểm, hỏng | D | P2 |
| 15 | Sổ kho append-only / audit được | **FIX** | xoá phiếu: chặn phiếu RETURN đã gắn kiểm hoàn, qua duyệt hai bước, ảnh chụp trước khi xoá | D | P0 |
| 15 | Chuyển động ORDER_RESERVATION/SHIPMENT_OUT | KEEP (dẫn xuất) | luật 10: đã chốt/đã xuất tính từ đơn + vận đơn | — | — |
| 16 | Không âm kho im lặng | **FIX** | tổng trang chủ tách dòng âm | D | P0 |
| 16 | Backorder / chờ hàng | KEEP | luật 70 | — | — |
| 17 | VTP, nhật ký trạng thái | KEEP | đầy đủ, append-only | — | — |
| 18 | Hoàn: quét, tra tay | KEEP | — | — | — |
| 18 | Kết quả SỬA LẠI / HUỶ | EXTEND | thêm kết quả, nối sổ kho | E | P2 |
| 19 | Chỉ số tồn thông minh | EXTEND | có; ngưỡng chậm/chết vào settings; thêm HOT + sell-through | D | P2 |
| 19 | Hai định nghĩa tốc độ bán | CONSOLIDATE | chọn một, đo trước/sau | D | P2 (cần đo production) |
| 20 | Máy đặt lại | KEEP | `computePlan` + `decideInventory`; chỉ ĐỀ XUẤT | — | — |
| 21 | Xả tồn nối về creative/ads | **BUILD** | đề xuất creative/ads đọc CLEARANCE/STOCKOUT_RISK | B + H | P4 |
| 22 | Trang Model 360 | **BUILD** (khung) → EXTEND | `/models/[id]` khung + dòng thời gian (A); các khối (A2) | A, A2 | P0/P1 |
| 23 | Cockpit chủ shop | EXTEND | khối "Cần anh quyết" + lưu quyết định đề xuất | H | P4 |
| 24 | Control plane, agent có trách nhiệm | KEEP/EXTEND | Tech room có; phòng khác theo thang luật 69 | — | P4 |
| 25 | Universal tasks | KEEP | `work_items` + nguồn mới | G, C | P0/P1 |
| 26 | Human gates | **FIX** | `approval_requests` không tiêu thụ được yêu cầu đã duyệt; thêm nguồn việc APPROVAL; quyền `approvals:decide` | G | P0 |
| 27 | Audit đủ who/what/when/source/before/after/reason/correlation | EXTEND | cột `actor_kind`, `correlation_id`, `reason` | G | P0 |
| 28 | Học có cấu trúc | DEFER | dữ liệu đã có trong `creative_learnings`, `ads_decision_ledger`; bộ dữ liệu mẫu sau khi có vòng đời | — | P4 |
| 33 | Kiểm thử E2E vòng đời | **BUILD** | một kịch bản PGlite đi qua mọi module | QA | P1 (sau C) |
| 34 | Quan sát job | **FIX** | 5 job không ghi `sync_runs` | G | P0 |
| 35 | Idempotency | KEEP | + `dedupe_key` cho sự kiện | A | P0 |
| 36 | Thông báo chỉ khi cần người | EXTEND | tin gửi lỗi không thử lại | — | DEFER |
| 37 | Phân quyền VIEW/EDIT/APPROVE | EXTEND | khoá mới mục 4 hợp đồng | A, C, G | P0/P1 |

## 2. Đường găng (critical path)

```
A: sổ mẫu + vòng đời + domain_events + /models khung  ──┐
                                                         ├──▶ C: topic → costing → sample → bản duyệt → PO
G: duyệt hai bước dùng được + audit cột + sync_runs  ────┘        │
                                                                  ├──▶ A2: trang 360 đủ khối + tín hiệu mẫu
B/D/F: hàm đọc theo mẫu (ads, creative, tồn, kinh tế) ────────────┘        │
                                                                           ├──▶ QA: E2E vòng đời
                                                                           └──▶ H: cockpit "Cần anh quyết"
```

Chỉ A nằm trên đường găng của Wave 1: C cần `product_models` và `transitionModelCore`. B, D, F, G độc
lập với A (chỉ THÊM hàm đọc hoặc SỬA lỗi trong miền của mình) nên chạy song song ngay.

## 3. Những điều chủ shop phải quyết (HUMAN GATE)

1. **Bật `production.requireApprovedDesign`** (PO bắt buộc trỏ bản thiết kế đã duyệt) — sau khi C xong
   và có ít nhất vài mẫu đi hết luồng sample.
2. **Bật `approval.enforce`** (duyệt hai bước thật sự chặn) — G làm màn hình bật, người bật là chủ shop.
3. **Xác nhận 4 trần ghi ngân sách QC + trần 5M/ngày nhân bản mẫu thắng** — đã có từ trước, vẫn chờ.
4. **Lịch chạy job `model-registry`** — AGENTS §7: đổi lịch scheduler cần hỏi. Tới khi có quyết định,
   sổ mẫu đồng bộ bằng nút trên `/models`.
5. **Chọn định nghĩa tốc độ bán duy nhất** (gộp hay ròng) — đổi số ngày phủ trên hai trang.
