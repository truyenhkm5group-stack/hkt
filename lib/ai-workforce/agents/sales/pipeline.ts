/**
 * DÂY CHUYỀN BÁN HÀNG — bốn trách nhiệm tách rời, chạy theo đúng thứ tự:
 *
 *   1. HIỂU     `understand.ts`  — luật trước, mô hình sau; đầu ra qua lược đồ.
 *   2. TRẠNG THÁI               — máy chủ KIỂM lại mọi thứ khách nói bằng công cụ ERP
 *                                 (mẫu mã có thật không, giá bao nhiêu, còn hàng không).
 *   3. QUYẾT ĐỊNH `decide.ts`   — hàm thuần; đây là chỗ duy nhất sinh ra hành động.
 *   4. DIỄN ĐẠT  `generate.ts`  — biến quyết định thành câu chữ; mô hình chỉ được đổi cách nói.
 *
 * Ở nấc SHADOW, bước 4 dừng lại ở một GỢI Ý ghi vào `sales_suggestions`. Không có nhánh nào
 * trong tệp này gọi tới `sendSalesMessage` — muốn gửi phải qua cổng `outbound.ts`, và cổng đó
 * từ chối mọi câu do AI soạn khi còn ở nấc SHADOW.
 */
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema, type Db } from "@/db";
import { getAiSettings, type AiSettings } from "@/lib/ai-workforce/config";
import { claimTask, finishTask, recordAiError, runsInLastHour } from "@/lib/ai-workforce/events";
import { parseRouting, runModelStep, type ModelAttempt } from "@/lib/ai-workforce/model-router";
import { getAgent } from "@/lib/ai-workforce/registry";
import { startRun, type RunRecorder } from "@/lib/ai-workforce/runs";
import { callTool } from "@/lib/ai-workforce/tools/gateway";
import { registerErpTools } from "@/lib/ai-workforce/tools/erp";
import { checkContextualConfirmation } from "@/lib/ai-workforce/agents/sales/confirm";
import { decide, type SalesDecision } from "@/lib/ai-workforce/agents/sales/decide";
import { generateSystemPrompt, guardGeneratedText, renderOrderReview, renderTemplate, type GenerationContext } from "@/lib/ai-workforce/agents/sales/generate";
import { bumpAsk, confirmationFingerprint, parseSalesState, parseStage, type SalesState } from "@/lib/ai-workforce/agents/sales/state";
import { mergeUnderstanding, ruleIsEnough, understandByRule, understandSystemPrompt, UNDERSTANDING_SCHEMA, type Understanding } from "@/lib/ai-workforce/agents/sales/understand";
import { resolveProduct, type ProductResolution } from "@/lib/ai-workforce/agents/sales/resolve-product";
import { learnAdMapping } from "@/lib/ai-workforce/agents/sales/ad-map";
import type { RouteTier, EscalationReason } from "@/lib/constants/ai";
import type { SizeResultCode } from "@/lib/constants/size-engine";

/** Kết quả máy gợi ý size, đúng hình dạng công cụ `size.recommend` trả về. */
export type SizeAdvice = { code: SizeResultCode; size: string | null; reason: string; needsHuman: boolean; missing: string[]; candidates: string[] };
import { nextStage, SALES_STALE_HOURS, type SalesStage } from "@/lib/constants/sales-agent";

// Nạp công cụ vào cổng ngay khi mô-đun được tải: dây chuyền không bao giờ chạy với cổng rỗng.
registerErpTools();

export type PipelineResult = {
  runId: string | null;
  status: "SUCCEEDED" | "FAILED" | "SKIPPED" | "HANDED_OFF";
  stage: SalesStage;
  action: string;
  suggestedReply: string;
  reason: string;
};

const GENERATED_SCHEMA = z.object({ text: z.string().min(1).max(1200) });

/** Đọc hội thoại + tin nhắn kích hoạt. Trả `null` nếu dữ liệu không đủ để chạy. */
async function loadContext(db: Db, conversationId: string, messageId: string | null) {
  const conversation = await db.query.salesConversations.findFirst({ where: eq(schema.salesConversations.id, conversationId) });
  if (!conversation) return null;
  const message = messageId
    ? await db.query.salesMessages.findFirst({ where: eq(schema.salesMessages.id, messageId) })
    : await db.query.salesMessages.findFirst({
        where: and(eq(schema.salesMessages.conversationId, conversationId), eq(schema.salesMessages.fromPage, false)),
        orderBy: (m, { desc: d }) => [d(m.sentAt), d(m.createdAt)],
      });
  if (!message) return null;
  return { conversation, message };
}

