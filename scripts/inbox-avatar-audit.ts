/*
  ops `inbox-avatar-audit` — ẢNH ĐẠI DIỆN VÀ LINK FACEBOOK CỦA HỘP THƯ KHÁCH, ĐO TRÊN DỮ LIỆU THẬT CỦA MỘT TỔ CHỨC (CHỈ ĐỌC).

  Vì sao có (10/10/2026, chủ shop mục E · F): hộp thư đã có thành phần ảnh mà chủ shop HSLC vẫn thấy chữ cái, và bấm ảnh chỉ mở hồ
  sơ khách nội bộ. Script trả lời bằng SỐ ĐẾM, trên N hội thoại gần nhất của tổ chức chỉ định:
   1. ẢNH: bao nhiêu hội thoại có ảnh · theo từng trạng thái chẩn đoán `PROFILE_*` + lý do (`avatar-profile.ts::avatarStatusOf` —
      CÙNG hàm với ứng dụng) · lần lấy Graph hỏng theo MÃ lỗi Meta (quyền Business Asset User Profile Access có đủ không) · payload
      Pancake nói gì về ảnh (`state.pancakeAvatar.outcome` — có từ bản này; hội thoại chưa có tin mới sau deploy ⇒ CHƯA LẤY).
   2. LINK: bấm ảnh mở trang Facebook (hợp lệ) · về hồ sơ nội bộ theo LÝ DO · không link (chưa nối hồ sơ) — `avatarLinkOf`.
   3. NGHĨA CỦA `customers.fb_id` / `conversation_link`: tỷ lệ có mặt và DẠNG (số dài · số ngắn · có chữ · URL Facebook · URL
      Pancake · URL khác) — chỉ đếm dạng, KHÔNG in giá trị; và phép đo quyết định: `fb_id` của khách đã nối có TRÙNG phần cuối mã
      hội thoại Pancake `<page>_<PSID>` không (trùng ⇒ `fb_id` là PSID — mã THEO PAGE, không dựng được link trang Facebook).
   4. Tên các khoá trong `customers.raw` (payload khách Pancake) có dáng ảnh / link / hồ sơ — TÊN khoá, không giá trị — để biết
      Pancake có trả URL ảnh / URL trang Facebook thật không.

  Không in tên, SĐT, mã, URL hay chữ tin. Vẫn MÃ HOÁ cả lượt (ops-vps `OPS_THAO_TAC_MA_HOA`) để phần in thêm sau này không ra log;
  dòng [ops:tom-tat] là số đếm. CHỈ ĐỌC do Postgres ép (`ERP_READ_ONLY=1` trước lần mở kết nối đầu tiên + hỏi lại phiên).

  arg: `<mã tổ chức> [--limit=N]` (N hội thoại gần nhất, mặc định 300, trần 3000).
*/
const CHAY_THANG = Boolean(process.argv[1] && process.argv[1].endsWith("inbox-avatar-audit.ts"));
if (CHAY_THANG) process.env.ERP_READ_ONLY = "1";

import "dotenv/config";
import { inArray, isNotNull, sql } from "drizzle-orm";
import { getDbForInspection, schema, type Db } from "@/db";
import { findOrganization } from "@/lib/platform/organizations";
import { avatarLinkOf, avatarStatusOf, type AvatarLinkReason, type AvatarStatus, type FacebookIdInput } from "@/lib/sales-chatbot/avatar-profile";
import { safeAvatarUrl } from "@/lib/sales-chatbot/inbox-shared";
import { rowsOf } from "@/lib/sql-rows";

const tomTat = (s: string) => console.log(`[ops:tom-tat] ${s.slice(0, 300)}`);

export const AUDIT_DEFAULT_LIMIT = 300;
export const AUDIT_MAX_LIMIT = 3000;
/** Trần số khách đọc để đếm DẠNG `fb_id` / `conversation_link` trên cả bảng — đủ lớn cho một shop, có trần để không quét vô hạn. */
export const AUDIT_CUSTOMER_SCAN_MAX = 60_000;

// ─────────────────────────── PHẦN THUẦN ───────────────────────────

export type IdShape = "EMPTY" | "DIGITS_LONG" | "DIGITS_SHORT" | "ALNUM" | "URL_FACEBOOK" | "URL_PANCAKE" | "URL_OTHER";

