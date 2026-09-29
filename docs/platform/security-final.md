# Bảo mật cuối — tấn công cô lập tổ chức trên main sau Phase 11 (28/09/2026)

Tệp này ghi lượt rà cuối trước khi bán: bộ tấn công `tests/tenant-attack.test.ts` và bộ quét tĩnh
`tests/platform-isolation-static.test.ts` chạy lại trên main (`7494ad1c`), rồi mở rộng cho những mặt ra đời SAU Phase 11
(trang Duyệt lõi `/approvals` — PR #366, sao lưu theo tổ chức — PR #365) và những mặt Phase 11 chưa phủ (AI Copilot,
thao túng metadata, xuất gói cấu hình, thẻ sao lưu). Không bài thứ hai: mọi mặt mới nằm trong đúng hai bài có sẵn, chạy
trong `npm test`. Lượt chạy lại cho pilot readiness (29/09/2026 — sổ dùng AI, vận hành pilot, công tắc khẩn, trang sức
khoẻ, đơn / sản phẩm tay; 243 mặt + S21) nằm ở mục cuối tệp.

## Cách đo

- Hai tổ chức THẬT `ta-a` / `ta-b`, mỗi tổ chức một CSDL PGlite. B dựng qua `/start` bằng mã mời và có đủ mọi loại dữ liệu
  (field + tệp, đối tượng tuỳ biến, form, trang, luật + lời duyệt đang chờ, blueprint đã cài, nháp AI, kết nối có bí
  mật, logo, và một dòng `ai_interactions` cũ ghi trước bản vá Copilot). Mọi chữ của B mang dấu `TABIMAT7Q`.
- Tổ chức NHÀ được gieo riêng một khách và một bộ lời khai sao lưu mang dấu `TANHAMAT4K` (dọn ở `finally`).
- Người quản trị của A dùng PHIÊN THẬT (JWT ký bằng bí mật của ứng dụng) gọi thẳng server action / page component / route
  handler / dịch vụ bằng id, khoá, slug của B. Mỗi lượt phải bị từ chối, hoặc — với cửa không nhận đích — chỉ chạm A.
- Sau cùng: 0 kết quả mang dấu của B, 0 request mạng, ảnh chụp CSDL của B (số dòng + băm nội dung của 186 bảng) và
  5 nhóm dòng mặt phẳng điều khiển của B TRƯỚC = SAU. Nhóm «Thao túng metadata» thêm một ảnh chụp CSDL của A: mọi lượt
  bị từ chối không ghi một dòng nào.

## Kết quả chạy lại trên main trước khi mở rộng

| Bài | Kết quả |
|---|---|
| `testTenantAttack` | ĐẠT — 112 mặt, CSDL B y nguyên, 0 request mạng |
| `testPlatformIsolationStatic` (S1–S20, gồm S18b · S19 · S20) | ĐẠT — 460 server action hỏi phiên trước lượt đọc/ghi đầu tiên, không action nào chọn CSDL theo mã tổ chức của client |

## Bảng mặt tấn công (sau mở rộng: 176 mặt, tất cả ĐẠT)

