/**
 * ═══════════ CHATBOT BÁN HÀNG — KHOÁ AI CHÍNH → KHOÁ DỰ PHÒNG → NGƯỜI (06/10/2026) — CHỈ MÁY CHỦ ═══════════
 *
 * Sự cố thật: Google AI Studio hết credit trả trước lúc 11:38 ⇒ khoá BYOK của Hải Sản Làng Chài VÀ khoá của nền tảng (cùng
 * một tài khoản Google) hỏng cùng lúc ⇒ bot im ~2 giờ. Bot chỉ có MỘT đường tới AI: hỏng là chuyển người.
 *
 *     khoá CHÍNH ──(lỗi chuyển được · mạch mở)──▶ khoá DỰ PHÒNG ──(cũng hỏng)──▶ NGƯỜI (HANDOFF + báo chủ shop, như cũ)
 *
 * Bốn luật:
 *  1. CHUYỂN Ở MỨC MỘT LỜI GỌI MODEL. `FailoverProvider.complete()` trả về ĐÚNG MỘT `AiResponse` của ĐÚNG MỘT nhà cung cấp;
 *     lời gọi hỏng ném lỗi nên phần chữ dở dang (nếu có) không bao giờ ra khỏi hàm. Engine chỉ ghi / gửi chữ SAU khi hàm
 *     trả về ⇒ khách không bao giờ nhận hai câu trả lời cho một lượt vì chuyển provider.
 *  2. CHỈ LỖI CỦA NHÀ CUNG CẤP MỚI CHUYỂN (`AI_FAILOVER_CLASSES`): hết credit · khoá bị từ chối · model không có · quá tải ·
 *     lỗi máy chủ · hết giờ. Câu hỏi bị từ chối (400 nội dung) hay lỗi chưa đọc được ⇒ KHÔNG chuyển: gửi cùng câu sang nhà
 *     khác là trả tiền hai lần cho cùng một lần hỏng.
 *  3. NGẮT MẠCH THEO (tổ chức, khoá): hết credit / khoá bị từ chối / model không có ⇒ mở LÂU (`failoverOpenMinutes`, mặc định
 *     30′); quá tải / 5xx / hết giờ LIÊN TIẾP `failuresToOpen` lần ⇒ mở NGẮN. Hết hạn ⇒ NỬA MỞ: đúng MỘT lượt được thử lại
 *     khoá đó; thành công ⇒ đóng mạch, khoá chính lấy lại việc (tự phục hồi). Hàm quyết định là HÀM THUẦN (`circuitState`,
 *     `nextHealth`, `planAttempts`, `shouldPersistHealth`).
 *  4. SỨC KHOẺ LƯU Ở `settings['ai.salesChatbot.providerHealth']` của CHÍNH tổ chức — không migration. Chỉ GHI khi trạng thái
 *     mạch đổi (mở / đóng / số lỗi liên tiếp / lớp lỗi) hoặc mốc thành công cũ quá `heartbeatMs` — KHÔNG ghi mỗi lượt.
 *
 *  5. LỊCH SỬ PHẢI ĐỌC ĐƯỢC Ở NHÀ CUNG CẤP KHÁC. Engine phát lại 40 tin gần nhất gồm cả khối công cụ cũ; Gemini đặt id
 *     dạng `g0_xxx|<thoughtSignature base64>` mà Anthropic từ chối (400, id phải khớp `^[A-Za-z0-9_-]+$`) — lỗi đó là
 *     INVALID_REQUEST nên KHÔNG chuyển, và khoá dự phòng chết đúng lúc cần. Nên trước mỗi lời gọi tới nhà cung cấp
 *     KHÔNG phải Gemini, id lạ được đổi thành id an toàn ỔN ĐỊNH (`portableToolId` — băm, cặp tool_use ↔ tool_result đổi
 *     CÙNG một id, chữ ký riêng của Gemini rơi đi). Chiều ngược (quay lại Gemini giữa lượt với khối công cụ do nhà khác
 *     sinh, thiếu chữ ký) không được phép xảy ra: lượt đã chuyển sang khoá dự phòng thì DÍNH khoá đó tới hết lượt.
 *
 * Không có khoá dự phòng (mặc định) ⇒ engine không bọc gì cả: hành vi y hệt trước ngày 06/10/2026.
 *
 * Sổ AI (`platform_ai_usage`): lượt khoá chính hỏng rồi chuyển ⇒ MỘT dòng `ERROR` của khoá chính (requests 1, token NULL —
 * chưa biết, không phải 0); lượt do khoá dự phòng trả lời ghi `provider = <tên thật>+failover` (`FAILOVER_LABEL_SUFFIX`) —
 * cột `ref` giữ nguyên id hội thoại vì báo cáo chi phí theo hội thoại nhóm theo nó.
 */
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { AiMessage, AiProvider, AiRequest, AiResponse } from "@/lib/ai/provider";
import type { AiSchemaDialect } from "@/lib/ai/schema-dialect";
import type { AiBillingSource } from "@/lib/ai-usage/types";
import { activeUserIdsWhoCan } from "@/lib/auth/session";
import { AI_FAILOVER_CLASSES, AI_FAILURE_CLASSES, classifyAiFailure, type AiFailureClass } from "@/lib/constants/ai-incidents";
import { sendInboxMessages } from "@/lib/inbox/send";
import { SALES_BOT_FAILURE_LABEL } from "@/lib/sales-chatbot/config";

