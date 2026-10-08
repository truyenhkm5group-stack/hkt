# Bản đồ ma sát — hành trình chủ shop Chốt Đơn Tự Động (08/10/2026)

*Sứ mệnh `product-excellence-baseline` · R0 · đọc mã ở `origin/main` `36b7791b`. Tệp này SỬA TẠI CHỖ ở mỗi chu kỳ review
(`README.md` §3), mỗi lần sửa ghi ngày ở cột «Mức» hoặc ở dòng cuối của bước.*

**Về danh sách 20 bước.** Phụ lục gốc của sứ mệnh (DISCOVER → … → REFER) không có trong kho mã. 20 bước dưới đây được dựng lại
theo đúng hai đầu mút đó và theo các mốc đã có trong mã (`lib/platform/saas-metrics.ts:254-262`, `docs/saas/HELP_CENTER.md` §7).
Nếu phụ lục đặt tên bước khác thì đổi tên, giữ nội dung.

Ký hiệu loại vấn đề: **F** ma sát (thêm thao tác / chờ) · **N** nhầm lẫn · **K** chữ kỹ thuật · **L** lỗi · **T** độ trễ ·
**H** thiếu hướng dẫn · **TC** vấn đề tin cậy.
Mức: **P0** chặn khách / sai tiền · **P1** khách lạc hoặc hiểu nhầm, sai đơn · **P2** đánh bóng (cùng thang `SHELL_AUDIT` §0).
«Chưa quan sát» = không có bằng chứng trong kho hay trong số đo production 08/10; KHÔNG có nghĩa là không có vấn đề.

## 0. Tóm tắt theo bước

| # | Bước | Vấn đề nặng nhất | Mức |
|---|---|---|---|
| 1 | DISCOVER — biết tới sản phẩm | chưa quan sát (không ghi nguồn khách) | — |
| 2 | EVALUATE — xem giá, điều khoản | gói AI thấp nhất 790k so với đối thủ 199k–480k | P2 |
| 3 | SIGNUP — tạo cửa hàng | F-02 không có thuê bao | **P0** |
| 4 | FIRST LOGIN | F-01 trang trắng ≥ 15–40 giây | **P0** |
| 5 | ORIENT — màn đầu tiên | Hộp thư rỗng không chỉ bước tiếp | P1 |
| 6 | SETUP SHOP | `/setup` đầy chữ ERP, link vào trang bị chặn | P2 |
| 7 | ADD PRODUCTS | chữ kho của ERP, nút nằm dưới nếp gấp trên điện thoại | P2 |
| 8 | CONNECT CHANNEL | Meta trực tiếp BLOCKED · trang kết nối lộ 16 connector ERP | **P1** |
| 9 | TEACH AI | «Field không tick», «webhook», «ERP» | P1 |
| 10 | TEST AI | khung thử tự cuộn cả trang trên điện thoại | P1 |
| 11 | GO LIVE | «Hỏng» cho việc chưa làm, 4 danh sách việc rời nhau | P1 |
| 12 | FIRST CUSTOMER MESSAGE | webhook là nguồn duy nhất, không quét bù | P1 |
| 13 | FIRST AI REPLY | bot im vì cạn credit trả trước (06/10, 07/10) | **P0** |
| 14 | HANDLE IN INBOX | 3 dòng thấy trọn, thứ tự đổi dưới tay | P2 |
| 15 | ORDER → CONFIRM | chốt sai khi khách chưa đồng ý 4/11 | **P1** |
| 16 | FULFILL / OUTCOME | chưa quan sát kết cục đơn của khách vỏ | — |
| 17 | SEE VALUE | không có «AI đã mang về bao nhiêu» cho chủ shop | P2 |
| 18 | GET HELP | 4/13 bài dẫn vào trang bị chặn, không kênh liên hệ | P1 |
| 19 | PAY / RENEW | trang Gói báo «liên hệ người vận hành», chưa thu được V1 | **P0** |
| 20 | EXPAND & REFER | trang Nhân viên 776 ô quyền; không có cơ chế giới thiệu | P2 |

## 1. Chi tiết