| Nhóm | Cũ | Mới | Tổng | Kết quả |
|---|---:|---:|---:|---|
| Đệm · Đệm năng lực | 2 | 0 | 2 | chỉ chạm A |
| Field & giá trị | 11 | 0 | 11 | từ chối |
| Tệp tuỳ biến (tệp field, tệp bản ghi, id logo, `openCustomFile`, **xuất gói cấu hình**) | 4 | 1 | 5 | 404 / từ chối; gói xuất của A không chứa khoá nào của B |
| Đối tượng & bản ghi | 15 | 0 | 15 | từ chối / chỉ bản ghi của A |
| Trang động + trình dựng | 24 | 0 | 24 | từ chối |
| Luật & duyệt | 9 | 0 | 9 | từ chối |
| **Duyệt lõi `/approvals`** — page component, khối Duyệt đứng riêng, danh sách chờ duyệt, sổ yêu cầu kể cả đã quyết, duyệt / từ chối lời duyệt của B bằng id | 0 | 6 | 6 | «Không tìm thấy yêu cầu»; danh sách của A không có id của B |
| Blueprint (mẫu ngành) | 3 | 0 | 3 | từ chối / chỉ A |
| AI Builder (+ màn AI Builder không liệt kê nháp của B; prompt quét theo 14 khoá của B và dấu của nhà) | 6 | 1 | 7 | từ chối / chỉ A |
| **AI Copilot** — xem mục riêng dưới đây | 0 | 13 | 13 | tắt ở cổng tổ chức, 0 dòng `ai_interactions`; công cụ chỉ đọc CSDL của A |
| Kết nối & bí mật (+ bản mã của B chép NGUYÊN VĂN — dòng mang mã tổ chức B: đọc khoá, `getBuilderAi`, soạn nháp AI) | 11 | 3 | 14 | «mang mã tổ chức khác ngữ cảnh — không dùng» trước khi giải mã |
| Thương hiệu & tự phục vụ | 19 | 0 | 19 | từ chối |
| **Thao túng metadata** — xem mục riêng dưới đây | 0 | 35 | 35 | từ chối ở máy chủ, CSDL A không đổi |
| **Sao lưu** — `getBackupHealth()` và thẻ «Sao lưu dữ liệu» của A | 0 | 2 | 2 | chỉ CSDL của A, «chưa có bản sao»; không lời khai / tổng hợp của nhà, không dòng của B |
| Phiên giả (+ `/approvals` rồi duyệt, xác nhận hành động Copilot của B, tải gói cấu hình) | 8 | 3 | 11 | về `/login` / 401 |
| **Tổng** | **112** | **64** | **176** | **176/176 ĐẠT** |

### AI Copilot (13 mặt)

Copilot gọi model bằng khoá AI trong biến môi trường — khoá của NHÀ. Sau bản vá ở mục «Lỗ tìm thấy», tổ chức khác nhà
TẮT ngay ở cổng tổ chức (`copilotOrgDenial`, dùng chung cho `copilotStatus`, `runCopilot`, `confirmCopilotActions`):

1. **Cổng.** Môi trường có khoá Anthropic của nhà: `copilotStatus` của A ⇒ `enabled: false`, `scope: ORGANIZATION`, lý do
   «AI Copilot chưa được mở cho tổ chức này»; hỏi bằng model thật và hỏi khi có model (giả) được tiêm sẵn ⇒ `DISABLED` /
   `AI_NOT_AVAILABLE_FOR_ORG`, model được gọi 0 lần; xác nhận hành động của lượt hỏi (cũ) của B ⇒ từ chối; `getBuilderAi`
   của A ⇒ «Tổ chức chưa có kết nối AI đang bật», KHÔNG rơi về khoá nhà. Số dòng `ai_interactions` của A trước = sau;
   phía B, `runCopilot` với model giả cũng tắt và không ghi dòng nào.
2. **Lớp thứ hai — công cụ gọi thẳng trong phiên A** (phòng khi cổng hỏng): `search_customer` theo đoạn tên khách của B /
   của nhà ⇒ 0 kết quả; `get_customer_history` với id khách của B / của nhà ⇒ «Không tìm thấy khách»; `get_owner_brief`
   không mang dấu nào; `get_care_case` (Giao vận) và `get_profit_summary` (Tài chính) ⇒ `MODULE_DISABLED` trước khi chạy.
   Đối chứng: tìm theo đoạn tên khách CỦA A thấy đúng `ta-a-cus1`.
3. **Tổ chức nhà không đổi**: cổng mở (`copilotOrgDenial() = null`), câu hỏi tới model và trả `OK`; `tests/ai-copilot.test.ts`
   (sổ `ai_interactions`, nhãn model, công cụ) vẫn xanh nguyên.

### Thao túng metadata (35 mặt)

A ghi vào tài nguyên CỦA CHÍNH MÌNH nhưng cài đúng một tham chiếu độc. Mỗi lượt phải bị từ chối VÌ chỗ độc (bài kiểm
khớp câu lỗi, không chỉ «có lỗi»), và ảnh chụp CSDL của A trước = sau.

