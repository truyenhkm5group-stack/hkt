# Vận hành khách pilot — nhận khách, theo dõi sức khoẻ, công tắc khẩn

> Dành cho **người vận hành nền tảng** (tài khoản của tổ chức nhà có quyền `platform:operate`). Mọi việc dưới đây làm
> trên giao diện, **không SQL, không deploy**. Mã: `lib/constants/pilot.ts` (luật), `lib/platform/pilot.ts` (vòng đời),
> `lib/platform/support.ts` (sức khoẻ), `lib/platform/kill-switches.ts` (công tắc), trang `/platform` và
> `/platform/org/<mã>`. Bài kiểm: `tests/pilot-ops.test.ts`.
>
> **Không tạo tổ chức thứ hai trên production** khi chủ nền tảng chưa quyết (AGENTS.md mục 7). `/start` công khai
> vẫn TẮT — người vận hành tạo hộ được bất kể chế độ.

## 1. Quy trình nhận một khách pilot (từng bước)

1. **Tạo tổ chức hộ khách.** `/platform` → khung «Tự phục vụ» → **Tạo tổ chức cho khách** → đi luồng `/start` (tên, mã,
   quản trị đầu tiên, loại hình, mẫu, module, xem trước) → Tạo. Phiên của bạn không đổi.
   Tổ chức mới vào giai đoạn **Vừa tạo**, cài mẫu xong tự sang **Đang cấu hình** (hai bước này do máy ghi, có nhật ký).
2. **Gửi thông tin đăng nhập cho quản trị của khách** (mã tổ chức + email + mật khẩu đã đặt) qua kênh riêng.
3. **Cấu hình cùng khách** (khách tự làm trong ERP của họ, hoặc bạn hướng dẫn): mời người dùng, xem lại module,
   xuất bản trang, bật luật tự động nếu có, khai + kiểm kết nối mà mẫu gợi ý.
4. **Theo dõi danh sách kiểm** ở `/platform/org/<mã>` → khung «Vòng đời pilot». Khi mọi mục của «Sẵn sàng UAT» đạt ⇒
   bấm **Chuyển sang «Sẵn sàng UAT»**.
5. **Khách chạy nghiệm thu (UAT)** trên dữ liệu thật của họ. Xong ⇒ bạn bấm **Xác nhận UAT** kèm ghi chú (ai thử, thử gì).
6. **Đợi bản sao lưu đêm đầu tiên** của CSDL tổ chức (lịch đêm 02–05 giờ). Khi có ⇒ bấm **Chuyển sang «Đang dùng thật»**.
7. Từ đó, mở `/platform/org/<mã>` khi khách báo lỗi hoặc định kỳ; mọi lượt mở đều được ghi vết (mục 5).

## 2. Giai đoạn và danh sách kiểm

Cột `platform_organizations.pilot_stage` — **tách khỏi `status`**: `status` nói "có được chạy không" (SUSPENDED là công
tắc khẩn), giai đoạn nói "khách đang ở bước nào". Đình chỉ không đổi giai đoạn; đổi giai đoạn không bật / tắt gì.
Tổ chức nhà và tổ chức có từ trước bản này: `NULL` (không theo dõi) — không đoán ngược.

| Giai đoạn | Nghĩa | Để VÀO giai đoạn này cần |
|---|---|---|
| **Vừa tạo** (`CREATED`) | Có dòng tổ chức + CSDL, mẫu chưa cài xong | — |
| **Đang cấu hình** (`CONFIGURING`) | Mẫu đã cài, có quản trị | Mẫu đã cài · ≥ 1 quản trị đang hoạt động |
| **Sẵn sàng UAT** (`READY_FOR_UAT`) | Đủ cấu hình để khách nghiệm thu | + đã chọn module nghiệp vụ · ≥ 2 người dùng đang hoạt động · kết nối mẫu gợi ý đã khai + kiểm đạt (nếu mẫu gợi ý) · có trang đã xuất bản · luật đã bật (nếu có luật) |
| **Đang dùng thật** (`ACTIVE`) | Đã nghiệm thu, đã có bản sao lưu | + bản sao lưu đêm đầu tiên của CSDL tổ chức · UAT đã xác nhận |

