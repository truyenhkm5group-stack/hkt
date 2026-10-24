/**
 * ═══════════ SỨC KHOẺ BOT NHÀ (chatbot/, container erp-chatbot) ĐI VÀO CÙNG CHUỖI BÁO VẬN HÀNH (24/10/2026) ═══════════
 *
 * Vì sao: 24/10/2026 bot nhà ngừng trả lời mọi page từ 11:21Z — Gemini 403 «Your project has been denied access» — và SÁU GIỜ không ai
 * biết: bot nhà chỉ ping healthchecks.io (ra ngoài, ERP không thấy), còn sự cố AI của ERP (#1023, `platform_org_health` dòng «AI») chỉ đo
 * AI NỀN TẢNG của tổ chức. Bot nhà dùng khoá / project RIÊNG.
 *
 * Bot nhà ĐẨY lên `/api/internal/bot-health` (khoá `x-chatbot-token`, như shipment-state):
 *  · `PROVIDER_ERROR` {status, message ≤ 160 — chữ lỗi của NHÀ CUNG CẤP, không chữ khách} · `PROVIDER_OK` — ERP phân loại bằng ĐÚNG
 *    `classifyAiError` (lib/constants/ai-incidents.ts), bot KHÔNG giữ bản sao luật;
 *  · `BEAT` mỗi 5′ {replies5m, customerTurns5m, lastReplyAt} — nhịp sống.
 * Trạng thái nằm ở MỘT khoá settings của tổ chức nhà (`home-bot.health`) — KHÔNG thêm check_key vào platform_org_health (CHECK đóng 7 khoá,
 * mirror ép đúng 7 dòng). Ghi bằng setSettingJson, KHÔNG qua audit() ⇒ không lượt clearMemo nào cho tổ chức nhà (lỗi #1036).
 * Báo vận hành qua notifyPlatformOperator (deliverThroughChain + platform_operator_alerts chống lặp): MỘT tin mỗi sự cố, MỘT tin hồi phục.
 * HÀM THUẦN ở tệp này — client import được.
 */
import { z } from "zod";
import { AI_CLASSES_CAN_NGUOI, classifyAiError, type AiErrorClass } from "@/lib/constants/ai-incidents";

export const HOME_BOT_HEALTH_PATH = "/api/internal/bot-health";
export const HOME_BOT_HEALTH_TOKEN_HEADER = "x-chatbot-token";
export const HOME_BOT_HEALTH_KEY = "home-bot.health";

/**
 * NGƯỠNG VẬN HÀNH (không phải ngưỡng nghiệp vụ) — MỘT chỗ khai:
 *  · `silentMinutes` 30 — có lượt khách mà 0 câu trả lời liên tục 30′ ⇒ «bot nhà im lặng». 30′ ≈ sáu nhịp 5′: một nhịp trống vì khách vừa
 *    nhắn lúc bot đang soạn không đủ để báo; giờ cao điểm tối 24/10 có ~20 câu trả lời / giờ nên 30′ trống là bất thường thật.
 *  · `beatStaleMinutes` 15 — không nhận nhịp nào > 15′ (ba nhịp liền) ⇒ «mất nhịp» (container chết / mạng nội bộ / ERP không tới). Một
 *    nhịp rơi vì deploy dựng lại container (≈ 2–4′) không đủ để báo.
 *  · `rateLimitBurst` 3 trong `rateLimitWindowMinutes` 10 — 429 lẻ là bình thường (bot tự thử lại); ba lần trong 10′ mới là sự cố.
 *  · Giới hạn route: `reportBurst` 20 lượt, đầy lại một lượt mỗi `reportRefillMs` 3 s — bot đã tự thưa lỗi; xô này chỉ chặn vòng lặp hỏng.
 */
export const HOME_BOT_HEALTH = {
  silentMinutes: 30,
  beatStaleMinutes: 15,
  beatEveryMinutes: 5,
  rateLimitBurst: 3,
  rateLimitWindowMinutes: 10,
  reportBurst: 20,
  reportRefillMs: 3_000,
} as const;

