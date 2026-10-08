/**
 * ═══════════ ĐỐI CHIẾU CHỈ MỤC DANH TÍNH — MẶC ĐỊNH CHẠY THỬ (ops `identity-reconcile`, 08/10/2026) ═══════════
 *
 * Trước bản vá P0 (lib/auth/identities.ts), chỉ mục đăng nhập (email / SĐT ⇒ tổ chức) chỉ được ghi SAU lần đăng nhập thành công
 * đầu tiên. Tài khoản tạo trước bản vá mà chưa từng đăng nhập — quản trị do job cấp phát / người vận hành tạo, người dùng tạo hộ ở
 * /settings/users, người nhận lời mời mà lượt đăng nhập ngay sau hỏng — không có dòng nào ⇒ chỉ vào được khi gõ «mã tổ chức».
 *
 * Đây là đối chiếu XÁC ĐỊNH, không phải ghép người (AGENTS 35): mỗi dòng ghi bù nối một email với ĐÚNG MỘT dòng `users` trong ĐÚNG
 * CSDL tổ chức đang chứa nó (cột `users.email` UNIQUE) — không so email giữa các tổ chức, không suy ai là ai. Ghi qua ĐÚNG đường ghi
 * của ứng dụng (`recordIdentity` với mốc dùng = NULL: chỉ mục, không giả một lần đăng nhập — nên không mở thêm đường Google /
 * Facebook nào, và ô «Người đã đăng nhập» không đổi).
 *
 * ĐỦ ĐIỀU KIỆN: tài khoản ĐANG BẬT · email đã ở dạng chuẩn (đúng chuỗi màn đăng nhập tra; lệch dạng thì tài khoản ấy vốn không đăng
 * nhập bằng email được — đếm riêng, không ghi) · băm mật khẩu bcrypt hợp lệ (đăng nhập được bằng mật khẩu — gồm cả mật khẩu ngẫu
 * nhiên chưa kích hoạt; không gồm băm giả kiểu "x"). SĐT chỉ khi đã chuẩn hoá (`users.phone` UNIQUE trong tổ chức).
 *
 * BỐN NHÓM: MISSING (chưa có dòng — ghi) · STALE (dòng trỏ tài khoản KHÁC trong cùng tổ chức — ghi đè đúng tài khoản) · đúng ·
 * MỒ CÔI (dòng trỏ tài khoản không còn / đang khoá — CHỈ ĐẾM, không xoá: lượt đọc vẫn tra CSDL tổ chức nên dòng ấy vô hại).
 * CSDL tổ chức không mở được ⇒ CHƯA BIẾT (`null`), không phải 0.
 *
 * CSDL tổ chức chỉ được ĐỌC, qua `getDbForInspection` (máy chủ ép chỉ đọc, không migrate) — kể cả lượt `--apply`, vốn chỉ ghi mặt
 * phẳng điều khiển (`platform_identities` + một dòng nhật ký nền tảng mỗi tổ chức có ghi, chỉ số đếm).
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDbForInspection, getPlatformDb, releaseOrganizationDb, schema } from "@/db";
import { recordIdentity } from "@/lib/auth/identities";
import { normalizeEmail, normalizePhone } from "@/lib/auth/identity-shared";
import { platformAudit, type PlatformAuditSource } from "@/lib/platform/audit";
import { listOrganizations } from "@/lib/platform/organizations";
import { rowsOf } from "@/lib/sql-rows";

/** Băm bcrypt hợp lệ (bcryptjs `$2a$` / `$2b$`, 60 ký tự). */
const BCRYPT_HASH = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;

export type ReconcileKind = "EMAIL" | "PHONE";
export type ReconcileGap = { orgCode: string; userId: string; kind: ReconcileKind; value: string; state: "MISSING" | "STALE" };

export type OrgReconcile = {
  orgCode: string;
  status: string;
  isHome: boolean;
  /** Không đọc được CSDL tổ chức ⇒ câu lỗi; mọi số đếm bên dưới là `null` (CHƯA BIẾT). */
  error: string | null;
  users: number | null;
  eligible: number | null;
  skipped: { inactive: number; noPassword: number; emailNotNormalized: number } | null;
  /** Số dòng chỉ mục ĐÚNG (email + SĐT của tài khoản đủ điều kiện). */
  ok: number | null;
  gaps: ReconcileGap[];
  orphans: number | null;
};

export type ReconcileTotals = { orgs: number; unreadable: number; eligible: number; ok: number; missing: number; stale: number; orphans: number };
export type ReconcilePlan = { orgs: OrgReconcile[]; totals: ReconcileTotals };

export type ReconcileUserFacts = { id: string; email: string | null; phone: string | null; active: boolean; passwordHash: string | null };
export type ReconcileIndexFacts = { kind: string; value: string; userId: string };

