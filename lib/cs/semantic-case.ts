import {
  ACTIONABLE_SPEAKER_INTENTS,
  ACTIONABLE_TEMPORAL_SCOPES,
  CONFIDENCE_LEVELS,
  CONFIDENCE_TO_ACTION,
  SEMANTIC_KINDS,
  SPEAKER_INTENTS,
  TEMPORAL_SCOPES,
  checkEligibility,
  type CaseFacts,
  type Confidence,
  type SpeakerIntent,
  type TemporalScope,
} from "@/lib/constants/case-semantics";
import { CS_KIND_LABEL, type CsKind } from "@/lib/constants/cs";
import { getAiProvider, type AiProvider, type AiToolDef } from "@/lib/ai/provider";
import { aiDisabledReason } from "@/lib/ai/router";
import { vnShortStamp } from "@/lib/format";
import { stripHtml } from "@/lib/text";

/**
 * ═══════════ TỪ KHOÁ TÌM ỨNG VIÊN — NGỮ NGHĨA VÀ CHỨNG TỪ MỚI KẾT LUẬN ═══════════
 *
 * Trước bản này đường đi là: `text.includes(từ khoá)` → `insert cs_cases`. Không có bước nào ở
 * giữa, nên mọi câu chứa chữ "không nhận" đều thành một việc "Trả hàng / hoàn" — kể cả câu khách
 * đang giục shop gửi hàng.
 *
 * Đường đi mới, đúng thứ tự và không rút gọn được bước nào:
 *
 *   TÍN HIỆU ỨNG VIÊN   (từ khoá · thẻ hội thoại · quan sát xác định)
 *        ↓
 *   BỐI CẢNH TOÀN ĐOẠN  (cả hội thoại, có phân vai, theo đúng trình tự thời gian)
 *        ↓
 *   HIỂU NGỮ NGHĨA      (phạm vi thời gian · ý định người nói · bằng chứng thuận/nghịch)
 *        ↓
 *   CHỨNG TỪ NGHIỆP VỤ  (đơn · trạng thái POS · vận đơn — THẮNG mọi kết luận của model)
 *        ↓
 *   CỬA TIN CẬY         (HIGH tạo việc · MEDIUM để người xem · LOW bỏ)
 *
 * ─── HAI ĐIỀU TỆP NÀY CỐ Ý KHÔNG LÀM ───
 *
 *  · **Không gọi model lúc dựng trang.** Phân loại chạy trong job quét, kết quả được LƯU; màn hình
 *    chỉ đọc. Một hàng đợi 200 dòng mà mỗi dòng gọi model là một trang không bao giờ mở xong.
 *  · **Không lưu dòng suy nghĩ riêng của model.** Chỉ lưu KẾT LUẬN có cấu trúc kèm trích dẫn
 *    nguyên văn từ hội thoại — thứ người đọc kiểm chứng được bằng cách mở chat ra đối chiếu.
 */

/** Một tín hiệu đáng xem, chưa phải một kết luận. */
export type CaseCandidate = {
  kind: CsKind;
  /** Nguyên văn đoạn làm dấy lên nghi ngờ — để người đọc kiểm chứng, và để model có chỗ bám. */
  evidence: string;
  /** `KEYWORD`/`TAG` phải qua tầng ngữ nghĩa. `DETERMINISTIC` đứng trên quan sát, không phải trên chữ. */
  from: "KEYWORD" | "TAG" | "DETERMINISTIC";
  /** Từ khoá / tên thẻ đã khớp — ghi lại để biết luật nào đang đẻ ra ứng viên rác. */
  signal?: string;
};

export type SemanticVerdict = {
  /** `NONE` = không có việc gì trong hội thoại này. */
  caseKind: CsKind | "NONE";
  actionable: boolean;
  confidence: Confidence;
  temporalScope: TemporalScope;
  speakerIntent: SpeakerIntent;
  /** Trích NGUYÊN VĂN từ hội thoại. Câu do model tự viết ra không phải bằng chứng. */
  supportingEvidence: string[];
  contradictoryEvidence: string[];
  /** Một câu, đọc được, nói vì sao. KHÔNG phải dòng suy nghĩ. */
  reason: string;
};

