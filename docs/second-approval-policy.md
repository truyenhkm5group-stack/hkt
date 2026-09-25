# Phê duyệt hai bước — chính sách và trạng thái

Ngày 10/09/2026. Chủ shop chốt chính sách; tài liệu này ghi lại **cách nó được cài đặt** và **vì sao
cưỡng chế đang tắt**.

Nguồn sự thật: `lib/constants/approval.ts`. Tài liệu này mô tả lại, không định nghĩa thay.

---

## 1. Hai câu hỏi khác nhau, đừng trộn

| | |
| --- | --- |
| **AI ĐƯỢC LÀM** | thuộc về quyền (`lib/auth/session.ts::can`). Không có quyền thì không thấy nút. |
| **CÓ CẦN NGƯỜI THỨ HAI KHÔNG** | thuộc về `lib/constants/approval.ts`. Có quyền vẫn có thể cần người khác gật. |

Trộn hai thứ lại là cách nhanh nhất để vừa chặn nhầm người có quyền, vừa cho lọt việc rủi ro.

## 2. Việc CẦN người thứ hai

| Nhóm | Ngưỡng | Vì sao |
| --- | ---: | --- |
| Điều chỉnh tồn kho bằng tay | mọi mức | tạo ra hàng không tồn tại, không có chứng từ ngoài để đối chiếu |
| Ghi giảm / huỷ hàng | 1.000.000đ | mất hàng thật, và là cách che thất thoát dễ nhất |
| Sửa tiền COD | mọi mức | sửa TIỀN, mà bảng kê ĐVVC là bằng chứng duy nhất còn lại |
| Sửa / xoá khoản chi | 5.000.000đ | đi thẳng vào lợi nhuận của cả kỳ |
| Sửa lương & cơ chế trả công | mọi mức | tiền trả cho người, và người đó có thể chính là người đang sửa |
| Ghi đè kết luận ĐVVC | mọi mức | nói ngược lại chứng từ |
| Đặt hàng vượt ngưỡng | 20.000.000đ | khoá vốn nhiều tháng nếu sai |
| Đổi luật nghiệp vụ / ngưỡng | mọi mức | đổi cách ĐỌC mọi số liệu lịch sử cùng lúc |
| Thay đổi ngân sách quảng cáo | mọi mức | đốt tiền theo giờ, gõ nhầm không có phanh |

**Chưa biết số tiền ⇒ coi như VƯỢT ngưỡng.** Đoán thấp ở đây là bỏ lọt đúng việc cần canh.

## 3. Việc KHÔNG cần, và cố ý

| Việc | Vì sao |
| --- | --- |
| Phân loại / nhận / đóng việc hàng đợi | vận hành thường ngày |
| Trả lời khách | chờ duyệt là mất khách |
| Kiểm đếm hàng hoàn | đã có số đếm thực tế làm chứng |
| Tái nhập ĐÚNG BẰNG số đã kiểm đếm | không còn gì để quyết thêm |

Bắt duyệt việc thường ngày chỉ tạo thói quen bấm cho xong — và thói quen đó sẽ đi theo sang cả những
việc thật sự rủi ro.

## 4. VÌ SAO CƯỠNG CHẾ ĐANG TẮT

Đo trên production 10/09/2026:

```
vai_tro | n | dang_hoat_dong
MANAGER | 1 |              1
ADMIN   | 1 |              1
```

**Hai tài khoản.** Bật cưỡng chế "người yêu cầu ≠ người duyệt" ngay hôm nay nghĩa là chủ shop tự chặn
mình khỏi việc điều chỉnh kho, sửa chi phí hay chốt lương — những việc đang làm hằng ngày, một mình.

Một cơ chế kiểm soát làm dừng việc thật sẽ bị vô hiệu hoá trong tuần đầu, và cùng với nó là niềm tin
vào mọi cơ chế kiểm soát khác. Nên:

- **máy móc dựng đủ** — bảng, cổng, giao diện duyệt / từ chối;
- **ghi nhận chạy ngay từ đầu** — kể cả khi chưa cưỡng chế, mỗi việc rủi ro để lại một dòng nhật ký
  `approval.skip:<thao tác>` kèm nhóm, số tiền và lý do bỏ qua;
