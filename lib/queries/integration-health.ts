import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { memo } from "@/lib/cache";
import { CARRIER_DOCUMENT_SOURCES, sqlSourceList } from "@/lib/constants/truth";

/**
 * ───────────── SỨC KHOẺ TÍCH HỢP ─────────────
 *
 * Một tích hợp chết âm thầm là chuyện đã xảy ra thật: tài khoản API Viettel Post không sở hữu vận
 * đơn do Pancake tạo, nhưng mỗi lần chạy vẫn ghi SUCCESS với "cập nhật 0", nên việc đối chiếu chết
 * suốt nhiều ngày mà không ai biết.
 *
 * Bảng này trả lời cùng một bộ câu hỏi cho MỌI connector, thay vì chỉ Viettel Post có (F8):
 * còn kết nối không · nhận tin lần cuối lúc nào · xử lý thành công lần cuối lúc nào · trễ bao lâu ·
 * đối chiếu lần cuối · bao nhiêu sự kiện mỗi giờ · bao nhiêu gói tin lỗi / chưa xử lý được ·
 * bên gửi phải gửi lại bao nhiêu lần · còn bao nhiêu trạng thái ERP chưa hiểu.
 *
 * BỐN MỨC, và mức phải nói đúng sự thật:
 *  · HEALTHY  — dữ liệu đang chảy, không có gói tin kẹt;
 *  · DEGRADED — vẫn chảy nhưng có phần hỏng (gói tin lỗi, trạng thái lạ, đối chiếu thất bại);
 *  · DOWN     — không nhận được gì trong ngưỡng mong đợi, hoặc lần chạy gần nhất thất bại;
 *  · UNKNOWN  — CHƯA ĐỦ CĂN CỨ để nói (chưa từng chạy, chưa cấu hình). Không được coi là HEALTHY.
 */

export type HealthState = "HEALTHY" | "DEGRADED" | "DOWN" | "UNKNOWN";

export const HEALTH_LABEL: Record<HealthState, string> = {
  HEALTHY: "Đang chạy tốt",
  DEGRADED: "Chạy nhưng có lỗi",
  DOWN: "Không nhận được dữ liệu",
  UNKNOWN: "Chưa đủ căn cứ",
};

export const HEALTH_TONE: Record<HealthState, string> = {
  HEALTHY: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300",
  DEGRADED: "bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300",
  DOWN: "bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300",
  UNKNOWN: "bg-muted text-muted-foreground",
};

export type ConnectorKey = "PANCAKE" | "VIETTELPOST" | "FACEBOOK" | "BANK";

export const CONNECTOR_LABEL: Record<ConnectorKey, string> = {
  PANCAKE: "Pancake POS",
  VIETTELPOST: "Viettel Post",
  FACEBOOK: "Facebook Ads",
  BANK: "Sổ ngân hàng / bảng kê",
};

export type ConnectorHealth = {
  key: ConnectorKey;
  label: string;
  state: HealthState;
  /** Vì sao lại xếp vào mức đó — luôn phải nói được. */
  reason: string;
  /** Gói tin / sự kiện nhận được gần nhất. */
  lastEventAt: Date | null;
  /** Lần XỬ LÝ THÀNH CÔNG gần nhất — khác hẳn "lần nhận gần nhất". */
  lastProcessedAt: Date | null;
  /** Trễ (giờ) kể từ lần nhận gần nhất. `null` = chưa từng nhận gì. */
  lagHours: number | null;
  /** Lần đối chiếu (job) gần nhất và kết quả. */
  lastReconciliation: { at: Date | null; status: string | null; detail: string | null } | null;
  /** Số sự kiện mỗi giờ, tính trên 24h gần nhất. */
  eventsPerHour: number;
  events24h: number;
  /** Gói tin xử lý lỗi. */
  failed: number;
  /** Gói tin nhận được nhưng chưa áp dụng được (chưa tìm ra đơn / vận đơn). */
  unprocessed: number;
  /** Số lần bên gửi phải gửi lại (ngoài lần đầu). */
  retries: number;
  /**
   * TỪNG BÊN GỬI vào cùng một điểm nhận.
   *
   * Viettel Post đẩy hành trình qua HAI đường: gửi thẳng từ VTP Partner, và Poscake chuyển tiếp
   * nguyên văn. Gộp chung thì con số "vẫn có dữ liệu" che mất việc một đường đã chết — chính xác
   * điều đã xảy ra: đường Poscake bị 401 suốt gần ba ngày trong khi VTP Partner thỉnh thoảng gửi
   * gói tin TEST, nên tổng số vẫn khác 0 và không ai nhận ra.
   */
  senders?: { label: string; lastAt: Date | null; events24h: number }[];
  /**
   * Viettel Post: vận đơn đang chạy theo NĂNG LỰC tra cứu. `webhookOnly` là vận đơn Pancake tạo mà
   * tài khoản API hiện tại không đọc được — chúng KHOẺ theo webhook, không kéo mức sức khoẻ xuống
   * (chủ shop chốt 11/09/2026). Chỉ `apiTrackable` mới phải đối chiếu được qua API.
   */
  capability?: { apiTrackable: number; webhookOnly: number; unknown: number };
  /** Trạng thái / mã ERP chưa có trong bảng ánh xạ. */
  unknownMappings: number;
  /**
   * Có được bấm "xử lý lại" không. CHỈ khi luồng nạp dữ liệu là idempotent — chạy lại nhiều lần
   * cho cùng kết quả. Không idempotent mà cho retry là mời gọi nhân đôi dữ liệu.
   */
  canReprocess: boolean;
  reprocessHint: string;
};

