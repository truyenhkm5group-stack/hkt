# BIÊN BẢN PHÁT HÀNH — HỆ ĐIỀU HÀNH CÔNG VIỆC (Work OS v1)

Ngày 12/09/2026 · nhánh `claude/work-management-os-v1` · SHA phát hành `12d337b` · deploy #242.

Đặc tả kiến trúc: `docs/work-management-os.md`. Rà soát điều hướng: `docs/navigation-review.md`.
Luật mới trong `AGENTS.md`: mục 19–21.

---

## 1. Kết luận audit — vì sao KHÔNG xây hệ thống task thứ hai

ERP đã có **sáu** hàng đợi việc, mỗi cái có SLA, nhóm phụ trách, tiền liên quan riêng:

| Nơi | Nguồn | Đã có |
|---|---|---|
| `/alerts` | `notifications` | 23 loại việc · 7 nhóm · điểm ưu tiên · SLA · người nhận · bằng chứng · 7 trạng thái |
| `/cs` | `cs_cases` + `cs_case_events` | vòng đời · người phụ trách · hẹn lại · chống trùng · lịch sử |
| `/shipments` | `shipment_care` + `care_case_events` | 9 trạng thái · chủ sở hữu · phản hồi đầu · mở lại |
| `/inventory/returns` | `return_inspections` | phiếu · người kiểm · tình trạng hàng |
| `/finance-ops` | `bank_transactions` | việc còn treo · số tiền |
| `/ads` | `getAdsDecision` | hành động đề xuất · tiền đang đốt |

**Thiếu không phải một hàng đợi nữa.** Thiếu MỘT CHỖ NHÌN CHUNG và thiếu TẦNG TỔ CHỨC: `users.role`
là vai trò phân quyền, `CaseTeam` là loại công việc, và không cái nào có danh sách người.

## 2. Quyết định kiến trúc: PHÉP CHIẾU, KHÔNG PHẢI BẢN SAO

Chép mỗi case CSKH thành một dòng `work_items` là lập tức có hai nơi giữ trạng thái cho cùng một
sự việc, rồi tới ngày `cs_cases.status='DONE'` đứng cạnh `work_items.status='IN_PROGRESS'`. Không
job đồng bộ nào cứu được vì job nào cũng trễ.

Nên `work_items` chỉ có dòng khi (a) đó là việc TAY / ĐỊNH KỲ, hoặc (b) có người chạm vào một việc
chiếu (giao, đặt hạn, hoãn, báo chặn). Ràng buộc CSDL biến điều đó thành bất khả thi:

```sql
CHECK ((authority = 'WORK') = (status IS NOT NULL))
UNIQUE (source_type, source_key)   -- source_key là khoá tự nhiên TẠI NGUỒN
```

Ba hệ quả đo được trên PGlite (`tests/work-os.test.ts`, 55 việc chiếu):

* **Chống trùng là tính chất cấu trúc** — 0 khoá trùng, không cơ chế dedupe nào phải bảo trì.
* **Đóng ở nguồn thì việc tự biến mất** — không job nào đóng hộ, không trạng thái mồ côi.
* **Hàng đợi KHÔNG đóng được việc của miền** — bị từ chối ở cả tầng ứng dụng lẫn ràng buộc CSDL.

## 3. Đã giao

| Phần | Nơi |
|---|---|
| Sổ thẩm quyền 11 nguồn việc | `lib/constants/work-sources.ts` |
| 7 trạng thái chung + BLOCKED ≠ WAITING + SLA + tiền `null`=chưa biết | `lib/constants/work.ts` |
| 7 phòng ban, ánh xạ `CaseTeam` → phòng | `lib/constants/departments.ts` + bảng `departments` |
| Sổ hành động LINK / DOMAIN / WORK — không nút giả | `lib/constants/work-actions.ts` |
| Phép chiếu bảy adapter chạy song song, nguồn hỏng không làm sập màn hình | `lib/queries/work-adapters.ts` |
| Lớp ghi chú: giao / hạn / hoãn / chặn / lịch sử | `lib/work/service.ts` + `lib/actions/work.ts` |
| Nút trên dòng gọi Server Action THẬT của miền | `lib/actions/work-quick.ts` |
| Sổ 14 chỉ số + hàm đọc, `null` khi chưa đo | `lib/constants/metric-bindings.ts` + `lib/queries/metric-resolver.ts` |
| OKR ba tầng · BSC bốn góc nhìn · trọng số cấu hình được | `lib/queries/okr.ts` · `lib/queries/bsc.ts` |
| Thẻ điểm nhân sự sáu trục, không gộp khi chưa khai trọng số | `lib/queries/work-performance.ts` |
| Kỳ review + ảnh chụp bất biến | `lib/queries/reviews.ts` |
| Bàn làm việc: một mục sidebar, bảy tab | `app/(dashboard)/work/*` |
| Job `work-recurrence` + lịch 15 phút | `lib/sync/jobs.ts` · `scripts/scheduler.mjs` |
| Tìm kiếm ⌘K: thêm Công việc và Nhân sự | `lib/queries/search.ts` |
| Dải "phòng nào đang kẹt" trên Điều hành theo khâu | `app/(dashboard)/operations/page.tsx` |
| Migration 0069, chỉ cộng thêm, gieo 7 phòng | `drizzle/0069_work_management_os.sql` |

