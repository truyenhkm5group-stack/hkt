# Video Scale cho mã win — đặc tả và trạng thái

> **Tệp trạng thái DUY NHẤT của module.** Hợp đồng mã nguồn: `lib/constants/video-scale.ts` (mọi con số, mọi trần, từ
> vựng góc bán, giá công bố). Mã: `lib/video-scale/*`. Màn hình: `/marketing/video-scale`. Kiểm thử: `tests/video-scale.test.ts`.
>
> Chủ shop yêu cầu 27/09/2026: *với mỗi mã win có ảnh mẫu được duyệt, ERP tạo nhiều kịch bản theo góc bán, sinh video 9:16
> bằng AI có API chính thức, hậu kỳ, viết content, đăng Reel, tạo quảng cáo, đo và tối ưu.* Chia bốn PR:
>
> | PR | Phạm vi | Trạng thái |
> |---|---|---|
> | 1 | Dữ liệu + kịch bản + video (Veo) + hậu kỳ + QC + duyệt | **dựng xong trong PR này** |
> | 2 | Content (caption / hook / CTA) + đăng Facebook Reel | **dựng xong** (§11) |
> | 3 | Meta ads (campaign / ad set / ad) + hạn mức + dừng khẩn cấp | kế tiếp |
> | 4 | Đo lường (Meta + đơn + lợi nhuận) + vòng tối ưu | kế tiếp |

---

## 1. Luồng một lượt

```
Người bấm "Tạo chiến dịch media" trên một MÃ WIN
  chọn ẢNH GỐC (ảnh sản phẩm thật của mã — người chọn = người duyệt ảnh), số biến thể, góc bán (tuỳ), ý tưởng, nhạc có quyền
        │  lượt `video_scale_runs` + việc SCRIPT   (ảnh chụp cấu hình: model, độ phân giải, số cảnh — lượt không đổi giữa chừng)
        ▼
SCRIPT  planAngles() chọn góc (hàm thuần, Thompson trên sổ học) → LLM viết kịch bản → scriptProblems() kiểm
        (giá = giá ERP, size / màu đang bán, KHÔNG chất liệu, KHÔNG khuyến mãi ngoài chính sách đã khai, không gần giống cũ)
        │  mỗi kịch bản một `video_scale_variants`; mỗi cảnh một việc CLIP (+ TTS nếu bật giọng đọc)
        ▼
CLIP    Veo image-to-video, 9:16, ảnh gốc làm khung đầu — giữ chỗ tiền trong trần NGÀY trước lời gọi, hỏi mỗi 20 giây
TTS     OpenAI TTS (tuỳ chọn)
        ▼  đủ clip ⇒ việc RENDER
RENDER  ffmpeg: chuẩn 9:16 30 fps, ghép cảnh, âm gốc / giọng đọc / nhạc có quyền, móc câu, chữ bán hàng, phụ đề, CTA
        │  lưu clip nguồn + bản hoàn chỉnh + ảnh bìa
        ▼
QC      kỹ thuật (ffprobe, tất định) + hình ảnh (mô hình so 4 khung với ảnh gốc: màu, cổ, tay, eo, dáng, người mẫu, chữ/logo lạ)
        ▼
REVIEW  người duyệt / loại (loại bắt buộc lý do) — hoặc mã bật "tự duyệt khi QC đạt": QC PASS ⇒ máy duyệt; FLAG vẫn chờ người
```

Video `APPROVED` là đầu vào của PR 2 (đăng Reel) và PR 3 (quảng cáo).

## 2. Ranh giới không được xoá

1. **Điểm ảnh gửi máy sinh video chỉ là ảnh sản phẩm THẬT của shop** (`creative_sources.kind = 'PRODUCT_PHOTO'`, đúng
   mã, đang bật). Kiểm ba lần: lúc tạo lượt, lúc đọc ảnh cho clip (`loadSourceImage`), và trong adapter lúc chạy
   (`assertVideoPixelSafe`). Cùng ranh giới 2–3 của vòng mẫu ảnh (`docs/creative-loop.md` §2).