/** Ngưỡng "quá lâu không nhận được gì" của từng connector, theo nhịp thật của nó. */
const SILENCE_HOURS: Record<ConnectorKey, number> = {
  PANCAKE: 24,
  VIETTELPOST: 24,
  // Chi tiêu quảng cáo kéo theo giờ nhưng có ngày shop không chạy quảng cáo.
  FACEBOOK: 48,
  // Bảng kê về theo đợt, vài ngày một lần.
  BANK: 24 * 10,
};

const DOC_SOURCES = sqlSourceList(CARRIER_DOCUMENT_SOURCES);

async function webhookStats(source: string) {
  const db = await getDb();
  const since24 = new Date(Date.now() - 24 * 3600_000);
  const [row] = await db
    .select({
      lastAt: sql<Date | null>`max(${schema.webhookEvents.receivedAt})`,
      lastProcessed: sql<Date | null>`max(${schema.webhookEvents.processedAt}) filter (where ${schema.webhookEvents.status} = 'PROCESSED')`,
      events24h: sql<number>`count(*) filter (where ${schema.webhookEvents.receivedAt} >= ${since24})`,
      failed: sql<number>`count(*) filter (where ${schema.webhookEvents.status} = 'FAILED')`,
      unprocessed: sql<number>`count(*) filter (where ${schema.webhookEvents.status} = 'IGNORED' and ${schema.webhookEvents.error} ilike '%không tìm thấy%')`,
      retries: sql<number>`coalesce(sum(${schema.webhookEvents.deliveryCount} - 1), 0)`,
    })
    .from(schema.webhookEvents)
    .where(eq(schema.webhookEvents.source, source));
  return row;
}

async function lastRun(source: string) {
  const db = await getDb();
  const row = await db.query.syncRuns.findFirst({
    where: and(eq(schema.syncRuns.source, source), isNotNull(schema.syncRuns.finishedAt)),
    orderBy: [desc(schema.syncRuns.finishedAt)],
    columns: { status: true, detail: true, error: true, finishedAt: true },
  });
  return row ?? null;
}

/** Xếp mức sức khoẻ. Thiếu căn cứ thì UNKNOWN — tuyệt đối không mặc định HEALTHY. */
function classify(input: {
  key: ConnectorKey;
  lastEventAt: Date | null;
  lastRunStatus: string | null;
  failed: number;
  unprocessed: number;
  unknownMappings: number;
  configured: boolean;
}): { state: HealthState; reason: string; lagHours: number | null } {
  if (!input.configured) return { state: "UNKNOWN", reason: "Chưa cấu hình kết nối này.", lagHours: null };
  if (!input.lastEventAt && !input.lastRunStatus) return { state: "UNKNOWN", reason: "Chưa từng nhận dữ liệu và chưa từng chạy đối chiếu — không đủ căn cứ để kết luận.", lagHours: null };

  const lagHours = input.lastEventAt ? (Date.now() - input.lastEventAt.getTime()) / 3600_000 : null;
  const silence = SILENCE_HOURS[input.key];

  if (input.lastRunStatus === "FAILED") {
    return { state: "DOWN", reason: "Lần chạy đối chiếu gần nhất thất bại.", lagHours };
  }
  if (lagHours === null) {
    return { state: "DEGRADED", reason: "Có chạy đối chiếu nhưng chưa nhận được sự kiện nào.", lagHours };
  }
  if (lagHours > silence) {
    return { state: "DOWN", reason: `Không nhận được gì trong ${Math.floor(lagHours)} giờ (ngưỡng ${silence} giờ).`, lagHours };
  }
  if (input.failed > 0 || input.unprocessed > 0 || input.unknownMappings > 0) {
    const parts = [
      input.failed ? `${input.failed} gói tin xử lý lỗi` : "",
      input.unprocessed ? `${input.unprocessed} gói tin chưa khớp được đơn` : "",
      input.unknownMappings ? `${input.unknownMappings} trạng thái ERP chưa hiểu` : "",
    ].filter(Boolean);
    return { state: "DEGRADED", reason: `Dữ liệu vẫn về nhưng ${parts.join(" · ")}.`, lagHours };
  }
  if (input.lastRunStatus === "PARTIAL") {
    return { state: "DEGRADED", reason: "Đối chiếu gần nhất chỉ chạy được một phần.", lagHours };
  }
  return { state: "HEALTHY", reason: `Dữ liệu về đều, gần nhất cách đây ${Math.max(0, Math.floor(lagHours))} giờ.`, lagHours };
}

