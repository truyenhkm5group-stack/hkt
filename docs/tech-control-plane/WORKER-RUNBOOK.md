# Runbook — worker headless của Phòng Tech AI

*Tài liệu VẬN HÀNH, cho người trực máy chạy worker. Kiến trúc và lý do nằm ở
`docs/tech-control-plane/README.md` (mục 4 · 8 · 10) — file này chỉ nói: chuẩn bị gì, bấm gì, chạy lệnh nào,
và khi hỏng thì đọc ở đâu.*

Mọi điều dưới đây đọc trực tiếp từ mã: `scripts/tech-worker.ts`, `scripts/tech-worker/adapters.ts`,
`scripts/tech-worker/brief.ts`, `lib/constants/tech-worker.ts`, `lib/constants/tech-capabilities.ts`,
`lib/tech/worker-service.ts`, `lib/tech/delivery.ts`, `app/api/tech/worker/[op]/route.ts`,
`app/(dashboard)/tech/workers/*`. Không có mục nào là dự định.

---

## 1. Worker là gì, chạy ở đâu, và KHÔNG làm gì

Worker là **một tiến trình Node chạy trên máy của bạn** (`npm run tech:worker` →
`scripts/tech-worker.ts`, tự khai phiên bản `tech-worker/1`). Nó xin việc từ hàng đợi của `/tech`, làm việc
đó trong một **cây git riêng**, chạy cổng, rồi đẩy một nhánh lên remote.

Một lượt việc đi đúng trình tự sau (mỗi bước đều hiện ở `/tech/workers` qua ô "bước" + phần trăm):

| Bước | Worker làm gì |
|---|---|
| nhận việc | `POST /api/tech/worker/claim` — máy chủ chọn việc, cấp lease |
| dựng cây làm việc | `git fetch origin main` rồi `git worktree add` một cây tên `wt-tech-<mã-việc>-a<lần-thử>`, nhánh `ai/worker/<MÃ>-a<lần-thử>` |
| cài phụ thuộc | `npm ci --no-audit --no-fund --prefer-offline` trong cây đó |
| agent đang làm | gọi Claude Code CLI headless trong cây, với danh sách công cụ CHO PHÉP |
| chạy cổng | việc loại `DOCS`: `typecheck` + `lint`; mọi loại khác: `typecheck` + `lint` + `test` (`gatesForTask`) |
| commit + đẩy nhánh | **worker** commit (`user.name=tech-worker`) và `git push` — không phải agent |
| báo kết cục | `POST /api/tech/worker/complete` với một kết cục trong danh sách ĐÓNG |

Kết cục chỉ có bốn giá trị (`TECH_RUN_OUTCOMES`): `SUCCEEDED` · `FAILED` · `BLOCKED` · `NEEDS_OWNER`.
Câu chữ của model **không** đổi trạng thái việc: máy chủ quyết bằng `decideCompletion` —
`SUCCEEDED` ⇒ việc sang `REVIEW`; `FAILED` còn lượt thử ⇒ về hàng đợi sau lùi dần, hết lượt ⇒ `FAILED`;
`BLOCKED` ⇒ `BLOCKED`; `NEEDS_OWNER` ⇒ `NEEDS_OWNER`.

### Worker KHÔNG làm gì

- **Không nối thẳng CSDL.** Worker chỉ nói chuyện với ERP qua năm thao tác
  `POST /api/tech/worker/{hello,heartbeat,claim,start,complete}`. `DATABASE_URL` bị **xoá khỏi môi trường**
  trước khi chạy `npm ci` / cổng, và môi trường của tiến trình agent dựng từ **danh sách CHO PHÉP**
  (`ENV_ALLOW` trong `lib/constants/tech-worker.ts`) nên không biến nào lọt xuống vì "quên khai".
