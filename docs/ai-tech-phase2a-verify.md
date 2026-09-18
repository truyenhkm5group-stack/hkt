# Phase 2A — kiểm chứng thật: còn thiếu đúng hai chiếc chìa khoá

*Cập nhật 18/09/2026. Đọc cùng `docs/ai-tech-phase2a.md` (thiết kế) và `AGENTS.md`.*

Phase 2A đã có đủ **mã**: tích hợp GitHub chỉ-đọc, sổ quan sát deploy, phép chiếu việc Tech lên
`/work`, runner agent có hàng rào. Bước này đi tìm **bằng chứng production** cho hai việc, và
dừng lại ở chỗ chúng thật sự bị chặn.

| Việc | Tình trạng | Cần gì |
| --- | --- | --- |
| Đồng bộ deploy GitHub chạy thật | **không còn chặn** | không cần gì — kho public đọc được không cần token |
| Agent DOCUMENTATION R0 chạy thật | **CHƯA** | một khoá AI trên máy runner |

Chỗ còn lại là **CHƯA BIẾT**, không phải *đã chạy và hỏng*, và cũng không phải *0*: `tech_agent_runs`
không có dòng nào, đúng như phải thế khi chưa có khoá.

## 1 · Vì sao trước bước này token không bao giờ tới được máy chủ

Audit toàn bộ đường cấu hình:

| Tệp | Trước | Sau |
| --- | --- | --- |
| `.github/workflows/deploy-vps.yml` | không truyền ba biến `ERP_GITHUB_*` | truyền qua `env` + `envs` + `export` |
| `scripts/install-vps.sh` | không ghi, không giữ | ghi ở cả hai nhánh (máy mới / máy đã có `.env`) |
| `.github/workflows/ops-vps.yml` | không có thao tác đặt cấu hình | thêm `apply-tech-github-env` |
| `scripts/bootstrap.sh` | chỉ ghim mã nguồn | không đổi (uỷ quyền ghi `.env` cho install) |

Chỗ duy nhất có chữ `GITHUB_TOKEN` trong `deploy-vps.yml` là token GHCR của **lần chạy**, chết
ngay khi workflow kết thúc — ghi nó vào `.env` là ghi một khoá đã hết hiệu lực.

Hậu quả của lỗ hổng này không tự lộ ra: trang Deploy nói *"chưa cấu hình"* mãi mãi, và không ai
đọc dòng đó như một lỗi cấu hình — họ đọc nó như *"chưa có lượt deploy nào"*.

## 2 · Token GitHub là TUỲ CHỌN, không phải điều kiện

Kho `truyenhkm5group-stack/hkt` đang **PUBLIC**, và GitHub cho đọc workflow + lượt chạy của kho
public **không cần xác thực**. Bắt chủ shop tạo một PAT chỉ để đọc thứ ai cũng đọc được là dựng
một rào cản không bảo vệ gì — và tệ hơn, nó làm *"chưa cấu hình"* với *"không có lượt deploy nào"*
trông giống hệt nhau trên màn hình.

| Có gì | ERP làm gì | Hạn mức |
| --- | --- | --- |
| `ERP_GITHUB_REPO` (workflow deploy tự truyền) | gọi ẩn danh, **không** gửi `Authorization` | 60 request/giờ theo IP máy chủ |
| thêm `ERP_GITHUB_TOKEN` | gửi `Authorization: Bearer …` | 5.000 request/giờ |

Một lượt đồng bộ tốn **đúng một** request, và job này chạy tay (không có lịch), nên 60/giờ là dư.

### Tên kho cũng không phải gõ

`deploy-vps.yml` truyền `ERP_GITHUB_REPO=${{ vars.ERP_GITHUB_REPO || github.repository }}`.
Workflow deploy là chỗ biết chắc hôm nay đang triển khai kho nào — bắt người gõ lại là thêm một
chỗ để gõ sai cho một thông tin máy đã cầm sẵn.

### Năm cách hỏng, năm cách sửa

Gộp lại thành "không kết nối được" là đẩy người đọc đi sửa nhầm chỗ:

| Loại | Nghĩa | Sửa ở đâu |
| --- | --- | --- |
| `NOT_CONFIGURED` | chưa biết đọc kho nào | chạy một lượt deploy |
| `RATE_LIMITED` | hết hạn mức (403 + `x-ratelimit-remaining: 0`) | **chờ** — hoặc thêm token |
| `AUTH_FAILED` | có token nhưng token sai | xoá token, hoặc thay token |
| `NOT_FOUND` | sai tên kho / tên tệp workflow | `.env`; kho private thì mới cần token |
| `NETWORK` | máy chủ không ra được api.github.com | mạng, không phải token |

`RATE_LIMITED` là loại quan trọng nhất phải tách riêng: GitHub báo nó bằng **403**, không phải
429, nên một bộ dò chỉ nhìn mã trạng thái sẽ gọi nhầm nó là "thiếu quyền" và gửi người vận hành
đi tạo token mới cho một thứ tự khỏi sau mười lăm phút.

