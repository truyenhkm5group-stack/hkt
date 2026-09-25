import type { Permission } from "@/lib/auth/permissions";
import { formatVND } from "@/lib/format";

/**
 * ═══════════ CẦN ANH QUYẾT — BUỒNG LÁI CỦA CHỦ SHOP (Company OS · Agent H) ═══════════
 *
 * Kiến trúc: docs/company-os/target-architecture.md mục 6. Tệp THUẦN — client import được.
 *
 * Một chỗ duy nhất trên trang chủ cho những QUYẾT ĐỊNH thuộc về người điều hành, mỗi dòng trả lời đủ
 * năm câu: CÁI GÌ · VÌ SAO · SỐ LIỆU · TÁC ĐỘNG · LÀM Ở ĐÂU.
 *
 * ─── HÀNG ĐỢI NÀY LÀ PHÉP CHIẾU, KHÔNG PHẢI MIỀN MỚI (luật 19) ───
 *
 * Không nguồn nào ở đây có công thức hay ngưỡng của riêng nó (luật 27, 38). Mỗi loại đọc lại ĐÚNG hàm
 * mà màn hình chủ của nó đang dùng: yêu cầu duyệt (`listApprovalRequests`), mẫu chờ duyệt và topic chờ
 * chốt (hai adapter của `/work`), lệnh SX quá hẹn (`getPurchasingReport`), cắt quảng cáo
 * (`adaptAdsDecisions` + `getAdsDecision`), mẫu THẮNG chưa mở topic sản xuất (`getModelSignalsBatch` —
 * tín hiệu mẫu đầy đủ của A2 đọc theo lô) và mẫu TRIỂN VỌNG nên cân nhắc mở topic SỚM (cùng lô, Agent T),
 * và ba kết luận tồn kho (`getInventoryDecisionReport` →
 * `decideInventory`, đã trừ hàng đặt xưởng).
 *
 * Người ĐÓNG việc ở màn hình chủ của nó — không có nút "xong" ở đây. Ba nút của cockpit chỉ GHI LẠI
 * phản ứng của người đọc với ĐỀ XUẤT (`recommendation_decisions`, append-only), để sau này đo được đề
 * xuất nào được nghe theo:
 *
 *  · CHẤP NHẬN  — dòng VẪN nằm trong hàng đợi cho tới khi điều kiện ở nguồn hết (chấp nhận ≠ đã làm).
 *  · BỎ QUA     — bắt buộc lý do; dòng ẩn cho tới khi KHOÁ NGUỒN đổi (nguồn nói một điều khác).
 *  · NHẮC LẠI SAU — ẩn tới đúng ngày người chọn, rồi tự hiện lại.
 */

// ─────────────────────────── LOẠI QUYẾT ĐỊNH ───────────────────────────

export const OWNER_DECISION_KINDS = [
  "APPROVAL",
  "SAMPLE_REVIEW",
  "TOPIC_DECISION",
  "ADS_CUT",
  "INVENTORY_STOCKOUT",
  "PRODUCTION_LATE",
  "INVENTORY_REORDER",
  "MODEL_SCALE",
  "MODEL_EARLY_TOPIC",
  "INVENTORY_CLEARANCE",
] as const;
export type OwnerDecisionKind = (typeof OWNER_DECISION_KINDS)[number];

/** Nguồn đọc — một nguồn có thể sinh nhiều loại (quyết định tồn sinh ba). */
export const OWNER_DECISION_SOURCES = ["APPROVALS", "SAMPLES", "TOPICS", "ADS_CUT", "MODEL_SCALE", "PRODUCTION_LATE", "INVENTORY"] as const;
export type OwnerDecisionSource = (typeof OWNER_DECISION_SOURCES)[number];

export const OWNER_DECISION_SOURCE_LABEL: Record<OwnerDecisionSource, string> = {
  APPROVALS: "Yêu cầu duyệt",
  SAMPLES: "Mẫu chờ duyệt",
  TOPICS: "Topic sản xuất",
  ADS_CUT: "Quyết định quảng cáo",
  MODEL_SCALE: "Tín hiệu mẫu",
  PRODUCTION_LATE: "Lệnh sản xuất",
  INVENTORY: "Quyết định vốn tồn",
};

