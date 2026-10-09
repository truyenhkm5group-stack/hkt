/**
 * ═══════════ NGHIỆM THU BẢO MẬT TRÊN PRODUCTION — LÕI CỦA OPS `security-acceptance` (LAUNCH_GATE §3 · docs/saas/ACCEPTANCE.md §11) ═══════════
 *
 * CHỈ ĐỌC: mọi lượt gọi HTTP là GET tới ứng dụng đang chạy (`127.0.0.1:3000` với Host chỉ định — đúng cách bước C của
 * `saas-acceptance` mở vỏ app); mọi lượt đọc CSDL là SELECT trên CSDL NHÀ (script đặt ERP_READ_ONLY=1 và hỏi lại Postgres).
 * Không ghi, không gửi job / tin, không tạo phiên cho tài khoản khách thật:
 *  · phiên phía VỎ = tài khoản quản trị của workspace NGHIỆM THU (sổ khai + `acceptanceWorkspaceOwned`), ký bằng `signSession` hạn
 *    ngắn — y như bước C;
 *  · phiên phía NHÀ = một tài khoản ADMIN đang bật của tổ chức nhà, y như `scripts/smoke.ts` ký cho lượt smoke sau deploy.
 * Phiên chỉ sống trong bộ nhớ của lượt chạy, không in.
 *
 * S1 · lấy id bản ghi THẬT của tổ chức nhà (một đơn · một khách · một hội thoại · một ảnh của nhân viên) ⇒ mở bằng phiên vỏ; lấy
 *      id hội thoại của workspace nghiệm thu từ sổ AI của nền tảng (`platform_ai_usage.conversation_id` — không mở CSDL của nó) ⇒ mở
 *      bằng phiên nhà. Dấu hiệu nội dung (tên / SĐT của bản ghi) chỉ nằm trong bộ nhớ để so; id chỉ in ở dạng đã thay bằng nhãn.
 * S2 · trang vỏ (cùng danh sách bước C) + trang công khai ⇒ quét bằng `scanForSecrets` (mẫu + GIÁ TRỊ THẬT của biến môi trường bí mật).
 * S3 · mỗi tổ chức mở bằng `getDbForInspection` (máy chủ ép chỉ đọc, KHÔNG migrate, KHÔNG dọn bảng `platform_*` — `getDb()` của tổ
 *      chức thì có, nên không dùng được trên kết nối chỉ đọc) rồi hỏi `secretsAtRestCells` của lib/connectors/service.ts — nơi DUY
 *      NHẤT được chạm cột bản mã (tests/connectors.test.ts). Hàm ấy phán phong bì ngay bên trong và chỉ trả loại ô + phán quyết:
 *      không byte nào, không giải mã. Tổ chức nhà dùng chính CSDL nhà. Mã tổ chức chỉ ra phần mã hoá.
 */
import { and, desc, eq, isNotNull, ne } from "drizzle-orm";
import { getDb, getDbForInspection, getPlatformDb, schema } from "@/db";
import { secretsAtRestCells, type SecretAtRestVerdict } from "@/lib/connectors/service";
import { findIdentity } from "@/lib/auth/identities";
import { signSession } from "@/lib/auth/session";
import { ACCEPTANCE_WORKSPACES, type AcceptanceWorkspace } from "@/lib/constants/saas-acceptance";
import { isSalesAgentUser, type ShellUser } from "@/lib/constants/saas-nav";
import {
  classifyIsolationProbe,
  envSecretValues,
  scanForSecrets,
  usableMarkers,
  type ProbeKind,
  type ProbeVerdict,
  type SecurityCheck,
} from "@/lib/constants/security-acceptance";
import { SESSION_COOKIE } from "@/lib/constants/session";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { findOrganization, getHomeOrganization, invalidateOrganizations, listOrganizations } from "@/lib/platform/organizations";
import { chotdonAppHost, chotdonDomainFrom, siteDomainFrom, type SiteEnv } from "@/lib/platform/site-host";
import { ACCEPTANCE_SESSION_TTL_SEC, metaRedirectTarget, shellRoutesFor, type AcceptanceDeps, type HttpReply } from "@/lib/saas/acceptance";
import { acceptanceWorkspaceOwned } from "@/lib/saas/acceptance-guard";

