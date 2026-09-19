# Hoà giải va chạm migration — nhánh nhân sự AI ↔ `main`

**Trạng thái: đường hoà giải ĐÃ CÓ và ĐÃ KIỂM. Chưa gộp nhánh, chưa đụng CSDL nào.**

## Va chạm

Nhánh và `main` cùng dùng số hiệu **0084–0099** cho những migration hoàn toàn khác nhau.
Không trùng một tên tệp nào, nhưng trùng **15 số hiệu**.

| | nhánh | `main` |
|---|---|---|
| miền | nhân sự AI bán hàng | lương · hoàn hàng · landing · vtp · tech · phiên |
| số migration từ 0084 | 16 (0084–0099) | 23 (0084–0106) |
| mốc lớn nhất | 1789835704721 | **1789976427245** |

Bản chạy thử (đo 19/09/2026): **97 migration đã áp**, trần mốc **1789381643786**, hash của mục
cuối `b3daebe6ae82` — **khớp đúng** `0097_review_expected_behavior` của nhánh. Không có một bảng
nào của `main` (`payroll_periods`, `fb_adsets`, `return_reason_observations`, `care_decisions`,
`cto_proposals` đều = 0).

## Vì sao gộp thẳng hỏng CẢ HAI phía

Drizzle **không so tên tệp** và **không so hash**. Nó đọc mốc lớn nhất đã áp (`created_at`) **một
lần**, rồi bỏ qua mọi migration có mốc thấp hơn con số ấy.

- **production** (trần = mốc lớn nhất của `main`): cả **16** migration của nhánh đều có mốc thấp
  hơn ⇒ **bị bỏ qua hết**, im lặng. Production không bao giờ có lược đồ nhân sự AI.
- **bản chạy thử** (trần 1789381643786): `main` 0084–0087 có mốc thấp hơn ⇒ bị bỏ qua. Và `main`
  0090 chạy `ALTER TABLE "fanpages"` trong khi bảng ấy do chính 0086 tạo ⇒ **lượt migration chết
  giữa chừng**. `IF NOT EXISTS` trên tên cột không cứu được một bảng không tồn tại.

## Hai tệp hoà giải

Sinh bằng `node scripts/migration-reconcile/generate.mjs` — không gõ tay lại một câu SQL nào.

| | nội dung | mốc | chạy ở đâu |
|---|---|---|---|
| **R1** | hiệu ứng của `main` 0084–0087 | **giữa** trần bản chạy thử và mốc `main` 0088 | chạy trên bản chạy thử; bỏ qua trên production (đã có) |
| **R2** | **trạng thái cuối** của lược đồ nhánh | **lớn hơn mọi mốc của `main`** | chạy trên production; không-làm-gì trên bản chạy thử |

### R2 không phải bản phát lại 16 migration

Bản đầu ghép 16 migration rồi thêm `IF NOT EXISTS` vào từng câu. Bài kiểm bác bỏ ngay, và lý do
đáng nhớ: **idempotent từng câu không phải idempotent cả chuỗi khi trong chuỗi có lệnh xoá.**

0088 tạo `sales_size_profiles` cùng các khoá ngoại trỏ tới nó; 0091 xoá **cả cột
`size_profile_id` lẫn bảng**. Phát lại chuỗi ấy trên một CSDL đã ở trạng thái cuối sẽ chạy câu
"thêm khoá ngoại trên `test_product_profiles.size_profile_id`" vào một cột **không còn tồn tại**.

Nên R2 mô tả **trạng thái cuối** (bản kết xuất toàn lược đồ của drizzle-kit, biến thành chạy-lại-
được). Không có bẫy thứ tự nào.

**Đánh đổi phải nói rõ:** bản kết xuất mô tả cái `db/schema.ts` *nói*, còn 16 migration mô tả cái
đã *thật sự chạy*. Hai thứ lệch nhau thì R2 đi theo `db/schema.ts`. Bài kiểm vì vậy không chỉ so
hai đường với nhau mà còn đòi những bảng/cột cụ thể phải có mặt.

## Kiểm chứng

`tests/migration-reconcile.test.ts` dựng hai CSDL PGlite thật:

- **đường A** — CSDL trắng đi theo sổ hợp nhất (tương đương production nâng cấp): **124 migration**
- **đường B** — CSDL đã mang lịch sử nhánh (đúng bản chạy thử hôm nay): **120 migration**

So từng bảng · từng cột · từng kiểu · từng chỉ mục: **2 676 dòng ảnh chụp, trùng khớp hoàn toàn.**

Bài kiểm đã được **thử ngược**: bỏ R1 ra khỏi sổ thì đường B chết đúng ở `main`
`0090_fanpage_alias_access` — đúng chỗ đã dự đoán.

## ⚠ THỨ TỰ ĐƯA VÀO SỔ — chỗ dễ hỏng nhất

**R2 CHỈ được đưa vào sổ Ở LÚC GỘP NHÁNH.** Đưa nó vào sổ của nhánh lúc này là nâng trần của bản
chạy thử lên **trên** mốc của `main` 0088–0106, và khi ấy toàn bộ **19** migration đó bị bỏ qua
vĩnh viễn ở bản chạy thử — đúng cái bẫy mà cả cuộc hoà giải này sinh ra để tránh.

Khi gộp, sổ hợp nhất xếp theo thứ tự:

```
[mục chung 0000–0083] → [main 0084–0087] → R1 → [main 0088–0106] → [nhánh 0084–0099] → R2
```

`idx` chỉ để người đọc; thứ hạng thật do **vị trí trong mảng** và **mốc** quyết định.

## Việc KHÔNG được làm (và đã không làm)

- đổi tên migration đã áp rồi giả vờ chưa chạy
- sửa SQL của migration đã áp
- đặt lại sổ migration · xoá lược đồ · ép bản chạy thử về lịch sử của `main`
- đụng CSDL production

## Còn lại cho người gộp nhánh

1. Gộp mã (12 tệp xung đột, phần lớn là cộng-thêm cả hai phía).
2. Chép `out/R1.sql` và `out/R2.sql` vào `drizzle/` với số hiệu sau `main` 0106, thêm mục sổ đúng
   **vị trí** và đúng **mốc** như bảng trên.
3. Cập nhật `MOI` trong `tests/migration-upgrade-path.test.ts`.
4. Chạy `tests/migration-reconcile.test.ts` trên sổ đã gộp thật.
