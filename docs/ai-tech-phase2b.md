# Phase 2B — Nối ba sợi dây đang hở, và đặt một quyết định lên bàn chủ shop

Ngày 20/09/2026 · Nhánh `claude/charming-turing-kao6lw` · **Không migration** (dùng lại lược đồ đã có)

Phase 2A dựng đủ bộ phận nhưng để hở ba chỗ nối. Lượt này nối chúng lại bằng mã đã có sẵn, không
mở thêm một quyền nào và không đụng tới lược đồ CSDL.

---

## 1. Ba chỗ hở đã đo được ngày 20/09/2026

| # | Chỗ hở | Đo được | Hậu quả thật |
|---|---|---|---|
| 1 | `github-deployments` không có lịch | Dòng mới nhất trong `tech_deployments` là 12:11 hôm trước, GitHub đã có thêm **12 lượt deploy** sau đó | `/tech/deployments` in "LỆCH — container có thể chưa khởi động lại" → **báo động giả**. Nguyên nhân thật là sổ cũ 14 giờ |
| 2 | Chín ô `pr_*` của `tech_tasks` (migration `0104`) chết | `grep` toàn kho: **không dòng mã nào** ghi hay đọc chúng ngoài `db/schema.ts` | Muốn biết một việc Tech đang nằm ở đâu thì phải mở GitHub |
| 3 | Không có đường `sync_runs` FAILED → `tech_incidents` | **0 sự cố đang mở**, cùng lúc `facebook-ads` hỏng lặp lại nhiều giờ | "0 sự cố" đo TRÍ NHỚ của người trực, không đo hệ thống |

Thêm một quả bom hẹn giờ cùng loại: `reapStaleRuns()` có hàm, không có lịch. Cổng "không hai lượt
song song" đọc chính `tech_agent_runs`, nên **một** tiến trình chết giữa chừng khoá vĩnh viễn mọi
lượt chạy sau trên cùng việc — im lặng, cho tới khi có người biết là phải gọi tay.

---

## 2. Đã làm gì

### 2.1 Bốn job vào bộ lập lịch

| Job | Nhịp | Biến môi trường | Vì sao nhịp đó |
|---|---|---|---|
| `github-deployments` | 15 phút | `GITHUB_DEPLOY_SYNC_EVERY_MINUTES` | Chọn theo HẠN MỨC: gọi ẩn danh được 60 request/giờ theo IP; 4 lượt/giờ chiếm 1/15 và còn chỗ cho người bấm tay |
| `github-pr-sync` | 15 phút | `GITHUB_PR_SYNC_EVERY_MINUTES` | Phục vụ một màn hình quản lý, không phục vụ một cái cổng. Ai cần biết CI vừa đỏ trong một phút thì đọc GitHub |
| `agent-reaper` | 15 phút | `AGENT_REAPER_EVERY_MINUTES` | Ngưỡng 45 phút ⇒ một lượt chạy phải im lặng qua **ba** nhịp tim trước khi bị đóng |
| `tech-incident-watch` | 30 phút | `TECH_INCIDENT_WATCH_EVERY_MINUTES` | Nhịp KHÔNG quyết định độ nhạy — ngưỡng là ba lượt hỏng liên tiếp của chính job kia |

`tests/scheduler-coverage.test.ts` được siết thêm một vế: **một dòng miễn trừ "chạy tay" không được
tồn tại cho job đang có lịch.** Dòng miễn trừ của `github-deployments` đã sống sót qua đúng cái
ngày lý do của nó hết hiệu lực; bài kiểm nay bắt nó đi theo.

### 2.2 Phép chiếu Pull Request (`github-pr-sync`)

Chín ô của migration `0104` nay có đầu đọc: `lib/integrations/github/pull-requests.ts`.

**Nối bằng khoá, không bằng ô chữ.** Hai khoá, đúng thứ tự: `tech_tasks.pr_number` đã biết, rồi
`tech_tasks.branch` **bằng đúng** `head.ref` của PR. **Không có đường thứ ba** — dò mã việc trong
tiêu đề PR là phép đoán, và một PR ghi "nối tiếp TECH-7" sẽ bị nhận là PR của TECH-7. Sai ở đây
không dừng ở một dòng hiển thị: cổng deploy tương lai đọc chính bốn cột này.

**Bốn chiều, không gộp** — vì mỗi chiều sửa ở một chỗ khác hẳn:

