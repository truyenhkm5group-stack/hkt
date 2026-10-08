# Thang rủi ro — kiểm kê, quy đổi hai chiều, một nguồn sự thật (đề xuất)

> CHỈ TÀI LIỆU, 08/10/2026, đọc mã ở `origin/main` `051f49a5`. Kiểm kê 08/10 ghi «hai thang song song chưa quy đổi». Đọc mã thì
> thấy BA thang cho cùng một câu hỏi «thay đổi này nguy hiểm tới đâu», cộng hai thang cho hai đối tượng khác. Tài liệu này KHÔNG sửa
> mã. Nó chỉ quy đổi, chỉ ra chỗ lệch, và đề xuất PR. Bảng quy đổi trong `docs/tech-control-plane/README.md:75` đã được hứa ở
> `lib/constants/tech-control-plane.ts`, nhưng tệp đó chưa có (đã kiểm: không có ánh xạ nào).

## 1. Kiểm kê

| Thang | Trả lời câu hỏi | Đầu vào | Hàm | Định nghĩa | Lưu ở | Cổng nó điều khiển |
|---|---|---|---|---|---|---|
| **R0–R2** «chạm sự thật» (`TechRisk`) | Việc này có đụng một con số / một quyền mà chủ shop dùng để quyết không? | loại việc · module · từ khoá tiêu đề | `classifyTechRisk` `lib/constants/tech-risk.ts:226` | `lib/constants/tech.ts:224-237` · 13 luật R2 + 3 luật R1 `lib/constants/tech-risk.ts:39-165` | `tech_tasks.risk` | R2 ⇒ chủ shop duyệt trước deploy (`requiresApproval` `lib/constants/tech-risk.ts:248`, `techDeployBlockers` `lib/constants/tech.ts:391`) |
| **R0–R4** «mức tự chủ» (`TechPolicyLevel`) | Máy được TỰ làm tới đâu, TRƯỚC khi bắt tay? | R0–R2 + luật đã khớp + loại việc + từ khoá nguy hiểm | `classifyTechPolicy` `lib/constants/tech-policy.ts:77` | `lib/constants/tech-policy.ts:19-98` | `tech_tasks.policy_level` (0230) | R0 · R1 tự động (`:31`) · R3 · R4 cần người duyệt (`:96`) · worker chỉ nhận tới trần, mặc định R0 (`lib/constants/tech-worker.ts:176-207`) |
| **LOW–CRITICAL** «mức gộp» (`Risk`, AI Tech Room) | Ai được GỘP thay đổi này, SAU khi làm xong? | danh sách TỆP đổi + migration phá dữ liệu | `classifyRisk` `scripts/ai-tech.ts:1962` · `riskFloorFor` `:323` | `scripts/ai-tech.ts:38-40` · sàn theo đường dẫn `.ai/config.json:30-49` · vùng thấp `:15` | dòng sứ mệnh ở sổ `ai-control/registry`, phán quyết của `queue` | `mergePolicy` `.ai/config.json:16`: LOW · MEDIUM `AUTO` · HIGH `LEAD_REVIEW` · CRITICAL `OWNER` (khoá cứng `scripts/ai-tech.ts:386`) · HIGH / CRITICAL gộp riêng (`orderQueue` `:2024`) |

Hai thang KHÔNG quy đổi, vì chúng đo đối tượng khác — chỉ đừng nhầm với ba thang trên:

| Thang | Đối tượng | Định nghĩa |
|---|---|---|
| SEV0–SEV3 | mức nghiêm trọng của một SỰ CỐ đã xảy ra | `tech_incidents.severity` `db/schema.ts:8726` |
| C · H · M · L | mức của một RỦI RO trong sổ rủi ro nền tảng | `docs/platform/risk-register.md:3` |

**Va nhãn.** «R2» của thang thứ nhất nghĩa là *chạm sự thật kinh doanh*; «R2» của thang thứ hai nghĩa là *vận hành hoàn tác được*.
Một việc có thể mang `risk = R2` và `policy_level = R3` cùng lúc (`lib/constants/tech-policy.ts:79-80`). Người đọc chữ «R2» trên
màn hình hay trong một bản kiểm kê không biết đang nói thang nào.

