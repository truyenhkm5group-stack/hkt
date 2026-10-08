import { cache } from "react";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { jwtVerify, SignJWT } from "jose";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { Role } from "@/db/schema";
import { hasPermission, homeOrgPermissionDenied, PLATFORM_OPERATE_PERMISSION, resolvePermissions, USER_PERMISSION_SNAPSHOT_KEY, type Permission, type RolePermissionMap } from "@/lib/auth/permissions";
import { departmentCodesOfMany, effectiveAccess, loadCustomRole } from "@/lib/auth/access";
import { normalizeScope, type AccessScope } from "@/lib/constants/access-scope";
import { env } from "@/lib/env";
import { memo } from "@/lib/cache";
import { getSettingJson } from "@/lib/settings";
import { hostOrganization } from "@/lib/platform/host-org";
import { ERP_METHOD_HEADER, ERP_PATH_HEADER, SESSION_COOKIE as COOKIE_PHIEN, SESSION_IDLE_DAYS, SESSION_LOGIN_CLAIM, SESSION_ORG_CLAIM, claimsFrom, cookieMaxAgeSec, sessionCookieSecure } from "@/lib/constants/session";
import { BILLING_LOCKED_PATH, DENY_REASON_PARAM, MODULE_DISABLED_PATH, sessionRevoked, type SessionDenyReason } from "@/lib/constants/session-revocation";
import { moduleOfPath, moduleOfPermission, type ModuleKey } from "@/lib/constants/platform-modules";
import { getEnabledModules } from "@/lib/platform/capabilities";
import { currentOrganization, OrgContextError, readSessionTokenRaw } from "@/lib/platform/context";
import { findOrganization } from "@/lib/platform/organizations";
import { billingWriteDenied } from "@/lib/billing/rules";
import { orgBillingStanding } from "@/lib/billing/standing";
import { billingLockApplies } from "@/lib/saas/policy";
import { forbiddenRedirectFor, isSalesAgentUser, salesAgentPathAllowed, salesAgentRedirectFor, SALES_AGENT_INBOX_HREF } from "@/lib/constants/saas-nav";

export const ROLE_PERMISSIONS_KEY = "auth.rolePermissions";

/*
  LUẬT PHIÊN Ở MỘT CHỖ: `lib/constants/session.ts`. Tệp đó không import gì nên `middleware.ts`
  (chạy ở Edge) nạp được cùng một bản — số ngày, phép quyết định gia hạn và thuộc tính cookie chỉ
  tồn tại một lần trong kho mã.
*/
export { SESSION_COOKIE } from "@/lib/constants/session";

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  role: Role;
  permissions: string[];
  /** Phạm vi dữ liệu (`lib/constants/access-scope.ts`). `ALL` = không thu hẹp gì. */
  scope: AccessScope;
  /** Mã phòng ban người này là thành viên — rỗng khi phạm vi là `ALL` (lúc đó không cần biết). */
  departmentCodes: string[];
  /** Chức danh. CHỈ ĐỂ HIỂN THỊ — không tham gia vào bất kỳ phép kiểm tra quyền nào. */
  positionId: string | null;
  /**
   * Tổ chức của phiên (docs/platform/shared-contracts.md mục 7). Mọi `SessionUser` do
   * `resolveCurrentUser()` dựng LUÔN có trường này; vắng mặt chỉ ở người dùng dựng tay trong kiểm thử.
   */
  organization?: { code: string; name: string; isHome: boolean; /** Thương hiệu nơi khách tự đăng ký (0215) — vỏ app Chốt Đơn đọc nó (`lib/constants/saas-nav.ts`). */ brand?: "vnx" | "chotdon" | null };
  /**
   * Module ĐANG BẬT của tổ chức (đã phân giải: dòng thiếu, core, đóng dưới phụ thuộc). Menu, cổng
   * đường dẫn và `can()` đọc trường này. `undefined` = không cổng module — chỉ người dựng tay trong
   * kiểm thử; `resolveCurrentUser()` luôn điền.
   */
  modules?: string[];
};

function secretKey() {
  return new TextEncoder().encode(env.authSecret);
}

const NGAY_GIAY = 86_400;