export type OwnerDecisionKindSpec = {
  label: string;
  source: OwnerDecisionSource;
  /** Màn hình chủ — nơi việc thật được làm và đóng. */
  home: string;
  /**
   * Quyền PHẢI có đủ để thấy loại này: quyền xem màn hình chủ, cộng quyền QUYẾT nếu màn hình chủ tách
   * xem / quyết. Cockpit không là cửa sau: người không mở được màn hình chủ thì không thấy số của nó.
   */
  requires: readonly Permission[];
  /** Loại dữ liệu có phạm vi (`lib/constants/data-scope-policy.ts`) — phạm vi `NONE` ⇒ không thấy. */
  scopeResource: "ADS" | null;
  /** Một câu cho ⓘ: nguồn đọc và vì sao nó là quyết định của người điều hành. */
  hint: string;
};

export const OWNER_DECISION_KIND_SPEC: Record<OwnerDecisionKind, OwnerDecisionKindSpec> = {
  APPROVAL: {
    label: "Yêu cầu chờ duyệt",
    source: "APPROVALS",
    home: "/alerts",
    requires: ["alerts:view", "approvals:decide"],
    scopeResource: null,
    hint: "Duyệt hai bước đang chờ (listApprovalRequests — cùng truy vấn với trang Cần xử lý và /work). Yêu cầu do chính anh xin không hiện ở đây: người xin không tự duyệt được.",
  },
  SAMPLE_REVIEW: {
    label: "Mẫu xưởng chờ duyệt",
    source: "SAMPLES",
    home: "/production",
    requires: ["planning:view", "production:approve"],
    scopeResource: null,
    hint: "Phiên bản mẫu ở trạng thái Đã gửi duyệt (cùng phép chiếu với nguồn việc SAMPLE_REVIEW). Duyệt / loại cần quyền production:approve.",
  },
  TOPIC_DECISION: {
    label: "Topic chờ chốt phương án",
    source: "TOPICS",
    home: "/production",
    requires: ["planning:view", "production:write"],
    scopeResource: null,
    hint: "Topic sản xuất đang “Đủ phương án” hoặc “Chờ quyết” (cùng phép chiếu với nguồn việc PRODUCTION_TOPIC, chỉ hai trạng thái cần người chốt).",
  },
  ADS_CUT: {
    label: "Chiến dịch nên CẮT",
    source: "ADS_CUT",
    home: "/ads",
    requires: ["expenses:view"],
    scopeResource: "ADS",
    hint: "Dòng CẮT của bảng quyết định quảng cáo 30 ngày, cấp chiến dịch, CHỈ dòng biết số chi (cùng phép chiếu với nguồn việc ADS_DECISION). Tác động = lỗ sau quảng cáo — tạm tính khi phần lớn đơn còn đang đi.",
  },
  INVENTORY_STOCKOUT: {
    label: "Nguy cơ hết hàng",
    source: "INVENTORY",
    home: "/inventory/decisions",
    requires: ["planning:view"],
    scopeResource: null,
    hint: "Kết luận STOCKOUT_RISK của trang Quyết định vốn tồn (decideInventory, đã trừ hàng đặt xưởng chưa nhận). Tác động là ƯỚC TÍNH lãi gộp mất nếu để hết hàng.",
  },
  PRODUCTION_LATE: {
    label: "Lệnh sản xuất quá hẹn",
    source: "PRODUCTION_LATE",
    home: "/inventory/purchasing",
    requires: ["planning:view"],
    scopeResource: null,
    hint: "Lệnh ĐÃ GỬI xưởng, chưa nhận, đã qua ngày hẹn (cùng danh sách “cam kết đang mở” của trang Mua hàng & xưởng). Lệnh nháp chưa gửi không có ở đây — nó chưa là một lời hẹn với xưởng.",
  },
  INVENTORY_REORDER: {
    label: "Nên đặt thêm",
    source: "INVENTORY",
    home: "/inventory/decisions",
    requires: ["planning:view"],
    scopeResource: null,
    hint: "Kết luận REORDER của trang Quyết định vốn tồn. Số nên đặt đã trừ hàng đặt xưởng chưa nhận; tác động = vốn cần bỏ ra (chưa biết giá nhập ⇒ —).",
  },
  MODEL_SCALE: {
    label: "Mẫu THẮNG chưa mở topic sản xuất",
    source: "MODEL_SCALE",
    home: "/models",
    requires: ["models:view", "expenses:view"],
    scopeResource: "ADS",
    hint: "Mẫu có tín hiệu THẮNG trong 30 ngày (tín hiệu mẫu của trang 360: quảng cáo có lãi VÀ phân loại mẫu mã tốt, không nguồn nào nói ngược — getModelSignalsBatch), chưa có topic sản xuất đang mở và trạng thái khai còn trước “Bàn sản xuất”. Mỗi ô số liệu là NHÃN phán quyết của một nguồn. Bỏ qua có hiệu lực tới khi tín hiệu hoặc một phán quyết nguồn đổi.",
  },
  MODEL_EARLY_TOPIC: {
    label: "Mẫu TRIỂN VỌNG — cân nhắc mở topic sản xuất sớm",
    // Cùng nguồn đọc với MODEL_SCALE (một lượt `getModelSignalsBatch` sinh cả hai loại) — cùng quyền.
    source: "MODEL_SCALE",
    home: "/models",
    requires: ["models:view", "expenses:view"],
    scopeResource: "ADS",
    hint: "Quy tắc chủ shop 25/09/2026: topic sản xuất mở được cho mẫu có chỉ số tốt mà CHƯA thắng. Mẫu có tín hiệu TRIỂN VỌNG trong 30 ngày (getModelSignalsBatch — thiếu một nguồn thị trường, hoặc mới thắng ở vòng thử creative / thiết kế), chưa có topic sản xuất đang mở, trạng thái khai còn trước “Bàn sản xuất” (Loại / Ngừng không vào). Topic mở sớm chạy SONG SONG với test quảng cáo — vòng đời mẫu không đổi. Ưu tiên thấp hơn mẫu THẮNG; không gửi tin gấp, chỉ vào bản tin sáng. Bỏ qua có hiệu lực tới khi tín hiệu hoặc một phán quyết nguồn đổi.",
  },
  INVENTORY_CLEARANCE: {
    label: "Nên xả / dừng",
    source: "INVENTORY",
    home: "/inventory/decisions",
    requires: ["planning:view"],
    scopeResource: null,
    hint: "Kết luận CLEARANCE_CANDIDATE của trang Quyết định vốn tồn. Tác động = vốn theo giá nhập giải phóng được nếu xả phần vượt mức.",
  },
};

