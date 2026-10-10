# OWNER REQUIREMENTS LEDGER — sổ yêu cầu chủ shop (Chốt Đơn Tự Động / VNXcommerce ERP)

*Lập 10/10/2026 (chiều) theo lệnh chủ shop «Owner Requirements Recovery» mục H–K. Kiểm YÊU CẦU, không kiểm trang.
Đối chiếu trên `origin/main` `3e853bd4` (#771). Production lúc lập: `6487e652` (sắp `3e853bd4`).*

Nguồn đã đọc: `docs/product/VISIBLE_PRODUCT_FINISH_BOARD.md` (main + bản mới nhất ở nhánh `docs/board-r2`, PR #772) ·
`docs/saas/LAUNCH_GATE.md` (main + r7 ở `docs/board-r2`) · `docs/tech/MASTER_MISSION_REGISTRY.md` · `docs/tech/CURRENT_CHECKPOINT.md` ·
sổ `/tech` (`origin/ai-control/registry`: `CHECKPOINT.md` + `mission.*.json`) · `docs/product/COMMERCIAL_POLISH_BOARD.md` ·
`git log origin/main` · mã nguồn (đọc có chủ đích, nêu tệp ở cột GAP) · số đo production của Tech Lead ngày 10/10/2026.

---

## 0. Cách chấm

**Bảy trạng thái — không có trạng thái thứ tám:**

| STATUS | Nghĩa |
|---|---|
| `NOT_STARTED` | Chưa có mã cho đúng yêu cầu này trên `main` (nhánh đang làm chưa gộp vẫn là NOT_STARTED). |
| `PARTIAL` | Có mã nhưng chỉ đạt một phần yêu cầu, HOẶC production / chủ shop đã chỉ ra hành vi sai. |
| `CODE_DONE_NOT_VERIFIED` | Mã đủ yêu cầu đã gộp (có thể đã deploy) nhưng CHƯA ai kiểm trên production. |
| `PRODUCTION_VERIFIED` | Đã kiểm trên production có vết: mở trang thật (ảnh trước / sau, giữ ngoài kho nếu có dữ liệu khách) hoặc run ops. |
| `DONE` | PRODUCTION_VERIFIED + chủ shop nghiệm thu. Hôm nay **0** dòng — chưa yêu cầu nào được chủ shop nghiệm thu bằng lời. |
| `BLOCKED_OWNER` | Bước tiếp theo cần chủ shop quyết / bấm. |
| `BLOCKED_EXTERNAL` | Bước tiếp theo cần bên ngoài (Meta, luật sư, kế toán). |

**Luật K (bắt buộc sau mỗi gộp / deploy):**
1. Gộp ⇒ tối đa `CODE_DONE_NOT_VERIFIED`. **Không yêu cầu nào DONE chỉ vì PR đã gộp hay đã deploy.**
2. Chỉ một lượt kiểm trên production mới nâng lên `PRODUCTION_VERIFIED` / `DONE`.
3. Production (hoặc chủ shop nhìn thấy trên production) mâu thuẫn với sổ ⇒ **production thắng**, sửa sổ ngay, hạ trạng thái.
4. Run ops chứng minh LOGIC; phần NHÌN THẤY vẫn cần mở trang. Một yêu cầu thuần logic được `PRODUCTION_VERIFIED` bằng run ops;
   một yêu cầu về giao diện thì không.
5. Ảnh workspace khách thật (HSLC) có tên · SĐT · địa chỉ ⇒ giữ ngoài kho (kho PUBLIC); sổ ghi số đo + tên tệp ảnh.
6. Không bịa số đo. Mọi con số trong sổ lấy từ run ops / lượt mở trang của Tech Lead ngày 10/10 hoặc từ tài liệu trong kho (ghi nguồn).

Mã yêu cầu: `ONB` · `HOM` · `CHN` · `INB` · `AIS` · `PRD` · `IND` · `ORD` · `STF` · `BIL` · `HLP` · `DOC` · `MOB` (khách SaaS) ·
`ADM` (admin nền tảng) · `SEC` · `LEG` · `OPS` (nền tảng chung) · `PUB` (công khai) · `ERP` (ERP lưu lượng cao) · `HSL` (bot của khách
thương mại đầu tiên HSLC). Mã đã cấp **không đổi**; yêu cầu mới thêm số tiếp theo.

---

## 1. Bảng tổng

| Chỉ số | Số |
|---|---|
| **TOTAL** | **127** |
| DONE | 0 |
| PRODUCTION_VERIFIED | 38 |
| PARTIAL | 10 |
| CODE_DONE_NOT_VERIFIED | 60 |
| NOT_STARTED | 9 |
| BLOCKED_OWNER | 6 |
| BLOCKED_EXTERNAL | 4 |
| **STALE STATUS FIXED** (sổ cũ ghi CAO hơn sự thật) | **9** — `INB-01` · `INB-04` · `INB-06` · `INB-09` · `IND-03` · `PUB-07` · `SEC-04` · `HSL-01` · `HSL-03` |

Theo bề mặt:

| Bề mặt | Tổng | PV/DONE | PARTIAL | CODE_DONE_NOT_VERIFIED | NOT_STARTED | BLOCKED_OWNER | BLOCKED_EXTERNAL |
|---|---|---|---|---|---|---|---|
| Khách SaaS | 67 | 23 | 9 | 23 | 7 | 4 | 1 |
| Admin nền tảng | 21 | 9 | 0 | 11 | 0 | 1 | 0 |
| Nền tảng chung (bảo mật · pháp lý · vận hành) | 6 | 3 | 0 | 1 | 0 | 1 | 1 |
| Công khai | 9 | 2 | 0 | 5 | 1 | 0 | 1 |
| ERP lưu lượng cao | 18 | 0 | 1 | 17 | 0 | 0 | 0 |
| Bot HSLC | 6 | 1 | 0 | 3 | 1 | 0 | 1 |
| **Tổng** | **127** | **38** | **10** | **60** | **9** | **6** | **4** |

Đếm bằng script trên cột STATUS của mọi bảng §2–§6 (không tự chấm). Yêu cầu «nhiều đơn mở trong một hội thoại · ghi lại sau
lỗi · địa chỉ có cấu trúc» chỉ đếm MỘT lần ở `ORD-05` (bảng Visible xếp nó dưới Inbox).

### 1.1 STALE STATUS FIXED — sổ cũ ghi cao hơn sự thật (9)

| REQ_ID | Sổ cũ ghi | Sự thật | Căn cứ |
|---|---|---|---|
| `INB-01` | Bảng Visible: Inbox `PRODUCTION_VERIFIED`, «chưa đọc lên đầu PASS» | PARTIAL — AI trả lời làm mất «chưa đọc» | Chủ shop 10/10 chiều; `lib/sales-chatbot/inbox.ts::UNREAD` đòi tin CUỐI là của khách (#770) |
| `INB-04` | Bảng Visible: nút nhanh «Cần người» PASS (thuộc Inbox PV) | PARTIAL — «Cần người» = mọi `status = 'HANDOFF'`, gộp thời gian AI nhường | `inbox.ts` `NEEDS_HUMAN: eq(c.status, "HANDOFF")` |
| `INB-06` | Bảng Visible: thứ tự «chưa đọc trước» PASS | PARTIAL — thứ tự đứng trên nghĩa «chưa đọc» sai | `inboxOrderBy` dùng `UNREAD`; đo PASS lúc định nghĩa CŨ |
| `INB-09` | Bảng Visible: «lọc gọn PASS» | PARTIAL — chỉ kiểm HÌNH THỨC (4 nút + Lọc ▾); chủ shop: «Bộ lọc có vấn đề» | Chủ shop 10/10; chưa có ma trận đếm · dòng · thứ tự |
| `IND-03` | Tiêu đề #755: «shop thực phẩm thôi thấy Size / Màu» | PARTIAL — chỉ 5 tệp trang sản phẩm đọc hồ sơ ngành | `grep readExperienceProfile`; Kho · Hàng hoàn · Hiệu quả SP · Sản xuất vẫn «Màu \ Size» |
| `PUB-07` | Bảng Visible: «Đăng ký / đăng nhập / quên mật khẩu» `DEPLOYED_NOT_VERIFIED` | NOT_STARTED — không có «Quên mật khẩu» tự phục vụ | `app/login/` không có link; `lib/actions/password-reset.ts` chỉ cho quản trị / người vận hành phát liên kết |
| `SEC-04` | Launch Gate S4 ✅ PROD | CODE_DONE_NOT_VERIFIED — bằng chứng là «#669 lên production», tức DEPLOY, trái chính §0 của Launch Gate | `LAUNCH_GATE.md` §3; chỉ trang Cấu hình AI Sales đã mở kiểm |
| `HSL-01` | Registry MM-HSLC-00 / MM-AI-01 `DONE` («bot im lặng / tin đơn nhanh», «không im») | Lúc sổ ghi DONE, tin vẫn rơi 22 % vì Pancake 429; sửa ở #770 | Ops org-order-audit 38030845978 · 38033540896 (95/431 → 0/97) — nay PV sau #770 |
| `HSL-03` | Registry MM-ORDER-00 `DONE` («biết ghép quy cách 0,5kg + 1kg») | Bot tính gấp đôi tiền gói 2kg tới #771 (chưa lên production) | Tiêu đề #771; registry §8.1 |

### 1.2 Lệch khác đã sửa (sổ cũ ghi THẤP hơn / lý do cũ) — không tính vào STALE

- Bảng Visible «Bảng giá» `NOT_STARTED`: trang `app/pricing/page.tsx` có, đọc số ngày dùng thử từ gói ⇒ `PUB-03` CODE_DONE_NOT_VERIFIED.
- Bảng Visible «Landing — CTA chờ D2» + Commercial C1 #4: chủ shop **09/10 đã chốt GIỮ đăng ký mở** (Launch Gate nhật ký 09/10 tối) ⇒ hết chặn (`PUB-02`).
- Bảng Visible «Tồn kho — chưa có yêu cầu nhìn thấy»: #762 (ERP-UX-E) đã gộp, có ảnh trước / sau cục bộ ⇒ `ERP-10`.
- Bảng Visible «Thanh toán / mức dùng» admin `DEPLOYED_NOT_VERIFIED`: nạp VietQR + trừ 590 ₫/khách AI chạy thật với HSLC ⇒ `BIL-01` PV.
- Registry `MM-UX-02` (danh sách 10 bước) BACKLOG: #752 đã làm danh sách 9 bước ⇒ `ONB-01`.
- Registry `MM-INBOX-01` (Hộp thư V2) **DEFERRED dù chủ shop đã mở lại**: V2-A / V2-B đã gộp, V3 ngữ nghĩa đang làm.
- `CURRENT_CHECKPOINT.md` trên main: «SURFACES PRODUCTION VERIFIED: 0» — cũ (nay Inbox V2-A/B · Cấu hình AI Sales · Sản phẩm ERP).
- Sổ `/tech`: `onboarding-v2`, `products-shell-v2` còn `INTEGRATING` dù #752 / #757 đã gộp và có trong `6487e652`.

### 1.3 Yêu cầu bị thay bằng bản yếu hơn (ghi để không ai coi là xong)

| REQ_ID | Chủ shop muốn | Bản đang chạy |
|---|---|---|
| `INB-01` | «Chưa đọc» = NGƯỜI chưa mở tin khách | #770 đổi thành «tin cuối là của khách» ⇒ AI trả lời là mất chưa đọc |
| `INB-17` | Bấm avatar mở trang Facebook thật | Mở hồ sơ khách NỘI BỘ (`avatarHrefOf`) |
| `INB-18` | Trả TẤT CẢ hội thoại cho AI | Chỉ trả từng hội thoại |
| `IND-03` | Thuộc tính theo ngành ở form + bộ lọc + điều hướng + thuật ngữ | Chỉ form / danh sách / chi tiết sản phẩm |
| `CHN-05` | Khách nhắn qua Messenger vào hộp thư | Nghiệm thu E2E đi qua CHAT WEB (kênh thay thế lúc chờ Meta) |
| `PRD-06` | Khách tự thêm sản phẩm trên giao diện | Nghiệm thu C5 đi LÕI `createProductCore`, không bấm trình duyệt |

---

## 2. KHÁCH SaaS (app Chốt Đơn)

### 2.1 Trang chủ · Onboarding

| REQ_ID | SURFACE | OWNER_REQUEST | EXPECTED_BEHAVIOR | IMPLEMENTED_BEHAVIOR | GAP | PR | PRODUCTION_SHA | PRODUCTION_EVIDENCE | STATUS | NEXT_ACTION |
|---|---|---|---|---|---|---|---|---|---|---|
| HOM-01 | Trang chủ | «Một việc nên làm tiếp» | Thiết lập chưa xong ⇒ «/» mở Tổng quan | Khách vỏ chưa xong 9/9 mở «/» về Tổng quan | — | #752 #769 | `6487e652` | `saas-acceptance --e2e --e2e-ops` PASS 8/8 bước C (run 38035198098) | PRODUCTION_VERIFIED | — |
| HOM-02 | Trang chủ | Không chữ kỹ thuật | Không «AI Sales · Kết nối · Thiết lập» kiểu kỹ thuật | #743 đổi chữ + thương hiệu sau redirect | Chưa mở trang có đăng nhập | #743 | trong `6487e652` | — | CODE_DONE_NOT_VERIFIED | Chụp khi có đường đăng nhập (`ONB-03`) |
| ONB-01 | Onboarding | Tự cài xong không cần hỏi | Một danh sách 9 bước, tiến độ, MỘT nút «Tiếp tục thiết lập» | Danh sách 9 bước DONE/NEEDS_ACTION/ERROR/FIX NOW ở Tổng quan | Chưa có ảnh: chỉ khách vỏ thấy | #752 | trong `6487e652` | Ảnh TRƯỚC (HSLC «Tổng quan», ngoài kho); ảnh SAU chưa | CODE_DONE_NOT_VERIFIED | Chờ `ONB-03` rồi chụp 1366 + 390 |
| ONB-02 | Onboarding | Hướng dẫn bước tiếp theo | Trạng thái rỗng + trang Hướng dẫn, không vòng trắng | #680: rỗng · Hướng dẫn · 404 · `/login` còn phiên (6.007 → 2 điều hướng) | Launch Gate C4 🟡 | #680 | trong `6487e652` | — | CODE_DONE_NOT_VERIFIED | Mở hộp thư rỗng của workspace thử |
| ONB-03 | Onboarding / nghiệm thu | Ảnh trước / sau mọi bề mặt khách | Có cách cho NGƯỜI đăng nhập workspace thử để chụp vỏ | Workspace thử chỉ đăng nhập bằng ops (mật khẩu trong bộ nhớ, xoay sau lượt) | Không có đường cho người | — | — | — | BLOCKED_OWNER | Chủ shop chọn: đặt lại mật khẩu khách thử / phiên ký ngắn hạn / khách thật đầu tiên |

### 2.2 Nối Facebook / Page · kênh

| REQ_ID | SURFACE | OWNER_REQUEST | EXPECTED_BEHAVIOR | IMPLEMENTED_BEHAVIOR | GAP | PR | PRODUCTION_SHA | PRODUCTION_EVIDENCE | STATUS | NEXT_ACTION |
|---|---|---|---|---|---|---|---|---|---|---|
| CHN-01 | Kênh | Khách tự nối Page không qua Pancake | OAuth → chọn Page → subscribe → tin vào hộp thư | Mã ERP xong (#603 #608 #611 #614 #628) | Meta chỉ cấp `public_profile` | #603–#628 | — | log 06/10 `PERMISSION_NOT_GRANTED` | BLOCKED_EXTERNAL | Chủ shop thêm use case Messenger trong App Dashboard (`docs/meta-app-review/HUONG_DAN_CHU_SHOP.md`) |
| CHN-02 | Kênh | Nói đúng «sắp mở» | Khách thấy «sắp mở», chỉ hướng dẫn kênh đang chạy | Cờ `meta.direct-connect.open` (#712) | Chưa mở trang | #712 | trong `6487e652` | — | CODE_DONE_NOT_VERIFIED | Mở `/settings/channels` vỏ khách |
| CHN-03 | Kênh | Bật nối thẳng khi Meta duyệt | Người vận hành bật cờ không cần deploy | Không có đường UI / ops bật cờ (MM-FU-712) | Toàn bộ | — | — | — | NOT_STARTED | Làm sau D20 (ngày bật) |
| CHN-04 | Kênh | Pancake là lối chính hôm nay | Khách dán mã trang + mã truy cập Pancake, tin vào hộp thư | Kênh Pancake chạy cho HSLC | Chưa khách mới nào tự nối trong vỏ | #637 #641 | trong `6487e652` | A7: HSLC «kết nối cũ · FB 972» (`/platform/customers`) — tổ chức cũ, không phải lượt nối mới | CODE_DONE_NOT_VERIFIED | Một lượt nối Pancake từ vỏ khách |
| CHN-05 | Kênh | Tin khách vào hộp thư | Tin qua kênh vào hộp thư, AI trả lời | Chat web → hộp thư → AI | Chỉ CHAT WEB (thay Messenger) | #690 #740 | `a951f77a` | `saas-acceptance --e2e` PASS 7/7 bước D (run 37935922309) | PRODUCTION_VERIFIED | Lặp lại bằng Messenger khi `CHN-01` mở |

### 2.3 Inbox

| REQ_ID | SURFACE | OWNER_REQUEST | EXPECTED_BEHAVIOR | IMPLEMENTED_BEHAVIOR | GAP | PR | PRODUCTION_SHA | PRODUCTION_EVIDENCE | STATUS | NEXT_ACTION |
|---|---|---|---|---|---|---|---|---|---|---|
| INB-01 | Inbox · lọc | «Chưa đọc» = người chưa mở tin khách (B1) | Khách gửi sau `staff_seen_at` ⇒ chưa đọc, BẤT KỂ AI đã trả lời; chỉ người mở mới xoá | `UNREAD` = tin cuối là của khách VÀ sau `staff_seen_at` | AI trả lời là mất chưa đọc (đúng ví dụ «xin giá → AI 280k» của chủ shop) | #748 #770 | `6487e652` | Chủ shop 10/10 chiều báo sai trên HSLC | PARTIAL | Nhánh `feat/inbox-semantics-v3` (sứ mệnh `inbox-semantics-v3`) |
| INB-02 | Inbox · lọc | Đếm chưa đọc đúng (B1) | `UNREAD_COUNT` = số tin khách sau `staff_seen_at` | Đếm sau `greatest(staff_seen, last_bot, last_staff)` | Lệch cùng gốc `INB-01` | #770 | `6487e652` | — | PARTIAL | Cùng nhánh v3 + bài kiểm hồi quy |
| INB-03 | Inbox · lọc | «Chờ trả lời» ≠ chưa đọc (B2) | Lượt cuối của khách còn cần trả lời; chờ lâu nhất trước | `NEEDS_REPLY` + `asc(last_customer_at)` | Hôm nay gần trùng mệnh đề với `UNREAD` (cùng `LAST_IS_CUSTOMER`); chưa kiểm production | #748 | `6487e652` | — | CODE_DONE_NOT_VERIFIED | Ma trận G trên HSLC |
| INB-04 | Inbox · lọc | «Cần người» chỉ khi cần người thật (B3) | Tách NEEDS_HUMAN · MANUAL_TAKEOVER · STAFF_COOLDOWN · COPILOT; lọc chỉ hiện cái đầu | `NEEDS_HUMAN` = mọi `status = 'HANDOFF'` | Gộp thời gian AI nhường / tiếp quản vào «Cần người» | #748 | `6487e652` | Chủ shop 10/10 chiều | PARTIAL | Nhánh v3: tách bốn trạng thái + bài kiểm mỗi trạng thái |
| INB-05 | Inbox · lọc | «Người đang xử lý» (B) | Lọc HUMAN = tiếp quản · AI nhường · copilot | `inboxHumanSql` (cùng mệnh đề huy hiệu hàng) | Chưa kiểm production | #748 | `6487e652` | — | CODE_DONE_NOT_VERIFIED | Ma trận G |
| INB-06 | Inbox · thứ tự | Chưa đọc trước, rồi đã đọc; tin mới nhất trước (C) | Nhóm HUMAN_UNREAD rồi đã đọc; trong nhóm theo tin có nghĩa mới nhất | `UNREAD desc, ACTIVITY desc, id` | Đứng trên nghĩa chưa đọc sai (`INB-01`) | #748 | `d307dec4` | Đo PASS theo định nghĩa CŨ (`inbox-after-unread-first-proof-1366x768`, ngoài kho) | PARTIAL | Đo lại sau v3 |
| INB-07 | Inbox · thứ tự | Không đổi chỗ vì nhãn / người phụ trách / hồ sơ / metadata (C) | Chỉ mốc TIN đẩy hội thoại lên | `ACTIVITY` = mốc tin khách · bot · nhân viên · lịch sử, không `updated_at` | Chưa kiểm production | #748 | `6487e652` | — | CODE_DONE_NOT_VERIFIED | Ma trận G: gắn nhãn / giao người rồi tải lại |
| INB-08 | Inbox · thứ tự | Đang đọc không nhảy; rời đi về đúng chỗ (C) | Hội thoại đang mở giữ chỗ; sang hội thoại khác thì về vị trí chuẩn | Giữ hàng tại chỗ khi mở (`inbox-shared.ts` gộp hàng cũ `unread: false`) | Chủ shop: «logic hiển thị danh sách có vấn đề» — chưa quy về hành vi cụ thể | #748 | `6487e652` | — | CODE_DONE_NOT_VERIFIED | Tái hiện trên HSLC trong ma trận G |
| INB-09 | Inbox · lọc | Bộ lọc đúng (G) | Mỗi lọc ALL · UNREAD · WAITING_REPLY · NEEDS_HUMAN · AI · HUMAN · HAS_PHONE · PAGE · DATE · kết hợp: đếm · dòng · thứ tự · không trùng · không thiếu | 10 thẻ + lọc nâng cao, một câu đếm cho mọi thẻ | Chưa có ma trận kiểm xác định; chủ shop: «Bộ lọc có vấn đề» | #748 | `6487e652` | — | PARTIAL | Ma trận kiểm thử xác định + chạy trên HSLC |
| INB-10 | Inbox · lọc | Lọc gọn | ≤ 5 nút nhanh + «Lọc ▾»; mở được ở 390 | Tìm kiếm + 4 nút nhanh + «Lọc ▾» | — | #748 | `d307dec4` | `inbox-after-1366x768` · `inbox-after-filter-popover-390x844` (ngoài kho) | PRODUCTION_VERIFIED | — |
| INB-11 | Inbox · mật độ | Thấy nhiều hội thoại | ≥ 10 dòng ở 1366×768, không cuộn ngang | 1366 **3 → 10** · 1440 4 → 12 · 390 4 → 11 dòng; cao dòng 87 → 56 px | — | #748 | `d307dec4` | `inbox-before-*` / `inbox-after-*` (ngoài kho) | PRODUCTION_VERIFIED | — |
| INB-12 | Inbox · soạn | Bong bóng tin, câu nhanh trong ô soạn | Tách màu 3 vùng, bong bóng, chèn câu mẫu / dòng sản phẩm | #748 + #661 #666 | Không có số đo riêng | #661 #666 #748 | `6487e652` | — | CODE_DONE_NOT_VERIFIED | Chụp một hội thoại có chèn câu mẫu |
| INB-13 | Inbox · đơn | Khung tóm tắt đơn | «ĐƠN ĐANG CHỐT»: SKU · biến thể · SL × giá · ship · tổng · tên · SĐT · địa chỉ · tỉnh · xã | Đủ trường; 390 mở bằng nút «Khách, đơn và ghi chú» | — | #753 | `e21f0ec3` | `inbox-v2b-before-*` / `inbox-v2b-after-*` (1366/1440/390, ngoài kho) | PRODUCTION_VERIFIED | — |
| INB-14 | Inbox · đơn | Trạng thái từng trường + xác nhận | 5 ô kiểm (SĐT/Địa chỉ/SKU/SL/Giá) + lý do + trạng thái đơn | 5 ô + «Giá CẦN KIỂM» kèm lý do + «ĐÃ XÁC NHẬN» | — | #753 | `e21f0ec3` | như `INB-13` | PRODUCTION_VERIFIED | — |
| INB-15 | Inbox · avatar | Ảnh khách thật, không chữ cái (E) | Meta: backfill có giới hạn tốc độ, không chậm AI; Pancake: dùng URL ảnh THẬT của nguồn | Component có; Meta chỉ lấy `profile_pic` SAU khi xử lý tin (`refreshMessengerProfile`) | HSLC vẫn thấy chữ cái; không backfill hội thoại cũ | #679 | `6487e652` | Tech Lead 10/10: HSLC thấy chữ cái | PARTIAL | Nhánh `feat/inbox-avatar-profile` |
| INB-16 | Inbox · avatar | Không giấu lỗi hồ sơ (E) | Chẩn đoán PROFILE_AVAILABLE · PERMISSION_DENIED · NOT_AVAILABLE · EXPIRED · NOT_FETCHED | Trả `FETCHED/FRESH/FAILED/SKIPPED`, lỗi bị `.catch(() => "FAILED")` | Không có lý do, không quyền Business Asset User Profile Access được kiểm | — | — | — | NOT_STARTED | Cùng nhánh avatar |
| INB-17 | Inbox · avatar | Bấm avatar → trang Facebook (F) | URL Facebook thật của nguồn ⇒ tab mới; ID đã xác minh ⇒ dựng link; KHÔNG BAO GIỜ `facebook.com/<PSID>`; không có ⇒ hồ sơ nội bộ + lý do | `avatarHrefOf()` chỉ mở `/customers/:id` | Toàn bộ thứ tự 1–3; báo số hội thoại HSLC có avatar / có link hợp lệ / chỉ nội bộ | — | — | — | NOT_STARTED | Nhánh avatar: soi `customers.fbId` · `conversationLink` · payload Pancake thật |
| INB-18 | Inbox · AI/người | «Trả tất cả cho AI» (D) | Nút cấp workspace dễ thấy; xác nhận «Trả X…» + «Y không tự chạy lại vì…»; in RESUMABLE / BLOCKED; quyền · tenant · audit · sự kiện · idempotent | Chỉ trả TỪNG hội thoại | Toàn bộ | — | — | — | NOT_STARTED | Đang làm (Tech Lead 10/10) |
| INB-19 | Inbox · AI/người | Tiếp quản / trả lại AI từng hội thoại | Bot nhường sau khi nhân viên trả lời; HUMAN → AUTO đổi đúng | `setConversationControlCore` | Phần nhìn thấy chưa chụp | #633 #746 | `863aa76a` | E2E PASS 8/8 bước R (run 37984880718; lặp 38035198098 ở `6487e652`) | PRODUCTION_VERIFIED | — |
| INB-20 | Inbox · trả lời | Nhân viên trả lời từ hộp thư | Tin SENT đứng tên tài khoản; gửi lại không nhân đôi | `sendStaffReplyCore` | Phần nhìn thấy chưa chụp | #746 | `863aa76a` | E2E PASS 8/8 bước R (run 37984880718) | PRODUCTION_VERIFIED | — |
| INB-21 | Inbox · tốc độ | Hộp thư nhanh | Tải hộp thư + chuyển hội thoại không chờ | p50 tải hộp thư **634 ms**; chuyển hội thoại p50 **~450 → ~85 ms** sau #770 | Chưa có đích do chủ shop đặt | #733 #770 | `6487e652` | ops org-order-audit 38030845978 · 38033540896 | PRODUCTION_VERIFIED | — |

### 2.4 Cấu hình AI Sales

| REQ_ID | SURFACE | OWNER_REQUEST | EXPECTED_BEHAVIOR | IMPLEMENTED_BEHAVIOR | GAP | PR | PRODUCTION_SHA | PRODUCTION_EVIDENCE | STATUS | NEXT_ACTION |
|---|---|---|---|---|---|---|---|---|---|---|
| AIS-01 | AI Sales | «Bot có đang chạy không» trong một nhìn | Ô trạng thái + MỘT nút chính; 4 nhóm cài đặt | «Đang chạy — Bot đang trả lời khách…» + «Mở hộp thư»; trang 8.097 → **5.483 px** | — | #756 | `6487e652` | `ai-settings-before-*` / `ai-settings-after-1366x768` (ngoài kho) | PRODUCTION_VERIFIED | — |
| AIS-02 | AI Sales | Không lộ hãng / model / USD | Khách vỏ không thấy tên hãng, model, khoá, USD | Ẩn với khách vỏ; nguồn AI / model chỉ ở workspace nhà | Chỉ kiểm trang này (xem `SEC-04`) | #756 | `6487e652` | như `AIS-01` | PRODUCTION_VERIFIED | — |
| AIS-03 | AI Sales | Dùng được trên điện thoại | Không tràn ngang ở 390 | 622 px tràn → **382 px** | — | #768 | `6487e652` | `ai-settings-after-390x844-fixed` (ngoài kho) | PRODUCTION_VERIFIED | — |
| AIS-04 | AI Sales · câu mẫu | Câu mẫu dễ dùng | Chọn tất cả · bật/tắt/xoá hàng loạt · trần 300 · tự nạp câu chưa khớp; công tắc có nhãn | #737 #739 (tự nạp MẶC ĐỊNH TẮT) | Chưa mở trang | #737 #739 | trong `6487e652` | — | CODE_DONE_NOT_VERIFIED | Mở màn câu mẫu HSLC |
| AIS-05 | AI Sales · kiến thức | FAQ / chính sách / khuyến mãi có cấu trúc | Ô riêng từng loại, bot đọc đúng loại | Chưa có (cần đổi lời nhắc — việc riêng) | Toàn bộ | — | — | — | NOT_STARTED | Thiết kế ô + cổng golden trước khi đổi lời nhắc (MM-AI-02) |
| AIS-06 | AI Sales | Bot trả lời khách | AI trả lời từng lượt, lên đơn nháp | Chạy | — | #690 #740 | `a951f77a` | E2E PASS 7/7 bước D (run 37935922309) | PRODUCTION_VERIFIED | — |

### 2.5 Sản phẩm / SKU · thuộc tính theo ngành

| REQ_ID | SURFACE | OWNER_REQUEST | EXPECTED_BEHAVIOR | IMPLEMENTED_BEHAVIOR | GAP | PR | PRODUCTION_SHA | PRODUCTION_EVIDENCE | STATUS | NEXT_ACTION |
|---|---|---|---|---|---|---|---|---|---|---|
| PRD-01 | Sản phẩm (ERP) | Không in «0 kho» khi chưa khai kho | «Chưa khai kho — tồn tính chung theo phiếu kho» | Đúng | — | #757 | `6487e652` | `products-before-*` / `products-after-1366x768` (ngoài kho) | PRODUCTION_VERIFIED | — |
| PRD-02 | Sản phẩm (ERP) | Số tiếng Việt | «1,62 tỷ» (dấu phẩy), «8.808 đơn vị hàng»; giá bán / giá vốn giữ nguyên | Đúng | — | #757 | `6487e652` | như `PRD-01` | PRODUCTION_VERIFIED | — |
| PRD-03 | Sản phẩm (vỏ khách) | Danh sách gọn | Giá bán · tồn khả dụng · thiếu gì, thay bảng 15 cột ERP | Có mã | Chưa chụp: chỉ khách vỏ thấy | #757 | trong `6487e652` | — | CODE_DONE_NOT_VERIFIED | Chờ `ONB-03` |
| PRD-04 | Sản phẩm | «Thêm mẫu mã» | Nút đầu trang, mở sẵn form; không sửa được thì nói vì sao | #685 | Chưa mở trang | #685 | trong `6487e652` | — | CODE_DONE_NOT_VERIFIED | Mở `/products/<mã>` |
| PRD-05 | Sản phẩm / đơn | Giá vốn chưa biết ≠ 0 | In «—», không «0 ₫», lãi gộp không bằng doanh thu | #716 | Chưa mở một mẫu mã thiếu giá vốn | #716 | trong `6487e652` | — | CODE_DONE_NOT_VERIFIED | Mở một SP chưa có giá vốn |
| PRD-06 | Sản phẩm | Khách tự thêm sản phẩm | Tạo SP + nhập hàng | `createProductCore` + `writeStockReceiptCore` | Kiểm qua LÕI, không qua giao diện | #740 | `a951f77a` | E2E PASS 7/7 bước P (run 37935922309) | PRODUCTION_VERIFIED | Phần giao diện đi cùng `ONB-03` |
| IND-01 | Thuộc tính ngành | Thời trang → Size / Màu | Tổ chức thời trang (và nhà) giữ Size / Màu, ma trận Màu × Size | Nhà luôn `FASHION`; mẫu `fashion-commerce` ⇒ FASHION | Chưa ảnh production | #755 | trong `6487e652` | Ảnh cục bộ `docs/product/evidence/erp-ux-profile/` (không phải production) | CODE_DONE_NOT_VERIFIED | Chụp VNX `/products/new` |
| IND-02 | Thuộc tính ngành | Thực phẩm: Quy cách · Khối lượng · Đơn vị bán · đóng gói | Form: Quy cách · Khối lượng (g) · đơn vị «gói»; «500g» không vào cột size | `FOOD_SEAFOOD`: ô Quy cách (`attributes.spec`) + Khối lượng (`weight`), `defaultUnit: "gói"` | Chưa mở form HSLC | #755 | trong `6487e652` | Ảnh cục bộ tổ chức thử (không phải production) | CODE_DONE_NOT_VERIFIED | Tech Lead mở form sản phẩm HSLC |
| IND-03 | Thuộc tính ngành | Không chỉ form — cả điều hướng · bộ lọc · thuật ngữ (J) | Mọi màn có size / màu đọc hồ sơ ngành | Chỉ 5 tệp đọc hồ sơ: `products/page` · `new` · `[id]` · `product-form` · `products-table` | Còn cố định thời trang: `/inventory/shortage` («Màu \ Size», `pending-matrix-section.tsx:210`), `/inventory/decisions`, `/inventory/returns` (nhận diện mẫu mã), `/inventory/workshop/[id]`, `/products/performance`, `/production/topics/[id]`, cột «Size» ở `lib/constants/stock-shortage.ts:766` + `landing.ts` | #755 | trong `6487e652` | — | PARTIAL | Đưa `readExperienceProfile` vào các màn trên (hoặc ẩn khi `sizeColorMatrix = false`) + bài kiểm quét mã |
| IND-04 | Thuộc tính ngành | HSLC (FOOD_SEAFOOD) không mặc định Size / Màu | HSLC tự nhận hồ sơ thực phẩm | Tự nhận chỉ khi mẫu ngành là `food-commerce` / `seafood-commerce`; còn lại `GENERIC_COMMERCE` = Size / Màu tới khi quản trị chọn ở Hệ thống → Module | `templateKey` của HSLC trên production CHƯA đo | #755 | trong `6487e652` | — | CODE_DONE_NOT_VERIFIED | Đo mẫu ngành HSLC; nếu không phải food thì HSLC chọn «Thực phẩm / hải sản» (thao tác UI) |

### 2.6 Xác nhận đơn · sự thật đơn

| REQ_ID | SURFACE | OWNER_REQUEST | EXPECTED_BEHAVIOR | IMPLEMENTED_BEHAVIOR | GAP | PR | PRODUCTION_SHA | PRODUCTION_EVIDENCE | STATUS | NEXT_ACTION |
|---|---|---|---|---|---|---|---|---|---|---|
| ORD-01 | Đơn | Bot lên đơn đúng | Đơn nháp đúng SKU · SL · SĐT · xã, vào OMS CONFIRMED | Chạy | — | #690 #740 | `a951f77a` | E2E PASS 7/7 bước D (run 37935922309) | PRODUCTION_VERIFIED | — |
| ORD-02 | Đơn | Dữ liệu mơ hồ ⇒ người kiểm | Khách lưỡng lự ⇒ cờ cần kiểm, bot không tự chốt | Chạy | — | #675 #746 | `863aa76a` | E2E PASS 8/8 bước R (run 37984880718) | PRODUCTION_VERIFIED | — |
| ORD-03 | Đơn | Xác nhận tay, không trùng | «Xác nhận đơn» ⇒ CONFIRMED, bấm lần hai không thêm đơn / nhật ký | `confirmOrderReviewCore` | — | #746 | `863aa76a` | E2E PASS 8/8 bước R (run 37984880718; lặp 38035198098) | PRODUCTION_VERIFIED | — |
| ORD-04 | Đơn (trang khách) | Đơn đúng sự thật | Không nói Pancake với khách không dùng Pancake; không «0 ₫» cho tiền không có | #725 #731 | Chưa mở trang bằng tổ chức không Pancake | #725 #731 | trong `6487e652` | — | CODE_DONE_NOT_VERIFIED | Mở `/orders/<id>` workspace thử |
| ORD-05 | Đơn | Đơn phức tạp | Nhiều đơn mở trong một hội thoại · ghi lại sau lỗi · địa chỉ có cấu trúc | Chưa có (thiết kế `docs/saas/ORDER_CANDIDATE.md`, MM-ORDER-03 BACKLOG) | Toàn bộ | — | — | — | NOT_STARTED | Order Candidate C3a → C3c |
| ORD-06 | Đơn | Khách huỷ / xã chưa ghép ⇒ người kiểm + nút nhanh | Nút Xác nhận / Huỷ nhanh | #675 | Vế «khách huỷ» chưa đi trên production | #675 | trong `6487e652` | — | CODE_DONE_NOT_VERIFIED | Thêm kịch bản huỷ vào `saas-acceptance` |

### 2.7 Nhân viên · Gói / mức dùng / thanh toán · Trợ giúp · Connection Doctor · mobile

| REQ_ID | SURFACE | OWNER_REQUEST | EXPECTED_BEHAVIOR | IMPLEMENTED_BEHAVIOR | GAP | PR | PRODUCTION_SHA | PRODUCTION_EVIDENCE | STATUS | NEXT_ACTION |
|---|---|---|---|---|---|---|---|---|---|---|
| STF-01 | Nhân viên | Chỉ vai trò bán hàng hợp lệ | Lời mời chỉ chọn vai trò hệ thống hợp bán hàng | #735 | Chưa mở trang | #735 | trong `6487e652` | — | CODE_DONE_NOT_VERIFIED | Mở `/settings/users` vỏ khách |
| STF-02 | Nhân viên | Nhân viên bán hàng được trả lời | `BAN_HANG` có `ai_sales:reply` | #741 | Chưa xác nhận lượt E2E dùng đúng vai trò này | #741 | trong `6487e652` | — | CODE_DONE_NOT_VERIFIED | E2E với tài khoản BAN_HANG |
| STF-03 | Nhân viên | Bộ vai trò rút gọn (tuỳ chọn) | Chủ shop · Nhân viên bán hàng · Chỉ xem | Chưa có (đổi quyền — AGENTS §7) | Toàn bộ | — | — | — | BLOCKED_OWNER | D10 |
| BIL-01 | Thanh toán | Nạp tiền AI bằng QR | Nạp VietQR, trừ đúng mỗi khách AI | Số dư AI + SePay | — | #644 #674 | `6487e652` | HSLC nạp 500.000 ₫ (08/10), trừ 590 ₫/khách AI (`/platform/ai-balance`) | PRODUCTION_VERIFIED | — |
| BIL-02 | Mức dùng | Đồng hồ khách AI đúng | Mỗi khách AI +1 đúng một đơn vị | Chạy | — | #746 | `863aa76a` | E2E PASS 8/8 bước R (run 37984880718) | PRODUCTION_VERIFIED | — |
| BIL-03 | Mức dùng | Hiểu «còn bao nhiêu» | Gói dùng thử «còn N ngày»; mức dùng / hạn mức dễ đọc | #670 + Số dư AI | Chưa mở trang vỏ khách | #670 | trong `6487e652` | — | CODE_DONE_NOT_VERIFIED | Mở «Gói dịch vụ» workspace thử |
| BIL-04 | Gói | Khách tự gia hạn / đổi gói | Tạo mã QR gia hạn / đổi gói, tiền về thì tự mở | `/settings/plan` có khung «Gia hạn hoặc đổi gói» (hoá đơn QR); cổng tự phục vụ đầy đủ (Phase E) DEFERRED | Tech Lead ghi «khách tự đổi gói chưa có» ⇒ chưa ai đi qua trên production; khung chỉ hiện khi `planPageFrame` cho phép | #655 | trong `6487e652` | — | PARTIAL | Mở `/settings/plan` workspace thử, phân xử khung có hiện không |
| BIL-05 | Thanh toán | Thu phần vượt gói | Hoá đơn vượt gói phát hành + thu QR, không thu hai lần với Số dư AI | Thiết kế (#662) | O2–O5 chờ quyết định | — | — | — | BLOCKED_OWNER | Chủ shop trả lời `OVERAGE.md` Q2–Q10 |
| HLP-01 | Trợ giúp | Chỉ hướng dẫn kênh đang chạy | Không hướng dẫn kênh chưa mở | #712 | Chưa mở trang | #712 | trong `6487e652` | — | CODE_DONE_NOT_VERIFIED | Mở trang Hướng dẫn vỏ khách |
| HLP-02 | Trợ giúp | Trợ giúp theo màn + nhắn hỗ trợ | H1–H5 (`docs/saas/HELP_CENTER.md`) | Thiết kế + #680 sửa link | Không có kênh hỗ trợ ⇒ không làm được «Nhắn hỗ trợ» | #680 | trong `6487e652` | — | BLOCKED_OWNER | D10: chủ shop chọn kênh hỗ trợ |
| DOC-01 | Connection Doctor | «Tin có tới không · AI có trả lời không · vì sao» cho khách | Một màn cho khách | Phía người vận hành có (O1–O8, sức khoẻ khách); phía khách chỉ có chẩn đoán lúc nối Page (#608) | Màn của khách chưa có (MM-INBOX-03 BACKLOG) | — | — | — | NOT_STARTED | Dựng trên dữ liệu `saas-ops-signals` |
| MOB-01 | Mobile | Hộp thư trên điện thoại | Đủ dòng, không cuộn ngang, khung đơn mở được | 390: **11** dòng; khung đơn qua nút | — | #748 #753 | `e21f0ec3` | ảnh 390 (ngoài kho) | PRODUCTION_VERIFIED | — |
| MOB-02 | Mobile | Cấu hình AI trên điện thoại | Không tràn | 382 px | — | #768 | `6487e652` | `ai-settings-after-390x844-fixed` | PRODUCTION_VERIFIED | — |
| MOB-03 | Mobile | Luồng chính dùng được trên điện thoại | Onboarding · Sản phẩm · Nhân viên · Gói ở 390 | Vỏ 390 (SHELL_AUDIT) | `/settings/users` nhiều phần tử nhỏ (Launch Gate C19 🟡); các màn khác chưa chụp | #700 #718 | trong `6487e652` | — | PARTIAL | Chụp 390 khi có `ONB-03` |

---

## 3. ADMIN NỀN TẢNG (`/platform`)

| REQ_ID | SURFACE | OWNER_REQUEST | EXPECTED_BEHAVIOR | IMPLEMENTED_BEHAVIOR | GAP | PR | PRODUCTION_SHA | PRODUCTION_EVIDENCE | STATUS | NEXT_ACTION |
|---|---|---|---|---|---|---|---|---|---|---|
| ADM-01 | Dashboard | Việc hằng ngày lên đầu | Tổ chức & sức khoẻ, công tắc khẩn trước; Webhook Meta xuống cuối | #714 | «9 nút không tên» chưa xác nhận trên DOM; chưa ảnh | #714 | trong `6487e652` | — | CODE_DONE_NOT_VERIFIED | Mở `/platform` + đếm nút không tên |
| ADM-02 | Danh sách khách | «Khách này có chạy không» < 30 giây | Mỗi khách: Messenger · AI · đăng nhập · đơn · hạn mức | Cột sức khoẻ | — | #683 | `6487e652` | Mở `/platform/customers` 10/10 (ngoài kho) | PRODUCTION_VERIFIED | — |
| ADM-03 | Danh sách khách | Nhận ra khách có vấn đề | Lọc theo sức khoẻ, mỗi khách kèm lý do | Nguy cấp 0 · Cần chú ý 7 · Chưa đủ dữ liệu 0 · Khoẻ 1 · Đã dừng 0 | — | #683 #692 | `6487e652` | Launch Gate A10 | PRODUCTION_VERIFIED | — |
| ADM-04 | Chi tiết khách | Thấy trạng thái cấp phát | Chuỗi ACCOUNT → … → TEMPLATE từng bước | Đủ chuỗi, từng bước DONE kèm chi tiết | — | #682 | `6487e652` | Launch Gate A6 | PRODUCTION_VERIFIED | — |
| ADM-05 | Tạo khách | Tạo khách không cần CSDL / script, đúng mặc định | Thương hiệu Chốt Đơn tự đặt, chỉ gói đang bán, cài mẫu AI | `requestProvisioning` (job của form) | Phần nhìn thấy ở `ADM-06` | #682 | `c7183395` | `saas-acceptance --apply` PASS 4/4 bước A (run 37838073371) | PRODUCTION_VERIFIED | — |
| ADM-06 | Tạo khách | Form không khoá im lặng | Ô lý do không chặn nhập; nút không mờ vô cớ | #682 | Chưa ảnh form | #682 | trong `6487e652` | — | CODE_DONE_NOT_VERIFIED | Chụp form trước / sau |
| ADM-07 | Gói / thuê bao | Gán gói, «còn N ngày» | Gói dùng thử của bảng giá đang hiệu lực + ghim giá V1 | Chạy; cột gói «Tiêu chuẩn» / «Dùng thử» | — | #682 | `6487e652` | Launch Gate A4 (run 37838073371) + A9 (mở trang 10/10) | PRODUCTION_VERIFIED | — |
| ADM-08 | Hỗ trợ | Gửi lại kích hoạt | Liên kết dùng một lần, không lộ token | `resendActivation` | — | #681 #684 | `c7183395` | Launch Gate A5 (run 37838073371) | PRODUCTION_VERIFIED | — |
| ADM-09 | Sức khoẻ | Đăng nhập hỏng (O1) | Báo khi khách đăng nhập / kích hoạt hỏng | Tín hiệu O1 | — | #692 #711 | `d23c0deb` | `ops-signals-check` run 37860619173 · 37867472656 | PRODUCTION_VERIFIED | — |
| ADM-10 | Sức khoẻ | Messenger / kênh mất kết nối (A7 · O2) | Thấy cảnh báo khi khách mất kênh | Cột kênh đúng («kết nối cũ · FB 972», «Chưa nối kênh bán») | Chưa có khách thật MẤT kênh để thấy cảnh báo | #683 #692 | `6487e652` | Launch Gate A7 🟡 | CODE_DONE_NOT_VERIFIED | Chờ sự cố thật (MM-FU-724) |
| ADM-11 | Sức khoẻ | Webhook hỏng (O3) | Báo webhook không nhận | Tính được; 8/9 UNKNOWN (nền 14 ngày mỏng) | Chưa chứng minh PHÁT HIỆN | #692 | `c7183395` | `ops-signals-check` PASS 9 × 8 | CODE_DONE_NOT_VERIFIED | Chờ sự cố thật |
| ADM-12 | Sức khoẻ | Thấy sức khoẻ AI (A8) | «AI trả lời N phút trước · Bật · lượt»; 0 lượt không in «khoẻ» | Đúng | — | #683 | `6487e652` | Launch Gate A8 | PRODUCTION_VERIFIED | — |
| ADM-13 | Sức khoẻ | AI im lặng (O4) | Báo AI ngừng trả lời | Tính được: 6 OK · 2 WARNING · 1 UNKNOWN | Cảnh báo chưa kiểm đúng / báo nhầm | #692 | `c7183395` | `ops-signals-check` PASS 9 × 8 | CODE_DONE_NOT_VERIFIED | Đối chiếu 2 WARNING với hội thoại thật |
| ADM-14 | Sức khoẻ | Gửi tin hỏng (O5) | Báo Send API hỏng | Tính được: 8 OK · 1 WARNING | Chưa kiểm đúng / báo nhầm | #692 | `c7183395` | `ops-signals-check` PASS 9 × 8 | CODE_DONE_NOT_VERIFIED | Đối chiếu WARNING |
| ADM-15 | Sự cố đơn | Đơn không hợp lệ (O6) | Báo đơn thiếu liên hệ | Phát hiện `MISSING_CONTACT` | — | #724 | `50293da6`+ | Diễn tập 37892162094 ⇒ tín hiệu 37892240945 | PRODUCTION_VERIFIED | — |
| ADM-16 | Sự cố đơn | Ghi đơn (OMS) hỏng (O7) | Báo ghi đơn lỗi, không ghi nhầm thành «AI lỗi» | Tính được: 9 OK | Chưa chứng minh PHÁT HIỆN | #692 | `c7183395` | `ops-signals-check` PASS 9 × 8 | CODE_DONE_NOT_VERIFIED | Chờ sự cố thật |
| ADM-17 | Mức dùng | Hết hạn mức (O8) · mức dùng từng khách (A9) | Thấy mức dùng; báo khi hết | Cột «khách AI» theo khách; O8 tính được 9 OK | O8 chưa chứng minh PHÁT HIỆN (mức dùng A9 đã PV) | #683 #692 | `6487e652` | Launch Gate A9 + `ops-signals-check` | CODE_DONE_NOT_VERIFIED | Chờ sự cố thật cho O8 |
| ADM-18 | Thanh toán | Doanh thu · chi phí · biên Số dư AI | Bảng trên `/platform`, không thu hai lần | #648 #653 | Chưa mở trang có vết | #648 #653 | trong `6487e652` | — | CODE_DONE_NOT_VERIFIED | Mở `/platform/ai-balance` |
| ADM-19 | Hỗ trợ | Đặt lại mật khẩu thay khách | Người vận hành phát liên kết có lý do + nhật ký | `createResetLinkAsOperator` | Chưa đi qua trên production | — | trong `6487e652` | — | CODE_DONE_NOT_VERIFIED | Một lượt trên workspace thử |
| ADM-20 | Hỗ trợ | Tổ chức cũ thương hiệu NULL rơi vỏ ERP | Người vận hành đặt «Đổi thương hiệu» | Có nút ở `/platform/org/<mã>`; #682 chỉ chữa đường tạo mới | Chưa đo số tổ chức NULL | #682 | trong `6487e652` | — | CODE_DONE_NOT_VERIFIED | Đo (chỉ đọc) rồi chủ shop đặt (MM-REC-01) |
| ADM-21 | Nghiệm thu | Tài khoản người vận hành kiểm thử | Smoke `/platform` tất định | Không có (quyết định quyền) | — | — | — | — | BLOCKED_OWNER | D13 (đề xuất: phiên ký ngắn hạn như `scripts/smoke.ts`) |

### 3.1 Nền tảng chung — bảo mật · pháp lý · vận hành

| REQ_ID | SURFACE | OWNER_REQUEST | EXPECTED_BEHAVIOR | IMPLEMENTED_BEHAVIOR | GAP | PR | PRODUCTION_SHA | PRODUCTION_EVIDENCE | STATUS | NEXT_ACTION |
|---|---|---|---|---|---|---|---|---|---|---|
| SEC-01 | Bảo mật | Cô lập tổ chức | Phiên tổ chức A không mở được dữ liệu tổ chức B | Chặn 4 + 1 hướng ngược | — | #744 | `863aa76a` | `security-acceptance` PASS (run 37984789053) S1 | PRODUCTION_VERIFIED | — |
| SEC-02 | Bảo mật | Bí mật ẩn | 0 mẫu bí mật trên trang vỏ / công khai | 17 trang × 24 mẫu ⇒ 0 trùng | — | #744 | `863aa76a` | run 37984789053 S2 | PRODUCTION_VERIFIED | — |
| SEC-03 | Bảo mật | Token page mã hoá | 0 bản rõ | 14 ô: 13 mã hoá · 1 rỗng · 0 bản rõ | — | #744 | `863aa76a` | run 37984789053 S3 | PRODUCTION_VERIFIED | — |
| SEC-04 | Bảo mật | Không lộ chi phí / nhà cung cấp cho khách | Mọi trang vỏ không có hãng · model · USD · chi phí AI | #669 che replay · học · ai-builder · USD · go-live | Chỉ trang Cấu hình AI Sales đã mở kiểm (`AIS-02`); Launch Gate ghi ✅ chỉ bằng deploy | #669 | trong `6487e652` | — | CODE_DONE_NOT_VERIFIED | Thêm mẫu «hãng / model / USD» vào quét S2 |
| LEG-01 | Pháp lý | Tuân thủ pháp luật VN trước khi thu tiền | L2 sổ chấp thuận văn bản; luật sư trả lời G-1…G-11; Chính sách / Điều khoản được rà | L1 sổ (#697); gói câu hỏi (#704) | Chờ luật sư (WAITING_FOR_LEGAL_COUNSEL); LEGAL ~23 % | #691 #697 #704 | — | `docs/legal/LEGAL_LAUNCH_GATE.md` | BLOCKED_EXTERNAL | Chủ shop gửi `COUNSEL_PACK.md` cho luật sư |
| OPS-01 | Vận hành | Sao lưu ngoài máy đủ | CSDL nhà + tổ chức lên Drive | 7 CSDL tổ chức OK; CSDL nhà HỎNG vì Drive đầy ~9,9 GB tệp riêng | Dung lượng | #689 | — | Lượt sao lưu 23:04 (Launch Gate §8) | BLOCKED_OWNER | D1: dọn Drive / mua dung lượng / tài khoản riêng |

---

## 4. CÔNG KHAI

| REQ_ID | SURFACE | OWNER_REQUEST | EXPECTED_BEHAVIOR | IMPLEMENTED_BEHAVIOR | GAP | PR | PRODUCTION_SHA | PRODUCTION_EVIDENCE | STATUS | NEXT_ACTION |
|---|---|---|---|---|---|---|---|---|---|---|
| PUB-01 | Landing | Nói đúng sản phẩm | Pancake là lựa chọn, nối thẳng «sắp mở», không claim tuyệt đối, không «Chi phí AI hiện rõ» | #706 | Chưa đối chiếu ảnh 1366 + 390 | #706 | trong `6487e652` | — | CODE_DONE_NOT_VERIFIED | Chụp `chotdontudong.com` 1366 + 390 |
| PUB-02 | Landing | Một CTA rõ | CTA «Dùng thử» trỏ `/start` theo chế độ đăng ký | CTA → `/start`; chủ shop 09/10 GIỮ đăng ký mở ⇒ CTA đúng | Chưa mở trang | #706 | trong `6487e652` | — | CODE_DONE_NOT_VERIFIED | Cùng lượt chụp `PUB-01` |
| PUB-03 | Bảng giá | Giá V1 rõ, số ngày dùng thử đúng | `/pricing` in gói V1 + đúng số ngày dùng thử của gói | `app/pricing/page.tsx` đọc `trialDays` từ gói | Tài liệu cũ ghi 14 ngày (D17 / MM-LEGAL-06); chưa mở trang | #627 | trong `6487e652` | — | CODE_DONE_NOT_VERIFIED | Mở `/pricing`; sửa tài liệu theo mã |
| PUB-04 | Đăng ký | Tự đăng ký có dùng thử ngay | `/start` tạo tổ chức + thuê bao dùng thử | #670 | Chưa đi qua `/start` trên production | #670 | trong `6487e652` | — | CODE_DONE_NOT_VERIFIED | Một lượt `/start` rồi xoá bằng ops có chạy thử |
| PUB-05 | Đăng nhập | Email + mật khẩu, không cần mã tổ chức | Ra đúng workspace; sai mật khẩu bị từ chối | Chạy | — | #681 | `c7183395` | `saas-acceptance --apply` PASS 4/4 bước B1 (run 37838073371) | PRODUCTION_VERIFIED | — |
| PUB-06 | Đăng nhập / đăng ký | Không trang trắng, đúng thương hiệu | `/login` sau đặt mật khẩu mang thương hiệu Chốt Đơn | #671 #700 #743 | Chưa ảnh 3 màn ở 390 | #671 #700 | trong `6487e652` | — | CODE_DONE_NOT_VERIFIED | Chụp 3 màn 390 |
| PUB-07 | Quên mật khẩu | Khách tự lấy lại mật khẩu | Link «Quên mật khẩu» ở `/login` ⇒ thư / liên kết dùng một lần | Không có; chỉ quản trị tổ chức (`users:manage`) hoặc người vận hành phát liên kết | Toàn bộ phần tự phục vụ | — | — | — | NOT_STARTED | Thiết kế (gửi thư cần dịch vụ ngoài ⇒ hỏi chủ shop, AGENTS §7) |
| PUB-08 | Kích hoạt | Đặt mật khẩu qua liên kết | Liên kết `/reset` dùng một lần | Chạy | — | #681 | `c7183395` | Launch Gate C1 (run 37838073371) | PRODUCTION_VERIFIED | — |
| PUB-09 | Pháp lý công khai | Chính sách / Điều khoản đúng | Không chữ kỹ thuật, luật sư đã rà | Trang có (`/chinh-sach-bao-mat`, `/dieu-khoan-su-dung`) | Chờ luật sư (D22) | #691 | — | — | BLOCKED_EXTERNAL | Cùng `LEG-01` |

---

## 5. ERP LƯU LƯỢNG CAO

Mọi ảnh trước / sau của lô ERP-UX (#754–#767) nằm ở `docs/product/evidence/erp-ux*/` và đều ghi rõ **«Chưa phải ảnh production»**
(CSDL demo cục bộ 1.126 đơn). Lô đã có trong production `6487e652` (Launch Gate nhật ký 10/10 chiều) ⇒ tối đa CODE_DONE_NOT_VERIFIED.

| REQ_ID | SURFACE | OWNER_REQUEST | EXPECTED_BEHAVIOR | IMPLEMENTED_BEHAVIOR | GAP | PR | PRODUCTION_SHA | PRODUCTION_EVIDENCE | STATUS | NEXT_ACTION |
|---|---|---|---|---|---|---|---|---|---|---|
| ERP-01 | Hôm nay | Hôm nay = chỗ làm việc | Dải «Việc cần làm ngay» bấm mở đúng danh sách đã lọc | #758 | Ảnh cục bộ | #758 | trong `6487e652` | — | CODE_DONE_NOT_VERIFIED | Chụp production 1366/1440/390 |
| ERP-02 | Điều hướng | Tìm / tạo nhanh | Mục chính theo vai trò · ô lệnh hiểu ý · «+ Tạo mới» · bộ lọc ≤ 4 + ngăn kéo | #754 | Ảnh cục bộ | #754 | trong `6487e652` | — | CODE_DONE_NOT_VERIFIED | Chụp production |
| ERP-03 | Đơn | Số thật, không bộ đếm Pancake | Danh sách / bộ lọc / khối Khách ở trang đơn theo `ORDER_OUTCOME` | #722 #731 | Chưa mở | #722 #731 | trong `6487e652` | — | CODE_DONE_NOT_VERIFIED | Mở `/orders` |
| ERP-04 | Đơn | Chi tiết đơn đọc được | Khách · tiền · hàng đang ở đâu · việc tiếp; không tràn 390 | #759 | Ảnh cục bộ | #759 | trong `6487e652` | — | CODE_DONE_NOT_VERIFIED | Chụp `/orders/<id>` |
| ERP-05 | Đơn | Đơn trên điện thoại | Dạng thẻ ở 390 | #754 | Ảnh cục bộ | #754 | trong `6487e652` | — | CODE_DONE_NOT_VERIFIED | Chụp 390 |
| ERP-06 | Khách | Giao thành công theo ĐVVC | Không lấy bộ đếm Pancake làm GTC | #715 #722 | Chưa mở | #715 #722 | trong `6487e652` | — | CODE_DONE_NOT_VERIFIED | Mở `/customers/<id>` |
| ERP-07 | Khách | Danh sách khách gọn | Ba số một dải; thẻ ở 390 | #760 | Ảnh cục bộ | #760 | trong `6487e652` | — | CODE_DONE_NOT_VERIFIED | Chụp production |
| ERP-08 | Giao vận | COD 0 không điền sai | Sửa đơn VTP không điền sẵn COD; đổi tiền thu hộ phải xác nhận | #717 | Chưa mở `/shipments/<id>` vận đơn COD 0 | #717 | trong `6487e652` | — | CODE_DONE_NOT_VERIFIED | Mở một vận đơn COD 0 |
| ERP-09 | Giao vận | Hàng đợi đọc lướt | Dải bốn số; tab một hàng ở 390; «Cần cấp trên» | #761 | Ảnh cục bộ | #761 | trong `6487e652` | — | CODE_DONE_NOT_VERIFIED | Chụp production |
| ERP-10 | Kho | Bảng phiếu kho lên màn đầu | Bốn thẻ thành dải; hướng dẫn lần đầu gập | #762 | Ảnh cục bộ | #762 | trong `6487e652` | — | CODE_DONE_NOT_VERIFIED | Chụp production |
| ERP-11 | Marketing | Trang quảng cáo nói rõ mục đích | Nhãn đúng nhóm Marketing | #765 | Ảnh cục bộ | #765 | trong `6487e652` | — | CODE_DONE_NOT_VERIFIED | Chụp production |
| ERP-12 | Marketing | Ước tính ≠ số đo | Tỷ lệ GTC ước tính đứng cạnh số đo, có nhãn + độ phủ | #166 | Chưa mở | #166 | trong `6487e652` | — | CODE_DONE_NOT_VERIFIED | Mở `/ads/daily` |
| ERP-13 | Tài chính | Tổng quan tài chính rõ mục đích | Không thẻ lồng thẻ | #764 | Ảnh cục bộ | #764 | trong `6487e652` | — | CODE_DONE_NOT_VERIFIED | Chụp production |
| ERP-14 | Lương | Không lộ dữ liệu nhân viên ở gợi ý; dùng được 390 | Gợi ý Lương không in tên + tỷ lệ hoa hồng thật; `/payroll` không tràn | #764 #708 | Ảnh cục bộ | #708 #764 | trong `6487e652` | — | CODE_DONE_NOT_VERIFIED | Chụp production 390 |
| ERP-15 | Toàn ERP · điện thoại | Thẻ chỉ số gọn | Đệm 16 px, số nhỏ một bậc trên mọi `MetricCard` | #763 | Ảnh cục bộ | #763 | trong `6487e652` | — | CODE_DONE_NOT_VERIFIED | Chụp production |
| ERP-16 | Toàn ERP | Chi tiết không mã thô; quay lại giữ bộ lọc | Dòng vị trí tiếng Việt; nút quay lại giữ lọc | #767 | Ảnh cục bộ | #767 | trong `6487e652` | — | CODE_DONE_NOT_VERIFIED | Chụp production |
| ERP-17 | /work | /work nhanh | Về lại 1,0–1,4 s | #734 sửa gốc (3,1–4,7 s từ `ef9b302a`); #738 giữ ấm | Chưa đo lại bằng trình duyệt | #734 #738 | trong `6487e652` | — | CODE_DONE_NOT_VERIFIED | Đo median 3–5 lượt |
| ERP-18 | Trang chậm | Trang không chậm (C1 #13) | `/chatbot` · `/chatbot/ad-bots` · `/cod` · `/reports/returns` · `/reports/target` có số production | Hộp thư đã đo (`INB-21`); năm trang kia chỉ có số CỤC BỘ (4,6 · 4,5 · 3,7 · 2,6 · 2,6 s) | Chưa đo production 5 trang | #733 | — | — | PARTIAL | Đo production rồi mới sửa (MM-REC-22) |

---

## 6. BOT CỦA KHÁCH THƯƠNG MẠI ĐẦU TIÊN (HSLC)

| REQ_ID | SURFACE | OWNER_REQUEST | EXPECTED_BEHAVIOR | IMPLEMENTED_BEHAVIOR | GAP | PR | PRODUCTION_SHA | PRODUCTION_EVIDENCE | STATUS | NEXT_ACTION |
|---|---|---|---|---|---|---|---|---|---|---|
| HSL-01 | Bot HSLC | Bot không sót tin | Pancake 429 ⇒ thử lại, không rơi tin | #770 thử lại khi 429 | — | #770 | `6487e652` | Tin rơi vì 429: **22 % (95/431) → 0/97** (ops org-order-audit 38030845978 · 38033540896) | PRODUCTION_VERIFIED | Theo dõi tuần đầu |
| HSL-02 | Bot HSLC | Không gọi khách mới là «khách cũ» | Chỉ khách có lịch sử thật mới là khách cũ | #770 | Chưa có số đo riêng | #770 | `6487e652` | — | CODE_DONE_NOT_VERIFIED | Đối chiếu một khách mới trên HSLC |
| HSL-03 | Bot HSLC | Báo đúng tiền khi khách «lấy 2kg» | Danh mục có gói 2kg ⇒ không nhân đôi | #771 | Chưa lên production | #771 | — (đang deploy `3e853bd4`) | — | CODE_DONE_NOT_VERIFIED | Sau deploy: một hội thoại 2kg thật |
| HSL-04 | Bot HSLC | Giá gói rẻ hơn khi mua nhiều | «N kg = N × SKU 1kg − 20.000 ₫ từ 2kg» | Chưa trên `main` (nhánh `claude/hslc-goi-re-hon`, phiên khác) | Toàn bộ | — | — | — | NOT_STARTED | Phiên đang cầm mở PR |
| HSL-05 | Bot HSLC | 0,5kg chỉ bán kèm; mời thêm bằng câu upsell + ảnh menu | Báo giá từ quy cách chính; chỉ thêm 0,5kg khi đã có món chính | #701 #720 | MM-REC-39 chưa hậu kiểm riêng | #701 #720 | trong `6487e652` | — | CODE_DONE_NOT_VERIFIED | Một hội thoại thật có món chính + 0,5kg |
| HSL-06 | Bot HSLC · tiền | Số dư AI là «tín dụng dịch vụ» hợp lệ | Kế toán / luật sư duyệt cách ghi nhận | HSLC đang dùng thật | Văn bản luật sư (G-7) | #644 | — | — | BLOCKED_EXTERNAL | Cùng `LEG-01` |

---

## 7. TOP 10 KHOẢNG TRỐNG THƯƠNG MẠI CÒN LẠI

Xếp theo ảnh hưởng tới **thời gian tới khách trả tiền đầu tiên** (Time to First Paying Customer). Một dòng mỗi mục.

1. `CHN-01` — Khách ngoài chưa tự nối được Page: Meta chưa cấp quyền Page; chủ shop thêm use case Messenger (BLOCKED_EXTERNAL).
2. `LEG-01` · `PUB-09` · `HSL-06` — Chưa thu tiền hợp pháp được: luật sư chưa trả lời gói câu hỏi, Chính sách / Điều khoản chưa rà.
3. `INB-01` · `INB-04` · `INB-09` — Hộp thư (công cụ dùng hằng ngày) sai nghĩa «Chưa đọc» / «Cần người» và bộ lọc chưa có ma trận kiểm.
4. `INB-18` — Chưa có «Trả tất cả cho AI»: sau giờ làm, nhân viên phải trả từng hội thoại, bot đứng im với phần còn lại.
5. `ONB-03` (kéo theo `ONB-01` · `PRD-03` · `MOB-03`) — Không ai xem được vỏ khách bằng mắt: onboarding 9 bước và danh sách sản phẩm gọn chưa có ảnh production.
6. `BIL-04` · `BIL-05` — Đường khách TỰ trả tiền chưa ai đi qua trên production; hoá đơn phần vượt gói chờ quyết định Q2–Q10.
7. `PUB-07` — Không có «Quên mật khẩu»: khách quên là phải nhờ người vận hành, đúng ngày đầu dùng thử.
8. `INB-15` · `INB-17` — Ảnh khách vẫn là chữ cái, bấm không mở Facebook: hộp thư trông kém Pancake ngay buổi demo đầu.
9. `AIS-05` — Chưa có ô FAQ / chính sách / khuyến mãi có cấu trúc: khách mới phải nhồi mọi thứ vào lời nhắc tự do.
10. `IND-03` · `IND-04` — Shop thực phẩm vẫn gặp «Màu \ Size» ngoài trang sản phẩm; HSLC có tự nhận hồ sơ thực phẩm hay không chưa đo.

---

## 8. Cập nhật sổ (luật K)

- Mỗi lượt gộp: dòng liên quan ⇒ `CODE_DONE_NOT_VERIFIED`, ghi PR.
- Mỗi lượt deploy + kiểm production: ghi SHA + vết (run / tên ảnh ngoài kho) ⇒ `PRODUCTION_VERIFIED`.
- Chủ shop báo sai trên production ⇒ hạ ngay về `PARTIAL`, thêm mã vào §1.1 nếu sổ cũ ghi cao hơn.
- Đếm lại §1 bằng cách đếm cột STATUS của mọi bảng §2–§6 (không tự chấm).

| Lúc | Thay đổi |
|---|---|
| 10/10/2026 chiều | Lập sổ: 127 yêu cầu nguyên tử · 0 DONE · 38 PRODUCTION_VERIFIED · 10 PARTIAL · 60 CODE_DONE_NOT_VERIFIED · 9 NOT_STARTED · 6 BLOCKED_OWNER · 4 BLOCKED_EXTERNAL; 9 dòng sổ cũ ghi cao hơn sự thật (§1.1). Đối chiếu `origin/main` `3e853bd4`, production `6487e652`. |
