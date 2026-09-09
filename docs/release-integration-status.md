# Trạng thái tích hợp phát hành — 4 phiên làm việc song song

Cập nhật: 09/09/2026, sau khi Session 1 đóng băng phạm vi.
Vai trò người viết: **điều phối phát hành** (release coordinator). Không mở tính năng mới.

| Phiên | Trạng thái | SHA cuối | Migration | Ghi chú |
| --- | --- | --- | ---: | --- |
| **SESSION_1** | **READY** | `586205e` | 2 (`0038`, `0043`) | Toàn bộ đã lên `main`. 0 tệp chưa commit. |
| SESSION_2 | **WAITING** | — | — | Chưa nộp biên bản. |
| **SESSION_3** | **READY** | `2bf8cdb` | 0 | Biên bản: `docs/session-3-handoff.md`. Cổng checkout sạch: PASS. 0 tệp chưa commit. |
| SESSION_4 | **WAITING** | — | — | Chưa nộp biên bản. Nhiều khả năng là phiên **P0 HIỆU NĂNG** — Session 3 ghi nhận họ đang giữ `app-sidebar.tsx`, `db/schema.ts`, `drizzle/meta/_journal.json`, `lib/cache.ts`, `db/index.ts`, `lib/perf/*`, `components/nav-progress.tsx`, `lib/constants/action-queue.ts`, `app/(dashboard)/alerts/*`. Trên đĩa đã thấy `docs/erp-performance-p0-report.md` và `docs/perf/` chưa commit. |

**Điều kiện phát hành: cả bốn dòng phải READY.** Hiện 2/4.

---

## 0. Một sự thật phải nói trước, vì nó đổi cách gộp nhánh

**Bốn phiên KHÔNG làm trên bốn nhánh riêng.** Cả bốn dùng chung một cây làm việc và commit thẳng
vào `main` (đúng quy ước `AGENTS.md` §6). Hệ quả cho kế hoạch tích hợp:

- **Không có `branch` và `final commit SHA` riêng để fetch/cherry-pick.** Việc của Session 2–4 đã
  nằm xen kẽ trong lịch sử tuyến tính của `main` rồi.
- Bước "merge/cherry-pick có kiểm soát" **không áp dụng** như hình dung ban đầu. Cái thay thế nó là:
  chọn **một SHA duy nhất trên `main`** làm bản ứng cử, dựng worktree sạch từ đúng SHA đó, chạy trọn
  cổng ra, rồi deploy đúng SHA đã kiểm.
- Rủi ro thật của mô hình này **không phải** xung đột gộp nhánh, mà là **commit dở dang**: một phiên
  commit phần giao diện trước phần lõi, và `main` đỏ trong khoảng giữa. Chuyện này đã xảy ra hai lần
  hôm nay (mục 4).

**Chữ ký git không phân biệt được phiên.** Cả bốn cùng `hkt77 <truyenhk@vnxcommerce.com>`. Danh sách
commit dưới đây quy theo **nội dung công việc**, không phải theo siêu dữ liệu git — không có cách nào
chứng minh quyền tác giả từ kho mã, và tôi không giả vờ là có.

---

## 1. SESSION_1 — phạm vi đã đóng băng

### 1.1 Commit (27, đã lên `main`, cũ → mới)