| Chiều | Câu hỏi | Sửa bằng cách |
|---|---|---|
| `pr_state` | PR còn mở hay đã đóng/gộp | Mở lại, hoặc mở PR mới |
| `ci_state` | Cổng `gates` xanh hay đỏ | Sửa **mã** rồi đẩy lại |
| `review_state` | Có ai duyệt chưa | Đi tìm **người** |
| `merge_state` | Có xung đột với `main` không | Gộp `main` vào nhánh |

Ba cái bẫy đã ghim bằng bài kiểm:

1. **Mảng check rỗng.** `[].every(...)` trả `true`, nên bản viết tự nhiên kết luận "mọi check đều
   xanh" cho một PR mà cổng `gates` còn chưa khởi động. Không có check nào ⇒ **CHƯA BIẾT**.
2. **`mergeable = null`** là GitHub *còn đang tính*, không phải một câu trả lời. Ép thành
   `MERGEABLE` là mời người bấm gộp một nhánh có thể xung đột; ép thành `CONFLICT` là gửi người đi
   gỡ một xung đột không tồn tại.
3. **Review cũ.** GitHub giữ nguyên mọi review, nên đếm gộp cả lịch sử sẽ báo "đã duyệt" cho một PR
   mà người ấy sau đó đã yêu cầu sửa. Chỉ **lượt cuối của mỗi người** được tính, và `DISMISSED` xoá
   lập trường cũ (ruleset của kho này huỷ duyệt khi có push mới).

Hai điều job này **không** làm: không đổi trạng thái việc (PR đã gộp ≠ việc đã xong — việc còn phải
lên production và được xác minh), và không chạm `tech_tasks.updated_at` (một job 15 phút/lần chạm
vào nó sẽ đẩy mọi việc có nhánh lên đầu `/tech/tasks` mãi mãi). Mốc của phép chiếu nằm ở
`pr_synced_at`, và đó là mốc **ĐỌC**, ghi cả ở lượt không đổi gì.

PR đang mở mà không việc nào nhận được **đếm riêng** (`unmatchedOpenPulls`) và in ra — hàng đợi Tech
sạch bong trong khi GitHub có bốn PR treo là một câu trả lời sai.

### 2.3 Sự cố tự mở (`tech-incident-watch`)

`lib/constants/sync-incidents.ts` (thuần) + `lib/tech/sync-incident-watch.ts` (ghi).

- **Một lượt hỏng không phải một sự cố.** Ngưỡng là **ba lượt hỏng LIÊN TIẾP** trong 24 giờ. Mạng
  chập, Pancake 429, GitHub hết hạn mức — mỗi thứ đó tự khỏi ở lượt sau.
- `RUNNING` **không** cắt chuỗi và cũng **không** nối dài nó (chưa phán quyết gì). `PARTIAL` thì
  **cắt**: job có chạy và có làm được việc.
- **Mốc phát hiện = lượt hỏng ĐẦU chuỗi**, không phải lúc bộ quét chạy. Lấy `now()` là làm mọi phép
  đo "bao lâu mới phát hiện ra" bằng 0 — một con số đẹp cho thứ chưa từng được đo.
- **Chỉ MỞ, không bao giờ tự đóng.** Job chạy lại được không chứng minh sự cố đã hết, và ràng buộc
  `tech_incidents_resolved_check` đòi một câu *đã làm gì để nó hết* — máy không có câu đó, nên tự
  đóng nghĩa là bịa. Chi phí hữu hạn: nhiều nhất **một sự cố chưa đóng cho mỗi job**.
- **Mọi sự cố tự mở đều SEV2**, và đó là lựa chọn. Máy đo được job có chạy hay không; nó không đo
  được hậu quả kinh doanh. `facebook-ads` hỏng ba tiếng là SEV3 với shop không chạy quảng cáo và
  SEV1 với shop đang tiêu tiền theo giờ.
- **Khoá chống trùng là TIÊU ĐỀ** (không có cột khoá riêng, và thêm cột là một migration trong lúc
  nhiều phiên đang cùng sinh migration — AGENTS.md mục 9). Hệ quả phải biết trước: **đổi công thức
  tiêu đề = mở lại một sự cố cho mọi job đang hỏng.** `tests/tech-pr-projection.test.ts` ghim
  nguyên chuỗi đầu ra, nên đổi nó là hành động có chủ ý với một bài kiểm đỏ.

### 2.4 Độ tươi của sổ deploy là một VẾ của phép kết luận

