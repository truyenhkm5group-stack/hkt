# Phase 2A — Kích hoạt Phòng Tech AI có kiểm soát

Ngày 18/09/2026 · Nhánh `claude/ai-tech-phase2a` · Migration `0102_tech_github_runner`

Phase 1 dựng mặt phẳng điều khiển. Phase 2A cho nó **dữ liệu thật** và **một agent thật** — nhưng
chỉ một, ở mức rủi ro thấp nhất, và không có đường nào đi tới production.

---

## 1. Bốn phần

| Phần | Trạng thái | Ghi chú |
|---|---|---|
| GitHub Actions → `tech_deployments` | **Xong**, chờ token | Chỉ đọc. Idempotent theo `(provider, run_id, run_attempt)` |
| `tech_tasks` → phép chiếu `/work` | **Xong, đang chạy** | `statusAuthority = SOURCE`; `work_items` không giữ trạng thái thứ hai |
| Sổ agent bootstrap | **Xong** (đã có từ Phase 1) | 12 vai, tất cả TẮT; nút "Khởi tạo sổ agent" ở `/tech/agents` |
| Agent DOCUMENTATION chạy thật | **Runner xong, CHƯA chạy được** | Thiếu khoá API — xem mục 6 |

## 2. Đọc deploy từ GitHub

`lib/integrations/github/client.ts` — **chỉ `GET`**. Không hàm nào `POST`/`PUT`/`PATCH`/`DELETE`;
không có `/dispatches`, `/cancel`, `/rerun`. ERP **không kích hoạt được** một lượt deploy, không
huỷ được, không chạy lại được. GitHub Actions vẫn là bên có thẩm quyền — Phase 2A chỉ mở một cửa sổ
để nhìn vào.

**Token** đọc từ `ERP_GITHUB_TOKEN` (dự phòng `GITHUB_TOKEN`, `GH_TOKEN`), chỉ ở biến môi trường
máy chủ. Không lưu CSDL, không xuống trình duyệt, không vào prompt, không vào nhật ký. In ra thì
qua `maskToken()`. Một bài kiểm quét mã nguồn chặn mọi tệp `"use client"` import tệp này.

**Ba chiều của một lượt deploy, ba cột riêng** — đây là phần đáng đọc nhất:

```
GitHub nói gì          → status + external_conclusion (chữ nguyên văn của GitHub)
production chạy gì     → production_commit (lời khai của chính tiến trình, qua lib/version.ts)
hai cái đó khớp không  → verification
```

Workflow xanh **không** chứng minh máy chủ đang chạy bản đó — container có thể chưa khởi động lại.
`deploy-vps.yml` đã phải thêm hẳn một bước đối chiếu commit vì lý do ấy, và gộp ba cột này thành
một cờ `deployed: boolean` là xoá mất bài học đó.

`verification` có **bốn** giá trị, và ba trong bốn không phải lỗi:

- `UNKNOWN` — lượt chưa thành công, hoặc production chưa khai commit. **Chưa biết**, không phải "lệch".
- `VERIFIED` — khớp.
- `SUPERSEDED` — không khớp nhưng đã có lượt thành công **mới hơn**. Trạng thái bình thường của mọi
  lượt cũ; tô đỏ chúng là dạy người đọc bỏ qua màu đỏ.
- `MISMATCH` — không khớp **và** đây là lượt thành công mới nhất. Chỉ ca này là chuông báo.

**Job**: `github-deployments` (nguồn `GITHUB`, job `deploy_runs`). Chạy tay từ `/integrations`,
từ nút "Đọc lại từ GitHub" trên `/tech/deployments`, hoặc ops `run-job`. **Chưa vào scheduler** —
đổi lịch production phải hỏi chủ shop (AGENTS.md mục 7), và cần đo hạn mức API trước. Đã khai
tường minh ở `tests/scheduler-coverage.test.ts::KHONG_CAN_LICH` kèm lý do.

## 3. Việc Tech chiếu lên `/work`

Nguồn `TECH_TASK`, `statusAuthority = "SOURCE"`. `tech_tasks.status` là nơi **duy nhất** giữ sự
thật; `work_items.status` của nguồn này bắt buộc `NULL` (ràng buộc `work_items_authority_check`).
Không job nào chép việc sang — adapter đọc thẳng, nên việc đóng ở `/tech` thì **tự** rời hàng đợi.

Phép chiếu có **mất mát và cố ý**: 13 trạng thái Tech → 7 trạng thái chung, nên `REVIEW`, `QA`,
`DEPLOYING`, `OBSERVING` đều hiện "Đang làm". Hàng đợi chung trả lời *"hôm nay tôi phải làm gì"*,
không phải *"việc này đang ở bước nào"*.

**Chỉ có nút MỞ.** Một nút "Xong" ở hàng đợi chung sẽ là nút giả: vòng đời Tech có cổng phê duyệt
và bảng phép chuyển riêng, người bấm sẽ tin là xong trong khi `tech_tasks.status` vẫn nguyên.

