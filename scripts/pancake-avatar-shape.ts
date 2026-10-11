/*
  ops `pancake-avatar-shape` — ẢNH KHÁCH NẰM Ở ĐÂU TRONG PAYLOAD API PANCAKE (CHỈ ĐỌC, KHÔNG IN GIÁ TRỊ).

  Vì sao có (11/10/2026): sau #791, ops `inbox-avatar-audit hslc-hmt-shop` cho «ref 0 · NO_AVATAR_FIELD 50 · POLL 36» — lượt quét lại
  ĐÃ đọc danh sách hội thoại mà mọi payload đều không có ảnh ở các khoá `pancakeAvatarFactsOf` đang đọc (`avatar_url` · `avatar` ·
  `from.*` · `customers[0].*`). Đoán thêm một khoá là đoán (AGENTS 8.8). Script này đo DÁNG thật:

   1. Gọi ĐÚNG API mà `catchUpFanpage` gọi (`/v2/pages/<page>/conversations?type=INBOX&order_by=updated_at`) bằng page access token
      của CHÍNH tổ chức (đọc qua `getDbForInspection` + `pageTokensForOffboard` — không qua ngữ cảnh, không ghi), lấy ≤ 5 hội thoại; và
      tin của ≤ 2 hội thoại đầu (`/v1/.../messages`, đúng đường `fetchThreadMessages`).
   2. In CHỈ đường dẫn khoá + kiểu + (với chuỗi) DẠNG: mốc thời gian · URL (host · có/không tham số khoá · độ dài · đường dẫn đã che
      mọi đoạn có số / dài) · chuỗi(độ dài). KHÔNG in giá trị, tên, SĐT, mã, chữ tin. Khoá trông như mã (số dài) bị che thành `<mã>`.
   3. Thử vài điểm cuối ảnh / khách của PANCAKE (mã khách lấy từ CHÍNH payload Pancake): in mã HTTP + content-type + có chuyển hướng
      không và tới HOST nào. Không dựng facebook.com/<PSID>, không gọi Graph. LƯỢT DÒ 2 (run 38093664102: cả 7 lần thử đều «406
      text/html», kể cả điểm cuối JSON ⇒ nghi header `accept` chỉ nhận ảnh): gửi `accept` mọi kiểu (JSON thì `application/json`); thử mọi mã khách của
      payload (`page_customer.psid/global_id/id` · `customers[0].fb_id/id` · `from.id` · `customer_id`) × `/pages/<page>/avatar/<id>` ·
      `/pages/<page>/customers/<id>/avatar` · `/pages/<page>/page_customers/<id>` ở cả `api/v1` lẫn `public_api/v1`; lỗi ⇒ in ≤ 120 ký
      tự đầu thân ĐÃ CHE (`maskBodySnippet`); JSON thành công ⇒ chỉ dáng khoá, không thân. Phản hồi TIN: in đủ khoá gốc và khoá của
      `conv_customers` · `conv_from` · `customers`.
   4. Kết luận lõi hiện tại: `pancakeAvatarFactsOf` cho mỗi hội thoại ra outcome nào.

  Cả lượt MÃ HOÁ (ops-vps `OPS_THAO_TAC_MA_HOA`); dòng [ops:tom-tat] chỉ mang đường dẫn khoá đã che + kiểu + host + số đếm — không
  giá trị nào. CHỈ ĐỌC do Postgres ép (`ERP_READ_ONLY=1` trước lần mở kết nối đầu tiên + hỏi lại phiên). Gọi Pancake CHỈ bằng GET.

  arg: `<mã tổ chức> [--limit=1..5]`.
*/
const CHAY_THANG = Boolean(process.argv[1] && process.argv[1].endsWith("pancake-avatar-shape.ts"));
if (CHAY_THANG) process.env.ERP_READ_ONLY = "1";