| SHA | Nội dung |
| --- | --- |
| `1081fb3` | Nút tắt cảnh báo thật sự có tác dụng (zod nuốt mất cờ bật/tắt) |
| `b4aa78e` | Hàng hoàn chờ kiểm đếm không làm ngập hàng đợi việc (chặn 445 việc cùng lúc) |
| `72d562f` | ops `kpi-snapshot` — chụp KPI đối chiếu trước/sau deploy |
| `a47419d` | Độ phủ quy kết thấp thì KHÔNG kết luận chiến dịch lỗ/lãi |
| `8f7317e` | ops `profit-verify` — kiểm chứng Báo cáo lợi nhuận trên dữ liệu thật |
| `8ecf720` | Đơn đã huỷ mà hàng vẫn đang đi ⇒ loại việc riêng, hạn 6 giờ |
| `676465a` | Nói rõ hai tỷ lệ quảng cáo lệch nhau thế nào ở kỳ đang chạy |
| `105d063` | Kiểm thử chặn trùng số hiệu migration giữa hai phiên song song |
| `67d1e7b` | Gỡ tệp kiểm thử của phiên khác bị cuốn nhầm vào commit |
| `cc9ac90` | Đường nối xác định `orders.post_id` → chiến dịch (P0.1) |
| `e4189d4` | Lượt quét tự kết thúc: mẩu quảng cáo đã lưu cũng được điền mối nối |
| `893b023` | Trần thật của độ phủ quy kết là 82%, không phải 100% |
| `c99c4ce` | Vòng đời hàng hoàn (bước đầu) |
| `06cb68c` | Giảm nhiễu hàng đợi việc bằng vòng đời xác định |
| `d4687fc` | Chi phí thiếu kỳ phân bổ (P0.5) |
| `87fddbe` | Tách dòng tiền khỏi lợi nhuận — trang Dòng tiền & vốn lưu động |
| `de3ec1e` | Khoá ranh giới "lớp tư vấn chỉ đọc" ở mức mã nguồn |
| `22cf278` | Migration 0038 bị bỏ qua vĩnh viễn trên production — sửa mốc, chặn tái diễn |
| `2ac5554` | Hai bên quy về cùng một khoá bài viết |
| `2b6a036` | Đo thật độ phủ sau khi nối — 46,2% |
| `3a963a2` | Tổng kết kèm ba lỗi tự phát hiện sau deploy |
| `4f86104` | **Một chỗ duy nhất chuẩn hoá danh tính quảng cáo** + kiểm thử định dạng production |
| `716276b` | Phân nhóm A/B/C và bác bỏ giả thuyết tách theo kỳ |
| `c924b38` | Gỡ dòng đăng ký trỏ tới tệp kiểm thử chưa vào kho |
| `c725878` | **Hàng hoàn chỉ vào tồn khi có người đếm** (Phase A) |
| `4e635db` | **Mỗi việc thuộc về một bộ phận** + smoke test không tự hết hạn |
| `a625456` | Cập nhật báo cáo tổng kết |

### 1.2 Tệp thuộc Session 1

**Thêm mới**

```
lib/constants/ads-identity.ts          lib/returns/inspection.ts
lib/constants/returns-condition.ts     lib/queries/ads-attribution-link.ts
lib/queries/cashflow.ts                app/(dashboard)/reports/cashflow/page.tsx
app/(dashboard)/inventory/returns/page.tsx
app/(dashboard)/inventory/returns/inspection-row.tsx
scripts/kpi-snapshot.ts                scripts/profit-verify.ts
drizzle/0038_fb_ads_post_link.sql      drizzle/0043_return_inspections.sql
tests/ads-identity.test.ts             tests/ads-attribution-link.test.ts
tests/migration-journal.test.ts        tests/advisory-safety.test.ts
tests/cashflow.test.ts                 tests/return-inspection.test.ts
tests/alert-config.test.ts             docs/claude-final-erp-report.md
docs/release-integration-status.md
```

**Sửa** — `db/schema.ts` (`fb_ads.post_id/story_id`, bảng `return_inspections`) ·
`drizzle/meta/_journal.json` · `lib/returns/warehouse.ts` · `lib/actions/returns-warehouse.ts` ·
`lib/alerts/rules.ts` · `lib/alerts/config.ts` · `lib/constants/action-queue.ts` ·
`lib/queries/action-queue.ts` · `lib/queries/ads-attribution.ts` · `lib/queries/ads-roas.ts` ·
`lib/integrations/facebook/client.ts` · `lib/integrations/facebook/ads-index.ts` ·
`lib/actions/expenses.ts` · `lib/validation/expenses.ts` · `lib/constants/audit.ts` ·
`scripts/smoke.ts` · `components/app-sidebar.tsx` · `app/(dashboard)/alerts/page.tsx` ·
`app/(dashboard)/alerts/queue-filters.tsx` · `app/(dashboard)/data-quality/receive-returns.tsx` ·
`app/(dashboard)/expenses/*` · `.github/workflows/ops-vps.yml`

### 1.3 Migration thêm bởi Session 1

| Tệp | idx sổ | Mốc | Nội dung |
| --- | ---: | ---: | --- |
| `drizzle/0038_fb_ads_post_link.sql` | 40 | 1788839391150 | `fb_ads.post_id`, `fb_ads.story_id`, `fb_ads_post_idx` |
| `drizzle/0043_return_inspections.sql` | 43 | 1788839392150 | bảng `return_inspections` + 5 ràng buộc CHECK |

