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

Ghi `settings` khoá `approval.enforce`, giá trị JSON theo nhóm:

```json
{ "INVENTORY_ADJUSTMENT": true, "PAYROLL_EDIT": true }
```

Bật một nhóm KHÔNG kéo theo nhóm khác. Chỉ đúng boolean `true` mới tính.

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
| Sửa tiền COD | ⬜ chưa |
| Ghi đè kết luận ĐVVC | ⬜ chưa |
| Đặt hàng vượt ngưỡng | ⬜ chưa |
| Đổi luật nghiệp vụ | ⬜ chưa |
| Ngân sách quảng cáo | ⬜ chưa — ERP hiện KHÔNG có đường ghi ngân sách QC (lớp tư vấn chỉ đọc) |

Phần chưa nối được **in ra ở mỗi lần chạy kiểm thử**, không nằm im trong tài liệu.