- **Không mở PR, không gộp, không deploy.** Worker chỉ `git push` một nhánh. PR do máy chủ dispatch bằng
  danh tính bot (`agent-open-pr.yml`, README mục 10); gộp là việc của người duyệt + Delivery Controller;
  deploy là một lượt dispatch riêng.
- **Không nhận việc rủi ro cao.** Chỉ `R0` / `R1` (`TECH_AUTONOMOUS_RISKS`). `R2` không bao giờ.
- **Không nhận năng lực người giữ.** Lúc đăng ký chỉ chọn được năng lực `autonomous` trong
  `lib/constants/tech-capabilities.ts`; `deploy-production`, `verify-production`, `code-review`,
  `security-review`, `database-migration`, `playwright-e2e`, `incident-response` bị từ chối ngay ở
  `registerTechWorker`.
- **Agent bên trong không chạm git ghi.** `toolAllowlist()` chỉ cho `Read`/`Edit`/`Write`/`Glob`/`Grep`,
  `git status` · `git diff` · `git log`, và `npm run typecheck` · `npm run lint` · `npx tsc` · `npx eslint`.
  Không mạng, không `npm install`, không `git commit`.
- **Không sửa gì trong `TECH_WORKER_REPO`.** Bản clone đó chỉ để `fetch` và dựng cây; cây làm việc nằm
  ngoài nó và bị gỡ sau mỗi lượt (nhánh giữ nguyên làm bằng chứng).

---

## 2. Chuẩn bị máy và đăng ký worker

### 2.1 Trên máy chạy worker

1. **Claude Code CLI phải gọi được.** `resolveClaudeBin()` tìm `claude.exe` (Windows) / `claude` trong
   `PATH`, cả đường npm `node_modules/@anthropic-ai/claude-code/bin/claude[.exe]`. Không tìm thấy ⇒ đặt
   `TECH_WORKER_CLAUDE_BIN` trỏ tới **tệp nhị phân thật** (không phải `claude.cmd`).
2. **Một bản clone RIÊNG của kho** cho worker, ví dụ `D:\tech-worker\hkt`. Thư mục phải có `.git`, nếu
   không worker thoát ngay với mã 2.
3. **Node + npm** dùng được (`npm ci` chạy trong mỗi cây làm việc; worker gọi `npm-cli.js` bằng
   `process.execPath`, giữ `shell: false`).
4. **Chỗ trống trên đĩa** cho cây làm việc + `node_modules` của nó. Cây nằm ở `TECH_WORKER_ROOT`, mặc định
   là thư mục **cha** của `TECH_WORKER_REPO`.

### 2.2 Đăng ký ở `/tech/workers`

Cần quyền `tech:manage` (`tech:view` chỉ để xem). Chỉ **NGƯỜI** đăng ký được — server action từ chối actor
không phải người.

Bấm **Đăng ký worker** rồi khai:

| Ô | Luật |
|---|---|
| Mã | chữ thường · số · gạch nối, 3–40 ký tự, bắt đầu bằng chữ; trùng mã ⇒ từ chối |
| Tên | để người đọc; bỏ trống thì lấy mã |
| Đường thi hành | `Claude Code · gói thuê bao` hoặc `Anthropic API · trả theo token` (xem mục 4) |
| Năng lực | chỉ các năng lực `autonomous`; mặc định tích `write-docs`, `fix-bug`, `implement-feature`, `unit-test` |

Bấm **Tạo worker** ⇒ hộp thoại hiện **khoá `tw_<id>.<secret>` ĐÚNG MỘT LẦN** kèm nguyên văn các lệnh cần
chạy (có nút **Chép lệnh**). CSDL chỉ giữ bản băm SHA-256, nên đóng hộp thoại là **không xem lại được**:
mất khoá ⇒ đăng ký worker mới và **Tắt** worker cũ.

Một worker chạy tối đa 4 việc cùng lúc (`TECH_LEASE.maxConcurrencyCeiling`), mặc định 1.

---

## 3. Ba chế độ chạy

### 3.1 Biến môi trường (đúng tên trong `scripts/tech-worker.ts`)