export const PROVIDER_HEALTH_SETTING_KEY = "ai.salesChatbot.providerHealth";

/** Nhãn cột `provider` của sổ AI cho lượt do khoá DỰ PHÒNG trả lời. */
export const FAILOVER_LABEL_SUFFIX = "+failover";

/** Trần KỸ THUẬT của bộ ngắt mạch (không phải ngưỡng nghiệp vụ). Phút mở lâu nằm trong cấu hình bot (`failoverOpenMinutes`). */
export const FAILOVER_RULE = {
  /** Quá tải / 5xx / hết giờ liên tiếp bấy nhiêu lần ⇒ mở mạch ngắn. */
  failuresToOpen: 3,
  /** Mạch ngắn: đủ để nhà cung cấp hết cơn quá tải, đủ ngắn để không bỏ rơi khoá chính lâu. */
  shortOpenMs: 2 * 60_000,
  /** Lượt thử nửa mở bị coi là chết nếu chưa xong sau chừng này (lượt khác được thử lại). */
  probeTimeoutMs: 3 * 60_000,
  /** Mốc thành công / lỗi cùng loại chỉ ghi lại CSDL khi bản đã lưu cũ hơn chừng này. */
  heartbeatMs: 60 * 60_000,
  /** Bản đệm sức khoẻ trong bộ nhớ sống chừng này rồi đọc lại CSDL (tiến trình khác có thể vừa mở / đóng mạch). */
  cacheTtlMs: 15_000,
} as const;

/** Lỗi không tự khỏi ⇒ mở mạch LÂU ngay từ lần đầu. */
export const LONG_OPEN_CLASSES: readonly AiFailureClass[] = ["CREDIT", "AUTH", "MODEL_UNAVAILABLE"];

export type ProviderHealthEntry = {
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastErrorClass: AiFailureClass | null;
  /** 200 ký tự đầu câu lỗi của nhà cung cấp (provider đã che khoá) — để người đọc và để lớp lỗi đọc lại được. */
  lastError: string | null;
  consecutiveFailures: number;
  /** Mạch mở tới mốc này; `null` = đóng. Đã qua mốc ⇒ NỬA MỞ. */
  openUntil: string | null;
};
export type ProviderHealthState = Record<string, ProviderHealthEntry>;

export const EMPTY_HEALTH: ProviderHealthEntry = { lastSuccessAt: null, lastFailureAt: null, lastErrorClass: null, lastError: null, consecutiveFailures: 0, openUntil: null };

const isoOrNull = (v: unknown): string | null => (typeof v === "string" && Number.isFinite(Date.parse(v)) ? v : null);

/** Bản đã lưu ⇒ bản dùng được. Ô hỏng ⇒ mặc định (mạch ĐÓNG — hỏng về phía hành vi cũ). HÀM THUẦN. */
export function parseProviderHealth(raw: unknown): ProviderHealthState {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: ProviderHealthState = {};
  for (const [key, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[a-z][a-z0-9-]{1,40}$/.test(key) || !v || typeof v !== "object") continue;
    const e = v as Record<string, unknown>;
    const cls = typeof e.lastErrorClass === "string" && (AI_FAILURE_CLASSES as readonly string[]).includes(e.lastErrorClass) ? (e.lastErrorClass as AiFailureClass) : null;
    const n = Number(e.consecutiveFailures);
    out[key] = {
      lastSuccessAt: isoOrNull(e.lastSuccessAt),
      lastFailureAt: isoOrNull(e.lastFailureAt),
      lastErrorClass: cls,
      lastError: typeof e.lastError === "string" ? e.lastError.slice(0, 200) : null,
      consecutiveFailures: Number.isInteger(n) && n > 0 ? Math.min(n, 1000) : 0,
      openUntil: isoOrNull(e.openUntil),
    };
  }
  return out;
}

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