import "dotenv/config";
import { sql } from "drizzle-orm";
import { getDbForInspection, type Db } from "@/db";
import { pageTokensForOffboard } from "@/lib/connectors/service";
import { PANCAKE_PAGES_API, scrubSecrets } from "@/lib/connectors/testers";
import { findOrganization } from "@/lib/platform/organizations";
import { avatarTokenParamNames, pancakeAvatarFactsOf } from "@/lib/sales-chatbot/avatar-profile";
import { FANPAGE_CONNECTOR } from "@/lib/sales-chatbot/fanpage";
import { rowsOf } from "@/lib/sql-rows";

const tomTat = (s: string) => console.log(`[ops:tom-tat] ${s.slice(0, 300)}`);

export const SHAPE_MAX_CONVERSATIONS = 5;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

// ─────────────────────────── PHẦN THUẦN ───────────────────────────

/** Khoá đối tượng trông như MÃ (số dài · chuỗi dài có chữ số) ⇒ `<mã>` — map theo mã khách / mã page không lộ ra. HÀM THUẦN. */
export function maskKey(k: string): string {
  if (/^\d{4,}$/.test(k)) return "<mã>";
  if (k.length >= 16 && /\d/.test(k) && /^[\w-]+$/.test(k)) return "<mã>";
  if (k.length > 40) return "<khoá dài>";
  return k;
}

const PATH_WORDS = new Set(["api", "public_api", "pages", "page", "avatar", "avatars", "picture", "pictures", "platform", "profilepic", "profile", "conversations", "customers", "page_customers", "customer", "image", "images", "img", "photo", "photos", "static", "statics", "content", "uploads", "upload", "media", "files", "file", "safe_image.php", "v", "t", "s", "p"]);

/** Đường dẫn URL đã che: chỉ giữ TỪ VỰNG API / CDN đã biết (`api`, `pages`, `avatar`, `v1`…); có số ⇒ `<mã>`, chữ lạ ⇒ `<chữ>`. HÀM THUẦN. */
export function maskUrlPath(pathname: string): string {
  const segs = pathname
    .split("/")
    .filter(Boolean)
    .map((s) => {
      if (/\.(jpe?g|png|webp|gif)$/i.test(s)) return `<tệp${s.slice(s.lastIndexOf(".")).toLowerCase()}>`;
      // Chỉ giữ TỪ VỰNG đường dẫn API / CDN đã biết — một đoạn toàn chữ vẫn có thể là tên người dùng (facebook.com/<tên>).
      return PATH_WORDS.has(s.toLowerCase()) || /^v\d{1,2}$/i.test(s) ? s : /^\d+$/.test(s) || /\d/.test(s) ? "<mã>" : "<chữ>";
    });
  return `/${segs.join("/")}`;
}

/** DẠNG của một chuỗi — không bao giờ trả lại giá trị. HÀM THUẦN. */
export function describeString(v: string): string {
  const s = v.trim();
  if (!s) return "chuỗi rỗng";
  if (ISO.test(s)) return "mốc";
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      const keys = avatarTokenParamNames(s);
      return `url(${u.protocol.replace(":", "")} host=${u.hostname.toLowerCase()} khoá=${keys.length ? keys.join("+") : "không"} dài=${s.length} đường=${maskUrlPath(u.pathname)})`;
    } catch {
      return `url hỏng(dài=${s.length})`;
    }
  }
  return `chuỗi(${s.length})`;
}

export type ShapeEntry = { types: Set<string>; seen: number; forms: Set<string> };
export type Shape = Map<string, ShapeEntry>;

function note(shape: Shape, path: string, type: string, form?: string) {
  const e = shape.get(path) ?? { types: new Set<string>(), seen: 0, forms: new Set<string>() };
  e.types.add(type);
  e.seen += 1;
  if (form && e.forms.size < 3) e.forms.add(form);
  shape.set(path, e);
}

/**
 * Dáng một giá trị JSON: đường dẫn khoá (`a.b[].c`) ⇒ kiểu + dạng chuỗi. Mảng ⇒ `x[]` và đi vào ≤ 3 phần tử đầu. Sâu tối đa 6. Số chỉ
 * in «số» (số lớn có thể là mã khách). HÀM THUẦN.
 */