Lên lịch cho job đọc làm chỗ hụt hiếm đi, **không xoá được nó**: job có thể chết, GitHub có thể
khoá hạn mức, máy chủ có thể vừa khởi động lại. Nên `/tech/deployments` nay không được phép kết
luận "LỆCH" trên một sổ đã cũ: quá `DEPLOY_LEDGER_STALE_MINUTES` (45 phút = ba nhịp) thì màn hình
in **"CHƯA KẾT LUẬN ĐƯỢC"** kèm mốc đọc gần nhất và việc phải làm, thay vì gửi người đi khởi động
lại một container không hỏng.

Ba câu trả lời vì ba cách sửa: `NEVER` (bấm "Đọc lại từ GitHub") · `STALE` (đi xem bộ lập lịch) ·
`FRESH` (lúc này mới được kết luận LỆCH).

### 2.5 B5 — `facebook-ads` hỏng lặp lại: tìm ra nguyên nhân gốc

Audit ghi câu lệnh hỏng là `update "ad_spends" ... returning "id"`. Trong toàn kho mã, **đúng một
hàm** chạy câu đó: `reapplyAdsMapping()`. Ba mắt xích, cả ba đọc được từ mã nguồn:

1. `ad_spends.product_id` có **khoá ngoại** tới `products.id`.
2. Giá trị ghi vào nó đến từ **`settings`** (`ads.campaignMap`, `ads.productAliases`) — chuỗi
   người lưu lúc ghép tay. Không gì ràng buộc chúng còn tồn tại trong `products`; sổ mã hàng đổi
   mà bảng ghép thì không đổi theo.
3. Hàm được gọi ở **cuối** `syncFacebookAds`, **ngoài mọi `try/catch`**.

⇒ Một dòng ghép trỏ vào mã hàng đã biến mất làm cả lượt đồng bộ ghi `FAILED` — **sau khi** toàn bộ
số liệu quảng cáo đã ghi xong. Và vì nguyên nhân là **tất định** (cùng bảng ghép, cùng dòng, cùng
cú ném), nó lặp lại mỗi lượt chạy, mãi mãi. Màn hình chỉ nói "FAILED", nên không ai phân biệt được
*đồng bộ hỏng* với *một bước dọn dẹp hỏng* — hai thứ sửa ở hai chỗ khác hẳn.

`tests/ads-mapping-dangling.test.ts` **chạy thật** câu lệnh cũ trên PGlite và khẳng định nó ném
lỗi khoá ngoại; không mô phỏng bằng lời. Nếu ngày nào đó nó không ném nữa (ai đó gỡ khoá ngoại)
thì bài kiểm đỏ — và đó đúng là lúc phải đọc lại cả tệp.

Ba lớp vá, **không lớp nào đụng vào một con số**:

| Lớp | Chặn cái gì |
|---|---|
| Đường ghi (`lib/actions/ads-mapping.ts`) | Mã hàng không có trong sổ thì **không lưu** vào bảng ghép. Chặn **nguyên nhân**, và người bấm biết ngay thay vì một job nền hỏng lúc 4 giờ sáng ba ngày sau |
| `reapplyAdsMapping()` | Dòng ghép trỏ vào mã đã biến mất thì **bỏ qua và nêu tên** — giữ nguyên dữ liệu cũ, **không** ghi `null` (ghi `null` là lặng lẽ gỡ chi phí quảng cáo khỏi một mã hàng, AGENTS.md mục 8.8). Mỗi chiến dịch có `try/catch` riêng nên một dòng hỏng không kéo theo 200 dòng còn lại |
| `syncFacebookAds` | Bước áp lại bảng ghép nay nằm **trong** `try` ⇒ ra `warning`, lượt chạy ghi `PARTIAL` kèm lý do đọc được. `PARTIAL` nói đúng sự thật: việc chính xong, một phần phụ chưa xong |

Dòng ghép treo hiện lên **ngay lúc người bấm** (toast cảnh báo ở trang Chi phí › Ghép chiến dịch)
và trong `sync_runs.detail`, nêu đích danh chiến dịch nào trỏ vào mã nào.

Liên quan tới mục 2.3: nếu không vá, bộ `tech-incident-watch` mới sẽ mở một sự cố SEV2 cho
`facebook-ads` mỗi 24 giờ — đúng, nhưng vô ích, vì nó báo về một bước dọn dẹp chứ không phải về
đường đồng bộ.

### 2.6 Phép chiếu PR khai độ tươi của chính nó

