# Payroll V2 — sổ lợi nhuận theo mã và thưởng nhiều MKTer

Chủ shop giao 19/10/2026 (*ERP PAYROLL V2 — CUMULATIVE PROFIT & MULTI-MARKETER ATTRIBUTION*). Tài liệu
này nối tiếp `docs/payroll-profit-gate.md` (cổng lỗ lũy kế toàn công ty, V1): V2 không thay cổng, V2
đứng DƯỚI cổng.

Mã: `lib/payroll/code-ledger.ts` (hàm thuần) · `lib/queries/payroll-code-ledger.ts` (đọc sổ, cắt đoạn) ·
`lib/queries/payroll.ts::getPayrollReport` (nối) · `lib/actions/payroll-code.ts` (đường ghi duy nhất) ·
`app/(dashboard)/payroll/codes` (màn hình). Bảng: `product_marketer_assignments`,
`product_bonus_terms` (migration `0249`, không gieo dòng nào). Kiểm thử: `tests/payroll-code-ledger.test.ts`.
Đối soát production: ops `payroll-profit-gate-audit` (đã mở rộng phần V2).

---

## 1. Công thức cũ và chỗ sai

| Thành phần | Trước V2 | Sai ở đâu |
|---|---|---|
| Ai phụ trách mã | `settings: payroll.config.productOwners` — `productId → employeeId` | MỘT người mỗi mã, **không có mốc hiệu lực**: đổi chủ mã hôm nay viết lại mọi tháng chưa khoá và cả `?period=all` |
| Người đẩy cùng | `productShares.crossPct` — % LN đơn của người chạy chéo | Chia theo ĐƠN quy kết, không có khái niệm "quỹ hỗ trợ" và trọng số đã duyệt |
| Thưởng theo mã | Không có — chỉ có `% LN cá nhân` = % × LN quy kết của người | Lỗ của một mã tháng trước không được bù: mã lỗ tháng 8, lãi tháng 9 vẫn sinh thưởng đủ cho tháng 9 |
| Cổng công ty | V1 đã chặn (`profit-gate.ts`) | V1 đúng ở mức công ty nhưng không trả lời được "mã nào sinh ra phần đủ điều kiện" |

## 2. Ba tầng, đúng thứ tự

```
1. SỔ MÃ (theo mã, không theo người)
   Cum(t)      = Cum(t−1) + Profit(t)                 Profit = products[].profit (tính MỘT lần)
   Eligible(t) = max(0, Cum(t) − max(0, HWM(t−1)))
   HWM(t)      = max(HWM(t−1), Cum(t))

2. CỔNG CÔNG TY
   Allocated(mã) = allocatePool(Eligible các mã, E công ty)     Σ Allocated ≤ min(Σ Eligible, E)

3. CHIA THƯỞNG CỦA MÃ (mỗi ĐOẠN hiệu lực)
   OwnerBonus      = Allocated × w_đoạn × X%
   SupportPool     = Allocated × w_đoạn × Y%
   SupportBonus(i) = SupportPool × Weight(i)       Σ Weight = 100%
   → mọi khoản đi vào CÙNG cổng V1: Σ được duyệt ≤ ⌊E × cap%⌋
```

- `Profit` của mã = doanh thu dòng hàng giao thành công − giá vốn − quảng cáo của mã − cước/phí hoàn −
  chi phí vận hành phân bổ (đúng con số trang Hiệu quả marketer in). Đơn nhiều mã chia theo DÒNG hàng.
- Mã bắt đầu ở 0 tại **tháng mở sổ của quy chế cổng** (`openingMonth`). Chưa khai quy chế ⇒ sổ mã
  chưa có mốc ⇒ mọi phân công đứng ở "chờ đối soát". Số dư mở sổ RIÊNG từng mã chưa có đường khai
  (xem §7).
