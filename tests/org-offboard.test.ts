/**
 * ═══════════ ops `org-offboard` — XOÁ một workspace TỰ ĐĂNG KÝ (lib/platform/offboard.ts · scripts/org-offboard.ts) ═══════════
 *
 *  · Mỗi bảng `platform_*` có ĐÚNG một quyết định (XOÁ · GIỮ · CHẶN · CHUNG); thứ tự xoá không chứa bảng tiền / nhật ký, bảng con trước.
 *  · «Tự đăng ký» đòi brand VÀ chứng cứ /start, dấu hiệu người vận hành thắng; nhà · brand NULL · có tiền thật · sai --confirm ⇒ TỪ CHỐI
 *    và KHÔNG ghi một dòng nào (băm mọi bảng mặt phẳng điều khiển trước / sau).
 *  · Chạy thử không ghi gì; xoá đúng ⇒ tổ chức tự đăng ký biến khỏi mọi bảng XOÁ + CSDL của nó, nhật ký còn (kèm ORG_OFFBOARD start /
 *    done), tổ chức người vận hành tạo nguyên vẹn; chạy lại ⇒ «không có tổ chức».
 *  · Log công khai không mang tên cửa hàng / email / SĐT; ops-vps khai thao tác (mã hoá, mặc định đọc, nhánh case).
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import { CONTROL_PLANE_TABLES } from "@/lib/blueprints/restore-drill";
import type { BackupHealth } from "@/lib/constants/backup";
import { platformAudit } from "@/lib/platform/audit";
import { invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { applyOffboard, classifyOrganization, OFFBOARD_DELETE_ORDER, OFFBOARD_TABLES, offboardHasActivity, offboardPlanLines, offboardRefusals, planOffboard, waitForNoConnections, type OffboardOptions, type OffboardSignals } from "@/lib/platform/offboard";
import { getHomeOrganization, invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { rowsOf } from "@/lib/sql-rows";
import { offboardDeletableAccountType } from "@/lib/saas/policy";
import { backupLines, parseOffboardArgs } from "@/scripts/org-offboard";

const TU_DK = "ob-tudk";
const VAN_HANH = "ob-vanhanh";
const BRAND_VH = "ob-brandvh";
const CO_TIEN = "ob-cotien";
const TEN = "Cửa Hàng Lan Anh Offboard";
const EMAIL = "lananh.offboard@example.com";
const SDT = "0912345678";
const PAGE = "1234567890123";
const PAGE2 = "9876543210987";
const DUA = "ob-dua";
const MO_COI = "ob-mocoi";

const S0: OffboardSignals = { brand: "chotdon", onboardingSource: null, signupCreated: 0, operatorSignup: 0, brandSetByOperator: 0, createCustomerJobs: 0 };

export function testOrgOffboardPure() {
  // Mỗi bảng mặt phẳng điều khiển một quyết định — thêm bảng platform_* mới mà không quyết thì đỏ ở đây.
  assert.deepEqual(Object.keys(OFFBOARD_TABLES).sort(), [...CONTROL_PLANE_TABLES].sort(), "OFFBOARD_TABLES phải khai ĐÚNG mọi bảng CONTROL_PLANE_TABLES");
  for (const [t, spec] of Object.entries(OFFBOARD_TABLES)) {
    if (spec.disposition === "GLOBAL") assert.equal(spec.where, undefined, `${t}: bảng CHUNG không có điều kiện theo tổ chức`);
    else assert.equal(typeof spec.where, "function", `${t}: bảng ${spec.disposition} phải có điều kiện theo tổ chức`);
  }
  const xoa = Object.entries(OFFBOARD_TABLES).filter(([, s]) => s.disposition === "DELETE").map(([t]) => t).sort();
  assert.deepEqual([...OFFBOARD_DELETE_ORDER].sort(), xoa, "thứ tự xoá phủ ĐÚNG các bảng XOÁ — không bảng tiền / nhật ký / chung nào");
  for (const t of ["platform_audit_log", "platform_ai_ledger_entries", "platform_billing_payments", "platform_cost_entries", "platform_billing_statements", "platform_signup_attempts", "platform_legal_acceptances"]) {
    assert.ok(!(OFFBOARD_DELETE_ORDER as readonly string[]).includes(t), `${t} không bao giờ bị xoá`);
  }
  const at = (t: string) => OFFBOARD_DELETE_ORDER.indexOf(t as (typeof OFFBOARD_DELETE_ORDER)[number]);
  assert.ok(at("platform_organization_modules") < at("platform_organizations") && at("platform_flag_overrides") < at("platform_organizations"), "bảng con của tổ chức trước dòng tổ chức");
  assert.ok(at("platform_organizations") < at("platform_accounts") && at("platform_product_subscriptions") < at("platform_accounts"), "tài khoản xoá CUỐI (khoá ngoài)");

  // Phân loại: brand + chứng cứ /start; dấu hiệu người vận hành THẮNG.
  assert.equal(classifyOrganization(true, { ...S0, onboardingSource: "OPEN" }), "HOME");
  assert.equal(classifyOrganization(false, { ...S0, onboardingSource: "OPEN" }), "SELF_SIGNUP");
  assert.equal(classifyOrganization(false, { ...S0, signupCreated: 1 }), "SELF_SIGNUP");
  assert.equal(classifyOrganization(false, S0), "UNVERIFIED", "brand mà không chứng cứ ⇒ chưa xác minh, không đoán");
  assert.equal(classifyOrganization(false, { ...S0, brand: null, onboardingSource: "OPEN" }), "UNVERIFIED", "brand NULL ⇒ không bao giờ là tự đăng ký");
  assert.equal(classifyOrganization(false, { ...S0, onboardingSource: "OPEN", brandSetByOperator: 1 }), "OPERATOR_CREATED");
  assert.equal(classifyOrganization(false, { ...S0, signupCreated: 1, createCustomerJobs: 1 }), "OPERATOR_CREATED");
  assert.equal(classifyOrganization(false, { ...S0, onboardingSource: "OPERATOR" }), "OPERATOR_CREATED");

  // Lý do từ chối: mỗi cổng tự đứng được (không dựa vào cổng khác bắt hộ).
  const base = { org: { id: "x", code: "ob-x", status: "ACTIVE", isHome: false, brand: "chotdon" as string | null, accountId: null, createdAt: new Date() }, kind: "SELF_SIGNUP" as const, signals: { ...S0, onboardingSource: "OPEN" }, account: null, tables: [], money: [], database: { name: "erp_org_ob_x", storage: "POSTGRES" as const, exists: true } };
  assert.deepEqual(offboardRefusals(base), [], "tự đăng ký sạch ⇒ không lý do từ chối");
  assert.ok(offboardRefusals({ ...base, kind: "UNVERIFIED", org: { ...base.org, brand: null } }).some((r) => r.includes("brand NULL")), "brand NULL (tổ chức trước 0215 tự đăng ký) ⇒ từ chối");
  assert.ok(offboardRefusals({ ...base, kind: "UNVERIFIED" }).some((r) => r.includes("KHÔNG có chứng cứ")));
  assert.ok(offboardRefusals({ ...base, org: { ...base.org, isHome: true } }).some((r) => r.includes("NHÀ")));
  assert.ok(offboardRefusals({ ...base, tables: [{ table: "platform_ai_ledger_entries", disposition: "BLOCK", rows: 1 }] }).length === 1, "một dòng sổ cái AI ⇒ từ chối");
  assert.ok(offboardRefusals({ ...base, money: [{ key: "paid_invoices", label: "hoá đơn ĐÃ TRẢ", rows: 1 }] }).length === 1, "hoá đơn đã trả ⇒ từ chối");
  assert.ok(offboardRefusals({ ...base, database: { ...base.database, storage: "EXTERNAL" } }).length === 1, "CSDL ở máy khác ⇒ từ chối");
  assert.ok(offboardRefusals({ ...base, account: { id: "a", type: "INTERNAL", workspaces: 1, isHomeAccount: false, deleteAccount: false } }).length === 1, "tài khoản nội bộ ⇒ từ chối");
  assert.deepEqual(["EXTERNAL", "INTERNAL", "", null, "external"].map(offboardDeletableAccountType), [true, false, false, false, false], "vị từ chính sách: chỉ khách ngoài xoá được, loại lạ ⇒ không");
  assert.ok(offboardRefusals({ ...base, database: { ...base.database, name: `erp_org_${"x".repeat(60)}` } }).some((r) => r.includes("63 byte")), "tên CSDL > 63 byte ⇒ từ chối");
  // Điều kiện XOÁ hoá đơn / phiếu nạp không bao giờ khớp dòng ĐÃ TRẢ (lưới cuối nếu mọi lượt đếm lại đều trượt).
  for (const t of ["platform_invoices", "platform_payment_intents"] as const) {
    const w = OFFBOARD_TABLES[t].where?.({ orgId: "x", code: "ob-x", accountId: null, deleteAccount: false });
    assert.ok(w && new PgDialect().sqlToQuery(w).sql.includes("status <> 'PAID'"), `${t}: điều kiện xoá phải loại dòng PAID`);
  }
  // Hoạt động: đơn / kết nối / page — hoặc CSDL còn mà không đọc được ⇒ cần --allow-active.
  const db0 = { readable: true, reason: null, users: 1, orders: 0, activeConnections: [] as string[], activeChannelPages: 0 };
  const dbx = { name: "erp_org_ob_x", storage: "POSTGRES" as const, exists: true };
  assert.equal(offboardHasActivity({ orgDb: db0, messengerPageIds: [], database: dbx }), false);
  assert.equal(offboardHasActivity({ orgDb: { ...db0, orders: 3 }, messengerPageIds: [], database: dbx }), true);
  assert.equal(offboardHasActivity({ orgDb: { ...db0, activeConnections: ["ghn-carrier"] }, messengerPageIds: [], database: dbx }), true);
  assert.equal(offboardHasActivity({ orgDb: db0, messengerPageIds: ["1"], database: dbx }), true);
  assert.equal(offboardHasActivity({ orgDb: { ...db0, readable: false, orders: null }, messengerPageIds: [], database: dbx }), true, "không đọc được CSDL ⇒ chưa biết ≠ không có");
  assert.equal(offboardHasActivity({ orgDb: { ...db0, readable: false, orders: null }, messengerPageIds: [], database: { ...dbx, exists: false } }), false);

  // Ô arg.
  assert.deepEqual(parseOffboardArgs([]), { ok: true, mode: "LIST" });
  assert.deepEqual(parseOffboardArgs(["ob-x"]), { ok: true, mode: "PLAN", code: "ob-x" });
  const CB = "--created-before=2026-10-08T00:00:00Z";
  const cb = new Date("2026-10-08T00:00:00Z");
  assert.deepEqual(parseOffboardArgs(["ob-x", "--apply", "--confirm=ob-x", CB]), { ok: true, mode: "APPLY", code: "ob-x", confirm: "ob-x", createdBefore: cb, allowActive: false, waitMs: 60_000 });
  assert.deepEqual(parseOffboardArgs(["ob-x", "--apply", "--confirm=ob-y", CB, "--allow-active", "--wait=5"]), { ok: true, mode: "APPLY", code: "ob-x", confirm: "ob-y", createdBefore: cb, allowActive: true, waitMs: 5_000 }, "confirm sai vẫn PARSE được — lõi từ chối");
  for (const bad of [
    ["ob-x", "--apply", CB],
    ["ob-x", "--apply", "--confirm=ob-x"],
    ["ob-x", "--apply", "--confirm=ob-x", "--created-before=hôm-qua"],
    ["ob-x", "--confirm=ob-x"],
    ["ob-x", "--allow-active"],
    ["ob-x", CB],
    ["--apply", "--confirm=ob-x", CB],
    ["ob-x", "ob-y"],
    ["ob-x", "--apply", "--confirm=ob-x", CB, "--force"],
    ["Ob_X"],
    ["ob-x", "--apply", "--apply", "--confirm=ob-x", CB],
    ["ob-x", "--apply", "--confirm=ob-x", CB, "--wait=9999"],
  ]) {
    assert.equal(parseOffboardArgs(bad).ok, false, `arg sai phải là lỗi cách dùng: ${bad.join(" ")}`);
  }

  // Sao lưu: in, không chặn; không đọc được ⇒ CẢNH BÁO.
  const warn = backupLines(null, null, { ok: false, reason: "PGlite" }, new Date(), "ob-x");
  assert.ok(warn.filter((l) => l.includes("CẢNH BÁO")).length === 3, "nhà · tổ chức · PITR không đọc được ⇒ ba cảnh báo");
  const t0 = new Date("2026-10-08T02:00:00Z");
  const h = { state: "HEALTHY", reason: "", lastSuccess: { finishedAt: t0 }, ageHours: 1.5 } as unknown as BackupHealth;
  const okLines = backupLines(h, h, { ok: true, lastArchivedAt: t0, failedCount: 0 }, new Date("2026-10-08T03:30:00Z"), "ob-x");
  assert.ok(okLines[0].includes("2026-10-08T02:00:00.000Z") && okLines[2].includes("90 phút trước"), okLines.join(" | "));

  // Mã nguồn: chỉ script ops gọi lõi; không FORCE; không ghi sổ cái AI.
  const goc = process.cwd();
  const walk = (d: string, out: string[] = []): string[] => {
    for (const n of readdirSync(d)) {
      const p = path.join(d, n);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.(ts|tsx)$/.test(n)) out.push(path.relative(goc, p).split(path.sep).join("/"));
    }
    return out;
  };
  const goi = ["lib", "app", "components", "scripts"].flatMap((d) => walk(path.join(goc, d))).filter((f) => f !== "lib/platform/offboard.ts" && /@\/lib\/platform\/offboard["']/.test(readFileSync(f, "utf8")));
  assert.deepEqual(goi, ["scripts/org-offboard.ts"], "lõi xoá tổ chức chỉ có script ops gọi — không trang, không server action");
  const loi = readFileSync("lib/platform/offboard.ts", "utf8");
  assert.ok(!/with\s*\(\s*force\s*\)/i.test(loi), "DROP DATABASE không bao giờ FORCE — cắt kết nối rảnh của ứng dụng làm sập tiến trình");
  assert.ok(!/platformAiLedgerEntries/.test(loi), "lõi không chạm sổ cái Số dư AI");
  const src = readFileSync("scripts/org-offboard.ts", "utf8");
  assert.match(src, /process\.env\.ERP_READ_ONLY = "1"/);
  assert.match(src, /show default_transaction_read_only/);

  const ops = readFileSync(".github/workflows/ops-vps.yml", "utf8");
  assert.match(ops, /- org-offboard\s+#/, "ops-vps khai lựa chọn org-offboard");
  assert.match(ops, /OPS_THAO_TAC_MA_HOA: "[^"]*\borg-offboard\b/, "kết quả org-offboard MÃ HOÁ");
  assert.match(ops, /DOC_NANG="[^"]*\borg-offboard\b/, "mặc định là thao tác ĐỌC (cờ --apply tự thành GHI)");
  assert.match(ops, /\n\s+org-offboard\)\n[\s\S]*?kiem_arg\n\s+ma_hoa_ket_qua chay_voi_arg docker exec erp-app npx tsx --tsconfig tsconfig\.json scripts\/org-offboard\.ts ;;/, "nhánh case chạy đúng script, trong ma_hoa_ket_qua");
  console.log("  ✓ org-offboard (thuần): mỗi bảng platform_* một quyết định · thứ tự xoá không chạm bảng tiền / nhật ký · tự đăng ký = brand + chứng cứ, người vận hành thắng · arg sai ⇒ 64 · sao lưu chỉ cảnh báo · chỉ script ops gọi lõi · không FORCE · ops-vps mã hoá");
}

export async function testWaitForNoConnections() {
  const seq = [2, 1, 0];
  let slept = 0;
  const left = await waitForNoConnections(async () => seq.shift() ?? 0, 60_000, 5_000, async (ms) => void (slept += ms));
  assert.equal(left, 0);
  assert.equal(slept, 10_000, "đợi đúng tới khi về 0");
  let calls = 0;
  const stuck = await waitForNoConnections(async () => (calls += 1, 3), 10_000, 5_000, async () => undefined);
  assert.equal(stuck, 3, "hết trần mà còn kết nối ⇒ trả số còn lại (nơi gọi DỪNG, không cắt ngang)");
  assert.equal(calls, 3);
}

async function hashControlPlane(): Promise<string> {
  const pdb = await getPlatformDb();
  const parts: string[] = [];
  for (const t of CONTROL_PLANE_TABLES) {
    const [r] = rowsOf<{ h: string | null; n: number }>(await pdb.execute(sql`select md5(coalesce(string_agg(x::text, '|' order by x::text), '')) as h, count(*)::int as n from ${sql.raw(t)} x`));
    parts.push(`${t}:${r?.n}:${r?.h}`);
  }
  return parts.join("\n");
}

/** Số dòng của một tổ chức ở mọi bảng XOÁ / GIỮ (để chứng minh tổ chức KHÁC nguyên vẹn). */
async function rowsOfOrg(code: string): Promise<Record<string, number>> {
  const plan = await planOffboard(code);
  assert.ok(plan, `${code} phải còn`);
  return Object.fromEntries(plan.tables.map((t) => [t.table, t.rows]));
}

