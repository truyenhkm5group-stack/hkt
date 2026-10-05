# AI Tech Room — cách một Lead chạy sứ mệnh kỹ thuật bằng nhiều worker song song

*05/10/2026. Công cụ: `scripts/ai-tech.ts` (`npm run ai -- help`). Trạng thái: `.ai/`. Kiểm thử:
`tests/ai-tech-room.test.ts` (trong `npm test`).*

Chủ shop nói **mục tiêu**. Lead (một phiên Claude) biến nó thành một **DAG việc**, quyết việc nào
làm tại chỗ, việc nào tách cây riêng, chạy song song bao nhiêu, đưa từng nhánh qua cổng của kho,
dọn cây khi xong, và chỉ gọi chủ shop khi thật sự cần một con người.

Đây là một **mặt phẳng điều khiển**, không phải một nhóm agent nói chuyện với nhau. Nó cố tình nhỏ:
một tệp TypeScript không phụ thuộc gói nào, vài tệp JSON, và git.

> **Không bắt buộc.** Một nhánh thường + một PR thường vẫn là cách đúng cho việc nhỏ. AI Tech Room
> chỉ dùng khi sứ mệnh đủ lớn để cần tách việc (mục 3).

---

## 0. Khác gì `/tech` trong ERP

| | `/tech` (Phòng Tech AI, `docs/ai-tech-department-phase1.md`) | AI Tech Room (tài liệu này) |
|---|---|---|
| Ở đâu | CSDL production (`tech_tasks`, `tech_agent_runs` …) | git + `.ai/` trong kho |
| Ai dùng | chủ shop xem việc kỹ thuật, deploy, sự cố của **hệ thống đang chạy** | Lead điều phối **phiên Claude Code trên máy dev** |
| Agent chạy | runner trên GitHub Actions (`agent-run.yml`) | phiên Claude cục bộ + subagent, mỗi worker một worktree |

Hai thứ không trùng nhau và không thay nhau. Một việc của AI Tech Room *có thể* sinh ra một việc
`TECH-n` khi nó cần chủ shop phê duyệt R2 trong ERP — lúc đó ghi số `TECH-n` vào `objective`, đừng
chép trạng thái qua lại.

## 1. Ba luật nền

1. **Tệp sứ mệnh giữ Ý ĐỊNH, git giữ SỰ THẬT.** `.ai/missions/<id>.json` khai việc · phụ thuộc ·
   phạm vi ghi · rủi ro · và những quyết định chỉ Lead/chủ shop biết (chặn, hoãn, huỷ, xong-tại-chỗ).
   RUNNING / REVIEW / MERGED **không lưu** — `npm run ai -- status` suy ra chúng từ git mỗi lần.
   Sau một lần sập máy, trạng thái đã lưu là lời khai cũ; trạng thái suy ra thì không thể cũ.
2. **Không ghi vào cây không phải của mình.** Công cụ đọc cây khác bằng `--no-optional-locks`, chỉ
   dọn cây có phiếu giao việc của nó, và không bao giờ dọn cây bẩn hay có commit chưa lên remote.
3. **Không một cổng nào bị nới để điều phối chạy nhanh hơn.** `gates / gates`, lượt duyệt của chủ
   shop, ruleset `main` — giữ nguyên (xem `docs/main-protection.md`).

## 2. Vai trò (là trách nhiệm, không phải nhân vật)

| Vai | Làm | Không làm |
|---|---|---|
| **Lead** | hiểu sứ mệnh · kiểm thực tế kho · chia việc + DAG · quyết INLINE/SERIAL/PARALLEL · giao phạm vi · giữ hợp đồng chung · xếp thứ tự tích hợp · quyết khi worker xin đổi phạm vi · gọi chủ shop | không để worker tự đổi hợp đồng chung |
| **Worker** | đúng MỘT việc trong đúng MỘT cây: làm, kiểm thử phạm vi mình, commit, đẩy nhánh, báo XONG/CHẶN | không mở PR, không merge, không deploy, không sửa ngoài `owns`, không sửa `.ai/` |
| **Reviewer/QA** | một lượt đọc với bối cảnh MỚI (subagent riêng) cho việc rủi ro ≥ HIGH: đúng · hồi quy · bảo mật · cô lập tổ chức · migration · luật nghiệp vụ AGENTS.md | không sửa mã — báo lại cho Lead |
| **Release** | (Lead kiêm) PR · cổng · thứ tự merge · deploy theo `deploy-vps.yml` · smoke · đối chiếu lại các worker | không bỏ qua cổng |

