import { desc, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { can } from "@/lib/auth/session";
import { decideScope } from "@/lib/auth/scope-guard";
import { APPROVAL_GROUP_LABEL, type ApprovalGroup } from "@/lib/constants/approval";
import { DECISION_LABEL, type InventoryDecisionKind } from "@/lib/constants/inventory-decision";
import { BEFORE_PRODUCTION_DISCUSSION } from "@/lib/constants/model-360";
import { MODEL_SIGNAL_HINT, MODEL_SIGNAL_LABEL, SIGNAL_SOURCE_LABEL, type SignalSource } from "@/lib/constants/model-signal";
import {
  allowedKinds,
  applyDecisions,
  foldLatestDecisions,
  groupByKind,
  OWNER_DECISION_KIND_SPEC,
  OWNER_DECISION_SOURCE_LABEL,
  sourcesFor,
  type DecoratedItem,
  type KindGroup,
  type OwnerDecisionItem,
  type OwnerDecisionKind,
  type OwnerDecisionSource,
  type RecommendationDecisionRow,
} from "@/lib/constants/owner-decisions";
import { TOPIC_STATUS_LABEL, type TopicStatus } from "@/lib/constants/production-os";
import type { WorkItem } from "@/lib/constants/work";
import { formatDate, formatDateTime, formatNumber, formatVND, vnDateKey } from "@/lib/format";
import { getAdsDecision, type AdsDecisionRow } from "@/lib/queries/ads-decision";
import { listApprovalRequests, type ApprovalRequestRow } from "@/lib/queries/approvals";
import { getInventoryDecisionReport, type InventoryDecisionRow } from "@/lib/queries/inventory-decision";
import { getModelSignalsBatch, type ModelSignalBatchRow, type ModelSignalReport } from "@/lib/queries/model-signal";
import { getPurchasingReport, type OpenProductionOrder } from "@/lib/queries/purchasing";
import { adaptAdsDecisions, adaptProductionTopics, adaptSampleReviews } from "@/lib/queries/work-adapters";
import { readDecisionRows, toRow } from "@/lib/owner-decisions/service";
import { resolvePeriod } from "@/lib/search-params";

/**
 * ═══════════ "CẦN ANH QUYẾT" — GOM NGUỒN (Company OS · Agent H) ═══════════
 *
 * Luật và kiểu: `lib/constants/owner-decisions.ts`. Tệp này chỉ làm ba việc:
 *
 *  1. ĐỌC LẠI đúng hàm mà màn hình chủ của mỗi loại đang dùng — không một điều kiện `stage`, một ngưỡng
 *     hay một công thức tiền nào được viết lại ở đây (luật 27, 38; AGENTS.md mục 8.12).
 *  2. ĐỔI HÌNH DẠNG sang CÁI GÌ · VÌ SAO · SỐ LIỆU · TÁC ĐỘNG · NÚT (các hàm `…ToItems`, thuần).
 *  3. Áp sổ phản ứng (`applyDecisions`) và quyền của người xem.
 *
 * ─── MỘT NGUỒN HỎNG / CHẬM KHÔNG GIỮ CẢ KHỐI LÀM CON TIN ───
 *
 * Mỗi nguồn có hạn giờ riêng (cùng cách `collectWorkItems` làm): quá hạn hoặc ném lỗi thì nguồn đó trả
 * rỗng và ĐƯỢC NÊU TÊN ở `failed` — khối in "chưa đọc được: …" thay vì một hàng đợi ngắn hơn thực tế mà
 * không ai biết. Lượt gọi quá hạn không bị huỷ: nó chạy tiếp và làm nóng `memo()` cho lần mở sau.
 *
 * ─── QUYỀN ───
 *
 * Loại nào người xem không có đủ quyền màn hình chủ (và phạm vi dữ liệu với quảng cáo) thì nguồn của
 * nó KHÔNG được đọc — không phải đọc rồi giấu.
 */

/** Hạn cho một nguồn trên trang chủ — cùng mức hàng đợi `/work` (đo 50–260 ms với nguồn đọc bảng). */
export const OWNER_DECISION_TIMEOUT_MS = 2_500;
/** Hạn khi GHI (người đang chờ nút bấm của mình): rộng hơn, vì phải dựng lại đúng đề xuất để chụp. */
export const OWNER_DECISION_WRITE_TIMEOUT_MS = 20_000;

export type SourceResult = { items: OwnerDecisionItem[]; notes?: string[] };
export type SourceLoader = (ctx: { now: Date; viewer: SessionUser }) => Promise<SourceResult>;

// ═══════════════════════════ ĐỔI HÌNH DẠNG (thuần) ═══════════════════════════

const money = (v: number | null | undefined) => (v === null || v === undefined ? null : formatVND(v));
const count = (v: number | null | undefined) => (v === null || v === undefined ? null : formatNumber(v));

/** Yêu cầu duyệt ĐANG CHỜ. Yêu cầu do chính người xem xin bị loại: người xin không tự duyệt được. */
export function approvalsToItems(rows: readonly ApprovalRequestRow[], viewerId: string): OwnerDecisionItem[] {
  return rows
    .filter((r) => r.status === "PENDING" && r.requestedBy !== viewerId)
    .map((r) => {
      const nhom = APPROVAL_GROUP_LABEL[r.group as ApprovalGroup] ?? r.group;
      return {
        kind: "APPROVAL" as const,
        sourceKey: `approval:${r.id}`,
        what: `Duyệt · ${r.summary}`,
        why: `${nhom} — ${r.requestedByEmail || "không rõ người xin"} xin; việc này cần người thứ hai duyệt.`,
        data: [
          { label: "Nhóm", value: nhom },
          { label: "Số tiền", value: money(r.amount) },
          { label: "Xin lúc", value: formatDateTime(r.requestedAt) },
        ],
        impact: {
          amountVnd: r.amount ?? null,
          basis: "Số tiền trên yêu cầu — QUY MÔ việc xin duyệt, không phải tiền đang treo (cùng cách nguồn việc APPROVAL đọc).",
        },
        action: { label: "Mở để duyệt", href: "/alerts" },
        modelId: null,
      };
    });
}

export type SampleExtra = { modelId: string; costVnd: number | null; supplierName: string | null; imageCount: number };

/** Mẫu chờ duyệt — từ CHÍNH phép chiếu `adaptSampleReviews` của `/work`, thêm vài ô đọc thẳng của mẫu. */
export function samplesToItems(work: readonly WorkItem[], extra: ReadonlyMap<string, SampleExtra>): OwnerDecisionItem[] {
  return work.map((w) => {
    const x = extra.get(w.sourceKey) ?? null;
    return {
      kind: "SAMPLE_REVIEW" as const,
      sourceKey: `sample:${w.sourceKey}`,
      what: w.title,
      why: "Mẫu xưởng đã gửi duyệt — duyệt / yêu cầu sửa / loại. Duyệt sinh bản thiết kế bất biến mà lệnh sản xuất sẽ trỏ vào.",
      data: [
        { label: "Gửi duyệt", value: formatDate(w.createdAt) },
        { label: "Xưởng", value: x?.supplierName ?? null },
        { label: "Giá mẫu", value: money(x?.costVnd ?? null) },
        { label: "Ảnh", value: x ? formatNumber(x.imageCount) : null },
      ],
      impact: { amountVnd: null, basis: "Duyệt mẫu là cửa chất lượng trước khi bỏ vốn sản xuất — chưa có con số tiền đo được cho quyết định này." },
      action: { label: "Mở mẫu để duyệt", href: w.sourceUrl },
      modelId: x?.modelId ?? null,
    };
  });
}

export type TopicExtra = { targetPrice: number | null; expectedQty: number | null; deadline: string | null };

/** Chỉ hai trạng thái cần NGƯỜI chốt: đủ phương án · chờ quyết (cùng tập `canQuyet` của adapter). */
export const TOPIC_DECISION_STATUSES: readonly TopicStatus[] = ["OPTIONS_READY", "WAITING_DECISION"];

export function topicsToItems(work: readonly WorkItem[], extra: ReadonlyMap<string, TopicExtra>): OwnerDecisionItem[] {
  return work
    .filter((w) => TOPIC_DECISION_STATUSES.includes(w.kind as TopicStatus))
    .map((w) => {
      const status = w.kind as TopicStatus;
      const x = extra.get(w.sourceKey) ?? null;
      return {
        kind: "TOPIC_DECISION" as const,
        sourceKey: `topic:${w.sourceKey}:${status}`,
        what: w.title,
        why: `Topic sản xuất đang “${TOPIC_STATUS_LABEL[status]}” — cần người chọn phương án để đi tiếp sang giá thành và làm mẫu.`,
        data: [
          { label: "Trạng thái", value: TOPIC_STATUS_LABEL[status] },
          { label: "Giá mục tiêu", value: money(x?.targetPrice ?? null) },
          { label: "SL dự kiến", value: count(x?.expectedQty ?? null) },
          { label: "Hạn", value: x?.deadline ?? null },
        ],
        impact: {
          amountVnd: null,
          basis: "Giá mục tiêu × số lượng dự kiến là MONG MUỐN của người mở topic, không phải tiền đang rủi ro (cùng lý do nguồn việc PRODUCTION_TOPIC không khai tiền).",
        },
        action: { label: "Mở topic để chốt", href: w.sourceUrl },
        modelId: w.businessEntityId || null,
      };
    });
}

/**
 * Lệnh ĐÃ GỬI xưởng, quá ngày hẹn — `lateDays` của trang Mua hàng & xưởng (khác `null` ⇔ ngày hẹn đã
 * qua). Tiền đã cam kết = cột `committed` của cùng trang; lệnh chưa ghi đơn giá ra 0 ở đó, và 0 ở ô
 * này có nghĩa "chưa nhập giá" (chú thích `production_orders.unit_cost`) ⇒ in "—", không in 0 ₫.
 */
export function lateOrdersToItems(orders: readonly OpenProductionOrder[]): OwnerDecisionItem[] {
  return orders
    .filter((o) => o.lateDays !== null && o.dueDate !== null)
    .map((o) => ({
      kind: "PRODUCTION_LATE" as const,
      sourceKey: `po:${o.id}:due:${vnDateKey(o.dueDate as Date)}`,
      what: `${o.code} · ${o.productCode || o.productName} — xưởng trễ hẹn`,
      why: `Lệnh đã gửi ${o.supplier}, hẹn ${formatDate(o.dueDate)}, chưa đánh dấu nhận hàng. Hàng không về đúng hẹn thì đơn chờ hàng và kế hoạch bán lệch theo.`,
      data: [
        { label: "Trễ", value: `${formatNumber(o.lateDays)} ngày` },
        { label: "Hẹn", value: formatDate(o.dueDate) },
        { label: "Số lượng", value: formatNumber(o.totalQty) },
        { label: "Xưởng", value: o.supplier || null },
      ],
      impact: {
        amountVnd: o.committed > 0 ? o.committed : null,
        basis: "Tiền đã cam kết với xưởng cho lệnh này (số lượng × đơn giá trên lệnh — trang Mua hàng & xưởng). Lệnh chưa ghi đơn giá ⇒ chưa biết.",
      },
      action: { label: "Mở lệnh sản xuất", href: `/inventory/planning/orders/${o.id}` },
      modelId: null,
    }));
}

/**
 * Chiến dịch nên CẮT — tập việc và TIỀN lấy nguyên từ phép chiếu `adaptAdsDecisions` (đọc tiền theo đúng
 * căn cứ đã sinh khuyến nghị: số đo, hoặc tạm tính); chỉ dòng biết số chi (`money.atRisk !== null`).
 * Ô số liệu đọc từ dòng của CÙNG bảng quyết định (`getAdsDecision`, cùng kỳ, cùng đệm).
 */
export function adsCutToItems(work: readonly WorkItem[], rows: ReadonlyMap<string, AdsDecisionRow>): OwnerDecisionItem[] {
  return work
    .filter((w) => w.kind === "CUT" && w.money.atRisk !== null)
    .map((w) => {
      const key = w.businessEntityId;
      const r = rows.get(key) ?? null;
      const tamTinh = w.tags.includes("TAM_TINH");
      return {
        kind: "ADS_CUT" as const,
        sourceKey: `ads:CUT:campaign:${key}:${tamTinh ? "PROJECTED" : "ACTUAL"}`,
        what: w.title,
        why: w.summary,
        data: [
          { label: "Chi QC 30 ngày", value: r ? money(r.spend) : null },
          { label: "Đơn chốt", value: r ? formatNumber(r.bookedOrders) : null },
          { label: tamTinh ? "Lãi sau QC (tạm tính)" : "Lãi sau QC", value: r ? money(tamTinh ? r.projectedProfitAfterAds : r.profitAfterAds) : null },
          { label: "Chi / đơn", value: r ? money(r.costPerOrder) : null },
        ],
        impact: { amountVnd: w.money.atRisk, basis: w.money.basis },
        action: { label: "Mở quyết định quảng cáo", href: w.sourceUrl },
        modelId: null,
      };
    });
}

/**
 * ─── MẪU THẮNG CHƯA MỞ TOPIC SẢN XUẤT (Agent S thay nguồn của H) ───
 *
 * Nguồn là tín hiệu mẫu ĐẦY ĐỦ của A2 (`getModelSignalsBatch` — cùng `deriveModelSignal` với trang 360),
 * không còn là riêng lá phiếu quảng cáo. Ba cổng, đúng ba cổng mà đề xuất "mở trao đổi sản xuất" ở trang
 * 360 dùng (`deriveModelSuggestions`): tín hiệu THẮNG · trạng thái khai còn trước “Bàn sản xuất”
 * (`BEFORE_PRODUCTION_DISCUSSION`) · KHÔNG topic sản xuất đang mở. Số topic CHƯA BIẾT (`null`) không phải 0
 * — mẫu đó không vào (nguồn ném lỗi ở bộ đọc để khối nêu tên nguồn hỏng).
 */
export function modelWinnerCandidates(rows: readonly ModelSignalBatchRow[]): ModelSignalBatchRow[] {
  return rows.filter((r) => r.signal.signal === "WINNER" && r.openProductionTopics === 0 && BEFORE_PRODUCTION_DISCUSSION.includes(r.model.state));
}

/**
 * Băm 53 bit (cyrb53) — tất định, không phụ thuộc môi trường. Không dùng `node:crypto`: tệp này đọc sổ
 * phản ứng nên bài kiểm của H cấm mọi lời gọi cập nhật ở đây (sổ append-only), kể cả của bộ băm. Khoá
 * mang `modelId` rõ ràng, nên hai căn cứ của CÙNG một mẫu trùng băm (~2⁻⁵³) là rủi ro duy nhất.
 */
function basisHash(s: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** Nguồn BỎ PHIẾU của tín hiệu — tồn kho chỉ là bối cảnh nên không vào khoá (đổi mỗi ngày theo tốc độ bán). */
const SIGNAL_VOTING_SOURCES: readonly SignalSource[] = ["ADS", "PRODUCT", "CREATIVE", "DESIGN"];

/**
 * Khoá nguồn: tín hiệu + TẬP phán quyết của các nguồn bỏ phiếu (nguồn · lá phiếu · nhãn), băm ngắn —
 * KHÔNG mang ngày. "Bỏ qua" có hiệu lực tới khi CĂN CỨ đổi (vd quảng cáo từ Tăng sang Giữ, creative có
 * mẩu thắng), không tự hết sau một ngày. Câu chi tiết (số mẫu mã, số creative) không vào khoá — đổi số
 * đếm không phải một khuyến nghị khác.
 */
export function modelWinnerSourceKey(modelId: string, signal: Pick<ModelSignalReport, "signal" | "reasons">): string {
  const basis = SIGNAL_VOTING_SOURCES.map((src) => {
    const r = signal.reasons.find((x) => x.source === src);
    return `${src}=${r ? `${r.vote}:${r.verdict}` : "-"}`;
  });
  const hash = basisHash(JSON.stringify([signal.signal, ...basis]));
  return `model:${signal.signal}:${modelId}:${hash}`;
}

export function modelScaleToItems(cands: readonly ModelSignalBatchRow[]): OwnerDecisionItem[] {
  return cands.map(({ model, signal }) => ({
    kind: "MODEL_SCALE" as const,
    sourceKey: modelWinnerSourceKey(model.id, signal),
    what: `Mẫu ${model.code} · tín hiệu ${MODEL_SIGNAL_LABEL.WINNER.toUpperCase()} — chưa mở topic sản xuất`,
    why: [`${MODEL_SIGNAL_HINT.WINNER} (${signal.periodLabel.toLowerCase()})`, ...signal.conflicts.map((c) => `Lưu ý: ${c}`)].join(" "),
    // Chỉ NHÃN phán quyết của từng nguồn (cùng mức trang 360 cho hiện khi che câu chi tiết) — không số.
    data: signal.reasons.map((r) => ({ label: SIGNAL_SOURCE_LABEL[r.source], value: r.vote === "ABSENT" ? null : r.verdict })),
    impact: {
      amountVnd: null,
      basis: "Chưa có con số tiền đo được cho quyết định mở bàn sản xuất — xem khối Kinh tế (ước tính vs thực đạt) ở trang 360 của mẫu.",
    },
    action: { label: "Mở trang mẫu", href: `/models/${model.id}` },
    modelId: model.id,
  }));
}

const INVENTORY_KIND: Partial<Record<InventoryDecisionKind, OwnerDecisionKind>> = {
  STOCKOUT_RISK: "INVENTORY_STOCKOUT",
  REORDER: "INVENTORY_REORDER",
  CLEARANCE_CANDIDATE: "INVENTORY_CLEARANCE",
};

/** Ba kết luận của `decideInventory` (qua `getInventoryDecisionReport`). Mọi số là của trang Quyết định vốn tồn. */
export function inventoryToItems(rows: readonly InventoryDecisionRow[]): OwnerDecisionItem[] {
  const out: OwnerDecisionItem[] = [];
  for (const r of rows) {
    const kind = INVENTORY_KIND[r.decision];
    if (!kind) continue;
    const ten = [r.productCode || r.productName, [r.color, r.size].filter(Boolean).join("/")].filter(Boolean).join(" · ");
    const impact =
      r.decision === "STOCKOUT_RISK"
        ? { amountVnd: r.grossImpactEstimate, basis: "ƯỚC TÍNH lãi gộp mất nếu để hết hàng (decideInventory). Chưa biết giá ⇒ —." }
        : r.decision === "REORDER"
          ? { amountVnd: r.capitalRequired, basis: "Vốn cần bỏ ra cho số nên đặt (đã trừ hàng đặt xưởng chưa nhận). Chưa biết giá nhập ⇒ —." }
          : { amountVnd: r.capitalFreeable, basis: "Vốn theo giá nhập giải phóng được nếu xả phần vượt mức. Chưa biết giá nhập ⇒ —." };
    out.push({
      kind,
      sourceKey: `inventory:${r.decision}:${r.variantId}`,
      what: `${ten} · ${DECISION_LABEL[r.decision]}`,
      why: r.reason,
      data:
        r.decision === "CLEARANCE_CANDIDATE"
          ? [
              { label: "Tồn", value: formatNumber(r.stock) },
              { label: "Vượt mức", value: formatNumber(r.excessQty) },
              { label: "Bán 30 ngày", value: formatNumber(r.sold30) },
              { label: "Lần bán cuối", value: r.daysSinceLastSale === null ? null : `${formatNumber(r.daysSinceLastSale)} ngày trước` },
            ]
          : [
              { label: "Khả dụng", value: formatNumber(r.available) },
              { label: "Bán 30 ngày", value: formatNumber(r.sold30) },
              { label: "Nên đặt", value: count(r.suggestedQty) },
              { label: "Đã đặt xưởng", value: formatNumber(r.openPoQty) },
            ],
      impact,
      action: { label: "Mở quyết định vốn tồn", href: "/inventory/decisions" },
      modelId: null,
    });
  }
  return out;
}

// ═══════════════════════════ NGUỒN (đọc hàm có sẵn) ═══════════════════════════

const ADS_PERIOD = () => resolvePeriod({ period: "30d" }, "30d");

async function loadApprovals({ viewer }: { viewer: SessionUser }): Promise<SourceResult> {
  return { items: approvalsToItems(await listApprovalRequests(), viewer.id) };
}

async function loadSamples({ now }: { now: Date }): Promise<SourceResult> {
  const work = await adaptSampleReviews(now);
  const ids = work.map((w) => w.sourceKey);
  const extra = new Map<string, SampleExtra>();
  if (ids.length) {
    const db = await getDb();
    const s = schema.samples;
    const rows = await db
      .select({ id: s.id, modelId: s.modelId, costVnd: s.costVnd, images: s.images, supplierName: schema.suppliers.name })
      .from(s)
      .leftJoin(schema.suppliers, eq(schema.suppliers.id, s.supplierId))
      .where(inArray(s.id, ids));
    for (const r of rows) extra.set(r.id, { modelId: r.modelId, costVnd: r.costVnd, supplierName: r.supplierName ?? null, imageCount: Array.isArray(r.images) ? r.images.length : 0 });
  }
  return { items: samplesToItems(work, extra) };
}

async function loadTopics({ now }: { now: Date }): Promise<SourceResult> {
  const work = (await adaptProductionTopics(now)).filter((w) => TOPIC_DECISION_STATUSES.includes(w.kind as TopicStatus));
  const ids = work.map((w) => w.sourceKey);
  const extra = new Map<string, TopicExtra>();
  if (ids.length) {
    const db = await getDb();
    const t = schema.productionTopics;
    const rows = await db.select({ id: t.id, requirements: t.requirements }).from(t).where(inArray(t.id, ids));
    for (const r of rows) {
      const q = (r.requirements ?? {}) as { targetPrice?: number | null; expectedQty?: number | null; deadline?: string | null };
      extra.set(r.id, { targetPrice: q.targetPrice ?? null, expectedQty: q.expectedQty ?? null, deadline: q.deadline ?? null });
    }
  }
  return { items: topicsToItems(work, extra) };
}

async function loadProductionLate(): Promise<SourceResult> {
  const report = await getPurchasingReport();
  const items = lateOrdersToItems(report.openOrders);
  const notes: string[] = [];
  // Trang Mua hàng liệt kê tối đa 50 lệnh mở (quá hẹn đứng trước). Có nhiều lệnh quá hẹn hơn số đọc
  // được thì NÓI RA — không để khối trông như đã đủ.
  if (report.open.overdueCount > items.length) notes.push(`Lệnh sản xuất: ${formatNumber(report.open.overdueCount)} lệnh quá hẹn, khối này chỉ đọc được ${formatNumber(items.length)} — mở trang Mua hàng & xưởng để xem đủ.`);
  return { items, notes };
}

async function loadAdsCut({ now }: { now: Date }): Promise<SourceResult> {
  const [work, decision] = await Promise.all([adaptAdsDecisions(now), getAdsDecision(ADS_PERIOD(), "campaign")]);
  return { items: adsCutToItems(work, new Map(decision.rows.map((r) => [r.key, r]))) };
}

/**
 * Mẫu THẮNG chưa mở topic sản xuất — tín hiệu mẫu đầy đủ đọc theo LÔ (`getModelSignalsBatch`, một lượt
 * mỗi nguồn cho cả shop, đệm theo kỳ). Nguồn sản xuất không đọc được ⇒ NÉM: khối nêu tên nguồn hỏng thay
 * vì đề xuất mở bàn sản xuất cho một mẫu có thể đã có topic.
 */
async function loadModelScale(): Promise<SourceResult> {
  const batch = await getModelSignalsBatch(ADS_PERIOD());
  if (batch.topicsError) throw new Error(batch.topicsError);
  return { items: modelScaleToItems(modelWinnerCandidates(batch.rows)) };
}

async function loadInventory(): Promise<SourceResult> {
  const report = await getInventoryDecisionReport();
  const notes = report.dataGate.state === "DATA_INSUFFICIENT" ? [`Quyết định vốn tồn đang tự xưng DỮ LIỆU CHƯA ĐỦ: ${report.dataGate.reasons.join(" ")}`] : [];
  return { items: inventoryToItems(report.rows), notes };
}

export const OWNER_DECISION_LOADERS: Record<OwnerDecisionSource, SourceLoader> = {
  APPROVALS: loadApprovals,
  SAMPLES: loadSamples,
  TOPICS: loadTopics,
  ADS_CUT: loadAdsCut,
  MODEL_SCALE: loadModelScale,
  PRODUCTION_LATE: loadProductionLate,
  INVENTORY: loadInventory,
};

// ═══════════════════════════ GOM ═══════════════════════════

export type FailedSource = { source: OwnerDecisionSource; label: string; error: string };

export type OwnerDecisionQueue = {
  groups: KindGroup[];
  total: number;
  /** Đề xuất đang ẩn vì BỎ QUA / NHẮC LẠI SAU — vẫn có ở nguồn, không mất. */
  hidden: DecoratedItem[];
  failed: FailedSource[];
  notes: string[];
  /** Loại người xem được thấy (đã áp quyền + phạm vi). */
  kinds: OwnerDecisionKind[];
};

export type QueueOptions = {
  viewer: SessionUser;
  now?: Date;
  timeoutMs?: number;
  /** Thay nguồn (kiểm thử). */
  loaders?: Partial<Record<OwnerDecisionSource, SourceLoader>>;
  /** Phạm vi dữ liệu của loại có phạm vi. Mặc định: `decideScope` (luật 30). */
  scopeOk?: (resource: "ADS") => Promise<boolean>;
  /** Chỉ đọc một số loại (lượt ghi dựng lại đúng một loại). */
  onlyKinds?: readonly OwnerDecisionKind[];
};

async function guarded(label: string, run: () => Promise<SourceResult>, timeoutMs: number): Promise<{ ok: true; value: SourceResult } | { ok: false; error: string }> {
  let hetGio: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race([
      run(),
      new Promise<SourceResult>((_, reject) => {
        hetGio = setTimeout(() => reject(new Error(`quá ${Math.round(timeoutMs / 1000)}s — đang tính lại, mở lại sau ít giây là có`)), timeoutMs);
      }),
    ]);
    return { ok: true, value };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : `${label}: ${String(e)}` };
  } finally {
    if (hetGio) clearTimeout(hetGio);
  }
}