| Loại | Mặt | Câu từ chối |
|---|---|---|
| Trang (nháp, trình kéo-thả) | bảng đọc `x_b_hd` · bảng khách với `custom:b_hang` · KPI tổng `x_chung.gia_tri` (field chỉ B có) · đối tượng `x_khong_ton_tai` · KPI nguồn ngoài sổ `sql_ngoai_so` · dòng thời gian `custom_record_x_b_hd` · trình kéo-thả (đúng số hiệu nháp) mang `x_b_hd` | «không có trong sổ nguồn / sổ chỉ số / sổ dòng thời gian», «không có field custom … đang hoạt động» |
| Trang — module | gắn trang vào `finance` (A không bật) · tạo trang trong `finance` | «Module «Tài chính» đang tắt với tổ chức» |
| Form / danh sách / field | ô `custom:b_hang` · ô `custom:x_khong_co` · cột `custom:b_stage` · field quan hệ trỏ `x_b_hd` | «Field … không tồn tại hoặc đã lưu trữ», «phải trỏ một đối tượng có trong sổ» |
| Luật | nghe `customer.b_stage` · nghe `x_b_hd` · điều kiện trên `gia_tri` · ghi CHÍNH field kích hoạt · nghe mọi lượt đổi trạng thái rồi ghi field · nghe sự kiện `workflow.*` | «không tồn tại», «vòng lặp trực tiếp», «chặn vòng lặp» |
| Gói tự gửi (tệp khôi phục) — xem trước VÀ cài (planHash của gói sạch), 6 × 2 | vai trò `users:manage` · luật ghi lại field kích hoạt · trang ở module gói không bật · form trên `x_b_hd` · field trên `x_b_hd` · trang đọc nguồn ngoài sổ | câu của `validateBlueprint` (luật 31, vòng lặp, module, đối tượng không khai trong gói, sổ chỉ số) |
| Module tắt ở xuất bản / dựng | xuất bản trang có KPI `delivered_revenue` (finance) · dựng thẳng khối đó | «thuộc module «finance» đang TẮT», `MODULE_DISABLED`; bản đã xuất bản của trang không đổi |
| Nháp AI độc | AI trả gói có `users:manage` ⇒ nháp ghi ở A với `valid = false`, xem trước ra kế hoạch BỊ CHẶN · áp dụng bằng đúng planHash của kế hoạch ấy | «Vai trò tuỳ chỉnh không được cấp quyền quản lý người dùng»; không vai trò nào của A mang `users:manage` |

Đối chứng (chạy TRƯỚC ảnh chụp): bản nháp form thật của A lưu được; gói gốc (mẫu bán sỉ đổi khoá) xem trước được.

## Lỗ tìm thấy

**Không có lỗ rò dữ liệu hay bí mật.** 64 mặt mới đều bị chặn ở máy chủ. Bằng chứng rằng các bài không «xanh vì rỗng»:
mỗi nhóm có đối chứng dương (công cụ Copilot thấy khách của A, nhà đọc được lời khai sao lưu của mình và tổng hợp tổ
chức, gói sạch xem trước được, form sạch lưu được, A tải được gói cấu hình của mình), và 11 đột biến dưới đây đều làm
bài ĐỎ.

**Một lỗi hành vi đã sửa (Copilot ở tổ chức khác nhà).** Trước bản vá, `copilotStatus` của tổ chức khác báo «bật» theo
khoá môi trường của nhà; mỗi câu hỏi đi tới provider, dừng ở `assertHomeCredentials` và ghi một dòng `ai_interactions`
`ERROR` vào CSDL của tổ chức đó. Không rò gì, nhưng người dùng thấy một chức năng không bao giờ trả lời và sổ AI đầy rác.

- `lib/ai/copilot.ts`: `copilotOrgDenial()` — tổ chức khác nhà ⇒ lý do; `runCopilot` trả `DISABLED` /
  `AI_NOT_AVAILABLE_FOR_ORG` TRƯỚC khi chọn provider, đọc sổ chi phí hay ghi dòng nào; `confirmCopilotActions` cùng cổng.
- `lib/actions/ai.ts`: `copilotStatus` trả `enabled: false`, `scope: "ORGANIZATION"` kèm lý do.
- `components/ai-copilot.tsx`: hiện «Chưa có AI cho tổ chức này» (không còn câu hướng dẫn `.env` của máy chủ); lối gửi —
  kể cả lượt gửi tự động qua sự kiện `erp:copilot` tới trước khi trạng thái kịp tải — đợi trạng thái và KHÔNG gửi khi tắt.