Một phiên làm được nhiều vai. Chỉ tách subagent khi bối cảnh mới đáng giá (review độc lập) hoặc khi
việc thật sự chạy song song.

## 3. Định tuyến: INLINE · SERIAL · PARALLEL · BLOCKED · DEFERRED

Lead quyết, không hỏi chủ shop.

| Chọn | Khi |
|---|---|
| **INLINE** (`mode: "INLINE"`) | việc nhỏ (≲ 30 phút, ≲ 5 tệp), hoặc chi phí dựng cây + `npm ci` + bàn giao lớn hơn lợi ích; Lead làm ngay trong cây của mình |
| **SERIAL** (`dependsOn`) | B cần đầu ra của A · lược đồ / hợp đồng chung phải ổn định trước · thứ tự migration · cùng một điểm nóng SERIAL |
| **PARALLEL** (`mode: "WORKER"`, không phụ thuộc nhau, phạm vi không chồng) | việc độc lập thật, hợp đồng đã ổn, rút ngắn được đường găng |
| **BLOCKED** (`decision.state: "BLOCKED"`) | thiếu phụ thuộc ngoài, cần phê duyệt / khoá / đăng nhập ngoài, hợp đồng của sứ mệnh khác chưa vào |
| **DEFERRED** | đúng nhưng chưa đáng làm lúc này |

Mặc định là **ít worker**. Bốn cây giẫm lên nhau tệ hơn hai cây độc lập; mục tiêu là rút ngắn
thời gian tường, không phải đếm agent.

## 4. Tệp sứ mệnh

`npm run ai -- new <id> "<tiêu đề>"` tạo khung. Mỗi việc:

```jsonc
{
  "id": "bao-cao-ton",              // slug a-z0-9-, thành tên nhánh claude/<id> và cây ../wt-<id>
  "slug": "bao-cao-ton-2",          // (tuỳ chọn) khi tên mặc định đã có người dùng
  "title": "…", "objective": "…",
  "mode": "WORKER",                 // hoặc INLINE
  "priority": "P1",                 // P0..P3
  "risk": "MEDIUM",                 // LOW..CRITICAL — không được thấp hơn sàn theo đường dẫn
  "dependsOn": ["hop-dong-ton"],
  "base": "integration",            // (tuỳ chọn) hoặc id một phụ thuộc để dựng CHỒNG — hạn chế dùng
  "owns": ["lib/queries/stock-report.ts", "app/(dashboard)/stock-report/"],
  "readOnly": ["lib/queries/stock.ts"],
  "doNotTouch": ["db/schema.ts"],
  "tests": ["npx tsx --tsconfig tsconfig.json tests/stock-report.test.ts", "npm run typecheck"],
  "definitionOfDone": ["…đo được…"],
  "expectedOutput": "…", "integrationNotes": "…",
  // do Lead/chủ shop ghi:
  "decision": { "state": "BLOCKED", "category": "APPROVAL_REQUIRED", "reason": "…", "ownerAction": "…", "resumes": "…" },
  "pr": 612,                        // số PR khi đã mở — làm bằng chứng squash-merge "(#612)"
  "deploy": { "sha": "…", "evidence": "link lượt Deploy ERP to VPS + smoke" }
  // "run": { … } — do `spawn` ghi, đừng sửa tay
}
```

`owns` là **phạm vi ghi**, không phải danh sách mọi tệp. Mẫu chỉ dùng `*` / `?`; mẫu không đại
diện phủ chính nó và mọi thứ bên dưới. Phép so chồng lấn **cố ý báo thừa** (mẫu đại diện coi như
phủ cả thư mục) — báo thừa thì hai việc phải tuần tự, báo thiếu thì hai cây cùng sửa một tệp.

`.ai/config.json` khai cho cả kho: trần worker (`maxImplementationWorkers`, mặc định **4**), nhánh
tích hợp (`origin/main`), quy ước tên (`claude/<slug>`, `../wt-<slug>` — đúng quy ước AGENTS.md
mục 9 đã có), **điểm nóng** và **sàn rủi ro**:

- **Điểm nóng SERIAL** — chỉ một việc giữ tại một thời điểm, kể cả khi hai việc sửa hai tệp khác
  nhau bên trong: `drizzle/` (số hiệu migration), `db/schema.ts`, `package*.json`, `.github/`,
  `AGENTS.md`, `CLAUDE.md`, `lib/auth/`, `middleware.ts`, `lib/queries/return-rate.ts`.
- **Điểm nóng SHARED** — nhiều việc cùng chạm được vì chỉ NỐI THÊM: `tests/sync-fixtures.test.ts`
  (một import + một lời gọi mỗi việc).
- **Sàn rủi ro** — rủi ro khai thấp hơn sàn là LỖI kiểm tra. ORDER_OUTCOME / đặc tả luật / contract
  test ⇒ CRITICAL; migration, lược đồ, xác thực, CI/deploy, lương, thu phí, sổ kho ⇒ HIGH.

`npm run ai -- validate` kiểm: id/slug, phụ thuộc tồn tại, **chu trình** (nêu tên), WORKER phải có
`owns` + `tests`, `owns` không nằm trong `doNotTouch`, sàn rủi ro, `BLOCKED` vì chủ shop phải có
`ownerAction`, và **cảnh báo** mọi cặp việc có thể chạy song song mà chồng phạm vi.

## 5. Trạng thái — suy ra, không khai

| Trạng thái | Nghĩa (đo từ git) |
|---|---|
| BACKLOG | còn phụ thuộc chưa xong |
| READY | phụ thuộc xong (MERGED/DEPLOYED/DONE), chưa có cây |
| RUNNING | có cây và: bẩn, hoặc chưa commit, hoặc commit chưa đẩy |
| REVIEW | sạch + đã đẩy (hoặc cây đã gỡ mà nhánh còn trên remote) — chờ PR / cổng / duyệt |
| MERGED | có **bằng chứng** đã vào nhánh tích hợp (dưới) |
| DEPLOYED | MERGED + Lead ghi `deploy` kèm bằng chứng lượt deploy và smoke |
| DONE / BLOCKED / DEFERRED / CANCELLED | quyết định đã khai |
| ORPHANED | tệp khai có lượt chạy nhưng git không còn cây lẫn nhánh trên remote — **phải đối chiếu tay** |

**Bằng chứng đã vào** (`mergeEvidence`), mạnh tới yếu — không có thì coi là CHƯA vào:

- `ANCESTOR` — nhánh có commit RIÊNG và đầu nhánh là tổ tiên của nhánh tích hợp (merge commit);
- `PR_SUBJECT` — nhánh tích hợp có commit kết thúc bằng `(#<pr>)`, dấu squash-merge của kho này;
- `PR_MERGED` — GitHub nói PR đã merge (khi gọi `--github`);
- `CONTENT` — mọi tệp nhánh đã đổi đều **giống hệt** ở nhánh tích hợp (squash không ghi số PR).

"Commit riêng" = commit trên chuỗi first-parent của nhánh mà không nằm trên chuỗi first-parent
của nhánh tích hợp. Worker chưa commit gì mà fast-forward lên `main` thì có 0 commit riêng ⇒
`EMPTY`, không bao giờ là "đã vào" (reviewer tái hiện lỗi này ở bản đầu: cây bị dọn dưới chân
phiên đang chạy). Hệ quả: tích hợp bằng **fast-forward** không được nhận là đã vào — PR của kho
merge bằng squash/merge commit, còn Lead tích hợp cục bộ thì dùng `git merge --no-ff`.

Đã vào thì git thắng: một `decision: BLOCKED` cũ không giữ được việc đã MERGED. Khi dọn cây, bằng
chứng được ghi vào `run.mergedEvidence` — sau khi GitHub tự xoá nhánh thì đó là dấu vết duy nhất.

## 6. Vòng lặp của Lead

