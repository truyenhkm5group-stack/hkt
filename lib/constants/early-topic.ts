import { MODEL_STATE_LABELS, MODEL_STATE_UNDECLARED_LABEL, MODEL_STATES, type ModelState } from "@/lib/constants/model-lifecycle";
import { MODEL_SIGNAL_LABEL, MODEL_SIGNALS, type ModelSignal, type ModelSignalResult, type SignalSource, type SourceVote } from "@/lib/constants/model-signal";
import { SAMPLE_STATUS_LABEL, TOPIC_BLOCKS_NEW_SUGGESTION, TOPIC_STATUS_LABEL, type SampleStatus, type TopicStatus } from "@/lib/constants/production-os";

/**
 * ═══════════ TOPIC SẢN XUẤT MỞ SỚM — LUỒNG SONG SONG, KHÔNG PHẢI CÚ NHẢY VÒNG ĐỜI (Company OS · Agent T) ═══════════
 *
 * Quy tắc chủ shop 25/09/2026 (nguyên văn): "Phần topic sản xuất thì có thể tạo topic trao đổi sản xuất
 * cho những mẫu có chỉ số tốt mà chưa win (tiềm năng sẽ win và lên mã), ko phải chỉ cho những mẫu đã win."
 *
 * "Chỉ số tốt mà chưa win" KHÔNG phải một ngưỡng mới: đó đúng là tín hiệu TRIỂN VỌNG (`PROMISING`) của
 * bảng gộp có sẵn (`deriveModelSignal` — thiếu một nguồn thị trường, hoặc mới thắng ở vòng thử creative /
 * thiết kế). Tệp này không có một con số nào (luật 27, 38).
 *
 * ─── VÌ SAO LÀ LUỒNG SONG SONG ───
 *
 * Topic mở sớm KHÔNG kéo vòng đời mẫu sang "Bàn sản xuất": làm vậy xoá mất sự thật "quảng cáo vẫn đang
 * test" và làm lượt khai THẮNG không còn chỗ để ghi (ADS_TESTING → WINNER là cạnh duy nhất). Bộ đi theo
 * vòng đời của Agent C (`followModelLifecycle`) vốn chỉ đi CẠNH TIẾN từ trạng thái hiện tại, nên với mẫu
 * còn trước THẮNG nó tự đứng yên — tệp này giữ nguyên hành vi đó.
 *
 * Khi NGƯỜI khai THẮNG cho một mẫu mà sản xuất đã đi trước (topic, giá thành, mẫu thử…), máy ĐỀ XUẤT một
 * lượt chuyển tiếp tới đúng chỗ sản xuất đang đứng (`winnerFollowUp`) — người bấm, lý do điền sẵn, đi qua
 * `transitionModel` (đường duy nhất đổi vòng đời). Không có gì tự áp (luật 23).
 *
 * Tệp THUẦN: không đọc/ghi CSDL, không đọc đồng hồ, client import được.
 */

// ─────────────────────────── TRẠNG THÁI KHAI ───────────────────────────

/** Trạng thái khai CÒN TRƯỚC lượt khai THẮNG. `null` = chưa khai (mẫu đồng bộ từ sổ, kể cả thiết kế TK). */
export const PRE_WINNER_STATES: readonly (ModelState | null)[] = [null, "IDEA", "CREATIVE", "ADS_TESTING"];

/** Trạng thái khai mà ở đó "mở trao đổi sản xuất" còn là bước phía trước = trước THẮNG + chính THẮNG. */
export const BEFORE_PRODUCTION_DISCUSSION_STATES: readonly (ModelState | null)[] = [...PRE_WINNER_STATES, "WINNER"];

/** Trạng thái khai ĐÃ KHAI và còn trước THẮNG (không gồm `null`). */
const DECLARED_PRE_WINNER: readonly ModelState[] = ["IDEA", "CREATIVE", "ADS_TESTING"];

// ─────────────────────────── ĐỀ XUẤT MỞ TOPIC ───────────────────────────

/**
 * `NORMAL` — mẫu THẮNG (tín hiệu, hoặc người đã khai THẮNG): mở topic là bước tiếp của vòng đời.
 * `EARLY`  — mẫu TRIỂN VỌNG còn trước THẮNG: mở topic là LUỒNG SONG SONG, vòng đời đứng yên.
 * `null`   — không đề xuất (tín hiệu khác, hoặc vòng đời đã qua bước bàn sản xuất / đang Loại / Ngừng).
 */
