# QUY TRÌNH TAY ĐÁP YÊU CẦU CỦA CHỦ THỂ DỮ LIỆU (DSR) — M-DSR-MANUAL

> 09/10/2026 · phiên bản 0.1 · mission M-DSR-MANUAL (`TECH_HANDOFF_LEGAL.md`), ô P0-9 của `LEGAL_LAUNCH_GATE.md`.
> Tài liệu này mô tả **cơ chế đang có** để đáp nghĩa vụ «đáp yêu cầu của chủ thể dữ liệu trong hạn» (Luật 91; NĐ 356) —
> KHÔNG phải ý kiến pháp lý và KHÔNG khẳng định đã tuân thủ. Mọi mốc thời hạn có ghi rõ nguồn và trạng thái xác nhận.
> **Không thêm gì cho khách hàng cuối**: không popup, không câu chữ mới trong hội thoại bán hàng hay luồng đơn — yêu cầu đi
> qua khách thuê (Bên Kiểm soát dữ liệu nhóm B) hoặc qua kênh hỗ trợ đã công bố.

## 1. Ai là ai

| Nhóm | Chủ thể | Ai kiểm soát | Kênh tiếp nhận | Ai thực hiện |
|---|---|---|---|---|
| A | Người đăng ký, quản trị, nhân viên của khách thuê (tài khoản) | VNX | Email hỗ trợ đã công bố ở Chính sách §9 (`COMPANY.email`) · điện thoại / Zalo công ty (`lib/constants/company.ts`) | Người vận hành nền tảng |
| B | Khách hàng cuối của khách thuê (người nhắn tin / mua hàng) | Khách thuê | Chủ thể gửi **cửa hàng đã thu thập dữ liệu** (Chính sách §8); cửa hàng chuyển cho VNX qua kênh hỗ trợ khi cần hỗ trợ | Khách thuê, VNX hỗ trợ (Bên Xử lý) |

Người vận hành nền tảng chỉ tự thao tác dữ liệu nhóm A. Với nhóm B, VNX làm theo chỉ dẫn của khách thuê, và mọi tra cứu đi
qua `getDb()` của ĐÚNG tổ chức đó (`VIETNAM_LEGAL_COMPLIANCE.md` §9). Người nhận yêu cầu ở VNX: **chưa chỉ định** (F-4).

## 2. Thời hạn — con số nào có căn cứ, con số nào chờ luật sư

| Việc | Mốc | Nguồn | Trạng thái |
|---|---|---|---|
| Phản hồi tiếp nhận | 2 ngày | Tài liệu Phase 1 (`VIETNAM_LEGAL_COMPLIANCE.md` §9, `LEGAL_LAUNCH_GATE.md` P0-9) ghi theo NĐ 356 — chưa dẫn số điều | **CHỜ G** |
| Sửa dữ liệu | 10 ngày | Như trên | **CHỜ G** |
| Hạn chế xử lý | 15 ngày | Như trên | **CHỜ G** |
| Xoá dữ liệu | 20 ngày | Như trên | **CHỜ G** |
| Xoá tài khoản / dữ liệu nhóm A sau khi xác minh | 30 ngày | Chính sách quyền riêng tư 1.1 §9 — chủ nền tảng đã công bố | Cam kết đã công bố — **mâu thuẫn tiềm tàng**: nếu G xác nhận mốc 20 ngày cho xoá thì 30 ngày ở Chính sách phải sửa |
| VNX hỗ trợ khách thuê thực hiện yêu cầu nhóm B | [5] ngày làm việc | Khung DPA nháp (`DATA_PROCESSING_REGISTER.md` §6 mục 10) | **CHƯA QUYẾT** (F + G-10) |

Cho tới khi luật sư trả lời: người xử lý **nhắm mốc NGẮN NHẤT** của bảng cho từng loại việc. Đây là lựa chọn vận hành phía an
toàn (đáp sớm hơn hạn không trái luật), không phải một khẳng định về thời hạn pháp lý; không mốc nào ở trên được gõ vào mã.

## 3. Các bước

### 3.1 Tiếp nhận
1. Ghi yêu cầu vào **sổ yêu cầu** (mục 5) ngay khi nhận: loại (xem / xuất · sửa · hạn chế / phản đối · rút đồng ý · xoá),
   kênh, mốc nhận, tổ chức liên quan.
2. Nhóm B gửi thẳng tới VNX (không qua cửa hàng): trả lời chủ thể rằng yêu cầu được chuyển tới cửa hàng đã thu thập dữ liệu,
   và báo quản trị của tổ chức đó qua kênh hỗ trợ. VNX không tự quyết thay Bên Kiểm soát.

### 3.2 Xác minh
- Nhóm A: xác minh qua email hoặc số điện thoại đã đăng ký (Chính sách §9); không nhận tài liệu định danh qua kênh chat bên
  ngoài (Telegram / Lark).
- Nhóm B: khách thuê xác minh chủ thể (hội thoại cùng PSID / Zalo id, SĐT trên đơn); VNX xác minh người gửi chỉ dẫn là quản
  trị của tổ chức (tài khoản có quyền `settings:manage`).

