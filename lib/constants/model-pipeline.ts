import type { LifecycleEvidenceGap } from "@/lib/constants/evidence-gaps";
import { BEFORE_PRODUCTION_DISCUSSION_STATES } from "@/lib/constants/early-topic";
import { MODEL_STATE_LABELS, MODEL_STATES, type ModelState } from "@/lib/constants/model-lifecycle";
import type { ModelSuggestion } from "@/lib/constants/model-360";
import type { StaleStateSuggestion } from "@/lib/constants/model-stale-state";
import type { ModelSignal } from "@/lib/constants/model-signal";
import { STOCK_RISK_ACTION, STOCK_RISK_LABEL, STOCK_RISKS, type StockRisk } from "@/lib/constants/slow-moving";

/**
 * ═══════════ BẢNG QUY TRÌNH MẪU — PHẦN THUẦN (Company OS · Agent BD) ═══════════
 *
 * Quy trình 13 bước của chủ shop (sơ đồ): 1 Tạo ảnh mẫu / creative → 2 Set camp → 3 Mẫu chỉ số tốt, chốt
 * đơn thì scale → 4 Tạo topic hỏi giá & phương án SX → 5 Chốt phương án, báo giá thành tạm tính, lên mẫu →
 * 6 Duyệt mẫu → 7 MKTer lập bảng số lượng + giá tạm tính → 8 Sản xuất với xưởng → 9 Xưởng trả hàng, nhập
 * kho → 10 Đẩy đơn VTP → 11 Quản lý & đẩy tồn → 12 Xử lý hoàn, tái nhập → 13 Đơn mới (vòng lại).
 *
 * Tệp này là BẢN KHAI DUY NHẤT của phép chiếu "trạng thái vòng đời ⇒ cột của bảng". Nó KHÔNG có luật
 * nghiệp vụ nào của riêng nó:
 *
 *  · CỘT = trạng thái KHAI (`product_models.lifecycle_state`, NGƯỜI nói). Mỗi mẫu đứng ĐÚNG MỘT cột, và cột
 *    chỉ phụ thuộc lời khai. Sự thật máy suy ra (tín hiệu Triển vọng khi còn test, topic mở sớm, lớp tồn
 *    hoàn gần hết / hàng chết / vốn nằm chết, mẫu chờ duyệt, lời khai thiếu chứng từ) CHỈ GẮN NHÃN lên thẻ
 *    — không bao giờ đẩy mẫu sang cột khác, không bao giờ sinh thẻ thứ hai. Máy dời mẫu sang cột khác là
 *    máy tự khai trạng thái (target-architecture Q3).
 *  · "VIỆC TIẾP THEO" chỉ NHẶT từ bộ máy đã có: chỗ hở lời khai ≠ chứng từ (P2 · `lifecycleEvidenceGap`),
 *    lời khai đi SAU chứng cứ (ST · `staleStateSuggestion`), gợi ý khai của máy (Q · `buildDeclarePreview`), và
 *    danh sách đề xuất của trang 360 (A2 ·
 *    `deriveModelSuggestions` — gồm luật mở topic sớm của T và chuyển tiếp của C — ghép vòng phản hồi tồn
 *    của X · `mergeStockFeedbackSuggestions`). Không bộ máy nào nói gì ⇒ thẻ KHÔNG có nút, không bịa việc.
 *
 * Tệp THUẦN: không đọc/ghi CSDL, không đọc đồng hồ (mốc `now` truyền vào), client import được.
 */

// ─────────────────────────── CỘT ───────────────────────────

export const PIPELINE_COLUMN_KEYS = [
  "UNDECLARED",
  "IDEA",
  "ADS_TEST",
  "WINNER",
  "PRODUCTION_TALK",
  "COSTING_SAMPLE",
  "SAMPLE_REVIEW",
  "QTY_PLAN",
  "IN_PRODUCTION",
  "SELLING",
  "CLEARANCE",
  "STOPPED",
] as const;
export type PipelineColumnKey = (typeof PIPELINE_COLUMN_KEYS)[number];

