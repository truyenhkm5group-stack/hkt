# Company OS — Bàn giao Agent B (Creative ↔ Ads theo mẫu)

Nhánh `claude/cos-b-creative-ads`, dựng trên `origin/main` @ `5a3a7ee6`. **Không migration.** Không
đổi ngưỡng creative, rào ghi quảng cáo hay đường ghi Facebook nào.

## 1. Đã làm

### 1.1 Số đơn của creative đi bằng `ORDER_AD_ID` (FIX)

`variantMetrics()` (`lib/queries/creative-loop.ts`) nay quy đơn về mẩu bằng CHÍNH `ORDER_AD_ID`
(`lib/queries/ads-attribution-link.ts`) — cùng biểu thức cấp mẩu của `/ads`, không bản chép tay:
`ad_id` Pancake gửi trước; không có (NULL hoặc chuỗi rỗng) thì bài viết của đơn, CHỈ khi bài ấy thuộc
ĐÚNG MỘT mẩu. Bài nhiều mẩu cùng chạy ⇒ không nối. Đơn mang `ad_id` luôn đi đường trực tiếp, không bị
kéo sang mẩu khác vì bài viết của nó.

Mỗi mẫu mang thêm: `attribution.direct` / `attribution.viaPost` (chốt · giao · hoàn — cộng lại đúng
bằng tổng), `bookedRevenueVnd`, `deliveredRevenueVnd` (`null` = mẫu chưa có mẩu QC), `killRuleOrders`.
Sổ phán quyết (`creative_verdicts.metrics`, jsonb — không đổi lược đồ) chụp thêm `ordersDirect`,
`ordersViaPost`, `killRuleOrders`, `bookedRevenueVnd`, `deliveredRevenueVnd`, `costPerOrderVnd`.

Hiệu năng: đơn ứng viên được thu hẹp TRƯỚC (đơn mang `ad_id` của mẩu đang xét, HOẶC đơn có bài viết là
bài của mẩu đang xét) rồi `ORDER_AD_ID` mới quyết — không tính truy vấn con tương quan trên mọi đơn.

### 1.2 Truy vết người tiêu thụ con số — và hàng rào đã dựng

| Người dùng số đơn | Hệ quả | Có tiêu tiền / ghi Facebook không người duyệt? |
|---|---|---|
| Ngưỡng THẮNG (`winOrdersAbove`) → `library_at` | ghi CSDL, nhãn | Không |
| Đề nghị scale (`proposeScale`) | chèn dòng PROPOSED | Không — nháp dựng PAUSED, phiếu HMAC người duyệt |
| Tiêu thêm (`creative-extend`) | ghi Facebook | Không — người bấm + phiếu |
| Luật GIỮ → PROMISING / LOSE, xoá ảnh mẫu thua | nhãn, ảnh | Không |
| Học gen (`creative_learnings`, bản tin AI) | ghi sổ học | Không (có thể viết lại bản tin 1 lần/ngày) |
| Nhập "quảng cáo cũ của shop" (`classifyOwnAd`) | ứng viên nhập | Không — người bấm nhập |
| Thiết kế: trạng thái WIN / điểm cha | ghi CSDL | Không — lô mới vẫn phải duyệt |
| MOQ thiết kế (`creative-moq.ts`) | nháp PO | KHÔNG dùng `variantMetrics` (đếm riêng) — không đổi |
| **LUẬT TẮT → `applyKills` → tạm dừng nhóm QC trên Facebook** | **ghi Facebook tự động** | **Có** (duyệt ở cấp LÔ, không ở từng lượt) |

Luật tắt là đường duy nhất con số tự dẫn tới một lượt ghi Facebook. Một luật `costPerOrder` đang
CHƯA BIẾT (0 đơn ⇒ mẫu số 0) có thể bỗng kích hoạt khi đơn qua bài viết được đếm — tức máy tắt mẫu theo
định nghĩa người duyệt lô chưa từng thấy. Nên thay vì DỪNG cả gói, tôi giữ NGUYÊN hành vi của luật tắt:
`VariantMetrics.killRuleOrders` (tuỳ chọn) — `judgeVariant` cho luật tắt đọc nó thay `bookedOrders`;
`variantMetrics` đặt nó = số đơn mang `ad_id` theo `KILL_RULE_ORDER_BASIS = "DIRECT_AD_ID"`. Nhãn, thư
viện, scale, học đọc số đầy đủ. Kết quả: không lượt tạm dừng Facebook MỚI nào có thể sinh ra từ thay
đổi này.