`/tech/tasks` in nguyên câu tóm tắt mà job `github-pr-sync` đã viết, kèm mốc đọc — trong đó có
**số PR đang mở mà không việc nào nhận**. Một hàng đợi sạch bong trong khi GitHub có bốn PR treo
là một câu trả lời sai. Chưa lượt đọc nào chạy thì màn hình nói rõ bốn cột PR trống vì **CHƯA
BIẾT**, không phải vì việc chưa có PR.

### 2.7 Năm lỗi do chính lượt này sinh ra, tìm thấy khi tự review

Một lượt review độc lập chạy trên toàn diff tìm ra năm chỗ. Cả năm đều thật, và **cái nặng nhất
là bản vá tự vô hiệu hoá chính nó**:

| # | Lỗi | Vì sao nó nguy hiểm | Đã sửa bằng |
|---|---|---|---|
| 1 | Độ tươi sổ deploy đọc từ `sync_runs`, coi `PARTIAL` là "đã đọc" | Mọi nhánh **bỏ qua** (hết hạn mức, lỗi mạng, token sai) đều đặt `warning` ⇒ lượt ghi `PARTIAL`. Nên một lượt **đọc được 0 dòng** vẫn làm sổ trông MỚI: sổ trông tươi nhất đúng lúc nó **chắc chắn** đứng im — đúng báo động giả mục 2.4 sinh ra để chặn | `lib/integrations/github/read-marker.ts`: mốc do **chính lượt đọc** ghi, sau khi GitHub đã trả dữ liệu. Không suy từ `status`, không bóc tách `detail` |
| 2 | `agent-reaper` đóng nhầm lượt chạy CÒN SỐNG | `heartbeat_at` chỉ ghi ở ba mốc thưa; bước agent suy nghĩ + sửa tệp nằm trọn giữa hai mốc và dễ vượt 45 phút. Bị đóng giữa chừng thì cổng chống song song **mở ra**, và khi tiến trình thật xong `finishTechAgentRun` thấy `status ≠ RUNNING` nên **vứt** commit SHA, kết quả bốn cổng và danh sách tệp đổi | Nhịp tim tự đập **mỗi phút** trong lúc bước dài chạy (`setInterval` + `unref`, dọn trong `finally`). Tỷ lệ 1:45 — phải lỡ 45 nhịp liên tiếp mới bị coi là chết |
| 3 | `github-pr-sync` không có trần lượt gọi | Xấu nhất 1 + 3×50 = **151 request/lượt** = 604/giờ ở nhịp 15 phút, trong khi đường gọi ẩn danh chỉ có **60/giờ**. Hết hạn mức thì `github-deployments` chết theo | Trần đi theo **chế độ gọi** (`prDetailBudget`): có token 12 PR/lượt ⇒ 148/giờ trên hạn mức 5.000; ẩn danh 3 PR/lượt ⇒ 40/giờ, cộng 4 của sổ deploy là 44, dưới 60. Việc quá trần **hoãn**, không cắt: thứ tự là *lâu chưa đọc nhất trước* nên nó **xoay vòng** |
| 4 | Vòng lặp nạp của `facebook-ads` vẫn ghi thẳng vào cột có khoá ngoại | Vá `reapplyAdsMapping` mà để hở đường kia thì lỗi quay lại nguyên vẹn — và ở đây nó còn **kết thúc sớm vòng lặp của cả tài khoản**, nên các dòng insight còn lại không bao giờ được ghi | Kiểm mã hàng trước khi ghi. Dòng **mới** để `product_id = NULL`; dòng **đã có** giữ nguyên bằng cách trỏ lại chính cột đó trong nhánh `DO UPDATE` |
| 5 | `unmatchedTasks` được in là "việc chưa mở PR" | Một PR **đã gộp từ lâu** cũng rơi khỏi cửa sổ 50 PR gần nhất ⇒ câu chữ nói **ngược** sự thật với đúng những việc đã xong | Câu chữ nói đúng chừng nó biết: *không thấy PR trong cửa sổ này*. Và việc `DONE` + PR đã `MERGED`/`CLOSED` không còn được đọc lại (GitHub không đổi trạng thái PR đã gộp nữa) |

### 2.8 Vòng review thứ hai — bốn lỗi nữa, do chính vòng sửa thứ nhất sinh ra

