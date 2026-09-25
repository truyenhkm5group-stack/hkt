/**
 * ═══════════ VÒNG ĐỜI MẪU — BẢNG CẠNH, MÃ MẪU, GIAI ĐOẠN QUAN SÁT ═══════════
 *
 * Hợp đồng: docs/company-os/shared-contracts.md mục 1 · kiến trúc: target-architecture.md Q2–Q4, §3.
 * Tệp THUẦN — không đọc/ghi CSDL, client import được.
 *
 * ─── HAI THỨ KHÁC NHAU, KHÔNG BAO GIỜ GỘP ───
 *
 *  · TRẠNG THÁI KHAI (`product_models.lifecycle_state`): điều NGƯỜI nói về mẫu. `NULL` = CHƯA KHAI, không
 *    phải "đang bán" (mục 42). Chỉ đổi qua `transitionModelCore`.
 *  · GIAI ĐOẠN QUAN SÁT (`observeModelStage`): điều MÁY thấy trong chứng cứ (thiết kế đang test, có chi QC,
 *    có lệnh SX mở, có đơn…). Luôn mang nhãn ƯỚC TÍNH và KHÔNG BAO GIỜ được ghi vào `lifecycle_state` —
 *    máy ghi trạng thái là biến một phép đoán thành một lời khai có tên người.
 *
 * HOT / SLOW / DEAD / nên đặt lại / nên xả KHÔNG phải trạng thái vòng đời (Q4): chúng đổi mỗi ngày theo
 * tốc độ bán và được tính lúc đọc từ máy có sẵn.
 */
import type { DomainActorKind } from "@/lib/constants/domain-events";
import { normalizeProductCode } from "@/lib/constants/workshop-ledger";

export const MODEL_STATES = [
  "IDEA",
  "CREATIVE",
  "ADS_TESTING",
  "WINNER",
  "LOSER",
  "PRODUCTION_DISCUSSION",
  "COSTING",
  "SAMPLING",
  "SAMPLE_REVIEW",
  "APPROVED",
  "PRODUCTION_PLANNING",
  "IN_PRODUCTION",
  "SELLING",
  "CLEARANCE",
  "DISCONTINUED",
] as const;
export type ModelState = (typeof MODEL_STATES)[number];

export const MODEL_STATE_LABELS: Record<ModelState, string> = {
  IDEA: "Ý tưởng",
  CREATIVE: "Làm creative",
  ADS_TESTING: "Test quảng cáo",
  WINNER: "Thắng test",
  LOSER: "Thua test",
  PRODUCTION_DISCUSSION: "Bàn sản xuất",
  COSTING: "Tính giá thành",
  SAMPLING: "Làm mẫu",
  SAMPLE_REVIEW: "Duyệt mẫu",
  APPROVED: "Mẫu đã duyệt",
  PRODUCTION_PLANNING: "Lên kế hoạch SX",
  IN_PRODUCTION: "Đang sản xuất",
  SELLING: "Đang bán",
  CLEARANCE: "Xả tồn",
  DISCONTINUED: "Ngừng",
};

/** Nhãn của `NULL` — in ra màn hình, không bao giờ in "Đang bán" hay để trống. */
export const MODEL_STATE_UNDECLARED_LABEL = "Chưa khai";

const TONE_TEST = "bg-sky-100 text-sky-800 dark:bg-sky-950/60 dark:text-sky-300";
const TONE_PROD = "bg-violet-100 text-violet-800 dark:bg-violet-950/60 dark:text-violet-300";
const TONE_SELL = "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300";
const TONE_END = "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300";

/** Màu theo PHA của vòng đời — không phải màu "tốt/xấu" (mục 38: không tô màu kết luận). */
export const MODEL_STATE_TONE: Record<ModelState, string> = {
  IDEA: TONE_TEST,
  CREATIVE: TONE_TEST,
  ADS_TESTING: TONE_TEST,
  WINNER: TONE_TEST,
  LOSER: TONE_END,
  PRODUCTION_DISCUSSION: TONE_PROD,
  COSTING: TONE_PROD,
  SAMPLING: TONE_PROD,
  SAMPLE_REVIEW: TONE_PROD,
  APPROVED: TONE_PROD,
  PRODUCTION_PLANNING: TONE_PROD,
  IN_PRODUCTION: TONE_PROD,
  SELLING: TONE_SELL,
  CLEARANCE: TONE_SELL,
  DISCONTINUED: TONE_END,
};

