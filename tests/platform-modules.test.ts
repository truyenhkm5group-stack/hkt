import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ALL_PERMISSIONS } from "@/lib/auth/permissions";
import { NAV_MODULES } from "@/lib/constants/department-modules";
import { isPlatformFlagKey, PLATFORM_FLAGS, resolveFlag } from "@/lib/constants/platform-flags";
import {
  MODULE_FREE_PATH_PREFIXES,
  MODULE_KEYS,
  moduleDef,
  moduleDependencyErrors,
  moduleOfPath,
  moduleOfPermission,
  ORG_TEMPLATES,
  permissionsOwnedByDisabledModules,
  PLATFORM_MODULES,
  PLATFORM_PERMISSION_KEYS,
  resolveEnabledModules,
  resolveFeature,
  UNOWNED_PERMISSIONS,
  validateModuleChange,
  type ModuleKey,
} from "@/lib/constants/platform-modules";
import type { ModuleRow } from "@/lib/platform/types";

/**
 * SỔ MODULE — hợp đồng `docs/platform/shared-contracts.md` mục 5–6, 12.
 *
 * Bài kiểm TỰ DỰNG kỳ vọng từ chính cây `app/` và chính sổ (luật 65): không gõ lại danh sách
 * route. Thêm một `page.tsx` mới mà quên khai module ⇒ đỏ ngay, vì trang đó sẽ LỌT QUA cổng module
 * (P9) — tắt module không chặn được một trang không ai biết nó thuộc về đâu.
 */

const goc = path.resolve(__dirname, "..");
const appDir = path.join(goc, "app");

/** Duyệt đệ quy `app/`, trả đường dẫn URL của mọi `page.tsx` / `route.ts`. */
function appEntries(): { url: string; file: string; kind: "page" | "route" }[] {
  const out: { url: string; file: string; kind: "page" | "route" }[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.name !== "page.tsx" && entry.name !== "route.ts") continue;
      // Chuẩn hoá dấu phân cách: `path.relative` trả `\` trên Windows (luật 65).
      const rel = path.relative(appDir, full).split(path.sep).join("/");
      const segments = rel.split("/").slice(0, -1).filter((s) => !/^\(.*\)$/.test(s) && !s.startsWith("@"));
      out.push({ url: `/${segments.join("/")}`, file: `app/${rel}`, kind: entry.name === "page.tsx" ? "page" : "route" });
    }
  };
  walk(appDir);
  return out;
}

function isModuleFree(url: string): boolean {
  return MODULE_FREE_PATH_PREFIXES.some((p) => url === p || url.startsWith(`${p}/`));
}

function rowsOn(keys: readonly ModuleKey[]): ModuleRow[] {
  return keys.map((k) => ({ moduleKey: k, enabled: true, features: {} }));
}

const CORE_KEYS = PLATFORM_MODULES.filter((m) => m.core).map((m) => m.key);
const ALL_KEYS = PLATFORM_MODULES.map((m) => m.key);
const label = (k: ModuleKey) => moduleDef(k)?.label ?? k;

