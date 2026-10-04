# Bảng giá 10/2026 — giá vốn, giá bán, so thị trường

> Migration `0194_pricing_2026_10`. Mọi con số dưới đây là **đề xuất ban đầu**:
> - người vận hành sửa ở `/platform` không cần deploy (giá tháng · tặng khi trả năm · đơn giá mua thêm);
> - credit AI sửa theo gói hoặc theo từng tổ chức.
>
> Migration chỉ ghi vào ô còn nguyên giá trị gieo, nên ô nào đã sửa tay thì không bị đè.

## 1. Thị trường (tra 03/10/2026, nguồn trong phần ghi chú cuối trang)

| Nhóm | Sản phẩm | Giá / tháng |
|---|---|---|
| Phần mềm bán hàng / POS | Sapo Pro 249k (không giới hạn người dùng) · KiotViet 270–490k · Nhanh.vn 250–750k · Haravan 300k–3 triệu | 170k – 800k |
| Chatbot bán hàng | Bot Bán Hàng / Retion: Lite 199k · Pro 480k (10 NV, 1 triệu ký tự AI) · Fchat 99k–999k · Smax theo kênh | 0 – 999k |
| Mua thêm | Retion 30k / nhân viên · 60k / trang · Fchat 20k / NV · Nhanh 75–100k / trang | |
| Trả năm | Fchat −30% · SePay −20% · Nhanh −27–40% (cam kết 2 năm) · thông lệ SaaS ≈ «tặng 2 tháng» (−17%) | |
| Dùng thử | Sapo / Retion 7 ngày · Haravan / Pancake 14 ngày · nhiều chatbot có gói Free | |

ERP này gộp **phần mềm bán hàng + chatbot AI bán hàng** trong một gói. Giá trị tham chiếu là POS (~250–330k) cộng
chatbot (~200–480k) ≈ 450–800k.

## 2. Giá vốn một cửa hàng / tháng

Tỷ giá dùng để tính: 26.000 ₫/USD.

| Khoản | Cách tính | Số |
|---|---|---|
| Hạ tầng | VPS 8 nhân / 16 GB khoảng 0,9–1,6 triệu chứa ~40–50 cửa hàng (mỗi cửa hàng một CSDL), cộng sao lưu | ~40k (gói lớn 60–120k) |
| AI dùng chung | **Trần cứng** = credit USD của gói (`checkAiQuota` chặn trước khi gọi model) | xem bảng 3 |
| Hỗ trợ | Ước tính thời gian người | 20k – 150k |
| Thu tiền (SePay) | Phí cố định cả nền tảng | ~0 |

Một hội thoại 8 lượt tốn khoảng:
- $0,0029 với Gemini 2.5 Flash-Lite;
- $0,0084 với Gemini 3.1 Flash-Lite;
- $0,0118 với Gemini 3.5 Flash-Lite;
- $0,031 với Claude Haiku 4.5.

## 3. Bảng giá

| Gói | Giá / tháng | Trả 12 tháng | Người dùng | Credit AI / tháng | ≈ hội thoại AI (3.1 Flash-Lite) | Giá vốn khi dùng HẾT credit | Biên lãi gộp tối thiểu |
|---|---:|---|---:|---:|---:|---:|---:|
| Dùng thử | 0 | — | 3 | $1 | ~120 | ~66k | — |
| **Cơ bản** (mới) | 249.000 | 2.490.000 (tặng 2 tháng) | 2 | $1,5 | ~180 | ~99k | ~60% |
| Khởi đầu | 499.000 | 4.990.000 | 5 | $3 | ~360 | ~148k | ~70% |
| Tăng trưởng | 999.000 | 9.990.000 | 15 | $8 | ~950 | ~328k | ~67% |
| Chuyên nghiệp | 1.990.000 | 19.900.000 | 40 | $15 | ~1.800 | ~660k | ~67% |

- **Biên lãi gộp tối thiểu** tính khi khách dùng HẾT credit AI. Khách thường dùng khoảng một nửa, khi đó biên lãi gộp
  75–85%. Ngưỡng tham chiếu của SaaS là trung vị 71–74% và mục tiêu 75–80%.