export type DecisionAction = "CREATE" | "REVIEW" | "SKIP";

export type CaseDecision = {
  action: DecisionAction;
  kind: CsKind | null;
  /** Câu giải thích đi thẳng vào báo cáo và vào ô bằng chứng của case. */
  reason: string;
  /** Cửa nào đã chặn. `null` = không cửa nào chặn. */
  blockedBy: "NOT_ACTIONABLE" | "TEMPORAL_SCOPE" | "SPEAKER_INTENT" | "DETERMINISTIC_FACT" | "CONFIDENCE" | "NO_MODEL" | null;
  /** Việc thuộc bàn khác — hàng đợi CSKH không được sinh dòng thứ hai cho cùng sự việc. */
  route?: "SHIPMENT_CARE";
  verdict: SemanticVerdict | null;
};

/* ════════════════════════ BỐI CẢNH ════════════════════════ */

export type ConversationMessage = { text: string; fromPage: boolean; insertedAt?: Date | null };

/** Trần ký tự của bản ghi hội thoại đưa cho model. Vượt trần thì cắt phần CŨ, giữ phần MỚI. */
export const TRANSCRIPT_MAX_CHARS = 12_000;
const MESSAGE_MAX_CHARS = 400;



/**
 * ═══════════ CẢ ĐOẠN, CÓ PHÂN VAI, ĐÚNG TRÌNH TỰ ═══════════
 *
 * Đưa mỗi câu chứa từ khoá cho model là lặp lại đúng lỗi của từ khoá, chỉ đắt tiền hơn. Câu
 * "không nhận" chỉ đọc ra được khi thấy câu ngay trước nó ("nếu chị không ưng") và câu ngay sau
 * ("em chuyển hàng cho chị càng nhanh càng tốt").
 *
 * PHÂN VAI là bắt buộc: kịch bản bán hàng của shop chứa sẵn "chốt đơn", "đổi size", "hoàn tiền".
 * Không biết ai nói thì lời mời của người bán bị đọc thành yêu cầu của người mua — đúng cái đã đẻ
 * ra 181 case "đã chốt · chưa tạo đơn" hồi tháng trước.
 *
 * Cắt theo phần CŨ khi quá dài: ý định hiện tại nằm ở cuối hội thoại, và bản ghi bị cắt phải NÓI
 * RA là mình bị cắt, không im lặng trông như đã đầy đủ.
 */
export function buildTranscript(messages: ConversationMessage[]): { text: string; used: number; truncated: boolean } {
  const sap = [...messages]
    .filter((m) => m.text && stripHtml(m.text).trim())
    .sort((a, b) => (a.insertedAt?.getTime() ?? 0) - (b.insertedAt?.getTime() ?? 0));
  const dong = sap.map((m) => {
    const noi = m.fromPage ? "SHOP" : "KHÁCH";
    const luc = m.insertedAt ? `${vnShortStamp(m.insertedAt)} ` : "";
    const chu = stripHtml(m.text).replace(/\s+/g, " ").trim().slice(0, MESSAGE_MAX_CHARS);
    return `[${luc}${noi}] ${chu}`;
  });
  let text = dong.join("\n");
  let truncated = false;
  let used = dong.length;
  while (text.length > TRANSCRIPT_MAX_CHARS && dong.length > 1) {
    dong.shift();
    used = dong.length;
    truncated = true;
    text = dong.join("\n");
  }
  return { text: truncated ? `(… phần đầu hội thoại đã lược bớt …)\n${text}` : text, used, truncated };
}