- HWM của mã tiến lên cả khi công ty chưa đủ điều kiện: phần lãi ấy đã đi bù lỗ công ty, nên nó
  **không** trở thành khoản thưởng treo phải trả sau ("không mặc định chuyển thưởng chưa đủ điều kiện
  thành khoản nợ thưởng").
- Tháng đã khoá: ảnh chụp lưu `profitGate.codes` (lợi nhuận từng mã của tháng). Sổ mã tháng sau dựng lại
  từ chuỗi số đã chụp bằng hàm thuần — không đo lại tháng khoá; chứng từ muộn đi qua điều chỉnh lũy
  kế của V1 (ở mức công ty).

## 3. Đổi người / đổi tỷ lệ giữa tháng

Tháng của một mã được cắt thành các ĐOẠN mà trong đó phân công + điều khoản không đổi
(`segmentBounds`, theo ngày lịch Việt Nam). Phần của đoạn `w_đoạn` = doanh thu giao thành công của mã
PHÁT SINH trong đoạn ÷ cả tháng — nghiệp vụ thật của đoạn, không phải số ngày. Trọng số SUPPORT đo
TRONG đoạn. Sổ mã không đổi: nó không có tham số người.

## 4. Thiếu căn cứ ⇒ `PENDING_RECONCILIATION`, không chia đều

| Tình huống | Kết quả |
|---|---|
| SUPPORT mà chưa có điều khoản Y% hiệu lực | chờ (OWNER vẫn tính) |
| Trọng số tay Σ ≠ 100% | chờ — không tự chuẩn hoá |
| `AD_SPEND` / `ATTRIBUTED_REVENUE` mà không SUPPORT nào có số | chờ — không chia đều |
| MỘT SUPPORT không có số đo trong đoạn (chiến dịch chưa ghép?) | chờ — không dồn cả quỹ cho người đã ghép |
| Mã còn chi phí QC / doanh thu CHƯA GÁN cho MKTer nào trong đoạn | chờ — trọng số thiếu một phần chưa biết của ai |
| Đổi phân công giữa tháng mà không đoạn nào có doanh thu giao thành công | chờ — không chia 1/n |
| Kỳ không phải trọn tháng lịch / cơ sở khác "Lợi nhuận tính lương" | chờ — thưởng theo mã CHƯA BIẾT, không phải 0 |
| Các SUPPORT dùng hai cách tính trọng số trong cùng đoạn | chờ |
| Hai OWNER / hai điều khoản cùng hiệu lực | chờ — ERP không chọn hộ |
| X% + Y% > 100% | chờ |
| Người đang hưởng % LN CÁ NHÂN mà được giao thêm mã | chờ — cộng cả hai là trả hai lần |
| MKTer không có dòng lương trong kỳ | chờ |
| Sổ mã chưa dựng được (chưa khai quy chế / ảnh chụp trước V2) | chờ |

Còn bất kỳ dòng chờ nào ⇒ blocker `PROFIT_CODE_PENDING` chặn duyệt kỳ, và thực nhận được duyệt của
người liên quan là CHƯA KẾT LUẬN (`null`, in "—"). Lỗi của CẢ ĐOẠN (hai OWNER, hai điều khoản, X + Y >
100%) gắn vào MỌI người có phân công trong đoạn — một khoản chờ không mang tên ai không chặn được
thực nhận của ai.

**Lối ra có người duyệt: xác nhận trọng số (mã × tháng).** Hai loại khoản chờ ở trên — một SUPPORT có
số đo 0, và mã còn chi phí / doanh thu CHƯA GÁN — ERP không phân biệt được "0 thật" với "chưa ghép".
Chặn cả kỳ lương mà không có lối ra hợp lệ sẽ đẩy người ta đi sửa lùi lịch sử phân công cho qua. Nên
khoản chờ ấy mang `kind: "WEIGHT_PARTIAL"` và gỡ được bằng `confirmCodeWeights` (duyệt người thứ hai,
kèm lý do, đúng một mã × một tháng, không cho tháng đã khoá; `settings: payroll.code-weight-confirmations`).
Khi đã xác nhận: số 0 là 0 thật, phần chưa gán đứng ngoài phép chia — nhưng CHỈ cho đúng số đo đã được
xem: lời xác nhận mang dấu vân tay từng đoạn (`weightFingerprint`: ai là SUPPORT, trọng số đo được, phần
chưa gán). Thêm SUPPORT, ghép muộn một chiến dịch, có thêm 1 ₫ chưa gán ⇒ khoản quay lại chờ, câu "số đo
đã đổi — phải xác nhận lại". Không xác nhận trước được (phải có khoản chờ đang tồn tại, đo lại bằng
`getPayrollReport` lúc bấm). Huỷ được (`revokeCodeWeights`, có lý do, đánh dấu chứ không xoá). Bản ghi
giữ RIÊNG người gửi và người duyệt. Người thứ hai chỉ bắt buộc khi nhóm `PAYROLL_EDIT` bật cưỡng chế
duyệt — hôm nay một quản trị viên lương xác nhận được một mình, giống mọi đường ghi lương khác. Lời xác nhận KHÔNG gỡ được các
khoản chờ khác (không SUPPORT nào có số đo, trọng số tay lệch, thiếu Y%, hai OWNER…) — những thứ ấy
sửa bằng phân công / điều khoản. Không có ngưỡng "đáng kể" ghi cứng (AGENTS.md mục 38).

**Ô trống ≠ 0.** `z.coerce.number()` biến `""` thành `0` và thành công; ô "trần (bỏ trống = không)"
từng lưu thành trần 0 ₫ và lặng lẽ đưa mọi khoản về 0 (review 19/10). Mọi ô số đi qua
`lib/validation/payroll-code.ts`: trống ⇒ ô bắt buộc báo lỗi, ô tuỳ chọn là "không khai".

