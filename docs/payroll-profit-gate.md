# Cổng lỗ lũy kế toàn công ty cho thưởng % lợi nhuận

Chủ shop giao 19/10/2026: *"Không cho phép phát sinh thưởng % lợi nhuận mới khi công ty còn lỗ lũy kế
chưa bù hết, đồng thời bảo đảm mọi khoản lương và quyền lợi hợp pháp của nhân viên."*

Mã: `lib/payroll/profit-gate.ts` (hàm thuần) · `lib/constants/payroll-profit-gate.ts` (quy chế) ·
`lib/queries/payroll-profit-gate.ts` (sổ lũy kế) · `lib/queries/payroll.ts::getPayrollReport` (nối).
Kiểm thử: `tests/payroll-profit-gate.test.ts`. Đối soát production: ops `payroll-profit-gate-audit`.

---

## 1. Công thức cũ và vì sao sai

| Khoản | Công thức cũ | Nhìn vào |
|---|---|---|
| Thưởng % LN toàn shop | `round(max(LN kỳ, 0) × %)` | MỘT kỳ |
| Hoa hồng % LN cá nhân | `round(max(LN cá nhân, 0) × %)` (sổ lỗ MKTer nếu bật) | MỘT người |
| Quyết toán tự động (01/M+2) | tính lại `max(LN sống, 0) × %` của kỳ đã khoá, truy lĩnh / truy thu phần chênh | MỘT kỳ, đi vòng |

Năm nguyên nhân gốc, đo trên production 18/10/2026:

1. **Không có khái niệm lỗ lũy kế của CÔNG TY ở bất kỳ đâu.** Sổ lỗ chỉ có theo từng MKTer
   (`marketer_profit_carryover`) và chưa bật. Tháng 8/2026 lợi nhuận shop ≤ 0, tháng 9 dương, tháng 10
   ≤ 0: tháng 9 vẫn tính **20.946.743 ₫** thưởng theo lợi nhuận mà không nhìn tháng 8.
2. **Lãi cá nhân vượt qua lỗ công ty.** Hoa hồng % LN cá nhân chỉ hỏi "người này lãi không". Một người
   lãi trên mã của mình vẫn được thưởng khi cả công ty lỗ — đúng hiện tượng trên `/payroll?period=all`.
3. **Cơ sở thưởng chưa trừ lương cứng.** Bảng Chi phí không có khoản "Lương" nào và nguồn ghi nhận chưa
   khai (mặc định bảng Chi phí) ⇒ lợi nhuận dùng để nhân % cao hơn sự thật **8.000.000 ₫/tháng**. Cảnh
   báo `PAYROLL_OBLIGATION_NOT_RECOGNIZED` có chặn CHỐT, nhưng không chặn HIỂN THỊ số thưởng.
4. **Không có trần quỹ.** Tổng các tỷ lệ % LN toàn shop đang khai là 40%, cộng thêm 25–30% LN cá nhân
   của ba người; không có gì buộc tổng thưởng ≤ một ngân sách nào.
5. **Quyết toán tự động là đường vòng.** `lib/payroll/settlement.ts` tự sinh thưởng lợi nhuận mới (hoặc
   truy thu thưởng đã chi) cho kỳ đã khoá, không qua điều kiện nào.

Production chưa từng chốt / khoá / trả kỳ lương nào qua ERP (0 dòng `payroll_periods`, 0 dòng
`payroll_payout_lines`), nên **chưa có đồng nào bị trả sai qua ERP**. Số "có nguy cơ" là số đã HIỂN THỊ
như thể được hưởng — mục 7.

## 2. Ba con số, không gộp

| Tên | Nghĩa | Dùng để |
|---|---|---|
| Lợi nhuận kế toán | sau MỌI chi phí, kể cả thưởng đã chia | kết quả kinh doanh |
| Lợi nhuận đóng góp cá nhân | phần quy kết cho một người | đo người, chia quỹ |
| Lợi nhuận đủ điều kiện chia | phần lãi của tháng còn lại sau khi bù hết lỗ lũy kế và vượt mốc cao nhất đã chia | sinh quỹ thưởng |