/** Phần danh tính đi vào cookie. Quyền / phạm vi KHÔNG nằm trong token — chúng được nạp lại từ
 *  CSDL ở mỗi lần dựng, nên thu hẹp phạm vi của một người có hiệu lực ngay, không đợi họ đăng
 *  nhập lại. */
export type SessionIdentity = Pick<SessionUser, "id" | "email" | "name" | "role">;

/**
 * Danh tính + TỔ CHỨC — thứ duy nhất được ký vào một phiên mới. `orgCode` BẮT BUỘC
 * (docs/platform/shared-contracts.md mục 3): một token không nói nó thuộc tổ chức nào chỉ còn được
 * chấp nhận cho phiên CŨ (phát ra khi hệ thống chỉ có tổ chức nhà), không bao giờ cho phiên mới.
 */
export type SessionSubject = SessionIdentity & { orgCode: string };

/**
 * Ký một token phiên.
 *
 * `loginAtSec` là mốc ĐĂNG NHẬP GỐC và nó ĐI THEO token qua mọi lần gia hạn — đó là thứ duy nhất
 * giữ cho trần tuyệt đối có nghĩa. Bỏ trống ⇒ đây là một lần đăng nhập mới, mốc là bây giờ.
 *
 * `iat` thì ngược lại: nó luôn là LÚC NÀY. Hai mốc tách nhau vì chúng trả lời hai câu khác nhau —
 * "phiên này bắt đầu khi nào" và "tờ giấy này được ký lại lần gần nhất khi nào".
 */
export async function signSession(user: SessionSubject, opts: { loginAtSec?: number; nowSec?: number } = {}) {
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const loginAtSec = opts.loginAtSec ?? nowSec;
  if (!user.orgCode) throw new Error("signSession: thiếu mã tổ chức — phiên mới phải nói nó thuộc tổ chức nào.");
  return new SignJWT({ email: user.email, name: user.name, role: user.role, [SESSION_ORG_CLAIM]: user.orgCode, [SESSION_LOGIN_CLAIM]: loginAtSec })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.id)
    .setIssuedAt(nowSec)
    .setExpirationTime(nowSec + SESSION_IDLE_DAYS * NGAY_GIAY)
    .sign(secretKey());
}

/**
 * Phiên đọc từ cookie, KÈM mốc đăng nhập gốc.
 *
 * `loginAtSec` là thứ luật thu hồi so sánh. Nó phải đi cùng danh tính từ đây tới
 * `resolveCurrentUser()` — đọc lại token lần thứ hai ở tầng dưới là mở đường cho hai chỗ đọc hai
 * giá trị khác nhau.
 */
type PhienDaDoc = { user: SessionUser; loginAtSec: number | null };

async function readSessionToken(token: string): Promise<PhienDaDoc | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey());
    if (!payload.sub) return null;
    const role = (payload.role as Role) ?? "VIEWER";
    // quyền thực tế được nạp lại từ DB trong requireUser / getCurrentUser
    const user: SessionUser = { id: payload.sub, email: String(payload.email ?? ""), name: String(payload.name ?? ""), role, permissions: resolvePermissions(role, null), scope: "ALL", departmentCodes: [], positionId: null };
    return { user, loginAtSec: claimsFrom(payload as Record<string, unknown>)?.loginAtSec ?? null };
  } catch {
    return null;
  }
}

export async function verifySessionToken(token: string): Promise<SessionUser | null> {
  return (await readSessionToken(token))?.user ?? null;
}

export async function createSession(user: SessionSubject) {
  const nowSec = Math.floor(Date.now() / 1000);
  const token = await signSession(user, { nowSec });
  const store = await cookies();
  store.set(COOKIE_PHIEN, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: sessionCookieSecure(process.env.NODE_ENV, env.appUrl),
    path: "/",
    // Hạn của cookie đi ĐÚNG với hạn của token. Lệch nhau thì hoặc trình duyệt vứt một tờ giấy
    // còn hạn, hoặc nó giữ một tờ giấy đã chết rồi gửi lên để nhận về 401.
    maxAge: cookieMaxAgeSec(nowSec + SESSION_IDLE_DAYS * NGAY_GIAY, nowSec),
  });
}

export async function destroySession() {
  const store = await cookies();
  store.delete(COOKIE_PHIEN);
}