/** Một ô bí mật đã phán (S3) — `category` là tên bảng (in ra), `orgCode` chỉ vào phần mã hoá. Không byte nào của ô. */
export type SecretCell = { orgCode: string; category: string; verdict: SecretAtRestVerdict };

/** Đường đọc S3 của production: CSDL CHỈ ĐỌC của tổ chức ⇒ `secretsAtRestCells` (lib/connectors/service.ts). */
export async function inspectSecretCells(org: { code: string; isHome: boolean }): Promise<SecretCell[]> {
  const db = await getDbForInspection(org);
  return (await secretsAtRestCells(db, org.code)).map((c) => ({ orgCode: org.code, ...c }));
}

export type SecurityDeps = {
  appGet: AcceptanceDeps["appGet"];
  siteEnv: SiteEnv;
  baseDomain: string | null;
  /** Host của ERP nhà (phiên nhà + trang /login công khai). */
  homeHost: string;
  /** Biến môi trường để so giá trị bí mật thật (S2) — chỉ trong bộ nhớ. */
  env: Readonly<Record<string, string | undefined>>;
  emit: (line: string) => void;
  /** S3 — đường đọc CHỈ ĐỌC các ô bản mã của MỘT tổ chức. `null` = chưa có đường được phép ⇒ CHƯA ĐO ĐƯỢC. */
  readSecretCells: ((org: { code: string; isHome: boolean }) => Promise<SecretCell[]>) | null;
};

const PAGE_TIMEOUT_MS = 60_000;
const MAX_REDIRECTS = 5;

const firstLine = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 200);
const pathOf = (location: string) => {
  try {
    const u = new URL(location, "http://ung-dung.local");
    return `${u.pathname}${u.search}`;
  } catch {
    return location;
  }
};

/** GET theo chuyển hướng như trình duyệt (tối đa `MAX_REDIRECTS`); ghi lại có bị đá về /login không. */
export async function fetchFollow(appGet: AcceptanceDeps["appGet"], path: string, host: string, cookie: string | undefined): Promise<{ reply: HttpReply; finalPath: string; loginRedirect: boolean }> {
  let current = path;
  let reply: HttpReply = { status: 0, location: null, body: "" };
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    reply = await appGet(current, { host, cookie, timeoutMs: PAGE_TIMEOUT_MS });
    const target = reply.status >= 300 && reply.status < 400 ? reply.location : reply.status === 200 ? metaRedirectTarget(reply.body) : null;
    if (!target) return { reply, finalPath: current, loginRedirect: false };
    const next = pathOf(target);
    if (next.split("?")[0] === "/login") return { reply, finalPath: next, loginRedirect: true };
    current = next;
  }
  return { reply, finalPath: current, loginRedirect: false };
}

// ─────────────────────────── S1 · mục tiêu + lượt dò ───────────────────────────

/** Một lượt dò: `label` thay id bằng nhãn (in ra phần mã hoá); `path` mang id thật (không in). */
export type Probe = { direction: "VO_TO_NHA" | "NHA_TO_VO"; kind: ProbeKind; label: string; path: string | null; markers: string[]; missing: string | null };

const s = (v: unknown) => (typeof v === "string" ? v : v === null || v === undefined ? "" : String(v));