Mọi mục (trừ «UAT đã xác nhận») **tính từ dữ liệu thật** mỗi lần mở trang: đếm trong CSDL của tổ chức, cấu hình module
ở control plane, tệp trạng thái sao lưu của đúng CSDL tổ chức. Mỗi mục có bốn kết quả: **Đạt** · **Chưa đạt** ·
**Không áp dụng** (mẫu không gợi ý kết nối / chưa có luật nào) · **Chưa đo được** (không mở được CSDL, máy chưa mount thư
mục sao lưu…). *Chưa đo được = chưa đạt* — không kết luận được thì không cho qua cổng.

**Luật chuyển:**

- Chỉ **tiến một bậc** mỗi lần. Nhảy bậc bị từ chối, kể cả khi ghi đè.
- Tiến mà danh sách kiểm chưa đạt ⇒ bị từ chối, trừ khi tích **Ghi đè** và ghi lý do **≥ 10 ký tự**. Nhật ký nền tảng
  ghi danh sách kiểm lúc bấm và đúng những mục đã bị vượt.
- **Lùi** bậc luôn được, cần lý do ≥ 5 ký tự. Lùi về dưới «Sẵn sàng UAT» thì xác nhận UAT cũ bị xoá (cấu hình sắp đổi).
- Hai người bấm cùng lúc: một người thắng, người kia nhận "giai đoạn vừa được người khác đổi".
- Mọi lượt đổi: `platform_audit_log` hành động `PILOT_STAGE` / `PILOT_UAT` (ai, trước → sau, lý do).

## 3. Công tắc khẩn — khi nào dùng, hệ quả

Ở `/platform/org/<mã>` → khung **Công tắc khẩn** (từng tổ chức) và `/platform` → **Công tắc khẩn — toàn nền tảng**
(tổng hợp + đăng ký công khai). Mỗi nút: ô lý do (≥ 5 ký tự) → hộp xác nhận in nguyên văn hệ quả → ghi nhật ký nền tảng.
Có hiệu lực ngay ở máy chủ nhận lượt bấm; tiến trình khác trễ tối đa 10 giây (sổ tổ chức) / 5 giây (cờ luật).

| Công tắc | Dùng khi | Hệ quả | Bật lại |
|---|---|---|---|
| **Đình chỉ tổ chức** (`status` → SUSPENDED) | Nghi lộ tài khoản, khách vi phạm, cần dừng mọi thứ để điều tra | Phiên đang mở bị chặn ở lượt bấm kế tiếp; không ai đăng nhập được; job của tổ chức trả SKIPPED `ORG_INACTIVE`; lịch fan-out bỏ tổ chức; mọi việc nền / webhook đi qua `withOrganization` bị từ chối. **Không xoá / đổi dữ liệu nào.** Tổ chức nhà không đình chỉ được từ đây. | Cùng nút («Bật lại tổ chức…») |
| **Tạm dừng mọi luật tự động** (cờ `workflows.paused`) | Một luật chạy lặp / gửi tin sai / làm hỏng dữ liệu và khách chưa kịp sửa | Bộ máy luật bỏ qua tổ chức: không xét sự kiện mới, không thực thi lượt nào (kể cả lượt đã duyệt); con trỏ đứng yên; **lượt chờ duyệt giữ nguyên**; luật của khách không bị sửa; ERP vẫn dùng bình thường. Nút «Chạy lượt kiểm tra ngay» của tổ chức báo đang tạm dừng. | «Cho luật chạy lại…» — lượt kế tiếp xét tiếp từ chỗ dừng, mỗi sự kiện vẫn đúng một lượt chạy (không nhân đôi) |
| **Tắt một kết nối** | Kết nối lỗi liên tục, nghi lộ khoá, gửi tin nhầm chỗ | Kết nối về TẮT qua sổ kết nối của tổ chức (không ghi thẳng bảng); nhật ký của CHÍNH tổ chức ghi "vận hành nền tảng" + lý do. Chỉ làm được khi tổ chức đang chạy. | Quản trị của tổ chức bật lại ở trang Kết nối dữ liệu, **sau một lần Kiểm tra ĐẠT** — người vận hành không bật hộ |
| **Tắt AI** (`settings.ai.disabled`) | Tiền AI tăng bất thường, nghi lộ khoá BYOK | AI Builder của tổ chức từ chối TRƯỚC khi gọi model (hiệu lực ngay ở máy chủ này, tiến trình khác trễ tối đa thời gian đệm công tắc); ERP vẫn dùng bình thường. Nút ở khung «Dùng AI» (`#ai-usage`) cùng trang — lý do + xác nhận + nhật ký `AI_ORG_CONTROL_SET` | Cùng chỗ |
| **Đăng ký công khai `/start`** | Nghi lạm dụng đăng ký | Cổng B ở `/platform` (`launch-gates.md` mục B): «TẮT» ⇒ `/start` đóng ngay; tắt cứng bằng `PLATFORM_SIGNUP_MODE=off` | Cổng B |

