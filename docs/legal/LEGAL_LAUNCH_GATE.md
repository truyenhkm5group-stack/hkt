# CỔNG RA MẮT PHÁP LÝ — CHỐT ĐƠN TỰ ĐỘNG

> Mở 08/10/2026. Đứng CẠNH `docs/saas/LAUNCH_GATE.md` (cổng kỹ thuật). Nguồn sự thật cho câu «về mặt pháp lý có được bán cho
> khách trả tiền chưa». Mỗi dòng trỏ tới bằng chứng (văn bản, số hồ sơ, ý kiến luật sư có ngày), không trỏ tới ý định.
> **Không bao giờ hiện xanh giả**: ô nào không có bằng chứng thì là UNKNOWN, và UNKNOWN tính 0.

## 1. Cách chấm

| Ký hiệu | Nghĩa | Điểm |
|---|---|---|
| ✅ DONE | Có bằng chứng loại tương ứng (A mã + bài kiểm · B văn bản có phiên bản · C hồ sơ ký · D cơ quan cấp / tiếp nhận · E kế toán xác nhận · F chủ sở hữu quyết bằng văn bản · G luật sư xác nhận bằng văn bản) | 1 |
| 🟡 PARTIAL | Một phần loại đã có, phần còn lại chưa | 0,5 |
| 🔧 WIP | Đang có mission / nhánh | 0 |
| ❌ MISSING | Chưa ai làm | 0 |
| ⛔ PENDING AUTHORITY | Đã nộp, chờ cơ quan | 0 (không tính «nội bộ») |
| ❓ UNKNOWN | Không biết có áp dụng không | 0 |

**LEGAL READY** = mọi LEGAL-P0 ✅ hoặc ⛔ (đã nộp) VÀ không mục nào ❓. **COMMERCIAL READY** = ENGINEERING READY (`LAUNCH_GATE.md`)
+ LEGAL READY + META READY. Một giấy phép / chứng nhận / hồ sơ **bắt buộc để cung cấp dịch vụ hợp pháp** còn ❓ hoặc ❌ ⇒ KHÔNG
được đánh dấu READY FOR PAYING CUSTOMER, bất kể các ô khác.

## 2. LEGAL-P0 — phải xong trước khách trả tiền đầu tiên

