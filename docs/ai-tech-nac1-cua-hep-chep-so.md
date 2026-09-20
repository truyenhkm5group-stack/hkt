# Nấc 1 — Cửa hẹp chép sổ lượt chạy agent về production

Ngày 20/09/2026 · Nhánh `claude/charming-turing-kao6lw` · Migration `0107_agent_run_external_ref`

Chủ shop đã chốt **phương án B** cho Phase 2B, nguyên văn nguyên tắc phải giữ:

> *code chưa qua review không được chạy cạnh DB production*

Tài liệu này ghi lại chỗ hở mà nấc này bịt, thứ đã dựng, ba quyết định thiết kế đi ngược phác thảo
ban đầu, hai lỗi mà chính bộ kiểm thử tìm ra, và **việc còn lại của chủ shop**.

---

## 1. Chỗ hở, đo được

`/tech/agents` hiện **12/12 vai "0 lượt chạy · Chưa từng chạy"**, trong khi `agent-run.yml` đã chạy
THÀNH CÔNG (run #4 ngày 19/09, run #5 ngày 20/09). Không vai nào hỏng cả — sổ và runner nằm ở hai
máy không nhìn thấy nhau:

| | Runner agent | Sổ `tech_agent_runs` |
|---|---|---|
| Máy | GitHub Actions (dùng một lần) | VPS production |
| CSDL | PGlite trong `./data/agent-ci-db`, xoá cùng máy | PostgreSQL sau mạng docker, **không mở ra ngoài** |

Máy Actions không nối được PostgreSQL production, và **đó là tính chất phải giữ**, không phải thiếu
sót. Nới `DATABASE_URL` ra Internet cho tiện chép sổ là đánh đổi đúng thứ mà cả Phase 2A dựng lên.

Nên sổ đi về bằng một cửa HTTP hẹp.

---

## 2. Đã dựng gì

| Tệp | Vai trò |
|---|---|
| `lib/constants/agent-ingest.ts` | Hàm thuần: khoá tự nhiên, trần lượt gọi, độ tươi gói tin |
| `drizzle/0107_agent_run_external_ref.sql` | Cột `external_ref` + **khoá duy nhất** `tech_agent_runs_external_ref_uq` |
| `lib/tech/agent-run-ingest.ts` | TOÀN BỘ đường ghi. Chỉ TẠO, không SỬA, một bảng duy nhất |
| `lib/db/unique-violation.ts` | Nhận ra lỗi trùng khoá qua chuỗi `cause` (xem mục 4.1) |
| `app/api/tech/agent-run/route.ts` | Cửa POST, xác thực bằng `CRON_SECRET` |
| `scripts/agent-run-report.ts` | Bên gọi, chạy ở bước cuối của `agent-run.yml` |
| `tests/agent-run-ingest.test.ts` | Hàm thuần · đường ghi thật · quét mã nguồn |

### Cửa hẹp tới mức nào

- **Không nhận** tên bảng, tên cột, mệnh đề `where`, hay bất kỳ mảnh SQL nào. Lược đồ đầu vào là
  `.strict()`: một trường lạ làm **cả gói tin bị từ chối**, không bị bỏ qua im lặng. Một cửa "hẹp"
  mà lờ đi thứ nó không hiểu sẽ rộng dần theo mỗi người gọi.
- **Chỉ TẠO.** Gọi lại cùng khoá ⇒ trả về dòng cũ, không ghi gì. Không có đường viết lại lịch sử.
- **Không có `GET`**, không có đường phiên đăng nhập, không nhận bí mật trên URL (URL nằm trong
  access log của Caddy và log proxy — cùng bài học với `/api/sync/[job]`).
- **Ghi đúng một bảng**: `tech_agent_runs`. Không chạm một dòng dữ liệu nghiệp vụ nào — đơn hàng,
  vận đơn, tiền, tồn kho đều nằm ngoài tầm với.
- **Không đụng `tech_tasks.status`.** Một lượt chạy xong KHÔNG phải một việc xong; chuyển trạng thái
  việc là quyết định, và quyết định không đi qua một endpoint máy-gọi-máy.

Hình dạng đó được khoá bằng **quét mã nguồn**, không phải bằng một câu dặn trong tài liệu: khối 3
của `tests/agent-run-ingest.test.ts` đỏ nếu route mọc thêm một trường `table`/`sql`/`where`, mất
`.strict()`, mọc một `GET`, hay đường ghi mọc một lệnh `update`.

---

## 3. Ba quyết định đi ngược phác thảo ban đầu

### 3.1 MỘT thao tác `ingest`, không phải ba (`start` · `heartbeat` · `finish`)

Phác thảo dự tính ba thao tác để `/tech` thấy agent "đang chạy". Bản này chỉ chép lại lượt chạy
**ĐÃ KẾT THÚC**, và `RUNNING` bị từ chối thẳng. Lý do đầu là lý do thật:

1. **ERP không quan sát được một lượt chạy đang diễn ra ở máy khác.** Một dòng `RUNNING` trên
   production là lời khai không ai kiểm được — và nếu máy Actions chết giữa chừng thì nó nằm lại
   vĩnh viễn, đúng loại mồ côi mà `agent-reaper` phải đi dọn. Mở một cửa để tự sinh việc cho cái
   chổi là ngược.
2. Ba thao tác là ba đường ghi trên một endpoint hướng ra Internet.
3. Lớp lỗi "lượt chạy treo ở RUNNING" **không tồn tại** thay vì được xử lý.

Muốn thấy agent đang chạy thì đọc thẳng GitHub Actions — bên đang giữ sự thật.

### 3.2 Chống phát lại ở CSDL, không ở mã

Khoá tự nhiên `provider:runId:attempt`, khoá **DUY NHẤT** ở CSDL. Không phải một mệnh đề
`where not exists` — mệnh đề ấy luôn có cửa sổ đua giữa lúc đọc và lúc ghi, và một gói tin gửi lại
đúng lúc sẽ lọt qua.

`attempt` nằm **trong** khoá: chạy lại một workflow là một sự việc mới đáng xem. Gộp hai lần chạy
thành một dòng là giấu mất đúng cái lần người ta quan tâm (cùng luật với `tech_deployments`).

`NULL` = lượt chạy **nội bộ** (chạy tay, chạy trong bộ kiểm thử). Postgres cho nhiều `NULL` cùng tồn
tại dưới một khoá duy nhất — `tests/migration-upgrade-path.test.ts` chạy lệnh thật để chứng minh cả
hai vế, vì một khoá duy nhất đặt nhầm sẽ lặng lẽ chặn mọi lượt chạy nội bộ thứ hai.

**KHÔNG backfill**: lượt chạy đã có đều là lượt nội bộ, hoặc lượt trên máy Actions mà sổ production
chưa bao giờ thấy. Gán cho chúng một khoá ngoài là bịa ra một danh tính chưa từng tồn tại
(AGENTS.md mục 35).

### 3.3 Vai đang TẮT vẫn được chép sổ

Cửa này không cho phép agent làm gì cả — lượt chạy **đã** xảy ra rồi, ở một máy khác, dưới hàng rào
của chính máy đó. Từ chối ghi vì vai đang tắt là **xoá bằng chứng** về một việc đã xảy ra, thứ tệ
nhất một sổ quan sát có thể làm. Cờ `enabled` chặn ở chỗ **mở** lượt chạy (`startTechAgentRun`),
không phải ở chỗ ghi lại nó.

---

## 4. Hai lỗi do chính bộ kiểm thử tìm ra

### 4.1 `String(error)` không bao giờ thấy tên khoá — nhánh chống đua chết lặng

Đo thật trên PGlite: drizzle **bọc lại** lỗi của driver. `String(error)` trả về

```
Error: Failed query: insert into "tech_agent_runs" (...) values (...)
```

— không tên ràng buộc, không mã SQLSTATE. Cả hai nằm ở `error.cause`, thấp hơn một tầng.

Bản đầu viết `String(error).includes("tech_agent_runs_external_ref_uq")`. Hệ quả: nhánh *"khoá duy
nhất vừa chặn một lượt ghi song song — đọc lại dòng của kẻ thắng"* **không bao giờ chạy**. Lượt gọi
thua cuộc nhận một lỗi ghi, trong khi CSDL vừa làm đúng việc của nó. Đúng loại sai không hiện ra
cho tới ngày có hai gói tin tới cùng một mili giây — tức là đúng ngày cần nó chạy đúng nhất.

Chữa bằng `lib/db/unique-violation.ts`: đi hết chuỗi `cause`, hỏi mã `23505` **hoặc** câu chữ chuẩn
của Postgres, và khi có tên ràng buộc thì đòi **đúng tên** (hai khoá duy nhất khác nhau trên cùng
một bảng là hai sự việc khác nhau).

Bài kiểm ghim luôn cái bẫy: `assert.ok(!String(loiTrung).includes("<tên khoá>"))` — nó ghi lại vì
sao hàm kia tồn tại, để không ai "đơn giản hoá" nó về `String(error).includes` lần nữa.

### 4.2 `"07"` và `"7"` là cùng một lần chạy, nhưng ra hai khoá

`agentRunExternalRef` giữ nguyên câu chữ của `attempt`. Cùng một lần chạy lại, đọc từ hai chỗ khác
nhau, sẽ dựng ra hai khoá khác nhau — và khoá duy nhất ở CSDL **không cứu được**, vì với nó đó là
hai giá trị khác nhau. Nay `attempt` được chuẩn hoá về số.

---

## 5. Bước chép sổ KHÔNG được làm hỏng lượt chạy agent

Bước trong `agent-run.yml` mang `continue-on-error: true`, và đó là chủ ý: bằng chứng **thật** của
một lượt chạy là hiện vật `bang-chung-agent.json` + nhánh `ai/documentation/*` đã đẩy. Một lần ERP
bận không được làm cả lượt chạy agent trông như hỏng.

Chưa khai cấu hình thì script in **"CHƯA BẬT"** kèm chỗ khai, thay vì ném một lỗi mạng khó hiểu —
chưa biết không được in ra thành một kết luận (AGENTS.md mục 42).

---

## 6. VIỆC CỦA CHỦ SHOP — hai khoá cấu hình

Cửa đã dựng xong nhưng **chưa thông**, vì hai giá trị dưới đây chỉ chủ shop mới đặt được. Tôi
**không tự thêm** chúng: thêm một Repository secret thay chủ shop là đúng thứ đã được dặn không làm.

Settings → Secrets and variables → Actions:

| Loại | Tên | Giá trị |
|---|---|---|
| **Variable** | `ERP_BASE_URL` | Địa chỉ ERP công khai, ví dụ `https://<tên miền ERP>` |
| **Secret** | `CRON_SECRET` | **Đúng giá trị** `CRON_SECRET` đang nằm trong `.env` của VPS |

Đặt sai giá trị `CRON_SECRET` thì cửa trả 401 và bước chép sổ in ra điều đó — nó không âm thầm bỏ
qua. Chưa đặt thì mọi thứ vẫn chạy như hôm nay, chỉ là `/tech/agents` tiếp tục nói "0 lượt chạy".

Sau khi đặt: Actions → **Chạy agent Tech** → Run workflow, rồi mở `/tech/agents` — vai
`documentation` phải hiện lượt chạy vừa rồi, với bốn cổng đọc từ mã thoát thật.

---

## 7. Cổng đã chạy

| Cổng | Kết quả |
|---|---|
| `npm run typecheck` | sạch |
| `npm run lint` | sạch |
| `npm test` (ẩn danh, như CI) | **TẤT CẢ KIỂM THỬ ĐẠT** |
| `npm test` (có `GITHUB_TOKEN` giả) | **TẤT CẢ KIỂM THỬ ĐẠT** |
| `npm run build` | sạch |

Chạy `npm test` ở **cả hai** chế độ là luật riêng của kho này từ ngày 20/09: `gates.yml` không đưa
`GITHUB_TOKEN` vào bước `npm test`, nên một bài kiểm đo *môi trường của máy chạy* thay vì đo *mã
nguồn* sẽ xanh ở máy người viết và đỏ ở CI.

---

## 8. Nấc tiếp theo

- **Nấc 2** — nới phạm vi ghi của agent theo từng bước ĐÃ KIẾM ĐƯỢC: `tests/` → `lib/queries/`
  (báo cáo chỉ-đọc) → `app/(dashboard)/`. **Chưa bao giờ** `lib/actions/` hay `db/schema.ts`.
- **Nấc 3** — ERP bấm nút giao việc cho agent (`dispatchAgentWorkflow`), có hạn mức và nhật ký, chỉ
  R0/R1 đã duyệt.
- **Nấc 4** — worker đẩy trạng thái việc theo sự kiện GitHub thay vì theo nút bấm.
- **Nấc 5** — vòng phản hồi review: agent chạy lại trên **cùng một nhánh**.
- **Nấc 6** — tự deploy + nghiệm thu + quay lui.

Cổng giữa hai nấc: **5 lượt chạy sạch liên tiếp**, và chỉ số theo dõi là *tỷ lệ PR của agent được
gộp mà người không phải viết lại*, kèm *số lời khẳng định sai lọt vào tài liệu* (hai lượt đầu: 1
lời khai sai mỗi lượt, và là **cùng một** lời khai — xem `docs/ai-tech-nac0-agent-thuc-te.md`).

**R2 không bao giờ mở cho agent.** Giữ nguyên.