## 2. Bảng quy đổi hai chiều

Mọi phép quy đổi dưới đây là SÀN, và chỉ NÂNG (`lib/constants/tech-risk.ts:10-12`, `scripts/ai-tech.ts:38`,
`lib/constants/tech-policy.ts:76`). Mức cuối cùng = max(mức tự xếp, mức quy đổi). Một thay đổi đi qua cổng nào cũng không được
thấp hơn cổng kia.

### 2a. R0–R2 → R0–R4 (ĐÃ CÓ, `lib/constants/tech-policy.ts:79-90`)

| R0–R2 | R0–R4 | Nâng thêm khi |
|---|---|---|
| R0 | R0 | INFRA ⇒ R2 · MIGRATION ⇒ R3 · luật SECRETS / ACCESS / DATA_FIX / SCHEDULER ⇒ R4 · loại SECURITY / DATA_FIX ⇒ R4 · từ khoá nguy hiểm ⇒ R4 |
| R1 | R1 | như trên |
| R2 | R3 | như trên |

### 2b. R0–R4 → LOW–CRITICAL (sàn gộp khi một việc `/tech` thành PR) — ĐỀ XUẤT

| R0–R4 | Sàn gộp | Vì sao |
|---|---|---|
| R0 | LOW | tài liệu · kiểm thử |
| R1 | MEDIUM | mã thường qua PR + cổng |
| R2 | HIGH | hạ tầng / deploy — hỏng thì cả hệ thống không mở được |
| R3 | HIGH (CRITICAL nếu tệp chạm sàn CRITICAL) | sự thật kinh doanh / migration — chủ shop đã duyệt trước deploy |
| R4 | CRITICAL | chủ shop quyết — gộp cũng là chủ shop (`OWNER`) |

### 2c. LOW–CRITICAL → R0–R4 (sàn tự chủ khi đưa một thay đổi của AI Tech Room lên `/tech` hay vào báo cáo) — ĐỀ XUẤT

| Mức gộp | R0–R4 | Ghi chú |
|---|---|---|
| LOW | R0 nếu chỉ `docs/` · `tests/` · `.ai/missions/` · R1 nếu chạm `components/` · `app/(dashboard)/` | `lowRiskPaths` gộp chung tài liệu với mã chạy production (`.ai/config.json:15`) |
| MEDIUM | R1 | |
| HIGH | R2 cho vùng hạ tầng · R3 cho migration / lược đồ / lương / kho / cô lập · R4 cho vùng thuộc luật R4 | KHÔNG suy được từ mức gộp — phải đọc từ VÙNG ⇒ lý do của §5 |
| CRITICAL | R4 | |

Bảng 2c cho thấy LOW–CRITICAL làm mất thông tin: biết «HIGH» thì chưa biết là R2, R3 hay R4. Vì vậy sổ vùng tệp phải mang mức R
tường minh, không suy từ mức gộp.

## 3. Ví dụ theo vùng tệp — hôm nay và đề xuất