/** Khối chứng từ — model ĐƯỢC ĐỌC nhưng KHÔNG được sửa; nó là dữ kiện, không phải đề xuất. */
export function buildFactsBlock(facts: CaseFacts): string {
  const d = (x: Date | null) => (x ? vnShortStamp(x) : "chưa biết");
  return [
    `- Ghép hội thoại với đơn: ${facts.orderMatch}`,
    `- Đơn đã tồn tại thật trên POS (Đã xác nhận trở đi): ${facts.orderMaterialized ? "CÓ" : "KHÔNG"}`,
    `- Giai đoạn đơn: ${facts.orderStage ?? "chưa biết"}${facts.orderFinal ? " (đã kết thúc)" : ""}`,
    `- Mã đơn: ${facts.orderSystemId ?? "chưa biết"} · lên đơn lúc: ${d(facts.orderInsertedAt)}`,
    `- Vận đơn: ${facts.hasShipment ? (facts.hasActiveShipment ? "CÓ, đang trên đường" : "CÓ, đã kết thúc") : "KHÔNG"}`,
  ].join("\n");
}

export type CaseContext = {
  customerName: string;
  tags: string[];
  candidates: CaseCandidate[];
  facts: CaseFacts;
  messages: ConversationMessage[];
};

export function buildPrompt(ctx: CaseContext): string {
  const { text: transcript, truncated } = buildTranscript(ctx.messages);
  const ungVien = ctx.candidates.length
    ? ctx.candidates.map((c) => `- ${CS_KIND_LABEL[c.kind] ?? c.kind} (${c.kind}) — dấu hiệu: ${c.signal ?? "—"} · trích: “${c.evidence.slice(0, 200)}”`).join("\n")
    : "- (không có dấu hiệu nào; hãy tự đọc hội thoại)";
  return [
    `KHÁCH: ${ctx.customerName || "chưa biết tên"}`,
    ctx.tags.length ? `THẺ HỘI THOẠI: ${ctx.tags.join(", ")}` : "THẺ HỘI THOẠI: (không có)",
    "",
    "CHỨNG TỪ NGHIỆP VỤ (sự thật quan sát được, KHÔNG được mâu thuẫn):",
    buildFactsBlock(ctx.facts),
    "",
    "DẤU HIỆU MÁY TÌM ĐƯỢC (chỉ là ứng viên, có thể sai hoàn toàn):",
    ungVien,
    "",
    `HỘI THOẠI${truncated ? " (đã lược phần đầu)" : ""}:`,
    transcript,
  ].join("\n");
}

/* ════════════════════════ GỌI MODEL ════════════════════════ */

export const SEMANTIC_SYSTEM = [
  "Bạn phân loại hội thoại bán hàng tiếng Việt của một shop thời trang để quyết định CÓ hay KHÔNG có một việc chăm sóc khách hàng cần người xử lý.",
  "",
  "Nguyên tắc:",
  "1. Chỉ kết luận có việc khi KHÁCH đang yêu cầu điều đó Ở HIỆN TẠI. Câu giả định (“nếu không ưng thì em không nhận”), câu hỏi chính sách (“có được đổi không”), chuyện đã qua, hoặc việc đã được giải quyết ngay trong hội thoại đều KHÔNG phải việc.",
  "2. Phân biệt ai nói. Lời mời của SHOP (“để em chốt đơn cho chị”, “bên em đổi size trong 7 ngày”) không phải yêu cầu của KHÁCH.",
  "3. Chứng từ nghiệp vụ là sự thật. Đừng kết luận trái với nó; nếu hội thoại nói khác chứng từ, hãy nêu ở contradictoryEvidence.",
  "4. Không chắc thì để confidence = LOW hoặc caseKind = NONE. Tạo việc giả tốn một cuộc gọi của nhân viên và làm hỏng niềm tin vào cả hàng đợi.",
  "5. supportingEvidence và contradictoryEvidence phải TRÍCH NGUYÊN VĂN từ hội thoại, không diễn giải lại.",
  "6. reason viết một câu tiếng Việt ngắn, nói KẾT LUẬN và CĂN CỨ. Không kể quá trình suy nghĩ.",
].join("\n");

