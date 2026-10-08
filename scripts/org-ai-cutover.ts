/*
  ops `org-ai-cutover` — AI BÁN HÀNG CỦA MỘT TỔ CHỨC KHÁCH ĐANG TRẢ TIỀN Ở ĐÂU, VÀ ĐƯA NÓ SANG AI DÙNG CHUNG CỦA NỀN TẢNG.

  Vì sao (08/10/2026, chủ shop): HSLC (`hslc-hmt-shop`) chạy bot bằng khoá Gemini RIÊNG (`gemini-byok`) ⇒ chi phí AI Bán hàng
  nằm ở nguồn BYOK, không vào cột «AI nền tảng trả» của /platform/saas. Muốn hạch toán tập trung: động cơ AI của bot sang
  `platform` (PLATFORM_AI_API_KEY trong `.env` của máy chủ) — KHÔNG chép khoá nền tảng vào kết nối của tổ chức, KHÔNG tắt kết nối
  BYOK (Media / Săn khách sỉ đọc thẳng kết nối ấy, không qua cấu hình bot).

  Ba chế độ — ô arg chỉ nhận chữ / số / khoảng trắng / = : . _ , / @ + -:
   · `<mã>`                    KIỂM (CHỈ ĐỌC — Postgres ép, hỏi lại trước khi đọc): động cơ AI của bot · kết nối AI (trạng thái,
                               KHÔNG bí mật) · khoá nền tảng sẵn sàng chưa · gói có credit AI dùng chung không, trần cứng hay ngân
                               sách mềm, đủ cho mức dùng 30 ngày không · VÂN TAY từng khoá (12 ký tự đầu SHA-256 — khoá chỉ nằm trong
                               RAM, KHÔNG BAO GIỜ in) · SAME_KEY / DIFFERENT_KEY · project Google của từng khoá (API Keys Lookup bằng
                               credential quản trị NẾU container có; không có ⇒ UNAVAILABLE, không đoán)
                               — KHÔNG gọi API nào khác bằng khoá của khách (review #659) · ai còn dùng `gemini-byok` · sổ AI 30
                               ngày theo nguồn tiền × nhà cung cấp × model × loại việc.
   · `<mã> --apply`            CHUYỂN: `connectorKey = platform`, model = mặc định / chính sách của nền tảng, KHÔNG dự phòng — qua
                               ĐÚNG `saveChatbotEngineAsOperator` (lõi của /platform/org/<mã>: bot đang bật mà AI dùng chung chưa dùng
                               được cho tổ chức ⇒ tự từ chối) + nhật ký nền tảng `AI_ORG_CONTROL_SET` nguồn SCRIPT. TỪ CHỐI khi credit
                               là trần cứng nhỏ hơn mức dùng AI Bán hàng của 30 ngày qua (bot sẽ im giữa tháng). In mốc cutover.
   · `<mã> --apply-probe [--since=<ISO>]`  HẬU KIỂM: MỘT lượt ở hội thoại THỬ (kênh TEST — không nhắn khách thật, công cụ mô phỏng)
                               rồi đọc dòng sổ AI của chính lượt ấy; đếm dòng sổ từ mốc cutover theo nguồn tiền × loại việc.
  Cả lượt chạy trong `ma_hoa_ket_qua`: vân tay, project / tài khoản Google, gói / credit / chi tiêu / sổ AI của khách CHỈ nằm ở phần MÃ
  HOÁ; dòng `[ops:tom-tat] ` (log công khai — kho PUBLIC) chỉ mang nhãn và phán quyết (SAME / DIFFERENT · ĐỦ / KHÔNG · ĐẠT / CHƯA).
*/
const ARGS = process.argv.slice(2);
const CHAY_THANG = Boolean(process.argv[1] && process.argv[1].endsWith("org-ai-cutover.ts"));
const CO_GHI = ARGS.includes("--apply") || ARGS.includes("--apply-probe");
if (CHAY_THANG && !CO_GHI) process.env.ERP_READ_ONLY = "1";

