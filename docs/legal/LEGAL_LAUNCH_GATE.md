# CỔNG RA MẮT PHÁP LÝ — CHỐT ĐƠN TỰ ĐỘNG

> Mở 08/10/2026; **sửa cùng ngày theo OWNER OVERRIDE «tuân thủ đúng luật, ma sát thấp nhất»** (`CONVERSION_FIRST_REAUDIT.md`).
> Đứng CẠNH `docs/saas/LAUNCH_GATE.md` (cổng kỹ thuật). Nguồn sự thật cho câu «về mặt pháp lý có được bán cho khách trả
> tiền chưa». Mỗi dòng trỏ tới bằng chứng (văn bản, số hồ sơ, ý kiến luật sư có ngày), không trỏ tới ý định.
> **Không bao giờ hiện xanh giả**: ô nào không có bằng chứng thì là UNKNOWN, và UNKNOWN tính 0.
> **LEGAL-P0 chỉ chứa điều THẬT SỰ bắt buộc để kinh doanh hợp pháp** (MANDATORY) hoặc câu hỏi về một GIẤY PHÉP chưa rõ
> (COUNSEL thuộc lớp giấy phép). RECOMMENDED / OPTIONAL không bao giờ vào P0.

## 1. Cách chấm

| Ký hiệu | Nghĩa | Điểm |
|---|---|---|
| ✅ DONE | Có bằng chứng loại tương ứng (A mã + bài kiểm · B văn bản có phiên bản · C hồ sơ ký · D cơ quan cấp / tiếp nhận · E kế toán xác nhận · F chủ sở hữu quyết bằng văn bản · G luật sư xác nhận bằng văn bản) | 1 |
| 🟡 PARTIAL | Một phần loại đã có | 0,5 |
| 🔧 WIP | Đang có mission / nhánh | 0 |
| ❌ MISSING | Chưa ai làm | 0 |
| ⛔ PENDING AUTHORITY | Đã nộp, chờ cơ quan | 0 (không tính «nội bộ») |
| ❓ UNKNOWN | Không biết có áp dụng không | 0 |

Cột **CĐ** = tác động chuyển đổi của cách thực hiện đã chọn (NONE / LOW / MEDIUM / HIGH). Mọi mục P0 phải ở NONE hoặc LOW; mục
nào không hạ được xuống LOW thì phải thiết kế lại trước khi giao Tech Lead.

**LEGAL READY** = mọi P0 ✅ hoặc ⛔ VÀ không mục nào ❓. **COMMERCIAL READY** = ENGINEERING READY + LEGAL READY + META READY.
Giấy phép / chứng nhận / hồ sơ **bắt buộc để cung cấp dịch vụ hợp pháp** còn ❓ hoặc ❌ ⇒ KHÔNG READY FOR PAYING CUSTOMER.

## 2. LEGAL-P0 — bắt buộc trước khách trả tiền đầu tiên (11 mục)

