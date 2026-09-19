# Khoá đồng thời của GitHub Actions — ai chờ ai, và vì sao

*19/09/2026. Đi kèm `.github/workflows/*` và `tests/ops-concurrency.test.ts`.*

> **Bản này gồm hai đợt.** Đợt 1 (PR #15) tách khoá theo tác động và đã đo được trên
> production. Đợt 2 chuyển hàng đợi xuống `flock` trên VPS để vá hai lỗi mà đợt 1 làm lộ ra
> — xem mục 2.

## 0 · Vấn đề đo được

Tới trước bản này, `deploy-vps.yml` và `ops-vps.yml` cùng khai **một** nhóm khoá ở **mức
workflow**. Khoá ấy được giữ từ **giây đầu tiên** của lượt chạy, chứ không phải từ lúc có gì đó
chạm tới máy chủ.

**Đo thật, deploy #352 (`31dceb0`, 19/09/2026)** — lấy từ mốc của từng bước trong GitHub Actions,
không phải ước lượng:

| Giai đoạn | Thời gian | Chạm VPS? |
| --- | ---: | --- |
| chờ cấp máy chạy | 0m25s | không |
| `gates / gates` (toàn vẹn · tsc 39s · eslint 21s · `npm test` 1m30s · `next build` 2m03s) | **5m05s** | không |
| checkout + setup-node + **`npm ci` mà job cũ không dùng tới** | 0m21s | không |
| đăng nhập GHCR | 0m01s | không |
| dựng ảnh Docker + đẩy GHCR | **2m56s** | không |
| **SSH vào VPS + `bootstrap.sh` (pull · migration · khởi động lại)** | **8m13s** | **có** |
| kiểm HTTPS từ bên ngoài | 0m00s | đọc |
| **Tổng** | **17m08s** | |

**8m48s trong 17m08s — 51% — là thời gian khoá bị giữ mà không có gì chạm tới máy chủ.** (Một
bản nháp của tài liệu này ghi "khoảng 80%"; con số ấy là ước lượng và nó SAI. Đo ra thì bước SSH
là giai đoạn **dài nhất** của lượt deploy, không phải ngắn nhất.)

### Cái giá đã trả, cũng đo được

Cùng ngày, hai lượt deploy xếp hàng sau một lượt khác:

- **#346** tạo lúc `08:00:17`, job **đầu tiên** của nó khởi động lúc `08:13:30` — đúng **2 giây**
  sau khi #345 kết thúc (`08:13:28`). **13m13s chờ suông, không làm một việc gì.** Tổng lượt chạy
  30m18s cho ~17 phút công việc.
- **#348** tổng 25m45s cho cùng khối lượng công việc ấy, cùng một nguyên nhân.

Và đó mới chỉ là deploy chờ deploy. Mọi thao tác **chỉ đọc** — `status`, `logs`, `db-query` mười
giây — cũng đứng trong đúng hàng đợi đó. Với nhiều phiên làm việc song song (`AGENTS.md` mục 9),
mọi phiên chờ nhau để hỏi một câu không đổi một byte nào.

## 1 · Bảng TRƯỚC / SAU

| Tình huống | Trước | Sau |
| --- | --- | --- |
| CI của hai PR khác nhau | song song *(đã đúng từ trước)* | song song |
| CI của hai commit trên CÙNG một PR | lượt cũ bị huỷ | lượt cũ bị huỷ |
| CI của hai commit trên `main` | lượt cũ bị huỷ | **giữ cả hai** — mỗi commit có lượt kiểm riêng |
| cổng + dựng ảnh của deploy ⟷ `status` / `logs` / `db-query` | **xếp hàng** | **song song** |
| cổng + dựng ảnh của deploy ⟷ báo cáo chỉ đọc (`smoke`, `profit-verify`…) | **xếp hàng** | **song song** |
| cổng của deploy ⟷ dựng ảnh của cùng lượt deploy | nối đuôi | **song song** |
| hai lượt `db-query` / `status` / `logs` bất kỳ | **xếp hàng** | **song song, không giới hạn** |
| hai lượt dò API ngoài (`vtp-probe`, `phone-probe`…) | xếp hàng | xếp hàng *(cùng làn `probe`)* |
| một lượt dò API ⟷ một báo cáo nặng | **xếp hàng** | **song song** (hai làn khác nhau) |
| bước SSH của deploy ⟷ bất kỳ thao tác GHI nào | xếp hàng | **xếp hàng** *(giữ nguyên — đây là điều phải giữ)* |
| hai thao tác GHI bất kỳ | xếp hàng | **xếp hàng** *(giữ nguyên)* |
| một thao tác `--apply` ⟷ deploy | xếp hàng | **xếp hàng** *(giữ nguyên)* |

**Thời gian chờ giảm ở đâu** — tính trên đúng các con số đo được ở mục 0:

- **Thao tác chỉ đọc**: trước phải chờ hết 17m08s của một lượt deploy; nay **chờ 0**. Đây là phần
  lớn nhất, và là lý do của cả bản sửa.
- **Thao tác GHI ⟷ deploy**: trước chờ 17m08s; nay chờ **8m13s** (chỉ job `release`). Vẫn xếp
  hàng — **đó là điều phải giữ** — nhưng chỉ trong phần thật sự chạm máy chủ.
- **Chính lượt deploy**: `gates` (5m05s) và `build_image` (~3m01s) chạy song song thay vì nối
  đuôi, và `release` không còn `npm ci` thừa. Đường tới production còn ≈ **13m45s** thay vì
  17m08s — **nhanh hơn ~3m20s, khoảng 20%** — mà không bỏ một cổng nào.

## 2 · Hàng đợi nằm trên máy chủ, không nằm ở GitHub

**Bản đầu (PR #15) dùng `concurrency` của GitHub làm hàng đợi. Chạy production nửa tiếng thì lộ ra
hai lỗi.** Cả hai đều chỉ máy chủ thật mới nói được.

### Lỗi A — lượt đọc bị deploy giết giữa chừng

| Mốc | Sự việc |
| --- | --- |
| 13:41:25 | `explain-stock` (lượt ops 1406) khởi động |
| 13:41:29 | job `release` của deploy #354 bắt đầu |
| 13:44:11 | lượt đọc chết: `container ... is not running` |

Nhóm concurrency cho hai bên chạy song song — đó đúng là điều PR #15 muốn — nhưng **không có gì
nói cho lượt đọc biết container dưới chân nó sắp bị dựng lại.**

### Lỗi B — `concurrency` của GitHub KHÔNG phải một hàng đợi

Một nhóm giữ tối đa **một lượt đang chạy + MỘT lượt đang chờ**. Lượt thứ ba tới **huỷ lượt đang
chờ**. Đo thật: lượt 1395 và 1416 bị huỷ đúng như vậy.

Với một nhóm GHI, điều đó nghĩa là **một lệnh ghi đã gửi đi có thể biến mất thay vì chờ tới
lượt** — im lặng, và người gửi chỉ thấy chữ "cancelled". *(Đừng viết trong tài liệu rằng nó là
FIFO. Nó không phải.)*

### Bản vá: ba ổ khoá `flock` trên VPS

GitHub nay chỉ làm MỘT việc: cho job **khởi động**. Việc chờ tài nguyên do `flock` quyết — và
`flock` là hàng đợi thật của nhân Linux, không ai bị đá ra vì có người tới sau.

| Ổ khoá | Ai lấy | Chế độ |
| --- | --- | --- |
| `/var/lock/erp-lifecycle.lock` | deploy `release` · mọi thao tác GHI | **ĐỘC QUYỀN** |
| | mọi thao tác đọc cần container đứng yên | **CHIA SẺ** |
| `/var/lock/erp-readonly-db.lock` | đọc nặng (báo cáo · EXPLAIN · màn hình thật · chạy thử) | ĐỘC QUYỀN |
| `/var/lock/erp-readonly-probe.lock` | dò API ngoài (VTP · Pancake · Meta) | ĐỘC QUYỀN |

Khoá gắn vào một **file descriptor** của shell, nên SSH đứt hay tiến trình chết là nhân **tự
nhả**. Không tự chế khoá bằng "tạo tệp rồi xoá tệp": kiểu đó để lại khoá ma vĩnh viễn mỗi lần một
lượt chạy bị huỷ giữa chừng — mà ở đây lượt chạy bị huỷ thật.

### Thứ tự lấy khoá là cố định — và đó là cả phần chứng minh không bế tắc

```
(1) khoá tài nguyên (db / probe, ĐỘC QUYỀN)   →   (2) khoá vòng đời (CHIA SẺ)
```

Thao tác GHI chỉ lấy (2) ĐỘC QUYỀN và **không bao giờ đụng (1)**. Không đường nào lấy (2) rồi mới
xin (1), nên đồ thị chờ không có chu trình.

Thứ tự này còn quan trọng vì lý do thứ hai: một lượt đọc nặng **đang xếp hàng ở (1) thì chưa cầm
(2)**, nên nó không vô tình chặn deploy trong lúc chính nó đang chờ.

### Hết giờ thì dừng hẳn và nói ra

Trần chờ hữu hạn: đọc 900s, ghi 1800s (ops), release 1200s — trần của release nhỏ hơn
`command_timeout` và `timeout-minutes` của job, nên hết giờ là **đỏ với một lời báo đọc được**,
không phải bị cắt ngang ở một chỗ tuỳ tiện. Không có nhánh nào "chờ không được thì thôi chạy
luôn": chạy một lệnh ghi song song với deploy đúng là thứ cả bản này sinh ra để chặn.

Mỗi lượt lấy khoá ghi nhật ký: mã lượt chạy · tên thao tác · lúc bắt đầu chờ · lúc lấy được · số
giây đã chờ.

### Cái gì còn giữ `concurrency` của GitHub, và vì sao nó vô hại

Chỉ `ci.yml`. Nhóm của nó chỉ chứa lượt chạy **đọc mã nguồn trên máy của GitHub** — nó không SSH
đi đâu cả, nên huỷ một lượt CI của commit đã bị thay thế không đánh mất thao tác VPS nào. Bài kiểm
khoá luôn điều đó: `ci.yml` không được chứa `appleboy/ssh-action`.

### Điều bản này KHÔNG phủ

Bộ lập lịch chạy **trong** container tự nó ghi CSDL và không đi qua ổ khoá nào. Ổ khoá này điều
phối các thao tác đi **từ GitHub** xuống, không phải mọi thứ chạm CSDL.

`flock` của Linux cũng **không hứa công bằng**: về lý thuyết một dòng lượt đọc nhẹ liên tục có thể
làm một lượt xin ĐỘC QUYỀN đói. Trần chờ hữu hạn biến tình huống đó thành một lượt deploy ĐỎ có
thông báo rõ, thay vì một lượt treo vô hạn.

## 4 · Thao tác `verify` — một lượt thay cho năm

Actions → **Vận hành ERP trên VPS** → `action = verify`. CHỈ ĐỌC, và nó **đỏ được**:

| Phần | Hỏi gì | Làm lượt kiểm đỏ khi |
| --- | --- | --- |
| 1/5 | `docker compose ps` + `/api/health` | ERP không trả `ok:true`, hoặc có dịch vụ đã dừng |
| 2/5 | `nproc` · `free` · `uptime` · `docker stats` | không (đây là số để đọc) |
| 3/5 | `df -h /` · `docker system df` | ổ đĩa ≥ 90% (cảnh báo từ 80%) |
| 4/5 | 500 dòng log gần nhất, lọc dấu hiệu lỗi, **che secret** | không — log luôn có lỗi lẻ; con số để so với lần trước |
| 5/5 | `smoke` — mở thật các màn hình chính | smoke không đạt |

`smoke` đứng riêng vẫn giữ `|| true` như cũ: nó là một phép **ĐO**, còn `verify` là một phép
**KIỂM**. Một lượt kiểm không bao giờ đỏ được thì không phải một lượt kiểm.

## 5 · Deploy vẫn không thể triển khai một bản chưa qua cổng

`release` khai `needs: [gates, build_image]`, và bước đầu tiên của nó **so ba SHA**: bản cổng
thật sự đã kiểm (`git rev-parse` trong job `gates`, không phải tham số chép lại) · bản đã dựng
thành ảnh · bản đang triển khai — cộng với **nhãn của ảnh**, vì ảnh mới là thứ VPS kéo về. Lệch
một cái là dừng **trước** khi SSH chạy.

Ảnh của một commit đỏ cổng vẫn nằm ở GHCR (vì `build_image` chạy song song với cổng) nhưng **không
bao giờ được triển khai**.

## 6 · Bài kiểm chặn ở mức mã nguồn

`tests/ops-concurrency.test.ts` chạy trong `npm test`, tức là trong cổng của mọi PR và của deploy.
`tsc` và `eslint` không đọc YAML lẫn shell, và một lỗi khoá không hiện ra ở đâu cả cho tới khi hai
lượt chạy thật gặp nhau trên máy chủ — lúc ấy triệu chứng là "container biến mất giữa một phép
đo".

Nên bài kiểm **trích khối khoá ra và CHẠY THẬT với `flock` thật**, không mô phỏng bằng lời:

- hai lượt đọc nặng **nối tiếp**, lượt sau ghi nhận số giây đã chờ > 0;
- hai lượt đọc nhẹ **chồng nhau** trong vùng tới hạn (khoá chia sẻ còn nguyên tác dụng);
- một lượt GHI **chờ** lượt đọc nhả khoá rồi mới vào — **bản vá cho lỗi A**;
- **ba lệnh ghi liên tiếp: không lệnh nào biến mất**, vùng tới hạn của chúng không chồng nhau, và
  ít nhất hai lệnh thật sự đứng chờ — **bản vá cho lỗi B**;
- hết giờ ⇒ thoát **75**, in `::error::`, và **không chạy thao tác**;
- ba lượt cùng lúc ở cả hai ổ khoá đều kết thúc — **không bế tắc**.

Phần đọc mã nguồn khoá thêm: không workflow nào dùng `concurrency` làm hàng đợi VPS · `ops` và
`release` không có khối `concurrency` · thứ tự FD 8 → FD 9 cố định ở mọi nhánh đọc và nhánh GHI
không đụng FD 8 · khoá gắn vào FD chứ không phải tệp tồn tại/bị xoá · trần chờ của release nhỏ hơn
giới hạn của bước SSH và của job · `--apply`/`--write`/`--fix` vẫn ép sang GHI · mặc định vẫn là
GHI · 24 thao tác ghi không lọt vào làn đọc · tên check bắt buộc `gates / gates` còn nguyên.
