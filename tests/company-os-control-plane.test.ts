import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import type { Role } from "@/db/schema";
import {
  applyLegacyEnforceCore,
  approvalFingerprint,
  approvalStillValid,
  approvalValidSince,
  consumeApprovedRequest,
  decideApprovalCore,
  guardSecondApprovalCore,
  readEnforceConfig,
  readLegacyEnforce,
  setEnforceGroupCore,
  type GuardInput,
} from "@/lib/approvals/service";
import { audit, inferActorKind } from "@/lib/audit";
import { effectiveAccess, type CustomRole } from "@/lib/auth/access";
import { ALL_PERMISSIONS, DEFAULT_ROLE_PERMISSIONS, resolvePermissions, type RolePermissionMap } from "@/lib/auth/permissions";
import { can, type SessionUser } from "@/lib/auth/session";
import { memo, trongJobNen } from "@/lib/cache";
import { APPROVAL_ENFORCE_KEY, APPROVAL_ENFORCE_LEGACY_KEY, APPROVAL_GROUPS, APPROVAL_GROUPS_WIRED, APPROVAL_VALID_HOURS, canonicalJson, isEnforced, legacyToV2, parseEnforceConfig } from "@/lib/constants/approval";
import { ROLE_BUILDER_FORBIDDEN } from "@/lib/constants/access-scope";
import { ROLE_ORDER } from "@/lib/constants/roles";
import { WORK_SOURCE_SPEC } from "@/lib/constants/work-sources";
import { DEFAULT_OWNERSHIP_MAP } from "@/lib/constants/work-ownership";
import { DEFAULT_SLA_MAP } from "@/lib/constants/work-sla";
import { collectWorkItems } from "@/lib/queries/work-adapters";
import { runJob } from "@/lib/sync/jobs";
import { runSyncJob } from "@/lib/sync/runner";
import { saveAccessRoleSchema } from "@/lib/validation/access";

/**
 * ═══════════ COMPANY OS · AGENT G · MẶT PHẲNG ĐIỀU KHIỂN ═══════════
 *
 * Sáu điều bài này khoá, mỗi điều là một chỗ đã hỏng thật hoặc sẽ hỏng im lặng:
 *
 *  1. Duyệt hai bước HOÀN TẤT ĐƯỢC: lời duyệt được TIÊU THỤ đúng một lần, đúng việc, đúng người,
 *     trong hạn — và cưỡng chế ĐỌC ĐƯỢC cấu hình (bản cũ đọc chuỗi JSON thô nên không bao giờ bật).
 *  2. Quyền `approvals:decide` = ĐÚNG tập người duyệt được trước khi có khoá, cho cả 8 vai.
 *  3. Nguồn việc `APPROVAL` là PHÉP CHIẾU: có khi đang chờ, tự biến mất khi đã quyết.
 *  4. `audit_logs` ghi ba cột mới, và CSDL từ chối loại tác nhân lạ.
 *  5. Năm job nay có dòng `sync_runs` — và bọc chúng KHÔNG đổi việc chúng làm (không làm cũ đệm).
 *
 * Không mốc ngày tuyệt đối nào (AGENTS.md mục 50, 65): mọi mốc dựng từ MỘT `now` truyền vào lõi.
 */

const P = "cosg-";

async function donDep(db: Db) {
  // Agent K: `approval.executed` đã LIVE — sự kiện của người thử (USER, CHECK cấm actor_id NULL) phải đi
  // trước tài khoản, nếu không ON DELETE SET NULL đụng CHECK và lượt dọn đổ.
  await db.delete(schema.domainEvents).where(and(eq(schema.domainEvents.name, "approval.executed"), like(schema.domainEvents.actorId, `${P}%`)));
  await db.delete(schema.auditLogs).where(like(schema.auditLogs.userEmail, `${P}%`));
  await db.delete(schema.approvalRequests).where(like(schema.approvalRequests.requestedByEmail, `${P}%`));
  await db.delete(schema.users).where(like(schema.users.id, `${P}%`));
  await db.delete(schema.settings).where(inArray(schema.settings.key, [APPROVAL_ENFORCE_KEY, APPROVAL_ENFORCE_LEGACY_KEY]));
}

function nguoi(id: string, role: Role, permissions: string[]): SessionUser {
  return { id, email: `${id}@t.local`, name: id, role, permissions, scope: "ALL", departmentCodes: [], positionId: null };
}

/** Luật CŨ, chép nguyên văn từ `lib/actions/approvals.ts` trước Company OS — thước để so. */
function luatCu(u: SessionUser): boolean {
  return can(u, "settings:manage") || u.role === "ADMIN" || u.role === "MANAGER";
}

