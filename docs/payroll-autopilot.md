# Lương tự động — tính, gửi phiếu, duyệt, chuyển tiền

Chủ shop chốt ngày 25/09/2026:

| Quyết định | Giá trị |
|---|---|
| Ngày chốt số | **01** hằng tháng (kỳ lương = trọn tháng trước) |
| Ngày trả lương | **15** |
| Đơn chưa có kết cục lúc chốt | "làm sao hợp lý nhất, dễ trình bày, dễ đối soát" → **quyết toán kỳ trước** (mục 2) |
| Khiếu nại | **không chặn** trả lương; trả đúng hạn theo số đã tính, sai thì điều chỉnh kỳ sau |
| Thuế TNCN / BHXH | khai **Không áp dụng** (phần lớn là cộng tác viên / khoán) — làm ở `/payroll/settings` |
| Gửi phiếu cho nhân viên | cách nào tiện nhất → **hộp thư ERP** của từng người (mục 3) |
| Job tự động | được phép thêm; tình trạng nhân sự có "Đang làm / Đã nghỉ" (mục 1) |

Mã nguồn: `lib/constants/payroll-autopilot.ts` (lịch + kế hoạch, hàm thuần) · `lib/payroll/autopilot.ts`
(bộ chạy) · `lib/payroll/run-service.ts` (lõi dùng chung người–máy) · `lib/payroll/payslip-delivery.ts` ·
`lib/payroll/payout.ts` · `lib/payroll/settlement.ts` · `lib/payroll/vietqr.ts`. Màn hình:
`/payroll/autopilot` (người duyệt) và `/my-payslip` (nhân viên). Kiểm thử: `tests/payroll-autopilot.test.ts`.

## 0. Máy làm, người ký

| Máy tự làm | Máy KHÔNG BAO GIỜ làm |
|---|---|
| mở kỳ, quyết toán kỳ trước, tính & chụp ảnh, chuyển soát | duyệt · khoá · mở khoá |
| gửi phiếu vào hộp thư, nhắc duyệt (từ ngày 13), nhắc chuyển (từ ngày 15) | khai "đã trả" khi chưa có dòng sao kê |
| lập lệnh chuyển khi kỳ được khoá, khớp tiền ra với sao kê | chuyển tiền |

Công tắc `payroll.autopilot` mặc định **TẮT**; bật là một lần chủ shop bấm ở `/payroll/autopilot`, có
nhật ký. Khớp tiền ra với lệnh chuyển chạy cả khi tắt — nó chỉ đọc chứng từ ngân hàng cho những lệnh
người đã lập. Máy đi ĐÚNG cửa người đi (`run-service.ts`), và lõi tự chặn máy ở mọi việc ngoài
`CALCULATE` / `SUBMIT_REVIEW`.

### Cài đặt một lần (trang `/payroll/autopilot` in danh sách này, mục nào xong tự tắt)

1. **Nguồn ghi nhận chi phí nhân sự = bảng Lương** (`/payroll/settings`). Chế độ cũ lấy khoản chi
   "Lương" gõ tay ở bảng Chi phí; ngày 01 chưa ai nhập khoản ấy nên ERP **chặn chốt** mọi kỳ (lợi
   nhuận chưa trừ đồng lương nào mà đã đem tính hoa hồng). Đo được trong bài kiểm, không phải giả định.
2. **Thuế TNCN / BHXH = Không áp dụng** kèm căn cứ (quyết định của chủ shop ngày 25/09/2026).
3. **Email đăng nhập ERP** của từng nhân sự trùng một tài khoản đang bật — để nhận phiếu.
4. **Tài khoản nhận lương** của từng nhân sự — để dựng mã QR.
5. Bật công tắc **Lương tự động**.

### Vì sao ERP không tự chuyển tiền

