/*
  ops `org-ai-cutover` — AI BÁN HÀNG CỦA MỘT TỔ CHỨC KHÁCH ĐANG TRẢ TIỀN Ở ĐÂU, VÀ ĐƯA NÓ SANG AI DÙNG CHUNG CỦA NỀN TẢNG.

  Vì sao (08/10/2026, chủ shop): HSLC (`hslc-hmt-shop`) chạy bot bằng khoá Gemini RIÊNG (`gemini-byok`) ⇒ chi phí AI Bán hàng
  nằm ở nguồn BYOK, không vào cột «AI nền tảng trả» của /platform/saas. Muốn hạch toán tập trung: động cơ AI của bot sang
  `platform` (PLATFORM_AI_API_KEY trong `.env` của máy chủ) — KHÔNG chép khoá nền tảng vào kết nối của tổ chức, KHÔNG tắt kết nối
  BYOK (Media / Săn khách sỉ đọc thẳng kết nối ấy, không qua cấu hình bot).

  Ba chế độ — ô arg chỉ nhận chữ / số / khoảng trắng / = : . _ , / @ + -; cờ lạ / thiếu / thừa ⇒ lỗi cách dùng (mã 64), không đoán:
   · `<mã>`                    KIỂM (CHỈ ĐỌC — Postgres ép, hỏi lại trước khi đọc): động cơ AI của bot — ô ĐÃ LƯU (thô, `settings.value`
                               là CHUỖI JSON) VÀ động cơ ĐANG CHẠY (đúng phép đọc của bot: `parseSalesChatbotConfig` + dự phòng hiệu
                               lực) · kết nối AI (trạng thái, KHÔNG bí mật) · khoá nền tảng sẵn sàng chưa · hạn mức AI ĐANG ÁP (gói ·
                               ghi đè · lượt · trần tiền · credit · ngân sách mềm) · credit có đủ cho AI Bán hàng theo NHỊP CHI GẦN ĐÂY
                               không (mục dưới) · VÂN TAY từng khoá (12 ký tự đầu SHA-256 — khoá chỉ nằm trong RAM, KHÔNG BAO GIỜ in) ·
                               SAME_KEY / DIFFERENT_KEY · project Google của từng khoá (API Keys Lookup bằng credential quản trị NẾU
                               container có; Lookup không ra số ⇒ DÒ bằng ErrorInfo của Google — mục dưới; vẫn không ra ⇒ UNAVAILABLE,
                               không đoán) — KHÔNG gọi API nào khác bằng khoá của khách (review #659) · ai còn dùng `gemini-byok` · sổ AI
                               30 ngày theo nguồn tiền × nhà cung cấp × model × loại việc.

  SỐ PROJECT BẰNG CHÍNH KHOÁ (08/10/2026, chủ shop hỏi «ID project của token API hệ thống»): container không có credential quản trị
  Google Cloud nên Lookup luôn UNAVAILABLE. Gọi một API Google nhận API key mà project chỉ-dùng-Gemini thường CHƯA BẬT (Translation ·
  Natural Language · Vision, thân CỐ Ý rỗng — API đang bật cũng không dịch / phân tích gì nên không phát sinh phí) ⇒ cổng Google trả 403
  kèm `google.rpc.ErrorInfo` (SERVICE_DISABLED / API_KEY_SERVICE_BLOCKED) mang `metadata.consumer = projects/<số>`. CHỈ cho khoá của
  NỀN TẢNG và khoá Gemini của NHÀ (`PROJECT_PROBE_KEY_ENVS`, đọc thẳng env của container — hàm dò không nhận khoá từ nơi nào khác), và
  chỉ khi khoá đúng dạng khoá API Google (khoá Anthropic không bao giờ bị gửi sang Google). Số ĐẦY ĐỦ chỉ ở phần MÃ HOÁ; dòng tóm tắt
  công khai chỉ mang dạng CHE (4 chữ số cuối + độ dài) và phép so CÙNG / KHÁC project.
   · `<mã> --apply [--credit=<USD>]`
                               CHUYỂN: `connectorKey = platform`, model = mặc định / chính sách của nền tảng, KHÔNG dự phòng — qua ĐÚNG
                               `saveChatbotEngineAsOperator` (lõi của /platform/org/<mã>: bot đang bật mà AI dùng chung chưa dùng được
                               cho tổ chức ⇒ tự từ chối) + nhật ký nền tảng `AI_ORG_CONTROL_SET` nguồn SCRIPT. TỪ CHỐI khi credit trần
                               cứng không đủ theo nhịp chi gần đây (bot sẽ im giữa tháng). `--credit=<USD>` (chỉ đi cùng `--apply`):
                               KIỂM credit ĐỀ XUẤT trước — không đủ ⇒ không ghi gì; đủ ⇒ đặt ghi đè `platformCreditUsdPerMonth` qua lõi
                               `setOrgAiLimitAsOperator` (lib/ai-usage/control.ts — cùng đường ghi + nhật ký với màn hình, nguồn SCRIPT),
                               đọc lại hạn mức ĐANG ÁP và kiểm lại, rồi mới chuyển; chuyển không thành ⇒ HOÀN credit về ghi đè cũ (cũng
                               có nhật ký). In mốc cutover.
   · `<mã> --apply-probe [--since=<ISO>]`  HẬU KIỂM: MỘT lượt ở hội thoại THỬ (kênh TEST — không nhắn khách thật, công cụ mô phỏng)
                               rồi đọc dòng sổ AI của chính lượt ấy; đếm dòng sổ từ mốc cutover theo nguồn tiền × loại việc.

  NHỊP CHI GẦN ĐÂY (08/10/2026): bot HSLC mới chạy đông từ 04/10 — chi phí AI Bán hàng theo ngày VN 0,16 · 0,74 · 1,23 · 1,98 · 2,64 ·
  3,12 USD (02/10 → 07/10). Tổng 30 ngày (11,07 USD) là trung bình của một tháng mà nửa đầu bot gần như chưa chạy: credit 14 USD
  qua được phép so cũ rồi cạn sau ~5 ngày ⇒ bot im với khách thật (PLATFORM là trần cứng). Cơ sở tháng nay = LỚN NHẤT của ba: tổng 30
  ngày trọn · tổng 7 ngày trọn × 30/7 · ngày VN trọn gần nhất × 30; cơ sở ngày = cơ sở tháng / 30. Chỉ ngày TRỌN (hôm nay chưa xong
  thì không vào cơ sở); chỉ lượt ĐÃ định giá (lượt chưa định giá đếm riêng, in cạnh); 30 ngày không lượt nào định giá được ⇒ CHƯA ĐO
  ĐƯỢC ⇒ KHÔNG đủ (không chuyển mù).

  MÃ LÝ DO (08/10/2026): production chạy `--apply --credit=150` rồi `=300` và cả hai lần chỉ ra «KHÔNG CHUYỂN: credit ĐỀ XUẤT không đủ» —
  lý do thật nằm trong phần mã hoá mà người vận hành không giải được, nên không biết nên nâng credit hay sửa chỗ khác. Nay credit KHÔNG đủ
  ⇒ dòng tóm tắt mang `CreditRefusalCode` sinh ở ĐÚNG nhánh của `creditVerdict` (PLAN_UNREADABLE · NO_PLATFORM_CREDIT · BASIS_UNMEASURED ·
  MONTH_EXHAUSTED · COST_HARD_BELOW_NEED · CREDIT_BELOW_NEED) + việc phải làm — chỉ tỷ lệ % lượt chưa định giá, tên model chưa có giá và
  cờ TRONG / VƯỢT trần đường ops, KHÔNG một con số tiền nào (`refusalTag`).

  Cả lượt chạy trong `ma_hoa_ket_qua`: vân tay, project / tài khoản Google, gói / credit / chi tiêu / sổ AI của khách CHỈ nằm ở phần MÃ
  HOÁ; dòng `[ops:tom-tat] ` (log công khai — kho PUBLIC) chỉ mang nhãn, phán quyết và mã lý do (SAME / DIFFERENT · ĐỦ / KHÔNG · ĐẠT /
  CHƯA), không một con số USD nào.
*/
const ARGS = process.argv.slice(2);
const CHAY_THANG = Boolean(process.argv[1] && process.argv[1].endsWith("org-ai-cutover.ts"));
const CO_GHI = ARGS.includes("--apply") || ARGS.includes("--apply-probe");
if (CHAY_THANG && !CO_GHI) process.env.ERP_READ_ONLY = "1";

import "dotenv/config";
import { createHash, createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { and, eq, gte, sql } from "drizzle-orm";
import { getDbForInspection, getPlatformDb, schema } from "@/db";
import { giaCuaModel } from "@/lib/ai/provider";
import { platformChatAi } from "@/lib/ai-builder/provider";
import { readOrgAiControl, SCRIPT_AI_CREDIT_MAX_USD, SCRIPT_AI_LIMIT_KEY, setOrgAiLimitAsOperator, type OrgAiControl, type OrgAiLimitScriptResult } from "@/lib/ai-usage/control";
import { aiUsageDaily, sourceUsage } from "@/lib/ai-usage/ledger";
import { PLATFORM_AI_ENV, platformAiConfig } from "@/lib/ai-usage/platform-ai";
import { probeWithPlatformKey } from "@/lib/ai-usage/platform-ai-admin";
import { resolveAiLimits, type ResolvedAiLimits } from "@/lib/ai-usage/quota";
import { policyForWorkload, readPlatformAiPolicies, routePlatformModel, type PlatformAiPolicySet } from "@/lib/ai-usage/platform-ai-policy";
import { AI_LIMIT_OVERRIDE_KEYS, PLATFORM_WORKLOADS, vnDayKey } from "@/lib/ai-usage/types";
import { aiConnectionAudit } from "@/lib/connectors/service";
import { platformAudit } from "@/lib/platform/audit";
import { withOrganization } from "@/lib/platform/context";
import { findOrganization, listOrganizations } from "@/lib/platform/organizations";
import { DEFAULT_SALES_CHATBOT_CONFIG, effectiveFallback, parseSalesChatbotConfig, SALES_CHATBOT_SETTING_KEY, salesChatbotConfigZ, type SalesBotConnector } from "@/lib/sales-chatbot/config";
import { chatTurn, loadSalesChatbotConfig, openConversation } from "@/lib/sales-chatbot/engine";
import { saveChatbotEngineAsOperator } from "@/lib/sales-chatbot/settings";
import { rowsOf } from "@/lib/sql-rows";

const tomTat = (s: string) => console.log(`[ops:tom-tat] ${s}`);

export const SCRIPT_LABEL = "script:org-ai-cutover";
export const CUTOVER_REASON = "Hạch toán tập trung chi phí AI Bán hàng trên /platform/saas: chuyển sang AI dùng chung của nền tảng (PLATFORM_AI_API_KEY), không dự phòng sang khoá riêng — yêu cầu của chủ shop 08/10/2026";
export const CREDIT_REASON = "Credit AI dùng chung cho AI Bán hàng, đặt NGAY TRƯỚC lượt chuyển (ops org-ai-cutover --apply --credit): đủ cho cơ sở tháng theo nhịp chi gần đây × biên an toàn — yêu cầu của chủ shop 08/10/2026";
/** Đúng các ô động cơ đổi khi chuyển: nguồn = AI dùng chung, model = của nền tảng, KHÔNG dự phòng (100% chi phí về PLATFORM). */
export const PLATFORM_ENGINE_PATCH = { connectorKey: "platform", model: "", fallbackConnectorKey: null, fallbackModel: "" } as const;
/** Tính năng của AI Bán hàng trên sổ AI — mọi lượt (trả lời · ảnh · trích nhanh · ghi đơn hộ · nhắc · học) đi qua MỘT cấu hình `ai.salesChatbot`. */
export const SALES_FEATURES = ["sales_chatbot", "sales_playbook"] as const;
export const AI_CONNECTORS = ["gemini-byok", "openai-byok", "anthropic-byok"] as const;
/** Biên an toàn khi so credit trần cứng với cơ sở chi (giá model nền tảng có thể khác, tháng có thể đông khách hơn). */
export const CREDIT_MARGIN = 1.25;
const PROBE_TEXT = "Shop ơi cho mình hỏi giá sản phẩm bán chạy nhất với ạ";
const HTTP_TIMEOUT_MS = 15_000;
const DAY_MS = 86_400_000;

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

/**
 * Ô `settings.value` ⇒ đối tượng ĐÃ LƯU. Cột là text và `setSettingJson` lưu CHUỖI JSON (đọc lại bằng `JSON.parse` — y như
 * `readJsonSetting` của bot); nơi gọi khác có thể đưa sẵn đối tượng. Hỏng / thiếu / không phải đối tượng ⇒ `null` — coi như không có.
 * Lỗi 08/10/2026: bản cũ chỉ nhận đối tượng nên lượt KIỂM in «bot — · nguồn —» trong khi bot đang chạy `gemini-byok`.
 */
export function storedSettingObject(value: unknown): Record<string, unknown> | null {
  let v: unknown = value;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v) as unknown;
    } catch {
      return null;
    }
  }
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export type EngineView = { enabled: boolean | null; connectorKey: string | null; model: string; fallbackConnectorKey: string | null; fallbackModel: string; failoverEnabled: boolean | null };

