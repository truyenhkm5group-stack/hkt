/**
 * ───────────── SOÁT NẤC CHẠY NGẦM ─────────────
 *
 * Màn hình này trả lời một câu hỏi: **máy có làm được việc như nhân viên không.** Vì thế đơn vị
 * hiển thị là LƯỢT, không phải tin nhắn: một lượt = một tin của khách + mọi tin shop trả lời cho
 * tới tin tiếp theo của khách.
 *
 * Cấu trúc lượt được DỰNG LẠI LÚC ĐỌC từ `sales_messages`, không lưu sẵn. Lý do: nhân viên trả
 * lời bằng mấy tin liền là chuyện thường, đôi khi không trả lời tin nào, đôi khi trả lời muộn hơn
 * một lượt khách mới. Một cột "câu trả lời" lưu sẵn sẽ đúng hôm nay và sai vào đúng hôm hội thoại
 * có hình dạng lạ.
 *
 * ĐỘ CHÍNH XÁC CHỈ TÍNH TRÊN PHẦN ĐÃ CHẤM TAY. Không dòng nào ở đây tự sinh sự thật nền; tỷ lệ
 * luôn đi kèm ĐỘ PHỦ để không ai đọc "95% đúng" mà không thấy nó tính trên 20 lượt trong 4.000.
 */
import { and, asc, count, desc, eq, gte, isNotNull, lte, ne, sql, type SQL } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { SalesStage } from "@/lib/constants/sales-agent";
import type { SenderType } from "@/lib/constants/sales-ingest";

export type ShadowTurnFilters = {
  from?: Date | null;
  to?: Date | null;
  conversationId?: string;
  /** Lọc theo mã sản phẩm máy nhận ra trong lượt. */
  productId?: string;
  /** Lọc theo một ý định bóc được. */
  intent?: string;
  /** Chỉ hội thoại đã / chưa chuyển người. */
  humanTakeover?: boolean;
  /** Chỉ lượt có lỗi. */
  hasError?: boolean;
  /** Có / không có câu gợi ý. */
  hasSuggestion?: boolean;
  /** Đã chấm tay hay chưa. */
  reviewed?: boolean;
  limit?: number;
};

export type ShadowTurn = {
  suggestionId: string;
  runId: string | null;
  conversationId: string;
  conversationExternalId: string;
  customerName: string;
  createdAt: Date;
  /** Tin khách đã kích hoạt lượt. */
  customerMessage: string;
  customerMessageAt: Date | null;
  intents: string[];
  entities: Record<string, unknown>;
  stageBefore: string;
  stageAfter: string;
  action: string;
  decisionReason: string;
  suggestedReply: string;
  confidence: number | null;
  /** Câu nhân viên trả lời (câu đầu của lượt) + số tin + thời gian phản hồi. */
  humanReply: string;
  humanReplyCount: number;
  humanResponseSeconds: number | null;
  sent: boolean;
  toolCalls: number;
  deniedCalls: number;
  model: string;
  tier: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  costVnd: number | null;
  pricingVersion: string;
  latencyMs: number;
  error: string | null;
  humanTakeoverAt: Date | null;
  /** Đã chấm tay chưa (null = chưa). */
  reviewedAt: Date | null;
  labelSummary: string;
};