| Vùng tệp | Sàn gộp hôm nay | Mức R hôm nay (theo việc) | Lệch? | Đề xuất R / gộp |
|---|---|---|---|---|
| `docs/` (trừ `docs/business-rules/`) · `tests/` (trừ contract test) · `.ai/missions/` · `README.md` | LOW (`.ai/config.json:15`) | R0 | khớp | R0 / LOW — được `close --no-runtime` (`scripts/ai-tech.ts:234`) |
| `docs/business-rules/` · `tests/contract-order-outcome.test.ts` · `lib/queries/return-rate.ts` | CRITICAL (`.ai/config.json:31-33`) | luật ORDER_OUTCOME R2 ⇒ R3 (`lib/constants/tech-risk.ts:41-46`) | lệch: R3 chỉ đòi duyệt trước deploy, trong khi AGENTS §0 nói chỉ chủ sở hữu được đổi đặc tả | R4 / CRITICAL |
| `components/` · `app/(dashboard)/` | LOW (`.ai/config.json:15`) | R1 | lệch nhẹ: mã chạy production được gộp lô AUTO | giữ R1 / LOW, NHƯNG thêm sàn R3 / HIGH cho trang tiền / khách: `app/(dashboard)/settings/plan/` · `settings/ai-balance/` · `app/(dashboard)/platform/` |
| `.github/` | HIGH, SERIAL (`.ai/config.json:22`, `:38`) | INFRA ⇒ R2 (`lib/constants/tech-policy.ts:85`); nhắc ruleset / bypass / branch protection ⇒ R4 (`:53-55`) | khớp phần lớn | R2 / HIGH; R4 / CRITICAL cho `gates.yml`, ruleset, bước bằng chứng của `deploy-vps.yml` |
| `db/schema.ts` · `drizzle/` | HIGH, SERIAL (`.ai/config.json:18-19`, `:34-35`); migration PHÁ dữ liệu ⇒ CRITICAL (`scripts/ai-tech.ts:1952-1972`) | MIGRATION ⇒ R3 (`lib/constants/tech-policy.ts:86`); drop / truncate / delete ⇒ R4 (`:43-45`) | khớp | R3 / HIGH; phá dữ liệu R4 / CRITICAL |
| `lib/auth/` · `middleware.ts` | HIGH, SERIAL (`.ai/config.json:25-26`, `:36-37`) | luật ACCESS ∈ nhóm R4 (`lib/constants/tech-policy.ts:34`); oauth / mật khẩu / credential ⇒ R4 (`:59-61`) | **LỆCH**: thang gộp cho Lead gộp sau một lượt review AI; thang tự chủ nói chủ shop quyết TRƯỚC | R4 trước khi làm (`NEEDS_OWNER`) + gộp ⚑ (giữ HIGH `LEAD_REVIEW` hay nâng CRITICAL) |
| `lib/billing/` | HIGH (`.ai/config.json:40`) | billing / payment / thanh toán ⇒ R4 (`lib/constants/tech-policy.ts:50-52`) | **LỆCH BA CHỖ**: cấu hình HIGH · chính sách R4 · `docs/saas/HANDOFF.md:35` ghi CRITICAL («chủ shop tự gộp») | ⚑ khuyến nghị R4 / CRITICAL cho đường tiền (khớp tiền, áp hoá đơn, sổ cái số dư) |
| `lib/pricing/` · `lib/saas/` (bảng kê, chính sách, cấp phát, che DTO) · `lib/ai-usage/` (hạn mức, sổ AI, chính sách model) | KHÔNG có sàn ⇒ MEDIUM ⇒ `AUTO` (`scripts/ai-tech.ts:1962-1967`) | R1 (trừ khi tiêu đề nhắc «billing») | **LỖ HỔNG**: giá, phần vượt, trần AI, che dữ liệu nội bộ được gộp tự động không ai review | R3 / HIGH (thêm sàn) |
| `app/api/webhooks/sepay/` · `lib/integrations/bank/` | MEDIUM (`lib/integrations/` `.ai/config.json:42`; `app/api/` không thuộc vùng thấp) | INTEGRATION_CHANGE R2 ⇒ R3 khi khai module INTEGRATIONS (`lib/constants/tech-risk.ts:110-117`) | lệch nhẹ | R3 / HIGH — đường tiền vào |
| `lib/platform/` · `db/index.ts` | HIGH (`.ai/config.json:45-46`) | module PLATFORM ⇒ luật INFRA ⇒ R2 (`lib/constants/tech-risk.ts:150-157`) | lệch: cô lập tổ chức là chuyện quyền dữ liệu, không phải hạ tầng | R3 / HIGH |
| `lib/payroll/` · `lib/queries/stock.ts` | HIGH (`.ai/config.json:39`, `:41`) | PAYROLL · INVENTORY_TRUTH ⇒ R3 | khớp | R3 / HIGH |
| `scripts/bootstrap.sh` · `deploy/` | HIGH (`.ai/config.json:43-44`) | INFRA ⇒ R2 | khớp | R2 / HIGH |
| `.ai/config.json` · `scripts/ai-tech.ts` | HIGH (`.ai/config.json:47-48`) | không luật nào khớp ⇒ R0 / R1 | **LỆCH**: đổi chính sách gộp hay sàn rủi ro là đổi luật cho MỌI sứ mệnh — cùng loại với «tắt bảo vệ» | R4 / HIGH (CRITICAL vẫn không hạ được bằng cấu hình — `scripts/ai-tech.ts:386`) |
| `lib/sales-chatbot/tools.ts` (công cụ chốt đơn) · `lib/records/order-create.ts` | MEDIUM | R1 | lệch: đơn «đã xác nhận» là sự thật kinh doanh (kiểm kê 08/10, mục 21) | R3 / HIGH cho đường chốt / tạo đơn; phần còn lại của `lib/sales-chatbot/` giữ R1 / MEDIUM |
| `lib/integrations/` (còn lại) · `chatbot/` | MEDIUM (`.ai/config.json:42`) | R2 ⇒ R3 khi khai module INTEGRATIONS | khớp tạm | giữ |