export const SEMANTIC_TOOL: AiToolDef = {
  name: "ket_luan_case",
  description: "Nêu kết luận có cấu trúc về việc chăm sóc khách hàng trong hội thoại này.",
  inputSchema: {
    type: "object",
    properties: {
      caseKind: { type: "string", enum: [...SEMANTIC_KINDS, "NONE"], description: "Loại việc, hoặc NONE nếu không có việc nào." },
      actionable: { type: "boolean", description: "Có ai đó phải làm gì ngay bây giờ không." },
      confidence: { type: "string", enum: [...CONFIDENCE_LEVELS] },
      temporalScope: { type: "string", enum: [...TEMPORAL_SCOPES] },
      speakerIntent: { type: "string", enum: [...SPEAKER_INTENTS] },
      supportingEvidence: { type: "array", items: { type: "string" }, description: "Trích nguyên văn ủng hộ kết luận." },
      contradictoryEvidence: { type: "array", items: { type: "string" }, description: "Trích nguyên văn đi ngược kết luận." },
      reason: { type: "string", description: "Một câu tiếng Việt: kết luận và căn cứ." },
    },
    required: ["caseKind", "actionable", "confidence", "temporalScope", "speakerIntent", "supportingEvidence", "contradictoryEvidence", "reason"],
    additionalProperties: false,
  },
};

const inList = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === "string" && (list as readonly string[]).includes(v);
const strings = (v: unknown, max: number) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && Boolean(x.trim())).slice(0, max).map((x) => x.trim().slice(0, 300)) : []);

/**
 * Đọc kết luận model trả về, TỪ CHỐI thứ không đúng bản khai.
 *
 * Model trả một loại không có trong sổ, một mức tin cậy lạ, hay thiếu trường ⇒ `null` = KHÔNG có
 * kết luận, chứ không phải "kết luận rỗng". Vá tạm bằng giá trị mặc định là cách một giá trị bịa
 * đi thẳng vào hàng đợi.
 */