/** Loại người xem được thấy. Phạm vi chỉ hỏi khi quyền đã đủ (luật 28: quyền trước, phạm vi sau). */
export async function viewerKinds(viewer: SessionUser, scopeOk?: (resource: "ADS") => Promise<boolean>): Promise<OwnerDecisionKind[]> {
  const hasPerm = (p: Parameters<typeof can>[1]) => can(viewer, p);
  const needScope = allowedKinds(hasPerm, () => true).some((k) => OWNER_DECISION_KIND_SPEC[k].scopeResource === "ADS");
  const adsOk = needScope ? await (scopeOk ?? (async (r: "ADS") => (await decideScope(r, viewer, "expenses:view")).allow !== "NONE"))("ADS") : false;
  return allowedKinds(hasPerm, () => adsOk);
}

export async function getOwnerDecisionQueue(opts: QueueOptions): Promise<OwnerDecisionQueue> {
  const now = opts.now ?? new Date();
  const timeoutMs = opts.timeoutMs ?? OWNER_DECISION_TIMEOUT_MS;
  let kinds = await viewerKinds(opts.viewer, opts.scopeOk);
  if (opts.onlyKinds) kinds = kinds.filter((k) => opts.onlyKinds!.includes(k));
  const failed: FailedSource[] = [];
  const notes: string[] = [];

  const results = await Promise.all(
    sourcesFor(kinds).map(async (source) => {
      const loader = opts.loaders?.[source] ?? OWNER_DECISION_LOADERS[source];
      const r = await guarded(OWNER_DECISION_SOURCE_LABEL[source], () => loader({ now, viewer: opts.viewer }), timeoutMs);
      if (!r.ok) {
        failed.push({ source, label: OWNER_DECISION_SOURCE_LABEL[source], error: r.error });
        return [];
      }
      notes.push(...(r.value.notes ?? []));
      return r.value.items;
    }),
  );
  // Một nguồn có thể sinh loại người xem KHÔNG được thấy (vd sau này tách quyền) — lọc lại theo loại.
  const seen = new Set<string>();
  const items = results.flat().filter((it) => kinds.includes(it.kind) && (seen.has(it.sourceKey) ? false : (seen.add(it.sourceKey), true)));

  let latest = new Map<string, RecommendationDecisionRow>();
  try {
    latest = foldLatestDecisions(await readDecisionRows(await getDb(), items.map((i) => i.sourceKey)));
  } catch (e) {
    // Sổ phản ứng hỏng ⇒ mọi đề xuất hiện lại (kể cả dòng đã bỏ qua) — và NÓI RA, không im lặng.
    notes.push(`Không đọc được sổ phản ứng (${e instanceof Error ? e.message : String(e)}) — đề xuất đã bỏ qua / hẹn nhắc có thể hiện lại.`);
  }
  const { visible, hidden } = applyDecisions(items, latest, now);
  failed.sort((a, b) => a.label.localeCompare(b.label, "vi"));
  return { groups: groupByKind(visible), total: visible.length, hidden, failed, notes, kinds };
}