export function isModelState(value: unknown): value is ModelState {
  return typeof value === "string" && (MODEL_STATES as readonly string[]).includes(value);
}

/**
 * CẠNH "TIẾN" — đi theo sơ đồ target-architecture.md §3, KHÔNG cần lý do.
 *
 *   IDEA → CREATIVE → ADS_TESTING ─┬─▶ WINNER → PRODUCTION_DISCUSSION → COSTING → SAMPLING → SAMPLE_REVIEW
 *                                  └─▶ LOSER                                            │   ▲ (yêu cầu sửa)
 *   DISCONTINUED ◀── CLEARANCE ◀── SELLING ◀── IN_PRODUCTION ◀── PRODUCTION_PLANNING ◀── APPROVED
 *                                   └──▶ PRODUCTION_PLANNING (tái sản xuất)
 *
 * Mọi cạnh KHÁC (lùi bước, nhảy cóc, ra khỏi LOSER / DISCONTINUED, khai lần đầu từ `NULL`) vẫn ĐƯỢC,
 * nhưng BẮT BUỘC lý do — `checkModelTransition` trả `needsReason: true`.
 */
export const MODEL_TRANSITIONS: Record<ModelState, readonly ModelState[]> = {
  IDEA: ["CREATIVE"],
  CREATIVE: ["ADS_TESTING"],
  ADS_TESTING: ["WINNER", "LOSER"],
  WINNER: ["PRODUCTION_DISCUSSION"],
  LOSER: [],
  PRODUCTION_DISCUSSION: ["COSTING"],
  COSTING: ["SAMPLING"],
  SAMPLING: ["SAMPLE_REVIEW"],
  SAMPLE_REVIEW: ["APPROVED", "SAMPLING"],
  APPROVED: ["PRODUCTION_PLANNING"],
  PRODUCTION_PLANNING: ["IN_PRODUCTION"],
  IN_PRODUCTION: ["SELLING"],
  SELLING: ["PRODUCTION_PLANNING", "CLEARANCE"],
  CLEARANCE: ["DISCONTINUED"],
  DISCONTINUED: [],
};

/** Lý do ngắn hơn thế này thì không ai đọc lại hiểu được vì sao — chặn ở lõi dịch vụ lẫn ô nhập. */
export const MODEL_REASON_MIN_LENGTH = 5;

export type ModelTransitionCheck = { ok: true; needsReason: boolean } | { ok: false; error: string };

/**
 * Kiểm một lượt chuyển. Thuần — dùng chung cho lõi dịch vụ (chặn thật) và giao diện (hiện ô lý do).
 *
 *  · `to === from` ⇒ lỗi (không có gì để ghi).
 *  · từ `NULL` (chưa khai) sang bất kỳ ⇒ được, CẦN lý do: đó là lời khai đầu tiên về một mẫu đã sống
 *    trước khi có sổ, người đọc sau phải biết căn cứ.
 *  · cạnh trong `MODEL_TRANSITIONS` ⇒ được, không cần lý do.
 *  · cạnh ngoài bảng ⇒ được, CẦN lý do.
 */
export function checkModelTransition(from: ModelState | null, to: ModelState): ModelTransitionCheck {
  if (!isModelState(to)) return { ok: false, error: `Trạng thái "${String(to)}" không có trong vòng đời mẫu` };
  if (from !== null && !isModelState(from)) return { ok: false, error: `Trạng thái hiện tại "${String(from)}" không có trong vòng đời mẫu` };
  if (from === to) return { ok: false, error: `Mẫu đang ở "${MODEL_STATE_LABELS[to]}" rồi` };
  if (from === null) return { ok: true, needsReason: true };
  return { ok: true, needsReason: !MODEL_TRANSITIONS[from].includes(to) };
}

/** Lý do có đạt yêu cầu không (sau khi cắt khoảng trắng). */
export function reasonIsEnough(reason: string | null | undefined): boolean {
  return (reason ?? "").trim().length >= MODEL_REASON_MIN_LENGTH;
}

