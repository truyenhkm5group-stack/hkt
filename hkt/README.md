# HKT – Sổ thu chi MB Bank cho shop bán hàng online

Ứng dụng web nhỏ, chạy trên máy cá nhân, giúp chủ shop online quản lý **doanh thu – chi phí – lợi nhuận**
từ sao kê tài khoản **MB Bank**: nhập sao kê, gán nhãn chi tiêu tự động, và lập
**Báo cáo kết quả kinh doanh** theo logic kế toán chuẩn.

## Tính năng

- **Nhập sao kê MB Bank** (`.csv` / `.xlsx`, xuất từ app MBBank, Biz MBBank hoặc Internet Banking).
  Tự nhận diện dòng tiêu đề và các cột *Ngày giao dịch, Nội dung, Số tiền / Ghi nợ / Ghi có, Số dư, Số tham chiếu, Đối tác*.
  Nhập chồng nhiều lần không bị trùng (khử trùng theo số tham chiếu).
- **Gán nhãn tự động** bằng quy tắc từ khoá / regex (không phân biệt dấu, hoa thường, theo chiều tiền vào/ra).
  Có sẵn hơn 20 quy tắc cho Shopee/Lazada/TikTok, GHN/GHTK/Viettel Post (COD và phí ship), Facebook/Google Ads,
  điện nước internet, lương, thuê kho, thuế, phí ngân hàng, lãi tiền gửi, góp/rút vốn...
  Người dùng thêm quy tắc riêng, "thử khớp" trước khi lưu, hoặc tạo quy tắc ngay từ một giao dịch.
- **Gán nhãn tay** từng giao dịch hoặc hàng loạt, thêm giao dịch tay (tiền mặt), ghi chú, xuất CSV.
- **Báo cáo kết quả kinh doanh** (mẫu B02-DN Thông tư 200 rút gọn cho hộ kinh doanh), biểu đồ theo tháng,
  chi tiết từng đầu mục chi phí kèm % doanh thu thuần, biên lợi nhuận gộp / ròng, dòng tiền, số dư đầu – cuối kỳ.
- **Ước tính thuế hộ kinh doanh** (GTGT 1% + TNCN 0,5% trên doanh thu, có ngưỡng miễn thuế theo năm – cấu hình được).

## Chạy

Mọi lệnh chạy trong thư mục `hkt/` (app này nằm cạnh Shop Control ERP trong cùng repo):

```bash
cd hkt
pip install -r requirements.txt
python run.py            # mở http://127.0.0.1:8000
```

Dữ liệu lưu ở `hkt/data/hkt.sqlite3` (đổi bằng biến môi trường `HKT_DB`). Dùng thử với file mẫu
`sample_data/mb_sao_ke_mau.csv` ở tab **Nhập sao kê**.

Chạy test:

```bash
python -m pytest -q
```

## Logic kế toán

Dữ liệu lấy từ sao kê ngân hàng nên báo cáo lập theo **cơ sở tiền** (cash basis): doanh thu / chi phí
ghi nhận khi tiền thực vào / ra tài khoản – phù hợp hộ kinh doanh nộp thuế theo doanh thu thực thu
(TT 40/2021, TT 88/2021/TT-BTC).

Mỗi giao dịch được gán vào một **danh mục**; mỗi danh mục thuộc một **nhóm kế toán**, và nhóm quyết định
dòng nào của báo cáo:

| Nhóm | TK tham chiếu | Ví dụ danh mục |
|---|---|---|
| Doanh thu bán hàng | 511 | Khách chuyển khoản, Shopee payout, COD từ GHN/GHTK |
| Giảm trừ doanh thu | 521 | Hoàn tiền / trả hàng, chiết khấu |
| Giá vốn hàng bán | 632 | Nhập hàng, vận chuyển hàng mua về, nguyên liệu |
| Chi phí bán hàng | 641 | Phí ship, bao bì, quảng cáo, phí sàn, hoa hồng |
| Chi phí quản lý | 642 | Lương, thuê kho, điện nước internet, phần mềm, lệ phí môn bài |
| Doanh thu / chi phí tài chính | 515 / 635 | Lãi tiền gửi / phí ngân hàng, lãi vay |
| Thu nhập / chi phí khác | 711 / 811 | Bồi thường, phạt |
| Thuế | 821 | Thuế GTGT + TNCN hộ kinh doanh đã nộp |
| **Không tính vào lãi/lỗ** | 411, 341, 112, 211, 331 | Góp / rút vốn, vay / trả gốc, chuyển nội bộ, mua tài sản lớn, đặt cọc NCC |

Báo cáo:

```
10  Doanh thu thuần          = 01 Doanh thu − 02 Giảm trừ
20  Lợi nhuận gộp            = 10 − 11 Giá vốn
30  LN thuần từ HĐKD         = 20 + 21 DT tài chính − 22 CP tài chính − 25 CP bán hàng − 26 CP quản lý
40  Lợi nhuận khác           = 31 Thu khác − 32 Chi khác
50  LN trước thuế            = 30 + 40
60  LN sau thuế              = 50 − 51 Thuế đã nộp trong kỳ
```

Một số nghiệp vụ được xử lý đúng chuẩn:

- Nhà cung cấp hoàn tiền (tiền vào, gán "Nhập hàng hoá") → **giảm giá vốn**, không phải doanh thu.
- Trả nợ vay: phần **gốc** không phải chi phí, chỉ phần **lãi** vào chi phí tài chính.
- Chủ shop rút tiền cá nhân → giảm vốn, **không phải chi phí**; góp vốn không phải doanh thu.
- Mua thiết bị giá trị lớn → tài sản, không tính chi phí một lần.
- Lệ phí môn bài vào chi phí quản lý (642); thuế GTGT/TNCN của hộ vào dòng thuế (821).

## Cấu trúc

```
app/main.py         API FastAPI + phục vụ giao diện
app/db.py           SQLite schema, seed danh mục / quy tắc / cài đặt
app/categories.py   Danh mục & nhóm kế toán, quy tắc mặc định
app/rules.py        Engine gán nhãn (chuẩn hoá bỏ dấu, contains / regex, chiều tiền, ưu tiên)
app/importer.py     Đọc sao kê CSV/XLSX, ánh xạ cột linh hoạt, parse số tiền / ngày, khử trùng
app/reports.py      P&L, chi tiết đầu mục, chuỗi theo tháng, ước tính thuế
app/static/         Giao diện web thuần (HTML/CSS/JS)
tests/              pytest (rules, importer, reports, API)
sample_data/        Sao kê mẫu
```

## API chính

`GET/POST/PATCH/DELETE /api/transactions`, `POST /api/transactions/bulk-categorize`,
`POST /api/import?dry_run=true|false`, `GET/POST/PUT/DELETE /api/rules`, `POST /api/rules/apply`,
`GET /api/rules/test`, `GET/POST/DELETE /api/categories`, `GET /api/reports/pnl|categories|monthly`,
`GET /api/export.csv`, `GET/PUT /api/settings`. Tài liệu tự sinh tại `/docs`.

## Lưu ý

MB Bank không có API công khai cho tài khoản cá nhân, nên app làm việc qua file sao kê xuất từ app / web MB Bank.
Số thuế chỉ để tham khảo, cần đối chiếu với cơ quan thuế.