/** Lựa chọn hợp lệ cho một mã: đúng confirm, mốc tạo trước = 1 giờ sau bây giờ, cho phép tổ chức đang có hoạt động. */
const OK = (code: string): OffboardOptions => ({ confirm: code, createdBefore: new Date(Date.now() + 3_600_000), allowActive: true });

/** Dọn bằng CHÍNH đường xoá: tổ chức thử bị từ chối (brand NULL / người vận hành / có tiền) được «mở khoá» rồi xoá hẳn, kể cả CSDL. */
async function cleanup() {
  const pdb = await getPlatformDb();
  for (const code of [TU_DK, VAN_HANH, BRAND_VH, CO_TIEN, DUA, MO_COI]) {
    await pdb.execute(sql`delete from platform_billing_payments where org_code = ${code}`);
    await pdb.execute(sql`update platform_payment_intents set status = 'EXPIRED', paid_at = null, expires_at = now() - interval '1 day' where org_code = ${code}`);
    await pdb.execute(sql`delete from platform_audit_log where target_org_code = ${code} and action = 'ORG_BRAND_SET'`);
    await pdb.execute(sql`update platform_organizations set brand = 'chotdon', status = 'ACTIVE', settings = jsonb_set(settings, '{onboarding}', '{"source":"OPEN"}'::jsonb) where code = ${code}`);
    invalidateOrganizations();
    const r = await applyOffboard(code, OK(code), {});
    assert.ok(r.outcome === "DONE" || r.outcome === "GONE", `dọn ${code}: ${r.lines.join(" | ")}`);
    await pdb.execute(sql`delete from platform_audit_log where target_org_code = ${code}`);
    await pdb.execute(sql`delete from platform_signup_attempts where organization_code = ${code}`);
  }
  invalidateOrganizations();
  invalidateCapabilities();
}

