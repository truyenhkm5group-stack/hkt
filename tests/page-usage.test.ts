import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { like } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { NAV_TITLES } from "@/components/app-sidebar";
import { OTHER_USAGE_KEY, summarizePageUsage, usageKeyOf, usageKeysFrom } from "@/lib/constants/page-usage";
import { getPageUsage, recordPageVisit } from "@/lib/usage/page-visits";

/**
 * ═══════════ LƯỢT MỞ TRANG ═══════════
 *
 * Ba thứ dễ sai nhất và bài này khoá lại:
 *  1. Khoá đếm là MỤC đã khai, theo ranh giới đoạn — không bao giờ là đường dẫn thô (mã đơn, mã mẫu).
 *  2. Chưa đo ≠ 0 lượt: sổ rỗng ⇒ `null`; đã đo ⇒ 0 thật, kèm số ngày đã đo.
 *  3. Không ghi ai mở: bảng không có cột người, đường ghi không đọc tài khoản.
 *
 * Ngày trong bài là ngày CỐ ĐỊNH năm 2001 truyền thẳng vào hàm thuần / hàm đọc (`today`), không so với
 * đồng hồ thật (luật 50, 65).
 */

const KEYS = ["/", "/orders", "/reports", "/reports/returns", "/models", OTHER_USAGE_KEY];

export function testPageUsagePure() {
  // ───────── 1. Quy đường dẫn về mục ─────────
  assert.equal(usageKeyOf("/", KEYS), "/");
  assert.equal(usageKeyOf("/orders", KEYS), "/orders");
  assert.equal(usageKeyOf("/orders/123456789012345678", KEYS), "/orders", "trang chi tiết đếm vào trang danh sách");
  assert.equal(usageKeyOf("/models/Q001?tab=kinh-te#x", KEYS), "/models", "bỏ query / hash, không lưu mã mẫu");
  assert.equal(usageKeyOf("/reports/returns", KEYS), "/reports/returns", "mục DÀI NHẤT thắng");
  assert.equal(usageKeyOf("/reports/returns/abc", KEYS), "/reports/returns");
  assert.equal(usageKeyOf("/reports/funnel", KEYS), "/reports");
  assert.equal(usageKeyOf("/ordersx", KEYS), OTHER_USAGE_KEY, "ranh giới đoạn: /ordersx không phải /orders");
  assert.equal(usageKeyOf("/ORDERS/", KEYS), "/orders", "chữ hoa / gạch chéo cuối không đẻ khoá mới");
  assert.equal(usageKeyOf("//orders", KEYS), "/orders");
  assert.equal(usageKeyOf("/khong-co", KEYS), OTHER_USAGE_KEY, "đường lạ rơi vào MỘT khoá (khác)");
  for (const rac of [null, undefined, 42, "", "orders", "/api/usage/visit", "/api", "/_next/static/x.js", `/${"a".repeat(400)}`]) {
    assert.equal(usageKeyOf(rac, KEYS), null, `không phải trang ⇒ không đếm: ${String(rac).slice(0, 30)}`);
  }
  // Sổ thật: mọi mục menu tự quy về chính nó.
  const that = usageKeysFrom(Object.keys(NAV_TITLES));
  for (const k of that) assert.equal(usageKeyOf(k, that), k, `mục ${k} phải quy về chính nó`);
  assert.ok(that.includes("/models"), "trang gốc vẫn có mặt");
  assert.deepEqual(usageKeysFrom(["/a", "/a?view=b", "/a", "x", "/c#d"]), ["/a"], "mục mang tham số / trùng / sai dạng bị bỏ — không để một ô 0 lượt giả");

  // ───────── 2. Chưa đo ≠ 0 ─────────
  const rong = summarizePageUsage({ rows: [], keys: KEYS, today: "2001-03-10", windowDays: 28, firstMeasuredDay: null });
  assert.equal(rong.measuredDays, 0);
  assert.ok(
    rong.lines.every((l) => l.visits === null && l.activeDays === null),
    "sổ rỗng ⇒ CHƯA BIẾT, không in 0",
  );
  assert.equal(rong.otherVisits, null);
  assert.ok(!rong.lines.some((l) => l.key === OTHER_USAGE_KEY), "(khác) đứng riêng, không lẫn vào danh sách trang");

  const rows = [
    { day: "2001-03-08", key: "/orders", visits: 5 },
    { day: "2001-03-10", key: "/orders", visits: 2 },
    { day: "2001-03-09", key: "/models", visits: 50 },
    { day: "2001-03-09", key: OTHER_USAGE_KEY, visits: 3 },
    { day: "2001-01-01", key: "/reports", visits: 99 }, // ngoài cửa sổ
    { day: "2001-03-11", key: "/reports", visits: 99 }, // sau "hôm nay"
  ];
  const s = summarizePageUsage({ rows, keys: KEYS, today: "2001-03-10", windowDays: 7, firstMeasuredDay: "2001-03-08" });
  assert.equal(s.measuredDays, 3, "mới đo từ 08/03 ⇒ cửa sổ 7 ngày chỉ có 3 ngày đã đo");
  const by = Object.fromEntries(s.lines.map((l) => [l.key, l]));
  assert.deepEqual(by["/orders"], { key: "/orders", visits: 7, activeDays: 2, lastDay: "2001-03-10" });
  assert.deepEqual(by["/models"], { key: "/models", visits: 50, activeDays: 1, lastDay: "2001-03-09" });
  assert.deepEqual(by["/reports"], { key: "/reports", visits: 0, activeDays: 0, lastDay: null }, "đã đo mà không lượt nào ⇒ 0 THẬT");
  assert.equal(s.otherVisits, 3);
  assert.equal(s.lines[s.lines.length - 1].key, "/models", "nhiều lượt nhất xuống cuối");
  assert.equal(s.lines[0].visits, 0, "ít dùng nhất lên đầu");

  // Đo từ lâu hơn cửa sổ ⇒ đủ số ngày của cửa sổ.
  assert.equal(summarizePageUsage({ rows, keys: KEYS, today: "2001-03-10", windowDays: 7, firstMeasuredDay: "2001-01-01" }).measuredDays, 7);

  console.log("✓ Lượt mở trang: khoá = mục đã khai (dài nhất, theo ranh giới đoạn), chưa đo ≠ 0, ít dùng nhất lên đầu");
}

