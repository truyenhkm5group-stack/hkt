# Phòng Tech AI — Phase 1: mặt phẳng điều khiển

Ngày 18/09/2026 · Nhánh `claude/ai-tech-control-plane` · Migration `0101_tech_control_plane`

Bản này dựng **chỗ nằm** cho việc của chính hệ thống: lỗi, migration, deploy, sự cố, và (từ Phase 2)
các agent AI xây nó. Nó **không** xây máy thi hành — xem mục 7.

---

## 1. Vì sao

ERP đã có sáu hàng đợi nghiệp vụ và một hệ điều hành công việc cho NGƯỜI (`/work`). Việc kỹ thuật
thì không có chỗ nào để nằm: nó sống trong đầu người đang trực và trong lịch sử chat. Hậu quả đo
được ngay trong kho mã này — `HANDOFF.md` mục 9 kể bốn lần `main` đỏ trong một buổi chiều vì hai
phiên làm việc song song, và không ai có một màn hình để thấy "ai đang làm gì trên nhánh nào".

Ba câu hỏi Phase 1 phải trả lời được bằng một lần mở trang:

1. Hệ thống đang khoẻ hay không — và nếu **chưa biết** thì nói ra là chưa biết.
2. Việc Tech nào đang tồn tại, cái nào P0/P1, cái nào đang chờ chủ shop phê duyệt.
3. Production đang chạy commit nào, lượt deploy gần nhất ra sao, sự cố nào đang mở.

## 2. Kiến trúc thực tế

```
app/(dashboard)/tech/…            5 màn hình (1 mục sidebar + 4 tab trong tech-nav.tsx)
  page.tsx                        tổng quan: 6 thẻ · hàng đợi · sức khoẻ · lượt chạy · deploy · sự cố
  tasks/                          danh sách + [id] chi tiết (dòng thời gian, lượt chạy, thao tác)
  agents/                         sổ agent: bật/tắt, khởi tạo từ bản khai
  deployments/                    lịch sử deploy + đối chiếu commit đang chạy
  incidents/                      danh sách + [id] chi tiết

lib/constants/tech.ts             TỪ VỰNG: 13 trạng thái việc, bảng phép chuyển, ưu tiên, rủi ro,
                                  vai agent, cổng chạy, trạng thái deploy, vòng đời sự cố, nhãn+màu
lib/constants/tech-risk.ts        MÁY XẾP RỦI RO: 16 luật, hàm THUẦN `classifyTechRisk`
lib/tech/health-parse.ts          đọc phong bì `/api/health` (hàm thuần), `commitMatches`
lib/version.ts                    `runningVersion()` — MỘT chỗ đọc `ERP_COMMIT`/`ERP_BRANCH_NAME`
lib/tech/service.ts               MỘT ĐƯỜNG GHI: luật vòng đời, cổng phê duyệt, chống bấm hai lần
lib/actions/tech.ts               vỏ mỏng: quyền → zod → dịch vụ → audit() → revalidatePath
lib/queries/tech.ts               hàng đợi việc, mặt cắt, chi tiết, thẻ đếm
lib/queries/tech-agents.ts        sổ agent + lượt chạy
lib/queries/tech-ops.ts           deploy + sự cố
lib/queries/tech-health.ts        sức khoẻ hệ thống (gộp lại, không tự đo lại thứ người khác đã đo)
```

**Vì sao tách `lib/tech/service.ts` khỏi `lib/actions/tech.ts`:** luật vòng đời phải kiểm thử được
mà không cần dựng một phiên đăng nhập Next.js, và Phase 2 sẽ gọi đúng những hàm ấy với
`actor.kind = "AI_AGENT"`. Nếu luật nằm trong Server Action thì agent phải có đường ghi RIÊNG — và
hai đường ghi cho một sự việc luôn lệch nhau (AGENTS.md mục 32).

## 3. Schema & migration

Migration `0101_tech_control_plane` — **chỉ cộng thêm**, sáu bảng mới, không sửa bảng nào đang có,
không backfill một dòng nào. Viết tay và idempotent như 0033–0100.