/**
 * Token đọc qua `readSessionTokenRaw()` của ngữ cảnh tổ chức — MỘT đường đọc cho cả "người này là
 * ai" lẫn "người này thuộc tổ chức nào", để hai câu trả lời không bao giờ đến từ hai token khác nhau.
 */
async function getSessionRaw(): Promise<PhienDaDoc | null> {
  const token = await readSessionTokenRaw();
  if (!token) {
    /*
      GIỮ HỢP ĐỒNG CŨ: NGOÀI mọi request thì NÉM, không trả `null`. `readSessionTokenRaw()` nuốt lỗi
      "gọi ngoài request" (ngữ cảnh tổ chức cần thế), nhưng `decideScope()` (lib/auth/scope-guard.ts)
      phân biệt "không có phiên TRONG request" (ĐÓNG) với "job nền / script" (MỞ) đúng bằng lỗi này.
      Trả `null` ở đây là biến mọi job nền thành "người lạ" và mọi truy vấn có phạm vi ra rỗng.
      Trong một request thật, `cookies()` không ném — nhánh này chỉ là "chưa đăng nhập".
    */
    await cookies();
    return null;
  }
  return readSessionToken(token);
}

/**
 * MÓC KIỂM THỬ cho `x-erp-path`: bộ kiểm thử chạy ngoài Next nên không có header request. Đặt một
 * hàm trả đường dẫn để giả lập "request tới trang này". `null` để gỡ. Mã sản phẩm không gọi hàm này.
 */
let requestPathOverride: (() => string | null | undefined) | null = null;
export function setRequestPathSourceForTests(source: (() => string | null | undefined) | null) {
  requestPathOverride = source;
}

/** MÓC KIỂM THỬ cho `x-erp-method` (cổng chỉ xem của thu phí) — cùng ý với móc đường dẫn ở trên. */
let requestMethodOverride: (() => string | null | undefined) | null = null;
export function setRequestMethodSourceForTests(source: (() => string | null | undefined) | null) {
  requestMethodOverride = source;
}

async function requestMethod(): Promise<string | null> {
  if (requestMethodOverride) return requestMethodOverride() ?? null;
  try {
    return (await headers()).get(ERP_METHOD_HEADER);
  } catch {
    return null;
  }
}

/**
 * Đường dẫn của request hiện hành, do middleware đặt (`x-erp-path`, client không giả được — xem
 * `middleware.ts`). `null` = không có request (script, job) ⇒ không có cổng module theo đường dẫn;
 * cổng theo khoá quyền trong `can()` vẫn chạy.
 */
async function requestPath(): Promise<string | null> {
  if (requestPathOverride) return requestPathOverride() ?? null;
  try {
    return (await headers()).get(ERP_PATH_HEADER);
  } catch {
    return null;
  }
}

export async function getSession(): Promise<SessionUser | null> {
  return (await getSessionRaw())?.user ?? null;
}

/**
 * Mẫu quyền của các vai trò (bản chỉnh trong settings, nếu có).
 *
 * Đệm 60 giây: hai khoá này được đọc ở MỌI lần dựng trang, mọi server action, mọi lượt hỏi
 * chuông thông báo (30 giây/lần) — mà chúng chỉ đổi khi quản trị sửa quyền, và lúc đó `audit()`
 * xoá hẳn đệm nên số mới hiện ngay. Trước đây mỗi lần điều hướng tốn 6 câu truy vấn chỉ để biết
 * người đang đăng nhập là ai (layout + trang, mỗi bên 3 câu).
 *
 * THEO TỔ CHỨC (tenant-readiness-audit ISO-02): `memo()` tự gắn tiền tố `org:<mã>:` cho mọi tổ chức
 * không phải nhà, nên mẫu quyền của tổ chức A không bao giờ áp cho người của B. Không thêm hậu tố
 * tổ chức ở đây — hai nơi cùng khoá theo tổ chức là hai chỗ phải giữ khớp nhau.
 */
export async function loadRoleTemplates(): Promise<RolePermissionMap> {
  return memo("auth:roleTemplates", 60_000, () => getSettingJson<RolePermissionMap>(ROLE_PERMISSIONS_KEY, {}));
}

/**
 * Ảnh chụp "lúc lưu quyền tuỳ chỉnh cho người này, hệ thống có những khoá quyền nào".
 *
 * Để trong `settings` thay vì thêm cột: chỉ vài người dùng nên dữ liệu rất nhỏ, và tránh được một
 * migration vào lúc kho đang có phiên làm việc khác sửa dở `db/schema.ts`.
 */