export function parseVerdict(input: unknown): SemanticVerdict | null {
  if (!input || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;
  const kind = o.caseKind;
  if (!(kind === "NONE" || inList(SEMANTIC_KINDS as readonly string[], kind))) return null;
  if (!inList(CONFIDENCE_LEVELS, o.confidence)) return null;
  if (!inList(TEMPORAL_SCOPES, o.temporalScope)) return null;
  if (!inList(SPEAKER_INTENTS, o.speakerIntent)) return null;
  if (typeof o.actionable !== "boolean") return null;
  if (typeof o.reason !== "string" || !o.reason.trim()) return null;
  return {
    caseKind: kind === "NONE" ? "NONE" : (kind as CsKind),
    actionable: o.actionable,
    confidence: o.confidence,
    temporalScope: o.temporalScope,
    speakerIntent: o.speakerIntent,
    supportingEvidence: strings(o.supportingEvidence, 5),
    contradictoryEvidence: strings(o.contradictoryEvidence, 5),
    reason: o.reason.trim().slice(0, 600),
  };
}

/** Một lượt gọi model cho một hội thoại. `null` = AI tắt hoặc model trả thứ không đọc được. */
export async function classifyConversation(ctx: CaseContext, provider?: AiProvider | null): Promise<SemanticVerdict | null> {
  const p = provider === undefined ? getAiProvider("routine") : provider;
  if (!p) return null;
  const res = await p.complete({
    system: SEMANTIC_SYSTEM,
    messages: [{ role: "user", content: [{ type: "text", text: buildPrompt(ctx) }] }],
    tools: [SEMANTIC_TOOL],
    maxTokens: 1200,
  });
  const call = res.content.find((b) => b.type === "tool_use" && b.name === SEMANTIC_TOOL.name);
  if (!call || call.type !== "tool_use") return null;
  return parseVerdict(call.input);
}

/* ════════════════════════ MỘT ĐOẠN SỰ VIỆC, MỘT VIỆC ════════════════════════ */

/**
 * ═══════════ KHOÁ CHỐNG TRÙNG BÁM ĐOẠN SỰ VIỆC, KHÔNG BÁM NGÀY CHẠY JOB ═══════════
 *
 * Bản cũ nhét NGÀY HÔM NAY vào khoá của "chưa tạo đơn", nên mỗi ngày job quét lại đẻ MỘT case mới
 * cho CÙNG một lần khách đưa thông tin — và máy đối chiếu ngay sau đó lại phải đóng chúng. Hàng
 * đợi vì thế luôn có một tầng case cũ mà không ai hiểu từ đâu ra, và người trực học được rằng phần
 * lớn dòng trong hàng đợi không đáng đọc.
 *
 * Nay khoá bám MỐC SỰ VIỆC:
 *
 *  · "chưa tạo đơn"  → ngày khách ĐƯA ĐỦ THÔNG TIN. Khách đưa lại vào hôm khác ⇒ đoạn mới ⇒ case
 *                      mới, đúng như phải thế; job chạy mười lần trong ngày vẫn một case.
 *  · loại khác       → tháng. Khách nhắc lại cùng một việc trong tháng không đẻ ra việc thứ hai;
 *                      bằng chứng mới nối vào lịch sử của chính case đó.
 */
export function episodeKey(kind: CsKind, infoCompleteAt: Date | null, now: Date = new Date()): string {
  if (kind === "ORDER_NOT_CREATED") return (infoCompleteAt ?? now).toISOString().slice(0, 10);
  return now.toISOString().slice(0, 7);
}

/** Khoá tự nhiên của một việc sinh từ chat: hội thoại · loại · đoạn sự việc. */
export function chatDedupeKey(conversationId: string, kind: CsKind, infoCompleteAt: Date | null, now?: Date): string {
  return `pk-chat:${conversationId}:${kind}:${episodeKey(kind, infoCompleteAt, now)}`;
}

/* ════════════════════════ QUYẾT ĐỊNH ════════════════════════ */

/**
 * ═══════════ CHỨNG TỪ THẮNG MODEL — HÀM THUẦN, KIỂM ĐƯỢC TỪNG CỬA ═══════════
 *
 * Thứ tự các cửa KHÔNG hoán vị được:
 *
 *  1. model tự nói không có việc                → bỏ;
 *  2. phạm vi thời gian không phải HIỆN TẠI     → bỏ  (đây là cửa chặn ca "Yến Ruby");
 *  3. người nói không phải KHÁCH đang yêu cầu   → bỏ  (kịch bản bán hàng của shop);
 *  4. chứng từ nghiệp vụ không đỡ được kết luận → BÁC  (không hạ bậc, không để người xem lại:
 *                                                       "POS đã xác nhận" là một sự thật, không
 *                                                       phải một mức tin cậy);
 *  5. cửa tin cậy                               → HIGH tạo · MEDIUM để xem · LOW bỏ.
 *
 * Cửa 4 đứng TRƯỚC cửa 5 có chủ đích. Đảo lại thì một kết luận sai nhưng "chắc chắn" vẫn lọt vào
 * hàng đợi, và đó đúng là loại case cũ mà không ai đóng được.
 */
export function decideCase(verdict: SemanticVerdict | null, facts: CaseFacts): CaseDecision {
  if (!verdict) {
    return { action: "SKIP", kind: null, reason: `Tầng ngữ nghĩa không chạy được (${aiDisabledReason() ?? "model không trả kết luận đọc được"}) — KHÔNG tạo việc bằng từ khoá`, blockedBy: "NO_MODEL", verdict: null };
  }
  if (verdict.caseKind === "NONE" || !verdict.actionable) {
    return { action: "SKIP", kind: null, reason: verdict.reason, blockedBy: "NOT_ACTIONABLE", verdict };
  }
  const kind = verdict.caseKind;
  if (!ACTIONABLE_TEMPORAL_SCOPES.includes(verdict.temporalScope)) {
    return { action: "SKIP", kind, reason: `Không phải yêu cầu đang còn hiệu lực (${verdict.temporalScope}): ${verdict.reason}`, blockedBy: "TEMPORAL_SCOPE", verdict };
  }
  if (!ACTIONABLE_SPEAKER_INTENTS.includes(verdict.speakerIntent)) {
    return { action: "SKIP", kind, reason: `Không phải yêu cầu của khách (${verdict.speakerIntent}): ${verdict.reason}`, blockedBy: "SPEAKER_INTENT", verdict };
  }
  const dieuKien = checkEligibility(kind, facts);
  if (!dieuKien.ok) {
    return { action: "SKIP", kind, reason: `Chứng từ nghiệp vụ bác kết luận: ${dieuKien.reason}`, blockedBy: "DETERMINISTIC_FACT", route: dieuKien.route, verdict };
  }
  const action = CONFIDENCE_TO_ACTION[verdict.confidence];
  if (action === "SKIP") return { action, kind, reason: `Chưa đủ chắc (LOW): ${verdict.reason}`, blockedBy: "CONFIDENCE", verdict };
  if (action === "REVIEW") return { action, kind, reason: `Chưa chắc (MEDIUM), để người xem lại: ${verdict.reason}`, blockedBy: "CONFIDENCE", verdict };
  return { action, kind, reason: verdict.reason, blockedBy: null, verdict };
}

/**
 * ═══════════ AI TẮT: LÙI VỀ PHÍA HẸP HƠN, KHÔNG LÙI VỀ TỪ KHOÁ ═══════════
 *
 * Mất tầng ngữ nghĩa thì thứ còn lại là phép so chuỗi — đúng thứ vừa bị bỏ vì nó sinh việc giả.
 * Nên ứng viên từ khoá / thẻ KHÔNG được tạo việc.
 *
 * Ứng viên `DETERMINISTIC` thì khác hẳn và vẫn chạy: kết luận của nó KHÔNG đứng trên chữ nghĩa mà
 * đứng trên quan sát (khách đã đưa SĐT và địa chỉ) cộng với chứng từ (không có đơn nào). Tắt nó đi
 * là tự bỏ mất loại case duy nhất trực tiếp cứu được doanh thu.
 */
export function decideWithoutModel(candidates: CaseCandidate[], facts: CaseFacts): CaseDecision[] {
  const ly_do = aiDisabledReason() ?? "tầng ngữ nghĩa không khả dụng";
  return candidates.map((c) => {
    if (c.from !== "DETERMINISTIC") {
      return { action: "SKIP" as const, kind: c.kind, reason: `Không có tầng ngữ nghĩa (${ly_do}) — dấu hiệu từ khoá/thẻ KHÔNG đủ để tạo việc`, blockedBy: "NO_MODEL" as const, verdict: null };
    }
    const dieuKien = checkEligibility(c.kind, facts);
    if (!dieuKien.ok) return { action: "SKIP" as const, kind: c.kind, reason: `Chứng từ nghiệp vụ bác kết luận: ${dieuKien.reason}`, blockedBy: "DETERMINISTIC_FACT" as const, route: dieuKien.route, verdict: null };
    return { action: "CREATE" as const, kind: c.kind, reason: c.evidence.slice(0, 300), blockedBy: null, verdict: null };
  });
}

/**
 * Bản ghi LƯU LẠI cùng case — chỉ kết luận và trích dẫn, KHÔNG có dòng suy nghĩ của model.
 *
 * Lưu nguyên khối để báo cáo đối chiếu (`scripts/cs-reconcile-dry-run.ts`) đọc lại được vì sao một
 * case được tạo, mà không phải gọi model lần nữa.
 */
export type SemanticRecord = {
  engine: "SEMANTIC" | "DETERMINISTIC";
  action: DecisionAction;
  confidence: Confidence | null;
  temporalScope: TemporalScope | null;
  speakerIntent: SpeakerIntent | null;
  reason: string;
  supportingEvidence: string[];
  contradictoryEvidence: string[];
  at: string;
};

export function toRecord(d: CaseDecision): SemanticRecord {
  return {
    engine: d.verdict ? "SEMANTIC" : "DETERMINISTIC",
    action: d.action,
    confidence: d.verdict?.confidence ?? null,
    temporalScope: d.verdict?.temporalScope ?? null,
    speakerIntent: d.verdict?.speakerIntent ?? null,
    reason: d.reason,
    supportingEvidence: d.verdict?.supportingEvidence ?? [],
    contradictoryEvidence: d.verdict?.contradictoryEvidence ?? [],
    at: new Date().toISOString(),
  };
}