export type PipelineColumn = {
  key: PipelineColumnKey;
  label: string;
  /** Bước trong sơ đồ 13 bước của chủ shop mà cột này gánh (rỗng = ngoài quy trình). */
  steps: readonly number[];
  /** Trạng thái KHAI rơi vào cột. `null` = chưa khai. */
  states: readonly (ModelState | null)[];
  /** Cột thu gọn mặc định (mẫu đã dừng — không còn việc trên bảng). */
  collapsed: boolean;
  /** Một câu cho ⓘ đầu cột. */
  hint: string;
};

/**
 * Thứ tự trái → phải. "Chưa khai" đứng ĐẦU: đo production 27/09/2026 có 18/25 mẫu chưa khai — đặt cột ấy
 * ở cuối là giấu phần lớn sổ ra ngoài màn hình, trong khi khai là việc phải làm trước mọi việc khác.
 */
export const PIPELINE_COLUMNS: readonly PipelineColumn[] = [
  { key: "UNDECLARED", label: "Chưa khai", steps: [], states: [null], collapsed: false, hint: "Mẫu vào sổ chưa ai khai trạng thái vòng đời. Máy không tự xếp nó vào bước nào — khai từng mẫu, hoặc bấm “Khai theo gợi ý” để xác nhận gợi ý của máy cho cả lô." },
  { key: "IDEA", label: "Ý tưởng / Creative", steps: [1], states: ["IDEA", "CREATIVE"], collapsed: false, hint: "Bước 1 — tạo ảnh mẫu / creative." },
  { key: "ADS_TEST", label: "Test QC", steps: [2], states: ["ADS_TESTING"], collapsed: false, hint: "Bước 2 — set camp, test quảng cáo. Mẫu tín hiệu Triển vọng vẫn đứng ở đây (nhãn trên thẻ) cho tới khi người khai Thắng." },
  { key: "WINNER", label: "Thắng / Triển vọng", steps: [3], states: ["WINNER"], collapsed: false, hint: "Bước 3 — mẫu chỉ số tốt, chốt đơn thì scale. Cột theo lời khai Thắng; mẫu còn test mà tín hiệu Triển vọng mang nhãn ở cột Test QC." },
  { key: "PRODUCTION_TALK", label: "Bàn SX", steps: [4], states: ["PRODUCTION_DISCUSSION"], collapsed: false, hint: "Bước 4 — tạo topic hỏi giá & phương án sản xuất. Mẫu còn trước Thắng mà đã mở topic sớm mang nhãn “Topic SX đang mở” ở cột của nó." },
  { key: "COSTING_SAMPLE", label: "Giá thành & mẫu", steps: [5], states: ["COSTING", "SAMPLING"], collapsed: false, hint: "Bước 5 — chốt phương án, báo giá thành tạm tính, lên mẫu." },
  { key: "SAMPLE_REVIEW", label: "Duyệt mẫu", steps: [6], states: ["SAMPLE_REVIEW"], collapsed: false, hint: "Bước 6 — duyệt mẫu xưởng." },
  { key: "QTY_PLAN", label: "Kế hoạch SL", steps: [7], states: ["APPROVED", "PRODUCTION_PLANNING"], collapsed: false, hint: "Bước 7 — lập bảng số lượng + giá tạm tính, lệnh sản xuất." },
  { key: "IN_PRODUCTION", label: "Đang SX", steps: [8, 9], states: ["IN_PRODUCTION"], collapsed: false, hint: "Bước 8–9 — sản xuất với xưởng, xưởng trả hàng, nhập kho." },
  { key: "SELLING", label: "Đang bán", steps: [10, 13], states: ["SELLING"], collapsed: false, hint: "Bước 10 và 13 — đẩy đơn, đơn mới (vòng lại). Tồn hoàn gần hết / hàng chết / vốn nằm chết hiện thành nhãn đỏ trên thẻ, không phải một thẻ ở cột Đẩy tồn." },
  { key: "CLEARANCE", label: "Đẩy tồn / Hoàn", steps: [11, 12], states: ["CLEARANCE"], collapsed: false, hint: "Bước 11–12 — quản lý & đẩy tồn, xử lý hoàn, tái nhập. Cột theo lời khai Xả tồn." },
  { key: "STOPPED", label: "Dừng", steps: [], states: ["LOSER", "DISCONTINUED"], collapsed: true, hint: "Thua test hoặc Ngừng — thu gọn, không còn việc trên bảng." },
];

