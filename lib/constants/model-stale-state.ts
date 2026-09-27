import { DESIGN_STATUS_LABEL } from "@/lib/constants/creative-loop";
import { PRE_WINNER_STATES } from "@/lib/constants/early-topic";
import { MODEL_STATE_LABELS, MODEL_STATES, MODEL_TRANSITIONS, type ModelEvidence, type ModelState } from "@/lib/constants/model-lifecycle";
import { LIFECYCLE_FOLLOW, SAMPLE_STATUS_LABEL, TOPIC_BLOCKS_NEW_SUGGESTION, type SampleStatus, type TopicStatus } from "@/lib/constants/production-os";

/**
 * ═══════════ LỜI KHAI ĐI SAU THỰC TẾ — MÁY ĐỀ XUẤT CẬP NHẬT, NGƯỜI BẤM (Company OS · Agent ST) ═══════════
 *
 * Đo production 27/09/2026 12:41 UTC (ops company-os-summary): 31 mẫu, đội vừa khai 22 mẫu qua "Khai theo
 * gợi ý" (21 → Làm creative, 1 → Test quảng cáo). Lời khai là ẢNH CHỤP của người: khi vòng creative đưa thiết
 * kế TK sang Đang test / THẮNG / Loại, hay sản xuất đi tiếp (mở topic, duyệt mẫu, gửi lệnh, nhận hàng) thì lời
 * khai CŨ ĐI — và Bảng quy trình mẫu (BD) xếp thẻ theo LỜI KHAI, nên thẻ nằm sai cột.
 *
 * P2 (`lifecycleEvidenceGap`) bắt chiều LỜI KHAI ĐI TRƯỚC chứng cứ. Tệp này bắt chiều ngược lại: CHỨNG CỨ ĐI
 * TRƯỚC lời khai ⇒ đề xuất MỘT lượt cập nhật để người bấm. Máy KHÔNG BAO GIỜ tự chuyển (target-architecture
 * Q3): phán quyết THẮNG / Loại là phán quyết của MÁY chấm creative — máy đề xuất, người khai.
 *
 * ─── LUẬT ───
 *  · Chỉ đi TỚI: đích phải đứng SAU lời khai theo thứ tự `MODEL_STATES` (cùng phép so của `observeModelStage`
 *    và `productionTrackState`). Không bao giờ lùi — kể cả cạnh "yêu cầu sửa" SAMPLE_REVIEW → SAMPLING và tái
 *    sản xuất SELLING → PRODUCTION_PLANNING: hai cạnh đó do bộ đi theo của C lo đúng lúc hành động xảy ra.
 *  · Chưa khai / Thua test / Ngừng ⇒ không đề xuất (chưa khai là việc của Q; ra khỏi Loại / Ngừng là quyết
 *    định của người, có lý do).
 *  · LUỒNG SONG SONG (Agent T): mẫu khai còn TRƯỚC THẮNG (Ý tưởng · Làm creative · Test quảng cáo) chỉ đọc
 *    chứng cứ CREATIVE. Topic mở sớm, giá thành, mẫu thử của nó KHÔNG kéo mẫu ra khỏi Test quảng cáo — đó
 *    đúng là luồng mở sớm, vòng đời đứng yên cho tới khi người khai THẮNG.
 *  · Phán quyết thiết kế THẮNG / Loại chỉ đề xuất THẮNG / Thua test từ đúng Test quảng cáo (cạnh duy nhất của
 *    sơ đồ). Mẫu còn Ý tưởng / Làm creative mà thiết kế đã có phán quyết ⇒ đề xuất Test quảng cáo (thiết kế
 *    ĐÃ lên camp); lượt khai phán quyết là bước sau, của người.
 *  · Chứng cứ SẢN XUẤT (mẫu khai ≥ THẮNG) đi qua ĐÚNG bảng `LIFECYCLE_FOLLOW` của C: mỗi dữ kiện sản xuất
 *    được dịch ra TÊN SỰ KIỆN đã sinh ra nó, và trạng thái đích đọc từ bảng của C — không có bảng
 *    "dữ kiện → trạng thái" thứ hai. Tự động hoá của C đã chuyển mẫu thì lời khai đã theo kịp và tệp này im
 *    lặng; nó chỉ lên tiếng ở chỗ tự động hoá KHÔNG chạy (mẫu khai sau khi sự việc đã xảy ra, sự việc xảy ra
 *    trước khi có tự động hoá, hay bước nhảy mà bộ đi theo không đi vì không phải cạnh tiến).
 *  · Hai dữ kiện NGOÀI bảng của C (C không có sự kiện nào cho chúng): lệnh sản xuất ĐÃ GỬI xưởng ⇒ Đang sản
 *    xuất; và (chỉ từ Đang sản xuất) đã có phiếu NHẬP HÀNG nối vào lệnh / lô, không còn lệnh đã gửi nào đang
 *    chờ hàng ⇒ Đang bán. Hai đích này là đúng hai cạnh tiến PRODUCTION_PLANNING → IN_PRODUCTION →
 *    SELLING của sơ đồ (`STALE_TAIL_FACTS`).
 *  · Ô CHƯA BIẾT (`null`) không phải chứng cứ, không phải 0 (luật 42): không đọc được sản xuất ⇒ không đề xuất
 *    gì từ sản xuất.
 *
 * Tệp THUẦN: không đọc/ghi CSDL, không đọc đồng hồ, chạy hai lần ra cùng kết quả, client import được. Không
 * ngưỡng số nào (chi quảng cáo "> 0" là cùng chứng cứ của `observeModelStage`).
 */

