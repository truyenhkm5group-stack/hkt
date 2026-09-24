import type { AdsWriteMode } from "@/lib/constants/ads-write";
import { CREATIVE_HARD_LIMITS, type CreativeVerdict, type VariantStatus } from "@/lib/constants/creative-loop";
import { gateCreativeWrite, type CreativeGateResult } from "@/lib/marketing/creative-write-gate";

/**
 * ═══════════ "CHO TIÊU THÊM" — PHÉP TÍNH THUẦN ═══════════
 *
 * Đặc tả: `docs/creative-loop.md` §0 (điều suy ra 1) và §3. Action: `lib/actions/creative-extend.ts`.
 *
 * Không đọc CSDL, không đọc đồng hồ (giờ là THAM SỐ), không gọi mạng, không đọc env — cùng tinh thần
 * `gateCreativeWrite`. Bước ĐỀ NGHỊ và bước ÁP gọi CHUNG hàm này với dữ liệu đọc lại từ CSDL, nên hai
 * bước không thể tính ra hai con số theo hai luật.
 *
 * ─── BA CON SỐ, VÀ VÌ SAO ───
 *
 *  · SỐ TIỀN THÊM = ngân sách một mẫu của ẢNH CHỤP LÔ (con số người duyệt lô đã thấy), KẸP bởi trần
 *    một lượt bấm `maxExtensionPerClickVnd`. Kẹp chứ không chặn: người bấm "cho tiêu thêm" xin một
 *    lượt nữa như lượt test, trần chỉ làm lượt ấy nhỏ lại. Trần NGÀY thì cổng CHẶN — kẹp theo phần
 *    còn lại của ngày là đoán hộ một con số người bấm chưa nhìn thấy.
 *  · NGÂN SÁCH TRỌN ĐỜI MỚI = đã cam kết + số thêm. Đã cam kết CHƯA BIẾT ⇒ KHÔNG tính (mục 42):
 *    ghi một ngân sách trọn đời đoán lên Facebook có thể làm nhóm tiêu ÍT hơn hoặc NHIỀU hơn đã duyệt.
 *  · KHUNG MỚI = kéo `end_time` thêm 24 giờ tính từ max(bây giờ, hạn cũ). Hạn cũ đã qua thì tính từ
 *    bây giờ — kéo từ một mốc trong quá khứ là cho một khung ngắn hơn 24 giờ mà người bấm tưởng đủ.
 *
 * ─── PHIẾU CŨ ───
 *
 * Khung mới phụ thuộc `now` khi hạn cũ đã qua, nên lúc ÁP nó không bao giờ trùng tới mili giây với
 * lúc ĐỀ NGHỊ. Phiếu ký khung của lúc đề nghị; lúc áp tính lại và chỉ nhận khi lệch không quá
 * `EXTENSION_TICKET_TTL_MINUTES` — đó cũng là hạn dùng của phiếu. Tiền thì phải KHỚP TUYỆT ĐỐI: bấm
 * lần hai sau khi lần một đã áp thì ngân sách trọn đời tính lại đã khác ⇒ phiếu cũ vô hiệu.
 */

/** Một lượt "cho tiêu thêm" kéo `end_time` thêm bấy nhiêu giờ. */
export const EXTENSION_HOURS = 24;

/** Phiếu tiêu thêm dùng được trong bấy nhiêu phút kể từ lúc đề nghị. */
export const EXTENSION_TICKET_TTL_MINUTES = 15;

/** Trạng thái mẫu cho tiêu thêm được: đang chạy, hoặc đã hết khung test. Mẫu đã TẮT là do luật hoặc người quyết. */
export const EXTENDABLE_STATUSES: readonly VariantStatus[] = ["LIVE", "ENDED"];

export type ExtensionInput = {
  status: VariantStatus;
  /** Nhóm quảng cáo của mẫu (do vòng tạo). `null` = chưa đăng. */
  fbAdsetId: string | null;
  /** Lô đã có `approval_digest` (người đã duyệt lô). */
  batchApproved: boolean;
  verdict: CreativeVerdict;
  /** Ngân sách trọn đời ĐÃ CAM KẾT hiện tại. `null` = CHƯA BIẾT. */
  committedBudgetVnd: number | null;
  /** Ngân sách một mẫu đọc NGUYÊN từ ảnh chụp lô (`batchConfig`), chưa kẹp. 0 = ảnh chụp không có. */
  budgetPerVariantVnd: number;
  /** Hạn hiện tại của nhóm: `end_time` của lượt tiêu thêm gần nhất, không có thì cuối khung test. */
  currentEndAt: Date;
  now: Date;
  // ── cho cổng ──
  hardEnabled: boolean;
  mode: AdsWriteMode;
  configComplete: boolean;
  /** Đề nghị: `true` (xem trước NHƯ THỂ người đã bấm). Áp: phiếu hợp lệ. */
  approved: boolean;
  /** Digest lô tính lại khớp `approval_digest` (và, lúc áp, số tính lại khớp phiếu). */
  approvalMatches: boolean;
  testCampaignId: string;
  startAt: Date;
  batchSize: number;
  /** Tổng tiêu thêm đã áp trong ngày bấm, toàn shop (`extendedOnDay`). */
  extendedTodayVnd: number;
};