| # | Lỗi | Đã sửa bằng |
|---|---|---|
| 1 | **Bài kiểm "việc DONE thì thôi đọc lại" là MÃ CHẾT.** Nó gọi thẳng `NEW → DONE`, mà máy trạng thái không cho, nên lời gọi trả `{error}`, khẳng định nằm trong `if ("ok" in …)` **không bao giờ chạy** — xanh vĩnh viễn cho một hàng rào chưa từng được kiểm, trong khi tài liệu nói nó đã khoá | Đi đủ tám bước của máy trạng thái, `assert.ok` từng bước, bỏ hẳn cái `if` bọc ngoài |
| 2 | `lastPrSyncRun` mất bộ lọc trạng thái nên lấy cả lượt `RUNNING` (`detail` rỗng) | Bỏ `RUNNING`: suốt thời gian một lượt chạy diễn ra, `/tech/tasks` sẽ thay câu tóm tắt tốt cuối cùng bằng "không ghi tóm tắt" kèm một cảnh báo không có thật |
| 3 | Trần lượt gọi tính theo **lượt** trong khi hạn mức GitHub tính theo **giờ**: 37 × 4 lượt = 148/giờ, gấp hơn hai lần hạn mức 60/giờ mà chính chú thích ấy trích dẫn | Trần đi theo chế độ gọi (xem bảng trên). Bài kiểm ghim luôn phép tính theo giờ |
| 4 | Câu in ra nội suy **hằng số** thay vì trần **đã dùng**, và `budget` không tới được từ sổ job | Kết quả mang `budget` thực tế, màn hình in con số đó; `lib/sync/jobs.ts` chuyển tiếp `?budget=` |

### 2.9 Vòng review thứ ba — và bài học đắt nhất của cả lượt

| # | Lỗi | Đã sửa bằng |
|---|---|---|
| 1 | Vòng sửa thứ hai vá cỡ mẫu của bài kiểm trần nhưng **bỏ sót một khẳng định** vẫn so với hằng số 12. Máy người viết có `GITHUB_TOKEN` nên trần là 12 và bài xanh; `gates.yml` **không** đưa `GITHUB_TOKEN` vào `env:` của bước `npm test` (Actions không tự xuất biến đó) nên **CI chạy ẩn danh**, trần là 3, cỡ mẫu 6, và `6 > 12` **ĐỎ** — chặn merge và chặn deploy | So với trần THẬT (`tranThat`). Và từ nay `npm test` được chạy ở **cả hai chế độ** trước khi commit |
| 2 | `?budget=` chuyển tiếp mà **không có trần trên** | Một cú `github-pr-sync?budget=50` trên máy chủ chưa đặt token bắn 151 request, thổi bay hạn mức 60/giờ và kéo `github-deployments` chết theo — đúng chuỗi đổ vỡ cái trần sinh ra để chặn. Nay tham số tay bị **kẹp** về trần ẩn danh khi không có token; có token thì để người dùng tự quyết |

Vòng thứ tư tìm thêm hai chỗ, cả hai trong chính tệp kiểm thử: bài "chưa cấu hình kho" chỉ xoá
`ERP_GITHUB_REPO` trong khi `repo()` còn lùi sang `GITHUB_REPOSITORY` (Actions **luôn** đặt biến
này) — nó xanh hoàn toàn nhờ một bài KHÁC chạy trước đã xoá biến ấy và không trả lại, nên chạy
riêng hoặc đảo thứ tự là đỏ; và cái kẹp `?budget=` **không có bài kiểm nào**, xoá nó đi `npm test`
vẫn xanh.

**Bài học, và nó là thứ đáng giữ lại nhất của cả lượt:** bốn vòng review, bốn lần tìm thấy lỗi
thật, và **ba trong bốn** là cùng một hình dạng — *một bài kiểm đo môi trường của máy đang chạy
thay vì đo mã*. AGENTS.md mục 50 đã ghi luật này cho **mốc thời gian**; nó đúng y hệt cho **biến
môi trường**, và còn khó thấy hơn vì biến môi trường không tự đổi mỗi ngày — nó đổi khi bài chạy ở
một máy khác, tức đúng lúc nó chặn deploy.

Từ nay bộ cổng của việc này chạy `npm test` ở **cả hai chế độ** trước khi commit:

```
env -u GITHUB_TOKEN -u GH_TOKEN -u ERP_GITHUB_TOKEN -u GITHUB_REPOSITORY npm test   # như CI
GITHUB_REPOSITORY=owner/ci-repo GITHUB_TOKEN=dummy npm test                          # như máy có token
```

