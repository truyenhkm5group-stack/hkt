# Báo cáo bàn giao — phiên tự động 08/09/2026

## 1. Đã làm những gì

**Phục hồi được đường nhập lịch sử Viettel Post.** Ba lỗi trong bộ nhập tệp làm mọi lần nhập lại đều
vô hiệu; đã sửa và **đang chạy trên production**:

1. **Xung đột giả do đổi hình dạng `snapshot`** — mỗi lần thêm một trường mới, toàn bộ sự kiện ghi
   trước đó thiếu khoá, `undefined !== ""`, và bị coi là "dữ liệu đã đổi". Đo được: nhập lại đúng bộ
   tệp cũ cho **1.582/1.597 dòng xung đột, ghi 0 dòng**. Nay so theo ý nghĩa, ba mức
   `same` / `changed` / `conflict`; chỉ mã vận đơn, mã đơn hàng, trạng thái và **tiền** mới là xung
   đột. Sau khi sửa: **1.582 → 10** (10 ca xung đột thật, đúng bằng con số ngày 06/09).
2. **Va chạm không gian định danh** — cột "Mã đơn hàng" của Viettel Post bị đem so với bản đồ mã vận
   đơn, làm một dòng chưa ghép được bị loại khỏi bước dò theo SĐT chỉ vì trùng chuỗi với vận đơn của
   đơn khác. Ca chứng minh: `PKE1508295104`.
3. **Thứ tự lần gửi sai** — vòng áp dụng xếp theo chuỗi mã vận đơn, mà mã tạo trước luôn nhỏ hơn,
   nên vận đơn **đã bị huỷ** luôn chiếm chỗ của vận đơn thay thế. Nay xếp theo mốc lần gửi và ưu
   tiên lần gửi chưa bị huỷ.

**Bịt lỗ hổng ngữ nghĩa `UNKNOWN`** (chưa deploy). Không có bất kỳ dấu vết nào của ĐVVC ⇒ kết quả là
**CHƯA BIẾT**, không phải "đang giao". Đặc tả `docs/business-rules/ORDER_OUTCOME.md` được sửa tường
minh theo yêu cầu chủ shop; contract test đổi kỳ vọng **theo đặc tả**, không phải để CI xanh.

**Trạng thái đơn Pancake không còn tạo ra "đã giao"** (chưa deploy). Mapper từng dịch thẳng "Đã
nhận" / "Đã thanh toán" thành `DELIVERED`, và còn ghi đè cả khi ĐVVC đã nói `PENDING`; `cod_collected`
thì lùi về COD **khai báo** — tức rửa trạng thái đơn thành chứng từ tiền.

**Hai công cụ chẩn đoán chỉ đọc** biến phỏng đoán thành dữ liệu: `vtp-statement-peek --find` (tệp có
chứa mã này không) và `vtp-replay-files --explain` (vì sao đúng dòng này không ghép được).

**Lô chứng từ chép tay** (viết xong, **chưa chạy**): nguồn `VTP_UI_MANUAL_VERIFICATION`, lô
`HISTORICAL_VTP_MANUAL_VERIFY_2026_09_08`, mốc cố định nên chạy lại không nhân bản, danh tính là mã
vận đơn, SĐT chỉ để đối chiếu.

## 2. Commit

| Commit | Nội dung | Nhánh |
|---|---|---|
| `c4234c9` | 3 lỗi importer | hotfix — **đang chạy** |
| `5fd45ef` · `8748010` | công cụ chẩn đoán | cả hai nhánh |
| `9b7e3ae` | Pancake không tạo ra "đã giao" | main |
| `3b2ea4c` | ngữ nghĩa `UNKNOWN` + luật nhập nhằng | main |
| `e754aae` · `01a8349` | nguồn chép tay + script lô 18 | main |
| `b0ede97` … `5ccfb4d` | báo cáo điều tra | main |

`main` đang **hơn production 16 commit**.

## 3. Kiểm thử

