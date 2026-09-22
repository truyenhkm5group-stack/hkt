# Lượt xử lý care — "đã care mấy lần rồi" và vì sao con số backlog cũ nói sai

Đặc tả của `lib/constants/care-rounds.ts`. Luật sống trong mã; tệp này ghi **số đo** và **vì sao**.

---

## 1. Vấn đề chủ shop nêu (22/09/2026)

> *"Báo cáo hiệu quả care hiện số case còn treo đúng là số case cần care chứ không phải treo những
> case đã care rồi làm đánh giá sai tình hình care đơn."*

Thẻ **"Backlog cần care"** in `counts.care` — tổng kiện đang ở góc nhìn "Cần care". Con số ấy gộp
hai thứ đòi hai hành động trái ngược:

| Kiện | Việc phải làm |
|---|---|
| Chưa ai mở ra nhìn bao giờ | Gọi ngay |
| Đã gọi khách 3 lượt, vừa hẹn lại chiều mai | **Đừng đụng vào** |

Gộp lại thì đội càng chăm chỉ con số càng không chịu giảm — và người đọc kết luận đội không làm gì.

---

## 2. Một LƯỢT XỬ LÝ là gì

Đếm trên **hai sổ việc**, và chỉ hai:

- `care_actions` — người ghi việc ĐÃ LÀM với khách (gọi · nhắn · sửa địa chỉ · hẹn lại).
- `care_decisions` — người bấm một KẾT QUẢ (Đã hoàn · Phát tiếp · Xử lý sau).

**Không tính**: đổi trạng thái, đặt hẹn, và đặc biệt là **giao việc**. Chúng là *chạm vào*, đếm
riêng ở `touches` — luật 57: gộp lại thì không phân biệt được *đội đã làm việc* với *đội đã nhìn
thấy*, và một trưởng nhóm bấm giao 50 ca trong ba phút sẽ làm 50 ca trông như đã xử lý.