**Phiếu lương / CSV.** Thưởng theo mã không nằm trong thành phần nào của chính sách nên in thành MỘT
dòng riêng ("Thưởng theo mã — tạm tính", `components/payroll/profit-gate-rows.tsx`) và một cột CSV
riêng; dòng chênh "chưa đủ điều kiện" bên dưới đưa tổng về đúng thực nhận được duyệt.
`PayrollLine.codeBonusProvisional` giữ phần ấy; bảng chuyển đổi trừ nó ra để so đúng công thức cũ.

## 5. Chính sách có phiên bản

| Yêu cầu | Đã có | Ở đâu |
|---|---|---|
| Lương cứng / hoa hồng hợp đồng / KPI / thưởng % LN tách riêng | Có | máy tính lương chung — `PayrollComponentKind`, `isProfitLinked` / `isRegularVariable` (V1) |
| `policy_id`, `version`, `effective_from/to`, trạng thái duyệt | Có | `salary_policies` + `salary_policy_versions` (DRAFT → ACTIVE → RETIRED, duyệt người thứ hai) |
| Phạm vi NHÂN VIÊN | Có | `employee_policy_assignments` |
| Phạm vi MÃ (thưởng theo mã) | Có (V2) | `product_marketer_assignments` + `product_bonus_terms` (mã > mặc định công ty) |
| Phạm vi PHÒNG BAN / NHÓM MÃ | **Chưa** | xem §7 |
| Đổi giữa tháng theo thời điểm nghiệp vụ | Có | cắt đoạn (§3); chính sách lương chung chia theo ngày hiệu lực |
| Kỳ khoá chụp phiên bản chính sách | Có | ảnh chụp kỳ: `policyVersion` cổng, `codes`, và mọi khoản đã tính |
| Không ghi đè lịch sử | Có | đổi = kết thúc + thêm mới; huỷ chỉ cho dòng nhập nhầm chưa chạm tháng khoá |

## 5b. Đường ghi

- Khoá dòng = băm NỘI DUNG (`codeRowId`): duyệt người thứ hai so dấu vân tay gồm khoá dòng, nên lần
  gửi lại sau khi được duyệt tiêu thụ ĐÚNG lời duyệt ấy. Người duyệt ghi vào dòng là người QUYẾT yêu
  cầu (`approval_requests.decided_by`).
- Bàn giao OWNER (`planOwnerHandover`): OWNER mới KHÔNG hạn đóng OWNER cũ ở ngày liền trước; OWNER mới
  CÓ hạn chồng lên OWNER khác ⇒ từ chối (đóng người cũ là cắt luôn quyền sau ngày kết thúc của người
  mới). Huỷ một dòng KHÔNG tự mở lại dòng đã bị bàn giao. Cùng luật cho điều khoản.
- Kết thúc một dòng ở ngày D chỉ đổi hiệu lực TỪ D + 1 (`endChangesFromKey`): bàn giao ngày 01 của tháng
  sau một tháng đã khoá làm được (review vòng 2 bắt lỗi kiểm thừa ngày 30).
- Dòng GIỐNG HỆT một dòng đã huỷ trùng khoá nội dung ⇒ báo rõ "đổi ghi chú để ghi lại thành dòng mới".
- Kiểm tháng khoá đọc TRONG giao dịch, sau khoá tên của mã. Còn một khe: đường chốt kỳ không lấy khoá
  ấy, nên một tháng có thể bị khoá giữa lúc kiểm và lúc ghi — dòng khi đó chỉ ảnh hưởng tháng SAU (tháng
  đã khoá đọc ảnh chụp), không đổi số đã khoá.

## 5c. Hiệu năng

Mốc của mọi mã trong tháng gom thành MỘT bộ mảnh chung (`buildCodeSegmentsFor`); mỗi mảnh là một lượt
`getMarketerReport` (song song, memo 120 s). Không ai đổi giữa tháng ⇒ 0 lượt đo thêm. N mốc khác nhau
trong tháng ⇒ N lượt, dùng chung cho mọi mã — không phải một lượt mỗi đoạn mỗi mã. Mô phỏng tháng
chưa khoá (tối đa 12) lặp lại phần ấy cho từng tháng; production hôm nay chưa có phân công nào nên chi
phí thêm là 2 câu đọc sổ mỗi tháng.

## 5d. Tổ chức đang phục vụ ở lược đồ cũ