- **cưỡng chế bật theo từng nhóm** khi shop có người thứ hai thật sự.

Ghi nhận trước là điểm quan trọng: ngày bật cưỡng chế lên, shop **không bắt đầu từ con số không** —
nhìn lại được nhóm việc đó đã xảy ra bao nhiêu lần và do ai.

### Bật thế nào

Trang **Cần xử lý** (`/alerts`) → mục **Cưỡng chế duyệt hai bước** — CHỈ quản trị viên (ADMIN) thấy và
bấm được; bật phải xác nhận bằng chữ, mỗi lần bật/tắt ghi nhật ký `approval.enforce` kèm trước/sau.
Chỉ bật được nhóm ĐÃ NỐI vào thao tác thật (`APPROVAL_GROUPS_WIRED`). Bật là quyết định của chủ shop.

Công tắc ghi `settings` khoá **`approval.enforce.v2`**, hình dạng:

```json
{ "v": 2, "groups": { "INVENTORY_ADJUSTMENT": true, "PAYROLL_EDIT": true } }
```

Chỉ hình dạng này, ở khoá này, mới có hiệu lực. Bật một nhóm KHÔNG kéo theo nhóm khác; chỉ đúng boolean
`true` mới tính.

**JSON gõ tay không còn tự có hiệu lực.** Bản trước của tài liệu này bảo ghi tay khoá `approval.enforce`
dạng `{ "INVENTORY_ADJUSTMENT": true }`. Dòng như vậy CHƯA TỪNG có hiệu lực: `settings.value` là cột
TEXT và cổng cũ đưa thẳng CHUỖI JSON vào `isEnforced()` (chỉ nhận object) — cưỡng chế không bao giờ bật.
Bản Company OS sửa lỗi đọc, nhưng cố ý KHÔNG đọc khoá cũ: nếu đọc, một dòng gõ tay từ lâu sẽ BỖNG có
hiệu lực ngay sáng hôm sau deploy, và chủ shop — đang làm một mình — bị `BLOCKED_NO_APPROVER` chặn khỏi
việc kho / lương. Nay nếu còn dòng cũ, mục cưỡng chế trên `/alerts` hiện nó ("Cấu hình cưỡng chế cũ
(chưa từng có hiệu lực do lỗi đọc)") kèm nút **Áp dụng cấu hình này**: hỏi lại bằng chữ, ghi bản v2
bằng đúng các nhóm đã nối của dòng cũ (thay các công tắc hiện tại), ghi nhật ký
`approval.enforce.apply-legacy` trước/sau. Dòng cũ KHÔNG bị xoá hay sửa.

Vì sao khoá riêng chứ không đổi hình dạng trên khoá cũ: ghi v2 đè lên khoá cũ thì lần bấm công tắc đầu
tiên xoá mất lời khai cũ mà chủ shop chưa kịp thấy. Dấu `"v": 2` là lớp chặn thứ hai — chép tay hình dạng
cũ sang khoá mới vẫn không có hiệu lực.

### Sau khi được duyệt thì sao — lời duyệt dùng ĐÚNG MỘT LẦN

Trước Company OS, duyệt xong không có gì xảy ra: người xin bấm lại thì cổng đẻ yêu cầu MỚI — vòng
lặp không lối ra. Nay (`lib/approvals/service.ts`):

1. Người xin bấm lại **đúng việc đã xin** (cùng nhóm · thao tác · thực thể · payload chuẩn hoá — dấu vân
   tay sha256) ⇒ lời duyệt được **tiêu thụ**: `EXECUTED` + `executed_at`, và việc chạy.
2. Tiêu thụ là `UPDATE … WHERE id = ? AND status = 'APPROVED' RETURNING` — hai lượt bấm đồng thời chỉ
   một lượt chạy.
3. Lần thứ hai phải xin lại. Việc khác (đổi một con số) hay người khác làm hộ ⇒ không dùng được lời duyệt.
4. Lời duyệt còn hiệu lực `APPROVAL_VALID_HOURS` = **72 giờ** kể từ lúc duyệt. Hạn nằm ngay trong điều
   kiện tiêu thụ; trạng thái `EXPIRED` được GHI khi người xin chạm lại nhóm đó (không có job định kỳ).
   Hệ quả: yêu cầu quá hạn mà không ai thử lại vẫn đọc `APPROVED` trong CSDL, nhưng không mở khoá gì.
5. Bấm lại việc đang CHỜ không đẻ yêu cầu thứ hai (chỉ mục duy nhất `approval_pending_fingerprint_uq`).
6. **Thao tác được duyệt mà hỏng thì lời duyệt KHÔNG mất** (Company OS · Agent K). Hai đường, chọn theo
   nơi gọi cổng:
   - Phiếu kho (`createStockReceipt` → `lib/inventory/receipt-create.ts`): cổng đứng TRONG giao dịch ghi
     phiếu — lật `EXECUTED` + sự kiện `approval.executed` cùng giao dịch với phiếu. Phiếu hỏng ⇒ tất cả
     huỷ, lời duyệt vẫn `APPROVED`, câu lỗi vào `execution_error`.
   - Mọi server action khác gọi `guardSecondApproval` trước thân: thân action bọc bằng
     `withApprovalExecution` (`lib/approvals/execution.ts`). Cổng lật `EXECUTED` để GIỮ CHỖ; action trả
     `{ error }` hoặc ném ⇒ về lại `APPROVED` + `execution_error` (làm lại không cần xin lại); xong ⇒
     `approval.executed` phát cùng giao dịch với lượt khẳng định. Lượt đã khẳng định không bao giờ bị hồi sinh.
   - Ngoại lệ đang mở: `setReturnDisposition` (vùng Agent R) chưa bọc — cổng chạy như cũ (tiêu thụ + sự
     kiện ngay). Xem `docs/company-os/handoff-k.md`.

Ai duyệt được: quyền `approvals:decide` — ADMIN, MANAGER và người có `settings:manage` LUÔN có (đúng
tập người cũ); vai trò tuỳ chỉnh không cấp được. Việc chờ duyệt cũng hiện trên `/work` (nguồn
`APPROVAL`, phòng Điều hành), và chỉ đóng bằng Duyệt / Từ chối.

## 5. Ba chỗ cơ chế loại này thường hỏng, và cách chặn

| Hỏng thế nào | Chặn ở đâu |
| --- | --- |
| **Người xin tự duyệt** | chặn ở `decideApproval`, và chặn lần nữa bằng ràng buộc CSDL `approval_khac_nguoi` — vì một đường ghi mới trong tương lai có thể đi vòng qua tầng ứng dụng |
| **Thiếu người duyệt ⇒ tự cho qua** | trả `BLOCKED_NO_APPROVER` và DỪNG. Một cơ chế tự bỏ qua chính mình khi bất tiện sẽ im lặng đúng lúc bị lợi dụng |
| **Sổ đăng ký không ai gọi** | `tests/approval.test.ts` đọc MÃ NGUỒN của các tệp thao tác và bắt buộc bốn nhóm rủi ro nhất phải thật sự được nối |

Điều thứ ba không phải lo xa: kho mã này đã gặp đúng lỗi đó **năm lần trong một ngày** — job không có
lịch, phép nối vận đơn không canh grain, lá chắn chi phí canh sáu tệp, ranh giới ghi canh 15 tệp,
khung xương canh 21 tuyến.

## 6. Trạng thái

| Nhóm | Đã nối vào thao tác thật |
| --- | --- |
| Điều chỉnh tồn kho | ✅ `createStockReceipt` kind `ADJUSTMENT` |
| Ghi giảm / xuất tay | ✅ `createStockReceipt` kind `ISSUE` |
| Sửa / xoá khoản chi | ✅ `updateExpense`, `deleteExpense` |
| Sửa cơ chế trả công | ✅ `savePayrollConfig` |
| Đổi luật nghiệp vụ | ✅ `saveProfitAssumptions` |
| Đặt hàng vượt ngưỡng | ✅ `saveProductionOrder` |
| Sửa tiền COD | ⬜ chưa — chưa có Server Action sửa COD, hiện chỉ sửa qua script vận hành |
| Ghi đè kết luận ĐVVC | ⬜ chưa |
| Ngân sách quảng cáo | ⬜ chưa — ERP hiện KHÔNG có đường ghi ngân sách QC (lớp tư vấn chỉ đọc) |

Phần chưa nối được **in ra ở mỗi lần chạy kiểm thử**, không nằm im trong tài liệu.
