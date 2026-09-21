# Phòng Tech AI — trạng thái

> **File trạng thái DUY NHẤT.** Mọi milestone cập nhật vào đây, không mở file mới.
> Cập nhật: **21/09/2026** · `main` = `661ffd7` · deploy thành công gần nhất **#380** ·
> lượt chạy agent gần nhất **#15 ✗ (hết credit Anthropic)**

---

## DONE

| Milestone | PR | `main` | Deploy |
|---|---|---|---|
| Nấc 0 — agent chạy thật, hàng rào giữ được | #44 | — | — |
| **Nấc 1a** — cửa hẹp `POST /api/tech/agent-run` + khoá duy nhất `external_ref` | #46 | `5677526` | #366 ✓ |
| **Nấc 1b** — khoá RIÊNG `AGENT_INGEST_SECRET`; bộ kiểm thử chạy được trên Windows | #48 | `d24a5da` | #367 ✓ |
| **Nấc 1c** — middleware chặn cửa TRƯỚC khi phép kiểm khoá chạy | #49 | `54f47dc` | #368 ✓ |
| **Luật 65** — bài kiểm đo MÃ NGUỒN, không đo máy; `gates.yml` chạy 2 chế độ | #50 | `0973e9a` | #369 ✓ |
| **B6** — lỗi OpenAI trên thẻ sức khoẻ là lỗi GIẢ do chính bộ tự kiểm sinh ra | #51 | `9283133` | #370 ✓ |
| **Nấc 2 · cơ chế** — phạm vi ghi theo VAI + `NEVER_WRITE` + khoá lối tắt xoá khẳng định | #52 | `a52a692` | #371 ✓ |
| **Nấc 3** — ERP khởi động lượt chạy agent: ba cổng, khoá GHI tách khỏi khoá ĐỌC | #53 | `7db0abc` | #372 ✓ |
| **Lỗi CSDL đọc được** — job đồng bộ nói NGUYÊN NHÂN thay vì chép 40 tên cột | #54 | — | #373 ✓ |
| **Canh khoá AI** — hết credit tự mở sự cố, tách hẳn khỏi quá hạn mức | #55 | — | #373 ✓ |
| **Nấc 3b** — cửa ĐỌC hẹp `GET /api/tech/agent-task`: agent nhận ĐÚNG việc được giao | #56 | — | #374 ✓ |
| **Nấc 4** — việc tự đi tiếp theo bằng chứng GitHub (`BUILDING→REVIEW→QA`) | #57 | `dedab48` | #375 ✓ |
| **Nấc 5** — agent sửa tiếp trên CHÍNH nhánh đã mở PR | #58 | `69e1e25` | #376 ✓ |
| **23 đơn không đồng bộ được** — đồng bộ nạp nhầm dòng vận đơn | #60 | `7fd334a` | #377 ✓ |
| **Đối chiếu sổ lượt chạy agent với GitHub** | #59 | `204e21e` | #378 ✓ |
| **Agent tự mở PR sau lượt chạy** | #61 | `bcf649b` | #379 ✓ |
| Vá quyền gọi cầu nối (lượt chạy #13 chết ở startup) | #62 | `c3dab99` | — |
| Vá hai lỗi của lượt chạy thật đầu tiên | #63 | `9c4324f` | — |
| **Bộ gắn lại lượt chạy agent về đúng việc** (thi hành BẢN KHAI, không suy diễn) | #64 | `661ffd7` | #380 ✓ |

### Production proof — sổ lượt chạy agent

```
 external_ref         | agent_key     | status    | cổng                        | tệp | xong
 github:35515944813:1 | documentation | SUCCEEDED | PASSED/PASSED/PASSED/PASSED | 1   | 20/09 21:25
 github:35513504364:1 | documentation | SUCCEEDED | PASSED/PASSED/PASSED/PASSED | 1   | 20/09 20:37
 github:35512040059:1 | documentation | SUCCEEDED | PASSED/PASSED/PASSED/PASSED | 1   | 20/09 20:06
 github:35511075146:1 | documentation | SUCCEEDED | PASSED/PASSED/PASSED/PASSED | 1   | 19:46
```

Cộng hai lượt **#11** và **#12** chạy sau khi chủ shop nạp credit (20/09 18:04 và 18:12 UTC), cả
hai `success`. Lượt chạy agent THẬT trong sổ production, khoá khác nhau, bốn cổng xanh, mỗi lượt
đúng một tệp.

---

## CURRENT — không PR nào chờ duyệt

Mọi milestone đã gộp và đã lên production. Việc duy nhất đang chặn là **credit Anthropic**.

| PR | Nội dung |
|---|---|
| #47 | *Không phải của phiên này* — nhánh cũ `claude/charming-turing-kao6lw`, tôi không đụng vào |

---

## Sổ lượt chạy agent — đã sửa xong, có bằng chứng từng dòng

7 dòng đều nằm nhầm dưới `TECH-1`. Trước khi sửa tôi đi lấy bằng chứng cho **từng dòng** thay vì
suy từ tên tệp: đọc log của cả 7 lượt chạy trên GitHub và lấy TIÊU ĐỀ việc mà runner in ra.

Phép dò đầu tiên của tôi **sai** — nó tìm chuỗi `agent:fetch-task` trong log, nhưng log in CẢ HAI
nhánh của khối `if/else` trong shell, nên chuỗi ấy có mặt kể cả khi nhánh kia chạy. Bằng chứng
thật là tiêu đề: `Kiểm chứng DOCUMENTATION agent Phase 2A` = lượt TỰ KIỂM.

Kết quả sau khi ghi (`agent-run-reattach --apply`, chạy thử trước, khớp từng dòng):

| Việc | Số lượt | Đúng chưa |
|---|---|---|
| *(không gắn)* | 6 | ✓ lượt TỰ KIỂM không thuộc việc nào — cửa nhận vốn cho `task_id` trống |
| **TECH-2** | 1 | ✓ lượt chạy #14, đúng việc nó làm |
| TECH-1 | **0** | ✓ agent chưa bao giờ làm việc R2 này |

Không dòng nào bị xoá: cổng, tệp đã đổi, nhánh, tóm tắt còn nguyên — chỉ ô quy kết đổi.

---

---

## VIỆC THẬT ĐẦU TIÊN — TECH-2, và những gì nó dạy

Chủ shop tạo **TECH-2** (`Viết tài liệu cho job đối chiếu sổ lượt chạy agent`, DOCS · TECH · R0 ·
agent `documentation`). Đây là lần đầu dây chuyền chạy trên một việc CÓ THẬT.

| Lượt | Kết quả | Dạy được gì |
|---|---|---|
| **#13** | `startup_failure` | Nơi gọi cấp `contents: write` nên mọi phạm vi khác thành `none`; cầu nối mở PR xin `pull-requests: read` ⇒ GitHub từ chối CẢ workflow trước khi job đầu chạy. **Không log, không annotation.** → PR #62 |
| **#14** | agent LÀM XONG, 4 cổng PASSED, vẫn tính FAILED | Hai lỗi cùng lúc — xem dưới. → PR #63 |
| **#15** | `QUOTA_OR_RATE_LIMIT` | **Hết credit Anthropic.** Agent chưa từng chạy, nên không có dòng sổ nào mới. |

### Lỗi 1 · sổ production ghi lượt chạy vào SAI VIỆC

CSDL tạm của máy CI rỗng ⇒ bộ sinh mã cấp `TECH-1` cho việc gieo lại. Mọi bước sau đọc mã cục bộ:
nhánh thành `ai/documentation/TECH-1-…`, cửa chép sổ ghi lượt chạy vào **TECH-1 trên production** —
việc *"Đánh giá tốc độ trang vận đơn"* (R2), hoàn toàn khác.

Đào tiếp thì rộng hơn: **6/6 dòng** trong sổ đều nằm dưới TECH-1, trong đó 4 lượt TỰ KIỂM chưa bao
giờ chạm tới việc ấy. Lượt tự kiểm không thuộc việc nào — và cửa nhận vốn đã cho `task_id` trống.

### Lỗi 2 · làm xong nhưng bị tính là hỏng

Agent kết thúc bằng một đoạn văn tóm tắt thay vì gọi `finish` ⇒ FAILED ⇒ điều kiện mở PR không đạt
⇒ **PR không được mở**. Công đã làm xong nằm lại trên một nhánh không ai mở ra xem.

Bỏ cuộc ngay là ĐÚNG về nguyên tắc (máy không đoán ý model), nhưng nó vứt một lượt chạy tốn tiền
thật vì một lỗi giao thức sửa được bằng một câu. Nay: **nhắc đúng một lần**, bằng một câu cố ý HẸP
— không mớm kết luận, vì nếu mớm thì tóm tắt trong sổ không còn là lời của model nữa.

### Điều đáng nói nhất

Cả ba lỗi đều **không đỏ ở `typecheck`, `lint`, `test` hay `build`**. Chúng chỉ lộ ra khi có người
bấm chạy thật — đúng lúc đắt nhất. Ba bài kiểm mới đã khoá cả ba ở mức mã nguồn.

---

## Production proof — sổ lượt chạy agent

```
 external_ref         | agent_key     | status    | cổng                        | tệp | xong
 github:35515944813:1 | documentation | SUCCEEDED | PASSED/PASSED/PASSED/PASSED | 1   | 20/09 21:25
 github:35513504364:1 | documentation | SUCCEEDED | PASSED/PASSED/PASSED/PASSED | 1   | 20/09 20:37
 github:35512040059:1 | documentation | SUCCEEDED | PASSED/PASSED/PASSED/PASSED | 1   | 20/09 20:06
 github:35511075146:1 | documentation | SUCCEEDED | PASSED/PASSED/PASSED/PASSED | 1   | 19:46
```

Cộng hai lượt **#11** và **#12** chạy sau khi chủ shop nạp credit (20/09 18:04 và 18:12 UTC), cả
hai `success`. Lượt chạy agent THẬT trong sổ production, khoá khác nhau, bốn cổng xanh, mỗi lượt
đúng một tệp.

---

## CURRENT — một PR chờ DUYỆT

| PR | Nội dung | Trạng thái |
|---|---|---|
| **#61** | **Agent tự mở PR sau lượt chạy** — mắt xích cuối của dây chuyền | cổng xanh · auto-merge bật · chờ HUMAN APPROVAL |
| #47 | *Không phải của phiên này* — nhánh cũ `claude/charming-turing-kao6lw` | tôi không đụng vào |

Dây chuyền sau #61: **nhận việc → code → chạy cổng → commit → đẩy nhánh → TỰ MỞ PR → review →
gộp**. Chỗ duy nhất còn cần người là **duyệt** — và đó là chỗ nó phải ở lại.

---

## Production proof — đo sau mỗi lần deploy

### #60 · lỗi 23 đơn — đã hết

| Lượt `orders_reconcile` | Trạng thái | updated | **failed** |
|---|---|---|---|
| 21/09 09:58 — **sau bản vá** | **SUCCESS** | 472 | **0** |
| 21/09 02:15 — trước | PARTIAL | 469 | 23 |
| 20/09 02:15 — trước | PARTIAL | 464 | 20 |

Kiểm thêm để không kết luận vội: trong 31 đơn hai lần gửi, **21 dòng vừa được ghi**, 40 dòng còn
mốc cũ — và 21/40 dòng cũ ấy thuộc về **chính 21 đơn vừa được ghi**. Tức mỗi đơn đúng **một** dòng
được cập nhật (dòng Pancake đang nói tới), dòng anh em nằm im. Đó là hành vi ĐÚNG: Pancake chỉ báo
một vận đơn cho mỗi đơn. 19 dòng còn lại thuộc đơn nằm ngoài cửa sổ 3 ngày.

### #59 · máy nay tự thấy thứ trước đây phải so tay

Lượt `agent-run-reconcile` đầu tiên trên production:

```
Xét 12 lượt chạy agent trên GitHub: 6 có sổ · 4 hỏng trước khi agent chạy · 0 chưa xong
· 2 mất dòng (di sản đã vá) · 0 mất dòng SAU khi cửa hoạt động
```

Đúng bằng con số tôi so tay đêm qua, và `failed = 0` vì di sản đã vá KHÔNG phải lỗi đang xảy ra.
Hai lượt mất được gọi đích danh (`github:35499651990:1` và lượt còn lại).

### Sức khoẻ chung (chỉ đọc)

| Hỏi | Trả lời |
|---|---|
| Job đồng bộ hỏng (ERROR) trong 24 giờ | **0** |
| Ba bộ canh Tech AI | chạy đúng lịch, đều SUCCESS |
| Việc Tech có khoá nối PR | **0** — Nấc 3b/4 chạy đúng nhưng **chưa có gì để làm** |
| Lỗi CSDL còn ở dạng thô sau deploy #373 | **0/151** |
| Sổ deploy | lượt mới nhất `VERIFIED`, các lượt cũ `SUPERSEDED` |

**Một quan sát chưa kết luận:** `deploy_runs` báo lệch commit 2/47 lượt. Trạng thái hiện tại lành,
nên nhiều khả năng đó là khoảng CHUYỂN TIẾP lúc container khởi động lại. Tôi **không** thêm ngưỡng
ân hạn để dập cảnh báo ấy: sổ chỉ lưu kết luận MỚI NHẤT nên không có dữ liệu về việc một lần lệch
kéo dài bao lâu, và đặt một con số khi chưa đo được thì chính nó mới là lời nói dối.

---

## BLOCKED / HUMAN GATE

> ### ⛔ 1 · Nạp credit Anthropic — đang chặn toàn bộ Phòng Tech AI
> Lượt chạy #15 dừng ở bước kiểm khoá: *"Your credit balance is too low to access the Anthropic
> API."* Agent chưa từng chạy, nên **không phải lỗi của agent** và không có dòng sổ nào bị bẩn.
>
> Máy runner còn một khoá OPENAI chưa thử (router đang chọn anthropic). **CHƯA THỬ nghĩa là chưa
> biết** — nó có thể cũng hết. Muốn thử thì đặt biến kho `AI_PROVIDER_AGENT = openai`; tôi không tự
> đổi cấu hình kho.
>
> **ERP vẫn bán hàng, đồng bộ đơn và vận đơn bình thường.**

> ### ⏸ 3 · `ERP_GITHUB_DISPATCH_TOKEN` (quyền `actions: write`)
> Nút "Khởi động lượt chạy agent" trong ERP đang nói lý do và không gọi được gì. Tôi vẫn dispatch
> workflow bằng tay được, nên đây **chưa chặn** việc gì.

### Đã chốt, không còn là gate

- **Vai QA đang BẬT** — chủ shop xác nhận 21/09 là **chủ ý**. Vai ấy ghi được `tests/`; bộ đếm
  khẳng định chặn được việc XOÁ bài kiểm, KHÔNG chặn được việc làm yếu. Ghi lại để người sau biết
  giới hạn ấy là đã được cân nhắc chứ không bị bỏ sót.
- **Cách tạo việc cho agent** — không cần "Lập kế hoạch rồi duyệt đề xuất". Tạo thẳng việc với
  **Loại = DOCS · Module = TECH** thì máy xếp **R0**, rồi đổi trạng thái sang *Đã phân loại* và gán
  agent. Ba thao tác, một màn hình.

## NEXT

| Việc | Phụ thuộc |
|---|---|
| Chạy lại TECH-2 đầu-cuối (agent → PR tự mở) | **credit Anthropic** |
| Agent đọc bình luận review rồi tự chạy lại (nối vào Nấc 5) | credit |
| **Nấc 6** — tự deploy + nghiệm thu + quay lui | **giữ lại chờ quyết định của chủ shop** |

### Cổng "5 lượt chạy sạch liên tiếp" — **6/5, đã đạt**

Runs #6 · #7 · #8 · #9 SUCCEEDED bốn cổng xanh; #10 hỏng vì **hết credit** (chưa bao giờ chạy —
`agent:check` chặn ở bước kiểm khoá); #11 và #12 SUCCEEDED sau khi nạp credit.

Cổng đã đạt về SỐ LƯỢNG. Việc **bật vai QA vẫn là quyết định của người**: nó mở cho agent quyền ghi
`tests/`, và một vai ghi được bài kiểm là một vai có thể làm xanh cổng bằng cách xoá khẳng định —
`lib/constants/agent-test-guard.ts` đếm khẳng định để chặn đúng nước đi ấy, nhưng nó bắt được việc
XOÁ, không bắt được việc LÀM YẾU. Nói ra giới hạn ấy ở đây thay vì để nó nằm im trong một docblock.

**R2 không bao giờ mở cho agent.** Giữ nguyên.

---

## Nhánh WIP đã bảo toàn

`wip/vtp-integration-before-tech-ai` @ `e03e8b4` — việc dở về sức khoẻ bảng kê VTP qua Gmail.
KHÔNG gộp vào Tech AI. (Ghi chú: job `vtp-statement-mail` chạy lần cuối **16/09** — đúng thứ nhánh
ấy đang làm.)