0249 khai trong `MIGRATION_SERVE_COMPAT`: hai đường đọc bắt lỗi bảng chưa có (42P01) và trả sổ rỗng —
chưa áp 0249 thì chưa ai được phân công, bảng lương chạy y như trước V2. Đường ghi báo lỗi CSDL cho tới
khi 0249 áp. Bài kiểm đổi tên tạm hai bảng rồi mở bảng lương để chứng minh.

## 6. Đối soát với lợi nhuận công ty

```
Σ products[].profit − QC test (chưa thuộc mã) − chi phí chung không chia xuống mã
                    − điều chỉnh vận chuyển không chia xuống mã  =  totals.profit
```

Đẳng thức này đúng theo cấu trúc của `getMarketerReportUncached` (mỗi mã cộng vào `totals.profit`
đúng một lần, ba khoản kia trừ ở cấp shop). Trang `/payroll/codes` in từng vế và in CHÊNH LỆCH — khác
0 là phải kiểm trước khi duyệt; `tests/payroll-code-ledger.test.ts` khẳng định đẳng thức trên dữ liệu
kiểm thử, ops `payroll-profit-gate-audit` đo nó trên production từng tháng.

Lợi nhuận đem xét ở cổng công ty là `totalProfit − hoa hồng thông thường` (V1) — lớn hơn hoặc nhỏ hơn
Σ LN mã đúng bằng các khoản trên cộng hoa hồng thông thường; trang in cả hai.

## 7. Chưa làm — cần chủ shop quyết

1. **X%, Y%, trần theo mã**: ERP KHÔNG đặt giá trị mặc định. Chưa khai thì không có khoản thưởng theo mã
   nào. Khai ở Lương → Lợi nhuận theo mã → Quản lý phân công.
2. **Người đang hưởng % LN cá nhân** (production 19/10: 3 người — 30% · 25% · 30%): giao thêm mã cho họ
   sẽ CHẶN kỳ cho tới khi chọn một trong hai. Chuyển một người sang thưởng theo mã là một quyết định
   hợp đồng — ERP không tự tắt % LN cá nhân.
3. **Số dư mở sổ từng mã**: hiện mọi mã bắt đầu ở 0 tại tháng mở sổ của quy chế. Nếu chủ shop muốn mã
   mang lỗ cũ trước mốc ấy, cần một bảng khai số dư mở sổ theo mã có người duyệt (chưa có).
4. **Phạm vi phòng ban / nhóm mã** cho chính sách: chưa có bảng. Ưu tiên đang chạy: nhân viên (chính
   sách lương chung) · mã > mặc định công ty (điều khoản thưởng theo mã).
5. **Đồng bộ với Marketing**: `payroll.config.productOwners` (trang Hiệu quả marketer) và
   `product_marketer_assignments` là HAI sổ. V2 không ghi đè sổ cũ và không đọc nó để chia thưởng —
   sổ cũ vẫn quyết cách QUY KẾT đơn / LN cá nhân. Hợp nhất hai sổ là một việc riêng.

6. **Tháng khoá TRƯỚC khi V2 lên production** sẽ không có `profitGate.codes` trong ảnh chụp ⇒ sổ mã
   của mọi tháng sau chưa dựng được ⇒ mọi phân công đứng ở "chờ". Production 19/10 chưa khoá tháng
   nào, nên chỉ cần V2 deploy trước lần khoá đầu tiên. Nếu đã lỡ: khai lại mốc mở sổ quy chế sau tháng ấy.
7. **Thuế / bảo hiểm trên thưởng theo mã**: khoản theo mã cộng SAU `netPay` của máy tính lương chung,
   nên công thức khấu trừ (nếu chính sách có) không nhìn thấy nó — giống phần chênh của cổng V1. Nếu
   chính sách cần khấu trừ trên khoản thưởng này, phải thêm thành phần tương ứng vào chính sách.

## 8. Kiểm thử

`tests/payroll-code-ledger.test.ts` — 13 ca chủ shop liệt kê (phần thuần + luồng thật trên CSDL qua
`getPayrollReport`, khoá tháng 1 bằng đường chốt kỳ, đổi OWNER + đổi X% giữa tháng 2), cộng hàng rào
mã nguồn. Kiểm đột biến 19/10/2026: bỏ HWM · chia đều khi thiếu QC · đề nghị trên phần đủ điều kiện
của mã thay vì phần phân bổ · bỏ chặn lương khi chờ · bỏ phát hiện % LN cá nhân · không cộng khoản
theo mã vào tạm tính — cả 6 đều làm bài kiểm đỏ. Sau review độc lập: thêm 5 đột biến (bỏ kiểm thiếu
một phần trọng số · ô trống không qua `blank` · cho OWNER có hạn cắt OWNER cũ · khoản chờ cả đoạn không
tên · kỳ không phải tháng im lặng) — cả 5 đỏ.