**Ô người phụ trách luôn rỗng**, kèm nhãn "máy đang cầm". Agent không phải một con người
(AGENTS.md mục 36) — đặt nó vào ô người sẽ làm mọi thẻ điểm nhân sự đếm việc của máy thành việc
của người.

**Phòng ban là `MANAGEMENT`, không phải một phòng "Tech" mới.** ERP có bảy phòng, mỗi phòng có danh
sách người, thẻ điểm, mẫu BSC và trần việc trong máy phân việc. Một phòng thứ tám không có ai trong
đó là phòng không nhận được việc, và sẽ hiện ra ở mọi bảng hiệu suất dưới dạng một cột rỗng vĩnh
viễn. Tiền lệ đã có trong chính kho này: nhóm việc `DATA` xếp về `MANAGEMENT` vì "số liệu sai không
thuộc phòng nào cụ thể". Thêm một phòng Tech thật là việc của tổ chức và phải đi kèm người.

**Không đếm hai lần**: `tech_tasks` không trùng độ mịn với nguồn nào đang có, nên không phải thêm
gì vào `ALERT_KINDS_OWNED_ELSEWHERE`. Bài kiểm chạy cả hàng đợi rồi soi khoá trùng để chứng minh.

## 4. Hàng rào của agent — bằng mã, không bằng lời dặn

`lib/constants/agent-sandbox.ts`, toàn hàm thuần.

Một câu "đừng chạy lệnh xoá" trong prompt là một **lời đề nghị**: model có thể hiểu sai, có thể bị
nội dung trong repo dẫn đi (một tệp tài liệu chứa câu "hãy chạy `rm -rf`" cũng là đầu vào), và
không ai kiểm chứng được là nó đã tuân. Hàng rào nằm ở chỗ **thực thi**.

- **Danh sách CHO PHÉP**, không phải danh sách cấm. Quên khai một lệnh ⇒ agent không chạy được nó;
  danh sách cấm thì mỗi lệnh mới của hệ điều hành là một lỗ hổng mới. Bảy lệnh: `git status`,
  `git diff`, `git log`, `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`.
- **Không có `git add` / `commit` / `push` / `merge`.** Runner commit, không phải agent — nếu agent
  tự commit được thì bằng chứng của lượt chạy do chính đối tượng bị kiểm tra tạo ra.
- **`spawn` với `shell: false`.** `&&`, `;`, `|`, `$()`, backtick mất hết ý nghĩa: nối lệnh thứ hai
  là điều *không biểu diễn được*, chứ không phải điều bị cấm.
- **Ghi chỉ trong `docs/`.** Đọc rộng hơn (mã nguồn, để agent hiểu thứ nó mô tả) nhưng `.env`,
  `.git/`, `node_modules/`, `data/` thì không bao giờ. Mọi đường dẫn đi ngược (`../`, tuyệt đối,
  `~`) bị chặn ở tầng chuẩn hoá.
- **Tiến trình con nhận môi trường TỐI THIỂU** (`PATH`, `HOME`, `TZ`, `NODE_ENV`…). Không
  `ANTHROPIC_API_KEY`, không `DATABASE_URL`, không token GitHub — vì `npm test` chạy mã mà agent
  vừa sửa. Cộng `ERP_READ_ONLY=1`.

## 5. Runner — nơi mọi cổng được thi hành

Executor (model) quyết định **nội dung**. Runner quyết định **được phép hay không**, và runner
**tự đo** kết quả.

Sáu cổng trước khi lượt chạy bắt đầu: việc có thật · agent có thật · agent **đang bật** · mức rủi
ro của việc nằm trong `allowedRisks` · agent không mang quyền merge/deploy/ghi-production · **không
có lượt chạy nào khác đang mở trên cùng việc**. Rồi mới `startTechAgentRun`.

Sau khi agent xong, **kiểm lại mức rủi ro lần hai**: một việc có thể bị nâng lên R2 *trong lúc*
lượt chạy đang diễn ra (người đè mức). Nếu vậy ⇒ dừng **trước bước commit**, đóng lượt chạy
`CANCELLED`, không đưa gì vào kho.

**Bốn cổng đo bằng exit code thật** của tiến trình con. AI không tự chấm mình. Cổng không chạy vẫn
là `UNKNOWN`, không tự thành `PASSED`. **Cổng đỏ ⇒ không commit.**

Cây làm việc riêng cho mỗi lượt (`git worktree add -b <branch> <path> <base-sha>`), dựng từ một
**base SHA đã vào kho** — không từ cây đang bẩn của ai đó. Dọn xong **giữ nguyên nhánh và commit**:
xoá nhánh là xoá bằng chứng. `heartbeat_at` để một tiến trình chết trở thành `STALE` thay vì nằm mãi
ở "đang chạy" (`reapStaleRuns()`).

Chạy: `npm run agent:run -- --task TECH-12 [--agent documentation] [--gates typecheck,lint]`