/** Id bản ghi THẬT của tổ chức nhà + dấu hiệu nội dung của chúng (CHỈ ĐỌC, CSDL nhà). */
export async function homeProbes(): Promise<Probe[]> {
  const db = await getDb();
  const o = schema.orders;
  const [order] = await db.select({ id: o.id, name: o.billFullName, phone: o.billPhone }).from(o).where(ne(o.billPhone, "")).orderBy(desc(o.insertedAt)).limit(1);
  const c = schema.customers;
  const [customer] = await db.select({ id: c.id, name: c.name, phone: c.phone }).from(c).where(isNotNull(c.phone)).orderBy(desc(c.createdAt)).limit(1);
  const cv = schema.salesChatConversations;
  const [conv] = await db.select({ id: cv.id, customerId: cv.customerId }).from(cv).orderBy(desc(cv.updatedAt)).limit(1);
  const [convCustomer] = conv?.customerId ? await db.select({ name: c.name, phone: c.phone }).from(c).where(eq(c.id, conv.customerId)).limit(1) : [];
  const si = schema.salesChatStaffImages;
  const [image] = await db.select({ id: si.id }).from(si).orderBy(desc(si.createdAt)).limit(1);
  const orderMarkers = [s(order?.name), s(order?.phone)];
  const customerMarkers = [s(customer?.name), s(customer?.phone)];
  const convMarkers = [s(convCustomer?.name), s(convCustomer?.phone)];
  const P = (kind: ProbeKind, label: string, id: string | undefined, build: (id: string) => string, markers: string[], what: string): Probe => {
    const path = id ? build(id) : null;
    return { direction: "VO_TO_NHA", kind, label, path, markers: path ? usableMarkers(markers, path) : [], missing: id ? null : `tổ chức nhà chưa có ${what}` };
  };
  return [
    P("DETAIL", "/orders/‹đơn của nhà›", order?.id, (id) => `/orders/${encodeURIComponent(id)}`, orderMarkers, "đơn có SĐT"),
    P("DETAIL", "/orders/‹đơn của nhà›/edit", order?.id, (id) => `/orders/${encodeURIComponent(id)}/edit`, orderMarkers, "đơn có SĐT"),
    P("DETAIL", "/customers/‹khách của nhà›", customer?.id, (id) => `/customers/${encodeURIComponent(id)}`, customerMarkers, "khách có SĐT"),
    P("DETAIL", "/ai/sales-chatbot/conversations/‹hội thoại của nhà›", conv?.id, (id) => `/ai/sales-chatbot/conversations/${encodeURIComponent(id)}`, convMarkers, "hội thoại bot"),
    P("LIST", "/ai/sales-chatbot/inbox?c=‹hội thoại của nhà›", conv?.id, (id) => `/ai/sales-chatbot/inbox?c=${encodeURIComponent(id)}`, convMarkers, "hội thoại bot"),
    P("API", "/api/ai-sales/inbox-images/‹ảnh của nhà›", image?.id, (id) => `/api/ai-sales/inbox-images/${encodeURIComponent(id)}`, [], "ảnh nhân viên gửi"),
  ];
}

/** Id hội thoại của workspace nghiệm thu — đọc từ sổ AI của NỀN TẢNG (không mở CSDL của workspace). */
export async function acceptanceProbes(entry: AcceptanceWorkspace): Promise<Probe[]> {
  const pdb = await getPlatformDb();
  const u = schema.platformAiUsage;
  const [row] = await pdb.select({ id: u.conversationId }).from(u).where(and(eq(u.orgCode, entry.code), isNotNull(u.conversationId))).orderBy(desc(u.at)).limit(1);
  const id = row?.id ?? null;
  return [
    {
      direction: "NHA_TO_VO",
      kind: "DETAIL",
      label: "/ai/sales-chatbot/conversations/‹hội thoại của workspace nghiệm thu›",
      path: id ? `/ai/sales-chatbot/conversations/${encodeURIComponent(id)}` : null,
      markers: [],
      missing: id ? null : "workspace nghiệm thu chưa có hội thoại nào trong sổ AI (chạy saas-acceptance --apply --e2e một lần)",
    },
  ];
}

export type ProbeResult = { probe: Probe; verdict: ProbeVerdict; status: number | null; why: string };