Mỗi lỗi có một bài kiểm khoá lại: mốc đọc **không được nhích** khi GitHub trả 403 hết hạn mức ·
trần hoãn rồi lượt sau đọc tiếp (chứng minh bằng việc số việc đã đọc **vượt** trần của một lượt) ·
việc `DONE` + PR `MERGED` tốn **0** lượt gọi · quét mã nguồn buộc vòng lặp nạp kiểm khoá ngoại và
buộc cảnh báo của nó nằm **ngoài** khối `try` của bước dọn dẹp.

---

## 3. QUYẾT ĐỊNH CẦN CHỦ SHOP — chỗ đứng của runner và sổ

**Đây là nút thắt duy nhất còn lại, và mọi việc P1 đều chờ nó.**

Hôm nay runner agent (`lib/agents/{runner,workspace,executor}.ts`) chỉ chạy được trong
`agent-run.yml` trên máy GitHub Actions, mà máy đó **không nối được PostgreSQL production** — nên
`tech_agent_runs` của nó ghi vào một PGlite dùng-một-lần rồi biến mất cùng máy ảo. Đo được:
`/tech/agents` hiện **12/12 vai "0 lượt chạy · Chưa từng chạy"**, và sẽ mãi như vậy kể cả khi agent
chạy thành công.

Đây là **nút thắt kiến trúc, không phải lỗi**. Ba phương án, và không phương án nào sai:

| | A · Runner tự quản trên VPS | B · Actions ghi sổ qua API nội bộ | C · Giữ hai sổ, chấp nhận `/tech` không thấy |
|---|---|---|---|
| Cách làm | Dựng self-hosted runner trên chính VPS, đọc thẳng Postgres | Runner vẫn ở Actions; sau mỗi bước gọi `POST /api/tech/agent-run` có `CRON_SECRET` | Không làm gì thêm |
| Sổ agent đầy đủ | Có | Có | Không |
| Bề mặt tấn công mới | **Lớn nhất**: một runner trên VPS chạy mã của nhánh, cạnh CSDL production | Một đầu ghi mới ra Internet, khoá bằng `CRON_SECRET` | Không có |
| Hàng rào sandbox hiện tại | Vẫn áp dụng, nhưng nó nay đứng cạnh CSDL thật | Nguyên vẹn — Actions vẫn cách ly | Nguyên vẹn |
| Việc phải làm | Cài runner, cách ly user, giới hạn mạng | Một route + xác thực + chống phát lại | 0 |
| Giá phải trả | Rủi ro bảo mật | Nhật ký lượt chạy có thể rơi nếu mạng hỏng giữa chừng | Không bao giờ biết agent đã làm gì |

Khuyến nghị: **B**. Nó giữ nguyên tính chất quan trọng nhất của thiết kế hiện tại — mã chưa ai
review **không bao giờ chạy cạnh CSDL production** — và đổi lại chỉ là một đầu ghi hẹp, chỉ nhận
đúng hình dạng của một dòng `tech_agent_runs`. Phương án A đảo ngược đúng cái hàng rào mà cả Phase
2A dựng lên.

**Chưa có quyết định thì P1.2 (ERP dispatch workflow) và P1.3 (worker hàng đợi) chưa nên bắt đầu** —
cả hai đều giả định sổ lượt chạy đọc được từ ERP.

---

## 4. Việc còn lại, theo thứ tự phụ thuộc

- **P0.3** Dọn 4 PR tồn (#38 sạch/0 review · #24 đã duyệt chưa gộp · #8 từ 18/09 · #2 từ 08/09, rác
  cũ 23 tệp) và chạy `probe_merge` của bộ chứng minh danh tính — ruleset đã lên 1 duyệt nên phép đo
  còn thiếu ấy nay chạy được. **Việc của người**: gộp và đóng PR là quyết định, không phải một lượt
  đồng bộ.
- **P0.4** Quyết định deploy `de8a449` hay giữ nguyên có chủ đích (production đang chạy `a535d4e`).
- **B5 · việc của người sau khi deploy**: mở trang Chi phí › Ghép chiến dịch và sửa những dòng ghép
  treo mà lượt đồng bộ đầu tiên nêu tên. Bản vá **giữ nguyên số cũ** chứ không tự chữa bảng ghép —
  chọn mã hàng nào thay thế là quyết định kinh doanh.
- **P1.2 → P1.6** Chờ quyết định ở mục 3.
- **R2 không bao giờ mở cho agent.** Giữ nguyên.