**Chi tiết quan trọng khi gộp:** mốc của `0043` cố ý đặt **ngay sau `0038`**, tức là **sớm hơn**
`0041`/`0042` của phiên khác, dù số hiệu lớn hơn. Lý do: drizzle chỉ áp migration có mốc **muộn hơn**
migration cuối đã áp. Nếu `0043` mang mốc muộn nhất mà lên production trước, `0041`/`0042` sẽ bị **bỏ
qua vĩnh viễn**. Thứ tự hiện tại an toàn cho mọi thứ tự deploy.

`tests/migration-journal.test.ts` khoá ba bất biến: mọi mục có tệp · mọi tệp có mục · **mốc TĂNG
NGHIÊM NGẶT**. Số hiệu trùng cho phép tối đa 1 (ca lịch sử idx 32), không được tăng thêm.

### 1.4 Kiểm thử thêm bởi Session 1

`ads-identity` (8 ca định dạng production thật) · `ads-attribution-link` · `migration-journal` ·
`advisory-safety` (14 module chỉ-đọc) · `cashflow` · `alert-config` · `return-inspection` (8 luật).
Cập nhật assertion: `inventory` · `data-quality` · `action-queue` · `sync-fixtures`.

### 1.5 Luật nghiệp vụ Session 1 đã thay đổi

1. **Hàng hoàn không vào tồn khi "nhận", chỉ vào tồn khi "đếm".** Trước: nút *Kho đã nhận* tự lập
   phiếu tái nhập bằng **đúng số đã xuất** — bấm hàng loạt là ERP tự khẳng định "về đủ" cho hàng
   trăm kiện chưa ai mở ra. Nay: `ĐÃ VỀ KHO → CHỜ ĐẾM → ĐÃ KIỂM`, và `recordInspection` là nơi **duy
   nhất** cộng tồn, theo số đếm được. Đếm lần hai bị chặn; đã đếm thì không huỷ ngược — sửa tồn phải
   qua phiếu điều chỉnh. Không mâu thuẫn `ORDER_OUTCOME`: đây là chiều **tồn kho**, không phải chiều
   tiền.
2. **Không kết luận chiến dịch lỗ/lãi khi độ phủ quy kết dưới ngưỡng** (`minAttributionToJudgeProfit`
   = 80). Trước đó 26 cảnh báo "chiến dịch lỗ" là giả: chi phí tính 100% còn doanh thu chỉ quy được
   45,9%.
3. **Một chỗ duy nhất chuẩn hoá danh tính quảng cáo** (`lib/constants/ads-identity.ts`). Bài viết bị
   **nhiều chiến dịch** cùng chạy thì **giữ nhập nhằng**, không chọn bừa.
4. **Mỗi loại việc trong hàng đợi thuộc đúng một bộ phận**, không có nhóm "chưa phân loại".
5. **Đơn đã huỷ mà hàng vẫn đang đi** là loại việc riêng, hạn 6 giờ.
6. `NULL`/chưa biết vẫn là chưa biết ở mọi thay đổi trên — không có chỗ nào đổi thành 0.

### 1.6 Đã đẩy lên `main` / còn chưa commit

- **Đã đẩy:** toàn bộ 27 commit ở mục 1.1.
- **Chưa commit: KHÔNG CÓ.** `git status` trên toàn bộ đường dẫn thuộc Session 1 trả về rỗng
  (kiểm 09/09/2026 sau khi đóng băng).
- Cây làm việc chung vẫn còn nhiều tệp `M`/`??` — **tất cả thuộc phiên khác**, không đụng tới.

---

## 1b. SESSION_3 — đã nhận biên bản

Nguồn: `docs/session-3-handoff.md` (commit `f91cb50`, khôi phục lại sau sự cố ở mục 4).

- `SESSION_3_STATUS = READY_FOR_INTEGRATION` · `FINAL_SESSION3_COMMIT = 2bf8cdb` · **0 migration** ·
  **0 tệp chưa commit** · cổng checkout sạch **PASS**.
