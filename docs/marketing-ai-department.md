# Phòng Marketing AI — đặc tả và lộ trình

> **File trạng thái DUY NHẤT của phòng.** Mọi nấc cập nhật vào đây, không mở file mới.
> Cập nhật: **22/09/2026** · **Nấc 0 đã dựng (trí nhớ); Nấc 1 trở lên chờ chủ shop quyết**
>
> Đọc kèm: `docs/ads-decision-contract.md` (hợp đồng chỉ số) · `docs/marketing-daily-contract.md` ·
> `docs/tech-ai-room-status.md` (phòng AI đầu tiên — mọi lớp lỗi ở đó sẽ lặp lại ở đây) ·
> `AGENTS.md` mục 3 và mục 19.

---

## 0. Câu hỏi thật, và câu trả lời thẳng

Chủ shop yêu cầu: *"phòng Marketing AI agent có thể tự động làm việc trong mọi khâu mà không cần
đến tôi can thiệp"*.

Đo ngày 22/09/2026, ERP đứng ở đây:

| Khâu marketing | ERP làm được gì hôm nay | Thiếu gì để máy tự làm |
|---|---|---|
| 1. ĐO hiệu quả theo ngày | `lib/queries/marketing-daily.ts` — đủ | — |
| 2. CHẨN ĐOÁN nguyên nhân | `lib/marketing/diagnose.ts` — phát hiện có bằng chứng, có `why` và `owner` | — |
| 3. QUYẾT ĐỊNH từng chiến dịch | `decideAction()` — hàm THUẦN, có cổng từ chối kết luận | — |
| 4. NHỚ đã quyết gì, có ai làm không, kết quả ra sao | **KHÔNG CÓ** (tới 22/09) | ⇒ **Nấc 0 dựng ở bản này** |
| 5. LÀM: đổi ngân sách · tắt/bật chiến dịch | **KHÔNG CÓ ĐƯỜNG NÀO** | ⇒ **Nấc 3, cần chủ shop quyết** |
| 6. NỘI DUNG: ý tưởng, câu chữ, ảnh | `marketing_ideas` là bảng ghi tay, không nối vào vòng | ⇒ Nấc 4 |

**Khâu 5 là cái trần thật, và nó không phải giới hạn của mô hình.** `lib/integrations/facebook/client.ts`
chỉ có đường `GET`: không có `method`, không có một lời gọi ghi nào tới Graph API. ERP ĐỌC Facebook
và chưa bao giờ ghi. Kho mã tự khai điều đó ở `lib/constants/work-sources.ts`:

> *"CỐ Ý chỉ có nút MỞ. ERP đọc Facebook Ads chứ không ghi, nên một nút 'Tạm dừng' ở đây sẽ là nút
> giả: người bấm tin đã xong, tiền vẫn chảy."*

Nên câu trả lời trung thực cho *"tự động trong MỌI khâu"* là: **bốn khâu đầu máy làm được và bản
này đưa khâu 4 vào chỗ; khâu 5 cần một quyết định của chủ shop mà không ai thay được** — mở quyền
`ads_management` là cho một cỗ máy tiêu tiền thật. Xem mục 5.

---

## 1. Ranh giới không được xoá

Giống hệt nền tảng nhân sự AI đã chốt (`docs/ai-workforce.md` §1), và không có ngoại lệ nào cho
marketing:

**ERP là nguồn sự thật. Agent là người làm việc đọc ERP qua cổng công cụ.** Không có đường nào để
mô hình trở thành nguồn của: doanh thu · giá vốn · cước · kết quả đơn · tồn kho · quy kết đơn về
chiến dịch.

**Văn bản mô hình sinh ra KHÔNG BAO GIỜ là một quyết định.** Quyết định nằm ở `decideAction()` —
hàm thuần, có kiểm thử bảng chân lý. Mô hình chỉ diễn đạt lại và xếp thứ tự. Nếu một ngày có người
nối mô hình vào chỗ SINH RA khuyến nghị thì phòng này mất đúng thứ làm nó đáng tin.

**Sổ quyết định không tính tiền.** `ads_decision_ledger` chép lại kết luận; không báo cáo tài chính
nào đọc nó. Job ghi sổ hỏng hoàn toàn cũng không làm lệch một con số tiền.