| Biến | Bắt buộc | Nghĩa |
|---|---|---|
| `TECH_WORKER_URL` | ✔ | gốc ERP, ví dụ `https://erp.vnxcommerce.com` (dấu `/` ở cuối bị cắt) |
| `TECH_WORKER_TOKEN` | ✔ | khoá riêng của worker, dạng `tw_<id>.<secret>` |
| `TECH_WORKER_REPO` | ✔ | bản clone riêng; cây làm việc dựng TỪ đây |
| `TECH_WORKER_ROOT` | | thư mục chứa cây làm việc — mặc định: thư mục cha của `TECH_WORKER_REPO` |
| `TECH_WORKER_TIMEOUT_MIN` | | trần một lượt agent, mặc định `45` (phút) |
| `TECH_WORKER_ANTHROPIC_API_KEY` | chỉ worker API | khoá API **riêng của worker** |
| `TECH_WORKER_CLAUDE_BIN` | | đường dẫn tới `claude.exe` / `claude` thật |

Thiếu một trong ba biến bắt buộc ⇒ worker in tên biến còn thiếu và thoát mã **2**. Worker **không bao giờ in
giá trị** của biến nào.

```
$env:TECH_WORKER_URL="https://erp.vnxcommerce.com"
$env:TECH_WORKER_TOKEN="tw_…"                 # /tech/workers → Đăng ký worker (hiện một lần)
$env:TECH_WORKER_REPO="D:\tech-worker\hkt"    # bản clone RIÊNG
```

### 3.2 `--check` — kiểm cấu hình, không xin việc

```
npm run tech:worker -- --check
```

Gọi `hello` (máy chủ xác thực khoá, trả mã worker · đường thi hành · các lượt còn mở) rồi gọi
`adapter.check()`, in một dòng:

```
worker <mã> · <đường thi hành> · <tên máy> · adapter SẴN SÀNG
```

hoặc `adapter KHÔNG CHẠY ĐƯỢC: <lý do>`. Thoát **0** khi adapter sẵn sàng, **3** khi không; **2** khi thiếu
biến / `TECH_WORKER_REPO` không phải kho git / máy chủ từ chối khoá. Chạy lệnh này sau mỗi lần đổi máy hoặc
đổi khoá — nó không nhận việc nào nên an toàn tuyệt đối.

### 3.3 `--once` — nhận đúng một việc rồi thoát

```
npm run tech:worker -- --once
```

Dùng để dogfood / kiểm tay. Hàng đợi không có gì thì in `không có việc: <lý do>` rồi thoát; lý do là một
trong `WORKER_DISABLED` (worker đang tắt) · `AT_CAPACITY` (đã đủ số việc song song) · `NO_CAPABILITY` (worker
không khai năng lực tự động nào) · `QUEUE_EMPTY` (không việc nào qua đủ mười lá chắn nhận việc).

### 3.4 Chạy mãi

```
npm run tech:worker
```

Đập nhịp tim mỗi **30 giây** (`TECH_LEASE.heartbeatSeconds`), xin việc khi đang rảnh, và nghỉ 60 giây giữa
hai lượt hỏi khi hàng đợi rỗng. Mỗi nhịp tim gửi kèm tối đa 200 dòng nhật ký (`maxLogLinesPerBeat`) và nhận
lại lệnh `CONTINUE` / `ABORT` cho từng lượt đang chạy.

> Nhật ký có trần: mỗi lượt giữ tối đa 2.000 dòng, mỗi dòng 2.000 ký tự; vượt thì lượt chạy được đánh dấu
> `logsTruncated`, không ghi thêm. `/tech/workers` hiện 20 lượt chạy cuối, 30 dòng nhật ký cuối mỗi lượt.

---

## 4. Worker gói thuê bao vs worker trả theo token API

