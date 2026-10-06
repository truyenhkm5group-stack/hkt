# Điều phối V2 — một Tech Lead, một sổ chung, một đường giao hàng

*06/10/2026. Mở rộng AI Tech Room (`README.md` cùng thư mục, PR #592/#594) — KHÔNG phải hệ thống thứ
hai. Công cụ: `npm run ai -- …` (`scripts/ai-tech.ts`, mục 12–13). Sổ chung: nhánh `ai-control/registry`.
Kiểm thử: `tests/delivery-v2.test.ts` (trong `npm test`). Cửa vào của chủ shop: skill `/lead`.*

---

## Chủ shop: từ giờ mở đâu, giao việc thế nào

1. Mở **một** phiên Claude Code ở thư mục `Code ERP` (hay bất kỳ cây nào của kho).
2. Gõ `/lead` rồi nói việc bằng lời thường:
   - `/lead Thêm báo cáo hiệu quả AI Sales theo fanpage`
   - `/lead Tình hình các việc?` → bảng RUNNING · READY · BLOCKED · FAILED · DONE · **CẦN CHỦ SHOP**
   - `/lead Ưu tiên Logistics trước` · `/lead Dừng task Ads` · `/lead Deploy những việc đã an toàn`
3. Không cần nói nhánh, worktree, PR, số migration, thứ tự gộp hay deploy. Tech Lead chỉ quay lại hỏi
   khi cần ĐÚNG một việc của con người (9 lý do, mục 15) — và nói rõ việc đó là gì.

Phiên chết / VS Code đóng: mở phiên mới, gõ `/lead tình hình?` — mọi thứ đọc lại từ git + GitHub + sổ
chung, không từ trí nhớ của phiên cũ (mục 16).

---

## 1. Đã có gì, V2 thêm gì (dùng lại trước, dựng sau)

| Năng lực | Đã có (AI Tech Room) | V2 thêm |
|---|---|---|
| Lead chia việc thành DAG, worker mỗi người một cây | `lead · next · spawn · ready · cleanup` | — (giữ nguyên) |
| Phạm vi ghi + điểm nóng SERIAL | TRONG một sứ mệnh | XUYÊN sứ mệnh, xuyên phiên, xuyên máy (`claim`) |
| Trạng thái suy từ git | `status` của một sứ mệnh | `board`: mọi sứ mệnh + PR lạ + production + khoá |
| Chống trùng việc | — | `intake` (main · sứ mệnh · PR · nhánh) + phán quyết bắt buộc khi `claim` |
| Số migration | `migration:renumber` lúc tích hợp | giữ chỗ TRƯỚC khi viết (`migration reserve`) + job CI phát hiện va số giữa PR |
| Một người gộp / deploy | quy ước miệng (ghi nhớ "deploy một chủ") | khoá có hạn `integration-lead` trên sổ, phục hồi được |
| Thứ tự gộp | `ready` của một việc | `queue`: lô rủi ro thấp · HIGH đi riêng · phụ thuộc · va tệp |
| Deploy theo lô | — | `deploy-plan`: một lượt cho cả lô, không chồng, không khi main đỏ |
| Hậu kiểm | smoke trên VPS (trong deploy) | `verify`: SHA · số migration · lượt deploy · endpoint — DONE đòi nó |
| Đo | — | `metrics`: viết mã · lead time · CI · chờ deploy · deploy · tỷ lệ đỏ · trùng đã chặn |
| Cổng CI | 1 job nối đuôi 37′ | 4 job song song gom về **đúng** check `gates / gates` |
| Cổng của deploy | chạy lại 37′ | dùng lại lượt cổng xanh của **đúng SHA** trên main |

Không dịch vụ mới, không CSDL mới, không gói mới: một tệp TypeScript chỉ dùng thư viện chuẩn, git,
và GitHub Actions.

## 2. Một Tech Lead — luồng một yêu cầu

```
YÊU CẦU → chuẩn hoá (mục tiêu đo được + từ khoá + phạm vi đoán trước)
        → intake           EXISTS ⇒ dùng lại · IN_PROGRESS ⇒ phối hợp/chờ · PARTIAL ⇒ mở rộng · MISSING ⇒ dựng
        → claim            đăng ký TRƯỚC khi viết mã; chồng phạm vi ⇒ tuần tự hoá (--after) hoặc khai cách tích hợp
        → migration reserve (nếu cần)
        → làm: nhỏ = một cây một nhánh; lớn = `lead` + `/mission` (DAG, worker, ready)
        → PR → gates / gates
        → queue            (Integration Lead, cầm khoá) gộp lô
        → deploy-plan → MỘT lượt deploy → verify --record
        → close --status=DONE   (đòi: đã vào main + verify ĐẠT, hoặc --no-runtime)
```

Vai trò vẫn là trách nhiệm, không phải nhân vật (README mục 2): một phiên có thể kiêm Tech Lead +
Integration Lead. Điều cấm là HAI phiên cùng kiêm Integration Lead một lúc — khoá chặn điều đó.

## 3. Sổ chung: nhánh `ai-control/registry`

Một cây PHẲNG, không chứa mã: `mission.<id>.json` · `lease.<tên>.json` · `events.ndjson` · `README.md`.
Mỗi dòng sứ mệnh: `mission_id · title · business_goal · status · priority · risk · owner · worker ·
worktree · branch · base_sha · domains · owned_paths · dependencies · blocked_by · related_prs ·
migration_reservations · created_at · updated_at · last_heartbeat · definition_of_done` (+ `intake`,
`needs_owner`, `evidence`). Trạng thái: `BACKLOG · PLANNING · READY · RUNNING · BLOCKED · PR_READY ·
INTEGRATING · DEPLOYING · VERIFYING · DONE · FAILED · CANCELLED`.

**Vì sao một nhánh git, không phải tệp trên `main` hay một dịch vụ:**

- Ghi lên `main` phải qua PR + cổng (~30′) — sổ cần ghi trong vài giây.
- Tệp trong thư mục chung của máy không tới được phiên trên máy khác hay phiên trên mây (đã có thật:
  `claude/vigilant-sagan-*`), và mất cùng cái máy.
- **Đẩy không ép CHÍNH LÀ phép so-và-ghi nguyên tử**: hai phiên cùng đọc một đỉnh rồi cùng ghi ⇒ GitHub
  nhận một, từ chối bên kia (non-fast-forward) ⇒ bên kia đọc lại và quyết lại trên sự thật mới
  (`mutateControl`). Khoá "một chủ" đúng nghĩa mà không cần máy chủ thứ hai.
- Ghi bằng lệnh cấp thấp (`hash-object → mktree → commit-tree → push`) — không chạm chỉ mục hay cây
  làm việc nào. Đây là chỗ DUY NHẤT công cụ đẩy lên remote; tên nhánh bắt buộc `ai-control/<tên>` ở
  cả cấu hình lẫn ngay trước lệnh đẩy, nên công cụ không thể đẩy lên `main` hay nhánh mã
  (`tests/delivery-v2.test.ts::testChiMotChoDay`).

**Sổ là LỜI KHAI, git/GitHub là SỰ THẬT** (luật 1 của README). `board` đối chiếu từng dòng
(`reconcileEntry`) mỗi lần đọc và in trạng thái THẬT kèm từng chỗ "lệch":

| Sổ nói | Git/GitHub nói | Bảng in |
|---|---|---|
| RUNNING | nhánh đã vào `main`, chưa deploy | `INTEGRATING` + "đã vào main nhưng sổ ghi RUNNING" |
| bất kỳ | đã vào và đã lên production | `VERIFYING` + "chạy verify rồi close" |
| RUNNING | PR mở, `gates` đỏ | `FAILED` |
| RUNNING | nhánh không còn ở đâu | `BLOCKED` + "ORPHANED" |
| RUNNING | phụ thuộc chưa khép | `BACKLOG` |
| RUNNING, nhịp tim > 24 giờ | — | "phiên giữ sứ mệnh có thể đã chết" |
| phạm vi khai | nhánh chạm tệp ngoài phạm vi | "chạm N tệp NGOÀI phạm vi khai" |
| DONE | không bằng chứng | "DONE mà không có bằng chứng" |

Bảng KHÔNG tự sửa sổ — sửa lặng lẽ là xoá dấu vết của chỗ lệch.

## 4. Chống trùng việc — `intake`

Trước khi tạo sứ mệnh: `intake "<yêu cầu>" --kw=… --paths=… --github --record` tìm (a) tệp trên `main`
mang đủ từ khoá (nội dung hoặc đường dẫn), (b) sứ mệnh đang mở khớp chủ đề hoặc chồng phạm vi, (c) PR
đang mở khớp tiêu đề hoặc chạm cùng vùng, (d) nhánh remote có commit trong 7 ngày mà chưa vào `main`.

Máy KHÔNG hiểu nghĩa, nên nó chỉ **gợi ý**: việc đang chạy khớp ≥ nửa từ khoá hoặc chồng phạm vi ⇒
`IN_PROGRESS`; tệp trên main mang đủ từ khoá ⇒ `PARTIAL`; không gì ⇒ `MISSING`. Lead đọc chứng cứ rồi
ghi phán quyết cuối vào sổ (`claim --intake=…`). `claim` **từ chối** sứ mệnh có phán quyết `EXISTS` /
`IN_PROGRESS` trừ khi khai lý do (`--accept-overlap`), và mọi lần chặn ghi `DUPLICATE_PREVENTED` vào
nhật ký — `metrics` đếm nó.

## 5. Phạm vi xuyên sứ mệnh — `claim`

`owned_paths` dùng cùng cú pháp `owns` (README mục 4) và cùng phép so chồng lấn CỐ Ý BÁO THỪA. Sứ mệnh có
tệp DAG ⇒ phạm vi DẪN XUẤT từ `owns` của các việc (không khai tay lần hai). Sứ mệnh ngoài AI Tech
Room ⇒ khai `--paths`, hoặc để trống và công cụ suy từ chính nhánh (thư mục chứa từng tệp đã đổi).

`claim` từ chối khi chồng phạm vi / cùng điểm nóng SERIAL với một sứ mệnh ĐANG MỞ, và đưa đúng hai lối
ra: **tuần tự hoá** (`--after=<sứ-mệnh>` ⇒ bảng giữ `BACKLOG` tới khi bên kia VÀO MAIN) hoặc **khai cách
tích hợp** (`--accept-overlap="…"`, ghi `OVERLAP_ACCEPTED`). Đây là soft-lock: không ai bị khoá chết —
sứ mệnh đã khép nhả phạm vi ngay, phiên chết thì bảng báo nhịp tim cũ để người đối chiếu.

## 6. Giữ chỗ số migration

Ca #598/#599: hai PR cùng lấy `0219`, mỗi PR xanh khi đứng một mình, trùng số chỉ lộ ra lúc gộp.

- `migration reserve --mission=<id>` ⇒ số = lớn hơn mọi số trên `main`, trên mọi PR đang mở, và mọi số
  đã giữ chỗ của sứ mệnh đang mở; ghi vào sổ bằng so-và-ghi ⇒ hai phiên không bao giờ nhận cùng số.
- Job `CI / migration` (chỉ trên PR, KHÔNG bắt buộc): `migration check --pr=<số>` đỏ khi PR thêm số đã
  có trên main, số không lớn hơn số cuối của main (drizzle bỏ qua vĩnh viễn), số mà một PR **mở trước**
  cũng thêm, hoặc số sứ mệnh khác **giữ chỗ trước**. Bên đến SAU đỏ; bên kia chỉ nhận cảnh báo — vì
  vậy job không bắt buộc (bắt buộc thì người làm đúng bị khoá vì lỗi của người khác).
- Lúc tích hợp vẫn dùng `npm run migration:renumber` (PR #338) nếu `main` đã đi tiếp.

## 7. Worker

Không đổi (README mục 7–8, `.claude/agents/ai-tech-worker.md`): đúng một việc, đúng một cây, chỉ sửa
`owns`, không PR / gộp / deploy / sửa `.ai/` hay sổ chung. `ready` của Lead + `gates / gates` là lá chắn
thật; luật trong prompt worker chỉ là lớp thứ hai.

## 7b. Bàn giao của worker — worker KHÔNG cần quyền GitHub API

Failure mode thật (06/10/2026): nhánh `feat/pancake-replacement` code/test/push xong (794/794 PASS) nhưng phiên worker không
có credential GitHub nên không ai mở PR. Kiến trúc không được giả định mọi worker giữ quyền đặc quyền:

- **Worker** (chỉ cần `git push`, thứ nó vốn có): `npm run ai -- handoff <sứ-mệnh> --tests="lệnh: kết quả|…" [--summary=…]`
  — công cụ kiểm nhánh ĐÃ lên remote, không còn commit cục bộ chưa đẩy, cây sạch, có khai kiểm thử; ghi bản bàn giao (nhánh ·
  SHA · kiểm thử · tóm tắt · ai bàn giao) vào sổ, trạng thái `PR_READY`. `board` hiện "đã bàn giao, CHƯA có PR"; `queue` hiện
  `NEEDS_PR`.
- **Delivery Controller** (MỘT phiên cầm khoá `integration-lead` + `GH_TOKEN` của cơ chế được ủy quyền):
  `pr-open <sứ-mệnh>` (chỉ cho ĐÚNG SHA đã bàn giao — nhánh đi tiếp sau bàn giao ⇒ từ chối, worker bàn giao lại) →
  `merge <PR> --sha=<SHA queue in>` (chỉ khi hàng đợi xếp MERGE_NOW / MERGE_ISOLATED ở đúng SHA đó, `clean`) →
  `deploy` (chỉ khi `deploy-plan` nói DEPLOY; bám đúng run của SHA, không dispatch lại) → `verify --record` → `close`.
  Ba lệnh ghi GitHub hỏi khoá TRƯỚC khi ghi (`tests/delivery-v2.test.ts` quét mã nguồn).

Ca chứng minh thật: `pancake-replacement` → handoff (06/10 13:3x) → PR #602 mở bởi `pr-open` → gates 17,3′ → `merge` →
`321f7e6d`, cùng lô deploy với #601 + #603.

## 8. Integration Lead — khoá có hạn

`lease acquire integration-lead --purpose=…` · `renew` · `release` · `status`. Hai tên khoá, danh sách
ĐÓNG: `integration-lead` (gộp + deploy), `tech-lead` (phiên đang là cửa vào).

- MỘT chủ còn hạn tại một thời điểm; người khác bị từ chối và được biết ai giữ, giữ tới khi nào.
- **Hết hạn (mặc định 60′) mà không gia hạn = coi như nhả** — phiên giữ nó đã chết. Người sau tiếp
  quản và nhật ký ghi `LEASE_TAKEOVER` (từ ai, hết hạn lúc nào); đời khoá (`generation`) tăng.
- Chủ = nhãn `máy:tên-cây` **VÀ mã phiên** (32 ký tự hex, cấp lúc lấy khoá; sổ chỉ giữ băm sha256 vì kho
  PUBLIC). Nhãn không đủ: review độc lập 06/10/2026 chứng minh hai phiên mở trong CÙNG một cây đều thành
  "chủ", cùng gộp, cùng deploy. Nay cùng nhãn mà không trình đúng mã ⇒ bị từ chối như người lạ.
  `renew` / `release` / `deploy-plan` nhận `--token=…`; phiên phục hồi sau sập trong cùng cây dùng
  `--resume` (đọc mã đã lưu trong thư mục quản trị git của cây) — chỉ khi chắc phiên cũ đã chết, vì
  tệp ấy mọi phiên trong cây đều đọc được. `AI_LEAD_ID` ghi đè nhãn khi cần.
- **Khoá TƯ VẤN, không có fencing.** Không gì chặn một phiên đã quá hạn khoá mà vẫn đang gộp / dispatch;
  hạn tính theo đồng hồ từng máy. Vì vậy `deploy-plan` đọc lại khoá ngay trước khi nói DEPLOY, gia hạn
  (`renew`) trước mỗi bước dài, và lớp chặn thật của production vẫn là `flock` trên VPS (dưới).
- Khoá của GitHub vẫn ở dưới: deploy giữ `flock` ĐỘC QUYỀN `/var/lock/erp-lifecycle.lock` trên VPS
  (`deploy-vps.yml`). Khoá sổ chặn hai NGƯỜI cùng quyết; `flock` chặn hai LƯỢT cùng chạm máy chủ.

## 9. Đường giao hàng: đo trước, sửa đúng chỗ

### Trước (đo 06/10/2026 qua GitHub API, chỉ đọc)

| Đo | median | p95 | mẫu |
|---|---|---|---|
| job `gates` (PR) | 37,3′ | 39,5′ | 30 lượt CI xanh gần nhất |
| · bộ kiểm thử ẩn danh | 14,9′ | 15,7′ | |
| · bộ kiểm thử có token giả | 15,0′ | 16,0′ | |
| · build | 4,3′ | 4,8′ | |
| · typecheck + lint + cài đặt | 2,7′ | 3,1′ | |
| lượt deploy (20 gần nhất) | 42,4′ | 46,3′ | job `gates` 37,4′ · `build_image` 6,0′ · `release` 5,1′ |
| hàng chờ máy chạy GitHub | 0,03′ | 0,23′ | không phải nút thắt |
| **7 ngày** (`metrics --days=7`, 210 PR gộp, 130 deploy) | | | |
| mở PR → gộp | 36,0′ | 264,2′ | 210 |
| CI của PR (thời gian tường) | 26,4′ | 38,1′ | 249 |
| **gộp → lên production** | **44,6′** | **106,5′** | 210 — nút thắt lớn nhất |
| một lượt deploy | 31,1′ | 44,8′ | 130 |
| CI đỏ · deploy đỏ · CI bị huỷ | 16,4% · 11,6% · 57 lượt | | |

Hai phát hiện: (1) không bước nào của cổng cần đầu ra của bước nào — chúng nối đuôi chỉ vì nằm chung
một job; (2) deploy chạy lại NGUYÊN cổng 37′ cho đúng SHA mà lượt CI trên `main` vừa chứng minh xong.

### Sửa

1. **Cổng song song** (`gates.yml`): bốn job (`tinh` · `kiem_thu` · `kiem_thu_token` · `dung_ban`) chạy
   cùng lúc trên bốn máy; job gom tên `gates` (check bắt buộc giữ nguyên tên) đứng đầu, `if: always()`,
   đỏ nếu BẤT KỲ nhánh nào không `success` (kể cả `skipped` / `cancelled` — check bắt buộc ở trạng thái
   skipped được GitHub coi là ĐẠT), và đòi bốn SHA đã checkout trùng nhau. Không bài kiểm nào bị bỏ,
   cùng hai chế độ xác thực. Đường găng = một lượt kiểm thử + cài đặt.
2. **Deploy dùng lại bằng chứng** (`deploy-vps.yml`, job `bang_chung`): tìm LƯỢT CHẠY WORKFLOW
   `ci.yml` · sự kiện `push` · nhánh `main` · `head_sha` = SHA đang triển khai · `success`. Có ⇒ bỏ qua
   `gates`; đang chạy ⇒ chờ nó (≤ 28′) thay vì chạy trùng; không có / đỏ / lỗi API ⇒ chạy `gates` như cũ.
   Hỏi workflow run chứ không hỏi check run, vì check run tên `gates / gates` thì job nào có
   `checks: write` cũng tạo được, còn `path` / `event` / `head_branch` của workflow run do GitHub ghi.
   `release` chạy khi và CHỈ khi ảnh đã dựng VÀ (cổng vừa xanh HOẶC cổng bỏ qua vì có bằng chứng) —
   `tests/delivery-v2.test.ts` duyệt đủ 288 tổ hợp kết quả của điều kiện ấy.

### Không làm, và vì sao

- **Chọn bài kiểm theo đường dẫn đổi** (bỏ test khi PR "chỉ đổi tài liệu"): bộ kiểm thử của kho ĐỌC
  tài liệu, `.ai/`, workflow và mã nguồn như dữ liệu (bản đồ module, vệ sinh mục 65, toàn vẹn kho…),
  nên không có lớp tệp nào đổi mà chắc chắn không làm đỏ một bài. Bỏ test theo đường dẫn ở đây là tắt
  hàng rào, không phải tối ưu.
- **Chia nhỏ `npm test` thành nhiều mảnh** (sharding): `tests/sync-fixtures.test.ts` là MỘT hàm `main()`
  ~2.270 dòng dùng chung fixture gieo đầu bài; chia nó là đổi bộ kiểm thử, rủi ro hơn lợi. Đây là nút
  thắt KẾ TIẾP (15′ / lượt) — làm thành một sứ mệnh riêng, đo trước/sau.
- **Bỏ lượt kiểm thử có token**: nhánh `TOKEN` đổi hành vi thật (trần request 12 vs 3); giữ, chỉ chạy song song.

### Sau

Đo thật trên lượt CI của chính PR này và lượt deploy đầu tiên sau khi gộp — ghi ở báo cáo bàn giao của
sứ mệnh `tech-lead-delivery-v2` trong sổ chung (`evidence`), không chép lại vào đây để khỏi cũ.
Kỳ vọng tính từ số trước: CI của PR ≈ 37′ → ≈ 16–18′; lượt deploy khi CI của `main` đã xanh ≈ 42′ →
≈ 11–12′ (dựng ảnh 6′ + release 5′); gộp-xong-dispatch-ngay ≈ 21′ (chờ CI của main 16′ song song với
dựng ảnh, rồi release). Đo lại bất cứ lúc nào: `npm run ai -- metrics --days=7`.

## 10. Rủi ro và chính sách gộp

`classifyRisk(tệp)`: sàn theo đường dẫn (`riskFloor` trong `.ai/config.json`) nâng; tệp nằm trọn trong
`lowRiskPaths` (tài liệu, test, component UI, trang dashboard) mà không chạm sàn nào ⇒ LOW; còn lại
MEDIUM (logic, API, tích hợp); migration PHÁ dữ liệu (DROP TABLE/COLUMN · TRUNCATE · DELETE FROM) ⇒
CRITICAL bất kể đường dẫn. HIGH: xác thực, cô lập tổ chức (`lib/platform/`, `db/index.ts`), migration,
CI/deploy, lương, thu phí, sổ kho, chính sách điều phối. CRITICAL: `ORDER_OUTCOME`, đặc tả luật nghiệp
vụ, contract test.

`mergePolicy`: LOW/MEDIUM ⇒ `AUTO` (Integration Lead gộp khi cổng xanh) · HIGH ⇒ `LEAD_REVIEW` (một lượt
`ai-tech-reviewer` bối cảnh mới, ĐẠT thì ghi dấu vào SỔ: `review <PR> --sha=<đầu nhánh> --verdict=PASS`
— gắn SHA, commit mới ⇒ mất hiệu lực, chỉ phiên cầm khoá tech-lead / integration-lead ghi được PASS;
dòng chữ trong thân PR thì ai mở được PR cũng viết được, nên không còn được tính) · CRITICAL ⇒ `OWNER`.
Gộp luôn kèm `sha` mà `queue` in ra — đầu nhánh đổi sau lượt xét thì GitHub từ chối lệnh gộp
(chủ shop duyệt) — cấu hình **không** nới được bậc CRITICAL. Ruleset `main` giữ nguyên: bắt buộc PR +
`gates / gates`, không ai né. Harness của phiên chặn bước gộp / dispatch ⇒ đưa chủ shop đúng một nút /
một lệnh `!`, không lách.

## 11. Hàng đợi gộp — `queue`

PR xanh ≠ gộp ngay. Mỗi PR đang mở nhận một phán quyết: `MERGE_NOW` · `MERGE_ISOLATED` · `WAIT_SERIAL` ·
`WAIT_DEPENDENCY` · `WAIT_GATES` · `NEEDS_REVIEW` · `NEEDS_OWNER` · `FIX_GATES` · `FIX_CONFLICT` ·
`MIGRATION_COLLISION` · `DRAFT`. Thứ tự: phụ thuộc trước (dòng `Phụ thuộc: #12` trong thân PR, hoặc
`dependencies` của sứ mệnh trong sổ) · rủi ro thấp gom thành MỘT lô (một deploy) · HIGH/CRITICAL đi
RIÊNG (gộp → deploy → verify rồi mới tới PR khác) · hai PR chạm cùng tệp / cùng điểm nóng SERIAL không
cùng lô (ruleset `strict` đang TẮT — đo 06/10 — nên gộp cả hai mà không cập nhật nhánh là chỗ xung đột
ngữ nghĩa lọt qua).

## 12. Deploy theo lô, một chủ — `deploy-plan`

Đọc SHA production (`/api/health`), liệt kê commit chưa deploy kèm rủi ro + migration, rồi:
`NOTHING` · `UNKNOWN_PRODUCTION` · `WAIT_DEPLOY` (một lượt đang chạy — không chồng) · `FIX_MAIN` (main
đỏ) · `NEED_LEASE` (chưa cầm `integration-lead`) · `DEPLOY` (một lượt cho cả lô). Dispatch vẫn là một
bước tường minh của Lead (MỘT lần, bám run id > BEFORE — ghi nhớ "một hành động một run"); công cụ
không dispatch hộ.

Không huỷ lượt deploy nào. Lượt đang chạy có thể đang ở migration (không đảo ngược) — chờ nó; lượt sau
xếp hàng bằng `flock` trên VPS. Lượt mới phủ lượt cũ đang chờ thì vẫn để lượt cũ chạy: nó vô hại
(SHA cũ hơn, cùng nội dung tiền tố), còn huỷ nhầm lượt đang release là sự cố.

## 13. Hậu kiểm production — `verify`

ĐẠT khi: `/api/health` `ok` · commit đang chạy = SHA mong đợi · số migration đã áp = số mục trong sổ
`_journal.json` của SHA đó · lượt `deploy-vps.yml` của SHA kết thúc `success` (gồm smoke đăng nhập +
các trang trên VPS — `scripts/smoke.ts`) · mọi endpoint công khai trong `verifyEndpoints` trả 2xx/3xx.
`--record --mission=<id>` ghi `PASS|FAIL <sha> <lúc>` vào sổ; `close --status=DONE` đòi: dòng sổ có nhánh
hoặc PR, bằng chứng đã vào main, chỉ ra được commit đưa việc vào main, và `PASS` trên một bản CHỨA commit
đó — hoặc `--no-runtime`, chỉ được nhận khi MỌI tệp sứ mệnh chạm nằm trong `nonRuntimePaths` (tài liệu,
test, `.ai/`, `.claude/`, công cụ điều phối; `.github/` cố ý không nằm đó — đổi đường deploy thì phải
deploy thật và hậu kiểm).

KHÔNG ĐẠT ⇒ INCIDENT, không tuyên bố xong. **Không rollback tự động**: migration của kho chỉ đi tới
(`drizzle` không có đường lùi), deploy lại SHA cũ trên một CSDL đã nâng lược đồ không an toàn hơn sửa
tiến. Sửa tiến bằng PR mới; production hỏng ⇒ gọi chủ shop (`PRODUCTION_INCIDENT`).

## 14. Bảng của chủ shop — `board`

```
BẢNG ĐIỀU KHIỂN · 11:42 6/10/2026 (giờ VN)
  main 419fe3be · production 419fe3be ✓ khớp main
  RUNNING 2 · READY 0 · PR_READY 1 · BLOCKED 0 · DEPLOYING 0 · FAILED 0 · DONE 3
  RUNNING  P1 HIGH  pancake-replacement  feat/pancake-replacement · nhịp 0.3h · …
      ⚠ <chỗ sổ nói khác git, nếu có>
PR ĐANG MỞ: 1 · 1 PR chưa thuộc sứ mệnh nào trong sổ: #600 claude/vigilant-sagan-dzqtn5
KHOÁ: integration-lead — trống · tech-lead — <máy:cây> còn 42′
CẦN CHỦ SHOP (1)
  [APPROVAL_REQUIRED] ai-tech-room: …
```

`--github` thêm PR + `gates`; `--all` hiện cả sứ mệnh đã khép; `--json` cho máy đọc. Có `GH_TOKEN`
trong môi trường thì dùng (5.000 lượt/giờ), không thì đọc công khai (60 lượt/giờ) — không bao giờ in token.

## 15. Khi nào gọi chủ shop

Chín loại (`OWNER_ESCALATIONS`) + AGENTS.md mục 7. Ghi bằng `claim <id> --needs-owner="LOẠI: việc cần
làm"`, `board` in ở mục CẦN CHỦ SHOP, `close` hoặc `--clear-owner` gỡ. Việc của worker bình thường
không bao giờ lên bảng này.

## 16. Phục hồi phiên — đúng các bước

1. Mở phiên mới (bất kỳ thư mục nào của kho). Đọc `CLAUDE.md` → `AGENTS.md` (tự nạp).
2. `git fetch origin` · `git show origin/main:scripts/ai-tech.ts > <tạm>/ai-tech.ts` (checkout có thể cũ).
3. `node <tạm>/ai-tech.ts board --github` — sổ đọc lại từ REMOTE (bài kiểm xoá bản sao cục bộ rồi
   chứng minh đọc lại đủ). Lệch giữa sổ và git được in ra; tin git.
4. `lease acquire tech-lead` — bị từ chối "cùng nhãn nhưng KHÔNG đúng mã phiên" và CHẮC phiên cũ (cùng
   cây) đã chết ⇒ `--resume`; cây khác ⇒ chờ khoá cũ hết hạn (≤ 60′) hoặc phiên kia vẫn sống và đang
   là Tech Lead.
5. Mỗi sứ mệnh RUNNING có tệp DAG: vào cây Lead của nó, `npm run ai -- status <id> --github` rồi theo
   README mục 13 (giao lại phiếu cho worker mới nếu worker cũ chết).
6. Khoá `integration-lead` của phiên chết: hết hạn thì `lease acquire` tiếp quản (nhật ký ghi
   `LEASE_TAKEOVER`); TRƯỚC khi gộp/deploy, `deploy-plan` để thấy lượt deploy nào đang chạy dở.

## 17. Dọn dẹp

Sứ mệnh DONE: `close` (đòi bằng chứng) nhả phạm vi + giữ chỗ migration; cây/nhánh dọn bằng `cleanup`
của README mục 11 (chạy thử trước; không bao giờ dọn cây bẩn, có commit chưa đẩy, chưa có bằng chứng
đã vào, hay không rõ chủ). Sổ giữ dòng đã khép làm lịch sử (`board --all`).

## 18. Đo lường — `metrics`

`metrics --days=N`: viết mã (commit đầu → mở PR — đo THIẾU khi phiên commit muộn, nên chỉ đọc làm cận
dưới) · lead time · CI tường · chờ deploy (gộp → lượt deploy xanh đầu tiên chứa commit đó) · một lượt
deploy · tỷ lệ CI đỏ / deploy đỏ / revert · CI bị huỷ · trùng việc đã chặn · chồng phạm vi đã phát hiện ·
và in nút thắt lớn nhất theo median. Độ bận worker: CHƯA ĐO ĐƯỢC (subagent không để lại mốc trên
GitHub) — in "—", không đoán.

## 19. Giới hạn đã biết

| Giới hạn | Hệ quả | Vì sao chấp nhận |
|---|---|---|
| `intake` khớp chữ, không hiểu nghĩa | gợi ý sai cả hai chiều | Lead đọc chứng cứ và ghi phán quyết; máy không được tự kết luận EXISTS |
| Đồng hồ hai máy lệch nhau | khoá hết hạn sớm/muộn vài giây–phút | thời hạn 60′ lớn hơn nhiều độ lệch thường gặp; tiếp quản luôn để dấu vết |
| `board` chỉ thấy sứ mệnh ĐÃ đăng ký | phiên không dùng V2 vô hình với sổ | `board --github` in PR không thuộc sứ mệnh nào; `intake` quét cả nhánh remote |
| Dấu review trong sổ là lời khai của phiên có quyền đẩy vào kho | không chứng minh bằng mật mã | gắn SHA + actor, chỉ ai đẩy được vào kho mới ghi được (không như thân PR); lá chắn thật vẫn là `gates / gates` + ruleset |
| Khoá tư vấn, không fencing (mục 8) | phiên quá hạn vẫn hành động được | `renew` trước bước dài; `flock` trên VPS chặn hai lượt chạm máy chủ |
| Bài kiểm chạy kịch bản gom bằng `bash` | trên Windows cần Git Bash trên PATH (WSL `bash` không ghi được `C:/…`) | CI (Linux) luôn có bash; trên máy này `npm test` chạy bằng Git Bash |
| `bang_chung` dùng lại cổng của lượt push vào main | PR gộp với `strict` tắt: SHA trên main là commit MỚI mà CI của PR chưa từng kiểm | đúng vì vậy bằng chứng phải là lượt CI của CHÍNH SHA trên main, không phải của PR |
| `queue` / `metrics` gọi API nhiều | chậm, ăn hạn mức | chạy khi cần; đặt `GH_TOKEN` |