/** DẠNG của một giá trị mã / link — không trả lại giá trị. Số dài = ≥ 15 chữ số (dáng PSID / mã Facebook). HÀM THUẦN. */
export function idShapeOf(v: unknown): IdShape {
  const s = typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "";
  if (!s) return "EMPTY";
  if (/^\d{15,}$/.test(s)) return "DIGITS_LONG";
  if (/^\d+$/.test(s)) return "DIGITS_SHORT";
  if (/^https?:\/\//i.test(s)) {
    let host = "";
    try {
      host = new URL(s).hostname.toLowerCase();
    } catch {
      return "URL_OTHER";
    }
    if (/(^|\.)(facebook\.com|fb\.com|messenger\.com)$/.test(host)) return "URL_FACEBOOK";
    if (/(^|\.)(pancake\.vn|pages\.fm|pancake\.ph|pancake\.biz)$/.test(host)) return "URL_PANCAKE";
    return "URL_OTHER";
  }
  return "ALNUM";
}

/** Phần PSID của mã hội thoại Pancake INBOX `<page>_<PSID>` — không đúng dạng ⇒ `null`. HÀM THUẦN. */
export function pancakeThreadPsid(threadId: string | null | undefined, pageId: string | null | undefined): string | null {
  const t = (threadId ?? "").trim();
  const p = (pageId ?? "").trim();
  if (!p || !t.startsWith(`${p}_`)) return null;
  const rest = t.slice(p.length + 1);
  return /^\d{5,30}$/.test(rest) ? rest : null;
}

export type AuditConversation = { channel: string; pageId: string | null; threadId: string | null; customerId: string | null; transport: string | null; state: unknown };
export type AuditCustomer = { fbId: string | null; conversationLink: string | null };

export type AvatarAuditReport = {
  conversations: number;
  bySource: Record<string, number>;
  withAvatarUrl: number;
  byStatus: Record<AvatarStatus, number>;
  byReason: Record<string, number>;
  metaErrorCodes: Record<string, number>;
  pancakeOutcome: Record<string, number>;
  link: { facebook: number; internal: number; none: number; byReason: Partial<Record<AvatarLinkReason, number>> };
  linkedCustomers: number;
  linkedFbId: Record<IdShape, number>;
  linkedConversationLink: Record<IdShape, number>;
  /** Hội thoại Pancake đã nối khách có `fb_id`: so `fb_id` với phần PSID của mã hội thoại. */
  fbIdVsThreadPsid: { equal: number; different: number; threadNotPsidShaped: number };
};

const zeroShapes = (): Record<IdShape, number> => ({ EMPTY: 0, DIGITS_LONG: 0, DIGITS_SHORT: 0, ALNUM: 0, URL_FACEBOOK: 0, URL_PANCAKE: 0, URL_OTHER: 0 });
const bump = (m: Record<string, number>, k: string) => {
  m[k] = (m[k] ?? 0) + 1;
};
export const sourceOfAudit = (c: Pick<AuditConversation, "channel" | "transport">) => (c.channel === "ZALO" ? "ZALO" : c.channel !== "FANPAGE" ? "WEB" : c.transport === "MESSENGER" ? "DIRECT" : c.transport === "PANCAKE" ? "PANCAKE" : "FANPAGE_UNKNOWN");

/**
 * Đếm ảnh / link / nghĩa mã trên các hội thoại đã đọc. Mã Facebook đưa vào `avatarLinkOf` kèm NGHĨA theo sổ `FACEBOOK_ID_SOURCES`
 * — đúng như ứng dụng phải làm, nên số «mở trang Facebook» ở đây là số ứng dụng sẽ cho. HÀM THUẦN.
 */
