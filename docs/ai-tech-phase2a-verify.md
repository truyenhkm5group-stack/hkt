# Phase 2A — kiểm chứng thật: còn thiếu đúng hai chiếc chìa khoá

*Cập nhật 18/09/2026. Đọc cùng `docs/ai-tech-phase2a.md` (thiết kế) và `AGENTS.md`.*

Phase 2A đã có đủ **mã**: tích hợp GitHub chỉ-đọc, sổ quan sát deploy, phép chiếu việc Tech lên
`/work`, runner agent có hàng rào. Bước này đi tìm **bằng chứng production** cho hai việc, và
dừng lại ở chỗ chúng thật sự bị chặn.

| Việc | Tình trạng | Chặn ở đâu |
| --- | --- | --- |
| Đồng bộ deploy GitHub chạy thật | **CHƯA** | thiếu Secret `ERP_GITHUB_TOKEN` |
| Agent DOCUMENTATION R0 chạy thật | **CHƯA** | thiếu khoá AI trên máy runner |

Hai ô ấy là **CHƯA BIẾT**, không phải *đã chạy và hỏng*, và cũng không phải *0*. Không có dòng
nào trong `tech_deployments` và không có dòng nào trong `tech_agent_runs` — đúng như phải thế.

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

## 2 · Chủ shop cần làm gì (hai việc, mỗi việc vài phút)

### 2.1 Token GitHub CHỈ ĐỌC

1. GitHub → Settings → Developer settings → **Fine-grained tokens** → Generate new token.
2. Repository access: chỉ kho `truyenhkm5group-stack/hkt`.
3. Repository permissions: **Actions: Read-only**. Thêm **Contents: Read-only** nếu GitHub đòi.
   KHÔNG cấp quyền ghi, KHÔNG `workflow`, KHÔNG `administration`.
4. Settings → Secrets and variables → Actions → New repository secret → tên `ERP_GITHUB_TOKEN`.
5. Actions → **Vận hành ERP trên VPS** → action = `apply-tech-github-env` → Run.
   Thao tác này chỉ ghi ba biến vào `.env`, khởi động lại app + scheduler, rồi hỏi GitHub một câu
   chỉ-đọc. Nó **không deploy**, không chạy migration, không đụng một dòng dữ liệu nghiệp vụ nào,
   và chỉ in **độ dài** token chứ không bao giờ in giá trị — kho mã này PUBLIC.

Sau đó: Actions → Vận hành ERP trên VPS → action = `run-job`, ô **arg** = `github-deployments --limit=20`.

### 2.2 Khoá AI cho MÁY RUNNER

Máy runner là máy có kho git + npm + khoá AI. **KHÔNG phải container production**: production là
ERP + PostgreSQL + scheduler + Caddy, và biến nó thành máy build là mở một bề mặt tấn công mới
trên chính chỗ giữ tiền của shop.

Khuyên dùng `ANTHROPIC_API_KEY` **riêng cho runner**, không dùng chung khoá AI Copilot đang chạy
production: lỗi 429 của Copilot sẽ lẫn vào lỗi của runner và không ai phân biệt được cái nào hỏng.

Khoá nằm trong **môi trường của máy runner**, không nằm trong `tech_tasks`, không trong CSDL,
không trong log, không trong prompt. `sandboxEnv()` gỡ nó ra khỏi mọi tiến trình con của agent,
nên chính agent không đọc được khoá đang trả tiền cho nó.

Chưa có khoá thì `executor.available()` trả `ok=false` và lượt chạy dừng ở **BLOCKED — CHƯA CẤU
HÌNH**. Đó là hành vi ĐÚNG, và nó khác hẳn "đã chạy xong".

### 2.3 Khởi tạo sổ agent, rồi bật ĐÚNG MỘT vai

`/tech/agents` → nút **“Khởi tạo sổ agent”**. Mẫu trong mã nguồn không tự kích hoạt (AGENTS.md
mục 23): 12 vai sinh ra ở trạng thái **TẮT**, và bấm lại không nhân đôi sổ. Chỉ **người** khởi
tạo được — `seedTechAgents()` từ chối mọi người thao tác không phải `HUMAN`.

Sau đó bật **duy nhất** vai `documentation`. Vai này khai sẵn trong mã: `allowedRisks: ["R0"]`,
`canMerge / canDeploy / canRunProdWrite` đều `false`. Không bật vai nào khác ở Phase 2A.

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
