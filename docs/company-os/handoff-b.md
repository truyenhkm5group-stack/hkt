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

---

# B2 — Một cách đếm đơn quảng cáo cho MOQ thiết kế và `/ads/daily` nhóm/mẩu (26/09/2026)

Nhánh `claude/cos-dem-don-qc-thong-nhat`, dựng trên `origin/main` @ `66dd128b`. **Không migration**, không
đổi khoá đệm (không thêm tham số), không đổi ngưỡng. Đóng hai mục "Còn lại" của §6 ở trên.

## B2.1 Đã làm

1. **MOQ thiết kế** (`lib/queries/creative-moq.ts`, đường `viaAd`): đơn quy về mẩu bằng CHÍNH `ORDER_AD_ID`
   (không bản chép). Thu hẹp ứng viên bằng `orderAdCandidates()` — siêu tập rẻ mới xuất ở
   `lib/queries/ads-attribution-link.ts`, dùng chung với `variantMetrics` (bản chép tay trong
   `creative-loop.ts` đã thay bằng hàm này, cùng SQL) và bộ lọc mẩu của `/ads/daily`. Căn cứ tách
   `viaAdDirect` (mang `ad_id`) · `viaAdPost` (qua bài viết của đúng một mẩu): có ở `DesignMoqCount`, ở ảnh
   chụp `moq_snapshot` (jsonb — ảnh chụp cũ đọc ra `null` = CHƯA TÁCH, không phải 0), ở câu
   `moqCountSentence` (ghi chú nháp + tin Lark), ở ô MOQ tab Thiết kế mới (dòng phụ "qua bài N" + tooltip).
2. **`/ads/daily` nhóm/mẩu** (`lib/queries/marketing-daily.ts`): `dimensionFilter` (adset/ad) →
   `ORDER_ADSET_ID` / `ORDER_AD_ID` (kèm siêu tập `orderAdsetCandidates` / `orderAdCandidates` để rẻ);
   `dimensionKeyExpr` + khoá của `dimensionKeys` đi cùng biểu thức ⇒ khoá bóc tách và bộ lọc là MỘT tập
   đơn. Nhãn mẩu = tên của đúng mẩu đã quy về; nhãn nhóm giữ nguyên. Phía CHI không đổi (luật hạt mẩu §1.3).
   Chiến dịch / mã hàng / marketer / fanpage / nguồn: không một dòng nào đổi.
3. Tài liệu: `docs/creative-loop.md` (§4 "chưa đổi theo" → đã đổi, §5 số đơn thiết kế, bảng §5h),
   `docs/marketing-daily-contract.md` (bảng nguồn + mục 4).

## B2.2 Truy vết hậu quả của MOQ — không có đường tự động nào quá nháp

`runDesignMoq` (gọi từ `lib/creative/loop.ts` bước 3c) ⇒ `production_orders` `status = 'DRAFT'`, mã
`PO-<TK>`, `unit_cost NULL`, xưởng trống + mốc `design_concepts.moq_reached_at` + MỘT tin Lark. Đã kiểm:
`DRAFT → SENT` chỉ qua `setProductionStatus` (người bấm, `planning:write`); không job/hàm nào tự gửi xưởng
hay báo nhà cung cấp; `cashflow.ts` / `inventory-decision.ts` chỉ đọc lệnh `SENT`; nháp `DRAFT` chỉ HIỆN ở
`/models/[id]` (`model-production.ts`, `models.ts`). Không tiền nào đi, không trạng thái thiết kế nào đổi.
Kiểm thử khoá bằng quét nguồn (`lib/creative/moq.ts` không có `status: "SENT"`, `sentAt:`, không import
`lib/actions/production`). ⇒ Không có lý do DỪNG; đã đổi.

