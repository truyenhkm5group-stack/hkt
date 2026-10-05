# Đối chiếu «Master Mission — AI Sales Agent SaaS» với kho mã thật

> Đo trên `origin/main` **317270ab** (05/10/2026). Tệp này là **kế hoạch sống DUY NHẤT** của lệnh Master Mission: mỗi
> yêu cầu của lệnh → thứ ĐÃ CÓ (trỏ tới mã) → khoảng trống THẬT → việc đang làm. Không viết lại những gì
> `docs/productization/*` đã ghi đúng — tệp này trỏ tới đó.

## 0. Kết luận một đoạn

Lệnh Master Mission phần lớn **trùng** với chương trình AI Sales Agent đã chạy từ 04/10/2026
(`docs/productization/00_EXECUTIVE_SUMMARY.md`, bảng Definition of Done 36 mục, 34 ĐẠT). Đã có: nền SILO
(mỗi tổ chức một CSDL) + bài tấn công cô lập, sổ sự kiện hội thoại `sales_conversation_events`, màn «Hiệu quả»,
bốn chế độ Quan sát · Copilot · Thử nghiệm AI vs Người · Tự động, phát lại hội thoại cũ, bộ hội thoại vàng, sổ chi
phí AI theo tổ chức, kinh tế SaaS (MRR/NRR…), hộp thư người trong ERP, Messenger / Instagram / Zalo / chat web.
**Không dựng lại cái nào.** Việc của lệnh này là đóng các khoảng trống thật dưới đây, theo thứ tự «số đúng trước,
tính năng sau».

## 1. Quyết định kiến trúc giữ nguyên (và vì sao lệnh nói khác)

