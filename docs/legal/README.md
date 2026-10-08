# Văn bản pháp lý cho khách thuê ERP — BẢN NHÁP

> **TRẠNG THÁI: NHÁP, CHƯA CÓ HIỆU LỰC.** Hai văn bản trong thư mục này do kỹ thuật soạn từ cách hệ thống THỰC SỰ vận
> hành hôm nay, để chủ nền tảng và luật sư có một bản đúng sự thật mà sửa — không phải văn bản pháp lý đã duyệt.
> Chưa trang nào hiện chúng cho khách, và `/start` chưa đòi khách đồng ý.

| Tệp | Nội dung |
|---|---|
| `terms-of-service.md` | Điều khoản sử dụng dịch vụ (khách thuê ↔ nền tảng) |
| `privacy-policy.md` | Chính sách bảo vệ dữ liệu cá nhân (dữ liệu của khách thuê VÀ của khách hàng cuối mà khách thuê nhập vào) |

## Hồ sơ tuân thủ pháp luật Việt Nam — Phase 1 (08/10/2026: nghiên cứu + kiểm kê + khoảng trống)

> KHÔNG phải ý kiến pháp lý. Mọi dòng «LEGAL COUNSEL REQUIRED» là câu hỏi chưa có trả lời. **Chưa hồ sơ nào được nộp
> cho cơ quan nhà nước.** Đọc theo thứ tự:

| Tệp | Trả lời câu gì |
|---|---|
| `VIETNAM_LEGAL_COMPLIANCE.md` | Luật nào chạm sản phẩm (14 văn bản, có mức tin cậy số điều), sản phẩm làm gì, khoảng trống, ai phải làm gì (F chủ sở hữu · G luật sư · D cơ quan · E kế toán · U chưa biết) |
| `LEGAL_LAUNCH_GATE.md` | Có được bán cho khách trả tiền chưa — 12 mục LEGAL-P0 (hôm nay ~21 %), P1, POST-LAUNCH; bốn trạng thái ENGINEERING / LEGAL / META / COMMERCIAL READY |
| `DATA_PROCESSING_REGISTER.md` | 17 tập dữ liệu × 15 cột (chủ thể, vai trò, căn cứ, lưu, xuyên biên giới, xoá, xuất); tra ngược bảng → tập; bảng retention mẫu; khung DPA |
| `DATA_FLOW_MAP.md` | Dữ liệu đi đâu, qua bước nào, tệp:dòng; điểm chạm xuyên biên giới |
| `SUBPROCESSOR_REGISTER.md` | 30 bên ngoài mã nguồn gọi tới: pháp nhân, dữ liệu, vùng (UNKNOWN khi chưa đọc điều khoản), đã công bố chưa; TÊN biến bí mật |
| `TECH_HANDOFF_LEGAL.md` | Mission có biên cho Tech Lead (Phase 2), mỗi mission ghi phân loại + tác động chuyển đổi; đánh dấu [CHỜ F] / [CHỜ G] / [DEFER] |
| `DSR_PROCEDURE.md` | Quy trình tay đáp yêu cầu của chủ thể dữ liệu: tiếp nhận qua khách thuê, xác minh, thời hạn (con số nào chờ luật sư), LEGAL HOLD |
| `INCIDENT_RESPONSE.md` | Runbook khung sự cố dữ liệu cá nhân: năm loại sự cố, mức độ, khoanh vùng bằng công tắc có sẵn, quyết định thông báo |
| Hằng có kiểu (`lib/constants/`) | `legal-documents.ts` (sổ văn bản + băm nội dung) · `legal-registers.ts` (bên xử lý phụ, xuyên biên giới) · `retention.ts` (khung lưu trữ) · `ai-systems.ts` (sổ hệ thống AI) · `legal-gate.ts` (cổng theo chiều) — bài kiểm `tests/legal-registers.test.ts` |
| `COUNSEL_PACK.md` | **Gửi luật sư (09/10/2026, trạng thái WAITING_FOR_LEGAL_COUNSEL)**: ba câu hỏi chặn + sự cố 24/09 + câu phụ, mỗi câu có sự thật, lựa chọn, ô YES / NO / CONDITIONS; hồ sơ phải nộp nếu YES; bằng chứng đã có; còn thiếu |
| `CONVERSION_FIRST_REAUDIT.md` | **OWNER OVERRIDE 08/10**: rà lại mọi mục theo «tuân thủ đúng luật, ma sát thấp nhất» — MANDATORY / COUNSEL / RECOMMENDED / OPTIONAL × tác động chuyển đổi; công bố AI thiết kế lại ở mức tối thiểu; danh sách bỏ / hoãn |