## 9. Payroll V2 vận hành — đối soát lợi nhuận tháng + duyệt hai cấp (chủ shop 19/10/2026, sau #911)

Mã: `lib/payroll/profit-reconciliation.ts` (thuần) · `lib/queries/payroll-reconciliation.ts` (đọc) ·
`lib/actions/payroll-reconciliation.ts` (ký / huỷ cấp 1) · `app/(dashboard)/payroll/reconciliation` (tab
**Đối soát**). Kiểm thử `tests/payroll-reconciliation.test.ts` + luồng thật trong `tests/payroll-code-ledger.test.ts`.

### 9.1 Hai vế, không tính lại lợi nhuận

| Dòng | Cơ sở lương (`getMarketerReport`) | Nguồn đối chiếu |
|---|---|---|
| Doanh thu giao thành công | Σ `products[].revenue` | đo lại trên đơn bằng CHÍNH `ORDER_OUTCOME_FAST` + `REVENUE_RECOGNIZED_ON_DELIVERY`; phần có chứng từ tiền (COD thực thu / chuyển khoản) |
| Đơn chưa kết thúc | — | giá trị đơn nhóm OPEN của tháng (đang đi · chưa rời kho · chưa biết) |
| Giá vốn | Σ `products[].cogs` (`LINE_UNIT_COST`) | máy chi phí `COGS`; "đã giải thích" CHỈ khi chênh = ảnh hưởng giá báo MKT ĐO ĐƯỢC (dư ≤ 1 ₫/đơn); dòng hàng mà `LINE_UNIT_COST` rơi về **0** được đếm riêng |
| Doanh thu dòng không mã | — | dòng hàng không ghép được mẫu mã — cơ sở bỏ qua |
| Quảng cáo | QC của mã + QC test | máy chi phí `ADS`; bốn ô (mã × có/không MKTer) đo THẲNG trên `ad_spends`; dòng riêng cho QC của mã KHÔNG đi vào quy kết của MKTer nào |
| Cước chiều đi | cước vận đơn của MỌI kiện đã gửi | máy chi phí `SHIPPING` (chỉ đơn đã kết thúc, không gồm điều chỉnh); "đã giải thích" CHỈ khi chênh = cước kiện đang đi ĐO ĐƯỢC (dư ≤ 1 ₫/kiện) |
| Phí chiều hoàn | **không có** | máy chi phí `RETURN_COST` (vận đơn chiều về, không gồm điều chỉnh) |
| Vận hành | `operatingEntered` | máy chi phí `operatingTotal` − khoản loại khỏi cơ sở (thù lao biến đổi) |
| Giả định | chi phí cố định khai ở Cấu hình, định mức theo đơn | — (ƯỚC TÍNH) |
| Cảnh báo `high` | — | vd lương cứng chưa ghi nhận |

Trạng thái mỗi dòng: **Khớp nguồn** · **Chênh đã giải thích** (chỉ khi đo được phần giải thích) · **Ước tính**
(có nhãn, không đếm là khớp) · **Chưa đối soát**. Nhóm chi phí: **theo mã** (giá vốn, QC của mã, cước, định
mức theo đơn) · **chung** (vận hành, chi phí cố định giả định — kể cả phần chia xuống mã theo doanh thu, QC
test có người chịu) · **chưa xác định nguồn** (QC không mã không người) · **có thật nhưng chưa vào cơ sở
lương** (phí chiều hoàn, lương cứng chưa ghi nhận — KHÔNG gồm khoản bị loại vì trùng nguồn). Dòng "Vận hành"
là kiểm nhất quán CÙNG nguồn, không phải đối chiếu độc lập với sao kê.

Độ phủ (mẫu số 0 ⇒ `null`, in "—", không phải 0%): doanh thu có chứng từ tiền ÷ doanh thu đã giao (theo
giá trị); giá trị đơn đã có kết quả ÷ (đã kết thúc + chưa kết thúc); chi phí ở dòng khớp / đã giải thích ÷
toàn bộ chi phí (gồm phần chưa vào cơ sở). Mã "đủ dữ liệu lợi nhuận" = có mã hàng, không dòng nào thiếu
giá vốn, QC của mã đều có người.

### 9.2 Ba lỗ hổng của cơ sở lương mà đối soát này làm lộ ra (CHƯA sửa công thức — chủ shop quyết)

1. **Giá vốn không biết = 0 ₫** (`LINE_UNIT_COST` rơi về 0): lợi nhuận cao hơn thật. Sửa ở dữ liệu
   (phiếu nhập / giá nhập mẫu mã), đối soát chặn tới khi hết.