/** HÀM THUẦN. */
export function circuitState(e: ProviderHealthEntry | undefined, nowMs: number): CircuitState {
  if (!e?.openUntil) return "CLOSED";
  const until = Date.parse(e.openUntil);
  if (!Number.isFinite(until)) return "CLOSED";
  return nowMs < until ? "OPEN" : "HALF_OPEN";
}

export type AttemptOutcome = { ok: true } | { ok: false; kind: AiFailureClass; message: string };

/**
 * Sức khoẻ sau MỘT lời gọi. HÀM THUẦN.
 *  · thành công ⇒ đóng mạch, xoá đếm lỗi (lớp / câu lỗi gần nhất giữ lại để người đọc biết chuyện gì vừa qua);
 *  · lỗi KHÔNG chuyển được (nội dung · chưa rõ) ⇒ chỉ ghi nhận, KHÔNG đụng mạch: đó không phải bệnh của nhà cung cấp;
 *  · lỗi lâu (credit · khoá · model) ⇒ mở mạch `longOpenMs`;
 *  · lỗi ngắn ⇒ đếm; đủ `failuresToOpen` lần, HOẶC đang là lượt thử nửa mở ⇒ mở mạch ngắn.
 */
export function nextHealth(prev: ProviderHealthEntry | undefined, outcome: AttemptOutcome, nowMs: number, longOpenMs: number): ProviderHealthEntry {
  const e = prev ?? EMPTY_HEALTH;
  const at = new Date(nowMs).toISOString();
  if (outcome.ok) return { ...e, lastSuccessAt: at, consecutiveFailures: 0, openUntil: null };
  const base: ProviderHealthEntry = { ...e, lastFailureAt: at, lastErrorClass: outcome.kind, lastError: outcome.message.replace(/\s+/g, " ").trim().slice(0, 200) };
  if (!AI_FAILOVER_CLASSES.includes(outcome.kind)) return base;
  const failures = e.consecutiveFailures + 1;
  if (LONG_OPEN_CLASSES.includes(outcome.kind)) return { ...base, consecutiveFailures: failures, openUntil: new Date(nowMs + longOpenMs).toISOString() };
  if (circuitState(e, nowMs) === "HALF_OPEN" || failures >= FAILOVER_RULE.failuresToOpen) return { ...base, consecutiveFailures: failures, openUntil: new Date(nowMs + FAILOVER_RULE.shortOpenMs).toISOString() };
  return { ...base, consecutiveFailures: failures };
}

/**
 * Có đáng GHI bản mới xuống CSDL không. Trạng thái mạch đổi ⇒ ghi. Còn lại (thành công nối tiếp thành công, lỗi nội dung
 * cùng lớp) ⇒ chỉ ghi khi mốc đã lưu cũ hơn `heartbeatMs`. HÀM THUẦN.
 */
export function shouldPersistHealth(prev: ProviderHealthEntry | undefined, next: ProviderHealthEntry, nowMs: number): boolean {
  if (!prev) return true;
  if (prev.openUntil !== next.openUntil || prev.consecutiveFailures !== next.consecutiveFailures || prev.lastErrorClass !== next.lastErrorClass) return true;
  const stale = (iso: string | null) => !iso || nowMs - Date.parse(iso) >= FAILOVER_RULE.heartbeatMs;
  if (next.lastSuccessAt !== prev.lastSuccessAt) return stale(prev.lastSuccessAt);
  if (next.lastFailureAt !== prev.lastFailureAt) return stale(prev.lastFailureAt);
  return false;
}

export type Slot = "PRIMARY" | "SECONDARY";
export type RoutePlan = { order: Slot[]; probe: Slot[]; skipped: { slot: Slot; state: CircuitState }[] };