export function auditAvatars(convs: readonly AuditConversation[], customers: ReadonlyMap<string, AuditCustomer>, now: Date): AvatarAuditReport {
  const r: AvatarAuditReport = {
    conversations: convs.length,
    bySource: {},
    withAvatarUrl: 0,
    byStatus: { PROFILE_AVAILABLE: 0, PROFILE_PERMISSION_DENIED: 0, PROFILE_NOT_AVAILABLE: 0, PROFILE_EXPIRED: 0, PROFILE_NOT_FETCHED: 0 },
    byReason: {},
    metaErrorCodes: {},
    pancakeOutcome: {},
    link: { facebook: 0, internal: 0, none: 0, byReason: {} },
    linkedCustomers: 0,
    linkedFbId: zeroShapes(),
    linkedConversationLink: zeroShapes(),
    fbIdVsThreadPsid: { equal: 0, different: 0, threadNotPsidShaped: 0 },
  };
  for (const c of convs) {
    const source = sourceOfAudit(c);
    bump(r.bySource, source);
    const st = (c.state && typeof c.state === "object" ? c.state : {}) as Record<string, unknown>;
    const meta = (st.messengerProfile && typeof st.messengerProfile === "object" ? st.messengerProfile : {}) as Record<string, unknown>;
    if (safeAvatarUrl(meta.pic) ?? safeAvatarUrl(st.pancakeAvatarUrl)) r.withAvatarUrl += 1;
    const d = avatarStatusOf(st, now);
    r.byStatus[d.status] += 1;
    bump(r.byReason, d.reason);
    if (typeof meta.at === "string" && meta.error) bump(r.metaErrorCodes, meta.code === null || meta.code === undefined ? "không mã (dòng trước 10/10)" : `#${String(meta.code)}${meta.subcode ? `/${String(meta.subcode)}` : ""}`);
    const pk = (st.pancakeAvatar && typeof st.pancakeAvatar === "object" ? st.pancakeAvatar : null) as Record<string, unknown> | null;
    if (source === "PANCAKE" || source === "FANPAGE_UNKNOWN") bump(r.pancakeOutcome, pk && typeof pk.outcome === "string" ? pk.outcome : "CHƯA_THẤY_PAYLOAD");

    const cust = c.customerId ? customers.get(c.customerId) ?? null : null;
    const ids: FacebookIdInput[] = [];
    if (cust?.fbId) ids.push({ value: cust.fbId, source: "PANCAKE_CUSTOMER_FB_ID" });
    if (source === "DIRECT" && c.threadId) ids.push({ value: c.threadId, source: "META_PSID" });
    const psid = pancakeThreadPsid(c.threadId, c.pageId);
    if (source !== "DIRECT" && psid) ids.push({ value: psid, source: "PANCAKE_FROM_PSID" });
    const link = avatarLinkOf({ customerId: c.customerId, ids });
    if (link.external) r.link.facebook += 1;
    else if (link.href) r.link.internal += 1;
    else r.link.none += 1;
    r.link.byReason[link.reason] = (r.link.byReason[link.reason] ?? 0) + 1;

    if (cust) {
      r.linkedCustomers += 1;
      r.linkedFbId[idShapeOf(cust.fbId)] += 1;
      r.linkedConversationLink[idShapeOf(cust.conversationLink)] += 1;
      if (cust.fbId && source !== "DIRECT") {
        if (!psid) r.fbIdVsThreadPsid.threadNotPsidShaped += 1;
        else if (psid === cust.fbId.trim()) r.fbIdVsThreadPsid.equal += 1;
        else r.fbIdVsThreadPsid.different += 1;
      }
    }
  }
  return r;
}

/** Tên khoá payload trông như ảnh / link / hồ sơ / mã Facebook — chỉ TÊN, dùng để biết nguồn có trả gì. HÀM THUẦN. */
export function interestingRawKey(k: string): boolean {
  return /avatar|picture|pic|photo|image|link|url|profile|fb|facebook|psid|global|scoped|uid|username/i.test(k);
}

