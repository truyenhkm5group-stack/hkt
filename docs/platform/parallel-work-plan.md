# Nền tảng ERP — Kế hoạch làm song song

> Mỗi agent một cây làm việc + một nhánh (AGENTS.md §9). Phiên tích hợp gộp theo thứ tự ở mục 3.
> Hợp đồng chung: `shared-contracts.md` — không agent nào tự tạo phiên bản riêng.

## 1. Đồ thị phụ thuộc

```
 P0 tài liệu + hợp đồng ──┬──► A  nền móng (ngữ cảnh, getDb, mặt phẳng điều khiển, cấp tổ chức) ──┬──► A2 cô lập mức tiến trình ─┐
                          │                                                                         │                             │
                          └──► B  sổ module (thuần) ─────────► tích hợp: capabilities + ghi cấu hình ┴──► C  phiên / RBAC / cổng ──┼──► QA  E2E hai tổ chức
                                                                                                     └──► E  giao diện ──────────┘
```

A và B không phụ thuộc nhau (B thuần). A2 chỉ cần A. C và E cần A + B + lớp capabilities (phiên tích
hợp viết, vì nó nối hai bên). QA cần tất cả.

## 2. Phân công

| Agent | Nhánh / cây | Phạm vi tệp (ĐƯỢC sửa) | KHÔNG được sửa | Kiểm thử | Bàn giao |
| --- | --- | --- | --- | --- | --- |
| **A** — Nền móng (phiên tích hợp tự làm) | `claude/platform-phase0` · `wt-platform` | `lib/platform/{types,context,organizations,audit,provision}.ts`, `db/index.ts`, `db/migrate.ts`, `db/schema.ts` (khối `platform_*`), `drizzle/0152_*` | mã nghiệp vụ | `tests/platform-context.test.ts` | ✔ commit `2c2092ad` |
| **B** — Sổ module | `claude/platform-modules` · `wt-platform-b` | `lib/constants/platform-modules.ts`, `lib/constants/platform-flags.ts`, `lib/platform/types.ts` (thêm `ModuleRow`) | `db/*`, `lib/auth/*`, `app/*`, `components/*`, `permissions.ts`, `department-modules.ts` | `tests/platform-modules.test.ts` (mọi route thuộc đúng một module, phụ thuộc không vòng, đóng dưới phụ thuộc, mẫu) | báo cáo + commit |
| **Tích hợp** — năng lực + ghi cấu hình | `claude/platform-phase0` | `lib/platform/capabilities.ts`, `lib/platform/module-config.ts`, `lib/platform/flags.ts` | — | mở rộng `platform-modules` phần CSDL | trước C/E |
| **A2** — Cô lập mức tiến trình | `claude/platform-isolation` · `wt-platform-a2` | `lib/cache.ts`, `lib/realtime/*`, `app/api/events`, `lib/platform/{credentials,webhooks}.ts`, client tích hợp (chỉ chèn chặn credential), `lib/alerts/config.ts`, `lib/alerts/rules.ts` (hẹn giờ), throttle ISO-18, `lib/sync/runner.ts`, `app/api/sync`, `app/api/webhooks/**` (bọc ngữ cảnh), `app/api/perf` | `lib/auth/*`, `middleware.ts`, `lib/actions/auth.ts`, `components/*`, `app/(dashboard)/*`, sổ module, schema | `tests/platform-isolation-static.test.ts`, `tests/platform-process-isolation.test.ts` | báo cáo + commit |
| **C** — Phiên / RBAC / cổng | `claude/platform-rbac` | `lib/auth/session.ts`, `middleware.ts`, `lib/constants/session.ts`, `lib/actions/auth.ts`, `app/login/*`, `lib/auth/login-throttle.ts`, `lib/auth/permissions.ts` (thêm `modules:manage`, `platform:operate`), `lib/auth/access.ts` (chặn vai trò tuỳ chỉnh cấp `platform:operate`) | `db/*`, `components/*` (trừ form đăng nhập), sổ module | `tests/platform-rbac.test.ts` | báo cáo + commit |
| **E** — Giao diện | `claude/platform-ui` | `components/app-sidebar.tsx`, `components/app-topnav.tsx`, ô lệnh ⌘K, `app/(dashboard)/settings/modules/*`, `app/(dashboard)/platform/*`, `app/module-disabled/*` (đứng ngoài nhóm `(dashboard)` từ #686), `lib/actions/platform-modules.ts`, `lib/queries/platform-health.ts` | `lib/auth/*`, `db/*`, sổ module | kiểm thử action + health | báo cáo + commit |
| **QA** — An toàn nền tảng | `claude/platform-qa` | `tests/platform-isolation.test.ts`, `scripts/platform-provision-org.ts`, `scripts/platform-demo-seed.ts` | mã sản phẩm (chỉ báo lỗi) | kịch bản §55 + truy cập trực tiếp theo id + hồi quy tổ chức nhà | báo cáo |

## 3. Thứ tự gộp vào nhánh tích hợp

`A` → `B` → capabilities (tích hợp) → `A2` → `C` → `E` → `QA`. Mỗi lượt gộp: cherry-pick lên
`claude/platform-phase0`, chạy typecheck + lint + bài kiểm nền tảng; cổng đầy đủ (`npm test` hai chế
độ + build) chạy trên cây SẠCH trước khi đẩy.

## 4. Chiến lược PR

Vì chủ shop đã chốt "gộp PR, tự deploy, bớt gọi chủ shop" (bộ nhớ dự án) và mỗi bước dưới đây tự đứng
được, dự kiến:

| PR | Nội dung | Đổi hành vi production |
| --- | --- | --- |
| PR-1 | `docs/platform/*` (Phase 0) | Không |
| PR-2 | Nền móng + sổ module + năng lực + cô lập tiến trình + phiên/cổng + giao diện + E2E (Phase 1) | Không cho tổ chức nhà (`module_default = ENABLED`); thêm 2 trang quản trị |

PR-2 lớn hơn mức lý tưởng nhưng các phần phụ thuộc chặt (cổng module vô nghĩa khi chưa có sổ; cô
lập tiến trình vô nghĩa khi chưa có ngữ cảnh). Nếu vượt ~60 tệp thì tách "cô lập tiến trình" thành
PR riêng đi TRƯỚC.

## 5. Khi một PR chờ người

Việc không phụ thuộc vẫn chạy: QA viết kịch bản trên nhánh tích hợp; tài liệu Phase 2 (`phase-2-plan.md`)
viết song song; không mở PR vụn chỉ để có việc làm.

## 6. Trạng thái (27/09/2026)

| Agent | Kết quả | Kiểm đột biến |
| --- | --- | --- |
| A — nền móng | ngữ cảnh, `getDb()` định tuyến, mặt phẳng điều khiển, cấp tổ chức | `getDb()` bỏ qua tổ chức ⇒ kịch bản §55 đỏ |
| B — sổ module | 23 module; mọi trang/API thuộc đúng một module; 8 khoá quyền vô chủ khai tường minh | 9/9 đỏ đúng thông điệp |
| A2 — cô lập tiến trình | ISO-01/02/03/04/05/06/07/08/11/12/14/15/16/18/25/26/27 đóng hoặc giảm; máy quét tĩnh + bài hành vi | 6/6 đỏ |
| C — phiên / RBAC | claim `org` qua gia hạn, cổng đường dẫn, `can()` theo module (cả ADMIN), `platform:operate` chỉ nhà, đăng nhập theo mã tổ chức, `apiGuard` (16 route) | 5/5 đỏ |
| E — giao diện | menu/⌘K/chuông theo module, `/settings/modules`, `/platform` (health), `/module-disabled` | 4/4 đỏ |
| QA — §55 | hai tổ chức thật, đọc/ghi theo id chạm 0 dòng (kể cả SQL thô), bật/tắt không deploy, phụ thuộc, nhật ký hai nơi | 1/1 đỏ |

Gộp theo thứ tự A → B → năng lực → E → QA → A2 → C trên `claude/platform-phase0`; hai xung đột
(`tests/sync-fixtures.test.ts` — giữ cả hai; `app/api/events/route.ts` — `apiGuard` của C + lọc tổ
chức của A2) gỡ tay. Hậu tố `@<org>` C thêm vào khoá đệm mẫu quyền được BỎ vì `memo()` của A2 đã
khoá theo tổ chức — hai nơi cùng khoá là hai chỗ phải giữ khớp.