/**
 * Chuẩn hoá mã mẫu. DÙNG LẠI `normalizeProductCode` (lib/constants/workshop-ledger.ts) — bộ chuẩn hoá
 * mã hàng đang chạy cho Sổ đặt xưởng và Giá báo MKT, và cùng phép với SQL của `resolveProductByCode`
 * (`upper(replace(trim(custom_id), ' ', ''))`). Một bộ thứ hai là mở đường cho "Q 002" khớp ở trang
 * này mà không khớp ở trang kia.
 *
 * Bỏ MỌI khoảng trắng và in hoa ("q 002 " → "Q002"). Rỗng / `null` ⇒ `null`: không có mã thì không
 * đăng ký, không bịa mã từ tên.
 */
export function normalizeModelCode(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const code = normalizeProductCode(raw);
  return code.length ? code : null;
}

/** Người thao tác trên vòng đời — cùng tập với `domain_events.actor_kind`. */
export type ModelActorKind = DomainActorKind;

// ─────────────────────────── GIAI ĐOẠN QUAN SÁT (ƯỚC TÍNH) ───────────────────────────

/**
 * Chứng cứ đọc từ các miền có sẵn. `null` ở một ô = CHƯA BIẾT / không đo được (ví dụ mẫu chưa có sản
 * phẩm Pancake thì không có đơn để đếm) — KHÁC với 0 (đã đo, không có).
 */
export type ModelEvidence = {
  /** `design_concepts.status` của thiết kế nối với mẫu; `null` = mẫu không đi từ vòng thiết kế. */
  designStatus: "DRAFT" | "TESTING" | "WIN" | "LOSE" | "PRODUCTION" | null;
  /** Sản phẩm Pancake đã bị xoá (`products.is_removed`); `null` = chưa có sản phẩm. */
  productRemoved: boolean | null;
  /** Chi quảng cáo 30 ngày gắn thẳng sản phẩm (`ad_spends.product_id`), VND. */
  adSpend30d: number | null;
  /** Số đơn lên 30 ngày (không kể huỷ / xoá) — đơn LÊN, không phải đơn giao thành công. */
  orders30d: number | null;
  /** Số đơn lên từ trước tới nay (không kể huỷ / xoá). */
  ordersTotal: number | null;
  /** Lệnh sản xuất nháp (DRAFT) của sản phẩm. */
  draftProductionOrders: number | null;
  /** Lệnh sản xuất đã gửi xưởng, chưa nhận (SENT). */
  sentProductionOrders: number | null;
  /** Có ít nhất một phiếu NHẬP HÀNG (RECEIPT) cho mẫu mã của sản phẩm — `stockKnownExpr`. */
  stockKnown: boolean | null;
  /** Tồn thực tế ERP (sổ kho). Chỉ có nghĩa khi `stockKnown`. */
  stockOnHand: number | null;
};

export type ObservedModelStage = { stage: ModelState | null; reasons: string[]; basis: "ESTIMATED" };

const nf = (n: number) => n.toLocaleString("vi-VN");

/**
 * Máy thấy gì trong chứng cứ. Mỗi chứng cứ góp MỘT ứng viên kèm câu lý do; giai đoạn trả về là ứng viên
 * ĐI XA NHẤT theo thứ tự `MODEL_STATES` (có lệnh SX đã gửi thì "đang sản xuất" thắng "thiết kế đang
 * test"). Mọi câu lý do đều được trả về — kể cả của ứng viên thua — để người đọc thấy chứng cứ mâu thuẫn.
 *
 * Không chứng cứ nào ⇒ `stage = null` (máy KHÔNG đoán), `reasons` rỗng.
 *
 * KHÔNG BAO GIỜ ghi kết quả này vào `lifecycle_state` (Q3).
 */