| # | Mục | Phân loại | Luật | CĐ | Trạng thái | Điểm | Bằng chứng / việc còn lại | Loại |
|---|---|---|---|---|---|---|---|---|
| P0-1 | Phân loại «kinh doanh dịch vụ xử lý DLCN»; nếu áp dụng: Giấy chứng nhận Bộ Công an | COUNSEL (lớp giấy phép) | NĐ 356 Đ.21–25 | NONE | ❓ | 0 | Chưa có ý kiến luật sư (G-1). Nếu CÓ: Đ.22 đạt 1/5 | G → C → D |
| P0-2 | Hồ sơ đánh giá tác động xử lý DLCN lập + nộp — hoặc văn bản xác nhận được hoãn | MANDATORY (hoãn: COUNSEL) | Luật 91; NĐ 356 Đ.19 | NONE | ❌ | 0 | Bằng chứng kỹ thuật đã có (`DATA_PROCESSING_REGISTER.md`, `DATA_FLOW_MAP.md`); chưa lập Mẫu 10 | B → D |
| P0-3 | Hồ sơ chuyển xuyên biên giới X1–X5 (+ X9 Cloudflare) + vùng xử lý xác định | MANDATORY | NĐ 356 Đ.18; Luật 91 Đ.8 | NONE (nội dung tin đơn giữ nguyên — chủ sở hữu chọn phương án A / B) | ❌ | 0 | Vùng Gemini / Meta / Telegram / Lark / Drive UNKNOWN — hỏi từng bên; dữ liệu đang chuyển | F → G → D |
| P0-4 | Công bố AI mức tối thiểu: tên hiển thị + greeting / tiêu đề (cơ chế 1) + một dòng tự nhiên đầu hội thoại mới (cơ chế 2); bot không nói dối khi bị hỏi; bỏ lời nhắc che giấu | MANDATORY | Luật AI Đ.11.1, Đ.7 | **LOW** (thiết kế lại từ MEDIUM) | ❌ | 0 | `engine.ts:156`, `followup.ts:58`, `config.ts:208`, `app/chat/page.tsx:29` — M-AI-DISCLOSE (đã thiết kế lại) | A |
| P0-5 | DPA với khách thuê — **phụ lục của Điều khoản**, chấp thuận cùng dòng đồng ý hiện có | MANDATORY | Luật 91 (bên xử lý) | LOW | ❌ | 0 | Khung `DATA_PROCESSING_REGISTER.md` §6; luật sư soạn; không màn hình mới | B → G |
| P0-6 | Nơi lưu dữ liệu tại Việt Nam | MANDATORY | Luật ANM Đ.25.3; NĐ 333 | NONE | 🟡 | 0,5 | CSDL + sao lưu chính tại VN ✅; bản Drive (mã hoá) chưa kết luận; tên nhà cung cấp VPS lệch (Vietnix / VNPT) | G · F |
| P0-7 | Thông báo / đăng ký nền tảng TMĐT (nếu áp dụng) | COUNSEL (lớp thủ tục bắt buộc) | Luật TMĐT 122/2025; NĐ 248 | NONE | ❓ | 0 | G-6; chat web do VNX host | G → D |
| P0-8 | Khả năng thông báo sự cố trong 72 giờ: runbook một trang + người trực; đánh giá sự cố log 24/09 | MANDATORY (nghĩa vụ thông báo); runbook là cách đáp | NĐ 356 Đ.28–29 | NONE | 🟡 | 0,5 | Runbook khung có (`INCIDENT_RESPONSE.md`, 09/10 — B); thiếu: người trực (F), ngưỡng / mốc thông báo + sự cố 24/09 (G-11) | B → G |
| P0-9 | Khả năng đáp yêu cầu chủ thể dữ liệu trong hạn (2 / 10 / 15 / 20 ngày): quy trình tay qua khách thuê + ops chỉ đọc + script xoá chạy thử | MANDATORY (công cụ tự phục vụ: P1) | Luật 91; NĐ 356 | NONE | 🟡 | 0,5 | Có: Chính sách §9 (email, 30 ngày), xuất CSV, xoá workspace, quy trình viết ra (`DSR_PROCEDURE.md`, 09/10 — hạn chờ G). Thiếu: script xoá theo SĐT / PSID | B · A |
| P0-10 | Số dư AI không phải trung gian thanh toán / ví điện tử | COUNSEL (lớp giấy phép NHNN) | NĐ 52/2024 | NONE | 🟡 | 0,5 | Thiết kế đúng (`ai-balance-rules.ts:4`); thiếu văn bản luật sư (G-7) | G |
| P0-11 | Xuất hoá đơn đúng khi thu tiền (kế toán chốt cách xuất, nhà cung cấp HĐĐT ngoài); giá công bố nói rõ thuế | MANDATORY (E) | NĐ 123/2020 + 70/2025; Luật GTGT 48/2024 | NONE | 🟡 | 0,5 | `tax_mode = UNDECLARED` ✅; thông tin xuất HĐ đã có (`billing.md` §8); thiếu quyết định kế toán | E |
| | **Tổng P0** | | | | | **2,5 / 11 = ~23 %** | | |

Mục đã **rời khỏi P0** theo override: chấp thuận điện tử có hash / checkbox (→ P1-6, backend-only); công cụ DSR tự phục vụ
(→ P1-14); bảng sự cố (→ P1-15); danh mục thuế cấu hình (→ P1-16).

## 3. LEGAL-P1 — trong 90 ngày sau khách đầu tiên (không chặn ra mắt)

