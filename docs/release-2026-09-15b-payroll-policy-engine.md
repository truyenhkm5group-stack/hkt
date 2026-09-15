# Lương thôi là bảng riêng của MKTer — chính sách, phiên bản, thành phần · 15/09/2026

Phiên làm việc trên nhánh `claude/elegant-curie-zn92up`, nối tiếp `450cf46` và hoà với `main` tại
`0091_landing_attribution` (phiên landing chạy song song).

---

## 0. ĐỌC NHANH

**Điều quan trọng nhất của bản này là thứ nó KHÔNG làm: không một con số lương nào đổi vào ngày
phát hành.** Máy tính lương chung đã sẵn sàng nhưng chưa chạm vào tiền của ai. Chuyển một người
sang máy mới là một lần chủ shop bấm, có mốc hiệu lực và có dấu vết.

| Trước | Sau |
|---|---|
| Cơ chế trả tiền = ĐÚNG BỐN Ô trên hồ sơ nhân sự ở `settings` | Chính sách → phiên bản → thành phần, khai trên màn hình |
| Thêm chức danh mới = thêm `if` vào lõi tính lương | Thêm chức danh mới = khai một chính sách, không sửa một dòng mã |
| Đổi tỷ lệ hôm nay ⇒ bảng lương tháng trước đổi theo | Phiên bản có mốc hiệu lực; tháng 8 vẫn đọc bản của tháng 8 |
| Chỉ có một cơ chế bù lỗ (hoa hồng MKTer) | Bù lỗ là một TUỲ CHỌN của từng thành phần, mỗi khoản một chuỗi số dư riêng |
| Thiếu số liệu ⇒ con số im lặng | Thiếu số liệu ⇒ CHƯA BIẾT, kèm tên người phải nhập và đại lượng đang thiếu |
| `basis=profit1` — cái tên không nói lên điều gì | Tên nghiệp vụ tường minh; giá trị cũ vẫn nhận ở URL |

---

## 1. KIẾN TRÚC CŨ TÌM ĐƯỢC

`lib/queries/payroll.ts::getPayrollReport` tính lương bằng bốn trường trên `Employee`
(`settings: payroll.employees`):

```
lương = fixed (chia theo ngày)
      + percentTotal   × max(LN toàn shop, 0)
      + percentPersonal × max(LN cá nhân sau bù lỗ, 0)
      + percentRevenue  × max(DT cá nhân, 0)
```

Đã CÓ và chạy đúng, không dựng lại: `payroll_periods` (ảnh chụp + chốt kỳ bất biến),
`marketer_profit_carryover` (sổ lỗ lũy kế), `payrollFinalizeBlockers` (một bộ điều kiện chốt dùng
chung cho màn hình và server), `getOperatingCost` (một đường lấy chi phí), `audit()`, ba quyền
`payroll:view-own` / `payroll:view` / `payroll:manage`, và `departments` / `positions` /
`department_members` / `users`.

## 2. VẤN ĐỀ

1. **Bốn ô ấy sinh ra cho MKTer.** Nhân viên kho ăn theo ngày công, thợ may ăn theo sản phẩm,
   CSKH ăn lương cứng + KPI — không ai khai được. Cách duy nhất để đỡ họ là thêm `if` vào lõi, và
   mỗi lần sửa lõi là một lần có thể làm sai tiền của người khác.
2. **Không có mốc hiệu lực.** Đổi tỷ lệ là viết lại quá khứ.
3. **Không có chỗ cho chấm công / KPI / sản lượng.** ERP không có bảng nào giữ chúng.
4. **`profit1` không phải một tên nghiệp vụ.** Người đọc phải mở mã nguồn mới biết mình đang trả
   tiền theo cơ sở nào.
5. **Hình thức làm việc bị lẫn với công thức lương.** "Bán thời gian" không phải một cách tính.

## 3. KIẾN TRÚC MỚI