async function connectorsUncached(): Promise<ConnectorHealth[]> {
  const db = await getDb();
  const [pancake, vtp] = await Promise.all([webhookStats("PANCAKE"), webhookStats("VIETTELPOST")]);
  const [pancakeRun, vtpRun, fbRun] = await Promise.all([lastRun("PANCAKE"), lastRun("VIETTELPOST"), lastRun("FACEBOOK")]);

  // Trạng thái ĐVVC ERP chưa hiểu — chỉ có nghĩa với Viettel Post.
  const [{ n: unknownVtp }] = await db
    .select({ n: sql<number>`count(distinct ${schema.shipmentEvents.status})` })
    .from(schema.shipmentEvents)
    .where(sql`${schema.shipmentEvents.source} in (${sql.raw(DOC_SOURCES)}) and (${schema.shipmentEvents.normalizedStage} is null or ${schema.shipmentEvents.normalizedStage} = 'UNKNOWN')`);

  // Facebook: không có webhook, "sự kiện" là dòng chi tiêu kéo về.
  const since24 = new Date(Date.now() - 24 * 3600_000);
  const [fbRow] = await db
    .select({
      lastAt: sql<Date | null>`max(${schema.adSpends.spendDate})`,
      events24h: sql<number>`count(*) filter (where ${schema.adSpends.spendDate} >= ${since24})`,
      total: sql<number>`count(*)`,
    })
    .from(schema.adSpends);

  // Bảng kê / sổ ngân hàng: "sự kiện" là tệp bảng kê đã nhận.
  const [bankRow] = await db
    .select({
      lastAt: sql<Date | null>`max(${schema.vtpStatementFiles.receivedAt})`,
      events24h: sql<number>`count(*) filter (where ${schema.vtpStatementFiles.receivedAt} >= ${since24})`,
      total: sql<number>`count(*)`,
    })
    .from(schema.vtpStatementFiles);

  const build = (
    key: ConnectorKey,
    stats: { lastEventAt: Date | null; lastProcessedAt: Date | null; events24h: number; failed: number; unprocessed: number; retries: number; unknownMappings: number },
    run: { status: string; detail: string | null; error: string | null; finishedAt: Date | null } | null,
    configured: boolean,
    reprocess: { can: boolean; hint: string },
  ): ConnectorHealth => {
    const { state, reason, lagHours } = classify({
      key,
      lastEventAt: stats.lastEventAt,
      lastRunStatus: run?.status ?? null,
      failed: stats.failed,
      unprocessed: stats.unprocessed,
      unknownMappings: stats.unknownMappings,
      configured,
    });
    return {
      key,
      label: CONNECTOR_LABEL[key],
      state,
      reason,
      lastEventAt: stats.lastEventAt,
      lastProcessedAt: stats.lastProcessedAt,
      lagHours: lagHours === null ? null : Math.round(lagHours * 10) / 10,
      lastReconciliation: run ? { at: run.finishedAt, status: run.status, detail: run.detail ?? run.error } : null,
      eventsPerHour: Math.round((stats.events24h / 24) * 10) / 10,
      events24h: stats.events24h,
      failed: stats.failed,
      unprocessed: stats.unprocessed,
      retries: stats.retries,
      unknownMappings: stats.unknownMappings,
      canReprocess: reprocess.can,
      reprocessHint: reprocess.hint,
    };
  };

  const asDate = (v: Date | string | null | undefined) => (v ? new Date(v) : null);

  // Tách theo `user-agent`: Poscake dùng client riêng, còn Viettel Post Partner gửi bằng Apache
  // HttpClient. Không đoán theo nội dung gói tin — chữ ký của bên gửi là bằng chứng chắc hơn.
  const senderRows = await db
    .select({
      ua: sql<string>`coalesce(${schema.webhookEvents.headers}->>'user-agent', '(không rõ)')`,
      lastAt: sql<Date | null>`max(${schema.webhookEvents.receivedAt})`,
      events24h: sql<number>`count(*) filter (where ${schema.webhookEvents.receivedAt} >= ${since24})`,
    })
    .from(schema.webhookEvents)
    .where(eq(schema.webhookEvents.source, "VIETTELPOST"))
    .groupBy(sql`coalesce(${schema.webhookEvents.headers}->>'user-agent', '(không rõ)')`);
  const senderLabel = (ua: string) =>
    /apache|java/i.test(ua) ? "Viettel Post gửi thẳng" : /mint|pancake|poscake/i.test(ua) ? "Poscake chuyển tiếp" : `Khác · ${ua.slice(0, 24)}`;
  const senders = senderRows
    .map((r) => ({ label: senderLabel(r.ua), lastAt: asDate(r.lastAt), events24h: Number(r.events24h) }))
    .sort((a, b) => b.events24h - a.events24h);

  // NĂNG LỰC TRA CỨU của vận đơn đang chạy — cùng phép đếm với `viettelPostHealth()`.
  const capRows = await db
    .select({ capability: schema.shipments.trackingCapability, n: sql<number>`count(*)` })
    .from(schema.shipments)
    .where(and(eq(schema.shipments.isFinal, false), isNotNull(schema.shipments.vtpOrderNumber)))
    .groupBy(schema.shipments.trackingCapability);
  const capability = { apiTrackable: 0, webhookOnly: 0, unknown: 0 };
  for (const r of capRows) {
    if (r.capability === "API_TRACKABLE") capability.apiTrackable += Number(r.n);
    else if (r.capability === "WEBHOOK_ONLY") capability.webhookOnly += Number(r.n);
    else capability.unknown += Number(r.n);
  }

  const vtpHealth = build(
      "VIETTELPOST",
      {
        lastEventAt: asDate(vtp?.lastAt),
        lastProcessedAt: asDate(vtp?.lastProcessed),
        events24h: Number(vtp?.events24h ?? 0),
        failed: Number(vtp?.failed ?? 0),
        unprocessed: Number(vtp?.unprocessed ?? 0),
        retries: Number(vtp?.retries ?? 0),
        unknownMappings: Number(unknownVtp ?? 0),
      },
      vtpRun,
      true,
      { can: true, hint: "Xử lý lại an toàn: sự kiện chống trùng theo vận đơn + nguồn + trạng thái + mốc ĐVVC, và trạng thái được dựng lại từ lịch sử." },
  );

  // Khoẻ theo năng lực: nói rõ phần vận đơn ngoài phạm vi API để không ai đọc "API không thấy" thành "hỏng".
  const vtpReason =
    vtpHealth.state === "HEALTHY" && capability.webhookOnly > 0
      ? `${vtpHealth.reason} ${capability.webhookOnly} vận đơn đang chạy chỉ nhận webhook (ngoài phạm vi tài khoản API) — khoẻ theo năng lực của chúng; ${capability.apiTrackable} vận đơn đối chiếu qua API.`
      : vtpHealth.reason;

  return [
    { ...vtpHealth, reason: vtpReason, senders, capability },
    build(
      "PANCAKE",
      {
        lastEventAt: asDate(pancake?.lastAt),
        lastProcessedAt: asDate(pancake?.lastProcessed),
        events24h: Number(pancake?.events24h ?? 0),
        failed: Number(pancake?.failed ?? 0),
        unprocessed: Number(pancake?.unprocessed ?? 0),
        retries: Number(pancake?.retries ?? 0),
        unknownMappings: 0,
      },
      pancakeRun,
      true,
      { can: true, hint: "Xử lý lại an toàn: đơn upsert theo id Pancake, gói tin cũ không đè dữ liệu mới." },
    ),
    build(
      "FACEBOOK",
      {
        lastEventAt: asDate(fbRow?.lastAt),
        lastProcessedAt: fbRun?.finishedAt ?? null,
        events24h: Number(fbRow?.events24h ?? 0),
        failed: 0,
        unprocessed: 0,
        retries: 0,
        unknownMappings: 0,
      },
      fbRun,
      Number(fbRow?.total ?? 0) > 0 || Boolean(fbRun),
      { can: true, hint: "Kéo lại an toàn: chi tiêu upsert theo khoá đồng bộ (tài khoản + chiến dịch + ngày)." },
    ),
    build(
      "BANK",
      {
        lastEventAt: asDate(bankRow?.lastAt),
        lastProcessedAt: asDate(bankRow?.lastAt),
        events24h: Number(bankRow?.events24h ?? 0),
        failed: 0,
        unprocessed: 0,
        retries: 0,
        unknownMappings: 0,
      },
      null,
      Number(bankRow?.total ?? 0) > 0,
      { can: true, hint: "Nhập lại an toàn: dòng bảng kê chống trùng theo kỳ chốt + mã vận đơn." },
    ),
  ];
}

export async function getIntegrationHealth(): Promise<ConnectorHealth[]> {
  return memo("integrationHealth", 60_000, connectorsUncached);
}