| # | Mục | Phân loại | CĐ | Trạng thái | Việc |
|---|---|---|---|---|---|
| P1-1 | Chính sách quyền riêng tư nêu đủ bên thứ ba (Zalo · Telegram · Cloudflare · Lark · GHN · GHTK · Anthropic · OpenAI · GitHub · Google Places / Sheets · Meta Marketing / Instagram) | MANDATORY (nghĩa vụ thông báo) | NONE | ❌ | Sửa `app/chinh-sach-bao-mat/page.tsx` §4, tăng `PRIVACY_POLICY.version` |
| P1-2 | Số công bố khớp mã: dùng thử 7 / 14; VPS Vietnix / VNPT; kênh thông báo khi không có email | MANDATORY (thông tin đúng) | NONE | ❌ | M-TRIAL-CONSISTENCY |
| P1-3 | Nhật ký đăng nhập ≥ 12 tháng có IP + cổng | MANDATORY nếu NĐ 333 áp (G-5) | NONE | ❌ | M-LOGIN-LOG |
| P1-4 | Bộ phận / nhân sự bảo vệ DLCN (hoặc văn bản hoãn) | MANDATORY trừ khi hoãn (G-2) | NONE | ❌ | F · C |
| P1-5 | Chính sách khiếu nại / hỗ trợ (một trang) | MANDATORY nếu TMĐT (G-6); BVQLNTD | NONE | ❌ | B |
| P1-6 | Ghi sổ chấp thuận backend: phiên bản · hash · mốc · IP; đổi phiên bản ⇒ thông báo trong app, **không chặn** | RECOMMENDED | NONE | 🟡 (`ORG_ONBOARDED.after.acceptedTerms`) | M-ACCEPT (đã bỏ checkbox) |
| P1-7 | Sổ đồng ý backend (nhóm A; tiếp thị do khách thuê bật) — **không popup** | MANDATORY khi dùng căn cứ đồng ý; backend-only | NONE | ❌ | M-CONSENT |
| P1-8 | Từ khoá «dừng» ⇒ tắt follow-up / broadcast cho người đó; không thêm chữ vào tin bán | Quyền phản đối (Luật 91); NĐ 91 không áp (không SMS / email / gọi) | NONE | ❌ (`mark_declined` một phần) | M-OPTOUT |
| P1-9 | Sổ hệ thống AI (tệp hằng số, không UI) | RECOMMENDED | NONE | 🟡 (`lib/constants/ai-systems.ts`; mức rủi ro chờ G-4) | M-AI-REG |
| P1-10 | Chính sách ATTT chính thức; MFA người vận hành nền tảng | RECOMMENDED | NONE | 🟡 | B · A |
| P1-11 | Retention + LEGAL HOLD theo loại (số do F + G + E điền) | Nguyên tắc MANDATORY; tự động hoá RECOMMENDED | NONE | 🟡 (khung `lib/constants/retention.ts`, mọi số chưa quyết) | M-RETENTION |
| P1-12 | Bằng chứng từng trường của đơn — backend, **không thêm bước xác nhận** | RECOMMENDED | NONE | 🔧 (`ORDER_CANDIDATE.md`) | Roadmap sản phẩm |
| P1-13 | Bài kiểm bất biến tín dụng dịch vụ | RECOMMENDED | NONE | ❌ | M-INVARIANT-CREDIT |
| P1-14 | Công cụ DSR tự phục vụ (tra · xuất theo chủ thể gồm hội thoại · xoá / ẩn danh · LEGAL HOLD · sổ yêu cầu) | RECOMMENDED | NONE | ❌ | M-DSR |
| P1-15 | Bảng `platform_incidents` | RECOMMENDED | NONE | ❌ | M-INCIDENT |
| P1-16 | Danh mục thuế cấu hình, mã thuế trên dòng, cột HĐĐT | RECOMMENDED | NONE | ❌ | M-TAX-CATEGORY |
| P1-17 | Chân trang TMĐT (chủ sở hữu · MST · khiếu nại · số thông báo) | COUNSEL | NONE | 🟡 (`COMPANY`) | M-ECOM-DISCLOSURE sau G-6 |

## 4. DEFERRED — không làm cho tới khi có căn cứ bắt buộc hoặc số đo

| Mục | Vì sao defer | Điều kiện mở lại |
|---|---|---|
| Checkbox đồng ý tường minh ở `/start`; màn chặn «đồng ý lại» | OPTIONAL + MEDIUM | Luật sư nói bắt buộc |
| Che SĐT / địa chỉ trong tin đơn Telegram / Lark (M-ALERT-MINIMIZE) | OPTIONAL (hồ sơ xuyên biên giới mới là bắt buộc) + vận hành kho MEDIUM | Chủ sở hữu chọn phương án B (Zalo Bot) ở P0-3 |
| Tối thiểu hoá khối «khách cũ» trong prompt (M-PROMPT-MIN) | RECOMMENDED + MEDIUM | Đo golden cho thấy không giảm tỷ lệ chốt |
| OTP SĐT khi đăng ký (M-PHONE-AUTH) | COUNSEL + HIGH | G-5 nói bắt buộc ⇒ xác minh SAU khi vào workspace / lúc thanh toán đầu |
| `/platform/compliance`; trang bên xử lý phụ động; bài kiểm hostname | OPTIONAL | POST-LAUNCH |
| Mọi câu báo máy ngoài dòng công bố đầu hội thoại | Quyết định chủ shop 05/10 giữ nguyên | Không |