```
Nhân sự → Phân công lao động (có mốc) → Chính sách → Phiên bản (có mốc) → Thành phần
                                                                              ↓
                              Đại lượng (sổ đăng ký: ERP đo được | phải nhập tay)
                                                                              ↓
                          lib/payroll/engine.ts — MỘT đường tính duy nhất, hàm thuần
```

* `lib/constants/payroll-components.ts` — 12 loại thành phần, **5 kiểu phép tính là một TẬP ĐÓNG**,
  và **SỔ ĐĂNG KÝ ĐẦU VÀO** tách `MEASURED` (ERP đo được) khỏi `MANUAL` (phải nhập).
  **Cố ý không có ô gõ công thức**: `eval` một dòng chữ trong CSDL là cho phép chạy mã tuỳ ý trên
  máy chủ, và một công thức sai chính tả là một kỳ lương sai mà không kiểm thử nào bắt được.
* `lib/payroll/policy-resolve.ts` — cắt kỳ thành các ĐOẠN mà mọi thứ đứng yên. Đây là thứ làm
  "vào làm giữa tháng", "nghỉ giữa tháng" và "đổi chính sách giữa tháng" tính đúng phần của mình.
* `lib/payroll/engine.ts` — thứ tự cố định: đại lượng → bù lỗ → phép tính → chia theo đoạn →
  sàn/trần → làm tròn → áp dấu. Trần áp TRƯỚC làm tròn, vì một cái trần vượt được không phải trần.
* `lib/queries/payroll-engine.ts` — nối vào nguồn số thật, MỘT lượt đọc cho cả shop (không N+1).

**Không có `if (phòng ban === …)` ở bất cứ đâu trong máy tính.** Nếu có ngày ai đó định thêm, đó là
dấu hiệu chính sách khai chưa đủ, không phải dấu hiệu máy thiếu tính năng.

## 4. MIGRATION

`drizzle/0092_payroll_policy_engine.sql` — viết tay, idempotent, **CHỈ CỘNG THÊM**:

| Bảng | Vai trò |
|---|---|
| `salary_policies` | chính sách |
| `salary_policy_versions` | phiên bản có mốc hiệu lực · `DRAFT` không bao giờ tính tiền |
| `salary_policy_components` | thành phần; `CHECK` khoá "bù lỗ chỉ trên lợi nhuận" và "trần ≥ sàn" |
| `employment_assignments` | phân công có mốc; `CHECK` đóng danh sách hình thức / nơi làm / trạng thái |
| `employee_policy_assignments` | gán chính sách có mốc; khoá ngoại `RESTRICT` |
| `payroll_inputs` | chấm công · KPI · sản lượng; khoá tự nhiên (người, kỳ, đại lượng) |
| `payroll_adjustments` | thưởng nóng · tạm ứng · khấu trừ; `reason` BẮT BUỘC, `amount ≥ 0` |

Cộng một cột `marketer_profit_carryover.component_code` có MẶC ĐỊNH `MARKETING_PROFIT`, và khoá
duy nhất nới từ (người, tháng) thành (người, tháng, thành phần).

**Không backfill. Không đặt chính sách mặc định cho ai.** `tests/migration-upgrade-path.test.ts`
dựng một production CŨ HƠN thực tế rồi áp cả sáu migration lên, và khẳng định bảy bảng mới phải
RỖNG — một migration lương tự gán chính sách cho người thật là một migration đổi tiền mà không ai bấm.

Đánh số lại **0091 → 0092**: `main` đã lấy 0091 cho `0091_landing_attribution` trong lúc nhánh này
chạy. Số hiệu đã vào `main` là bất khả xâm phạm; thứ phải dời là cái CHƯA vào ở đâu cả.

## 5. DÙNG LẠI, KHÔNG DỰNG LẠI

`payroll_periods` + `buildPayrollSnapshot` (ảnh chụp nay mang thêm vết giải thích) ·
`marketer_profit_carryover` + `carryoverMonth` (phép bù lỗ giữ nguyên, chỉ nới khoá) ·
`payrollFinalizeBlockers` (thêm hai mã, không dựng bộ thứ hai) · `prorateMonthlyAmount` (CÙNG hàm
mà chi phí nhân sự dùng — tự viết một phép `× ngày / 30` ở đây là để bảng lương và báo cáo lợi
nhuận nói hai con số khác nhau) · `getOperatingCost` · `audit()` · ba quyền cũ · `guardSecondApproval`.