- 11 commit: nhận diện VNXcommerce · Mua hàng & xưởng · Giữ chân khách · Mô phỏng kịch bản · khoá
  quyền 13 đường API · `scripts/final-gate.ts` · ba lần vá `main` đỏ do commit lẫn tệp.
- Nợ lại: **3 trang mới chưa có trong menu** (`app-sidebar.tsx`) — họ cố ý không sửa vì tệp đó đang
  do phiên hiệu năng giữ.
- Họ chủ động **không** làm Phase A vì phải chạm `db/schema.ts` + sổ migration của phiên khác. Phần
  Phase A hàng hoàn **đã do Session 1 làm xong** (`0043`), nên khi gộp cần đối chiếu thiết kế schema
  ở mục I biên bản của họ với bảng `return_inspections` đã có, **tránh dựng bảng thứ hai cho cùng
  một việc**.

⚠️ **Một điểm trong biên bản Session 3 đã lỗi thời:** mục L của họ ghi *"tách bài viết ra từng chiến
dịch riêng sẽ đưa độ phủ lên ~78% và mở khoá Phase E"*. Chủ shop đã bác điều này (xem mục 5). Ngưỡng
chặn SCALE/CUT vẫn đúng và phải giữ; chỉ có lối thoát đề xuất là sai.

⚠️ **Rủi ro #2 của họ cần Coordinator gánh:** số liệu Session 3 chưa đối chiếu trên production (họ
không có quyền `db-query`). Sau deploy phải so: tiền cam kết xưởng · số lô quá hạn · tỷ lệ mua lại.

---

## 2. Bản ứng cử phát hành hiện tại

**SHA: `21b643f`** (`origin/main` lúc kiểm) — *fix(deploy): bản được kiểm phải đúng là bản được
triển khai, và smoke test thôi báo lỗi giả*.

Đã dựng **worktree riêng** (`git worktree add --detach`), **không dùng cây làm việc chung**, và chạy:

| Cổng | Kết quả |
| --- | --- |
| `tsc --noEmit` | **SẠCH** |
| `eslint` | **SẠCH**, 0 cảnh báo |
| Toàn bộ kiểm thử | **TẤT CẢ KIỂM THỬ ĐẠT** |
| `next build` | **thành công** |
| Toàn vẹn sổ migration | đạt (nằm trong bộ kiểm thử) |

Ba lỗi chặn ghi nhận trước đó — `countOpenNotifications` chưa export, `@/components/nav-progress`
chưa vào kho, `metric-shape-consistency.test` chưa vào kho — **đã được phiên khác vá xong** ở
`5879b60` → `d0af22c`. **Hiện không còn blocker kỹ thuật nào trên `main`.**

⚠️ Điều này **không** có nghĩa là được deploy. Ba phiên còn lại chưa báo hoàn tất; commit tiếp theo
của họ có thể lại đưa `main` vào trạng thái dở dang. Bản ứng cử phải được **chốt lại và kiểm lại**
đúng lúc cả bốn phiên đã xong.

---

## 3. Kế hoạch tích hợp phát hành

### 3.1 Thu thập từ Session 2, 3, 4

Vì cả bốn cùng commit vào `main`, thứ cần thu thập **không phải** branch mà là:

1. **SHA cuối cùng** của phiên đó (commit cuối họ tạo);
2. danh sách tệp;
3. migration đã thêm (tên tệp, idx, **mốc `when`**);
4. kiểm thử đã thêm;
5. luật nghiệp vụ đã đổi;
6. blocker đã biết;
7. **xác nhận `git status` sạch cho phạm vi của họ** — đây là điều kiện bắt buộc, vì lỗi hay gặp
   nhất hôm nay là commit thiếu tệp chứ không phải xung đột nội dung.

### 3.2 Chốt bản ứng cử

1. `git fetch origin main`; chọn SHA cuối cùng sau khi cả bốn phiên báo xong.
2. `git worktree add --detach <thư mục sạch> <SHA>` — **bắt buộc là worktree, không phải
   `git archive`**: `tests/migration-journal.test.ts` gọi `git ls-files`/`git show HEAD:` nên bản
   sao không có `.git` sẽ làm cả bộ kiểm thử đổ với `fatal: not a git repository`.
3. Cài phụ thuộc sạch trong worktree đó.

### 3.3 Kiểm tra trước khi chạy cổng