## 4. Ba lỗi QA TRÌNH DUYỆT bắt được (mà ba lá chắn kia không thấy)

`tsc` xanh, `eslint` xanh, `npm test` xanh với cả ba. Chỉ có người mở trang mới thấy.

1. **`/work/all` đổ hoàn toàn** — `assignableMembers()` có truy vấn con tương quan; truy vấn chỉ
   một bảng trong FROM nên Drizzle in `"id"` trần, đụng `department_members dm` trong truy vấn con:
   `column reference "id" is ambiguous`. Nay qualify tay và kiểm thử gọi thẳng hàm đó.
2. **Hàng nút xuống ba dòng** — tám hành động trên một dòng. Nay ba nút ngoài, còn lại sau `…`.
3. **Một ô vượt đích che một ô đang chết** — doanh thu 185% kéo thẻ điểm lên 84% trong khi góc
   nhìn Quy trình nội bộ đúng bằng 0. Nay ô hiện số thật nhưng chỉ đóng góp tối đa 100% vào điểm
   góc nhìn / điểm thẻ / tiến độ Objective (84% → 63%, mục tiêu 49% → 44%).

## 5. Cổng phát hành

Chạy trên **bản checkout SẠCH** theo đúng SHA ứng viên (`git worktree add --detach`), không phải
trên cây làm việc:

```
npm ci            ✓
npm run typecheck ✓
npm run lint      ✓
npm test          ✓  "TẤT CẢ KIỂM THỬ ĐẠT"
npm run build     ✓  Compiled successfully in 50s
```

QA trình duyệt (Chromium, bản dựng production, PGlite 1.126 đơn demo): 8/8 tuyến trả 200, không
lỗi console, không phản hồi 5xx. Thời gian tới lúc hiện tiêu đề: `/work` 516ms · `/work/department`
373ms · `/work/all` 429ms · `/work/okr` 1.083ms · `/work/performance` 229ms · `/work/review` 225ms ·
`/work/settings` 330ms · `/operations` 334ms.

Đường nâng cấp từ production được kiểm riêng (`tests/migration-upgrade-path.test.ts`): áp 0069 lên
CSDL đã có 68 migration và dữ liệu nghiệp vụ thật → 7 phòng gieo đúng, đơn/case nguyên vẹn,
`work_items` RỖNG (phép chiếu, không bản sao), 3 ràng buộc thẩm quyền chặn đúng, chạy lại không
nhân đôi.

## 5b. HAI LẦN DEPLOY ĐỎ — và cả hai KHÔNG phải lỗi của bản này

Ghi lại vì nó là một lỗi hạ tầng kiểu **chậm và im lặng**, đúng loại khó tìm nhất, và nó sẽ quay
lại nếu người sau không biết.

| Deploy | Chết ở đâu | Thông báo |
|---|---|---|
| #242 (`12d337b`) | giải nén layer | `failed to extract layer ... no space left on device` |
| #243 (`2bf77eb`) | `git pull` trên VPS | `error: file write error: No space left on device` |

Cả hai lần: **bản đang chạy KHÔNG bị đụng tới** — production giữ nguyên `f280faa`, không migration
nào chạy, không gián đoạn dịch vụ. Mọi cổng CI đều xanh ở cả hai lần.

### Nguyên nhân gốc: tích luỹ suốt ~240 lần deploy

