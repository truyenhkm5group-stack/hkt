/**
 * ═══════════ PLATFORM AI POLICY — MODEL CỦA AI DÙNG CHUNG KHÔNG CÒN GHI CỨNG (06/10/2026 · docs/platform/ai-model-control.md) ═══════════
 *
 * Trước tệp này, model của khoá nền tảng chỉ có MỘT nguồn: biến môi trường `PLATFORM_AI_MODEL` (trống ⇒
 * `PLATFORM_GEMINI_DEFAULT_MODEL`). Đổi model = sửa GitHub Variable + deploy, không chạy thử được trên một phần lưu lượng,
 * không có nút hoàn tác, và không có vết "ai đổi, vì sao".
 *
 * Chính sách (`platform_settings` · `platform.ai.policy`) là lớp NẰM TRÊN biến môi trường, không thay nó:
 *  · KHÔNG có chính sách / `enabled = false` / chưa tới `effectiveFrom` / chính sách hỏng hình ⇒ y hệt hành vi cũ: model
 *    của biến môi trường (`BASE`). Mọi nhánh lỗi rơi về phía CŨ ĐÃ CHẠY, không bao giờ về một model chưa ai kiểm.
 *  · Có chính sách ⇒ `canaryPct`% hội thoại (băm ỔN ĐỊNH theo khoá định tuyến — một hội thoại không nhảy model giữa hai tin)
 *    đi `primaryModel` với `fallbackModel` đỡ khi primary hỏng (`CANARY`); phần còn lại đi `fallbackModel` (`CONTROL`).
 *    `canaryPct = 100` là "Áp dụng".
 *  · Model không có giá trong bảng giá ⇒ không trừ được credit ⇒ chính sách bị BỎ QUA (về `BASE`), như `platformAiConfig`.
 *
 * Phần thuần (parse · băm · định tuyến) không đọc CSDL; `readPlatformAiPolicy` đọc qua bộ đệm 30 giây (đường nóng: mỗi tin
 * khách một lượt đọc), lỗi đọc ⇒ `null` ⇒ `BASE`. Ghi DUY NHẤT qua lõi người vận hành `lib/ai-usage/platform-ai-admin.ts`.
 */
import { and, eq, gte } from "drizzle-orm";
import { getPlatformDb, schema } from "@/db";
import { PLATFORM_AI_PROVIDERS, type PlatformAiProviderName } from "@/lib/ai-usage/platform-ai";

export const PLATFORM_AI_POLICY_KEY = "platform.ai.policy";
export const PLATFORM_AI_POLICY_TTL_MS = 30_000;
const MODEL_RE = /^[a-z0-9][a-z0-9.\-]{1,60}$/;

export type PlatformAiPolicyCore = {
  enabled: boolean;
  provider: PlatformAiProviderName;
  primaryModel: string;
  /** Model đỡ khi primary hỏng + model của phần lưu lượng NGOÀI canary. `null` ⇒ model của biến môi trường. */
  fallbackModel: string | null;
  /** 0–100, số nguyên. 100 = áp dụng toàn bộ. */
  canaryPct: number;
  effectiveFrom: string;
  reason: string;
  changedBy: string | null;
  changedAt: string;
  /**
   * Mốc bắt đầu COHORT của `primaryModel` — hội thoại mở từ mốc này mới vào phép so A/B. Tăng nấc (10 → 30 → 50 → 100) với
   * CÙNG primary giữ nguyên mốc; đổi primary thì mốc mới. Bản cũ không có ô này ⇒ dùng `effectiveFrom`.
   */
  cohortSince: string;
};
/** `previous` = bản ngay trước lượt đổi — nút Hoàn tác trả về đúng bản đó (một nấc; nhật ký nền tảng giữ cả lịch sử). */
export type PlatformAiPolicy = PlatformAiPolicyCore & { previous: PlatformAiPolicyCore | null };

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isoOrNull = (v: unknown) => (typeof v === "string" && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null);

