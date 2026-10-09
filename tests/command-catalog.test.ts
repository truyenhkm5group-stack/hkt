/**
 * SỔ LỆNH (`lib/constants/command-catalog.ts`) — ô lệnh ⌘K, «+ Tạo mới», mục chính theo vai trò.
 *
 * Sổ lệnh KHÔNG khai trang và KHÔNG cấp quyền; nó chỉ trỏ vào trang của sổ trang (`department-modules.ts`). Bài kiểm giữ
 * đúng hai điều đó: mọi đường dẫn trỏ vào một trang CÓ THẬT trong sổ trang, và mọi tham số lọc của lối đi nhanh là giá
 * trị mà trang đích THẬT SỰ đọc — một lối tắt dẫn tới danh sách lọc sai còn tệ hơn không có lối tắt.
 *
 * Chạy riêng: npx tsx --tsconfig tsconfig.json tests/command-catalog.test.ts
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { roleEnum } from "@/db/schema";
import { MODULE_GROUPS } from "@/lib/constants/department-modules";
import { CREATE_ACTIONS, MAX_PRIMARY_NAV, PAGE_ALIASES, PRIMARY_NAV_BY_ROLE, QUICK_VIEWS, primaryNavFor } from "@/lib/constants/command-catalog";
import { FULFILLMENT_BUCKET_ORDER } from "@/lib/constants/fulfillment-bucket";
import { CARE_VIEWS } from "@/lib/constants/care";
import { INBOX_FILTERS } from "@/lib/sales-chatbot/inbox-shared";
import { PERIOD_OPTIONS } from "@/lib/search-params";

export function testCommandCatalog() {
  const known = new Set(MODULE_GROUPS.flatMap((g) => g.items.map((i) => i.href)));

  for (const href of Object.keys(PAGE_ALIASES)) assert.ok(known.has(href), `PAGE_ALIASES trỏ tới ${href} — không có trong sổ trang`);
  for (const [role, list] of Object.entries(PRIMARY_NAV_BY_ROLE)) {
    assert.ok(list.length <= MAX_PRIMARY_NAV, `${role}: quá ${MAX_PRIMARY_NAV} mục chính`);
    for (const href of list) assert.ok(known.has(href), `${role}: mục chính ${href} không có trong sổ trang`);
  }
  // Đủ tám vai trò: vai trò mới mà quên khai thì `primaryNavFor` rơi về VIEWER — hẹp, không rộng.
  for (const role of roleEnum.enumValues) assert.ok(PRIMARY_NAV_BY_ROLE[role], `thiếu mục chính cho vai trò ${role}`);
  assert.deepEqual(primaryNavFor("ADMIN", new Set(["/", "/orders"])), ["/", "/orders"], "mục chính chỉ giữ trang người xem vào được");

  const validParam: Record<string, Record<string, readonly string[]>> = {
    "/orders": { fulfillment: FULFILLMENT_BUCKET_ORDER, review: ["flagged"], address: ["unnormalized", "normalized"], period: PERIOD_OPTIONS.map((o) => o.value) },
    "/shipments": { view: [...CARE_VIEWS, "report", "reconcile"] },
    "/ai/sales-chatbot/inbox": { f: INBOX_FILTERS },
    "/reports": { period: PERIOD_OPTIONS.map((o) => o.value) },
  };
  const keys = new Set<string>();
  for (const v of QUICK_VIEWS) {
    assert.ok(!keys.has(v.key), `QUICK_VIEWS trùng khoá ${v.key}`);
    keys.add(v.key);
    assert.ok(known.has(v.base), `${v.key}: trang gốc ${v.base} không có trong sổ trang`);
    const url = new URL(v.href, "http://x");
    assert.equal(url.pathname, v.base, `${v.key}: đường dẫn phải là chính trang gốc (quyền đi theo trang gốc)`);
    for (const [k, value] of url.searchParams) {
      const allowed = validParam[v.base]?.[k];
      assert.ok(allowed, `${v.key}: tham số «${k}» chưa được khai là tham số trang ${v.base} đọc`);
      assert.ok(allowed.includes(value), `${v.key}: «${k}=${value}» không phải giá trị trang ${v.base} hiểu`);
    }
  }

  for (const a of CREATE_ACTIONS) {
    assert.ok(known.has(a.base), `Tạo mới «${a.label}»: trang gốc ${a.base} không có trong sổ trang`);
    const page = path.join("app", "(dashboard)", ...a.href.split("/").filter(Boolean), "page.tsx");
    assert.ok(existsSync(page), `Tạo mới «${a.label}»: không có trang ${a.href}`);
  }

  // Thanh lọc chung: bộ lọc nhanh có trần, phần dư vào ngăn kéo — không nút lọc nào bị bỏ.
  const toolbar = readFileSync("components/data-table/toolbar.tsx", "utf8");
  assert.match(toolbar, /quickCount = 4/, "trần bộ lọc nhanh mặc định là 4");
  assert.match(toolbar, /<MoreFilters facets=\{facets\}/, "điện thoại: MỌI bộ lọc phải vào được ngăn kéo");
  console.log("✓ sổ lệnh: bí danh · lối đi nhanh · tạo mới · mục chính theo vai trò trỏ đúng trang có thật");
}

if (process.argv[1] && /command-catalog\.test\.ts$/.test(process.argv[1])) testCommandCatalog();