2. ~~**Phí chiều hoàn không vào cơ sở lương**~~ — **ĐÃ SỬA 20/10/2026, chủ shop quyết** ("các khoản thực
   tế công ty phải chịu phải được tính vào P&L; ưu tiên gắn theo vận đơn và SKU; khoản không xác định được
   mã thì hạch toán chi phí chung; không ghi trùng"). Xem §10.2.
3. **Kiện đang đi** đã chịu cước + chi phí theo đơn mà chưa có doanh thu: số của tháng còn đổi cho tới khi
   mọi đơn có kết quả.

### 9.3 Duyệt hai cấp (`lib/constants/payroll-reconciliation.ts` · `lib/payroll/recon-signoff.ts`)

**Ký trên ẢNH CHỤP kỳ, không trên số sống** (review vòng 1): số sống đổi theo từng webhook / khoản COD về,
nên "ký số sống rồi tính rồi duyệt" có thể không bao giờ khớp — và kỳ kẹt kéo theo cả lương cứng.

1. **Tính kỳ** (`CALCULATE`) — KHÔNG bị chặn bởi đối soát. Ảnh chụp mang bảng đối soát của tháng
   (`snapshot.profitRecon`: từng dòng, nhóm chi phí, độ phủ, khoản chưa đối soát, dấu vân tay).
2. **Cấp 1 — ký** (`signProfitReconciliation`) khi kỳ `CALCULATED` / `UNDER_REVIEW`: ký ĐÚNG dấu vân tay
   của ảnh chụp đang hiện (trang gửi mã ảnh; ảnh đã tính lại ⇒ từ chối). Bảng còn khoản chưa đối soát ⇒ phải
   đánh dấu đã xem từng khoản và ghi lý do chấp nhận. Huỷ được, có lý do (đánh dấu, không xoá).
3. **Cấp 2 — duyệt** (`APPROVE`): kỳ có thưởng % lợi nhuận **đủ điều kiện > 0** thì phải có chữ ký CÒN
   HIỆU LỰC trên đúng ảnh chụp này, và người duyệt **khác** người ký. **Khoá** (`LOCK`) kiểm lại chữ ký vẫn
   còn hiệu lực — huỷ chữ ký sau khi duyệt thì không khoá được, không sinh lệnh chuyển. Đọc chữ ký trong
   giao dịch, dưới khoá tên của sổ chữ ký.
4. Tính lại kỳ ⇒ ảnh mới; số không đổi ⇒ cùng dấu vân tay (bảng tất định) ⇒ chữ ký cũ vẫn áp; số đổi ⇒
   phải ký lại.

Kỳ KHÔNG có khoản thưởng đủ điều kiện (công ty còn lỗ lũy kế) duyệt / khoá như cũ — không giữ lương của ai
vì bảng đối soát. Người thứ hai duyệt chính chữ ký cấp 1 khi nhóm `PAYROLL_EDIT` bật cưỡng chế; hôm nay chưa
bật nên MỘT quản trị viên ký được, nhưng người DUYỆT kỳ vẫn phải là người khác.

Lưu ý thực tế: tháng còn đơn chưa kết thúc hay còn phí chiều hoàn thì bảng gần như luôn "chưa đối soát" — cổng
khi ấy là "một người đã xem từng khoản và ghi lý do", rồi một người khác duyệt.

### 9.4 Năm nấc của một khoản thưởng % lợi nhuận

Tạm tính (chưa xét được) → Chưa đủ điều kiện / Đủ điều kiện chờ duyệt → Đã duyệt (kỳ `APPROVED` /
`LOCKED`) → Đã thanh toán (kỳ `PAID`). Kỳ đã khoá đọc từ ảnh chụp.

### 9.5 Phân công từ dữ liệu quảng cáo

Trang phân công liệt kê (mã × MKTer × tháng) chi phí QC và số chiến dịch thật, từ tháng mở sổ của quy chế
(chưa khai thì 12 tháng gần nhất), kèm liên kết mở đúng danh sách chiến dịch. Nút «Điền» chỉ điền sẵn biểu
mẫu — máy không tự giao: người chi nhiều nhất chưa chắc là người phụ trách mã. Phân công lịch sử khai được
cho mọi tháng chưa khoá.

### 9.6 X% / Y% theo chính sách · nhân viên · mã · thời gian

X% khai trên TỪNG phân công (nhân viên × mã × khoảng hiệu lực); Y% và trần trên điều khoản (theo mã, hoặc
mặc định công ty), có hiệu lực theo thời gian; mỗi dòng mang số hiệu quy chế (`policyRef`). Không có tỷ lệ
mặc định nào ghi cứng.

## 10. Payroll V2 — Trung tâm đối soát (chủ shop 20/10/2026, sau #916)

Màn hình `/payroll/reconciliation/center` (`lib/queries/payroll-recon-center.ts` · hàm thuần
`lib/payroll/recon-center.ts`). CHỈ ĐỌC — không nút nào ghi một con số.

### 10.1 Ba khối

- **Đã tự đối soát**: dòng của bảng tháng (§9) đã KHỚP nguồn / chênh đo được — dữ liệu nguồn đã có thì máy
  kết luận, không ai phải nhập lại.
- **Chưa đối soát**: mỗi khoản có PHÒNG chịu trách nhiệm (`issueOwner` — phòng ban, không bao giờ một
  người, AGENTS mục 22), nguyên nhân và lối sửa.
- **MỘT danh sách phê duyệt** (`buildApprovalList`): `DECIDE` = người có quyền phải chọn (số dư mở sổ,
  phân công chờ duyệt, mã chưa có OWNER, tháng chờ ký cấp 1); `SUPPLY` = phòng phải bổ sung chứng từ ERP
  chưa có (ngày vào làm, giá vốn, bảng kê COD, khoản chi trùng nguồn). Dữ liệu đủ ⇒ danh sách RỖNG.

### 10.2 Phí chiều hoàn trong cơ sở lương

`returnCostByProduct()` sống trong `cost-engine.ts`, cạnh thành phần `RETURN_COST` mà nó chia — cùng hai
vế, cùng mốc ngày: (a) vận đơn chiều về (`order_id` rỗng) nối về đơn gốc qua `order_reference` = mã vận
đơn gốc, theo ngày chiều hoàn, chia theo giá trị dòng hàng của đơn gốc; (b) `orders.return_fee` của đơn
HOÀN, chia theo dòng hàng. TỔNG lấy từ máy chi phí (`returnLegCost` = `RETURN_COST` − điều chỉnh tay đã
nằm trong `logisticsAdjustment`). Phần gắn được mã ⇒ cột vận chuyển của mã; phần dư ⇒ quỹ chi phí chung
(chia theo doanh thu cùng chi phí vận hành). `toCodes + shared = amount` — không ghi trùng, không bỏ sót.
Bảng đối soát so cơ sở ↔ máy chi phí ở dòng `return-cost`; `NOT_IN_BASIS` chỉ còn phần thiếu.

### 10.3 Lương cứng: căn cứ tách riêng, lá chắn chốt lương GIỮ NGUYÊN

Người chưa khai ngày vào làm thì `employmentWindow` coi như có mặt mọi kỳ — đó là lý do lịch sử từ 08/2025
"lỗ" 8 triệu lương mỗi tháng. `getRecognizedPayrollCost` nay tách `fixedSalaryDueEvidenced` (người có ngày
vào làm) / `fixedSalaryDueUndated` (người chưa khai) — THUẦN theo dữ liệu, không đọc đồng hồ.

Phép tách KHÔNG đổi phép ghi nhận: máy chi phí, cảnh báo `PAYROLL_OBLIGATION_NOT_RECOGNIZED` và quyền cầm
nguồn của bảng Lương vẫn dùng `fixedSalaryDue`. Bản nháp đầu coi phần chưa khai ngày ở "kỳ đã qua" là chưa
biết ngay trong máy chi phí; rà soát độc lập chỉ ra kỳ ĐANG CHỐT LƯƠNG luôn là kỳ đã qua (lương tháng M chốt
trong tháng M+1) ⇒ cảnh báo tắt đúng lúc cần, kỳ chốt được trên lợi nhuận 0 ₫ lương, và cùng một tháng ra
hai số khác nhau ở hai bên mốc đầu tháng. Nên phần chưa khai ngày chỉ là CHƯA BIẾT ở chỗ DỰNG LẠI LỊCH SỬ —
đề xuất số dư mở sổ (§10.6) — và thành một mục "bổ sung" của phòng Nhân sự trong danh sách phê duyệt.

### 10.4 Phân công / điều khoản: CHỜ DUYỆT (migration `0250`)

Lưu ⇒ `PENDING` (bảng lương không đọc, không tỷ lệ mặc định nào áp thay). `approveCodeRow` là đường DUY
NHẤT sang `APPROVED`: duyệt người thứ hai nhóm `PAYROLL_EDIT`; người khai không tự duyệt (trừ `ADMIN` —
chủ shop); bàn giao OWNER / đóng điều khoản cũ làm LÚC DUYỆT, dưới khoá tên của mã, tháng khoá đọc lại.
"Huỷ" một dòng chờ = từ chối. CSDL chặn `APPROVED` không có mốc duyệt; mặc định cột là `PENDING`.

### 10.5 Giá vốn và COD

- `cogsGapsByVariant`: dòng đã giao có giá vốn 0, gom theo mẫu mã, NGUYÊN NHÂN đo được (không nối mẫu mã ·
  phiếu nhập không ghi giá · chưa có phiếu nhập và Pancake không có giá) + mã đơn để tra. KHÔNG tự điền.
- `codSplit`: doanh thu KẾ TOÁN (đã giao, đã ghi nhận) · PHẢI THU chưa xác minh (đã giao, chưa chứng từ
  tiền — theo nguyên nhân `codGapCause` và tuổi) · TIỀN THỰC NHẬN (trả trước + COD đã về ngân hàng) · COD
  ĐVVC đã thu nhưng chưa ghi trả về (tiền ở ĐVVC, chưa phải tiền của shop). Chứng từ tiền dùng chung
  `MONEY_EVIDENCE_SQL` với bảng đối soát tháng.

### 10.6 Đề xuất số dư mở sổ

`buildOpeningProposal`: Σ (doanh thu đã ghi nhận − chi phí máy chi phí đã ghi nhận − lương CÓ căn cứ chưa
ghi nhận) của các tháng từ đầu kỳ dữ liệu tới trước mốc mở sổ. Lương của người chưa khai ngày: bảng Lương
cầm nguồn ⇒ trừ ngược khỏi chi phí ghi nhận; bảng Chi phí chưa có khoản lương ⇒ chỉ lấy phần có ngày của cảnh
báo nghĩa vụ; bảng Chi phí có khoản lương thật ⇒ đó là chứng từ. KHÔNG cộng giả định (chi phí cố định khai
tay, định mức theo đơn, lương người chưa khai ngày). Tháng thiếu căn cứ (trước khoản chi đầu tiên được nhập
⇒ chi phí vận hành CHƯA BIẾT; giá vốn 0; đơn chưa kết quả; doanh thu chưa chứng từ tiền; lương chưa biết)
nói rõ thiếu gì, và còn một tháng thiếu thì đề xuất là "CHƯA ĐỦ CĂN CỨ". ERP không bao giờ tự khai số này vào
quy chế cổng.

### 10.7 Cước theo ghi nhận Viettel Post + lịch cước ước tính (chủ shop 21/10/2026)

"Chi phí vận chuyển thực tế khi tính lương cần tính đúng theo ghi nhận của VTP (lấy từ dữ liệu VTP về hoặc từ
file tôi up lên), đối soát COD cùng với chi phí vận chuyển. Còn chi phí vận chuyển ước tính ở cấu hình BCLN có
thể thay đổi theo khoảng thời gian khác nhau."