## 4. Luật gộp · review · deploy theo mức (một bảng cho cả hai đường)

| Mức | Trước khi làm | Review | Ai gộp | Lô | Deploy · hậu kiểm | `close --no-runtime`? |
|---|---|---|---|---|---|---|
| R0 / LOW | máy tự nhận (worker, trần mặc định R0) | không bắt buộc | Integration Lead khi `gates / gates` xanh (`AUTO`) | gom lô | không cần nếu mọi tệp thuộc vùng không chạy production (`scripts/ai-tech.ts:234`) | có |
| R1 / MEDIUM | máy tự nhận khi chủ shop mở trần R1 (`tech.worker-policy-ceiling`) | không bắt buộc (`AUTO`) | Integration Lead | gom lô | theo lô · `verify` (`docs/ai-tech-room/delivery-v2.md` §13) | không |
| R2 / HIGH | Delivery Controller quyết, không tự động (`lib/constants/tech-policy.ts:31`) | `ai-tech-reviewer` PASS gắn ĐÚNG SHA (`LEAD_REVIEW`) | Integration Lead sau PASS | RIÊNG (`MERGE_ISOLATED`) | riêng, `verify` xong mới tới PR kế | không |
| R3 / HIGH | chủ shop duyệt trước deploy (`approval_required`, `lib/constants/tech-policy.ts:96`) | `LEAD_REVIEW` | Integration Lead sau PASS + có duyệt | RIÊNG | riêng · `verify` + đối chiếu số trước / sau trên production (AGENTS §6.5) | không |
| R4 / CRITICAL | chủ shop QUYẾT trước khi viết mã (`NEEDS_OWNER` + một trong chín loại leo thang, `scripts/ai-tech.ts:47`) | `LEAD_REVIEW` | chủ shop (`OWNER`) | RIÊNG | riêng, ngoài giờ cao điểm nếu không đảo được · hậu kiểm nghiệp vụ | không |

Không mức nào được rollback tự động. Migration chỉ đi tới; sửa tiến bằng PR mới (`docs/ai-tech-room/delivery-v2.md` §13).

## 5. Đề xuất MỘT nguồn sự thật

Nguyên tắc: một sự thật có một nhà, mọi chỗ khác dẫn xuất và có bài kiểm khoá (cùng tinh thần AGENTS mục 15 · 18 · 59).

1. **Thang công khai duy nhất cho người là R0–R4.** Chủ shop, Lead, sổ sứ mệnh và báo cáo kiểm kê đều nói bằng R0–R4 (kiểm kê
   08/10 đã làm vậy). LOW–CRITICAL lùi về làm chi tiết nội bộ của công cụ gộp: `queue` / `board` in «R3 (HIGH)».
2. **R0–R2 giữ làm ĐẦU VÀO của máy xếp**, không đổi khoá đã lưu (`tech_tasks.risk` có CHECK và dữ liệu). Chỉ đổi NHÃN hiển thị
   để hết va chữ «R2», ví dụ «Chạm sự thật: không · hệ thống · có».