function parseCore(raw: unknown): PlatformAiPolicyCore | null {
  if (!isRec(raw)) return null;
  const provider = typeof raw.provider === "string" ? raw.provider : "";
  if (!(PLATFORM_AI_PROVIDERS as readonly string[]).includes(provider)) return null;
  const primaryModel = typeof raw.primaryModel === "string" ? raw.primaryModel.trim() : "";
  if (!MODEL_RE.test(primaryModel)) return null;
  const fb = typeof raw.fallbackModel === "string" ? raw.fallbackModel.trim() : null;
  if (fb !== null && fb !== "" && !MODEL_RE.test(fb)) return null;
  const pct = raw.canaryPct;
  if (typeof pct !== "number" || !Number.isInteger(pct) || pct < 0 || pct > 100) return null;
  const effectiveFrom = isoOrNull(raw.effectiveFrom);
  const changedAt = isoOrNull(raw.changedAt);
  if (!effectiveFrom || !changedAt || typeof raw.enabled !== "boolean") return null;
  return {
    enabled: raw.enabled,
    provider: provider as PlatformAiProviderName,
    primaryModel,
    fallbackModel: fb ? fb : null,
    canaryPct: pct,
    effectiveFrom,
    reason: typeof raw.reason === "string" ? raw.reason.slice(0, 500) : "",
    changedBy: typeof raw.changedBy === "string" ? raw.changedBy : null,
    changedAt,
    cohortSince: isoOrNull(raw.cohortSince) ?? effectiveFrom,
  };
}

/** Chính sách đã lưu ⇒ kiểu đã kiểm. Sai hình ở BẤT KỲ ô nào ⇒ `null` (không đoán ý người lưu). HÀM THUẦN. */
export function parsePlatformAiPolicy(raw: unknown): PlatformAiPolicy | null {
  const core = parseCore(raw);
  if (!core) return null;
  const prev = isRec(raw) && raw.previous !== null && raw.previous !== undefined ? parseCore(raw.previous) : null;
  return { ...core, previous: prev };
}

/** Băm FNV-1a 32 bit ⇒ ô 0–99. ỔN ĐỊNH: cùng khoá luôn cùng ô, nên cùng hội thoại luôn cùng nhánh. HÀM THUẦN. */
export function canaryBucket(routingKey: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < routingKey.length; i++) {
    h ^= routingKey.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % 100;
}

export type PlatformModelArm = "BASE" | "CANARY" | "CONTROL";

/** Chính sách ĐANG có hiệu lực lúc `now` (bật + đã tới giờ), không thì `null`. HÀM THUẦN. */
export function livePolicy(policy: PlatformAiPolicy | null, now: Date): PlatformAiPolicy | null {
  return policy && policy.enabled && Date.parse(policy.effectiveFrom) <= now.getTime() ? policy : null;
}
export type PlatformModelRoute = { model: string; fallbackModel: string | null; arm: PlatformModelArm; note: string | null };

/**
 * Lượt AI dùng chung này đi model nào. HÀM THUẦN — đường nóng (`platformChatAi`) và màn người vận hành dùng CHUNG, nên
 * con số "bao nhiêu % lưu lượng đang đi model mới" trên màn hình là đúng luật đang chạy, không phải một bản chép.
 */