| Bảng | Vai trò |
|---|---|
| `tech_tasks` | việc Tech: 13 trạng thái, mức ưu tiên, mức rủi ro + luật đã khớp, nhánh/cây làm việc, cha–con, phụ thuộc, cổng phê duyệt, xác minh production |
| `tech_task_events` | nhật ký chỉ-thêm: ai (người/hệ thống/agent), làm gì, từ giá trị nào sang giá trị nào |
| `tech_agents` | sổ agent — **dữ liệu điều khiển**, KHÔNG nối `users` |
| `tech_agent_runs` | lượt chạy: nhánh, commit vào/ra, bốn cổng (typecheck·lint·test·build), tệp đã đổi |
| `tech_deployments` | LỚP QUAN SÁT deploy + ba cổng sau khi lên (health·smoke·quan sát) |
| `tech_incidents` | sự cố: SEV0–SEV3, năm trạng thái, bằng chứng, nguyên nhân gốc (được phép trống) |

**Mười ràng buộc CHECK đáng kể** (chúng là cổng, không phải trang trí):

- `tech_tasks_approval_consistency_check` — "không cần duyệt" và "đang chờ duyệt" không cùng đúng.
- `tech_tasks_blocked_reason_check` — `BLOCKED` phải nói bị chặn bởi cái gì.
- `tech_tasks_completed_check` — `DONE` phải có mốc xong.
- `tech_tasks_risk_override_check` — đè mức rủi ro phải kèm lý do ≥ 10 ký tự.
- `tech_task_events_human_link_check` / `_actor_link_check` — agent không bao giờ mang khoá tài
  khoản của người, và ngược lại (AGENTS.md mục 34 & 36).
- `tech_agent_runs_ended_check` — đang chạy thì không có mốc kết thúc; đã đóng thì phải có.
- `tech_deployments_rollback_check` — lượt quay lui phải trỏ tới lượt nó quay lui.
- `tech_incidents_resolved_check` — đóng sự cố phải có mốc đóng VÀ kể được đã làm gì.

## 4. Phần đã dùng lại của ERP (không dựng lại)

| Dùng lại | Thay vì |
|---|---|
| `audit()` (`lib/audit.ts`) | một sổ nhật ký riêng cho Tech |
| `users` · `access_roles` · `lib/auth/session.ts` | một bảng người dùng của Tech |
| `getIntegrationHealth()` | đo lại Pancake / VTP / Facebook / ngân hàng bằng luật riêng |
| `HealthState` bốn mức của `integration-health.ts` | một thang đo sức khoẻ thứ hai |
| `/api/health` + `lib/version.ts` | một nguồn thứ hai cho "commit đang chạy" |
| `sync_runs` | một sổ nhịp tim riêng cho scheduler |
| `ai_interactions` + `lib/ai/router.ts` | một phép đo riêng cho nhà cung cấp AI |
| `DataTable` · `parseListParams` · `PageHeader` · `MetricCard` · `SectionCard` | bảng và thẻ riêng |
| `scripts/smoke.ts` | không có lá chắn cho 5 tuyến mới |

**KHÔNG dùng lại `work_items`** — và đây là quyết định đáng giải thích nhất. AGENTS.md mục 19 nói
mỗi sự việc chỉ có MỘT nơi giữ trạng thái, `/work` là PHÉP CHIẾU chứ không phải bản sao. Việc Tech
là một MIỀN MỚI với vòng đời riêng: không trạng thái nào trong `WorkStatus` diễn đạt được "đang
quan sát sau deploy", và `work_items` không có chỗ cho mức rủi ro, cổng phê duyệt hay nhánh git.
Nhét nó vào đó là tạo ra nơi giữ trạng thái thứ hai — đúng cái bẫy mục 19 sinh ra để chặn. Phase 2
sẽ CHIẾU `tech_tasks` lên `/work` bằng một nguồn `TECH_TASK` khai tường minh ở
`lib/constants/work-sources.ts`; chiếu trước khi có miền là chép dữ liệu.