export function testPageUsageSource() {
  // ───────── 3. Không ghi ai mở ─────────
  const cot = Object.keys(schema.pageVisitDaily).filter((k) => !k.startsWith("_") && k !== "getSQL" && k !== "enableRLS");
  assert.deepEqual(cot.sort(), ["day", "lastAt", "pageKey", "visits"], "bảng lượt mở trang không được có cột người");
  for (const tep of ["lib/usage/page-visits.ts", "app/api/usage/visit/route.ts", "components/page-visit-beacon.tsx"]) {
    const src = readFileSync(tep, "utf8");
    assert.ok(!/user\.(id|email|name)|userId/.test(src), `${tep}: đường đếm không được đọc tài khoản người mở`);
  }
  const layout = readFileSync("app/(dashboard)/layout.tsx", "utf8");
  assert.match(layout, /<PageVisitBeacon \/>/, "bộ đếm phải được gắn ở layout chung — không gắn thì bảng mãi rỗng");
  console.log("✓ Lượt mở trang: không cột người, không đọc tài khoản, bộ đếm gắn ở layout chung");
}

export async function testPageUsageDb(db: Db) {
  const t = schema.pageVisitDaily;
  await db.delete(t).where(like(t.day, "2001-%"));
  try {
    await recordPageVisit("/orders", "2001-03-09", db);
    await recordPageVisit("/orders", "2001-03-09", db);
    await recordPageVisit("/orders", "2001-03-10", db);
    const dong = await db.select().from(t).where(like(t.day, "2001-%"));
    assert.equal(dong.length, 2, "cùng (ngày, mục) cộng dồn trên MỘT dòng");
    assert.equal(dong.find((d) => d.day === "2001-03-09")?.visits, 2);

    const s = await getPageUsage(["/orders", "/reports"], { today: "2001-03-10", windowDays: 7, db });
    const by = Object.fromEntries(s.lines.map((l) => [l.key, l]));
    assert.equal(by["/orders"].visits, 3);
    assert.equal(by["/orders"].activeDays, 2);
    assert.equal(by["/reports"].visits, 0);
    await assert.rejects(db.insert(t).values({ day: "01/03/2001", pageKey: "/orders", visits: 1 }), "ngày sai dạng bị CHECK chặn");
  } finally {
    await db.delete(t).where(like(t.day, "2001-%"));
  }
  console.log("✓ Lượt mở trang (CSDL): upsert cộng dồn theo (ngày, mục), đọc lại đúng cửa sổ");
}