- **Import mồ côi:** `tsc` bắt hết trường hợp tệp được tham chiếu mà chưa vào kho.
- **Sổ migration:** mọi tệp có mục, mọi mục có tệp, **mốc tăng nghiêm ngặt**, không thêm số hiệu
  trùng. Có kiểm thử tự động.
- **Cài đặt trùng lặp:** soi riêng bốn vùng bốn phiên cùng chạm — `db/schema.ts`,
  `drizzle/meta/_journal.json`, `lib/queries/action-queue.ts`, `lib/alerts/rules.ts`,
  `components/app-sidebar.tsx`.
- **Xung đột luật:** giải theo bất biến nghiệp vụ, **không chọn `ours`/`theirs` mù**. Thứ tự ưu tiên:
  `docs/business-rules/ORDER_OUTCOME.md` → `AGENTS.md` §0/§3 → `tests/contract-order-outcome.test.ts`.
  Contract test đỏ nghĩa là **mã sai**, không phải test sai.

### 3.4 Cổng ra (chạy trong worktree sạch, không phải cây chung)

`install` → `tsc --noEmit` → `eslint` → toàn bộ kiểm thử → `next build` → chạy thử migration →
bất biến nghiệp vụ → nhất quán chỉ số → Chất lượng dữ liệu → đo hiệu năng.

**Chỉ khi tất cả đạt mới được deploy.**

### 3.5 Deploy và xác minh

- Deploy **đúng SHA đã kiểm**, không phải `main` mới nhất lúc bấm.
- Sau deploy: `/api/health` phải trả về commit **trùng khít SHA đã kiểm**.
- `kpi-snapshot` trước/sau: **sáu con số kết quả đơn và ba con số tiền phải giữ nguyên**, trừ phần
  thay đổi thật của gói hàng trong khoảng thời gian đó.
- Smoke test: nay ký lại phiên trước từng trang, nên `307` từ đây có nghĩa là **vấn đề quyền**, không
  còn là hết hạn phiên.

---

## 4. Blocker và rủi ro đang theo dõi

| # | Việc | Trạng thái |
| --- | --- | --- |
| 1 | 3 lỗi chặn checkout sạch (`countOpenNotifications`, `nav-progress`, `metric-shape-consistency`) | **ĐÃ HẾT** tại `21b643f` |
| 2 | Session 2, 3, 4 chưa báo hoàn tất | **ĐANG CHỜ** — chưa được deploy |
| 3 | Cây làm việc và chỉ mục git dùng chung | **RỦI RO CÒN NGUYÊN**: một phiên `git add`/`git commit` có thể cuốn theo tệp dở của phiên khác, hoặc commit từ chỉ mục cũ làm mất thay đổi vừa vào. Đã xảy ra 4 lần hôm nay. Giảm thiểu: chỉ commit theo đường dẫn tường minh, và kiểm checkout sạch trước mỗi lần deploy. |
| 4 | Bài kiểm thử sổ migration cần bản sao có `.git` | **ĐÃ BIẾT** — dùng `git worktree`, không dùng `git archive` |
| 5 | Deploy `34334451645` báo thất bại | **KHÔNG PHẢI LỖI ỨNG DỤNG** — phiếu smoke hết hạn giữa chừng; bản vá đã áp thật, `fb_ads.post_id` có mặt trên production |
| 6 | **`git reset` trên cây chung làm văng 2 commit** | **ĐÃ KHÔI PHỤC** — xem mục 4b |
| 7 | **Cây làm việc đang LẠC HẬU so với `main` ở 6 tệp** | **CẦN CHỦ SỞ HỮU XỬ LÝ — tôi cố ý không đụng** — xem mục 4c |

### 4c. Cây làm việc lạc hậu so với `main` — 6 tệp

Lệnh `reset` ở mục 4b chỉ dời con trỏ, **không cập nhật tệp trên đĩa**. Nên mọi thay đổi mà `21b643f`
và `ddf63cd` mang vào đều CÓ trong `main` nhưng **KHÔNG có trên đĩa**:

```
 M .github/workflows/deploy-vps.yml     M AGENTS.md
 M scripts/bootstrap.sh                 M scripts/smoke.ts
 D docs/safe-release-review.md          D tests/repo-integrity.test.ts
```

Không ai xoá gì cả — đây là bản cũ nằm lại. Nhưng hậu quả thì thật:

1. **Ai chạy `git commit -a` sẽ ÂM THẦM lùi cả 6 tệp**, xoá `docs/safe-release-review.md` và
   `tests/repo-integrity.test.ts` khỏi kho, và huỷ bản phân loại kết quả smoke của `21b643f`.
2. Chạy kiểm thử tại máy sẽ khác kết quả chạy trên `main`, vì `tests/repo-integrity.test.ts` không có
   trên đĩa.

**Cách xử lý đúng:** `git checkout -- <6 đường dẫn>` để đồng bộ đĩa với `main`. Tôi **không tự làm**
vì cả 6 thuộc phiên khác và ràng buộc của đợt này là không `checkout` tệp của phiên khác. Phiên sở
hữu (hoặc chủ shop) chạy lệnh đó là xong.

**Không ảnh hưởng bản ứng cử:** mọi cổng ra đều chạy trên worktree sạch dựng từ SHA, không đọc đĩa
của cây chung.

### 4b. Sự cố mất commit trên cây làm việc dùng chung (09/09/2026)

Đang làm việc thì `HEAD` nhảy về `origin/main` do một phiên khác chạy `reset`. Reflog:

```
ddf63cd HEAD@{0}: reset: moving to origin/main
1d4913f HEAD@{1}: commit: docs: biên bản bàn giao Session 3 ...
e415bf9 HEAD@{3}: commit: docs: đóng băng phạm vi Session 1 ...
```

**Hai commit rơi khỏi `main`**: biên bản bàn giao của Session 3 và bản đóng băng phạm vi của Session 1.
Nội dung tệp vẫn còn trên đĩa (reset không phải `--hard`), nên đã khôi phục bằng cách commit lại đúng
các đường dẫn đó, **giữ nguyên nội dung và thông điệp gốc** — `f91cb50` (Session 3) và `586205e`
(Session 1). Không rewrite history, không đụng tệp của ai.

**Bài học cho phần còn lại của đợt phát hành:** `git reset` / `git pull` trên cây dùng chung có thể
làm biến mất commit vừa tạo của phiên khác **mà không báo lỗi gì**. Trước mỗi lần chốt bản ứng cử,
phải đối chiếu `git log` với danh sách SHA trong biên bản của từng phiên — SHA nào không còn là tổ
tiên của `HEAD` thì đã bị rơi và phải khôi phục.

---

## 5. Đính chính do chủ shop nêu — độ phủ quy kết quảng cáo

Báo cáo trước ghi: *"nếu mỗi bài chỉ chạy trong MỘT chiến dịch thì 46,2% → khoảng 78%"*.

**Khuyến nghị đó KHÔNG dùng được.** Chủ shop nêu rõ nghiệp vụ marketing là scale theo tầng: một bài
viết được nhân lên nhiều quảng cáo, nhiều nhóm quảng cáo, nhiều chiến dịch, nhiều tài khoản — và
ngược lại một tài khoản có nhiều chiến dịch, một chiến dịch nhiều nhóm, một nhóm nhiều quảng cáo.
Quan hệ bài ↔ chiến dịch là **nhiều–nhiều theo thiết kế**, không phải do đặt sai.

Hệ quả cần ghi nhận thẳng:

- **Trần thật của quy kết theo bài viết ở cấp chiến dịch là ~49%**, không phải 78%. 539 đơn thuộc
  nhóm nhập nhằng sẽ **không bao giờ** tự phân giải được bằng dữ liệu hiện có.
- Muốn tăng độ phủ mà **không bịa số** thì phải có mã theo dõi riêng cho từng mẩu quảng cáo
  (`ref`/`utm` gắn vào liên kết hoặc kịch bản tin nhắn) để đơn mang được `ad_id` thật — đó là thay
  đổi cách chạy quảng cáo, cần chủ shop quyết, **không phải việc phần mềm tự làm được**.
- Cho tới lúc đó, mọi kết luận lỗ/lãi ở cấp chiến dịch phải tiếp tục bị chặn bởi ngưỡng độ phủ, và
  phần dưới ngưỡng phải trả về `DATA_INSUFFICIENT` thay vì một con số trông có vẻ chắc chắn.

Mục F của `docs/claude-final-erp-report.md` đã được sửa theo đính chính này.