export async function loadPermissionSnapshots(): Promise<Record<string, string[]>> {
  return memo("auth:permissionSnapshots", 60_000, () => getSettingJson<Record<string, string[]>>(USER_PERMISSION_SNAPSHOT_KEY, {}));
}

/**
 * Kết quả đầy đủ: hoặc là người dùng, hoặc là LÝ DO bị từ chối — mỗi lý do một câu khác nhau.
 * `module` chỉ có mặt khi `denied = "MODULE_DISABLED"`: khoá của module đang tắt mà đường dẫn thuộc về.
 */
export type ResolvedUser = { user: SessionUser } | { denied: SessionDenyReason; module?: ModuleKey; /** Chỉ khi `SHELL_RESTRICTED`: trang nhà của vỏ cho ĐÚNG người này. */ home?: string };

/**
 * Người dùng hiện tại với quyền đã tính, HOẶC lý do bị từ chối. Không chuyển hướng.
 *
 * `cache()` của React khử trùng lặp TRONG MỘT LẦN DỰNG: layout gọi `requireUser`, trang gọi
 * `requirePermission`, các khối Suspense gọi `can` — trước đây mỗi lời gọi là một lượt tra
 * người dùng riêng. Không phải đệm theo thời gian: lần dựng kế tiếp vẫn tra lại, nên khoá tài
 * khoản — và thu hồi phiên — có hiệu lực ngay ở lần điều hướng tiếp theo.
 */
export const resolveCurrentUser = cache(async (): Promise<ResolvedUser> => {
  const session = await getSessionRaw();
  if (!session) return { denied: "NOT_FOUND" };
  let ket: ResolvedUser;
  try {
    ket = await resolveSessionUser(session);
  } catch (error) {
    /*
      Claim `org` trỏ tới tổ chức đình chỉ / lưu trữ / không còn ⇒ `getDb()` NÉM (lib/platform/context.ts).
      Đó là một lý do từ chối có tên, không phải trang lỗi 500 — và tuyệt đối không rơi về tổ chức nhà.
    */
    if (error instanceof OrgContextError) return { denied: "ORG_INACTIVE" };
    throw error;
  }
  if ("denied" in ket) return ket;
  /*
    HOST ⇄ PHIÊN (0180). Trên tên miền con `<slug>.<miền gốc>`, phiên phải thuộc ĐÚNG tổ chức đã xuất bản với slug đó.
    Cookie là host-only nên thường không bao giờ lệch — nhưng slug đổi / tổ chức rút xuất bản / cookie bị chép tay thì
    lệch, và khi lệch thì không chọn bên nào. Miền chính (không slug) ⇒ không kiểm, y như trước.
  */
  const host = await hostOrganization();
  if (host.slug && (!host.org || host.org.code !== ket.user.organization?.code)) return { denied: "HOST_MISMATCH" };
  /*
    CỔNG MODULE THEO ĐƯỜNG DẪN (target-architecture P8, P9). Đứng SAU mọi kiểm danh tính: người bị
    khoá / bị thu hồi phải nghe đúng câu của họ, không phải "module chưa bật". Đọc cùng tập module mà
    `can()` và menu dùng (`user.modules`) — một ảnh chụp cho cả lượt dựng.
  */
  const path = await requestPath();
  /*
    CỔNG VỎ APP CHỐT ĐƠN (lib/constants/saas-nav.ts). Workspace «Sales Agent» chỉ mở được trang của vỏ; trang ERP nội bộ còn lại
    chuyển về trang nhà của vỏ. Đứng TRƯỚC cổng module: trang ERP của một module tắt phải về hộp thư, không về «module chưa bật —
    liên hệ quản trị» (khách không có ai để liên hệ, và họ không cần module đó). Phép quyết định chỉ đọc phiên đã có (thương hiệu
    + module), không tốn thêm câu truy vấn nào.
  */
  if (path && isSalesAgentUser(ket.user) && !salesAgentPathAllowed(path)) return { denied: "SHELL_RESTRICTED", home: salesAgentRedirectFor(ket.user, path) };
  const pathModule = path ? moduleOfPath(path) : null;
  if (pathModule && !(ket.user.modules ?? []).includes(pathModule)) return { denied: "MODULE_DISABLED", module: pathModule };
  /*
    CỔNG CHỈ XEM CỦA THU PHÍ (0187). Đứng SAU mọi cổng khác vì nó hẹp nhất: chỉ chặn lượt GHI (server action, API không
    phải GET) của tổ chức khách đã quá hạn thanh toán và hết ân hạn. Lượt đọc không chạm sổ thuê bao — chỉ lượt ghi của tổ
    chức khách mới hỏi (đệm 10 giây). Trang gia hạn và đường đăng xuất được miễn (`BILLING_WRITE_EXEMPT_PATHS`).
  */
  const org = ket.user.organization;
  // `billingLockApplies` là vị từ CHUNG với khung gia hạn của /settings/plan — bị khoá thì trang luôn có mã QR.
  if (org && billingLockApplies(org)) {
    const method = await requestMethod();
    if (method && method !== "GET" && method !== "HEAD") {
      const standing = await orgBillingStanding(org);
      if (billingWriteDenied({ isHome: org.isHome, standing: standing.kind, method, path })) return { denied: "BILLING_LOCKED" };
    }
  }
  return ket;
});

