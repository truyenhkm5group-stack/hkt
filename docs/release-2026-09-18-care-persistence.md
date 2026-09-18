# Bản phát hành 18/09/2026 — Ca care đã xử lý xong thôi tự quay lại

Luật: `AGENTS.md` mục **59–64**.
Mã: `lib/care/reopen-guard.ts` · `lib/constants/care-reopen-class.ts` · `lib/constants/care-timing.ts`.
Kiểm thử: `tests/care-reopen.test.ts` · `tests/care-os.test.ts`.
Không migration nào trong vòng này — **không cột mới, không backfill** (mục 8.8 và mục 35).

---

## 0. Trạng thái: ĐÓNG

Lỗi P0 "mất note / ca quay lại sau khi hoàn tất" **đã đóng ngày 18/09/2026**, sau khi chủ shop
kiểm chứng trực tiếp trên production bằng thao tác thật.

---

## 1. KIỂM CHỨNG THỦ CÔNG TRÊN PRODUCTION — CHỦ SHOP THỰC HIỆN

Đây là phần **không một phiên agent nào làm thay được**: không phiên nào điều khiển được trình
duyệt với phiên đăng nhập thật, nên trong suốt vòng sửa này tôi đã nêu rõ là chưa PASS và không
được báo PASS thay. Chủ shop tự chạy và xác nhận:

| Bước | Kết quả |
|---|---|
| Hoàn tất một ca care ở `/shipments` | **PASS** |
| Tải lại trang (F5) | **PASS** |
| Note còn nguyên sau khi tải lại | **PASS** |
| Chờ bộ đối chiếu (10 phút/lần) chạy rồi tải lại | **PASS** |
| Ca **không** quay lại hàng đợi "Cần care" | **PASS** |

Năm bước này phủ đúng chuỗi triệu chứng người dùng báo ban đầu. Không anomaly mới nào được ghi nhận.

**Vì sao bước này là bắt buộc và không thay bằng kiểm thử tự động được:** bài kiểm chạy trên PGlite
dựng lại đường mở ca và bộ đối chiếu, nhưng nó không chứng minh được rằng *trình duyệt thật, phiên
đăng nhập thật, bộ nhớ đệm thật* hợp lại vẫn cho ra cùng kết quả. Một lỗi persistence mà chỉ lộ ra
sau một lượt revalidate hay một lần gửi lại biểu mẫu sẽ đi lọt qua mọi bài kiểm ở tầng dịch vụ.

---

## 2. Nguyên nhân gốc — đo được, không suy luận

Cả hai đường mở ca (`applyCarrierEventToCare` từ webhook và `reconcileCareCoverage` chạy 10
phút/lần) hỏi cùng một câu SAI: *"kiện này có đợt nào ĐANG MỞ không?"*

Người bấm hoàn tất làm `active = false`, nên câu trả lời là "không" — và một đợt **mới** được mở cho
đúng tình trạng ĐVVC **cũ**, chưa đổi một chữ. Bộ đối chiếu chạy mỗi 10 phút nên ca quay lại gần như
tức thì, trạng thái về "Chưa xử lý", note của đợt cũ không hiện nữa.

Đếm trên toàn bộ dữ liệu care lúc đó:

```
18 cặp đợt liên tiếp trên cùng một kiện
16 cặp có mốc kích hoạt CŨ HƠN HOẶC BẰNG mốc đóng của đợt trước
16 do BỘ ĐỐI CHIẾU tạo ra (source_trigger = 'RECONCILE')
12 trong số đó làm "mất" một note
 2 cặp hợp lệ — có sự kiện ĐVVC MỚI sau khi đóng
```

**Note chưa bao giờ mất khỏi CSDL.** Nó nằm ở `care_actions` (append-only, mang khoá tài khoản) và ở
`last_note` của đợt **cũ**. Màn hình đọc đợt ĐANG MỞ, và đợt đang mở lúc đó là đợt mới, trắng trơn.
Vì vậy sửa đường **mở ca** mới là sửa đúng chỗ; đường ghi note vốn không hỏng. Chép note sang đợt
mới sẽ là **bịa ra một hành động chưa từng xảy ra** trên đợt đó (mục 60).