export type TopicOpeningMode = "NORMAL" | "EARLY";

export function topicOpeningMode(signal: ModelSignal | null, state: ModelState | null): TopicOpeningMode | null {
  if (!BEFORE_PRODUCTION_DISCUSSION_STATES.includes(state)) return null;
  if (signal === "WINNER") return "NORMAL";
  if (signal === "PROMISING") return state === "WINNER" ? "NORMAL" : "EARLY";
  return null;
}

/**
 * Cổng của đề xuất "mở topic" (trang 360 và buồng lái dùng CHUNG): có chế độ ⇒ và KHÔNG có topic nào
 * mang nghĩa "đường sản xuất đã có" (`trackTopics` — đếm theo `TOPIC_BLOCKS_NEW_SUGGESTION`: mọi trạng thái
 * trừ Đã đóng, KỂ CẢ Đã chốt phương án — Agent K). Số topic CHƯA BIẾT (`null`) không phải 0 ⇒ không đề xuất
 * (có thể đã có topic).
 */
export function suggestsTopicOpening(signal: ModelSignal | null, state: ModelState | null, trackTopics: number | null): TopicOpeningMode | null {
  if (trackTopics === null || trackTopics > 0) return null;
  return topicOpeningMode(signal, state);
}

// ─────────────────────────── BỐI CẢNH LÚC MỞ TOPIC (ảnh chụp) ───────────────────────────

/**
 * Hai trường thêm vào `production_topics.evidence_snapshot` (jsonb — không cột mới, không migration).
 * Lá phiếu chỉ giữ NHÃN (nguồn · phiếu · phán quyết), KHÔNG giữ câu chi tiết: trang topic mở cho người
 * có `planning:view`, còn câu chi tiết có thể chứa biên lợi nhuận / chi quảng cáo (cùng mức che của
 * trang 360 và buồng lái).
 *
 * `signalAtOpen = null` ⇒ CHƯA BIẾT (không đọc được tín hiệu lúc mở — câu lỗi ở `signalErrorAtOpen`),
 * không phải "không có tín hiệu". Topic mở trước khi có hai trường này thì không mang chúng: KHÔNG
 * backfill (mục 8.8, 35) — trang in "không có ảnh chụp bối cảnh".
 */
export type TopicSignalAtOpen = {
  signal: ModelSignal;
  decidedBy: ModelSignalResult["decidedBy"];
  reasons: { source: SignalSource; vote: SourceVote; verdict: string }[];
};

export type TopicOpenContext = {
  signalAtOpen: TopicSignalAtOpen | null;
  signalErrorAtOpen: string | null;
  /** Trạng thái KHAI lúc mở; `null` = chưa khai. */
  lifecycleAtOpen: ModelState | null;
};

export function buildTopicOpenContext(signal: Pick<ModelSignalResult, "signal" | "decidedBy" | "reasons"> | null, lifecycle: ModelState | null, signalError: string | null = null): TopicOpenContext {
  return {
    signalAtOpen: signal ? { signal: signal.signal, decidedBy: signal.decidedBy, reasons: signal.reasons.map((r) => ({ source: r.source, vote: r.vote, verdict: r.verdict })) } : null,
    signalErrorAtOpen: signal ? null : (signalError ?? "Không đọc được tín hiệu mẫu lúc mở topic"),
    lifecycleAtOpen: lifecycle,
  };
}

const isSignal = (v: unknown): v is ModelSignal => typeof v === "string" && (MODEL_SIGNALS as readonly string[]).includes(v);
const isState = (v: unknown): v is ModelState => typeof v === "string" && (MODEL_STATES as readonly string[]).includes(v);

/**
 * Topic có được mở TRƯỚC khi mẫu thắng không:
 *  · trạng thái khai lúc mở còn trước THẮNG (Ý tưởng / Creative / Test quảng cáo) ⇒ SỚM;
 *  · chưa khai và tín hiệu lúc mở là TRIỂN VỌNG ⇒ SỚM (đúng câu "chỉ số tốt mà chưa win" — mẫu đồng bộ
 *    từ sổ, kể cả thiết kế TK, đều chưa khai);
 *  · còn lại ⇒ không (chưa khai mà tín hiệu khác thì ta KHÔNG biết mẫu đã từng thắng chưa — mẫu Pancake
 *    đang bán nhiều tháng cũng "chưa khai"; gắn nhãn "sớm" cho nó là khẳng định không chứng minh được).
 */