async function resolveSessionUser(session: PhienDaDoc): Promise<ResolvedUser> {
  const db = await getDb();
  const [user, templates, snapshots, platform] = await Promise.all([
    db.query.users.findFirst({
      where: eq(schema.users.id, session.user.id),
      // `sessionInvalidBefore` đi CÙNG lượt tra này — không thêm một câu truy vấn nào. Và tuyệt đối
      // KHÔNG được bọc lượt tra này trong `memo()`: một cửa sổ đệm 60 giây là 60 giây mà token vừa
      // bị thu hồi vẫn dùng được, tức là tính năng này không còn là thu hồi nữa.
      columns: { id: true, email: true, name: true, role: true, active: true, permissions: true, accessRoleId: true, positionId: true, dataScope: true, sessionInvalidBefore: true },
    }),
    loadRoleTemplates(),
    loadPermissionSnapshots(),
    platformOfSession(),
  ]);
  if (!user) return { denied: "NOT_FOUND" };
  if (!user.active) return { denied: "DISABLED" };
  /*
    THU HỒI PHIÊN. So mốc đăng nhập GỐC của token (`lgn`) với `users.session_invalid_before`.

    Middleware ở Edge vẫn gia hạn cookie của một phiên đã bị thu hồi — nó không có CSDL để biết.
    Vô hại, và cố ý: gia hạn giữ NGUYÊN `lgn`, nên tờ giấy vừa được ký lại vẫn bị chặn ở ngay đây.
    Đó chính là lý do luật so với `lgn` chứ không so với `iat`.
  */
  if (sessionRevoked(session.loginAtSec, user.sessionInvalidBefore)) return { denied: "REVOKED" };
  return { user: await sessionUserOfRow(user, templates, snapshots, platform) };
}

type UserRowForAccess = { id: string; email: string; name: string; role: Role; permissions: string[] | null; accessRoleId: string | null; positionId: string | null; dataScope: string | null };

/**
 * Dòng `users` ⇒ người dùng với quyền đã cộng đủ ba chiều. ĐƯỜNG DUY NHẤT: phiên đăng nhập và việc chọn người nhận tin
 * (`activeUserIdsWhoCan`) cùng đi qua đây, nên "ai được thấy" và "ai được báo" không thể lệch nhau.
 */