### Khi nào mới cần token

Đúng hai trường hợp, và thao tác ops `apply-tech-github-env` vẫn giữ nguyên cho chúng:

1. Kho chuyển sang **private** — lượt gọi ẩn danh khi đó luôn thấy 404.
2. Gặp lỗi **hạn mức** — 60 request/giờ dùng chung cho cả máy chủ.

Fine-grained PAT → Repository permissions → **Actions: Read-only** (+ Contents: Read-only).
Secret `ERP_GITHUB_TOKEN` → Actions → *Vận hành ERP trên VPS* → `apply-tech-github-env`.

## 2.3 · Khởi tạo sổ agent, rồi bật ĐÚNG MỘT vai

`/tech/agents` → nút **“Khởi tạo sổ agent”**. Mẫu trong mã nguồn không tự kích hoạt (AGENTS.md
mục 23): 12 vai sinh ra ở trạng thái **TẮT**, và bấm lại không nhân đôi sổ. Chỉ **người** khởi
tạo được — `seedTechAgents()` từ chối mọi người thao tác không phải `HUMAN`.

Sau đó bật **duy nhất** vai `documentation`: `allowedRisks: ["R0"]`, `canMerge / canDeploy /
canRunProdWrite` đều `false`.

## 2.4 · Máy runner — việc duy nhất còn lại

Chạy `npm run agent:check` trên máy định dùng làm runner. Nó trả lời trong hai giây, và KHÔNG in
một ký tự bí mật nào — chỉ CÓ/KHÔNG và DÙNG ĐƯỢC/KHÔNG:

```
▶ Máy runner        git · Node · cây làm việc có sạch không
▶ Hàng rào          4 lệnh nguy hiểm mẫu còn bị chặn · 10 biến bí mật còn bị gỡ
▶ Khoá AI           gọi thật một lượt ping rẻ

KẾT LUẬN: READY | MISSING | AUTH_FAILED | QUOTA_OR_RATE_LIMIT | PROVIDER_ERROR
```

Bốn kết luận cuối là bốn cách sửa khác nhau, và không cái nào là "agent hỏng" — gộp chúng lại là
đổ cho agent một thứ agent chưa từng chạy.

### Khoá AI

Máy runner là máy có kho git + npm + khoá AI. **KHÔNG phải container production**: production là
ERP + PostgreSQL + scheduler + Caddy, và biến nó thành máy build là mở một bề mặt tấn công mới
trên chính chỗ giữ tiền của shop.

Khuyên dùng `ANTHROPIC_API_KEY` **riêng cho runner**, không dùng chung khoá AI Copilot đang chạy
production: lỗi 429 của Copilot sẽ lẫn vào lỗi của runner và không ai phân biệt được cái nào hỏng.

Khoá nằm trong **môi trường của máy runner** — không trong `tech_tasks`, không trong CSDL, không
trong log, không trong prompt. `sandboxEnv()` gỡ nó ra khỏi mọi tiến trình con của agent, nên
chính agent không đọc được khoá đang trả tiền cho nó.

Chưa có khoá thì `executor.available()` trả `ok=false` và lượt chạy dừng ở **BLOCKED — CHƯA CẤU
HÌNH**. Đó là hành vi ĐÚNG, và nó khác hẳn "đã chạy xong".

## 2.5 · Máy xếp rủi ro CHẶN NHẦM việc tài liệu — hai lần, vì hai lý do khác nhau