```
while sứ mệnh chưa xong:
    npm run ai -- status <id> [--github]   # đối chiếu thực tế: cây, nhánh, PR, cổng
    npm run ai -- reconcile <id>           # main chạy tiếp: ai phải cập nhật
    npm run ai -- next <id>                # DỰNG CÂY · LEAD LÀM · NẰM LẠI (kèm lý do)
    việc INLINE  → làm ngay trong cây Lead, ghi decision DONE + bằng chứng
    việc WORKER  → spawn → giao phiếu cho subagent (mục 7) — chạy nền, song song
    worker báo XONG → ready → (HIGH+: reviewer subagent) → PR → gates → duyệt → merge
    sau mỗi merge nền tảng → reconcile các worker còn lại
    merge xong → cleanup (chạy thử rồi --apply) → next
    BLOCKED vì người → ghi decision + ownerAction, làm tiếp việc READY khác
```

`next` không cố lấp đầy trần. Nó xếp READY theo **ưu tiên → số việc phía sau (đường găng) → id**,
rồi để một việc NẰM LẠI khi: chồng phạm vi với việc đang RUNNING/REVIEW (REVIEW vẫn giữ phạm vi
tới khi vào), cùng điểm nóng SERIAL, đủ trần (của sứ mệnh và của **cả máy** — đếm cây có phiếu
của mọi sứ mệnh), hoặc có việc CRITICAL đang chạy (**CRITICAL chạy một mình**). Ưu tiên khi chọn:
sự cố production → an ninh / toàn vẹn dữ liệu → việc chặn đường găng → giá trị cao → mở khoá phụ
thuộc → giảm rủi ro → tính năng thường → dọn dẹp.

## 7. Dựng worker

```
npm run ai -- spawn <sứ-mệnh> <việc> [--dry-run]
```

1. Từ chối nếu việc không READY, là INLINE, hoặc bộ xếp lịch đang giữ nó lại.
2. `git fetch origin` — **fetch hỏng thì không dựng** (gốc có thể cũ; `--offline` nếu chấp nhận).
3. Gốc = `origin/main` vừa fetch (hoặc nhánh trên remote của phụ thuộc khi `base` dựng chồng) —
   **không bao giờ** `main` cục bộ, thứ mà ở kho này thường là bản cũ của một phiên khác.
4. Va chạm ⇒ từ chối, nói rõ cái gì: nhánh cục bộ, nhánh remote, worktree đã đăng ký, thư mục có
   sẵn. Không bao giờ dùng lại / đè lên thứ đang có. Sửa bằng `slug` mới.
5. `git worktree add --no-track -b claude/<slug> ../wt-<slug> <sha>`.
6. Phiếu giao việc ghi vào **thư mục quản trị git của cây** (`.git/worktrees/wt-<slug>/ai-tech-task.json`
   + `ai-tech-brief.md`) — không nằm trong cây làm việc nên không bao giờ bị `git add` nhầm, và nó
   là dấu **sở hữu**: cây có phiếu là cây của AI Tech Room, cây không có phiếu là của ai đó khác.
7. Ghi `run` (nhánh, cây, gốc, SHA, lúc dựng) vào tệp sứ mệnh — chỗ duy nhất công cụ tự ghi.

Gọi lại `spawn` cho việc đã có cây chỉ **ghi lại phiếu** (phục hồi sau sập), không dựng lần hai.

**Giao cho worker** (Claude Code hiện tại): Lead gọi tool `Agent` (chạy nền) với prompt =
`npm run ai -- brief <sứ-mệnh> <việc>` + một dòng "làm việc trong thư mục `<cây>`". Worker mở phiên
mới trong cây đó thì chạy `npm run ai -- whoami` để đọc lại phiếu. Không dùng `isolation: "worktree"`
của tool Agent cho việc này: nó dựng cây từ HEAD hiện tại dưới `.claude/worktrees/` và không có
phiếu — tức là đúng loại cây không rõ chủ, gốc không kiểm, mà công cụ này sinh ra để tránh.

**Runtime làm được và không làm được** (đo 05/10/2026):

| Được tự động | Còn cần người |
|---|---|
| nhánh, cây, gốc đã kiểm, phiếu, trạng thái, đối chiếu, dọn | mở PR khi phiên không có `gh` / token (dán link `compare` mà `ready` in ra, hoặc chủ shop chạy workflow `agent-open-pr`) |
| khởi động worker bằng subagent nền trong cùng phiên | **duyệt PR** — ruleset bắt buộc 1 lượt duyệt của NGƯỜI; agent không duyệt / không tự merge |
| đọc PR + check trên GitHub (kho public, không cần token) | bấm deploy production (`deploy-vps.yml` là `workflow_dispatch`) khi phiên không có quyền dispatch |