// ─────────────────────────── DỮ KIỆN ───────────────────────────

/**
 * Phần của `getModelProductionSummary` (Agent C) mà luật cần — khai cấu trúc để tệp thuần không kéo tầng truy
 * vấn (cùng cách `ProductionTrackInput` của T). `ModelProductionSummary` thoả kiểu này.
 */
export type StaleProductionFacts = {
  topics: readonly { status: TopicStatus }[];
  finalCosting: { version: number } | null;
  draftCostings: number;
  latestSample: { version: number; status: SampleStatus } | null;
  approvedDesign: { version: number } | null;
  /** Lệnh ĐANG MỞ (DRAFT / SENT) của sản phẩm của mẫu. `receivedViaLinkedReceipts = null` ⇒ chưa phiếu nào nối. */
  openOrders: readonly { code: string; status: string; designVersionId: string | null; receivedViaLinkedReceipts: number | null }[];
};

export type StaleStateFacts = {
  /** `design_concepts.status` của thiết kế nối với mẫu (`getModelsEvidenceBatch`); `null` = không có thiết kế. */
  designStatus: ModelEvidence["designStatus"];
  /** Chi quảng cáo trong cửa sổ chứng cứ, đã ghép với mã; `null` = CHƯA BIẾT (chưa sản phẩm / chưa từng ghép). */
  adSpend30d: number | null;
  /** Tóm tắt sản xuất (C); `null` = không đọc được / không có quyền đọc. */
  production: StaleProductionFacts | null;
  /** Số phiếu NHẬP HÀNG đã nối vào lệnh / lô sản xuất của sản phẩm; `null` = CHƯA BIẾT (chưa sản phẩm / không đọc). */
  linkedReceipts: number | null;
};

/** Ghép dữ kiện từ ba lô đọc có sẵn — một chỗ, cho bảng quy trình, `/models`, trang 360 và lõi ghi. */
export function staleFactsOf(evidence: Pick<ModelEvidence, "designStatus" | "adSpend30d"> | null, production: StaleProductionFacts | null, linkedReceipts: number | null): StaleStateFacts {
  return { designStatus: evidence?.designStatus ?? null, adSpend30d: evidence?.adSpend30d ?? null, production, linkedReceipts };
}

// ─────────────────────────── BẢNG DỊCH DỮ KIỆN → SỰ KIỆN (không phải → trạng thái) ───────────────────────────

/**
 * Mẫu thử mới nhất ở trạng thái X là kết quả của sự kiện nào. Trạng thái ĐÍCH đọc từ `LIFECYCLE_FOLLOW` (C).
 * Mẫu bị LOẠI không kéo vòng đời (C) — nó vẫn là mẫu đã GỬI duyệt, nên sự kiện là `sample.submitted`.
 */
export const SAMPLE_STATUS_EVENT: Readonly<Record<SampleStatus, string>> = {
  IN_PROGRESS: "sample.created",
  SUBMITTED: "sample.submitted",
  CHANGES_REQUESTED: "sample.reviewed",
  REJECTED: "sample.submitted",
  APPROVED: "sample.approved",
};

/** Sự kiện của C mà các dữ kiện khác của tóm tắt sản xuất là dấu vết. */
export const PRODUCTION_FACT_EVENT = {
  topic: "production_topic.created",
  costing: "costing.version_created",
  approvedDesign: "sample.approved",
  orderLinkedDesign: "production_order.linked_design",
} as const;

/**
 * HAI dữ kiện ngoài bảng của C — C không phát sự kiện nào khi lệnh được GỬI, và phiếu nhập nối lệnh không kéo
 * vòng đời. Mỗi đích là một cạnh tiến có sẵn của `MODEL_TRANSITIONS` (bài kiểm khoá).
 */