/**
 * Thứ tự thử của MỘT lời gọi. HÀM THUẦN.
 *  · mạch ĐÓNG ⇒ thử; NỬA MỞ và chưa ai đang thử ⇒ thử (là lượt thử — `probe`); MỞ, hoặc nửa mở mà lượt khác đang thử ⇒ bỏ qua.
 *  · khoá chính luôn đứng trước — nên khoá chính nửa mở thử thành công là tự quay về khoá chính.
 *  · `null` = không có khoá đó (khoá chính không mở được · không có dự phòng). Cả hai bị bỏ qua ⇒ `order` rỗng: nơi gọi báo lỗi ngay (không tốn lời gọi).
 */
export function planAttempts(input: { primary: ProviderHealthEntry | undefined | null; secondary: ProviderHealthEntry | undefined | null; nowMs: number; probing: { PRIMARY: boolean; SECONDARY: boolean } }): RoutePlan {
  const plan: RoutePlan = { order: [], probe: [], skipped: [] };
  const slots: [Slot, ProviderHealthEntry | undefined][] = [];
  if (input.primary !== null) slots.push(["PRIMARY", input.primary]);
  if (input.secondary !== null) slots.push(["SECONDARY", input.secondary]);
  for (const [slot, entry] of slots) {
    const st = circuitState(entry, input.nowMs);
    if (st === "CLOSED") plan.order.push(slot);
    else if (st === "HALF_OPEN" && !input.probing[slot]) {
      plan.order.push(slot);
      plan.probe.push(slot);
    } else plan.skipped.push({ slot, state: st });
  }
  return plan;
}

// ─────────────────────────── lịch sử mang sang nhà cung cấp khác ───────────────────────────

/** Id công cụ mọi nhà cung cấp nhận (Anthropic: `^[a-zA-Z0-9_-]+$`; OpenAI `call_id` giữ cùng tập để khỏi phải đoán). */
export const PORTABLE_TOOL_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Id lạ ⇒ id an toàn ỔN ĐỊNH (cùng id vào ⇒ cùng id ra, nên cặp tool_use ↔ tool_result vẫn khớp). HÀM THUẦN. */
export function portableToolId(id: string): string {
  return PORTABLE_TOOL_ID_RE.test(id) ? id : `t_${createHash("sha256").update(id).digest("hex").slice(0, 32)}`;
}

/** Lịch sử với mọi id công cụ đã đổi sang dạng an toàn — không đổi gì thì trả lại đúng mảng cũ. HÀM THUẦN. */
export function portableHistory(messages: readonly AiMessage[]): AiMessage[] {
  let changed = false;
  const out = messages.map((m) => {
    let touched = false;
    const content = m.content.map((b) => {
      if (b.type === "tool_use" && !PORTABLE_TOOL_ID_RE.test(b.id)) {
        touched = true;
        return { ...b, id: portableToolId(b.id) };
      }
      if (b.type === "tool_result" && !PORTABLE_TOOL_ID_RE.test(b.toolUseId)) {
        touched = true;
        return { ...b, toolUseId: portableToolId(b.toolUseId) };
      }
      return b;
    });
    if (!touched) return m;
    changed = true;
    return { ...m, content };
  });
  return changed ? out : (messages as AiMessage[]);
}

/**
 * Provider Gemini (BYOK `gemini-byok` · nền tảng `gemini-platform`) đọc lại chữ ký nằm trong id của CHÍNH nó — không được
 * đổi id khi gửi cho nó. Mọi provider khác nhận lịch sử đã đổi id.
 */
export function speaksGeminiToolIds(provider: Pick<AiProvider, "name">): boolean {
  return /^gemini/.test(provider.name);
}

// ─────────────────────────── kho sức khoẻ (settings của tổ chức) ───────────────────────────

export type ProviderHealthStore = {
  read(): Promise<ProviderHealthState>;
  /** Ghi MỘT khoá. `persist = false` ⇒ chỉ cập nhật bản đệm trong bộ nhớ. */
  update(key: string, entry: ProviderHealthEntry, persist: boolean): Promise<void>;
};

const healthCache = new Map<string, { state: ProviderHealthState; readAt: number }>();
const probes = new Map<string, number>();

/** Chỉ bài kiểm: xoá bản đệm sức khoẻ + lượt thử nửa mở trong bộ nhớ. */
export function resetProviderHealthCacheForTests() {
  healthCache.clear();
  probes.clear();
}