| # | Mục | Luật | Trạng thái | Điểm | Bằng chứng / việc còn lại | Loại |
|---|---|---|---|---|---|---|
| P0-1 | Phân loại «kinh doanh dịch vụ xử lý DLCN»; nếu áp dụng: Giấy chứng nhận Bộ Công an | NĐ 356 Đ.21–25 | ❓ UNKNOWN | 0 | Chưa có ý kiến luật sư. Nếu CÓ: điều kiện Đ.22 đạt 1/5 (`VIETNAM_LEGAL_COMPLIANCE.md` §4.3) | G → C → D |
| P0-2 | Hồ sơ đánh giá tác động xử lý DLCN lập + nộp (hoặc văn bản xác nhận được hoãn) | Luật 91; NĐ 356 Đ.19 | ❌ MISSING | 0 | Bằng chứng kỹ thuật đã có (`DATA_PROCESSING_REGISTER.md`, `DATA_FLOW_MAP.md`); chưa lập Mẫu 10 | B → D |
| P0-3 | Hồ sơ chuyển xuyên biên giới cho X1–X5 + vùng xử lý xác định | NĐ 356 Đ.18; Luật 91 Đ.8 (5 % doanh thu) | ❌ MISSING | 0 | Vùng Gemini / Meta / Telegram / Lark / Drive: UNKNOWN — **BLOCKER**; dữ liệu đang chuyển | F → G → D |
| P0-4 | Minh bạch AI: khách hàng cuối nhận biết đang tương tác với AI | Luật AI Đ.11.1; NĐ 356 Đ.10 | ❌ MISSING (vi phạm theo thiết kế: `engine.ts:156`, `followup.ts:58`) | 0 | OWNER DECISION rồi M-AI-DISCLOSE | F → A |
| P0-5 | DPA với khách thuê | Luật 91 (bên xử lý) | ❌ MISSING | 0 | Khung ở `DATA_PROCESSING_REGISTER.md` §6; luật sư soạn | B → G |
| P0-6 | Chấp thuận điện tử có bằng chứng (phiên bản + hash + tài khoản + mốc + IP; đồng ý lại khi đổi) | Luật GDĐT; Luật BVQLNTD | 🟡 PARTIAL | 0,5 | Có: phiên bản ghi `ORG_ONBOARDED` (`lib/onboarding/service.ts:439`), trang công khai. Thiếu: hash, IP, bảng riêng, đồng ý lại — M-ACCEPT | A |
| P0-7 | Nơi lưu dữ liệu tại Việt Nam | Luật ANM Đ.25.3; NĐ 333 | 🟡 PARTIAL | 0,5 | CSDL + sao lưu chính tại VN ✅; bản Drive ngoài VN (mã hoá) chưa có kết luận; tên nhà cung cấp VPS lệch (Vietnix / VNPT) | G · F |
| P0-8 | Thông báo / đăng ký nền tảng TMĐT (nếu áp dụng) | Luật TMĐT 122/2025; NĐ 248 | ❓ UNKNOWN | 0 | Chat web do VNX host có làm VNX thành trung gian? — G rồi D | G → D |
| P0-9 | Runbook sự cố lộ DLCN (72 giờ) + đánh giá sự cố log 24/09 | NĐ 356 Đ.28–29 | ❌ MISSING | 0 | Khung ở `VIETNAM_LEGAL_COMPLIANCE.md` §13; sự cố 24/09 chưa đánh giá | B → G |
| P0-10 | Quyền chủ thể dữ liệu cho khách hàng cuối (tra · xuất · xoá theo SĐT / PSID, LEGAL HOLD, sổ yêu cầu, hạn 2 / 10 / 15 / 20 ngày) | Luật 91; NĐ 356 | 🟡 PARTIAL | 0,5 | Có: xuất CSV tổ chức, xoá workspace, email thủ công 30 ngày. Thiếu: theo chủ thể, hội thoại, sổ DSR — M-DSR | A · B |
| P0-11 | Số dư AI = tín dụng dịch vụ, không phải trung gian thanh toán | NĐ 52/2024 | 🟡 PARTIAL | 0,5 | Thiết kế đúng (không rút, không chuyển ngang — `ai-balance-rules.ts:4`); thiếu xác nhận luật sư + bài kiểm khoá bất biến | G · A |
| P0-12 | Thuế / hoá đơn: danh mục thuế cấu hình được + bằng chứng sẵn-sàng-hoá-đơn + kế toán duyệt | Luật GTGT 48/2024; NĐ 123 + 70 | 🟡 PARTIAL | 0,5 | `tax_mode = UNDECLARED` ✅ không hard-code; thiếu bảng danh mục / thuế suất, mã thuế trên dòng, kế toán duyệt, nhà cung cấp HĐĐT | E · A |
| | **Tổng P0** | | | **2,5 / 12 = ~21 %** | | |

## 3. LEGAL-P1 — trước khi mở rộng (trong 90 ngày sau khách đầu tiên, hoặc sớm hơn nếu luật sư yêu cầu)