Cửa sổ gộp `CARE_ROUND_MERGE_MINUTES = 5`: hai ghi nhận của **cùng một người** cách nhau ≤ 5 phút
là **một** lượt. Lý do có thật ở đường ghi — `addCareNote` ghi vào `care_actions`,
`recordCareDecision` ghi vào `care_decisions`, nên một thao tác ("gọi khách xong rồi bấm Phát
tiếp") để lại **hai** dòng ở hai sổ.

### Cửa sổ 5 phút là số ĐO ĐƯỢC, không phải số đoán

Khoảng cách giữa hai ghi nhận liên tiếp của cùng một kiện, đo production 22/09/2026 (51 cặp trên
toàn bộ 441 đợt):

| Khoảng cách | Cùng người | Khác người |
|---|---:|---:|
| ≤ 1 phút | 8 | 0 |
| 1 – 5 phút | 5 | 0 |
| **5 – 30 phút** | **2** | 0 |
| 30 phút – 4 giờ | 4 | 0 |
| > 4 giờ | 27 | 5 |
| **Tổng** | **46** | **5** |

Hai cụm tách hẳn nhau, và **khe hẹp nhất nằm ở 5–30 phút (2 cặp)**. Mốc 5 phút đặt vào đúng khe đó:
nó gộp 13 cặp "cùng một lần ngồi làm" và không gộp nhầm lần quay lại nào. Nới lên 30 phút chỉ thêm
2 cặp — không đáng đổi một ngưỡng để lấy 2 cặp.

**Mix việc đổi thì ĐO LẠI** rồi sửa ở `CARE_ROUND_MERGE_MINUTES`. Đừng đoán, và đừng gõ lại số 5 ở
chỗ thứ hai.

### Hai dòng không nối được tài khoản thì GỘP (đếm thiếu)

Lựa chọn có chủ ý, và `tests/care-rounds.test.ts` khoá nó lại vì "sửa" nó theo hướng ngược nghe rất
hợp lý. Đếm **thừa** làm ca trông đã được xử lý nhiều hơn thực tế ⇒ **giấu việc**. Đếm **thiếu** thì
ca nổi lên hàng đợi sớm hơn và người trực mở ra thấy ngay là đã làm rồi. Chỉ một trong hai chiều tự
sửa được khi có người nhìn.

---

## 3. "Còn treo" bổ ra ba con số

`careBacklogGroup(rounds, followUpAt, now)` — hàm thuần, và là một phép **BỔ**: tổng ba nhóm bằng
đúng `counts.care`, không kiện nào rơi ra, không kiện nào đếm hai lần.

| Nhóm | Nghĩa | Việc |
|---|---|---|
| `UNTOUCHED` | 0 lượt | **Đây là "số case cần care" thật** |
| `WORKED_DUE` | ≥ 1 lượt, hẹn đã qua hoặc chưa hẹn | Đọc lại lượt trước rồi làm tiếp |
| `WORKED_SCHEDULED` | ≥ 1 lượt, hẹn còn ở phía trước | **Đừng đụng**, chưa tới giờ |

Thẻ báo cáo in `UNTOUCHED` làm con số lớn, hai nhóm kia đứng ngay dưới — không giấu, vì chúng vẫn
là việc, chỉ không phải cùng một việc.

### Số đo production 22/09/2026 — 42 đợt care đang mở

| Nhóm | Đợt | Chưa hẹn | Quá hẹn | Còn trong hẹn |
|---|---:|---:|---:|---:|
| 0 lượt (chưa ai đụng) | **25** | 25 | 0 | 0 |
| 1 lượt | 10 | 0 | 4 | 6 |
| 2 lượt | 6 | 0 | 5 | 1 |
| ≥ 3 lượt | 1 | 0 | 1 | 0 |

Theo trạng thái xử lý:

| Trạng thái | Đợt | 0 lượt | 1 | 2 | ≥3 |
|---|---:|---:|---:|---:|---:|
| `ASSIGNED` | 22 | **22** | 0 | 0 | 0 |
| `WAITING_REDELIVERY` | 10 | 0 | 5 | 4 | 1 |
| `WAITING_CARRIER` | 7 | 0 | 5 | 2 | 0 |
| `NEW` | 3 | 3 | 0 | 0 | 0 |

**17/42 đợt đang mở đã có người xử lý** — 40% con số backlog cũ là việc đã được làm ít nhất một
lượt.

---

## 4. Phát hiện kèm theo: "phản hồi đầu" đang đếm lần GIAO VIỆC

`lib/care/service.ts::setCareOwner` ghi `first_response_at` ngay lúc giao việc.

Đo 22/09/2026: **22 trong 25 đợt chưa xử lý lần nào vẫn mang `first_response_at`** — tất cả đều ở
`ASSIGNED` với **0 hành động chăm sóc và 0 lần chạm** ngoài chính cú bấm giao việc.

Hệ quả:

- 22 ca ấy **không bao giờ bị tính vỡ hạn phản hồi đầu**, dù chưa ai gọi một cuộc nào;
- trung vị "Phản hồi đầu" đang đo **tốc độ bấm giao việc**, không đo tốc độ chăm khách.

Đây đúng kịch bản luật 57 đã cấm cho `care_actions`, nhưng cột này chưa ai rà lại.

**Chưa sửa** — thôi ghi mốc ở đường giao việc sẽ làm đổi số vỡ SLA của các ca đang chạy, thuộc diện
phải hỏi chủ shop (AGENTS mục 7). Thay vào đó thẻ báo cáo in con số cảnh báo
(`firstResponse.assignedOnly`) **ĐỨNG CẠNH** trung vị, để người đọc biết trung vị kia đang đứng
trên cái gì.

---

## 5. "ĐVVC có tin mới sau lượt xử lý cuối"

`history.carrierNewsAfterLastRound` — so mốc sự kiện ĐVVC gần nhất với lượt xử lý cuối.

Người trực gọi khách lúc 9 giờ rồi hẹn xem lại chiều mai; 10 giờ Viettel Post báo phát hụt lần nữa.
Cái hẹn vẫn giữ ca nằm im tới chiều mai, trong khi nó đứng trên một bức tranh đã cũ. Cờ này là thứ
duy nhất trên dòng nói ra điều đó.

Đo 22/09/2026: **3 trong 17 đợt đã xử lý** rơi vào trường hợp này. Số nhỏ, nhưng nó là số kiện mà
người trực đang ra quyết định bằng thông tin sai.

---

## 6. SQL dán sẵn cho ops `db-query` (chỉ đọc)

Một câu mỗi lần; enum cast `::text`; CTE không tồn tại sang câu sau.

### 6.1 Phân bố số lượt trên các đợt đang mở

```sql
with dot as (
  select c.id, c.shipment_id, c.care_status::text as st,
         coalesce(c.opened_at, c.created_at) as bat_dau, c.follow_up_at
    from shipment_care c where c.active
), luot as (
  select d.*,
    (select count(*) from care_actions a where a.shipment_id = d.shipment_id and a.created_at >= d.bat_dau) as n_action,
    (select count(*) from care_decisions x where x.care_case_id = d.id) as n_decision
  from dot d
)
select case when n_action + n_decision = 0 then '0 chua dung'
            when n_action + n_decision = 1 then '1 luot'
            when n_action + n_decision = 2 then '2 luot' else '3+ luot' end as nhom,
       count(*) as dot,
       count(*) filter (where follow_up_at is null)     as khong_hen,
       count(*) filter (where follow_up_at <= now())    as qua_hen,
       count(*) filter (where follow_up_at >  now())    as trong_hen,
       count(*) filter (where first_response_at is null) as chua_phan_hoi
  from luot group by 1 order by 1;
```

> Câu này đếm **dòng thô**, chưa áp cửa sổ gộp 5 phút, nên nó là **cận trên** của số lượt thật.
> Muốn con số đúng bằng con số trên màn hình thì đọc qua `getCareQueue()`, nơi `careRoundCount`
> chạy.

### 6.2 Kiểm lại cửa sổ gộp (chạy lại khi mix việc đổi)

```sql
with so as (
  select shipment_id, created_at as at, actor_id from care_actions
  union all
  select shipment_id, decided_at as at, actor_user_id from care_decisions
), g as (
  select at - lag(at) over (partition by shipment_id order by at) as khoang,
         actor_id is not distinct from lag(actor_id) over (partition by shipment_id order by at) as cung_nguoi
  from so
)
select cung_nguoi,
  count(*) filter (where khoang <= interval '1 minute')                                    as le1p,
  count(*) filter (where khoang >  interval '1 minute'  and khoang <= interval '5 minutes') as p1_5,
  count(*) filter (where khoang >  interval '5 minutes' and khoang <= interval '30 minutes') as p5_30,
  count(*) filter (where khoang >  interval '30 minutes' and khoang <= interval '4 hours')  as p30_4h,
  count(*) filter (where khoang >  interval '4 hours')                                      as tren4h,
  count(*) as tong
from g where khoang is not null group by cung_nguoi;
```

Khe hẹp nhất phải nằm ở **ngay trên** cửa sổ gộp. Nếu một ngày nào đó cụm dồn vào 5–30 phút thì
cửa sổ đang cắt nhầm giữa một lần ngồi làm — đổi `CARE_ROUND_MERGE_MINUTES`, đừng vá từng chỗ đọc.

### 6.3 "Phản hồi đầu" có bao nhiêu phần là giao việc

```sql
with dot as (
  select c.id, c.shipment_id, coalesce(c.opened_at, c.created_at) as bat_dau, c.first_response_at
    from shipment_care c where c.active
)
select count(*) filter (where first_response_at is not null) as co_moc_phan_hoi,
       count(*) filter (
         where first_response_at is not null
           and not exists (select 1 from care_actions a where a.shipment_id = dot.shipment_id and a.created_at >= dot.bat_dau)
           and not exists (select 1 from care_decisions x where x.care_case_id = dot.id)
       ) as moc_chi_do_giao_viec
  from dot;
```

Con số thứ hai phải tiến về 0. Nó đang là **22/25** (22/09/2026).

---

## 7. Vòng hai (22/09/2026) — bốn việc đọc theo lượt xử lý

### 7.1 "Đã phản hồi chưa" thôi đếm cú bấm GIAO VIỆC

Chủ shop chốt: sửa ở **tầng đọc**. Cột `shipment_care.first_response_at` **giữ nguyên trong CSDL**
— không migration, không backfill (đoán là thứ mục 35 cấm), không mất một dòng lịch sử nào. Câu hỏi
*"đội đã phản hồi chưa"* đọc theo **lượt xử lý thật**:

| Nơi | Trước | Sau |
|---|---|---|
| `slaOf().firstResponseBreached` | `first_response_at` | `teamResponded()` → `firstRoundAt` |
| `careSlaBucket()` ("sắp quá hạn") | bản chép tay của cùng phép tính | cùng vị từ |
| Trung vị "Phản hồi đầu" của báo cáo | `first_response_at` | `CARE_FIRST_ROUND_AT` (SQL) |

Ba vị từ (`teamResponded` · `teamWorkEnded` · `followUpStillHolds`) nay sống ở **một chỗ**
(`lib/care/view.ts`). Trước đó `responded` và `paused` được chép tay trong `careSlaBucket`, nên bản
vá này sẽ chỉ tới được một trong hai nơi và một ca hiện "bình thường" ngay cạnh con số nói nó đã
quá hạn.

**Ba giá trị, ba nghĩa** của `firstRoundAt` (luật 42):

| Giá trị | Nghĩa | Hành vi |
|---|---|---|
| `undefined` | nơi gọi CHƯA ĐỌC lịch sử | lùi về cột cũ |
| `null` | đã đọc, KHÔNG có lượt nào | chưa phản hồi |
| `Date` | lượt xử lý thật đầu tiên | đã phản hồi |

Hệ quả trên màn hình: **số vỡ hạn phản hồi đầu TĂNG** (tới 22 ca đang ẩn hiện ra), trung vị
"Phản hồi đầu" **tăng** (chậm hơn, vì thôi tính những cú bấm giao việc mất 2 giây). Số xấu đi, và
đó là số thật.

### 7.2 Tin ĐVVC mới làm hết hiệu lực cái hẹn

`followUpStillHolds()`. Một cái hẹn là lời khai *"tôi đã làm phần mình, tới giờ đó tôi quay lại"* —
nó đứng trên bức tranh của **lúc đặt hẹn**. Người trực gọi khách 9 giờ rồi hẹn chiều mai; 10 giờ
Viettel Post báo phát hụt lần nữa. Cái hẹn không còn nói về tình trạng hiện tại nhưng vẫn giữ ca
nằm im tới chiều mai.

Nay ca quay lại **Cần care**. Nó **không xoá** `follow_up_at` và **không ghi gì** vào CSDL — câu
hỏi này đọc ra lúc xem, nên nó tự đúng lại khi có người xử lý thêm một lượt.

Góc nhìn và đồng hồ đổi **cùng nhau**: ca rời "Đang chờ" mà đồng hồ vẫn dừng thì nó nằm ở Cần care
và không bao giờ vỡ hạn — một dòng vô hình với mọi cảnh báo.

Đo 22/09/2026: **3 trong 17 đợt đã xử lý**.

### 7.3 "Đã giao mà chưa ai bắt đầu"

Đo 22/09/2026: **22 đợt `ASSIGNED` với 0 lượt và 0 lần chạm**. Cột `open` một mình không nói được
điều đó — một người cầm 10 việc và làm cả 10 trông y hệt một người cầm 10 việc và chưa mở cái nào.

- Bảng **"Khối lượng đang cầm"**: thêm cột `Chưa bắt đầu`.
- Trên dòng: nhãn **"đã giao, chưa bắt đầu"**.

### 7.4 Độ nguội giữa hai lượt

`careRoundGapsHours()` + `timingStat()` (ngưỡng và độ phủ dùng chung với `lib/constants/care-timing.ts`).

Trả lời câu **khác hẳn** "phản hồi đầu": cái kia hỏi *đội bắt đầu nhanh không*, cái này hỏi *đội có
bỏ ca giữa chừng không*. Một đội gọi trong 20 phút rồi im ba ngày và một đội gọi sau 3 giờ rồi gọi
lại mỗi sáng cho ra **cùng một con số** ở phép đo thứ nhất.

Mỗi ca đóng góp **đúng một phiếu** (trung vị các khoảng của chính nó) — một ca được gọi tám lượt
không được lấn át bảy ca chỉ có một khoảng.

> Trên dữ liệu 22/09/2026 thẻ này đọc **"—"**: chỉ 7/42 ca đang mở có từ 2 lượt trở lên, dưới
> ngưỡng `TIMING_MIN_SAMPLE = 10`. Đó là kết quả **đúng**, và thẻ nói thẳng lý do thay vì in một
> con số dựng trên 7 ca.

### 7.5 Nhật ký hai cột, tải khi mở

Cột trái **Viettel Post nói gì · chứng từ**, cột phải **Đội làm gì · nhật ký xử lý**. Đứng cạnh
nhau, **không trộn** — luật 47: trộn thành một dòng thời gian thì đọc xuôi rất dễ, nhưng sau vài
dòng không ai còn phân biệt được đâu là chứng từ và đâu là việc shop tự làm.

Hành trình ĐVVC **tải khi người mở** (`loadCarrierJourney`, chỉ đọc, quyền `shipments:view`), không
đi kèm hàng đợi: trang Vận đơn đã nằm trong danh sách trang chậm, và cột này chỉ được mở ở vài dòng
mỗi buổi. "Đang đọc…" là một trạng thái riêng — một danh sách rỗng ở đó là một lời khẳng định sai
trong nửa giây.

### 7.6 Ô ghi note nói ra đây là lượt thứ mấy

*"Khách hẹn mai"* ở lượt 1 và ở lượt 3 là hai tình huống khác hẳn nhau — cái sau nghĩa là khách đã
hẹn rồi lỡ hai lần. Chữ gợi ý lấy thẳng `CARE_ROUND_BAND_HINT`, cùng bộ chữ với chip lọc và tooltip
của nút mở nhật ký, nên ba chỗ không nói ba điều khác nhau về cùng một rổ.

### 7.7 Một luật, hai bản — và một bài kiểm so chúng

`CARE_FIRST_ROUND_AT` (SQL, cho báo cáo theo kỳ) và `CareHistory.firstRoundAt` (TS, cho hàng đợi)
là cùng một luật viết hai lần. Chúng **nằm cạnh nhau** trong `lib/queries/care-workbench.ts`, và
`tests/care-workbench.test.ts` chạy cả hai trên **cùng dữ liệu** rồi so từng kiện — đúng cách
`tests/care-reopen.test.ts` khoá cặp TS/SQL của luật mở ca.

Không có cửa sổ gộp trong bản SQL, và đó là đúng: gộp chỉ ảnh hưởng tới phép **đếm** số lượt; mốc
lượt **đầu tiên** là `min` của hai sổ dù có gộp hay không.