export async function listShadowTurns(filters: ShadowTurnFilters = {}): Promise<ShadowTurn[]> {
  const db = await getDb();
  const s = schema.salesSuggestions;
  const r = schema.aiRuns;
  const c = schema.salesConversations;
  const l = schema.salesReviewLabels;

  const conds: (SQL | undefined)[] = [
    filters.from ? gte(s.createdAt, filters.from) : undefined,
    filters.to ? lte(s.createdAt, filters.to) : undefined,
    filters.conversationId ? eq(s.conversationId, filters.conversationId) : undefined,
    filters.humanTakeover === true ? isNotNull(c.humanTakeoverAt) : undefined,
    filters.humanTakeover === false ? sql`${c.humanTakeoverAt} is null` : undefined,
    filters.hasError === true ? isNotNull(r.error) : undefined,
    filters.hasSuggestion === true ? ne(s.suggestedReply, "") : undefined,
    filters.hasSuggestion === false ? eq(s.suggestedReply, "") : undefined,
    filters.reviewed === true ? isNotNull(l.reviewedAt) : undefined,
    filters.reviewed === false ? sql`${l.reviewedAt} is null` : undefined,
    filters.productId ? sql`${r.stateAfter}->>'productId' = ${filters.productId}` : undefined,
    filters.intent ? sql`${r.understanding}->'intents' @> ${JSON.stringify([filters.intent])}::jsonb` : undefined,
  ];

  const rows = await db
    .select({
      suggestionId: s.id,
      runId: s.runId,
      conversationId: s.conversationId,
      conversationExternalId: c.externalId,
      customerName: c.customerName,
      createdAt: s.createdAt,
      stageBefore: s.stageBefore,
      stageAfter: s.stageAfter,
      action: s.action,
      suggestedReply: s.suggestedReply,
      confidence: s.confidence,
      humanReply: s.humanReply,
      humanReplyCount: s.humanReplyCount,
      humanResponseSeconds: s.humanResponseSeconds,
      sent: s.sent,
      humanTakeoverAt: c.humanTakeoverAt,
      customerMessage: sql<string>`coalesce((select m.text from sales_messages m where m.id = ${s.triggerMessageId}), '')`,
      customerMessageAt: sql<Date | null>`(select m.sent_at from sales_messages m where m.id = ${s.triggerMessageId})`,
      understanding: r.understanding,
      decision: r.decision,
      tier: r.tier,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      cachedInputTokens: r.cachedInputTokens,
      costVnd: r.costVnd,
      pricingVersion: r.pricingVersion,
      latencyMs: r.latencyMs,
      error: r.error,
      model: sql<string>`coalesce((select mc.model from ai_model_calls mc where mc.run_id = ${r.id} order by mc.created_at desc limit 1), '')`,
      toolCalls: sql<number>`(select count(*) from ai_tool_calls tc where tc.run_id = ${r.id})`,
      deniedCalls: sql<number>`(select count(*) from ai_tool_calls tc where tc.run_id = ${r.id} and tc.outcome = 'DENIED')`,
      reviewedAt: l.reviewedAt,
      labelProduct: l.productOk,
      labelIntent: l.intentOk,
      labelAction: l.nextActionQuality,
      labelHallucination: l.hallucination,
    })
    .from(s)
    .innerJoin(c, eq(c.id, s.conversationId))
    .leftJoin(r, eq(r.id, s.runId))
    .leftJoin(l, eq(l.suggestionId, s.id))
    .where(and(...conds.filter(Boolean)))
    .orderBy(desc(s.createdAt))
    .limit(Math.min(filters.limit ?? 100, 500));

  return rows.map((row) => {
    const understanding = (row.understanding ?? {}) as Record<string, unknown>;
    const decision = (row.decision ?? {}) as Record<string, unknown>;
    const marks: string[] = [];
    if (row.labelProduct === false) marks.push("sản phẩm sai");
    if (row.labelIntent === false) marks.push("ý định sai");
    if (row.labelHallucination === true) marks.push("bịa / phá luật");
    if (row.labelAction) marks.push(`hành động: ${row.labelAction}`);
    return {
      suggestionId: row.suggestionId,
      runId: row.runId,
      conversationId: row.conversationId,
      conversationExternalId: row.conversationExternalId,
      customerName: row.customerName,
      createdAt: row.createdAt,
      customerMessage: row.customerMessage ?? "",
      customerMessageAt: row.customerMessageAt ?? null,
      intents: Array.isArray(understanding.intents) ? (understanding.intents as string[]) : [],
      entities: (understanding.entities ?? {}) as Record<string, unknown>,
      stageBefore: row.stageBefore,
      stageAfter: row.stageAfter,
      action: row.action,
      decisionReason: String(decision.reason ?? ""),
      suggestedReply: row.suggestedReply,
      confidence: row.confidence === null ? null : Number(row.confidence),
      humanReply: row.humanReply,
      humanReplyCount: Number(row.humanReplyCount ?? 0),
      humanResponseSeconds: row.humanResponseSeconds === null ? null : Number(row.humanResponseSeconds),
      sent: Boolean(row.sent),
      toolCalls: Number(row.toolCalls ?? 0),
      deniedCalls: Number(row.deniedCalls ?? 0),
      model: row.model ?? "",
      tier: row.tier ?? "",
      inputTokens: Number(row.inputTokens ?? 0),
      outputTokens: Number(row.outputTokens ?? 0),
      cachedInputTokens: Number(row.cachedInputTokens ?? 0),
      costVnd: row.costVnd === null ? null : Number(row.costVnd),
      pricingVersion: row.pricingVersion ?? "",
      latencyMs: Number(row.latencyMs ?? 0),
      error: row.error,
      humanTakeoverAt: row.humanTakeoverAt,
      reviewedAt: row.reviewedAt,
      labelSummary: marks.join(" · "),
    };
  });
}