async function sessionUserOfRow(user: UserRowForAccess, templates: RolePermissionMap, snapshots: Record<string, string[]>, platform: Required<Pick<SessionUser, "organization" | "modules">>): Promise<SessionUser> {
  const scope = normalizeScope(user.dataScope);
  const known = snapshots[user.id] ?? null;

  /*
    ĐƯỜNG NHANH: phạm vi `ALL` và không có vai trò tuỳ chỉnh — tức là MỌI tài khoản đang chạy hôm
    nay. Không thêm một câu truy vấn nào, kết quả đúng bằng hành vi trước bản này. Chỉ khi chủ shop
    CHỦ ĐỘNG thu hẹp phạm vi hoặc gán vai trò tuỳ chỉnh thì mới tốn thêm hai câu — và lúc đó tài
    khoản ấy đáng để tốn.
  */
  if (scope === "ALL" && !user.accessRoleId) {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      permissions: resolvePermissions(user.role, user.permissions, templates, known),
      scope,
      departmentCodes: [],
      positionId: user.positionId ?? null,
      ...platform,
    };
  }

  const [customRole, deptMap] = await Promise.all([loadCustomRole(user.accessRoleId), departmentCodesOfMany([user.id])]);
  const access = effectiveAccess({
    role: user.role,
    userCustom: user.permissions,
    customRole,
    scope,
    departmentCodes: deptMap[user.id] ?? [],
    templates,
    known,
  });
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    permissions: access.permissions,
    scope: access.scope,
    departmentCodes: access.departmentCodes,
    positionId: user.positionId ?? null,
    ...platform,
  };
}

/**
 * Tài khoản ĐANG BẬT của tổ chức hiện hành mà `can(người đó, quyền)` đúng — dùng để chọn người nhận tin trong hộp thư cá
 * nhân (không phụ thuộc module «Cần xử lý»). Hỏi đúng `can()` mà mọi trang dùng, trên người dùng dựng bằng đúng đường của
 * phiên đăng nhập — không tính quyền lần thứ hai.
 */
export async function activeUserIdsWhoCan(permission: Permission): Promise<string[]> {
  const db = await getDb();
  const [rows, templates, snapshots, platform] = await Promise.all([
    db
      .select({ id: schema.users.id, email: schema.users.email, name: schema.users.name, role: schema.users.role, permissions: schema.users.permissions, accessRoleId: schema.users.accessRoleId, positionId: schema.users.positionId, dataScope: schema.users.dataScope })
      .from(schema.users)
      .where(eq(schema.users.active, true)),
    loadRoleTemplates(),
    loadPermissionSnapshots(),
    platformOfSession(),
  ]);
  const out: string[] = [];
  for (const row of rows) if (can(await sessionUserOfRow(row, templates, snapshots, platform), permission)) out.push(row.id);
  return out;
}

/** Tổ chức + module bật của phiên hiện hành — cùng ngữ cảnh mà `getDb()` vừa dùng để tra người dùng. */
async function platformOfSession(): Promise<Required<Pick<SessionUser, "organization" | "modules">>> {
  const ctx = await currentOrganization();
  const [org, modules] = await Promise.all([findOrganization(ctx.code), getEnabledModules(ctx.code)]);
  return { organization: { code: ctx.code, name: org?.name ?? ctx.code, isHome: ctx.isHome, brand: org?.brand ?? null }, modules: [...modules] };
}

/**
 * Người dùng hiện tại, hoặc `null`. Lớp mỏng trên `resolveCurrentUser()` — nó nuốt LÝ DO từ chối
 * đi, nên chỉ dùng cho những chỗ chỉ cần biết "có hay không" (API trả 401, khối tuỳ quyền).
 * Chỗ nào phải NÓI cho người dùng biết vì sao thì đọc `resolveCurrentUser()`.
 */
export const getCurrentUser = async (): Promise<SessionUser | null> => {
  const ket = await resolveCurrentUser();
  return "user" in ket ? ket.user : null;
};

