# Payroll dùng được thật: cơ sở có tên, vòng đời có chữ ký, chuyển đổi có đối chiếu · 15/09/2026

Nối tiếp `docs/release-2026-09-15b-payroll-policy-engine.md`. Cùng nhánh `claude/elegant-curie-zn92up`.

---

## 0. ĐỌC NHANH — vòng này giải quyết gì

| Việc | Trước | Sau |
|---|---|---|
| `COMMISSION_BASIS_NEEDS_REVIEW` | cảnh báo VÔ ĐIỀU KIỆN, không bao giờ tắt được | cơ sở có tên; cảnh báo chỉ bật khi ĐO ĐƯỢC có hoa hồng nằm nhầm chỗ |
| Chốt kỳ | một lượt bấm đi thẳng từ chưa có gì tới BẤT BIẾN | sáu trạng thái, duyệt là một chữ ký có tên và có quyền riêng |
| Lợi nhuận cá nhân | một con số, không bóc tách được | bảy dòng, mỗi dòng bấm được về chứng từ gốc |
| Chuyển người sang máy mới | phải gõ tay từng chính sách | xem trước · đối chiếu từng khoản · bấm từng người |
| Cấu hình lương | chỉ đặt được bằng script chạy tay trên VPS | có nút, có cảnh báo, có nhật ký, cần người thứ hai |
| Kiểm sổ khai | không có | chồng lấn · khoảng trống · thiếu tham số · phiên bản chưa hiệu lực |

---

## 1. `COMMISSION_BASIS_NEEDS_REVIEW` — giải bằng một LỜI KHAI, không bằng một con số

Vòng tròn chỉ tồn tại khi cơ sở tính hoa hồng và lợi nhuận kế toán là **cùng một số**:

```
hoa hồng  = r × lợi nhuận
lợi nhuận = doanh thu − … − hoa hồng
```

Hai vế định nghĩa lẫn nhau. Đó không phải bài toán khó — nó là một phép khai KHÔNG XÁC ĐỊNH, và
mọi cách "giải" đều là chọn một điểm dừng tuỳ tiện rồi gọi đó là kết quả.

**Cách thoát: đặt tên cho điểm dừng.**

```
PRE_VARIABLE_COMPENSATION_PROFIT   (“Lợi nhuận trước thù lao biến đổi”)
  = doanh thu giao thành công
  − giá vốn hàng ĐÃ GIAO
  − quảng cáo
  − cước vận chuyển và phí hoàn
  − lương CỨNG
  − chi phí cố định phân bổ + vận hành đã ghi nhận
  − dự phòng rủi ro tồn kho theo GIÁ VỐN HÀNG BÁN RA

hoa hồng          = r × (cơ sở ấy, sau bù lỗ lũy kế)
LỢI NHUẬN KẾ TOÁN = cơ sở − hoa hồng
```

**Vì sao lương cứng ở trong, hoa hồng thì không** — và đây là ranh giới duy nhất, kiểm được bằng
máy chứ không bằng cảm tính: lương cứng **không phải hàm của lợi nhuận** (một con số khai theo
tháng, tính được trước khi biết lợi nhuận). Hoa hồng thì có.

`lib/constants/compensation-profit.ts` khai một dòng cho **mỗi** thành phần trong `COST_COMPONENTS`:
trong hay ngoài cơ sở, và VÌ SAO. Bỏ sót một thành phần là để một khoản chi thật rơi ra ngoài mà
không ai quyết định điều đó — `tests/compensation-profit.test.ts` chặn.

**Phần còn lại, và nó ĐO ĐƯỢC:** hoa hồng đã trả ghi ở bảng Chi phí nhóm "Lương" thì nằm trong chi
phí vận hành — tức trong chính cơ sở mà lời khai vừa nói phải loại nó ra. Hệ quả: cơ sở kỳ này bị
trừ đi hoa hồng của kỳ TRƯỚC. Cảnh báo nay bật **có điều kiện** trên đúng khoản dư ấy.

**Vì sao bảng Lương vẫn chưa ghi nhận hoa hồng:** lý do đổi từ *vòng tròn khái niệm* sang *vòng gọi
hàm ở mức mã nguồn* (`getOperatingCost` → `payroll-cost` → `getPayrollReport` → `getMarketerReport`
→ `getOperatingCost`). Khái niệm đã hết vòng; lời gọi thì chưa. Đây là việc còn lại, và nó là một
bài toán kỹ thuật có lời giải, không còn là một câu hỏi treo cho chủ shop.