- **Gói Cơ bản** là cửa vào để không mất shop nhỏ vào tay Sapo / KiotViet / Retion Lite. Nó vẫn có chatbot AI, thứ POS
  không có.
- **Giữ mốc 499k / 999k / 1,99 triệu** của chủ nền tảng: biên lãi ở mức này đạt chuẩn SaaS. Sức cạnh tranh đến từ:
  - gói Cơ bản;
  - trả năm tặng 2 tháng (khoảng 416k / 833k / 1,66 triệu mỗi tháng);
  - AI có sẵn trong gói;
  - mua thêm từng hạng mục thay vì phải nhảy gói.

## 4. Mua thêm (VND / một bước / tháng)

| Hạng mục (một bước) | Cơ bản | Khởi đầu | Tăng trưởng | Chuyên nghiệp |
|---|---:|---:|---:|---:|
| Người dùng (1) | 79.000 | 79.000 | 69.000 | 59.000 |
| Dung lượng (1 GB) | 29.000 | 29.000 | 25.000 | 19.000 |
| Bản ghi tuỳ biến (1.000) | — | 19.000 | 15.000 | 9.000 |
| Trang · đối tượng (1) · luật (5) | — | 59.000 | 49.000 | 39.000 |

**Nguyên tắc:** mua lẻ hết phần chênh giữa hai gói luôn đắt hơn nâng gói. Ví dụ: gói Khởi đầu cần từ 12 người trở lên
thì nâng lên Tăng trưởng rẻ hơn mua thêm.

**Mua thêm không làm lỗ.** Giá vốn biên của một người dùng / 1 GB / 1.000 bản ghi chỉ vài nghìn đồng, nên mỗi phần mua
thêm gần như toàn bộ là lãi.

## 5. Dùng thử 7 ngày (chủ nền tảng chốt 04/10/2026; bản đầu cùng ngày là 14 ngày)

- Cửa hàng tự đăng ký qua `/start` (cửa mở) được bật thu phí NGAY lúc tạo: `paid_through` = ngày đăng ký + 6 (tính cả
  ngày đăng ký = 7 ngày), ân hạn 3 ngày, rồi CHỈ XEM. Không xoá dữ liệu.
- Áp cho cửa hàng tạo SAU lần deploy; cửa hàng đã đăng ký giữ nguyên `paid_through` đã ghi lúc tạo.
- Dải nhắc chỉ chuyển vàng khi còn ≤ 3 ngày (`TRIAL_WARN_DAYS_LEFT`).
- Nền tảng chưa khai tài khoản nhận tiền ⇒ KHÔNG bật (khách không có đường trả tiền thì không được khoá).
- Khách mời và tổ chức người vận hành tạo: không đụng, người vận hành tự đặt điều khoản.
- Đầu ERP luôn hiện «Dùng thử miễn phí — còn N ngày» kèm nút «Chọn gói».
- Mã: `lib/billing/rules.ts` (`TRIAL_DAYS`, `TRIAL_GRACE_DAYS`, `billingNotice`) · `lib/billing/service.ts::startSelfServiceTrial`.

## 6. Chưa làm, cần chủ nền tảng quyết

- **Giảm 40% cho lần kích hoạt đầu** (Retion làm vậy): chưa làm, vì giảm giá phải là một cột tường minh (luật 38).
- **Mua thêm credit AI lẻ:** hôm nay chỉ nâng gói, hoặc người vận hành ghi đè credit cho từng tổ chức.

## Ghi chú nguồn

- botbanhang.vn/vi/pricing
- retion.ai/en/pricing
- sapo.vn/bang-gia.html
- kiotviet.vn/phi-dich-vu
- haravan.com/pages/pricing
- nhanh.vn/bang-gia
- fchat.vn/price
- smax.ai/vi/Pricing
- sepay.vn/bang-gia.html
- ai.google.dev/gemini-api/docs/pricing
- developers.openai.com/api/docs/pricing
- claude.com/pricing
- Chuẩn biên lãi gộp SaaS: stealthagents.com/research/startup-gross-margin-benchmarks-2026
- Mức giảm khi trả năm: suffdigital.com/resources/data-studies/saas-annual-billing-discount
