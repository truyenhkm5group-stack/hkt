# Lỗ lũy kế theo MKTer, và ba đường làm chi phí biến mất — 15/09/2026

Phiên làm việc trên nhánh `claude/trusting-noether-fh23sk`, nối tiếp mốc `3a27a04` (deploy #293).

---

## 0. ĐỌC NHANH — cái nào đang làm sai tiền ngay hôm nay

| # | Việc | Hôm nay có đang sai không |
|---|---|---|
| F10 | Lợi nhuận âm của MKTer bị `max(…, 0)` xoá mất, tháng sau ăn hoa hồng như chưa từng lỗ | **CÓ** — và đây là yêu cầu mới của chủ shop |
| F03 | Chi phí chung không còn căn cứ chia thì **bốc hơi** khỏi lợi nhuận | **CÓ** ở mọi kỳ không có doanh thu |
| F04 | Mã chỉ có quảng cáo, chưa có đơn ⇒ toàn bộ tiền quảng cáo rơi ra ngoài | **CÓ** với mọi mã mới đang thử |
| F01 | Đổi nguồn ghi nhận lương làm **hoa hồng biến mất** khỏi lợi nhuận | Chỉ khi chủ shop bật nguồn PAYROLL — nhưng bật là mất ngay |
| F05 | Chốt kỳ không kiểm "đã trừ đủ chi phí chưa" | Rủi ro chốt trên số thiếu |
| F06 | Hai yêu cầu chốt đồng thời có thể tạo hai kỳ FINAL chồng lấn | Chưa xảy ra — bịt trước |

Ba lỗi F03/F04/F01 đều làm lợi nhuận **CAO HƠN** sự thật. Đó là chiều hỏng nguy hiểm hơn trừ hai
lần: trừ hai lần làm lợi nhuận thấp đi nên có người thắc mắc, còn mất một khoản làm lợi nhuận cao
đẹp nên không ai đi kiểm. Và đó là con số dùng để trả lương.

---

## 1. F10 — LỖ LŨY KẾ THEO TỪNG MKTer (yêu cầu mới của chủ shop)

### 1.1 Vì sao hôm nay chưa làm được

Bảng lương tính hoa hồng cá nhân bằng `max(LN cá nhân, 0) × %`. Cái `max` ấy đúng ở chỗ không trả
tiền âm cho người ta — nhưng nó cũng **vứt mất con số âm**. Tháng lỗ 10 triệu và tháng hoà vốn cho
ra cùng một kết quả là 0. Nên tháng sau lãi 15 triệu thì người ấy ăn hoa hồng trên đủ 15 triệu như
chưa từng có tháng lỗ. Số âm không tồn tại ở bất kỳ đâu trong kho mã.

### 1.2 Công thức đang chạy

```
S_t      = P_t + D_{t-1}              (lợi nhuận sau bù lỗ, GIỮ được số âm)
Cơ sở HH = max(S_t, 0)
D_t      = min(S_t, 0)                (lỗ chuyển tháng sau, luôn ≤ 0)
HH có dấu = r_t × S_t                 (để THEO DÕI, không phải khoản phải trả)
HH phải trả = round(r_t × max(S_t, 0))
```

Ba con số tách bạch, cố ý không gộp: **LN thực phát sinh của tháng** (lỗ cũ KHÔNG bị trừ vào đây
lần nữa), **cơ sở tính hoa hồng sau bù lỗ**, và **tiền hoa hồng phải trả** (không bao giờ âm).

"HH có dấu" là số để theo dõi, **không cộng dồn**: −1 triệu tháng 8 và −0,4 triệu tháng 9 không
thành nợ −1,4 triệu. Chỉ `D_t` — số dư **lợi nhuận** — mới chuyển kỳ.

### 1.3 Khi hoa hồng là chi phí: giải hệ, không lặp

```
P = Q − H
H = r × max(P + D, 0)
```

Giải đóng: `Q + D > 0 ⇒ H = r(Q + D) / (1 + r)`, và khi ấy `P + D = (Q + D)/(1 + r) > 0` nên giả
thiết tự nhất quán. Ngược lại `H = 0, P = Q`. **Không vòng lặp, không ngưỡng hội tụ, chạy hai lần
ra đúng một số.**

**Làm tròn:** làm tròn ĐÚNG MỘT LẦN, ở `H` — vì `H` là tiền thật trả cho người thật. `P` suy ra
bằng `Q − H`, nên `P + H = Q` luôn đúng tuyệt đối, không có đồng nào rơi vào khe làm tròn.

Hệ nhiều người ở cấp shop: `P_shop = K / (1 + ΣA)` khi `K > 0`, ngược lại `P_shop = K`. Điều kiện
tồn tại `ΣA > −1`; vi phạm thì **chặn và nói lý do**, không in một con số nào.

### 1.4 Sổ (`marketer_profit_carryover`, migration 0089)

Grain: **một người, một tháng lịch Việt Nam**. Khoá duy nhất `(employee_id, month_key)` và cố ý
**không kèm `calc_version`** — đổi phiên bản phép tính không được sinh dòng chính thức thứ hai cho
cùng một nghĩa vụ.

Ràng buộc ở CSDL: số dư đầu/cuối ≤ 0 (số dương nghĩa là "lãi mang sang", mà lãi đã được trả hoa
hồng ở tháng nó phát sinh — mang sang là trả hai lần); cơ sở HH ≥ 0; tiền phải trả ≥ 0; chốt thiếu
ảnh chụp bị chặn; khoá tháng sai định dạng bị chặn.

**Vì sao là bảng, không phải tính lại mỗi lần mở.** Tính lại được, nhưng chỉ khi mọi tháng trước
đều còn ra đúng con số cũ — mà chính đó là thứ không giữ được: đổi một tỷ lệ, sửa một quy kết
fanpage, nhập thêm một phiếu kho, và số dư của tháng **đã trả tiền** đổi theo. Số dư mang sang là
một NGHĨA VỤ đã phát sinh, không phải một phép tính chạy lại được.

### 1.5 Không tự bật, và không đặt cả hệ thống về 0

Sổ chỉ chạy khi chủ shop **bật** VÀ khai **tháng mở sổ** (`settings: payroll.carryover`).

Vì sao phải có mốc mở sổ: muốn biết số dư đầu tháng 9 phải biết tháng 8, rồi tháng 7… lùi tới ngày
mở cửa — mà lợi nhuận những tháng ấy sẽ được tính bằng **công thức hôm nay** trên **dữ liệu hôm
nay**, không phải con số chủ shop đã dùng để trả lương lúc đó. Dựng một chuỗi số dư từ đó rồi gọi
nó là nghĩa vụ có thật là **tự bịa ra một khoản nợ**.

Số dư đầu của chính tháng mở sổ là 0 **theo khai báo của chủ shop** — có chủ, có ngày, truy nguyên
được; khác hẳn máy tự điền 0 cho mọi người rồi im lặng (AGENTS.md mục 35).

### 1.6 Bốn căn cứ số dư, không gộp

| Căn cứ | Nghĩa | Chốt được? |
|---|---|---|
| `PREV_MONTH_FINAL` | Tháng trước đã CHỐT | ✅ |
| `OPENING_DECLARATION` | Chủ shop khai số dư mở sổ | ✅ |
| `PREV_MONTH_DRAFT` | Tháng trước mới là NHÁP — mô phỏng | ❌ xem được, chưa đủ để chốt |
| `NONE` | Chưa có gì — **CHƯA BIẾT**, không phải 0 | ❌ |

Thứ năm là `NOT_APPLICABLE`: kỳ không phải một tháng lịch, hoặc tháng nằm trước mốc mở sổ. **Xem 7
ngày hay một quý không tạo và không cộng lại số dư** — số dư là chuỗi tuần tự theo tháng, cộng nó
theo một kỳ khác làm mất đúng phần lỗ mà cơ chế này sinh ra để giữ.

### 1.7 Chốt kỳ ghi luôn số dư mới

Không có phần này thì không tháng nào bao giờ thành FINAL trong sổ, nên chuỗi số dư **không bao giờ
tiến**: tháng sau mãi mãi đọc "tháng trước mới là nháp" và mãi mãi bị chặn chốt.

Nay mỗi dòng sổ được ghi trong **cùng giao dịch** với ảnh chụp kỳ, kèm **tỷ lệ hoa hồng tại lúc
chốt** (để số hoa hồng trong ảnh cũ vẫn giải thích được sau khi chủ shop đổi tỷ lệ) và căn cứ của
số dư đầu kỳ.

---

## 2. F03 · F04 · F01 — ba đường làm chi phí biến mất

### 2.1 F03 · Chi phí chung không còn căn cứ chia thì bốc hơi

Chi phí chung chia xuống từng mã theo **tỷ trọng doanh thu**. Kỳ không có đồng doanh thu nào thì
tổng trọng số bằng 0 và phép chia trả về toàn số 0.

Bản thân hàm phân bổ **không sai** — không có căn cứ nào để chia một triệu đồng cho những dòng đều
bằng 0. Sai ở phía **gọi**: lợi nhuận shop được cộng từ các dòng **đã phân bổ**, nên khoản ấy không
bao giờ được trừ.

Nay phần không chia được ở lại **cấp shop** thành một dòng đối soát đọc được (`sharedUnallocated`)
và vẫn trừ khỏi lợi nhuận, với bất biến:

```
Σ operatingAlloc của các mã + sharedUnallocated = operatingEntered + fixedCost + perOrderOps
```

Không chia bừa cho marketer — đó là ném chi phí lên đầu người không liên quan.

### 2.2 F04 · Mã chỉ có quảng cáo, chưa có đơn

Vòng lặp đi theo dòng hàng đã bán và phiếu nhập. Một mã mới vừa mở chiến dịch — đã tiêu tiền, chưa
bán được gì — không có dòng nào để đi qua, nên toàn bộ tiền quảng cáo của nó rơi ra ngoài.

Đây đúng là hình dạng chi tiêu của một mã mới: **tiêu trước, bán sau**. Và khoản bị giấu chính là
khoản chủ shop cần thấy nhất.

Nay mỗi mã như vậy có một dòng doanh thu 0, và quy kết rơi về chiều **quảng cáo** nên chi phí về
đúng người đã chạy chiến dịch — không phải chia đều, không phải rơi vào "chưa gán". Chiến dịch đánh
dấu `excluded` vẫn bị loại (có bài kiểm chiều ngược).

### 2.3 F01 · Đổi nguồn làm hoa hồng biến mất

Nhóm "Lương" ở bảng Chi phí đang chứa **cả lương cứng lẫn hoa hồng** — đó là cách shop vẫn ghi.
Bảng Lương chỉ góp được lương cứng. Nhưng độ phủ chỉ có **một cờ**, và cờ ấy bật `COMPLETE` chỉ vì
lương cứng > 0. Máy chi phí đọc cờ ấy rồi loại **toàn bộ** nhóm cũ.

Cảnh báo cũ CÓ nói ra — nguyên văn *"kể cả phần hoa hồng nằm lẫn trong đó"* — nhưng nói ra một
khoản tiền đã biến mất không làm nó quay lại.

Nay độ phủ khai **theo từng thành phần**:

| Thành phần | Nguồn khi bật PAYROLL | Độ phủ |
|---|---|---|
| Lương cứng | bảng Lương (đã chia theo ngày) | có thể `COMPLETE` |
| Hoa hồng | phần nhóm cũ **vượt quá** lương cứng — **vẫn được tính** | luôn `INCOMPLETE`, kèm lý do |

Nhóm cũ 12 triệu với lương cứng 9 triệu ra **9 + 3**, chứ không phải 9 (mất 3) và cũng không phải
21 (cộng hai lần). Cảnh báo nêu đúng phần chưa đối chiếu và nói thẳng hai điều: khoản ấy **vẫn được
tính**, và việc cần làm là **tách ra chứ không xoá chứng từ** — xoá đi là làm mất chi phí thật.

---

## 3. F05 · F06 — chốt kỳ

### 3.1 Một bộ điều kiện dùng chung

Trước bản này điều kiện nằm rải rác: server action kiểm bốn thứ, màn hình tự quyết hiện nút bằng
một biểu thức riêng. Hai nơi, hai mệnh đề, không ai buộc chúng nói cùng một điều.

Nay cả hai gọi **cùng một hàm thuần** (`lib/constants/payroll-readiness.ts`). Và điều kiện cũ
thiếu thật: *"tổng lương tính ra được một con số"* **không** đồng nghĩa với *"con số ấy đã trừ đủ
chi phí"*.

Năm cửa: kỳ có mốc đầu/cuối · cơ sở đủ điều kiện · không con số nào CHƯA BIẾT · **không có tiền
thật nằm ngoài phép tính** (cảnh báo mức `high` của máy chi phí) · **số dư lỗ đầu kỳ đã xác lập**.

Cảnh báo mức `medium` **không chặn** — nó là lời khai về NGUỒN, không phải lỗ hổng về SỐ. Chặn cả
nó là cách không bao giờ chốt được kỳ nào, rồi sẽ có người đi tắt hết cảnh báo cho xong.

Màn hình hiện nguyên văn danh sách việc còn thiếu ngay cạnh nút. Một nút bị ẩn mà không nói vì sao
là một bức tường.

### 3.2 Nguyên tử

Kiểm chồng lấn rồi mới ghi là **hai lượt đi CSDL**. Hai yêu cầu chốt gửi cùng lúc thì cả hai cùng
đọc "chưa có kỳ nào chồng lấn", rồi cả hai cùng ghi. Khoá tự nhiên `(period_key, basis)` không chặn
được vì hai khoá khác nhau; khoá một **dòng** cũng không cứu được vì dòng cần khoá **chưa tồn tại**.

Nay cả phép kiểm lẫn lượt ghi nằm trong một giao dịch cầm **khoá TÊN**
(`pg_advisory_xact_lock`) — khoá một cái tên chứ không khoá một dòng, tự nhả khi giao dịch kết
thúc, không cần `btree_gist` (không chắc có trên mọi môi trường). Chốt lương là việc mỗi tháng một
lần nên xếp hàng ở đây không tốn gì.

`setWhere status = 'DRAFT'` chặn chuyện hai yêu cầu cùng dùng một số dư cũ để ghi hai kết quả.

---

## 4. Giao diện và CSV

`/payroll` có bảng **Bù trừ lỗ lũy kế theo tháng** với bảy cột theo đúng thứ tự của phép tính:
lỗ đầu tháng · LN thực tháng · lỗ được bù · LN tính HH sau bù · HH có dấu · HH phải trả · lỗ chuyển
tiếp, kèm **căn cứ số dư**.

Đặt riêng chứ không nhồi vào bảng lương — bảng ấy đã rộng, và bảy con số này chỉ đọc được khi đứng
cạnh nhau. Cột "HH có dấu" cố ý **vẫn hiện số âm** dù tiền phải trả bằng 0: giấu nó đi thì tháng lỗ
và tháng hoà vốn trông giống hệt nhau — đúng cái lỗi mà cơ chế này sinh ra để sửa.

Bảng dựng từ tập dòng **đã lọc theo quyền**, nên tài khoản "xem của mình" chỉ thấy sổ của chính
mình. Không thêm một lượt lọc thứ hai: thêm một lượt lọc là thêm một chỗ để quên.

CSV mang đủ bảy cột ấy. Ô để **trống** khi chưa biết (ghi 0 là để bảng tính sau đó cộng nó vào tổng
như một con số đã xác minh), số âm giữ nguyên dấu, và dòng chân tệp nói rõ sổ đang ÁP DỤNG hay
KHÔNG ÁP DỤNG.

---

## 5. Kiểm thử

| Bộ | Khoá cái gì |
|---|---|
| `tests/profit-carryover.test.ts` | 12 khối, **bằng chính con số chủ shop đưa** |
| `tests/payroll-carryover.test.ts` | Sổ đi qua `getPayrollReport` THẬT + điều kiện chốt + nguyên tử |
| `tests/payroll-cost-preservation.test.ts` | F03 và F04 qua `getMarketerReport` THẬT |
| `tests/cost-double-count.test.ts` khối 11 | F01 — hoa hồng không biến mất khi đổi nguồn |
| `tests/migration-upgrade-path.test.ts` | 0089: bảng phải RỖNG sau nâng cấp + 4 ràng buộc |

Ca chủ shop nêu, chạy đúng số:

| Tháng | Lỗ đầu | LN thực | Sau bù | Cơ sở HH | HH có dấu | HH phải trả | Lỗ chuyển tiếp |
|---|---:|---:|---:|---:|---:|---:|---:|
| 8 | 0 | −10tr | −10tr | 0 | −1tr | 0 | −10tr |
| 9 | −10tr | +6tr | −4tr | 0 | −0,4tr | 0 | −4tr |
| 10 | −4tr | +9tr | +5tr | 5tr | +0,5tr | **500.000đ** | 0 |

Ca độc lập: lỗ cũ −10tr, tháng sau +15tr ⇒ cơ sở 5tr (không phải 15tr), trả 500.000đ.
Đổi tỷ lệ 10%→20%: bù theo **lợi nhuận** trước rồi mới áp tỷ lệ ⇒ 20% × 5tr = **1 triệu**, không
phải 2 triệu.
Hệ có lỗ cũ: Q = 20tr, D = −10tr, r = 10% ⇒ P = 19.090.909đ, H = 909.091đ, **P + H = Q**.

Hai bài chi phí đo bằng **chênh lệch** trước/sau, không gắn cứng con số của fixture dùng chung.

---

## 6. Còn tồn — nói thẳng

1. **Tranh chấp thật chưa thử trên PostgreSQL.** PGlite chỉ có MỘT kết nối nên hai giao dịch trong
   bộ kiểm luôn chạy nối đuôi nhau. Một bài "chạy hai lượt thấy đúng một cái thắng" trên PGlite
   chứng minh **đúng không gì cả** — nó xanh kể cả khi không có lá chắn nào. Nên khối 8 chỉ khoá
   hai thứ kiểm được: dòng đã chốt không bị ghi đè, và phép kiểm chồng lấn nằm SAU khoá tên. Phần
   tranh chấp thật cần một bài chạy trên PostgreSQL với hai kết nối.

2. **Hoa hồng vẫn chưa phải một khoản chi phí trong lợi nhuận đang chạy.** Phần giải hệ đã có,
   đã kiểm thử đầy đủ và dùng được (`solveCommissionWithCarryover`, `solveShopPayroll`), nhưng
   chưa nối vào `getMarketerReport` — đổi định nghĩa lợi nhuận toàn shop là đổi mọi con số của mọi
   báo cáo, và nó cần chủ shop chốt cơ sở trước (AGENTS.md mục 18 vẫn bật
   `COMMISSION_BASIS_NEEDS_REVIEW`).

3. **F07 · F08 (giá vốn đã ghi nhận, hàng tặng, phí vận đơn hoàn/giao lại) chưa làm** trong bản
   này.

4. **F09 (`/ads` 6,5 giây nguội) chưa làm** — xem mục 5.5 biên bản 14/09, ba giả thuyết đã bị bác
   bằng phép đo và bước tiếp theo đã ghi sẵn ở đó.

5. **Chủ shop cần cung cấp để sổ chạy:** bật `payroll.carryover`, khai **tháng mở sổ** và lý do;
   nếu có người đang mang lỗ từ trước mốc ấy thì khai số dư mở sổ đích danh. Chưa khai thì sổ
   KHÔNG ÁP DỤNG và bảng lương chạy y như trước — không con số nào đổi.