/** Kho sức khoẻ của tổ chức `orgCode` (CSDL ngữ cảnh — `getDb()` đã trỏ đúng tổ chức). Lỗi CSDL không bao giờ chặn lượt chat. */
export function settingsHealthStore(orgCode: string, now: () => number = Date.now): ProviderHealthStore {
  return {
    async read() {
      const hit = healthCache.get(orgCode);
      if (hit && now() - hit.readAt < FAILOVER_RULE.cacheTtlMs) return hit.state;
      let state: ProviderHealthState = hit?.state ?? {};
      try {
        const db = await getDb();
        const [row] = await db.select({ value: schema.settings.value }).from(schema.settings).where(eq(schema.settings.key, PROVIDER_HEALTH_SETTING_KEY)).limit(1);
        state = parseProviderHealth(row?.value ? (JSON.parse(row.value) as unknown) : null);
      } catch {
        // Đọc hỏng ⇒ dùng bản đệm cũ (hoặc rỗng = mạch đóng): hỏng về phía hành vi cũ.
      }
      healthCache.set(orgCode, { state, readAt: now() });
      return state;
    },
    async update(key, entry, persist) {
      const hit = healthCache.get(orgCode);
      const state = { ...(hit?.state ?? {}), [key]: entry };
      healthCache.set(orgCode, { state, readAt: hit?.readAt ?? now() });
      if (!persist) return;
      try {
        const db = await getDb();
        const text = JSON.stringify(state);
        await db
          .insert(schema.settings)
          .values({ key: PROVIDER_HEALTH_SETTING_KEY, value: text })
          .onConflictDoUpdate({ target: schema.settings.key, set: { value: text, updatedAt: new Date() } });
      } catch {
        // Ghi hỏng ⇒ bản trong bộ nhớ vẫn đúng cho tiến trình này; lượt chat không được hỏng vì sổ sức khoẻ.
      }
    },
  };
}

/** Sức khoẻ khoá AI cho màn hình cấu hình (đọc tươi, không qua bản đệm). */
export async function loadProviderHealth(): Promise<ProviderHealthState> {
  try {
    const db = await getDb();
    const [row] = await db.select({ value: schema.settings.value }).from(schema.settings).where(eq(schema.settings.key, PROVIDER_HEALTH_SETTING_KEY)).limit(1);
    return parseProviderHealth(row?.value ? (JSON.parse(row.value) as unknown) : null);
  } catch {
    return {};
  }
}

// ─────────────────────────── provider bọc ───────────────────────────

/** Nguồn trả tiền của một khoá — cùng tập với sổ AI (`HOME` chỉ ở tổ chức nhà, Phase 8b). */
export type BillingSource = AiBillingSource;
export type FailoverCandidate = { key: string; source: BillingSource; provider: AiProvider };
export type ServedBy = { key: string; name: string; model: string; source: BillingSource; failover: boolean };
export type FailedAttempt = { key: string; name: string; model: string; source: BillingSource; kind: AiFailureClass; message: string };

export type FailoverDeps = {
  orgCode: string;
  /** `null` = khoá chính không mở được (vd kết nối đã tắt) ⇒ chỉ còn khoá dự phòng. */
  primary: FailoverCandidate | null;
  /** Khoá chính không mở được thì vì sao — để câu lỗi cuối cùng vẫn nói đúng bệnh của khoá chính. */
  primaryError?: string;
  /** Mở khoá dự phòng LÚC CẦN (không tốn một lượt đọc kết nối / kiểm credit gói ở lượt khoá chính khoẻ). */
  resolveSecondary: () => Promise<{ ok: true; candidate: FailoverCandidate } | { ok: false; error: string }>;
  /** Khoá kết nối của khoá dự phòng (để tra sức khoẻ TRƯỚC khi mở nó). */
  secondaryKey: string;
  longOpenMs: number;
  store: ProviderHealthStore;
  /** Lời gọi hỏng mà lượt ĐÃ CHUYỂN sang khoá khác — ghi sổ AI (lời gọi hỏng cuối cùng do nơi gọi ghi như trước). */
  onAttemptFailed?: (a: FailedAttempt) => Promise<void> | void;
  /** Khoá chính vừa hỏng kiểu cần người (credit · khoá · model) nhưng khoá dự phòng đã đỡ lượt này. */
  onPrimaryNeedsHuman?: (a: FailedAttempt) => Promise<void> | void;
  now?: () => number;
};

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Một `AiProvider` gồm khoá chính + khoá dự phòng. `name` / `model` / `source` đọc SAU một lời gọi là của nhà cung cấp VỪA
 * phục vụ (hoặc vừa hỏng cuối cùng) — nên mọi nơi đang ghi sổ AI bằng `prov.provider.name` / `prov.source` sau lời gọi tự
 * ghi đúng nhà cung cấp thật, không phải sửa từng nơi.
 */