Lợi nhuận cá nhân / phòng ban **không bao giờ** là căn cứ vượt qua điều kiện lỗ của công ty.

## 3. Công thức mới (một tháng lịch t)

```
N(t−1)  lũy kế toàn công ty tới hết tháng trước, ĐÃ trừ thưởng lợi nhuận đã chia
H(t−1)  mốc cao nhất đã chia (High-Water Mark), luôn ≥ N(t−1)
B(t)    lợi nhuận tháng TRƯỚC thưởng lợi nhuận, SAU mọi chi phí khác
        = lợi nhuận tính lương − hoa hồng thông thường (+ điều chỉnh muộn của tháng trước, mục 5)

L = H − N                       lỗ cần bù (≥ 0)
E = max(0, B − L)               lợi nhuận đủ điều kiện chia
Q = ⌊E × cap%⌋                  quỹ thưởng tối đa (cap% do quy chế khai, không có mặc định)
S = min(Σ đề nghị, Q)           phân bổ; vượt quỹ thì chia theo tỷ lệ, làm tròn xuống, dư phát theo số lẻ lớn nhất
N(t) = N + B − S
H(t) = E > 0 ? H + E − S : H
```

- **Đề nghị** của khoản % LN toàn công ty = `% × E` (không phải `% × B`); của khoản % LN cá nhân = số
  tạm tính (đã qua sổ lỗ MKTer nếu bật). Chính sách máy chung có bậc / ngưỡng trên `PROFIT_SHOP` được
  tính lại một lượt với đại lượng `= E`.
- **Bất biến** H(t) ≥ N(t): nếu E > 0 thì N + B = H + E nên H(t) − N(t) = 0; nếu E = 0 thì B ≤ L nên
  H − N − B ≥ 0. Hệ quả: lợi nhuận đã chia không bao giờ chia lại, và lỗ phát sinh SAU một tháng đã
  thưởng phải bù trước khi phát sinh thưởng mới. Phép thử ngẫu nhiên 50 chuỗi × 24 tháng khoá điều này.
- **Không vòng lặp**: thưởng lợi nhuận nằm NGOÀI B — nó được tính từ B.
- Tháng cũ (khoá trước khi có cổng) đã chốt thưởng VƯỢT phần đủ điều kiện ⇒ mốc không lùi, phần vượt
  thành lỗ phải bù.

### Giả định kế toán

1. Cơ sở là "Lợi nhuận tính lương" (`profit1`): doanh thu giao thành công (`ORDER_OUTCOME`) − giá vốn
   hàng đã giao − quảng cáo − vận chuyển & phí hoàn − chi phí vận hành phân bổ − lương cố định theo
   NGUỒN GHI NHẬN chi phí nhân sự. Đơn hoàn/huỷ đã nằm sẵn trong định nghĩa doanh thu.
2. Hoa hồng thông thường = khoản loại `COMMISSION`/`KPI`/`BONUS`/`PIECE_RATE` KHÔNG tính trên lợi
   nhuận, và % doanh thu cá nhân của đường cũ. Lương cứng / phụ cấp KHÔNG trừ lại ở đây (đã ở nguồn ghi
   nhận — trừ thêm là trừ hai lần).
3. **Bảo hiểm phía doanh nghiệp**: ERP CHƯA có mô hình phần đóng của doanh nghiệp. Khoản ấy phải nhập
   vào bảng Chi phí để vào B; ERP không phát hiện được sự vắng mặt của nó (ghi rõ ở đây để không ai
   tưởng nó đã được trừ).
4. Phạm vi: CSDL của tổ chức đang xem (`getDb()`, mô hình SILO). P&L của khách SaaS là pháp nhân khác,
   không bao giờ cộng vào lũy kế của VNXcommerce (`tests/payroll-profit-gate.test.ts` quét mã nguồn).

## 4. Quy chế — số dư mở sổ do người duyệt khai