export async function runProbe(appGet: AcceptanceDeps["appGet"], probe: Probe, host: string, cookie: string): Promise<ProbeResult> {
  if (!probe.path) return { probe, verdict: "SKIPPED", status: null, why: probe.missing ?? "không có id" };
  try {
    const r = await fetchFollow(appGet, probe.path, host, cookie);
    const verdict = classifyIsolationProbe({ kind: probe.kind, requestedPath: probe.path, finalPath: r.finalPath, status: r.reply.status, body: r.reply.body, markers: probe.markers, loginRedirect: r.loginRedirect });
    const moved = r.finalPath.split("?")[0] !== probe.path.split("?")[0] ? " · bị chuyển ra khỏi đường dẫn bản ghi" : "";
    return { probe, verdict, status: r.reply.status, why: `HTTP ${r.reply.status}${moved} · ${probe.markers.length} dấu hiệu nội dung đem so` };
  } catch (e) {
    return { probe, verdict: "UNSURE", status: null, why: `không mở được: ${firstLine(e)}` };
  }
}

/** Gom kết quả S1 ⇒ trạng thái + số đếm (tên đếm cố định). THUẦN. */
export function summarizeS1(results: readonly ProbeResult[], skippedDirections: readonly string[] = []): Pick<SecurityCheck, "status" | "counts" | "note"> {
  const counts: Record<string, number> = {};
  for (const r of results) counts[`${r.probe.direction === "VO_TO_NHA" ? "vo→nha" : "nha→vo"}:${r.verdict}`] = (counts[`${r.probe.direction === "VO_TO_NHA" ? "vo→nha" : "nha→vo"}:${r.verdict}`] ?? 0) + 1;
  const bad = results.filter((r) => r.verdict === "LEAK" || r.verdict === "UNSURE" || r.verdict === "SESSION_REJECTED").length;
  const blocked = results.filter((r) => r.verdict === "BLOCKED").length;
  const note = skippedDirections.length ? `bỏ qua: ${skippedDirections.join(" · ")}` : null;
  return { status: bad ? "FAIL" : blocked ? "PASS" : "SKIP", counts, note };
}

// ─────────────────────────── S3 · ô bản mã ───────────────────────────

/** Gom phán quyết phong bì ⇒ trạng thái + số đếm theo loại ô (KHÔNG mã tổ chức). THUẦN. */
export function summarizeS3(cells: readonly SecretCell[]): Pick<SecurityCheck, "status" | "counts"> & { byOrg: Record<string, Record<SecretAtRestVerdict, number>> } {
  const counts: Record<string, number> = {};
  const byOrg: Record<string, Record<SecretAtRestVerdict, number>> = {};
  for (const c of cells) {
    const v = c.verdict;
    counts[`${c.category}:${v}`] = (counts[`${c.category}:${v}`] ?? 0) + 1;
    const o = (byOrg[c.orgCode] ??= { ENCRYPTED: 0, EMPTY: 0, PLAINTEXT: 0, MALFORMED: 0, FOREIGN_ORG: 0 });
    o[v] += 1;
  }
  // Bản rõ · sai hình · dòng mang mã tổ chức khác (bản sao chép nhầm CSDL) đều là hỏng.
  const bad = Object.values(byOrg).reduce((n, o) => n + o.PLAINTEXT + o.MALFORMED + o.FOREIGN_ORG, 0);
  return { status: bad ? "FAIL" : "PASS", counts, byOrg };
}

// ─────────────────────────── Chạy ───────────────────────────

const S3_UNAVAILABLE_NOTE = "lượt chạy không có đường đọc ô bản mã (readSecretCells) — chưa đo";