export class FailoverProvider implements AiProvider {
  private last: ServedBy;
  private secondary: FailoverCandidate | null | undefined;
  private secondaryError: string | null = null;
  /** Lượt đã được khoá dự phòng phục vụ ⇒ DÍNH khoá dự phòng tới hết các vòng công cụ còn lại (luật 5 ở đầu tệp). */
  private stuck = false;

  constructor(private readonly deps: FailoverDeps) {
    const p = deps.primary;
    this.last = p ? { key: p.key, name: p.provider.name, model: p.provider.model, source: p.source, failover: false } : { key: "none", name: "none", model: "", source: "BYOK", failover: true };
  }

  get name(): string {
    return this.last.failover ? `${this.last.name}${FAILOVER_LABEL_SUFFIX}` : this.last.name;
  }
  get model(): string {
    return this.last.model;
  }
  get schemaDialect(): AiSchemaDialect {
    return (this.deps.primary ?? this.secondary)?.provider.schemaDialect ?? "openai";
  }
  get source(): BillingSource {
    return this.last.source;
  }
  servedBy(): ServedBy {
    return { ...this.last };
  }

  private async secondaryCandidate(): Promise<FailoverCandidate | null> {
    if (this.secondary !== undefined) return this.secondary;
    try {
      const r = await this.deps.resolveSecondary();
      this.secondary = r.ok ? r.candidate : null;
      if (!r.ok) this.secondaryError = r.error;
    } catch (error) {
      this.secondary = null;
      this.secondaryError = messageOf(error);
    }
    return this.secondary;
  }

  private probeKey(key: string) {
    return `${this.deps.orgCode}:${key}`;
  }

  private probing(key: string | undefined, nowMs: number): boolean {
    if (!key) return false;
    const at = probes.get(this.probeKey(key));
    return at !== undefined && nowMs - at < FAILOVER_RULE.probeTimeoutMs;
  }

  private async record(key: string, outcome: AttemptOutcome, state: ProviderHealthState) {
    const nowMs = (this.deps.now ?? Date.now)();
    const prev = state[key];
    const next = nextHealth(prev, outcome, nowMs, this.deps.longOpenMs);
    state[key] = next;
    await this.deps.store.update(key, next, shouldPersistHealth(prev, next, nowMs));
  }

  async complete(req: AiRequest): Promise<AiResponse> {
    const now = this.deps.now ?? Date.now;
    const state = { ...(await this.deps.store.read()) };
    const p = this.deps.primary;
    // Sức khoẻ tra theo KHOÁ KẾT NỐI nên đọc được trước khi mở khoá dự phòng.
    const secondaryKey = this.deps.secondaryKey;
    const plan = planAttempts({
      primary: p && !this.stuck ? state[p.key] : null,
      secondary: state[secondaryKey],
      nowMs: now(),
      probing: { PRIMARY: this.probing(p?.key, now()), SECONDARY: this.probing(secondaryKey, now()) },
    });
    let lastError: unknown = null;
    for (const [i, slot] of plan.order.entries()) {
      const cand = slot === "PRIMARY" ? p : await this.secondaryCandidate();
      if (!cand) continue;
      this.last = { key: cand.key, name: cand.provider.name, model: cand.provider.model, source: cand.source, failover: slot === "SECONDARY" };
      const probe = plan.probe.includes(slot);
      if (probe) probes.set(this.probeKey(cand.key), now());
      try {
        const res = await cand.provider.complete(speaksGeminiToolIds(cand.provider) ? req : { ...req, messages: portableHistory(req.messages) });
        await this.record(cand.key, { ok: true }, state);
        if (slot === "SECONDARY") this.stuck = true;
        return res;
      } catch (error) {
        const message = messageOf(error);
        const kind = classifyAiFailure(message);
        await this.record(cand.key, { ok: false, kind, message }, state);
        lastError = error;
        const hasNext = i < plan.order.length - 1;
        if (!hasNext || !AI_FAILOVER_CLASSES.includes(kind)) throw error;
        // Còn khoá sau nhưng khoá đó không mở được ⇒ ném lỗi của khoá này (câu lỗi thật, lớp lỗi thật).
        if (slot === "PRIMARY" && !(await this.secondaryCandidate())) throw error;
        const failed: FailedAttempt = { key: cand.key, name: this.name, model: cand.provider.model, source: cand.source, kind, message };
        await Promise.resolve(this.deps.onAttemptFailed?.(failed)).catch(() => undefined);
        if (slot === "PRIMARY" && LONG_OPEN_CLASSES.includes(kind)) await Promise.resolve(this.deps.onPrimaryNeedsHuman?.(failed)).catch(() => undefined);
      } finally {
        if (probe) probes.delete(this.probeKey(cand.key));
      }
    }
    if (lastError) throw lastError;
    throw new Error(this.allOpenMessage(state, p?.key, secondaryKey));
  }