## 5. Quyền

Hai khoá mới trong `lib/auth/permissions.ts`, nhóm **"Phòng Tech AI"**:

- `tech:view` — xem sức khoẻ, hàng đợi, sổ agent, deploy, sự cố.
- `tech:manage` — tạo/đổi việc, đè mức rủi ro (có lý do), **phê duyệt việc R2**, bật tắt agent,
  ghi deploy, mở/đóng sự cố.

**Không vai trò nào ngoài `ADMIN` nhận hai khoá này theo mặc định.** Mẫu của `MANAGER` dựng bằng
phép TRỪ, nên hai khoá phải được nêu tên trong danh sách loại — một quyền lọt vào bằng phép trừ là
quyền không ai từng quyết định cấp (cùng lý do với `payroll:view`, xem ghi chú dài trong tệp ấy).
Chủ shop cấp tay cho từng người ở `/settings/users`.

Ba chiều quyền không bị đụng tới: không suy quyền từ chức danh, không thêm phạm vi dữ liệu mới, và
`tech:*` không nằm trong vùng nhạy cảm nào của `SENSITIVE_AREAS` (nó không đọc tiền hay lương).

## 6. Máy xếp rủi ro

`classifyTechRisk` là hàm THUẦN, client-safe — biểu mẫu chạy nó **trong lúc gõ** để người ghi việc
thấy cổng phê duyệt trước khi bấm Lưu; máy chủ chạy lại nó khi lưu (không tin client).

- **16 luật**, khớp theo module · loại việc · từ khoá (khớp cả chuỗi **không dấu**).
- **Chỉ NÂNG, không bao giờ hạ**: một việc `DOCS` chạm lương vẫn là R2.
- **13 luật R2** phủ đúng các vùng sự thật của AGENTS.md: `ORDER_OUTCOME` · lương · lợi nhuận &
  phân bổ chi phí · tồn kho · quyền · migration · sửa dữ liệu production · scheduler · secret ·
  đổi tích hợp ngoài · COD · chứng từ ĐVVC · định nghĩa chỉ số.
- **R2 ⇒ bắt buộc chủ shop phê duyệt** trước khi vào cột *Sẵn sàng deploy* — và lá chắn thứ hai
  đứng lại ở bước deploy, cho trường hợp việc bị nâng lên R2 SAU khi đã sẵn sàng.
- Không luật nào khớp ⇒ R0, và màn hình nói đúng nghĩa: *"chưa thấy rủi ro"*, không phải *"đã kiểm
  tra và an toàn"*.
- Người đè được, nhưng phải ký tên: lý do ≥ 10 ký tự, lưu `risk_overridden_by` (khoá tài khoản),
  vào `audit_logs` và vào nhật ký việc. **Máy KHÔNG đè được** — một agent tự hạ mức rủi ro của
  chính việc mình làm là tự mở cổng bằng cửa sau.

## 7. Cố tình CHƯA xây (thuộc Phase 2–4)

Không phải bỏ sót. Mỗi dòng là một quyết định.

| Chưa xây | Vì sao |
|---|---|
| Agent tự viết mã / tự merge / tự deploy | Phase 1 là mặt phẳng điều khiển. `setTechAgentEnabled` **chặn** bật một agent mang cờ `can_merge`/`can_deploy`/`can_run_prod_write`, và không mẫu nào khai `true` — một cờ bật ở đây là lời hứa mã nguồn không giữ được |
| Gọi Claude Agent SDK | sổ agent Phase 1 là DỮ LIỆU ĐIỀU KHIỂN; nối SDK trước khi có chỗ ghi kết quả là chạy trước khi có đường |
| Agent ghi vào dữ liệu production | không agent nào có `can_run_prod_write`; `lib/ai/tools/*` hiện tại đã cấm nhóm `destructive` |
| Auto rollback | ERP không phải bên có thẩm quyền về deploy; tự quay lui là ghi đè quyết định của GitHub Actions |
| Agent tự lấy secret / mở shell trên production | kho mã PUBLIC; secret chỉ ở `.env` VPS và GitHub Secrets |
| Server Action cho `startTechAgentRun` / `finishTechAgentRun` | Phase 1 không ai bấm chúng bằng tay. Hàm sống ở `lib/tech/service.ts`, có kiểm thử, và Phase 2 gọi thẳng. Bọc thành nút ngay bây giờ là dựng một nút không ai bấm — đúng thứ `tests/action-wiring.test.ts` sinh ra để chặn |
| Chiếu `tech_tasks` lên `/work` | phải khai nguồn ở `lib/constants/work-sources.ts` và kiểm độ mịn trùng lặp trước, nếu không tiền bị đếm hai lần ở mọi tổng hợp (AGENTS.md mục 19) |
| Đọc trạng thái GitHub Actions tự động | cần token trong ERP; Phase 1 ghi quan sát bằng tay, và màn hình **nói ra** khi commit đang chạy lệch với sổ |