---

## 3. Luật thay thế

Chỉ mở đợt mới khi **mốc kích hoạt (mốc ĐVVC) MỚI HƠN mốc đóng của đợt gần nhất**.

* bằng nhau **không** phải mới hơn — chính lúc bấm hoàn tất là lúc người ta nhìn thấy trạng thái đó;
* ĐVVC không cho mốc ⇒ **không mở**. Lùi về "giờ hiện tại" ở nhánh này là dựng lại một đợt mỗi mười
  phút, mãi mãi. Nhánh lỗi phải rơi về phía **hẹp hơn**;
* **không** chặn theo `entry_carrier_state`: 7/16 lần dựng lại mang nguyên nhân khác mà mốc vẫn cũ —
  chặn theo nguyên nhân sẽ để lọt đúng 7 ca đó;
* **không** chặn theo mã vận đơn: một kiện có quyền hỏng lần thứ hai thật, và 2 cặp hợp lệ quan sát
  được chính là loại đó.

Luật sống ở **hai bản** — TypeScript (`canOpenNewEpisode`) và SQL (`chuaAiXuLyXongSql`) — và
`tests/care-reopen.test.ts` chạy cả hai trên cùng dữ liệu rồi so từng kiện, nên chúng không trôi xa
nhau được.

Kèm theo: đóng một ca **đã đóng** không được ghi gì thêm (mục 61). `canTransition` cho phép tự
chuyển, nên một cú bấm hai lần từng ghi thêm một dòng `care_actions`, thêm một mốc `RESOLVE`, và đẩy
`done_at` về lần bấm sau.

---

## 4. Phần đã trót sinh ra: ba câu trả lời, không phải hai

Các đợt sinh ra bởi lỗi này vẫn nằm trong CSDL sau khi luật đã vá, và vẫn được đếm như ca độc lập ở
**mọi** con số care. Phân loại **đọc ra lúc xem**, không ghi cột mới:

| Loại | Số cặp (đo 18/09) | Vào mẫu số? |
|---|---:|---|
| `FALSE_REOPEN_LEGACY` — mốc cũ hơn **và** không sự kiện ĐVVC xen giữa | 10 | **không** |
| `REOPEN_UNVERIFIED` — mốc cũ hơn **nhưng** có sự kiện xen giữa | 6 | **có** |
| `LEGITIMATE_REOPEN` — mốc mới hơn lúc đóng | 3 | có |

Vòng trước tôi báo "16 false reopen". Con số đó **gộp hai nhóm khác nhau** và tôi đã sửa lại: gộp 6
cặp giữa vào nhóm lỗi là khẳng định một điều không chứng minh được, và nó làm con số lỗi to lên 60%.
Gộp vào nhóm thật thì giấu mất chúng. Loại `REOPEN_UNVERIFIED` ra khỏi mẫu số chỉ vì không chắc
cũng là giấu việc — nên nó **vẫn đếm**.

---

## 5. Monitoring giữ nguyên — `new_false_reopen_after_fix`

`REOPEN_GUARD_LIVE_AT` (18/09 ~04:10Z, lúc luật mới bắt đầu chạy thật trên production) chia đôi con
số: bản sao tạo **trước** mốc đó là di sản đã vá; tạo **sau** là lỗi **còn đang xảy ra** và phải
bằng 0. Gộp hai bên làm chủ shop tưởng lỗi chưa hết trong khi nó đã hết.

Màn hình `/shipments` in riêng, và in **xanh khi bằng 0 / đỏ khi > 0**. Đo lại 18/09 07:54Z:

```
FIRST_EPISODE      338    tạo sau khi vá: 2
REOPEN_CU_HON       16    tạo sau khi vá: 0    mới nhất 16/09 14:02Z
LEGITIMATE_REOPEN    3    tạo sau khi vá: 1    (PKE1517089542 #2 — đã xác minh hợp lệ)
```