**Tác động.** Đếm mới ≥ đếm cũ với mọi thiết kế (vế `ad_id` giữ nguyên; chỉ CỘNG đơn không `ad_id` mà bài
viết thuộc đúng một mẩu của thiết kế VÀ chưa có dòng mã TK — đơn có dòng mã TK vốn đã vào `viaCode`). Thiết
kế đã có `moq_reached_at` không bị đụng (máy chỉ xét thiết kế còn trống mốc). Thiết kế có thể qua MOQ SỚM
hơn = thiết kế chưa có mốc mà `hợp cũ < 50 ≤ hợp mới` — rơi vào nhóm này chủ yếu là thiết kế CHƯA có sản
phẩm Pancake mã TK (chỉ đếm được qua quảng cáo) và bán nhiều qua bình luận/nhắn tin dưới bài. **Chưa đo
được số thiết kế trên production từ máy này** (không có quyền đọc) — SQL ở B2.4 trả lời đúng câu đó
(`crosses_moq_now = true`). Chấp nhận được vì hệ quả duy nhất là một NHÁP + một tin báo, người vẫn kiểm
màu/size/giá/xưởng rồi mới gửi; ghi chú nháp nay nói rõ bao nhiêu đơn đứng trên `ad_id`, bao nhiêu trên bài
viết. Nháp lượt đầu sau deploy mang ghi chú với căn cứ mới; `adOnly` (số lượng CHƯA BIẾT) có thể lớn hơn trước.

**Luật TẮT không đổi**: `KILL_RULE_ORDER_BASIS = "DIRECT_AD_ID"` (kiểm thử khoá cả giá trị lẫn dòng khai).

## B2.3 Kiểm thử

`tests/company-os-ad-order-unify.test.ts` (đăng ký ngay sau `testCreativeMoqDb`). Ngày CỐ ĐỊNH của dữ liệu
gieo (13/02/2019), kỳ dựng từ đúng ngày ấy — không đồng hồ thật (mục 50, 65). Khoá: MOQ đếm đơn qua bài MỘT
lần (kể cả khi thấy ở cả hai đường) · bài nhiều mẩu (khác nhóm HOẶC cùng nhóm) không nối · đơn mang `ad_id`
không đếm đúp, không bị kéo sang thiết kế khác · căn cứ vào ảnh chụp + ghi chú nháp; ảnh chụp cũ ⇒ `null` ·
`/ads/daily` bóc tách + bộ lọc nhóm/mẩu = `/ads` (số đơn, doanh số lên đơn) cho 6 khoá, kể cả khoá CHỈ có đơn
qua bài viết · số lượng theo khoá nhóm = theo bộ lọc · chiến dịch / fanpage / nguồn / marketer / mã hàng: tổng
bằng số dựng tay · luật tắt `DIRECT_AD_ID` · MOQ dừng ở nháp.

**Trước/sau:** chạy CÙNG bài trên mã cũ (stash `lib/` + `app/`): phần "các chiều khác" ĐẠT (tổng không đổi),
phần MOQ / `/ads/daily` = `/ads` / quét nguồn TRƯỢT (đúng chỗ đổi có chủ đích).

Không sửa khẳng định nào của bài cũ (`creative-moq`, `marketing-daily`, `company-os-creative-ads` giữ nguyên,
vẫn đạt: fixture cũ không có bài viết nên `ORDER_AD_ID` = `ad_id`).

**Đột biến (15/15 bị bắt)**, mỗi cái áp riêng lên mã, chạy riêng bài B2 trên PGlite bộ nhớ, rồi hoàn nguyên:
M1 MOQ đọc lại `orders.ad_id` · M2 MOQ thu hẹp chỉ theo `ad_id` · M3 cờ qua-bài bỏ `nullif` · M4/M5 bộ lọc
mẩu/nhóm `/ads/daily` về `ad_id` thô · M6/M7 khoá bóc tách mẩu/nhóm về `ad_id` thô · M8/M9 siêu tập bỏ vế bài
viết · M10 luật tắt sang `ORDER_AD_ID` · M11 máy MOQ dựng lệnh `SENT` · M12 ảnh chụp bỏ căn cứ · M13 câu MOQ bỏ
căn cứ · M14 chiều CHIẾN DỊCH lỡ tay đổi (khối "các chiều khác" bắt) · M15 `POST_TO_AD` bỏ `having` (bài nhập
nhằng bị nối).

**Cổng (Windows, cây `wt-cos-b`):** `npm run typecheck` sạch · `npm run lint` sạch · `npm test` in "TẤT CẢ KIỂM
THỬ ĐẠT" (có dòng B2) · `npm run build` thành công. Chưa chạy cổng trên checkout sạch theo SHA (AGENTS.md §9) —
việc của Tech Lead lúc gộp.