Tài khoản nhận COD là tài khoản **cá nhân** MB; SePay chỉ **đọc** giao dịch. Không ngân hàng nào cho bên
thứ ba rút tiền khỏi tài khoản cá nhân bằng API. Và kể cả khi có (tài khoản doanh nghiệp + hợp đồng chi
hộ), một nút trong ERP làm tiền đi thẳng nghĩa là **ai chiếm được ERP là rút được tiền**; bước OTP trên
app ngân hàng là lớp bảo vệ đáng giữ nhất. ERP làm hết phần còn lại: mã VietQR mang sẵn ngân hàng, STK,
số tiền, nội dung; chủ shop quét, so tên người nhận, xác nhận.

## 1. Tình trạng nhân sự: "đã nghỉ" đi bằng NGÀY

Ô "Đang làm việc" cũ: bỏ tick là người ấy biến mất khỏi **mọi** kỳ, kể cả tháng còn làm dở. Nay hồ sơ có
Tình trạng + **Ngày vào làm** + **Ngày làm cuối** (bắt buộc khi Đã nghỉ). Luật một chỗ:
`lib/constants/payroll-employment.ts::employmentWindow`, dùng chung cho bảng lương và chi phí nhân sự
của báo cáo lợi nhuận. Lương cứng chia theo đúng số ngày còn làm. Hồ sơ không khai ngày ⇒ con số y như
trước (không backfill ngày cho ai).

Hồ sơ còn có **tài khoản nhận lương** (ngân hàng theo mã BIN NAPAS · STK · tên chủ TK không dấu). Đổi STK
ghi một dòng nhật ký riêng (`PAYROLL_BANK_ACCOUNT_CHANGE`) và lệnh chuyển kỳ sau in đỏ "STK khác lần trả
trước".

## 2. Đơn chưa có kết cục lúc chốt → quyết toán kỳ trước

Lương tháng M chốt 01/M+1 khi đơn của mấy ngày cuối tháng phần lớn chưa có kết cục (hoàn trung bình
~7,7 ngày). Bảng lương lọc đơn theo ngày đơn lên, nên nếu không làm gì thì đuôi hoa hồng ấy **không bao
giờ được trả**.

**Mỗi kỳ quyết toán hai lần, trả cùng lương tháng sau:**

1. Ngày 01/M+1 — tạm tính theo đơn đã có kết cục. Đây là số chốt, duyệt, trả ngày 15.
2. Ngày 01/M+2 — máy tính lại kỳ M bằng dữ liệu hôm ấy, **giữ nguyên tỷ lệ đã chốt** (lấy từ ảnh chụp).
   Phần chênh thành **một dòng điều chỉnh** của kỳ M+1: `Quyết toán tháng MM/YYYY — truy lĩnh` (hoặc
   `truy thu` nếu âm), lý do ghi đủ "trước → sau" của từng con số.

Lương cứng không quyết toán. Người có sổ lỗ lũy kế ⇒ `Cần quyết toán tay` (số dư mang sang đã chốt theo
số tạm tính; máy không đoán lại cả chuỗi). Một con số CHƯA BIẾT ⇒ `Chưa biết`, không quy về 0. Ảnh chụp
kỳ M không bao giờ bị viết lại (AGENTS.md mục 21). Chạy lại quyết toán thì máy xoá **đúng dòng của máy**
(`created_by IS NULL` + cùng `reference`) rồi ghi lại; dòng người nhập không bị chạm.

Kéo theo một sửa lỗi: khoản điều chỉnh (`payroll_adjustments`) trước đây chỉ vào lương người đã gán
chính sách; người ở đường tính cũ nhập vào thì nằm im. Nay đường cũ cộng chúng (cùng dấu
`PAYROLL_COMPONENT_SIGN`), ảnh chụp giữ `legacyAdjustments`, tệp CSV có cột "Điều chỉnh".
`PAYROLL_CALC_VERSION` = 3.

## 3. Phiếu lương gửi riêng từng người

