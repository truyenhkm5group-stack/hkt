# Phòng Tech AI — trạng thái

> **File trạng thái DUY NHẤT.** Mọi milestone cập nhật vào đây, không mở file mới.
> Cập nhật: **21/09/2026** · `main` = `9b6476f` · deploy thành công gần nhất **#381**

---

## Dây chuyền đã dựng xong

```
việc thật trên /tech  →  cửa đọc có khoá  →  agent làm  →  4 cổng  →  commit
    →  đẩy nhánh  →  TỰ MỞ PR  →  review  →  gộp  →  deploy  →  kiểm production
```

Chỗ duy nhất còn cần NGƯỜI là **duyệt PR** — và đó là chỗ nó phải ở lại.

| Milestone | PR | Deploy |
|---|---|---|
| Nấc 0 — agent chạy thật, hàng rào giữ được | #44 | — |
| Nấc 1a·1b·1c — cửa chép sổ, khoá riêng, middleware chặn đúng chỗ | #46 #48 #49 | #366–#368 |
| Luật 65 — bài kiểm đo MÃ NGUỒN, không đo máy | #50 | #369 |
| B6 — lỗi OpenAI trên thẻ sức khoẻ là lỗi GIẢ do chính bộ tự kiểm sinh ra | #51 | #370 |
| Nấc 2 — phạm vi ghi theo VAI + `NEVER_WRITE` | #52 | #371 |
| Nấc 3 — ERP khởi động lượt chạy agent: ba cổng | #53 | #372 |
| Lỗi CSDL đọc được · canh khoá AI hết credit | #54 #55 | #373 |
| Nấc 3b — cửa ĐỌC hẹp `GET /api/tech/agent-task` | #56 | #374 |
| Nấc 4 — việc tự đi tiếp theo bằng chứng GitHub | #57 | #375 |
| Nấc 5 — agent sửa tiếp trên CHÍNH nhánh đã mở PR | #58 | #376 |
| **23 đơn không đồng bộ được** — lỗi production thật | #60 | #377 |
| Đối chiếu sổ lượt chạy agent với GitHub | #59 | #378 |
| **Agent tự mở PR sau lượt chạy** | #61 | #379 |
| Vá quyền gọi cầu nối · vá hai lỗi của lượt chạy thật | #62 #63 | — |
| Bộ gắn lại lượt chạy về đúng việc | #64 | #380 |
| **Cắt chi phí lượt chạy agent** | #67 | #381 |
| Vá đường khai khoá dispatch | #68 | — |
| Vá bộ đo chi phí + phạm vi tệp cho phép | #70 | — |

---

## Việc thật đầu tiên (TECH-2) — bốn lượt chạy, năm lỗi

Chủ shop tạo **TECH-2** (`Viết tài liệu cho job đối chiếu sổ lượt chạy agent` · DOCS · TECH · R0).
Đây là lần đầu dây chuyền chạy trên một việc CÓ THẬT, và nó tìm ra những lỗi mà **không cổng nào
bắt được** — `typecheck`, `lint`, `test`, `build` đều xanh trong cả bốn lần.

| Lượt | Kết quả | Lỗi tìm ra | Vá ở |
|---|---|---|---|
| **#13** | `startup_failure` — không job nào chạy, không log, không annotation | ① nơi gọi cấp `contents: write` ⇒ mọi phạm vi khác thành `none`; cầu nối xin `pull-requests: read` ⇒ GitHub từ chối CẢ workflow | #62 |
| **#14** | agent LÀM XONG, 4 cổng xanh, vẫn FAILED | ② sổ production ghi lượt chạy vào **sai việc** (6/6 dòng nằm dưới TECH-1) ③ agent quên gọi `finish` ⇒ tính là hỏng ⇒ PR không mở | #63 |
| **#16** | agent SUCCEEDED, viết được tài liệu | ④ danh sách cho phép ghi cứng tên tệp tự kiểm ⑤ phép đo tiền không tra được giá (bí danh ≠ tên model API trả về) | #70 |
| **#17** | agent BỎ CUỘC | ⑥ **đề bài giấu phạm vi ĐỌC** — agent tưởng nó chỉ đọc được `docs/` rồi từ chối làm | #72 |

### Lỗi ⑥ đáng nói nhất, vì tôi đã chữa đúng lớp lỗi ấy một lần rồi

Agent nói: *"Không thể hoàn thành task vì không có quyền đọc mã nguồn (phạm vi chỉ có docs/)"* —
**câu ấy SAI**, hàng rào cho nó đọc `lib/`, `app/`, `db/`, `tests/`, `scripts/`… Nhưng đề bài chỉ
có MỘT dòng về quyền: *"Bạn được GHI trong: docs/"*. Agent suy ra phạm vi đọc cũng chừng ấy — một
suy luận **hợp lý từ dữ kiện nó được cho**.