export async function testCompanyOsControlPlane(db: Db) {
  await donDep(db);

  /* ═══════════ 1a · DẤU VÂN TAY ỔN ĐỊNH ═══════════ */
  assert.equal(canonicalJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: undefined } }), canonicalJson({ a: { d: [1, { x: 1, y: 2 }] }, b: 1 }), "thứ tự khoá không được đổi dấu vân tay");
  const ngay = new Date(Date.UTC(2020, 0, 1));
  assert.equal(canonicalJson({ t: ngay }), JSON.stringify({ t: ngay.toISOString() }), "Date chuẩn hoá thành ISO như jsonb lưu");
  const goc: GuardInput = { group: "INVENTORY_ADJUSTMENT", action: "stock.adjustment", entity: "STOCK_RECEIPT", summary: "Điều chỉnh 2 mẫu", amount: 3_000_000, payload: { items: [{ v: "a", q: -2 }], note: "kiểm kê" } };
  const chuKhac: GuardInput = { ...goc, summary: "chữ khác" };
  assert.equal(approvalFingerprint(goc), approvalFingerprint(chuKhac), "đổi CHỮ mô tả không đổi việc");
  assert.notEqual(approvalFingerprint(goc), approvalFingerprint({ ...goc, payload: { items: [{ v: "a", q: -3 }], note: "kiểm kê" } }), "đổi một con số là một việc KHÁC");
  assert.notEqual(approvalFingerprint(goc), approvalFingerprint({ ...goc, action: "stock.issue" }), "đổi thao tác là một việc khác");

  /* ═══════════ 1b · CẤU HÌNH CƯỠNG CHẾ: CHỈ BẢN v2 DO CÔNG TẮC GHI MỚI CÓ HIỆU LỰC ═══════════ */
  const now = new Date();
  await db.insert(schema.users).values([
    { id: `${P}xin`, email: `${P}xin@t.local`, name: "Người xin", role: "MANAGER", passwordHash: "x", active: true },
    { id: `${P}xin2`, email: `${P}xin2@t.local`, name: "Người xin khác", role: "LEADER", passwordHash: "x", active: true },
    { id: `${P}duyet`, email: `${P}duyet@t.local`, name: "Người duyệt", role: "ADMIN", passwordHash: "x", active: true },
  ]);
  const xin = { id: `${P}xin`, email: `${P}xin@t.local` };
  const xin2 = { id: `${P}xin2`, email: `${P}xin2@t.local` };
  const duyet = { id: `${P}duyet`, email: `${P}duyet@t.local`, canDecide: true };
  const quanTri = { id: duyet.id, email: duyet.email, isAdmin: true };

  // `settings.value` là TEXT. Bản cũ đưa thẳng chuỗi vào `isEnforced` ⇒ luôn TẮT.
  assert.equal(isEnforced('{"INVENTORY_ADJUSTMENT":true}', "INVENTORY_ADJUSTMENT"), false, "tiền đề: isEnforced nhận CHUỖI thì luôn tắt — đúng lỗi của bản cũ");
  assert.equal(isEnforced(parseEnforceConfig('{"v":2,"groups":{"INVENTORY_ADJUSTMENT":true}}'), "INVENTORY_ADJUSTMENT"), true, "chuỗi v2 đã parse thì bật được");
  assert.equal(parseEnforceConfig('{"INVENTORY_ADJUSTMENT":true}'), null, "hình dạng CŨ không bao giờ có hiệu lực — kể cả khi nằm ở khoá mới");
  assert.equal(parseEnforceConfig('{"v":1,"groups":{"INVENTORY_ADJUSTMENT":true}}'), null, "thiếu dấu v2 thì không có hiệu lực");
  assert.equal(parseEnforceConfig("không phải json"), null, "chuỗi hỏng ⇒ TẮT, không ném lỗi");
  assert.equal(parseEnforceConfig("[true]"), null, "mảng không phải cấu hình theo nhóm");
  assert.notEqual(APPROVAL_ENFORCE_KEY, APPROVAL_ENFORCE_LEGACY_KEY, "khoá có hiệu lực phải KHÁC khoá cũ");

  // DÒNG CŨ trên production (gõ tay theo hướng dẫn cũ) KHÔNG được tự có hiệu lực sau deploy.
  const dongCu = '{"INVENTORY_ADJUSTMENT":true,"PAYROLL_EDIT":true,"COD_CORRECTION":true,"NHOM_LA":true}';
  await db.insert(schema.settings).values({ key: APPROVAL_ENFORCE_LEGACY_KEY, value: dongCu });
  assert.equal(await readEnforceConfig(db), null, "chỉ có dòng cũ ⇒ cưỡng chế TẮT");
  const khongBat = await guardSecondApprovalCore(db, xin, goc, now);
  assert.equal(khongBat.mode, "PROCEED", "dòng cũ KHÔNG được chặn việc thật của chủ shop");
  // Hiện được cho quản trị viên, và chuyển đổi đúng.
  const cu0 = await readLegacyEnforce(db);
  assert.deepEqual(cu0?.groups, ["INVENTORY_ADJUSTMENT", "PAYROLL_EDIT", "COD_CORRECTION"]);
  const chuyen = legacyToV2(cu0!);
  assert.deepEqual(chuyen.config, { v: 2, groups: { INVENTORY_ADJUSTMENT: true, PAYROLL_EDIT: true } }, "chỉ nhóm ĐÃ NỐI vào v2");
  assert.deepEqual(chuyen.ignored, ["COD_CORRECTION", "NHOM_LA"], "nhóm chưa nối và khoá lạ được nói ra, không lặng lẽ bỏ");

  // Công tắc ghi v2 (người không phải ADMIN bị chặn).
  assert.ok("error" in (await setEnforceGroupCore(db, { ...quanTri, isAdmin: false }, "EXPENSE_EDIT", true)), "chỉ ADMIN bật được");
  assert.ok("error" in (await setEnforceGroupCore(db, quanTri, "COD_CORRECTION", true)), "nhóm chưa nối không bật được");
  assert.ok("ok" in (await setEnforceGroupCore(db, quanTri, "EXPENSE_EDIT", true)));
  const [v2Row] = await db.select().from(schema.settings).where(eq(schema.settings.key, APPROVAL_ENFORCE_KEY));
  assert.deepEqual(JSON.parse(v2Row.value), { v: 2, groups: { EXPENSE_EDIT: true } }, "công tắc ghi đúng hình dạng v2");
  assert.equal(isEnforced(await readEnforceConfig(db), "EXPENSE_EDIT"), true, "v2 ⇒ bật đúng nhóm");
  assert.equal(isEnforced(await readEnforceConfig(db), "INVENTORY_ADJUSTMENT"), false, "v2 không kéo theo nhóm của dòng cũ");

  // Nút "Áp dụng cấu hình này": v2 = đúng dòng cũ (thay công tắc hiện tại), dòng cũ để nguyên.
  assert.ok("error" in (await applyLegacyEnforceCore(db, { ...quanTri, isAdmin: false })), "chỉ ADMIN áp dụng được");
  const apDung = await applyLegacyEnforceCore(db, quanTri);
  assert.ok("ok" in apDung);
  const cfgSau = await readEnforceConfig(db);
  assert.deepEqual(cfgSau, { INVENTORY_ADJUSTMENT: true, PAYROLL_EDIT: true }, "áp dụng xong ⇒ v2 đúng bằng các nhóm đã nối của dòng cũ");
  const [conDongCu] = await db.select().from(schema.settings).where(eq(schema.settings.key, APPROVAL_ENFORCE_LEGACY_KEY));
  assert.equal(conDongCu?.value, dongCu, "dòng cũ KHÔNG bị xoá hay sửa");
  const [nhatKyApDung] = await db.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.action, "approval.enforce.apply-legacy"), eq(schema.auditLogs.userId, quanTri.id)));
  assert.deepEqual((nhatKyApDung?.detail as { after?: unknown })?.after, { v: 2, groups: { INVENTORY_ADJUSTMENT: true, PAYROLL_EDIT: true } }, "nhật ký ghi trước/sau");
  // Dọn: từ đây cưỡng chế bật cho đúng hai nhóm mà các khối dưới cần.
  await db.delete(schema.settings).where(eq(schema.settings.key, APPROVAL_ENFORCE_LEGACY_KEY));
  assert.ok("ok" in (await setEnforceGroupCore(db, quanTri, "EXPENSE_EDIT", true)));
  assert.equal(isEnforced(await readEnforceConfig(db), "INVENTORY_ADJUSTMENT"), true);

  /* ═══════════ 1c · VÒNG ĐỜI: XIN → DUYỆT → TIÊU THỤ MỘT LẦN ═══════════ */
  const a = schema.approvalRequests;
  const dong = async (id: string) => (await db.select().from(a).where(eq(a.id, id)))[0];
  const demCho = async () => Number((await db.select({ n: sql<number>`count(*)` }).from(a).where(and(eq(a.status, "PENDING"), like(a.requestedByEmail, `${P}%`))))[0].n);

  const l1 = await guardSecondApprovalCore(db, xin, goc, now);
  assert.equal(l1.mode, "NEEDS_APPROVAL", "cưỡng chế bật + vượt ngưỡng ⇒ phải chờ duyệt");
  assert.ok(l1.requestId);
  const id1 = l1.requestId!;
  const l1b = await guardSecondApprovalCore(db, xin, goc, now);
  assert.equal(l1b.mode, "NEEDS_APPROVAL");
  assert.equal(l1b.requestId, id1, "bấm lại việc đang chờ phải trả lại ĐÚNG yêu cầu cũ");
  assert.equal(await demCho(), 1, "bấm lại KHÔNG được đẻ yêu cầu thứ hai");

  // Người xin không tự duyệt; người không có quyền không duyệt.
  const tuDuyet = await decideApprovalCore(db, { ...xin, canDecide: true }, id1, true, undefined, now);
  assert.ok("error" in tuDuyet && /tự duyệt/.test(tuDuyet.error), "người xin KHÔNG được tự duyệt");
  const khongQuyen = await decideApprovalCore(db, { ...duyet, canDecide: false }, id1, true, undefined, now);
  assert.ok("error" in khongQuyen, "không có approvals:decide thì không duyệt được");
  const tuChoiKhongLyDo = await decideApprovalCore(db, duyet, id1, false, "  ", now);
  assert.ok("error" in tuChoiKhongLyDo, "từ chối phải nêu lý do");
  assert.equal((await dong(id1)).status, "PENDING", "ba lượt hỏng ở trên không được đổi trạng thái");

  const ok1 = await decideApprovalCore(db, duyet, id1, true, undefined, now);
  assert.ok("ok" in ok1, "người khác, có quyền ⇒ duyệt được");
  const lanHai = await decideApprovalCore(db, duyet, id1, false, "đổi ý", now);
  assert.ok("error" in lanHai, "đã quyết rồi thì không quyết lại được");
  assert.equal((await dong(id1)).status, "APPROVED");

  // Việc KHÁC (khác payload) không được tiêu thụ lời duyệt của việc này.
  const khac = await guardSecondApprovalCore(db, xin, { ...goc, payload: { items: [{ v: "a", q: -200 }], note: "kiểm kê" } }, now);
  assert.equal(khac.mode, "NEEDS_APPROVAL", "đổi payload thì phải xin lại");
  assert.notEqual(khac.requestId, id1);
  assert.equal((await dong(id1)).status, "APPROVED", "lời duyệt của việc cũ còn nguyên sau khi thử một việc khác");
  // Người KHÁC làm đúng việc ấy cũng không được dùng lời duyệt của người xin.
  const nguoiKhac = await guardSecondApprovalCore(db, xin2, goc, now);
  assert.equal(nguoiKhac.mode, "NEEDS_APPROVAL", "lời duyệt gắn với NGƯỜI xin, không phải với việc trôi nổi");
  assert.equal((await dong(id1)).status, "APPROVED");

  // Đúng người, đúng việc ⇒ TIÊU THỤ.
  const chay = await guardSecondApprovalCore(db, xin, goc, now);
  assert.equal(chay.mode, "PROCEED", "đã được duyệt ⇒ việc phải chạy được");
  assert.equal(chay.consumed, true);
  assert.equal(chay.requestId, id1);
  const sauChay = await dong(id1);
  assert.equal(sauChay.status, "EXECUTED", "lời duyệt đã dùng phải ghi EXECUTED");
  assert.ok(sauChay.executedAt, "phải ghi executed_at");
  // Lần thứ hai: phải xin lại — lời duyệt chỉ dùng MỘT lần.
  const chayLai = await guardSecondApprovalCore(db, xin, goc, now);
  assert.equal(chayLai.mode, "NEEDS_APPROVAL", "lời duyệt đã dùng KHÔNG mở khoá lần thứ hai");
  assert.notEqual(chayLai.requestId, id1);

  /* ═══════════ 1d · HAI LƯỢT TIÊU THỤ ĐỒNG THỜI: CHỈ MỘT LƯỢT THẮNG ═══════════ */
  const id3 = chayLai.requestId!;
  assert.ok("ok" in (await decideApprovalCore(db, duyet, id3, true, undefined, now)));
  const fp = approvalFingerprint(goc);
  const [c1, c2] = await Promise.all([
    consumeApprovedRequest(db, { requesterId: xin.id, group: goc.group, action: goc.action, fingerprint: fp, now }),
    consumeApprovedRequest(db, { requesterId: xin.id, group: goc.group, action: goc.action, fingerprint: fp, now }),
  ]);
  assert.equal([c1, c2].filter(Boolean).length, 1, `hai lượt đồng thời chỉ MỘT được tiêu thụ (được: ${c1} · ${c2})`);
  // Và qua đường cổng đầy đủ: duyệt thêm một yêu cầu, hai lượt bấm cùng lúc ⇒ một PROCEED.
  const l4 = await guardSecondApprovalCore(db, xin, goc, now);
  assert.ok("ok" in (await decideApprovalCore(db, duyet, l4.requestId!, true, undefined, now)));
  const cung = await Promise.all([guardSecondApprovalCore(db, xin, goc, now), guardSecondApprovalCore(db, xin, goc, now)]);
  assert.equal(cung.filter((k) => k.mode === "PROCEED").length, 1, "hai lượt bấm cùng lúc trên MỘT lời duyệt ⇒ đúng một lượt chạy");

  /* ═══════════ 1e · HẾT HẠN: KHÔNG TIÊU THỤ ĐƯỢC, GHI EXPIRED KHI CHẠM ═══════════ */
  assert.equal(approvalStillValid({ status: "APPROVED", executedAt: null, decidedAt: new Date(approvalValidSince(now).getTime() + 1) }, now), true, "trong hạn 1 ms vẫn còn hiệu lực");
  assert.equal(approvalStillValid({ status: "APPROVED", executedAt: null, decidedAt: approvalValidSince(now) }, now), false, "đúng mốc hết hạn là HẾT");
  const hetHan: GuardInput = { ...goc, payload: { items: [{ v: "het-han", q: -1 }] } };
  // Chèn thẳng một lời duyệt đã quá hạn (mốc dựng từ CÙNG `now` truyền vào lõi).
  const [cu] = await db
    .insert(a)
    .values({
      group: hetHan.group,
      action: hetHan.action,
      entity: hetHan.entity ?? "",
      summary: "lời duyệt cũ",
      requestedBy: xin.id,
      requestedByEmail: xin.email,
      status: "APPROVED",
      decidedBy: duyet.id,
      decidedByEmail: duyet.email,
      decidedAt: new Date(now.getTime() - (APPROVAL_VALID_HOURS + 1) * 3_600_000),
      payloadFingerprint: approvalFingerprint(hetHan),
    })
    .returning({ id: a.id });
  // Điều kiện hạn nằm NGAY TRONG phép tiêu thụ — không dựa vào việc bước ghi EXPIRED đã chạy trước.
  assert.equal(
    await consumeApprovedRequest(db, { requesterId: xin.id, group: hetHan.group, action: hetHan.action, fingerprint: approvalFingerprint(hetHan), now }),
    null,
    "phép tiêu thụ tự nó phải từ chối lời duyệt quá hạn",
  );
  assert.equal((await dong(cu.id)).status, "APPROVED", "tiền đề: tiêu thụ hụt không đổi dòng");
  const thuHetHan = await guardSecondApprovalCore(db, xin, hetHan, now);
  assert.equal(thuHetHan.mode, "NEEDS_APPROVAL", "lời duyệt quá hạn KHÔNG mở khoá được việc");
  assert.equal((await dong(cu.id)).status, "EXPIRED", "chạm vào nhóm đó thì lời duyệt quá hạn phải ghi EXPIRED");
  assert.equal((await dong(cu.id)).executedAt, null, "hết hạn không phải đã chạy");

  /* ═══════════ 1f · CƯỠNG CHẾ TẮT ⇒ HÀNH VI Y HỆT BẢN CŨ ═══════════ */
  const l5 = await guardSecondApprovalCore(db, xin, goc, now);
  assert.ok("ok" in (await decideApprovalCore(db, duyet, l5.requestId!, true, undefined, now)));
  assert.ok("ok" in (await setEnforceGroupCore(db, quanTri, "INVENTORY_ADJUSTMENT", false)));
  const tat = await guardSecondApprovalCore(db, xin, goc, now);
  assert.equal(tat.mode, "PROCEED");
  assert.equal(tat.consumed, undefined, "cưỡng chế tắt thì KHÔNG đụng tới lời duyệt nào");
  assert.equal((await dong(l5.requestId!)).status, "APPROVED", "lời duyệt còn nguyên khi cưỡng chế tắt");

  /* ═══════════ 4 · AUDIT: BA CỘT MỚI ═══════════ */
  const [dongXin] = await db.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.entityId, id1), eq(schema.auditLogs.action, "approval.request:stock.adjustment")));
  assert.ok(dongXin, "phải có dòng nhật ký lúc xin");
  assert.equal(dongXin.actorKind, "USER");
  assert.equal(dongXin.correlationId, id1, "dòng nhật ký nối về đúng yêu cầu");
  const [dongChay] = await db.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.entityId, id1), eq(schema.auditLogs.action, "approval.execute:stock.adjustment")));
  assert.ok(dongChay?.reason, "lượt tiêu thụ phải ghi LÝ DO vào cột reason");
  const [dongHet] = await db.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.entityId, cu.id), eq(schema.auditLogs.action, "approval.expire")));
  assert.equal(dongHet?.actorKind, "SYSTEM", "hết hạn là MÁY làm, không phải người");
  const tuChoi = await guardSecondApprovalCore(db, xin2, { ...goc, payload: { tu: "choi" } }, now);
  assert.ok("ok" in (await setEnforceGroupCore(db, quanTri, "INVENTORY_ADJUSTMENT", true)));
  const tc = await guardSecondApprovalCore(db, xin2, { ...goc, payload: { tu: "choi-2" } }, now);
  assert.equal(tuChoi.mode, "PROCEED", "tiền đề: nhóm tắt thì làm luôn");
  assert.ok("ok" in (await decideApprovalCore(db, duyet, tc.requestId!, false, "thiếu biên bản kiểm kê", now)));
  const [dongTuChoi] = await db.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.entityId, tc.requestId!), eq(schema.auditLogs.action, "approval.reject")));
  assert.equal(dongTuChoi?.reason, "thiếu biên bản kiểm kê", "lý do từ chối đi vào cột reason");
  assert.deepEqual((dongTuChoi?.detail as { before?: unknown })?.before, { status: "PENDING" }, "detail jsonb vẫn ghi như cũ (thêm trước/sau)");
  // Suy loại tác nhân.
  assert.equal(inferActorKind({ userEmail: "a@b", userId: "u1" }, true), "USER", "có userId thì là NGƯỜI — kể cả khi cờ job nền (toàn cục) đang bật");
  assert.equal(inferActorKind({ userEmail: "job:x", userId: null }, false), "SYSTEM");
  assert.equal(inferActorKind({ userEmail: "", userId: null }, true), "SYSTEM");
  assert.equal(inferActorKind({ userEmail: "webhook-ai-do", userId: null }, false), null, "không suy được thì CHƯA BIẾT, không đoán là người dùng");
  await trongJobNen(() => audit({ userId: null, userEmail: `${P}job`, action: "cosg.probe", entity: "TEST", entityId: `${P}probe`, correlationId: `${P}run-1` }));
  const [probe] = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.entityId, `${P}probe`));
  assert.equal(probe?.actorKind, "SYSTEM", "audit() trong job nền ghi SYSTEM");
  assert.equal(probe?.correlationId, `${P}run-1`);
  let csdlChan = false;
  try {
    await db.insert(schema.auditLogs).values({ userEmail: `${P}x`, action: "x", entity: "TEST", actorKind: "ROBOT" });
  } catch {
    csdlChan = true;
  }
  assert.ok(csdlChan, "CSDL phải từ chối loại tác nhân ngoài bốn giá trị");
  // Lỗi ghi nhật ký KHÔNG được ném vào nghiệp vụ.
  const logCu = console.error;
  let inLoi = 0;
  console.error = () => {
    inLoi += 1;
  };
  try {
    await audit({ userId: null, userEmail: `${P}x`, action: "x", entity: "TEST", actorKind: "ROBOT" as never });
  } finally {
    console.error = logCu;
  }
  assert.equal(inLoi, 1, "ghi nhật ký hỏng phải IN RA (console.error), không nuốt im lặng — và không ném");

  /* ═══════════ 3 · NGUỒN VIỆC APPROVAL: PHÉP CHIẾU ═══════════ */
  assert.equal(WORK_SOURCE_SPEC.APPROVAL.statusAuthority, "SOURCE", "trạng thái nằm ở approval_requests, không ở work_items");
  assert.deepEqual(WORK_SOURCE_SPEC.APPROVAL.actions, ["OPEN_SOURCE"], "không nút nào 'đánh dấu xong' — chỉ decideApproval đóng được");
  assert.equal(DEFAULT_OWNERSHIP_MAP.APPROVAL?.department, "MANAGEMENT");
  assert.equal(DEFAULT_SLA_MAP.APPROVAL?.hours, null, "không gõ một số giờ mới (AGENTS.md mục 22)");
  const cho = await guardSecondApprovalCore(db, xin, { ...goc, payload: { work: "projection" } }, now);
  const key = `APPROVAL:${cho.requestId}`;
  const truoc = await collectWorkItems({ sources: ["APPROVAL"], now });
  const viec = truoc.items.find((i) => i.key === key);
  assert.ok(viec, "yêu cầu đang chờ phải hiện trên hàng đợi");
  assert.equal(viec.status, "NEW");
  assert.equal(viec.department, "MANAGEMENT");
  assert.equal(viec.money.atRisk, null, "số tiền xin KHÔNG phải tiền đang treo");
  assert.ok("ok" in (await decideApprovalCore(db, duyet, cho.requestId!, true, undefined, now)));
  const sau = await collectWorkItems({ sources: ["APPROVAL"], now });
  assert.ok(!sau.items.some((i) => i.key === key), "quyết xong thì việc TỰ biến mất — không ai đóng hộ");
  const lichSu = await collectWorkItems({ sources: ["APPROVAL"], now, closedSince: new Date(now.getTime() - 3_600_000) });
  assert.equal(lichSu.items.find((i) => i.key === key)?.status, "DONE", "trong cửa sổ đã đóng thì hiện DONE, có completedAt");

  /* ═══════════ 2 · approvals:decide = ĐÚNG TẬP NGƯỜI CŨ, CẢ 8 VAI ═══════════ */
  assert.ok(ROLE_BUILDER_FORBIDDEN.includes("approvals:decide"), "vai trò tuỳ chỉnh không được cấp quyền duyệt");
  assert.equal(saveAccessRoleSchema.safeParse({ code: "TU_DUYET", name: "Tự duyệt", baseRole: "VIEWER", permissions: ["orders:read", "approvals:decide"], defaultScope: "ALL" }).success, false, "lược đồ phải từ chối vai tuỳ chỉnh chứa approvals:decide");
  const khongDuyet = (p: string[]) => p.filter((x) => x !== "approvals:decide" && x !== "settings:manage");
  let soCa = 0;
  for (const role of ROLE_ORDER as readonly Role[]) {
    const mau = DEFAULT_ROLE_PERMISSIONS[role];
    const templatesGhiDe: RolePermissionMap = { [role]: khongDuyet(mau) };
    const templatesCoCauHinh: RolePermissionMap = { [role]: [...khongDuyet(mau), "settings:manage"] };
    const vaiTuyChinh = (perms: string[]): CustomRole => ({ id: "r", code: "R", name: "R", baseRole: "VIEWER", permissions: perms, defaultScope: "ALL", active: true });
    const cacCa: [string, string[]][] = [
      ["mẫu mặc định", resolvePermissions(role, null, null)],
      ["mẫu GHI ĐÈ trong settings (không có khoá mới)", resolvePermissions(role, null, templatesGhiDe)],
      ["mẫu ghi đè CÓ settings:manage", resolvePermissions(role, null, templatesCoCauHinh)],
      ["quyền riêng không có settings:manage", resolvePermissions(role, ["orders:read"], null, [...ALL_PERMISSIONS])],
      ["quyền riêng CÓ settings:manage", resolvePermissions(role, ["orders:read", "settings:manage"], null, [...ALL_PERMISSIONS])],
      ["quyền riêng, ảnh chụp kiểu cũ", resolvePermissions(role, ["orders:read"], null, null)],
      ["vai tuỳ chỉnh không có settings:manage", effectiveAccess({ role, userCustom: null, customRole: vaiTuyChinh(["orders:read"]), scope: "DEPARTMENT", departmentCodes: [] }).permissions],
      ["vai tuỳ chỉnh CÓ settings:manage", effectiveAccess({ role, userCustom: null, customRole: vaiTuyChinh(["orders:read", "settings:manage"]), scope: "DEPARTMENT", departmentCodes: [] }).permissions],
      ["vai tuỳ chỉnh LÉN chứa approvals:decide", effectiveAccess({ role, userCustom: null, customRole: vaiTuyChinh(["orders:read", "approvals:decide"]), scope: "ALL", departmentCodes: [] }).permissions],
      ["vai tuỳ chỉnh bị TẮT", effectiveAccess({ role, userCustom: null, customRole: { ...vaiTuyChinh(["settings:manage"]), active: false }, scope: "ALL", departmentCodes: [] }).permissions],
    ];
    for (const [ten, perms] of cacCa) {
      const u = nguoi(`${P}${role}`, role, perms);
      assert.equal(can(u, "approvals:decide"), luatCu(u), `${role} · ${ten}: quyền duyệt mới (${can(u, "approvals:decide")}) phải BẰNG luật cũ (${luatCu(u)})`);
      soCa += 1;
    }
  }
  // Tập theo vai mặc định, viết ra cho người đọc: đúng ADMIN và MANAGER.
  const theoVai = (ROLE_ORDER as readonly Role[]).filter((r) => can(nguoi("x", r, resolvePermissions(r, null, null)), "approvals:decide"));
  assert.deepEqual([...theoVai].sort(), ["ADMIN", "MANAGER"], "mặc định chỉ ADMIN và MANAGER duyệt được");

  /* ═══════════ 5 · NĂM JOB GHI sync_runs, VÀ KHÔNG ĐỔI VIỆC CHÚNG LÀM ═══════════ */
  const NAM_JOB = ["alerts", "work-recurrence", "work-escalation", "work-snapshot", "dashboard-warm"] as const;
  const nguonJobs = readFileSync("lib/sync/jobs.ts", "utf8");
  for (const j of NAM_JOB) {
    assert.ok(new RegExp(`runSyncJob\\(\\{ source: "ERP", job: "${j}"[^}]*observeOnly: true`).test(nguonJobs), `${j}: phải bọc runSyncJob với observeOnly (không đổi việc job làm)`);
  }
  const runIds: string[] = [];
  for (const j of NAM_JOB) {
    const r = (await runJob(j, { trigger: "MANUAL", actor: `${P}test` })) as { run: { id: string; status: string } };
    assert.ok(r.run?.id, `${j}: phải có dòng sync_runs`);
    runIds.push(r.run.id);
    const [dongChayJob] = await db.select().from(schema.syncRuns).where(eq(schema.syncRuns.id, r.run.id));
    assert.equal(dongChayJob.source, "ERP");
    assert.equal(dongChayJob.job, j);
    assert.ok(["SUCCESS", "PARTIAL"].includes(dongChayJob.status), `${j}: lượt chạy bình thường không được FAILED (sự cố giả) — được ${dongChayJob.status}: ${dongChayJob.error ?? ""}`);
    assert.ok(dongChayJob.finishedAt, `${j}: phải đóng lượt chạy`);
  }
  // observeOnly KHÔNG làm cũ đệm; job thường thì CÓ — chứng minh bằng một mục đệm thăm dò.
  let goi = 0;
  const tham = () => memo(`${P}probe`, 600_000, async () => (goi += 1));
  await tham();
  const ra = await runSyncJob({ source: "ERP", job: `${P}observe`, observeOnly: true }, async () => 1);
  runIds.push(ra.run.id);
  await tham();
  assert.equal(goi, 1, "job observeOnly không được làm cũ đệm (dashboard-warm sẽ tự triệt tiêu)");
  const rb = await runSyncJob({ source: "ERP", job: `${P}normal` }, async () => 1);
  runIds.push(rb.run.id);
  await tham();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(goi, 2, "tiền đề: job thường VẪN làm cũ đệm như trước");
  await db.delete(schema.syncRuns).where(inArray(schema.syncRuns.id, runIds));

  /* ═══════════ 6 · CÔNG TẮC CHỈ BẬT NHÓM ĐÃ NỐI ═══════════ */
  const nguonThaoTac = ["stock", "expenses", "payroll", "payroll-policy", "payroll-run", "report-settings", "production", "delivery-rate-override"].map((f) => readFileSync(`lib/actions/${f}.ts`, "utf8")).join("\n");
  for (const g of APPROVAL_GROUPS) {
    const coGoi = nguonThaoTac.includes(`"${g}"`);
    assert.equal(APPROVAL_GROUPS_WIRED.includes(g), coGoi, `${g}: APPROVAL_GROUPS_WIRED phải khớp mã nguồn (có lời gọi = ${coGoi})`);
  }
  assert.ok(!APPROVAL_GROUPS_WIRED.includes("ADS_BUDGET_MUTATION"), "ADS_BUDGET_MUTATION CỐ Ý không nối (docs/marketing-ai-department.md)");

  await donDep(db);
  console.log(
    `✓ Company OS · mặt phẳng điều khiển: lời duyệt tiêu thụ ĐÚNG MỘT LẦN (đúng việc · đúng người · trong ${APPROVAL_VALID_HOURS} giờ; đồng thời chỉ một lượt thắng; quá hạn ghi EXPIRED) · chỉ cấu hình v2 do công tắc ADMIN ghi mới có hiệu lực, dòng cũ hiện ra và áp dụng có chủ đích · approvals:decide khớp luật cũ ở ${soCa} ca × 8 vai · nguồn việc APPROVAL tự biến mất khi đã quyết · audit ghi actor_kind/correlation_id/reason, CSDL chặn loại lạ, lỗi ghi được in ra · 5 job có sync_runs mà không làm cũ đệm`,
  );
}