export const STALE_TAIL_FACTS = {
  PRODUCTION_ORDER_SENT: "IN_PRODUCTION",
  LINKED_RECEIPT: "SELLING",
} as const satisfies Record<string, ModelState>;

/** Phiếu nhập nối lệnh chỉ chứng minh "đã về hàng" khi lời khai nói đang có MỘT lượt sản xuất chạy. */
export const LINKED_RECEIPT_FROM: ModelState = "IN_PRODUCTION";

// ─────────────────────────── PHẠM VI ───────────────────────────

/** Không bao giờ đề xuất từ các lời khai này. */
export const STALE_NEVER_FROM: readonly ModelState[] = ["LOSER", "DISCONTINUED"];

/** Lời khai còn trước THẮNG — chỉ đọc chứng cứ creative (luồng song song của T). Dẫn xuất từ T, không gõ lại. */
export const STALE_CREATIVE_TRACK_STATES: readonly ModelState[] = PRE_WINNER_STATES.filter((s): s is ModelState => s !== null);

/** Lời khai có thể nhận đề xuất — dùng để chỉ đọc chứng cứ cho đúng những mẫu cần. */
export function staleCandidateState(declared: ModelState | null): declared is ModelState {
  return declared !== null && !STALE_NEVER_FROM.includes(declared);
}

// ─────────────────────────── LUẬT ───────────────────────────

export type StaleStateSuggestion = {
  to: ModelState;
  /** Mọi câu chứng cứ đi TỚI (câu của đích đứng đầu). */
  reasons: string[];
  /** Cụm ngắn cho nút trên thẻ ("thiết kế đã lên camp"). */
  short: string;
};

type Ung = { state: ModelState; text: string; short: string };

const hang = (s: ModelState) => MODEL_STATES.indexOf(s);

function followTarget(eventName: string): ModelState | null {
  return LIFECYCLE_FOLLOW[eventName] ?? null;
}

function creativeCandidates(declared: ModelState, f: StaleStateFacts): Ung[] {
  const out: Ung[] = [];
  const d = f.designStatus;
  if (d !== null) out.push({ state: "CREATIVE", text: `Đã có thiết kế TK (${DESIGN_STATUS_LABEL[d]})`, short: "đã có thiết kế" });
  if (d === "TESTING" || d === "WIN" || d === "LOSE") out.push({ state: "ADS_TESTING", text: `Thiết kế đã lên camp test quảng cáo (${DESIGN_STATUS_LABEL[d]})`, short: "thiết kế đã lên camp" });
  if (f.adSpend30d !== null && f.adSpend30d > 0) out.push({ state: "ADS_TESTING", text: "Đã có chi quảng cáo gần đây (cửa sổ chứng cứ của mẫu), đã ghép với mã", short: "đã có chi quảng cáo" });
  // Phán quyết là của MÁY chấm creative — chỉ đề xuất từ đúng Test quảng cáo, người khai.
  if (declared === "ADS_TESTING" && d === "WIN") out.push({ state: "WINNER", text: "Thiết kế mang phán quyết THẮNG của vòng test (máy chấm — người xác nhận)", short: "thiết kế thắng test" });
  if (declared === "ADS_TESTING" && d === "LOSE") out.push({ state: "LOSER", text: "Thiết kế mang phán quyết Loại của vòng test (máy chấm — người xác nhận)", short: "thiết kế bị loại" });
  return out;
}

