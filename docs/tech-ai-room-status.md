# Phòng Tech AI — trạng thái

> **File trạng thái DUY NHẤT.** Mọi milestone cập nhật vào đây, không mở file mới.
> Cập nhật gần nhất: **20/09/2026** · `main` = `5677526` · production đang chạy `5677526`

---

## DONE

| # | Milestone | Bằng chứng |
|---|---|---|
| Nấc 0 | Agent chạy thật hai lượt trên GitHub Actions, hàng rào giữ được | PR #44 · `agent-run.yml` run #4, #5 |
| Nấc 1a | Cửa hẹp `POST /api/tech/agent-run` + khoá duy nhất `tech_agent_runs.external_ref` | **PR #46 merged** · deploy **#366 success** |
| — | Migration `0107` áp trên production | `db-query` run `35504329310`: `external_ref`=1 · `tech_agent_runs_external_ref_uq`=1 · 108 migration |
| — | Ba job deploy xanh gồm cả kiểm HTTPS từ bên ngoài | run #366: `build_image` · `gates` · `release` |

### Kèm theo Nấc 1b (PR hiện tại) — sửa ba lỗi "bài kiểm đo cái máy, không đo mã nguồn"

Bộ kiểm thử **không chạy được trên Windows**, tức là workspace duy nhất còn lại không tự kiểm
chứng được gì. Ba nguyên nhân, đều là lớp lỗi AGENTS.md mục 50:

