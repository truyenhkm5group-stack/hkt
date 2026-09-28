# ERP Builder Platform — lộ trình Phase 5 → 12 và các quyết định xuyên suốt

> Chốt 28/09/2026 sau khi Phase 4 (Dynamic Page Runtime) lên production (`4f82910a`, 164 migration).
> Tài liệu này là HỢP ĐỒNG giữa các phase. Hợp đồng chi tiết từng phase nằm ở `phase-<n>-contracts.md`.
> Trạng thái thực thi (commit, PR, việc đang dở) nằm ở `current-execution-state.md`.

## 1. Bảy quyết định không đổi giữa các phase

**X1 — MỘT runtime, nhiều lớp soạn.** Trang (Phase 4), form, danh sách (Phase 2), luật (Phase 3) mỗi thứ có đúng MỘT
định dạng metadata và MỘT bộ máy chạy. Trình kéo-thả (Phase 5), mẫu ngành (Phase 7), AI (Phase 8) chỉ là những lớp
SINH RA cùng metadata ấy. Không lớp nào được có đường ghi riêng xuống CSDL.

**X2 — Mọi thứ khách cấu hình đi qua sổ ĐÓNG + kiểm ở máy chủ.** Sổ đối tượng, sổ field, sổ nguồn dữ liệu, sổ action,
sổ trigger/action của luật, sổ module. Không SQL, JavaScript, mã máy chủ, lệnh shell hay URL API thô do khách hoặc AI
khai. Cấu hình không bao giờ là ranh giới an ninh: quyền + module + phạm vi được kiểm theo NGƯỜI XEM ở mọi lượt đọc/ghi.

**X3 — BLUEPRINT là định dạng gói duy nhất.** Một "blueprint" là một gói JSON có phiên bản, mô tả modules · đối tượng
tuỳ biến · field · trạng thái · form · danh sách · trang · luật · vai trò · menu · cài đặt · gợi ý tích hợp. MẪU NGÀNH
(Phase 7) là blueprint do nền tảng soạn sẵn. AI (Phase 8) soạn một blueprint (hoặc một blueprint DIFF) từ câu mô tả.
Onboarding (Phase 10) cài một blueprint. Có đúng MỘT bộ kiểm (`validateBlueprint`) và MỘT bộ cài (`applyBlueprint`,
chạy thử trước, ghi sau), và bộ cài chỉ gọi các dịch vụ metadata đã có — không bao giờ ghi thẳng bảng.

**X4 — Cài đặt không đè tuỳ biến.** Mỗi thực thể do blueprint sinh ra mang dấu gốc (`origin = template:<key>@<ver>`).
Nâng mẫu lên phiên bản mới là một PHÉP SO BA CHIỀU (bản mẫu cũ · bản mẫu mới · bản hiện tại của tổ chức): thứ tổ chức
chưa sửa thì cập nhật, thứ tổ chức đã sửa thì HỎI, thứ tổ chức đã xoá thì KHÔNG dựng lại. Chạy thử luôn đi trước.

**X5 — Đối tượng tuỳ biến dùng chung hạ tầng field của Phase 2.** Không tạo bảng vật lý cho mỗi đối tượng. Bản ghi ở
`custom_records` (cột hệ thống), giá trị ở `custom_values` (như mọi field tuỳ biến đã có), định nghĩa field ở
`meta_custom_fields` với `object_key` là khoá đối tượng tuỳ biến. Mọi dịch vụ Phase 2–4 nhận khoá đối tượng tuỳ biến
qua MỘT bộ phân giải đối tượng (`resolveObject`), không nhánh riêng.

**X6 — Cô lập tổ chức là SILO.** Mỗi tổ chức một CSDL (`getDb()`), secrets của tổ chức mã hoá trong CSDL của chính nó,
ngữ cảnh AI chỉ đọc qua các công cụ đã chạy trong ngữ cảnh tổ chức hiện hành. Thứ duy nhất dùng chung là mã nguồn và
`platform_*` (bảng điều khiển ở CSDL nhà).

**X7 — VNX là tổ chức quan trọng nhất và không bị đụng.** Không tạo tổ chức thứ hai trên production khi chưa có yêu cầu
của chủ shop; tổ chức mẫu chỉ ở bài kiểm / máy thử. Credential / khoá AI của VNX không đổi. Mọi migration CHỈ THÊM.
Tự đăng ký tổ chức (Phase 10) có cờ TẮT mặc định trên production.

## 2. Các phase

| Phase | Kết quả chứng minh được | Phụ thuộc |
|---|---|---|
| 5 | Trình kéo-thả ba cột trên schema trang; khối Filter / Column / Heading; KPI + biểu đồ tổng hợp theo field; hành động theo dòng; tự lưu có chống ghi đè | 4 |
| 6 | Đối tượng tuỳ biến: định nghĩa · field · quan hệ · trạng thái · quyền · danh sách/form/chi tiết tự sinh · luật chạy được · dùng được trong trang | 2, 3, 4 |
| 7 | Blueprint + 5 mẫu ngành (Thời trang, TMĐT chung, Bán sỉ, Sản xuất, Dịch vụ) · cài vào tổ chức · nâng phiên bản an toàn | 5, 6 |
| 8 | AI soạn blueprint / blueprint diff từ câu mô tả → xem lại → áp dụng; không bao giờ tự ghi | 7 |
| 9 | Sổ connector (năng lực · kiểu xác thực · schema cài đặt · webhook · sức khoẻ · gắn tổ chức); kết nối theo tổ chức với secrets mã hoá; hợp đồng mở rộng | 1 |
| 10 | Tự phục vụ: tạo tổ chức → loại hình → mẫu → module → xem trước → dùng; trạng thái rỗng đúng nghĩa; thương hiệu cơ bản; hạn mức theo gói | 7, 9 |
| 11 | Gia cố: quét cô lập toàn bộ bề mặt, tải nhiều tổ chức, sao lưu/khôi phục metadata, chẩn đoán | 5–10 |
| 12 | Chấp nhận thương mại: 3 tổ chức mẫu + 8 E2E cuối (xem `phase-12-acceptance.md` khi tới) | 11 |

## 3. Thứ tự song song

- Đợt 1 (bắt đầu 28/09): Phase 5 (runtime + trình kéo-thả) ‖ Phase 6 (đối tượng tuỳ biến, lõi) ‖ Phase 9 (sổ connector).
- Đợt 2: Phase 6 nối vào trang và luật ‖ Phase 7 (blueprint + mẫu) ‖ Phase 9 (kết nối theo tổ chức).
- Đợt 3: Phase 8 (AI) ‖ Phase 10 (tự phục vụ).
- Đợt 4: Phase 11 → 12.

Mỗi phase: nhánh riêng → một commit → PR → gates → gộp → deploy → kiểm production (health + smoke VNX) → phase kế.