export async function testPlatformModules() {
  // ───────── 0. Hình dạng sổ ─────────
  assert.deepEqual(ALL_KEYS, [...MODULE_KEYS], "PLATFORM_MODULES phải khai đúng và đủ MODULE_KEYS, cùng thứ tự");
  assert.equal(new Set(ALL_KEYS).size, ALL_KEYS.length, "khoá module không được trùng");
  for (const m of PLATFORM_MODULES) {
    assert.match(m.key, /^[a-z][a-z_]*$/, `khoá module "${m.key}" sai dạng`);
    assert.ok(m.label && m.description && m.why, `module ${m.key} thiếu nhãn / mô tả / lý do`);
    for (const f of m.features) {
      assert.ok(f.key.startsWith(`${m.key}.`), `feature ${f.key} phải mang tiền tố "${m.key}."`);
      assert.ok(f.label && f.why, `feature ${f.key} thiếu nhãn / lý do`);
    }
    for (const r of m.routes) {
      assert.ok(r === "/" || (/^\/[a-z0-9/_-]+$/.test(r) && !r.endsWith("/")), `tiền tố "${r}" của ${m.key} sai dạng (chữ thường, không "/" cuối)`);
      assert.ok(!isModuleFree(r), `tiền tố "${r}" của ${m.key} nằm trong vùng không-module`);
    }
  }
  const featureKeys = PLATFORM_MODULES.flatMap((m) => m.features.map((f) => f.key));
  assert.equal(new Set(featureKeys).size, featureKeys.length, "khoá feature không được trùng");
  const prefixes = PLATFORM_MODULES.flatMap((m) => m.routes);
  const trungTienTo = prefixes.filter((p, i) => prefixes.indexOf(p) !== i);
  assert.deepEqual(trungTienTo, [], "một tiền tố đường dẫn chỉ thuộc MỘT module");

  // ───────── a. Mọi page.tsx / route.ts thuộc một module (trừ vùng không-module) ─────────
  const entries = appEntries();
  assert.ok(entries.filter((e) => e.kind === "page").length > 50, "bộ duyệt `app/` phải thấy các trang thật — thấy quá ít là bộ duyệt hỏng, không phải kho sạch");
  assert.ok(entries.some((e) => e.url === "/orders/[id]"), "bộ duyệt phải bỏ nhóm `(dashboard)` và giữ đoạn động");
  const loTrang = entries.filter((e) => !isModuleFree(e.url) && moduleOfPath(e.url) === null).map((e) => `${e.file} → ${e.url}`);
  assert.deepEqual(loTrang, [], "trang / API không thuộc module nào sẽ lọt qua cổng module (P9)");
  const lotVung = entries.filter((e) => isModuleFree(e.url) && moduleOfPath(e.url) !== null).map((e) => e.file);
  assert.deepEqual(lotVung, [], "webhook / sync / login phải trả null");

  // ───────── b. Mọi mục menu có module ─────────
  const menuMoCoi = NAV_MODULES.filter((m) => moduleOfPath(m.href) === null).map((m) => m.href);
  assert.deepEqual(menuMoCoi, [], "mục menu không thuộc module nào thì không ẩn được khi tắt module");

  // ───────── c. Khoá quyền: tối đa một chủ, khoá vô chủ phải khai lý do ─────────
  const universe = new Set<string>([...(ALL_PERMISSIONS as string[]), ...PLATFORM_PERMISSION_KEYS]);
  const owners = new Map<string, ModuleKey[]>();
  for (const m of PLATFORM_MODULES) for (const p of m.permissions) owners.set(p, [...(owners.get(p) ?? []), m.key]);
  const haiChu = [...owners].filter(([, ms]) => ms.length > 1).map(([p, ms]) => `${p}: ${ms.join(", ")}`);
  assert.deepEqual(haiChu, [], "một khoá quyền thuộc TỐI ĐA một module");
  const khoaLa = [...owners.keys(), ...Object.keys(UNOWNED_PERMISSIONS)].filter((p) => !universe.has(p));
  assert.deepEqual(khoaLa, [], "sổ module nhắc tới khoá quyền không tồn tại (khoá cũ đã bỏ?)");
  const vuaCoChuVuaVoChu = Object.keys(UNOWNED_PERMISSIONS).filter((p) => owners.has(p));
  assert.deepEqual(vuaCoChuVuaVoChu, [], "khoá đã có chủ không được đồng thời khai vô chủ");
  const chuaQuyet = [...universe].filter((p) => !owners.has(p) && !(p in UNOWNED_PERMISSIONS));
  assert.deepEqual(chuaQuyet, [], "mọi khoá quyền phải có chủ hoặc khai tường minh ở UNOWNED_PERMISSIONS kèm lý do");
  for (const [p, why] of Object.entries(UNOWNED_PERMISSIONS)) assert.ok(why.length > 20, `khoá vô chủ ${p} phải có lý do`);
  for (const [p, [m]] of owners) assert.equal(moduleOfPermission(p), m);
  assert.equal(moduleOfPermission("modules:manage"), "core");
  assert.equal(moduleOfPermission("platform:operate"), "core");
  assert.equal(moduleOfPermission("planning:view"), null, "khoá dùng chung không thuộc module nào");
  assert.equal(moduleOfPermission("khong:co"), null);

  // ───────── d. Phụ thuộc: có thật, không vòng, lõi không dựa vào ngoài lõi ─────────
  for (const m of PLATFORM_MODULES) {
    for (const d of m.dependsOn) {
      assert.ok(moduleDef(d), `${m.key} phụ thuộc khoá không có thật: ${d}`);
      assert.notEqual(d, m.key, `${m.key} tự phụ thuộc chính nó`);
      if (m.core) assert.ok(moduleDef(d)?.core, `module lõi ${m.key} không được phụ thuộc module không-lõi ${d}`);
    }
  }
  const trangThai = new Map<ModuleKey, "dang" | "xong">();
  const tham = (k: ModuleKey, chuoi: ModuleKey[]) => {
    const t = trangThai.get(k);
    if (t === "xong") return;
    assert.notEqual(t, "dang", `vòng phụ thuộc: ${[...chuoi, k].join(" → ")}`);
    trangThai.set(k, "dang");
    for (const d of moduleDef(k)?.dependsOn ?? []) tham(d, [...chuoi, k]);
    trangThai.set(k, "xong");
  };
  for (const k of ALL_KEYS) tham(k, []);

  // ───────── e. P7: dòng thiếu theo moduleDefault ─────────
  assert.deepEqual([...resolveEnabledModules({ moduleDefault: "ENABLED" }, [])].sort(), [...ALL_KEYS].sort(), "tổ chức nhà (ENABLED, không dòng nào) ⇒ ĐỦ mọi module, y như hôm nay");
  assert.deepEqual([...resolveEnabledModules({ moduleDefault: "DISABLED" }, [])].sort(), [...CORE_KEYS].sort(), "tổ chức mới (DISABLED, không dòng nào) ⇒ chỉ lõi");
  assert.ok(resolveEnabledModules({ moduleDefault: "DISABLED" }, [{ moduleKey: "core", enabled: false, features: {} }]).has("core"), "lõi luôn bật, kể cả dòng dữ liệu nói tắt");
  assert.deepEqual([...resolveEnabledModules({ moduleDefault: "DISABLED" }, [{ moduleKey: "khong_co", enabled: true, features: {} }])].sort(), [...CORE_KEYS].sort(), "dòng khoá lạ bị bỏ qua");

  // ───────── f. Đóng dưới phụ thuộc — hỏng về phía hẹp ─────────
  const hong: ModuleRow[] = [
    { moduleKey: "orders", enabled: false, features: {} },
    { moduleKey: "returns", enabled: true, features: {} },
  ];
  const tapHong = resolveEnabledModules({ moduleDefault: "ENABLED" }, hong);
  assert.ok(!tapHong.has("returns"), "Hàng hoàn bật mà Đơn hàng tắt ⇒ Hàng hoàn bị coi là TẮT");
  for (const k of tapHong) for (const d of moduleDef(k)?.dependsOn ?? []) assert.ok(tapHong.has(d), `tập phân giải không đóng: ${k} thiếu ${d}`);
  const loi = moduleDependencyErrors({ moduleDefault: "ENABLED" }, hong);
  const loiReturns = loi.find((e) => e.key === "returns");
  assert.ok(loiReturns, "moduleDependencyErrors phải nêu Hàng hoàn");
  assert.deepEqual(loiReturns.missing, ["orders"]);
  assert.ok(loiReturns.message.includes(label("orders")), "câu lỗi nêu module thiếu bằng NHÃN");
  assert.ok(!loi.some((e) => e.key === "orders"), "module tắt theo dữ liệu không phải lỗi phụ thuộc");
  assert.deepEqual(moduleDependencyErrors({ moduleDefault: "ENABLED" }, []), [], "tổ chức nhà không có lỗi phụ thuộc");

  // ───────── g. validateModuleChange: CHẶN + GIẢI THÍCH (P10) ─────────
  const tatCa = resolveEnabledModules({ moduleDefault: "ENABLED" }, []);
  const chiLoi = resolveEnabledModules({ moduleDefault: "DISABLED" }, []);
  const khongDuoc = (r: ReturnType<typeof validateModuleChange>) => (r.ok ? null : r);

  const core = khongDuoc(validateModuleChange(tatCa, "core", false, { orgIsHome: true }));
  assert.equal(core?.code, "CORE_MODULE");
  assert.equal(khongDuoc(validateModuleChange(tatCa, "work", false, { orgIsHome: true }))?.code, "CORE_MODULE");

  assert.equal(khongDuoc(validateModuleChange(tatCa, "khong_co", true, { orgIsHome: true }))?.code, "UNKNOWN_MODULE");

  const thieu = khongDuoc(validateModuleChange(chiLoi, "returns", true, { orgIsHome: false }));
  assert.equal(thieu?.code, "MISSING_DEPENDENCY");
  assert.deepEqual([...(thieu?.related ?? [])].sort(), [...(moduleDef("returns")?.dependsOn ?? [])].sort());
  assert.ok(thieu?.message.includes(label("orders")), "câu lỗi phải nêu «Đơn hàng» bằng nhãn");

  const phuThuoc = khongDuoc(validateModuleChange(tatCa, "orders", false, { orgIsHome: true }));
  assert.equal(phuThuoc?.code, "HAS_DEPENDENTS");
  const nguoiDungOrders = ALL_KEYS.filter((k) => moduleDef(k)?.dependsOn.includes("orders"));
  assert.deepEqual([...(phuThuoc?.related ?? [])].sort(), [...nguoiDungOrders].sort());
  assert.ok(phuThuoc?.message.includes(label("returns")));

  const coOrders = new Set<ModuleKey>([...CORE_KEYS, "customers", "products", "orders"]);
  const credential = khongDuoc(validateModuleChange(coOrders, "connector_pancake", true, { orgIsHome: false }));
  assert.equal(credential?.code, "REQUIRES_HOME_CREDENTIALS");
  assert.equal(khongDuoc(validateModuleChange(coOrders, "connector_pancake", true))?.code, "REQUIRES_HOME_CREDENTIALS", "thiếu ngữ cảnh ⇒ coi như không phải nhà (hỏng về phía hẹp)");
  assert.deepEqual(validateModuleChange(coOrders, "connector_pancake", true, { orgIsHome: true }), { ok: true });

  const coKho = new Set<ModuleKey>([...CORE_KEYS, "products", "inventory"]);
  assert.deepEqual(validateModuleChange(coKho, "production", true, { orgIsHome: false }), { ok: true }, "bật Sản xuất khi Sản phẩm + Kho đã bật ⇒ được");
  assert.deepEqual(validateModuleChange(chiLoi, "marketing", false, { orgIsHome: false }), { ok: true }, "tắt module đang tắt ⇒ không làm gì");
  assert.deepEqual(validateModuleChange(tatCa, "returns", true, { orgIsHome: true }), { ok: true }, "bật module đang bật ⇒ không làm gì");
  assert.deepEqual(validateModuleChange(tatCa, "returns", false, { orgIsHome: true }), { ok: true }, "tắt lá của cây phụ thuộc ⇒ được");

  // ───────── h. moduleOfPath: tiền tố dài nhất, ranh giới đoạn ─────────
  const ca: [string, ModuleKey | null][] = [
    ["/inventory/planning", "production"],
    ["/inventory/planning/orders/abc/edit", "production"],
    ["/inventory/receipts", "inventory"],
    ["/inventory", "inventory"],
    ["/inventory/", "inventory"],
    ["/reports/returns", "returns"],
    ["/reports", "finance"],
    ["/reports/cashflow?from=2026-09-01", "finance"],
    ["/", "core"],
    ["/orders/abc", "orders"],
    ["/cockpit", "core"],
    ["/tech/cto", "tech"],
    ["/operations/dwell", "logistics"],
    ["/integrations", "integrations"],
    ["/chatbot", "connector_pancake"],
    ["/api/webhooks/viettelpost", null],
    ["/api/sync/pancake", null],
    ["/login", null],
    ["/_next/static/chunk.js", null],
    ["/PAYROLL", "payroll"],
    ["//payroll/runs", "payroll"],
    ["/%70ayroll", "payroll"],
  ];
  for (const [p, m] of ca) assert.equal(moduleOfPath(p), m, `moduleOfPath(${p})`);
  assert.notEqual(moduleOfPath("/inventoryx"), "inventory", "/inventoryx không phải con của /inventory");
  assert.equal(moduleOfPath("/khong-co-trang-nay"), null, "\"/\" chỉ khớp đúng \"/\"");

  // ───────── i. Mẫu tổ chức đóng dưới phụ thuộc ─────────
  for (const [key, t] of Object.entries(ORG_TEMPLATES)) {
    for (const k of t.modules) assert.ok(moduleDef(k), `mẫu ${key} nhắc module không có thật: ${k}`);
    const tap = resolveEnabledModules({ moduleDefault: "DISABLED" }, rowsOn(t.modules));
    assert.deepEqual([...tap].sort(), [...new Set<ModuleKey>([...CORE_KEYS, ...t.modules])].sort(), `mẫu ${key} không đóng dưới phụ thuộc — áp mẫu sẽ bị loại bớt module lặng lẽ`);
  }
  assert.deepEqual([...ORG_TEMPLATES["fashion-commerce"].modules].sort(), [...ALL_KEYS].sort(), "hồ sơ VNX = mọi module");
  const wholesale = new Set(ORG_TEMPLATES.wholesale.modules);
  for (const k of ["marketing", "production", "payroll"] as const) assert.ok(!wholesale.has(k), `mẫu bán buôn không chứa ${k}`);
  const canNha = PLATFORM_MODULES.filter((m) => m.requiresHomeCredentials && wholesale.has(m.key)).map((m) => m.key);
  assert.deepEqual(canNha, [], "mẫu cho tổ chức mới không được chứa module chỉ tổ chức nhà bật được");

  // ───────── Feature + quyền của module tắt ─────────
  const featureMau = moduleDef("finance")?.features[0];
  assert.ok(featureMau);
  assert.equal(resolveFeature(featureMau.key, tatCa, []), featureMau.defaultEnabled);
  assert.equal(resolveFeature(featureMau.key, chiLoi, []), false, "module tắt ⇒ feature tắt");
  assert.equal(resolveFeature(featureMau.key, tatCa, [{ moduleKey: "finance", enabled: true, features: { [featureMau.key]: !featureMau.defaultEnabled } }]), !featureMau.defaultEnabled, "ghi đè thắng mặc định");
  assert.equal(resolveFeature("finance.khong_co", tatCa, []), false);
  const quyenTat = permissionsOwnedByDisabledModules(chiLoi);
  assert.ok(quyenTat.includes("payroll:manage") && !quyenTat.includes("users:manage"));

  // ───────── Cờ nền tảng (P11): sổ riêng, không trộn với module ─────────
  for (const f of PLATFORM_FLAGS) assert.ok(!moduleDef(f.key), `cờ ${f.key} trùng khoá module`);
  assert.ok(isPlatformFlagKey("dynamic_page_runtime"));
  assert.equal(resolveFlag("dynamic_page_runtime", {}), false, "runtime trang động mặc định TẮT");
  assert.equal(resolveFlag("dynamic_page_runtime", { dynamic_page_runtime: true }), true);
}