3. **Sổ vùng tệp có MỘT nhà: `.ai/config.json` `riskFloor`.** Mỗi dòng thêm ô `policy` (R0–R4). Ô `risk` (LOW–CRITICAL) không
   được thấp hơn ánh xạ §2b của `policy`. Thêm các sàn ở §3: `lib/pricing/`, `lib/saas/`, `lib/ai-usage/`,
   `app/api/webhooks/sepay/`, `lib/integrations/bank/`, trang tiền / khách, đường chốt đơn.
4. **Phép quy đổi có MỘT nhà: `lib/constants/tech-policy.ts`**, gồm hai hàm thuần `riskFloorOfPolicy` và `policyFloorOfRisk`.
   `scripts/ai-tech.ts` buộc phải chép năm dòng ánh xạ, vì nó phải tự đứng: chỉ dùng thư viện chuẩn, và chạy được từ bản sao tạm khi
   phục hồi phiên (`docs/ai-tech-room/delivery-v2.md` §16). Bài kiểm so hai bản, như luật 59 làm với bản TS + SQL.
5. **ERP không đọc `.ai/config.json` lúc chạy.** `.ai/` khai là vùng không chạy production (`scripts/ai-tech.ts:234`). Nếu app đọc
   nó, sửa `.ai/` sẽ đổi hành vi production mà `close --no-runtime` vẫn nhận là «không cần deploy». Phép kiểm lệch thang (A17 của
   `docs/saas/auditor/DESIGN.md`) vì vậy chạy trong công cụ dev (`queue`), không chạy trên production.
6. **Bài kiểm khoá `tests/risk-scale.test.ts` (mới):**
   - mỗi dòng `riskFloor` có `policy`;
   - đơn điệu: `riskFloorOfPolicy(policy) ≤ risk`;
   - mọi luật R4 của `tech-policy.ts` (ACCESS, SECRETS, billing…) có vùng tệp tương ứng ở mức ≥ HIGH;
   - bản ánh xạ trong `scripts/ai-tech.ts` bằng bản trong `tech-policy.ts`;
   - đột biến: hạ một sàn ⇒ đỏ.

## 6. Thứ tự PR (chỉ đề xuất — tài liệu này không sửa mã)

| PR | Nội dung | Mức (theo chính đề xuất) | Chờ gì |
|---|---|---|---|
| RS-1 | `lib/constants/tech-policy.ts`: bảng ánh xạ + hai hàm thuần · nhãn R0–R2 mới · bài kiểm đơn điệu | R1 / MEDIUM | — |
| RS-2 | `.ai/config.json`: ô `policy` cho mọi sàn + các sàn mới ở §3 · `tests/risk-scale.test.ts` | R4 / HIGH (đổi luật gộp của mọi sứ mệnh) | chủ shop chọn các ô ⚑ (§7) |
| RS-3 | `scripts/ai-tech.ts`: đọc `policy`, `queue` / `board` in «R3 (HIGH)», phán quyết NEEDS_OWNER cho R4, phép kiểm A17 | R4 / HIGH | RS-1 + RS-2 |
| RS-4 | `/tech`: hiện hai cổng cạnh nhau trên việc có PR (mức R của việc + sàn gộp của tệp) | R1 / LOW | RS-1 |

## 7. Quyết định của chủ shop

1. `lib/billing/` (và đường tiền vào SePay): HIGH như cấu hình, hay CRITICAL như `docs/saas/HANDOFF.md:35`? Khuyến nghị: CRITICAL
   cho khớp tiền, áp hoá đơn và sổ cái số dư.
2. `lib/auth/` · `middleware.ts`: R4 trước khi làm là đã đúng. Phần gộp giữ `LEAD_REVIEW`, hay nâng CRITICAL (chủ shop gộp mọi PR
   xác thực)?
3. `.ai/config.json` · `scripts/ai-tech.ts` lên R4: từ nay đổi luật gộp phải có chủ shop.
4. Thêm sàn R3 / HIGH cho `lib/pricing/`, `lib/saas/`, `lib/ai-usage/`, trang tiền / khách và đường chốt đơn: khi đó các PR này mất
   quyền gộp tự động.