export const PIPELINE_COLUMN_BY_KEY: Readonly<Record<PipelineColumnKey, PipelineColumn>> = Object.fromEntries(PIPELINE_COLUMNS.map((c) => [c.key, c])) as Record<PipelineColumnKey, PipelineColumn>;

const COLUMN_OF_STATE = new Map<ModelState | null, PipelineColumnKey>();
for (const c of PIPELINE_COLUMNS) for (const s of c.states) COLUMN_OF_STATE.set(s, c.key);

/** Cột của một trạng thái khai. Hàm TOÀN PHẦN trên 15 trạng thái + `null` (bài kiểm duyệt đủ). */
export function pipelineColumnOf(state: ModelState | null): PipelineColumnKey {
  const k = COLUMN_OF_STATE.get(state);
  if (!k) throw new Error(`Trạng thái "${String(state)}" không có cột trên bảng quy trình — khai vào PIPELINE_COLUMNS`);
  return k;
}

/** Mọi giá trị trạng thái khai có thể có (kể cả chưa khai) — cho bài kiểm tính toàn phần. */
export const ALL_DECLARED_VALUES: readonly (ModelState | null)[] = [null, ...MODEL_STATES];

// ─────────────────────────── NHÃN SUY RA (CHỈ GẮN, KHÔNG DỜI CỘT) ───────────────────────────

export type PipelineChipKind = "EVIDENCE_GAP" | "STOCK_RISK" | "SAMPLE_WAITING" | "OPEN_TOPIC";

/** Thứ tự ưu tiên khi thẻ chỉ còn chỗ cho `PIPELINE_MAX_CHIPS` nhãn. Lời khai trái chứng từ đứng đầu. */
export const PIPELINE_CHIP_ORDER: readonly PipelineChipKind[] = ["EVIDENCE_GAP", "STOCK_RISK", "SAMPLE_WAITING", "OPEN_TOPIC"];
export const PIPELINE_MAX_CHIPS = 2;

export type PipelineChipTone = "danger" | "warn" | "info";
export type PipelineChip = { kind: PipelineChipKind; text: string; title: string; tone: PipelineChipTone };

/** Lớp tồn đáng gắn nhãn trên bảng — ba lớp "phải làm gì đó" của phép xếp lớp DUY NHẤT (`classifyStockRisk`). */
export const PIPELINE_STOCK_RISKS: readonly StockRisk[] = ["DEAD", "RETURNED_OUT", "EXCESS"];
const STOCK_CHIP_TEXT: Partial<Record<StockRisk, string>> = { DEAD: "Hàng chết", RETURNED_OUT: "Hoàn gần hết", EXCESS: "Vốn nằm chết" };

/**
 * Lớp tồn TỆ NHẤT của một mẫu từ lớp từng mẫu mã — theo đúng thứ tự in `STOCK_RISKS` của Hàng chậm (không
 * thứ tự thứ hai). Không mẫu mã nào biết lớp ⇒ `null` (không phải "Bình thường").
 */
export function worstStockRisk(risks: readonly StockRisk[]): StockRisk | null {
  let best: StockRisk | null = null;
  for (const r of risks) if (best === null || STOCK_RISKS.indexOf(r) < STOCK_RISKS.indexOf(best)) best = r;
  return best;
}

export type PipelineChipInput = {
  state: ModelState | null;
  /** P2 — `null` = không hở, hoặc người xem không đọc được sản xuất. */
  gap: LifecycleEvidenceGap | null;
  /** Lớp tồn tệ nhất (Hàng chậm) — `null` = chưa biết / không có hàng / không có quyền. */
  stockRisk: StockRisk | null;
  /** Mẫu thử mới nhất đang ĐÃ GỬI, chờ duyệt (C). */
  sampleWaiting: boolean;
  /** Số topic mang nghĩa "đường sản xuất đã có" (`countTopicsBlockingSuggestion`); `null` = chưa biết. */
  trackTopics: number | null;
};

/**
 * Nhãn của thẻ, tối đa `PIPELINE_MAX_CHIPS`. "Mẫu chờ duyệt" không gắn ở cột Duyệt mẫu (cột đã nói điều đó);
 * "Topic SX đang mở" chỉ gắn khi mẫu còn TRƯỚC bước Bàn SX — đó chính là luồng song song của topic mở sớm.
 */