`npm test` in **TẤT CẢ KIỂM THỬ ĐẠT** · **15/15 bất biến nghiệp vụ** · `typecheck` sạch ·
`lint` 0 lỗi · Chất lượng dữ liệu **0 NGHIÊM TRỌNG**.

Bất biến mới:

- **13** — trạng thái đơn Pancake không bao giờ thành "đã giao" (gồm ca 505 "Tồn - Thông báo chuyển
  hoàn" phải ra HOÀN);
- **14** — thang thẩm quyền chứng từ chỉ có một bản, tiền/COD vĩnh viễn ở mức `NEVER`;
- **15** — không mã, không sự kiện ⇒ `UNKNOWN`, không `DELIVERED` và cũng không `IN_TRANSIT`.

Bộ kiểm thử tự bắt được hai lỗi của chính tôi trong phiên: nới lỏng phép so `snapshot` làm hỏng bất
biến *"cùng thời điểm đổi tiền không overwrite"*, và ngữ nghĩa `UNKNOWN` làm danh sách đối soát COD
lệch với số tổng (19 ≠ 20) — tức suýt tạo ra **nợ ảo**.

## 4. Tệp / schema thay đổi

**Không đổi schema, không sinh migration.** `shipment_events.source` là `text` nên nguồn mới không
cần đổi cấu trúc.

`lib/queries/return-rate.ts` · `lib/constants/{returns,truth,reconciliation}.ts` ·
`lib/integrations/{pancake/mapper,viettelpost/statement-db,viettelpost/state}.ts` ·
`lib/queries/{cod-settlement,control-tower,metrics,landing}.ts` · `lib/sync/{backfill,consistency}.ts` ·
`scripts/{vtp-manual-verify,vtp-statement-peek,vtp-replay-files}.ts` ·
`docs/business-rules/ORDER_OUTCOME.md` · 3 tệp kiểm thử mới/sửa · `.github/workflows/ops-vps.yml`.

## 5. Sức khoẻ production

| | |
|---|---|
| Commit | `c4234c9bafea` · `hotfix/vtp-import-recovery` |
| `/api/health` | `ok: true` |
| Webhook VTP 1 giờ qua | **124 gói** |
| Gói lỗi 24 giờ | **0** |
| Vận đơn / chưa có mã | 1.757 / 13 |

Realtime Viettel Post chảy đều qua đường Poscake chuyển tiếp.

## 6. Trạng thái Data Truth release

| Phần | Trạng thái |
|---|---|
| Hotfix importer | **ĐÃ LÊN production** |
| Canonical patch + `UNKNOWN` + luật nhập nhằng | **XONG, CHƯA DEPLOY** |
| Lô 18 chứng từ chép tay | **XONG, CHƯA CHẠY** |
| WRITE BACKFILL toàn cục | **KHÔNG chạy** (đúng lệnh) |

Tác động KPI dự phóng khi deploy `main` (đo bằng truy vấn chỉ đọc trên production):

| | Hiện tại | Dự phóng |
|---|---|---|
| `DELIVERED` | 421 | **412** (−9) |
| `RETURNED` | 772 | **768** (−4) |
| `UNKNOWN` | — | **13** |
| Doanh thu giao thành công | | **−4.566.000đ** |
| Tỷ lệ GTC | 35,29% | **34,92%** |

Toàn bộ tác động nằm gọn trong 13 vận đơn đã biết mặt; 0 đơn nào khác bị ảnh hưởng.

## 7. Direct VTP fulfillment — mức sẵn sàng

**Chưa bắt đầu, và cố ý không bắt đầu.** Không tạo nhánh `claude/vtp-direct-fulfillment-p1`, không
viết dòng mã nào, không gọi API tạo vận đơn.

Điều đã biết chắc và có ích cho việc đó sau này: token partner API hiện tại **đăng nhập được** nhưng
**không đọc được vận đơn nào** (`getOrderDetailV3` và `order-filter` trả rỗng, `list-data-push-his`
trả 403) vì vận đơn do Poscake tạo dưới partner của Poscake. Muốn ERP tự tạo vận đơn thì phải có
credential partner **của chính shop** với quyền tạo đơn — đây là việc phải làm với Viettel Post
trước khi viết bất kỳ dòng mã nào.

## 8. Blocker

1. **`CLAUDE_ERP_4H_AUTONOMOUS_PLAN.md` không tồn tại** — không có trong cây làm việc, lịch sử git,
   hay bất kỳ nhánh nào. Không thể thực thi kế hoạch không đọc được; tự nghĩ ra 12 pha cho ERP đang
   chạy thật là mở rộng phạm vi không đặc tả, nhất là khi phần được nhắc tới nằm đúng trong danh
   sách CẤM của phiên.
2. **Không deploy được trong phiên** — lệnh kích hoạt workflow bị bộ phân loại quyền của môi trường
   chặn. Không tìm cách lách.
3. **Lô chép tay phải đợi deploy** — ảnh Docker hiện tại chưa biết nguồn `VTP_UI_MANUAL_VERIFICATION`
   nên trạng thái sẽ không được dựng lại. Ghi bây giờ để lại trạng thái nửa vời khi không có người
   trực. Đã kiểm chứng production còn **0 bản ghi** chép tay — sạch, không có gì dở dang.

## 9. Việc chủ shop cần làm khi quay lại

1. **Gửi lại tệp kế hoạch** `CLAUDE_ERP_4H_AUTONOMOUS_PLAN.md` (kéo vào kho mã hoặc dán nội dung).
2. **Deploy `main`** — Actions → *Deploy ERP to VPS* → nhánh `main`. Workflow tự chạy `tsc` + `npm test`
   như điều kiện chặn. Đây là bước sửa số kỳ tháng 8 (−9 đơn · −4.566.000đ), cần chủ shop bấm.
3. **Sau khi deploy xanh**, chạy ops `vtp-manual-verify` **không tham số** (chạy thử) rồi
   `--apply`. Lô có định danh riêng nên rollback được độc lập.
4. **Đối chiếu lại một số**: `PKE1484463365` — tệp xuất của Viettel Post ghi thu hộ **30.000đ**,
   giao diện web ghi **474.000đ**. Script đang dùng số 474.000 theo bản chủ shop xác minh.
5. **Xác nhận hai mã chép tay**: `PKE14844634301P1` và `PKE14844634303` không tồn tại trong tệp xuất
   của Viettel Post; hai mã có thật khớp từng thuộc tính là `PKE14844634031P1` và `PKE1484463403`
   (đảo chữ số). Script dùng mã có thật và lưu nguyên văn chuỗi đã chép.

## 10. An toàn để deploy

- Nhánh `main` toàn bộ: canonical patch + `UNKNOWN` + luật nhập nhằng + nguồn chép tay + công cụ
  chẩn đoán. Test 15/15, typecheck sạch, lint 0 lỗi, tác động KPI liệt kê được từng đơn.

## 11. TUYỆT ĐỐI CHƯA ĐƯỢC BẬT

- **WRITE BACKFILL toàn cục** (`canonical-backfill --apply`) — chạy thử vẫn cho 70 vận đơn đổi trạng
  thái, trong đó 17 rời `DELIVERED`, và guardrail cố ý trả `outcomeAfter: null` nên **không đo được**
  tác động lên kết quả đơn. Chạy ghi là chốt số mà không biết chốt cái gì.
- **Direct VTP fulfillment** — chưa có mã, chưa có credential, chưa có thiết kế được duyệt.
- **Tạo vận đơn Viettel Post thật** từ ERP.
- **Xoay secret webhook** — đúng một lần xoay ngày 04/09 đã làm đứt toàn bộ đường nạp dữ liệu suốt
  gần ba ngày mà không ai biết, vì triệu chứng chỉ xuất hiện sau lần deploy kế tiếp.
