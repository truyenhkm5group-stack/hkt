# Sở hữu miền dữ liệu — ERP ↔ Chốt Đơn Tự Động, và chatbot

*06/10/2026. Khai trong mã: `lib/saas/catalog.ts::ProductDef.ownedDomains`; `domainOwnershipConflicts()` + bài kiểm chặn
hai sản phẩm cùng làm nguồn sự thật một miền.*

## 1. Ai sở hữu gì

| Miền | Chủ (nguồn sự thật) | Nơi dữ liệu nằm |
|---|---|---|
| Sản phẩm, SKU, giá, tồn kho, khách (hồ sơ kinh doanh), đơn, kho, giao vận, tài chính, lương, sản xuất | **ERP** | bảng nghiệp vụ trong CSDL workspace |
| Kênh, Facebook Page, hội thoại, tin nhắn, hộp thư hợp nhất, AI Sales Agent, cấu hình agent, prompt, tri thức, runtime AI, nhắn lại, tự động hoá bán hàng, phân tích hội thoại, quy kết bán hàng AI | **Chốt Đơn Tự Động** | `sales_chat_*`, `sales_conversation_events`, `settings['ai.salesChatbot*']`, `org_connections` (kênh) trong CSDL workspace; `platform_messenger_pages` (chỉ mục page ⇒ workspace) |
| Dùng AI, chi phí AI | **Control plane** (đo) — sản phẩm chỉ ghi | `platform_ai_usage` |
| Khách thương mại, thuê bao, gói, bảng kê | **Control plane** | `platform_*` |

## 2. Hai runtime chatbot hôm nay (audit 06/10/2026, origin/main `51db3e42`)

| | Bot nhà `chatbot/` | Chốt Đơn `lib/sales-chatbot/` |
|---|---|---|
| Chạy ở | container riêng `erp-chatbot` (Node, ~9,7k dòng JS), không Postgres | trong ứng dụng, CSDL của từng workspace |
| Ai dùng | chỉ workspace nhà (VNX) — `assertHomeCredentials("chatbot")` | mọi workspace khách bật `ai_sales` |
| Hội thoại / cấu hình | tệp JSON trên volume (`state.json`, `pages.json`, `system.md`) | `sales_chat_*`, `settings` |
| Đơn | ghi thẳng Pancake POS, ERP thấy qua đồng bộ Pancake | `createOrderAsAgent` (ERP, cùng CSDL) |
| Tồn / giá | Pancake POS API | ERP (`lib/sales-chatbot/catalog.ts` → `lib/queries/stock.ts`) |
| Sổ AI | sổ riêng `aicost.js` — **không vào `platform_ai_usage`** | `recordAiUsage` |
| Module gác | `connector_pancake` · feature `connector_pancake.chatbot` · quyền `cs:config` | `ai_sales` |

## 3. Bản đồ chuyển

| Phần | Chủ hiện tại | Chủ đích | Cách chuyển | Nguồn sự thật | Ngừng dùng |
|---|---|---|---|---|---|
| Miền AI bán hàng (khai báo) | lẫn lộn | Chốt Đơn | **XONG (0224)**: danh mục khai Chốt Đơn sở hữu; workspace nhà có thuê bao Chốt Đơn (runtime cũ) | Chốt Đơn | — |
| `/chatbot` trên ERP | bot nhà (iframe quản trị) | cửa vào Chốt Đơn | **XONG**: khung «Chatbot thuộc Chốt Đơn» — workspace bật `ai_sales` được đưa sang `/ai/sales-chatbot`; workspace nhà thấy nhãn runtime chuyển tiếp | — | khi runtime cũ tắt: trang thành chuyển hướng |
| Hội thoại, cấu hình, prompt, tri thức của VNX | tệp JSON của container | `sales_chat_*` + `settings` của workspace nhà | chạy bóng từng page (M10) | bot nhà → Chốt Đơn sau khi chuyển page | tắt container khi page cuối chuyển |
| Đơn do bot của VNX tạo | Pancake POS | ERP qua `OrderSink` | cần `PancakePosSink` (VNX vẫn bán bằng POS) | ERP | — |
| Sổ AI của bot nhà | `aicost.js` | `platform_ai_usage` | đi theo khi chuyển runtime | control plane | — |
| Giọng nói, persona theo quảng cáo, bảng size | bot nhà | Chốt Đơn | chuyển tính năng (vision đã có `vision.ts`) | Chốt Đơn | — |

## 4. Vì sao runtime của VNX CHƯA chuyển trong đợt này — và điều kiện để chuyển

Đổi runtime bán hàng của chính VNX là quyết định production không đảo được nửa chừng (khách thật đang nhắn). Kế hoạch đã
có từ trước (`docs/productization/MIGRATION_PLAN.md` §M10, TD-08, DOMAIN_MAP): chuyển TỪNG PAGE, chạy BÓNG trước, chủ shop
duyệt mỗi page. Bốn chặn kỹ thuật đã đo, phải gỡ trước:

1. **Ghi đơn**: `manualOrderOrgGate()` từ chối tạo đơn khi `connector_pancake` bật (đơn của VNX đến từ Pancake) — cần
   `PancakePosSink` để bot Chốt Đơn ghi đơn vào POS như bot nhà đang làm.
2. **Webhook**: `resolveUrlSecretOrganization` (`lib/platform/webhooks.ts`) loại workspace nhà cho fanpage Pancake / Zalo.
3. **Lịch job**: `sales-followup`, `sales-health` chỉ chạy qua fan-out, mà fan-out bỏ workspace nhà.
4. **Nguồn trả tiền AI**: `salesChatProvider` chỉ có PLATFORM / BYOK; khoá `.env` của nhà chưa là một lựa chọn.

Khi bốn chặn gỡ xong: bật `ai_sales` cho workspace nhà ở chế độ bóng trên MỘT page → so hội thoại vàng → chủ shop duyệt →
chuyển page → lặp → tắt container. Thuê bao Chốt Đơn của VNX không đổi qua cả quá trình (chỉ runtime đổi).