**`new_false_reopen_after_fix = 0`.** Cả 16 bản sao đều được tạo **trước** mốc vá.

Ô này **không được tắt, không được làm tròn về 0, và không được gộp vào một ô "OK" chung**. Nếu nó
> 0 thì luật mở ca đã hở lại, và đó là một lỗi P0 khác chứ không phải một con số cần giải thích.

---

## 6. Kèm trong cùng vòng: thẻ điểm care thôi nói sai về con người

Ba lỗi liên tiếp trên cùng một ô số, mỗi lỗi tìm ra bằng một phép đo khác nhau.

**(a) Sai cột.** Ô "thời gian phản hồi" cạnh tên nhân viên đọc `first_action_at` — cột chỉ được ghi ở
đúng một đường (`requestCarrierAction`). Đo 16/09: `first_action_at` có ở **2/319** đợt, còn
`first_response_at` (việc care hằng ngày ghi) có ở **193/319**. Con số đang hiện là trung vị của
**hai dòng**. Sửa: **hai cột riêng**, mỗi cột mang độ phủ của chính nó, mẫu dưới
`TIMING_MIN_SAMPLE` (10) thì trả `null` chứ không in một con số nhỏ (mục 63).

**(b) Sai grain.** `percentile_cont` đi chung câu SQL nhóm theo `(người × kết cục)`, nên ô in trung
vị của **một nhóm kết cục** — nhóm nào thắng tuỳ thứ tự dòng Postgres trả về, tức con số còn đổi
giữa hai lần chạy. Sửa: tách thành hai phép gom, mỗi cái theo đúng grain của nhãn nó phục vụ.

**(c) "Làm sạch" sai cách.** Đo lại thấy 36/232 đợt có `first_response_at` sớm hơn `opened_at`. Bản
vá đầu tiên của tôi loại chúng khỏi phép tính vì "thời gian âm là vô nghĩa" — nghe hợp lý. Đo
trước/sau:

| | Trung vị "chạm đầu" |
|---|---:|
| Giữ nguyên | **266 phút** |
| Loại 36 ca âm | **594 phút** |

Chênh lệch âm **sâu nhất** trong cả 36 đợt là **dưới 30 giây**, và cả 36 đều `source_trigger =
'MANUAL'`: người mở ca bằng tay thì hai mốc được ghi trong **cùng một thao tác**, thứ tự giữa chúng
ngẫu nhiên ở mức mili giây. Đó là những ca **phản hồi ngay**. Phép "làm sạch" ấy cắt đúng 34 ca
nhanh nhất và làm đội trông chậm gấp đôi.

Luật thay thế (mục 64): âm **trong** dung sai ghi ⇒ **kẹp về 0 và vẫn tính**; chỉ âm **quá** dung
sai mới ra khỏi phép tính và phải **đếm riêng**, hiện lên màn hình. Đo sau khi deploy: mâu thuẫn
thật = **0**, trung vị giữ nguyên **266 phút / 210 ca**.

Bài học đã thành luật: **trước khi loại bất kỳ nhóm quan sát nào khỏi một con số chấm người, phải đo
con số ấy trước và sau khi loại.**

---

## 7. Số cuối trên production (18/09)

| Chỉ số | Giá trị |
|---|---|
| Bản sao ca tạo sau khi vá | **0** |
| Đợt mở sau khi vá | 3 (2 đợt đầu, 1 mở lại hợp lệ) |
| Trung vị "chạm đầu" — Trần Anh Quân | 266 phút / 210 ca |
| Trung vị "hành động đầu" | `—` / 2 ca (dưới ngưỡng, không phát biểu) |
| Mốc mâu thuẫn quá dung sai | 0 |

---

## 8. Không làm gì thêm cho care

Vòng này đóng lại ở đây. Không thêm feature care, không refactor lại bản vá vừa deploy. Việc còn
mở duy nhất là **giữ ô `new_false_reopen_after_fix`**: nếu nó > 0 thì cảnh báo ngay, không tự che.
