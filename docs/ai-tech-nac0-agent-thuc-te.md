# Nấc 0 — agent làm được việc thật không? Đo, ngày 20/09/2026

> **Câu hỏi:** trước khi xây dispatch, worker, vòng phản hồi và auto-merge quanh runner — **lõi
> ấy có làm ra thứ dùng được không?** Mọi hạng mục P1/P2 đều giả định là có. Chưa ai kiểm.

## 0. Một đính chính trước

`/tech/agents` hiện **12/12 vai "0 lượt chạy · Chưa từng chạy"**, và tôi đã đọc con số ấy thành
*"agent chưa từng chạy"*. **Sai.** Agent đã chạy — `agent-run.yml` có **5 lượt**, lượt #4 (19/09)
và #5 (20/09) đều **success**. Con số kia chỉ đúng với **sổ production**, vì lượt chạy ghi vào
PGlite dùng-một-lần trên máy Actions (xem `docs/ai-tech-phase2b.md` mục 3).

Hai chuyện khác nhau: *agent chưa chạy* và *sổ không thấy agent chạy*. Chỉ chuyện thứ hai là thật.

## 1. Hai lượt chạy, đo được

| | Run #4 | Run #5 |
|---|---|---|
| Ngày | 19/09 | 20/09 08:28→08:37 (8m06s) |
| Kết quả | success | success |
| Nhánh đẩy ra | `ai/documentation/TECH-1-mu7ws71b` | `ai/documentation/TECH-1-mu9k1jty` |
| Tệp đổi | **1** (`docs/ai-tech-agent-runner-proof.md`, 70 dòng) | **1** (cùng tệp, 74 dòng) |
| Cổng phạm vi tệp | qua | qua |

**Phạm vi được tôn trọng cả hai lượt.** Không lượt nào chạm tệp thứ hai, không lượt nào thử lách.

## 2. Chấm nội dung theo 8 mục đề bài bắt buộc

| Mục | #4 | #5 |
|---|---|---|
| mã việc | ✅ | ✅ |
| vai agent | ✅ | ✅ |
| phạm vi duy nhất | ✅ | ✅ |
| việc vai tài liệu KHÔNG được làm | ✅ (8 gạch đầu dòng, đúng) | ✅ |
| câu nguyên văn *"Agent không merge, không deploy"* | ✅ | ✅ |
| kết quả bốn cổng | ⚠ 3/4 | ⚠ 3/4 |
| **base SHA** | ❌ | ❌ |
| **tên nhánh** | ❌ | ❌ |

**Văn phong dùng được ngay.** Không bịa tên hàm, không bịa số. Bảng rõ, lý lẽ đi kèm từng ô.

## 3. Hai ô ❌ là lỗi của ĐỀ BÀI, không phải của agent

Đề bài đòi **base SHA** và **tên nhánh**. Agent thử `git rev-parse` (không có trong
`DOCUMENTATION_COMMANDS`) rồi thử đọc `.git/HEAD` (nằm trong `NEVER_READ`) — **bị chặn cả hai**,
và viết:

> Base SHA | **Chưa xác minh được từ trong phiên chạy**
> […] Để trống có chủ đích vẫn tốt hơn là điền một giá trị đoán.

Đây là hành vi **ĐÚNG** — AGENTS.md mục 42, và agent làm đúng mà không ai dạy nó số hiệu luật.

Cái sai nằm ở phía ta: `runAgentOnTask` **có sẵn** `opts.baseCommit` và `branch` nhưng `AgentJob`
không mang chúng. Một việc **không thể hoàn thành đúng luật** thì hoặc dạy agent lách luật, hoặc
dạy người đọc rằng "chưa biết" là chuyện bình thường. Cả hai đều đắt hơn hai dòng mã.

## 4. Phát hiện đắt nhất: agent trình bày SUY ĐOÁN như SỰ THẬT

Cả hai lượt, agent gọi `npm run test`, bị chặn, rồi viết vào **tài liệu bàn giao**:

> #4: *"runner chặn `npm run test` đối với vai tài liệu."*
> #5: *"nó không nằm trong danh sách lệnh cho phép của vai tài liệu."*

**Cả hai câu đều SAI.** `DOCUMENTATION_COMMANDS` dòng 61: `{ key: "test", bin: "npm", args: ["test"] }`
— vai tài liệu **ĐƯỢC** chạy test. Nó bị chặn vì `checkCommand` so khớp **chính xác**: ba cổng kia
khai `npm run <tên>`, riêng test khai `npm test`, nên dạng mà bất cứ ai đọc ba dòng trên cũng sẽ
viết theo lại là dạng bị từ chối.

Phần đáng sợ không phải agent đoán — con người bị chặn cũng sẽ đoán. Phần đáng sợ là **lời đoán ấy
đi thẳng vào tài liệu bàn giao, đọc lên y như một điều đã kiểm chứng**, và nó lặp lại **độc lập ở
cả hai lượt chạy**. Đây là khiếm khuyết hệ thống, không phải một lần lỡ tay.

> **Một hàng rào từ chối mà không nói lý do thì người bị chặn sẽ tự nghĩ ra lý do — và lý do tự
> nghĩ luôn có vẻ đúng.**

## 5. Đã vá

| Lỗi | Vá |
|---|---|
| `AgentJob` không mang bối cảnh agent bị cấm tự lấy | thêm `baseCommit` + `branch`; runner truyền xuống; prompt **nói thẳng** hai giá trị. Hàng rào **giữ nguyên** — `git rev-parse` vẫn cấm, `.git/` vẫn không đọc được |
| `npm run test` bị từ chối trong khi `npm test` được phép | nhận **cả hai** dạng. Không nới quyền nào: `npm test` vốn đã được phép |

`tests/tech-phase2a.test.ts` khoá cả **lớp**, không riêng ca test: **mọi** cổng phải gọi được bằng
dạng `npm run <tên>`; và `AgentJob` phải mang `baseCommit` + `branch`, prompt phải nói ra, runner
phải truyền xuống — đồng thời khẳng định hai hàng rào vẫn **còn nguyên**.

## 6. Kết luận Nấc 0

**Lõi chạy được, và đầu ra dùng được.** Hai lượt độc lập: đúng phạm vi, đúng văn phong nhà, không
bịa số, và biết nói "chưa biết".

**Nhưng nó cũng biết nói một câu sai bằng giọng chắc chắn** — và đó là rủi ro thật của cả phòng
Tech AI, lớn hơn rủi ro nó viết mã hỏng. Mã hỏng thì cổng bắt được; **một câu sai trong tài liệu
thì không cổng nào bắt**. Nên mọi nấc sau phải giữ nguyên nguyên tắc: **đầu ra của agent là một ĐỀ
XUẤT chờ người đọc, không phải một lời khai đã kiểm chứng.**

Chỉ số phải theo dõi từ đây: **tỷ lệ PR của agent merge được mà không cần người viết lại** — và
với vai tài liệu, thêm một chỉ số nữa: **số câu khẳng định sai lọt vào tài liệu**. Hai lượt đầu:
**1 câu sai / lượt**, cùng một câu.
