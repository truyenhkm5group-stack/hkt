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
- **P1.2 → P1.6** Chờ quyết định ở mục 3.
- **R2 không bao giờ mở cho agent.** Giữ nguyên.
