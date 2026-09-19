# Khoá đồng thời của GitHub Actions — ai chờ ai, và vì sao

*19/09/2026. Đi kèm `.github/workflows/*` và `tests/ops-concurrency.test.ts`.*

## 0 · Vấn đề đo được

Tới trước bản này, `deploy-vps.yml` và `ops-vps.yml` cùng khai **một** nhóm khoá ở **mức
workflow**. Nhóm ấy gộp ba loại việc hoàn toàn khác nhau vào một hàng đợi:

| Việc | Chạy ở đâu | Chạm VPS? | Thời gian |
| --- | --- | --- | --- |
| cổng chất lượng (typecheck · lint · test · build) | máy của GitHub | **không** | ~10–15 phút |
| dựng ảnh Docker + đẩy GHCR | máy của GitHub | **không** | ~6–10 phút |
| SSH vào VPS, `docker pull`, khởi động lại, migration | VPS | **có** | ~2–5 phút |
| `db-query` chỉ đọc | VPS | có (đọc) | ~10 giây |
| nhập bảng kê COD (GHI) | VPS | **có (ghi)** | vài phút |

Thứ **thật sự** không được chạy đè lên nhau chỉ là hai hàng cuối cùng cộng với bước SSH của
deploy. Nhưng khoá ở mức workflow giữ chỗ từ **giây đầu tiên**, nên khoảng 80% thời gian một lượt
deploy giữ khoá là khoảng thời gian nó **không chạm tới máy chủ**. Với nhiều phiên làm việc song
song (`AGENTS.md` mục 9), mọi phiên đứng chờ nhau để hỏi một câu chỉ đọc.

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

**Thời gian chờ giảm ở đâu:** ở đúng phần không chạm máy chủ. Một lượt deploy ~20 phút trước đây
chặn mọi thao tác khác suốt 20 phút; nay nó chỉ chặn các thao tác **GHI**, và chỉ trong ~2–5 phút
của job `release`. Một phiên muốn chạy `db-query` trong lúc phiên khác deploy: trước chờ tới 20
phút, nay chờ 0.

**Bản thân lượt deploy cũng nhanh hơn**: `gates` và `build_image` chạy song song thay vì nối đuôi,
và job `release` không còn `npm ci` thừa (job cũ cài phụ thuộc rồi không dùng tới).

## 2 · Bốn nhóm khoá, và luật của từng nhóm

| Nhóm | Ai dùng | Song song? | Huỷ lượt cũ? |
| --- | --- | --- | --- |
| `ci-<sự kiện>-<ref>` | `ci.yml` | mỗi nhánh một làn | chỉ trên pull request |
| `vps-readonly-shell-<mã lượt chạy>` | `status` · `perf` · `disk` · `logs` · `db-query` | **không giới hạn** | không |
| `vps-readonly-probe` | dò API ngoài (VTP · Pancake · Meta) | 1 lượt | không |
| `vps-readonly-db` | báo cáo nặng · mở màn hình thật · EXPLAIN · mọi thao tác CHẠY THỬ | 1 lượt | không |
| `vps-mutating` | **mọi thao tác GHI + job `release` của deploy** | 1 lượt | **không bao giờ** |
| `tech-agent-run` · `tech-cto-plan` | `agent-run.yml` · `cto-plan.yml` | 1 lượt mỗi loại | không |

`agent-run.yml` và `cto-plan.yml` **không đổi**: chúng chạy trên máy của GitHub, không SSH vào
production, và nhóm khoá của chúng bảo vệ một tài nguyên thật (bằng chứng của lượt chạy, hạn mức
khoá AI) chứ không phải VPS. Chúng chưa bao giờ nằm trong nút thắt này.

### Vì sao hai làn đọc nặng vẫn có hạn mức 1 lượt

VPS chỉ ~1,9 GB và **đang phục vụ người dùng thật**. Mỗi `docker exec erp-app npx tsx` là một
tiến trình Node vài trăm MB. **"Chỉ đọc" nói về DỮ LIỆU, không nói về BỘ NHỚ** — thả tự do mười
lượt đọc song song là tự gây ra đúng sự cố mình định đi đo. Hai làn tách riêng vì chúng tranh hai
tài nguyên khác nhau: `probe` chờ mạng ra ngoài, `db` ăn CPU/RAM/CSDL. Làn `shell` không có hạn
mức vì nó **không dựng tiến trình nào trong container** — nó chỉ hỏi Docker và chạy `psql` ở chế
độ chỉ đọc; bài kiểm chặn việc ai đó lén thêm `npx tsx` vào một thao tác của làn này.

## 3 · Ba luật khoá chặt bảng phân loại

1. **MẶC ĐỊNH LÀ GHI.** Nhánh cuối của biểu thức là `vps-mutating`. Thêm một thao tác mới vào
   `options` mà quên phân loại ⇒ nó rơi vào làn **an toàn nhất**, không phải một làn đọc.
   (`AGENTS.md` mục 31: mọi nhánh lỗi rơi về phía HẸP HƠN.)
2. **`--apply` / `--write` / `--fix` đè lên tất cả.** Hơn một nửa thao tác "chỉ đọc" ở đây là
   CHẠY THỬ theo mặc định và GHI THẬT khi có cờ. Phân loại theo TÊN thao tác thôi là sai ngay lần
   đầu ai đó gõ `--apply`.
3. **Ghi một dòng vẫn là ghi.** `vtp-import-preview` chỉ đọc `shipments` nhưng vẫn tạo một dòng
   `vtp_import_batches` (mục 49); `sepay-verify` phát lại một gói tin thật. Cả hai ở
   `vps-mutating` — không có hạng "ghi một chút".

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

`tests/ops-concurrency.test.ts` chạy trong `npm test`, tức là trong cổng của mọi PR và của deploy:

- nhóm khoá gộp-tất-cả ngày xưa không quay lại được, và deploy/ops không được khoá ở mức workflow;
- ba làn đọc không giao nhau, chỉ chứa thao tác có thật trong `options`;
- 24 thao tác GHI (danh sách viết tay, độc lập với YAML) không bao giờ lọt vào làn đọc;
- mặc định là GHI, và cờ `--apply/--write/--fix` đứng TRƯỚC mọi phân loại theo tên;
- `gates` / `build_image` không giữ khoá, `release` giữ và không cắt ngang, `release` cần cả hai;
- tên check bắt buộc `gates / gates` còn nguyên (đổi tên job là gỡ khoá `main` mà không ai thấy);
- khối `verify` được **trích ra và CHẠY THẬT** dưới `bash -e` với `docker` giả: xanh khi máy khoẻ
  (kể cả ca "không có lỗi nào để in" — đúng bẫy đã giết deploy #244), đỏ ở năm kiểu hỏng, và che
  secret trước khi in.