## 4. Trang sức khoẻ `/platform/org/<mã>`

Mở từ `/platform` → cột cuối **Sức khoẻ & công tắc**. Cột **Pilot · dùng** ở `/platform` tóm tắt giai đoạn, cờ luật
tạm dừng, số người dùng đang hoạt động và lần đăng nhập cuối (không ghi vết — chỉ là số đếm).

| Ô | Đọc từ |
|---|---|
| Trạng thái · giai đoạn | `platform_organizations.status` / `.pilot_stage` |
| Gói · hạn mức · mức dùng · module | chẩn đoán H4 (`getPlanUsage`, cấu hình module) |
| Người dùng · đăng nhập cuối | `users` của tổ chức: đếm đang hoạt động / tổng / quản trị, `max(last_login_at)` |
| Dung lượng | `pg_database_size` của CSDL tổ chức + tổng `custom_files.size` |
| Dùng AI | Lượt hôm nay / tháng · tiền ước tính (chưa định giá được ⇒ «chưa rõ») · lượt bị hạn mức chặn — sổ `platform_ai_usage` |
| Luật 7 ngày | `workflow_runs` FAILED trong 7 ngày · lượt treo (`lib/workflow/stale.ts`) · lượt chờ duyệt |
| Kết nối | `org_connections`: bật / tắt / nháp, số lần kiểm hỏng, lần kiểm cuối (không bí mật, không cấu hình) |
| Hoạt động cuối | mốc + LOẠI của dòng `audit_logs` và `domain_events` mới nhất |
| Sao lưu cuối | tệp trạng thái của đúng CSDL tổ chức (`backupTargetFor`) |
| Lỗi 7 ngày | `sync_runs` FAILED 7 ngày + lỗi khối trang của tiến trình này |

**Không dữ liệu nghiệp vụ của khách:** chỉ số đếm, dung lượng, mốc thời gian và loại. Không tên khách, không số đơn,
không số tiền, không giá trị field, không email, không câu lỗi thô. Bài kiểm gieo tên khách / số tiền đơn / giá trị field /
payload sự kiện rồi quét toàn bộ kết quả trang.

**Hỗ trợ có vết:** MỖI lượt mở trang ghi một dòng `SUPPORT_VIEW` vào `platform_audit_log` (ai, tổ chức nào, lúc nào)
**trước** khi đọc CSDL của khách. Không ghi được vết ⇒ trang không mở. Người không phải người vận hành (kể cả quản trị của
tổ chức khác có khoá `platform:operate`) bị từ chối mà không một câu nào chạm CSDL của khách.

## 5. AI trên trang sức khoẻ (nối với sổ hạn mức AI — docs/platform/ai-usage.md)

- Ô «Dùng AI» (`lib/platform/support.ts::aiUsageOf`) đọc `loadOrgAiUsage` của sổ `platform_ai_usage` (mặt phẳng điều
  khiển): số lượt hôm nay / tháng, tiền ƯỚC TÍNH của các lượt đã định giá, số lượt chưa rõ giá, số lượt bị hạn mức chặn.
  Chưa lượt nào định giá được ⇒ tiền in «chưa rõ», không phải 0. Không prompt, không khoá.
- Công tắc tắt AI của MỘT tổ chức và ghi đè hạn mức: khung «Dùng AI» (`#ai-usage`) cùng trang — mục 4 của «Công tắc
  khẩn» chỉ in trạng thái và trỏ tới đó, không có nút thứ hai (hai nút cho một công tắc là hai đường ghi).
- Công tắc AI Builder toàn nền tảng: cổng D ở `/platform#ai-usage`; khung «Công tắc khẩn» của `/platform` chỉ in trạng thái.