Khi kỳ chuyển sang **Đang soát** (máy hoặc người bấm), `deliverPayslips` ghi một dòng
`payroll_confirmations` cho mỗi người trong ảnh chụp và một tin vào **hộp thư cá nhân**
(`user_messages`, hiện ở chuông thông báo mục "Gửi riêng bạn"). Người nhận do máy chủ khớp email hồ sơ ↔
tài khoản ERP đang bật; không khớp được ⇒ dòng vẫn có, trạng thái "Chưa gửi được", màn hình nói ra.

- Phiếu là **ảnh chụp lúc gửi**. Tính lại kỳ ⇒ lượt gửi mới (`round`); lời xác nhận cũ không trôi sang số mới.
- Trang `/my-payslip`: cổng là **quyền sở hữu phiếu** (`payslipOwnerGate`), không phải khoá quyền lương —
  hẹp hơn `payroll:view-own`, không cần cấp thêm quyền cho vai trò Kho / CSKH.
- Hạn 48 giờ. Quá hạn mà im lặng ⇒ **"không phản hồi"**, KHÔNG phải "đã xác nhận" (tính lúc đọc).
- Khiếu nại bắt buộc lý do; người duyệt nhận tin. Tiêu đề tin không bao giờ in số tiền; nhóm Lark chỉ
  nhận câu không có số tiền.

## 4. Lệnh chuyển và "đã trả"

Bấm **Duyệt & khoá** = hai lượt `movePayrollRun` (APPROVE rồi LOCK), qua đủ cổng người thứ hai. Bước
LOCK lập `payroll_payout_lines` từ ảnh chụp: số tiền = thực nhận đã duyệt (≤ 0 thì không có dòng),
tài khoản chụp từ hồ sơ, nội dung riêng `LUONG T092026 X7K2` (ổn định, không trùng, không lồng nhau).

**"Đã trả" chỉ bằng sao kê.** Máy khớp dòng tiền RA có nội dung chứa mã **và** số tiền bằng đúng số của
lệnh. Nội dung gõ khác ⇒ người bấm "Khớp tay" và phải chọn một dòng sao kê có thật, đúng số tiền. Mối nối
đi qua đường ghi duy nhất `lib/finance/linkage.ts::createLink` (loại `PAYROLL_PERIOD`, khoá `YYYY-MM`) —
nối không phải ghi nhận chi phí (AGENTS.md mục 17). Đủ mọi dòng ⇒ kỳ tự sang **ĐÃ TRẢ**, `paid_by = NULL`
(máy), chứng từ là các dòng sao kê. `MARK_PAID` (lời khẳng định, cần người thứ hai) vẫn còn cho trường hợp
sổ ngân hàng không có dữ liệu.

**Cần biết:** SePay đã cấu hình, nhưng chưa rõ nó có đẩy **tiền RA** của tài khoản MB hay không. Nếu
không, tải sao kê MB ở trang Ngân hàng sau khi chuyển — máy khớp y như vậy.

## 5. Lịch

| Khi | Việc |
|---|---|
| 01, từ 09:00 | quyết toán kỳ trước nữa (nếu đã khoá) → tính & chụp ảnh → chuyển soát → gửi phiếu. Chưa tính được ⇒ báo một lần mỗi ngày kèm nguyên văn việc còn thiếu, thử lại mỗi giờ |
| +48 giờ | vòng xác nhận khép ⇒ một tin "sẵn sàng duyệt" |
| từ 13 | chưa duyệt ⇒ nhắc mỗi ngày |
| 15 | còn người chưa có sao kê ⇒ nhắc mỗi ngày |

Job `payroll-autopilot` chạy mỗi 60 phút (`PAYROLL_AUTOPILOT_EVERY_MINUTES`). Mọi tin và mọi dòng có
khoá chống trùng ở CSDL, nên chạy lại vô hại.

## 6. Kiểm trên production sau khi deploy (chỉ đọc)

```sql
select count(*) from payroll_confirmations;           -- 0 cho tới khi bật công tắc và tới ngày 01
select count(*) from payroll_payout_lines;            -- 0 cho tới lần Duyệt & khoá đầu tiên
select value from settings where key = 'payroll.autopilot';  -- trống = TẮT
```