---

## 2. Năm nấc, và nấc nào đã có

```
Nấc 0  TRÍ NHỚ      sổ quyết định + độ bền                        ✅ bản này
Nấc 1  VIỆC         khuyến nghị đã chín → hàng đợi /work          ⏳ (Nấc 0 phải có dữ liệu trước)
Nấc 2  DIỄN ĐẠT     agent đọc sổ, viết bản tin, xếp ưu tiên       ⏳
Nấc 3  BÀN TAY      ghi ngân sách Facebook, có trần và phanh      ⏸ CHỦ SHOP QUYẾT
Nấc 4  NỘI DUNG     ý tưởng → chiến dịch → kết quả, khép vòng     ⏸
```

Thứ tự này không đảo được. Nấc 3 mà không có Nấc 0 là một cỗ máy tiêu tiền không có trí nhớ: nó sẽ
cắt một chiến dịch hôm nay, thấy số liệu đổi, bật lại ngày mai, và không ai đọc được vì sao.

---

## 3. Nấc 0 — TRÍ NHỚ (đã dựng)

### 3.1 Vì sao bảng quyết định chưa đủ

`lib/queries/ads-decision.ts` tính lại từ đầu mỗi lần ai đó mở `/ads`. Nó trả lời rất tốt *"lúc này
nên làm gì"*, và cố ý không trả lời ba câu còn lại:

- hôm qua nó khuyên gì — nên không ai biết nó có đổi ý xoành xoạch không;
- sau lời khuyên có ai làm gì không;
- làm rồi thì kết quả ra sao.

Với NGƯỜI, ba câu ấy là tiện nghi. Với một AGENT thì chúng là điều kiện tồn tại. **Phòng Tech đã
cắn đúng lớp lỗi này**: dây chuyền chạy trọn nửa ĐI rồi đứng, vì việc trên `/tech` không bao giờ
biết PR của nó đã mở — không gì đỏ, hàng đợi chỉ lặng lẽ nói sai theo hướng dễ tin nhất
(`docs/tech-ai-room-status.md`, mục *Nửa VỀ*).

### 3.2 Kỳ chuẩn — MỘT, và không phụ thuộc người đang xem

**14 ngày, kết thúc NGÀY HÔM QUA (giờ Việt Nam)** (`ledgerPeriod()`, hàm thuần).

- *Kết thúc hôm qua* vì hôm nay chưa đóng: tiền quảng cáo tiêu từ sáng còn hàng chưa tới tay ai.
  Một ngày đang chạy luôn trông như đang lỗ.
- *14 ngày* vì cổng độ chín của `decideAction` đòi 60% đơn đã ngã ngũ. Hàng đi 3–7 ngày, nên cửa sổ
  7 ngày sẽ rơi vào `INSUFFICIENT_DATA` gần như mọi hôm — một sổ toàn chữ "chưa đủ dữ liệu" không
  phải trí nhớ, chỉ là tiếng ồn có ngày tháng.

Bảng trên màn hình vẫn chạy theo kỳ người dùng chọn, và đó là hành vi ĐÚNG cho một màn tra cứu.
Hai kỳ đứng cạnh nhau thì giao diện phải nói ra — nếu không người đọc sẽ tin "giữ 4 ngày" là nói về
tháng họ đang xem.

### 3.3 Độ bền — hai số, và vì sao không phải một

Cửa sổ 14 ngày **lăn** nghĩa là hai ngày liên tiếp dùng chung 13/14 dữ liệu. Nên *"hôm nay giống
hôm qua"* gần như luôn đúng, và một cổng chỉ nhìn chuỗi liên tiếp sẽ mở sau đúng ba ngày cho một
chiến dịch đang nhảy qua nhảy lại quanh điểm hoà vốn — **tưởng là thận trọng, thực ra là tự động
gật**.

Thứ phân biệt một dòng ĐÃ NGÃ NGŨ với một dòng ngồi trên ranh giới là **số lần đổi ý**. Nên cổng có
hai vế và phải qua cả hai:

| | `minHeldDays` | `maxFlips` (trong 10 ngày) | vì sao |
|---|---|---|---|
| `CUT` | 3 | 1 | đang chảy máu, chờ lâu mất thêm tiền; nhưng cắt nhầm là giết một dòng đang học |
| `SCALE` | 4 | 1 | cam kết thêm ngân sách ⇒ đòi bằng chứng dày hơn cắt |
| `FIX_DELIVERY` | 2 | 2 | không đụng ngân sách, rẻ khi sai ⇒ cho đi sớm hơn |

> **Ba bộ số này là ĐỀ XUẤT KHỞI ĐIỂM, chưa được chủ shop chốt** (AGENTS.md mục 7). Mã nguồn nói
> thẳng như vậy thay vì im lặng nhận là đã chốt. Sửa ở `lib/constants/marketing-decision-ledger.ts`,
> và chỉ ở đó.

### 3.4 Bốn cách một khuyến nghị bị từ chối — và chúng khác nhau

`lib/marketing/decision-stability.ts::stabilityOf()` là hàm THUẦN (vào là mảng dòng sổ, ra là kết
luận). Bốn lý do, vì gộp lại là lấy mất khả năng sửa:

| Lý do | Nghĩa | Tự khỏi? |
|---|---|---|
| `STALE` | sổ chưa ghi tới hôm nay — job không chạy nghĩa là **ERP KHÔNG BIẾT**, không phải "không có gì đổi" | **KHÔNG** — phải đi xem vì sao job không chạy |
| `YOUNG` | khuyến nghị mới, chưa giữ đủ ngày | có |
| `UNSTABLE` | đổi ý quá nhiều lần: dòng đang sát một ngưỡng | có |
| `RULE_CHANGED` | cửa sổ có hơn một phiên bản luật ⇒ chuỗi không so được với chính nó | có |

`STALE` tách riêng vì đúng lớp lỗi mà phòng Tech ghi lại: *"một bộ tự động chỉ đúng khi nó chạy
đúng nhịp là một bộ tự động sẽ sai."*

### 3.5 Những điều sổ CỐ Ý không làm

- **Không backfill.** Sổ bắt đầu rỗng và quá khứ không dựng lại được: kết luận của ngày 12/09 phải
  tính trên dữ liệu NHƯ NÓ CÓ ngày 12/09, mà đơn hôm ấy còn treo nay đã ngã ngũ. Một chuỗi "đã giữ
  30 ngày" dựng ngược là một lời nói dối có vẻ thuyết phục (mục 8.8 và mục 35).
- **Không bắc cầu qua ngày thiếu.** Ngày không có dòng là CHƯA ĐO, và nó CẮT chuỗi (mục 42).
- **Không nối chuỗi qua hai phiên bản luật.** Cùng chữ `CUT` sinh bởi hai bộ ngưỡng khác nhau không
  phải cùng một kết luận (mục 40).
- **Không ghi `adset`/`ad`.** Hai cấp ấy không có số chi, nên mọi dòng sẽ mang `NO_SPEND_DATA`:
  hàng nghìn dòng mỗi ngày, không kết luận nào, chỉ có dung lượng.

### 3.6 Tệp

| Tệp | Việc |
|---|---|
| `lib/constants/marketing-decision-ledger.ts` | kỳ chuẩn · phiên bản luật · ngưỡng độ bền · hạng hành động |
| `lib/marketing/decision-stability.ts` | `stabilityOf()` — hàm thuần, bốn lý do từ chối |
| `lib/marketing/decision-ledger.ts` | **đường GHI duy nhất** (job) |
| `lib/queries/marketing-ledger.ts` | đường ĐỌC (`lib/queries/*` là chỉ-đọc — `tests/advisory-safety.test.ts` canh ở mức mã nguồn) |
| `drizzle/0108_ads_decision_ledger.sql` | bảng, thuần bổ sung |
| `tests/marketing-decision-ledger.test.ts` | kỳ chuẩn thuần · chưa-đo ≠ không-đổi · đổi luật cắt chuỗi |

### 3.7 Bật sổ

Job `marketing-decision-ledger` **mặc định KHÔNG có trong lịch** — thêm một mục vào lịch là đổi
lịch (mục 7). Bật bằng:

```
MARKETING_LEDGER_EVERY_MINUTES=30
```