export function isEarlyOpen(lifecycle: ModelState | null, signal: ModelSignal | null): boolean {
  if (lifecycle !== null) return DECLARED_PRE_WINNER.includes(lifecycle);
  return signal === "PROMISING";
}

export type TopicOpenBadge = { early: boolean; label: string };

/**
 * Đọc ngược ảnh chụp để in nhãn trên trang topic. Ảnh chụp cũ (không có trường `lifecycleAtOpen`) ⇒
 * `null`: không có bối cảnh thì không in nhãn nào, KHÔNG đoán.
 */
export function describeTopicOpenContext(snapshot: unknown): TopicOpenBadge | null {
  if (!snapshot || typeof snapshot !== "object" || !("lifecycleAtOpen" in snapshot)) return null;
  const s = snapshot as { lifecycleAtOpen?: unknown; signalAtOpen?: { signal?: unknown } | null };
  const lifecycle = isState(s.lifecycleAtOpen) ? s.lifecycleAtOpen : null;
  const signal = s.signalAtOpen && isSignal(s.signalAtOpen.signal) ? s.signalAtOpen.signal : null;
  const signalText = signal ? MODEL_SIGNAL_LABEL[signal] : "chưa đọc được tín hiệu";
  const stateText = lifecycle ? MODEL_STATE_LABELS[lifecycle] : MODEL_STATE_UNDECLARED_LABEL;
  if (isEarlyOpen(lifecycle, signal)) return { early: true, label: `Mở sớm — mẫu đang ${signalText} / ${stateText}` };
  return { early: false, label: `Lúc mở: tín hiệu ${signalText} · vòng đời ${stateText}` };
}

// ─────────────────────────── SẢN XUẤT ĐÃ ĐI TỚI ĐÂU ───────────────────────────

/**
 * Phần của `getModelProductionSummary` (Agent C) mà phép tính cần — khai cấu trúc thay vì import kiểu từ
 * `lib/queries/*` để tệp thuần không kéo tầng truy vấn.
 */
export type ProductionTrackInput = {
  topics: readonly { status: TopicStatus }[];
  finalCosting: { version: number } | null;
  draftCostings: number;
  latestSample: { version: number; status: SampleStatus } | null;
  approvedDesign: { version: number } | null;
  openOrders: readonly { code: string; designVersionId: string | null }[];
};

/**
 * Sản xuất THẬT SỰ đang đứng ở đâu — đọc từ chứng cứ của miền sản xuất, mỗi chứng cứ ánh xạ tới đúng
 * trạng thái mà `LIFECYCLE_FOLLOW` của C sẽ đi tới nếu sự kiện đó xảy ra khi mẫu đã ở ≥ THẮNG:
 *
 *   topic chưa đóng (kể cả Đã chốt phương án) → Bàn sản xuất · có bảng giá thành (nháp / chốt) → Tính giá
 *   thành · mẫu thử đang làm / yêu cầu sửa → Làm mẫu · mẫu đã gửi / bị loại → Duyệt mẫu (loại không kéo
 *   vòng đời — C) · mẫu đã duyệt hoặc có bản thiết kế duyệt → Mẫu đã duyệt · lệnh SX mở trỏ bản duyệt →
 *   Lên kế hoạch SX.
 *
 * Trả chứng cứ ĐI XA NHẤT (thứ tự `MODEL_STATES`) cùng mọi câu chứng cứ. Topic chỉ còn "Đã đóng" không
 * tính: đóng có thể là bỏ dở. Không chứng cứ ⇒ `null`.
 */
