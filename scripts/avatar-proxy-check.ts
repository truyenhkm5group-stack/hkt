/*
  ops `avatar-proxy-check` — ẢNH KHÁCH QUA PROXY HỎNG Ở BƯỚC NÀO (CHỈ ĐỌC, KHÔNG IN MÃ / URL / TOKEN / TÊN).

  Vì sao có (11/10/2026): sau #796, `inbox-avatar-audit hslc-hmt-shop` cho «ref 264 · hộp thư sẽ hiện ảnh 264/300», nhưng trên trình
  duyệt cả 8 lần thử `/api/ai-sales/avatar/<id>` đều «404, 0 byte». Route gộp mọi lỗi thành 404 (đúng — client lùi về chữ cái) và đệm
  lỗi 10 phút, nên không nhìn được bước nào hỏng. Script đi lại TỪNG BƯỚC của `avatarProxyCore` bằng CHÍNH lib trên image (không hàm
  lib mới ⇒ không cần deploy), BỎ QUA đệm:

   1. Ref (`avatarProxyRefFor` — cùng hàm với hộp thư / route): có không · dạng · nguồn · page của ref = page của hội thoại?
   2. Token page: đi lại ĐÚNG thứ tự `defaultPageToken` của route — hàng page riêng (`org_channel_pages`: có · trạng thái · có bí mật)
      rồi kết nối đơn cũ (`org_connections`: trạng thái · đã kiểm đạt · page khớp) — in CÓ/KHÔNG + NGUỒN, KHÔNG in token. Giải mã
      bằng `pageTokensForOffboard` (handle chỉ định, không qua ngữ cảnh).
   3. `avatarFetchUrl` có dựng được URL không.
   4. Bước 1 gọi hai lần: header ĐÚNG như lib (accept ảnh) và accept mọi kiểu (lượt dò pancake-avatar-shape 1 gửi accept ảnh ⇒
      406 ở mọi điểm cuối; lượt 2 gửi accept mọi kiểu ⇒ 301) — in mã HTTP · kiểu · có Location · host Location · https không · bước sau có được
      phép (`avatarHopAllowed(…, 1)`).
   5. Bước 2 (theo Location đã bỏ khoá): mã HTTP · kiểu · kích thước.
   6. Đường thật `fetchAvatarImage` (lib nguyên vẹn): ĐƯỢC / HỎNG + kiểu ⇒ kết luận bằng ĐÚNG mã reason của `avatarProxyCore`.

  Cả lượt MÃ HOÁ; dòng [ops:tom-tat] chỉ mang số thứ tự hội thoại + mã bước — không id, URL, token, tên. Gọi mạng CHỈ GET. CHỈ ĐỌC do
  Postgres ép (`ERP_READ_ONLY=1` + hỏi lại phiên).

  arg: `<mã tổ chức> [--limit=1..5]`.
*/
const CHAY_THANG = Boolean(process.argv[1] && process.argv[1].endsWith("avatar-proxy-check.ts"));
if (CHAY_THANG) process.env.ERP_READ_ONLY = "1";

import "dotenv/config";
import { and, desc, eq, sql } from "drizzle-orm";
import { getDbForInspection, schema, type Db } from "@/db";
import { pageTokensForOffboard } from "@/lib/connectors/service";
import { findOrganization } from "@/lib/platform/organizations";
import { avatarProxyRefFor, isEndpointAvatarRef, stripAvatarToken } from "@/lib/sales-chatbot/avatar-profile";
import { AVATAR_FETCH, avatarFetchUrl, avatarHopAllowed, fetchAvatarImage } from "@/lib/sales-chatbot/avatar-proxy";
import { FANPAGE_CONNECTOR } from "@/lib/sales-chatbot/fanpage";
import { rowsOf } from "@/lib/sql-rows";

const tomTat = (s: string) => console.log(`[ops:tom-tat] ${s.slice(0, 300)}`);

export const CHECK_MAX = 5;
/** Số hội thoại gần nhất quét để tìm ≤ 5 hội thoại có ref. */
export const CHECK_SCAN = 300;