`settings: payroll.profit-gate`, khai ở **Lương → Cấu hình**. Mỗi lần lưu là một PHIÊN BẢN MỚI (bản cũ
giữ trong `history`), mang người duyệt (cần cả `payroll:manage` và `payroll:approve`), mốc thời gian,
số hiệu quy chế, căn cứ số dư, có thể cần người thứ hai duyệt, và một dòng `audit_logs`
(`PAYROLL_PROFIT_GATE_POLICY`).

| Ô | Ý nghĩa |
|---|---|
| Tháng mở sổ | ngày hiệu lực — tháng đầu tiên cổng xét |
| Lũy kế tới hết tháng trước | số dư ĐÃ ĐỐI SOÁT; âm = lỗ |
| Mốc cao nhất đã chia | ≥ max(0, lũy kế) — không cho chia lại lãi trước mốc |
| Thưởng đã chi trước mốc | để màn hình hiện "đã chi" đầy đủ |
| Quỹ tối đa (%) | (0, 100] — quyết định của quy chế |

ERP KHÔNG tính ngược lỗ lũy kế về quá khứ: lợi nhuận những tháng trước khi ERP có số (vốn, hàng tồn,
chi phí ngoài sổ) ERP không biết; dựng từ công thức hôm nay là bịa một con số.

**Chưa khai ⇒ `NOT_ESTABLISHED`**: thưởng % lợi nhuận là "chưa xét được", thực nhận được duyệt là `—`,
kỳ có khoản ấy không chốt được. Không có đường lùi về "trả như cũ".

## 5. Sổ lũy kế theo tháng

Số dư đầu tháng M = khai báo mở sổ → đi qua từng tháng từ mốc mở sổ tới M−1:

- tháng ĐÃ KHOÁ (`LOCKED`/`PAID`, cơ sở `profit1`): đọc `snapshot.profitGate` (lợi nhuận riêng của
  tháng + điều chỉnh muộn + thưởng đã chốt). Ảnh chụp đời cũ: dựng từ chính các con số đã chụp.
- tháng CHƯA KHOÁ: MÔ PHỎNG bằng bản tính sống (tối đa 12 tháng) — xem được, `established = false`,
  CHẶN chốt (`PROFIT_GATE_NOT_ESTABLISHED`). Khoá lần lượt từng tháng.

**Chứng từ đến muộn** (đơn hoàn sau ngày khoá, chi phí nhập muộn): tháng đã khoá đứng yên, và ERP
**không tự đo lại** nó. Lý do (review độc lập vòng 2–4): lợi nhuận "sống" của một tháng cũ được tính
bằng giá vốn (giá báo MKT / phiếu nhập gần nhất), giả định chi phí cố định / theo đơn, hồ sơ nhân sự
và nguồn ghi nhận lương của HÔM NAY. Đem nó trừ số đã chụp là trộn chứng từ muộn với một lần đổi giá —
hạ giá báo MKT 20.000 ₫ trên 5.000 cái đã bán là 100 triệu "lãi muộn" ảo, đủ vượt mốc và sinh thưởng.
Không phép tính nào tách được hai thứ ấy, nên ERP không đoán.