/** Động cơ AI của bot đọc từ giá trị ĐÃ LƯU của `ai.salesChatbot` (chuỗi JSON hoặc đối tượng) — chỉ các ô động cơ, không bí mật, KHÔNG mặc định. */
export function engineOf(value: unknown): EngineView {
  const v = storedSettingObject(value) ?? {};
  const s = (x: unknown) => (typeof x === "string" ? x : "");
  const b = (x: unknown) => (typeof x === "boolean" ? x : null);
  return { enabled: b(v.enabled), connectorKey: s(v.connectorKey) || null, model: s(v.model), fallbackConnectorKey: s(v.fallbackConnectorKey) || null, fallbackModel: s(v.fallbackModel), failoverEnabled: b(v.failoverEnabled) };
}

export function engineText(e: Pick<EngineView, "connectorKey" | "model" | "fallbackConnectorKey" | "fallbackModel">): string {
  return `nguồn ${e.connectorKey ?? "—"} · model ${e.model || "(mặc định của nguồn)"} · dự phòng ${e.fallbackConnectorKey ? `${e.fallbackConnectorKey}${e.fallbackModel ? ` / ${e.fallbackModel}` : ""}` : "KHÔNG"}`;
}

/** `MISSING` chưa lưu · `UNREADABLE` ô lưu không đọc được (JSON hỏng / không phải đối tượng) · `INVALID` sai lược đồ · `OK`. */
export type RunningEngineState = "MISSING" | "UNREADABLE" | "INVALID" | "OK";
export type RunningEngine = { state: RunningEngineState; enabled: boolean; connectorKey: SalesBotConnector; model: string; fallback: { connectorKey: SalesBotConnector; model: string } | null; issues: string | null };

/**
 * Động cơ ĐANG CHẠY = ĐÚNG phép đọc của bot: `readJsonSetting` (chuỗi JSON; rỗng / hỏng ⇒ `null`) rồi `parseSalesChatbotConfig` (mặc
 * định + zod; sai lược đồ ⇒ MẶC ĐỊNH với bot TẮT — hỏng về phía đóng). Dự phòng = `effectiveFallback` (công tắc tắt / trùng nguồn
 * chính ⇒ không có). `issues` chỉ để in ở phần MÃ HOÁ (thông điệp zod có thể mang giá trị của shop).
 */
