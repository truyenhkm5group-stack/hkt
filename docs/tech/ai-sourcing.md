# AI China Fashion Sourcing — P0: nghiên cứu, thiết kế, lộ trình

| | |
|---|---|
| Chủ shop giao | 23/10/2026 |
| Sứ mệnh | `sourcing-p0-research` (CHỈ TÀI LIỆU + phép thử chỉ đọc, không code tính năng) |
| Mốc kho lúc khảo sát | `main` = `ec00525c7` (#980) |
| Track trong chương trình | «SRC» ở `docs/tech/odoo-inspired-erp-upgrade.md` §5.2 |

**Mục tiêu sản phẩm.** Người dùng gõ tiếng Việt hoặc tải ảnh ⇒ tìm sản phẩm THẬT trên nguồn Trung Quốc ⇒ lọc / so sánh nhà cung cấp (giá theo bậc, MOQ, nguồn, mức tin cậy) ⇒ lưu mẫu ⇒ tạo yêu cầu mua thử ⇒ ERP theo dõi kết quả kinh doanh của mẫu (bán, hoàn, lợi nhuận) và chỉnh gợi ý. Khách mục tiêu: nam và nữ 35–60 tuổi.

**Kết luận một dòng.** Phần lớn «xương» đã có trong ERP (mẫu chưa mã `TEST-`, topic / mẫu thử / bảng giá thành, lưu tệp, AI có trần chi phí theo tổ chức, duyệt người thứ hai, báo cáo GTC / lợi nhuận theo mã). Chỗ CHƯA có và CHẶN: **chưa có nguồn dữ liệu Trung Quốc nào được xác minh là hợp lệ** — tài liệu chính thức của 1688 / Alibaba.com không đọc được từ máy này (trang dựng bằng JavaScript), và các nhà cung cấp bên thứ ba đọc được đều không chứng minh được quyền dùng dữ liệu. Vì vậy P1 làm trọn phần KHÔNG cần API (bộ sinh truy vấn tiếng Trung, kho mẫu nhập tay / dán link, công thức giá về VN, lưu mẫu ⇒ mã `TEST-`, yêu cầu mua thử có duyệt), còn kết nối dữ liệu chờ chủ shop gỡ blocker ở §6.

---

## 1. Audit ERP: cái tái dùng được

Đọc mã ở `main` `ec00525c7`. Không có dòng nào về sourcing / 1688 / CNY trong `lib/`, `app/`, `docs/` trước tệp này.

| Nhóm | Đã có (tệp:dòng) | Dùng cho sourcing | Thiếu |
|---|---|---|---|
| Sản phẩm / mẫu mã | `products` `db/schema.ts:1072` (mã shop = `customId`) · `productVariants` :1137 (`color` :1149, `size` :1150, `images[]`) · tra mã qua quan hệ `lib/queries/product-code.ts:52-165` · tạo tay `lib/actions/manual-products.ts:32` (tiền tố `erp-`) | Mẫu thắng ⇒ sản phẩm + ma trận màu × size | Không có liên kết nguồn (URL, offer id, SKU nguồn ↔ mẫu mã) |
| Mẫu chưa mã `TEST-` (#290) | `lib/constants/provisional-model.ts:18-76` (`TEST-YYMMDD-NN`, trạng thái đầu `ADS_TESTING`) · `registerProvisionalModelCore` / `assignModelCodeCore` `lib/models/service.ts:262/326` · `productModels` `db/schema.ts:9321` (vòng đời IDEA → ADS_TESTING → WINNER/LOSER → SELLING) | **Danh tính của «mẫu đã lưu»** trước khi có mã thật — không dựng bảng thứ hai | Trường nguồn (nền tảng, offer) |
| Topic / mẫu thử / giá thành | `productionTopics` :9453 (`requirements`: chất liệu, màu, size, giá bán, giá mục tiêu, số lượng, hạn) · `productionTopicMessages` :9515 (QUOTE có `quotedUnitPrice` VND) · `samples` :9660 · `sampleReviews` :9698 · `costSheets` / `costSheetLines` :9601/9636 (`INBOUND`, `FACTORY_TRANSPORT`) · `createTopicCore` `lib/production/topics.ts:48` · `computeCostSheet` `lib/constants/production-os.ts:228` | Trao đổi / báo giá / mẫu thử / bảng giá thành của hàng nhập | Bậc giá, MOQ, tiền tệ CNY |
| Lưu tệp / ảnh | bytea chia khúc `productionTopicFiles` :9558 + `lib/production/topic-files.ts`, phục vụ có Range `app/api/production/files/[id]/route.ts` (ảnh ≤ 8 MB, `lib/constants/production-files.ts:16-32`) · `storeCreativeImage` (khử trùng sha256) `lib/creative/images.ts:59` · thu nhỏ ảnh phía trình duyệt `lib/ideas/shrink-image.ts` | Ảnh người dùng tải lên để tìm · ảnh bằng chứng của mẫu | Băm ảnh cảm nhận (pHash) cho chống trùng gần đúng |
| Nhà cung cấp / đặt xưởng | `suppliers` :448 (chỉ tên, bí danh, SĐT, ghi chú) · `productionOrders` :465 · `stockReceipts` / `stockReceiptItems` :2616/2645 (`unitCost`) · `getPurchasingReport` `lib/queries/purchasing.ts:612` (lead time, giá nhảy) · MOQ / lead time ở `inventory.planning` (`lib/constants/planning.ts`) | Lịch sử giá nhập THẬT, lead time thật sau khi hàng về | Nhà cung cấp nước ngoài: nền tảng, link shop, năm hoạt động, đánh giá, xác minh |
| Duyệt | `approvalRequests` :967 · `PURCHASING_LARGE` 20.000.000 ₫ `lib/constants/approval.ts:104` · `guardSecondApproval` `lib/actions/approvals.ts:68` · mẫu dùng: `saveProductionOrder` `lib/actions/production.ts:66-82` + `withApprovalExecution` `lib/approvals/execution.ts:74` | Mọi yêu cầu mua thử / liên hệ ngoài đi qua cổng người thứ hai | Nhóm duyệt cho «hành động ra bên ngoài» (xem §3.7) |
| Quảng cáo | `adSpends` :3637 (theo `productId`) · `adSpendByProduct` `lib/queries/product-intelligence.ts:253` · tạo camp TEST/WIN `lib/constants/campaign-setup.ts:75`, `lib/creative/publish.ts:339` | Mẫu thử chạy camp TEST qua đường đã có | — |
| Lợi nhuận / giá vốn | `getModelEconomics` `lib/queries/model-economics.ts:317` (ước tính vs thật theo mẫu) · `getNominalProfitReport` `lib/queries/profit-nominal.ts:1371` · giá vốn chỉ từ phiếu kho (`COST_AUTHORITY_REGISTRY` `lib/constants/cost-authority.ts:75`) · giá dự tính `setEstimatedCost` `lib/actions/estimated-cost.ts:133` | Giá về VN ước tính đi vào **giá dự tính**, KHÔNG vào giá vốn (AGENTS 3.13–3.18) | Phân rã giá về (CNY × tỷ giá + cước + thuế + phí) |
| Tỷ lệ chốt / hoàn | `ORDER_OUTCOME` `lib/queries/return-rate.ts:262` · `getReturnRateByVariant` :858 · `getModelSignal` / `deriveModelSignal` (`lib/queries/model-signal.ts:114`, `lib/constants/model-signal.ts:269`) · `variantSalesSubquery` `lib/queries/stock.ts:106` | **Vòng phản hồi**: ứng viên → mẫu `TEST-` → sản phẩm → GTC / lợi nhuận → chỉnh gợi ý | `sold30Subquery` (`lib/queries/products.ts:91`) đang private |
| Quyền / module / tổ chức | `PERMISSION_GROUPS` `lib/auth/permissions.ts:9` (+ `PERMISSIONS_ADDED_AFTER_SNAPSHOT` :477) · `PLATFORM_MODULES` `lib/constants/platform-modules.ts:119` · `canUseModule` / `assertModule` `lib/platform/capabilities.ts:83-93` · `NAV_MODULES` `lib/constants/department-modules.ts:87` · `getDb()` một CSDL / tổ chức `db/index.ts:213` · `audit()` `lib/audit.ts:125` · `getSettingJson` / `setSettingJson` `lib/settings.ts:35/57` | Module mới tách theo tổ chức, quyền, nhật ký, cấu hình tham số | Khoá module `sourcing` + nhóm quyền |
| AI | `getAiProvider` (nhận ảnh) `lib/ai/provider.ts:408` · đọc ảnh có sẵn `describeSource` `lib/creative/vision.ts:125`, `readProductDna` `lib/creative/dna.ts:120` · chuỗi gác theo tổ chức (kết nối → công tắc tắt → hạn mức → gọi → ghi sổ) `lib/creative/org-ai.ts:159-232` · sổ dùng AI `platformAiUsage` :5075, `recordAiUsage` `lib/ai-usage/ledger.ts:146` · trần ngày `lib/ai/budget.ts:33` | Sinh truy vấn tiếng Trung, đọc ảnh tải lên thành thuộc tính | `AI_USAGE_FEATURES` / `WORKLOADS` là danh sách đóng (có CHECK ở CSDL) ⇒ thêm giá trị cần migration |
| Job / kết nối | `JOB_DEFINITIONS` `lib/sync/jobs.ts:144` (gắn `module`, `fanOut`) · `sync_runs` :4746 · `ConnectorSpec` + `testConnection` `lib/connectors/registry.ts:117-144` · bí mật mã hoá `sealSecrets` `lib/connectors/secrets.ts:137` · `fetchJson` thử lại 4 lần, lùi dần, tôn trọng Retry-After `lib/integrations/http.ts:85` · `fetchPublicUrl` chống SSRF `lib/net/public-url.ts:76` | Kết nối nguồn dữ liệu đúng chuẩn AGENTS §5 | Circuit breaker chung (chỉ có bản riêng cho AI `lib/sales-chatbot/provider-failover.ts:106`) |
| Tỷ giá / chi phí nhập | Chỉ USD→VND (`FACEBOOK_USD_VND`, `lib/env.ts:136`) · cước nội địa VN `lib/constants/profit.ts:219` | — | **Không có CNY**; không cước TQ→VN, thuế, phí mua hộ |
| Việc / thông báo | `WORK_SOURCES` `lib/constants/work-sources.ts:33` (đã có APPROVAL, PRODUCTION_TOPIC, SAMPLE_REVIEW) · `notifications` :737 · `emitDomainEvent` `lib/events/emit.ts:43` (sổ sự kiện đóng) | Duyệt mua thử hiện ở `/work` của phòng đúng | Sự kiện `sourcing.*` mới |

**Mười khối tái dùng đầu bảng:** (1) mẫu `TEST-` làm danh tính «mẫu đã lưu»; (2) topic → mẫu thử → bảng giá thành; (3) lưu tệp bytea + khử trùng ảnh; (4) chuỗi gác AI theo tổ chức; (5) đọc ảnh bằng AI đã có; (6) cổng người thứ hai + mẫu `saveProductionOrder`; (7) phiếu kho → lịch sử giá / lead time thật; (8) `ORDER_OUTCOME` + tín hiệu mẫu + kinh tế mẫu; (9) module / quyền / audit / settings / CSDL theo tổ chức; (10) job có gắn module + `sync_runs` + kết nối có kiểm + `fetchJson`.

---

## 2. Nguồn dữ liệu: bằng chứng, tháng 10/2026

Đọc ngày 23/10/2026 bằng công cụ đọc trang (không chạy JavaScript). **Chưa thử API nào**: không có tài khoản, AppKey hay khoá dùng thử. Nhãn: **ĐÃ ĐỌC** = đọc được nội dung trên chính trang ghi URL · **KHÔNG ĐỌC ĐƯỢC** = trang trả vỏ JavaScript / lỗi · **CHƯA KIỂM CHỨNG** = chỉ là hiểu biết chung, phải xác minh.

### 2.1 1688 Open Platform (chính thức)

| Mục | Kết quả |
|---|---|
| https://open.1688.com/ | KHÔNG ĐỌC ĐƯỢC — HTTP 200 nhưng chỉ có chữ «阿里巴巴开放平台» (trang dựng bằng JavaScript) |
| https://open.1688.com/api/apidocdetail.htm | KHÔNG ĐỌC ĐƯỢC — như trên |
| Trình duyệt thật (Playwright) | Không dùng được trên máy này (cần Chrome mở cổng gỡ lỗi 9222) |
| Tìm theo từ khoá · tìm bằng ảnh (以图搜货) · chi tiết + bậc giá + MOQ · thông tin NCC · đặt hàng | CHƯA KIỂM CHỨNG. Hiểu biết chung: 1688 có nhóm API cho «phân phối / mua hàng xuyên biên giới» gồm cả tìm bằng ảnh và chi tiết sản phẩm có bậc giá; quyền gọi theo «giải pháp» và phải xin. **Không ghi tên API nào vào thiết kế cho tới khi đọc được trang chính thức.** |
| Điều kiện cấp AppKey (pháp nhân, tài khoản 1688, phí, quota, điều khoản dùng xuyên biên giới / bán lại dữ liệu) | CHƯA KIỂM CHỨNG — là blocker B1 (§6) |
| Mua cho Việt Nam | Theo trang OT Commerce (bên thứ ba, ĐÃ ĐỌC https://otcommerce.com/1688-com/): «Items from 1688.com are for purchase within China only» ⇒ mua thật phải qua đơn vị mua hộ / vận chuyển. CHƯA KIỂM CHỨNG trên trang 1688. |

### 2.2 Alibaba.com (ICBU) và Alibaba Cloud

| Mục | Kết quả |
|---|---|
| https://openapi.alibaba.com/ · https://open.alibaba.com/ | KHÔNG ĐỌC ĐƯỢC (vỏ JavaScript, chỉ chữ «Alibaba.com») |
| https://developer.alibaba.com/ | ĐÃ ĐỌC phần menu: trỏ tới «文档中心 / API文档» (trang con KHÔNG ĐỌC ĐƯỢC: «页面加载中») và chợ dịch vụ https://fw.alibaba.com |
| https://fw.alibaba.com | ĐÃ ĐỌC: chợ dịch vụ cho NGƯỜI BÁN (商家) và nhà cung cấp dịch vụ (服务商), ví dụ «RFQ商机自动跟踪», «找买家» — **không phải API cho người mua** |
| Alibaba Cloud Image Search https://www.alibabacloud.com/product/imagesearch | ĐÃ ĐỌC: tìm trong «self-managed image library» (thư viện ảnh CỦA MÌNH), «From 300 USD / mo». **Không tìm được trong catalogue Alibaba / 1688 ⇒ không phù hợp làm nguồn**; chỉ có thể dùng về sau cho tìm trùng trong kho mẫu của chính shop |
| API người mua (tìm sản phẩm / NCC trên Alibaba.com) | CHƯA KIỂM CHỨNG. Nhiều API Alibaba.com phục vụ người BÁN quản lý cửa hàng của họ. |

### 2.3 Nhà cung cấp dữ liệu bên thứ ba

| Nhà cung cấp | Đọc được gì | Giá | Quyền dùng dữ liệu | Đánh giá |
|---|---|---|---|---|
| TMAPI (tmapi.top) | ĐÃ ĐỌC tài liệu Taobao: chi tiết theo ID / URL, hàng của shop, đánh giá. Endpoint 1688, tìm từ khoá, tìm ảnh, MOQ, bậc giá: không thấy | Không có bảng giá công khai; «free testing quotas» | ĐÃ ĐỌC https://tmapi.top/terms: khách «solely responsible for any use of the external Data Sources which may be subject to restrictions of use and require additional license agreements with the third party»; cấm lưu dữ liệu quá 8 giờ; cấm bán lại; khách bồi hoàn | **Không dùng** khi chưa có giấy phép từ nguồn — điều khoản đẩy trách nhiệm cấp phép về phía shop |
| Onebound 万邦 (open.onebound.cn) | ĐÃ ĐỌC mục lục: chỉ thấy tài liệu JD; không thấy 1688 | Không công khai | Chân trang tự mô tả «数据采集公司» (công ty thu thập dữ liệu); không thấy tuyên bố được ủy quyền | **Không dùng** — dấu hiệu thu thập dữ liệu không ủy quyền |
| OT Commerce / Otapi (otcommerce.com, otapi.net) | ĐÃ ĐỌC https://otcommerce.com/1688-com/: Get Item, Search items, Get Vendor, giao hàng; «Search by photo» là module trả phí 170 $ | ĐÃ ĐỌC https://otcommerce.com/key-payments/: gói K0 150 $ … K3 600 $, 0,001–0,012 $/lượt, duy trì tối thiểu 5 $/ngày | ĐÃ ĐỌC https://otcommerce.com/real-time-api-taobao-and-1688/: «we work with multiple data providers»; không có tuyên bố được 1688 ủy quyền | **Chỉ cân nhắc** nếu họ đưa văn bản chứng minh quyền dùng dữ liệu (blocker B2) |
| 1688 Global (global.1688.com) | ĐÃ ĐỌC: trang «跨境专供» có ô «以图搜款» cho người dùng; không thấy API | — | — | Kênh tay cho nhân viên, không phải API |
| DajiAPI, RapidAPI «1688» | KHÔNG ĐỌC ĐƯỢC (tên miền lỗi / trang JavaScript) | — | — | Chưa đánh giá |

**Luật cho mọi phương án:** KHÔNG cào web, KHÔNG trình duyệt chạy ngầm, KHÔNG vượt chống bot, KHÔNG dùng nhà cung cấp không chứng minh được quyền dùng dữ liệu. Dán link do NGƯỜI dùng mở bằng tay vẫn được — ERP chỉ lưu link + số người nhập, không tự tải trang (§3.1, trạng thái `MANUAL`).

---

## 3. Thiết kế

### 3.1 Mô hình dữ liệu (CSDL của tổ chức, một tổ chức một CSDL như mọi module)

| Bảng | Một dòng là | Trường chính | Ghi chú |
|---|---|---|---|
| `sourcing_requests` | Một lần tìm của người dùng | chữ tiếng Việt · ảnh (tệp đã lưu, sha256 + pHash) · thuộc tính đọc từ ảnh · truy vấn tiếng Trung đã sinh (bản cố định + bản AI) · người · thời điểm · chi phí AI | Không xoá, để đo «tìm bao nhiêu, lưu bao nhiêu» |
| `sourcing_offers` | Một sản phẩm nguồn | `platform` (1688 / ALIBABA / TAOBAO / OTHER) · `offer_id` · `canonical_url` · tiêu đề zh + vi · ảnh · `supplier_id` · `data_status` · `fetched_at` · `raw` | **Khoá chống trùng:** `(platform, offer_id)` UNIQUE; link chuẩn hoá về một dạng; trùng gần đúng theo pHash chỉ GẮN CỜ «có thể trùng», không tự gộp |
| `sourcing_offer_snapshots` | Lịch sử giá | `offer_id` · `captured_at` · bậc giá `[{từ_sl, giá_CNY}]` · MOQ · bảng SKU (màu / size zh→vi) · nguồn của số (`MANUAL` / `API`) | Chụp mới thay vì ghi đè — giá nhảy đọc được |
| `sourcing_suppliers` | Một nhà cung cấp nguồn | nền tảng · link shop · số năm · đánh giá · tỷ lệ phản hồi · cờ xác minh · nơi gửi hàng | Mỗi số kèm `source` + `as_of`; thiếu là `NULL` (CHƯA BIẾT), không bao giờ 0 (AGENTS 42) |
| `sourcing_evidence` | Một bằng chứng | đối tượng · loại (ảnh chụp màn hình / tin nhắn / báo giá / tệp) · tệp · ai thêm | Tái dùng lưu tệp bytea của topic |
| `sourcing_shortlist` | Mẫu đã lưu | `offer_id` · `model_id` (mẫu `TEST-` qua `registerProvisionalModelCore`) · ghi chú · trạng thái | Mẫu thắng đi tiếp đường topic → mẫu thử → sản phẩm sẵn có |
| `sourcing_trial_requests` | Yêu cầu mua thử | `shortlist_id` · số lượng theo màu × size · giá về VN ước tính (ảnh chụp công thức + tham số) · `approval_request_id` · trạng thái | **Không tự đặt hàng**: người làm ngoài ERP rồi bấm «đã đặt» / «hàng về» (phiếu kho thật mang `unitCost`) |

**`data_status`** (danh sách đóng, có CHECK): `MANUAL` (người nhập / dán link) · `API` (lấy qua nguồn đã được duyệt, có `fetched_at`) · `STALE` (quá hạn làm mới theo nguồn — ví dụ điều khoản cấm lưu > 8 giờ thì sau 8 giờ chỉ còn link + số đã chụp, không hiển thị như số hiện tại) · `UNKNOWN`. Màn hình luôn in trạng thái cạnh con số.

### 3.2 Bộ sinh truy vấn tiếng Trung từ tiếng Việt

1. **Phần cố định (không AI, chạy trước):** từ điển thuật ngữ thời trang trong mã (`lib/constants/sourcing-glossary.ts`), mỗi mục khai nghĩa + từ khoá Trung + ghi chú. Ví dụ hướng tới khách 35–60: đầm → 连衣裙; áo sơ mi → 衬衫; đồ trung niên → 中老年; đồ cho mẹ → 妈妈装; đồ cho bố → 爸爸装 / 中年男装; size lớn → 大码; dáng suông → 宽松; vải lanh → 亚麻; lụa → 真丝 / 仿真丝; che bụng / tôn dáng → 显瘦. Bảng có bài kiểm (mọi mục có ví dụ, không trùng khoá) và người dùng thêm được mục riêng của tổ chức qua settings.
2. **Phần AI (tuỳ chọn, có trần):** mở rộng truy vấn và đọc ảnh tải lên thành thuộc tính (loại áo, cổ, tay, chất liệu, hoạ tiết) — tái dùng `describeSource` / `getAiProvider` qua chuỗi gác theo tổ chức. Ước tính chi phí: một lượt văn bản ngắn khoảng 1–2 nghìn token, một lượt ảnh vài nghìn token ⇒ dưới 0,02 USD / lượt theo bảng giá model đang dùng (**ước tính**, đo thật bằng sổ `platform_ai_usage` sau khi chạy). Trần: số lượt / ngày / tổ chức trong settings, mặc định nhỏ; vượt trần ⇒ chỉ chạy phần cố định.
3. **Đầu ra:** 3–5 truy vấn tiếng Trung xếp theo độ cụ thể, mỗi truy vấn kèm câu tiếng Việt giải thích. Ở P1 (chưa có API) người dùng bấm «chép» để tự tìm trên trang 1688 / 1688 Global bằng tài khoản của họ.

### 3.3 Công thức giá về Việt Nam (luôn nhãn «ƯỚC TÍNH»)

Bản đã cài (SRC-4, `lib/sourcing/landed-cost.ts`, Tech Lead chốt căn cứ 23/10/2026):

```
giá_mua          = giá_bậc_CNY(sl) × tỷ_giá_CNY_VND
cước_nội_địa     = cước_nội_địa_TQ_CNY_một_lượt / sl × tỷ_giá_CNY_VND
phí_mua_hộ       = phí_mua_hộ_% × giá_mua                                   ← căn cứ: GIÁ MUA
cước_TQ→VN       = cước_TQ→VN_VND_kg × kg_một_cái
trị_giá_CIF      = giá_mua + cước_nội_địa + cước_TQ→VN                      ← căn cứ thuế, như hải quan VN tính trị giá tính thuế
thuế_phí_nhập    = thuế_phí_% × trị_giá_CIF
giá_một_cái_VND  = giá_mua + cước_nội_địa + phí_mua_hộ + cước_TQ→VN + thuế_phí_nhập + phí_khác_một_cái_VND
```

- Tham số hiện có MỘT tỷ lệ thuế / phí gộp. Khi tách thuế nhập khẩu và VAT: VAT tính trên (CIF + thuế nhập khẩu).
- Thiếu một khoản cước cấu thành CIF ⇒ thuế là «thiếu cước … nên chưa tính được căn cứ thuế», KHÔNG lùi về giá mua.
- Nhiều đơn vị vận chuyển báo giá «bao thuế theo kg»: khi đó chủ shop khai thuế 0% và cước / kg đã gồm thuế. Màn hình nói điều đó
  cạnh ô thuế = 0.
- Mỗi khoản làm tròn tới đồng; tổng là cộng các khoản ĐÃ làm tròn, để người đọc cộng lại đúng số in ra. Cân nặng một cái ở bảng
  `sourcing_offer_weights` (0257, chỉ thêm dòng).
- Không có số mặc định: thiếu tham số / cân nặng ⇒ ô in «—» kèm lý do.
- `giá_bậc_CNY(sl)` lấy đúng bậc theo số lượng dự định; `sl < MOQ` ⇒ cờ «dưới MOQ», không tính.
- Mọi tham số nằm ở settings `sourcing.landed-cost` (có người đặt, ngày, lý do, phiên bản), KHÔNG hard-code (AGENTS 38). Tỷ giá CNY→VND nhập tay theo nguồn chủ shop chọn, kèm ngày; quá N ngày ⇒ cảnh báo «tỷ giá cũ».
- Kết quả đi vào **giá dự tính** (`setEstimatedCost`) khi mẫu thành sản phẩm — KHÔNG vào giá vốn; giá vốn thật chỉ đến từ phiếu kho khi hàng về (AGENTS 3.13–3.15). Màn hình so sánh hai số khi đã có hàng.
- Ảnh chụp công thức + tham số được lưu vào `sourcing_trial_requests` lúc xin duyệt, để người duyệt thấy đúng con số đã xin.

### 3.4 Chấm điểm — ba điểm tách rời, không gộp

Bản đã cài (SRC-4, `lib/sourcing/score.ts`):
- **Nhà cung cấp**: từng thành phần + độ phủ. Điểm tổng (thang 100) chỉ khi chủ shop khai `sourcing.scoreWeights` (trọng số + trần
  số năm, có người / ngày / lý do). Thiếu một thành phần có trọng số ⇒ không có tổng.
- **Khớp yêu cầu**: ✓ / ✗ từng từ khoá Trung của câu yêu cầu trong tên Trung của mẫu, không ra con số.
- **Tiềm năng**: «chưa đo được» tới khi mẫu gắn nhóm hàng của shop (SRC-5).


| Điểm | Căn cứ | Thiếu dữ liệu |
|---|---|---|
| **Nhà cung cấp** | số năm, đánh giá, phản hồi, xác minh — chỉ trường có `source` | Điểm `NULL` + «chưa đủ căn cứ», không tô màu (AGENTS 39, 44) |
| **Khớp yêu cầu** | thuộc tính khớp (loại, chất liệu, size lớn, dáng) + độ giống ảnh | — |
| **Tiềm năng** | dữ liệu CỦA SHOP: GTC / lợi nhuận / tín hiệu mẫu của nhóm hàng tương tự (`getModelSignal`, `getReturnRateByVariant`, `getModelEconomics`) | Nhóm chưa có lịch sử ⇒ «chưa đo được» |

**Không bịa số bán.** Số «đã bán» của nền tảng chỉ hiện khi nguồn được duyệt trả về, kèm nguồn và ngày; không có thì không hiện, không suy ra. Trọng số do chủ shop khai (như AGENTS 27), không có bộ mặc định ẩn.

### 3.5 Job định kỳ (chỉ khi đã có nguồn được duyệt — P2)

- Gắn module `sourcing` trong `JOB_DEFINITIONS` (tổ chức tắt module ⇒ job SKIPPED), ghi `sync_runs`, không làm sập job khác (AGENTS §5).
- Làm mới GIÁ chỉ cho mẫu trong `sourcing_shortlist` (không quét đại trà); bộ đệm tôn trọng điều khoản nguồn (ví dụ trần lưu trữ).
- Hạn mức lượt gọi / ngày / tổ chức + trần chi phí tiền; `fetchJson` thử lại có lùi; **circuit breaker chung** (bản mới, nhỏ, trạng thái trong settings): lỗi liên tiếp quá ngưỡng ⇒ ngắt một khoảng, ghi lý do, hiện ở trang Kết nối dữ liệu.
- Kết nối mới phải có `testConnection`, bí mật mã hoá (`sealSecrets`), mục trên trang Kết nối dữ liệu (AGENTS §5).

### 3.6 Vòng phản hồi

ứng viên → mẫu `TEST-` → camp TEST (đường quảng cáo sẵn có) → mã thật → `ORDER_OUTCOME` / GTC / lợi nhuận ⇒ bảng «nguồn nào, nhà cung cấp nào, nhóm hàng nào ra mẫu thắng» ⇒ người chỉnh trọng số gợi ý. Bước chỉnh là **người quyết**, máy chỉ đưa số và độ phủ; không học máy hộp đen ở các phase đầu.

### 3.7 Duyệt, phân quyền, nhiều tổ chức, nhật ký

- **Mọi hành động ra bên ngoài** (gửi tin cho nhà cung cấp, đặt mua thử, trả tiền) đều cần duyệt người thứ hai: tái dùng `guardSecondApproval` + `withApprovalExecution`; nhóm mới `SOURCING_EXTERNAL` (hoặc `PURCHASING_LARGE` khi vượt ngưỡng) — đổi nhóm / ngưỡng là quyết định của chủ shop (AGENTS §7). ERP **không tự gửi, không tự đặt**: chỉ soạn nháp, người làm ngoài ERP rồi ghi kết quả.
- Module `sourcing` (`homeOptIn`) + quyền `sourcing:view` · `sourcing:search` · `sourcing:write` · `sourcing:approve` (khai `PERMISSIONS_ADDED_AFTER_SNAPSHOT`); vị trí trên bản đồ phòng ban (`department-modules`, phòng `PRODUCTION` hoặc thu mua — chủ shop chọn).
- Dữ liệu ở CSDL của tổ chức qua `getDb()`; mọi ghi gọi `audit()`; dùng AI đi qua sổ `platform_ai_usage` + hạn mức + số dư AI của tổ chức khách.

---

## 4. Lộ trình — phần KHÔNG cần API đi trước

| Bước | PR | Nội dung | Cần API? |
|---|---|---|---|
| **P1** | SRC-1 | Khung module `sourcing` + quyền + mục điều hướng + settings `sourcing.landed-cost` (tỷ giá, cước, thuế, phí — có người đặt, ngày, lý do) | Không |
| | SRC-2 | Bộ sinh truy vấn tiếng Trung: từ điển cố định + bài kiểm; AI tuỳ chọn có trần; nút «chép truy vấn» | Không |
| | SRC-3 | Kho mẫu nhập tay: dán link + nhập bậc giá / MOQ / nhà cung cấp / ảnh bằng tay (`data_status = MANUAL`); chống trùng theo `(platform, offer_id)` + link chuẩn hoá + cờ trùng ảnh | Không |
| | SRC-4 | Công thức giá về VN + màn so sánh mẫu (bậc giá, MOQ, giá về, điểm khớp, điểm NCC «chưa đủ căn cứ») | Không |
| | SRC-5 | Lưu mẫu ⇒ mã `TEST-` (tái dùng `registerProvisionalModelCore`) · yêu cầu mua thử ⇒ duyệt người thứ hai ⇒ việc ở `/work` | Không |
| **P2** | SRC-6 | Kết nối nguồn dữ liệu đã được chủ shop chọn + duyệt (blocker B1/B2): connector + `testConnection` + bí mật + hạn mức + circuit breaker; tìm theo từ khoá + chi tiết + chụp giá | **Có** |
| **P3** | SRC-7 | Tìm bằng ảnh qua nguồn đã duyệt; pHash chống trùng; điểm nhà cung cấp từ dữ liệu nguồn | **Có** |
| **P4** | SRC-8 | Vòng phản hồi: báo cáo nguồn / NCC / nhóm hàng → mẫu thắng, độ phủ; chủ shop chỉnh trọng số | Không (dùng dữ liệu ERP) |

Mỗi PR nhỏ, có bài kiểm, theo AGENTS §6; P1 có thể chạy ngay khi chủ shop đồng ý danh sách tham số ở B4.

---

## 5. Rủi ro đã biết

- **Miễn quét vendor 1688 / alibaba / taobao / tmall** (`VENDOR_SCAN_EXEMPT_HOSTS`, SRC-3) chỉ đúng khi máy chủ KHÔNG gọi các tên miền
  đó: ERP chỉ đọc chữ của link người dán, ảnh do trình duyệt người xem tải. Ngày nối API thật (B1) PHẢI gỡ miễn trừ và khai nhà cung
  cấp dữ liệu vào sổ bên xử lý phụ (`lib/constants/legal-registers.ts` + `docs/legal/SUBPROCESSOR_REGISTER.md`).

- **Pháp lý dữ liệu:** dùng dữ liệu 1688 / Taobao không có quyền là rủi ro của SHOP (điều khoản TMAPI nói rõ như vậy). Không phương án nào ở đây cào hay vượt chống bot.
- **Mua thật:** 1688 bán nội địa Trung Quốc; mua cho Việt Nam phải qua đơn vị mua hộ — ERP không tự đặt và không trả tiền.
- **Số «ước tính» bị đọc như số thật:** mọi giá về VN mang nhãn, lưu tham số, và so với giá nhập thật khi hàng về.
- **Chi phí AI:** có trần theo tổ chức; vượt trần chỉ chạy phần cố định.

---

## 6. BLOCKER cho chủ shop

| # | Việc | Ai làm | Vì sao | Chi phí ước tính |
|---|---|---|---|---|
| B1 | Đăng nhập https://open.1688.com bằng tài khoản 1688 của shop (hoặc tạo), chụp màn hình trang **điều kiện nhà phát triển / xin AppKey**: loại pháp nhân được phép (có nhận công ty Việt Nam không), có cần giấy phép kinh doanh Trung Quốc, phí, hạn mức, điều khoản về dùng xuyên biên giới / lưu trữ dữ liệu. Làm tương tự ở https://open.alibaba.com nếu muốn Alibaba.com | Chủ shop (hoặc người được ủy quyền giữ tài khoản) | Trang chính thức chỉ hiện sau khi chạy JavaScript / đăng nhập; máy kỹ thuật không đọc được | Chưa biết — phụ thuộc kết quả B1 |
| B2 | Nếu B1 không khả thi: chọn một đơn vị mua hộ / đối tác có API CHÍNH THỨC với 1688 và xin **văn bản xác nhận quyền dùng dữ liệu** + điều khoản lưu trữ. OT Commerce có bảng giá công khai (gói 150–600 $, 0,001–0,012 $/lượt, duy trì tối thiểu 5 $/ngày — ĐÃ ĐỌC https://otcommerce.com/key-payments/) nhưng chưa chứng minh quyền dùng dữ liệu | Chủ shop | Không dùng nguồn không chứng minh được quyền | Khoảng 150 $/tháng trở lên nếu chọn OT Commerce (theo bảng giá đọc được) |
| B3 | Chốt trần chi phí AI cho sourcing (lượt / ngày / tổ chức) | Chủ shop | Tránh hết tiền AI trả trước (đã xảy ra 06/10 và 19/10) | Dưới 0,02 USD / lượt (ước tính) |
| B4 | Cung cấp tham số giá về: nguồn tỷ giá CNY→VND, báo giá cước TQ→VN theo kg của đơn vị vận chuyển đang dùng, phí mua hộ %, thuế / phí % theo nhóm hàng | Chủ shop + đơn vị vận chuyển | Công thức không hard-code; thiếu tham số ⇒ không tính | Không |
| B5 | Chọn phòng sở hữu module (sản xuất / thu mua) và ai duyệt «hành động ra bên ngoài» (nhóm `SOURCING_EXTERNAL`, ngưỡng tiền) | Chủ shop | Đổi quyền / ngưỡng cần chủ shop (AGENTS §7) | Không |

**Không chặn P1:** SRC-1 → SRC-5 làm được khi có B3 + B4 + B5; B1 / B2 chỉ chặn P2–P3.