| Lỗi | Đo được | Sửa ở tầng nào |
|---|---|---|
| Kho không có `.gitattributes`, `core.autocrlf=true` ⇒ **1.302 tệp CRLF** trên đĩa còn CI đo LF. `indexOf("\n}\n")` trả `-1`, `slice(0,1)` ra `"f"` | `cs-workqueue` ĐỎ trên Windows, XANH trên CI — cùng một commit | `.gitattributes` `* text=auto eol=lf` — sửa cả lớp, không vá từng bài |
| `path.relative()` trả `\` trên Windows, `/` trên Linux ⇒ khoá tra cứu khác nhau | `care-reopen`, `bank-ledger` | `.split(path.sep).join("/")` (thành ngữ sẵn có của kho) |
| `spawn("npm", {shell:false})` ⇒ ENOENT; `spawn("npm.cmd", {shell:false})` ⇒ **EINVAL** (Node chặn `.cmd` sau CVE-2024-27980) | `tech-phase2a::testAgentRunner` | Gọi thẳng `npm-cli.js` bằng `process.execPath`. **KHÔNG** bật `shell: true` — đó là hàng rào của agent |

`flock` không có trên Git Bash ⇒ `ops-concurrency::testKhoaChayThat` in **"CHƯA ĐO ĐƯỢC trên win32"**
và **ĐỎ nếu thiếu `flock` trên Linux** — một câu trung thực, không phải một dấu ✓ giả.

---

## CURRENT

**Nấc 1b — thu HUMAN GATE từ hai thao tác xuống một.**

Bản đầu đòi `ERP_BASE_URL` (Variable) + `CRON_SECRET` (Secret). Cả hai đã bỏ được:

- `ERP_BASE_URL` → suy từ `vars.ERP_DOMAIN || 'erp.vnxcommerce.com'`, đúng nguồn `deploy-vps.yml`
  đang dùng. Hai chỗ khai cùng một giá trị là hai chỗ để chúng lệch nhau.
- `CRON_SECRET` → **không dùng nữa**. Nó chỉ sinh trên VPS (`install-vps.sh`) nên lấy được đòi SSH,
  và nó mở được **cả bộ lập lịch** (hàng chục job, có job GHI hàng loạt). Đưa nó lên một máy chạy
  mã chưa review là đánh đổi bán kính thiệt hại lấy một dòng cấu hình.

Thay bằng **`AGENT_INGEST_SECRET`** — khoá riêng, mở đúng một đường ghi vào một bảng quan sát.
Deploy tự mang xuống `.env` theo đúng đường `ERP_GITHUB_TOKEN` và ba khoá SePay đã đi.

Cổng đã chạy: `typecheck` · `lint` · `npm test` (**TẤT CẢ KIỂM THỬ ĐẠT**) · `build` — sạch cả năm.

---

## BLOCKED / HUMAN GATE

> ### ⛔ MỘT thao tác, ~30 giây, làm một lần
>
> **GitHub → repo `hkt` → Settings → Secrets and variables → Actions → tab *Secrets* →
> *New repository secret***
>
> | Ô | Điền |
> |---|---|
> | **Name** | `AGENT_INGEST_SECRET` |
> | **Secret** | một chuỗi ngẫu nhiên bất kỳ (ví dụ kết quả `openssl rand -hex 24`) |
>
> → **Add secret**. Hết.
>
> **Không** cần SSH · **không** cần sửa `.env` · **không** đụng `CRON_SECRET` · **không** tạo lại ba
> secret danh tính agent (chúng ở Environment `agent-identity` và phải ở nguyên đó).
>
> Chưa đặt thì mọi thứ chạy như hôm nay: bước chép sổ in "CHƯA BẬT" kèm chỗ khai, **không** làm lượt
> chạy agent đỏ, và `/tech/agents` tiếp tục nói "0 lượt chạy" — một câu ĐÚNG.

Sau khi đặt, tôi tự chạy tiếp: deploy để mang khoá xuống `.env` → chạy `agent-run.yml` thật →
chứng minh lượt chạy hiện trong sổ production.

---

## NEXT — backlog tới mục tiêu cuối

| Nấc | Nội dung | Phụ thuộc |
|---|---|---|
| **1c** | Chạy `agent-run.yml` thật, chứng minh lượt chạy xuất hiện ở `/tech/agents` production | HUMAN GATE ở trên |
| **2** | Nới phạm vi ghi của agent theo bước ĐÃ KIẾM ĐƯỢC: `tests/` → `lib/queries/` (báo cáo chỉ-đọc) → `app/(dashboard)/`. **Không bao giờ** `lib/actions/`, `db/schema.ts` | 1c + 5 lượt chạy sạch liên tiếp |
| **3** | ERP bấm nút giao việc (`dispatchAgentWorkflow`), có hạn mức + nhật ký, chỉ R0/R1 đã duyệt | 2 |
| **4** | Worker đẩy trạng thái việc theo sự kiện GitHub thay vì theo nút bấm | 3 |
| **5** | Vòng phản hồi review: agent chạy lại trên **cùng một nhánh** | 4 |
| **6** | Tự deploy + nghiệm thu + quay lui; migration nối deployment↔task (ADR đã viết, chưa làm) | 5 |
| **B6** | Tách lỗi AI theo mốc/nhà cung cấp/mã lỗi — phân biệt dư âm OpenAI hết credit với lỗi mới. **Không ghi dữ liệu production khi chẩn đoán** | — (làm song song được) |
| **Luật** | Thêm vào AGENTS.md luật "bài kiểm đo MÃ NGUỒN, không đo máy đang chạy" + ma trận CI hai chế độ (ẩn danh / có token GIẢ). Phải là PR riêng vì nó sửa `gates.yml` | — |

**Cổng giữa hai nấc:** 5 lượt chạy sạch liên tiếp. Chỉ số theo dõi: tỷ lệ PR của agent được gộp mà
người không phải viết lại, kèm số lời khẳng định sai lọt vào tài liệu (hai lượt đầu: 1 lời/lượt, và
là **cùng một** lời — xem `docs/ai-tech-nac0-agent-thuc-te.md`).

**R2 không bao giờ mở cho agent.** Giữ nguyên.

---

## Production proof

| Mục | Giá trị | Nguồn |
|---|---|---|
| `main` | `5677526` | merge PR #46 |
| Production đang chạy | `5677526` | deploy #366, bước "Kiểm tra HTTPS từ bên ngoài" xanh |
| Migration đã áp | **108** | `db-query` run `35504329310` |
| `tech_agent_runs.external_ref` | cột **có** · khoá duy nhất **có** | cùng lượt trên |
| Lượt chạy trong sổ production | **0** | cùng lượt trên — cửa chưa thông, chờ HUMAN GATE |
| Vai agent | 12 | cùng lượt trên |

## PR / deploy SHA

| | |
|---|---|
| PR #46 | merged · head `759af1d` · squash-merge thành `5677526` |
| Deploy | run **#366** · `5677526` · success · 3/3 job |
| `db-query` kiểm chứng | run `35504329310` · success |
| Nhánh WIP đã bảo toàn | `wip/vtp-integration-before-tech-ai` · `e03e8b4` (KHÔNG gộp vào Tech AI) |