Subagent của một phiên **không sống qua** việc phiên đó tắt. Nhưng cây, nhánh và phiếu thì sống:
phiên Lead mới chạy `status` là thấy việc nào RUNNING dở, rồi giao lại phiếu cho subagent mới.

## 8. Worker được làm gì, xong thế nào

Phiếu (`renderBrief`) là hợp đồng, AGENTS.md vẫn thắng phiếu:

- chỉ sửa trong `owns`; **cần chạm ngoài phạm vi ⇒ dừng và báo "YÊU CẦU ĐỔI PHẠM VI: tệp — vì sao"**.
  Lead quyết: mở rộng `owns`, tạo việc mới, tuần tự hoá, tự sửa hợp đồng chung tại chỗ, hay từ chối;
- `npm ci` lần đầu; chạy `tests` của phiếu + `npm run typecheck` + `npm run lint` (bộ đầy đủ
  `npm test` chạy ở cổng PR — worker không phải chứng minh cả kho);
- commit tiếng Việt, chỉ tệp của việc, rồi `git push -u origin <nhánh>`. Không tên model AI — kể cả
  dòng `Co-Authored-By` mà công cụ tự chèn: xoá **trước** khi đẩy; không bao giờ đẩy đè (dogfood
  05/10/2026: cả hai worker phải amend + force-push nhánh của mình vì đúng chỗ này);
- **không** mở PR, merge, deploy, đụng `main`, sửa `.ai/`, hay vào cây khác;
- báo cáo cuối: XONG/CHẶN · SHA · lệnh kiểm thử + kết quả · tệp đã đổi · rủi ro còn lại.

## 9. Tích hợp

```
npm run ai -- ready <sứ-mệnh> <việc>
```

Kiểm: cây sạch · có commit · nhánh remote khớp · **cập nhật với nhánh tích hợp** (ruleset `strict`
đòi vậy) · mọi tệp đổi nằm trong `owns` · không chạm `doNotTouch` / `.ai/` · không xung đột
(`git merge-tree`, không đụng cây nào) · cảnh báo điểm nóng và rủi ro ≥ HIGH (cần reviewer). Đạt
thì in link PR + tiêu đề.

Thứ tự: hợp đồng chung vào trước, việc tiêu thụ nó sau (hoặc việc sau khai `base` để dựng chồng —
tránh chuỗi nhánh dài). Nhiều PR độc lập: rủi ro thấp + mở khoá nhiều trước. Mỗi PR đi đúng đường
của kho: `gates / gates` xanh + một lượt duyệt người + `strict`. **Không** `--admin`, không
`--no-verify`, không sửa ruleset hay workflow cổng để qua.

Hai nhánh cùng thêm migration ⇒ `reconcile` báo `CONFLICTS` kèm lệnh `npm run migration:renumber`
(công cụ đã có, mục 4 AGENTS.md). Việc chạm `drizzle/` vốn đã SERIAL nên hiếm khi tới bước này.

## 10. Khi `main` chạy tiếp

`npm run ai -- reconcile <id>` fetch rồi xếp mỗi việc đang mở vào một ô:

| Kết luận | Làm gì |
|---|---|
| UP_TO_DATE | không gì |
| NO_EFFECT | không gì bây giờ; cập nhật một lần lúc mở PR |
| AFFECTS_READ_ONLY | cập nhật trước PR + chạy lại kiểm thử |
| SHARED_CONTRACT | upstream đổi một điểm nóng — đọc thay đổi, cập nhật trước PR |
| REQUIRES_REFRESH | upstream sửa đúng tệp/phạm vi của việc — cập nhật trước khi làm tiếp |
| CONFLICTS | xung đột thật (`merge-tree`) hoặc trùng số migration — cập nhật NGAY, giải có chủ đích |

Không rebase liên tục. Cập nhật = `git merge origin/main` **trong cây của chính việc đó** (merge,
không rebase: SHA đã đẩy giữ nguyên), chạy lại kiểm thử, đẩy. Không bao giờ đè thay đổi upstream.

## 11. Dọn cây

```
npm run ai -- cleanup <sứ-mệnh>:<việc>     # chạy thử
npm run ai -- cleanup <sứ-mệnh>:<việc> --apply
npm run ai -- cleanup --merged --apply     # mọi cây CÓ PHIẾU đủ điều kiện
```

