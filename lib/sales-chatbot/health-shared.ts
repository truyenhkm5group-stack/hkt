import type { AiSalesSlo } from "@/lib/constants/ai-sales-slo";

/**
 * ═══════════ AI BÁN HÀNG SỐNG HAY CHẾT — HÀM THUẦN (dùng chung máy chủ + màn hình) ═══════════
 *
 * `evaluateSalesHealth(snapshot, slo)` không đọc / ghi CSDL, chạy hai lần ra cùng kết quả. Ảnh chụp dựng ở `health.ts`.
 *
 * Bảy câu hỏi đứng RIÊNG vì mỗi câu sửa ở một chỗ khác (cùng tinh thần luật 52 — gộp thành một ô "OK" là mất khả năng sửa):
 *  1. HÀNG CHỜ  — tin đủ điều kiện nằm chờ bao lâu (oldest_unhandled_message_age) — SLO 5 / 10 phút;
 *  2. BOT IM    — có tin khách được máy chốt mà không câu bot nào đi ra (đúng sự cố 06/10/2026);
 *  3. PROVIDER  — nhà cung cấp AI lỗi, và LỚP lỗi (hết tiền · khoá bị từ chối · quá tải · khác) để báo đúng nguyên nhân;
 *  4. WEBHOOK   — khung giờ này mọi hôm có tin mà giờ im (nền 14 ngày, trung vị — dưới 5 ngày là CHƯA BIẾT);
 *  5. ĐỘ TRỄ    — P95 tin khách → câu bot so với SLO 60 giây (dưới mẫu tối thiểu là CHƯA ĐỦ DỮ LIỆU);
 *  6. LƯỚI AN TOÀN — job quét lại tin rơi + ghi đơn từ hội thoại còn chạy không;
 *  7. GHI ĐƠN   — công tắc ghi đơn từ hội thoại bật mà job lỗi.
 *
 * CHƯA BIẾT không bao giờ in thành "khoẻ" (luật 42/52): một kiểm thiếu dữ liệu ⇒ `UNKNOWN`, và tổng chỉ XANH khi không còn
 * kiểm nào vàng/đỏ. Bot TẮT ⇒ `OFF` — không báo động cho một thứ chủ shop cố ý tắt (lưới ghi đơn vẫn được kiểm nếu bật).
 */

export type HealthLevel = "OK" | "WARNING" | "CRITICAL" | "UNKNOWN";
export type SalesHealthStatus = "GREEN" | "YELLOW" | "RED" | "UNKNOWN" | "OFF";
export type HealthCheckKey = "BACKLOG" | "ABANDONED" | "BOT_SILENT" | "PROVIDER" | "WEBHOOK" | "LATENCY" | "SAFETY_NET" | "ORDER_SYNC";

export type HealthCheck = { key: HealthCheckKey; level: HealthLevel; title: string; detail: string; fix?: string };

/** Lớp lỗi provider — lấy từ `salesBotError` (config.ts); chuỗi để chịu được lớp mới mà không vỡ kiểu. */
export type ProviderErrorKind = string;