// ─────────────────────────── PHẦN THUẦN ───────────────────────────

export function parseCheckArgs(argv: readonly string[]): { code: string; limit: number } | { error: string } {
  const code = (argv.find((a) => !a.startsWith("--")) ?? "").trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(code)) return { error: "thiếu / sai mã tổ chức" };
  const raw = argv.find((a) => a.startsWith("--limit="))?.slice(8);
  const limit = raw === undefined ? CHECK_MAX : Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > CHECK_MAX) return { error: `--limit phải là số nguyên 1..${CHECK_MAX}` };
  return { code, limit };
}

export type OwnPageRow = { orgCode: string; status: string; hasSecrets: boolean } | null;
export type LegacyConn = { orgCode: string; status: string; lastTestOk: boolean | null; pageId: string; hasSecrets: boolean } | null;
export type TokenVerdict = { found: boolean; source: "HÀNG_PAGE_RIÊNG" | "KẾT_NỐI_ĐƠN_CŨ" | "KHÔNG"; why: string };

/**
 * ĐÚNG thứ tự quyết định của `avatar-proxy.ts::defaultPageToken` (openChannelPageToken rồi openActiveConnection), dựng trên dữ kiện
 * dòng — để biết route có lấy được token không và DỪNG ở nhánh nào. `decrypted` = token giải được cho page đó (pageTokensForOffboard).
 * HÀM THUẦN.
 */
export function tokenVerdict(orgCode: string, pageId: string, own: OwnPageRow, legacy: LegacyConn, decrypted: boolean): TokenVerdict {
  if (own) {
    if (own.orgCode !== orgCode) return { found: false, source: "KHÔNG", why: "HÀNG_PAGE_KHÁC_TỔ_CHỨC" };
    if (own.status !== "ACTIVE") return { found: false, source: "KHÔNG", why: `HÀNG_PAGE_${own.status}` };
    if (own.hasSecrets) return decrypted ? { found: true, source: "HÀNG_PAGE_RIÊNG", why: "OK" } : { found: false, source: "KHÔNG", why: "HÀNG_PAGE_KHÔNG_GIẢI_MÃ_ĐƯỢC" };
    // Hàng page không có token riêng ⇒ route đọc tiếp kết nối đơn cũ.
  }
  if (!legacy) return { found: false, source: "KHÔNG", why: own ? "HÀNG_PAGE_KHÔNG_TOKEN · KHÔNG_CÓ_KẾT_NỐI" : "KHÔNG_CÓ_HÀNG_PAGE · KHÔNG_CÓ_KẾT_NỐI" };
  if (legacy.orgCode !== orgCode) return { found: false, source: "KHÔNG", why: "KẾT_NỐI_KHÁC_TỔ_CHỨC" };
  if (legacy.status !== "ACTIVE" || legacy.lastTestOk !== true) return { found: false, source: "KHÔNG", why: `KẾT_NỐI_${legacy.status}${legacy.lastTestOk === true ? "" : "_CHƯA_KIỂM_ĐẠT"}` };
  if (!legacy.hasSecrets) return { found: false, source: "KHÔNG", why: "KẾT_NỐI_KHÔNG_BÍ_MẬT" };
  if (legacy.pageId !== pageId) return { found: false, source: "KHÔNG", why: "KẾT_NỐI_KHÁC_PAGE" };
  return decrypted ? { found: true, source: "KẾT_NỐI_ĐƠN_CŨ", why: "OK" } : { found: false, source: "KHÔNG", why: "KẾT_NỐI_KHÔNG_GIẢI_MÃ_ĐƯỢC" };
}

/** Một bước HTTP ⇒ chuỗi mã: `HTTP 301 · kiểu=text/html · Location=có host=content.pancake.vn https=có bước-sau=được`. HÀM THUẦN. */
export function describeStep(status: number, contentType: string | null, location: string | null, base: string, size?: number): string {
  const type = (contentType ?? "").split(";")[0].trim().toLowerCase() || "—";
  let loc = "Location=không";
  if (location) {
    try {
      const u = new URL(location, base);
      const next = stripAvatarToken(u.toString());
      loc = `Location=có host=${u.hostname.toLowerCase()} https=${u.protocol === "https:" ? "có" : "KHÔNG"} bước-sau=${next && avatarHopAllowed(next, 1) ? "được" : "BỊ_CHẶN"}`;
    } catch {
      loc = "Location=hỏng";
    }
  }
  return `HTTP ${status} · kiểu=${type} · ${loc}${size !== undefined ? ` · ${size}B` : ""}`;
}

