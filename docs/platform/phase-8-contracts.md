# Phase 8 — AI ERP Builder: hợp đồng

> AI SOẠN, người DUYỆT, bộ cài của Phase 7 GHI. AI không có đường ghi nào của riêng nó (X1, X3).

## 1. Ai trả tiền AI, khoá nằm đâu (X6, X7)

`getBuilderAi(org)` chọn provider theo thứ tự, không bao giờ lẫn sang tổ chức khác:
1. **Kết nối AI của CHÍNH tổ chức** (Phase 9, connector `anthropic-byok` / `openai-byok`, `tenancy: PER_ORG`, khoá mã hoá
   trong `org_connections`, bật sau `testConnection`) — tổ chức mang khoá của mình.
2. **Tổ chức nhà** — provider hiện có (`getAiProvider`, khoá `.env` của VNX), đúng như Copilot đang dùng.
3. Không có ⇒ AI Builder hiện "chưa có kết nối AI" + đường tới `/settings/connections`. Mẫu ngành (Phase 7) vẫn dùng được.

Không có khoá AI "của nền tảng" dùng chung: ai dùng người ấy trả, và ngữ cảnh không bao giờ đi qua khoá của tổ chức khác.
*Cập nhật (0175, `docs/platform/ai-usage.md`):* nền đã có nhánh thứ ba — khoá của NỀN TẢNG (`PLATFORM_AI_API_KEY`, khác
khoá của nhà) trừ credit theo gói — MẶC ĐỊNH TẮT, bật là quyết định của chủ nền tảng (launch-gates.md mục D). Mọi lượt
ghi sổ `platform_ai_usage`; hạn mức `checkAiQuota` và công tắc AI chặn TRƯỚC khi gọi model.
Bài kiểm dùng provider giả tiêm vào (không gọi mạng).

## 2. Hai chế độ

| Chế độ | Đầu vào | Đầu ra |
|---|---|---|
| **Dựng mới** | câu mô tả doanh nghiệp | `Blueprint` đầy đủ (key `ai-<ngẫu nhiên>`, version `1.0.0`) |
| **Sửa lặp** | câu yêu cầu thay đổi + tóm tắt cấu hình HIỆN TẠI của tổ chức | `Blueprint` MẢNH (chỉ các mục thêm/sửa; cùng định dạng) |

Lời gọi AI dùng MỘT công cụ có `input_schema` = JSON Schema sinh từ zod của blueprint (`lib/blueprints/schema.ts`), kèm
bản tóm tắt SỔ (module + phụ thuộc, kiểu field, loại khối trang + khoá nguồn/action, trigger/action luật, khoá quyền an
toàn). Trả lời không qua công cụ ⇒ bỏ. Đầu ra đi qua `validateBlueprint`; lỗi ⇒ gửi lại danh sách `path + message` cho AI
sửa, TỐI ĐA 2 lượt, rồi dừng và hiện lỗi cho người.

Tóm tắt cấu hình hiện tại (chế độ sửa) CHỈ gồm metadata (module bật, đối tượng, field, form, trang, luật — tên + khoá),
KHÔNG bao giờ có bản ghi, giá trị field, secrets, người dùng.

## 3. Lưu nháp và duyệt

- Bảng `ai_blueprint_drafts` (CSDL tổ chức, CHỈ THÊM): prompt, mode, blueprint jsonb, validation, plan hash, trạng thái
  `DRAFT | APPLIED | DISCARDED`, created_by, token/chi phí ước tính, timestamps. Audit mỗi lượt tạo / áp dụng / bỏ.
- Màn `/settings/ai-builder` (quyền `metadata:manage`): ô mô tả → **Tạo bản nháp** → bản tóm tắt theo nhóm (module · đối
  tượng · field · form · trang · luật · vai trò · gợi ý tích hợp) → người BỎ CHỌN từng mục được → **Xem trước** (=
  `planForOrg`, hiện CREATE/UPDATE/CONFLICT) → **Áp dụng** (`installBlueprint` với `expectedPlanHash`) → kết quả từng bước.
- Sửa lặp: "Thêm bước trưởng phòng duyệt đơn trên 20 triệu" ⇒ mảnh chứa một luật (NHÁP) ⇒ xem trước diff ⇒ áp dụng.
  "Dashboard thêm doanh thu theo nhân viên" ⇒ mảnh chứa trang cập nhật ⇒ vào NHÁP của trang, người xuất bản.

## 4. An toàn (bài kiểm bắt buộc)

- Không mã, không SQL, không URL: mọi thứ AI trả là dữ liệu qua zod; trường chữ tự do chỉ là nhãn/mô tả.
- Vai trò: không `users:manage`, không base ADMIN (luật 31) — BLOCKED ở bộ kiểm, AI không vượt được.
- Luật luôn NHÁP + CHẠY THỬ; AI không bật luật, không xuất bản trang (trừ lần cài đầu nếu người chọn), không bật kết nối,
  không nhập secrets (mục `integrations` chỉ là gợi ý).
- Prompt injection: câu mô tả của người dùng nằm trong khối dữ liệu có ranh giới; mọi "chỉ dẫn" trong đó không đổi được
  công cụ hay sổ. Đầu ra vẫn phải qua bộ kiểm — đó là hàng rào thật.
- Hạn mức: trần số lượt / ngày / tổ chức (Phase 10 entitlement nối vào sau), trần token mỗi lượt.

## 5. Ghi chú hiện thực (đọc từ mã đã làm)

- Mã: `lib/ai-builder/*` (provider · providers · prompt · draft · select · metadata · service · types),
  `lib/actions/ai-builder.ts`, `app/(dashboard)/settings/ai-builder/`, `components/ai-builder/`, migration
  `0168_ai_blueprint_drafts`. Bài kiểm: `tests/ai-builder.test.ts`. Trần: `AI_BUILDER_LIMITS` (20 lượt soạn / ngày /
  tổ chức, 16.000 token / lời gọi, 2 lượt sửa, câu mô tả ≤ 4.000 ký tự).
- Máy chủ CHUẨN HOÁ xác định, không "sửa hộ" AI: điền `format/formatVersion/key=ai-<8 hex>/version=1.0.0`; thêm module
  lõi + phụ thuộc còn thiếu; chế độ sửa thêm mọi module đang bật; gắn field ĐÃ CÓ mà mảnh tham chiếu (dựng từ chính
  định nghĩa đang dùng ⇒ kế hoạch UNCHANGED). Mục máy chủ thêm là MỤC NGỮ CẢNH (`context_keys`): hiện ra, không bỏ chọn
  được. JSON hỏng / khoá lạ KHÔNG được vá — quay lại AI như lỗi của bộ kiểm.
- Mảnh sửa lặp mang khoá gói MỚI, nên mục cùng khoá với thứ đã có (trang, form) ra `CONFLICT` kèm khác biệt; người bật
  «Ghi đè» từng mục ⇒ cập nhật vào NHÁP. Không có "nâng phiên bản" ngầm của một gói AI cũ.
- Câu trả lời không qua công cụ / gọi công cụ lạ ⇒ dừng ngay (không tốn lượt sửa); JSON hỏng / gói lỗi ⇒ tối đa 2 lượt
  sửa. Nháp lỗi VẪN lưu (người thấy lỗi và chi phí); nháp không có gói không xem trước / áp dụng được.
- Không ép `tool_choice` (model thế hệ mới từ chối ép công cụ khi suy luận bật) và không `strict` (schema có ô
  `unknown`): cổng thật là `validateBlueprint` ở máy chủ.