**Đường thi hành do MÁY CHỦ quyết**, không do máy bạn: worker đọc `provider` từ phản hồi `hello` và dựng
adapter theo đó. Đặt thêm biến ở máy không đổi được cách tính tiền.

Cả hai adapter chạy **cùng một CLI** (Claude Code headless `-p`), khác nhau đúng một điều: **môi trường tiến
trình con**, dựng bởi `buildChildEnv()`:

|  | `SUBSCRIPTION_CLAUDE_CODE` | `ANTHROPIC_API` |
|---|---|---|
| Nhãn trên màn hình | Claude Code · gói thuê bao | Anthropic API · trả theo token |
| Khoá API trong môi trường con | **KHÔNG CÓ biến nào** | đúng một biến `ANTHROPIC_API_KEY`, giá trị lấy từ `TECH_WORKER_ANTHROPIC_API_KEY` |
| Thiếu khoá | không liên quan | `--check` trả `KHÔNG CHẠY ĐƯỢC` và worker không xin việc — **không mượn khoá của máy** |
| Lưới cuối | `assertBillingBoundary()` **ném lỗi và không chạy** nếu môi trường con có bất kỳ biến nào trong `API_BILLING_ENV` | không áp dụng |
| Tiền một lượt | CLI tự báo ⇒ ghi `estimated: true`, màn hình in `≈$… (ước tính, gói thuê bao)` | `estimated: false`, màn hình in `tiền API thật` |

`API_BILLING_ENV` — sáu biến có thể khiến Claude Code tính tiền theo API thay vì gói thuê bao:
`ANTHROPIC_API_KEY` · `ANTHROPIC_AUTH_TOKEN` · `CLAUDE_CODE_USE_BEDROCK` · `CLAUDE_CODE_USE_VERTEX` ·
`ANTHROPIC_BASE_URL` · `AWS_BEARER_TOKEN_BEDROCK`. Máy nào đang có một trong số đó cho mục đích khác thì
**không chạy worker gói thuê bao trên máy ấy**: `buildChildEnv` chỉ sao chép các biến trong `ENV_ALLOW` nên
biến lạ không đi xuống, nhưng nếu lọt vào bằng đường khác thì worker dừng thay vì âm thầm đổi đường
thanh toán.

Ngoài danh sách cho phép, môi trường con **luôn** có `ERP_READ_ONLY=1` và `CI=1`. Hai biến bị xoá tường minh
khỏi môi trường cổng: `TECH_WORKER_TOKEN` và `TECH_WORKER_ANTHROPIC_API_KEY` — `npm test` chạy mã mà agent
vừa sửa, nên nó không được thấy khoá nào.

---

## 5. Sự cố thường gặp

### 5.1 Worker mất nhịp tim ⇒ việc tự về hàng đợi

Đồng hồ: lease sống **300 giây**, worker gia hạn mỗi **30 giây**. Trạng thái sống của worker tính **lúc đọc**
(`workerLiveness`, không có cột nào lưu):

| Nhãn | Nghĩa |
|---|---|
| Chưa từng chạy | chưa có nhịp tim nào |
| Đang sống | nhịp tim cuối ≤ 90 giây |
| Chập chờn | 90 – 300 giây |
| Mất liên lạc | > 300 giây |

Lease hết hạn thì `reapExpiredTechLeases` đóng lượt chạy đang mở (`FAILED`, lý do mất nhịp tim), nhả lease và
**đưa việc về hàng đợi nếu còn lần thử**: lùi dần 5′ → 10′ → 20′ … trần 60′, tối đa 3 lần thử
(`defaultMaxAttempts`); hết lượt ⇒ việc thành `FAILED` (vẫn mở, hiện ở nhóm thất bại).

Việc thu hồi chạy **lười** — tự chạy ở mỗi lượt `claim`. Không muốn đợi worker nào hỏi thì bấm **Thu hồi
lease hết hạn** trên `/tech/workers` (cần `tech:manage`); nút báo lại đã thả bao nhiêu việc.