// ─────────────────────────── ĐỌC ───────────────────────────

const str = (v: unknown) => (typeof v === "string" ? v : "");

async function step(url: string, accept: string): Promise<{ text: string; location: string | null; ok: boolean }> {
  try {
    const res = await fetch(url, { method: "GET", redirect: "manual", headers: { accept }, signal: AbortSignal.timeout(AVATAR_FETCH.timeoutMs) });
    const location = res.headers.get("location");
    let size: number | undefined;
    if (!location && res.body) {
      const buf = new Uint8Array(await res.arrayBuffer().catch(() => new ArrayBuffer(0)));
      size = buf.byteLength;
    } else await res.body?.cancel().catch(() => undefined);
    return { text: describeStep(res.status, res.headers.get("content-type"), location, url, size), location, ok: res.status >= 200 && res.status < 400 };
  } catch (e) {
    const code = e instanceof Error && e.cause && typeof e.cause === "object" ? str((e.cause as { code?: unknown }).code) : "";
    return { text: `lỗi mạng (${e instanceof Error ? e.name : "lỗi"}${code ? ` ${code}` : ""})`, location: null, ok: false };
  }
}

async function main() {
  const args = parseCheckArgs(process.argv.slice(2));
  if ("error" in args) {
    tomTat(`avatar-proxy-check: DỪNG · cách dùng sai — ${args.error} (arg: <mã tổ chức> [--limit=1..${CHECK_MAX}])`);
    process.exit(1);
  }
  const org = await findOrganization(args.code);
  if (!org) {
    tomTat(`avatar-proxy-check: DỪNG · không có tổ chức «${args.code}»`);
    process.exit(1);
  }
  const db: Db = await getDbForInspection({ code: org.code, isHome: org.isHome });
  const [ro] = rowsOf<Record<string, unknown>>(await db.execute(sql`show default_transaction_read_only`));
  if (String(ro?.default_transaction_read_only ?? "") !== "on") {
    tomTat("avatar-proxy-check: DỪNG · phiên CSDL KHÔNG ở chế độ chỉ đọc — không đọc gì");
    process.exit(1);
  }

  // Token: giải bằng handle chỉ định; NGUỒN dựng lại theo thứ tự của route từ dữ kiện dòng.
  const { tokens } = await pageTokensForOffboard(db, org.code, FANPAGE_CONNECTOR);
  const p = schema.orgChannelPages;
  const ownRows = await db.select({ pageId: p.pageId, orgCode: p.orgCode, status: p.status, secretsEnc: p.secretsEnc }).from(p).where(eq(p.connectorKey, FANPAGE_CONNECTOR));
  const oc = schema.orgConnections;
  const [conn] = await db.select({ orgCode: oc.orgCode, status: oc.status, lastTestOk: oc.lastTestOk, settings: oc.settings, secretsEnc: oc.secretsEnc }).from(oc).where(eq(oc.connectorKey, FANPAGE_CONNECTOR)).limit(1);
  const legacy: LegacyConn = conn ? { orgCode: conn.orgCode, status: conn.status, lastTestOk: conn.lastTestOk, pageId: str((conn.settings as Record<string, unknown> | null)?.pageId).trim(), hasSecrets: Boolean(conn.secretsEnc) } : null;
  console.log(`Tổ chức ${org.code} · hàng page Pancake riêng ${ownRows.length} · kết nối đơn cũ ${legacy ? `${legacy.status}${legacy.lastTestOk ? "" : " (chưa kiểm đạt)"}` : "không có"} · page giải được token ${tokens.size}`);

  const c = schema.salesChatConversations;
  const convs = await db
    .select({ id: c.id, channel: c.channel, pageId: c.pageId, threadId: c.threadId, state: c.state })
    .from(c)
    .where(and(eq(c.channel, "FANPAGE")))
    .orderBy(desc(sql`coalesce(${c.lastCustomerAt}, ${c.updatedAt})`))
    .limit(CHECK_SCAN);
  const withRef = convs.map((r) => ({ r, found: avatarProxyRefFor(r.state, r) })).filter((x) => x.found);
  tomTat(`avatar-proxy-check ${org.code}: ${convs.length} hội thoại FANPAGE gần nhất · có ref ${withRef.length} · kiểm ${Math.min(args.limit, withRef.length)} · hàng page riêng ${ownRows.length} · kết nối đơn cũ ${legacy ? `${legacy.status}${legacy.lastTestOk ? "" : "/chưa kiểm đạt"}` : "không"} · page có token ${tokens.size}`);

  const reasons: Record<string, number> = {};
  for (const [i, { r, found }] of withRef.slice(0, args.limit).entries()) {
    const ref = found!.ref;
    const kind = isEndpointAvatarRef(ref) ? "ENDPOINT" : "URL";
    const pageMatch = isEndpointAvatarRef(ref) ? ref.pageId === r.pageId : null;
    const pageId = r.pageId ?? "";
    const ownRow = ownRows.find((x) => x.pageId === pageId);
    const tv = tokenVerdict(org.code, pageId, ownRow ? { orgCode: ownRow.orgCode, status: ownRow.status, hasSecrets: Boolean(ownRow.secretsEnc) } : null, legacy, tokens.has(pageId));
    const token = tv.found ? tokens.get(pageId) ?? null : null;
    const first = avatarFetchUrl(ref, r.pageId, token);
    const parts = [`HT#${i + 1}: ref=${kind}/${found!.source}`, `page khớp=${pageMatch === null ? "—" : pageMatch ? "có" : "KHÔNG"}`, `token=${tv.found ? `CÓ(${tv.source})` : `KHÔNG(${tv.why})`}`, `URL bước 1=${first ? "dựng được" : "KHÔNG"}`];
    let reason = "OK";
    if (!first) reason = "NO_TOKEN";
    else {
      const asLib = await step(first, "image/*");
      const anyType = await step(first, "*/*");
      parts.push(`B1[image/*]: ${asLib.text}`, `B1[*/*]: ${anyType.text}`);
      const loc = anyType.location ?? asLib.location;
      if (loc) {
        const next = stripAvatarToken(new URL(loc, first).toString());
        if (next && avatarHopAllowed(next, 1)) parts.push(`B2: ${(await step(next, "image/*")).text}`);
        else parts.push("B2: không gọi (bị chặn)");
      }
      const real = await fetchAvatarImage(first, fetch);
      parts.push(`đường thật=${real ? `ĐƯỢC ${real.contentType} ${real.body.byteLength}B` : "HỎNG"}`);
      if (!real) reason = "FETCH_FAILED";
    }
    parts.push(`reason=${reason}`);
    reasons[reason] = (reasons[reason] ?? 0) + 1;
    console.log(parts.join(" · "));
    // Tóm tắt công khai: chia nhiều dòng (trần 300 ký tự / dòng), không id / URL / token / tên.
    tomTat(parts.slice(0, 4).join(" · "));
    for (const x of parts.slice(4)) tomTat(`  HT#${i + 1} ${x}`);
  }
  tomTat(`Kết luận: ${Object.entries(reasons).map(([k, n]) => `${k} ${n}`).join(" · ") || "không hội thoại nào có ref"}`);
  process.exit(0);
}

// Chỉ chạy khi được gọi THẲNG từ dòng lệnh — `import` từ bài kiểm không được kéo theo `process.exit`.
if (CHAY_THANG) {
  main().catch((e) => {
    console.error("avatar-proxy-check lỗi:", e instanceof Error ? e.name : "lỗi");
    tomTat("avatar-proxy-check: LỖI ngoài phép đo — chi tiết trong phần mã hoá");
    process.exit(1);
  });
}