- CHƯA mở Copilot bằng khoá BYOK của tổ chức: ai trả tiền token cho tổ chức khác là quyết định còn treo.
- Đỏ trước / xanh sau: đột biến #2 và #3 dưới đây chính là mã trước bản vá (cổng luôn mở; trạng thái báo «bật») — cả hai
  làm bài ĐỎ.

## Kiểm đột biến (11/11 ĐỎ)

| # | Đột biến | Mặt bắt được |
|---|---|---|
| 1 | `decideApprovalCore`: «không tìm thấy yêu cầu» ⇒ `{ ok: true }` | duyệt lời duyệt của B bằng id |
| 2 | `copilotOrgDenial` luôn mở (= trước bản vá) | `runCopilot` của B ghi dòng và gọi model |
| 3 | `copilotStatus` bỏ nhánh tổ chức khác (= trước bản vá) | trạng thái Copilot của A báo «bật» |
| 4 | `toolModuleEnabled` luôn đúng | `get_care_case` khi Giao vận tắt |
| 5 | `getBuilderAi`: tổ chức khác rơi về khoá nhà | AI Builder của A khi môi trường có khoá nhà (`source: HOME`) |
| 6 | Bỏ chốt «dòng mang mã tổ chức khác» + AAD lấy từ cột `org_code` | bản mã của B chép nguyên văn — khoá của B giải ra ở A |
| 7 | `customRefProblems` bỏ kiểm field custom | trang A đọc `custom:b_hang` |
| 8 | Bỏ chặn vòng lặp trực tiếp của luật | luật ghi lại field kích hoạt |
| 9 | `validateBlueprint` cho vai trò khoá cấm | gói tự gửi có `users:manage` |
| 10 | `getBackupHealth` luôn đọc đích của nhà | thẻ sao lưu của A (mang tổng hợp nhắc B) |
| 11 | `search_customer` đọc CSDL nhà | công cụ tìm khách (đối chứng của A mất) |

## Rủi ro còn lại có chủ đích

1. **Copilot chỉ có ở tổ chức nhà** (có chủ đích): tổ chức khác thấy «Chưa có AI cho tổ chức này». Mở Copilot bằng khoá
   BYOK của tổ chức (như AI Builder) chờ quyết định ai trả tiền token (integration-inventory §2.3). Dòng `ai_interactions`
   `ERROR` đã ghi ở tổ chức khác trước bản vá vẫn nằm đó (không xoá dữ liệu).
2. **Nháp được mang cảnh báo module tắt** (G7): trang / khối của module chưa bật lưu được ở NHÁP (module có thể bật sau);
   XUẤT BẢN và DỰNG chặn. Nháp AI độc cũng được ghi (`valid = false`) để người đọc lỗi; áp dụng bị chặn, và người dùng loại
   mục độc (`excludedKeys`) rồi cài phần còn lại là đúng thiết kế.
3. **Vòng lặp GIÁN TIẾP giữa hai luật** không chặn lúc lưu; chặn lúc chạy bằng độ sâu nhân quả 3 (W7 — `FAILED` «vòng lặp»).
   Hành động `set_custom_value` không phát `custom_record.updated`, nên luật nghe sự kiện ấy không tự kích lại chính nó.
