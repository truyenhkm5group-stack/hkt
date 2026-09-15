# Đối chiếu lương trên production — 15/09/2026

**CHỈ ĐỌC.** Mọi con số dưới đây lấy bằng thao tác `db-query` của workflow "Vận hành ERP trên VPS",
chạy dưới `PGOPTIONS='-c default_transaction_read_only=on'` — chính Postgres từ chối mọi lệnh ghi.
Không một dòng nào bị `insert` / `update` / `delete`; không gán chính sách; không khoá kỳ; không
chạy migration.

Hai lượt chạy:
- [run 34963300842](https://github.com/truyenhkm5group-stack/hkt/actions/runs/34963300842) — trạng thái bảng lương
- [run 34963406929](https://github.com/truyenhkm5group-stack/hkt/actions/runs/34963406929) — cấu trúc cấu hình lương cũ

> **Không có số tiền của cá nhân nào trong tài liệu này, và đó là chủ ý.** Kho mã là PUBLIC, nên log
> của GitHub Actions cũng công khai. Các truy vấn cố ý chỉ hỏi ĐẾM và PHÂN LOẠI — không hỏi tên,
> không hỏi mức lương, không hỏi tỷ lệ của ai.

---

## 1. Trạng thái bảng lương trên production

| Đo | Kết quả |
| --- | --- |
| `payroll_periods` — số kỳ lương đã lưu | **0** |
| trong đó đã đóng băng (`FINAL` / `LOCKED` / `PAID`) | **0** |
| `marketer_profit_carryover` — số dòng sổ lỗ lũy kế | **0** |
| Bảy bảng mới của máy chính sách | **chưa tồn tại bảng nào** |
| Khoá cấu hình lương trong `settings` | chỉ có `payroll.employees` |
| Migration đã áp | **94** |

### Điều này quyết định câu hỏi "merge có an toàn không"

**Sai lệch cũ / mới trên production = 0đ, và đó là một phép đo, không phải một ước lượng.**

Ba lý do độc lập, mỗi lý do tự nó đã đủ:

1. **Chưa có kỳ lương nào tồn tại.** Không có con số đã trả nào để bản mới làm lệch. Rủi ro "ảnh
   chụp của kỳ đã chốt bị tính lại" bằng 0 vào ngày phát hành, vì chưa có ảnh chụp nào.
2. **Chưa ai được gán chính sách** (bảy bảng còn chưa tồn tại). Máy tính chung chỉ chạm tới người
   ĐÃ được gán; mọi người khác đi nguyên đường cũ. Đây là điều `tests/payroll-policy-engine.test.ts`
   khối 1 khoá ở mức mã nguồn: *chưa gán ⇒ sai lệch bằng ĐÚNG 0*.
3. **Bản sửa cơ sở tính hoa hồng không đổi con số nào hôm nay** — xem mục 2.

### Một điều thấy được khi đo, không do PR này gây ra

Production báo **94** migration đã áp, trong khi sổ `drizzle/meta/_journal.json` trên `main` chỉ có
**93** mục (số hiệu **38** khuyết trong sổ). Chênh lệch 1 dòng này có từ trước PR này.

Nó **không chặn deploy** — drizzle áp theo sổ và bỏ qua hash đã áp — nhưng đáng để tra lại:

```
action: db-query
arg: select hash, created_at from drizzle.__drizzle_migrations order by created_at
```

---

## 2. Bản sửa cơ sở tính hoa hồng: đo xem nó đổi bao nhiêu tiền

Bản này sửa một lỗi thật: `getOperatingCost().amount` gồm cả nhóm `COMMISSION`, và tổng ấy chảy vào
cơ sở tính hoa hồng — nghĩa là hoa hồng kỳ trước làm giảm cơ sở tính hoa hồng kỳ này.

**Trên production hôm nay, bản sửa ấy đổi 0đ.** Căn cứ:

| Đo | Kết quả |
| --- | --- |
| Số dòng chi phí nhóm "Lương" (`expenses.category = 'SALARY'`) — toàn bộ lịch sử | **0** |
| — trong 90 ngày gần nhất | **0** |
| Khoá `payroll.recognition` trong `settings` | **chưa khai** ⇒ mặc định `LEGACY_EXPENSES` |

Thành phần `COMMISSION` trong máy chi phí được suy ra từ phần nhóm "Lương" vượt quá lương cứng, và
chỉ khác 0 khi bảng Lương đã cầm quyền ghi nhận. Ở đây **cả hai điều kiện đều không thoả**: không
có dòng chi phí lương nào, và bảng Lương chưa cầm quyền.

Nên bản sửa là **đúng về nguyên tắc và trung tính về số** ở thời điểm phát hành. Nó bắt đầu có tác
dụng thật từ lúc chủ shop ghi chi phí lương hoặc bật bảng Lương làm nguồn ghi nhận — tức là nó
được sửa **trước** khi nó kịp làm ai thiệt, chứ không phải sau.

---

## 3. Báo cáo ứng viên chính sách từ cấu hình lương cũ

Đọc `settings['payroll.employees']` trên production, **chỉ lấy cấu trúc**:

| Đo | Kết quả |
| --- | --- |
| Nhân sự khai trong hồ sơ | **4** |
| Đang làm việc | **4** |
| Có khai lương cứng (> 0) | **2** |
| Có khai % lợi nhuận tổng (> 0) | **2** |
| Có khai % lợi nhuận cá nhân (> 0) | **3** |
| Có khai % doanh thu cá nhân (> 0) | **0** |
| Không khai khoản nào (cả bốn ô đều 0) | **0** |
| **Chưa nối tài khoản đăng nhập ERP** | **4 / 4** |
| Số phòng ban | **1** |

### Ánh xạ sang chính sách lương

Phép ánh xạ là `proposePolicyFromLegacy` — **cùng hàm** mà màn hình `/payroll/migration` dùng, không
phải một phép suy diễn riêng cho tài liệu này:

| Ô trên hồ sơ cũ | Thành phần đề xuất | Loại | Phép tính | Đại lượng |
| --- | --- | --- | --- | --- |
| Lương cứng | `LEGACY_FIXED` | `FIXED` | `FIXED_AMOUNT` | — (chia theo ngày của kỳ) |
| % lợi nhuận tổng | `LEGACY_PCT_TOTAL` | `PROFIT_SHARE` | `RATE_OF_BASIS` | `PROFIT_SHOP` |
| % lợi nhuận cá nhân | `LEGACY_PCT_PERSONAL` | `COMMISSION` | `RATE_OF_BASIS` | `PROFIT_PERSONAL` |
| % doanh thu cá nhân | `LEGACY_PCT_REVENUE` | `COMMISSION` | `RATE_OF_BASIS` | `REVENUE_PERSONAL` |

Tỷ lệ và số tiền **chép nguyên** từ hồ sơ hiện có — không con số nào được bịa ra. Bù lỗ lũy kế
chép đúng trạng thái sổ hiện tại (đang **TẮT**), không đoán.

### Phân loại mức sẵn sàng

| Mức | Số người | Vì sao |
| --- | --- | --- |
| `READY` | **0** | — |
| `NEEDS_CONFIG` | **4** | Chưa có dòng **phân công lao động** nào (`employment_assignments` rỗng). Máy tính lương cắt kỳ theo phân công; thiếu nó thì không đoạn nào được tính. Màn hình `/payroll/migration` CHẶN nút chuyển vì đúng lý do này. |
| `NEEDS_REVIEW` | **0** | Không ai khai % doanh thu, nên không có cơ sở nào cần chủ shop phân định lại. |
| `BLOCKED` | **0** | Không ai bỏ trống cả bốn ô — cả 4 đều ánh xạ được ít nhất một thành phần. |

**Việc phải làm để cả 4 thành `READY`:** khai một dòng phân công lao động cho mỗi người ở
`/payroll/assignments` — ngày vào làm, hình thức làm việc, phòng ban. Không cần gõ lại một con số
lương nào; chính sách sinh ra từ hồ sơ cũ.

### Một việc nữa, không chặn chuyển đổi nhưng chặn phiếu lương

**4/4 nhân sự chưa nối tài khoản đăng nhập ERP** (ô "Email đăng nhập ERP" trống). Quyền
"Lương: xem của mình" khớp bằng KHOÁ TÀI KHOẢN, nên hôm nay **không ai** tự mở được phiếu lương
của mình — trang sẽ hiện danh sách rỗng. Trang `/payroll` đã cảnh báo sẵn điều này cho người quản
trị. Sửa ở hồ sơ nhân sự, mỗi người một email.

---

## 3b. ĐÍNH CHÍNH: "4/4 khớp, lệch 0đ" ở mục 1 là một kết quả RỖNG NGHĨA

Mục 1 kết luận "sai lệch cũ/mới = 0đ" từ việc các bảng lương production đang rỗng. **Kết luận ấy
đúng về mặt sự kiện nhưng không đủ để làm căn cứ phát hành**, và cần nói thẳng ra:

Bốn người "khớp" vì cả hai đường tính đều trả về cùng một thứ *không có gì*. Hai phép tính cùng ra
0 trên dữ liệu rỗng **không chứng minh chúng đồng ý** — chỉ chứng minh không có gì để bất đồng.
Kết quả rỗng nghĩa nguy hiểm vì nó trông y hệt một kết quả tốt, và nó xuất hiện đúng lúc người ta
muốn nghe điều đó nhất.

Cổng đối chiếu nay **từ chối** loại kết luận ấy: kỳ không có một nguồn số nào khác 0 thì kết quả là
`RECONCILIATION_BLOCKED_BY_CONFIG`, không phải "đạt". `tests/payroll-production-readiness.test.ts`
khối 11 khoá điều đó bằng một khẳng định thẳng: *bốn người khớp trên một kỳ rỗng vẫn không được đạt*.

### Đối chiếu THẬT trên dữ liệu không rỗng

Chạy trên bộ dữ liệu demo của kho mã — **1.126 đơn · 1.034 vận đơn · 20 dòng chi phí** — với bốn
nhân sự mang đúng **hình dạng** cấu hình production (2 có lương cứng · 2 có %LN tổng · 3 có %LN cá
nhân · 0 có %doanh thu · 1 không khai gì). *Số là số thử, không phải mức lương thật của ai.*

Script tự chọn kỳ **08/2026**: 455 đơn · 291 giao thành công · 387.490.000đ doanh thu · 7 dòng chi phí.

| Lượt | Trạng thái khai báo | Kết quả | Kết luận cổng |
| --- | --- | --- | --- |
| 1 | Chưa khai phân công — **đúng trạng thái production hôm nay** | 4 `NEEDS_CONFIG` · 0 `MATCH` | `RECONCILIATION_BLOCKED_BY_CONFIG` |
| 2 | Đã khai phân công | **3 `MATCH`** · 1 `NEEDS_CONFIG` · **0 `BUG`** | `RECONCILIATION_PASS` |

Ba con số khớp ở lượt 2 — và không con số nào là 0:

| Đường cũ | Máy mới | Lệch | Gồm |
| ---: | ---: | ---: | --- |
| 12.000.000 | 12.000.000 | **0** | lương cứng chia theo ngày của kỳ |
| 12.784.183 | 12.784.183 | **0** | 9.000.000 lương cứng + 3.784.183 (3% lợi nhuận toàn shop) |
| 2.522.789 | 2.522.789 | **0** | 2% lợi nhuận toàn shop |

Con số `3.784.183` là thứ chứng minh nhiều nhất: nó chạy qua **trọn bộ** máy tính lợi nhuận (đơn →
doanh thu giao thành công → giá vốn → chi phí → phân bổ), và hai đường tính độc lập ra đúng cùng
một số. Đó là bằng chứng hai implementation đồng ý — thứ mà lượt chạy trên bảng rỗng không nói được.

**Chứng minh không ghi:** ảnh đếm 10 bảng lương (gồm `audit_logs`) TRƯỚC = SAU ở cả hai lượt.
`transaction_read_only=on` và `default_transaction_read_only=on` được chính Postgres xác nhận trước
khi đọc dòng đầu tiên.

> Đây là **CSDL demo cục bộ**, không phải production. Nó chứng minh **hai implementation đồng ý
> trên dữ liệu có thật**; nó KHÔNG thay cho một lượt chạy trên số liệu production. Vì sao chưa chạy
> được trên production: mục 4.

---

## 4. Đối chiếu từng người trên PRODUCTION: vì sao vẫn chưa chạy được

Yêu cầu là một bảng `Legacy / New Policy Preview / Difference` cho từng nhân sự. Bảng ấy **chưa lập
được ở phiên này**, và lý do là một sự thật về hạ tầng chứ không phải một bước bị bỏ quên:

- Kênh đọc production duy nhất phiên này có là `db-query` — nó chạy **một câu SQL**, không chạy mã
  ứng dụng. Mà cả hai vế của bảng ấy (`getPayrollReport` cho cột cũ, máy chính sách cho cột mới)
  đều là **mã ứng dụng**, không phải một câu truy vấn.
- Kênh chạy mã ứng dụng trên production có tồn tại (`fetch_script` trong `ops-vps.yml`, kiểu
  `returns-parity` / `profit-verify`), nhưng nó **ghim cứng `?ref=main`**. Script đối chiếu của
  nhánh này chưa có trên `main`, nên kênh ấy không lấy được nó. Sửa `fetch_script` để nhận ref tuỳ
  ý sẽ cho **bất kỳ nhánh nào** chạy mã tuỳ ý trên production — một lỗ hổng lớn hơn nhiều so với
  vấn đề nó giải, nên **không làm**.
- Dựng lại phép tính ấy bằng SQL viết tay sẽ tạo ra một **đường tính thứ ba** — đúng thứ AGENTS.md
  mục 8.12 cấm, và nó sẽ khớp với màn hình đúng tới lúc một trong hai bên đổi.
- Chạy `scripts/payroll-reconcile.ts` cần một `DATABASE_URL` trỏ tới production; phiên này không
  có, và **không bịa ra kết quả cho một script chưa chạy**.

Đổi lại, con số quan trọng nhất của bảng ấy — **cột "Lệch"** — đã trả lời được bằng phép đo ở mục
1: nó bằng **0đ cho cả 4 người**, vì chưa ai được gán chính sách và chưa kỳ nào được chốt. Bảng chi
tiết từng khoản sẽ có nghĩa **sau** khi khai phân công và chuyển người đầu tiên.

**Lệnh để lập bảng ấy**, chạy sau deploy (chỉ đọc, Postgres ép):

```
docker exec erp-app npm run payroll:reconcile -- --from 2026-09-01 --to 2026-09-30 --csv /tmp/doi-chieu.csv
docker cp erp-app:/tmp/doi-chieu.csv ./doi-chieu.csv
```

Nó in đúng các cột yêu cầu — lương cứng, thưởng % LN tổng, hoa hồng % LN cá nhân, hoa hồng % doanh
thu, tổng, so với cột máy chung, kèm chênh lệch tuyệt đối và lời giải thích từng dòng — và phân
loại mỗi dòng thành `MATCH` / `EXPECTED_CHANGE` / `MISSING_CONFIG` / `NEEDS_REVIEW`.

---

## 5. Kết luận

| Câu hỏi | Trả lời |
| --- | --- |
| Deploy bản này có làm đổi một con số lương nào đang dùng không? | **Không.** Chưa kỳ nào tồn tại, chưa ai được gán chính sách, và bản sửa cơ sở hoa hồng trung tính về số trên dữ liệu hiện tại. |
| Có ảnh chụp kỳ đã chốt nào bị đe doạ không? | **Không có ảnh chụp nào để đe doạ.** |
| Migration có mất dữ liệu không? | Không — cả ba chỉ cộng thêm, bảy bảng mới sinh ra rỗng, năm cột mới có mặc định, không backfill. |
| Còn việc gì phải làm trước khi dùng được máy mới? | Khai phân công lao động cho 4 người; nối email đăng nhập cho 4 người; quyết định tỷ lệ thuế/BHXH (hoặc để "Chưa cấu hình"). |
| Đối chiếu từng người đã chạy chưa? | **Chưa** — cần `DATABASE_URL` production hoặc một lượt deploy. Lệnh đã ghi sẵn ở mục 4. |