/** THUẦN. So tài khoản của MỘT tổ chức với dòng chỉ mục của CHÍNH tổ chức đó. */
export function compareOrgIdentities(org: { code: string; status: string; isHome: boolean }, users: readonly ReconcileUserFacts[], index: readonly ReconcileIndexFacts[]): OrgReconcile {
  const owner = new Map(index.map((r) => [`${r.kind}\u0000${r.value}`, r.userId]));
  const skipped = { inactive: 0, noPassword: 0, emailNotNormalized: 0 };
  const gaps: ReconcileGap[] = [];
  let eligible = 0;
  let ok = 0;
  const check = (u: ReconcileUserFacts, kind: ReconcileKind, value: string) => {
    const cur = owner.get(`${kind}\u0000${value}`);
    if (cur === undefined) gaps.push({ orgCode: org.code, userId: u.id, kind, value, state: "MISSING" });
    else if (cur !== u.id) gaps.push({ orgCode: org.code, userId: u.id, kind, value, state: "STALE" });
    else ok += 1;
  };
  for (const u of users) {
    if (!u.active) skipped.inactive += 1;
    else if (!u.passwordHash || !BCRYPT_HASH.test(u.passwordHash)) skipped.noPassword += 1;
    else if (!u.email || normalizeEmail(u.email) !== u.email) skipped.emailNotNormalized += 1;
    else {
      eligible += 1;
      check(u, "EMAIL", u.email);
      if (u.phone && normalizePhone(u.phone) === u.phone) check(u, "PHONE", u.phone);
    }
  }
  const live = new Set(users.filter((u) => u.active).map((u) => u.id));
  const orphans = index.filter((r) => !live.has(r.userId)).length;
  return { orgCode: org.code, status: org.status, isHome: org.isHome, error: null, users: users.length, eligible, skipped, ok, gaps, orphans };
}

function totalsOf(orgs: readonly OrgReconcile[]): ReconcileTotals {
  const sum = (f: (o: OrgReconcile) => number | null) => orgs.reduce((a, o) => a + (f(o) ?? 0), 0);
  return {
    orgs: orgs.length,
    unreadable: orgs.filter((o) => o.error).length,
    eligible: sum((o) => o.eligible),
    ok: sum((o) => o.ok),
    missing: sum((o) => o.gaps.filter((g) => g.state === "MISSING").length),
    stale: sum((o) => o.gaps.filter((g) => g.state === "STALE").length),
    orphans: sum((o) => o.orphans),
  };
}

/** CHỈ ĐỌC. `orgCode` = một tổ chức; bỏ trống = MỌI tổ chức trong sổ (kể cả nhà, kể cả đang tạm dừng — dòng ghi bù vô hại tới khi nó hoạt động lại). */
export async function planIdentityReconcile(opts: { orgCode?: string | null } = {}): Promise<ReconcilePlan> {
  const all = await listOrganizations();
  const orgs = opts.orgCode ? all.filter((o) => o.code === opts.orgCode) : all;
  const pdb = await getPlatformDb();
  const t = schema.platformIdentities;
  const u = schema.users;
  const out: OrgReconcile[] = [];
  for (const org of orgs) {
    const index = await pdb.select({ kind: t.kind, value: t.value, userId: t.userId }).from(t).where(and(eq(t.orgCode, org.code), inArray(t.kind, ["EMAIL", "PHONE"])));
    let users: ReconcileUserFacts[];
    try {
      const db = await getDbForInspection(org);
      users = await db.select({ id: u.id, email: u.email, phone: u.phone, active: u.active, passwordHash: u.passwordHash }).from(u);
    } catch (error) {
      out.push({ orgCode: org.code, status: org.status, isHome: org.isHome, error: (error instanceof Error ? error.message : String(error)).slice(0, 200), users: null, eligible: null, skipped: null, ok: null, gaps: [], orphans: null });
      continue;
    } finally {
      // Lượt quét MỌI tổ chức không giữ một bể kết nối cho mỗi CSDL; handle của ứng dụng (nếu tiến trình đang mở) không bị đụng.
      if (!org.isHome) await releaseOrganizationDb(org.code, { inspectionOnly: true });
    }
    out.push(compareOrgIdentities(org, users, index));
  }
  return { orgs: out, totals: totalsOf(out) };
}

/**
 * Chạy thử (`apply: false`) hoặc ghi bù. Lượt ghi đọc LẠI ngay trước khi ghi (không dùng kế hoạch cũ), ghi từng dòng thiếu / lệch
 * qua `recordIdentity(…, null)` — idempotent theo khoá `(kind, value, org_code)`, chạy hai lần không đẻ dòng thứ hai — rồi đọc lại
 * lần nữa để báo phần CÒN thiếu (phải là 0).
 */