// ─────────────────────────── MỘT DÒNG QUYẾT ĐỊNH ───────────────────────────

/** Một ô số liệu. `value = null` ⇒ CHƯA BIẾT, in "—" (luật 42). Giá trị đã định dạng ở máy chủ. */
export type OwnerDecisionDatum = { label: string; value: string | null };

export type OwnerDecisionItem = {
  kind: OwnerDecisionKind;
  /**
   * KHOÁ ỔN ĐỊNH của đề xuất. Đổi khi và CHỈ khi nguồn nói một điều khác (topic đổi trạng thái, lệnh đổi
   * ngày hẹn, kết luận tồn đổi loại, quyết định quảng cáo đổi căn cứ đo được ↔ tạm tính) — đó là lúc một
   * lời "bỏ qua" cũ hết hiệu lực.
   */
  sourceKey: string;
  what: string;
  why: string;
  data: OwnerDecisionDatum[];
  /** `amountVnd = null` ⇒ CHƯA BIẾT hoặc không có tiền đo được — `basis` nói cái nào. */
  impact: { amountVnd: number | null; basis: string };
  action: { label: string; href: string };
  /** Mẫu liên quan (để sự kiện `recommendation.decided` hiện trên dòng thời gian mẫu). */
  modelId: string | null;
};