const iso = z.string().datetime({ offset: true });
export const homeBotReportSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("PROVIDER_ERROR"), status: z.number().int().min(0).max(999), message: z.string().max(160) }).strict(),
  z.object({ type: z.literal("PROVIDER_OK") }).strict(),
  z.object({ type: z.literal("BEAT"), replies5m: z.number().int().min(0).max(100_000), customerTurns5m: z.number().int().min(0).max(100_000), lastReplyAt: iso.nullable() }).strict(),
]);
export type HomeBotReport = z.infer<typeof homeBotReportSchema>;

/** Lớp sự cố bot nhà: hai lớp «cần người» của ERP + RATE_LIMIT dồn dập. */
export type HomeBotIncidentKind = "CREDIT" | "AUTH" | "RATE_LIMIT";
export type HomeBotHealthState = {
  /** Sự cố nhà cung cấp đang mở (`null` = không có) + mốc mở. */
  incident: { kind: HomeBotIncidentKind; since: string; lastErrorAt: string; count: number; status: number | null } | null;
  /** Mốc các lần 429 gần đây (≤ rateLimitBurst, trong cửa sổ). */
  rateErrors: string[];
  lastBeatAt: string | null;
  /** Bắt đầu chuỗi nhịp «có lượt khách, 0 câu trả lời». `null` = không im lặng. */
  silentSince: string | null;
  /** Đã báo «im lặng» cho chuỗi bắt đầu ở mốc này. */
  silentAlerted: string | null;
  /** Đã báo «mất nhịp» cho nhịp cuối ở mốc này. */
  staleAlerted: string | null;
  lastReplyAt: string | null;
};
export const EMPTY_HOME_BOT_STATE: HomeBotHealthState = { incident: null, rateErrors: [], lastBeatAt: null, silentSince: null, silentAlerted: null, staleAlerted: null, lastReplyAt: null };

export type HomeBotAlert = { dedupeKey: string; title: string; lines: string[] };

const vn = (isoAt: string) => {
  const d = new Date(Date.parse(isoAt) + 7 * 3_600_000).toISOString();
  return `${d.slice(11, 16)} ${d.slice(8, 10)}/${d.slice(5, 7)}`;
};
const KIND_LABEL: Record<HomeBotIncidentKind, string> = {
  AUTH: "khoá AI bị nhà cung cấp TỪ CHỐI (403 / quyền) — mở đúng project của khoá Gemini bot nhà xem lý do",
  CREDIT: "hết tiền / hạn mức AI — nạp hoặc đổi tài khoản trả phí của khoá Gemini bot nhà",
  RATE_LIMIT: "nhà cung cấp AI giới hạn tần suất dồn dập (429) — xem hạn mức của project",
};

/** Đọc trạng thái đã lưu — dữ liệu lạ ⇒ trạng thái rỗng (không ném). HÀM THUẦN. */
export function parseHomeBotState(raw: unknown): HomeBotHealthState {
  if (!raw || typeof raw !== "object") return { ...EMPTY_HOME_BOT_STATE };
  const r = raw as Partial<HomeBotHealthState>;
  const s = (x: unknown) => (typeof x === "string" && Number.isFinite(Date.parse(x)) ? x : null);
  const inc = r.incident && typeof r.incident === "object" && ["CREDIT", "AUTH", "RATE_LIMIT"].includes(String(r.incident.kind)) && s(r.incident.since) ? r.incident : null;
  return {
    incident: inc,
    rateErrors: Array.isArray(r.rateErrors) ? r.rateErrors.filter((x): x is string => s(x) !== null).slice(-HOME_BOT_HEALTH.rateLimitBurst) : [],
    lastBeatAt: s(r.lastBeatAt),
    silentSince: s(r.silentSince),
    silentAlerted: s(r.silentAlerted),
    staleAlerted: s(r.staleAlerted),
    lastReplyAt: s(r.lastReplyAt),
  };
}

