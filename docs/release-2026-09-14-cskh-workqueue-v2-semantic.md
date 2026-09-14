# Bản phát hành 14/09/2026 — Hàng đợi CSKH V2 · Máy sinh case hiểu câu · Vòng đời case

> **Trạng thái**: mã nguồn đã lên `main` tại `6ee2098`, deploy run #266.
> Phần đối soát HMT bằng tệp thật vẫn **chờ một thao tác duy nhất của chủ shop** — xem mục cuối.

---

## 1. Ba việc, một nguyên nhân chung

Hàng đợi CSKH trên production có 417 case đang mở mà chỉ **2** case có người phụ trách thật, và
`assignee_user_id` chỉ có ở **3/823** case. Không phải vì không ai làm việc — mà vì **hàng đợi
không dùng được như một bàn làm việc**:

| Triệu chứng | Nguyên nhân gốc |
|---|---|
| Trưởng nhóm không giao được việc | Ô chọn người CHỈ hiện khi đã có ai đó nhận |
| Không biết ai đã gọi khách, gọi lúc nào | Ghi chú xử lý trộn chung ô với bằng chứng |
| Case cũ không ai đóng, chất đống | Case là ẢNH CHỤP bất biến, không đối chiếu lại với thực tế |
| Việc giả ("Trả hàng · Yến Ruby") | Một phép so CHUỖI đứng ở vị trí của một phép hiểu Ý ĐỊNH |

Ba việc trong bản này sửa ba tầng đó, và tầng sau chỉ có nghĩa khi tầng trước đã đúng.

---

## 2. Hàng đợi thành bàn làm việc

Tám cột, đúng thứ tự chủ shop chốt:
`CASE · KHÁCH/ĐƠN · PHỤ TRÁCH · PHÁT SINH · TUỔI/HẠN · TRẠNG THÁI · GHI CHÚ · HÀNH ĐỘNG`.

**PHỤ TRÁCH** — ô chọn LUÔN hiện, có "Chưa ai nhận" / "Bỏ gán", nút "Nhận việc" đứng cạnh làm lối
tắt. Danh sách người lấy từ **tài khoản ERP đang bật**, đi bằng **KHOÁ** (`users.id`); TÊN do máy
chủ đọc từ bảng `users`, không nhận từ client (AGENTS.md mục 34). Bot tạo case ≠ bot phụ trách
case — dòng bot nhắn hiện "Bot đã nhắn · chưa ai nhận".

**GHI CHÚ** tách hẳn khỏi **BẰNG CHỨNG**: ghi chú gần nhất + ai ghi + lúc nào + số ghi chú; bằng
chứng vẫn ở nút "Xem bằng chứng" và không ai sửa được. Trộn hai thứ thì không ai phân biệt lời
khách với kết luận của đồng nghiệp.

**PHÁT SINH** đọc `created_at`, **không** đọc `updated_at` — sắp theo cái sau thì một lượt bấm nút
đẩy case cũ lên đầu và người trực tưởng vừa có việc mới.

**SẮP XẾP** chạy ở máy chủ qua `sort` / `dir` trên URL, giữ nguyên khi sang trang.

### Hai lỗi CÂM chỉ mở trình duyệt mới thấy

1. **Bấm sắp xếp đổi URL mà bảng không đổi.** `useQueryStates` thiếu `startTransition` nên điều
   hướng không kéo theo một lượt dựng lại ở máy chủ. `DataTable` và `UrlPagination` đều truyền nó —
   chính vì lý do này.
2. **Cột HÀNH ĐỘNG trôi ra ngoài mép phải.** Bảng dùng bố cục TỰ ĐỘNG nên `w-[180px]` ở tiêu đề chỉ
   là gợi ý: một ghi chú dài kéo ô rộng 384px, cả bảng cần 1587px. `max-w` phải đặt trên chính Ô.

Cả hai nay được khoá ở mức mã nguồn trong `tests/cs-workqueue.test.ts`.

---

## 3. Máy sinh case: hiểu câu thay vì đếm chữ

### Ca gốc

Case thật trên production — "Trả hàng / hoàn · Yến Ruby", bằng chứng nguyên văn:

> "Dừng rồi bây giờ chị em mình chốt 3 cái… **nếu chị không ưng chị không nhận**…
> đúng vậy em chuyển hàng cho chị càng nhanh càng tốt…"

Khách đang **chốt đơn** và đang **giục gửi hàng**. "Không nhận" là một **giả định**. Máy cũ thấy
chữ, tạo một việc trả hàng; CSKH mở ra thấy một việc không tồn tại, còn việc THẬT thì không ai thấy.

### Đường đi mới

```
tín hiệu ứng viên  (từ khoá · thẻ hội thoại · quan sát xác định)
   ↓
bối cảnh TOÀN ĐOẠN  (cả hội thoại, phân vai KHÁCH/SHOP, đúng trình tự thời gian)
   ↓
hiểu ngữ nghĩa      (phạm vi thời gian · ý định người nói · bằng chứng thuận & nghịch)
   ↓
CHỨNG TỪ NGHIỆP VỤ  (đơn · trạng thái POS · vận đơn)   ← THẮNG kết luận của model
   ↓
cửa tin cậy         (HIGH tạo · MEDIUM để người xem · LOW bỏ)
```