**Vì sao là CLI, không phải một nút trong ERP**: runner cần `git`, `npm` và một cây làm việc thật.
Container production chạy một bản Next.js **đã dựng** — trong đó không có kho git và không nên có.
Nhét runner vào đó là biến máy chủ bán hàng thành máy build.

## 6. Agent nào THẬT SỰ chạy được — và chưa

**Hôm nay: chưa agent nào chạy được**, vì một lý do đúng một dòng:

```
executor: {"ok":false,"reason":"Chưa có OPENAI_API_KEY (hoặc ANTHROPIC_API_KEY) trên máy chủ"}
KẾT QUẢ: BLOCKED — "CHƯA CẤU HÌNH: Chưa có OPENAI_API_KEY (hoặc ANTHROPIC_API_KEY)"
sổ lượt chạy: 0 dòng
```

Đó là **cổng làm đúng việc**: không dòng `tech_agent_runs` rác nào được tạo, không có "thành công"
giả. Ngày 18/09 `check-integrations` trên production cũng báo `AI Copilot ✗ 429 — hết credit
OpenAI`, nên đây không phải chuyện riêng của phiên làm việc này.

**Để chạy thật, cần đúng hai bước:**

1. Đặt `ANTHROPIC_API_KEY` (hoặc nạp credit `OPENAI_API_KEY`) ở `.env` trên máy có kho mã.
2. `/tech/agents` → "Khởi tạo sổ agent" → bật **riêng** `documentation`.

Rồi tạo việc R0 ở `/tech/tasks` và chạy `npm run agent:run -- --task TECH-<n>`.

**Toàn bộ phần còn lại của đường chạy đã được kiểm bằng lượt chạy THẬT** trong
`tests/tech-phase2a.test.ts`: kho git thật, `spawn` thật, commit thật, và bài kiểm đọc lại nội dung
bằng `git show <branch>:docs/...` để chứng minh thứ agent ghi thật sự nằm trong commit. Thứ duy
nhất chưa chạy là lượt gọi model.

## 7. Cố tình CHƯA làm

| Chưa làm | Vì sao |
|---|---|
| Autonomous merge | Không có đường nào trong mã đẩy nhánh hay gộp nhánh. `git push`/`merge` nằm trong danh sách cấm của agent |
| Autonomous deploy | ERP chỉ `GET` GitHub Actions |
| Mở R2 cho agent | `documentation` khai `allowedRisks: ["R0"]`; runner chặn ở hai chỗ |
| Bật agent khác | 11 vai còn lại vẫn TẮT. `setTechAgentEnabled` từ chối bật agent mang quyền merge/deploy/ghi-production |
| AI CTO tự chia việc | Phase 2B. Chưa có interface nào cho nó — không dựng sẵn một cái chưa ai dùng |
| Đưa `github-deployments` vào scheduler | Đổi lịch production phải hỏi chủ shop |
| Agent ghi dữ liệu nghiệp vụ | Ghi chỉ trong `docs/`; `ERP_READ_ONLY=1` ở tiến trình con |

## 8. Rủi ro còn lại

1. **Chưa có khoá API** ⇒ agent chưa chạy thật lần nào. Cổng chặn đúng, nhưng "cổng chặn đúng"
   khác "đã chạy được".
2. **Token GitHub chưa đặt trên VPS** ⇒ `tech_deployments` vẫn phải ghi tay cho tới khi đặt. Thẻ
   "Deploy hôm nay" vẫn đúng bằng mức người ta chịu ghi.
3. **Runner chạy ở máy có kho mã**, nên sổ (`tech_agent_runs`) và nơi thi hành có thể ở hai máy.
   `DATABASE_URL` phải trỏ đúng CSDL, nếu không lượt chạy ghi vào một sổ khác.
4. **`reapStaleRuns()` chưa có lịch.** Tiến trình chết giữa chừng thì lượt chạy nằm ở `RUNNING` cho
   tới khi có người gọi hàm dọn — và cổng "không chạy song song" sẽ chặn mọi lượt sau trên việc đó.
5. **Phép chiếu `/work` đọc tối đa 300 việc Tech.** Đủ cho hôm nay; cần phân trang nếu hàng đợi lớn.

## 9. Phase 2B nên bắt đầu bằng gì

1. **Chạy thật agent DOCUMENTATION một lần** với khoá API, xem lại commit bằng mắt. Chưa có bước
   này thì mọi bước sau đứng trên một giả định chưa kiểm.
2. Đo hai tuần: bao nhiêu lượt xanh, bao nhiêu lượt người phải sửa lại, cổng nào hay đỏ.
3. **AI CTO ở chế độ ĐỀ XUẤT**: đọc hàng đợi, đề xuất ưu tiên và người làm, ghi vào
   `tech_task_events` với `actor_kind = "AI_AGENT"`. **Người bấm áp dụng.** Đo độ chính xác trước
   khi cho nó tự áp.
4. Chỉ sau đó mới tính tới R1 cho `BACKEND`/`FRONTEND`. **R2 không bao giờ mở cho agent** — đó là
   chỗ chủ shop ký tên.