### 3.3 Thực hiện — công cụ ĐANG có và chỗ còn thiếu

| Loại | Đang có | Thiếu (mission) |
|---|---|---|
| Xem / xuất | Xuất CSV toàn tổ chức `/settings/data-export` (`lib/exports/tenant-data.ts`, ghi `DATA_EXPORT`); hộp thư tìm theo hội thoại | Xuất theo **một** chủ thể, gồm hội thoại (M-DSR) |
| Sửa | Nhân viên sửa khách / đơn trong phần mềm; người dùng tự sửa hồ sơ | — |
| Hạn chế / phản đối tiếp thị | Đổi hội thoại sang chế độ người phụ trách (`lib/sales-chatbot/conversation-control.ts`); `mark_declined` dừng follow-up của hội thoại | Sổ từ chối nhận tin theo người (M-OPTOUT) |
| Xoá nhóm A | Khoá tài khoản; xoá cả workspace `lib/platform/offboard.ts` (chạy thử trước, không đụng tiền) | Xoá / ẩn danh **một** tài khoản (`lib/auth/identities.ts`: chỉ có KHOÁ) |
| Xoá nhóm B | Không có đường xoá một khách hàng cuối xuyên bảng | `scripts/subject-erase.ts` chạy thử theo SĐT / PSID / email (M-DSR-MANUAL phần mã) |

Cho tới khi có script: liệt kê dòng của chủ thể bằng ops chỉ đọc theo bảng tra ngược `DATA_PROCESSING_REGISTER.md` §3, kết quả
đi kênh mã hoá hiện có — KHÔNG dán dữ liệu người vào issue, log CI hay nhóm chat. Sửa / xoá dữ liệu production chỉ qua
job / action của ứng dụng (AGENTS §4) — thao tác xoá hàng loạt phải hỏi chủ shop trước (AGENTS §7).

### 3.4 LEGAL HOLD — dữ liệu KHÔNG xoá theo yêu cầu
Nguồn: `lib/constants/retention.ts` (`legalHold: true`, `subjectEraseAllowed()` trả `false`):

| Loại | Vì sao giữ | Làm gì thay vì xoá |
|---|---|---|
| Đơn hàng, chứng từ giao dịch (D7) | Nghĩa vụ kế toán / thuế của khách thuê — thời hạn chờ E | Ẩn danh trường không cần cho kế toán (tên hiển thị, ghi chú tự do); giữ phần còn lại + ghi lý do vào sổ yêu cầu |
| Thanh toán phí, hoá đơn, Số dư AI (D11) | Chứng từ kế toán của VNX — thời hạn chờ E | Giữ nguyên; trả lời chủ thể lý do giữ |
| Nhật ký kiểm toán (D13) | Trách nhiệm giải trình — thời hạn chờ F + G | Giữ; chỉ thêm, không sửa |
| Bản sao lưu (D16) | Khôi phục sự cố | Không chạm; dữ liệu tự hết hạn theo xoay vòng (Chính sách §9 đã nói) |

Thời hạn giữ của từng loại: **chưa quyết** (`retentionDays: null`) — LEGAL HOLD không có nghĩa «giữ mãi», nghĩa là «không
xoá theo yêu cầu cho tới khi có thời hạn được quyết».

### 3.5 Trả lời
Trả lời bằng đúng kênh đã nhận, nêu: đã làm gì, phần nào giữ lại và vì sao, bản sao lưu hết hạn khi nào. Đóng dòng trong sổ.

## 4. Không làm

- Không thêm thông báo, câu hỏi hay nút DSR vào hội thoại bán hàng / luồng đơn (OWNER OVERRIDE 08/10).
- Không xoá chứng từ đang LEGAL HOLD để «cho nhanh».
- Không chép dữ liệu của chủ thể sang tổ chức khác, kênh chat bên ngoài, hay bản ghi sự cố.

## 5. Sổ yêu cầu (tạm, cho tới khi có bảng `data_subject_requests` — M-DSR)

Mỗi yêu cầu một dòng: mã yêu cầu · loại · nhóm (A / B) · tổ chức · chủ thể **đã che** (băm hoặc 3 số cuối SĐT) · kênh · mốc
nhận · hạn mục tiêu (mục 2) · người xử lý · kết quả · phần LEGAL HOLD + lý do · mốc đóng. Sổ chứa dữ liệu cá nhân nên lưu
trên hệ thống trong nước của VNX, không trên Lark / Telegram.

## 6. Việc còn mở

| # | Việc | Ai |
|---|---|---|
| 1 | Xác nhận các mốc 2 / 10 / 15 / 20 ngày (số điều, mốc tính từ khi nào, ngày làm việc hay ngày lịch) | G |
| 2 | Chỉ định người tiếp nhận và người thay thế | F (F-4) |
| 3 | Thời hạn giữ chứng từ cho LEGAL HOLD | E |
| 4 | `scripts/subject-erase.ts` chạy thử, rồi công cụ tự phục vụ | Kỹ thuật (M-DSR-MANUAL, M-DSR) |
| 5 | Mốc 30 ngày ở Chính sách §9 khớp với mốc luật định sau khi G trả lời | F + G |