## 2. VÒNG ĐỜI KỲ LƯƠNG

`DRAFT → CALCULATED → UNDER_REVIEW → APPROVED → LOCKED → PAID`

* **Quyền `payroll:approve` là quyền MỚI**, tách khỏi `payroll:manage`: người khai số và người duyệt
  số không nên là một. Mặc định KHÔNG mở cho vai MANAGER.
* **Ba việc đi qua người thứ hai**, mỗi việc nguy hiểm một kiểu: DUYỆT (người duyệt có thể chính là
  người được hưởng) · MỞ KHOÁ (làm một kỳ đã trả tiền đổi số được) · ĐÁNH DẤU ĐÃ TRẢ (không ai kiểm
  lại nếu sai).
* **Sổ lỗ lũy kế ghi NHÁP ở bước tính, thành chính thức đúng lúc KHOÁ.** Đóng băng nó sớm hơn là
  khẳng định một nghĩa vụ dựa trên con số còn sửa được. Mở khoá hạ nó về nháp.
* **`FINAL` cũ không bị viết lại** — nó ở lại trong `CHECK` và được ĐỌC như `LOCKED`.
* Bảng chuyển trạng thái là **DỮ LIỆU**, màn hình và máy chủ đọc chính nó. Bộ kiểm đối chiếu hai
  hàm ấy và đã bắt được một lối đi vòng (xem mục 6).

## 3. BÓC TÁCH LỢI NHUẬN + TRUY NGUYÊN

Doanh thu → giá vốn → quảng cáo → QC thử → cước → phân bổ → chia % chủ mã → **lợi nhuận kỳ**, rồi
lỗ mang sang → cơ sở sau bù → tỷ lệ → **hoa hồng** → lỗ chuyển tiếp. Mỗi dòng bấm được về chứng từ.

Có một **dòng kiểm tra** ở cuối: bảng cộng lại phải bằng đúng con số máy đã tính. Lệch thì in ra
lệch — một bảng bóc tách cộng không ra đúng con số nó đang giải thích là một bảng làm người đọc tin
nhầm.

## 4. MÀN HÌNH

Chín tab dưới `/payroll`, không nhồi vào một trang: **Bảng lương · Phiếu lương · Lịch sử kỳ ·
Chính sách lương · Phân công & gán chính sách · Đầu vào & điều chỉnh · Xem trước chuyển đổi ·
Cấu hình**. Bốn tab khai báo chỉ hiện với `payroll:manage`.

**Cấu hình lương** là tab đáng kể nhất: hai công tắc (sổ lỗ lũy kế · nguồn ghi nhận chi phí nhân
sự) trước đây **chỉ đặt được bằng `set-setting` chạy tay trên VPS**. Nghĩa là chúng hoặc không bao
giờ được bật, hoặc được bật bởi đúng một người biết cách — và không ai khác biết nó đã đổi.

Bảng khai cơ sở tính lương in đủ 11 dòng và **không có nút nào**: cho sửa nó trên màn hình là mở
đường để ai đó loại một khoản chi thật ra khỏi cơ sở trả tiền bằng một lượt bấm.

## 5. CHUYỂN ĐỔI VÀ ĐỐI CHIẾU

`/payroll/migration` **đọc · tính · so · rồi dừng lại**. Cố ý KHÔNG có nút "chuyển tất cả".

Cột "mới" chạy **thật** máy thành phần trên bản đề xuất, không nhân lại tỷ lệ cho nhanh — làm thế
là dựng một đường tính THỨ BA chỉ tồn tại trong bảng đối chiếu, và nó sẽ khớp đúng tới lúc một
trong hai đường kia đổi.

**So theo TỪNG khoản, không chỉ tổng.** Hai tổng bằng nhau không có nghĩa là đúng: một khoản thừa
và một khoản thiếu bằng nhau sẽ triệt tiêu ở dòng thực nhận. Có bài kiểm khoá đúng ca đó.

Lệch **chưa giải thích được** thì CHẶN. Lối ra duy nhất là khai một lý do, và lý do ấy vào nhật ký.

## 6. BA LỖI BỘ KIỂM BẮT ĐƯỢC TRONG VÒNG NÀY

1. **Lối đi vòng ở vòng đời.** Nút "Trả lại để sửa" hiện ở trạng thái ĐÃ DUYỆT nhưng bảng chuyển
   trạng thái không có đường ấy. Cách duy nhất để sửa một kỳ đã duyệt sai sẽ là khoá đại rồi mở
   khoá — tốn một lượt "mở khoá" vô nghĩa trong nhật ký. Nay `APPROVED → CALCULATED` là đường CÓ
   TÊN, và trả lại để sửa thì XOÁ chữ ký duyệt.