| # | Mục | Luật | Trạng thái | Việc |
|---|---|---|---|---|
| P1-1 | Sổ đồng ý theo mục đích (vận hành ≠ tiếp thị ≠ AI) | Luật 91; NĐ 356 | ❌ | M-CONSENT |
| P1-2 | Từ chối nhận tin tiếp thị (Messenger / Zalo / SĐT), tách giao dịch khỏi quảng cáo, không bulk không giới hạn | NĐ 91/2020; chính sách Meta | ❌ (chỉ `mark_declined`, `wholesale_suppressions`) | M-OPTOUT |
| P1-3 | Sổ hệ thống AI + phân loại rủi ro + bằng chứng + phiên bản + người chịu trách nhiệm + sự cố | Luật AI Đ.9, 12, 14, 15 | ❌ (khởi tạo ở `VIETNAM_LEGAL_COMPLIANCE.md` §11) | M-AI-REG |
| P1-4 | `/platform/compliance` 15 ô, 5 trạng thái, mặc định UNKNOWN | — | ❌ | M-COMPLIANCE-ADMIN |
| P1-5 | Nhật ký đăng nhập bền vững ≥ 12 tháng: tài khoản · vào / ra · IP · cổng | NĐ 333 | ❌ (`audit_logs` không IP) | M-LOGIN-LOG |
| P1-6 | Xác thực tài khoản bằng SĐT di động VN / định danh điện tử | NĐ 333 | 🟡 (OTP ZNS có, mặc định tắt) | G xác nhận phạm vi → F bật |
| P1-7 | Chỉ định bộ phận / nhân sự bảo vệ DLCN (hoặc văn bản hoãn) | Luật 91; NĐ 356 Đ.13–16 | ❌ | F · C |
| P1-8 | Chính sách ATTT chính thức, MFA cho người vận hành nền tảng, danh sách truy cập production, luân chuyển khoá | Luật ANM; NĐ 356 (biện pháp) | 🟡 (`docs/saas/SECURITY.md`; MFA không có) | B · A |
| P1-9 | Chính sách khiếu nại / hỗ trợ; quy trình giải quyết tranh chấp | Luật BVQLNTD; Luật TMĐT | ❌ | B |
| P1-10 | Retention tự động + LEGAL HOLD theo loại dữ liệu | Luật 91; kế toán; NĐ 333 | ❌ | M-RETENTION |
| P1-11 | Bằng chứng từng trường của đơn (nguồn · giá trị · độ tin · ai sửa · mốc) | Luật BVQLNTD; Luật GDĐT | 🔧 (`docs/saas/ORDER_CANDIDATE.md`) | Theo roadmap sản phẩm |
| P1-12 | Trang công khai bên xử lý phụ đọc từ cấu hình; Chính sách §4 đủ tên | Luật 91 | 🟡 | M-SUBPROC |
| P1-13 | Khớp số công bố với mã: dùng thử 7 vs 14 ngày; «email báo trước» khi không có email; VPS Vietnix / VNPT | Luật BVQLNTD (thông tin đúng) | ❌ | F → B |
| P1-14 | Tối thiểu hoá prompt: che SĐT / địa chỉ trong khối «khách cũ» gửi AI nếu không cần | Luật 91 (tối thiểu hoá) | ❌ | M-PROMPT-MIN |

## 4. POST-LAUNCH

| # | Mục |
|---|---|
| PL-1 | Đánh giá tuân thủ định kỳ hằng năm (NĐ 356 nếu là dịch vụ xử lý DLCN) |
| PL-2 | Tích hợp hoá đơn điện tử khi chủ sở hữu chọn nhà cung cấp |
| PL-3 | Chuyển sao lưu ngoài máy về lưu trữ trong nước (nếu F quyết) |
| PL-4 | Xác thực người bán bằng định danh điện tử (NĐ 248, từ 01/01/2027) nếu VNX là nền tảng trung gian |
| PL-5 | Đánh giá lại khi Thủ tướng ban hành Danh mục AI rủi ro cao |
| PL-6 | Thương hiệu riêng `<tên>.chotdontudong.com` ⇒ cập nhật `SITE_LEGAL_PATHS`, thông báo TMĐT cho tên miền mới |

## 5. Bốn trạng thái sẵn sàng

| Trạng thái | Định nghĩa | Hôm nay |
|---|---|---|
| ENGINEERING READY | `docs/saas/LAUNCH_GATE.md` ĐẠT (0 P0, Admin ≥ 90 %, Khách ≥ 90 %, quan sát 8/8, smoke production xanh) | NOT READY (35 % — 08/10 tối) |
| LEGAL READY | §2 mọi P0 ✅ / ⛔, không ❓ | **NOT READY (21 %)** |
| META READY | App Review duyệt + smoke bằng tài khoản ngoài | ⛔ NGOÀI |
| COMMERCIAL READY | Cả ba trên | **NOT READY** |

## 6. Nhật ký cập nhật

| Lúc | Thay đổi |
|---|---|
| 08/10/2026 | Mở cổng. P0 2,5 / 12 = 21 %. Chưa hồ sơ nào nộp. Ba câu hỏi chặn: dịch vụ xử lý DLCN · minh bạch AI · vùng xử lý xuyên biên giới |