type ToolRunner = <T>(name: Parameters<typeof callTool>[1], args: unknown) => Promise<T | null>;

/**
 * BƯỚC 2 — TRẠNG THÁI. Mọi thứ khách nói đều bị máy chủ KIỂM lại: mẫu mã phải có thật trong ERP,
 * giá phải do `pricing.get` tính, tồn phải do sổ kho trả lời. Không có dòng nào ở đây lấy số liệu
 * từ văn bản của mô hình.
 */
async function applyUnderstanding(
  state: SalesState,
  understanding: Understanding,
  tool: ToolRunner,
  /** Kết quả của Product Resolver v2 — do `runSalesTask` giải trước, vì nó cần CSDL và tin nhắn. */
  resolution: ProductResolution | null,
): Promise<{
  state: SalesState;
  sizes: string[];
  colors: string[];
  stockKnown: boolean;
  available: number | null;
  shippingFee: number | null;
  toolFailed: boolean;
  sizeAdvice: SizeAdvice | null;
}> {
  const entities = understanding.entities;
  let next: SalesState = { ...state };
  let toolFailed = false;
  let sizes: string[] = [];
  let colors: string[] = [];
  let stockKnown = false;
  let available: number | null = null;
  let shippingFee: number | null = null;
  let sizeAdvice: SizeAdvice | null = null;

  // Ý MUỐN MUA DÍNH LẠI: đã nói một lần là còn giá trị cho các lượt sau. Gửi SĐT hoặc địa chỉ
  // cho shop trong bán hàng qua chat cũng là ý muốn mua — không ai đọc địa chỉ nhà cho người lạ.
  const intents = understanding.intents;
  if (intents.includes("PURCHASE_INTENT") || intents.includes("CONFIRM") || intents.includes("PROVIDE_CONTACT") || intents.includes("PROVIDE_ADDRESS")) {
    next.purchaseIntent = true;
  }
  // Khách nói rõ không mua nữa thì bỏ cờ đi, nếu không mọi lượt sau vẫn bị đẩy về hướng chốt đơn.
  if (intents.includes("REJECT")) next.purchaseIntent = false;

  if (entities.phone) next.phone = entities.phone;
  if (entities.address) next.address = entities.address;
  if (entities.province) next.province = entities.province;
  if (entities.quantity) next.quantity = entities.quantity;
  if (entities.size) next.size = entities.size;
  if (entities.color) next.color = entities.color;

  // 2.1 SẢN PHẨM — kết quả của Product Resolver v2 (nhiều tầng: mã hàng · bản đồ quảng cáo · câu
  //      quảng cáo · lượt trước · mã nhân viên nhắc · khớp chữ). Bản cũ chỉ có tầng khớp chữ và
  //      trên dữ liệu thật nó ra rỗng 36/36 lần: khách bấm quảng cáo rồi nhắn "còn hàng không ạ",
  //      trong câu ấy không có gì để khớp.
  //
  //      Dưới ngưỡng tin cậy thì KHÔNG nhận — `resolveProduct` đã trả `productId = null` sẵn.
  if (!next.productId && resolution?.productId) {
    next.productId = resolution.productId;
    next.productName = resolution.productName;
    if (resolution.variantId) next.variantId = resolution.variantId;
  }

  // 2.2 Mẫu mã của sản phẩm: size / màu có bao nhiêu lựa chọn — dữ kiện này quyết định còn phải hỏi gì.
  if (next.productId) {
    const variants = await tool<{ variants: { variantId: string; size: string; color: string }[]; sizes: string[]; colors: string[]; needsSize: boolean; needsColor: boolean }>(
      "product.get_variants",
      { productId: next.productId },
    );
    if (variants === null) toolFailed = true;
    else {
      sizes = variants.sizes;
      colors = variants.colors;
      next.needsSize = variants.needsSize;
      next.needsColor = variants.needsColor;
      const matched = variants.variants.filter(
        (v) => (!next.size || v.size.toUpperCase() === next.size.toUpperCase()) && (!next.color || v.color.toLowerCase().includes(next.color.toLowerCase())),
      );
      // Đúng một mẫu mã khớp mới khoá; hai mẫu bằng điểm là chưa biết, phải hỏi khách.
      const sizeSettled = !variants.needsSize || Boolean(next.size);
      const colorSettled = !variants.needsColor || Boolean(next.color);
      if (matched.length === 1 && sizeSettled && colorSettled) {
        next.variantId = matched[0].variantId;
        next.variantLabel = [matched[0].size, matched[0].color].filter(Boolean).join(" ");
        next.size = matched[0].size || next.size;
        next.color = matched[0].color || next.color;
      } else if (next.variantId && !matched.some((v) => v.variantId === next.variantId)) {
        // Khách đổi ý sang size/màu khác ⇒ mẫu mã cũ không còn đúng, xoá đi thay vì giữ lại.
        next.variantId = null;
        next.variantLabel = "";
      }
    }
  }

  // 2.3 GIÁ — luôn do máy chủ tính, kể cả khi khách hay mô hình đã nói một con số.
  if (next.variantId) {
    const pricing = await tool<{ total: number; shippingFee: number; unitPrice: number; label: string }>("pricing.get", { variantId: next.variantId, quantity: next.quantity });
    if (pricing === null) toolFailed = true;
    else {
      next.quotedTotal = pricing.total;
      shippingFee = pricing.shippingFee;
      if (!next.variantLabel) next.variantLabel = pricing.label;
    }
    const stock = await tool<{ stockKnown: boolean; available: number | null; canPromise: boolean }>("inventory.check", { variantId: next.variantId });
    if (stock === null) toolFailed = true;
    else {
      stockKnown = stock.stockKnown;
      available = stock.available;
    }
  }

  // 2.3b GỢI Ý SIZE — chỉ hỏi máy khi khách thật sự nói tới size hoặc đưa số đo. Máy trả mã
  //      `SIZE_DATA_MISSING` khi ERP chưa có bảng số đo, và dây chuyền sẽ chuyển người thay vì
  //      để mô hình đoán một size trên cơ thể người thật.
  const wantsSize = understanding.intents.includes("SIZE_QUESTION") || entities.heightCm !== null || entities.weightKg !== null;
  if (wantsSize && next.productId) {
    const advice = await tool<SizeAdvice>("size.recommend", {
      variantId: next.variantId ?? undefined,
      productId: next.productId,
      heightCm: entities.heightCm,
      weightKg: entities.weightKg,
      bustCm: entities.bustCm,
      waistCm: entities.waistCm,
      hipCm: entities.hipCm,
    });
    if (advice === null) toolFailed = true;
    else {
      sizeAdvice = advice;
      // Size do BẢNG SỐ ĐO quyết định, không do mô hình nói. Chỉ nhận khi mã là OK.
      if (advice.code === "OK" && advice.size && !next.size) next.size = advice.size;
    }
  }

  // 2.4 Bản chốt đang chờ mà đơn đã đổi ⇒ huỷ bản chốt. Không được để một chữ "ok" gửi sau đó
  //     dính vào một đơn đã khác nội dung.
  if (next.pending && confirmationFingerprint(next) !== next.pending.fingerprint) next = { ...next, pending: null };

  return { state: next, sizes, colors, stockKnown, available, shippingFee, toolFailed, sizeAdvice };
}