export function pipelineChips(i: PipelineChipInput): PipelineChip[] {
  const col = pipelineColumnOf(i.state);
  const all: PipelineChip[] = [];
  if (i.gap) all.push({ kind: "EVIDENCE_GAP", text: "Thiếu chứng từ", title: i.gap.text, tone: "warn" });
  if (i.stockRisk && PIPELINE_STOCK_RISKS.includes(i.stockRisk)) {
    all.push({ kind: "STOCK_RISK", text: STOCK_CHIP_TEXT[i.stockRisk] ?? STOCK_RISK_LABEL[i.stockRisk], title: `${STOCK_RISK_LABEL[i.stockRisk]} — ${STOCK_RISK_ACTION[i.stockRisk]}`, tone: i.stockRisk === "EXCESS" ? "warn" : "danger" });
  }
  if (i.sampleWaiting && col !== "SAMPLE_REVIEW") all.push({ kind: "SAMPLE_WAITING", text: "Mẫu chờ duyệt", title: "Mẫu thử mới nhất đã gửi, đang chờ người duyệt (bàn sản xuất của mẫu).", tone: "info" });
  if ((i.trackTopics ?? 0) > 0 && BEFORE_PRODUCTION_DISCUSSION_STATES.includes(i.state)) {
    all.push({ kind: "OPEN_TOPIC", text: "Topic SX đang mở", title: "Đã có topic sản xuất chưa đóng trong khi vòng đời còn trước “Bàn sản xuất” — luồng song song (mở sớm), vòng đời không đổi.", tone: "info" });
  }
  return all.sort((a, b) => PIPELINE_CHIP_ORDER.indexOf(a.kind) - PIPELINE_CHIP_ORDER.indexOf(b.kind)).slice(0, PIPELINE_MAX_CHIPS);
}

// ─────────────────────────── VIỆC TIẾP THEO ───────────────────────────

export type NextActionSource = "EVIDENCE_GAP" | "STALE" | "DECLARE" | "SUGGESTION";

/**
 * Thứ tự nhặt MỘT việc tiếp theo cho thẻ:
 *  1. Lời khai trái chứng từ (P2) — ERP đang nói hai điều trái nhau về chính bước của mẫu, sửa trước.
 *  2. Lời khai đi SAU chứng từ (ST) — thẻ đang đứng sai cột: thiết kế đã lên camp / đã có phán quyết, sản xuất
 *     đã đi tiếp mà lời khai chưa theo. Một cú bấm mở ô khai CHỌN SẴN đích + lý do điền sẵn (người bấm lưu).
 *  3. Mẫu chưa khai mà máy có gợi ý (Q) — chưa biết mẫu ở bước nào thì mọi việc khác là đoán.
 *  4. Đề xuất của trang 360 (A2 + T + X): ưu tiên đề xuất ĐẨY BƯỚC quy trình (`STEP_ADVANCING_SUGGESTION_KEYS`),
 *     không có thì đề xuất đầu tiên theo đúng thứ tự bộ máy trả.
 */
export const NEXT_ACTION_ORDER: readonly NextActionSource[] = ["EVIDENCE_GAP", "STALE", "DECLARE", "SUGGESTION"];

/**
 * Khoá đề xuất của `deriveModelSuggestions` (mục 3 — mở topic / chuyển vòng đời) — đề xuất đưa mẫu sang
 * bước kế tiếp của quy trình. Chỉ là thứ tự NHẶT trên bảng, không phải điều kiện sinh đề xuất; bài kiểm quét
 * `lib/constants/model-360.ts` để chắc từng khoá còn tồn tại ở đó.
 */
export const STEP_ADVANCING_SUGGESTION_KEYS: readonly string[] = ["lifecycle-production-ahead", "lifecycle-production-discussion", "topic-open-early", "topic-open"];

export type PipelineNextAction = {
  source: NextActionSource;
  /** Khoá đề xuất gốc (SUGGESTION) / loại chứng từ thiếu (EVIDENCE_GAP) / `declare` — để truy về. */
  key: string;
  label: string;
  href: string;
  /** Câu "vì sao" của bộ máy gốc — đi vào ⓘ / tooltip, không in thẳng. */
  why: string;
};