## 8. Kiểm thử

`tests/tech-control-plane.test.ts`, nối vào `npm test` (5 hàm). Mốc thời gian đi theo **đồng hồ
thật**, dữ liệu tự dọn bằng tiền tố `tech-t-` (AGENTS.md mục 50 — không ghim ngày tuyệt đối).

1. **`testTechLifecycle`** — mọi trạng thái tới được từ `NEW`; chỉ `DONE` kết thúc; `FAILED` /
   `ROLLED_BACK` VẪN đếm là còn mở; không đường tắt tới `DEPLOYING` hay `DONE`; cổng deploy nói
   được LÝ DO chặn; vòng đời sự cố cho tái phát quay lại nhưng không mở lại sự cố đã đóng.
2. **`testTechRiskEngine`** — R2 cho lương/tồn kho/`ORDER_OUTCOME` (kể cả chuỗi không dấu); luật chỉ
   nâng; hàm thuần (hai lượt ra một kết quả); mọi luật giải thích được; 11 vùng sự thật đều có cổng.
3. **`testTechPermissions`** — hai khoá có nhãn; không vai trò nào ngoài ADMIN nhận theo mặc định;
   tài khoản có danh sách quyền riêng cũng không tự nhận; **quét mã nguồn**: 7 trang đều gọi
   `requirePermission("tech:view")`, 16 Server Action đều qua cổng quyền VÀ ghi `audit()`.
4. **`testTechHealthParsing`** — bốn tình huống `UP`/`DOWN`/`UNREACHABLE`/`UNREADABLE` tách riêng;
   `"unknown"` đọc thành `null`; `commitMatches` trả `null` khi thiếu một vế (hai vế cùng trống
   KHÔNG phải "khớp"); mức tổng lấy **xấu nhất** và `UNKNOWN` xếp trên `HEALTHY`.
5. **`testTechControlPlaneDb`** — đường ghi thật: sổ agent không tự đầy và bấm lại không nhân đôi;
   mọi agent sinh ra TẮT; cổng R2 không lách được bằng máy / bằng hạ rủi ro / bằng giao agent; bấm
   hai lần không đẻ lịch sử; `BLOCKED` phải có lý do; đóng việc phải có bằng chứng; đóng một lượt
   chạy đã đóng không đẩy mốc; deploy KHÔNG chống trùng theo commit; đóng sự cố phải kể được đã làm
   gì và `root_cause` để trống là hợp lệ; lọc + phân trang + mặt cắt.

`tests/migration-upgrade-path.test.ts` thêm `0101`: bước 1 chứng minh hai bảng CHƯA có, bước 2
chứng minh migration không gieo agent/việc nào và bốn ràng buộc CHECK chặn đúng.

Bốn cổng đã chạy sạch: `npm run typecheck` · `npm run lint` · `npm test` (**TẤT CẢ KIỂM THỬ ĐẠT**) ·
`npm run build`.

## 9. Rủi ro còn lại