`branch`/`baseCommit` từng bị giấu y hệt, và kết luận đã viết sẵn trong mã từ lần ấy:
*"Cái sai là ĐỀ BÀI: nó hỏi thứ mà hàng rào cấm lấy."* Lần này đề bài **giấu** thứ hàng rào **cho
phép** — mặt thứ hai của cùng một lỗi, và tôi để sót.

### Agent viết được gì (lượt #16)

`docs/agent-run-reconciliation.md` trên nhánh `ai/documentation/TECH-2-mub112o4`. Nó nắm đúng ba
chỗ khó:

- *"Bằng chứng lượt chạy thật sự là hiện vật + lịch sử Actions; dòng sổ trên production chỉ là
  phản chiếu"* — không nhầm cái phụ thành cái chính.
- *"Không dùng ID từ CSDL tạm vì nó dùng-một-lần, chạy lại sinh UUID mới"* — đúng lý do thật.
- *"Không quy về PASSED hoặc FAILED: chưa biết ≠ đã đạt"* — bắt đúng luật mục 42.

Một lỗi chính tả (`cợng`). Không thấy chỗ nào sai sự thật.

**Kết luận thẳng:** sáu lỗi vừa rồi **không phải** giới hạn của model. Năm cái là hạ tầng và đề bài
— tức là của tôi.

---

## Chi phí — đo được, và đã cắt

Chủ shop 21/09: *"mới đang ở khâu test luồng mà đã hết $25"*. Đi đo ra ba chỗ:

| Chỗ | Đo được | Đã vá |
|---|---|---|
| Runner gọi bậc `copilot` cho MỌI vai ⇒ `claude-opus-5` ($5/M vào · **$25/M ra**) để viết Markdown | mọi lượt chạy | bậc theo VAI; `DOCUMENTATION`/`QA` → `routine` (haiku, $1/$5) |
| Vòng lặp gửi lại cả lịch sử mỗi vòng, chỉ prompt hệ thống được đệm | tới 24 vòng | đệm cả tiền tố hội thoại — lượt #16 đo được **306.431 token** đi giá đệm |
| **Không ai đo được một lượt chạy tốn bao nhiêu** | lượt chạy trên Actions KHÔNG ghi vào `ai_interactions` | mỗi lượt in một dòng tiền |

Chỗ thứ ba mới là lỗ hổng thật: khi chủ shop hỏi tiền đi đâu, **không ai trả lời được, kể cả tôi**
— và mọi lượt "tối ưu" sau đó đều là niềm tin.

**Số đo thật, lượt #17:** `tiền: $0.0320 · 9 vòng · vào 24.143 · ra 1.580`.

| | trước khi cắt | sau |
|---|---|---|
| Một lượt chạy **hỏng** | ~$1,80 (ước tính từ token) | **$0,032** (máy tự in) |

Bản thân việc *thất bại* rẻ đi quãng 50 lần — đó là thứ cho phép tìm lỗi bằng cách **chạy thật**
thay vì ngồi đoán. Bốn lượt chạy tìm ra sáu lỗi với tổng chi phí chưa tới $0,5.

**Một chỗ tốn tiền nữa, CHƯA đổi:** Copilot trong ERP (`/shipments`) cũng chạy `claude-opus-5` —
50 lượt · 115.560 token vào · 23.998 ra (19→21/09). Đó là tính năng chủ shop dùng; hạ model là hạ
chất lượng trả lời, nên tôi báo số chứ không tự quyết.

---

## Sổ lượt chạy agent — đã sửa, có bằng chứng từng dòng

7 dòng đều nằm nhầm dưới `TECH-1`. Trước khi sửa tôi lấy bằng chứng cho **từng dòng**: đọc log của
cả 7 lượt trên GitHub và lấy TIÊU ĐỀ việc mà runner in ra.

Phép dò đầu tiên của tôi **sai** — nó tìm chuỗi `agent:fetch-task` trong log, nhưng log in CẢ HAI
nhánh của khối `if/else` trong shell, nên chuỗi ấy có mặt kể cả khi nhánh kia chạy. Nếu tin nó,
bản khai đã sai hai dòng — và bộ sửa sẽ ghi sai một cách rất tự tin.

| Việc | Số lượt | |
|---|---|---|
| *(không gắn)* | 6 | lượt TỰ KIỂM không thuộc việc nào |
| **TECH-2** | 1 | đúng việc nó làm |
| TECH-1 | **0** | agent chưa bao giờ làm việc R2 này |

Không dòng nào bị xoá: cổng, tệp đã đổi, nhánh, tóm tắt còn nguyên — chỉ ô quy kết đổi.

---

## Production — đo sau mỗi lần deploy