export type SalesHealthSnapshot = {
  at: string;
  /** Bot trả lời khách đang bật (tổ chức hoặc ít nhất một page). */
  botEnabled: boolean;
  /** Chế độ vận hành (`OPERATING_MODES`): AUTOPILOT thì bot im mới là lỗi; OBSERVE / COPILOT im là đúng thiết kế; EXPERIMENT chia một phần cho người nên không kiểm «bot im». */
  mode: string;
  orderSyncEnabled: boolean;
  channels: {
    pancake: { configured: boolean; lastWebhookAt: string | null };
    messenger: { pages: number; lastEventAt: string | null; lastErrorAt: string | null; lastError: string | null };
  };
  lastCustomerMessageAt: string | null;
  lastAiReplyAt: string | null;
  lastAiOrderAt: string | null;
  queue: {
    /**
     * Tin khách sống (không phải tin nhập lịch sử) đang PENDING và còn trong cửa sổ bot TỰ xử lý (≤ `PENDING_ELIGIBLE_MINUTES`).
     * Tin PENDING cũ hơn bot không bao giờ tự trả lời nữa (quét lại chỉ nhìn 30 phút) ⇒ đếm riêng ở `abandoned24h`, không làm
     * hàng chờ đỏ mãi.
     */
    pending: number;
    /** … trong đó đang có lượt giành (đang xử lý / thử lại). */
    retrying: number;
    oldestPendingAt: string | null;
    /** Tin khách bị chốt DONE vì AI hỏng (chuyển người, bot không nhắn gì) trong 24 giờ. */
    failedAiDown24h: number;
    /** Tin khách chốt DONE kèm lỗi GỬI (Pancake / Meta không nhận tin) trong 24 giờ. */
    failedSend24h: number;
    /** Tin khách PENDING quá cửa sổ tự xử lý (bị bỏ sót) trong 24 giờ — việc của người / job cứu hội thoại. */
    abandoned24h: number;
    /** Dead-letter (đã hết lượt thử). `null` = CSDL chưa có cột này (trước migration thử lại). */
    deadLetter: number | null;
  };
  silent: { customerHandled: number; botSent: number; windowMinutes: number };
  latency: { p50Seconds: number | null; p95Seconds: number | null; sample: number; unanswered: number };
  provider: {
    okInWindow: number;
    errorsInWindow: number;
    blockedInWindow: number;
    lastOkAt: string | null;
    lastErrorAt: string | null;
    /** Lớp lỗi của lượt hỏng gần nhất (hội thoại bị chuyển người vì AI hỏng) — `null` = không có / chưa biết. */
    lastErrorKind: ProviderErrorKind | null;
    lastErrorLabel: string | null;
  };
  traffic: { lastHour: number; baselineSameHour: number | null; baselineDays: number };
  followup: { lastRunAt: string | null; lastStatus: string | null; lastError: string | null };
  orderSyncErrors24h: number;
  /** Ghi đơn từ hội thoại: lỗi trong cửa sổ provider + mốc thành công / lỗi gần nhất — sự cố đã hồi phục không vàng suốt 24 giờ. */
  orderSync: { errorsInWindow: number; lastOkAt: string | null; lastErrorAt: string | null };
  /** Hôm nay (giờ VN). `ordersAi` = đơn BOT chốt (origin AI_AGENT); `ordersSync` = đơn máy ghi hộ nhân viên chốt (AI_ORDER_SYNC). Giá trị là DANH NGHĨA lúc chốt — chưa phải doanh thu theo ORDER_OUTCOME. */
  today: { conversationsAi: number; ordersAi: number; ordersSync: number; orderValueAi: number; conversionPct: number | null };
  errors24h: number;
};

export type SalesHealth = { status: SalesHealthStatus; checks: HealthCheck[]; headline: string };

/** Tin PENDING quá mốc này (phút) bot không tự xử lý nữa: quét lại Pancake / Messenger chỉ nhìn 30 phút gần nhất. */
export const PENDING_ELIGIBLE_MINUTES = 60;

const minutesSince = (iso: string | null, now: number): number | null => (iso ? Math.max(0, (now - Date.parse(iso)) / 60_000) : null);
const rank: Record<HealthLevel, number> = { OK: 0, UNKNOWN: 1, WARNING: 2, CRITICAL: 3 };
const fmtMin = (m: number) => (m < 60 ? `${Math.round(m)} phút` : `${Math.floor(m / 60)} giờ ${Math.round(m % 60)} phút`);

/** Lớp lỗi KHÔNG tự khỏi — có người phải làm gì đó (nạp tiền, thay khoá, nâng hạn mức). */
export const PROVIDER_KINDS_NEED_HUMAN: readonly string[] = ["CREDIT", "AUTH"];