async function provision(code: string, brand: "chotdon" | "vnx" | null, onboardingSource: string | null) {
  await provisionOrganization({ code, name: TEN, brand, modules: ["customers", "orders"], admin: { email: EMAIL, name: TEN, password: "Offboard@12345" }, source: "TEST", actor: null });
  const pdb = await getPlatformDb();
  if (onboardingSource) {
    await pdb.execute(sql`update platform_organizations set settings = jsonb_set(settings, '{onboarding}', ${JSON.stringify({ source: onboardingSource, adminEmail: EMAIL, state: "DONE" })}::jsonb) where code = ${code}`);
  }
  await withOrganization(code, async () => {
    const db = await getDb();
    await db.update(schema.users).set({ phone: SDT }).where(eq(schema.users.email, EMAIL));
  });
  const [u] = rowsOf<{ id: string }>(await withOrganization(code, async () => (await getDb()).execute(sql`select id from users where email = ${EMAIL}`)));
  // Dòng EMAIL đã do chính lượt cấp phát ghi (P0 08/10/2026 — lib/auth/identities.ts) ⇒ không chèn trùng; vẫn đúng hai dòng.
  await pdb
    .insert(schema.platformIdentities)
    .values([
      { kind: "EMAIL", value: EMAIL, orgCode: code, userId: u.id },
      { kind: "PHONE", value: SDT, orgCode: code, userId: u.id },
    ])
    .onConflictDoNothing();
  await pdb.insert(schema.platformAiUsage).values({ orgCode: code, feature: "sales_chatbot", billingSource: "PLATFORM", requests: 1, status: "OK", costUsd: 0.0123 });
  await pdb.insert(schema.platformOrgMilestones).values({ orgCode: code, milestone: "FIRST_ORDER", reachedAt: new Date(), source: "TEST" });
  await pdb.insert(schema.platformSubscriptions).values({ orgCode: code, billingEnabled: false });
  await pdb.insert(schema.platformAiAccounts).values({ orgCode: code });
  invalidateOrganizations();
}