/**
 * Dựng lại ĐÚNG một đề xuất cho lượt ghi — máy chủ chụp thứ nó thật sự đề xuất, không nhận ảnh chụp từ
 * trình duyệt. Người xem không có quyền loại đó ⇒ `FORBIDDEN`; nguồn không còn đề xuất ấy ⇒ `GONE`.
 */
export async function findOwnerDecisionItem(
  kind: OwnerDecisionKind,
  sourceKey: string,
  viewer: SessionUser,
  opts: { now?: Date; loaders?: QueueOptions["loaders"]; scopeOk?: QueueOptions["scopeOk"] } = {},
): Promise<{ item: OwnerDecisionItem } | { error: "FORBIDDEN" | "GONE" | "SOURCE_FAILED"; detail?: string }> {
  const kinds = await viewerKinds(viewer, opts.scopeOk);
  if (!kinds.includes(kind)) return { error: "FORBIDDEN" };
  const source = OWNER_DECISION_KIND_SPEC[kind].source;
  const loader = opts.loaders?.[source] ?? OWNER_DECISION_LOADERS[source];
  const r = await guarded(OWNER_DECISION_SOURCE_LABEL[source], () => loader({ now: opts.now ?? new Date(), viewer }), OWNER_DECISION_WRITE_TIMEOUT_MS);
  if (!r.ok) return { error: "SOURCE_FAILED", detail: r.error };
  const item = r.value.items.find((i) => i.kind === kind && i.sourceKey === sourceKey);
  return item ? { item } : { error: "GONE" };
}

export type RecentDecision = RecommendationDecisionRow & { what: string };

/** Phản ứng gần đây — chỉ của loại người xem được thấy (ảnh chụp mang số của màn hình chủ). */
export async function listRecentDecisions(viewer: SessionUser, limit = 20): Promise<RecentDecision[]> {
  const kinds = await viewerKinds(viewer);
  if (!kinds.length) return [];
  const db = await getDb();
  const r = schema.recommendationDecisions;
  const rows = await db.select().from(r).where(inArray(r.kind, kinds)).orderBy(desc(r.decidedAt)).limit(limit);
  return rows.map((x) => ({ ...toRow(x), what: typeof x.snapshot?.what === "string" ? x.snapshot.what : x.sourceKey }));
}