export function evaluateSalesHealth(s: SalesHealthSnapshot, slo: AiSalesSlo): SalesHealth {
  const now = Date.parse(s.at);
  const checks: HealthCheck[] = [];
  const aiActive = s.botEnabled;

  // 1. HÀNG CHỜ — oldest_unhandled_message_age.
  if (aiActive) {
    const age = minutesSince(s.queue.oldestPendingAt, now);
    if (age === null) checks.push({ key: "BACKLOG", level: "OK", title: "Hàng chờ", detail: "Không tin khách nào đang chờ xử lý." });
    else if (age >= slo.backlogCriticalMinutes)
      checks.push({ key: "BACKLOG", level: "CRITICAL", title: "Hàng chờ", detail: `${s.queue.pending} tin khách đang chờ, tin cũ nhất ${fmtMin(age)} (SLO ${slo.backlogCriticalMinutes} phút).`, fix: "Mở «Tin lỗi / đang chờ» bên dưới; nếu provider lỗi thì sửa provider trước." });
    else if (age >= slo.backlogWarnMinutes)
      checks.push({ key: "BACKLOG", level: "WARNING", title: "Hàng chờ", detail: `${s.queue.pending} tin khách đang chờ, tin cũ nhất ${fmtMin(age)} (SLO ${slo.backlogWarnMinutes} phút).` });
    else checks.push({ key: "BACKLOG", level: "OK", title: "Hàng chờ", detail: `${s.queue.pending} tin đang chờ, cũ nhất ${fmtMin(age)}.` });
    if (s.queue.abandoned24h > 0)
      checks.push({ key: "ABANDONED", level: "WARNING", title: "Tin bị bỏ sót", detail: `${s.queue.abandoned24h} tin khách trong 24 giờ nằm chờ quá ${PENDING_ELIGIBLE_MINUTES} phút — bot sẽ KHÔNG tự trả lời nữa.`, fix: "Nhân viên trả lời các tin này (bảng «Tin lỗi / đang chờ»)." });
  }

  // 3. PROVIDER — trước «bot im» để câu tổng nói nguyên nhân, không chỉ triệu chứng.
  const p = s.provider;
  const errorAfterOk = p.lastErrorAt !== null && (p.lastOkAt === null || Date.parse(p.lastErrorAt) > Date.parse(p.lastOkAt));
  const needsHuman = p.lastErrorKind !== null && PROVIDER_KINDS_NEED_HUMAN.includes(p.lastErrorKind);
  const totalCalls = p.okInWindow + p.errorsInWindow + p.blockedInWindow;
  if (totalCalls === 0 && p.lastOkAt === null && p.lastErrorAt === null) {
    if (aiActive) checks.push({ key: "PROVIDER", level: "UNKNOWN", title: "Nhà cung cấp AI", detail: "Chưa có lượt gọi AI nào trong sổ — chưa biết provider có chạy không." });
  } else if (p.blockedInWindow > 0 && p.okInWindow === 0) {
    checks.push({ key: "PROVIDER", level: "CRITICAL", title: "Nhà cung cấp AI", detail: `${p.blockedInWindow} lượt bị CHẶN trong ${slo.providerWindowMinutes} phút (hết hạn mức AI của gói / công tắc khẩn cấp).`, fix: "Kiểm hạn mức AI của gói và công tắc khẩn cấp AI." });
  } else if (errorAfterOk && (needsHuman || p.errorsInWindow >= slo.providerErrorBurst)) {
    checks.push({ key: "PROVIDER", level: "CRITICAL", title: "Nhà cung cấp AI", detail: `${p.errorsInWindow} lượt lỗi trong ${slo.providerWindowMinutes} phút, chưa lượt nào thành công sau lỗi cuối. ${p.lastErrorLabel ?? "Lỗi chưa xếp lớp được."}`, fix: p.lastErrorLabel ?? undefined });
  } else if (errorAfterOk && p.errorsInWindow > 0) {
    checks.push({ key: "PROVIDER", level: "WARNING", title: "Nhà cung cấp AI", detail: `${p.errorsInWindow} lượt lỗi gần đây (${p.lastErrorLabel ?? "chưa xếp lớp"}) — chưa đủ ${slo.providerErrorBurst} lượt để kết luận hỏng.` });
  } else checks.push({ key: "PROVIDER", level: "OK", title: "Nhà cung cấp AI", detail: `${p.okInWindow} lượt thành công trong ${slo.providerWindowMinutes} phút${p.errorsInWindow ? `, ${p.errorsInWindow} lỗi đã hồi phục` : ""}.` });

  // 2. BOT IM — tin khách được chốt xử lý mà không câu bot nào ra (chỉ ở chế độ TỰ ĐỘNG).
  if (aiActive && s.mode === "AUTOPILOT") {
    const { customerHandled, botSent, windowMinutes } = s.silent;
    if (customerHandled >= slo.silentMinCustomerMessages && botSent === 0)
      checks.push({ key: "BOT_SILENT", level: "CRITICAL", title: "Bot trả lời khách", detail: `${customerHandled} tin khách trong ${windowMinutes} phút qua, bot KHÔNG gửi câu nào.`, fix: "Xem lý do ở «Tin lỗi»: AI hỏng thì khách đang bị chuyển cho nhân viên — gọi lại khách trong lúc sửa." });
    else checks.push({ key: "BOT_SILENT", level: "OK", title: "Bot trả lời khách", detail: `${customerHandled} tin khách · ${botSent} câu bot trong ${windowMinutes} phút.` });
  }

  // 4. WEBHOOK — im lặng so với nền của đúng khung giờ.
  const t = s.traffic;
  if (t.baselineSameHour === null || t.baselineDays < slo.webhookBaselineMinDays)
    checks.push({ key: "WEBHOOK", level: "UNKNOWN", title: "Tin khách tới (webhook)", detail: `Chưa đủ ${slo.webhookBaselineMinDays} ngày dữ liệu cho khung giờ này — CHƯA BIẾT, không phải "khoẻ". Giờ qua: ${t.lastHour} tin.` });
  else if (t.baselineSameHour >= slo.webhookSilentBaselineMin && t.lastHour === 0)
    checks.push({ key: "WEBHOOK", level: "WARNING", title: "Tin khách tới (webhook)", detail: `Khung giờ này mọi hôm có khoảng ${t.baselineSameHour} tin, giờ qua 0 tin.`, fix: "Kiểm webhook Pancake / Meta của page (Kết nối dữ liệu) và trạng thái page bên dưới." });
  else checks.push({ key: "WEBHOOK", level: "OK", title: "Tin khách tới (webhook)", detail: `Giờ qua ${t.lastHour} tin (mọi hôm khung này ~${t.baselineSameHour}).` });

  // 5. ĐỘ TRỄ — P95 so với SLO.
  if (aiActive) {
    const l = s.latency;
    if (l.sample < slo.latencyMinSample || l.p95Seconds === null)
      checks.push({ key: "LATENCY", level: "UNKNOWN", title: "Độ trễ trả lời", detail: `Mới ${l.sample} lượt đo trong 24 giờ (cần ≥ ${slo.latencyMinSample}) — CHƯA ĐỦ DỮ LIỆU.` });
    else if (l.p95Seconds > slo.replyTargetSeconds)
      checks.push({ key: "LATENCY", level: "WARNING", title: "Độ trễ trả lời", detail: `P95 ${Math.round(l.p95Seconds)} giây > SLO ${slo.replyTargetSeconds} giây (P50 ${Math.round(l.p50Seconds ?? 0)} giây, ${l.sample} lượt).` });
    else checks.push({ key: "LATENCY", level: "OK", title: "Độ trễ trả lời", detail: `P50 ${Math.round(l.p50Seconds ?? 0)} giây · P95 ${Math.round(l.p95Seconds)} giây (${l.sample} lượt).` });
  }

  // 6. LƯỚI AN TOÀN — job quét lại tin rơi + ghi đơn.
  if (aiActive || s.orderSyncEnabled) {
    const age = minutesSince(s.followup.lastRunAt, now);
    if (age === null) checks.push({ key: "SAFETY_NET", level: "UNKNOWN", title: "Job quét lại & ghi đơn", detail: "Chưa thấy lượt chạy nào của job sales-followup." });
    else if (age >= slo.followupStaleMinutes)
      checks.push({ key: "SAFETY_NET", level: "WARNING", title: "Job quét lại & ghi đơn", detail: `Lượt cuối cách đây ${fmtMin(age)} (lịch 5 phút) — tin rơi không được quét lại, đơn từ hội thoại không được ghi.`, fix: "Kiểm bộ lập lịch (Hệ thống → Đồng bộ)." });
    else if (s.followup.lastStatus && s.followup.lastStatus !== "SUCCESS" && s.followup.lastStatus !== "PARTIAL")
      checks.push({ key: "SAFETY_NET", level: "WARNING", title: "Job quét lại & ghi đơn", detail: `Lượt cuối ${s.followup.lastStatus}: ${(s.followup.lastError ?? "").slice(0, 160)}` });
    else checks.push({ key: "SAFETY_NET", level: "OK", title: "Job quét lại & ghi đơn", detail: `Lượt cuối cách đây ${fmtMin(age)}.` });
  }

  // 7. GHI ĐƠN TỪ HỘI THOẠI.
  if (s.orderSyncEnabled) {
    const o = s.orderSync;
    const syncBroken = o.errorsInWindow > 0 && o.lastErrorAt !== null && (o.lastOkAt === null || Date.parse(o.lastErrorAt) > Date.parse(o.lastOkAt));
    if (syncBroken && errorAfterOk && needsHuman)
      checks.push({ key: "ORDER_SYNC", level: "CRITICAL", title: "AI ghi đơn từ hội thoại", detail: `Provider AI hỏng (${p.lastErrorLabel ?? "?"}) — máy KHÔNG ghi được đơn từ hội thoại nhân viên chốt.` });
    else if (syncBroken)
      checks.push({ key: "ORDER_SYNC", level: "WARNING", title: "AI ghi đơn từ hội thoại", detail: `${o.errorsInWindow} lượt ghi đơn lỗi trong ${slo.providerWindowMinutes} phút, chưa lượt nào thành công sau đó (lượt sau tự đọc lại).` });
    else checks.push({ key: "ORDER_SYNC", level: "OK", title: "AI ghi đơn từ hội thoại", detail: s.orderSyncErrors24h ? `${s.orderSyncErrors24h} lượt lỗi trong 24 giờ, đã hồi phục.` : "Không lỗi trong 24 giờ." });
  }

  const worst = checks.reduce<HealthLevel>((w, c) => (rank[c.level] > rank[w] ? c.level : w), "OK");
  let status: SalesHealthStatus;
  if (!aiActive && !s.orderSyncEnabled) status = "OFF";
  else if (worst === "CRITICAL") status = "RED";
  else if (worst === "WARNING") status = "YELLOW";
  else if (worst === "UNKNOWN" && checks.every((c) => c.level !== "OK")) status = "UNKNOWN";
  else status = "GREEN";
  const top = [...checks].sort((a, b) => rank[b.level] - rank[a.level])[0];
  const headline =
    status === "OFF" ? "AI bán hàng đang TẮT (chủ shop tắt)." : status === "GREEN" ? "AI bán hàng đang chạy bình thường." : status === "UNKNOWN" ? "Chưa đủ dữ liệu để kết luận." : `${top.title}: ${top.detail}`;
  return { status, checks, headline };
}