export function routePlatformModel(input: { baseModel: string; provider: PlatformAiProviderName; policy: PlatformAiPolicy | null; now: Date; routingKey: string; priced: (model: string) => boolean; prior?: readonly string[] }): PlatformModelRoute {
  const base = (note: string | null): PlatformModelRoute => ({ model: input.baseModel, fallbackModel: null, arm: "BASE", note });
  const p = input.policy;
  if (!p) return base(null);
  if (!p.enabled) return base("Chính sách đang tắt — dùng model của biến môi trường.");
  if (p.provider !== input.provider) return base(`Chính sách khai cho ${p.provider} nhưng khoá nền tảng là ${input.provider} — bỏ qua.`);
  if (input.now.getTime() < Date.parse(p.effectiveFrom)) return base("Chính sách chưa tới giờ hiệu lực.");
  if (!input.priced(p.primaryModel)) return base(`Model ${p.primaryModel} chưa có trong bảng giá — bỏ qua chính sách.`);
  const fb = p.fallbackModel && input.priced(p.fallbackModel) ? p.fallbackModel : input.baseModel;
  const canary: PlatformModelRoute = { model: p.primaryModel, fallbackModel: fb === p.primaryModel ? null : fb, arm: "CANARY", note: null };
  const control: PlatformModelRoute = { model: fb, fallbackModel: null, arm: "CONTROL", note: null };
  // GHIM THEO HỘI THOẠI: hội thoại đã chạy model nào (sổ AI) thì giữ nhánh đó — tăng nấc 10 → 30% không kéo hội thoại đang
  // dở của nhóm đối chứng sang model mới, và hội thoại mở TRƯỚC khi bật canary (chỉ có dòng của model ổn định) không đổi
  // model giữa chừng. Lượt hỏng của primary (dòng ERROR mang tên primary) vẫn là nhánh canary.
  const prior = input.prior ?? [];
  if (prior.includes(p.primaryModel)) return canary;
  if (prior.includes(fb)) return control;
  return canaryBucket(input.routingKey) < p.canaryPct ? canary : control;
}

const holder = globalThis as typeof globalThis & { __erpPlatformAiPolicy?: { at: number; policy: PlatformAiPolicy | null } };

/** Chính sách đang lưu (bộ đệm 30 giây, `fresh` bỏ qua bộ đệm). Lỗi đọc ⇒ `null` ⇒ model của biến môi trường. */
export async function readPlatformAiPolicy(opts: { fresh?: boolean } = {}): Promise<PlatformAiPolicy | null> {
  const hit = holder.__erpPlatformAiPolicy;
  if (!opts.fresh && hit && Date.now() - hit.at < PLATFORM_AI_POLICY_TTL_MS) return hit.policy;
  let policy: PlatformAiPolicy | null = null;
  try {
    const pdb = await getPlatformDb();
    const r = await pdb.query.platformSettings.findFirst({ where: eq(schema.platformSettings.key, PLATFORM_AI_POLICY_KEY) });
    policy = parsePlatformAiPolicy(r?.value);
  } catch {
    policy = null;
  }
  holder.__erpPlatformAiPolicy = { at: Date.now(), policy };
  return policy;
}

/**
 * Model nguồn PLATFORM mà MỘT hội thoại đã chạy (cả dòng ERROR) trong 30 ngày — căn cứ ghim nhánh. Chỉ gọi khi có chính sách
 * đang hiệu lực (đường nóng không tốn thêm câu nào khi không chạy thử). Lỗi đọc ⇒ `[]` ⇒ băm như hội thoại mới.
 */
export async function readConversationPlatformModels(orgCode: string, ref: string, now: Date = new Date()): Promise<string[]> {
  try {
    const pdb = await getPlatformDb();
    const a = schema.platformAiUsage;
    const rows = await pdb
      .selectDistinct({ model: a.model })
      .from(a)
      .where(and(eq(a.orgCode, orgCode), gte(a.at, new Date(now.getTime() - 30 * 86_400_000)), eq(a.ref, ref), eq(a.billingSource, "PLATFORM")));
    return rows.map((r) => r.model).filter((m): m is string => typeof m === "string" && m.length > 0);
  } catch {
    return [];
  }
}

/** Sau mỗi lượt ghi: tiến trình này đọc lại ngay (tiến trình khác — scheduler — tối đa 30 giây sau). */
export function invalidatePlatformAiPolicy() {
  delete holder.__erpPlatformAiPolicy;
}