export function walkShape(v: unknown, path: string, shape: Shape, depth = 0): Shape {
  if (v === null || v === undefined) {
    note(shape, path || "(gốc)", "null");
    return shape;
  }
  if (typeof v === "string") note(shape, path || "(gốc)", "chuỗi", describeString(v));
  else if (typeof v === "number") note(shape, path || "(gốc)", "số");
  else if (typeof v === "boolean") note(shape, path || "(gốc)", "đúng/sai");
  else if (Array.isArray(v)) {
    note(shape, path || "(gốc)", "mảng", `dài ${v.length}`);
    if (depth < 6) for (const x of v.slice(0, 3)) walkShape(x, `${path}[]`, shape, depth + 1);
  } else if (typeof v === "object") {
    note(shape, path || "(gốc)", "đối tượng");
    if (depth < 6) for (const [k, x] of Object.entries(v as Record<string, unknown>)) walkShape(x, path ? `${path}.${maskKey(k)}` : maskKey(k), shape, depth + 1);
  } else note(shape, path || "(gốc)", typeof v);
  return shape;
}

/** Một dòng mỗi đường dẫn: `đường · kiểu · số lần · dạng`. Đường dẫn trông như ẢNH / URL lên đầu. HÀM THUẦN. */
export function shapeLines(shape: Shape): string[] {
  const looks = (p: string, e: ShapeEntry) => /avatar|picture|pic|photo|image|img|profile|thumb/i.test(p) || [...e.forms].some((f) => f.startsWith("url("));
  return [...shape.entries()]
    .sort((a, b) => Number(looks(b[0], b[1])) - Number(looks(a[0], a[1])) || a[0].localeCompare(b[0]))
    .map(([p, e]) => `${looks(p, e) ? "★ " : ""}${p} · ${[...e.types].join("|")} · ×${e.seen}${e.forms.size ? ` · ${[...e.forms].join(" ; ")}` : ""}`);
}

/** Đường dẫn khoá có dáng ảnh / URL — phần đáng gửi lên tóm tắt. HÀM THUẦN. */
export function avatarishLines(shape: Shape): string[] {
  return shapeLines(shape).filter((l) => l.startsWith("★ "));
}

export function parseShapeArgs(argv: readonly string[]): { code: string; limit: number } | { error: string } {
  const code = (argv.find((a) => !a.startsWith("--")) ?? "").trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(code)) return { error: "thiếu / sai mã tổ chức" };
  const raw = argv.find((a) => a.startsWith("--limit="))?.slice(8);
  const limit = raw === undefined ? SHAPE_MAX_CONVERSATIONS : Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > SHAPE_MAX_CONVERSATIONS) return { error: `--limit phải là số nguyên 1..${SHAPE_MAX_CONVERSATIONS}` };
  return { code, limit };
}

/** Kết quả một lượt GET điểm cuối ảnh — chỉ mã HTTP · kiểu nội dung · host chuyển hướng. HÀM THUẦN. */
export function describeProbe(status: number, contentType: string | null, location: string | null, base: string): string {
  let to = "";
  if (location) {
    try {
      to = ` → chuyển hướng tới host=${new URL(location, base).hostname.toLowerCase()}`;
    } catch {
      to = " → chuyển hướng (Location hỏng)";
    }
  }
  return `HTTP ${status} · kiểu=${(contentType ?? "—").split(";")[0].trim() || "—"}${to}`;
}

/**
 * ≤ 120 ký tự ĐẦU của thân phản hồi LỖI, đã che — chỉ để thấy câu lỗi của Pancake (406 «Not Acceptable» vì header hay vì thiếu tham
 * số?). Bỏ thẻ HTML, che: chuỗi bí mật truyền vào (token) · email · dãy ≥ 5 chữ số (mã khách / page / SĐT) · chuỗi chữ-số dài ≥ 20
 * (token khác). HÀM THUẦN.
 */
