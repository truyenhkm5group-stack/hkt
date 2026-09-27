# Nền tảng ERP — Kế hoạch Phase 2 (CHƯA BẮT ĐẦU)

> Điều kiện bắt đầu: Phase 1 đạt đủ Definition of Done (yêu cầu mục 54) VÀ chạy ổn trên production ít
> nhất hai tuần với tổ chức nhà. Không làm song song với việc vá an toàn Phase 1.

## 1. Mục tiêu

Cho một tổ chức tự định hình dữ liệu và quy tắc của mình **bằng cấu hình** — không sửa mã, không
deploy — trên đúng nền Phase 1 (silo + sổ module + năng lực).

## 2. Sáu hạng mục, theo thứ tự phụ thuộc

| # | Hạng mục | Ý tưởng cốt lõi | Nằm ở đâu |
| --- | --- | --- | --- |
| 1 | **Metadata Model** | Sổ thực thể (`entity_definitions`) mô tả thực thể nghiệp vụ đã có (orders, customers, products…) + thực thể mới do tổ chức khai | CSDL tổ chức — silo cô lập miễn phí |
| 2 | **Custom Field Engine** | Trường tuỳ biến lưu `jsonb` trên bảng mở rộng `<entity>_ext` (khoá = id thực thể), KHÔNG `ALTER TABLE` lúc chạy; kiểu, bắt buộc, giá trị mặc định, kiểm hợp lệ bằng zod dựng từ metadata | CSDL tổ chức |
| 3 | **Dynamic Forms** | Form dựng từ metadata (thứ tự, nhóm, điều kiện hiện) — một renderer dùng chung, không trang riêng cho mỗi tổ chức | mã nền tảng |
| 4 | **Configurable Status** | Máy trạng thái khai được cho thực thể MỚI; thực thể có luật "không thương lượng" (đơn, vận đơn — ORDER_OUTCOME) KHÔNG cho sửa trạng thái lõi, chỉ thêm trạng thái phụ | CSDL tổ chức |
| 5 | **Simple Business Rules** | "Khi X thì Y" với tập điều kiện/hành động ĐÓNG, có chạy thử (giống luật 25 — mặc định chạy thử, `apply` mới ghi) | CSDL tổ chức |
| 6 | **Workflow Engine foundation** | Bước, người duyệt, hạn — dựng trên `work_items` (phép chiếu, luật 19) và `approval_requests` đã có, không tạo hàng đợi thứ hai | CSDL tổ chức |

## 3. Ba việc Phase 2 phải làm TRƯỚC khi thêm tính năng

1. **Tách gói ngành khỏi module chung** cho ba chỗ vỡ đã biết với tổ chức không phải thời trang-COD
   (`vnx-specific-rules.md` mục 5): `ORDER_OUTCOME` (đơn công nợ 0đ COD bị xếp hoàn), sổ kho chỉ trừ
   theo sự kiện ĐVVC, cảnh báo `VTP_ORDER_LIST_DUE` bật mặc định. Mỗi cái thành một feature có bản cài
   của gói ngành; tổ chức nhà giữ bản hiện tại, contract test giữ nguyên.
2. **Credential theo tổ chức** cho connector (P12): màn hình khai + lưu mã hoá trong CSDL tổ chức; bảng
   liên kết "tài khoản bên ngoài → tổ chức" để webhook phân giải tường minh (thay `HOME_ONLY`).
3. **Lọc `/work` theo module bật**: `/`, `/cockpit`, `/data-quality` đã lọc ở Phase 1.x (`lib/platform-ui/module-visibility.ts`); còn hàng đợi `/work` đọc cả nguồn việc của module đang tắt.

## 4. Không làm ở Phase 2

Kéo-thả trang, AI dựng ERP, marketplace plugin — chỉ bắt đầu khi Dynamic Page Runtime và Workflow
Runtime đã ổn định (yêu cầu mục 40). Builder chỉ là trình soạn metadata, không phải nền móng.

## 5. Rủi ro đã thấy trước

- Trường tuỳ biến trong báo cáo: báo cáo hiện là SQL viết tay; nối `jsonb` vào 1.879 đoạn SQL là
  không khả thi ⇒ trường tuỳ biến chỉ vào báo cáo MỚI dựng từ metadata, báo cáo cũ giữ nguyên.
- Hiệu năng `jsonb` trên VPS 2 nhân: chỉ mục GIN chỉ khi đo được truy vấn thật cần nó.
- Luật "đích không hard-code" (AGENTS 38) và "không backfill im lặng" (8.8) áp nguyên cho metadata.