function productionCandidates(declared: ModelState, f: StaleStateFacts): Ung[] {
  const p = f.production;
  if (!p) return [];
  const out: Ung[] = [];
  const push = (event: string, text: string, short: string) => {
    const to = followTarget(event);
    if (to) out.push({ state: to, text, short });
  };
  const track = p.topics.filter((t) => TOPIC_BLOCKS_NEW_SUGGESTION.includes(t.status)).length;
  if (track) push(PRODUCTION_FACT_EVENT.topic, `${track} topic sản xuất chưa đóng`, "đã mở topic sản xuất");
  if (p.finalCosting) push(PRODUCTION_FACT_EVENT.costing, `Giá thành bản ${p.finalCosting.version} đã chốt`, "đã có giá thành");
  else if (p.draftCostings > 0) push(PRODUCTION_FACT_EVENT.costing, `${p.draftCostings} bản giá thành nháp`, "đã có giá thành");
  if (p.latestSample) push(SAMPLE_STATUS_EVENT[p.latestSample.status], `Mẫu thử bản ${p.latestSample.version}: ${SAMPLE_STATUS_LABEL[p.latestSample.status].toLowerCase()}`, "mẫu thử đã đi tiếp");
  if (p.approvedDesign) push(PRODUCTION_FACT_EVENT.approvedDesign, `Bản thiết kế ${p.approvedDesign.version} đã duyệt`, "mẫu đã duyệt");
  const troBanDuyet = p.openOrders.filter((o) => o.designVersionId !== null);
  if (troBanDuyet.length) push(PRODUCTION_FACT_EVENT.orderLinkedDesign, `Lệnh sản xuất ${troBanDuyet.map((o) => o.code).join(", ")} trỏ bản duyệt`, "đã lập lệnh sản xuất");
  const daGui = p.openOrders.filter((o) => o.status === "SENT");
  if (daGui.length) out.push({ state: STALE_TAIL_FACTS.PRODUCTION_ORDER_SENT, text: `Lệnh sản xuất ${daGui.map((o) => o.code).join(", ")} đã gửi xưởng`, short: "lệnh đã gửi xưởng" });
  // Đã về hàng: có phiếu nhập nối lệnh / lô, và KHÔNG còn lệnh đã gửi nào đang chờ (chưa phiếu nào nối) —
  // lệnh đã gửi còn chờ hàng là lượt sản xuất đang chạy (tái sản xuất), phiếu cũ của lượt trước không chứng minh gì.
  const conCho = daGui.some((o) => o.receivedViaLinkedReceipts === null);
  if (declared === LINKED_RECEIPT_FROM && f.linkedReceipts !== null && f.linkedReceipts > 0 && !conCho) {
    out.push({ state: STALE_TAIL_FACTS.LINKED_RECEIPT, text: `${f.linkedReceipts} phiếu nhập hàng đã nối vào lệnh / lô sản xuất`, short: "hàng đã về kho" });
  }
  return out;
}

/**
 * Đề xuất cập nhật lời khai theo chứng cứ, hoặc `null`. Chỉ đích đứng SAU lời khai; nhiều chứng cứ ⇒ đích đi
 * XA NHẤT (thứ tự `MODEL_STATES`), mọi câu chứng cứ đi tới đều trả về (câu của đích đứng đầu).
 */
export function staleStateSuggestion(declared: ModelState | null, facts: StaleStateFacts): StaleStateSuggestion | null {
  if (!staleCandidateState(declared)) return null;
  const ung = STALE_CREATIVE_TRACK_STATES.includes(declared) ? creativeCandidates(declared, facts) : productionCandidates(declared, facts);
  const toi = ung.filter((u) => hang(u.state) > hang(declared));
  if (!toi.length) return null;
  const chon = toi.reduce((a, b) => (hang(b.state) > hang(a.state) ? b : a));
  const reasons = [chon.text, ...toi.filter((u) => u !== chon).map((u) => u.text)];
  return { to: chon.state, reasons: [...new Set(reasons)], short: chon.short };
}

/** Lời khai hiện tại → đích có phải cạnh tiến của sơ đồ không (không thì lõi đòi lý do — lý do điền sẵn đủ dài). */
export function staleIsForwardEdge(declared: ModelState, to: ModelState): boolean {
  return MODEL_TRANSITIONS[declared].includes(to);
}

// ─────────────────────────── CHỮ ───────────────────────────

/** Lý do điền sẵn cho lượt cập nhật hàng loạt — sửa được, vẫn phải qua cổng lý do. */
export const STALE_UPDATE_DEFAULT_REASON = "Cập nhật theo thực tế: chứng từ trong ERP đã đi trước lời khai";

/** Lý do điền sẵn cho MỘT mẫu (trang 360 / nút trên bảng): nói rõ chứng cứ. */
export function staleUpdateReason(s: StaleStateSuggestion): string {
  return `Cập nhật theo thực tế: ${s.reasons.join(" · ")}`;
}

/** Nguồn ghi vào lịch sử khi cập nhật từ bảng xem trước trên `/models`. */
export const STALE_UPDATE_SOURCE = "ui:/models:stale-update";

/** Nguồn khi cập nhật ở trang một mẫu. */
export function modelStaleSource(modelId: string): string {
  return `ui:/models/${modelId}:stale`;
}

/** Khoá `metadata.kind` của dòng lịch sử — phân biệt với lượt khai lần đầu của Q. */
export const STALE_UPDATE_KIND = "STALE_UPDATE";

/** Một câu cho người đọc: lời khai → đích, vì sao. */
export function describeStale(declared: ModelState, s: StaleStateSuggestion): string {
  return `Thực tế đã đi trước lời khai “${MODEL_STATE_LABELS[declared]}”: ${s.reasons.join(" · ")} — đề xuất cập nhật sang “${MODEL_STATE_LABELS[s.to]}”. Người bấm — máy không tự ghi.`;
}