**Khởi động lại worker sau khi sập:** `hello` trả danh sách lượt còn mở và worker in
`còn N lượt mở từ lần chạy trước — không nhận lại`. Đúng như vậy: nó **không** nhận lại; lease của chúng hết
hạn rồi việc được thả về hàng đợi. Nhánh của lần thử trước giữ nguyên (tên nhánh mang số lần thử nên lần
sau không đè lên).

**Worker cũ sống lại và nộp kết quả muộn:** máy chủ chặn bằng fencing token `lease_generation` và trả **409**
với `RUN_NOT_YOURS` / `RUN_CLOSED` / `STALE_LEASE`. Đây là câu trả lời **bình thường**, không phải lỗi máy
chủ — việc đã thuộc lượt khác, kết quả muộn không được đè.

### 5.2 CI đỏ trên PR của worker

Worker đã chạy cổng trước khi đẩy, nhưng cổng của worker chỉ là lọc sớm — bộ đầy đủ vẫn là `gates / gates`
trên PR. Khi bộ đồng bộ PR ghi sự kiện `ci.failed`, `handleCiFailure` tự mở **một việc con năng lực
`ci-debug`** trên **chính nhánh đó**: worker nhận việc này sẽ checkout `origin/<nhánh>` và đẩy tiếp lên cùng
nhánh, nên **PR tự cập nhật và CI chạy lại** — không có PR thứ hai.

`ciFixDecision` quyết định, và chỉ bốn tình huống ngoài việc mở phiếu sửa:

| Phán quyết | Nghĩa — bạn phải làm gì |
|---|---|
| `NOT_WORKER` | nhánh không bắt đầu bằng `ai/worker/` ⇒ PR của người, **người sửa** |
| `NOT_OPEN` | PR không còn mở ⇒ không làm gì |
| `FIX_IN_FLIGHT` | đang có một việc sửa chưa xong ⇒ đợi, một đợt đỏ chỉ một việc sửa |
| `EXHAUSTED` | đã dùng hết `CI_FIX_MAX = 2` lượt sửa ⇒ việc gốc sang `FAILED` kèm ghi chú, **người mở PR ra xem** |

Việc con `ci-debug` nhận đúng đề bài: đọc lỗi cổng rồi sửa **mã** cho xanh — "không sửa giá trị kỳ vọng của
bài kiểm để cho xanh; không nới cổng". Nếu một lượt sửa mà cổng bị nới thì đó là lỗi phải chặn ở review, không
phải cách dùng đúng của đường này.

### 5.3 Dừng một worker

Có ba cách, hệ quả khác nhau:

1. **Tắt worker trên `/tech/workers`** (nút **Tắt**, cần `tech:manage`). Worker không nhận việc mới
   (`claim` trả `WORKER_DISABLED`), và **lượt đang chạy nhận lệnh `ABORT` ở nhịp tim kế tiếp** — tức trong
   vòng 30 giây. Worker huỷ tiến trình agent và **không commit gì**. Huỷ là **hợp tác**: máy chủ không giết
   được tiến trình trên máy khác, nó chỉ nói "dừng".
2. **Người đổi trạng thái việc** (huỷ việc, chuyển sang "Cần chủ shop"…). Nhịp tim trả `ABORT` với lý do
   `TASK_<trạng-thái>` vì việc đã ra khỏi `SPEC_READY` / `BUILDING`. Kết quả nộp muộn không đè quyết định của
   người.
3. **Dừng tiến trình ở máy** (Ctrl+C / kill). Nhanh nhất nhưng việc **không** được thả ra ngay: phải đợi
   lease hết hạn (tối đa 5 phút) hoặc bấm **Thu hồi lease hết hạn**. Muốn dừng "sạch" một lượt đang chạy thì
   dùng cách 1.

Tắt worker **không** làm mất gì trong hàng đợi: việc vẫn nằm đó, lease tự nhả, và bật lại là chạy tiếp.