export function maskBodySnippet(text: string, secrets: readonly string[] = []): string {
  let s = text.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]*>/g, " ");
  for (const x of secrets) if (x) s = s.split(x).join("<khoá>");
  s = s
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "<email>")
    .replace(/[A-Za-z0-9_-]{20,}/g, (m) => (/\d/.test(m) ? "<chuỗi>" : m))
    .replace(/\+?\d[\d .-]{3,}\d/g, (m) => (m.replace(/\D/g, "").length >= 5 ? "<số>" : m))
    .replace(/\s+/g, " ")
    .trim();
  return s.slice(0, 120);
}

/** Gộp danh sách thành các dòng ≤ `max` ký tự (dòng tóm tắt có trần 300). HÀM THUẦN. */
export function chunkJoin(items: readonly string[], max = 260): string[] {
  const out: string[] = [];
  let chunk = "";
  for (const it of items) {
    if (chunk && (chunk + ", " + it).length > max) {
      out.push(chunk);
      chunk = it;
    } else chunk = chunk ? `${chunk}, ${it}` : it;
  }
  if (chunk) out.push(chunk);
  return out;
}

/**
 * Gộp các lần thử cùng KẾT QUẢ (mã HTTP · kiểu · thân đã che) thành một dòng `kết quả ← nhãn | nhãn` — kênh tóm tắt có trần 60 dòng,
 * 40 lần thử cùng ra 406 không được chiếm hết chỗ. Dòng không theo dạng `nhãn [..]: kết quả` giữ nguyên. HÀM THUẦN.
 */
export function groupProbes(lines: readonly string[]): string[] {
  const groups = new Map<string, string[]>();
  const loose: string[] = [];
  for (const l of lines) {
    const i = l.indexOf("]: ");
    if (i < 0) {
      loose.push(l);
      continue;
    }
    const result = l.slice(i + 3);
    groups.set(result, [...(groups.get(result) ?? []), l.slice(0, i + 1)]);
  }
  return [...[...groups.entries()].map(([result, labels]) => `${result} ×${labels.length} ← ${labels.join(" | ")}`), ...loose];
}

/** Đường khoá của `shape` bắt đầu bằng `prefix` (không kiểu, không dạng). HÀM THUẦN. */
export function pathsUnder(shape: Shape, prefix: string): string[] {
  return [...shape.keys()].filter((p) => p === prefix || p.startsWith(`${prefix}.`) || p.startsWith(`${prefix}[]`)).sort();
}

export type ProbeKind = "image" | "json";
/** Các biến thể điểm cuối ảnh / khách cho MỘT mã (lấy từ chính payload Pancake) trên hai gốc API của Pancake. HÀM THUẦN. */
export function probeTargets(pageId: string, id: string, q: string): { label: string; url: string; kind: ProbeKind }[] {
  const p = encodeURIComponent(pageId);
  const i = encodeURIComponent(id);
  const bases: [string, string][] = [
    ["api/v1", "https://pages.fm/api/v1"],
    ["public_api/v1", "https://pages.fm/api/public_api/v1"],
  ];
  return bases.flatMap(([name, b]) => [
    { label: `${name} /pages/<page>/avatar/<id>`, url: `${b}/pages/${p}/avatar/${i}?${q}`, kind: "image" as const },
    { label: `${name} /pages/<page>/customers/<id>/avatar`, url: `${b}/pages/${p}/customers/${i}/avatar?${q}`, kind: "image" as const },
    { label: `${name} /pages/<page>/page_customers/<id>`, url: `${b}/pages/${p}/page_customers/${i}?${q}`, kind: "json" as const },
  ]);
}

// ─────────────────────────── ĐỌC ───────────────────────────

const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const rec = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

