# Sổ tay đưa module Lương lên production

> **Tài liệu này CHƯA được thực thi.** Nó là bản hướng dẫn để chủ shop (hoặc phiên deploy) làm
> theo sau khi đã đọc báo cáo cuối và quyết định merge. Không bước nào ở đây đã chạy.

Nhánh: `claude/elegant-curie-zn92up` · PR [#3](https://github.com/truyenhkm5group-stack/hkt/pull/3)

---

## 0. Điều làm bản này khác một lần phát hành thông thường

**Không một con số lương nào đổi vào ngày phát hành.** Đó không phải một lời hứa mà là một tính
chất đo được, và đây là căn cứ (đo trên production 15/09/2026 bằng thao tác `db-query`, chỉ đọc):

| Đo trên production | Kết quả |
| --- | --- |
| Số kỳ lương đã lưu (`payroll_periods`) | **0** |
| Số kỳ đã đóng băng (`FINAL` / `LOCKED` / `PAID`) | **0** |
| Số dòng sổ lỗ lũy kế (`marketer_profit_carryover`) | **0** |
| Bảy bảng mới của máy chính sách | **chưa có bảng nào** |
| Nhân sự khai trong `payroll.employees` | **4** |
| Migration đã áp | **94** |

Người CHƯA được gán chính sách vẫn đi ĐƯỜNG TÍNH CŨ, không sửa một dòng nào. Bảy bảng mới sinh ra
RỖNG. Nên ngay sau deploy, mọi con số của `/payroll` vẫn đúng bằng con số hôm nay.

Chuyển một người sang máy mới là một lần **chủ shop bấm**, có mốc hiệu lực, có bảng đối chiếu, có
dấu vết — không phải một hệ quả của việc deploy.

---

## 1. TRƯỚC KHI DEPLOY

### 1.1 Sao lưu

```
Actions → "Vận hành ERP trên VPS" → action: backup
```

Chờ chạy xong và **đọc dòng cuối**: nó in ra tên tệp dump và kích thước. Không có dòng ấy thì
chưa có bản sao lưu — dừng lại.

### 1.2 Đối chiếu production (CHỈ ĐỌC)

Hai cách, dùng cách nào cũng được:

**Cách A — không cần deploy gì, chạy ngay hôm nay.** Thao tác `db-query` chạy dưới
`default_transaction_read_only=on`, nghĩa là chính Postgres từ chối mọi lệnh ghi.

```
Actions → "Vận hành ERP trên VPS" → action: db-query
arg:
select count(*) as ky_luong, count(*) filter (where status in ('FINAL','LOCKED','PAID')) as da_dong_bang from payroll_periods
```

Kỳ vọng ở thời điểm viết tài liệu: `0 | 0`. Nếu ra số khác 0 thì đã có kỳ lương được chốt kể từ
15/09/2026 — **đọc lại mục 0**, vì căn cứ "không con số nào đổi" dựa trên việc bảng ấy rỗng.

**Cách B — sau khi deploy, đối chiếu từng người bằng script.** Script này CHỈ ĐỌC, và "chỉ đọc" ở
đây do Postgres ép chứ không do mã nguồn hứa (`ERP_READ_ONLY=1` →
`default_transaction_read_only=on` ở gói khởi tạo kết nối):

```
docker exec erp-app npm run payroll:reconcile -- --from 2026-09-01 --to 2026-09-30
```

Thêm `--json bao-cao.json` hoặc `--csv bao-cao.csv` để lấy tệp đính kèm. Thêm `--employee <id>` để
soi một người.

Script **không** `insert`, **không** `update`, **không** `delete`, **không** gán chính sách,
**không** khoá kỳ.

### 1.3 Kiểm migration

Trước deploy, đếm số migration đã áp:

```
action: db-query
arg: select count(*) from drizzle.__drizzle_migrations
```

Ghi lại con số. Bản này thêm **3** migration (`0094_payroll_policy_engine`,
`0095_payroll_run_lifecycle`, `0096_payroll_input_approval`), nên **sau** deploy con số phải tăng
đúng 3. Tăng ít hơn nghĩa là có migration bị bỏ qua — dừng lại và đọc mục 4.

> **Một điều đã thấy khi đo, không do bản này gây ra:** production báo 94 migration đã áp trong khi
> sổ `drizzle/meta/_journal.json` trên `main` chỉ có 93 mục (số hiệu 38 khuyết). Chênh lệch này có
> từ trước PR này và không chặn deploy (drizzle áp theo sổ và bỏ qua hash đã áp), nhưng đáng để chủ
> shop biết và tra lại khi rảnh.

Ba migration của bản này **chỉ cộng thêm**: `ADD COLUMN IF NOT EXISTS`, `CREATE TABLE IF NOT
EXISTS`, thêm ràng buộc. Không `DROP`, không `ALTER TYPE`, không backfill, không viết đè dòng nào.
Bảng lớn không bị khoá lâu vì không có bảng lớn nào bị đụng — bảy bảng mới đều rỗng, và ba cột
thêm vào `payroll_inputs` nằm trên một bảng cũng rỗng.

### 1.4 Kiểm cấu hình và biến môi trường

Bản này **không thêm biến môi trường nào bắt buộc**. Biến duy nhất nó giới thiệu là
`ERP_READ_ONLY`, và script tự đặt cho tiến trình của chính nó — **không được** đặt nó trong `.env`
của ứng dụng, vì làm vậy là biến cả ERP thành chỉ đọc.

### 1.5 Kiểm quyền

Ba quyền lương phải có người giữ, và **`payroll:manage` với `payroll:approve` nên ở hai người khác
nhau** — người khai số và người duyệt số không nên là một. Kiểm ở `/settings/users`.

| Quyền | Làm được gì |
| --- | --- |
| `payroll:view` | Xem bảng lương toàn shop |
| `payroll:view-own` | Chỉ xem phiếu lương của chính mình (khớp bằng email đăng nhập) |
| `payroll:manage` | Khai chính sách, phân công, nhập liệu, tính kỳ |
| `payroll:approve` | Duyệt · trả lại · khoá · mở khoá · đánh dấu đã trả |

Chưa có ai giữ `payroll:approve` thì kỳ lương sẽ đi được tới `UNDER_REVIEW` rồi dừng — không hỏng,
nhưng không chốt được.

### 1.6 Xác nhận chính sách và tỷ lệ

**Chưa gán chính sách cho ai.** Đây là việc của chủ shop sau khi deploy, làm từng người ở
`/payroll/migration`. Trước đó không cần chuẩn bị gì.

### 1.7 Xác nhận đường tính cũ vẫn chạy

Sau deploy, người chưa gán chính sách phải vẫn hiện đủ bốn ô lương cũ trên `/payroll`. Đây là bước
kiểm ở mục 3.2.

---

## 2. DEPLOY

1. **Merge PR #3 vào `main`** (chủ shop bấm).
2. `Actions → "Deploy ERP to VPS" → Run workflow` trên `main`.
   Workflow tự chạy `npm ci` → `typecheck` → `lint` → `npm test` → `build` **TRƯỚC** khi chạm máy
   chủ. Contract test đỏ thì deploy dừng, không phải cảnh báo.
3. **Migration tự áp khi ứng dụng khởi động** — không có bước chạy tay.
4. Chờ workflow báo thành công. Nó tự gọi `/api/health` và so `ERP_COMMIT` với SHA vừa deploy; sai
   SHA thì nó báo lỗi.

---

## 3. SAU KHI DEPLOY

### 3.1 Kiểm migration đã áp đủ

```
action: db-query
arg: select count(*) from drizzle.__drizzle_migrations
```

Phải bằng con số ghi ở mục 1.3 **cộng 3**.

Và bảy bảng mới phải có mặt, **và phải RỖNG**:

```
action: db-query
arg: select 'salary_policies' t, count(*) n from salary_policies union all select 'employee_policy_assignments', count(*) from employee_policy_assignments union all select 'employment_assignments', count(*) from employment_assignments union all select 'payroll_inputs', count(*) from payroll_inputs union all select 'payroll_adjustments', count(*) from payroll_adjustments
```

Kỳ vọng: **tất cả bằng 0.** Một bảng khác 0 ngay sau deploy nghĩa là có backfill ở đâu đó — dừng
lại, vì bản này cố ý KHÔNG backfill gì.

### 3.2 Mở màn hình

Tám tuyến lương nay nằm trong `scripts/smoke.ts`, nên **workflow deploy tự mở chúng** bằng một
phiên đăng nhập thật và báo lỗi nếu trang nào không trả 200. Không cần mở tay — nhưng vẫn nên nhìn:

Mở lần lượt, mỗi trang phải lên được và không có ô nào hiện `0 ₫` ở chỗ đáng lẽ là `—`:

- `/payroll` — bảng lương, các thẻ số liệu, nút xuất CSV
- `/payroll/payslip` — phiếu lương một người
- `/payroll/policies` — sổ chính sách (rỗng) và ô "Xem thử phép tính"
- `/payroll/assignments` — phân công & gán chính sách (rỗng)
- `/payroll/adjustments` — đầu vào nhập tay & điều chỉnh (rỗng)
- `/payroll/migration` — bảng đối chiếu cũ/mới, phải hiện đủ 4 người
- `/payroll/runs` — vòng đời kỳ lương
- `/payroll/settings` — hai công tắc + bảng khai cơ sở lợi nhuận + ô khấu trừ theo luật

> **Đã chạy thật ở phiên soát này** (15/09/2026, bản dựng production trên PGlite cục bộ có gieo 3
> nhân sự): cả 8 tuyến + đường xuất CSV đều trả **HTTP 200**, không trang nào lỗi runtime, trang
> nặng nhất `/payroll` mất **0,51 giây**. Kiểm cả nội dung: phiếu lương in **"Chưa cấu hình"** ở
> dòng khấu trừ theo luật (KHÔNG in "0 ₫"), màn hình chuyển đổi in đủ **5 nhãn trạng thái** và nêu
> chặn "chưa có dòng PHÂN CÔNG", tệp CSV mang dòng **"Nguồn số: BẢN TÍNH SỐNG"**.

### 3.3 Người đường cũ không đổi số

Trên `/payroll`, so bốn ô của một người bất kỳ với con số **trước** deploy. Phải bằng nhau.
Nhanh hơn: `/payroll/migration` in thẳng bảng "Đường cũ / Máy chung / Lệch" cho từng người.

### 3.4 Xem thử phép tính

`/payroll/policies` → "Xem thử phép tính". Nhập một bộ đại lượng giả, bấm xem. Nó chạy **đúng máy**
đang tính lương thật và **không ghi gì**. Sau khi bấm, kiểm lại mục 3.1: bảy bảng vẫn phải rỗng.

### 3.5 Nhật ký

`/settings/audit` phải có dòng cho mọi thao tác vừa làm. Không có dòng nào nghĩa là nhật ký không
chạy — đó là một lỗi chặn, vì cả module này dựa trên việc mọi lượt đổi tiền đều có vết.

### 3.6 Sổ lỗ lũy kế

Mặc định **TẮT**. Kiểm ở `/payroll/settings`. Bật nó là đổi cơ sở tính tiền của mọi người có thành
phần bù lỗ, nên chỉ bật khi chủ shop đã chọn tháng mở sổ và nêu lý do.

### 3.7 Tệp xuất

Xuất CSV từ `/payroll`. Kiểm:
- ô CHƯA BIẾT để **trống**, không phải `0`;
- dòng cuối tệp nói rõ nguồn số là **BẢN TÍNH SỐNG** (vì chưa kỳ nào đóng băng);
- cột "Thực nhận" của người chưa gán chính sách để **trống** — trống nghĩa là không áp dụng.

---

## 4. QUAY ĐẦU (ROLLBACK)

### 4.1 Quay ứng dụng về bản trước

```
Actions → "Deploy ERP to VPS" trên commit TRƯỚC khi merge PR #3
```

Hoặc trên VPS: `docker compose up -d app scheduler` với thẻ ảnh cũ.

### 4.2 Migration thì KHÔNG quay đầu — và không cần quay

Ba migration này **chỉ cộng thêm**: bảy bảng mới (rỗng) và năm cột mới (có mặc định). Bản ứng dụng
CŨ không đọc chúng, nên để nguyên là an toàn tuyệt đối.

**Không chạy một migration ngược nào.** `DROP TABLE` / `DROP COLUMN` là thao tác MẤT DỮ LIỆU và
không cứu được gì — bảng rỗng không gây hại. Nếu thật sự cần dọn, đó là một quyết định riêng của
chủ shop, làm sau, có sao lưu, không nằm trong đường quay đầu.

### 4.3 Đóng băng việc ghi lương trong lúc xử lý sự cố

Nếu cần chặn mọi lượt ghi lương mà không quay đầu cả ứng dụng: gỡ quyền `payroll:manage` và
`payroll:approve` khỏi mọi tài khoản ở `/settings/users`. Màn hình vẫn xem được, mọi đường ghi bị
từ chối ở **máy chủ** (không phải chỉ ẩn nút).

### 4.4 Đường tính cũ là lưới an toàn

Kể cả khi máy mới có vấn đề, người chưa gán chính sách vẫn được trả bằng đường cũ. Muốn đưa một
người ĐÃ chuyển về lại đường cũ: xoá dòng gán chính sách của người ấy ở `/payroll/assignments`, hoặc
đóng nó lại tại một mốc. Lịch sử không mất.

---

## 5. Những việc KHÔNG nằm trong sổ tay này

- **Khai tỷ lệ thuế TNCN / BHXH.** ERP cố ý để trống và in "Chưa cấu hình" thay vì "0 ₫". Khai là
  một quyết định của chủ shop kèm căn cứ pháp lý, làm ở `/payroll/settings`, cần người thứ hai duyệt.
- **Gán chính sách hàng loạt.** Không có nút ấy, và cố ý không có.
- **Bật bảng Lương làm nguồn ghi nhận chi phí nhân sự.** Mặc định vẫn là bảng Chi phí. Đổi sai
  chiều nào cũng hỏng — đọc phần giải thích ngay trên công tắc trước khi bấm.