Chạy dày là an toàn và có chủ ý: khoá duy nhất `(ngày quyết định, chiều, mục)` biến mọi lượt sau
trong ngày thành CẬP NHẬT — lượt thứ 48 không đẻ thêm một dòng nào. Chạy dày là để **không bỏ lỡ
một ngày** khi máy chủ khởi động lại, và một ngày bỏ lỡ thì mất hẳn.

Chạy tay một lượt: ops `run-job` với `arg = marketing-decision-ledger`.

---

## 4. Nấc 1 và 2 — VIỆC và DIỄN ĐẠT (chưa làm)

**Nấc 1.** Khuyến nghị `ready = true` đi vào hàng đợi `/work` qua nguồn `ADS_DECISION` đã khai sẵn
ở `lib/constants/work-sources.ts`. Hai điều phải giữ:

- Nó là **PHÉP CHIẾU**, không phải bản sao (AGENTS.md mục 19): `work_items.status` bắt buộc `NULL`,
  và dòng rời hàng đợi khi điều kiện sinh ra nó hết. Không có nút "đánh dấu xong".
- Bộ lọc là `ready`, không phải `ACTIONABLE`. Đưa cả dòng chưa chín vào hàng đợi là biến hàng đợi
  thành danh sách mọi chiến dịch — và một hàng đợi như thế bị tắt sau một tuần.

**Nấc 2.** Agent đọc sổ + phát hiện của `diagnose()`, viết bản tin và xếp ưu tiên. Dùng lại nguyên
`lib/marketing/ai-context.ts` (bối cảnh có cấu trúc, không gửi dữ liệu thô) và `ai-explain.ts` (lớp
tuỳ chọn, không bao giờ chặn đường). Phần mới duy nhất là đưa **độ bền** vào bối cảnh: một khuyến
nghị đã giữ 6 ngày và một khuyến nghị mới nảy hôm nay không được viết bằng cùng một giọng.

---

## 5. Nấc 3 — BÀN TAY ⏸ **CẦN CHỦ SHOP QUYẾT**

Đây là nấc biến "trợ lý" thành "nhân viên", và là nấc duy nhất chạm tiền thật.

### 5.1 Phải mở gì

Token Facebook hiện có chỉ đọc. Để ERP đổi được ngân sách cần quyền **`ads_management`** trên System
User token, và `lib/integrations/facebook/client.ts` phải có đường `POST` — hôm nay nó không có.

### 5.2 Hàng rào tối thiểu, nếu chủ shop đồng ý

Không nấc nào dưới đây được bỏ. Chúng chép từ nền tảng đã chốt (`docs/ai-workforce.md` §9) vì lớp
lỗi giống hệt, chỉ khác là ở đây tiền chảy ra ngay chứ không qua một khách hàng:

1. **Chặn cứng cấp môi trường.** `AI_ALLOW_ADS_WRITE` đọc THẲNG từ biến môi trường, **không** hợp
   nhất với bảng `settings` — ghi khoá ấy vào CSDL là ghi vào hư không. Chỉ đúng chuỗi `"true"` mở
   được. Chốt này đứng TRƯỚC mọi chốt khác.
2. **Một cổng ghi duy nhất.** Đúng một tệp trong kho gọi API ghi của Facebook, để đọc một tệp là
   kiểm chứng được lời khẳng định "chưa bật thì không ghi gì".
3. **Trần dịch chuyển ngân sách mỗi ngày** — theo phần trăm của tổng chi, và theo số tuyệt đối. Một
   cỗ máy không có trần là một cỗ máy sẽ tiêu hết ngân sách tháng trong một đêm vì một lỗi dấu.
4. **Cổng độ bền là bắt buộc**, không phải khuyến khích: chỉ `ready = true` mới được thực thi.
5. **Phiếu duyệt ở nấc COPILOT** — cơ chế token HMAC đã có ở `lib/ai/policy.ts`, dùng lại nguyên.
6. **Mỗi lần ghi để lại một dòng sổ** với ảnh chụp trước/sau và lý do, nối vào đúng dòng
   `ads_decision_ledger` đã sinh ra nó. Không có dòng ấy thì không đo được bàn tay làm tốt hay xấu.
7. **Phanh tự động**: `N` lần ghi liên tiếp mà lợi nhuận góp sau quảng cáo đi xuống ⇒ dừng và báo
   người. Máy phải biết tự nghi ngờ mình.