**Một lệch còn lại (đã chấp nhận, cần Tech Lead biết):** THẮNG được xét TRƯỚC luật tắt (như cũ). Mẫu
mà số đơn ĐẦY ĐỦ vượt ngưỡng nhưng số đơn `ad_id` thì không, và có một luật tắt kích hoạt, trước đây sẽ
bị tạm dừng; nay là THẮNG và không bị tạm dừng. Hệ quả: mẫu tiếp tục tiêu trong ngân sách + `end_time`
lô ĐÃ DUYỆT — không có đồng tiêu nào ngoài phong bì đã duyệt. Cần một mẫu > 100 đơn (mặc định) mà vẫn
phạm luật tắt, nên hiếm.

### 1.3 `/ads/daily` chiều nhóm QC / mẩu QC (FIX)

`MARKETING_DIMENSION_SPEND.adset/ad = true` (đồng bộ với `ADS_DIMENSION_HAS_SPEND`). `spendByDay` đi
nhánh mới `adGrainSpendByDay`: chi = PHÉP CỘNG dòng hạt `AD` của nhóm/mẩu; ngày mà CHIẾN DỊCH của nó có
dòng hạt khác `AD` ⇒ chi của ngày ấy `null` (và tiền cấp chiến dịch ngày ấy được đếm riêng); không dòng
nào trong biên quan sát ⇒ 0 thật. Chiến dịch của nhóm/mẩu lấy từ `fb_ads` (+ dòng hạt AD, + `fb_adsets`);
không biết ⇒ cả chiều CHƯA BIẾT. Có ngày chưa tách ⇒ TỔNG kỳ (chi, tin nhắn, lợi nhuận góp, lợi nhuận
ước tính) là `null` — không in phần cộng thiếu như tổng. Độ phủ `MarketingDaily.spendCoverage`
(`knownDays · knownSpend · unsplitDays · unsplitCampaignSpend`) in trong thẻ "Chi quảng cáo" + cảnh
báo; bóc tách theo nhóm/mẩu áp cùng luật cho từng dòng. Câu hint cũ ("Facebook chỉ trả số chi ở cấp
chiến dịch") thay bằng câu đúng cho fanpage/nguồn đơn + `MARKETING_AD_GRAIN_SPEND_HINT`.
Chiều chiến dịch / mã hàng / marketer: đường code không đổi (`unsplitDays = null`), kiểm thử khoá tổng.

### 1.4 Thư viện creative lọc theo mẫu và ngày (EXTEND)

`listLibrary(db, { productId, from, to })` — `from/to` lọc theo NGÀY VÀO THƯ VIỆN (`library_at`).
`listLibraryProductOptions(db)` — chỉ các mẫu có mặt trong thư viện. Tab dùng `DataTableToolbar`
(nuqs): facet `mau` (chọn một), kỳ `period/from/to` mặc định "toàn bộ".

### 1.5 `lib/queries/model-ads.ts` (BUILD)

- `getModelAdsSummary(productId, range)` — đọc NGUYÊN dòng chiều `product` của `getAdsDecision` (chi,
  đơn, CPO, ROAS lên đơn/giao, lợi nhuận sau QC + tạm tính, hành động + lý do + căn cứ), kèm độ phủ quy
  kết của bảng (`confidence.coveragePct`) và phần chi hạt mẩu (`spendDetail.pct`). `status`:
  `NO_ROW` (mọi ô `null`) · `SPEND_UNMAPPED` (mã có đơn mà `ad_spends` chưa từng ghép chiến dịch nào ⇒
  chi/CPO/ROAS/lợi nhuận `null`, hành động vẫn trả nguyên) · `OK`. Đệm 90 s, khoá gồm `productId` + kỳ.
- `getModelCreativeSummary(productId)` (+ `modelCreativeSummary(db, …)` không đệm) — số creative theo
  phán quyết ĐÃ CHỤP gần nhất (`NO_VERDICT` riêng), đơn quy kết (qua `variantMetrics`), chi (`null` khi
  không mẩu nào biết chi), CPO (`null` khi còn mẩu chưa biết chi), mẫu thắng gần nhất, link thư viện đã
  lọc sẵn.

### 1.6 Bằng chứng cạnh phán quyết (display only)

Tab Đang chạy: dưới phán quyết in "Chi/đơn · DT lên đơn"; ô đơn chốt có tooltip tách đường `ad_id` /
bài viết. Thẻ thư viện in chi/đơn, DT lên đơn, số đơn qua bài viết. Không tô màu, không ngưỡng mới.
`costPerOrderOf()` (judge.ts) là CHÍNH `metricValue(…, "costPerOrder")` làm tròn — không công thức thứ hai.

## 2. Tệp

Sửa: `lib/queries/creative-loop.ts` · `lib/creative/judge.ts` · `lib/creative/evaluate.ts` ·
`lib/queries/marketing-daily.ts` · `lib/constants/marketing-daily.ts` ·
`app/(dashboard)/ads/daily/{daily-kpis,breakdown}.tsx` ·
`app/(dashboard)/marketing/creatives/{library-tab,live-tab,page}.tsx` · `docs/creative-loop.md` ·
`docs/marketing-daily-contract.md` · `tests/marketing-daily.test.ts` · `tests/sync-fixtures.test.ts`.
Mới: `lib/queries/model-ads.ts` · `tests/company-os-creative-ads.test.ts` · tệp này.

## 3. Lệch khỏi đề bài — và vì sao

1. **Không DỪNG ở mục 1** dù có một đường ghi Facebook tự động: đã cô lập nó (`killRuleOrders`) để
   thay đổi không sinh lượt ghi mới nào; phần còn lại không tiêu tiền / ghi Facebook không người duyệt.
   Nếu Tech Lead muốn diễn giải chặt hơn thì revert `lib/creative/judge.ts` KHÔNG đủ — phải revert cả
   `variantMetrics` (vì nhãn THẮNG xét trước luật tắt, xem 1.2).
2. `lib/creative/judge.ts`, `lib/creative/evaluate.ts`, `live-tab.tsx`, `daily-kpis.tsx`,
   `breakdown.tsx` không có trong bảng sở hữu §8 nhưng cũng không thuộc agent nào khác — chạm tối thiểu.
3. Sửa hai khẳng định CŨ trong `tests/marketing-daily.test.ts` (`adBd.spendGrain === false` → `true`,
   thêm `page` vẫn `false`; câu chú thích mẩu không rõ chiến dịch). Đây là hành vi đổi CÓ CHỦ ĐÍCH,
   không phải chỉnh kỳ vọng cho xanh.
4. `docs/ads-decision-contract.md` §6 vẫn ghi "Nhóm/Mẩu: chỉ `ad_id`" trong khi `ads-decision.ts` dùng
   `ORDER_AD_ID` từ 22/09 — tài liệu của miền Agent F, tôi KHÔNG sửa; cần F hoặc Tech Lead cập nhật.

## 4. Kiểm thử

`tests/company-os-creative-ads.test.ts` (đăng ký trong `main()` ngay sau `testCreativeEvaluate`), ngày
cố định của chính dữ liệu gieo (2021), kỳ dựng từ đúng những ngày ấy — không cửa sổ trượt (mục 50, 65).
Khoá: đơn qua bài của một mẩu đếm MỘT lần · bài nhiều mẩu không đếm · `ad_id` rỗng coi như không có ·
đơn mang `ad_id` không bị đếm lại / không bị kéo sang mẩu khác · huỷ / NEW không vào · tổng quy kết = 4/5
đơn · luật tắt giữ định nghĩa cũ (CPO chưa biết không bỗng tắt; "0 đơn" vẫn tắt; THẮNG đọc số đầy đủ) ·
chi mẩu đúng ở ngày hạt mẩu, `null` ở ngày hạt chiến dịch, tổng `null` + độ phủ đúng, chiến dịch khác
không làm ngày thành chưa biết · nhóm = Σ mẩu · chiến dịch và mã hàng tổng 450.000 ₫ không đổi · mẩu lạ
⇒ chưa biết · tóm tắt mẫu `null` khi không dữ liệu, `SPEND_UNMAPPED` không in 0 ₫ · thư viện lọc mẫu /
từ / đến / kết hợp · lựa chọn bộ lọc.

**Đột biến (12/12 bị bắt)**, mỗi cái chạy riêng bài kiểm rồi hoàn nguyên:
M1 đếm quay về `orders.ad_id` · M2 bỏ `nullif` ở đường bài viết · M3 luật tắt đọc số đầy đủ · M4 judge bỏ
`killView` · M5 ngày chưa tách coi là biết · M6 tổng in phần cộng thiếu · M7 ngày chưa tách không lọc
theo chiến dịch · M8 mẩu không rõ chiến dịch coi là biết · M9 tóm tắt tin chi chưa ghép · M10 thư viện bỏ
lọc mẫu · M11 lọc theo ngày tạo thay ngày vào thư viện · M12 tóm tắt rỗng in chi 0.

**Cổng (Windows, cây `wt-cos-b`):** `npm run typecheck` sạch · `npm run lint` sạch · `npm test` in
"TẤT CẢ KIỂM THỬ ĐẠT" (kể cả `testChatbotImportGuards`) · `npm run build` thành công. Chưa chạy cổng
trên bản checkout sạch theo SHA (AGENTS.md §9) — việc của Tech Lead lúc gộp.

## 5. SQL chỉ đọc để đo tác động (ops `db-query`, MỘT câu)

Đếm đơn đã chốt (population `CONFIRMED_STAGES`, CHƯA trừ đơn huỷ theo `ORDER_OUTCOME` — nên hơi cao hơn
`bookedOrders` thật ở cả hai cột như nhau) theo cách cũ vs cách mới, cho mọi creative đã đăng:

```sql
select cv.id as variant_id, cv.fb_ad_id, cv.library_at is not null as in_library,
  count(*) filter (where nullif(o.ad_id, '') = cv.fb_ad_id) as orders_old_ad_id,
  count(*) filter (where coalesce(nullif(o.ad_id, ''), pa.ad_id) = cv.fb_ad_id) as orders_new_order_ad_id,
  count(*) filter (where nullif(o.ad_id, '') is null and pa.ad_id = cv.fb_ad_id) as orders_via_post
from creative_variants cv
join orders o on (o.ad_id = cv.fb_ad_id
  or regexp_replace(o.post_id, '^.*_', '') in (select fa.post_id from fb_ads fa where fa.id = cv.fb_ad_id and fa.post_id is not null))
left join (select fa.post_id, min(fa.id) as ad_id from fb_ads fa
           where fa.post_id is not null and fa.post_id ~ '^[0-9]{5,}$'
           group by fa.post_id having count(distinct fa.id) = 1) pa
  on pa.post_id = regexp_replace(o.post_id, '^.*_', '')
where cv.fb_ad_id is not null
  and o.stage::text in ('CONFIRMED','PACKING','READY_TO_SHIP','SHIPPED','DELIVERED','PAID','RETURNING','PARTIAL_RETURN','RETURNED')
group by cv.id, cv.fb_ad_id, cv.library_at
order by (count(*) filter (where coalesce(nullif(o.ad_id, ''), pa.ad_id) = cv.fb_ad_id)
        - count(*) filter (where nullif(o.ad_id, '') = cv.fb_ad_id)) desc
limit 50;
```

Đọc: `orders_new_order_ad_id − orders_old_ad_id = orders_via_post` là phần tăng thêm. Dòng có
`in_library = false` mà `orders_new_order_ad_id > winOrdersAbove` là mẫu sẽ được chốt THẮNG ở lượt chấm
đầu sau deploy (một lần, không gỡ) — và sinh dòng ĐỀ NGHỊ scale (không tiêu tiền). **Chưa đo production
từ máy này** — kỳ vọng: tăng ở mẫu tự đăng của vòng (mỗi bài đúng một mẩu), ~0 ở mẩu chung bài.

## 6. Còn lại

- `lib/queries/creative-moq.ts` (đường `viaAd`) vẫn đếm bằng `orders.ad_id` — nó tự dựng nháp PO, đổi
  cần người quyết; doc creative-loop đã ghi "chưa đổi theo".
- Bộ lọc ĐƠN của `/ads/daily` ở chiều nhóm/mẩu vẫn đi bằng `orders.ad_id` (`dimensionFilter`,
  `dimensionKeyExpr`) — chi đã ở hạt mẩu nhưng đơn chưa qua bài viết ⇒ ROAS cấp mẩu ở trang này có thể
  thấp hơn `/ads`. Không đổi vì ngoài đề bài; nên làm cùng `ORDER_AD_ID`/`ORDER_ADSET_ID` ở lượt sau.
- Bóc tách theo nhóm/mẩu chỉ lấy khoá từ ĐƠN — mẩu tiêu tiền mà không đơn nào không hiện (như trước).
- Trang 360 (`/models/[id]`, Agent A) chưa gọi hai hàm tóm tắt — chờ A.

## 7. HUMAN GATE

1. **Chuyển luật tắt sang định nghĩa đơn mới** (`KILL_RULE_ORDER_BASIS` → `"ORDER_AD_ID"`): quyết định
   của chủ shop, nên kèm lô mới duyệt theo định nghĩa mới. Kiểm thử đang khoá giá trị `DIRECT_AD_ID`.
2. **Lượt chấm đầu sau deploy** có thể chốt THẮNG + đề nghị scale cho một số mẫu (đo trước bằng SQL ở
   mục 5). Không tiêu tiền tự động; tin Lark "đề nghị scale" sẽ báo các dòng đề nghị mới, và `sync_runs` ghi "thắng mới N".
3. Deploy / merge: chưa làm — theo đề bài.