## 5. POST-LAUNCH

| # | Mục |
|---|---|
| PL-1 | Đánh giá tuân thủ định kỳ hằng năm (NĐ 356 nếu là dịch vụ xử lý DLCN) |
| PL-2 | Tích hợp hoá đơn điện tử khi chủ sở hữu chọn nhà cung cấp |
| PL-3 | Sao lưu ngoài máy trong nước (nếu F quyết) |
| PL-4 | Xác thực người bán bằng định danh điện tử (NĐ 248, từ 01/01/2027) nếu VNX là nền tảng trung gian |
| PL-5 | Đánh giá lại khi Thủ tướng ban hành Danh mục AI rủi ro cao |
| PL-6 | Thương hiệu riêng `<tên>.chotdontudong.com` ⇒ `SITE_LEGAL_PATHS`, thông báo TMĐT cho tên miền mới |
| PL-7 | `/platform/compliance` 15 ô (đặc tả `VIETNAM_LEGAL_COMPLIANCE.md` §18) |

## 6. Bốn trạng thái sẵn sàng

| Trạng thái | Định nghĩa | Hôm nay |
|---|---|---|
| ENGINEERING READY | `docs/saas/LAUNCH_GATE.md` ĐẠT | NOT READY (35 % — 08/10 tối) |
| LEGAL READY | §2 mọi P0 ✅ / ⛔, không ❓ | **NOT READY (23 %)** |
| META READY | App Review duyệt + smoke tài khoản ngoài | ⛔ NGOÀI |
| COMMERCIAL READY | Cả ba | **NOT READY** |

## 7. Nhật ký cập nhật

| Lúc | Thay đổi |
|---|---|
| 08/10/2026 | Mở cổng. P0 2,5 / 12 = 21 %. Ba câu hỏi chặn: dịch vụ xử lý DLCN · minh bạch AI · vùng xử lý xuyên biên giới |
| 08/10/2026 (override) | Rà lại theo «ma sát thấp nhất»: P0 còn 11 mục toàn MANDATORY / COUNSEL-giấy-phép, 2,0 / 11 = 18 %; công bố AI thiết kế lại LOW; DPA thành phụ lục; chấp thuận / DSR tooling / sự cố / thuế xuống P1; 6 mục DEFER (§4) |
| 09/10/2026 (legal-registers) | Trạng thái theo chiều thành hằng có kiểu (§8, `lib/constants/legal-gate.ts`), LEGAL READY dẫn xuất. P0-8 ❌ → 🟡 (runbook khung `INCIDENT_RESPONSE.md`); P0-9 thêm `DSR_PROCEDURE.md` (vẫn 🟡); P1-9 · P1-11 ❌ → 🟡 (sổ AI, khung retention). P0 2,5 / 11 = 23 % |

## 8. Trạng thái theo chiều — nguồn: `lib/constants/legal-gate.ts`

> Năm chiều tách rời, mỗi chiều một người đóng: ENGINEERING (kỹ thuật) · COUNSEL (G) · GOVERNMENT_FILING (D; FILED = ⛔ chờ cơ
> quan) · ACCOUNTING (E) · OWNER (F). **LEGAL READY là DẪN XUẤT** — chỉ «CÓ» khi mọi chiều xong hoặc NOT_NEEDED (mỗi
> NOT_NEEDED khai lý do trong hằng); không ô nào khai tay. Bảng dưới SINH từ hằng, bài kiểm `tests/legal-registers.test.ts`
> so từng byte và so cột ký hiệu §2 / §3 (✅ ⇔ LEGAL READY; dòng «Tổng P0» tính lại từ ký hiệu). Sửa trạng thái ⇒ sửa hằng,
> chạy bài kiểm, chép lại bảng.