export async function runIdentityReconcile(opts: { orgCode?: string | null; apply: boolean; source?: PlatformAuditSource }): Promise<{ before: ReconcilePlan; after: ReconcilePlan | null; written: number; failed: number }> {
  const before = await planIdentityReconcile(opts);
  if (!opts.apply) return { before, after: null, written: 0, failed: 0 };
  let written = 0;
  let failed = 0;
  for (const org of before.orgs) {
    if (!org.gaps.length) continue;
    let w = 0;
    let f = 0;
    for (const g of org.gaps) {
      if (await recordIdentity(g.kind, g.value, g.orgCode, g.userId, null)) w += 1;
      else f += 1;
    }
    written += w;
    failed += f;
    await platformAudit({
      action: "IDENTITY_RECONCILE",
      targetOrgCode: org.orgCode,
      subject: "identity-reconcile",
      before: { missing: org.gaps.filter((g) => g.state === "MISSING").length, stale: org.gaps.filter((g) => g.state === "STALE").length },
      after: { written: w, failed: f },
      reason: "Ghi bù chỉ mục đăng nhập (email / SĐT ⇒ tổ chức) cho tài khoản tạo trước bản vá 08/10/2026 — đối chiếu xác định trong CSDL của chính tổ chức, không ghép người",
      source: opts.source ?? "SCRIPT",
      actor: null,
    });
  }
  return { before, after: await planIdentityReconcile(opts), written, failed };
}

/** CSDL nền tảng của tiến trình này có đang bị máy chủ ép CHỈ ĐỌC không — lượt chạy thử hỏi lại trước khi đọc. */
export async function platformDbReadOnly(): Promise<boolean> {
  const pdb = await getPlatformDb();
  const [ro] = rowsOf<Record<string, unknown>>(await pdb.execute(sql`show default_transaction_read_only`));
  return String(ro?.default_transaction_read_only ?? "") === "on";
}

/** Che email / SĐT trước khi in (kể cả phần mã hoá): đủ để đối chiếu với màn Người dùng, không đủ để dùng lại. */
export function maskIdentity(kind: ReconcileKind, value: string): string {
  if (kind === "EMAIL") {
    const at = value.indexOf("@");
    return at > 0 ? `${value.slice(0, 1)}***${value.slice(at)}` : "***";
  }
  return value.length > 6 ? `${value.slice(0, 4)}****${value.slice(-2)}` : "***";
}

/**
 * Dòng in. `summary` (đi kênh tóm tắt — log CÔNG KHAI): tổng + một dòng cho mỗi tổ chức có chỗ thiếu / lệch / không đọc được —
 * mã tổ chức và SỐ ĐẾM, không email / SĐT. `detail` (chỉ phần MÃ HOÁ): từng chỗ thiếu với email / SĐT đã che + mã tài khoản.
 */
export function reconcileLines(plan: ReconcilePlan): { summary: string[]; detail: string[] } {
  const t = plan.totals;
  const summary = [`${t.orgs} tổ chức · ${t.unreadable} không đọc được · ${t.eligible} tài khoản đủ điều kiện · đúng ${t.ok} · THIẾU ${t.missing} · LỆCH ${t.stale} · mồ côi ${t.orphans} (chỉ đếm, không xoá)`];
  const detail: string[] = [];
  for (const o of plan.orgs) {
    const label = `${o.orgCode}${o.isHome ? " (nhà)" : ""} · ${o.status}`;
    if (o.error) {
      summary.push(`${label} · KHÔNG ĐỌC ĐƯỢC CSDL tổ chức — chưa biết`);
      detail.push(`${label} · lỗi: ${o.error}`);
      continue;
    }
    const missing = o.gaps.filter((g) => g.state === "MISSING").length;
    const stale = o.gaps.length - missing;
    const line = `${label} · ${o.eligible} đủ điều kiện · đúng ${o.ok} · thiếu ${missing} · lệch ${stale} · mồ côi ${o.orphans} · bỏ qua: khoá ${o.skipped?.inactive ?? 0}, không mật khẩu ${o.skipped?.noPassword ?? 0}, email chưa chuẩn ${o.skipped?.emailNotNormalized ?? 0}`;
    if (o.gaps.length) summary.push(line);
    detail.push(line);
    for (const g of o.gaps) detail.push(`  ${o.orgCode} · ${g.kind} ${maskIdentity(g.kind, g.value)} · tài khoản ${g.userId} · ${g.state === "MISSING" ? "THIẾU" : "LỆCH (dòng trỏ tài khoản khác)"}`);
  }
  return { summary, detail };
}