async function main() {
  const args = parseShapeArgs(process.argv.slice(2));
  if ("error" in args) {
    tomTat(`pancake-avatar-shape: DỪNG · cách dùng sai — ${args.error} (arg: <mã tổ chức> [--limit=1..${SHAPE_MAX_CONVERSATIONS}])`);
    process.exit(1);
  }
  const org = await findOrganization(args.code);
  if (!org) {
    tomTat(`pancake-avatar-shape: DỪNG · không có tổ chức «${args.code}»`);
    process.exit(1);
  }
  const db: Db = await getDbForInspection({ code: org.code, isHome: org.isHome });
  const [ro] = rowsOf<Record<string, unknown>>(await db.execute(sql`show default_transaction_read_only`));
  if (String(ro?.default_transaction_read_only ?? "") !== "on") {
    tomTat("pancake-avatar-shape: DỪNG · phiên CSDL KHÔNG ở chế độ chỉ đọc — không đọc gì");
    process.exit(1);
  }
  const { tokens } = await pageTokensForOffboard(db, org.code, FANPAGE_CONNECTOR);
  const pages = [...tokens.entries()];
  if (!pages.length) {
    tomTat(`pancake-avatar-shape ${org.code}: DỪNG · không có page Pancake nào có token (kết nối «Fanpage qua Pancake» chưa nối / không giải mã được)`);
    process.exit(0);
  }
  const [pageId, token] = pages[0];
  const secrets = [token, pageId];
  const q = `page_access_token=${encodeURIComponent(token)}`;
  const getJson = async (label: string, url: string): Promise<Record<string, unknown> | null> => {
    try {
      const res = await fetch(url, { method: "GET", redirect: "manual", headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
      const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      console.log(`${label}: HTTP ${res.status} · success=${body ? String(body.success ?? "—") : "không JSON"}`);
      return res.ok && body && body.success !== false ? body : null;
    } catch (e) {
      console.log(`${label}: lỗi mạng — ${scrubSecrets(e instanceof Error ? e.message : String(e), secrets).slice(0, 160)}`);
      return null;
    }
  };
  const probe = async (label: string, url: string, kind: ProbeKind = "image"): Promise<string> => {
    try {
      // Lượt dò 1 (run 38093664102) gửi `accept: image/*` và nhận 406 ở MỌI điểm cuối, kể cả JSON ⇒ lượt 2 gửi `*/*` / JSON.
      const res = await fetch(url, { method: "GET", redirect: "manual", headers: { accept: kind === "json" ? "application/json" : "*/*" }, signal: AbortSignal.timeout(10_000) });
      const head = `${label} [${kind === "json" ? "json" : "*/*"}]: ${describeProbe(res.status, res.headers.get("content-type"), res.headers.get("location"), url)}`;
      const type = (res.headers.get("content-type") ?? "").toLowerCase();
      if (res.status >= 200 && res.status < 300 && type.includes("json")) {
        // Thành công dạng JSON có thể là hồ sơ khách ⇒ KHÔNG in thân, chỉ dáng khoá (có ★ nếu có ảnh).
        const body = (await res.json().catch(() => null)) as unknown;
        const sh = walkShape(body, "", new Map());
        const star = avatarishLines(sh).map((l) => l.replace(/^★ /, ""));
        return `${head} · khoá: ${sh.size ? [...sh.keys()].slice(0, 25).join(", ") : "—"}${star.length ? ` · ★ ${star.slice(0, 3).join(" ; ")}` : ""}`;
      }
      if (res.status >= 200 && res.status < 400) {
        await res.body?.cancel().catch(() => undefined);
        return head;
      }
      const text = (await res.text().catch(() => "")).slice(0, 4000);
      return `${head} · thân: «${maskBodySnippet(text, secrets)}»`;
    } catch (e) {
      // Dòng này lên TÓM TẮT công khai ⇒ chỉ tên lỗi + mã hệ thống, không câu lỗi (câu lỗi của Node có thể chứa URL).
      const code = e instanceof Error && e.cause && typeof e.cause === "object" ? str((e.cause as { code?: unknown }).code) : "";
      return `${label}: lỗi mạng (${e instanceof Error ? e.name : "lỗi"}${code ? ` ${code}` : ""})`;
    }
  };

  console.log(`Tổ chức ${org.code} · ${pages.length} page Pancake có token · đo page thứ nhất · lúc ${new Date().toISOString()}`);

  // 1. Danh sách hội thoại — ĐÚNG lời gọi của catchUpFanpage.
  const list = await getJson("Danh sách hội thoại (v2, như catchUpFanpage)", `${PANCAKE_PAGES_API}/v2/pages/${encodeURIComponent(pageId)}/conversations?${q}&type=INBOX&order_by=updated_at`);
  const convs = (Array.isArray(list?.conversations) ? list.conversations : []).slice(0, args.limit) as Record<string, unknown>[];
  const topKeys = list ? Object.keys(list).map(maskKey).sort().join(", ") : "—";
  const convShape: Shape = new Map();
  for (const c of convs) walkShape(c, "", convShape);
  console.log(`Khoá gốc của phản hồi danh sách: ${topKeys}`);
  console.log(`DÁNG ${convs.length} hội thoại (★ = dáng ảnh / URL):`);
  for (const l of shapeLines(convShape)) console.log(`  ${l}`);
  const outcomes: Record<string, number> = {};
  for (const c of convs) {
    const o = pancakeAvatarFactsOf(c).outcome;
    outcomes[o] = (outcomes[o] ?? 0) + 1;
  }

  // 2. Tin của ≤ 2 hội thoại đầu — đúng đường fetchThreadMessages.
  const msgShape: Shape = new Map();
  let msgTop = "";
  for (const c of convs.slice(0, 2)) {
    const id = str(c.id);
    if (!id) continue;
    const body = await getJson("Tin của một hội thoại (v1)", `${PANCAKE_PAGES_API}/v1/pages/${encodeURIComponent(pageId)}/conversations/${encodeURIComponent(id)}/messages?${q}`);
    if (!body) continue;
    msgTop = Object.keys(body).map(maskKey).sort().join(", ");
    for (const [k, v] of Object.entries(body)) walkShape(k === "messages" && Array.isArray(v) ? v.slice(0, 3) : v, maskKey(k), msgShape);
  }
  console.log(`Khoá gốc của phản hồi tin: ${msgTop || "—"}`);
  console.log("DÁNG phản hồi tin (★ = dáng ảnh / URL):");
  for (const l of shapeLines(msgShape)) console.log(`  ${l}`);

  // 3. Điểm cuối ảnh / khách của Pancake — mã lấy từ CHÍNH payload Pancake, chỉ in mã HTTP · kiểu · host chuyển hướng.
  const probes: string[] = [];
  const first = convs[0];
  if (first) {
    const from = rec(first.from);
    const cust = rec(Array.isArray(first.customers) ? first.customers[0] : null);
    const pc = rec(first.page_customer);
    // Mọi mã khách Pancake trả trong CHÍNH payload (lượt dò 1 thấy `page_customer.{psid,global_id,id}`) — trùng giá trị thì thử một lần.
    const ids: [string, string][] = [
      ["page_customer.psid", str(pc.psid)],
      ["page_customer.global_id", str(pc.global_id)],
      ["page_customer.id", str(pc.id)],
      ["customers[0].fb_id", str(cust.fb_id)],
      ["customers[0].id", str(cust.id)],
      ["from.id", str(from.id)],
      ["customer_id", str(first.customer_id)],
    ];
    const seen = new Map<string, string>();
    for (const [src, id] of ids) {
      if (!id) continue;
      if (seen.has(id)) {
        probes.push(`${src}: cùng giá trị với ${seen.get(id)} — không thử lại`);
        continue;
      }
      seen.set(id, src);
      for (const t of probeTargets(pageId, id, q)) probes.push(await probe(`${t.label} theo ${src}`, t.url, t.kind));
    }
    for (const [name, b] of [["api/v1", "https://pages.fm/api/v1"], ["public_api/v1", `${PANCAKE_PAGES_API}/v1`]] as const) {
      probes.push(await probe(`${name} page_customers (danh sách)`, `${b}/pages/${encodeURIComponent(pageId)}/page_customers?${q}&page_size=1`, "json"));
    }
  }
  // URL dáng ảnh có sẵn trong payload (nếu có) — gọi NGUYÊN như Pancake trả, chỉ in mã HTTP / kiểu / host chuyển hướng.
  const urlish = convs.flatMap((c) => {
    const found: string[] = [];
    const visit = (v: unknown, k: string, d: number) => {
      if (d > 4) return;
      if (typeof v === "string" && /^https:\/\//i.test(v) && /avatar|picture|pic|photo|image|thumb/i.test(k)) found.push(v);
      else if (Array.isArray(v)) v.slice(0, 3).forEach((x) => visit(x, k, d + 1));
      else if (v && typeof v === "object") for (const [kk, x] of Object.entries(v as Record<string, unknown>)) visit(x, kk, d + 1);
    };
    visit(c, "", 0);
    return found;
  });
  if (urlish[0]) probes.push(await probe("URL dáng ảnh đầu tiên trong payload (gọi nguyên)", urlish[0]));
  console.log("Điểm cuối ảnh / khách:");
  for (const l of probes) console.log(`  ${l}`);

  // ── TÓM TẮT (đường dẫn khoá đã che + kiểu + host — không giá trị). Kênh có trần 60 dòng ⇒ phần MỚI của lượt dò lên trước. ──
  tomTat(`pancake-avatar-shape ${org.code}: ${pages.length} page · ${convs.length} hội thoại · lõi hiện tại: ${Object.entries(outcomes).map(([k, n]) => `${k} ${n}`).join(" · ") || "—"}`);
  // 1) Điểm cuối ảnh / khách — gộp theo kết quả.
  for (const g of groupProbes(probes)) {
    const k = g.indexOf(" ← ");
    if (k < 0) {
      tomTat(`ĐIỂM CUỐI ${g}`);
      continue;
    }
    tomTat(`ĐIỂM CUỐI ${g.slice(0, k)}`);
    for (const l of chunkJoin(g.slice(k + 3).split(" | ")).slice(0, 3)) tomTat(`  ← ${l}`);
  }
  // 2) Khách trong phản hồi TIN — chỗ ảnh có thể nằm (lượt dò 1 bị cắt ở «glob…»).
  const msgStar = avatarishLines(msgShape);
  tomTat(`Phản hồi tin: dáng ảnh/URL ${msgStar.length}`);
  for (const prefix of ["conv_customers", "conv_from", "customers", "from", "page_customer", "global_id", "profile_updated_at"]) {
    const under = pathsUnder(msgShape, prefix);
    if (under.length) for (const l of chunkJoin(under).slice(0, 3)) tomTat(`TIN ${prefix}: ${l}`);
  }
  for (const l of chunkJoin(msgTop ? msgTop.split(", ") : ["—"]).slice(0, 4)) tomTat(`TIN khoá gốc: ${l}`);
  for (const l of msgStar.slice(0, 6)) tomTat(`TIN ${l}`);
  // 3) Danh sách hội thoại (lượt dò 1 đã có — in gọn).
  const convLines = shapeLines(convShape);
  const star = avatarishLines(convShape);
  tomTat(`Hội thoại: ${convLines.length} đường khoá · dáng ảnh/URL ${star.length} · khoá gốc danh sách: ${topKeys}`);
  for (const l of star.slice(0, 5)) tomTat(`HT ${l}`);
  const paths = convLines.map((l) => l.replace(/^★ /, "").split(" · ")[0]);
  for (const l of chunkJoin(paths).slice(0, 4)) tomTat(`HT khoá: ${l}`);
  process.exit(0);
}

// Chỉ chạy khi được gọi THẲNG từ dòng lệnh — `import` từ bài kiểm không được kéo theo `process.exit`.
if (CHAY_THANG) {
  main().catch((e) => {
    console.error("pancake-avatar-shape lỗi:", e instanceof Error ? e.name : "lỗi");
    tomTat("pancake-avatar-shape: LỖI ngoài phép đo — chi tiết trong phần mã hoá");
    process.exit(1);
  });
}