<!-- legal-gate:begin (sinh từ lib/constants/legal-gate.ts — không sửa tay) -->
| # | ENGINEERING | COUNSEL | GOVERNMENT_FILING | ACCOUNTING | OWNER | LEGAL READY (dẫn xuất) | Còn mở |
|---|---|---|---|---|---|---|---|
| P0-1 | NOT_NEEDED | PENDING | PENDING | NOT_NEEDED | PENDING | không | COUNSEL · GOVERNMENT_FILING · OWNER |
| P0-2 | READY | PENDING | PENDING | NOT_NEEDED | PENDING | không | COUNSEL · GOVERNMENT_FILING · OWNER |
| P0-3 | WIP | PENDING | PENDING | NOT_NEEDED | PENDING | không | ENGINEERING · COUNSEL · GOVERNMENT_FILING · OWNER |
| P0-4 | NOT_STARTED | PENDING | NOT_NEEDED | NOT_NEEDED | PENDING | không | ENGINEERING · COUNSEL · OWNER |
| P0-5 | NOT_STARTED | PENDING | NOT_NEEDED | NOT_NEEDED | PENDING | không | ENGINEERING · COUNSEL · OWNER |
| P0-6 | READY | PENDING | NOT_NEEDED | NOT_NEEDED | PENDING | không | COUNSEL · OWNER |
| P0-7 | NOT_NEEDED | PENDING | PENDING | NOT_NEEDED | NOT_NEEDED | không | COUNSEL · GOVERNMENT_FILING |
| P0-8 | READY | PENDING | NOT_NEEDED | NOT_NEEDED | PENDING | không | COUNSEL · OWNER |
| P0-9 | WIP | PENDING | NOT_NEEDED | PENDING | PENDING | không | ENGINEERING · COUNSEL · ACCOUNTING · OWNER |
| P0-10 | READY | PENDING | PENDING | NOT_NEEDED | NOT_NEEDED | không | COUNSEL · GOVERNMENT_FILING |
| P0-11 | READY | PENDING | NOT_NEEDED | PENDING | PENDING | không | COUNSEL · ACCOUNTING · OWNER |
| P1-1 | NOT_STARTED | PENDING | NOT_NEEDED | NOT_NEEDED | PENDING | không | ENGINEERING · COUNSEL · OWNER |
| P1-2 | NOT_STARTED | NOT_NEEDED | NOT_NEEDED | NOT_NEEDED | PENDING | không | ENGINEERING · OWNER |
| P1-3 | NOT_STARTED | PENDING | NOT_NEEDED | NOT_NEEDED | NOT_NEEDED | không | ENGINEERING · COUNSEL |
| P1-4 | NOT_NEEDED | PENDING | NOT_NEEDED | NOT_NEEDED | PENDING | không | COUNSEL · OWNER |
| P1-5 | NOT_STARTED | PENDING | NOT_NEEDED | NOT_NEEDED | PENDING | không | ENGINEERING · COUNSEL · OWNER |
| P1-6 | WIP | NOT_NEEDED | NOT_NEEDED | NOT_NEEDED | NOT_NEEDED | không | ENGINEERING |
| P1-7 | NOT_STARTED | PENDING | NOT_NEEDED | NOT_NEEDED | NOT_NEEDED | không | ENGINEERING · COUNSEL |
| P1-8 | NOT_STARTED | NOT_NEEDED | NOT_NEEDED | NOT_NEEDED | NOT_NEEDED | không | ENGINEERING |
| P1-9 | READY | PENDING | PENDING | NOT_NEEDED | NOT_NEEDED | không | COUNSEL · GOVERNMENT_FILING |
| P1-10 | WIP | NOT_NEEDED | NOT_NEEDED | NOT_NEEDED | PENDING | không | ENGINEERING · OWNER |
| P1-11 | WIP | PENDING | NOT_NEEDED | PENDING | PENDING | không | ENGINEERING · COUNSEL · ACCOUNTING · OWNER |
| P1-12 | WIP | NOT_NEEDED | NOT_NEEDED | NOT_NEEDED | NOT_NEEDED | không | ENGINEERING |
| P1-13 | NOT_STARTED | NOT_NEEDED | NOT_NEEDED | NOT_NEEDED | NOT_NEEDED | không | ENGINEERING |
| P1-14 | NOT_STARTED | NOT_NEEDED | NOT_NEEDED | NOT_NEEDED | NOT_NEEDED | không | ENGINEERING |
| P1-15 | NOT_STARTED | NOT_NEEDED | NOT_NEEDED | NOT_NEEDED | NOT_NEEDED | không | ENGINEERING |
| P1-16 | NOT_STARTED | NOT_NEEDED | NOT_NEEDED | PENDING | NOT_NEEDED | không | ENGINEERING · ACCOUNTING |
| P1-17 | WIP | PENDING | NOT_NEEDED | NOT_NEEDED | NOT_NEEDED | không | ENGINEERING · COUNSEL |
<!-- legal-gate:end -->