`docker image prune -f` trong `install-vps.sh` **chỉ xoá ảnh KHÔNG CÓ TAG**. Mỗi lần deploy kéo về
`ghcr.io/<kho>:<sha>` — một ảnh **có tag** ~2,6 GB — gắn thêm `erp-app:local` rồi đi tiếp. Ảnh cũ
mất tag `erp-app:local` nên thành dangling và được dọn; tag theo SHA thì **không ai gỡ**. Lệnh dọn
nhìn thẳng qua đúng thứ đang tích lại.

Đo được bằng thao tác `disk` mới: 39G/39G · 0 byte trống · 16 ảnh / 31,74 GB / **26,33 GB thu hồi
được (82%)** · 12 ảnh theo SHA.

### #243 phơi ra một điều #242 chưa thấy

Bản sửa nằm trong `install-vps.sh`, mà script đó chỉ chạy **sau khi** VPS `git pull` được. Máy chủ
đầy tới mức không ghi nổi một loose object — **không tải nổi chính bản sửa cho việc nó bị đầy**.
Sửa đúng chỗ vẫn vô dụng nếu không có đường đưa nó tới.

Lối ra: workflow vận hành **nhúng thẳng** script qua SSH, không cần `git pull` trên máy chủ (chứng
minh: thao tác `disk` chạy được lúc đĩa đã 100%). Thao tác `docker-prune` đi đường đó.

### Kết quả

```
TRƯỚC  /dev/vda1  39G  39G   0   100%   · 16 ảnh · 31,74 GB
SAU    /dev/vda1  39G  8.8G  30G  23%   ·  3 ảnh ·  3,16 GB
```

Dịch vụ sống suốt quá trình: 4/4 container Up, `{"ok":true,"commit":"f280faa260c5"}`.

### Bốn sửa để nó không quay lại

1. `install-vps.sh` — gỡ mọi tag `ghcr.io/<kho>:<sha>` cũ **trước** khi kéo.
2. `install-vps.sh` — gỡ tag theo SHA **ngay sau** khi gắn `erp-app:local` (ảnh vẫn sống).
3. `install-vps.sh` — **cổng ổ đĩa** dưới 3 GB thì dừng sớm, kèm `docker system df`, cùng lối với
   cổng bộ nhớ đã có ngay bên dưới.
4. `bootstrap.sh` — thông báo lỗi nói **đúng nguyên nhân**. #243 báo "Không kết nối được github.com
   — kiểm tra mạng của VPS" trong khi mạng hoàn toàn bình thường; một thông báo sai hướng bắt người
   trực đi soi nhầm chỗ.

Cộng thêm hai thao tác vận hành mới: `disk` (ổ đĩa là tài nguyên DUY NHẤT trong bốn thứ CPU / RAM /
đĩa / mạng chưa có chỗ xem — nên nó là thứ duy nhất hỏng mà không ai thấy trước) và `docker-prune`.

## 6. CHƯA LÀM — và vì sao

* **Kéo-thả / phụ thuộc giữa việc / sprint.** Cố ý không làm: V1 phải dùng được hằng ngày, không
  phải thay Jira. Mỗi ô thừa là một ô người ta bỏ trống rồi thấy phiền.
* **Hành động GHI sang Facebook Ads** (tạm dừng chiến dịch từ hàng đợi). ERP đọc Facebook chứ
  không ghi — `lib/integrations/facebook/*` không có hàm bật/tắt. Một nút "Tạm dừng" ở đây sẽ là
  nút giả: người bấm tin đã xong, tiền vẫn chảy. Nguồn `ADS_DECISION` vì thế chỉ có nút MỞ.
* **Chỉ số HR thật** (giờ đào tạo, tỷ lệ giữ người, hài lòng nội bộ). ERP chưa đo được, nên chúng
  để `MANUAL` trong sổ chỉ số thay vì có một truy vấn gần đúng đội lốt số đo.
* **Thời gian phản hồi tin nhắn đầu ở cấp lead.** `conversation_funnel` có dữ liệu nhưng độ phủ
  chưa đủ để làm KR (xem chú thích của chính bảng đó) — chưa đưa vào sổ chỉ số.
* **Gộp sáu trục hiệu suất thành một điểm.** Có hàm `combineScore` nhưng KHÔNG có bộ trọng số mặc
  định, và giao diện chưa có chỗ khai. Một bộ trọng số mặc định sẽ được dùng như thể nó có căn cứ,
  rồi ba tháng sau thành "điểm nhân viên" mà không ai nhớ ai chọn các con số đó.
* **Ba đề xuất điều hướng** (`docs/navigation-review.md` mục 3) — chờ chủ shop quyết, chưa đụng
  route nào.