### 1. DISCOVER
| Loại | Vấn đề | Bằng chứng | Mức |
|---|---|---|---|
| H | Không biết khách đến từ đâu: nguồn của lượt đăng ký `/start` không được ghi | `docs/productization/11_SAAS_METRICS_SPEC.md` §8 | P2 |
| — | Trang giới thiệu theo thương hiệu đã chạy từ 05/10 (#552, #569) | — | chưa quan sát ma sát |

### 2. EVALUATE
| Loại | Vấn đề | Bằng chứng | Mức |
|---|---|---|---|
| F | Gói có AI thấp nhất là STARTER 790.000 ₫/tháng; gói INBOX 299.000 ₫ không có AI. Đối thủ chatbot (tra 03/10): Retion Lite 199k, Pro 480k | `docs/saas/PRICING_V1.md` §I.1, `docs/platform/pricing.md:13-17` | P2 · quyết định giá là của chủ shop |
| TC | Điều khoản 1.0 chưa qua luật sư (theo ghi chép ngày 04/10) | ghi chép dự án, không có trong kho | P2 |
| N | Số ngày dùng thử có HAI nguồn: trang giá đọc phiên bản giá (`app/pricing/page.tsx:39`), Điều khoản đọc hằng `TRIAL_DAYS = 7` (`lib/billing/rules.ts:166`, `app/dieu-khoan-su-dung/page.tsx:82`). Chỉ khớp khi phiên bản giá khai đúng 7 ngày; chưa kiểm số đang chạy | đọc mã | P2 |

### 3. SIGNUP
| Loại | Vấn đề | Bằng chứng | Mức |
|---|---|---|---|
| L | Workspace tự đăng ký không có thuê bao sản phẩm — production 08/10: 2/3 | F-02; `lib/onboarding/service.ts:339`, `lib/platform/provision.ts:113-114` (SUY LUẬN của `SHELL_AUDIT`) | **P0** · PR đang làm |
| F | Production để chế độ đăng ký `off` / `invite`: khách lạ không tự vào được | `docs/platform/launch-gates.md` mục B | quyết định chủ shop |
| — | Một màn, ngành chọn sẵn, ~8 giây (3/3) | `SHELL_AUDIT` §0 | tốt |

### 4. FIRST LOGIN
| Loại | Vấn đề | Bằng chứng | Mức |
|---|---|---|---|
| L · T | Trang trắng ≥ 15 giây (host Chốt Đơn), ≥ 40 giây (host khác); tải lại thì hiện | F-01, `lib/actions/auth.ts:81` | **P0** · PR đang làm |
| TC | OAuth khớp EMAIL chưa xác minh mở được phiên không mật khẩu | kiểm kê B#36, `lib/auth/social.ts:20` | P1 · chờ chủ shop (IDENTITY §7 Q5) |

### 5. ORIENT
| Loại | Vấn đề | Bằng chứng | Mức |
|---|---|---|---|
| H | Hộp thư rỗng: «Không có hội thoại nào ở bộ lọc này.» — không nói vì sao, không nút «Kết nối kênh» | F-03, `inbox/page.tsx:338`, `:354-359` | P1 |
| N · K | Banner «BẢN NHÁP» trên mọi trang dẫn vào `/setup` đầy chữ ERP; shop chỉ bán qua Facebook không cần «xuất bản» | F-15, `app/(dashboard)/layout.tsx:64` | P2 |
| N | Tên menu khác tiêu đề trang ở 5 mục | F-10 | P2 |
| L | Đường lạ ra trang 404 tiếng Anh, không vỏ, không lối về | F-11 | P2 |

### 6. SETUP SHOP
| Loại | Vấn đề | Bằng chứng | Mức |
|---|---|---|---|
| K · L | `/setup`: «Xem trước ERP», tên module nội bộ, link `/p/<slug>` bị chặn | F-15, `setup/page.tsx:81`, `lib/platform/publish.ts:156` | P2 |
| N | `/settings/ai-balance` khi cờ tắt báo «không có quyền xem» | F-12 | P2 |

### 7. ADD PRODUCTS
| Loại | Vấn đề | Bằng chứng | Mức |
|---|---|---|---|
| K | «0 kho», «Tồn khả dụng ERP», cột ĐÃ XUẤT / ĐƠN GTC / TỶ LỆ GTC | F-08, `products/page.tsx:34-36`, `:103` | P2 |
| F | Trên điện thoại, 3 thẻ «0» đứng trước nút «Tạo sản phẩm» | F-13 | P2 |
| — | Nhập sản phẩm từ link (#515) | — | tốt |

### 8. CONNECT CHANNEL
| Loại | Vấn đề | Bằng chứng | Mức |
|---|---|---|---|
| L | Meta chưa cấp quyền Page cho app: nối page trả `PERMISSION_NOT_GRANTED` (đo 06/10) | sứ mệnh `meta-messenger-access` BLOCKED; `MASTER_MISSION_STATUS.md` P0 #1 | **P1** · chờ chủ shop |
| K · N | `/settings/connections` hiện «16 connector trong sổ», khung Viettel Post, hướng dẫn vào `/settings/modules` bị chặn | F-06, `settings/connections/page.tsx:51`, `components/connectors/org-carrier-panel.tsx:20` | P1 |
| H | «Nối ở Cài đặt → Kết nối» trong khi Cài đặt vỏ không có mục đó | F-15, `ai/channels/channels-panel.tsx:351` | P2 |
| TC | Kết nối Zalo OA hay ô chat web không bao giờ được tính là «đã nối kênh» trong sổ mốc | `lib/platform/saas-metrics.ts:302` chỉ gồm 3 khoá Pancake + `facebook-messenger` | P2 (lỗ đo, không phải lỗ cho khách) |
| — | Chẩn đoán quyền Meta theo từng lý do, nói rõ ai phải làm gì | `lib/integrations/messenger/permission-guide.ts:29`, `app/(dashboard)/ai/channels/page.tsx:30` | tốt |

### 9. TEACH AI
| Loại | Vấn đề | Bằng chứng | Mức |
|---|---|---|---|
| K | «ERP» ×2, «webhook», «Field không tick…», «Khung thử (TEST)» | F-08, `ai/sales-chatbot/config-form.tsx:286`, `:292` | P1 |

### 10. TEST AI
| Loại | Vấn đề | Bằng chứng | Mức |
|---|---|---|---|
| L | Mở AI Sales trên điện thoại thì trang tự cuộn tới 7.532/8.889 px, bảng sẵn sàng bị khuất | F-04, `components/sales-chat/chat-panel.tsx:36-38` | P1 |
| H | Shop mới chưa có lịch sử nên «Phát lại hội thoại cũ» không dùng được; không có bộ kịch bản thử dựng từ danh mục của chính shop | `docs/productization/22_HISTORICAL_REPLAY.md`; không thấy mã sinh kịch bản thử theo danh mục | P2 |

### 11. GO LIVE
| Loại | Vấn đề | Bằng chứng | Mức |
|---|---|---|---|
| TC | Bảng «AI đã sẵn sàng…» gắn nhãn «Hỏng» cho «Bot đang tắt», «Cần cấu hình» của shop mới | F-07, `app/(dashboard)/ai/sales-chatbot/page.tsx:124` | P1 |
| L | Mục tồn kho dẫn tới `/inventory`, trang vỏ chặn | F-07, `lib/sales-chatbot/readiness-shared.ts:48-49` | P1 |
| N | Bốn danh sách việc rời nhau (`progress.ts` 9 bước, go-live 7 mốc, GoLiveCard 3, sẵn sàng 9); GoLiveCard không hiện trong vỏ | `HELP_CENTER.md` §7 | P1 |

### 12. FIRST CUSTOMER MESSAGE
| Loại | Vấn đề | Bằng chứng | Mức |
|---|---|---|---|
| TC | Webhook Meta là nguồn duy nhất, không quét bù Graph khi mất gói tin (cùng lớp lỗi AGENTS 51) | kiểm kê B#6 | P1 |
| H | Chưa có bài «Vì sao chưa thấy tin khách» | `HELP_CENTER.md` §3 | P1 |
| T | Độ trễ tin → màn hình chưa đo (S5) | `INBOX_V2.md` §8 | chưa quan sát |

### 13. FIRST AI REPLY
| Loại | Vấn đề | Bằng chứng | Mức |
|---|---|---|---|
| L | Bot HSLC im ~2 giờ ngày 06/10 và lần hai 07/10: tài khoản trả trước AI cạn, khoá khách và khoá nền tảng hỏng cùng phút | production 08/10; câu lỗi được xếp lớp CREDIT từ #603 | **P0** |
| T | Mục tiêu 60 giây đã chốt; số đo production chưa đọc được từ sổ nhà | `lib/constants/ai-sales-slo.ts:21` | chưa quan sát |

### 14. HANDLE IN INBOX
| Loại | Vấn đề | Bằng chứng | Mức |
|---|---|---|---|
| F | 3 dòng thấy trọn ở 1366×768, khối lọc ~300 px | `INBOX_V2.md` §1 | P2 |
| N | Làm mới 5 giây đổi thứ tự dòng ngay dưới tay người bấm | `INBOX_V2.md` D3 | P2 |
| N | Thanh điều khiển AI nói «AI chưa sẵn sàng» ba lần, in đôi «đội ngũ đang xử lý» | F-14, `inbox/control-bar.tsx:179` | P2 |
| K | Chip «Direct» / «Pancake» | `lib/sales-chatbot/inbox-shared.ts:35` | P2 |
| N | Tiếp quản, nháp đơn, AI nhường không hiện trong timeline | B#11–12 | P2 |
| — | Câu mẫu + dòng sản phẩm chèn tại con trỏ (#661) | — | tốt |

### 15. ORDER → CONFIRM
| Loại | Vấn đề | Bằng chứng | Mức |
|---|---|---|---|
| L | Chốt sai khi khách chưa đồng ý: 4/11 ca (công tắc tắt) — «??», «chưa chốt đâu», «ok để chị hỏi chồng» | golden v2 Bảng 1, `lib/sales-chatbot/tools.ts:648` | **P1** |
| L | Khách nói «thôi không lấy nữa» mà đơn nháp vẫn sống | golden v2 `huy-sau-tom-tat` | P1 |
| L | SĐT lưu nguyên dạng khách gõ; sửa SĐT bằng hồ sơ khách không đổi người nhận của đơn | golden v2 mục 5, 7 | P1 |
| TC | Đơn không mang bằng chứng từng trường; nhân viên không biết trường nào máy đã kiểm | `ORDER_CANDIDATE.md` §1 | P1 |
| TC | Công tắc «đơn đủ thông tin = đã xác nhận» áp cả nháp của bot (8/11 khi bật) — LUẬT chủ shop, không phải lỗi | `lib/records/order-create.ts:460-464` | chờ chủ shop |

### 16. FULFILL / OUTCOME
| Loại | Vấn đề | Bằng chứng | Mức |
|---|---|---|---|
| N | `/orders` mở như trang phụ của «Hội thoại»; thanh dưới tô sáng «Hội thoại» | F-11, F-13 | P2 |
| H | «Phí giao: chưa khai» không có bước nào dẫn tới | `HELP_CENTER.md` §7 bước 6 | P2 |
| — | Kết cục đơn của khách vỏ (giao / hoàn) | — | chưa quan sát |

### 17. SEE VALUE
| Loại | Vấn đề | Bằng chứng | Mức |
|---|---|---|---|
| H | Không có màn trả lời «AI đã mang về cho tôi bao nhiêu đơn / tiền» trong vỏ; «Hiệu quả» chỉ là một nút trong AI Sales | F-11; `MASTER_MISSION_STATUS.md` P0 #5 («ROI khách» còn thiếu) | P2 |
| TC | «Tỷ lệ hoàn 0.0% — 0 đơn hoàn / 0 đơn» | F-16, `customers/page.tsx:42` | P2 |
| — | Tổng quan in «—» khi chưa biết | `SHELL_AUDIT` §0 | tốt |

### 18. GET HELP
| Loại | Vấn đề | Bằng chứng | Mức |
|---|---|---|---|
| L | 4/13 bài dẫn vào trang vỏ chặn | F-05, `lib/constants/help-guides.ts:84-91` | P1 |
| H · TC | ≥ 12 câu «liên hệ hỗ trợ» không kèm kênh nào | `HELP_CENTER.md` §1 | P1 |
| F | Không có lối vào Hướng dẫn trên menu; điện thoại phải «Thêm» → Cài đặt → Hướng dẫn | `HELP_CENTER.md` §1 | P2 |
| H | Chưa có bài cho Hội thoại, Kênh kết nối, Tổng quan | `HELP_CENTER.md` §1 | P1 |

### 19. PAY / RENEW
| Loại | Vấn đề | Bằng chứng | Mức |
|---|---|---|---|
| L · K | Trang Gói: «Workspace chưa có thuê bao sản phẩm nào — liên hệ người vận hành», kèm «Khách ngoài · Hoá đơn khách» | F-02, `components/saas/my-products.tsx:9-11` | **P0** |
| L | Chưa khai tài khoản nhận tiền ⇒ Số dư AI và nạp QR thật chưa bật; chưa có hoá đơn vượt gói | `MASTER_MISSION_STATUS.md` mục 8–10; B#30 | P1 · chờ chủ shop |
| K | Ngày kiểu ISO trên trang Gói | F-16, `lib/pricing/versions.ts:574` | P2 |

### 20. EXPAND & REFER
| Loại | Vấn đề | Bằng chứng | Mức |
|---|---|---|---|
| F · K | «Nhân viên» là ma trận quyền ERP: 776 ô, cao 4.462 px trên điện thoại | F-09 | P2 |
| H | Không có cơ chế giới thiệu khách mới (tìm `referral` / `affiliate` trong `lib/`, `app/` ngày 08/10 chỉ ra quy kết quảng cáo Meta) | tìm kiếm mã | P2 |
| — | Thêm fanpage / người dùng vượt gói: giá đã chốt, hoá đơn chưa có | `PRICING_V1.md` §I.3 | xem bước 19 |