Từ chối (mỗi lý do một mã): `MAIN` · `CURRENT` · `LOCKED` · `PRUNABLE` · `DIRTY` · `UNKNOWN` ·
`NOT_MERGED` · `UNPUSHED` (commit không có trên bất kỳ ref remote nào và chưa nằm trong nhánh tích
hợp) · `LOCAL_SECRETS` (tệp `.env*` bị ignore — `worktree remove` xoá cả chúng) · `RECENT` (có
người động vào trong `cleanupGraceMinutes` phút, mặc định 30 — bằng chứng merge nói về commit, không
nói ai còn đứng trong cây) · `EMPTY_BUT_RECENT` · `UNOWNED` · `UNOWNED_RECENT`. Không có cờ nào bỏ
qua được bẩn / chưa đẩy / bí mật cục bộ.

Làm: `git worktree remove` **không `--force`** (git tự từ chối nếu cây vừa bẩn lên giữa lúc đo và
lúc làm) → `git update-ref -d refs/heads/<nhánh> <SHA đã đo>` (so-và-xoá: worker commit thêm giữa
lúc đo và lúc xoá thì nhánh được giữ) → ghi `cleanedAt` + bằng chứng. **Nhánh trên remote giữ nguyên** — GitHub tự
xoá sau merge nếu kho bật, còn không thì đó là quyết định của chủ shop.

`npm run ai -- worktrees` phân loại mọi cây trên máy: `MAIN · CURRENT · ACTIVE · IDLE ·
STALE_CLEAN · STALE_DIRTY · MERGED_SAFE_TO_CLEAN · UNKNOWN`. "Lần cuối động" đọc reflog HEAD và
mtime tệp bẩn — **không** đọc `index`, vì trình soạn thảo làm mới index của mọi cây (đo 05/10/2026:
50+ cây "vừa động" cùng lúc). Cây không rõ chủ thì chỉ BÁO; dọn chúng cần chủ shop cho phép
(`--allow-unowned`) và vẫn không dọn cây vừa dùng trong `activeWithinHours` giờ.

## 12. Hotfix

Sự cố production không xếp hàng sau sứ mệnh lớn:

1. Thêm việc `P0`, `risk` theo sàn, `owns` tối thiểu, vào sứ mệnh đang chạy hoặc `npm run ai -- new hotfix-<ngày>`.
2. `spawn … --ignore-capacity` — cờ này **chỉ** cho hotfix; nó không bỏ qua va chạm tên hay chồng phạm vi.
3. Sửa tối thiểu + kiểm thử của vùng + cổng đầy đủ → PR → duyệt → merge → `Deploy ERP to VPS` → smoke.
4. `reconcile` mọi sứ mệnh đang mở với `main` mới.

Không sửa trên cây chính dùng chung.

## 13. Phục hồi sau gián đoạn

VS Code đóng, phiên chết, máy khởi động lại, mạng mất: một Lead **mới** chỉ cần

```
npm run ai -- status            # mọi sứ mệnh trong cây này, suy từ git
npm run ai -- status --github   # + PR, cổng
npm run ai -- worktrees         # cả máy
```

rồi xử lý theo trạng thái: RUNNING ⇒ giao lại phiếu cho worker mới (`brief`), hoặc mở cây đọc
`git log` để tiếp; REVIEW ⇒ kiểm PR; ORPHANED ⇒ đối chiếu (nhánh mất mà chưa vào là việc bị mất —
dựng lại hoặc huỷ có lý do); BLOCKED ⇒ xem chủ shop đã làm chưa. Không tin lời khai nào trong
tệp sứ mệnh hơn git. Tệp sứ mệnh phải được **commit và đẩy** cùng nhánh Lead sau mỗi lần đổi kế
hoạch — chỉ nằm trên đĩa là mất cùng cái máy.

## 14. Khi nào gọi chủ shop

Chỉ chín loại (`OWNER_ESCALATIONS`): `APPROVAL_REQUIRED` · `CREDENTIAL_REQUIRED` ·
`PAYMENT_REQUIRED` · `EXTERNAL_AUTH_REQUIRED` · `IRREVERSIBLE_BUSINESS_DECISION` ·
`PRODUCTION_INCIDENT` · `SECURITY_INCIDENT` · `POLICY_CONFLICT` · `UNKNOWN_HIGH_RISK_STATE` — cộng
những việc AGENTS.md mục 7 bắt buộc hỏi. Chờ hợp đồng của sứ mệnh khác là `EXTERNAL_DEPENDENCY`,
**không** phải việc của chủ shop.