export function runningEngineOf(value: unknown): RunningEngine {
  const missing = value === null || value === undefined || value === "";
  let raw: unknown = null;
  let unreadable = false;
  if (!missing) {
    if (typeof value === "string") {
      try {
        raw = JSON.parse(value) as unknown;
      } catch {
        unreadable = true;
      }
    } else raw = value;
  }
  const cfg = parseSalesChatbotConfig(unreadable ? null : raw);
  let state: RunningEngineState = missing ? "MISSING" : unreadable || !raw || typeof raw !== "object" || Array.isArray(raw) ? "UNREADABLE" : "OK";
  let issues: string | null = null;
  if (state === "OK") {
    const check = salesChatbotConfigZ.safeParse({ ...DEFAULT_SALES_CHATBOT_CONFIG, ...(raw as Record<string, unknown>) });
    if (!check.success) {
      state = "INVALID";
      issues = check.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.map(String).join(".") || "cấu hình"}: ${i.message}`)
        .join(" · ");
    }
  }
  return { state, enabled: cfg.enabled, connectorKey: cfg.connectorKey, model: cfg.model, fallback: effectiveFallback(cfg), issues };
}

export function runningEngineText(r: RunningEngine): string {
  const fb = r.fallback ? `${r.fallback.connectorKey}${r.fallback.model ? ` / ${r.fallback.model}` : ""}` : "KHÔNG";
  const why =
    r.state === "MISSING"
      ? " — chưa lưu cấu hình ⇒ mặc định, bot TẮT"
      : r.state === "UNREADABLE"
        ? " — ô lưu không đọc được (JSON hỏng / không phải đối tượng) ⇒ mặc định, bot TẮT"
        : r.state === "INVALID"
          ? " — cấu hình SAI LƯỢC ĐỒ ⇒ bot chạy MẶC ĐỊNH và bị TẮT (lỗi trong phần mã hoá)"
          : "";
  return `bot ${r.enabled ? "BẬT" : "TẮT"} · nguồn ${r.connectorKey} · model ${r.model || "(mặc định của nguồn)"} · dự phòng hiệu lực ${fb}${why}`;
}

/** AI Bán hàng có đang dùng kết nối `key` không — theo động cơ ĐANG CHẠY: nguồn chính, hay dự phòng HIỆU LỰC. */
export function salesConnectorUse(r: RunningEngine, key: string): "PRIMARY" | "FALLBACK" | null {
  if (r.connectorKey === key) return "PRIMARY";
  if (r.fallback?.connectorKey === key) return "FALLBACK";
  return null;
}

/** Số ngày còn lại của tháng theo giờ VN, tính cả hôm nay (≥ 1) — khung của credit tháng (`monthStartVN`). */
export function daysLeftInMonthVN(now: Date): number {
  const vn = new Date(now.getTime() + 7 * 3_600_000);
  const end = Date.UTC(vn.getUTCFullYear(), vn.getUTCMonth() + 1, 1);
  return Math.max(1, Math.ceil((end - vn.getTime()) / 86_400_000));
}

const usd2 = (v: number) => Math.round(v * 100) / 100;

/** Một dòng của `aiUsageDaily` (ngày VN × nguồn × tính năng × model) — chỉ các ô phép tính cần. */
export type SalesUsageRow = { day: string; feature: string; turns: number; costUsd: number | null; unknownCost: number; model?: string | null; inputTokens?: number; outputTokens?: number };
/**
 * Chi phí AI Bán hàng của MỘT ngày VN, mọi nguồn tiền. `usd` = tổng lượt ĐÃ định giá; `null` = có lượt mà không lượt nào định giá được
 * (CHƯA BIẾT — luật 42); ngày không có dòng sổ nào = 0 lượt, 0 USD THẬT (mọi lượt AI đều ghi sổ). `unpriced` = lượt chưa định giá.
 */
export type DayCost = { day: string; usd: number | null; turns: number; unpriced: number };

/** Gom `aiUsageDaily` thành chuỗi theo ngày VN của AI Bán hàng, đủ `days` ngày tới HÔM NAY (cũ → mới). Tính năng khác bị bỏ. */
export function salesDailySeries(rows: readonly SalesUsageRow[], now: Date, days = 31): DayCost[] {
  const acc = new Map<string, { usd: number | null; turns: number; unpriced: number }>();
  for (let i = days - 1; i >= 0; i -= 1) acc.set(vnDayKey(new Date(now.getTime() - i * DAY_MS)), { usd: null, turns: 0, unpriced: 0 });
  for (const r of rows) {
    if (!(SALES_FEATURES as readonly string[]).includes(r.feature)) continue;
    const d = acc.get(r.day);
    if (!d) continue;
    d.turns += r.turns;
    d.unpriced += r.unknownCost;
    if (r.costUsd !== null && Number.isFinite(r.costUsd)) d.usd = (d.usd ?? 0) + r.costUsd;
  }
  return [...acc].map(([day, d]) => ({ day, usd: d.usd !== null ? d.usd : d.turns === 0 ? 0 : null, turns: d.turns, unpriced: d.unpriced }));
}

export type MonthlyBasis = { fromMonth: number | null; from7d: number | null; fromDay: number | null; monthly: number | null; daily: number | null };

/** Cơ sở tháng = LỚN NHẤT của (tổng 30 ngày · tổng 7 ngày × 30/7 · ngày trọn gần nhất × 30); cơ sở ngày = cơ sở tháng / 30. Không vế nào đo được ⇒ `null`. */
export function monthlyBasis(c: { total30d: number | null; total7d: number | null; lastDayUsd: number | null }): MonthlyBasis {
  const fromMonth = c.total30d === null ? null : usd2(c.total30d);
  const from7d = c.total7d === null ? null : usd2((c.total7d * 30) / 7);
  const fromDay = c.lastDayUsd === null ? null : usd2(c.lastDayUsd * 30);
  const known = [fromMonth, from7d, fromDay].filter((v): v is number => v !== null);
  const monthly = known.length ? Math.max(...known) : null;
  return { fromMonth, from7d, fromDay, monthly, daily: monthly === null ? null : usd2(monthly / 30) };
}

export type SpendBasis = MonthlyBasis & { today: string; lastFullDay: string; days7: string[]; total30d: number | null; total7d: number | null; lastDayUsd: number | null; turns7d: number; unpriced7d: number; unpriced30d: number };

/**
 * Ba vế của cơ sở chi trên chuỗi theo ngày (TIÊM VÀO — hàm thuần). Chỉ NGÀY TRỌN: 30 / 7 ngày VN tính lùi từ hôm qua; hôm nay chưa
 * xong không vào vế nào. Một cửa sổ không có lượt nào định giá được ⇒ vế đó `null` (không đo được — KHÔNG phải 0).
 */
export function spendBasis(series: readonly DayCost[], now: Date): SpendBasis {
  const byDay = new Map(series.map((d) => [d.day, d]));
  const k30 = Array.from({ length: 30 }, (_, i) => vnDayKey(new Date(now.getTime() - (i + 1) * DAY_MS)));
  const pick = (ks: readonly string[]) => ks.map((k) => byDay.get(k) ?? { day: k, usd: 0, turns: 0, unpriced: 0 });
  const sum = (ds: readonly DayCost[]): number | null => (ds.some((d) => d.usd !== null && d.turns > 0) ? usd2(ds.reduce((s, d) => s + (d.usd ?? 0), 0)) : null);
  const d30 = pick(k30);
  const d7 = d30.slice(0, 7);
  const total30d = sum(d30);
  const total7d = sum(d7);
  const lastDayUsd = sum(d7.slice(0, 1));
  return {
    today: vnDayKey(now),
    lastFullDay: k30[0],
    days7: k30.slice(0, 7).reverse(),
    total30d,
    total7d,
    lastDayUsd,
    ...monthlyBasis({ total30d, total7d, lastDayUsd }),
    turns7d: d7.reduce((s, d) => s + d.turns, 0),
    unpriced7d: d7.reduce((s, d) => s + d.unpriced, 0),
    unpriced30d: d30.reduce((s, d) => s + d.unpriced, 0),
  };
}

/** Dòng in phần MÃ HOÁ: chuỗi 7 ngày trọn + hôm nay (không vào cơ sở) + ba cơ sở. */
export function spendLines(series: readonly DayCost[], b: SpendBasis): string[] {
  const f = (v: number | null) => (v === null ? "—" : v.toFixed(2));
  const byDay = new Map(series.map((d) => [d.day, d]));
  const dayLine = (k: string, tail: string) => {
    const d = byDay.get(k);
    return `  ${k}${tail}: ${f(d ? d.usd : 0)} USD · ${d?.turns ?? 0} lượt${d?.unpriced ? ` (+${d.unpriced} chưa định giá, không cộng)` : ""}`;
  };
  return [
    `Chi phí AI Bán hàng theo ngày VN (mọi nguồn tiền, chỉ lượt ĐÃ định giá) — 7 ngày trọn tới ${b.lastFullDay}:`,
    ...b.days7.map((k) => dayLine(k, "")),
    dayLine(b.today, " (hôm nay, CHƯA trọn — không vào cơ sở)"),
    `Ba cơ sở tháng: 30 ngày trọn ${f(b.total30d)} · 7 ngày ${f(b.total7d)} × 30/7 = ${f(b.from7d)} · ngày ${b.lastFullDay} ${f(b.lastDayUsd)} × 30 = ${f(b.fromDay)} ⇒ cơ sở tháng ${f(b.monthly)} USD (lớn nhất) · cơ sở ngày ${f(b.daily)} USD · lượt chưa định giá (không cộng): 7 ngày ${b.unpriced7d} · 30 ngày ${b.unpriced30d}`,
    ...(b.monthly === null ? ["Cơ sở: CHƯA ĐO ĐƯỢC — 30 ngày trọn không có lượt AI Bán hàng nào định giá được ⇒ không kết luận đủ credit"] : []),
  ];
}

export type CreditLimits = { platformCreditUsdPerMonth: number; softOnly?: boolean; costUsdPerMonth?: { hard: number | null } };

/**
 * MÃ LÝ DO khi credit KHÔNG đủ — đi ra dòng tóm tắt công khai (không kèm số tiền) để người vận hành biết SỬA CHỖ NÀO mà không cần giải
 * phần mã hoá. Sinh ở ĐÚNG nhánh của `creditVerdict` (không phân tích câu `reason`):
 *  · `PLAN_UNREADABLE` không đọc được gói · `NO_PLATFORM_CREDIT` credit 0 ⇒ AI dùng chung không mở;
 *  · `BASIS_UNMEASURED` chưa đo được cơ sở chi — nâng credit KHÔNG giải quyết (sửa bảng giá / đợi dữ liệu; chi tiết ở `EffectiveBasis.cause`);
 *  · `MONTH_EXHAUSTED` tháng này đã DÙNG chạm trần nguồn PLATFORM;
 *  · `COST_HARD_BELOW_NEED` trần TIỀN tháng (costUsdHard) tự nó thấp hơn mức cần ⇒ `--credit` không sửa được, phải nâng ở /platform/org/<mã>;
 *  · `CREDIT_BELOW_NEED` credit (đề xuất / đang áp) thấp hơn mức tối thiểu.
 */
export type CreditRefusalCode = "PLAN_UNREADABLE" | "NO_PLATFORM_CREDIT" | "BASIS_UNMEASURED" | "MONTH_EXHAUSTED" | "COST_HARD_BELOW_NEED" | "CREDIT_BELOW_NEED";
export type CreditVerdict = { ok: true; reason: string; code: null } | { ok: false; reason: string; code: CreditRefusalCode };

/**
 * Credit AI dùng chung có đủ cho AI Bán hàng không, trên CƠ SỞ THÁNG theo nhịp chi gần đây (`spendBasis().monthly`). Credit 0 ⇒ KHÔNG
 * (AI dùng chung không mở cho tổ chức — `platformChatAi` — kể cả ngân sách mềm). Trần THẬT của nguồn PLATFORM y như `evaluateAiQuota`:
 * ngân sách mềm (`softOnly`) ⇒ chỉ trần tiền tháng nếu có khai (không có ⇒ ĐỦ, vượt chỉ cảnh báo); trần cứng ⇒ min(trần tiền, credit).
 * Có trần ⇒ HAI điều: trần ≥ cơ sở tháng × biên, VÀ (trần − đã dùng PLATFORM tháng này) ≥ cơ sở ngày × số ngày còn lại × biên.
 * Chưa đo được (null) ⇒ không kết luận ⇒ KHÔNG đủ (không chuyển mù). Ước tính theo giá model đang chạy — model của nền tảng rẻ / đắt
 * hơn thì lệch; biên an toàn gánh phần ấy.
 */
export function creditVerdict(limits: CreditLimits | null, monthlyBasisUsd: number | null, monthUsedUsd = 0, daysLeftInMonth = 30): CreditVerdict {
  if (!limits) return { ok: false, code: "PLAN_UNREADABLE", reason: "không đọc được gói của tổ chức" };
  const credit = limits.platformCreditUsdPerMonth;
  if (!(credit > 0)) return { ok: false, code: "NO_PLATFORM_CREDIT", reason: "gói không có credit AI dùng chung (0 USD) — AI dùng chung không mở cho tổ chức, bot sẽ không chạy" };
  const costHard = limits.costUsdPerMonth?.hard ?? null;
  const ceiling = limits.softOnly ? costHard : costHard === null ? credit : Math.min(costHard, credit);
  if (ceiling === null) return { ok: true, code: null, reason: `ngân sách mềm ${credit} USD/tháng — vượt chỉ cảnh báo, không chặn bot` };
  const what = ceiling < credit ? `trần tiền tháng ${ceiling} USD (ô costUsdHard — thấp hơn credit ${credit})` : `trần cứng ${ceiling} USD/tháng`;
  if (monthlyBasisUsd === null) return { ok: false, code: "BASIS_UNMEASURED", reason: `${what} mà chưa đo được nhịp chi AI Bán hàng (30 ngày trọn không lượt nào định giá được) — không chuyển mù` };
  const needMonth = usd2(monthlyBasisUsd * CREDIT_MARGIN);
  const needRest = usd2((monthlyBasisUsd / 30) * daysLeftInMonth * CREDIT_MARGIN);
  const left = usd2(ceiling - monthUsedUsd);
  // Trần TIỀN tháng TỰ NÓ có qua được cùng hai vế không: không ⇒ nâng credit bằng --credit cũng vô ích (mã COST_HARD_BELOW_NEED).
  const costRoom = costHard === null ? null : usd2(costHard - monthUsedUsd);
  const costHardShort = costHard !== null && costRoom !== null && (costRoom <= 0 || costHard < needMonth || costRoom < needRest);
  const shortCode: CreditRefusalCode = costHardShort ? "COST_HARD_BELOW_NEED" : "CREDIT_BELOW_NEED";
  const fix = "đặt credit đủ bằng --apply --credit=<USD> (hoặc ghi đè AI ở /platform/org/<mã>), hoặc chuyển ngân sách mềm trước";
  // Không còn gì: trần TIỀN tháng (costUsdHard) đang chặn ⇒ COST_HARD_BELOW_NEED (nâng credit vô ích, review #694 — credit 500 · costHard 50
  // · đã dùng 60); «hết tháng» chỉ khi CREDIT là trần đã dùng chạm (nâng credit là đúng việc); trần 0 mà chưa dùng gì là trần quá thấp.
  const exhaustedCode: CreditRefusalCode = costHardShort ? "COST_HARD_BELOW_NEED" : monthUsedUsd > 0 ? "MONTH_EXHAUSTED" : "CREDIT_BELOW_NEED";
  if (left <= 0) return { ok: false, code: exhaustedCode, reason: `${what}: tháng này không còn gì (đã dùng ${usd2(monthUsedUsd)}) — bot bị chặn ngay; ${fix}` };
  if (ceiling < needMonth) return { ok: false, code: shortCode, reason: `${what} < ${needMonth} USD (cơ sở tháng ${monthlyBasisUsd} × ${CREDIT_MARGIN}) — bot sẽ im giữa tháng; ${fix}` };
  if (left < needRest) return { ok: false, code: shortCode, reason: `tháng này còn ${left} USD (đã dùng ${usd2(monthUsedUsd)}) < ${needRest} USD cho ${daysLeftInMonth} ngày còn lại — bot sẽ im trước cuối tháng; ${fix}` };
  return { ok: true, code: null, reason: `${what} ≥ ${needMonth} USD (cơ sở tháng ${monthlyBasisUsd} × ${CREDIT_MARGIN}); tháng này còn ${left} USD ≥ ${needRest} USD cho ${daysLeftInMonth} ngày còn lại` };
}

/** Tỷ lệ lượt chưa định giá trong 7 ngày trọn mà quá ngưỡng này thì cơ sở chi không đáng tin ⇒ KHÔNG kết luận đủ. */
export const UNPRICED_SHARE_MAX = 0.2;

/** Model AI dùng chung mà một lượt AI Bán hàng CÓ THỂ chạy sau khi chuyển — mọi loại việc × mọi nhánh của chính sách (chính · đối chứng · dự phòng) + model nền. HÀM THUẦN, đi qua ĐÚNG `routePlatformModel`. */
export function platformCandidateModels(set: PlatformAiPolicySet, baseModel: string, provider: Parameters<typeof routePlatformModel>[0]["provider"], now: Date, priced: (model: string) => boolean): string[] {
  const out = new Set<string>([baseModel]);
  for (const w of [null, ...PLATFORM_WORKLOADS]) {
    const { policy } = policyForWorkload(set, w);
    const priors: string[][] = [[], ...(policy ? [[policy.primaryModel], [policy.fallbackModel ?? baseModel], [baseModel]] : [])];
    for (const prior of priors) {
      const r = routePlatformModel({ baseModel, provider, policy, now, routingKey: "org-ai-cutover", priced, prior });
      out.add(r.model);
      if (r.fallbackModel) out.add(r.fallbackModel);
    }
  }
  return [...out].sort();
}

/** Vì sao chưa cân được giá — cho MÃ LÝ DO công khai (`refusalTag`); `model` = TÊN model chưa có giá (chỗ phải sửa bảng giá). */
export type PriceRatioCause = "NO_TOKENS" | "NO_PLATFORM_MODEL" | "UNPRICED_CURRENT_MODEL" | "UNPRICED_PLATFORM_MODEL" | "ZERO_COST";
export type PriceRatio = { ratio: number | null; reason: string; cause?: PriceRatioCause | null; model?: string | null };

/**
 * Cơ sở chi đo bằng model ĐANG CHẠY; sau khi chuyển, lượt chạy model của NỀN TẢNG (có thể đắt hơn hàng chục lần). Tỷ lệ = max(1, max
 * qua mọi model nền tảng của (giá nền tảng / giá hiện tại)) trên HỖN HỢP TOKEN vào / ra THẬT của AI Bán hàng 30 ngày trọn. Thiếu giá
 * một bên, hay không có token để cân ⇒ `null` (chưa đo được). HÀM THUẦN, giá tiêm vào.
 */
export function platformPriceRatio(rows: readonly SalesUsageRow[], now: Date, platformModels: readonly string[], price: (model: string) => { input: number; output: number } | null): PriceRatio {
  const days = new Set(Array.from({ length: 30 }, (_, i) => vnDayKey(new Date(now.getTime() - (i + 1) * DAY_MS))));
  const mix = new Map<string, { inT: number; outT: number }>();
  for (const r of rows) {
    if (!(SALES_FEATURES as readonly string[]).includes(r.feature) || !days.has(r.day)) continue;
    const inT = r.inputTokens ?? 0;
    const outT = r.outputTokens ?? 0;
    if (inT + outT <= 0) continue;
    const k = r.model ?? "";
    const m = mix.get(k) ?? { inT: 0, outT: 0 };
    m.inT += inT;
    m.outT += outT;
    mix.set(k, m);
  }
  if (!mix.size) return { ratio: null, cause: "NO_TOKENS", reason: "không có token AI Bán hàng trong 30 ngày trọn để cân giá" };
  if (!platformModels.length) return { ratio: null, cause: "NO_PLATFORM_MODEL", reason: "không biết model AI dùng chung (khoá nền tảng chưa sẵn sàng)" };
  let current = 0;
  let inT = 0;
  let outT = 0;
  for (const [model, m] of mix) {
    const p = model ? price(model) : null;
    if (!p) return { ratio: null, cause: "UNPRICED_CURRENT_MODEL", model: model || null, reason: `model đang chạy «${model || "(không tên)"}» chưa có trong bảng giá` };
    current += (m.inT * p.input + m.outT * p.output) / 1e6;
    inT += m.inT;
    outT += m.outT;
  }
  if (!(current > 0)) return { ratio: null, cause: "ZERO_COST", reason: "chi phí hiện tại theo bảng giá bằng 0 — không cân được" };
  let worst = 1;
  const parts: string[] = [];
  for (const model of platformModels) {
    const p = price(model);
    if (!p) return { ratio: null, cause: "UNPRICED_PLATFORM_MODEL", model, reason: `model AI dùng chung «${model}» chưa có trong bảng giá` };
    const r = (inT * p.input + outT * p.output) / 1e6 / current;
    parts.push(`${model} × ${r.toFixed(2)}`);
    worst = Math.max(worst, r);
  }
  return { ratio: Math.round(worst * 1000) / 1000, reason: `giá model AI dùng chung / model đang chạy trên hỗn hợp token 30 ngày: ${parts.join(" · ")} ⇒ nhân cơ sở × ${(Math.round(worst * 1000) / 1000).toFixed(3)} (không dưới 1)` };
}

/** Vì sao cơ sở dùng để phán quyết là `null`: chưa có lượt định giá được · lượt chưa định giá quá ngưỡng · chưa cân được giá nền tảng. */
export type BasisCause = "NO_SPEND" | "UNPRICED_SHARE" | "PRICE_UNKNOWN";
/**
 * `unpricedPct` = % lượt chưa định giá trong 7 ngày trọn (tỷ lệ ĐẾM, không phải tiền — được ra log công khai; 1 chữ số thập phân để
 * 20,4% không in thành «20% > 20%»); `null` khi 7 ngày không có lượt. `priceCause` / `priceModel` chép từ `PriceRatio` khi giá là nguyên nhân.
 */
export type EffectiveBasis = { monthly: number | null; unpricedNote: boolean; reason: string; cause: BasisCause | null; unpricedPct: number | null; priceCause: PriceRatioCause | null; priceModel: string | null };

/** Cơ sở tháng DÙNG ĐỂ PHÁN QUYẾT = cơ sở đo × tỷ lệ giá nền tảng; chưa đo / tỷ lệ chưa biết / lượt chưa định giá 7 ngày > 20% ⇒ `null`. */
export function effectiveBasis(b: Pick<SpendBasis, "monthly" | "turns7d" | "unpriced7d">, ratio: PriceRatio): EffectiveBasis {
  const unpricedNote = b.unpriced7d > 0;
  const unpricedPct = b.turns7d > 0 ? Math.round((b.unpriced7d / b.turns7d) * 1000) / 10 : null;
  const base = { unpricedNote, unpricedPct, priceCause: null, priceModel: null };
  if (b.monthly === null) return { ...base, monthly: null, cause: "NO_SPEND", reason: "chưa đo được nhịp chi" };
  if (b.turns7d > 0 && b.unpriced7d / b.turns7d > UNPRICED_SHARE_MAX) return { ...base, monthly: null, cause: "UNPRICED_SHARE", reason: `lượt chưa định giá 7 ngày ${b.unpriced7d}/${b.turns7d} > ${UNPRICED_SHARE_MAX * 100}% — cơ sở không đáng tin` };
  if (ratio.ratio === null) return { ...base, monthly: null, cause: "PRICE_UNKNOWN", priceCause: ratio.cause ?? null, priceModel: ratio.model ?? null, reason: `chưa cân được giá model AI dùng chung: ${ratio.reason}` };
  return { ...base, monthly: usd2(b.monthly * ratio.ratio), cause: null, reason: `cơ sở tháng ${b.monthly} × ${ratio.ratio} = ${usd2(b.monthly * ratio.ratio)} USD` };
}

/** Tên model có lượt AI Bán hàng CHƯA định giá trong 7 ngày trọn — chỗ phải bổ sung bảng giá. Không tên ⇒ «(không tên)». HÀM THUẦN. */
export function unpricedSalesModels(rows: readonly SalesUsageRow[], now: Date): string[] {
  const days = new Set(Array.from({ length: 7 }, (_, i) => vnDayKey(new Date(now.getTime() - (i + 1) * DAY_MS))));
  const out = new Set<string>();
  for (const r of rows) if ((SALES_FEATURES as readonly string[]).includes(r.feature) && days.has(r.day) && r.unknownCost > 0) out.add(r.model || "(không tên)");
  return [...out].sort();
}

/** Mảnh khoá API Google (`AIza…`) và chuỗi ngẫu nhiên dài ≥ 30 — MỘT bộ mẫu cho cả `redactKeyish` lẫn `publicModelName`. */
const GOOGLE_KEY_FRAGMENT_RE = /AIza[0-9A-Za-z_-]{6,}/g;
const LONG_RANDOM_RUN_RE = /[0-9A-Za-z_-]{30,}/g;

/**
 * Tên model đưa ra log CÔNG KHAI: chỉ dạng mã model (chữ, số, . _ - : /, ≤ 64 ký tự) — chuỗi lạ trong sổ AI không bao giờ lọt ra
 * nguyên văn. Ô model do NGƯỜI gõ: khoá dán nhầm (`AIza…`, `sk-…`, hay chuỗi ngẫu nhiên dài) sẽ thành «model chưa định giá» ⇒ cũng
 * «(tên lạ)», không bao giờ ra log của kho PUBLIC (review #694).
 */
export function publicModelName(m: string | null | undefined): string {
  if (!m) return "(không tên)";
  if (/AIza|^sk-/i.test(m) || m.search(GOOGLE_KEY_FRAGMENT_RE) >= 0 || m.search(LONG_RANDOM_RUN_RE) >= 0) return "(tên lạ)";
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/.test(m) ? m : "(tên lạ)";
}

/**
 * Phần MÃ LÝ DO của dòng tóm tắt công khai khi credit KHÔNG đủ: mã + việc phải làm, KHÔNG một con số tiền nào (chỉ tỷ lệ % lượt chưa
 * định giá, ngưỡng % và tên model). `minimumUsd` chỉ để quyết cờ TRONG / VƯỢT trần đường ops — số không bao giờ được in. Đủ ⇒ "".
 */
export function refusalTag(code: CreditRefusalCode | null, eb: EffectiveBasis, unpricedModels: readonly string[], minimumUsd: number | null): string {
  if (!code) return "";
  const pct = (v: number) => `${String(v).replace(".", ",")}%`;
  // Có lượt chưa định giá mà tỷ lệ làm tròn ra 0 ⇒ «<0,1%», không in «0%» (0% đọc như KHÔNG có lượt nào).
  const pctLuot = (v: number) => (v === 0 && eb.unpricedNote ? "<0,1%" : pct(v));
  const ten = [...new Set(unpricedModels.map(publicModelName))];
  const dsModel = ten.length ? ` · model có lượt chưa định giá: ${ten.slice(0, 3).join(", ")}${ten.length > 3 ? ", …" : ""}` : "";
  const chuaGia = eb.unpricedNote && eb.unpricedPct !== null ? ` · lượt chưa định giá 7 ngày ${pctLuot(eb.unpricedPct)}${dsModel}` : dsModel;
  let why: string;
  if (code === "PLAN_UNREADABLE") why = "không đọc được gói của tổ chức — kiểm /platform/org/<mã>";
  else if (code === "NO_PLATFORM_CREDIT") why = "gói không có credit AI dùng chung — chạy --apply --credit=<USD>";
  else if (code === "MONTH_EXHAUSTED") why = "tháng này đã dùng chạm trần nguồn PLATFORM — nâng credit (credit tối thiểu ở phần mã hoá đã gồm phần đã dùng)";
  else if (code === "COST_HARD_BELOW_NEED") why = "trần tiền tháng (costUsdHard) thấp hơn mức cần — --credit KHÔNG sửa được, nâng ô đó ở /platform/org/<mã>";
  else if (code === "CREDIT_BELOW_NEED")
    why = `credit thấp hơn mức tối thiểu — mức tối thiểu ${minimumUsd !== null && minimumUsd > SCRIPT_AI_CREDIT_MAX_USD ? "VƯỢT trần đường ops: đặt ở /platform/org/<mã>" : "TRONG trần đường ops: chạy lại --apply --credit=<mức tối thiểu ở phần mã hoá>"}`;
  else {
    const fix = "nâng credit KHÔNG giải quyết";
    if (eb.cause === "UNPRICED_SHARE") why = `chưa đo được cơ sở chi: lượt chưa định giá 7 ngày ${eb.unpricedPct === null ? "—" : pctLuot(eb.unpricedPct)} > ${pct(Math.round(UNPRICED_SHARE_MAX * 1000) / 10)} — bổ sung giá model vào bảng giá; ${fix}`;
    else if (eb.cause === "PRICE_UNKNOWN") {
      const p = eb.priceCause;
      const chiTiet =
        p === "UNPRICED_CURRENT_MODEL"
          ? `model đang chạy «${publicModelName(eb.priceModel)}» chưa có trong bảng giá`
          : p === "UNPRICED_PLATFORM_MODEL"
            ? `model AI dùng chung «${publicModelName(eb.priceModel)}» chưa có trong bảng giá`
            : p === "NO_PLATFORM_MODEL"
              ? "chưa biết model AI dùng chung (khoá nền tảng chưa sẵn sàng)"
              : p === "NO_TOKENS"
                ? "không có token AI Bán hàng 30 ngày trọn để cân giá"
                : p === "ZERO_COST"
                  ? "chi phí theo bảng giá bằng 0"
                  : "không rõ";
      why = `chưa cân được giá model AI dùng chung: ${chiTiet}; ${fix}`;
    } else why = `chưa đo được cơ sở chi (30 ngày trọn không lượt AI Bán hàng nào định giá được); ${fix}`;
    return ` · mã lý do ${code} (${why})${eb.cause === "UNPRICED_SHARE" ? dsModel : chuaGia}`;
  }
  return ` · mã lý do ${code} (${why})${chuaGia}`;
}

/** Credit TỐI THIỂU (USD nguyên, làm tròn LÊN) qua được cả hai vế của `creditVerdict` khi trần = credit. Chưa đo được ⇒ `null`. */
export function minimumCredit(monthlyBasisUsd: number | null, monthUsedUsd: number, daysLeftInMonth: number): number | null {
  if (monthlyBasisUsd === null) return null;
  const needMonth = monthlyBasisUsd * CREDIT_MARGIN;
  const needNow = monthUsedUsd + (monthlyBasisUsd / 30) * daysLeftInMonth * CREDIT_MARGIN;
  return Math.ceil(usd2(Math.max(needMonth, needNow)));
}

/** Dòng «credit tối thiểu đề xuất» (phần MÃ HOÁ) — nói luôn khi đường ops KHÔNG đủ (vượt trần ops, hay trần tiền tháng thấp hơn). */
export function creditFloorLine(min: number | null, monthUsedUsd: number, daysLeftInMonth: number, limits: CreditLimits | null): string {
  if (min === null) return "Credit tối thiểu đề xuất: — (chưa đo được nhịp chi AI Bán hàng)";
  const costHard = limits?.costUsdPerMonth?.hard ?? null;
  const tail =
    min > SCRIPT_AI_CREDIT_MAX_USD
      ? ` — VƯỢT trần đường ops (${SCRIPT_AI_CREDIT_MAX_USD} USD): đặt ở /platform/org/<mã>`
      : costHard !== null && !limits?.softOnly && costHard < min
        ? ` — trần tiền tháng (costUsdHard ${costHard} USD) THẤP hơn mức này: nâng ở /platform/org/<mã> trước (đường ops không đặt ô đó)`
        : ` — chạy: "<mã> --apply --credit=${min}"`;
  return `Credit tối thiểu đề xuất (${limits?.softOnly ? "ngân sách mềm — chỉ tham khảo, không chặn" : "trần cứng"}): ${min} USD/tháng = max(cơ sở tháng × ${CREDIT_MARGIN}; đã dùng PLATFORM tháng này ${usd2(monthUsedUsd)} + cơ sở ngày × ${daysLeftInMonth} ngày còn lại × ${CREDIT_MARGIN})${tail}`;
}

/** Hạn mức AI ĐANG ÁP của tổ chức (gói + ghi đè) — phần MÃ HOÁ. */
export function limitsLines(r: ResolvedAiLimits, control: Pick<OrgAiControl, "disabled" | "readError"> | null): string[] {
  if (!r) return ["Hạn mức AI đang áp: KHÔNG đọc được gói của tổ chức (lượt AI dùng chung sẽ bị từ chối)"];
  const l = r.limits;
  const so = (v: number | null) => (v === null ? "không giới hạn" : String(v));
  const tien = (v: number | null) => (v === null ? "không giới hạn" : `${v} USD`);
  const ghiDe = AI_LIMIT_OVERRIDE_KEYS.filter((k) => k in r.override).map((k) => `${k}=${r.override[k] ?? "không giới hạn"}`);
  return [
    `Hạn mức AI đang áp — gói ${r.planKey} (${r.planName})${r.fellBack ? " · gói lạ ⇒ theo gói mặc định" : ""}${r.undeclared ? " · gói CHƯA khai hạn mức AI" : ""}`,
    `  ghi đè của tổ chức: ${ghiDe.length ? ghiDe.join(" · ") : "không"} · công tắc AI của tổ chức: ${control ? (control.readError ? "KHÔNG đọc được (coi như TẮT)" : control.disabled ? "TẮT" : "BẬT") : "—"}`,
    `  lượt / ngày ${so(l.requestsPerDay)} · lượt / tháng ${so(l.requestsPerMonth)} — AI Bán hàng không tính vào trần lượt (sales_chatbot · sales_playbook): với nó chỉ trần TIỀN chặn`,
    `  trần tiền tháng: mềm ${tien(l.costUsdPerMonth.soft)} · cứng ${tien(l.costUsdPerMonth.hard)} · credit nền tảng ${l.platformCreditUsdPerMonth} USD/tháng · ${l.softOnly ? "softOnly — NGÂN SÁCH MỀM (vượt chỉ cảnh báo)" : "trần CỨNG cho nguồn PLATFORM = min(trần tiền cứng, credit)"}`,
  ];
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

export type CutoverArgs = { ok: true; code: string; mode: "AUDIT" | "APPLY" | "PROBE"; credit: number | null; since: Date | null } | { ok: false; error: string };

/** Ô arg ⇒ chế độ. Cờ lạ / lặp / sai cặp ⇒ lỗi cách dùng — không đoán ý (gõ nhầm `--credits` mà vẫn chạy `--apply` là chuyển mù). Thông điệp không lặp lại giá trị đã gõ. */
export function parseCutoverArgs(args: readonly string[]): CutoverArgs {
  const positional = args.filter((a) => !a.startsWith("--"));
  const flags = args.filter((a) => a.startsWith("--"));
  if (positional.length !== 1) return { ok: false, error: positional.length ? "chỉ nhận MỘT mã tổ chức" : "thiếu mã tổ chức" };
  const known = (f: string) => f === "--apply" || f === "--apply-probe" || f.startsWith("--credit=") || f.startsWith("--since=");
  if (flags.some((f) => !known(f))) return { ok: false, error: "cờ lạ — chỉ nhận --apply, --credit=<USD>, --apply-probe, --since=<ISO>" };
  if (new Set(flags.map((f) => f.split("=")[0])).size !== flags.length) return { ok: false, error: "mỗi cờ chỉ một lần" };
  const apply = flags.includes("--apply");
  const probe = flags.includes("--apply-probe");
  if (apply && probe) return { ok: false, error: "chọn MỘT: --apply hoặc --apply-probe" };
  const creditRaw = flags.find((f) => f.startsWith("--credit="))?.slice("--credit=".length);
  const sinceRaw = flags.find((f) => f.startsWith("--since="))?.slice("--since=".length);
  if (creditRaw !== undefined && !apply) return { ok: false, error: "--credit chỉ đi cùng --apply (đặt credit rồi chuyển trong CÙNG một lượt)" };
  if (sinceRaw !== undefined && !probe) return { ok: false, error: "--since chỉ đi cùng --apply-probe" };
  let credit: number | null = null;
  if (creditRaw !== undefined) {
    if (!/^\d{1,4}(?:\.\d{1,2})?$/.test(creditRaw)) return { ok: false, error: "--credit phải là số USD dạng 150 hoặc 117.5 (dấu chấm, tối đa 2 chữ số thập phân)" };
    credit = Number(creditRaw);
    if (!(credit > 0) || credit > SCRIPT_AI_CREDIT_MAX_USD) return { ok: false, error: `--credit phải > 0 và ≤ ${SCRIPT_AI_CREDIT_MAX_USD} USD / tháng (lớn hơn đặt ở /platform/org/<mã>)` };
  }
  let since: Date | null = null;
  if (sinceRaw !== undefined) {
    since = new Date(sinceRaw);
    if (!sinceRaw || Number.isNaN(since.getTime())) return { ok: false, error: "--since phải là mốc ISO, ví dụ 2026-10-08T04:00:00Z" };
  }
  return { ok: true, code: positional[0], mode: apply ? "APPLY" : probe ? "PROBE" : "AUDIT", credit, since };
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

// ─────────────────────────── CHUYỂN (thứ tự + hoàn — tiêm phụ thuộc để kiểm được) ───────────────────────────

/** Mọi thứ đụng CSDL / mạng của lượt `--apply`. Bản thật ở `realDeps()`; bài kiểm tiêm bản giả để đi hết các nhánh hoàn. */
export type CutoverDeps = {
  now: () => Date;
  platformReady: () => { ready: true } | { ready: false; reason: string };
  resolveLimits: (orgCode: string) => Promise<ResolvedAiLimits>;
  readControl: (orgCode: string) => Promise<OrgAiControl | null>;
  usageDaily: (orgCode: string, now: Date) => Promise<readonly SalesUsageRow[]>;
  platformMonthUsed: (orgCode: string, now: Date) => Promise<number>;
  /** Mọi model AI dùng chung mà lượt AI Bán hàng có thể chạy sau khi chuyển (`platformCandidateModels`); khoá chưa sẵn sàng ⇒ []. */
  platformModels: (now: Date) => Promise<string[]>;
  setCredit: (orgCode: string, value: number | null, reason: string) => Promise<OrgAiLimitScriptResult>;
  platformUsable: (orgCode: string) => Promise<{ ok: true } | { ok: false; reason: string }>;
  switchEngine: (orgCode: string) => Promise<{ ok: true; before: unknown; after: unknown } | { ok: false; error: string }>;
  runningConnector: (orgCode: string) => Promise<string | null>;
  auditSwitch: (orgCode: string, before: unknown, after: unknown, at: string) => Promise<void>;
};

type CreditChange = { previous: number | null; changed: boolean };

/** Đọc lại nguồn AI ĐANG CHẠY sau một bước hỏng: `PLATFORM` · `OTHER` (chắc chắn chưa ở AI dùng chung) · `UNKNOWN` (không đọc được). */
async function engineAfterFailure(orgCode: string, deps: CutoverDeps): Promise<"PLATFORM" | "OTHER" | "UNKNOWN"> {
  const c = await deps.runningConnector(orgCode).catch(() => null);
  return c === null ? "UNKNOWN" : c === "platform" ? "PLATFORM" : "OTHER";
}

/**
 * Hoàn credit về ghi đè CŨ (cũng qua lõi + nhật ký) — CHỈ khi đọc lại CHẮC CHẮN thấy bot chưa ở AI dùng chung. Bot đã (hay có thể
 * đã) ở đó — lỗi giữa chừng, hay chạy lại sau một lượt chuyển thành công — ⇒ GIỮ credit: credit thừa vô hại, hoàn credit khi bot
 * đang chạy bằng nó là làm bot im với khách thật.
 */
async function undoCredit(orgCode: string, credit: CreditChange | null, deps: CutoverDeps, why: string): Promise<number> {
  if (!credit) return 1;
  if (!credit.changed) {
    tomTat("KHÔNG CHUYỂN — credit không đổi ở lượt này nên không có gì để hoàn");
    return 1;
  }
  const engine = await engineAfterFailure(orgCode, deps);
  if (engine !== "OTHER") {
    tomTat(engine === "PLATFORM" ? "CẢNH BÁO: bot ĐANG ở AI dùng chung — GIỮ credit mới (hoàn là làm bot im); chi tiết trong phần mã hoá" : "CẢNH BÁO: không đọc lại được động cơ — GIỮ credit mới (phía an toàn: bot không im); kiểm tay ở /platform/org/<mã>");
    return 1;
  }
  let r: OrgAiLimitScriptResult;
  try {
    r = await deps.setCredit(orgCode, credit.previous, `Hoàn credit AI dùng chung về ghi đè cũ (ops org-ai-cutover): ${why}`);
  } catch (e) {
    r = { error: errorText(e) };
  }
  if ("error" in r) {
    console.log(`Hoàn credit: ${r.error}`);
    tomTat("KHÔNG CHUYỂN — và HOÀN CREDIT HỎNG: ghi đè credit mới còn nguyên, sửa tay ở /platform/org/<mã> (lý do trong phần mã hoá)");
    return 1;
  }
  const veTheoGoi = credit.previous === null;
  tomTat(`KHÔNG CHUYỂN — đã hoàn credit AI dùng chung về ${veTheoGoi ? "theo gói (bỏ ghi đè)" : "ghi đè cũ"} (nhật ký nền tảng nguồn SCRIPT)`);
  return 1;
}

/**
 * `--apply [--credit=<USD>]`. Thứ tự là hợp đồng: (1) khoá nền tảng sẵn sàng; (2) phán quyết credit trên credit ĐỀ XUẤT (hay credit
 * đang áp) theo nhịp chi — KHÔNG đủ ⇒ dừng, không ghi gì; (3) có `--credit` ⇒ đặt ghi đè qua lõi, đọc lại hạn mức ĐANG ÁP, kiểm lại;
 * (4) AI dùng chung dùng được cho tổ chức; (5) đổi động cơ qua lõi /platform/org. Hỏng ở (3)–(5) ⇒ hoàn credit (`undoCredit`) — trừ
 * khi bot đã / có thể đã ở AI dùng chung: khi đó GIỮ (credit thừa vô hại, bot im với khách thì không).
 */
export async function applyCutover(org: { code: string }, proposed: number | null, deps: CutoverDeps): Promise<number> {
  const ready = deps.platformReady();
  if (!ready.ready) {
    tomTat(`KHÔNG CHUYỂN: AI dùng chung chưa sẵn sàng — ${ready.reason}`);
    return 1;
  }
  const now = deps.now();
  const limits = await deps.resolveLimits(org.code);
  for (const l of limitsLines(limits, await deps.readControl(org.code))) console.log(`[trước] ${l}`);
  const rows = await deps.usageDaily(org.code, now);
  const series = salesDailySeries(rows, now);
  const basis = spendBasis(series, now);
  for (const l of spendLines(series, basis)) console.log(l);
  const ratio = platformPriceRatio(rows, now, await deps.platformModels(now), giaCuaModel);
  const eb = effectiveBasis(basis, ratio);
  console.log(`Giá AI dùng chung: ${ratio.reason}`);
  console.log(`Cơ sở dùng để phán quyết: ${eb.reason}`);
  const ghiChuChuaGia = eb.unpricedNote ? " (có lượt chưa định giá — cơ sở có thể thấp)" : "";
  const used = await deps.platformMonthUsed(org.code, now);
  const daysLeft = daysLeftInMonthVN(now);
  const candidate: CreditLimits | null = limits ? (proposed === null ? limits.limits : { ...limits.limits, platformCreditUsdPerMonth: proposed }) : null;
  const minimum = minimumCredit(eb.monthly, used, daysLeft);
  console.log(creditFloorLine(minimum, used, daysLeft, candidate));
  const verdict = creditVerdict(candidate, eb.monthly, used, daysLeft);
  console.log(`Credit${proposed === null ? "" : " ĐỀ XUẤT"}: ${verdict.reason}`);
  // Mã lý do (không số tiền) ra log công khai — người vận hành biết sửa chỗ nào mà không phải giải phần mã hoá.
  const unpricedModels = unpricedSalesModels(rows, now);
  if (!verdict.ok) {
    const maLyDo = refusalTag(verdict.code, eb, unpricedModels, minimum);
    if (proposed === null) tomTat(`KHÔNG CHUYỂN: credit AI dùng chung không đủ cho AI Bán hàng theo nhịp chi gần đây${ghiChuChuaGia} — chưa ghi gì (credit tối thiểu trong phần mã hoá; đặt bằng --apply --credit=<USD>)${maLyDo}`);
    else tomTat(`KHÔNG CHUYỂN: credit ĐỀ XUẤT không đủ cho AI Bán hàng theo nhịp chi gần đây${ghiChuChuaGia} — CHƯA GHI GÌ (chi tiết trong phần mã hoá)${maLyDo}`);
    return 1;
  }

  let credit: CreditChange | null = null;
  if (proposed !== null) {
    const set = await deps.setCredit(org.code, proposed, CREDIT_REASON);
    if ("error" in set) {
      console.log(`Đặt credit: ${set.error}`);
      tomTat("KHÔNG CHUYỂN: không đặt được credit AI dùng chung — chưa đổi gì (lý do trong phần mã hoá)");
      return 1;
    }
    credit = { previous: set.previous, changed: set.changed };
    tomTat(`Credit AI dùng chung: ${set.changed ? "ĐÃ ĐẶT ghi đè (nhật ký nền tảng nguồn SCRIPT)" : "ghi đè đã đúng mức đề xuất — không đổi"}`);
    // Đọc lại hạn mức ĐANG ÁP (đúng đường bot đọc) và kiểm lại: ghi đè chưa có hiệu lực ⇒ không chuyển.
    try {
      const after = await deps.resolveLimits(org.code);
      for (const l of limitsLines(after, await deps.readControl(org.code))) console.log(`[sau khi đặt credit] ${l}`);
      const again = creditVerdict(after?.limits ?? null, eb.monthly, used, daysLeft);
      console.log(`Kiểm lại trên hạn mức đang áp: ${again.reason}`);
      if (!again.ok) {
        tomTat(`KHÔNG CHUYỂN: hạn mức ĐANG ÁP sau khi đặt credit vẫn không đủ${refusalTag(again.code, eb, unpricedModels, minimum)}`);
        return undoCredit(org.code, credit, deps, "hạn mức đang áp sau khi đặt vẫn không đủ");
      }
    } catch (e) {
      console.log(`Đọc lại hạn mức: ${errorText(e)}`);
      tomTat("KHÔNG CHUYỂN: lỗi khi đọc lại hạn mức sau khi đặt credit (chi tiết trong phần mã hoá)");
      return undoCredit(org.code, credit, deps, "lỗi khi đọc lại / kiểm AI dùng chung");
    }
  }

  let usable: Awaited<ReturnType<CutoverDeps["platformUsable"]>>;
  try {
    usable = await deps.platformUsable(org.code);
  } catch (e) {
    console.log(`Kiểm AI dùng chung: ${errorText(e)}`);
    tomTat("KHÔNG CHUYỂN: lỗi khi kiểm AI dùng chung (chi tiết trong phần mã hoá)");
    return undoCredit(org.code, credit, deps, "lỗi khi đọc lại / kiểm AI dùng chung");
  }
  if (!usable.ok) {
    console.log(`AI dùng chung: ${usable.reason}`);
    tomTat(`KHÔNG CHUYỂN: AI dùng chung chưa dùng được cho ${org.code} (lý do trong phần mã hoá)`);
    return undoCredit(org.code, credit, deps, "AI dùng chung chưa dùng được cho tổ chức");
  }

  let r: Awaited<ReturnType<CutoverDeps["switchEngine"]>>;
  try {
    r = await deps.switchEngine(org.code);
  } catch (e) {
    // Lỗi GIỮA chừng: cấu hình có thể đã lưu rồi mới hỏng (nhật ký tổ chức) ⇒ đọc lại trước khi quyết có hoàn credit không.
    console.log(`Đổi động cơ ném lỗi: ${errorText(e)}`);
    const engine = await engineAfterFailure(org.code, deps);
    tomTat(`LỖI giữa lượt đổi động cơ (chi tiết trong phần mã hoá) — đọc lại: ${engine === "PLATFORM" ? "bot ĐÃ ở AI dùng chung" : engine === "OTHER" ? "động cơ vẫn là nguồn cũ" : "KHÔNG đọc lại được động cơ"}`);
    return undoCredit(org.code, credit, deps, "lượt đổi động cơ hỏng giữa chừng");
  }
  if (!r.ok) {
    console.log(`Đổi động cơ: ${r.error}`);
    tomTat("KHÔNG CHUYỂN: lõi /platform/org từ chối đổi động cơ (lý do trong phần mã hoá)");
    return undoCredit(org.code, credit, deps, "lõi /platform/org từ chối đổi động cơ");
  }
  const at = deps.now().toISOString();
  let rc = 0;
  try {
    await deps.auditSwitch(org.code, r.before, r.after, at);
  } catch (e) {
    console.log(`Nhật ký nền tảng của lượt chuyển: ${errorText(e)}`);
    tomTat("CẢNH BÁO: ĐÃ CHUYỂN nhưng KHÔNG ghi được nhật ký nền tảng của lượt chuyển (nhật ký tổ chức vẫn có)");
    rc = 1;
  }
  tomTat(`ĐÃ CHUYỂN ${org.code} lúc ${at} (mốc cutover): ${engineText(engineOf(r.before))} ⇒ ${engineText(engineOf(r.after))}`);
  tomTat(`Credit AI dùng chung: ĐỦ${ghiChuChuaGia}`);
  console.log(`Mốc cutover ${at} — hậu kiểm: "${org.code} --apply-probe --since=${at}"`);
  return rc;
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

// ─────────────────────────── SỐ PROJECT TỪ ErrorInfo — CHỈ khoá của NỀN TẢNG / NHÀ ───────────────────────────

/**
 * Biến môi trường DUY NHẤT mà phép dò đọc khoá: khoá của NỀN TẢNG và khoá Gemini của NHÀ, ở `.env` của máy chủ. Khoá BYOK của tổ chức
 * khách không bao giờ có ở đây (chỉ được giải và băm trong lib/connectors/service.ts) — phép dò gửi khoá sang API mà chủ khoá chưa
 * từng nhờ gọi, nên với khoá của khách đó là dùng khoá của người khác vào việc họ không giao (review #659).
 */
export const PROJECT_PROBE_KEY_ENVS = [
  { env: PLATFORM_AI_ENV.apiKey, label: "PLATFORM_AI_API_KEY" },
  { env: "GEMINI_API_KEY", label: "GEMINI_API_KEY (nhà)" },
] as const;

/**
 * API Google nhận API key mà project chỉ-dùng-Gemini thường CHƯA BẬT. Thân CỐ Ý rỗng / thiếu ô bắt buộc: API đang tắt ⇒ cổng Google từ
 * chối (403 + ErrorInfo) TRƯỚC khi đọc thân; API đang bật ⇒ 400 thiếu tham số / 200 rỗng — không một ký tự nào được dịch / phân tích /
 * nhận dạng, nên không phát sinh phí ở project của chủ khoá. API đang bật ⇒ sang API kế.
 */
export const PROJECT_PROBE_APIS = [
  { label: "Cloud Translation", url: "https://translation.googleapis.com/language/translate/v2", body: "{}" },
  { label: "Cloud Natural Language", url: "https://language.googleapis.com/v1/documents:analyzeSentiment", body: "{}" },
  { label: "Cloud Vision", url: "https://vision.googleapis.com/v1/images:annotate", body: '{"requests":[]}' },
] as const;

/** Trần thời gian của MỖI lượt gọi (cả lúc đọc thân) — lượt quá trần coi như không gọi được, sang API kế. */
export const PROJECT_PROBE_TIMEOUT_MS = 8_000;
/** Lý do ErrorInfo mà `metadata.consumer` là project SỞ HỮU khoá (khoá API không kèm `x-goog-user-project` thì consumer = project của khoá). */
export const PROJECT_ERROR_REASONS = ["SERVICE_DISABLED", "API_KEY_SERVICE_BLOCKED"] as const;
/** Khoá API Google: `AIza` + 35 ký tự. Khoá không đúng dạng (vd khoá Anthropic của PLATFORM_AI_PROVIDER=anthropic) KHÔNG được gửi sang Google. */
const GOOGLE_API_KEY_RE = /^AIza[0-9A-Za-z_-]{35}$/;
const CONSUMER_RE = /^projects\/(\d{6,20})$/;
/** Đường DỰ PHÒNG khi thân lỗi không có ErrorInfo: đúng câu mẫu của SERVICE_DISABLED, số 6–20 chữ số — không đọc số nào khác trong câu. */
const SERVICE_DISABLED_MESSAGE_RE = /\bAPI has not been used in project (\d{6,20}) before or it is disabled\b/;
const ERROR_INFO_TYPE = "type.googleapis.com/google.rpc.ErrorInfo";

/** Đối tượng `error` của thân lỗi Google (đã JSON.parse; vài API bọc trong mảng). Không phải đối tượng ⇒ `null`. */
function googleErrorOf(body: unknown): Record<string, unknown> | null {
  const b = Array.isArray(body) ? (body[0] as unknown) : body;
  if (!b || typeof b !== "object") return null;
  const e = (b as Record<string, unknown>).error;
  return e && typeof e === "object" && !Array.isArray(e) ? (e as Record<string, unknown>) : null;
}

/** `google.rpc.ErrorInfo` ĐẦU TIÊN trong `error.details[]` — chỉ hai ô cần. Không có ⇒ `null`. */
export function errorInfoOf(body: unknown): { reason: string | null; consumer: string | null } | null {
  const details = googleErrorOf(body)?.details;
  if (!Array.isArray(details)) return null;
  for (const d of details) {
    if (!d || typeof d !== "object" || (d as Record<string, unknown>)["@type"] !== ERROR_INFO_TYPE) continue;
    const x = d as { reason?: unknown; metadata?: unknown };
    const meta = x.metadata && typeof x.metadata === "object" ? (x.metadata as Record<string, unknown>) : {};
    return { reason: typeof x.reason === "string" ? x.reason : null, consumer: typeof meta.consumer === "string" ? meta.consumer : null };
  }
  return null;
}

export type ProjectFromError = { number: string; via: "ERROR_INFO" | "MESSAGE"; reason: string };

/**
 * Số project từ MỘT phản hồi lỗi của Google. Có ErrorInfo ⇒ CHỈ tin ErrorInfo: lý do thuộc `PROJECT_ERROR_REASONS` và `consumer` đúng dạng
 * `projects/<số>`; lý do khác / consumer lạ ⇒ `null` (KHÔNG đọc tới câu chữ). Không có ErrorInfo ⇒ đường dự phòng: HTTP 403 và câu
 * đúng mẫu SERVICE_DISABLED. Còn lại ⇒ `null`. HÀM THUẦN.
 */
export function projectFromGoogleError(status: number, body: unknown): ProjectFromError | null {
  if (status < 400) return null;
  const info = errorInfoOf(body);
  if (info) {
    if (!info.reason || !(PROJECT_ERROR_REASONS as readonly string[]).includes(info.reason)) return null;
    const m = CONSUMER_RE.exec(info.consumer ?? "");
    return m ? { number: m[1], via: "ERROR_INFO", reason: info.reason } : null;
  }
  if (status !== 403) return null;
  const msg = googleErrorOf(body)?.message;
  const m = typeof msg === "string" ? SERVICE_DISABLED_MESSAGE_RE.exec(msg) : null;
  return m ? { number: m[1], via: "MESSAGE", reason: "SERVICE_DISABLED" } : null;
}

/** Che mọi chuỗi giống khoá trong một câu TRƯỚC khi giữ lại: chính khoá đang dò, mọi khoá API Google, mọi chuỗi ngẫu nhiên dài ≥ 30. */
export function redactKeyish(text: string, key: string): string {
  const k = key.trim();
  const t = k ? text.split(k).join("•••") : text;
  return t.replace(GOOGLE_KEY_FRAGMENT_RE, "AIza•••").replace(LONG_RANDOM_RUN_RE, "•••");
}

export type KeyProjectProbe = { number: string | null; api: string | null; via: "ERROR_INFO" | "MESSAGE" | null; attempts: string[]; reason: string | null };
/** Đủ cho phép dò: `fetch` toàn cục khớp kiểu này; bài kiểm tiêm bản giả (không gọi mạng thật). */
export type ProbeFetcher = (url: string, init: RequestInit) => Promise<{ status: number; text: () => Promise<string> }>;

/**
 * Dò số project của MỘT khoá API Google bằng ErrorInfo (`PROJECT_PROBE_APIS` lần lượt). Khoá đi ở header `x-goog-api-key` (không ở
 * URL), không theo chuyển hướng, mỗi lượt có trần thời gian; khoá không bao giờ vào kết quả — câu chữ của Google qua `redactKeyish`
 * trước khi giữ. Khoá sai dạng ⇒ không gửi gì. API đang bật / lỗi không mang project ⇒ sang API kế; Google báo khoá hỏng ⇒ dừng (API
 * nào cũng sẽ trả như vậy). Hết danh sách ⇒ UNAVAILABLE — không đoán.
 */
export async function probeKeyProject(key: string, fetcher: ProbeFetcher = fetch): Promise<KeyProjectProbe> {
  const out: KeyProjectProbe = { number: null, api: null, via: null, attempts: [], reason: null };
  const k = key.trim();
  if (!GOOGLE_API_KEY_RE.test(k)) return { ...out, reason: "UNAVAILABLE — khoá không đúng dạng khoá API Google (AIza…): không gửi sang Google" };
  for (const api of PROJECT_PROBE_APIS) {
    let status: number;
    let raw = "";
    try {
      const r = await fetcher(api.url, { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": k }, body: api.body, redirect: "manual", signal: AbortSignal.timeout(PROJECT_PROBE_TIMEOUT_MS) });
      status = r.status;
      if (status >= 400) raw = (await r.text()).slice(0, 20_000);
    } catch (e) {
      out.attempts.push(`${api.label}: không gọi được (${e instanceof Error ? e.name : "lỗi"})`);
      continue;
    }
    if (status < 300) {
      out.attempts.push(`${api.label}: HTTP ${status} — API đang bật ở project này, sang API kế`);
      continue;
    }
    if (status < 400) {
      out.attempts.push(`${api.label}: HTTP ${status} — chuyển hướng, không theo`);
      continue;
    }
    let body: unknown = null;
    try {
      body = JSON.parse(raw) as unknown;
    } catch {
      body = null;
    }
    const p = projectFromGoogleError(status, body);
    if (p) {
      out.attempts.push(`${api.label}: HTTP ${status} · ${p.reason} (${p.via === "ERROR_INFO" ? "ErrorInfo" : "câu SERVICE_DISABLED đúng mẫu"})`);
      return { ...out, number: p.number, api: api.label, via: p.via };
    }
    const info = errorInfoOf(body);
    const msg = googleErrorOf(body)?.message;
    const trich = typeof msg === "string" && msg ? redactKeyish(msg, k).slice(0, 160) : "";
    out.attempts.push(`${api.label}: HTTP ${status} · ${info ? (info.reason ?? "ErrorInfo không lý do") : "không có ErrorInfo"} — không suy được${trich ? ` («${trich}»)` : ""}`);
    if (info?.reason === "API_KEY_INVALID") return { ...out, reason: "UNAVAILABLE — Google báo khoá không hợp lệ (API_KEY_INVALID)" };
  }
  return { ...out, reason: "UNAVAILABLE — không suy được (không API nào trả project)" };
}

/**
 * Dò số project cho ĐÚNG các khoá ở `PROJECT_PROBE_KEY_ENVS`, đọc qua `readEnv` — hàm này KHÔNG nhận khoá từ nơi gọi, nên không đường
 * nào đưa được khoá BYOK của khách vào phép dò. `skip(label)` ⇒ không dò (Lookup đã ra số). Hai biến cùng một khoá ⇒ dò MỘT lần.
 */
export async function probeServerKeyProjects(readEnv: (name: string) => string | undefined, probe: (key: string) => Promise<KeyProjectProbe>, skip: (label: string) => boolean = () => false): Promise<Record<string, KeyProjectProbe | null>> {
  const out: Record<string, KeyProjectProbe | null> = {};
  const daDo = new Map<string, Promise<KeyProjectProbe>>();
  for (const { env, label } of PROJECT_PROBE_KEY_ENVS) {
    const k = (readEnv(env) ?? "").trim();
    if (!k || skip(label)) {
      out[label] = null;
      continue;
    }
    let p = daDo.get(k);
    if (!p) {
      // Một lượt dò hỏng không được làm hỏng cả lượt KIỂM: ra UNAVAILABLE, câu lỗi chỉ mang TÊN lỗi (không bao giờ thông điệp — có thể mang khoá).
      p = probe(k).catch((e: unknown): KeyProjectProbe => ({ number: null, api: null, via: null, attempts: [], reason: `UNAVAILABLE — lỗi khi dò (${e instanceof Error ? e.name : "lỗi"})` }));
      daDo.set(k, p);
    }
    out[label] = await p;
  }
  return out;
}

/** Số project ở dạng CHE cho log công khai: 4 chữ số cuối + độ dài (ngắn dưới 8 chữ số ⇒ chỉ độ dài). Không phải chuỗi số ⇒ «project —». */
export function maskProjectNumber(n: string | null): string {
  if (!n || !/^\d+$/.test(n)) return "project —";
  return n.length >= 8 ? `project …${n.slice(-4)} (${n.length} chữ số)` : `project … (${n.length} chữ số)`;
}

/** Số project ĐÃ BIẾT của một khoá: Lookup (credential quản trị) trước, rồi dò ErrorInfo. */
export function resolvedProjectNumber(lookup: GcpProject | null, probe: KeyProjectProbe | null): string | null {
  return lookup?.number ?? probe?.number ?? null;
}

/**
 * Dòng in cho project của MỘT khoá ở `.env`: `priv` (phần MÃ HOÁ — số đầy đủ, API, từng lượt gọi đã che khoá) và `pub` (dòng tóm tắt
 * công khai — chỉ dạng CHE). Lookup ra số ⇒ giữ nguyên dòng «Lookup CÓ» như trước; dò ra số ⇒ dạng che + nguồn; không ra ⇒ UNAVAILABLE.
 */
export function projectReportLines(label: string, lookup: GcpProject | null, lookupReason: string | null, probe: KeyProjectProbe | null): { priv: string[]; pub: string } {
  const priv = [`Project của ${label}: ${lookup ? `số ${lookup.number ?? "—"} · id ${lookup.id ?? "—"} · tên ${lookup.name ?? "—"} · chủ ${lookup.owners ? lookup.owners.join(", ") || "(không có roles/owner)" : "—"}${lookup.reason ? ` · ${lookup.reason}` : ""}` : (lookupReason ?? "—")}`];
  if (probe) {
    const ketQua = probe.number ? `số ${probe.number} · qua ${probe.api ?? "—"} (${probe.via === "ERROR_INFO" ? "ErrorInfo" : "câu SERVICE_DISABLED đúng mẫu"})` : (probe.reason ?? "UNAVAILABLE");
    priv.push(`Project của ${label} — dò ErrorInfo của Google (không cần credential quản trị): ${ketQua}${probe.attempts.length ? ` · lượt gọi: ${probe.attempts.join(" · ")}` : ""}`);
  }
  if (lookup?.number) return { priv, pub: `Project ${label}: Lookup CÓ` };
  if (probe?.number) return { priv, pub: `Project ${label}: ${maskProjectNumber(probe.number)} — nguồn ErrorInfo của Google (không cần credential quản trị)` };
  return { priv, pub: `Project ${label}: Lookup ${lookup?.reason ?? lookupReason ?? "UNAVAILABLE"}${probe ? " · dò ErrorInfo: UNAVAILABLE — không suy được (chi tiết trong phần mã hoá)" : ""}` };
}

// ─────────────────────────── ĐỌC CHUNG ───────────────────────────

type Org = { code: string; name: string; isHome: boolean; status: string };

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

/** Model AI dùng chung có thể chạy cho AI Bán hàng lúc `now` — đúng cấu hình khoá + chính sách Platform AI Model Control đang lưu. */
async function platformModelsNow(now: Date): Promise<string[]> {
  const c = platformAiConfig();
  if (!c.ready) return [];
  return platformCandidateModels(await readPlatformAiPolicies({ fresh: true }), c.model, c.provider, now, (m) => giaCuaModel(m) !== null);
}

/** Phụ thuộc THẬT của `--apply`: lõi /platform/org (đổi động cơ), lõi hạn mức AI (credit, nguồn SCRIPT), sổ AI, khoá nền tảng. */
function realDeps(): CutoverDeps {
  let operator: { orgCode: string; email: string } | null = null;
  const operatorOf = async () => {
    if (!operator) operator = { orgCode: (await listOrganizations()).find((o) => o.isHome)?.code ?? "home", email: SCRIPT_LABEL };
    return operator;
  };
  return {
    now: () => new Date(),
    platformReady: () => {
      const c = platformAiConfig();
      return c.ready ? { ready: true } : { ready: false, reason: c.reason };
    },
    resolveLimits: (code) => resolveAiLimits(code),
    readControl: (code) => readOrgAiControl(code, { fresh: true }),
    usageDaily: (code, now) => aiUsageDaily(code, 31, now),
    platformMonthUsed: async (code, now) => (await sourceUsage(code, "PLATFORM", now)).costUsdMonth,
    platformModels: (now) => platformModelsNow(now),
    setCredit: async (code, value, reason) => setOrgAiLimitAsOperator({ orgCode: code, key: SCRIPT_AI_LIMIT_KEY, value, operator: await operatorOf(), reason }),
    platformUsable: async (code) => {
      const p = await platformChatAi(code);
      return p.ok ? { ok: true } : { ok: false, reason: p.reason };
    },
    switchEngine: async (code) => {
      const op = await operatorOf();
      return withOrganization(code, () => saveChatbotEngineAsOperator({ engine: { ...PLATFORM_ENGINE_PATCH }, operator: op, reason: CUTOVER_REASON }));
    },
    runningConnector: (code) => withOrganization(code, async () => (await loadSalesChatbotConfig()).connectorKey),
    auditSwitch: (code, before, after, at) => platformAudit({ action: "AI_ORG_CONTROL_SET", targetOrgCode: code, subject: "sales_chatbot.engine", before, after, reason: `${CUTOVER_REASON} · mốc ${at}`, source: "SCRIPT", actor: null }),
  };
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

  // `settings.value` là CHUỖI JSON: in cả ô ĐÃ LƯU (thô) lẫn động cơ ĐANG CHẠY (đúng phép đọc của bot — mặc định + lược đồ).
  const [setting] = await db.select({ value: schema.settings.value }).from(schema.settings).where(eq(schema.settings.key, SALES_CHATBOT_SETTING_KEY)).limit(1);
  const stored = engineOf(setting?.value);
  const storedNote = !setting?.value ? " — chưa lưu cấu hình" : storedSettingObject(setting.value) ? "" : " — ô lưu KHÔNG đọc được (JSON hỏng / không phải đối tượng)";
  tomTat(`Động cơ AI Bán hàng ĐÃ LƯU (ô thô): bot ${stored.enabled === null ? "—" : stored.enabled ? "BẬT" : "TẮT"} · ${engineText(stored)} · chuyển dự phòng ${stored.failoverEnabled === null ? "—" : stored.failoverEnabled ? "bật" : "tắt"}${storedNote}`);
  const running = runningEngineOf(setting?.value ?? null);
  tomTat(`Động cơ AI Bán hàng ĐANG CHẠY (mặc định + lược đồ của bot): ${runningEngineText(running)}`);
  if (running.issues) console.log(`Cấu hình bot sai lược đồ: ${running.issues}`);

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
  // Cùng MỘT danh sách với phép dò ErrorInfo (PROJECT_PROBE_KEY_ENVS): PLATFORM_AI_API_KEY ⇒ platformKey · GEMINI_API_KEY ⇒ homeGemini.
  const keys = PROJECT_PROBE_KEY_ENVS.map(({ env, label }) => [label, (process.env[env] ?? "").trim() || null] as const);
  const projects: Record<string, GcpProject | null> = {};
  for (const [label, key] of keys) projects[label] = key && token && token.ok ? await gcpLookup(key, token.token) : null;
  // Lookup không ra số ⇒ dò bằng ErrorInfo của Google. Hàm dò tự đọc khoá từ env theo PROJECT_PROBE_KEY_ENVS (khoá của nền tảng / nhà) —
  // không nhận khoá nào từ đây, nên khoá BYOK của khách không bao giờ tới được nó.
  const errorInfo = await probeServerKeyProjects((name) => process.env[name], probeKeyProject, (label) => Boolean(projects[label]?.number));
  const projectNo: Record<string, string | null> = {};
  for (const [label, key] of keys) {
    const probed = errorInfo[label] ?? null;
    projectNo[label] = resolvedProjectNumber(projects[label] ?? null, probed);
    if (!key) continue;
    // Project / chủ project là dữ liệu nhạy cảm ⇒ số ĐẦY ĐỦ chỉ trong phần MÃ HOÁ; dòng tóm tắt chỉ có / không, hay dạng CHE.
    const baoCao = projectReportLines(label, projects[label] ?? null, lookupReason, probed);
    for (const l of baoCao.priv) console.log(l);
    tomTat(baoCao.pub);
  }
  if (sa.ok) tomTat(`Credential quản trị Google: biến ${sa.env}`);
  tomTat(`Project ${org.code}/gemini-byok: UNAVAILABLE — Lookup cần chính khoá, mà khoá của tổ chức chỉ được giải trong lib/connectors/service.ts`);
  const P = projects["PLATFORM_AI_API_KEY"];
  tomTat(`Project nền tảng ↔ BYOK: ${compareProjects(projectNo["PLATFORM_AI_API_KEY"] ?? null, null)} · tài khoản Google nền tảng ↔ BYOK: ${compareAccounts(P?.owners ?? null, null)} · project nền tảng ↔ nhà: ${compareProjects(projectNo["PLATFORM_AI_API_KEY"] ?? null, projectNo["GEMINI_API_KEY (nhà)"] ?? null)}`);

  // Hạn mức AI ĐANG ÁP + credit theo NHỊP CHI GẦN ĐÂY — số liệu chỉ ở phần MÃ HOÁ; log công khai chỉ phán quyết.
  const now = new Date();
  const limits = await resolveAiLimits(org.code);
  for (const l of limitsLines(limits, await readOrgAiControl(org.code))) console.log(l);
  const rows = await aiUsageDaily(org.code, 31, now);
  const series = salesDailySeries(rows, now);
  const basis = spendBasis(series, now);
  for (const l of spendLines(series, basis)) console.log(l);
  const ratio = platformPriceRatio(rows, now, await platformModelsNow(now), giaCuaModel);
  const eb = effectiveBasis(basis, ratio);
  console.log(`Giá AI dùng chung: ${ratio.reason}`);
  console.log(`Cơ sở dùng để phán quyết: ${eb.reason}`);
  const monthUsed = (await sourceUsage(org.code, "PLATFORM", now)).costUsdMonth;
  const daysLeft = daysLeftInMonthVN(now);
  const minimum = minimumCredit(eb.monthly, monthUsed, daysLeft);
  console.log(creditFloorLine(minimum, monthUsed, daysLeft, limits?.limits ?? null));
  const verdict = creditVerdict(limits?.limits ?? null, eb.monthly, monthUsed, daysLeft);
  console.log(`Credit: ${verdict.reason}`);
  const kieuTran = limits ? (limits.limits.softOnly ? "ngân sách mềm" : "trần cứng") : "không đọc được gói";
  const ghiChuChuaGia = eb.unpricedNote ? " (có lượt chưa định giá — cơ sở có thể thấp)" : "";
  const maLyDo = refusalTag(verdict.code, eb, unpricedSalesModels(rows, now), minimum);
  tomTat(`Credit AI dùng chung đủ cho AI Bán hàng (theo nhịp chi gần đây, giá model AI dùng chung): ${verdict.ok ? "ĐỦ" : "KHÔNG"} (${kieuTran})${ghiChuChuaGia}${maLyDo}`);
  const goiYCredit = !verdict.ok && limits !== null && eb.monthly !== null;
  if (goiYCredit) tomTat("Muốn chuyển: --apply --credit=<USD> (credit tối thiểu đề xuất ở phần mã hoá)");
  const plat = await platformChatAi(org.code).catch((e: unknown) => ({ ok: false as const, reason: `không đọc được (${e instanceof Error ? e.name : "lỗi"})` }));
  if (!plat.ok) console.log(`AI dùng chung: ${plat.reason}`);
  tomTat(`AI dùng chung cho ${org.code} lúc này: ${plat.ok ? "DÙNG ĐƯỢC" : "KHÔNG (lý do trong phần mã hoá)"}`);

  // Ai còn dùng khoá riêng: AI Bán hàng theo động cơ ĐANG CHẠY; Media (ảnh / chữ) mở kết nối đầu tiên đang bật (OpenAI rồi Gemini);
  // Săn khách sỉ mở thẳng gemini-byok (lib/creative/org-ai.ts · lib/wholesale/outreach.ts).
  const active = (k: string) => conns.some((r) => r.connectorKey === k && r.status === "ACTIVE" && r.lastTestOk === true);
  const gemImage = byok?.imageModel ?? null;
  const use = salesConnectorUse(running, "gemini-byok");
  tomTat(`Ai dùng gemini-byok: AI Bán hàng ${use === "PRIMARY" ? "CÓ (nguồn chính đang chạy)" : use === "FALLBACK" ? "CÓ (dự phòng hiệu lực)" : "không"}${use && !running.enabled ? " — bot đang TẮT" : ""} · Media viết chữ ${active("openai-byok") ? "không (OpenAI đứng trước)" : active("gemini-byok") ? "CÓ" : "không (chưa bật)"} · Media vẽ ảnh ${active("openai-byok") ? "không (OpenAI đứng trước)" : active("gemini-byok") && typeof gemImage === "string" && gemImage ? "CÓ" : "không (chưa khai model vẽ ảnh)"} · Săn khách sỉ ${active("gemini-byok") ? "CÓ" : "không (chưa bật)"}`);

  const groups = await usageGroups(org.code, new Date(Date.now() - 30 * 86_400_000));
  for (const g of groups.slice(0, 60)) console.log(`Sổ AI 30 ngày · ${g.billingSource} · ${g.provider ?? "—"} · ${g.model ?? "—"} · ${g.feature}/${g.workload ?? "—"} · ${g.status}: ${g.n} dòng · ${g.costUsd === null ? "—" : g.costUsd.toFixed(4)} USD`);
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
  const a = parseCutoverArgs(ARGS);
  if (!a.ok) {
    tomTat(`Cách dùng sai: ${a.error} — arg: <mã tổ chức> [--apply [--credit=<USD>] | --apply-probe [--since=<ISO>]]`);
    return 64;
  }
  const org = await findOrganization(a.code);
  if (!org) {
    tomTat(`Không có tổ chức mã «${a.code}»`);
    return 64;
  }
  if (org.isHome) {
    tomTat("Tổ chức nhà dùng khoá của nhà (HOME) — không có gì để chuyển");
    return 64;
  }
  if (a.mode === "APPLY") return applyCutover(org, a.credit, realDeps());
  if (a.mode === "PROBE") return probe(org, a.since);
  return audit(org);
}

if (CHAY_THANG) {
  main()
    .then((rc) => process.exit(rc))
    .catch((e) => {
      // Câu lỗi có thể mang dữ liệu (câu SQL, số tiền) ⇒ chỉ ở phần MÃ HOÁ; log công khai chỉ biết là có lỗi.
      console.log(`LỖI: ${errorText(e)}`);
      tomTat("LỖI — chi tiết trong phần mã hoá");
      process.exit(1);
    });
}