export async function runSecurityAcceptance(deps: SecurityDeps): Promise<SecurityCheck[]> {
  const entry = ACCEPTANCE_WORKSPACES[0];
  invalidateOrganizations();
  const org = entry ? await findOrganization(entry.code) : null;
  const owned = Boolean(entry && org && (await acceptanceWorkspaceOwned(entry)));
  const shellHost = chotdonAppHost(deps.siteEnv);

  // Phiên VỎ: tài khoản quản trị của workspace nghiệm thu (đúng cách bước C).
  let shellCookie: string | null = null;
  let shellUser: ShellUser | null = null;
  let shellWhy: string | null = null;
  if (!entry || !org) shellWhy = "chưa có workspace nghiệm thu (chạy saas-acceptance --apply)";
  else if (!owned) shellWhy = "workspace mang mã nghiệm thu KHÔNG do ops tạo — không ký phiên cho nó";
  else if (!shellHost) shellWhy = "nền tảng tắt tên miền Chốt Đơn — vỏ không có host";
  else {
    const userId = (await findIdentity("EMAIL", entry.ownerEmail)).find((h) => h.orgCode === entry.code)?.userId ?? null;
    if (!userId) shellWhy = "không có chỉ mục danh tính của tài khoản thử (chạy saas-acceptance --apply)";
    else {
      invalidateCapabilities(entry.code);
      const modules = [...(await getEnabledModules(entry.code))];
      shellUser = { role: "ADMIN", permissions: [], organization: { isHome: false, brand: org.brand ?? null }, modules };
      if (!isSalesAgentUser(shellUser)) shellWhy = "workspace nghiệm thu không mang vỏ Chốt Đơn";
      else shellCookie = `${SESSION_COOKIE}=${await signSession({ id: userId, email: entry.ownerEmail, name: entry.ownerName, role: "ADMIN", orgCode: entry.code }, { ttlSec: ACCEPTANCE_SESSION_TTL_SEC })}`;
    }
  }

  // Phiên NHÀ: một ADMIN đang bật của tổ chức nhà (đúng cách smoke ký).
  const home = await getHomeOrganization();
  const [admin] = await (await getDb()).select({ id: schema.users.id, email: schema.users.email, name: schema.users.name }).from(schema.users).where(and(eq(schema.users.role, "ADMIN"), eq(schema.users.active, true))).orderBy(schema.users.id).limit(1);
  const homeCookie = admin ? `${SESSION_COOKIE}=${await signSession({ id: admin.id, email: admin.email, name: admin.name, role: "ADMIN", orgCode: home.code }, { ttlSec: ACCEPTANCE_SESSION_TTL_SEC })}` : null;

  // ── S1 ──
  const s1: ProbeResult[] = [];
  const s1Skipped: string[] = [];
  if (shellCookie && shellHost) for (const p of await homeProbes()) s1.push(await runProbe(deps.appGet, p, shellHost, shellCookie));
  else s1Skipped.push(`vỏ→nhà (${shellWhy})`);
  if (homeCookie && entry) for (const p of await acceptanceProbes(entry)) s1.push(await runProbe(deps.appGet, p, deps.homeHost, homeCookie));
  else s1Skipped.push("nhà→vỏ (tổ chức nhà không có ADMIN đang bật để ký phiên)");
  const S1 = summarizeS1(s1, s1Skipped);
  const s1Detail = [...s1.map((r) => `${r.probe.direction} ${r.probe.kind} ${r.probe.label}: ${r.verdict} — ${r.why}`), ...s1Skipped.map((x) => `bỏ qua ${x}`)];

  // ── S2 ──
  const pages: { host: string; path: string; cookie?: string; label: string }[] = [];
  if (shellCookie && shellHost && shellUser) for (const r of shellRoutesFor(shellUser)) pages.push({ host: shellHost, path: r.path, cookie: shellCookie, label: `vỏ ${r.path}` });
  if (shellHost) pages.push({ host: shellHost, path: "/login", label: "vỏ /login (không phiên)" });
  const cd = chotdonDomainFrom(deps.siteEnv.CHOTDON_DOMAIN);
  if (cd) for (const p of ["/", "/pricing"]) pages.push({ host: cd, path: p, label: `${cd}${p}` });
  const vnx = siteDomainFrom(deps.siteEnv.SITE_DOMAIN);
  if (vnx) for (const p of ["/", "/pricing"]) pages.push({ host: vnx, path: p, label: `${vnx}${p}` });
  if (entry && deps.baseDomain) pages.push({ host: `${entry.domainSlug}.${deps.baseDomain}`, path: "/chat", label: `chat công khai ${entry.domainSlug}` });
  pages.push({ host: deps.homeHost, path: "/login", label: "ERP nhà /login (không phiên)" });
  const envValues = envSecretValues(deps.env);
  const hits: Record<string, number> = {};
  const s2Detail: string[] = [];
  let scanned = 0;
  let unreachable = 0;
  for (const pg of pages) {
    try {
      const r = await fetchFollow(deps.appGet, pg.path, pg.host, pg.cookie);
      scanned += 1;
      const found = scanForSecrets(r.reply.body, envValues);
      for (const [k, n] of Object.entries(found)) hits[k] = (hits[k] ?? 0) + n;
      const names = Object.keys(found);
      s2Detail.push(`${pg.label}: HTTP ${r.reply.status} · ${Math.round(r.reply.body.length / 1024)}kB · ${names.length ? `TRÚNG ${names.join(", ")}` : "0 trúng"}`);
    } catch (e) {
      unreachable += 1;
      s2Detail.push(`${pg.label}: không mở được — ${firstLine(e)}`);
    }
  }
  const totalHits = Object.values(hits).reduce((a, b) => a + b, 0);
  const S2: SecurityCheck = {
    key: "S2",
    status: totalHits ? "FAIL" : scanned ? "PASS" : "SKIP",
    counts: { trang: scanned, khong_mo_duoc: unreachable, mau: envValues.length, trung: totalHits, ...hits },
    note: shellCookie ? null : `chỉ trang công khai — ${shellWhy}`,
    detail: s2Detail,
  };

  // ── S3 ──
  let S3: SecurityCheck;
  if (!deps.readSecretCells) S3 = { key: "S3", status: "SKIP", counts: {}, note: S3_UNAVAILABLE_NOTE, detail: [S3_UNAVAILABLE_NOTE] };
  else {
    const cells: SecretCell[] = [];
    const s3Detail: string[] = [];
    let orgs = 0;
    let activeFailed = 0;
    let inactiveFailed = 0;
    for (const o of await listOrganizations()) {
      try {
        cells.push(...(await deps.readSecretCells({ code: o.code, isHome: o.isHome })));
        orgs += 1;
      } catch (e) {
        // Tổ chức ĐANG HOẠT ĐỘNG mà không đọc được = CHƯA BIẾT ⇒ không được PASS. Tổ chức không hoạt động (lưu trữ / dựng hỏng) có thể
        // không còn CSDL — đếm riêng, nói ra, không đánh trượt S3 vì nó.
        if (o.status === "ACTIVE") activeFailed += 1;
        else inactiveFailed += 1;
        s3Detail.push(`${o.code} (${o.status}): không đọc được — ${firstLine(e)}`);
      }
    }
    const sum = summarizeS3(cells);
    for (const [code, c] of Object.entries(sum.byOrg)) s3Detail.push(`${code}: mã hoá ${c.ENCRYPTED} · trống ${c.EMPTY} · BẢN RÕ ${c.PLAINTEXT} · sai hình ${c.MALFORMED} · mang mã tổ chức khác ${c.FOREIGN_ORG}`);
    S3 = { key: "S3", status: activeFailed ? "FAIL" : sum.status, counts: { to_chuc: orgs, o: cells.length, ...sum.counts, to_chuc_hoat_dong_khong_doc_duoc: activeFailed, to_chuc_ngung_khong_doc_duoc: inactiveFailed }, note: null, detail: s3Detail };
  }

  return [{ key: "S1", ...S1, detail: s1Detail }, S2, S3];
}