| Lệnh nói | Thực tế | Quyết định |
|---|---|---|
| `tenant_id` trên mọi bảng (§7) | SILO: một CSDL mỗi tổ chức, mặt phẳng điều khiển `platform_*` ở CSDL nhà (`docs/platform/target-architecture.md`) | **Giữ SILO.** Cô lập là tính chất của kết nối; bài kiểm `tests/tenant-attack.test.ts`, `ai-sales-isolation.test.ts`, `platform-isolation*.test.ts` chứng minh. Không thêm `tenant_id` |
| Danh sách ~30 loại sự kiện (§10) | 18 loại có CHECK, mỗi loại có nguồn thật (`lib/sales-chatbot/events-shared.ts`) | Thêm loại **khi có nguồn ghi được**; không khai loại chưa ghi |
| Phễu 12 bước (§9) | Bước bot `QUOTE · CONSULT · INFO · UPSELL · CONFIRM · DONE · DECLINED` (`stages.ts`) + phễu dựng từ sự kiện (báo giá → SĐT → nháp → chốt) | Giữ; phễu dựng lại từ sổ sự kiện, không bắt nhân viên khai bước |
| Feature flag chung (§39) | Công tắc theo tổ chức: module/feature (`lib/platform/capabilities.ts`), chế độ vận hành, cấu hình `settings` | Không thêm hệ flag thứ hai; mỗi hành vi mới có công tắc trong cấu hình của nó, mặc định TẮT |
| Đổi tên điều hướng (§33) | Gói «Chỉ cần AI bán hàng» đã có menu gọn (#530) | Không đổi tên route |

## 2. Đối chiếu từng mảng

Ký hiệu: **CÓ** · **MỘT PHẦN** · **THIẾU** · **LỖI** (có nhưng sai số).

| Lệnh § | Mảng | Trạng thái | Ở đâu / khoảng trống |
|---|---|---|---|
| 7 | Đa tổ chức + cô lập | CÓ | SILO; TD-19 (ngữ cảnh rỗng rơi về nhà) còn mở — M9, đổi hành vi, chờ chế độ chỉ-ghi-log |
| 8 | Gói ngành | MỘT PHẦN | `lib/sales-chatbot/packs.ts` (food · fashion · generic) chỉ đổi câu ví dụ trong lời nhắc; bài học tự học còn ghi cứng «shop đồ ăn» (`lessons-shared.ts`) |
| 9–10 | Phễu + sổ sự kiện | CÓ | Thiếu nguồn cho: sản phẩm được xác định, kiểm tồn, địa chỉ (chỉ cờ trong payload), hẹn follow-up, khách trả lời follow-up, đơn huỷ / giao (đọc sống qua `ORDER_OUTCOME`, đúng — không cần sự kiện) |
| 12 | Quy kết doanh thu theo ĐƠN | **LỖI + THIẾU** | (a) đơn NHÂN VIÊN tạo trong khung chat (`lib/records/chat-order.ts`, `order.confirmed` actor HUMAN) bị đếm là «Đơn bot chốt», vào doanh thu AI và chi phí AI / đơn (`performance.ts`, `basket.ts`, ô lọc drill-down). (b) Chỉ có nhóm theo HỘI THOẠI (AI_ONLY / AI_THEN_HUMAN), chưa có nhãn mỗi ĐƠN AI_ONLY / AI_ASSISTED / HUMAN_ONLY. (c) Messenger trực tiếp: nhân viên trả lời trong Hộp thư Meta chuyển hội thoại sang người nhưng KHÔNG ghi `human.took_over` ⇒ hội thoại rơi vào nhóm «AI tự làm» |
| 13 | KPI lõi | MỘT PHẦN | Có: hội thoại, chốt, giao thành công + doanh thu (`ORDER_OUTCOME`), chuyển người, SĐT, upsell, bán chéo, chi phí AI / đơn. Thiếu: AOV, doanh thu / hội thoại, chi phí AI / hội thoại, doanh thu ÷ chi phí AI, thời gian người nhận handoff, **follow-up thu hồi** |
| 14–15 | Màn chủ shop «Hôm nay AI kiếm bao nhiêu» | THIẾU | Trang chủ tổ chức khách là danh sách cài đặt (`components/onboarding/getting-started.tsx`); số tiền nằm sâu ở `/ai/sales-chatbot/performance` |
| 16 | AI vs Người | CÓ | #547 theo nhánh thử nghiệm chia ngẫu nhiên; theo từng nhân viên chờ đủ dữ liệu hộp thư ERP |
| 17 | Lý do mất khách | THIẾU | `mark_declined` lưu chữ tự do; `ai_sales.objection_rate` khai UNAVAILABLE |
| 18 | Phát hiện lỗi AI + hàng đợi rà | THIẾU (chỉ offline) | `PRICE_UNGROUNDED` chỉ chạy khi phát lại (`replay-shared.ts`); không có kiểm trên lượt thật, không có hàng đợi |
| 19–20 | Hành vi bán + giá/tồn thật | CÓ | Công cụ không nhận giá từ model; lõi đơn tự tính lại giá (#525); chiết khấu cứng 0 |
| 21 | Ảnh khách gửi | CÓ (bot đa tổ chức đọc ảnh, `vision.ts`) | — |
| 22 | Handoff | CÓ | 14 mã lý do; thiếu thời gian người nhận |
| 23 | Upsell có kiểm soát | MỘT PHẦN | Mẫu câu upsell do shop chọn (máy chủ chặn nháp tới khi đã mời); không có bảng quan hệ sản phẩm / combo |
| 24 | Follow-up theo ý định | MỘT PHẦN | Hẹn giờ cố định 1h/6h/22h (`followup-shared.ts`), không phân loại «để suy nghĩ / đắt / cuối tháng»; **không đo thu hồi** |
| 25 | Trí nhớ khách | MỘT PHẦN | Ba mức tin (THREAD / FB_ID / PHONE) dựng lại mỗi lượt từ đơn/khách (`returning.ts`); không có sở thích suy ra (đúng — chưa có nguồn) |
| 29–30 | Thử nghiệm | CÓ (AI vs Người) | Chưa thử nghiệm câu chữ / lịch follow-up — **chưa làm khi số chưa tin được** (§46 Phase 6) |
| 31–32 | Trừu tượng nhà cung cấp + chi phí AI | CÓ | `AiProvider`, BYOK Anthropic/OpenAI/Gemini; `platform_ai_usage` theo tổ chức × tính năng × `ref` = hội thoại |
| 34–35 | Đăng ký + kiểm tra sẵn sàng | MỘT PHẦN | `/start` + nối fanpage một nút; **không có cổng hành vi** (giá, sổ tay, kết quả phát lại) trước khi bật Tự động |
| 36 | Bản tin hằng ngày | THIẾU | Cần KPI đúng trước |
| 48 | Chỉ số công ty SaaS | CÓ | #533 `/platform/saas` |

## 3. Kế hoạch (cập nhật mỗi PR)

| # | Việc | Phase lệnh | Trạng thái | Ghi chú |
|---|---|---|---|---|
| P1 | **Đơn người không thành đơn bot**: «Đơn bot chốt» / doanh thu AI / chi phí AI mỗi đơn chỉ đếm `order.confirmed` KHÔNG do người chốt; hội thoại có đơn do người tạo vào nhóm có người; Messenger ghi `human.took_over` | 1–2 | XONG (nhánh `wt-master-mission`) | Hai vị ngữ dùng chung `lib/sales-chatbot/events-sql.ts`. Đơn bot chốt mang tác nhân CUSTOMER — lọc `= 'AI'` là sai (bài kiểm đột biến bắt cả hai chiều). Tổ chức đã dùng form tạo đơn trong chat (#565, từ 04/10) sẽ thấy số đơn bot GIẢM — đúng hướng |
| P2 | Quy kết từng đơn AI_ONLY / AI_ASSISTED / HUMAN_ONLY + doanh thu theo nhãn (`docs/revenue-attribution.md`) | 2 | XONG (nhánh) | `attribution-shared.ts` (luật thuần) + `attribution.ts`; khối «Đơn theo người làm ra» trên màn Hiệu quả; vào bài tấn công cô lập |
| P3 | Follow-up thu hồi: hội thoại có `followup.sent` → khách trả lời → đơn chốt; doanh thu thu hồi qua `ORDER_OUTCOME` | 2/4 | XONG (nhánh) | `followupRecovery` — đơn phải lên SAU tin trả lời, cùng lượt mua |
| P4 | KPI còn thiếu: AOV, doanh thu / hội thoại, chi phí AI / hội thoại, doanh thu ÷ chi phí AI | 2 | XONG (nhánh) | `salesEconomics` (thuần); 9 khoá mới trong `AI_SALES_METRICS` |
| P5 | Màn chủ shop «Hôm nay AI kiếm bao nhiêu» (di động trước) đọc CÙNG hàm của màn «Hiệu quả» | 2 | XONG (nhánh) | `components/onboarding/ai-sales-today.tsx` đầu trang chủ tổ chức khách: hôm nay = giá trị ĐẶT (chưa giao), 30 ngày = doanh thu ĐÃ GIAO; bài kiểm chặn công thức thứ hai |
| P6 | Lý do mất khách + báo cáo «Vì sao khách không mua» + drill-down | 3 | XONG (nhánh) | KHÔNG đổi công cụ bot: phân loại LÚC ĐỌC (`lost-reasons-shared.ts`, `LOST_REASON_VERSION`). Từ khoá có dấu («đặt» ≠ «đắt»); im lặng quá 24 giờ là SUY RA; chuyển người không thấy đơn là nhóm riêng. Bước sau (đổi hành vi, cần bộ vàng): cho `mark_declined` nhận mã lý do |
| P7 | Kiểm giá không căn cứ trên lượt THẬT ⇒ hàng đợi rà lỗi AI | 3 | XONG (nhánh) | `/ai/sales-chatbot/quality`: luật tất định (cùng bộ đọc tiền của phát lại) — giá không căn cứ · công cụ lỗi · khách hỏi lại y nguyên; tin nhân viên không bị cờ. Quyết định người rà ở `sales_ai_reviews` (migration `0216`, chỉ THÊM). Không dùng AI thứ hai làm giám khảo |
| P8 | Cổng sẵn sàng trước khi bật Tự động | 5 | CHỜ | |

## 4. Nhật ký quyết định

- **05/10/2026 — Không tạo `docs/architecture.md`, `data-model.md`, `event-model.md`… như lệnh liệt kê.** Nội dung
  thật đã có ở `docs/productization/{CURRENT_STATE,TARGET_ARCHITECTURE,DOMAIN_MAP}.md`, `docs/platform/*`. Thêm bản
  thứ hai là tạo đúng thứ «hỗn loạn» lệnh §52 cấm. Tài liệu MỚI chỉ sinh ra khi có mã mới cần nó
  (`docs/revenue-attribution.md` đi cùng P2).
- **05/10/2026 — Sửa số trước khi thêm số.** P1 đứng trước mọi màn mới: một màn «AI kiếm bao nhiêu» đọc con số đang
  gộp đơn người là quảng cáo sai cho chính sản phẩm.

## 5. Baseline 05/10/2026 (cây sạch 317270ab, Windows)

`npm run typecheck` sạch · `npm run lint` sạch · `npm test` in «TẤT CẢ KIỂM THỬ ĐẠT» (775 dòng ✓). Sáu mục in «CHƯA ĐO ĐƯỢC
trên win32» (thiếu `flock` / `jq` / bit quyền POSIX) — có từ trước, CI Linux đo; không phải lỗi của lệnh này.