### Lỗi 23 đơn (PR #60) — đã hết

| Lượt `orders_reconcile` | Trạng thái | updated | **failed** |
|---|---|---|---|
| 21/09 09:58 — **sau bản vá** | **SUCCESS** | 472 | **0** |
| 21/09 02:15 — trước | PARTIAL | 469 | 23 |
| 20/09 02:15 — trước | PARTIAL | 464 | 20 |

### Job đối chiếu sổ (PR #59) — máy tự thấy thứ trước đây phải so tay

```
Xét 12 lượt chạy agent trên GitHub: 6 có sổ · 4 hỏng trước khi agent chạy
· 0 chưa xong · 2 mất dòng (di sản đã vá) · 0 mất dòng SAU khi cửa hoạt động
```

### Sức khoẻ chung

0 job hỏng (ERROR) trong 24 giờ · 3 bộ canh Tech AI chạy đúng lịch · **0/151** lỗi còn ở dạng thô
sau deploy #373 · sổ deploy không lệch.

**Một quan sát CHƯA kết luận:** `deploy_runs` báo lệch commit 2/47 lượt, và lần đo gần nhất rơi
đúng lúc một lượt deploy đang chạy — nhiều khả năng là khoảng CHUYỂN TIẾP lúc container khởi động
lại. Tôi **không** thêm ngưỡng ân hạn để dập cảnh báo: sổ chỉ lưu kết luận MỚI NHẤT nên chưa có dữ
liệu về việc một lần lệch kéo dài bao lâu, và đặt một con số khi chưa đo được thì chính nó mới là
lời nói dối.

---

## CURRENT

| PR | Nội dung | Trạng thái |
|---|---|---|
| **#72** | Đề bài nói cả phạm vi ĐỌC (lỗi ⑥) | cổng xanh · chờ duyệt lại sau khi đồng bộ `main` |
| #47 | *Không phải của phiên này* — nhánh cũ `claude/charming-turing-kao6lw` | không đụng vào |

> **Về nhịp duyệt:** ruleset bật `strict` + `dismiss_stale_reviews_on_push` + `require_last_push_approval`.
> Khi `main` nhích lên giữa chừng, nhánh phải đồng bộ lại và **lượt duyệt trước bị gỡ** — cần bấm
> Approve thêm một lần. Đó là ruleset làm đúng việc của nó, không phải trục trặc.

---

## BLOCKED / HUMAN GATE

> ### ⏸ 1 · Nạp credit Anthropic khi cần
> Đã cắn hai lần (lượt #10 và #15). Lượt chạy dừng ở bước kiểm khoá — **agent chưa từng chạy**, nên
> không phải lỗi agent và không dòng sổ nào bị bẩn. Sau khi cắt chi phí, mỗi lượt chạy chỉ còn
> quãng **$0,03–0,25**.

> ### ⏸ 2 · Nấc 6 — tự deploy + nghiệm thu + quay lui
> **Tôi vẫn giữ lại, không tự làm.** Đây là bước máy được phép chạm production mà không có người
> bấm; nó cần chủ shop quyết phạm vi trước.

### Đã chốt, không còn là gate

- **`ERP_GITHUB_DISPATCH_TOKEN`** — đã khai và đã lên máy chủ (`đã ghi (93 ký tự)`, 21/09).
- **Vai QA đang BẬT** — chủ shop xác nhận là CHỦ Ý. Vai ấy ghi được `tests/`; bộ đếm khẳng định
  chặn được việc XOÁ bài kiểm, KHÔNG chặn được việc làm yếu. Ghi lại để người sau biết giới hạn ấy
  đã được cân nhắc chứ không bị bỏ sót.
- **Cách tạo việc cho agent** — không cần "Lập kế hoạch rồi duyệt đề xuất". Tạo thẳng việc với
  **Loại = DOCS · Module = TECH** thì máy xếp **R0**; rồi đổi trạng thái sang *Đã phân loại* và gán
  agent. Ba thao tác, một màn hình.

---

## NEXT

| Việc | Phụ thuộc |
|---|---|
| Chạy TECH-2 trọn vẹn: agent → 4 cổng → **PR tự mở** | #72 gộp |
| Agent đọc bình luận review rồi tự chạy lại (nối vào Nấc 5) | sau khi dây chuyền chạy trọn một lần |
| Hạ bậc model cho Copilot ERP | **quyết định của chủ shop** — đổi model là đổi chất lượng trả lời |
| **Nấc 6** | **quyết định của chủ shop** |

---

## Nhánh WIP đã bảo toàn

`wip/vtp-integration-before-tech-ai` @ `e03e8b4` — việc dở về sức khoẻ bảng kê VTP qua Gmail.
KHÔNG gộp vào Tech AI.