/** Lấy người dùng hiện tại (kiểm tra còn active trong DB), chuyển hướng /login nếu chưa đăng nhập */
export async function requireUser(roles?: Role[]): Promise<SessionUser> {
  const ket = await resolveCurrentUser();
  if ("denied" in ket) {
    /*
      BA NGUYÊN NHÂN, BA CÂU. Trước bản này cả ba đều ra `?reason=inactive`, tức là nói với một
      nhân viên rằng tài khoản họ bị khoá trong khi tài khoản hoàn toàn bình thường — và họ đi gọi
      quản trị. Không có cookie thì về `/login` trần như cũ, vì lúc đó chẳng có gì để giải thích.
    */
    if (ket.denied === "NOT_FOUND" && !(await getSession())) redirect("/login");
    // Module chưa bật KHÔNG phải lỗi phiên: người dùng vẫn đăng nhập hợp lệ, chỉ trang này không dùng
    // được. Đưa họ về `/login` là bắt đăng nhập lại để rồi bị chặn đúng chỗ cũ.
    if (ket.denied === "MODULE_DISABLED" && ket.module) redirect(`${MODULE_DISABLED_PATH}?m=${encodeURIComponent(ket.module)}`);
    // Quá hạn thanh toán: phiên hợp lệ, chỉ lượt GHI bị chặn ⇒ trang giải thích, không phải `/login`.
    if (ket.denied === "BILLING_LOCKED") redirect(BILLING_LOCKED_PATH);
    // Trang ERP ngoài vỏ app Chốt Đơn: phiên hợp lệ ⇒ về trang nhà của vỏ (hộp thư), không về `/login`.
    if (ket.denied === "SHELL_RESTRICTED") redirect(ket.home ?? SALES_AGENT_INBOX_HREF);
    redirect(`/login?reason=${DENY_REASON_PARAM[ket.denied]}`);
  }
  const user = ket.user;
  // Đích từ chối theo người (lib/constants/saas-nav.ts::forbiddenRedirectFor): ERP `/?forbidden=1` như cũ; người vỏ Chốt Đơn về
  // trang nhà của vỏ — `/` bị chính layout vỏ chặn, và từ một server action đó là vòng trang trắng.
  if (roles && !roles.includes(user.role) && user.role !== "ADMIN") redirect(forbiddenRedirectFor(user));
  return user;
}

/** Như requireUser nhưng bắt buộc có quyền; thiếu quyền → về trang nhà với thông báo (`forbiddenRedirectFor`) */
export async function requirePermission(permission: Permission): Promise<SessionUser> {
  const user = await requireUser();
  if (!can(user, permission)) redirect(forbiddenRedirectFor(user));
  return user;
}

export const ROLE_LABEL: Record<Role, string> = {
  ADMIN: "Quản trị",
  MANAGER: "Quản lý",
  LEADER: "Trưởng nhóm",
  ACCOUNTANT: "Kế toán",
  WAREHOUSE: "Kho",
  CS: "CSKH",
  MARKETING: "Marketing",
  VIEWER: "Chỉ xem",
};

/** Khoá quyền chỉ người của TỔ CHỨC NHÀ có hiệu lực (docs/platform/shared-contracts.md mục 11) — khai ở `lib/auth/permissions.ts` (thuần) để menu dùng cùng luật. */
export { PLATFORM_OPERATE_PERMISSION };

/**
 * Khoá quyền này có thuộc một module ĐANG TẮT của tổ chức người dùng không — trả khoá module đó, hoặc
 * `null`. `modules` vắng mặt (người dùng dựng tay trong kiểm thử, không qua `resolveCurrentUser()`)
 * ⇒ không có cổng module.
 */
export function permissionModuleDisabled(subject: SessionUser, permission: string): ModuleKey | null {
  if (!subject.modules) return null;
  const owner = moduleOfPermission(permission);
  return owner && !subject.modules.includes(owner) ? owner : null;
}

/**
 * Kiểm tra quyền: truyền người dùng (quyền đã tuỳ chỉnh) hoặc vai trò (quyền mẫu mặc định).
 *
 * Với NGƯỜI DÙNG, thứ tự là cổng module → cổng nền tảng → luật cũ:
 *  · Khoá thuộc module đang tắt ⇒ `false`, KỂ CẢ ADMIN (target-architecture P8). ADMIN vượt mọi kiểm
 *    QUYỀN, không vượt được cấu hình của TỔ CHỨC — nếu không, tắt module chỉ là ẩn menu.
 *  · `platform:operate` ⇒ chỉ người của tổ chức NHÀ. ADMIN của tổ chức khác KHÔNG BAO GIỜ có, và
 *    người không mang thông tin tổ chức cũng không (mọi nhánh lỗi rơi về phía HẸP HƠN, luật 31).
 *
 * Với VAI TRÒ (chuỗi): không có ngữ cảnh tổ chức ⇒ luật cũ — chỉ dùng cho màn hình mẫu quyền.
 */
export function can(subject: SessionUser | Role, permission: Permission) {
  if (typeof subject === "string") return subject === "ADMIN" || hasPermission(resolvePermissions(subject, null), permission);
  if (permissionModuleDisabled(subject, permission)) return false;
  if (homeOrgPermissionDenied(subject, permission)) return false;
  return subject.role === "ADMIN" || hasPermission(subject.permissions, permission);
}
