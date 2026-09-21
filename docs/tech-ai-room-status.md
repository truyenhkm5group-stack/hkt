# Phòng Tech AI — trạng thái

> **File trạng thái DUY NHẤT.** Mọi milestone cập nhật vào đây, không mở file mới.
> Cập nhật: **21/09/2026** · `main` = `204e21e` · deploy thành công gần nhất **#378** ·
> lượt chạy agent gần nhất **#12 ✓**

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

> ### ⛔ 1 · Duyệt PR #61
> Bấm **Approve**. Auto-merge đã bật.
>
> Lưu ý về nhịp: ruleset bật `strict` + `dismiss_stale_reviews_on_push` + `require_last_push_approval`.
> Nên khi `main` nhích lên giữa chừng, nhánh phải đồng bộ lại và **lượt duyệt trước bị gỡ** — cần
> bấm Approve thêm một lần. Đó là ruleset làm đúng việc của nó, không phải trục trặc.

> ### ⏸ 2 · Một việc Tech THẬT — nút thắt lớn nhất còn lại
> Production có đúng một việc: **TECH-1** (R2 · NEW · chưa gán agent). **R2 không bao giờ mở cho
> agent**, nên nó không dispatch được — đúng luật, không phải lỗi.
>
> Hệ quả: Nấc 3b → 4 → 5 → tự mở PR đều đã dựng xong và chạy đúng, nhưng **chưa có việc nào để
> chạy qua**. `github-pr-sync` đang báo 0 việc có khoá nối.
>
> Cách mở: `/tech/tasks/TECH-1` → **Lập kế hoạch** → duyệt đề xuất. `approveProposal` đòi
> `actor.kind === "HUMAN"` — cổng ấy là **cố ý**.

> ### ⏸ 3 · `ERP_GITHUB_DISPATCH_TOKEN` (quyền `actions: write`)
> Nút "Khởi động lượt chạy agent" ở `/tech/tasks/<mã>` đang nói lý do và không gọi được gì.
> **Chưa bật**, không phải hỏng.

> ### ⏸ 4 · Bật vai QA (agent được ghi `tests/`)
> Cổng "5 lượt sạch" đã đạt **6/5**. Nhưng đây là quyết định của NGƯỜI, và lý do nói thẳng: bộ đếm
> khẳng định chặn được việc **XOÁ** bài kiểm, **không** chặn được việc **làm yếu** nó.

## NEXT

| Việc | Phụ thuộc |
|---|---|
| Chạy thử đầu-cuối: việc thật → agent → PR tự mở → review → gộp | **cần một việc Tech thật (gate 2)** |
| **Nấc 6** — tự deploy + nghiệm thu + quay lui | **giữ lại chờ quyết định của chủ shop** |
| Agent tự trả lời phản hồi review (đọc bình luận → chạy lại Nấc 5) | sau khi #61 gộp |

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