4. **Getter đồng bộ chỉ thấy ngữ cảnh TƯỜNG MINH** (`peekIsNonHome`): request mang phiên tổ chức khác nhận instance
   provider của ngăn nhà; với Copilot, cổng tổ chức nay đứng trước, và `assertHomeCredentials` ở lối gọi mạng là lớp thứ
   hai cho mọi đường AI khác — bộ quét tĩnh (S6') buộc mọi lối gọi mạng phía máy chủ mới có nó.
5. **Mức mã, không phải trình duyệt**: các mặt mới gọi thẳng server action / page component / route trong phạm vi request
   dựng tay, trên PGlite một tiến trình. E2E #7 bằng trình duyệt (Phase 12) phủ id / slug / tệp nhưng chưa phủ
   `/approvals`, Copilot, gói tự gửi. Thẻ sao lưu trên PGlite: tên CSDL tổ chức không khớp mẫu `erp_org_*` nên luôn «chưa
   có bản sao» — đúng hướng; đích thật chỉ đo được trên Postgres.
6. **Webhook, job, bus, đệm tiến trình** không nằm trong bài này — đã có `platform-process-isolation.test.ts` và bộ quét
   tĩnh S1–S20.
7. **HUMAN GATE còn treo**: E2E #6 (AI Builder với model thật) cần khoá AI thật của một tổ chức thử.

## Chạy lại cho pilot readiness (29/09/2026)

Base `b4c8a1e8` (origin/main + A3 sổ dùng AI + A4 vòng đời pilot / trang sức khoẻ / công tắc khẩn; main đã có B1 sản
phẩm tay, B2 đơn tay, A1 tự kiểm khoá bí mật). Không thêm tính năng: chỉ thêm mặt vào ĐÚNG hai bài có sẵn.

### Chạy lại trước khi mở rộng

| Bài | Kết quả |
|---|---|
| `testTenantAttack` | ĐẠT — **178 mặt** (bảng trên ghi 176; đếm lại trên base, nhóm «Thương hiệu & tự phục vụ» có 21 mặt chứ không phải 19 — hai mặt mở đăng ký `/start` chưa vào bảng), CSDL B 188 bảng y nguyên, 0 request mạng |
| `testPlatformIsolationStatic` (S1–S20) | ĐẠT — 482 server action hỏi phiên trước lượt đọc / ghi đầu tiên; mọi action mới nhận mã tổ chức (5 action `platform-ops.ts` + `setOrgAiControlAction`) đã khai ở `ACTION_NHAN_MA_TO_CHUC` loại `VAN_HANH` |

### Mặt mới: 178 → 243 (65 mặt mới, tất cả ĐẠT)

| Nhóm | Mặt | Kết quả |
|---|---:|---|
| **Sổ dùng AI** (A3) — `/settings/plan` page component; cùng trang kèm `?org=ta-b` (params + searchParams); `loadOrgAiUsage` theo mã của PHIÊN; `loadOperatorOrgAi(B)`; `loadPlatformAiSummary` | 5 | trang chỉ cộng dòng sổ mang mã A (số lượt + token = đúng tổng của A trong `platform_ai_usage`), không số token hiếm của B; tham số URL không đổi được tổ chức; hai loader của người vận hành «Chỉ người của tổ chức nhà…» |
| **Vận hành pilot · công tắc · hỗ trợ** (A4 + A1) — với đích **B** và đích **NHÀ**, mỗi cửa hai lớp: vỏ action (phiên thật) VÀ lõi gọi thẳng: lùi giai đoạn pilot (kèm ghi đè + lý do) · xác nhận UAT · đình chỉ · tạm dừng luật · tắt kết nối · tắt AI + hạ hạn mức AI (6 × 2 × 2) + `loadOrgSupport` + page `/platform/org/<mã>` (× 2); công tắc AI toàn nền tảng (action + lõi); tự kiểm khoá bí mật (action + lõi); page `/platform?org=ta-b`; `listOrgSupportSummaries` | 34 | mọi lượt từ chối VÌ «không phải người vận hành» (bài khớp câu `Chỉ người của tổ chức nhà mới vận hành` / `forbidden=1`, không nhận lời từ chối phụ như lý do ngắn, sai giai đoạn); tóm tắt hỗ trợ trả `{}`; `platform_audit_log` không có dòng nào do người của A ghi |
| **Đơn · sản phẩm · khách tạo tay** (B1 · B2) — sửa / xác nhận (`CONFIRMED`) / huỷ đơn tay của B bằng id; tạo đơn ở A cho khách của B · với mẫu mã của B; `manualOrderFormValues(đơn B)`; page `/orders/<B>/edit` · `/orders/<B>`; sửa sản phẩm tay của B; cài mẫu mã của B vào sản phẩm tay CỦA A; page `/products/<sản phẩm B>` · `/products/<mẫu mã B>` (lối tra ngược); sửa thông tin cơ bản khách B (form profile); page `/customers/<B>`; A tạo sản phẩm trùng mã + SKU của B | 15 | «Không có đơn này» / «Khách hàng · Mẫu mã không tồn tại trong tổ chức này» / «Không tìm thấy sản phẩm · khách trong tổ chức này» / «Mẫu mã không thuộc sản phẩm này» / 404. A (không đồng bộ Pancake) qua được cổng tạo tay — lời từ chối là vì id không có ở CSDL A, không vì cổng. Mã / SKU là duy nhất THEO TỔ CHỨC: A dùng lại đúng mã của B lưu được (không có máy dò danh mục chéo) |
| **Công tắc của người vận hành** — người vận hành NHÀ tạm dừng luật + tắt AI của A, rồi đình chỉ A; A tự bỏ tạm dừng (action + lõi) · tự bật lại AI (action) · tự bật AI + nâng hạn mức (lõi) · tự đẩy giai đoạn pilot · tự bỏ đình chỉ (action với phiên thật + lõi); đối chứng AI Builder của A khi AI bị tắt | 8 | từ chối; cờ `workflows.paused` vẫn bật, `settings.ai.disabled` vẫn `true`, `status` vẫn `SUSPENDED`; phiên A khi bị đình chỉ ⇒ `/login?reason=org-inactive`; đối chứng: AI Builder dừng «AI đang bị tắt bởi người vận hành» TRƯỚC provider (model giả được tiêm: 0 lượt gọi) |
| **Phiên giả** (thêm) — huỷ đơn tay của B · sửa sản phẩm tay của B · đổi công tắc / hạn mức AI của B | 3 | về `/login` |
| **Tổng** | **65** | **243/243 ĐẠT** |

**Người vận hành NHÀ mở trang sức khoẻ của B** (chạy SAU ảnh chụp cuối; không tính vào số mặt vì không phải đòn của A):
đúng MỘT dòng `SUPPORT_VIEW` mang mã tổ chức nhà + email người vận hành; CSDL B (188 bảng) y nguyên — xem chỉ ĐẾM; kết
quả (trừ khối `organization` — tên tổ chức là dữ liệu mặt phẳng điều khiển) không chứa `TABIMAT7Q` (tên khách, giá trị
field, tên sản phẩm, ghi chú đơn), email khách `khach.TABIMAT7Q@ta-b.local`, số tiền đơn tay `7319007`, mã sản phẩm tay,
email quản trị B, bí mật kết nối, dấu nhà. Đối chứng dương: trang đo THẬT CSDL B (≥ 1 người dùng hoạt động, 2 kết nối
bật); ô «Dùng AI» = đúng tổng lượt của sổ mang mã B; `loadOperatorOrgAi(B)` thấy số token của B và không thấy của A. Sao
lưu của B: `lastSuccessAt = null` trong khi cùng thư mục trạng thái có bản sao THÀNH CÔNG của nhà — trang sức khoẻ đọc
đích sao lưu theo tổ chức, không mượn lời khai nhà.

Ảnh chụp mặt phẳng điều khiển mở rộng từ 5 lên **9 nhóm**: thêm sổ `platform_ai_usage` của B, `platform_settings`
`platform.ai.enabled`, dòng tổ chức NHÀ và cờ của nhà — TRƯỚC = SAU.

### Bộ quét tĩnh: S21 — lõi vận hành hỏi người vận hành trước lượt đọc / ghi đầu tiên

Vỏ action (`requirePermission("platform:operate")`, S20) chỉ là lớp thứ nhất; lõi nhìn xuyên tổ chức còn được trang và bài
kiểm gọi thẳng. `testLoiVanHanhHoiTruoc` (trong `testPlatformIsolationStatic`):

1. Mọi hàm xuất khẩu ở `lib/` có gọi `platformOperatorDenial(` gọi nó TRƯỚC `await` đầu tiên không phải đọc phiên (hoặc
   qua hàm cục bộ tự hỏi trước — `parseCommon`), và phải khai ở `LOI_VAN_HANH` (15 lõi: công tắc khẩn ×3, pilot ×2, hỗ
   trợ ×2, công tắc AI ×2, màn AI ×2, tự kiểm khoá bí mật, bật / tắt module, chẩn đoán H4, cổng đăng ký).
2. Lõi đã khai mà mất câu hỏi ⇒ đỏ (luật 1 mù với lõi đã xoá hẳn câu hỏi; danh sách đóng thì không).
3. Mỗi server action qua `platform:operate` gọi một lõi trong `LOI_VAN_HANH` hoặc `requireOperator` (tự hỏi).
4. `loadOrgAiUsage(` (đọc sổ AI theo mã, không hỏi người) chỉ ở 3 chỗ khai; `/settings/plan` không nhận `params` /
   `searchParams`, mã lấy từ `user.organization?.code`.
5. `writeOrgFlag(` chỉ công tắc khẩn gọi.

Bí mật (A1): `secretsSelfTestAction` / `runSecretsSelfTest` có trong bảng tấn công (từ chối A) và trong `LOI_VAN_HANH`;
phép thử khoá riêng vẫn ở bài của A1.

### Lỗ tìm thấy

**Không có.** 65 mặt mới đều bị chặn ở máy chủ, đúng lý do. Bằng chứng không «xanh vì rỗng»: `/settings/plan` của A cộng
đúng dòng sổ của A; A lưu được sản phẩm trùng mã của B; người vận hành nhà đọc được sức khoẻ + sổ AI của B; AI Builder của
A thật sự dừng khi bị tắt; và 10 đột biến dưới đây đều làm ít nhất một bài ĐỎ.

### Kiểm đột biến (10/10 ĐỎ — tệp sao ra trước khi phá, chép lại sau, không `git checkout`)

| # | Đột biến | Bài đỏ · mặt bắt được |
|---|---|---|
| 1 | `parseCommon` (công tắc khẩn) bỏ `platformOperatorDenial` | tấn công: A đình chỉ được B qua lõi · S21: lõi đã khai mất câu hỏi |
| 2 | `setOrgAiControl` bỏ câu hỏi người vận hành | tấn công: A tắt AI + hạ hạn mức của B · S21 |
| 3 | `loadOrgSupport` bỏ câu hỏi người vận hành | tấn công: A mở được sức khoẻ của B · S21 |
| 4 | Sổ AI `totalsSince` bỏ lọc `org_code` | tấn công: `/settings/plan` của A cộng cả sổ của B |
| 5 | `loadOrgSupport` không ghi `SUPPORT_VIEW` | tấn công: lượt mở của người vận hành không để vết |
| 6 | Sao lưu ở trang sức khoẻ đọc đích NHÀ | tấn công: B «mượn» bản sao thành công của nhà |
| 7 | `updateProductCore` bỏ kiểm «mẫu mã thuộc sản phẩm này» | tấn công: A cài mẫu mã của B vào sản phẩm của mình ⇒ «Đã lưu» |
| 8 | `setPilotStage` hỏi người vận hành SAU `await findOrganization` | S21: đọc trước khi hỏi (bài tấn công vẫn xanh — đúng: lớp này do S21 bắt) |
| 9 | `/settings/plan` nhận `searchParams.org` | tấn công: `?org=ta-b` đổi được sổ · S21: trang đọc tham số |
| 10 | `aiKillSwitchDenial` bỏ qua công tắc AI của tổ chức | tấn công: đối chứng AI Builder của A chạy dù người vận hành đã tắt |

### Rủi ro còn lại

1. **Người vận hành dựng tay**: phía NHÀ đo ở mức lõi (`loadOrgSupport`, `loadOperatorOrgAi`, công tắc) với một
   `SessionUser` của tổ chức nhà dựng trong bài — CSDL thử không có tài khoản nhà thật để ký phiên. Page component
   `/platform/org/<mã>` chỉ được đo ở phía BỊ TỪ CHỐI.
2. **Chẩn đoán H4 trên cùng trang** in tên / khoá cấu hình (trang, luật, đối tượng) của khách — CẤU HÌNH, không phải dữ
   liệu nghiệp vụ, có từ Phase 11 · H4; lượt quét «không dấu B» chỉ áp cho khối sức khoẻ A4.
3. **Sổ AI nằm ở CSDL nhà**: silo không che; hàng rào là bộ lọc `org_code` của máy chủ + S21 (đột biến #4 và #9 cho thấy
   thiếu nó thì bài đỏ).
4. **Đình chỉ ở tiến trình khác trễ ≤ 10 giây** (đệm sổ tổ chức) — đã khai ở A4; bài chạy một tiến trình.
5. **Sao lưu trên PGlite**: tên CSDL tổ chức không khớp `erp_org_*` nên B luôn «chưa có bản sao» — đúng hướng; đích thật
   chỉ đo được trên Postgres.
6. **Tắt AI của tổ chức không chạm Copilot / job AI của nhà** (có chủ đích, A3 — chúng có trần tiền ngày riêng).
7. **Mức mã, không phải trình duyệt**: E2E bằng trình duyệt chưa phủ các màn pilot / sổ AI / đơn tay.