- `lib/queries/shipping-cost.ts::shipmentCostSql()` là MỘT biểu thức cước chiều đi, dùng chung bởi cơ sở lương,
  bảng đối soát và máy chi phí: `shipments.shipping_fee > 0` (webhook · bảng kê COD · tệp danh sách vận đơn) ⇒
  đúng số ấy; thiếu ⇒ cước ƯỚC TÍNH theo lịch cước tại ngày lên đơn, chỉ khi đơn có vận đơn hoặc Pancake ghi cước
  đối tác (dấu hiệu "có gửi ĐVVC"); không vận đơn ⇒ 0. KHÔNG còn lùi về `orders.partner_fee` của Pancake làm số
  tiền. Cước bình quân 90 ngày (ô để trống) cũng chỉ đọc cước Viettel Post.
- Lịch cước: `profit.assumptions.shipFeeSchedule` — mỗi mốc (từ ngày · cước gửi · cước 1 đơn hoàn · lý do) có
  hiệu lực tới trước mốc kế tiếp; trước mốc đầu dùng hai ô chung. Báo cáo một kỳ lấy bình quân theo số NGÀY chồng
  lấn (`shipFeesForPeriod`). Biểu mẫu "Sửa giả định" của Báo cáo lợi nhuận có bảng soạn; lược đồ lưu PHẢI nhận
  trường này (zod bỏ trường lạ ⇒ thiếu là xoá sạch lịch mỗi lần Lưu).
- Bảng đối soát tháng: dòng `shipping` là ƯỚC TÍNH khi có kiện tính theo lịch cước; dòng mới `shipping-billing`
  tách cước đã nằm trong bảng kê COD (đã đối soát cùng tiền thu hộ) · VTP ghi nhận chưa có bảng kê (CHƯA đối
  soát) · ước tính. Máy chi phí nêu riêng `shippingEstimate`.
- Ngoài phạm vi (giữ nguyên, việc sau): Báo cáo lợi nhuận `pnl()` (`lib/queries/reports.ts::orderFacts`, dùng chung với
  Hiệu quả marketing theo ngày) còn cộng `orders.partner_fee` của Pancake; luật kết quả đơn "cước < 10K" (`return-rate.ts`) và các báo cáo quảng
  cáo / dòng tiền còn tự viết `coalesce(shipping_fee, partner_fee)` — đổi chúng là đổi số của báo cáo khác, cần
  đo trước/sau riêng.

