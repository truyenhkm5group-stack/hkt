# ADR · Nối lượt deploy với việc Tech — quan hệ NHIỀU-NHIỀU

**Trạng thái: ĐỀ XUẤT.** Chưa có migration, và lượt này **cố ý không tạo migration** — xem mục 7.

Ngày 20/09/2026 · liên quan `tech_deployments`, `tech_tasks` · bối cảnh `docs/ai-tech-phase2b.md`

---

## 1. Vấn đề

`/tech/deployments` đo được: **26/26 dòng** đều hiện *"— không gắn việc nào"*. Cơ chế gắn đã có
trong lược đồ (`tech_deployments.task_id`, khoá ngoại tới `tech_tasks`), nhưng không đường nào tự
điền nó, nên câu hỏi *"lượt deploy này chở những việc gì"* chỉ trả lời được bằng cách mở GitHub và
đọc lịch sử commit.

## 2. Vì sao KHÔNG điền cột đang có

`task_id` là **một khoá đơn**. Một lượt deploy `main` gần như luôn chở **nhiều** việc — mỗi PR merge
từ lượt deploy trước tới lượt này. Nhét một `task_id` vào đó tạo ra một lời khẳng định **sai**, và
sai theo hướng khó phát hiện:

> Màn hình sẽ đọc ra *"lượt deploy này mang việc TECH-12"*, trong khi nó mang TECH-12, TECH-15 và
> TECH-19. Hai việc kia **biến mất** khỏi mọi câu hỏi ngược ("việc này đã lên production chưa?").

Một ô trống nói *"chưa biết"* là trung thực. Một ô điền sai một phần ba sự thật thì tệ hơn ô trống,
vì nó **dừng** việc đi tìm. Đây đúng là cái bẫy AGENTS.md mục 42 mô tả ở một chỗ khác: *chưa biết
không được in ra thành một giá trị*.

## 3. Quan hệ đúng

```
tech_deployments  ──┐
                    ├──  tech_deployment_tasks  ──  tech_tasks
                  ──┘
```

| Cột | Ý nghĩa |
|---|---|
| `deployment_id` | FK → `tech_deployments.id`, `on delete cascade` |
| `task_id` | FK → `tech_tasks.id`, `on delete cascade` |
| `link_source` | **`MERGE_COMMIT`** (suy từ khoảng commit) · **`MANUAL`** (người gắn) — hai mức tin cậy khác nhau, không gộp |
| `evidence` | SHA của merge commit đã dẫn tới suy luận, hoặc câu người ghi |
| `created_at` | |

**Khoá duy nhất: `(deployment_id, task_id)`.** Job đối chiếu chạy 15 phút/lần nên phải chạy lại
được mà không nhân đôi; khoá tự nhiên này là thứ chặn, không phải một mệnh đề `where not exists`
trong mã (mệnh đề ấy có cửa sổ đua, khoá thì không).

`link_source` **nằm trong bảng nhưng KHÔNG nằm trong khoá**: một việc được máy suy ra rồi người xác
nhận lại vẫn là **một** liên kết, không phải hai. Người ghi đè thì `link_source` chuyển `MANUAL` và
`evidence` chuyển sang câu của người — cập nhật, không thêm dòng.

## 4. Đường suy luận, và giới hạn của nó

Nguồn duy nhất đủ mạnh là **khoảng commit giữa hai lượt deploy thành công liên tiếp**:

```
GET /repos/{owner}/{repo}/compare/{deploy_truoc.commit_sha}...{deploy_nay.commit_sha}
→ danh sách commit
→ lọc merge commit → merge_commit_sha của từng PR
→ tech_tasks.pr_number (phép chiếu PR, đã có từ Phase 2B) → task_id
```

Ba điều kiện phải giữ, nếu không thì **không kết luận**:

1. **Phải có lượt deploy thành công TRƯỚC.** Lượt đầu tiên trong sổ không có mốc so sánh ⇒ để
   trống, không lấy "toàn bộ lịch sử" làm khoảng.