async function count(q: ReturnType<typeof sql>): Promise<number> {
  const pdb = await getPlatformDb();
  return Number(rowsOf<{ n: number }>(await pdb.execute(q))[0]?.n ?? 0);
}

let bankSeq = 0;
const tienVe = async (code: string) => {
  const pdb = await getPlatformDb();
  bankSeq += 1;
  await pdb.insert(schema.platformBillingPayments).values({ bankRef: `ob-test-${Date.now()}-${bankSeq}`, txnAt: new Date(), amountVnd: 199_000, transferCode: "ERPNAPQWERTY", orgCode: code, outcome: "TOPUP_HELD" });
};

export async function testOrgOffboardDb() {
  await cleanup();
  const pdb = await getPlatformDb();
  await provision(TU_DK, "chotdon", "OPEN");
  await pdb.insert(schema.platformSignupAttempts).values({ mode: "open", ipHash: "f".repeat(64), organizationCode: TU_DK, outcome: "CREATED" });
  await pdb.insert(schema.platformMessengerPages).values({ pageId: PAGE, orgCode: TU_DK, pageName: TEN, connectedByEmail: EMAIL });
  await pdb.insert(schema.platformPaymentIntents).values({ orgCode: TU_DK, amountVnd: 100_000, referenceCode: "ERPNAPABCDEF", status: "EXPIRED", expiresAt: new Date(Date.now() - 86_400_000) });
  await provision(VAN_HANH, null, "OPERATOR");
  await provision(BRAND_VH, "vnx", null);
  await platformAudit({ action: "ORG_BRAND_SET", targetOrgCode: BRAND_VH, subject: "brand", before: { brand: null }, after: { brand: "vnx" }, reason: "kiểm thử", source: "TEST", actor: null });
  await provision(CO_TIEN, "chotdon", "OPEN");
  await tienVe(CO_TIEN);
  // DUA: chứng cứ tự đăng ký CHỈ là lượt đăng ký (không onboarding) — để đo lọc theo mốc tạo; một page Meta để đo câu lỗi gỡ webhook.
  await provision(DUA, "chotdon", null);
  await pdb.insert(schema.platformMessengerPages).values({ pageId: PAGE2, orgCode: DUA });
  const home = await getHomeOrganization();

  try {
    // ── 1 · CHẠY THỬ: không ghi một dòng nào ──
    const truoc = await hashControlPlane();
    const plans = await Promise.all([TU_DK, VAN_HANH, BRAND_VH, CO_TIEN, home.code].map(async (c) => {
      const p = await planOffboard(c);
      assert.ok(p, `${c} có kế hoạch`);
      return p;
    }));
    const [pTu, pVh, pBv, pTien, pHome] = plans;
    assert.equal(pTu.kind, "SELF_SIGNUP");
    assert.deepEqual(pTu.refusals, [], `tự đăng ký sạch ⇒ xoá được: ${pTu.refusals.join(" | ")}`);
    assert.equal(pTu.database.exists, true);
    assert.equal(pTu.orgDb.users, 1);
    assert.equal(pTu.orgDb.orders, 0);
    assert.deepEqual(pTu.messengerPageIds, [PAGE]);
    assert.ok(pTu.account?.deleteAccount, "tài khoản chỉ sở hữu workspace này ⇒ xoá cùng");
    const dong = (p: typeof pTu, t: string) => p.tables.find((x) => x.table === t)?.rows;
    assert.equal(dong(pTu, "platform_identities"), 2);
    assert.equal(dong(pTu, "platform_payment_intents"), 1, "phiếu nạp HẾT HẠN không phải tiền ⇒ xoá");
    assert.equal(dong(pTu, "platform_signup_attempts"), 1, "lượt đăng ký là lịch sử ⇒ GIỮ");
    assert.equal(pVh.kind, "OPERATOR_CREATED");
    assert.ok(pVh.refusals.some((r) => r.includes("brand NULL")));
    assert.equal(pBv.kind, "OPERATOR_CREATED", "brand do người vận hành đặt ⇒ không phải tự đăng ký");
    assert.equal(pTien.kind, "SELF_SIGNUP");
    assert.ok(pTien.refusals.some((r) => r.includes("platform_billing_payments")), "tiền đã về ⇒ từ chối");
    assert.equal(pHome.kind, "HOME");
    assert.ok(pHome.refusals.some((r) => r.includes("NHÀ")));
    for (const p of plans) {
      const { summary, detail } = offboardPlanLines(p);
      for (const l of [...summary, ...detail]) for (const bimat of [TEN, EMAIL, SDT]) assert.ok(!l.includes(bimat), `dòng in mang dữ liệu người: ${l}`);
      for (const l of summary) assert.ok(!l.includes(PAGE), "mã page chỉ ở phần mã hoá");
    }
    assert.ok(offboardPlanLines(pTu).summary.some((l) => l.includes("đơn 0") && l.includes("--allow-active")), "kênh tóm tắt in số đơn + cảnh báo hoạt động (page Meta)");
    assert.equal(await hashControlPlane(), truoc, "chạy thử KHÔNG ghi gì vào mặt phẳng điều khiển");
    // L3: lượt đăng ký CŨ hơn mốc tạo tổ chức (mã từng thuộc tổ chức khác) KHÔNG là chứng cứ.
    const taoDua = (await planOffboard(DUA))!.org.createdAt;
    await pdb.insert(schema.platformSignupAttempts).values({ mode: "open", ipHash: "e".repeat(64), organizationCode: DUA, outcome: "CREATED", at: new Date(taoDua.getTime() - 3 * 86_400_000) });
    assert.equal((await planOffboard(DUA))!.kind, "UNVERIFIED", "lượt đăng ký từ trước khi tạo tổ chức ⇒ không phải chứng cứ");
    await pdb.insert(schema.platformSignupAttempts).values({ mode: "open", ipHash: "e".repeat(64), organizationCode: DUA, outcome: "CREATED" });
    assert.equal((await planOffboard(DUA))!.kind, "SELF_SIGNUP");
    const truoc2 = await hashControlPlane();

    // ── 2 · TỪ CHỐI: sai / thiếu confirm · thiếu / sai mốc tạo · đang hoạt động mà không --allow-active · nhà · brand NULL · brand
    //        người vận hành · có tiền · hoá đơn MỞ / phiếu nạp còn hạn — không ghi gì ──
    const tuChoi = async (code: string, o: OffboardOptions, can: string) => {
      const r = await applyOffboard(code, o, {});
      assert.equal(r.outcome, "REFUSED", `${code} phải bị từ chối (${can})`);
      assert.ok(r.outcome === "REFUSED" && r.refusals.some((x) => x.includes(can)), `${code}: thiếu lý do «${can}» trong ${r.lines.join(" | ")}`);
    };
    await tuChoi(TU_DK, { ...OK(TU_DK), confirm: "ob-tudk-sai" }, "--confirm");
    await tuChoi(TU_DK, { ...OK(TU_DK), confirm: null }, "--confirm");
    await tuChoi(TU_DK, { ...OK(TU_DK), createdBefore: null }, "--created-before");
    await tuChoi(TU_DK, { ...OK(TU_DK), createdBefore: new Date(pTu.org.createdAt.getTime() - 1000) }, "KHÔNG trước mốc");
    await tuChoi(TU_DK, { ...OK(TU_DK), allowActive: false }, "--allow-active");
    await tuChoi(home.code, OK(home.code), "NHÀ");
    await tuChoi(VAN_HANH, OK(VAN_HANH), "brand NULL");
    await tuChoi(BRAND_VH, OK(BRAND_VH), "NGƯỜI VẬN HÀNH");
    await tuChoi(CO_TIEN, OK(CO_TIEN), "platform_billing_payments");
    assert.equal(await hashControlPlane(), truoc2, "từ chối KHÔNG ghi gì (kể cả nhật ký)");
    await pdb.insert(schema.platformPaymentIntents).values({ orgCode: DUA, amountVnd: 50_000, referenceCode: "ERPNAPZXCVBN", status: "PENDING", expiresAt: new Date(Date.now() + 86_400_000) });
    const truoc3 = await hashControlPlane();
    await tuChoi(DUA, OK(DUA), "phiếu nạp còn HẠN");
    assert.equal(await hashControlPlane(), truoc3, "từ chối vì phiếu nạp còn hạn KHÔNG ghi gì");
    await pdb.execute(sql`update platform_payment_intents set status = 'EXPIRED', expires_at = now() - interval '1 hour' where org_code = ${DUA}`);

    // ── 3 · TIỀN VỀ GIỮA CHỪNG (MEDIUM-1): trước DROP ⇒ dừng, CSDL + dòng nguyên; trong giao dịch xoá ⇒ hoàn tác, không xoá dòng nào ──
    const metaLoi = async () => {
      throw new Error("BI-MAT-LOI-META token=EAAxyz");
    };
    const r1 = await applyOffboard(DUA, OK(DUA), { unsubscribeMeta: metaLoi, hook: async (ph) => (ph === "BEFORE_DROP" ? tienVe(DUA) : undefined) });
    assert.equal(r1.outcome, "MONEY_ARRIVED", r1.lines.join("\n"));
    assert.ok(r1.lines.some((l) => l.includes("HỎNG") && l.includes("CẦN GỠ TAY")), "L1: kênh tóm tắt chỉ in HỎNG + cần gỡ tay");
    assert.ok(r1.lines.every((l) => !l.includes("BI-MAT") && !l.includes(PAGE2)), "L1: câu lỗi / mã page KHÔNG ra kênh tóm tắt");
    assert.ok(r1.detail.some((l) => l.includes("BI-MAT-LOI-META")), "L1: câu lỗi nằm ở phần mã hoá");
    const pDua1 = await planOffboard(DUA);
    assert.ok(pDua1 && pDua1.org.status === "SUSPENDED" && pDua1.database.exists === true, "dừng trước DROP: tổ chức ĐÌNH CHỈ, CSDL còn");
    assert.equal(dong(pDua1, "platform_identities"), 2, "không xoá dòng nào");
    await pdb.execute(sql`delete from platform_billing_payments where org_code = ${DUA}`);
    // L2: tổ chức ĐÃ ĐÌNH CHỈ vẫn được gọi gỡ webhook (token đọc qua handle chỉ đọc khi CSDL còn).
    const goiDua: string[] = [];
    const r2 = await applyOffboard(DUA, OK(DUA), {
      unsubscribeMeta: async (_c, ids) => (goiDua.push(...ids), { ok: 0, failed: ids.length, note: null }),
      hook: async (ph) => (ph === "BEFORE_DELETE" ? tienVe(DUA) : undefined),
    });
    assert.deepEqual(goiDua, [PAGE2], "L2: gỡ webhook không phụ thuộc trạng thái ACTIVE");
    assert.ok(r2.lines.some((l) => l.includes("1 page CẦN GỠ TAY")), "L2: không gỡ được ⇒ in số page cần gỡ tay");
    assert.equal(r2.outcome, "MONEY_ARRIVED", r2.lines.join("\n"));
    const pDua2 = await planOffboard(DUA);
    assert.ok(pDua2 && pDua2.database.exists === false, "CSDL đã xoá trước giao dịch");
    assert.equal(dong(pDua2, "platform_identities"), 2, "giao dịch xoá HOÀN TÁC — không một dòng nào mất");
    assert.equal(await count(sql`select count(*)::int as n from platform_organizations where code = ${DUA}`), 1);
    const subj = (await pdb.select().from(schema.platformAuditLog).where(eq(schema.platformAuditLog.targetOrgCode, DUA))).filter((x) => x.action === "ORG_OFFBOARD").map((x) => x.subject).sort();
    assert.deepEqual(subj, ["offboard:start", "offboard:start", "offboard:stopped", "offboard:stopped"], "mỗi lượt dừng có nhật ký");
    // CSDL đã mất ⇒ lượt sau KHÔNG gọi gỡ webhook (không còn token), in «cần gỡ tay».
    await pdb.execute(sql`delete from platform_billing_payments where org_code = ${DUA}`);
    const goiDua3: string[] = [];
    const r3 = await applyOffboard(DUA, OK(DUA), { unsubscribeMeta: async (_c, ids) => (goiDua3.push(...ids), { ok: ids.length, failed: 0, note: null }) });
    assert.equal(r3.outcome, "DONE", r3.lines.join("\n"));
    assert.deepEqual(goiDua3, []);
    assert.ok(r3.lines.some((l) => l.includes("CSDL tổ chức không còn") && l.includes("1 page CẦN GỠ TAY")));

    // ── 4 · XOÁ ĐÚNG (tổ chức đã ĐÌNH CHỈ từ trước — L2) ──
    await pdb.execute(sql`update platform_organizations set status = 'SUSPENDED' where code = ${TU_DK}`);
    invalidateOrganizations();
    const vhTruoc = await rowsOfOrg(VAN_HANH);
    const bvTruoc = await rowsOfOrg(BRAND_VH);
    const goiMeta: string[][] = [];
    const r = await applyOffboard(TU_DK, OK(TU_DK), {
      unsubscribeMeta: async (code, ids) => {
        assert.equal(code, TU_DK);
        goiMeta.push([...ids]);
        return { ok: ids.length, failed: 0, note: null };
      },
    });
    assert.equal(r.outcome, "DONE", r.lines.join("\n"));
    assert.deepEqual(goiMeta, [[PAGE]], "gỡ đăng ký webhook Meta đúng page, kể cả khi tổ chức đã đình chỉ");
    assert.ok(r.outcome === "DONE" && Object.values(r.remaining).every((n) => n === 0), "0 dòng còn lại ở mọi bảng XOÁ");
    for (const l of r.lines) for (const bimat of [TEN, EMAIL, SDT, PAGE]) assert.ok(!l.includes(bimat), `log công khai mang dữ liệu: ${l}`);
    assert.equal(await planOffboard(TU_DK), null, "tổ chức không còn trong sổ");
    assert.ok(!existsSync(organizationDatabaseUrl({ code: TU_DK, isHome: false }).replace(/^pglite:\/\//, "")), "CSDL của tổ chức đã xoá");
    for (const t of OFFBOARD_DELETE_ORDER) {
      const col = t === "platform_organizations" ? "code" : t === "platform_organization_modules" || t === "platform_flag_overrides" ? null : t === "platform_accounts" ? null : "org_code";
      if (!col) continue;
      assert.equal(await count(sql`select count(*)::int as n from ${sql.raw(t)} where ${sql.raw(col)} = ${TU_DK}`), 0, `${t} còn dòng của tổ chức đã xoá`);
    }
    assert.equal(await count(sql`select count(*)::int as n from platform_identities where value in (${EMAIL}, ${SDT}) and org_code = ${TU_DK}`), 0, "danh tính email / SĐT đã xoá");
    const nk = await pdb.select().from(schema.platformAuditLog).where(eq(schema.platformAuditLog.targetOrgCode, TU_DK));
    assert.ok(nk.some((x) => x.action === "ORG_CREATE"), "nhật ký cũ CÒN");
    const off = nk.filter((x) => x.action === "ORG_OFFBOARD");
    assert.deepEqual(off.map((x) => x.subject).sort(), ["offboard:done", "offboard:start"]);
    assert.ok(off.every((x) => x.source === "SCRIPT" && x.actorUserId === null));
    const start = off.find((x) => x.subject === "offboard:start")!;
    const done = off.find((x) => x.subject === "offboard:done")!;
    assert.ok(start.at.getTime() <= done.at.getTime(), "nhật ký start ghi TRƯỚC");
    for (const bimat of [TEN, EMAIL, SDT, PAGE]) assert.ok(!JSON.stringify(off).includes(bimat), "nhật ký ORG_OFFBOARD không mang dữ liệu người / mã page");
    assert.equal(await count(sql`select count(*)::int as n from platform_signup_attempts where organization_code = ${TU_DK}`), 1, "lượt đăng ký (lịch sử) còn");

    // Hai tổ chức kia nguyên vẹn (cả CSDL lẫn mặt phẳng điều khiển).
    assert.deepEqual(await rowsOfOrg(VAN_HANH), vhTruoc);
    assert.deepEqual(await rowsOfOrg(BRAND_VH), bvTruoc);
    const nguoi = await withOrganization(VAN_HANH, async () => rowsOf<{ n: number }>(await (await getDb()).execute(sql`select count(*)::int as n from users`)));
    assert.equal(nguoi[0].n, 1, "CSDL tổ chức người vận hành tạo vẫn mở được, dữ liệu còn");

    // ── 5 · CHẠY LẠI: idempotent; L6: start chưa có done ⇒ ghi bù done đúng một lần ──
    const sau = await hashControlPlane();
    const lai = await applyOffboard(TU_DK, OK(TU_DK), {});
    assert.equal(lai.outcome, "GONE");
    assert.ok(lai.lines[0].includes("không có tổ chức") && !lai.lines[0].includes("ghi bù"));
    assert.equal(await hashControlPlane(), sau, "chạy lại không ghi gì");
    await platformAudit({ action: "ORG_OFFBOARD", targetOrgCode: MO_COI, subject: "offboard:start", after: { phase: "STARTED" }, source: "TEST", actor: null });
    const bu = await applyOffboard(MO_COI, OK(MO_COI), {});
    assert.ok(bu.outcome === "GONE" && bu.lines[0].includes("ghi bù"), bu.lines.join(" | "));
    assert.equal(await count(sql`select count(*)::int as n from platform_audit_log where target_org_code = ${MO_COI} and subject = 'offboard:done'`), 1);
    const sau2 = await hashControlPlane();
    await applyOffboard(MO_COI, OK(MO_COI), {});
    assert.equal(await hashControlPlane(), sau2, "đã có done ⇒ không ghi bù lần hai");
    console.log("  ✓ org-offboard (CSDL): chạy thử không ghi · sai / thiếu confirm, thiếu / sai --created-before, đang hoạt động thiếu --allow-active, nhà, brand NULL, brand người vận hành, có tiền, phiếu nạp còn hạn ⇒ từ chối, không ghi · tiền về trước DROP ⇒ dừng, CSDL + dòng nguyên; tiền về trong giao dịch ⇒ hoàn tác · lượt đăng ký cũ hơn mốc tạo không là chứng cứ · gỡ webhook không cần ACTIVE, lỗi chỉ ở phần mã hoá · xoá đúng ⇒ mọi bảng XOÁ = 0, CSDL mất, nhật ký còn + start/done, tổ chức khác nguyên vẹn · chạy lại ⇒ không có tổ chức; start mồ côi ⇒ ghi bù done một lần");
    console.log("  ⚠ org-offboard: nhánh Postgres (đợi pg_stat_activity + DROP DATABASE không FORCE) CHƯA ĐO ĐƯỢC trên PGlite — chỉ hàm đợi thuần được kiểm (testWaitForNoConnections)");
  } finally {
    await cleanup();
  }
}