/**
 * Áp MỘT báo cáo của bot lên trạng thái ⇒ trạng thái mới + các tin phải gửi (chống lặp theo `dedupeKey` ở platform_operator_alerts). HÀM THUẦN.
 *  · lỗi lớp «cần người» (CREDIT / AUTH) ⇒ mở sự cố (một tin); cùng lớp lặp lại chỉ đếm; lớp khác ⇒ sự cố mới;
 *  · 429 ⇒ chỉ thành sự cố khi đủ `rateLimitBurst` lần trong cửa sổ; lỗi OTHER (mạng, 5xx…) không mở sự cố;
 *  · `PROVIDER_OK` khi đang có sự cố ⇒ đóng (một tin hồi phục);
 *  · `BEAT`: có lượt khách mà 0 câu trả lời ⇒ chuỗi im lặng; ≥ `silentMinutes` ⇒ một tin; có câu trả lời ⇒ hết im lặng (một tin hồi phục nếu
 *    đã báo); KHÔNG có lượt khách ⇒ đêm vắng, không phải im lặng — chuỗi không đổi; nhịp quay lại sau «mất nhịp» đã báo ⇒ một tin hồi phục.
 */
export function applyHomeBotReport(prev: HomeBotHealthState, report: HomeBotReport, now: Date): { state: HomeBotHealthState; alerts: HomeBotAlert[] } {
  const at = now.toISOString();
  const state: HomeBotHealthState = { ...prev, rateErrors: [...prev.rateErrors] };
  const alerts: HomeBotAlert[] = [];
  const open = (kind: HomeBotIncidentKind, status: number | null) => {
    if (state.incident?.kind === kind) {
      state.incident = { ...state.incident, lastErrorAt: at, count: state.incident.count + 1, status };
      return;
    }
    state.incident = { kind, since: at, lastErrorAt: at, count: 1, status };
    alerts.push({ dedupeKey: `home-bot:new:${kind}:${at}`, title: `🔴 Bot nhà: ${kind === "RATE_LIMIT" ? "AI bị giới hạn tần suất" : "AI không trả lời được"} (${kind})`, lines: [`Từ ${vn(at)}: ${KIND_LABEL[kind]}.`, "Khách nhắn các page nhà có thể không được trả lời — nhân viên trực trả lời tay tới khi hồi phục.", `Mã lỗi nhà cung cấp: ${status ?? "—"}.`] });
  };
  if (report.type === "PROVIDER_ERROR") {
    const cls: AiErrorClass = classifyAiError(`${report.status} ${report.message}`);
    if ((AI_CLASSES_CAN_NGUOI as readonly string[]).includes(cls)) open(cls as HomeBotIncidentKind, report.status);
    else if (cls === "RATE_LIMIT") {
      const from = now.getTime() - HOME_BOT_HEALTH.rateLimitWindowMinutes * 60_000;
      state.rateErrors = [...state.rateErrors.filter((x) => Date.parse(x) >= from), at].slice(-HOME_BOT_HEALTH.rateLimitBurst);
      if (state.rateErrors.length >= HOME_BOT_HEALTH.rateLimitBurst && !state.incident) open("RATE_LIMIT", report.status);
    }
    return { state, alerts };
  }
  if (report.type === "PROVIDER_OK") {
    if (state.incident) {
      alerts.push({ dedupeKey: `home-bot:ok:${state.incident.kind}:${state.incident.since}`, title: `🟢 Bot nhà: AI đã trả lời lại (${state.incident.kind})`, lines: [`Sự cố mở từ ${vn(state.incident.since)}, ${state.incident.count} lần lỗi; hồi phục lúc ${vn(at)}.`] });
      state.incident = null;
    }
    state.rateErrors = [];
    return { state, alerts };
  }
  // BEAT
  if (state.staleAlerted && state.lastBeatAt && state.staleAlerted === state.lastBeatAt) {
    alerts.push({ dedupeKey: `home-bot:stale-ok:${state.staleAlerted}`, title: "🟢 Bot nhà: nhận lại nhịp sống", lines: [`Mất nhịp từ ${vn(state.staleAlerted)}; nhịp quay lại lúc ${vn(at)}.`] });
    state.staleAlerted = null;
  }
  state.lastBeatAt = at;
  if (report.lastReplyAt) state.lastReplyAt = report.lastReplyAt;
  if (report.replies5m > 0) {
    if (state.silentSince && state.silentAlerted === state.silentSince) alerts.push({ dedupeKey: `home-bot:silent-ok:${state.silentSince}`, title: "🟢 Bot nhà: trả lời khách lại", lines: [`Im lặng từ ${vn(state.silentSince)}; có câu trả lời lại lúc ${vn(at)}.`] });
    state.silentSince = null;
    state.silentAlerted = null;
  } else if (report.customerTurns5m > 0) {
    state.silentSince = state.silentSince ?? new Date(now.getTime() - HOME_BOT_HEALTH.beatEveryMinutes * 60_000).toISOString();
    if (now.getTime() - Date.parse(state.silentSince) >= HOME_BOT_HEALTH.silentMinutes * 60_000 && state.silentAlerted !== state.silentSince) {
      state.silentAlerted = state.silentSince;
      alerts.push({ dedupeKey: `home-bot:silent:${state.silentSince}`, title: "🟠 Bot nhà: có khách nhắn mà không trả lời", lines: [`Từ ${vn(state.silentSince)} có lượt khách nhưng 0 câu trả lời (≥ ${HOME_BOT_HEALTH.silentMinutes}′).`, state.incident ? `Sự cố AI đang mở: ${state.incident.kind}.` : "Chưa có lỗi nhà cung cấp nào được báo — xem log bot (ops chatbot-status).", "Nhân viên trực trả lời tay các page nhà."] });
    }
  }
  return { state, alerts };
}

