/**
 * Chủ shop tự duyệt lương (chủ shop 21/10/2026) — `lib/constants/org-owner.ts`.
 *
 * Khoá: (1) chỉ người khai ở `org.owner` được miễn người thứ hai, và chỉ khi id khớp + tài khoản còn bật + ADMIN;
 * (2) kế toán / ADMIN khác / lời khai hỏng ⇒ vẫn chờ người thứ hai; (3) mỗi lần miễn để lại nhật ký có câu quy định;
 * (4) không có đường ghi `org.owner` nào trong ứng dụng — chỉ ops `set-setting`.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { and, eq, inArray, like } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { isDeclaredOwner, ORG_OWNER_KEY, OWNER_SELF_APPROVAL_GROUPS, OWNER_SELF_APPROVAL_REASON, parseOrgOwner } from "@/lib/constants/org-owner";
import { APPROVAL_ENFORCE_KEY } from "@/lib/constants/approval";
import { guardSecondApprovalCore } from "@/lib/approvals/service";
import { profitApprovalProblem } from "@/lib/payroll/profit-reconciliation";

const P = "oo-";

function testPure() {
  for (const hong of [null, "", "khong-phai-json", "[]", "\"53abf971\"", "{}", "{\"userId\":\"  \"}", "{\"userId\":5}"]) {
    assert.equal(parseOrgOwner(hong), null, `lời khai hỏng ${JSON.stringify(hong)} ⇒ không có chủ shop nào được miễn`);
  }
  const decl = parseOrgOwner(JSON.stringify({ userId: "u1", decidedAt: "2026-10-21", note: "chủ shop chốt 21/10" }));
  assert.deepEqual(decl, { userId: "u1", decidedAt: "2026-10-21", note: "chủ shop chốt 21/10" });
  assert.equal(isDeclaredOwner(decl, { id: "u1", active: true, role: "ADMIN" }), true, "đúng id · còn bật · ADMIN ⇒ chủ shop");
  assert.equal(isDeclaredOwner(decl, { id: "u2", active: true, role: "ADMIN" }), false, "ADMIN KHÁC không phải chủ shop");
  assert.equal(isDeclaredOwner(decl, { id: "u1", active: false, role: "ADMIN" }), false, "tài khoản đã tắt ⇒ về luật hai người");
  assert.equal(isDeclaredOwner(decl, { id: "u1", active: true, role: "MANAGER" }), false, "bị hạ vai trò ⇒ về luật hai người");
  assert.equal(isDeclaredOwner(null, { id: "u1", active: true, role: "ADMIN" }), false, "chưa khai ⇒ không ai được miễn (không suy từ vai trò)");
  assert.deepEqual([...OWNER_SELF_APPROVAL_GROUPS], ["PAYROLL_EDIT"], "chỉ nhóm lương — chủ shop không nói gì về nhóm khác");

  // Ký đối soát cấp 1 vs DUYỆT kỳ có thưởng.
  const ky = { id: "s1", monthKey: "2029-01", fingerprint: "fp", signedById: "u1", signedByEmail: "u1@t", revokedAt: null };
  const base = { allocatedTotal: 1, monthKey: "2029-01", snapshotFingerprint: "fp", signoffs: [ky], actorId: "u1", requireDifferentPerson: true };
  assert.match(profitApprovalProblem(base) ?? "", /MỘT NGƯỜI KHÁC/, "người ký không tự duyệt");
  assert.equal(profitApprovalProblem({ ...base, actorIsOwner: true }), null, "chủ shop vừa ký vừa duyệt được");
  assert.match(profitApprovalProblem({ ...base, actorIsOwner: true, signoffs: [] }) ?? "", /CHƯA có chữ ký/, "miễn người thứ hai KHÔNG miễn chữ ký cấp 1");
}

function testSourceFences() {
  // Không đường ghi `org.owner` nào trong ứng dụng: khoá chỉ được NHẮC ở bản khai và tệp đọc.
  const tep = execFileSync("git", ["ls-files", "lib", "app", "components", "db"], { encoding: "utf8" }).split("\n").filter((f) => /\.(ts|tsx)$/.test(f));
  const choPhep = new Set(["lib/constants/org-owner.ts", "lib/auth/org-owner.ts"]);
  for (const f of tep) {
    if (choPhep.has(f)) continue;
    const s = readFileSync(f, "utf8");
    assert.ok(!s.includes("ORG_OWNER_KEY") && !s.includes('"org.owner"'), `${f}: không được đọc / ghi khoá org.owner ngoài lib/auth/org-owner.ts — chỉ ops set-setting ghi được`);
  }
  const doc = readFileSync("lib/auth/org-owner.ts", "utf8");
  assert.ok(!/\.(insert|update|delete)\(|setSetting/.test(doc), "tệp đọc chủ shop CHỈ ĐỌC");
  // Ba chỗ miễn đều đi qua isOrgOwner — không chỗ nào hỏi vai trò ADMIN thay.
  const pol = readFileSync("lib/actions/payroll-policy.ts", "utf8");
  assert.ok(/const chuTuDuyet = Boolean\(row\.enteredBy && row\.enteredBy === guard\.id\) && \(await isOrgOwner\(db, guard\.id\)\);/.test(pol), "người nhập tự duyệt chỉ khi là chủ shop đã khai");
  assert.ok(pol.includes("if (row.enteredBy && row.enteredBy === guard.id && !chuTuDuyet)"), "người nhập khác vẫn bị chặn");
  const run = readFileSync("lib/payroll/run-service.ts", "utf8");
  assert.ok(/chuShopDuyet = action === "APPROVE" && \(await isOrgOwner\(tx, actor\.id\)\);/.test(run), "duyệt kỳ: chủ shop đọc trong giao dịch, chỉ ở bước DUYỆT");
  const svc = readFileSync("lib/approvals/service.ts", "utf8");
  assert.ok(/OWNER_SELF_APPROVAL_GROUPS\.includes\(input\.group\) && \(await isOrgOwner\(db, user\.id\)\)/.test(svc), "cổng người thứ hai: miễn theo khai báo, không theo vai trò");
}

async function testGuard(db: Db) {
  const s = schema.settings;
  const truoc = await db.select().from(s).where(inArray(s.key, [ORG_OWNER_KEY, APPROVAL_ENFORCE_KEY]));
  const users = [
    { id: `${P}chu`, role: "ADMIN" },
    { id: `${P}kt`, role: "ACCOUNTANT" },
    { id: `${P}admin2`, role: "ADMIN" },
  ] as const;
  for (const u of users) await db.insert(schema.users).values({ id: u.id, email: `${u.id}@t.local`, name: u.id, role: u.role, passwordHash: "x", active: true }).onConflictDoNothing();
  const ghiSetting = async (key: string, value: unknown) => {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    await db.insert(s).values({ key, value: text }).onConflictDoUpdate({ target: s.key, set: { value: text } });
  };
  const hoi = (id: string, action = "payroll.profit-gate.policy") =>
    guardSecondApprovalCore(db, { id, email: `${id}@t.local` }, { group: "PAYROLL_EDIT", action, entity: "SETTINGS", entityId: `${P}gate`, summary: "kiểm thử quy chế cổng", amount: null, payload: { n: 1 } });
  try {
    await ghiSetting(APPROVAL_ENFORCE_KEY, { v: 2, groups: { PAYROLL_EDIT: true } });
    await db.delete(s).where(eq(s.key, ORG_OWNER_KEY));
    assert.equal((await hoi(`${P}chu`)).mode, "NEEDS_APPROVAL", "chưa khai org.owner ⇒ ADMIN cũng chờ người thứ hai (không suy từ vai trò)");

    await ghiSetting(ORG_OWNER_KEY, { userId: `${P}chu`, decidedAt: "2026-10-21", note: "kiểm thử" });
    const chu = await hoi(`${P}chu`, "payroll.kiem-thu-chu");
    assert.equal(chu.mode, "PROCEED", "chủ shop tự lưu ⇒ có hiệu lực ngay");
    const [nk] = await db
      .select({ reason: schema.auditLogs.reason, userId: schema.auditLogs.userId })
      .from(schema.auditLogs)
      .where(and(eq(schema.auditLogs.action, "approval.owner-self:payroll.kiem-thu-chu"), eq(schema.auditLogs.userId, `${P}chu`)));
    assert.equal(nk?.reason, OWNER_SELF_APPROVAL_REASON, "nhật ký ghi rõ chủ shop tự duyệt theo quy định 21/10");

    assert.equal((await hoi(`${P}kt`)).mode, "NEEDS_APPROVAL", "kế toán lập ⇒ chờ chủ shop duyệt như cũ");
    assert.equal((await hoi(`${P}admin2`)).mode, "NEEDS_APPROVAL", "ADMIN khác không được miễn");

    await db.update(schema.users).set({ active: false }).where(eq(schema.users.id, `${P}chu`));
    assert.equal((await hoi(`${P}chu`)).mode, "NEEDS_APPROVAL", "tài khoản chủ shop bị tắt ⇒ về luật hai người");
    await db.update(schema.users).set({ active: true, role: "MANAGER" }).where(eq(schema.users.id, `${P}chu`));
    assert.equal((await hoi(`${P}chu`)).mode, "NEEDS_APPROVAL", "bị hạ vai trò ⇒ về luật hai người");
    await db.update(schema.users).set({ role: "ADMIN" }).where(eq(schema.users.id, `${P}chu`));
    await ghiSetting(ORG_OWNER_KEY, "khong-phai-json");
    assert.equal((await hoi(`${P}chu`)).mode, "NEEDS_APPROVAL", "lời khai hỏng ⇒ về luật hai người");
  } finally {
    await db.delete(s).where(inArray(s.key, [ORG_OWNER_KEY, APPROVAL_ENFORCE_KEY]));
    for (const r of truoc) await db.insert(s).values(r);
    await db.delete(schema.approvalRequests).where(like(schema.approvalRequests.requestedByEmail, `${P}%`));
    await db.delete(schema.users).where(like(schema.users.id, `${P}%`));
  }
}

export async function testOrgOwner(db: Db) {
  testPure();
  testSourceFences();
  await testGuard(db);
  console.log(
    "✓ Chủ shop tự duyệt lương (21/10/2026): chỉ người khai ở org.owner (id · còn bật · ADMIN), chỉ nhóm PAYROLL_EDIT · kế toán / ADMIN khác / lời khai hỏng ⇒ vẫn chờ người thứ hai · nhật ký ghi câu quy định · chủ shop vừa ký vừa duyệt kỳ có thưởng, chữ ký cấp 1 vẫn bắt buộc · không đường ghi org.owner nào trong ứng dụng",
  );
}