2. **"Không có khoản này" bị đọc thành "chưa biết số của khoản này"** trong bảng đối chiếu. Hai thứ
   khác hẳn nhau; gộp lại làm mọi dòng khớp-ở-mức-0 bị đánh dấu chưa giải thích được, và rồi không
   ai chuyển được ai.
3. **Cảnh báo hoa hồng bật cả khi không có gì sai** — bài kiểm nay khoá cả hai chiều: khoản nhóm
   Lương vừa đúng lương cứng ⇒ KHÔNG cảnh báo; thêm 3tr hoa hồng lẫn vào ⇒ PHẢI cảnh báo, đúng số.

## 7. KIỂM SỔ KHAI

Bốn phép kiểm, và cả bốn đều KHÔNG lộ ra ở con số cuối cùng — bảng vẫn ra một số, và số ấy sai:
**chồng lấn mốc gán** (tiền của ngày chồng lấn do thứ tự dòng quyết định) · **khoảng trống** ·
**thành phần khai tỷ lệ/đơn giá 0** (0 là giá trị hợp lệ, nhưng "chưa ai nhập" và "đã quyết là 0"
trông y hệt nhau) · **phiên bản chưa hiệu lực**.

## 8. MIGRATION

`0094_payroll_policy_engine` · `0095_payroll_run_lifecycle` · `0096_payroll_input_approval` — viết tay, idempotent, **chỉ cộng thêm**.

Đánh số lại **hai lần** trong một phiên: `main` lấy 0091 cho `0091_landing_attribution`, rồi lấy
0092 cho `0092_fb_adsets`. Số hiệu đã vào `main` là bất khả xâm phạm; thứ phải dời luôn là cái CHƯA
vào ở đâu cả.

## 9. ĐỐI CHIẾU

Vẫn giữ nguyên câu trả lời sắc nhất: **chưa gán chính sách cho ai thì sai lệch bằng ĐÚNG 0**, có
bài kiểm khoá. Ngoài ra nay có đối chiếu CÓ CẤU TRÚC cho từng người sắp chuyển.

**Việc chủ shop phải làm trước khi gán người đầu tiên:** khai tỷ lệ, đơn giá, ngưỡng. ERP KHÔNG đặt
hộ một con số nào — không có bộ mặc định và không được thêm.

## 10. CÒN THIẾU TRƯỚC KHI MERGE / DEPLOY

1. **Hoa hồng vẫn vào lợi nhuận qua bảng Chi phí**, vì vòng GỌI HÀM chưa cắt. Cần một đường đọc chi
   phí "không kể hoa hồng" để `payroll-cost` tính được hoa hồng mà không gọi ngược `getPayrollReport`.
   Cơ sở nghiệp vụ đã có tên nên đây là việc kỹ thuật, không còn là câu hỏi cho chủ shop.
2. **Chưa có nút "xem thử phép tính" trong trình khai chính sách.** Hôm nay phải lưu nháp rồi xem ở
   tab Xem trước chuyển đổi.
3. **Chấm công / KPI / sản lượng vẫn nhập tay.** Lời khai đúng của hôm nay (AGENTS.md mục 20 · 45),
   không phải thiếu sót cần lấp bằng một truy vấn gần đúng.
4. **Thuế / bảo hiểm chưa có.** Cố ý: ghi cứng một tỷ lệ pháp lý chưa được xác nhận còn tệ hơn
   không có.
5. **Chưa đối chiếu trên dữ liệu production thật** — phiên này không có đường `db-query` tới máy
   chủ. Đối chiếu cũ/mới đã chứng minh ở mức mã nguồn và trên CSDL kiểm thử; số production phải đo
   sau khi deploy, TRƯỚC khi gán người đầu tiên.

## 11. LÙI LẠI

Ba mức, không đổi so với bản trước, và mức nhẹ nhất vẫn giải quyết gần như mọi tình huống:

1. **Gỡ dòng gán chính sách** của người có số bất thường ⇒ quay về đường tính cũ với đúng con số cũ.
   Không mất dữ liệu, không cần deploy.
2. **Tắt chính sách** (`salary_policies.active = false`) nếu cả một nhóm sai.
3. **Lùi mã nguồn.** Chín bảng mới và các cột mới ở lại CSDL, không gây hại: mã cũ không đọc chúng,
   `component_code` và `status` đều có mặc định. **Không cần migration lùi.**