**Cửa chứng từ đứng TRƯỚC cửa tin cậy, cố ý.** "POS đã xác nhận" là một SỰ THẬT, không phải một mức
tin cậy — nên nó **bác** kết luận của model chứ không hạ bậc. Đảo lại thì một kết luận sai nhưng
"chắc chắn" vẫn lọt vào hàng đợi.

Đầu ra có cấu trúc: `{caseKind, actionable, confidence, temporalScope, speakerIntent,
supportingEvidence, contradictoryEvidence, reason}` — lưu ở `cs_cases.semantic`.
**Không lưu dòng suy nghĩ riêng của model**: nó không kiểm chứng được, không ai đọc, và là chỗ dữ
liệu khách hàng rò ra nhiều nhất.

### Mất AI thì lùi về phía HẸP HƠN

Ứng viên từ **chữ** (từ khoá, thẻ) **không tạo việc** khi không có tầng ngữ nghĩa — lùi về luật từ
khoá chính là quay lại thứ vừa bị bỏ. Ứng viên **XÁC ĐỊNH** ("khách đã cho đủ SĐT và địa chỉ mà
chưa có đơn") vẫn chạy, vì kết luận của nó đứng trên QUAN SÁT cộng CHỨNG TỪ, không trên chữ nghĩa —
và đó là loại case duy nhất trực tiếp cứu được doanh thu.

### Mức tin cậy GIỮA có làn riêng

Trạng thái `NEEDS_REVIEW` ghi lại đủ để người xem, nhưng **không** nằm trong
`CS_ACTIONABLE_STATUSES` nên không chiếm chỗ của người đang trực. "Không chắc" không được ép thành
việc.

### Một đoạn sự việc, một việc

Khoá chống trùng bám **mốc khách đưa đủ thông tin**, không bám ngày chạy job. Bản cũ đẻ một case
mới **mỗi ngày** cho cùng một lần khách đưa thông tin — và máy đối chiếu ngay sau đó lại phải đóng
chúng. Khách nhắc lại thì bằng chứng nối vào case cũ bằng sự kiện `EVIDENCE`, tách hẳn khỏi `NOTE`
của người xử lý.

---

## 4. "Đơn đã được tạo chưa" — một câu hỏi, một câu trả lời

Chủ shop chốt 14/09/2026: **POS ở trạng thái "Đã xác nhận" nghĩa là đơn ĐÃ được tạo.**

`lib/constants/order-materialized.ts` khai điều đó đúng MỘT chỗ, bám **MÃ SỐ** Pancake
(`PANCAKE_ORDER_STATUS`, "Đã xác nhận" = `1`) chứ không so chuỗi hiển thị — chuỗi là thứ Pancake
được phép đổi bất cứ lúc nào, và dấu tiếng Việt còn phụ thuộc cách chuẩn hoá Unicode của phía gửi.
Danh sách mã **sinh ra** từ bảng trạng thái, không gõ lại.

### Cửa sổ ±2 ngày — đo rồi mới chọn

Một đơn đã xác nhận trong CÙNG hội thoại vẫn chưa đủ để đóng case: hội thoại Pancake sống rất lâu.
Đo cả 10 case đang mở (production 14/09/2026) — 4 case có đơn đã xác nhận cùng hội thoại:

| Khoảng cách tới mốc case | Chặng | Đọc ra |
|---|---|---|
| **3 giờ** | CONFIRMED | đúng đơn case đang chờ |
| **5 giờ** | CONFIRMED | đúng đơn ấy |
| 83 giờ | CONFIRMED | 3,5 ngày — không kết luận được |
| 298 giờ | DELIVERED | 12,4 ngày — **khách mua lại**, đóng là đóng một việc thật |

Không có gì ở giữa. Phép đo này cũng **loại bỏ** một luật nghe rất chắc — "chỉ đóng khi đơn KHÁC
đơn máy quét đã thấy": ở **cả bốn** case, đơn đã xác nhận của hội thoại CHÍNH LÀ `cs_cases.order_id`,
nên luật ấy đóng được đúng **0** case.

Chọn 48 giờ thay vì 72 để chừa khoảng trống rõ ràng với ca 83 giờ: một ngưỡng chỉ cách dữ liệu thật
11 giờ là một ngưỡng sẽ tự lật khi có thêm vài đơn.

---

## 5. Case không còn lý do tồn tại thì tự rời hàng đợi

`lib/cs/stale.ts` đối chiếu CẢ hàng đợi với thực tế hiện tại, phân bốn kết luận:

| Kết luận | Nghĩa | Máy được ghi? |
|---|---|---|
| `KEEP_OPEN` | chứng từ vẫn đỡ được việc này | không |
| `AUTO_RESOLVE` | điều kiện không còn VÀ chưa ai cầm | **có** — đóng mềm, có lý do từng case |
| `RECLASSIFY` | việc có thật nhưng ở bàn Vận đơn & care | không |
| `NEEDS_REVIEW` | đã có người cầm — máy không đóng hộ | không |

Dùng **CHÍNH** bộ điều kiện mà nơi sinh case dùng (`checkEligibility`): một luật, hai đầu.

**Hai phía an toàn ngược nhau, cố ý.** Cùng một hàm, hai mặc định trái chiều: lúc **SINH**, loại
chưa khai điều kiện thì KHÔNG tạo; lúc **ĐÓNG**, loại chưa khai thì GIỮ NGUYÊN. Dùng chung một mặc
định là cách chắc chắn nhất để một ngày thêm loại case mới rồi im lặng đóng sạch nó.

Đóng bằng `AUTO_RESOLVED` chứ không `DONE`: `DONE` là công của NGƯỜI, và đóng 40 case bằng `DONE`
sẽ làm bảng năng suất CSKH trông như 40 lần có người gọi khách. Không xoá gì.

Chạy trong job `cs-chat` (đối chiếu TRƯỚC lượt quét), và chạy tay được qua thao tác ops `cs-stale`
(**mặc định CHẠY THỬ**; `--apply` mới ghi).

---

## 6. Đo được, không suy đoán

### Bộ đánh giá ngữ nghĩa (12 ca có nhãn, `tests/cs-semantic.test.ts`)

| Chỉ số | Giá trị |
|---|---|
| Độ chính xác (việc tạo ra là việc thật) | **100%** |
| Độ phủ (việc thật được tạo) | **100%** |
| Tỷ lệ báo nhầm | **0%** |
| Để người xem lại | 1/12 ca |

Ngưỡng **không đối xứng, cố ý**: ưu tiên độ chính xác. Một việc giả tốn một cuộc gọi của nhân viên
VÀ dạy người trực rằng hàng đợi không đáng đọc — thiệt hại kép. Một việc bỏ sót thì máy đối chiếu và
người trực còn bắt lại được.

Ca gốc "Yến Ruby" là bài kiểm hồi quy: model trả `RETURN` nhưng `temporalScope = HYPOTHETICAL` ⇒
**không** sinh case, và bản ghi nói rõ bị chặn ở cửa nào.

### QA trình duyệt (bản dựng production tại chỗ, PGlite, 29 case)

Sáng/tối × 90/100/110%: **0** lỗi console, **0** lỗi HTTP, **0** trang tràn ngang. Dòng cao trung
bình 126px (cao nhất 157px). Bảng cần 1369px (trước: 1587px) — vừa màn 1920 và 1600.

Hành vi đo được: sắp xếp mới→cũ và cũ→mới đều đúng và giữ nguyên khi sang trang 2; ô giao việc hiện
ở cả 25 dòng với danh sách tài khoản ERP thật; cột Ghi chú hiện nội dung + người + mốc + "2 ghi chú";
case "chờ người xem lại" KHÔNG nằm trong hàng đợi phải làm nhưng lọc ra được; nút chép SĐT (24) và
mã vận đơn (24) còn nguyên.

### Cổng mã nguồn

Chạy trên bản checkout **SẠCH** đúng SHA ứng viên (`git worktree add --detach 6ee2098`, `npm ci`):
`typecheck` · `lint` · `npm test` (**TẤT CẢ KIỂM THỬ ĐẠT**) · `build` — sạch cả bốn.

---

## 7. Migration

`0081_cs_case_semantic` — **một cột nullable** `cs_cases.semantic`. Không đổi kiểu, không xoá cột,
không đổi tên, không đụng dữ liệu. Dòng cũ giữ `NULL` = **CHƯA BIẾT**, không phải "model đã xem và
không nói gì". Viết tay và idempotent như 0033–0080 (ảnh chụp `drizzle/meta/*_snapshot.json` của kho
này đã cũ từ 0032, nên `drizzle-kit generate` sinh ra một bản dựng lại TOÀN BỘ lược đồ — chạy bản đó
lên production sẽ hỏng ngay ở câu lệnh đầu tiên).

Trạng thái `NEEDS_REVIEW` **không cần** migration: `cs_cases.status` là `text` không ràng buộc CHECK.
`tests/migration-upgrade-path.test.ts` chứng minh điều đó thay vì tin lời — ngày nào có người thêm
CHECK vào cột ấy thì bài kiểm đỏ, đúng lúc cần đỏ.

---

## 8. Còn chờ: đối soát HMT bằng tệp thật

Bộ máy đối soát đã dựng xong và kiểm thử đầy đủ từ bản trước. Thứ còn thiếu là **chính tệp** trên
máy có quyền đọc CSDL production.

Môi trường phiên làm việc này **không** có đường đưa tệp sang: `docs.google.com` và
`erp.vnxcommerce.com` đều bị chặn ở tầng proxy (403 CONNECT); ô "arg" của workflow hiện công khai
trên kho mã PUBLIC; và tệp tuyệt đối không được commit vào Git hay đưa vào ảnh Docker.

Nên: máy chủ đã sẵn sàng đọc `/root/hmt/*.xlsx`. Chủ shop chỉ cần **một lệnh duy nhất** từ máy đang
có tệp, rồi chạy thao tác ops `returns-hmt`.