export type NextActionInput = {
  modelId: string;
  state: ModelState | null;
  gap: LifecycleEvidenceGap | null;
  /** Gợi ý khai của máy (Q) — chỉ truyền khi người xem KHAI được; `null` = không gợi ý / không quyền. */
  declareSuggestion: { state: ModelState; reasons: readonly string[] } | null;
  /** Lời khai đi sau chứng cứ (ST) — chỉ truyền khi người xem KHAI được; `null` / vắng = không đề xuất. */
  stale?: StaleStateSuggestion | null;
  suggestions: readonly ModelSuggestion[];
};

export function modelHref(modelId: string, anchor?: string): string {
  return `/models/${encodeURIComponent(modelId)}${anchor ? `#${anchor}` : ""}`;
}

/** Neo khối "Đề xuất" trên trang 360 — nút chuyển vòng đời nằm ở đó. */
export const SUGGESTIONS_ANCHOR = "de-xuat";
/** Neo ô "Trạng thái khai" trên trang 360 (Q chọn sẵn gợi ý ở đó). */
export const DECLARE_ANCHOR = "trang-thai-khai";

function suggestionAction(modelId: string, s: ModelSuggestion): PipelineNextAction {
  const link = s.links[0] ?? null;
  return {
    source: "SUGGESTION",
    key: s.key,
    label: s.what,
    // Không có link (lượt chuyển vòng đời, hoặc người xem không có quyền tạo topic) ⇒ mở khối Đề xuất của trang 360.
    href: link ? link.href : modelHref(modelId, SUGGESTIONS_ANCHOR),
    why: [s.why, s.data, s.caveat].filter(Boolean).join(" · "),
  };
}

/** MỘT việc tiếp theo, hoặc `null` khi không bộ máy nào nói gì. */
export function pickNextAction(i: NextActionInput): PipelineNextAction | null {
  for (const src of NEXT_ACTION_ORDER) {
    if (src === "EVIDENCE_GAP" && i.gap) {
      return { source: "EVIDENCE_GAP", key: i.gap.missing, label: i.gap.actionLabel, href: i.gap.actionHref, why: i.gap.text };
    }
    if (src === "STALE" && i.state !== null && i.stale) {
      return {
        source: "STALE",
        key: `stale:${i.stale.to}`,
        label: `Cập nhật → ${PIPELINE_COLUMN_BY_KEY[pipelineColumnOf(i.stale.to)].label} (${i.stale.short})`,
        href: modelHref(i.modelId, DECLARE_ANCHOR),
        why: `Thực tế đã đi trước lời khai “${MODEL_STATE_LABELS[i.state]}”: ${i.stale.reasons.join(" · ")}. Đề xuất cập nhật sang “${MODEL_STATE_LABELS[i.stale.to]}” — người bấm lưu, máy không tự ghi.`,
      };
    }
    if (src === "DECLARE" && i.state === null && i.declareSuggestion) {
      return {
        source: "DECLARE",
        key: "declare",
        label: `Khai “${MODEL_STATE_LABELS[i.declareSuggestion.state]}” theo gợi ý`,
        href: modelHref(i.modelId, DECLARE_ANCHOR),
        why: `Máy gợi ý (ước tính): ${i.declareSuggestion.reasons.join(" · ") || MODEL_STATE_LABELS[i.declareSuggestion.state]}. Người khai — máy không tự ghi.`,
      };
    }
    if (src === "SUGGESTION" && i.suggestions.length) {
      const step = i.suggestions.find((s) => STEP_ADVANCING_SUGGESTION_KEYS.includes(s.key));
      return suggestionAction(i.modelId, step ?? i.suggestions[0]);
    }
  }
  return null;
}

// ─────────────────────────── THẺ, BỘ LỌC, SỐ ĐẾM ───────────────────────────

export type PipelineCard = {
  modelId: string;
  code: string;
  name: string;
  image: string | null;
  state: ModelState | null;
  column: PipelineColumnKey;
  /** Mốc vào trạng thái hiện tại: lượt lịch sử gần nhất; chưa khai ⇒ lúc vào sổ. `null` = chưa biết. */
  since: Date | null;
  /** `since` là mốc vào sổ (chưa có dòng lịch sử nào) chứ không phải mốc khai. */
  sinceIsRegistered: boolean;
  ownerUserId: string | null;
  ownerName: string | null;
  /** Tín hiệu mẫu (S · lô) — `null` = không đọc được. */
  signal: ModelSignal | null;
  chips: PipelineChip[];
  next: PipelineNextAction | null;
};