Thay vào đó: **ĐIỀU CHỈNH LŨY KẾ tường minh** (Lương → Cấu hình): tháng GHI (phải còn mở), tháng chứng
từ, số tiền có dấu, lý do, người duyệt (cần quyền khai báo + duyệt lương, có thể cần người thứ hai),
nhật ký `PAYROLL_PROFIT_GATE_ADJUSTMENT`. Nó cộng vào lợi nhuận đem xét của tháng ghi đúng một lần và
được chụp cùng tháng ấy khi khoá; dòng nào ghi vào tháng đã khoá bị bỏ qua. Chỉ thêm — sai thì ghi dòng
ngược dấu. Tháng chứng từ BẮT BUỘC, phải sớm hơn tháng ghi và ĐÃ KHOÁ (chứng từ của tháng chưa khoá đã
nằm trong bản tính của chính tháng ấy — ghi thêm là đếm hai lần). Duyệt / khoá một tháng bị CHẶN nếu
tập điều chỉnh trong sổ khác tập trong ảnh chụp (ghi lúc soát mà chưa tính lại thì khoản ấy sẽ mất im
lặng) — phép so chạy TRONG giao dịch khoá, dưới cùng khoá tên với lượt ghi sổ. Sổ ghi dưới khoá tên
— hai lượt lưu đồng thời không xoá dòng của nhau. Mở khoá tháng k bị chặn khi còn điều chỉnh về chứng
từ của k (tổng khác 0): tính lại k sẽ gồm chính chứng từ ấy — ghi một dòng ngược dấu trước. Mở khoá phải đi **từ tháng khoá mới nhất trở về** (chặn ở `transitionPayrollRunAs`), nên một
điều chỉnh không bao giờ bị đếm hai lần vì tháng cũ được tính lại.

Chiều sai còn lại là QUÊN GHI. Đơn cuối tháng giao sau ngày chốt (đuôi mà `settlement.ts` đã khai) làm
lợi nhuận thật CAO hơn số đã chụp — quên ghi thì công ty thưởng ít hơn. Nhưng đơn hoàn muộn và chi phí
nhập muộn đi chiều ngược lại — quên ghi thì lũy kế cao hơn sự thật. Chiều nào trội là một GIẢ ĐỊNH chưa
đo trên production; trước khi dựa vào nó, đo dấu của chênh lệch sau khoá của vài tháng đầu.
Bảng "chênh lệch phát sinh sau khi chốt" của kỳ đã khoá (`payrollDrift`, có dòng "Lợi nhuận đem xét
cổng thưởng") cho người kế toán thấy cần ghi gì — nhớ rằng nó gồm cả phần đổi giá / giả định.

Số dư dựng từ tháng còn nháp là MÔ PHỎNG: phần "đủ điều kiện" hiện kèm nhãn "mô phỏng", thực nhận
được duyệt của người có khoản ấy là "—", và chốt kỳ bị chặn.

**Quyết toán tự động** (`settlement.ts`) từ bản này CHỈ truy lĩnh / truy thu hoa hồng thông thường; dòng quyết toán do máy tạo (`AUTO_SETTLEMENT:`, ADJUSTMENT/DEDUCTION, người có mặt) được trừ vào cơ sở của tháng ghi nó.
Thưởng % lợi nhuận không bao giờ được sinh thêm hay truy thu tự động cho kỳ đã khoá.

## 6. Bảo vệ quyền lợi nhân viên & dữ liệu lịch sử

- Lương cứng, phụ cấp, hoa hồng doanh thu, điều chỉnh đã duyệt: **không đổi một đồng**.
- Số TẠM TÍNH theo công thức cũ vẫn hiện (cột riêng, `provisionalSalary`) — không xoá, không ghi đè.
  Phần "chưa đủ điều kiện" kèm lý do; nó không phải nợ của nhân viên.
- Không sửa / truy thu kỳ đã khoá; không backfill; không ghi dữ liệu production nào.
- Hợp đồng / quy chế hiện hành có thể hứa thưởng % lợi nhuận THEO THÁNG không điều kiện. Cổng mặc định
  CHƯA KẾT LUẬN cho tới khi người có quyền duyệt lương khai quy chế — đó là bước "rà soát hợp đồng trước
  khi kích hoạt". Nếu quy chế cũ có hiệu lực pháp lý cho một kỳ, khoản ấy trả bằng **Điều chỉnh** (loại
  Thưởng, bắt buộc lý do + người duyệt) — một quyết định có tên, không phải một công thức im lặng.

## 7. Đối soát production

```
python ship.py ops payroll-profit-gate-audit "--from-month 2026-06 --to-month 2026-10 --opening 0 --cap 100"
```