export function observeModelStage(e: ModelEvidence): ObservedModelStage {
  const ungVien: { stage: ModelState; reason: string }[] = [];

  if (e.productRemoved === true) ungVien.push({ stage: "DISCONTINUED", reason: "Sản phẩm đã bị xoá trên Pancake" });

  if ((e.sentProductionOrders ?? 0) > 0) ungVien.push({ stage: "IN_PRODUCTION", reason: `${nf(e.sentProductionOrders ?? 0)} lệnh sản xuất đã gửi xưởng, chưa nhận hàng` });
  if ((e.draftProductionOrders ?? 0) > 0) ungVien.push({ stage: "PRODUCTION_PLANNING", reason: `${nf(e.draftProductionOrders ?? 0)} lệnh sản xuất đang ở bản nháp` });

  if ((e.orders30d ?? 0) > 0) ungVien.push({ stage: "SELLING", reason: `${nf(e.orders30d ?? 0)} đơn lên trong 30 ngày (đơn lên, chưa kể kết quả giao)` });
  else if ((e.ordersTotal ?? 0) > 0 && e.stockKnown === true && (e.stockOnHand ?? 0) > 0)
    ungVien.push({ stage: "SELLING", reason: `Còn ${nf(e.stockOnHand ?? 0)} sản phẩm trong sổ kho, đã từng có ${nf(e.ordersTotal ?? 0)} đơn — 30 ngày nay chưa có đơn` });

  switch (e.designStatus) {
    case "PRODUCTION":
      ungVien.push({ stage: "PRODUCTION_DISCUSSION", reason: "Thiết kế đã được người đánh dấu “đưa vào sản xuất”" });
      break;
    case "WIN":
      ungVien.push({ stage: "WINNER", reason: "Thiết kế mang phán quyết THẮNG" });
      break;
    case "LOSE":
      ungVien.push({ stage: "LOSER", reason: "Thiết kế mang phán quyết Loại" });
      break;
    case "TESTING":
      ungVien.push({ stage: "ADS_TESTING", reason: "Thiết kế đang test quảng cáo" });
      break;
    case "DRAFT":
      ungVien.push({ stage: "CREATIVE", reason: "Thiết kế đang chờ test (bản nháp)" });
      break;
    default:
      break;
  }

  if ((e.adSpend30d ?? 0) > 0 && (e.orders30d ?? 0) === 0) ungVien.push({ stage: "ADS_TESTING", reason: `Có chi quảng cáo ${nf(e.adSpend30d ?? 0)} ₫ trong 30 ngày mà chưa có đơn` });

  if (!ungVien.length) return { stage: null, reasons: [], basis: "ESTIMATED" };
  const hang = (s: ModelState) => MODEL_STATES.indexOf(s);
  const chon = ungVien.reduce((a, b) => (hang(b.stage) > hang(a.stage) ? b : a));
  return { stage: chon.stage, reasons: ungVien.map((u) => u.reason), basis: "ESTIMATED" };
}

// ─────────────────────────── DÒNG THỜI GIAN MẪU ───────────────────────────

/**
 * Chiều của một mốc trên dòng thời gian mẫu. `LIFECYCLE` là mốc của CHÍNH sổ mẫu (sự kiện + lịch sử);
 * bốn chiều kia là PHÉP CHIẾU từ nhật ký của miền khác — không chép, chỉ đọc (Q5).
 */
export const MODEL_TIMELINE_DIMENSIONS = ["LIFECYCLE", "DESIGN", "PRODUCTION", "INVENTORY", "ORDER"] as const;
export type ModelTimelineDimension = (typeof MODEL_TIMELINE_DIMENSIONS)[number];

export const MODEL_TIMELINE_DIMENSION_LABEL: Record<ModelTimelineDimension, string> = {
  LIFECYCLE: "Vòng đời",
  DESIGN: "Thiết kế",
  PRODUCTION: "Sản xuất",
  INVENTORY: "Kho",
  ORDER: "Đơn hàng",
};

export const MODEL_TIMELINE_DIMENSION_TONE: Record<ModelTimelineDimension, string> = {
  LIFECYCLE: "bg-primary/10 text-primary",
  DESIGN: "bg-sky-100 text-sky-800 dark:bg-sky-950/60 dark:text-sky-300",
  PRODUCTION: "bg-violet-100 text-violet-800 dark:bg-violet-950/60 dark:text-violet-300",
  INVENTORY: "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300",
  ORDER: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300",
};