Việc R0 đầu tiên được soạn đúng như đặc tả yêu cầu (module `PLATFORM`, mô tả nhắc "giới hạn
**quyền** của vai tài liệu"). Máy xếp nó là **R2**. Đo thật:

| Module | Mô tả | Kết quả | Luật khớp |
| --- | --- | --- | --- |
| `PLATFORM` | có chữ "quyền" | **R2** | `ACCESS` |
| `PLATFORM` | không có chữ "quyền" | **R1** | `INFRA` |
| `TECH` | có chữ "quyền" | **R2** | `ACCESS` |
| `TECH` | không có chữ "quyền" | **R0** | không luật nào |

Hai lỗi dương tính giả, và cả hai đều đáng biết:

1. **`ACCESS` khớp từ khoá `quyen` ở bất kỳ đâu trong tiêu đề hoặc mô tả.** Một việc *mô tả* giới
   hạn quyền bị xếp ngang với một việc *thay đổi* quyền. Máy đọc chữ, không đọc ý.

2. **`classifyTechRisk()` khớp module / loại việc / từ khoá bằng phép HOẶC.** Luật `INFRA` khai cả
   `taskTypes: ["INFRA"]` lẫn `modules: ["PLATFORM"]` — rõ ràng có ý là "việc hạ tầng TRONG module
   nền tảng" — nhưng phép HOẶC làm **mọi** việc thuộc module `PLATFORM` tự động ít nhất R1, kể cả
   một việc chỉ viết một tệp markdown.

**Đã KHÔNG đè mức rủi ro** (đặc tả cấm, và đè là đúng thứ làm cổng phê duyệt thành vô nghĩa).
Thay vào đó việc được khai lại cho ĐÚNG với thứ nó làm: module `TECH` (việc của Phòng Tech, không
phải thay đổi hạ tầng), và mô tả nói "những việc vai tài liệu **KHÔNG được làm**" thay vì "giới
hạn **quyền**" — cùng một nội dung agent phải viết ra, nhưng không còn khẳng định sai rằng việc
này chạm tới quyền.

**Cũng KHÔNG sửa máy xếp rủi ro trong lượt này.** Chuyển `INFRA` sang phép VÀ sẽ HẠ mức của nhiều
việc đang có, mà luật của máy là *chỉ nâng, không bao giờ hạ*. Chặn nhầm là hướng an toàn; nới ra
là quyết định của chủ shop, không phải của một lượt dọn dẹp. Nhưng nó đáng biết: mọi việc trong
module `PLATFORM` hiện không bao giờ tới tay agent R0 được.

## 3 · Chín hàng rào — đã kiểm, KHÔNG phải bằng cách thử phá máy chủ thật

`tests/tech-phase2a.test.ts::testPhase2aBarriers()` chạy trên kho git tạm + CSDL kiểm thử:

| # | Hàng rào | Kết quả |
| --- | --- | --- |
| 1 | việc **R1** giao cho agent tài liệu | BLOCKED, nêu đúng mức rủi ro |
| 2 | việc **R2** | BLOCKED |
| 3 | **agent đang tắt** | BLOCKED trước khi mở lượt chạy — không để lại rác |
| 4 | **R0 → R2 giữa chừng** | dừng TRƯỚC commit, lượt chạy đóng lại `CANCELLED` |
| 5 | 7 **lệnh cấm** (push, merge, ssh, psql, printenv, curl, npm install) | hàng rào từ chối kèm lý do |
| 6 | 5 đường **ghi ngoài phạm vi** + đọc `.env` | chặn, `.env` kho gốc nguyên vẹn |
| 7 | **thiếu khoá API** | BLOCKED "CHƯA CẤU HÌNH", không chạy một vòng nào |
| 8 | agent **tự phê duyệt** / tự hạ rủi ro / tự bật chính nó | cả ba đều bị từ chối |
| 9 | agent **tự deploy** | xem dưới |

Hàng rào 9 **đỏ trước bước này**. Phép thử thật trên CSDL kiểm thử:

```
AI recordTechDeployment: {"ok":true,"id":"6bf625a2-…"}
AI updateTechDeployment: {"ok":true}
```

ERP không kích hoạt được deploy (client GitHub chỉ `GET`), nhưng hai đường trên là **lời khẳng
định về production**: `tech_deployments` là sổ QUAN SÁT, nên một dòng agent gõ vào trông y hệt
dòng lượt đồng bộ nạp về — một lượt deploy **chưa từng xảy ra** vẫn đọc ra như đã xảy ra, và
phép đối chiếu commit (`VERIFIED` / `MISMATCH`) khi đó đứng trên một quan sát bịa. Tương tự,
`READY_TO_DEPLOY` đọc ra là *"việc này sẵn sàng ra production"* — agent tự dán nhãn đó lên việc
của chính nó là AI tự chấm mình ở đúng chỗ tốn kém nhất.

Bản vá: `chanAgent()` trong `lib/tech/service.ts`, chặn **đích danh `AI_AGENT`** ở ba chỗ. Cố ý
KHÔNG đòi `HUMAN`: lượt đồng bộ GitHub ghi thẳng với `actorKind: "SYSTEM"` và không đi qua hai
hàm đó, nên một job nền của hệ thống vẫn ghi được sổ quan sát. Bài kiểm khẳng định cả chiều
ngược — người vẫn ghi và sửa được; cổng chặn AGENT, không chặn việc.

## 4 · Việc R0 đầu tiên, khi đã có khoá

Tạo qua Tech Control Plane (`/tech/tasks`), loại **DOCS**, module **PLATFORM**, ưu tiên P3.
Máy phải tự xếp **R0** — nếu nó ra R1/R2 thì luật rủi ro đã đổi, và phải hiểu vì sao trước khi
chạy, không đè mức.

Mô tả giới hạn agent chỉ được tạo/sửa **một tệp**: `docs/ai-tech-agent-runner-proof.md`, gồm mã
việc, base SHA, nhánh, giới hạn quyền của agent tài liệu, các cổng đã chạy, và câu
*"Agent không merge, không deploy"*.

Trên máy runner, kho sạch ở đúng `origin/main`:

```
npm run agent:run -- --task <TECH-xx> --agent documentation --gates typecheck,lint,test,build --keep
```

Rồi **DỪNG**: nhánh `ai/documentation/TECH-xx` ở lại để người đọc diff. Không merge. Không deploy.
Output sai thì ghi lượt chạy là **không đạt** — che một lượt hỏng đầu tiên là dạy cả hệ thống nói dối.