### 5.3 Con đường KHÔNG được đi

`ADS_BUDGET_MUTATION` đã có mặt trong sổ phê duyệt hai bước (`tests/second-approval` liệt kê nó ở
nhóm **CHƯA nối**). Nối nó vào một nút bấm trước khi có mục 5.2 là dựng một nút giả thứ hai — lần
này là nút giả có thể tiêu tiền.

---

## 6. Nấc 4 — NỘI DUNG (chưa làm)

`marketing_ideas` hôm nay là một bảng ghi tay không nối vào vòng nào: không ai biết ý tưởng nào đã
thành chiến dịch, và chiến dịch ấy ra bao nhiêu tiền. Khép vòng ấy (ý tưởng → chiến dịch →
`ads_decision_ledger` → kết quả) là thứ cho phép hỏi *"kiểu nội dung nào đang kiếm ra tiền"* — câu
mà hôm nay không ai trong shop trả lời được bằng số.

Nấc này **không phụ thuộc Nấc 3** và làm được ngay sau Nấc 1.

---

## 7. Đo trên production — chưa làm được từ máy này

Máy làm việc hiện tại không có `gh` CLI và không có `.env`, nên mọi con số ở tài liệu này là con số
**cấu trúc** (đọc từ mã nguồn), không phải số production. Ba câu cần đo ngay sau khi bật sổ, bằng
ops `db-query` (một câu mỗi ô, enum cast `::text`):

```sql
-- 1. Sổ có chạy không, và có đủ ngày không
select decision_day, dimension, count(*) as dong, count(*) filter (where action_class = 'ACTIONABLE') as can_lam
from ads_decision_ledger group by 1, 2 order by 1 desc, 2 limit 30;
```

```sql
-- 2. ERP có đổi ý xoành xoạch không — số lần đổi khuyến nghị trong 10 ngày, theo chiến dịch
select entity_key, entity_name, count(distinct action) as so_khuyen_nghi, count(*) as so_ngay,
       min(action) as vi_du
from ads_decision_ledger
where dimension = 'campaign' and decision_day >= to_char(now() - interval '10 days', 'YYYY-MM-DD')
group by 1, 2 having count(distinct action) > 1 order by 3 desc limit 30;
```

```sql
-- 3. Bao nhiêu tiền đang nằm ở nhóm KHÔNG kết luận được (câu quan trọng nhất của cả bảng)
select decision_day, sum(spend) filter (where action_class = 'NO_OPINION') as tien_chua_ket_luan,
       sum(spend) filter (where action_class = 'ACTIONABLE') as tien_co_viec, sum(spend) as tong
from ads_decision_ledger where dimension = 'campaign' group by 1 order by 1 desc limit 14;
```

---

## 8. BLOCKED / HUMAN GATE

> ### ⏸ 1 · Ngưỡng độ bền (mục 3.3)
> Ba bộ số đang là đề xuất khởi điểm. Chủ shop chốt thì sửa ở
> `lib/constants/marketing-decision-ledger.ts` và tăng `DECISION_RULE_VERSION`.

> ### ⏸ 2 · Bật job ghi sổ (mục 3.7)
> Một biến môi trường. Chưa bật thì Nấc 1 trở lên không có dữ liệu để đứng lên.

> ### ⏸ 3 · Nấc 3 — quyền ghi Facebook (mục 5)
> **Quyết định của chủ shop, không ai thay được.** Mở `ads_management` là cho một cỗ máy tiêu tiền
> thật. Tôi giữ lại và không tự làm.

---

## 9. NEXT

| Việc | Phụ thuộc |
|---|---|
| Bật `MARKETING_LEDGER_EVERY_MINUTES`, đo ba câu ở mục 7 sau 7 ngày | chủ shop bật |
| Nấc 1 — chiếu khuyến nghị đã chín vào `/work` | sổ có ít nhất `minHeldDays` ngày dữ liệu |
| Nấc 2 — đưa độ bền vào bối cảnh AI | Nấc 1 |
| Nấc 4 — khép vòng nội dung | Nấc 1 |
| Nấc 3 — bàn tay | **quyết định của chủ shop** |
