/**
 * ═══ SRC-1 · KHUNG MODULE «TÌM HÀNG NGUỒN» (`sourcing`, docs/tech/ai-sourcing.md) ═══
 *
 * Khoá: (1) module khai đúng — BẬT ở tổ chức nhà, TẮT ở tổ chức khách mới, không cần migration; (2) quyền — ADMIN đủ bốn,
 * MANAGER không tự có quyền duyệt & cấu hình, tài khoản có ảnh chụp quyền cũ không tự nhận; (3) hai khoá cấu hình — trần AI mặc
 * định 200, tham số giá về mặc định RỖNG và «chưa khai» là `null` chứ không phải 0; (4) khung KHÔNG gọi nguồn ngoài, không gọi AI.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ALL_PERMISSIONS, DEFAULT_ROLE_PERMISSIONS, PERMISSIONS_ADDED_AFTER_SNAPSHOT } from "@/lib/auth/permissions";
import { NAV_MODULES } from "@/lib/constants/department-modules";
import { moduleDef, moduleOfPath, resolveEnabledModules } from "@/lib/constants/platform-modules";
import {
  DEFAULT_SOURCING_LIMITS,
  EMPTY_LANDED_COST,
  LANDED_COST_FIELDS,
  SOURCING_LANDED_COST_KEY,
  SOURCING_LIMITS_KEY,
  fxStale,
  landedCostMissing,
  parseLandedCost,
  parseSourcingLimits,
} from "@/lib/constants/sourcing";

const KEYS = ["sourcing:view", "sourcing:search", "sourcing:write", "sourcing:approve"];

function testModule() {
  const m = moduleDef("sourcing");
  assert.ok(m, "module sourcing có trong sổ");
  assert.deepEqual([m!.routes, m!.permissions, m!.dependsOn, m!.core], [["/sourcing"], KEYS, ["products", "production"], false]);
  assert.ok(!m!.homeOptIn, "không homeOptIn: tổ chức nhà dòng thiếu ⇒ BẬT, không cần dòng migration");
  assert.equal(moduleOfPath("/sourcing"), "sourcing");
  assert.ok(resolveEnabledModules({ moduleDefault: "ENABLED" }, []).has("sourcing"), "tổ chức nhà (moduleDefault ENABLED, chưa có dòng) ⇒ BẬT");
  assert.ok(!resolveEnabledModules({ moduleDefault: "DISABLED" }, []).has("sourcing"), "tổ chức khách mới (DISABLED) ⇒ TẮT tới khi bật");
  const nav = NAV_MODULES.find((n) => n.href === "/sourcing");
  assert.ok(nav && nav.zone === "PRODUCTION" && nav.permission === "sourcing:view" && (nav.why ?? "").length > 40, "trên bản đồ phòng ban: phòng sản xuất, có lý do");
}

function testPermissions() {
  for (const k of KEYS) assert.ok((ALL_PERMISSIONS as readonly string[]).includes(k), `${k} có trong sổ quyền`);
  assert.ok(KEYS.every((k) => DEFAULT_ROLE_PERMISSIONS.ADMIN.includes(k as never)), "ADMIN đủ bốn quyền");
  const mgr = DEFAULT_ROLE_PERMISSIONS.MANAGER as readonly string[];
  assert.deepEqual(KEYS.map((k) => mgr.includes(k)), [true, true, true, false], "MANAGER: xem / tìm / lưu — KHÔNG duyệt & cấu hình (tham số tiền, trần chi phí)");
  for (const role of ["LEADER", "ACCOUNTANT", "WAREHOUSE", "CS", "MARKETING", "VIEWER"] as const) {
    assert.ok(!KEYS.some((k) => (DEFAULT_ROLE_PERMISSIONS[role] as readonly string[]).includes(k)), `${role} không tự có quyền tìm hàng`);
  }
  assert.ok(KEYS.every((k) => PERMISSIONS_ADDED_AFTER_SNAPSHOT.includes(k)), "tài khoản có ảnh chụp quyền cũ KHÔNG tự nhận — chủ shop cấp tay");
}

function testSettings() {
  assert.deepEqual([SOURCING_LIMITS_KEY, SOURCING_LANDED_COST_KEY], ["sourcing.limits", "sourcing.landedCost"]);
  assert.deepEqual(DEFAULT_SOURCING_LIMITS, { aiCallsPerDay: 200 }, "trần mặc định 200 lượt / ngày (Tech Lead 23/10)");
  assert.deepEqual(parseSourcingLimits(null), { aiCallsPerDay: 200 });
  assert.deepEqual(parseSourcingLimits({ aiCallsPerDay: 50 }), { aiCallsPerDay: 50 });
  assert.deepEqual(parseSourcingLimits({ aiCallsPerDay: 0 }), { aiCallsPerDay: 0 }, "0 là khai «tắt AI», hợp lệ");
  for (const bad of [{ aiCallsPerDay: -1 }, { aiCallsPerDay: 1.5 }, { aiCallsPerDay: "200" }, [200]]) assert.deepEqual(parseSourcingLimits(bad), { aiCallsPerDay: 200 }, `hỏng ⇒ mặc định: ${JSON.stringify(bad)}`);

  assert.deepEqual(parseLandedCost(null), EMPTY_LANDED_COST, "mặc định RỖNG");
  assert.equal(landedCostMissing(EMPTY_LANDED_COST).length, LANDED_COST_FIELDS.length, "rỗng ⇒ thiếu mọi tham số bắt buộc");
  const du = parseLandedCost({ cnyToVnd: 3550, fxAsOf: "2026-10-23", fxSource: "VCB", cnDomesticShipCny: 0, intlFreightVndPerKg: 30000, agentFeePercent: 3, dutyVatPercent: 0, otherVndPerUnit: 0 });
  assert.deepEqual(landedCostMissing(du), [], "0 là KHAI «không có khoản này» — không bị coi là thiếu");
  const am = parseLandedCost({ ...du, intlFreightVndPerKg: -5, agentFeePercent: "3" });
  assert.deepEqual(landedCostMissing(am), ["Cước Trung Quốc → Việt Nam", "Phí mua hộ"], "số âm / chữ ⇒ CHƯA KHAI (null), không thành 0");
  assert.equal(am.intlFreightVndPerKg, null);
  assert.equal(parseLandedCost({ fxAsOf: "23/10/2026" }).fxAsOf, null, "ngày sai dạng ⇒ chưa khai");
  assert.equal(fxStale({ fxAsOf: null }, new Date()), null);
  assert.equal(fxStale({ fxAsOf: "2026-10-20" }, new Date("2026-10-23T05:00:00Z")), false);
  assert.equal(fxStale({ fxAsOf: "2026-10-01" }, new Date("2026-10-23T05:00:00Z")), true, "quá 7 ngày ⇒ tỷ giá cũ");
}

function testSourceFences() {
  const tep = ["lib/constants/sourcing.ts", "lib/actions/sourcing-settings.ts", "components/sourcing/sourcing-settings-forms.tsx", "app/(dashboard)/sourcing/page.tsx"];
  for (const f of tep) {
    const s = readFileSync(f, "utf8");
    assert.ok(!/\bfetch\(|fetchJson\(|fetchPublicUrl\(|getAiProvider\(|@\/lib\/ai\//.test(s), `${f}: khung SRC-1 không gọi nguồn ngoài, không gọi AI`);
  }
  const act = readFileSync("lib/actions/sourcing-settings.ts", "utf8");
  assert.ok(act.startsWith('"use server";'), "server action");
  assert.ok(act.includes('can(user, "sourcing:approve")'), "ghi cấu hình đòi quyền duyệt & cấu hình");
  assert.equal((act.match(/await audit\(\{[^}]*reason: parsed\.data\.reason/g) ?? []).length, 3, "ba đường ghi cấu hình (trần AI · tham số giá về · trọng số điểm) đều có nhật ký kèm lý do");
  const page = readFileSync("app/(dashboard)/sourcing/page.tsx", "utf8");
  assert.ok(page.includes('requirePermission("sourcing:view")'), "trang đòi quyền xem");
  assert.ok(page.includes("Chưa có nguồn dữ liệu được duyệt") && page.includes("không cào web"), "trạng thái trống nói rõ vì sao chưa tìm được");
}

export function testSourcingShell() {
  testModule();
  testPermissions();
  testSettings();
  testSourceFences();
  console.log("  ✓ SRC-1 khung Tìm hàng nguồn: module BẬT ở nhà / TẮT ở khách, không migration · quyền ADMIN đủ, MANAGER không duyệt, ảnh chụp cũ không tự nhận · trần AI 200 · tham số giá về rỗng, chưa khai ≠ 0 · không gọi nguồn ngoài / AI");
}