/** Chạy nhân sự bán hàng cho MỘT việc. Không bao giờ ném — mọi thất bại đều thành một lượt chạy đọc được. */
export async function runSalesTask(taskId: string, options: { db?: Db; settings?: AiSettings } = {}): Promise<PipelineResult> {
  const db = options.db ?? (await getDb());
  const settings = options.settings ?? (await getAiSettings());
  const task = await db.query.aiTasks.findFirst({ where: eq(schema.aiTasks.id, taskId) });
  if (!task) return { runId: null, status: "SKIPPED", stage: "NEW_LEAD", action: "NO_ACTION", suggestedReply: "", reason: "Không tìm thấy việc" };

  const agent = await getAgent("sales", settings, db);
  if (!agent || agent.mode === "OFF") {
    await finishTask(taskId, "CANCELLED", "Nhân sự bán hàng đang tắt", db);
    return { runId: null, status: "SKIPPED", stage: "NEW_LEAD", action: "NO_ACTION", suggestedReply: "", reason: "Nhân sự bán hàng đang tắt" };
  }
  // Trần lượt chạy: chặn một vòng lặp tốn tiền trước khi nó kịp tốn tiền.
  const recent = await runsInLastHour(db);
  if (recent >= settings.maxRunsPerHour) {
    await finishTask(taskId, "FAILED", `Vượt trần ${settings.maxRunsPerHour} lượt/giờ`, db);
    await recordAiError({ scope: "PIPELINE", agentKey: "sales", message: `Vượt trần ${settings.maxRunsPerHour} lượt chạy mỗi giờ — dừng để không tạo vòng lặp tốn tiền` }, db);
    return { runId: null, status: "SKIPPED", stage: "NEW_LEAD", action: "NO_ACTION", suggestedReply: "", reason: "Vượt trần lượt chạy mỗi giờ" };
  }
  if (!(await claimTask(taskId, db))) {
    return { runId: null, status: "SKIPPED", stage: "NEW_LEAD", action: "NO_ACTION", suggestedReply: "", reason: "Việc đã được tiến trình khác nhận" };
  }

  const payload = (task.payload ?? {}) as Record<string, unknown>;
  const context = await loadContext(db, task.subjectId, typeof payload.messageId === "string" ? payload.messageId : null);
  if (!context) {
    await finishTask(taskId, "FAILED", "Không đọc được hội thoại / tin nhắn", db);
    return { runId: null, status: "FAILED", stage: "NEW_LEAD", action: "NO_ACTION", suggestedReply: "", reason: "Không đọc được hội thoại / tin nhắn" };
  }
  const { conversation, message } = context;
  const stageBefore = parseStage(conversation.stage);
  const stateBefore = parseSalesState(conversation.state);

  const run: RunRecorder = await startRun(
    {
      agentId: agent.id,
      agentKey: agent.key,
      agentVersionId: agent.versionId,
      taskId,
      eventId: task.eventId,
      mode: agent.mode,
      subjectType: "CONVERSATION",
      subjectId: conversation.id,
      input: { messageId: message.id, text: message.text, sentAt: message.sentAt },
      stateBefore: { stage: stageBefore, ...stateBefore },
    },
    db,
  );

  const toolCtx = { agentKey: agent.key, mode: agent.mode, allowedTools: agent.definition.allowedTools, run, conversationId: conversation.id };
  const tool: ToolRunner = async <T,>(name: Parameters<typeof callTool>[1], args: unknown) => {
    const result = await callTool<T>(toolCtx, name, args);
    return result.ok ? (result.value as T) : null;
  };

  const modelAttempts: ModelAttempt[] = [];
  let tier: RouteTier = "RULE";
  let escalation: EscalationReason | null = null;

  try {
    // ───── 1. HIỂU ─────
    let understanding = understandByRule(message.text);
    if (!ruleIsEnough(understanding)) {
      const routed = await runModelStep({
        step: "understand",
        system: understandSystemPrompt(),
        messages: [{ role: "user", content: message.text.slice(0, 2000) }],
        schema: UNDERSTANDING_SCHEMA,
        routing: parseRouting(agent.definition.routing),
        confidenceOf: (v) => v.confidence,
        settings,
      });
      modelAttempts.push(...routed.attempts);
      if (routed.tier !== "HUMAN" && routed.value) {
        understanding = mergeUnderstanding(understanding, routed.value, routed.tier === "STRONG" ? "STRONG" : "ECONOMY");
        tier = routed.tier;
      } else {
        escalation = routed.escalation;
      }
    }

    // ───── 2. NHẬN DIỆN SẢN PHẨM ─────
    // Giải TRƯỚC khi áp trạng thái, vì nó cần CSDL và cần chính tin nhắn (mã quảng cáo nằm ở
    // đính kèm của tin, không nằm trong chữ khách gõ).
    const resolution = await resolveProduct(
      {
        conversationId: conversation.id,
        pageId: conversation.pageId,
        text: message.text,
        adId: message.adId ?? "",
        adDescription: message.adDescription ?? "",
        postUrl: message.postUrl ?? "",
      },
      db,
    );
    await db.insert(schema.salesProductResolutions).values({
      runId: run.id,
      conversationId: conversation.id,
      messageId: message.id,
      productId: resolution.productId,
      variantId: resolution.variantId,
      productCode: resolution.productCode,
      source: resolution.source,
      confidence: resolution.confidence,
      evidence: resolution.evidence,
      candidateCount: resolution.candidateCount,
    });
    // Học bản đồ quảng cáo → sản phẩm khi vừa kết luận được từ CÂU QUẢNG CÁO. Lần sau cùng một
    // quảng cáo không phải đoán lại, và kết quả không đổi giữa hai lượt.
    await learnAdMapping({ pageId: conversation.pageId, adId: message.adId ?? "", postUrl: message.postUrl ?? "", adDescription: message.adDescription ?? "", resolution }, db);

    // ───── 3. TRẠNG THÁI ─────
    const applied = await applyUnderstanding(stateBefore, understanding, tool, resolution);
    let state = applied.state;

    // ───── 3. QUYẾT ĐỊNH ─────
    const now = new Date();
    const confirmation = checkContextualConfirmation({ state, message: { text: message.text, sentAt: message.sentAt }, now });
    const staleHours = conversation.lastShopMessageAt ? (now.getTime() - conversation.lastShopMessageAt.getTime()) / 3_600_000 : 0;
    const decision: SalesDecision = decide({
      stage: stageBefore,
      state,
      understanding,
      confirmation,
      humanTakeover: Boolean(conversation.humanTakeoverAt),
      orderCreated: Boolean(conversation.orderId),
      stale: staleHours >= SALES_STALE_HOURS,
      toolFailed: applied.toolFailed,
      canPromiseStock: applied.stockKnown ? (applied.available ?? 0) > 0 : null,
      sizeAdvice: applied.sizeAdvice,
    });

    // ───── 3b. QUYẾT ĐỊNH ĐỂ CHẤM ĐIỂM (chỉ ở nấc SHADOW) ─────
    //
    // `decide()` trả `NO_ACTION` ngay khi nhân viên đã cầm hội thoại — đúng cho SẢN XUẤT, vì máy
    // phải đứng ngoài. Nhưng ở nấc SHADOW máy vốn đã không được gửi gì cho ai, nên im lặng ở đây
    // không mua thêm một chút an toàn nào; nó chỉ VỨT ĐI đúng phần dữ liệu đáng giá nhất.
    //
    // Đo trên mẻ 20 hội thoại: 22/36 lượt ra `NO_ACTION` vì luật này, trong đó có hội thoại 25 tin
    // với 11 tin khách — lead nóng nhất mẻ. Không có gì để đặt cạnh câu nhân viên đã trả lời.
    //
    // Nên tách hẳn hai câu hỏi: ĐƯỢC PHÉP LÀM GÌ (`productionAction`, luôn `NO_SEND` ở SHADOW) và
    // LẼ RA NÊN LÀM GÌ (`decision.action`). Bản để chấm dựng bằng cách hỏi lại `decide()` với giả
    // định người CHƯA vào — và nó KHÔNG được chạm vào trạng thái hội thoại thật.
    const nguoiDaVao = Boolean(conversation.humanTakeoverAt);
    const chamDiem = nguoiDaVao && agent.mode === "SHADOW";
    const decisionDeCham: SalesDecision = chamDiem
      ? decide({
          stage: stageBefore, state, understanding, confirmation,
          humanTakeover: false,
          orderCreated: Boolean(conversation.orderId),
          stale: staleHours >= SALES_STALE_HOURS,
          toolFailed: applied.toolFailed,
          canPromiseStock: applied.stockKnown ? (applied.available ?? 0) > 0 : null,
          sizeAdvice: applied.sizeAdvice,
        })
      : decision;

    // ───── 4. DIỄN ĐẠT ─────
    const generation: GenerationContext = {
      action: decisionDeCham.action,
      state,
      sizes: applied.sizes,
      colors: applied.colors,
      sizeAdvice: applied.sizeAdvice,
      stockKnown: applied.stockKnown,
      available: applied.available,
      shippingFee: applied.shippingFee,
      missing: decisionDeCham.missing,
      reason: decisionDeCham.reason,
    };
    // Bản xem trước đơn cũng dựng theo bản để chấm — câu chữ phải nói về ĐÚNG hành động đang soạn.
    // Đây thuần tuý là dựng CHỮ, không ghi gì và không gọi công cụ nào.
    if (decisionDeCham.action === "SEND_ORDER_REVIEW" && !decisionDeCham.missing.length && state.variantId && state.quotedTotal !== null) {
      const unit = applied.shippingFee === null ? state.quotedTotal / state.quantity : (state.quotedTotal - applied.shippingFee) / state.quantity;
      generation.orderSummary = renderOrderReview({
        productLabel: `${state.productName} ${state.variantLabel}`.trim(),
        quantity: state.quantity,
        unitPrice: Math.round(unit),
        shippingFee: applied.shippingFee ?? 0,
        total: state.quotedTotal,
        name: state.customerName || conversation.customerName,
        phone: state.phone,
        address: [state.address, state.province].filter(Boolean).join(", "),
      });
    }
    const fallback = renderTemplate(generation);
    let suggested = fallback;

    // Mô hình chỉ được mời viết lại khi có gì để viết, và chỉ được đổi CÁCH NÓI.
    if (fallback && settings.modelCallsEnabled && decisionDeCham.action !== "NO_ACTION" && decisionDeCham.action !== "HANDOFF_HUMAN") {
      const routed = await runModelStep({
        step: "generate",
        system: generateSystemPrompt(),
        messages: [{ role: "user", content: `Câu nháp:\n${fallback}\n\nTin của khách:\n${message.text.slice(0, 500)}` }],
        schema: GENERATED_SCHEMA,
        routing: parseRouting(agent.definition.routing),
        settings,
      });
      modelAttempts.push(...routed.attempts);
      if (routed.tier !== "HUMAN" && routed.value) {
        const allowed = [state.quotedTotal ?? 0, applied.shippingFee ?? 0, state.quotedTotal !== null && applied.shippingFee !== null ? state.quotedTotal - applied.shippingFee : 0].filter((n) => n > 0);
        const guard = guardGeneratedText(routed.value.text, fallback, allowed);
        suggested = guard.text;
        if (guard.rejected) {
          await recordAiError({ scope: "MODEL", agentKey: "sales", runId: run.id, subjectType: "CONVERSATION", subjectId: conversation.id, message: `Bỏ bản mô hình viết: ${guard.rejectReason}` }, db);
        } else {
          tier = routed.tier;
        }
      }
    }

    let finalStage = decision.stage;

    // Ghi bản chốt đang chờ khi VỪA gửi bản chốt — đây là mảnh làm cho chữ "ok" sau này có nghĩa.
    //
    // Và phải ĐI TIẾP một nấc ngay trong lượt này: bản chốt vừa rời khỏi tay shop thì hội thoại
    // đang CHỜ KHÁCH XÁC NHẬN, không còn đang đọc lại đơn. Để nguyên ở ORDER_REVIEW thì chữ "ok"
    // của khách ở lượt sau rơi vào đúng cái nhánh "chưa gửi bản chốt nào" và không bao giờ chốt
    // được đơn. Nấc mới vẫn do máy trạng thái quyết, không gán tay.
    if (decision.action === "SEND_ORDER_REVIEW" && generation.orderSummary && !decision.missing.length) {
      state = {
        ...state,
        pending: {
          sentAt: now.toISOString(),
          fingerprint: confirmationFingerprint(state),
          summary: generation.orderSummary,
          variantId: state.variantId ?? "",
          quantity: state.quantity,
          total: state.quotedTotal ?? 0,
        },
      };
      finalStage = nextStage(decision.stage, { ...decision.facts, reviewSent: true }).stage;
    }
    if (decision.action === "ASK_SIZE") state = bumpAsk(state, "size");
    if (decision.action === "ASK_VARIANT") state = bumpAsk(state, "variant");
    if (decision.action === "ASK_CONTACT") state = bumpAsk(state, "phone");
    if (decision.action === "ASK_ADDRESS") state = bumpAsk(state, "address");

    // Chuyển người là hành động THẬT, đi qua đúng công cụ, kể cả ở nấc SHADOW.
    if (decision.action === "HANDOFF_HUMAN" && decision.handoffReason) {
      await callTool(toolCtx, "conversation.handoff", { reason: `${decision.handoffReason}: ${decision.reason}`.slice(0, 200) });
    }

    // LÊN ĐƠN: vẫn ĐI QUA cổng công cụ ngay cả khi biết chắc sẽ bị từ chối ở nấc SHADOW.
    // Gọi rồi bị chặn để lại một dòng đọc được — "máy đã ĐỊNH lên đơn này" — còn bỏ qua vì biết
    // trước kết quả thì màn hình quan sát không bao giờ thấy được ý định đó.
    if (decision.action === "CREATE_DRAFT_ORDER" && confirmation.confirmed && state.variantId) {
      const draft = await callTool<{ created: boolean; orderId?: string }>(toolCtx, "order.create_draft", {
        variantId: state.variantId,
        quantity: state.quantity,
        name: state.customerName || conversation.customerName || "Khách",
        phone: state.phone,
        address: state.address,
        province: state.province || undefined,
        confirmationEvidence: { reviewSentAt: confirmation.reviewSentAt, customerRepliedAt: confirmation.customerRepliedAt, quote: confirmation.quote },
      });
      // Chỉ khi đơn THỰC SỰ được tạo mới sang giai đoạn đã lên đơn. Bị chặn thì đứng ở CONFIRMED
      // để nhân viên lên đơn tay — tuyệt đối không để giai đoạn nói dối về việc đã có đơn.
      if (draft.ok && draft.value?.created) finalStage = "ORDER_CREATED";
    }

    await db
      .update(schema.salesConversations)
      .set({ stage: finalStage, state, lastRunAt: now, updatedAt: now })
      .where(eq(schema.salesConversations.id, conversation.id));

    await run.model(modelAttempts);
    await db.insert(schema.salesSuggestions).values({
      runId: run.id,
      conversationId: conversation.id,
      triggerMessageId: message.id,
      stageBefore,
      stageAfter: finalStage,
      // CHẤT LƯỢNG: máy lẽ ra nên làm gì.
      action: decisionDeCham.action,
      // AN TOÀN: máy thật sự được phép làm gì. Ở nấc SHADOW luôn là không gửi.
      productionAction: agent.mode === "SHADOW" ? "NO_SEND" : decision.action,
      // Dòng này sinh ra CHỈ để chấm điểm — sản xuất đã đứng ngoài vì người đang cầm hội thoại.
      evaluationOnly: chamDiem,
      suggestedReply: suggested,
      confidence: decisionDeCham.confidence,
      // Ở nấc SHADOW đây luôn là false — cổng gửi tin không mở cho câu do AI soạn.
      sent: false,
    });

    const status = decision.action === "HANDOFF_HUMAN" ? "HANDED_OFF" : "SUCCEEDED";
    await run.finish({
      status,
      stateAfter: { stage: finalStage, ...state },
      understanding,
      decision: { ...decision, confirmation },
      suggestedReply: suggested,
      tier,
      escalationReason: escalation,
    });
    await finishTask(taskId, "DONE", null, db);
    return { runId: run.id, status, stage: finalStage, action: decision.action, suggestedReply: suggested, reason: decision.reason };
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    await run.model(modelAttempts);
    await run.finish({ status: "FAILED", error: messageText, tier, escalationReason: escalation });
    await recordAiError({ scope: "PIPELINE", agentKey: "sales", runId: run.id, subjectType: "CONVERSATION", subjectId: conversation.id, message: messageText }, db);
    await finishTask(taskId, "FAILED", messageText, db);
    return { runId: run.id, status: "FAILED", stage: stageBefore, action: "NO_ACTION", suggestedReply: "", reason: messageText };
  }
}

/** Chạy hết việc đang chờ của nhân sự bán hàng (dùng cho job và cho `after()` của webhook). */
export async function drainSalesTasks(limit = 20, db?: Db) {
  const conn = db ?? (await getDb());
  const settings = await getAiSettings();
  const agent = await getAgent("sales", settings, conn);
  if (!agent || agent.mode === "OFF") return { ran: 0, skipped: true, reason: "Nhân sự bán hàng đang tắt" };
  const tasks = await conn.query.aiTasks.findMany({
    where: and(eq(schema.aiTasks.agentId, agent.id), eq(schema.aiTasks.status, "PENDING")),
    orderBy: (t, { asc }) => [asc(t.createdAt)],
    limit,
  });
  const results: PipelineResult[] = [];
  for (const task of tasks) results.push(await runSalesTask(task.id, { db: conn, settings }));
  return { ran: results.length, skipped: false, results };
}