export type ExtensionPlan = {
  addVnd: number;
  newLifetimeVnd: number;
  newEndAt: Date;
  /** Số tiền thêm đã bị kẹp bởi trần một lượt (ảnh chụp lô xin nhiều hơn). */
  clamped: boolean;
};

export type ExtensionResult = ({ ok: true } & ExtensionPlan) | { ok: false; reason: string; plan: ExtensionPlan | null; gate: CreativeGateResult | null };

/** Khung mới: `max(now, hạn cũ) + 24 giờ`. */
export function extensionEndAt(currentEndAt: Date, now: Date): Date {
  const from = Math.max(now.getTime(), currentEndAt.getTime());
  return new Date(from + EXTENSION_HOURS * 3_600_000);
}

/** Số tiền thêm: ngân sách một mẫu của ảnh chụp, kẹp bởi trần một lượt. */
export function extensionAmount(budgetPerVariantVnd: number): { addVnd: number; clamped: boolean } {
  const b = Number.isFinite(budgetPerVariantVnd) ? Math.round(budgetPerVariantVnd) : 0;
  const cap = CREATIVE_HARD_LIMITS.maxExtensionPerClickVnd;
  return b > cap ? { addVnd: cap, clamped: true } : { addVnd: b, clamped: false };
}

/**
 * Tính một lượt tiêu thêm và chạy cổng nhánh `EXTEND_ADSET`. Điều kiện của MẪU (trạng thái, có nhóm,
 * lô đã duyệt, biết ngân sách đã cam kết) xét trước cổng — chúng không phải lý do ghi bị chặn mà là
 * lý do KHÔNG CÓ GÌ để ghi.
 */
export function planExtension(i: ExtensionInput): ExtensionResult {
  if (!EXTENDABLE_STATUSES.includes(i.status)) return { ok: false, reason: `Mẫu đang ở trạng thái ${i.status} — chỉ mẫu đang chạy hoặc đã hết khung test mới cho tiêu thêm được.`, plan: null, gate: null };
  if (!i.fbAdsetId) return { ok: false, reason: "Mẫu chưa có nhóm quảng cáo trên Facebook.", plan: null, gate: null };
  if (!i.batchApproved) return { ok: false, reason: "Lô của mẫu chưa có phiếu duyệt — không có căn cứ nào cho một đồng tiêu thêm.", plan: null, gate: null };
  if (i.committedBudgetVnd === null || !Number.isInteger(i.committedBudgetVnd) || i.committedBudgetVnd <= 0) {
    return { ok: false, reason: "Chưa biết ngân sách trọn đời đã cam kết của mẫu — không tính được ngân sách mới.", plan: null, gate: null };
  }

  const { addVnd, clamped } = extensionAmount(i.budgetPerVariantVnd);
  const plan: ExtensionPlan = { addVnd, newLifetimeVnd: i.committedBudgetVnd + addVnd, newEndAt: extensionEndAt(i.currentEndAt, i.now), clamped };

  const gate = gateCreativeWrite({
    hardEnabled: i.hardEnabled,
    mode: i.mode,
    action: "EXTEND_ADSET",
    configComplete: i.configComplete,
    approved: i.approved,
    approvalMatches: i.approvalMatches,
    testCampaignId: i.testCampaignId,
    targetCampaignId: null,
    templateCampaignId: null,
    ourAdset: true,
    now: i.now,
    startAt: i.startAt,
    budgetPerVariantVnd: i.budgetPerVariantVnd,
    publishedInBatch: 0,
    batchSize: i.batchSize,
    committedDayVnd: 0,
    variantHasAdset: true,
    pauseKind: null,
    killRuleFired: false,
    promising: i.verdict === "PROMISING",
    extensionVnd: addVnd,
    extendedTodayVnd: i.extendedTodayVnd,
  });
  if (!gate.ok) return { ok: false, reason: gate.reason, plan, gate };
  return { ok: true, ...plan };
}

/**
 * Số tính lại lúc ÁP có khớp phiếu không. Tiền: khớp tuyệt đối. Khung: lệch không quá hạn phiếu —
 * và khung đã ký phải còn ở TƯƠNG LAI.
 */
export function extensionMatchesTicket(signed: { addVnd: number; newLifetimeVnd: number; newEndAt: Date }, fresh: ExtensionPlan, now: Date): { ok: true } | { ok: false; reason: string } {
  if (signed.addVnd !== fresh.addVnd || signed.newLifetimeVnd !== fresh.newLifetimeVnd) {
    return { ok: false, reason: "Số tiền tính lại đã khác lúc đề nghị (có lượt tiêu thêm khác vừa áp, hoặc ảnh chụp lô đã đổi). Mở lại đề nghị." };
  }
  const drift = Math.abs(fresh.newEndAt.getTime() - signed.newEndAt.getTime());
  if (drift > EXTENSION_TICKET_TTL_MINUTES * 60_000) return { ok: false, reason: `Phiếu đã quá ${EXTENSION_TICKET_TTL_MINUTES} phút hoặc hạn nhóm đã đổi. Mở lại đề nghị.` };
  if (signed.newEndAt.getTime() <= now.getTime()) return { ok: false, reason: "Khung mới trên phiếu đã ở quá khứ. Mở lại đề nghị." };
  return { ok: true };
}