## Đã công bố

- **Chính sách quyền riêng tư — phiên bản 1.0, hiệu lực 03/10/2026**: `https://vnxcommerce.com/chinh-sach-bao-mat`
  (`app/chinh-sach-bao-mat/page.tsx`). Google / Facebook đòi link này để mở đăng nhập bằng tài khoản của họ.
  - Thông tin pháp nhân do chủ nền tảng cung cấp, khai ở `lib/constants/company.ts`.
  - Các chỗ trống `[…]` của bản nháp được điền bằng điều hệ thống ĐANG làm: máy chủ VNPT tại Việt Nam, sao lưu Google
    Drive đã mã hoá, xoay vòng 7 ngày / 4 tuần, không tự xoá khi ngừng thuê.
  - Mốc «xoá trong 30 ngày kể từ khi xác minh yêu cầu» là đề xuất của kỹ thuật, chủ nền tảng đổi được.
  - Thời hạn trả lời yêu cầu và báo sự cố ghi «theo thời hạn pháp luật quy định» — chờ luật sư điền số cụ thể.
- **Điều khoản sử dụng — phiên bản 1.0, hiệu lực 04/10/2026**: `https://vnxcommerce.com/dieu-khoan-su-dung`
  (`app/dieu-khoan-su-dung/page.tsx`). Chủ nền tảng giao kỹ thuật chọn phương án (04/10/2026):
  - dùng thử 14 ngày, ân hạn 3 ngày, rồi chỉ xem;
  - hoàn 100% lần thanh toán ĐẦU TIÊN nếu yêu cầu trong 7 ngày; các lần sau không hoàn phần đã dùng;
  - giữ dữ liệu ít nhất 90 ngày sau khi hết hạn, xoá chỉ sau khi báo trước 15 ngày;
  - báo trước 30 ngày khi đổi giá, 15 ngày khi sửa điều khoản; toà án có thẩm quyền tại Hà Nội.
  - Mọi con số khai ở `lib/constants/company.ts::SERVICE_COMMITMENTS` (+ `TRIAL_DAYS` trong `lib/billing/rules.ts`) —
    trang đọc từ đó.
- **Đồng ý khi đăng ký**: dòng «Bằng việc tạo cửa hàng, bạn đồng ý với Điều khoản sử dụng và Chính sách quyền riêng tư»
  ngay trên nút tạo (đăng ký nhanh và trình đầy đủ). Phiên bản hai văn bản ghi vào nhật ký `ORG_ONBOARDED` của tổ chức
  (`after.acceptedTerms`).
- Chính sách quyền riêng tư lên 1.1 (04/10/2026): thêm mốc giữ dữ liệu 90 ngày cho khớp Điều khoản.

Còn phải nhờ luật sư rà cả hai văn bản; sửa thì tăng `PRIVACY_POLICY.version` trong `lib/constants/company.ts`.

## Việc chủ nền tảng phải làm trước khi dùng

1. Điền mọi chỗ `[…]`: tên pháp nhân, mã số thuế, địa chỉ, người đại diện, email / số điện thoại hỗ trợ.
2. Nhờ luật sư rà — đặc biệt: căn cứ pháp lý về dữ liệu cá nhân (Luật Bảo vệ dữ liệu cá nhân và văn bản hướng dẫn hiện
   hành), giới hạn trách nhiệm, luật áp dụng / nơi giải quyết tranh chấp, hoá đơn VAT.
3. Chốt các con số kinh doanh đang để trống: thời gian giữ dữ liệu sau khi ngừng thuê, thời hạn hoàn tiền.
4. Báo kỹ thuật khi văn bản đã duyệt. Khi đó mới làm phần cơ chế: trang công khai `/terms`, `/privacy`; ô đồng ý ở
   `/start` ghi lại **phiên bản** văn bản + thời điểm + người đồng ý vào sổ của nền tảng; đổi phiên bản thì quản trị
   của khách phải đồng ý lại ở lần đăng nhập kế tiếp.

## Nguyên tắc khi sửa

Mỗi câu cam kết phải là điều hệ thống ĐANG làm được. Ví dụ đúng hôm nay: dữ liệu mỗi tổ chức nằm ở một CSDL riêng;
quá hạn thanh toán chỉ chuyển sang chỉ xem, không xoá dữ liệu; sao lưu hằng ngày. Ví dụ CHƯA làm được, không được
hứa: cam kết thời gian hoạt động (SLA) bằng con số, xuất toàn bộ dữ liệu tự phục vụ ở mọi module, xoá dữ liệu tự động
theo lịch. Hứa điều chưa làm được biến văn bản thành bằng chứng chống lại chính mình.