1. **Sổ deploy phải ghi bằng tay.** ERP không đọc GitHub Actions, nên "Deploy hôm nay" chỉ đúng
   bằng mức người ta chịu ghi. Màn hình chống lại điều đó bằng cách **đối chiếu** commit đang chạy
   với lượt deploy thành công gần nhất và nói LỆCH khi chúng khác nhau — nhưng nó không thay được
   một lần ghi bị bỏ. Phase 2 nên đọc GitHub Actions API.
2. **Nhịp scheduler đo trên hai job.** `NHIP_JOB` canh `pancake-orders` (3′) và `vtp-tracking`
   (10′) với ngưỡng gấp sáu lần nhịp. Một job khác chết mà hai job này sống thì bảng vẫn xanh.
3. **Sức khoẻ AI không gọi thử API.** Nó đọc `ai_interactions`; nhà cung cấp chết mà không ai dùng
   copilot trong 24 giờ thì thẻ nằm ở `UNKNOWN` chứ không đỏ — đúng theo luật "chưa biết không
   được in thành khoẻ", nhưng nó KHÔNG phải một phép đo chủ động.
4. **Trang `/tech` gọi `getIntegrationHealth()`** (có đệm 60 giây) cùng năm truy vấn đếm. Đã nằm
   trong `scripts/smoke.ts` nên lá chắn hiệu năng canh được; nếu nó chậm lên thì sẽ thấy.
5. **Mã việc `TECH-n` tính từ số lớn nhất** với khoá duy nhất ở CSDL và ba lần thử lại. Ở nhịp một
   shop thì đủ; ở nhịp hàng chục lượt tạo một giây thì phải đổi sang chuỗi tuần tự của CSDL.
6. **Chưa có màn hình cấu hình cho `TECH_AGENT_TEMPLATES`.** Đổi bản khai vẫn phải sửa mã và
   deploy. Cố ý: Phase 1 chưa biết agent thật cần những gì, và khai sớm một bảng cấu hình là khoá
   chặt một hình dạng chưa ai kiểm nghiệm.

## 10. Phase 2 — nối Claude Agent SDK và AI CTO

Theo thứ tự, mỗi bước đứng được một mình:

1. **Đọc GitHub Actions** (`tech_deployments` tự đầy). Token ở `.env` VPS, ERP chỉ ĐỌC. Gỡ rủi ro
   số 1, và làm cho "Deploy hôm nay" thành một con số đo được thay vì một con số được khai.
2. **Chiếu `tech_tasks` lên `/work`**: khai nguồn `TECH_TASK` ở `lib/constants/work-sources.ts` với
   `statusAuthority: "SOURCE"` (miền Tech giữ trạng thái, `work_items` chỉ là lớp ghi chú), khai
   `ALERT_KINDS_OWNED_ELSEWHERE` nếu trùng độ mịn với một cảnh báo đang có.
3. **Một agent thật, một vai, một mức rủi ro**: `DOCUMENTATION` ở R0. Nó gọi
   `startTechAgentRun` → làm việc trong một worktree riêng → `finishTechAgentRun` với bốn cổng
   khai THẬT. Không merge, không deploy. Đo trong hai tuần: bao nhiêu lượt xanh, bao nhiêu lượt
   người phải sửa lại.
4. **AI CTO ở chế độ ĐỀ XUẤT**: đọc hàng đợi, đề xuất mức ưu tiên và người làm, ghi đề xuất vào
   `tech_task_events` với `actor_kind = "AI_AGENT"`. Người bấm áp dụng. Đo độ chính xác trước khi
   cho nó tự áp.
5. **Mở dần mức rủi ro**: R1 cho `BACKEND`/`FRONTEND` sau khi bước 3 có số liệu. **R2 không bao giờ
   mở cho agent** — đó là chỗ chủ shop ký tên.
6. **`can_merge` chỉ sau khi có review bắt buộc của người**, và `can_deploy` thì Phase 1 đã trả lời:
   GitHub Actions là bên có thẩm quyền, ERP không tranh chỗ đó.

Ba luật của Phase 1 phải sống nguyên qua Phase 2: **cổng R2 là của người** · **agent không bao giờ
được ghi thành người** · **chưa biết không được in ra thành khoẻ / đã đạt / 0**.