export type ConversationTurn = {
  triggerMessageId: string;
  customerMessage: string;
  customerMessageAt: Date | null;
  /** MỌI tin shop trả lời trong lượt — không giả định một-đổi-một. */
  shopReplies: { id: string; text: string; sentAt: Date | null; senderType: SenderType; fromName: string }[];
  suggestionId: string | null;
  suggestedReply: string;
  action: string;
  stageAfter: SalesStage | string;
};

/**
 * Dựng lại cấu trúc lượt của một hội thoại. Đây là bản ĐẦY ĐỦ: `sales_suggestions.human_reply`
 * chỉ là ảnh chụp câu đầu tiên cho bảng danh sách đọc nhanh.
 */
export async function getConversationTurns(conversationId: string): Promise<ConversationTurn[]> {
  const db = await getDb();
  const messages = await db.query.salesMessages.findMany({
    where: eq(schema.salesMessages.conversationId, conversationId),
    orderBy: [asc(schema.salesMessages.sentAt), asc(schema.salesMessages.createdAt)],
    limit: 400,
  });
  const suggestions = await db.query.salesSuggestions.findMany({
    where: eq(schema.salesSuggestions.conversationId, conversationId),
    columns: { id: true, triggerMessageId: true, suggestedReply: true, action: true, stageAfter: true },
  });
  const byTrigger = new Map(suggestions.filter((x) => x.triggerMessageId).map((x) => [x.triggerMessageId as string, x]));

  const turns: ConversationTurn[] = [];
  for (const message of messages) {
    if (!message.fromPage) {
      const suggestion = byTrigger.get(message.id);
      turns.push({
        triggerMessageId: message.id,
        customerMessage: message.text,
        customerMessageAt: message.sentAt,
        shopReplies: [],
        suggestionId: suggestion?.id ?? null,
        suggestedReply: suggestion?.suggestedReply ?? "",
        action: suggestion?.action ?? "",
        stageAfter: suggestion?.stageAfter ?? "",
      });
    } else if (turns.length) {
      // Tin của shop thuộc về lượt đang mở. Tin shop trước tin khách đầu tiên không thuộc lượt nào
      // — bỏ qua thay vì gán bừa vào lượt kế tiếp.
      turns[turns.length - 1].shopReplies.push({
        id: message.id,
        text: message.text,
        sentAt: message.sentAt,
        senderType: message.senderType as SenderType,
        fromName: message.fromName,
      });
    }
  }
  return turns;
}

/** Một chiều đo được chấm tay: đúng bao nhiêu trên bao nhiêu ĐÃ CHẤM, và độ phủ. */
export type LabelledMetric = { key: string; label: string; reviewed: number; correct: number; accuracy: number | null };

export type ShadowMetrics = {
  /** Đo được KHÔNG cần chấm tay. */
  turns: number;
  conversations: number;
  withSuggestion: number;
  handoffs: number;
  handoffRate: number | null;
  sentToCustomer: number;
  errors: number;
  medianLatencyMs: number;
  p90LatencyMs: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  costVnd: number | null;
  unpricedRuns: number;
  costPerConversationVnd: number | null;
  humanRepliedTurns: number;
  medianHumanResponseSeconds: number | null;
  /** Cần chấm tay — chỉ tính trên phần đã chấm. */
  reviewed: number;
  reviewCoverage: number | null;
  labelled: LabelledMetric[];
  hallucinations: number;
};

const LABEL_FIELDS: { key: keyof typeof schema.salesReviewLabels.$inferSelect; label: string }[] = [
  { key: "productOk", label: "Nhận đúng sản phẩm" },
  { key: "colorOk", label: "Nhận đúng màu" },
  { key: "sizeOk", label: "Nhận đúng size / số đo" },
  { key: "phoneOk", label: "Nhận đúng số điện thoại" },
  { key: "addressOk", label: "Nhận đúng địa chỉ" },
  { key: "intentOk", label: "Nhận đúng ý định" },
  { key: "purchaseIntentOk", label: "Nhận đúng ý muốn mua" },
  { key: "confirmationOk", label: "Nhận đúng xác nhận chốt đơn" },
  { key: "replyUsable", label: "Câu gợi ý dùng được" },
];