import "dotenv/config";
import { createHash, createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { getDbForInspection, getPlatformDb, schema } from "@/db";
import { platformChatAi } from "@/lib/ai-builder/provider";
import { sourceUsage } from "@/lib/ai-usage/ledger";
import { PLATFORM_AI_ENV, platformAiConfig } from "@/lib/ai-usage/platform-ai";
import { probeWithPlatformKey } from "@/lib/ai-usage/platform-ai-admin";
import { resolveAiLimits } from "@/lib/ai-usage/quota";
import { aiConnectionAudit } from "@/lib/connectors/service";
import { platformAudit } from "@/lib/platform/audit";
import { withOrganization } from "@/lib/platform/context";
import { findOrganization, listOrganizations } from "@/lib/platform/organizations";
import { SALES_CHATBOT_SETTING_KEY } from "@/lib/sales-chatbot/config";
import { chatTurn, openConversation } from "@/lib/sales-chatbot/engine";
import { saveChatbotEngineAsOperator } from "@/lib/sales-chatbot/settings";
import { rowsOf } from "@/lib/sql-rows";

const tomTat = (s: string) => console.log(`[ops:tom-tat] ${s}`);

export const SCRIPT_LABEL = "script:org-ai-cutover";
export const CUTOVER_REASON = "Hạch toán tập trung chi phí AI Bán hàng trên /platform/saas: chuyển sang AI dùng chung của nền tảng (PLATFORM_AI_API_KEY), không dự phòng sang khoá riêng — yêu cầu của chủ shop 08/10/2026";
/** Đúng các ô động cơ đổi khi chuyển: nguồn = AI dùng chung, model = của nền tảng, KHÔNG dự phòng (100% chi phí về PLATFORM). */
export const PLATFORM_ENGINE_PATCH = { connectorKey: "platform", model: "", fallbackConnectorKey: null, fallbackModel: "" } as const;
/** Tính năng của AI Bán hàng trên sổ AI — mọi lượt (trả lời · ảnh · trích nhanh · ghi đơn hộ · nhắc · học) đi qua MỘT cấu hình `ai.salesChatbot`. */
export const SALES_FEATURES = ["sales_chatbot", "sales_playbook"] as const;
export const AI_CONNECTORS = ["gemini-byok", "openai-byok", "anthropic-byok"] as const;
/** Biên an toàn khi so credit trần cứng với mức dùng 30 ngày (giá model nền tảng có thể khác, tháng có thể đông khách hơn). */
export const CREDIT_MARGIN = 1.25;
const PROBE_TEXT = "Shop ơi cho mình hỏi giá sản phẩm bán chạy nhất với ạ";
const HTTP_TIMEOUT_MS = 15_000;

// ─────────────────────────── HÀM THUẦN ───────────────────────────

/** Dấu băm SHA-256 đầy đủ của một khoá (hex) — để SO; khoá của tổ chức được băm ngay trong lib/connectors/service.ts. */
export function keyDigest(key: string | null | undefined): string | null {
  const k = (key ?? "").trim();
  return k ? createHash("sha256").update(k, "utf8").digest("hex") : null;
}

/** Vân tay rút gọn để IN (phần mã hoá): 12 ký tự hex đầu của SHA-256 — không dò ngược được khoá (khoá API ~39 ký tự ngẫu nhiên). */
export function fingerprintOf(digest: string | null): string | null {
  return digest ? `sha256:${digest.slice(0, 12)}` : null;
}

export function keyFingerprint(key: string | null | undefined): string | null {
  return fingerprintOf(keyDigest(key));
}

/** So hai khoá (hay hai DẤU BĂM ĐẦY ĐỦ — không phải vân tay rút gọn) trong RAM. Thiếu một bên ⇒ UNAVAILABLE. */
export function compareKeys(a: string | null | undefined, b: string | null | undefined): "SAME_KEY" | "DIFFERENT_KEY" | "UNAVAILABLE" {
  const x = (a ?? "").trim();
  const y = (b ?? "").trim();
  if (!x || !y) return "UNAVAILABLE";
  return x === y ? "SAME_KEY" : "DIFFERENT_KEY";
}

export function compareProjects(a: string | null, b: string | null): "SAME_PROJECT" | "DIFFERENT_PROJECT" | "UNAVAILABLE" {
  if (!a || !b) return "UNAVAILABLE";
  return a === b ? "SAME_PROJECT" : "DIFFERENT_PROJECT";
}

/** Cùng tài khoản Google = hai project có CHUNG ít nhất một chủ (roles/owner). Thiếu danh sách chủ ⇒ UNAVAILABLE — không đoán. */
export function compareAccounts(a: readonly string[] | null, b: readonly string[] | null): "SAME_GOOGLE_ACCOUNT" | "DIFFERENT_ACCOUNT" | "UNAVAILABLE" {
  if (!a?.length || !b?.length) return "UNAVAILABLE";
  const s = new Set(a.map((x) => x.toLowerCase()));
  return b.some((x) => s.has(x.toLowerCase())) ? "SAME_GOOGLE_ACCOUNT" : "DIFFERENT_ACCOUNT";
}

export type EngineView = { enabled: boolean | null; connectorKey: string | null; model: string; fallbackConnectorKey: string | null; fallbackModel: string; failoverEnabled: boolean | null };

/** Động cơ AI của bot đọc từ giá trị ĐÃ LƯU của `ai.salesChatbot` — chỉ các ô động cơ, không bí mật. */
export function engineOf(value: unknown): EngineView {
  const v = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const s = (x: unknown) => (typeof x === "string" ? x : "");
  const b = (x: unknown) => (typeof x === "boolean" ? x : null);
  return { enabled: b(v.enabled), connectorKey: s(v.connectorKey) || null, model: s(v.model), fallbackConnectorKey: s(v.fallbackConnectorKey) || null, fallbackModel: s(v.fallbackModel), failoverEnabled: b(v.failoverEnabled) };
}

export function engineText(e: Pick<EngineView, "connectorKey" | "model" | "fallbackConnectorKey" | "fallbackModel">): string {
  return `nguồn ${e.connectorKey ?? "—"} · model ${e.model || "(mặc định của nguồn)"} · dự phòng ${e.fallbackConnectorKey ? `${e.fallbackConnectorKey}${e.fallbackModel ? ` / ${e.fallbackModel}` : ""}` : "KHÔNG"}`;
}

/** Số ngày còn lại của tháng theo giờ VN, tính cả hôm nay (≥ 1) — khung của credit tháng (`monthStartVN`). */
export function daysLeftInMonthVN(now: Date): number {
  const vn = new Date(now.getTime() + 7 * 3_600_000);
  const end = Date.UTC(vn.getUTCFullYear(), vn.getUTCMonth() + 1, 1);
  return Math.max(1, Math.ceil((end - vn.getTime()) / 86_400_000));
}

const usd2 = (v: number) => Math.round(v * 100) / 100;

/**
 * Credit AI dùng chung có đủ cho AI Bán hàng không. Ngân sách mềm (`softOnly`) không bao giờ chặn ⇒ đủ. Trần cứng ⇒ HAI điều: một tháng
 * đầy ≥ mức dùng 30 ngày × biên, VÀ phần còn lại của tháng này (trừ cái đã dùng nguồn PLATFORM) ≥ mức dùng / ngày × số ngày còn lại ×
 * biên. Chưa đo được mức dùng (null) ⇒ không kết luận ⇒ KHÔNG đủ (không chuyển mù). Ước tính theo giá model đang chạy (BYOK) — model
 * của nền tảng rẻ / đắt hơn thì lệch; lượt chưa định giá không cộng — nơi gọi in số ấy cạnh phán quyết.
 */
export function creditVerdict(limits: { platformCreditUsdPerMonth: number; softOnly?: boolean } | null, salesCost30dUsd: number | null, monthUsedUsd = 0, daysLeftInMonth = 30): { ok: boolean; reason: string } {
  if (!limits) return { ok: false, reason: "không đọc được gói của tổ chức" };
  if (limits.softOnly) return { ok: true, reason: `ngân sách mềm ${limits.platformCreditUsdPerMonth} USD/tháng — vượt chỉ cảnh báo, không chặn bot` };
  const credit = limits.platformCreditUsdPerMonth;
  if (!(credit > 0)) return { ok: false, reason: "gói không có credit AI dùng chung (0 USD) — bot sẽ không chạy" };
  if (salesCost30dUsd === null) return { ok: false, reason: `trần cứng ${credit} USD/tháng mà chưa đo được mức dùng 30 ngày — không chuyển mù` };
  const needMonth = usd2(salesCost30dUsd * CREDIT_MARGIN);
  const needRest = usd2((salesCost30dUsd / 30) * daysLeftInMonth * CREDIT_MARGIN);
  const left = usd2(credit - monthUsedUsd);
  const fix = "nâng hạn mức của tổ chức (ghi đè AI ở /platform) hoặc chuyển ngân sách mềm trước";
  if (credit < needMonth) return { ok: false, reason: `trần cứng ${credit} USD/tháng < ${needMonth} USD (30 ngày ${salesCost30dUsd} USD × ${CREDIT_MARGIN}) — bot sẽ im giữa tháng; ${fix}` };
  if (left < needRest) return { ok: false, reason: `tháng này còn ${left} USD (đã dùng ${monthUsedUsd}) < ${needRest} USD cho ${daysLeftInMonth} ngày còn lại — bot sẽ im trước cuối tháng; ${fix}` };
  return { ok: true, reason: `trần cứng ${credit} USD/tháng ≥ ${needMonth} USD; tháng này còn ${left} USD ≥ ${needRest} USD cho ${daysLeftInMonth} ngày còn lại` };
}

export type UsageGroup = { billingSource: string; feature: string; workload: string | null; n: number };

/** Sau mốc cutover: dòng sổ của AI Bán hàng còn nguồn BYOK là SAI (dự phòng đã tắt); tính năng khác (Media, Săn khách sỉ) BYOK là đúng. */
export function cutoverVerdict(rows: readonly UsageGroup[]): { salesPlatform: number; salesByok: number; salesOther: number; otherByok: number } {
  const out = { salesPlatform: 0, salesByok: 0, salesOther: 0, otherByok: 0 };
  for (const r of rows) {
    const sales = (SALES_FEATURES as readonly string[]).includes(r.feature);
    if (sales && r.billingSource === "PLATFORM") out.salesPlatform += r.n;
    else if (sales && r.billingSource === "BYOK") out.salesByok += r.n;
    else if (sales) out.salesOther += r.n;
    else if (r.billingSource === "BYOK") out.otherByok += r.n;
  }
  return out;
}

// ─────────────────────────── GOOGLE ───────────────────────────

type ServiceAccount = { client_email: string; private_key: string; token_uri?: string };
/** Credential quản trị Google Cloud có thể có trong container — chỉ TÊN biến được in, không bao giờ nội dung. */
export const GCP_CREDENTIAL_ENVS = ["GCP_ADMIN_SERVICE_ACCOUNT_JSON", "GOOGLE_SERVICE_ACCOUNT_JSON", "GOOGLE_APPLICATION_CREDENTIALS_JSON", "GOOGLE_APPLICATION_CREDENTIALS"] as const;

function readServiceAccount(): { ok: true; env: string; sa: ServiceAccount } | { ok: false; reason: string } {
  for (const env of GCP_CREDENTIAL_ENVS) {
    const raw = (process.env[env] ?? "").trim();
    if (!raw) continue;
    try {
      const j = JSON.parse(raw.startsWith("{") ? raw : readFileSync(raw, "utf8")) as Partial<ServiceAccount>;
      if (typeof j.client_email === "string" && typeof j.private_key === "string") return { ok: true, env, sa: { client_email: j.client_email, private_key: j.private_key, token_uri: j.token_uri } };
    } catch {
      // nội dung hỏng ⇒ coi như không có — không in gì của nó
    }
    return { ok: false, reason: `${env} có mà không đọc được thành service account` };
  }
  return { ok: false, reason: "container không có credential quản trị Google Cloud (service account)" };
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

async function gcpAccessToken(sa: ServiceAccount): Promise<{ ok: true; token: string } | { ok: false; reason: string }> {
  try {
    const now = Math.floor(Date.now() / 1000);
    const aud = sa.token_uri || "https://oauth2.googleapis.com/token";
    const unsigned = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/cloud-platform", aud, iat: now, exp: now + 600 }))}`;
    const signer = createSign("RSA-SHA256");
    signer.update(unsigned);
    const assertion = `${unsigned}.${b64url(signer.sign(sa.private_key))}`;
    const r = await fetch(aud, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }), redirect: "manual", signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    if (!r.ok) return { ok: false, reason: `lấy token HTTP ${r.status}` };
    const j = (await r.json()) as { access_token?: unknown };
    return typeof j.access_token === "string" && j.access_token ? { ok: true, token: j.access_token } : { ok: false, reason: "token rỗng" };
  } catch (e) {
    return { ok: false, reason: `không lấy được token (${e instanceof Error ? e.name : "lỗi"})` };
  }
}

export type GcpProject = { number: string | null; id: string | null; name: string | null; owners: string[] | null; reason: string | null };

async function gcpLookup(apiKey: string, token: string): Promise<GcpProject> {
  const out: GcpProject = { number: null, id: null, name: null, owners: null, reason: null };
  const auth = { Authorization: `Bearer ${token}` };
  const why: string[] = [];
  try {
    // `keyString` bắt buộc nằm ở query (API Keys Lookup không nhận header) — không theo chuyển hướng để khoá không đi tiếp đâu cả.
    const r = await fetch(`https://apikeys.googleapis.com/v2/keys:lookupKey?keyString=${encodeURIComponent(apiKey)}`, { headers: auth, redirect: "manual", signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    if (!r.ok) return { ...out, reason: `UNAVAILABLE — Lookup HTTP ${r.status}${r.status === 403 ? " (thiếu quyền apikeys.keys.lookup)" : ""}` };
    const m = /^projects\/(\d+)\//.exec(((await r.json()) as { parent?: string }).parent ?? "");
    if (!m) return { ...out, reason: "UNAVAILABLE — Lookup không trả project" };
    out.number = m[1];
    const p = await fetch(`https://cloudresourcemanager.googleapis.com/v3/projects/${m[1]}`, { headers: auth, redirect: "manual", signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    if (p.ok) {
      const pj = (await p.json()) as { projectId?: string; displayName?: string };
      out.id = pj.projectId ?? null;
      out.name = pj.displayName ?? null;
    } else why.push(`projects.get HTTP ${p.status}${p.status === 403 ? " (thiếu quyền)" : ""}`);
    const iam = await fetch(`https://cloudresourcemanager.googleapis.com/v3/projects/${m[1]}:getIamPolicy`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: "{}", redirect: "manual", signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    if (iam.ok) {
      const bindings = ((await iam.json()) as { bindings?: { role?: string; members?: string[] }[] }).bindings ?? [];
      out.owners = bindings.filter((b) => b.role === "roles/owner").flatMap((b) => b.members ?? []).map((m2) => m2.replace(/^(user|serviceAccount|group|domain):/, ""));
    } else why.push(`getIamPolicy HTTP ${iam.status}${iam.status === 403 ? " (thiếu quyền IAM)" : ""}`);
  } catch (e) {
    why.push(`không gọi được Google (${e instanceof Error ? e.name : "lỗi"})`);
  }
  out.reason = why.length ? `UNAVAILABLE một phần — ${why.join(" · ")}` : null;
  return out;
}

// ─────────────────────────── ĐỌC CHUNG ───────────────────────────

type Org = { code: string; name: string; isHome: boolean; status: string };

async function salesCost30d(orgCode: string): Promise<{ usd: number | null; unpriced: number }> {
  const pdb = await getPlatformDb();
  const u = schema.platformAiUsage;
  const [r] = await pdb
    .select({ usd: sql<string | null>`sum(${u.costUsd})`, unpriced: sql<number>`count(*) filter (where ${u.costUsd} is null and ${u.status} = 'OK')` })
    .from(u)
    .where(and(eq(u.orgCode, orgCode), inArray(u.feature, [...SALES_FEATURES]), gte(u.at, new Date(Date.now() - 30 * 86_400_000))));
  return { usd: r?.usd === null || r?.usd === undefined ? null : Math.round(Number(r.usd) * 100) / 100, unpriced: Number(r?.unpriced ?? 0) };
}

async function usageGroups(orgCode: string, since: Date): Promise<(UsageGroup & { provider: string | null; model: string | null; status: string; costUsd: number | null })[]> {
  const pdb = await getPlatformDb();
  const u = schema.platformAiUsage;
  const rows = await pdb
    .select({ billingSource: u.billingSource, provider: u.provider, model: u.model, feature: u.feature, workload: u.workload, status: u.status, n: sql<number>`count(*)::int`, cost: sql<string | null>`sum(${u.costUsd})` })
    .from(u)
    .where(and(eq(u.orgCode, orgCode), gte(u.at, since)))
    .groupBy(u.billingSource, u.provider, u.model, u.feature, u.workload, u.status)
    .orderBy(u.billingSource, u.feature, u.workload);
  return rows.map((r) => ({ billingSource: r.billingSource, provider: r.provider, model: r.model, feature: r.feature, workload: r.workload, status: r.status, n: Number(r.n), costUsd: r.cost === null ? null : Number(r.cost) }));
}

// ─────────────────────────── BA CHẾ ĐỘ ───────────────────────────

async function audit(org: Org): Promise<number> {
  const db = await getDbForInspection(org);
  const pdb = await getPlatformDb();
  for (const [nhan, d] of [["tổ chức", db], ["nền tảng", pdb]] as const) {
    const [ro] = rowsOf<Record<string, unknown>>(await d.execute(sql`show default_transaction_read_only`));
    if (String(ro?.default_transaction_read_only ?? "") !== "on") {
      tomTat(`DỪNG: kết nối CSDL ${nhan} KHÔNG ở chế độ chỉ đọc — không đọc gì`);
      return 70;
    }
  }
  console.log(`Tên tổ chức: ${org.name}`);
  tomTat(`KIỂM ${org.code} — CHỈ ĐỌC`);

  const [setting] = await db.select({ value: schema.settings.value }).from(schema.settings).where(eq(schema.settings.key, SALES_CHATBOT_SETTING_KEY)).limit(1);
  const engine = engineOf(setting?.value);
  tomTat(`Động cơ AI Bán hàng: bot ${engine.enabled === null ? "—" : engine.enabled ? "BẬT" : "TẮT"} · ${engineText(engine)} · chuyển dự phòng ${engine.failoverEnabled === null ? "—" : engine.failoverEnabled ? "bật" : "tắt"}`);

  // Kết nối AI + DẤU BĂM khoá qua lib/connectors/service.ts — khoá của tổ chức được giải và băm NGAY TRONG service, không tới đây.
  const conns = await aiConnectionAudit(db, org.code);
  for (const row of conns) {
    tomTat(`Kết nối ${row.connectorKey}: ${row.status} · lần kiểm ${row.lastTestOk === null ? "—" : row.lastTestOk ? "đạt" : "hỏng"} ${row.lastTestAt ? row.lastTestAt.toISOString().slice(0, 16) : ""} · model ${row.model ?? "(mặc định)"} · model vẽ ảnh ${row.imageModel ?? "—"}`);
    if (row.digestError) tomTat(`${row.connectorKey}: không lấy được dấu băm khoá — UNAVAILABLE`);
    if (row.digestError) console.log(`${row.connectorKey}: ${row.digestError}`);
  }
  const byok = conns.find((r) => r.connectorKey === "gemini-byok") ?? null;
  const byokDigest = byok?.keyDigest ?? null;
  if (!byok) tomTat("gemini-byok: tổ chức chưa có kết nối này");

  const pcfg = platformAiConfig();
  const platformKey = (process.env[PLATFORM_AI_ENV.apiKey] ?? "").trim() || null;
  const homeGemini = (process.env.GEMINI_API_KEY ?? "").trim() || null;
  tomTat(`AI dùng chung: ${PLATFORM_AI_ENV.enabled}=${(process.env[PLATFORM_AI_ENV.enabled] ?? "").trim() === "1" ? "1" : "≠1"} · ${PLATFORM_AI_ENV.provider}=${(process.env[PLATFORM_AI_ENV.provider] ?? "").trim() || "(mặc định)"} · ${pcfg.ready ? `SẴN SÀNG · nhà cung cấp ${pcfg.provider} · model nền ${pcfg.model}` : `CHƯA sẵn sàng — ${pcfg.reason}`}`);
  if (pcfg.ready) {
    const p = await probeWithPlatformKey([pcfg.model]);
    if (p.ready) for (const r of p.results) tomTat(`Gọi thử khoá nền tảng · ${r.provider} · ${r.model} · ${r.verdict} · HTTP ${r.httpStatus ?? "—"} · ${r.latencyMs} ms`);
    else tomTat(`Gọi thử khoá nền tảng: ${p.reason}`);
  }

  const digests = { platform: keyDigest(platformKey), byok: byokDigest, home: keyDigest(homeGemini) };
  const fp = { platform: fingerprintOf(digests.platform), byok: fingerprintOf(digests.byok), home: fingerprintOf(digests.home) };
  console.log(`Vân tay (12 ký tự đầu SHA-256): PLATFORM_AI_API_KEY ${fp.platform ?? "—"} · ${org.code}/gemini-byok ${fp.byok ?? "—"} · GEMINI_API_KEY của nhà ${fp.home ?? "—"}`);
  tomTat(`Khoá nền tảng ↔ khoá BYOK ${org.code}: ${compareKeys(digests.platform, digests.byok)} · khoá BYOK ↔ khoá Gemini của nhà: ${compareKeys(digests.byok, digests.home)} · khoá nền tảng ↔ khoá của nhà: ${compareKeys(digests.platform, digests.home)}`);

  const sa = readServiceAccount();
  const token = sa.ok ? await gcpAccessToken(sa.sa) : null;
  const lookupReason = !sa.ok ? `UNAVAILABLE — ${sa.reason}` : token && !token.ok ? `UNAVAILABLE — ${token.reason}` : null;
  // Lookup cần CHÍNH khoá ⇒ chỉ chạy cho khoá ở `.env` của máy chủ; khoá của tổ chức không rời lib/connectors/service.ts.
  const keys = [
    ["PLATFORM_AI_API_KEY", platformKey],
    ["GEMINI_API_KEY (nhà)", homeGemini],
  ] as const;
  const projects: Record<string, GcpProject | null> = {};
  for (const [label, key] of keys) {
    const lookup = key && token && token.ok ? await gcpLookup(key, token.token) : null;
    projects[label] = lookup;
    if (!key) continue;
    // Project / chủ project là dữ liệu nhạy cảm ⇒ CHỈ trong phần MÃ HOÁ; dòng tóm tắt chỉ nói có / không.
    console.log(`Project của ${label}: ${lookup ? `số ${lookup.number ?? "—"} · id ${lookup.id ?? "—"} · tên ${lookup.name ?? "—"} · chủ ${lookup.owners ? lookup.owners.join(", ") || "(không có roles/owner)" : "—"}${lookup.reason ? ` · ${lookup.reason}` : ""}` : (lookupReason ?? "—")}`);
    tomTat(`Project ${label}: Lookup ${lookup?.number ? "CÓ" : (lookup?.reason ?? lookupReason ?? "UNAVAILABLE")}`);
  }
  if (sa.ok) tomTat(`Credential quản trị Google: biến ${sa.env}`);
  tomTat(`Project ${org.code}/gemini-byok: UNAVAILABLE — Lookup cần chính khoá, mà khoá của tổ chức chỉ được giải trong lib/connectors/service.ts`);
  const P = projects["PLATFORM_AI_API_KEY"];
  const H = projects["GEMINI_API_KEY (nhà)"];
  tomTat(`Project nền tảng ↔ BYOK: ${compareProjects(P?.number ?? null, null)} · tài khoản Google nền tảng ↔ BYOK: ${compareAccounts(P?.owners ?? null, null)} · project nền tảng ↔ nhà: ${compareProjects(P?.number ?? null, H?.number ?? null)}`);

  const limits = await resolveAiLimits(org.code);
  const cost = await salesCost30d(org.code);
  const month = await sourceUsage(org.code, "PLATFORM");
  const plat = await platformChatAi(org.code).catch((e: unknown) => ({ ok: false as const, reason: `không đọc được (${e instanceof Error ? e.name : "lỗi"})` }));
  const credit = creditVerdict(limits?.limits ?? null, cost.usd, month.costUsdMonth, daysLeftInMonthVN(new Date()));
  console.log(`Gói ${limits?.planKey ?? "—"}: credit AI dùng chung ${limits ? `${limits.limits.platformCreditUsdPerMonth} USD/tháng · ${limits.limits.softOnly ? "ngân sách mềm" : "trần cứng"}` : "—"} · đã dùng tháng này (PLATFORM) ${month.costUsdMonth} USD · AI Bán hàng 30 ngày ${cost.usd ?? "—"} USD${cost.unpriced ? ` (+${cost.unpriced} lượt chưa định giá, không cộng)` : ""}`);
  console.log(`Credit: ${credit.reason}`);
  tomTat(`Credit AI dùng chung đủ cho AI Bán hàng: ${credit.ok ? "ĐỦ" : "KHÔNG"} (${limits ? (limits.limits.softOnly ? "ngân sách mềm" : "trần cứng") : "không đọc được gói"})`);
  if (!plat.ok) console.log(`AI dùng chung: ${plat.reason}`);
  tomTat(`AI dùng chung cho ${org.code} lúc này: ${plat.ok ? "DÙNG ĐƯỢC" : "KHÔNG (lý do trong phần mã hoá)"}`);

  // Ai còn dùng khoá riêng: AI Bán hàng theo cấu hình bot; Media (ảnh / chữ) mở kết nối đầu tiên đang bật (OpenAI rồi Gemini);
  // Săn khách sỉ mở thẳng gemini-byok (lib/creative/org-ai.ts · lib/wholesale/outreach.ts).
  const active = (k: string) => conns.some((r) => r.connectorKey === k && r.status === "ACTIVE" && r.lastTestOk === true);
  const gemImage = byok?.imageModel ?? null;
  tomTat(`Ai dùng gemini-byok: AI Bán hàng ${engine.connectorKey === "gemini-byok" || engine.fallbackConnectorKey === "gemini-byok" ? "CÓ (theo cấu hình bot)" : "không"} · Media viết chữ ${active("openai-byok") ? "không (OpenAI đứng trước)" : active("gemini-byok") ? "CÓ" : "không (chưa bật)"} · Media vẽ ảnh ${active("openai-byok") ? "không (OpenAI đứng trước)" : active("gemini-byok") && typeof gemImage === "string" && gemImage ? "CÓ" : "không (chưa khai model vẽ ảnh)"} · Săn khách sỉ ${active("gemini-byok") ? "CÓ" : "không (chưa bật)"}`);

  const groups = await usageGroups(org.code, new Date(Date.now() - 30 * 86_400_000));
  for (const g of groups.slice(0, 60)) console.log(`Sổ AI 30 ngày · ${g.billingSource} · ${g.provider ?? "—"} · ${g.model ?? "—"} · ${g.feature}/${g.workload ?? "—"} · ${g.status}: ${g.n} dòng · ${g.costUsd === null ? "—" : g.costUsd.toFixed(4)} USD`);
  return 0;
}

async function apply(org: Org): Promise<number> {
  const pcfg = platformAiConfig();
  if (!pcfg.ready) {
    tomTat(`KHÔNG CHUYỂN: AI dùng chung chưa sẵn sàng — ${pcfg.reason}`);
    return 1;
  }
  const plat = await platformChatAi(org.code);
  if (!plat.ok) {
    console.log(`AI dùng chung: ${plat.reason}`);
    tomTat(`KHÔNG CHUYỂN: AI dùng chung chưa dùng được cho ${org.code} (lý do trong phần mã hoá)`);
    return 1;
  }
  const limits = await resolveAiLimits(org.code);
  const cost = await salesCost30d(org.code);
  const credit = creditVerdict(limits?.limits ?? null, cost.usd, (await sourceUsage(org.code, "PLATFORM")).costUsdMonth, daysLeftInMonthVN(new Date()));
  console.log(`Credit: ${credit.reason}`);
  if (!credit.ok) {
    tomTat("KHÔNG CHUYỂN: credit AI dùng chung không đủ cho AI Bán hàng (chi tiết trong phần mã hoá)");
    return 1;
  }
  const home = (await listOrganizations()).find((o) => o.isHome);
  const r = await withOrganization(org.code, () => saveChatbotEngineAsOperator({ engine: { ...PLATFORM_ENGINE_PATCH }, operator: { orgCode: home?.code ?? "home", email: SCRIPT_LABEL }, reason: CUTOVER_REASON }));
  if (!r.ok) {
    tomTat(`KHÔNG CHUYỂN: ${r.error}`);
    return 1;
  }
  const at = new Date().toISOString();
  await platformAudit({ action: "AI_ORG_CONTROL_SET", targetOrgCode: org.code, subject: "sales_chatbot.engine", before: r.before, after: r.after, reason: `${CUTOVER_REASON} · mốc ${at}`, source: "SCRIPT", actor: null });
  tomTat(`ĐÃ CHUYỂN ${org.code} lúc ${at} (mốc cutover): ${engineText(engineOf(r.before))} ⇒ ${engineText(engineOf(r.after))}`);
  tomTat("Credit AI dùng chung: ĐỦ");
  return 0;
}

async function probe(org: Org, since: Date | null): Promise<number> {
  const t = await withOrganization(org.code, async () => {
    // Máy làm ⇒ không mang tên người (luật 34 / 36); dấu vết nằm ở nhật ký nền tảng của lượt chuyển.
    const conv = await openConversation("TEST", { createdBy: null });
    const turn = await chatTurn(conv.id, PROBE_TEXT, { channel: "TEST", actorId: null });
    return { convId: conv.id, ok: turn.ok, error: turn.ok ? null : turn.error };
  });
  tomTat(`Lượt thử (kênh TEST, không nhắn khách thật): ${t.ok ? "bot trả lời được" : "LỖI"}`);
  if (!t.ok) console.log(`Lỗi lượt thử: ${t.error}`);
  const pdb = await getPlatformDb();
  const u = schema.platformAiUsage;
  const rows = await pdb
    .select({ billingSource: u.billingSource, provider: u.provider, model: u.model, feature: u.feature, workload: u.workload, status: u.status, costUsd: u.costUsd, at: u.at })
    .from(u)
    .where(and(eq(u.orgCode, org.code), eq(u.ref, t.convId)))
    .orderBy(u.at);
  if (!rows.length) tomTat("Sổ AI: lượt thử KHÔNG để lại dòng nào");
  for (const r of rows) tomTat(`Sổ AI lượt thử · org_code ${org.code} · ${r.billingSource} · ${r.provider ?? "—"} · ${r.model ?? "—"} · ${r.feature}/${r.workload ?? "—"} · ${r.status}`);
  for (const r of rows) console.log(`Sổ AI lượt thử · ${r.at.toISOString()} · ${r.billingSource} · ${r.model ?? "—"} · ${r.workload ?? "—"} · ${r.costUsd === null ? "—" : r.costUsd.toFixed(5)} USD`);
  if (since) {
    const groups = await usageGroups(org.code, since);
    for (const g of groups) console.log(`Từ mốc ${since.toISOString()} · ${g.billingSource} · ${g.provider ?? "—"} · ${g.model ?? "—"} · ${g.feature}/${g.workload ?? "—"} · ${g.status}: ${g.n} dòng · ${g.costUsd === null ? "—" : g.costUsd.toFixed(4)} USD`);
    const v = cutoverVerdict(groups);
    console.log(`Từ mốc cutover: AI Bán hàng PLATFORM ${v.salesPlatform} dòng · AI Bán hàng BYOK ${v.salesByok} · AI Bán hàng nguồn khác ${v.salesOther} · tính năng khác BYOK ${v.otherByok}`);
    tomTat(`Từ mốc cutover: AI Bán hàng nguồn PLATFORM ${v.salesPlatform > 0 ? "CÓ" : "CHƯA CÓ"} · AI Bán hàng nguồn BYOK ${v.salesByok === 0 ? "0 — ĐẠT" : "CÒN — CHƯA ĐẠT"} · nguồn khác ${v.salesOther === 0 ? "0" : "CÓ"} · Media / Săn khách sỉ BYOK ${v.otherByok > 0 ? "có (đúng)" : "không"}`);
  }
  return 0;
}

async function main(): Promise<number> {
  const flags = ARGS.filter((a) => a.startsWith("--"));
  const code = ARGS.find((a) => !a.startsWith("--")) ?? "";
  if (!code) {
    tomTat("arg: <mã tổ chức> [--apply | --apply-probe [--since=<ISO>]]");
    return 64;
  }
  const org = await findOrganization(code);
  if (!org) {
    tomTat(`Không có tổ chức mã «${code}»`);
    return 64;
  }
  if (org.isHome) {
    tomTat("Tổ chức nhà dùng khoá của nhà (HOME) — không có gì để chuyển");
    return 64;
  }
  if (flags.includes("--apply") && flags.includes("--apply-probe")) {
    tomTat("Chọn MỘT: --apply hoặc --apply-probe");
    return 64;
  }
  if (flags.includes("--apply")) return apply(org);
  if (flags.includes("--apply-probe")) {
    const raw = flags.find((f) => f.startsWith("--since="))?.slice("--since=".length) ?? "";
    const since = raw ? new Date(raw) : null;
    if (since && Number.isNaN(since.getTime())) {
      tomTat("--since phải là mốc ISO, ví dụ 2026-10-08T04:00:00Z");
      return 64;
    }
    return probe(org, since);
  }
  return audit(org);
}

if (CHAY_THANG) {
  main()
    .then((rc) => process.exit(rc))
    .catch((e) => {
      tomTat(`LỖI: ${e instanceof Error ? e.message.slice(0, 200) : "không rõ"}`);
      process.exit(1);
    });
}