export function productionTrackState(p: ProductionTrackInput): { to: ModelState; evidence: string[] } | null {
  const ung: { state: ModelState; text: string }[] = [];
  const conMo = p.topics.filter((t) => TOPIC_BLOCKS_NEW_SUGGESTION.includes(t.status));
  if (conMo.length) {
    const daChot = conMo.filter((t) => t.status === "SELECTED").length;
    ung.push({
      state: "PRODUCTION_DISCUSSION",
      text: daChot ? `${daChot} topic ${TOPIC_STATUS_LABEL.SELECTED.toLowerCase()}` : `${conMo.length} topic đang trao đổi`,
    });
  }
  if (p.finalCosting) ung.push({ state: "COSTING", text: `giá thành bản ${p.finalCosting.version} đã chốt` });
  else if (p.draftCostings > 0) ung.push({ state: "COSTING", text: `${p.draftCostings} bản giá thành nháp` });
  if (p.latestSample) {
    const st = p.latestSample.status;
    const to: ModelState = st === "APPROVED" ? "APPROVED" : st === "SUBMITTED" || st === "REJECTED" ? "SAMPLE_REVIEW" : "SAMPLING";
    ung.push({ state: to, text: `mẫu thử bản ${p.latestSample.version} ${SAMPLE_STATUS_LABEL[st].toLowerCase()}` });
  }
  if (p.approvedDesign) ung.push({ state: "APPROVED", text: `bản thiết kế ${p.approvedDesign.version} đã duyệt` });
  const lenhTroBanDuyet = p.openOrders.filter((o) => o.designVersionId !== null);
  if (lenhTroBanDuyet.length) ung.push({ state: "PRODUCTION_PLANNING", text: `lệnh sản xuất ${lenhTroBanDuyet.map((o) => o.code).join(", ")} trỏ bản duyệt` });
  if (!ung.length) return null;
  const hang = (s: ModelState) => MODEL_STATES.indexOf(s);
  const xaNhat = ung.reduce((a, b) => (hang(b.state) > hang(a.state) ? b : a));
  return { to: xaNhat.state, evidence: ung.map((u) => u.text) };
}

export const WINNER_FOLLOW_UP_PREFIX = "Sản xuất đã đi trước lúc mẫu thắng";

export type WinnerFollowUp = { to: ModelState; reason: string };

/**
 * Lượt chuyển tiếp SAU khi người khai THẮNG: tới đúng chỗ sản xuất đang đứng, lý do điền sẵn. `null` khi
 * sản xuất chưa bắt đầu (khi đó bước tiếp là "Bàn sản xuất" — cạnh tiến thường của bảng vòng đời).
 * Mọi đích ở đây đều sau THẮNG trong sơ đồ; nhảy cóc qua cạnh ngoài bảng vẫn cần lý do — lý do này đủ dài.
 */
export function winnerFollowUp(p: ProductionTrackInput | null): WinnerFollowUp | null {
  if (!p) return null;
  const t = productionTrackState(p);
  if (!t) return null;
  return { to: t.to, reason: `${WINNER_FOLLOW_UP_PREFIX}: ${t.evidence.join(" · ")} — chuyển tiếp tới “${MODEL_STATE_LABELS[t.to]}”.` };
}

/**
 * Câu nhắc trên biểu mẫu mở topic cho MỘT mẫu (`/production/topics/new?model=`): topic này mở SỚM (luồng
 * song song, vòng đời đứng yên) hay sẽ kéo vòng đời theo. Cùng luật `isEarlyOpen` với nhãn trên trang topic
 * và cùng cạnh tiến mà `followModelLifecycle` (C) dùng — chỉ THẮNG → Bàn sản xuất đi theo sự kiện mở topic.
 */
export function topicOpenNotice(state: ModelState | null, signal: ModelSignal | null): { early: boolean; text: string } | null {
  if (isEarlyOpen(state, signal)) {
    const sig = signal ? MODEL_SIGNAL_LABEL[signal] : "chưa đọc được tín hiệu";
    const st = state ? MODEL_STATE_LABELS[state] : MODEL_STATE_UNDECLARED_LABEL;
    return { early: true, text: `Mở SỚM — mẫu đang ${sig} / ${st}. Topic chạy song song với test quảng cáo: xưởng báo giá, làm mẫu trước; vòng đời mẫu KHÔNG đổi khi topic mở. Khai THẮNG vẫn là việc của người, ở trang mẫu.` };
  }
  if (state === "WINNER") return { early: false, text: `Mẫu đã khai ${MODEL_STATE_LABELS.WINNER} — mở topic thì vòng đời tự đi theo sang “${MODEL_STATE_LABELS.PRODUCTION_DISCUSSION}”.` };
  return null;
}