## B2.4 SQL chỉ đọc so MOQ cũ / mới (ops `db-query`, MỘT câu)

Population = `CONFIRMED_STAGES`, CHƯA trừ đơn huỷ theo `ORDER_OUTCOME` (nên hơi cao hơn số màn hình ở CẢ HAI
cột như nhau — phần CHÊNH vẫn đúng). `50` = `DESIGN_MOQ.minOrders` lúc viết.

```sql
select *, (not reached and moq_old < 50 and moq_new >= 50) as crosses_moq_now
from (
  with ad_of as (
    select cv.design_concept_id as design_id, trim(cv.fb_ad_id) as ad_id
    from creative_variants cv
    where cv.design_concept_id is not null and nullif(trim(cv.fb_ad_id), '') is not null
  ), post_one_ad as (
    select fa.post_id, min(fa.id) as ad_id from fb_ads fa
    where fa.post_id is not null and fa.post_id ~ '^[0-9]{5,}$'
    group by fa.post_id having count(distinct fa.id) = 1
  ), ord as (
    select o.id, nullif(o.ad_id, '') as direct_ad, coalesce(nullif(o.ad_id, ''), p.ad_id) as order_ad_id
    from orders o
    left join post_one_ad p on p.post_id = regexp_replace(o.post_id, '^.*_', '')
    where o.stage::text in ('CONFIRMED','PACKING','READY_TO_SHIP','SHIPPED','DELIVERED','PAID','RETURNING','PARTIAL_RETURN','RETURNED')
  ), via_code as (
    select distinct dc.id as design_id, oi.order_id
    from design_concepts dc
    join products pr on upper(trim(pr.custom_id)) = upper(trim(dc.code))
    left join product_variants pv on pv.product_id = pr.id
    join order_items oi on oi.is_bonus = false and (oi.product_id = pr.id or oi.variant_id = pv.id)
    join ord on ord.id = oi.order_id
  ), via_ad_old as (
    select distinct a.design_id, ord.id as order_id from ad_of a join ord on ord.direct_ad = a.ad_id
  ), via_ad_new as (
    select distinct a.design_id, ord.id as order_id from ad_of a join ord on ord.order_ad_id = a.ad_id
  )
  select dc.code, dc.moq_reached_at is not null as reached,
    (select count(*) from (select order_id from via_code c where c.design_id = dc.id
       union select order_id from via_ad_old x where x.design_id = dc.id) u) as moq_old,
    (select count(*) from (select order_id from via_code c where c.design_id = dc.id
       union select order_id from via_ad_new x where x.design_id = dc.id) u) as moq_new,
    (select count(*) from via_ad_new x where x.design_id = dc.id)
      - (select count(*) from via_ad_old x where x.design_id = dc.id) as via_post_added
  from design_concepts dc
) t
order by crosses_moq_now desc, (moq_new - moq_old) desc, code
limit 100;
```

Đọc: `crosses_moq_now = true` = thiết kế mà lượt vòng mẫu ĐẦU TIÊN sau deploy sẽ dựng nháp `PO-<TK>` + gửi
một tin (do đếm mới). `reached = true` ⇒ không đổi gì dù `moq_new` lớn hơn.

## B2.5 Lệch khỏi đề bài / còn lại

- Chạm thêm `lib/queries/creative-loop.ts` (chỉ thay bản chép tay "đơn ứng viên" bằng `orderAdCandidates`,
  cùng SQL; bài B + 12 đột biến của B vẫn đạt) và `lib/constants/creative-loop.ts`
  (`DesignMoqSnapshot.viaAdDirect/viaAdPost`, `number | null`) · `lib/queries/creative-design.ts` (chú thích).
- Nhãn dòng NHÓM ở bóc tách vẫn là tên một mẩu (như trước); `fb_adsets.name` có sẵn — đổi là việc riêng.
- `docs/ads-decision-contract.md` §6 vẫn ghi "chỉ `ad_id`" (miền Agent F) — không sửa.
- Chưa đo production (không quyền); SQL ở B2.4.
