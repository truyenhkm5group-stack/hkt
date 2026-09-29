# Mẩu quảng cáo → Creative → Bài viết

Màn hình: **Quảng cáo → tab “Ad → Bài viết”** (`/ads/post-resolver`).

Dán một Ad ID (hoặc link xem trước có `feed_demo_ad=…`, hoặc nhiều mã mỗi dòng một mã) → ERP hỏi
Meta Marketing API ở máy chủ → trả Creative ID, Page ID, Post ID, Object Story ID, tên fanpage và
permalink. Chạy được với **bài ẩn (dark post)** tạo bằng “Tạo quảng cáo”, vì bài lấy từ creative chứ
không từ dòng thời gian fanpage.

## Đường chính là TỰ ĐỒNG BỘ, màn hình này là công cụ kiểm tra

Job `facebook-ads` (hằng giờ) gọi `syncFacebookAdIndex`: mọi mẩu **có đơn** hoặc **có chi tiêu** được
hỏi creative và ghi mối nối vào `fb_ads`. Màn hình tra tay chỉ để kiểm tra một mẩu, gỡ lỗi, hoặc
đồng bộ ngay một mẩu chưa tới lượt. Dải số trên màn hình cho biết đường tự đồng bộ đang phủ tới đâu.

## Luật

| Luật | Ở đâu |
|---|---|
| Bài viết CHỈ lấy từ `effective_object_story_id` → `object_story_id`. Không có ⇒ `POST_NOT_RESOLVED`, không đoán. | `pickStoryFromCreative` (`lib/constants/meta-ad-post.ts`) |
| `feed_demo_ad` là Ad ID để tra, không phải Post ID. Link bài viết không được bóc số ra làm Ad ID. | `normalizeAdIdInput` |
| Luôn giữ chuỗi `PAGEID_POSTID` gốc cạnh hai phần đã tách. | `parseObjectStoryId`, cột `fb_ads.story_id` |
| Permalink chỉ lưu khi Meta trả. Link dựng từ Page ID + Post ID chỉ để mở, có ghi “link dựng”, không lưu. | `postOpenUrl` |
| Nút “Đồng bộ” tra LẠI ở máy chủ rồi mới ghi. Không nhận Post ID từ trình duyệt. Ghi idempotent theo `ad_id`. | `syncMetaAdPosts`, `saveAdPostResolutions` |
| Không đè điều đã biết bằng chưa biết: lần tra không ra bài / không đọc được tên trang thì giữ giá trị cũ. | `saveAdPostResolutions`, `fbAdRowFromInfo` |
| Lỗi tạm thời (token hết hạn, hạn mức, lỗi Graph chung) KHÔNG đánh `missing`. Mẩu đó được tra lại ở lượt sau. | `TRANSIENT_META_ERRORS`, `fbAdRowFromInfo` |

## Dữ liệu (`fb_ads`, migration 0173)

Thêm cột vào bảng có sẵn, không tạo bảng mới: `creative_id`, `page_id`, `effective_object_story_id`,
`object_story_id` (hai trường thô), `post_resolution_source`, `page_name`, `permalink_url`,
`post_resolved_at`, `resolve_error` (lỗi có cấu trúc, đã che token). `fetched_at` là lần cuối hỏi Meta.
`story_id` **không unique**: nhiều mẩu có thể dùng chung một bài.

Chuỗi cho vòng mẫu (Creative Growth Loop):
`creative_variants.fb_post_id` (= `effective_object_story_id` đầy đủ) = `fb_ads.story_id`
→ `fb_ads.id` = `ad_spends.ad_id` (tiền) = `orders.ad_id`, hoặc `orders.post_id` theo khoá bài
(`normalizePostKey`) → doanh thu / lợi nhuận qua `ORDER_OUTCOME`.

## Quyền & bảo mật

- Tra: `expenses:view` + phạm vi `ADS`. Ghi: `expenses:write`. Không thêm khoá quyền mới.
- Mọi lời gọi Graph ở máy chủ qua `FacebookAdsClient` (token System User, chỉ đọc). Token không vào
  kết quả trả về, không vào nhật ký, không vào câu lỗi.
- Tối đa 50 mã mỗi lượt, 12 lượt mỗi phút mỗi người.
- Nhật ký: `META_AD_POST_LOOKUP` (tra, không xoá đệm báo cáo), `META_AD_POST_SYNC` (ghi).

## Lỗi

`INVALID_AD_ID` · `AD_NOT_FOUND` · `NO_ACCESS` (Meta trả chung một lỗi cho “không tồn tại” và “không
có quyền”) · `TOKEN_EXPIRED` · `MISSING_PERMISSION` · `CREATIVE_NOT_FOUND` · `POST_NOT_RESOLVED` ·
`META_RATE_LIMIT` · `META_API_ERROR` · `NOT_CONFIGURED`.

## Kiểm chứng trên production

Ops `meta-ad-post-probe` (arg: các Ad ID) chạy đúng hàm của màn hình, in mã đã che. Thêm `--apply`
để ghi như nút “Đồng bộ”.