const fmt = (m: Record<string, number>) =>
  Object.entries(m)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k} ${n}`)
    .join(" · ") || "0";

// ─────────────────────────── ĐỌC DỮ LIỆU ───────────────────────────

export function parseAuditArgs(argv: readonly string[]): { code: string; limit: number } | { error: string } {
  const code = (argv.find((a) => !a.startsWith("--")) ?? "").trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(code)) return { error: "thiếu / sai mã tổ chức" };
  const raw = argv.find((a) => a.startsWith("--limit="))?.slice(8);
  const limit = raw === undefined ? AUDIT_DEFAULT_LIMIT : Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > AUDIT_MAX_LIMIT) return { error: `--limit phải là số nguyên 1..${AUDIT_MAX_LIMIT}` };
  return { code, limit };
}

async function main() {
  const args = parseAuditArgs(process.argv.slice(2));
  if ("error" in args) {
    tomTat(`inbox-avatar-audit: DỪNG · cách dùng sai — ${args.error} (arg: <mã tổ chức> [--limit=1..${AUDIT_MAX_LIMIT}])`);
    process.exit(1);
  }
  const org = await findOrganization(args.code);
  if (!org) {
    tomTat(`inbox-avatar-audit: DỪNG · không có tổ chức «${args.code}»`);
    process.exit(1);
  }
  const db: Db = await getDbForInspection({ code: org.code, isHome: org.isHome });
  const [ro] = rowsOf<Record<string, unknown>>(await db.execute(sql`show default_transaction_read_only`));
  if (String(ro?.default_transaction_read_only ?? "") !== "on") {
    tomTat("inbox-avatar-audit: DỪNG · phiên CSDL KHÔNG ở chế độ chỉ đọc — không đọc gì");
    process.exit(1);
  }
  const now = new Date();
  const c = schema.salesChatConversations;
  const convRows = await db
    .select({ channel: c.channel, pageId: c.pageId, threadId: c.threadId, customerId: c.customerId, state: c.state })
    .from(c)
    .orderBy(sql`coalesce(${c.lastCustomerAt}, ${c.updatedAt}) desc nulls last`)
    .limit(args.limit);

  // Đường tin của hội thoại = đường của tin gần nhất có ghi đường (cùng cách hộp thư phân nguồn, inbox.ts::inboxSourceOf).
  const t = schema.salesChatInbound;
  const threadIds = [...new Set(convRows.map((r) => r.threadId).filter((x): x is string => Boolean(x)))];
  const transportOf = new Map<string, string>();
  for (let i = 0; i < threadIds.length; i += 500) {
    const part = threadIds.slice(i, i + 500);
    const rows = rowsOf<{ page_id: string; thread_id: string; transport: string }>(
      await db.execute(sql`select distinct on (page_id, thread_id) page_id, thread_id, transport from ${t} where thread_id in (${sql.join(part.map((x) => sql`${x}`), sql`, `)}) and transport is not null order by page_id, thread_id, created_at desc`),
    );
    for (const r of rows) transportOf.set(`${r.page_id}|${r.thread_id}`, r.transport);
  }

  const cu = schema.customers;
  const customerIds = [...new Set(convRows.map((r) => r.customerId).filter((x): x is string => Boolean(x)))];
  const customers = new Map<string, AuditCustomer>();
  for (let i = 0; i < customerIds.length; i += 500) {
    const rows = await db.select({ id: cu.id, fbId: cu.fbId, conversationLink: cu.conversationLink }).from(cu).where(inArray(cu.id, customerIds.slice(i, i + 500)));
    for (const r of rows) customers.set(r.id, { fbId: r.fbId, conversationLink: r.conversationLink });
  }

  const convs: AuditConversation[] = convRows.map((r) => ({ ...r, transport: r.pageId && r.threadId ? transportOf.get(`${r.pageId}|${r.threadId}`) ?? null : null }));
  const rep = auditAvatars(convs, customers, now);

  // Cả bảng khách: tỷ lệ có mặt + DẠNG của fb_id / conversation_link (đếm ở TypeScript bằng CÙNG `idShapeOf`).
  const allCust = await db.select({ fbId: cu.fbId, conversationLink: cu.conversationLink }).from(cu).limit(AUDIT_CUSTOMER_SCAN_MAX + 1);
  const capped = allCust.length > AUDIT_CUSTOMER_SCAN_MAX;
  const scan = allCust.slice(0, AUDIT_CUSTOMER_SCAN_MAX);
  const allFb = zeroShapes();
  const allLink = zeroShapes();
  for (const r of scan) {
    allFb[idShapeOf(r.fbId)] += 1;
    allLink[idShapeOf(r.conversationLink)] += 1;
  }
  // Tên khoá trong payload khách Pancake đã lưu (`customers.raw`) — chỉ TÊN.
  const keyRows = rowsOf<{ k: string; n: number | string }>(
    await db.execute(sql`select k, count(*)::int as n from (select jsonb_object_keys(${cu.raw}) as k from ${cu} where ${cu.raw} is not null and jsonb_typeof(${cu.raw}) = 'object' limit 2000000) x group by k order by n desc`),
  );
  const rawKeys = keyRows.filter((r) => interestingRawKey(r.k)).map((r) => `${r.k} ${Number(r.n)}`);
  const rawRows = await db.select({ n: sql<number>`count(*)::int` }).from(cu).where(isNotNull(cu.raw));

  // ── CHI TIẾT (phần MÃ HOÁ — cũng chỉ số đếm) ──
  console.log(`Tổ chức ${org.code} · ${rep.conversations} hội thoại gần nhất (trần ${args.limit}) · lúc ${now.toISOString()}`);
  console.log(`Nguồn: ${fmt(rep.bySource)}`);
  console.log(`Ảnh: có URL ảnh ${rep.withAvatarUrl} · trạng thái ${fmt(rep.byStatus)}`);
  console.log(`Lý do ảnh: ${fmt(rep.byReason)}`);
  console.log(`Graph lỗi theo mã: ${fmt(rep.metaErrorCodes)}`);
  console.log(`Payload Pancake nói về ảnh: ${fmt(rep.pancakeOutcome)}`);
  console.log(`Link: Facebook ${rep.link.facebook} · hồ sơ nội bộ ${rep.link.internal} · không link ${rep.link.none} · lý do ${fmt(rep.link.byReason as Record<string, number>)}`);
  console.log(`Khách đã nối ${rep.linkedCustomers}: fb_id ${fmt(rep.linkedFbId)} · conversation_link ${fmt(rep.linkedConversationLink)}`);
  console.log(`fb_id so với PSID trong mã hội thoại Pancake: trùng ${rep.fbIdVsThreadPsid.equal} · khác ${rep.fbIdVsThreadPsid.different} · mã hội thoại không dạng <page>_<PSID> ${rep.fbIdVsThreadPsid.threadNotPsidShaped}`);
  console.log(`Cả bảng khách ${scan.length}${capped ? ` (cắt ở ${AUDIT_CUSTOMER_SCAN_MAX})` : ""}: fb_id ${fmt(allFb)} · conversation_link ${fmt(allLink)}`);
  console.log(`customers.raw có ${Number(rawRows[0]?.n ?? 0)} dòng · khoá dáng ảnh/link/hồ sơ: ${rawKeys.join(" · ") || "không có"}`);

  // ── TÓM TẮT (số đếm, ra log công khai) ──
  const s = rep.byStatus;
  tomTat(`inbox-avatar-audit ${org.code}: ${rep.conversations} hội thoại (${fmt(rep.bySource)}) · có ảnh ${rep.withAvatarUrl}`);
  tomTat(`Trạng thái ảnh: AVAILABLE ${s.PROFILE_AVAILABLE} · PERMISSION_DENIED ${s.PROFILE_PERMISSION_DENIED} · NOT_AVAILABLE ${s.PROFILE_NOT_AVAILABLE} · EXPIRED ${s.PROFILE_EXPIRED} · NOT_FETCHED ${s.PROFILE_NOT_FETCHED}`);
  tomTat(`Lý do ảnh: ${fmt(rep.byReason)}`);
  tomTat(`Graph lỗi theo mã: ${fmt(rep.metaErrorCodes)} · payload Pancake: ${fmt(rep.pancakeOutcome)}`);
  tomTat(`Bấm ảnh: trang Facebook hợp lệ ${rep.link.facebook} · hồ sơ nội bộ ${rep.link.internal} · không link ${rep.link.none} · lý do ${fmt(rep.link.byReason as Record<string, number>)}`);
  tomTat(`Khách đã nối ${rep.linkedCustomers}: fb_id ${fmt(rep.linkedFbId)} · conversation_link ${fmt(rep.linkedConversationLink)} · fb_id = PSID mã hội thoại: trùng ${rep.fbIdVsThreadPsid.equal} / khác ${rep.fbIdVsThreadPsid.different} / không dạng ${rep.fbIdVsThreadPsid.threadNotPsidShaped}`);
  tomTat(`Cả bảng khách ${scan.length}${capped ? "+" : ""}: fb_id ${fmt(allFb)} · conversation_link ${fmt(allLink)}`);
  tomTat(`customers.raw: khoá dáng ảnh/link/hồ sơ — ${rawKeys.slice(0, 12).join(" · ") || "không có"}`);
  process.exit(0);
}

// Chỉ chạy khi được gọi THẲNG từ dòng lệnh — `import` từ bài kiểm không được kéo theo `process.exit`.
if (CHAY_THANG) {
  main().catch((e) => {
    console.error("inbox-avatar-audit lỗi:", e instanceof Error ? e.message : e);
    tomTat("inbox-avatar-audit: LỖI ngoài phép đo — chi tiết trong phần mã hoá");
    process.exit(1);
  });
}