export async function shadowMetrics(days = 7): Promise<ShadowMetrics> {
  const db = await getDb();
  const since = new Date(Date.now() - Math.min(Math.max(days, 1), 90) * 86_400_000);
  const s = schema.salesSuggestions;
  const r = schema.aiRuns;
  const l = schema.salesReviewLabels;

  const [base] = await db
    .select({
      turns: count(),
      conversations: sql<number>`count(distinct ${s.conversationId})`,
      withSuggestion: sql<number>`count(*) filter (where ${s.suggestedReply} <> '')`,
      sent: sql<number>`count(*) filter (where ${s.sent})`,
      humanReplied: sql<number>`count(*) filter (where ${s.humanRepliedAt} is not null)`,
      medianHuman: sql<number | null>`percentile_cont(0.5) within group (order by ${s.humanResponseSeconds}) filter (where ${s.humanResponseSeconds} is not null)`,
    })
    .from(s)
    .where(gte(s.createdAt, since));

  const [runs] = await db
    .select({
      handoffs: sql<number>`count(*) filter (where ${r.status} = 'HANDED_OFF')`,
      total: count(),
      errors: sql<number>`count(*) filter (where ${r.error} is not null)`,
      median: sql<number>`coalesce(percentile_cont(0.5) within group (order by ${r.latencyMs}), 0)`,
      p90: sql<number>`coalesce(percentile_cont(0.9) within group (order by ${r.latencyMs}), 0)`,
      input: sql<number>`coalesce(sum(${r.inputTokens}), 0)`,
      output: sql<number>`coalesce(sum(${r.outputTokens}), 0)`,
      cached: sql<number>`coalesce(sum(${r.cachedInputTokens}), 0)`,
      cost: sql<number>`coalesce(sum(${r.costVnd}), 0)`,
      unpriced: sql<number>`count(*) filter (where ${r.costVnd} is null)`,
    })
    .from(r)
    .where(and(gte(r.startedAt, since), eq(r.subjectType, "CONVERSATION")));

  const [labels] = await db
    .select({
      reviewed: sql<number>`count(*) filter (where ${l.reviewedAt} is not null)`,
      hallucinations: sql<number>`count(*) filter (where ${l.hallucination})`,
      ...Object.fromEntries(
        LABEL_FIELDS.map((f) => [
          `${String(f.key)}_n`,
          sql<number>`count(*) filter (where ${l[f.key as "productOk"]} is not null)`,
        ]),
      ),
      ...Object.fromEntries(
        LABEL_FIELDS.map((f) => [`${String(f.key)}_ok`, sql<number>`count(*) filter (where ${l[f.key as "productOk"]})`]),
      ),
    })
    .from(l)
    .where(gte(l.createdAt, since));

  const labelRow = labels as unknown as Record<string, number>;
  const labelled: LabelledMetric[] = LABEL_FIELDS.map((f) => {
    const reviewed = Number(labelRow[`${String(f.key)}_n`] ?? 0);
    const correct = Number(labelRow[`${String(f.key)}_ok`] ?? 0);
    return {
      key: String(f.key),
      label: f.label,
      reviewed,
      correct,
      // Chưa chấm ô nào ⇒ CHƯA BIẾT. Không bao giờ in 0% cho một chiều chưa ai chấm.
      accuracy: reviewed > 0 ? (correct / reviewed) * 100 : null,
    };
  });

  const turns = Number(base?.turns ?? 0);
  const runTotal = Number(runs?.total ?? 0);
  const conversations = Number(base?.conversations ?? 0);
  const unpriced = Number(runs?.unpriced ?? 0);
  const cost = unpriced > 0 ? null : Number(runs?.cost ?? 0);
  const reviewed = Number(labels?.reviewed ?? 0);
  return {
    turns,
    conversations,
    withSuggestion: Number(base?.withSuggestion ?? 0),
    handoffs: Number(runs?.handoffs ?? 0),
    handoffRate: runTotal > 0 ? (Number(runs?.handoffs ?? 0) / runTotal) * 100 : null,
    sentToCustomer: Number(base?.sent ?? 0),
    errors: Number(runs?.errors ?? 0),
    medianLatencyMs: Math.round(Number(runs?.median ?? 0)),
    p90LatencyMs: Math.round(Number(runs?.p90 ?? 0)),
    inputTokens: Number(runs?.input ?? 0),
    outputTokens: Number(runs?.output ?? 0),
    cachedInputTokens: Number(runs?.cached ?? 0),
    costVnd: cost,
    unpricedRuns: unpriced,
    costPerConversationVnd: cost !== null && conversations > 0 ? Math.round(cost / conversations) : null,
    humanRepliedTurns: Number(base?.humanReplied ?? 0),
    medianHumanResponseSeconds: base?.medianHuman === null || base?.medianHuman === undefined ? null : Math.round(Number(base.medianHuman)),
    reviewed,
    reviewCoverage: turns > 0 ? (reviewed / turns) * 100 : null,
    labelled,
    hallucinations: Number(labels?.hallucinations ?? 0),
  };
}