## 6. LUẬT NGHIỆP VỤ ĐỔI

Không luật nào của đường tính cũ đổi. Luật MỚI chỉ áp cho người ĐÃ ĐƯỢC GÁN chính sách:

* đã gán ⇒ tiền là `netPay` của máy chung, bốn ô cũ **không còn tham gia**. Cộng cả hai là trả hai
  lần cho cùng một tháng công; lấy số lớn hơn là để cách trả tiền phụ thuộc vào một phép so sánh
  không ai khai ở đâu cả;
* thiếu một đại lượng ⇒ khoản đó và TỔNG đều CHƯA BIẾT. "Tổng của một số đã biết và một số chưa
  biết" là một số chưa biết, không phải số đã biết ấy;
* chưa gán chính sách cho một đoạn ⇒ nói thẳng, **không tính 0 đồng**. Trả 0 là câu trả lời sai
  nguy hiểm nhất: nó trông y hệt "kỳ này không có gì để nhận".

## 7. BÙ LỖ LŨY KẾ

Là **tuỳ chọn của từng thành phần**, không áp tự động cho mọi chức danh. Chỉ bật được cho thành
phần tính theo LỢI NHUẬN — doanh thu, số đơn, giờ công và sản lượng không bao giờ âm, nên "lỗ mang
sang" ở đó là một khái niệm rỗng. Khoá ở `CHECK` của CSDL lẫn ở zod.

Ví dụ chủ shop đưa, có kiểm thử: tháng 8 lỗ 10tr ⇒ thưởng 0, sổ giữ −10tr · tháng 9 lãi 30tr ⇒ cơ
sở 20tr · tháng 9 chỉ lãi 7tr ⇒ thưởng 0, mang −3tr sang tháng 10.

## 8. KIỂM THỬ

| Bộ | Nội dung |
|---|---|
| `tests/payroll-engine.test.ts` | 30 tình huống bắt buộc bằng hàm thuần |
| `tests/payroll-policy-engine.test.ts` | 8 tình huống chạy qua CSDL thật |
| `tests/migration-upgrade-path.test.ts` | đường nâng cấp 0087→0092 trên một production dựng lại |

Chạy: `npm run typecheck` · `npm run lint` · `npm test` in **"TẤT CẢ KIỂM THỬ ĐẠT"** ·
`npm run build`. Cổng chạy lại trên **bản checkout SẠCH** theo đúng SHA ứng viên (AGENTS.md mục 9).

Bài "làm từ xa không phải một công thức lương" là bài quan trọng nhất về kiến trúc: cùng chính
sách, chỉ đổi `workMode`, số tiền PHẢI y hệt. Ngày nào ai đó thêm `if (workMode === 'REMOTE')` vào
máy tính, bài ấy đỏ.

## 9. ĐỐI CHIẾU CŨ / MỚI

Kho mã này có câu trả lời sắc hơn "sai lệch nằm trong ngưỡng chấp nhận":

> **Chưa gán chính sách cho ai thì đường tính cũ không bị chạm tới một dòng nào, nên sai lệch bằng
> ĐÚNG 0.**

`tests/payroll-policy-engine.test.ts` bài số 1 khoá điều đó ở mức mã nguồn. Sau khi gán người đầu
tiên, đối chiếu đi bằng khối "Chi tiết cách tính" trên màn hình và khối CHI TIẾT THÀNH PHẦN trong
tệp CSV — cả hai đọc từ CÙNG một `getPayrollReport`.

**Việc chủ shop phải làm trước khi gán người đầu tiên:** khai tỷ lệ, đơn giá và ngưỡng. ERP KHÔNG
đặt hộ một con số nào — không có bộ mặc định và không được thêm.

