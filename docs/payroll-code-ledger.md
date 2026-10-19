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
| Các SUPPORT dùng hai cách tính trọng số trong cùng đoạn | chờ |
| Hai OWNER / hai điều khoản cùng hiệu lực | chờ — ERP không chọn hộ |
| X% + Y% > 100% | chờ |
| Người đang hưởng % LN CÁ NHÂN mà được giao thêm mã | chờ — cộng cả hai là trả hai lần |
| MKTer không có dòng lương trong kỳ | chờ |
| Sổ mã chưa dựng được (chưa khai quy chế / ảnh chụp trước V2) | chờ |

Còn bất kỳ dòng chờ nào ⇒ blocker `PROFIT_CODE_PENDING` chặn duyệt kỳ, và thực nhận được duyệt của
người liên quan là CHƯA KẾT LUẬN (`null`, in "—").

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

## 8. Kiểm thử

`tests/payroll-code-ledger.test.ts` — 13 ca chủ shop liệt kê (phần thuần + luồng thật trên CSDL qua
`getPayrollReport`, khoá tháng 1 bằng đường chốt kỳ, đổi OWNER + đổi X% giữa tháng 2), cộng hàng rào
mã nguồn. Kiểm đột biến 19/10/2026: bỏ HWM · chia đều khi thiếu QC · đề nghị trên phần đủ điều kiện
của mã thay vì phần phân bổ · bỏ chặn lương khi chờ · bỏ phát hiện % LN cá nhân · không cộng khoản
theo mã vào tạm tính — cả 6 đều làm bài kiểm đỏ.