/** Khoá các kiểm đang ở mức ≥ CẢNH BÁO — dùng để biết có kiểm MỚI xấu đi (báo ngay) hay vẫn là sự cố cũ (nhắc theo khung). */
export function badCheckKeys(h: SalesHealth): string[] {
  return h.checks
    .filter((c) => c.level === "WARNING" || c.level === "CRITICAL")
    .map((c) => `${c.key}:${c.level}`)
    .sort();
}

export type HealthAlertDecision = { kind: "NONE" } | { kind: "ALERT"; reason: "NEW_PROBLEM" | "REMINDER"; dedupe: string } | { kind: "RECOVERED"; dedupe: string };

/**
 * Báo khi nào — HÀM THUẦN. Báo NGAY khi có kiểm mới xấu đi (khoá chưa có ở lần trước); đang ĐỎ thì nhắc lại mỗi
 * `remindEveryMinutes` (khoá chống trùng theo khung giờ — gọi lại bao nhiêu lần trong khung vẫn là MỘT tin); trở lại XANH
 * sau khi từng vàng/đỏ ⇒ MỘT tin "đã hồi phục". Vàng kéo dài không nhắc lại (đã báo một lần là đủ — tránh nhờn).
 */
export function decideHealthAlert(prev: { status: SalesHealthStatus; bad: string[]; since: string } | null, cur: SalesHealth, now: Date, remindEveryMinutes: number): HealthAlertDecision {
  const bad = badCheckKeys(cur);
  const prevBad = new Set(prev?.bad ?? []);
  const fresh = bad.filter((k) => !prevBad.has(k));
  const bucket = Math.floor(now.getTime() / (remindEveryMinutes * 60_000));
  if (fresh.length) return { kind: "ALERT", reason: "NEW_PROBLEM", dedupe: `sales-health:new:${fresh.join(",")}:${bucket}` };
  if (cur.status === "RED") return { kind: "ALERT", reason: "REMINDER", dedupe: `sales-health:remind:${bad.join(",")}:${bucket}` };
  if (cur.status === "GREEN" && prev && (prev.status === "RED" || prev.status === "YELLOW")) return { kind: "RECOVERED", dedupe: `sales-health:ok:${prev.since}` };
  return { kind: "NONE" };
}

export const STATUS_DOT: Record<SalesHealthStatus, string> = { GREEN: "🟢", YELLOW: "🟡", RED: "🔴", UNKNOWN: "⚪", OFF: "⚫" };
export const STATUS_LABEL: Record<SalesHealthStatus, string> = { GREEN: "Đang chạy", YELLOW: "Cảnh báo", RED: "Đang hỏng", UNKNOWN: "Chưa đủ dữ liệu", OFF: "Đang tắt" };