Chỉ đọc (Postgres ép). In theo tháng: lợi nhuận tính lương · hoa hồng thông thường · lương cứng chưa ghi
nhận · lợi nhuận đem xét · thưởng tạm tính và đủ điều kiện từng người · chênh lệch; đối chiếu ba cơ sở
(tính lương · danh nghĩa · dòng tiền); và bảng `?period=all`. Số dư mở sổ trong tham số là GIẢ ĐỊNH của
phép đo. Kết quả từng người nằm trong bản mã, không vào tài liệu này (kho PUBLIC).

## 8. Màn hình

`/payroll` (tháng lịch, cơ sở "Lợi nhuận tính lương"): khối **Điều kiện thưởng lợi nhuận toàn công
ty** — lợi nhuận kỳ · lũy kế toàn công ty · số lỗ cần bù · LN đủ điều kiện · quỹ tối đa · thưởng đã chi ·
còn được phân bổ — và câu *"Chưa đủ điều kiện thưởng lợi nhuận — công ty chưa bù hết lỗ lũy kế."* khi
còn lỗ. Bảng lương: LN đóng góp cá nhân · thưởng % LN tạm tính · thưởng LN đủ điều kiện (+ chưa đủ điều
kiện và lý do) · thực nhận được duyệt (+ tạm tính). Kỳ không phải tháng / cơ sở khác: `NOT_APPLICABLE`,
chỉ tạm tính. Phiếu lương, CSV, chuyển khoản (`snapshotNetPay`) đọc số được duyệt.

## 9. Trần theo tháng + người nhận phần còn lại (chủ shop 21/10/2026)

Chủ shop: «Quân ăn 35% lợi nhuận tổng, và từ tháng 11 ăn 40% lợi nhuận tổng trừ các chi phí và lợi nhuận đã phân
chia cho các MKTer và nhân viên khác … 35% và 40% lợi nhuận là con số tổng lợi nhuận phân chia, … tự làm thì ăn cả,
còn dùng MKTer hoặc nhân viên khác thì cần chia phần cho các nhân viên đó, và chỉ nhận được phần còn lại để tổng LN
phân chia không vượt quá 35% (trước tháng 11/2026) và không vượt quá 40% (từ tháng 11/2026).» Bảng hỏi cùng ngày:
lợi nhuận tổng = LN ĐỦ ĐIỀU KIỆN (sau cổng); lương cứng KHÔNG trừ (đã là chi phí).

```
cap(m)      = mốc cuối của poolCapSchedule có fromMonth ≤ m; không có ⇒ poolCapPercent; không có ⇒ CHƯA XÁC LẬP
Q(m)        = ⌊E(m) × cap(m)⌋
R (người nhận phần còn lại) = max(0, Q − Σ đề nghị của MỌI người khác)
Σ người khác > Q ⇒ R = 0, người khác chia tỷ lệ (allocatePool), số vượt in ra (PROFIT_GATE residual.overdrawnBy)
```

- Khai ở Lương → Cấu hình → Quy chế chia thưởng lợi nhuận: bảng «Trần quỹ theo tháng» + ô «Người nhận phần còn lại».
  Lưu là phiên bản mới (quyền Duyệt lương · người thứ hai `PAYROLL_EDIT` · nhật ký).
- Khoản riêng của người nhận (35% toàn shop, thưởng theo mã…) HIỆN trên phiếu với số tạm và lý do «gộp trong phần
  còn lại», được duyệt 0; dòng «Phần còn lại của quỹ thưởng» mang số thật. Thực nhận vẫn theo công thức cũ
  `tạm tính − Σ tạm tính thưởng LN + Σ đủ điều kiện`.
- Hồ sơ % cũ của người khác (vd % LN cá nhân song song thưởng theo mã) KHÔNG bị sửa ngầm — lá chắn «trả hai lần»
  giữ chờ tới khi chủ shop đưa về 0 trên giao diện.
- Ảnh chụp kỳ (`ProfitGateSnapshot.poolCapPercent` · `.residual`) ghi trần đã dùng, người nhận, Σ người khác và số
  vượt — kỳ đã khoá đọc ảnh chụp, không tính lại.