Báo đúng năm dòng (`status` in ra từ `decision`): LOẠI · CHUYỆN GÌ · VÌ SAO MÁY KHÔNG TỰ LÀM TIẾP
ĐƯỢC · CHỦ SHOP CẦN LÀM ĐÚNG GÌ · SAU ĐÓ CÁI GÌ CHẠY TIẾP. Trong lúc chờ, làm tiếp việc READY khác.

Không hỏi: "làm tiếp không?", "thêm test không?", "tạo nhánh không?", "sửa tệp nào?", "mở PR
không?" — chính sách này đã trả lời.

## 15. Những thứ bị chặn có chủ đích

Hai agent sửa cùng lược đồ / cùng migration (SERIAL) · worker tự đổi hợp đồng chung (phiếu cấm +
`ready` bắt tệp ngoài phạm vi) · worker làm trên cây chính dùng chung · fan-out 20 agent (trần 4,
đếm cả máy) · nhánh không rõ chủ (phiếu = sở hữu) · nghĩa địa cây (`worktrees` + `cleanup`) · merge
tuỳ hứng (`next`/`ready`) · bỏ test vì "agent khác sẽ test" (phiếu bắt chạy) · coi lịch sử chat là
nguồn sự thật (git là nguồn) · reset/stash/clean cây khác (công cụ không có lệnh nào như thế — bài
kiểm quét mã nguồn) · bỏ qua cổng · hỏi chủ shop việc kỹ thuật thường · xây hạ tầng điều phối thay
vì làm việc kinh doanh (công cụ là một tệp; đừng thêm dịch vụ).

## 16. Chuyển tiếp: cây chính dùng chung và các sứ mệnh đang chạy

- **Cây `Code ERP` trên `main`**: không ai di chuyển, stash hay reset việc đang dở ở đó. Các phiên
  cũ làm xong tới điểm dừng an toàn thì đẩy lên nhánh riêng (mẫu ảnh chụp không xâm lấn ở AGENTS.md
  mục 9). Từ đó cây chính chỉ để đọc / `git pull`. Việc mới — kể cả hotfix — đi cây riêng.
- **`wt-master-mission`** và mọi sứ mệnh khác: **không bắt buộc** chuyển ngay. Áp dụng khi tới một
  điểm dừng tự nhiên, theo ba bước, không động tới mã sản phẩm của họ:
  1. `git merge origin/main` (sau khi AI Tech Room đã vào `main`) để có `scripts/ai-tech.ts` + `.ai/config.json`;
  2. `npm run ai -- new <id-su-menh>`, khai các việc còn lại; việc đang dở trong cây hiện tại thì
     khai `mode: "INLINE"` (cây Lead chính là cây đó) — không dựng lại cái đang chạy;
  3. từ việc mới tiếp theo trở đi dùng `next` / `spawn` / `ready` / `cleanup`.
  Hợp đồng sản phẩm (lược đồ SalesEvent, quy kết doanh thu, dashboard) vẫn của sứ mệnh đó; AI Tech
  Room chỉ thấy chúng dưới dạng `owns` / `readOnly` / điểm nóng mà sứ mệnh tự khai.
- **159 cây hiện có** (đo 05/10/2026: 55 đã vào `main` và sạch, 23 lâu không động) là của các phiên
  khác. Công cụ chỉ BÁO; dọn chúng là quyết định của chủ shop (`cleanup <cây> --allow-unowned --apply`
  từng cây, hoặc theo danh sách `worktrees --all`).

## 17. Đo hiệu quả điều phối

Không đếm số agent. Đo: thời gian từ READY tới MERGED · thời gian BLOCKED · chờ review · chờ CI ·
số lần `reconcile` ra CONFLICTS · số PR đỏ cổng lần đầu · số lần phải làm lại · số lần gọi chủ
shop. Các mốc lấy từ git (thời điểm commit, `run.createdAt`, `run.cleanedAt`) và GitHub — không
thêm sổ thứ hai.