/** Số ngày trọn ở trạng thái hiện tại. Mốc chưa biết ⇒ `null` (in "—"), không phải 0. */
export function daysInState(since: Date | null, now: Date): number | null {
  if (!since) return null;
  const d = Math.floor((now.getTime() - since.getTime()) / 86_400_000);
  return d < 0 ? 0 : d;
}

/** Giá trị facet "chưa giao người phụ trách". */
export const PIPELINE_OWNER_NONE = "none";

export type PipelineFilters = {
  /** `users.id` hoặc `PIPELINE_OWNER_NONE`; rỗng = mọi người. */
  owner: readonly string[];
  /** `departments.id` — mẫu có người phụ trách là thành viên CÒN HIỆU LỰC của phòng. */
  dept: readonly string[];
  q: string;
  /** Chỉ mẫu có việc tiếp theo. */
  onlyActionable: boolean;
};

export const EMPTY_PIPELINE_FILTERS: PipelineFilters = { owner: [], dept: [], q: "", onlyActionable: false };

function fold(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase();
}

/** Thẻ có khớp bộ lọc không. `deptsOfUser` = phòng còn hiệu lực của từng người (đọc qua `lib/org/membership.ts`). */
export function matchesPipelineFilters(card: PipelineCard, f: PipelineFilters, deptsOfUser: ReadonlyMap<string, readonly string[]>): boolean {
  if (f.owner.length) {
    const ok = card.ownerUserId ? f.owner.includes(card.ownerUserId) : f.owner.includes(PIPELINE_OWNER_NONE);
    if (!ok) return false;
  }
  if (f.dept.length) {
    const depts = card.ownerUserId ? (deptsOfUser.get(card.ownerUserId) ?? []) : [];
    if (!depts.some((d) => f.dept.includes(d))) return false;
  }
  const q = fold(f.q.trim());
  if (q && !fold(`${card.code} ${card.name}`).includes(q)) return false;
  if (f.onlyActionable && !card.next) return false;
  return true;
}

export type ColumnCount = { total: number; actionable: number };

/** Số đếm đầu cột — mọi cột đều có mặt (0 thật là 0: cột đã được đếm và không có mẫu nào). */
export function pipelineColumnCounts(cards: readonly PipelineCard[]): Record<PipelineColumnKey, ColumnCount> {
  const out = Object.fromEntries(PIPELINE_COLUMN_KEYS.map((k) => [k, { total: 0, actionable: 0 }])) as Record<PipelineColumnKey, ColumnCount>;
  for (const c of cards) {
    out[c.column].total += 1;
    if (c.next) out[c.column].actionable += 1;
  }
  return out;
}

/** Gom thẻ theo cột, giữ thứ tự đầu vào trong từng cột. */
export function groupPipelineCards(cards: readonly PipelineCard[]): Record<PipelineColumnKey, PipelineCard[]> {
  const out = Object.fromEntries(PIPELINE_COLUMN_KEYS.map((k) => [k, [] as PipelineCard[]])) as Record<PipelineColumnKey, PipelineCard[]>;
  for (const c of cards) out[c.column].push(c);
  return out;
}

/** Khoá đệm của bộ lọc — mọi tham số ảnh hưởng kết quả phải nằm trong khoá (AGENTS.md §2). */
export function pipelineFiltersKey(f: PipelineFilters): string {
  return JSON.stringify({ o: [...f.owner].sort(), d: [...f.dept].sort(), q: f.q.trim(), a: f.onlyActionable });
}

// ─────────────────────────── ĐƯỜNG DẪN ───────────────────────────

/** Giá trị `?view=` của bảng — bảng là MỘT CÁCH XEM của `/models` (cùng module Sản xuất, cùng quyền `models:view`). */
export const PIPELINE_VIEW = "bang";
export const PIPELINE_VIEW_HREF = `/models?view=${PIPELINE_VIEW}` as const;