// ─────────────────────────── PHẢN ỨNG CỦA NGƯỜI ĐỌC ───────────────────────────

export const RECOMMENDATION_DECISIONS = ["ACCEPTED", "DISMISSED", "SNOOZED"] as const;
export type RecommendationDecision = (typeof RECOMMENDATION_DECISIONS)[number];

export const RECOMMENDATION_DECISION_LABEL: Record<RecommendationDecision, string> = {
  ACCEPTED: "Chấp nhận",
  DISMISSED: "Bỏ qua",
  SNOOZED: "Nhắc lại sau",
};

/** Độ dài tối thiểu của lý do bỏ qua — cùng mức mọi ô lý do khác của Company OS (≥ 5 ký tự). */
export const DISMISS_REASON_MIN = 5;

/** Một dòng `recommendation_decisions` ở dạng cockpit cần đọc. */
export type RecommendationDecisionRow = {
  id: string;
  sourceKey: string;
  kind: string;
  decision: RecommendationDecision;
  reason: string;
  snoozeUntil: Date | null;
  decidedByUserId: string;
  decidedBy: string;
  decidedAt: Date;
};

export type DecisionRequest = { decision: RecommendationDecision; reason: string; snoozeUntil: Date | null };

/** Luật của một lượt ghi — hàm thuần, lõi dịch vụ và biểu mẫu cùng gọi. */
export function checkDecisionRequest(r: DecisionRequest, now: Date): { ok: true } | { error: string } {
  if (!(RECOMMENDATION_DECISIONS as readonly string[]).includes(r.decision)) return { error: "Quyết định không hợp lệ" };
  if (r.decision === "DISMISSED" && r.reason.trim().length < DISMISS_REASON_MIN) {
    return { error: `Bỏ qua một đề xuất phải nêu lý do (ít nhất ${DISMISS_REASON_MIN} ký tự) — không có lý do thì không đo được đề xuất sai ở đâu` };
  }
  if (r.decision === "SNOOZED") {
    if (!r.snoozeUntil || Number.isNaN(r.snoozeUntil.getTime())) return { error: "Chọn ngày muốn được nhắc lại" };
    if (r.snoozeUntil.getTime() <= now.getTime()) return { error: "Ngày nhắc lại phải ở tương lai" };
  } else if (r.snoozeUntil) {
    return { error: "Chỉ “Nhắc lại sau” mới có ngày nhắc" };
  }
  return { ok: true };
}

/**
 * Dòng MỚI NHẤT của mỗi khoá. Đầu vào đã xếp theo thời điểm quyết TĂNG DẦN (truy vấn làm việc đó);
 * cùng mốc thì dòng đứng sau thắng. Một bản gập duy nhất cho mọi nơi đọc sổ.
 */
export function foldLatestDecisions<T extends { sourceKey: string; decidedAt: Date }>(rows: readonly T[]): Map<string, T> {
  const out = new Map<string, T>();
  for (const r of rows) {
    const cur = out.get(r.sourceKey);
    if (!cur || r.decidedAt.getTime() >= cur.decidedAt.getTime()) out.set(r.sourceKey, r);
  }
  return out;
}

/** Lượt bấm lặp lại đúng phản ứng đang có hiệu lực ⇒ không ghi thêm (cùng tinh thần luật 61). */
export function repeatsLatest(latest: Pick<RecommendationDecisionRow, "decision" | "snoozeUntil" | "reason"> | undefined, r: DecisionRequest): boolean {
  if (!latest || latest.decision !== r.decision) return false;
  if (r.decision === "SNOOZED") return (latest.snoozeUntil?.getTime() ?? null) === (r.snoozeUntil?.getTime() ?? null);
  if (r.decision === "DISMISSED") return latest.reason.trim() === r.reason.trim();
  return true;
}

export type DecoratedItem = OwnerDecisionItem & { latest: RecommendationDecisionRow | null };

