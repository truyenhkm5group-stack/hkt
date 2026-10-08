# RUNBOOK SỰ CỐ DỮ LIỆU CÁ NHÂN — M-INCIDENT (khung)

> 09/10/2026 · phiên bản 0.1 · mission M-INCIDENT phần tài liệu, ô P0-8 của `LEGAL_LAUNCH_GATE.md`; khung từ
> `VIETNAM_LEGAL_COMPLIANCE.md` §13. Đây là **cơ chế để có thể thông báo đúng hạn** (nghĩa vụ NĐ 356 Điều 28–29 theo bản
> đọc Phase 1) — KHÔNG phải ý kiến pháp lý, KHÔNG khẳng định đã tuân thủ. Mốc thời gian nào chưa có căn cứ thì ghi là mục
> tiêu nội bộ chờ duyệt, không ghi như luật.
> Người trực sự cố: **CHƯA CHỈ ĐỊNH** (F). Bảng `platform_incidents` chưa có (P1-15) — biên bản tạm theo mục 6.

## 1. Năm loại sự cố

| Mã | Loại | Ví dụ trong hệ thống này |
|---|---|---|
| I-1 | Sự cố dữ liệu cá nhân chung | Truy cập trái phép CSDL / VPS; bản sao lưu lộ; log mang dữ liệu khách công khai (tiền lệ: `docs/security-2026-09-24-ops-log-leak.md`) |
| I-2 | Lộ dữ liệu giữa tổ chức | Tổ chức A thấy hội thoại / đơn / khách của tổ chức B (sai `getDb()`, đệm dùng chung, webhook ghép nhầm page) |
| I-3 | Lộ token / secret | `PLATFORM_SECRETS_KEY`, khoá AI, page token, token Viettel Post, secret GitHub in ra log / commit (kho PUBLIC) |
| I-4 | Gửi nhầm người nhận | Tin đơn (tên · SĐT · địa chỉ) tới nhóm Telegram / Lark / Zalo Bot sai; bot trả lời vào hội thoại của người khác |
| I-5 | AI rò rỉ | Bot đưa dữ liệu của khách khác vào câu trả lời; lộ system prompt chứa dữ liệu khách cũ; nội dung gửi tới bên AI ngoài phạm vi đã khai (`lib/constants/legal-registers.ts`) |

## 2. Mức độ

| Mức | Khi nào | Ai được báo ngay |
|---|---|---|
| SEV-1 | Dữ liệu cá nhân **đã** tới người không có quyền, HOẶC lộ giữa tổ chức (I-2), HOẶC secret cho phép đọc dữ liệu người (I-3) | Người trực + chủ sở hữu |
| SEV-2 | Có khả năng lộ nhưng chưa chứng minh có người đọc (log công khai, cấu hình sai đã sửa) | Người trực + chủ sở hữu |
| SEV-3 | Sai lệch không mang dữ liệu người (cảnh báo kỹ thuật, token đã hết hạn) | Người trực |

Thuộc diện «phải thông báo cơ quan» hay không **không do runbook quyết** — xem mục 5.

## 3. Các bước

| Bước | Việc | Mốc | Căn cứ của mốc |
|---|---|---|---|
| 0 | Phát hiện → mở biên bản (mục 6), ghi mốc phát hiện | T+0 | — |
| 1 | Phân loại: loại (mục 1), mức (mục 2), loại dữ liệu, ước số chủ thể, tổ chức bị ảnh hưởng, có dữ liệu nhạy cảm không | T+1h | Mục tiêu nội bộ đề xuất (§13) — **F duyệt** |
| 2 | Khoanh vùng (mục 4) | T+4h | Mục tiêu nội bộ đề xuất (§13) — **F duyệt** |
| 3 | Báo khách thuê bị ảnh hưởng | T+24h | Mục tiêu nội bộ đề xuất (§13); Chính sách §10 chỉ ghi «trong thời hạn pháp luật quy định»; khung DPA nháp ghi [24] giờ — **CHƯA QUYẾT** (F + G-10) |
| 4 | Thông báo cơ quan có thẩm quyền (nếu thuộc diện) | ≤ 72 giờ | Bản đọc Phase 1 NĐ 356 Điều 28–29 — **G-11 xác nhận** ngưỡng, mốc tính từ khi nào, mẫu, cơ quan nhận |
| 5 | Báo cáo sau sự cố | T+7 ngày | Mục tiêu nội bộ đề xuất (§13) — **F duyệt** |
| 6 | Giữ bằng chứng | ≥ 24 tháng | Đề xuất §13 — thời hạn chờ F + G (`lib/constants/retention.ts` loại AUDIT, chưa quyết) |

## 4. Khoanh vùng — dùng công tắc ĐANG có, không deploy

| Loại | Việc | Cơ chế có sẵn |
|---|---|---|
| I-2, I-5 | Đình chỉ tổ chức bị ảnh hưởng / gây lộ | `lib/platform/kill-switches.ts` (ACTIVE ⇄ SUSPENDED, ghi `platform_audit_log`, không xoá dữ liệu) |
| I-5 | Tắt AI của một tổ chức hoặc cả nền tảng | `lib/ai-usage/control.ts` (`setOrgAiControl`, `setPlatformAiEnabled`) |
| I-4 | Tắt kết nối Telegram / Lark / Zalo Bot của tổ chức | `lib/platform/kill-switches.ts` → `disableConnectionAsOperator` |
| I-3 | Xoay khoá mã hoá token kết nối | `lib/connectors/secrets.ts` (khoá hiện tại + khoá cũ); thu hồi page token / khoá AI ở bên cấp |
| I-3 | Secret GitHub / VPS | Xoay ở GitHub Secrets + `.env` VPS; deploy lại bằng workflow |
| I-1 | Log công khai | Xoá run log của Actions; kiểm lại `docs/security-2026-09-24-ops-log-leak.md` |

## 5. Quyết định thông báo

| Câu hỏi | Ai trả lời |
|---|---|
| Có thuộc diện phải thông báo cơ quan không, mẫu nào, gửi ai | G (G-11) — runbook chỉ chuẩn bị dữ kiện |
| Có báo khách thuê / chủ thể không, bằng câu chữ nào | F, theo ý kiến G |
| Khách thuê (Bên Kiểm soát) có nghĩa vụ riêng không — VNX hỗ trợ ra sao | G (G-3, G-10) |

Dữ kiện người trực phải có sẵn khi hỏi: loại dữ liệu (theo D1–D17 của `DATA_PROCESSING_REGISTER.md`), ước số chủ thể, tổ
chức, khoảng thời gian, bên nhận ngoài ý muốn, đã khoanh vùng gì, lúc nào.

## 6. Biên bản (tạm — cho tới khi có `platform_incidents`)

Một tệp `docs/security-<YYYY-MM-DD>-<tên>.md` theo tiền lệ 24/09: mốc phát hiện · loại · mức · phạm vi tổ chức · loại dữ liệu ·
ước số chủ thể · các mốc ở mục 3 (thực tế) · ai được báo, lúc nào · khoanh vùng · nguyên nhân · đóng.
**Không ghi dữ liệu người vào biên bản** (kho PUBLIC) — chỉ mã tổ chức, số đếm, loại.

## 7. Sự cố đang mở

| Sự cố | Trạng thái |
|---|---|
| 24/09/2026 — log GitHub Actions của kho PUBLIC có thể đã chứa dữ liệu khách và secret | Chờ luật sư đánh giá có phải thông báo không (G-11) |