## 10. HAI LỖI TIỀN BỘ KIỂM BẮT ĐƯỢC TRƯỚC KHI RA PRODUCTION

1. **`-0` ở dòng khấu trừ.** Bằng `0` với `===` nhưng in ra màn hình là "-0 ₫" — một dòng khấu trừ
   âm không tồn tại, đứng cạnh tên một người thật.
2. **MỘT NGÀY CÔNG MA.** Mốc hiệu lực `23:59:59` thiếu phần mili giây làm `effectiveTo + 1ms` rơi
   vào GIỮA ngày. Mẩu 999 mili giây ấy thành một ĐOẠN RIÊNG không chính sách nào phủ — bảng lương
   báo "chưa gán chính sách" cho một người đã gán đủ — và `inclusiveDays` đếm nó là MỘT NGÀY, cộng
   thẳng vào phép chia lương cứng. Nay mọi mốc cắt làm tròn LÊN đầu ngày lịch Việt Nam.

## 11. QUYỀN & NHẬT KÝ

Không thêm quyền mới: ba màn hình khai báo đều sau `payroll:manage`, và tab chỉ hiện với quyền ấy.
Hai việc đổi cách trả tiền — **phát hành phiên bản** và **gán chính sách cho người** — đi qua
`guardSecondApproval` như mọi thay đổi cơ chế lương khác: người sửa có thể chính là người được hưởng.

Ghi nhật ký: `PAYROLL_POLICY_CREATE/UPDATE`, `PAYROLL_POLICY_VERSION_CREATE/UPDATE/ACTIVATE`,
`PAYROLL_POLICY_ASSIGN`, `PAYROLL_EMPLOYMENT_CREATE/UPDATE`, `PAYROLL_INPUT_SAVE`,
`PAYROLL_ADJUSTMENT_CREATE/UPDATE/DELETE` — đều kèm `before`/`after` và, với khoản tiền, kèm `reason`.

## 12. RỦI RO ĐÃ BIẾT

* **Số đo của kỳ chia cho nhiều đoạn là ƯỚC TÍNH.** Lợi nhuận, doanh thu và đại lượng nhập tay đều
  đo cho CẢ KỲ. Kỳ một đoạn (áp đảo) không có phép chia nào; kỳ nhiều đoạn chia theo SỐ NGÀY và
  màn hình **nói thẳng đó là ước tính**.
* **Chấm công / KPI / sản lượng vẫn phải nhập tay.** Đó là lời khai đúng của hôm nay, không phải
  một thiếu sót cần lấp bằng một truy vấn gần đúng (AGENTS.md mục 20 · 45).
* **Hoa hồng vẫn chưa vào lợi nhuận qua bảng Lương** (`COMMISSION_BASIS_NEEDS_REVIEW`): mọi cơ sở
  hoa hồng đều là % của LỢI NHUẬN, nên nó không thể vừa là đầu vào vừa là đầu ra. Bản này KHÔNG
  chạm vào vòng tròn ấy — thoát khỏi nó là một quyết định của chủ shop, không phải của ERP.
* **Thuế / bảo hiểm chưa có.** Cố ý: ghi cứng một tỷ lệ pháp lý chưa được xác nhận còn tệ hơn không có.

## 13. LÙI LẠI NẾU CẦN

Ba mức, từ nhẹ tới nặng, và mức 1 giải quyết gần như mọi tình huống:

1. **Gỡ dòng gán chính sách** (`employee_policy_assignments`) của người có số bất thường. Người đó
   lập tức quay về đường tính cũ với đúng con số cũ. Không mất dữ liệu, không cần deploy.
2. **Tắt chính sách** (`salary_policies.active = false`) nếu cả một nhóm sai.
3. **Lùi mã nguồn** về `450cf46`. Bảy bảng mới ở lại CSDL và không gây hại: mã cũ không đọc chúng,
   và cột `component_code` có mặc định nên sổ lỗ vẫn chạy. **Không cần migration lùi** — migration
   này chỉ CỘNG THÊM.