/**
 * Áp sổ phản ứng lên tập đề xuất ĐANG CÓ ở nguồn. `now` truyền vào (kiểm thử dựng từ dữ liệu, không từ
 * đồng hồ thật — luật 50, 65).
 *
 *  · BỎ QUA                          ⇒ ẩn (cho tới khi khoá nguồn đổi: khoá mới không có dòng sổ nào).
 *  · NHẮC LẠI SAU, chưa tới ngày     ⇒ ẩn; tới ngày ⇒ hiện lại như chưa ai đụng.
 *  · CHẤP NHẬN                       ⇒ VẪN HIỆN, mang dấu đã chấp nhận: chấp nhận không phải đã làm, và
 *    việc chỉ rời hàng đợi khi điều kiện ở nguồn hết (luật 19).
 */
export function applyDecisions(items: readonly OwnerDecisionItem[], latest: ReadonlyMap<string, RecommendationDecisionRow>, now: Date): { visible: DecoratedItem[]; hidden: DecoratedItem[] } {
  const visible: DecoratedItem[] = [];
  const hidden: DecoratedItem[] = [];
  for (const it of items) {
    const d = latest.get(it.sourceKey) ?? null;
    if (d?.decision === "DISMISSED") hidden.push({ ...it, latest: d });
    else if (d?.decision === "SNOOZED" && d.snoozeUntil && d.snoozeUntil.getTime() > now.getTime()) hidden.push({ ...it, latest: d });
    else visible.push({ ...it, latest: d?.decision === "ACCEPTED" ? d : null });
  }
  return { visible, hidden };
}

export type KindGroup = { kind: OwnerDecisionKind; label: string; count: number; items: DecoratedItem[] };

/**
 * Gom theo loại, giữ thứ tự `OWNER_DECISION_KINDS`. Trong một loại: tác động lớn trước, tác động CHƯA
 * BIẾT xếp sau cùng (giữ thứ tự nguồn) — xếp chưa-biết như 0 là nói nó nhỏ, mà ta không biết điều đó.
 */
export function groupByKind(items: readonly DecoratedItem[]): KindGroup[] {
  const out: KindGroup[] = [];
  for (const kind of OWNER_DECISION_KINDS) {
    const of = items
      .map((it, i) => ({ it, i }))
      .filter(({ it }) => it.kind === kind)
      .sort((a, b) => {
        const x = a.it.impact.amountVnd;
        const y = b.it.impact.amountVnd;
        if (x === null && y === null) return a.i - b.i;
        if (x === null) return 1;
        if (y === null) return -1;
        return y - x || a.i - b.i;
      })
      .map(({ it }) => it);
    if (of.length) out.push({ kind, label: OWNER_DECISION_KIND_SPEC[kind].label, count: of.length, items: of });
  }
  return out;
}

/**
 * Loại nào người xem được thấy. `can` = quyền; `scopeOk` = phạm vi dữ liệu của loại có phạm vi.
 * Thiếu MỘT quyền trong `requires` ⇒ không thấy (hỏng về phía hẹp).
 */
export function allowedKinds(can: (p: Permission) => boolean, scopeOk: (resource: "ADS") => boolean): OwnerDecisionKind[] {
  return OWNER_DECISION_KINDS.filter((k) => {
    const s = OWNER_DECISION_KIND_SPEC[k];
    if (!s.requires.every((p) => can(p))) return false;
    return s.scopeResource === null || scopeOk(s.scopeResource);
  });
}

/** Nguồn cần đọc cho tập loại được thấy — nguồn không sinh loại nào được thấy thì KHÔNG đọc. */
export function sourcesFor(kinds: readonly OwnerDecisionKind[]): OwnerDecisionSource[] {
  return OWNER_DECISION_SOURCES.filter((s) => kinds.some((k) => OWNER_DECISION_KIND_SPEC[k].source === s));
}

// ─────────────────────────── IN SỐ ───────────────────────────

/** Ô số liệu: `null` ⇒ "—" (chưa biết), không bao giờ "0". */
export function datumText(v: string | null | undefined): string {
  return v === null || v === undefined || v === "" ? "—" : v;
}

/** Tác động: `null` ⇒ "—"; 0 thật ⇒ "0 ₫". */
export function impactText(amountVnd: number | null): string {
  return formatVND(amountVnd, { compact: true });
}