2. **`compare` có trần 250 commit.** Vượt trần thì GitHub cắt và ta sẽ suy ra **thiếu** việc mà
   không biết mình thiếu. Phải đọc cờ cắt và ghi `UNKNOWN` cho cả lượt, chứ không ghi một tập con
   trông như tập đủ.
3. **Chỉ nối được việc ĐÃ CÓ `pr_number`.** Việc chưa gắn PR (làm tay, hotfix đẩy thẳng) sẽ không
   bao giờ xuất hiện — và màn hình phải **in ra số commit không quy được về việc nào**, đứng cạnh
   danh sách đã quy được. Một danh sách sạch không kèm phần dư là một danh sách nói dối.

> Mốc so sánh phải là lượt deploy **THÀNH CÔNG** gần nhất trước đó, không phải lượt gần nhất. Lượt
> hỏng không bao giờ lên máy chủ, nên lấy nó làm mốc là bỏ sót đúng những việc đã đi qua nó.

## 5. Backfill — KHÔNG

26 dòng hiện có: `compare` vẫn gọi được cho chúng, nhưng phép chiếu PR (`tech_tasks.pr_number`) chỉ
bắt đầu được điền từ Phase 2B trở đi. Backfill sẽ cho **một tập con** rồi trình bày như tập đủ —
đúng thứ AGENTS.md mục 8.8 cấm.

Dòng cũ để `UNKNOWN`. Con số *"N lượt deploy chưa quy được việc"* phải hiện ngay trên màn hình, vì
nó là **độ phủ**, và độ phủ luôn đứng cạnh con số (mục 57).

## 6. Quay đầu

Bảng nối **không mang dữ liệu gốc** — nó là phép chiếu suy ra được lại từ `tech_deployments` +
`tech_tasks` + GitHub. Nên quay đầu là `drop table`, và không mất gì ngoài những dòng `MANUAL` do
người gắn tay. Vì vậy:

- Dòng `MANUAL` phải mang `evidence` là câu người viết, không phải một SHA — để nếu bảng bị dựng
  lại thì phần người đóng góp còn đọc lại được từ nhật ký việc (`tech_task_events`).
- Job suy luận ghi thêm một dòng `tech_task_events` kind `DEPLOY` cho mỗi liên kết MỚI. Nhật ký là
  append-only và **không** bị `drop table` cuốn theo.

## 7. Vì sao lượt này KHÔNG tạo migration

Nhiều phiên đang cùng làm việc trên kho này, và **migration là chỗ va chạm đắt nhất**: hai nhánh
cùng sinh `0106` thì nhánh về sau phải đánh số lại, và nếu nhánh kia đã áp lên production thì việc
đánh số lại không còn an toàn nữa (AGENTS.md mục 4 + mục 9). Riêng trong phiên này main đã nhảy
`de8a449 → 6df5881` giữa chừng.

Cái giá của việc chờ là **26 dòng tiếp tục hiện "không gắn việc nào"** — một sự thật khó chịu nhưng
đúng. Cái giá của việc không chờ là một số hiệu migration phải sửa lại sau khi đã áp.

**Điều kiện để bắt đầu:** chủ shop chốt riêng, và lúc đó kiểm `drizzle/meta/_journal.json` ngay
trước khi `npm run db:generate`.

## 8. Phương án đã cân và loại

| Phương án | Vì sao loại |
|---|---|
| Điền `task_id` bằng việc của **merge commit cuối** trong khoảng | Đúng-một-phần. Đọc ra là "lượt này chở TECH-12" trong khi nó chở ba việc. Xem mục 2 |
| Thêm `task_ids jsonb[]` vào `tech_deployments` | Không có khoá ngoại ⇒ việc bị xoá để lại id mồ côi; không truy vấn ngược được ("việc này lên production lúc nào") mà không quét toàn bảng |
| Suy từ **thời gian** (việc `DONE` trước lượt deploy) | Thời gian không phải quan hệ nhân quả. Một việc xong lúc 10:00 không chứng minh nó nằm trong lượt deploy 10:05 — PR có thể chưa merge |
| Để nguyên, không nối | Chính là hiện trạng. Chấp nhận được **tạm thời**, không chấp nhận được lâu dài: không có nó thì "quay đầu lượt deploy nào" phải trả lời bằng tay |