  /**
   * Không còn khoá nào được thử (mạch mở / khoá dự phòng không mở được). Câu lỗi mang NGUYÊN câu lỗi gần nhất của khoá
   * chính, nên `salesBotError` vẫn xếp đúng lớp (hết credit ⇒ báo chủ shop) như ngày chưa có dự phòng.
   */
  private allOpenMessage(state: ProviderHealthState, primaryKey: string | undefined, secondaryKey: string | undefined): string {
    const pe = primaryKey ? state[primaryKey] : undefined;
    const se = secondaryKey ? state[secondaryKey] : undefined;
    const parts = [
      primaryKey ? `Khoá AI chính «${primaryKey}» đang tạm ngắt${pe?.openUntil ? ` tới ${pe.openUntil}` : ""}${pe?.lastError ? ` — lỗi gần nhất: ${pe.lastError}` : ""}.` : `Khoá AI chính không mở được${this.deps.primaryError ? `: ${this.deps.primaryError}` : ""}.`,
      this.secondaryError ? `Khoá dự phòng chưa dùng được: ${this.secondaryError}.` : secondaryKey ? `Khoá dự phòng «${secondaryKey}» đang tạm ngắt${se?.lastError ? ` — lỗi gần nhất: ${se.lastError}` : ""}.` : "",
    ];
    return parts.filter(Boolean).join(" ");
  }
}

// ─────────────────────────── báo chủ shop ───────────────────────────

/**
 * Khoá CHÍNH hỏng kiểu không tự khỏi nhưng khoá dự phòng đang đỡ: bot VẪN trả lời khách, nên không phải tin «bot ngừng» —
 * nhưng chủ shop phải biết, nếu không khoá chính hết tiền mãi mà không ai nạp và lượt nào cũng trả tiền ở khoá dự phòng.
 * MỘT tin mỗi khoá × lớp lỗi × ngày (giờ VN), chống trùng ở CSDL (`dedupe_key`). Lỗi gửi không chặn lượt chat.
 */
export async function notifyPrimaryFailover(primaryKey: string, kind: AiFailureClass, fallbackLabel: string, now: Date): Promise<void> {
  const day = new Date(now.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);
  const title = "Khoá AI chính của chatbot hỏng — bot đang chạy bằng khoá dự phòng";
  const body = `Khoá «${primaryKey}»: ${SALES_BOT_FAILURE_LABEL[kind]}. Bot vẫn trả lời khách bằng khoá dự phòng «${fallbackLabel}» (trả tiền ở khoá đó). Sửa khoá chính ở Cài đặt → Kết nối / trang của nhà cung cấp AI; bot tự quay về khoá chính khi nó khoẻ lại.`;
  const dedupe = `sales-chat:failover:${primaryKey}:${kind}:${day}`;
  const db = await getDb();
  await db
    .insert(schema.notifications)
    .values({ kind: "SYSTEM", severity: "warning", title, body, href: "/ai/sales-chatbot", entityType: "SALES_CHAT", entityId: primaryKey, dedupeKey: dedupe, occurredAt: now })
    .onConflictDoNothing({ target: schema.notifications.dedupeKey });
  const users = await activeUserIdsWhoCan("ai_sales:manage");
  await sendInboxMessages(users.map((userId) => ({ userId, kind: "SALES_CHAT_AI_DOWN", title, body, href: "/ai/sales-chatbot", dedupeKey: `${dedupe}:${userId}` })), db);
}