/** Kiểm «mất nhịp» (job 5′ của tổ chức nhà). Bot CHƯA từng gửi nhịp (bản cũ) ⇒ không kết luận. HÀM THUẦN. */
export function homeBotStaleCheck(prev: HomeBotHealthState, now: Date): { state: HomeBotHealthState; alerts: HomeBotAlert[] } {
  if (!prev.lastBeatAt || prev.staleAlerted === prev.lastBeatAt) return { state: prev, alerts: [] };
  if (now.getTime() - Date.parse(prev.lastBeatAt) <= HOME_BOT_HEALTH.beatStaleMinutes * 60_000) return { state: prev, alerts: [] };
  return {
    state: { ...prev, staleAlerted: prev.lastBeatAt },
    alerts: [{ dedupeKey: `home-bot:stale:${prev.lastBeatAt}`, title: "🔴 Bot nhà: mất nhịp sống", lines: [`Nhịp cuối lúc ${vn(prev.lastBeatAt)} (> ${HOME_BOT_HEALTH.beatStaleMinutes}′) — container bot dừng, mạng nội bộ hỏng hoặc ERP không nhận được.`, "Xem ops chatbot-status / status; nhân viên trực trả lời tay các page nhà."] }],
  };
}

/** Ba dòng banner cho /platform: sự cố đang mở · im lặng · mất nhịp. Rỗng = không có gì phải báo. HÀM THUẦN. */
export function homeBotBannerLines(s: HomeBotHealthState, now: Date): string[] {
  const out: string[] = [];
  if (s.incident) out.push(`Bot nhà: ${KIND_LABEL[s.incident.kind]} — từ ${vn(s.incident.since)}, ${s.incident.count} lần lỗi.`);
  if (s.silentSince && s.silentAlerted === s.silentSince) out.push(`Bot nhà có khách nhắn mà không trả lời từ ${vn(s.silentSince)}.`);
  if (s.lastBeatAt && now.getTime() - Date.parse(s.lastBeatAt) > HOME_BOT_HEALTH.beatStaleMinutes * 60_000) out.push(`Bot nhà mất nhịp sống từ ${vn(s.lastBeatAt)}.`);
  return out;
}