2. **Không giả lập thành công.** Thiếu `GEMINI_API_KEY`, thiếu ffmpeg, chưa khai trần, chạm trần ⇒ việc `BLOCKED` với câu
   nói rõ thiếu gì; nhà cung cấp lỗi ⇒ `FAILED` với lỗi thật. Bộ sinh GIẢ chỉ có khi `NODE_ENV !== 'production'` **và**
   `VIDEO_PROVIDER_FAKE=1`; lượt dùng nó mang `is_test` — màn hình gắn nhãn "DỮ LIỆU THỬ", không đăng, không quảng cáo,
   không chạy QC hình ảnh.
3. **Không gửi lại một lời gọi tốn tiền mà không biết lượt trước tới đâu.** Veo không nhận khoá chống trùng.
   `provider_pending_at` ghi NGAY TRƯỚC lời gọi tạo, xoá cùng lúc lưu mã thao tác. Không có phản hồi, hoặc gặp lại dấu ấy
   mà không có mã ⇒ `FAILED · AMBIGUOUS`; chỉ người có `expenses:write` bấm "Thử lại" (nhật ký ghi "chấp nhận rủi ro trả
   tiền hai lần"). Lỗi CÓ phản hồi (429 / 5xx) ⇒ chắc chắn chưa tạo ⇒ trả chỗ trong trần, tự thử lại, lùi 1 → 4 → 16 phút.
4. **Video bị QC loại không đi tiếp.** `video_scale_variants_approve_check`: `APPROVED` đòi `qc_verdict ∈ (PASS, FLAG)` +
   có bản hoàn chỉnh + có mốc duyệt. `video_scale_variants_auto_check`: máy chỉ tự duyệt `PASS`, và dòng tự duyệt không
   mang người. Kiểm thử sửa thẳng CSDL để chứng minh CHECK chặn.
5. **Mô hình không quyết định.** Chọn góc là hàm thuần; LLM chỉ viết cho góc đã chọn. Câu GIỮ SẢN PHẨM + CẤM CHỮ của câu
   lệnh Veo do mã nguồn gắn tất định (`VEO_KEEP_PRODUCT`), không nhờ LLM nhớ.
6. **Nhạc chỉ từ thư viện có quyền** (`video_scale_music`, bắt buộc khai nguồn + quyền ≥ 10 ký tự). Không có bản nào ⇒
   video dùng âm gốc của clip. Máy không bao giờ tự lấy nhạc ở nơi khác.

## 3. Tiền

| Trần | Giá trị | Ghi chú |
|---|---|---|
| Chi sinh video / ngày | **bắt buộc khai**, ≤ 30 USD (trần cứng) | chưa khai ⇒ không sinh — máy không đoán ngân sách |
| Clip / ngày | ≤ 120 | chặn vòng lặp hỏng kể cả khi giá sai |
| Clip đồng thời | ≤ 3 | |
| Biến thể / lượt | ≤ 6 | |
| Cảnh / biến thể | ≤ 3 | 3 × 8 giây = 24 giây, trong khung 3–90 giây của Reels |
| Hậu kỳ đồng thời | 1 | VPS 2 nhân đang chạy Postgres + ERP |

**Giá là ƯỚC TÍNH theo bảng công bố** (ai.google.dev/gemini-api/docs/pricing, đọc 27/09/2026) — Gemini API không trả số
tiền trong phản hồi. Veo 3.1 Fast 0,10 USD/giây (720p) · Lite 0,05 · Standard 0,40. Model không có trong bảng ⇒ giá CHƯA
BIẾT ⇒ không sinh. Trần ngày đếm **tiền giữ chỗ** (`reserved_usd`, ghi trước lời gọi tạo, gồm cả lượt hỏng — không biết
Google có tính lượt bị bộ lọc chặn hay không) theo ngày giờ Việt Nam; trần đọc từ cấu hình HIỆN TẠI trước MỖI clip, nên hạ
trần / tắt module có hiệu lực ngay với việc đang xếp hàng. Ví dụ mặc định (Fast, 720p, 2 cảnh × 8 giây): **1,60 USD / biến thể**.

Kịch bản, câu chữ, QC hình ảnh, giọng đọc đi qua OpenAI và ghi sổ `ai_interactions` như mọi lượt AI khác (trần AI ngày
`ai.tran-ngay-usd` áp cho chúng). Giọng đọc: tài liệu OpenAI không in giá một lượt ⇒ tiền ghi CHƯA BIẾT.

## 4. Hàng đợi

Không có bảng hàng đợi chung trong kho; module dùng `video_scale_jobs` theo đúng lối "cầm bằng trạng thái" của kho:

- **Khoá chống trùng** `idempotency_key` (duy nhất): `script:<lượt>` · `clip:<biến thể>:<cảnh>` · `tts:…` · `render:<biến thể>` ·
  `qc:<biến thể>:<tệp>`.
- **Cầm có hạn** `locked_until` + `lock_token`, cập nhật có điều kiện — lượt `after()` sau cú bấm và lượt của bộ lập lịch
  chạy song song không cầm trùng. Mọi lượt chốt đòi đúng `lock_token`.
- **Thử lại** chỉ lỗi `TRANSIENT` / `TIMEOUT`, trong `max_attempts` (SCRIPT 2 · CLIP 3 · TTS 3 · RENDER 2 · QC 3).
- **Hạn chót** clip: 20 phút chờ Veo. Video trên máy chủ Google chỉ giữ 2 ngày — hàng đợi tải về ngay trong lượt hỏi thấy xong.
- **Chạy ở đâu:** sau mỗi cú bấm, `after()` chạy hàng đợi tới 15 phút (ngủ giữa các lượt hỏi Veo). Lưới an toàn khi tiến
  trình chết: job `video-scale` của bộ lập lịch, **chỉ có trong lịch khi đặt `VIDEO_SCALE_EVERY_MINUTES`** (chi tiền thật ⇒
  fail-closed như `CREATIVE_LOOP_EVERY_MINUTES`: xoá Variable ⇒ 0 ⇒ ra khỏi lịch).

## 5. Tệp

Trong CSDL, khúc `bytea` 2 MB (`video_scale_assets` + `video_scale_asset_chunks`), phục vụ qua `/api/video-scale/assets/[id]`
có `Range` (quyền `ideas:view`). Trần một tệp 60 MB, tổng 4 GB. Giữ: clip nguồn + giọng đọc 3 ngày sau khi biến thể kết thúc;
bản hoàn chỉnh của biến thể KHÔNG dùng (loại / hỏng / QC loại / huỷ) 14 ngày; bản đã duyệt giữ. Xoá NỘI DUNG, giữ dòng.

## 6. Máy chủ

- Image Docker cài `ffmpeg` + `font-dejavu` và **kiểm ngay lúc dựng** (thiếu ⇒ dựng đỏ, AGENTS.md mục 65).
- Chữ trên hình đi qua tệp (`textfile=`, `expansion=none`), tham số đi dạng mảng (`shell: false`) — chữ của người / mô hình
  không bao giờ thành lệnh hay bẻ được bộ lọc.
- Đã đo trên máy dựng (ffmpeg 8.0, Windows): dựng 8 giây 720×1280 kèm chữ ≈ 1 giây.

## 7. Quyền

| Việc | Quyền |
|---|---|
| Xem | `ideas:view` |
| Tạo lượt · làm lại biến thể (tiêu tiền) | `ideas:write` **và** `expenses:write` (cùng cặp với "Đăng camp") |
| Duyệt / loại · huỷ lượt · thử lại việc · nhạc | `ideas:write` |
| Thử lại việc `AMBIGUOUS` | thêm `expenses:write` |
| Cấu hình (trần tiền, model) | `settings:manage` |
| Tự duyệt theo mã | `settings:manage` hoặc `expenses:write` |

Không thêm khoá quyền mới — nên không có việc gì phải làm với `auth.rolePermissions` trên production.

## 8. Chủ shop cần làm để chạy THẬT (HUMAN GATE)

| Việc | Vì sao máy không tự làm |
|---|---|
| Thêm GitHub Secret **`GEMINI_API_KEY`** (khoá Gemini API **bậc trả phí** — Veo không có bậc miễn phí), rồi chạy ops `apply-ai-env` hoặc deploy | bí mật; khoá của bot chat nằm trong container riêng, ERP không đọc được và không được đọc |
| Tab Cấu hình: **Bật** + khai **trần chi sinh video / ngày (USD)** | trần tiền là quyết định kinh doanh |
| (Tuỳ) GitHub Variable **`VIDEO_SCALE_EVERY_MINUTES`** (gợi ý 5) rồi deploy | đổi lịch bộ lập lịch là việc của chủ shop (AGENTS.md mục 7) |
| (Tuỳ) khai **câu chính sách bán hàng** được phép nói, tải **nhạc có quyền** | máy không đoán khuyến mãi, không tự lấy nhạc |
| Có ẢNH SẢN PHẨM THẬT cho mã (Thư viện Media → Nguồn ảnh → Nhập từ Pancake) | máy không sinh video cho sản phẩm nó không nhìn thấy |

## 9. Vận hành hằng ngày

1. Mở **Video Scale → Mã win**. Mã chưa có ảnh gốc hiện "0 ảnh gốc" — nhập ảnh trước.
2. Bấm **Tạo chiến dịch media** → chọn 1–3 ảnh gốc rõ sản phẩm → 3–4 biến thể → (tuỳ) góc bán → Tạo. Xem ước tính tiền ở
   tab Cấu hình trước lần đầu.
3. **Hàng đợi render**: theo dõi. `Bị chặn` luôn kèm câu lý do (thiếu khoá / chạm trần / tắt module). `Hỏng · không rõ đã
   tạo chưa` = có thể đã mất tiền — chỉ thử lại khi chấp nhận trả hai lần.
4. **Duyệt video**: xem video cạnh ảnh gốc, đọc QC từng điểm. Duyệt, hoặc Loại kèm lý do cụ thể (vd "sai màu cổ áo") —
   lý do là dữ liệu học của PR 4.

## 10. Rủi ro đã biết

- Tham số Veo lấy từ tài liệu (đọc 27/09/2026) và chạy trên bộ giả trong kiểm thử — **lượt Veo thật đầu tiên** nên là 1
  lượt × 1 biến thể để đối chiếu hình dạng phản hồi (`generatedSamples[0].video.uri`) và giá thật trên Google AI Studio.
- Bộ lọc an toàn của Veo có thể chặn ảnh người mẫu (ảnh gốc có người thật): việc hỏng `PERMANENT` kèm lý do của Google —
  thử ảnh gốc khác (cận sản phẩm, ít mặt người).
- QC hình ảnh là một mô hình đọc ảnh — nó giảm việc cho người duyệt, không thay người duyệt; vì thế mặc định mọi mã là
  "người duyệt từng video".

## 11. PR 2 — Content + đăng Facebook Reel

```
Video ĐÃ DUYỆT (người, hoặc máy khi mã bật tự duyệt)
  → CAPTION   LLM viết 3 phương án (móc câu · thân · CTA · hashtag) từ kịch bản của video + sự thật về mã
              → CÙNG bộ kiểm khẳng định với kịch bản (`lib/video-scale/claims.ts`): giá, size, màu, chất liệu, khuyến mãi
  → NGƯỜI     chọn / sửa content (máy chủ kiểm lại) → Đăng ngay hoặc Hẹn giờ (≥ 10 phút, ≤ 29 ngày — luật Facebook)
     hoặc MÁY fanpage bật TỰ ĐĂNG ⇒ phương án đầu, trong trần bài / ngày của fanpage
  → PUBLISH_REEL  mở phiên (video_reels start) → tải byte (rupload) → ĐĂNG (finish) → hỏi trạng thái tới khi đăng xong
```

**Fanpage ĐƯỢC DUYỆT theo mã** (`video_scale_skus.page_id`): người có `expenses:write` / `settings:manage` chọn trong danh
sách fanpage ERP đã biết (`fanpages`, đồng bộ từ Pancake) — máy không đoán theo tên. Mã chưa gán ⇒ không đăng được.

**Chế độ đăng**: theo FANPAGE (`video_scale_pages`). Fanpage chưa có dòng = **chờ người bấm từng bài** (mặc định an toàn).
`AUTO_PUBLISH` ⇒ máy đăng video đã duyệt + content qua kiểm, tối đa N bài / ngày (1–10); bài vượt trần nằm CHỜ tới 0 giờ,
không mất. Mã có thể ép "luôn chờ người" kể cả khi fanpage tự đăng.

**Dừng khẩn cấp ba cấp** — mã · fanpage · toàn module (`settings["videoScale.automation"]`, FAIL-CLOSED: đọc lỗi / JSON hỏng /
`paused` không đúng kiểu ⇒ coi như DỪNG). Có hiệu lực ở lượt việc kế tiếp: cổng đăng đọc lại TRƯỚC MỖI lượt. Kéo: `ideas:write`
hoặc `expenses:write`; nhả: `expenses:write` hoặc `settings:manage`; cả hai bắt buộc lý do, ghi nhật ký. Công tắc khẩn cấp
quảng cáo (`ads.write.kill`) và `ADS_WRITE_ENABLED` vẫn áp — mọi lời ghi Facebook đi qua `graphPost`.

**Không đăng trùng**: một dòng `video_scale_posts` / (biến thể, fanpage) — ràng buộc duy nhất; thử lại dùng lại dòng. Bước
mở phiên và tải byte gửi lại an toàn (không tạo bài). Chỉ bước `finish` ĐĂNG: `pending_step = FINISH` ghi trước; lượt sau
thấy dấu ⇒ HỎI trạng thái video trước, Facebook đã nhận ⇒ không gửi lại. Mất phản hồi mà hết lượt thử ⇒ bài HỎNG nhưng
GIỮ dấu ⇒ không ai đăng lại mù (phải kiểm fanpage rồi huỷ). Facebook TRẢ LỜI từ chối ⇒ chắc chưa đăng ⇒ xoá dấu.

**Đổi fanpage giữa chừng** ⇒ bài đang chờ hỏng có lý do "fanpage đã đổi", không lên fanpage cũ.

**Token**: ERP lấy token FANPAGE bằng token System User mỗi lần dùng (`GET /{page_id}?fields=access_token`) — không lưu,
không log. Cần `pages_show_list` · `pages_read_engagement` · `pages_manage_posts` (tab Đăng Reel hỏi Facebook và in thiếu gì)
và System User được GIAO fanpage với quyền Tạo nội dung (chỉ lộ ra ở lượt đăng đầu tiên).

### HUMAN GATE thêm của PR 2

| Việc | Vì sao máy không tự làm |
|---|---|
| Token System User có `pages_manage_posts` + `pages_read_engagement` + `pages_show_list`, và được giao fanpage thử (quyền Tạo nội dung) | cấp quyền là việc của chủ Business Manager |
| Gán **fanpage thử** cho mã thử ở tab Mã win | chọn fanpage nào đăng là quyết định của người |
| (Tuỳ) bật TỰ ĐĂNG cho fanpage | để máy đăng thay người là quyết định kinh doanh |

## 12. PR 3 — Quảng cáo Meta + hạn mức

```
Reel ĐÃ ĐĂNG của video đã duyệt
  → planVideoAd       một dòng `video_scale_ads` / (video, tài khoản) — ràng buộc duy nhất; tên VS_<mã>_<yymmdd>_<fanpage>_V<n>
  → CREATE_AD (việc)  tải video bằng LINK KÝ TÊN (≤ 2 giờ) → đợi `ready` → ảnh bìa → bài quảng cáo video (chép nút kêu gọi
                      của MẨU MẪU) → CHIẾN DỊCH riêng (TẮT, ABO) → NHÓM (ngân sách NGÀY) → QUẢNG CÁO
  → bật               chỉ khi cổng `gateVideoAd` cho qua (người bấm, hoặc AUTO_LAUNCH)
```

**Ba chế độ theo mã** (`video_scale_skus.ads_mode`): `DRAFT` (mặc định — chỉ lập dòng, người bấm dựng) · `PUBLISH_PAUSED`
(Reel đăng xong ⇒ máy dựng đủ ba cấp, để TẮT) · `AUTO_LAUNCH` (dựng xong ⇒ máy bật nếu cổng cho qua). `AUTO_LAUNCH` là
QUYẾT ĐỊNH ĐỨNG TÊN: CHECK ở CSDL đòi đủ tài khoản quảng cáo + ngân sách ngày khởi điểm + trần mã / ngày + người bật. Đây là
một lời duyệt thường trực có phong bì tiền rõ, không phải nâng `MAX_ALLOWED_ADS_WRITE_MODE` (vẫn `COPILOT`).

**Cổng `gateVideoAd`** — hàm thuần, thứ tự chốt, kiểm thử khoá cả thứ tự: đường ghi Facebook mở → không dừng khẩn cấp ở cấp
nào (module · mã · fanpage) → video đã duyệt, không phải dữ liệu thử, QC không loại → Reel đã đăng + fanpage của mã chưa đổi →
có tài khoản quảng cáo + mẩu mẫu → (bật / đổi ngân sách) có LUẬT TẮT ở Thư viện Media → ngân sách hợp lệ và trong BA TRẦN:
mỗi quảng cáo (trần cứng 500.000đ) · mã / ngày (trần cứng 2.000.000đ) · toàn module / ngày (trần cứng 5.000.000đ, bắt buộc
khai). Đổi ngân sách: đọc ngân sách hiện tại TỪ FACEBOOK, tối đa +30% / lần, một lần / quảng cáo / ngày. **Tắt luôn được** —
kể cả khi đường ghi đóng hay đang dừng khẩn cấp (tắt chỉ làm giảm tiền).

**Không tạo trùng**: `pending_step` ghi TRƯỚC lời gọi tạo chiến dịch / nhóm / quảng cáo; gặp lại dấu mà không có id ⇒ KHÔNG gửi
lại, hỏng kèm TÊN để người tìm trên Ads Manager. Tải video / ảnh / dựng bài gửi lại được (không tiêu tiền).

**Không đụng camp ngoài module**: mọi lời ghi nhắm id do CHÍNH module tạo ra (`video_scale_ads.fb_*`). Mẩu mẫu chỉ được ĐỌC.

**Sổ** `video_scale_ad_actions`: mọi lượt tạo / bật / tắt / đổi ngân sách — cả lượt BỊ CHẶN (kèm mã chặn) và lượt HỎNG.

**Dừng khẩn cấp theo phạm vi**: dừng mã / fanpage / toàn module ⇒ xếp việc `PAUSE_AD` cho mọi quảng cáo đang chạy trong phạm vi.

### HUMAN GATE thêm của PR 3

| Việc | Vì sao máy không tự làm |
|---|---|
| `ADS_WRITE_ENABLED=true` + `ADS_WRITE_MODE=COPILOT` (GitHub Variables) rồi deploy | mở đường ghi tiền là quyết định của chủ shop |
| Khai **mẩu quảng cáo mẫu** (Cấu hình) và **luật TẮT** (Thư viện Media → Cấu hình & luật) | máy không đoán đối tượng / mục tiêu / điều kiện dừng |
| Khai **trần toàn module / ngày** (Cấu hình) | trần tiền là quyết định kinh doanh |
| Mỗi mã: tài khoản quảng cáo · chế độ · ngân sách ngày khởi điểm · trần mã / ngày | như trên |

