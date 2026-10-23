/**
 * ═══════════ «TÍNH LÚC · NGUỒN · TRỄ ĐỐI TÁC» CHO MÀN HÌNH SỐ LIỆU (OD-UX-03, 23/10/2026) ═══════════
 *
 * Một hàm THUẦN dựng chữ cho mọi trang dùng chỉ báo này (/shipments, /reports/returns — GTC và lương vòng sau), để không
 * trang nào tự viết lại luật in (§8.12). Ba câu, mỗi câu sửa ở một chỗ khác nhau:
 *  · TÍNH LÚC — mốc dữ liệu cũ nhất đứng sau con số (`collectAsOf` trong lib/cache.ts). KHÔNG in «bây giờ»: đệm trả số cũ
 *    tới 15 phút rồi mới làm mới phía sau.
 *  · NGUỒN — lần cuối mỗi nguồn kết luận của trang thật sự vào được ERP. Chưa từng có ⇒ «—» (AGENTS 42), không phải 0.
 *  · TRỄ ĐVVC — đọc lại `vtpWebhookHealth()` (đã đo, không đo mới). Mẫu thiếu / chưa có nền ⇒ nói CHƯA BIẾT, không bao giờ
 *    tô xanh (AGENTS 52); chỉ LAGGING / STALLED mới đổi màu, kèm câu giải thích của chính phép đo.
 *  · CHỖ HỤT WEBHOOK (OD-UX-03b) — ERP không tự thấy gói tin chưa từng tới; chỉ tệp «Danh sách vận đơn» đo được (AGENTS 51).
 *    Lâu không nhập tệp = lâu không có phép đo nào, nên thẻ nói ra «chưa đo từ <mốc> (N ngày)» kèm lối bấm. Hổ phách theo
 *    ĐÚNG nhịp đã khai `VTP_ORDER_LIST_MAX_AGE_HOURS` (lib/constants/feed-freshness.ts) — không gõ ngưỡng mới. Tỷ lệ khớp đọc
 *    lại `vtpWebhookHealth()` (30 ngày), dưới `WEBHOOK_MATCH_MIN_SAMPLE` thì «chưa đủ mẫu», và KHÔNG tô màu: chưa ai khai đích
 *    cho tỷ lệ này (AGENTS 38).
 * Chuyện của DỮ LIỆU, không kết luận gì về đơn hàng.
 */
import { formatDateTime } from "@/lib/format";
import { VTP_ORDER_LIST_MAX_AGE_HOURS } from "@/lib/constants/feed-freshness";
import { WEBHOOK_MATCH_MIN_SAMPLE } from "@/lib/constants/webhook-gap";
import { WEBHOOK_LATENCY_MIN_SAMPLE, type WebhookLatencyVerdict } from "@/lib/constants/webhook-latency";
import type { WebhookHealth } from "@/lib/queries/vtp-webhook-health";

/** Job đồng bộ ĐƠN Pancake (`runSyncJob` trong lib/integrations/pancake/sync.ts). Mốc nguồn = lượt SUCCESS cuối của một trong số này. */
export const PANCAKE_ORDER_SYNC_JOBS = ["orders_incremental", "orders_reconcile", "orders_backfill"] as const;

export type AsOfTone = "muted" | "warn";
export type AsOfCell = { key: "asOf" | "codStatement" | "pancake" | "webhookGap" | "webhookMatch" | "latency"; text: string; tone: AsOfTone; title?: string; href?: string };

/** Trang nhập tệp «Danh sách vận đơn» — lối bấm của ô «chỗ hụt webhook». */
export const VTP_ORDER_LIST_IMPORT_HREF = "/import-vtp";

export type AsOfLatency = { medianSeconds: number | null; baselineSeconds: number | null; sample: number; verdict: WebhookLatencyVerdict; note: string };

/** Đúng năm trường độ trễ của `vtpWebhookHealth()` — đọc lại phép đo đã có, không đo mới. */
export function latencyFromHealth(h: Pick<WebhookHealth, "latencyMedianSeconds" | "latencyBaselineSeconds" | "latencySample" | "latency" | "latencyNote">): AsOfLatency {
  return { medianSeconds: h.latencyMedianSeconds, baselineSeconds: h.latencyBaselineSeconds, sample: h.latencySample, verdict: h.latency, note: h.latencyNote };
}

export type AsOfWebhookMatch = { rate: number | null; sample: number };

/** Tỷ lệ khớp 30 ngày của `vtpWebhookHealth()` — đọc lại phép đo đã có. */
export function webhookMatchFromHealth(h: Pick<WebhookHealth, "matchRate" | "matchSample">): AsOfWebhookMatch {
  return { rate: h.matchRate, sample: h.matchSample };
}

export type AsOfInput = {
  /**
   * Kết quả của `collectAsOf`. `null` = trang không đo được mốc ⇒ «—». `undefined` = chỗ đặt hàng này đứng TRÊN các khối tự tải
   * số riêng (đầu trang /shipments) ⇒ không in ô «tính lúc», vì không một mốc nào đúng cho mọi khối bên dưới.
   */
  asOf?: { asOf: Date; cached: boolean } | null;
  now: Date;
  /** `undefined` = trang không dựa vào nguồn này ⇒ không in ô; `null` = chưa từng có ⇒ «—». */
  lastCodStatementAt?: Date | null;
  lastPancakeSyncAt?: Date | null;
  latency?: AsOfLatency | null;
  /** Lần NHẬP THẬT cuối của tệp «Danh sách vận đơn» (mốc phép đo chỗ hụt webhook gần nhất). `undefined` = không in ô. */
  orderListImportAt?: Date | null;
  webhookMatch?: AsOfWebhookMatch | null;
};

const LUAT_51 =
  "ERP không tự thấy một gói tin webhook chưa từng tới — chỉ tệp «Danh sách vận đơn» tải từ viettelpost.vn, nhập vào ERP, mới đo được chỗ hụt (AGENTS 51). Không nhập tệp = không có phép đo.";

/** Ô «chỗ hụt webhook»: chưa từng đo · đo đã cũ (≥ nhịp nhập đã khai) · đo còn mới. HÀM THUẦN. */
export function webhookGapCell(orderListImportAt: Date | null, now: Date): AsOfCell {
  if (!orderListImportAt) {
    return { key: "webhookGap", tone: "warn", href: VTP_ORDER_LIST_IMPORT_HREF, title: LUAT_51, text: "Chỗ hụt webhook: CHƯA TỪNG đo — nhập tệp Danh sách vận đơn để đo" };
  }
  const gio = (now.getTime() - orderListImportAt.getTime()) / 3_600_000;
  if (gio >= VTP_ORDER_LIST_MAX_AGE_HOURS) {
    const ngay = Math.floor(gio / 24);
    return {
      key: "webhookGap",
      tone: "warn",
      href: VTP_ORDER_LIST_IMPORT_HREF,
      title: LUAT_51,
      text: `Chỗ hụt webhook: chưa đo từ ${formatDateTime(orderListImportAt)} (${ngay >= 1 ? `${ngay} ngày` : `${Math.floor(gio)} giờ`}) — nhập tệp Danh sách vận đơn để đo`,
    };
  }
  return { key: "webhookGap", tone: "muted", title: LUAT_51, text: `Chỗ hụt webhook: đo lần cuối ${formatDateTime(orderListImportAt)}` };
}

/** Ô «webhook khớp tệp (30 ngày)». Không tô màu — chưa có đích khai cho tỷ lệ này (AGENTS 38). HÀM THUẦN. */
export function webhookMatchCell(m: AsOfWebhookMatch | null): AsOfCell {
  const nhan = "Webhook khớp tệp (30 ngày)";
  if (!m || m.sample === 0) return { key: "webhookMatch", tone: "muted", text: `${nhan}: chưa đo — không lần nhập tệp nào trong 30 ngày` };
  if (m.rate === null) return { key: "webhookMatch", tone: "muted", text: `${nhan}: chưa đủ mẫu (${m.sample} dòng, cần ${WEBHOOK_MATCH_MIN_SAMPLE})` };
  return { key: "webhookMatch", tone: "muted", text: `${nhan}: ${(Math.round(m.rate * 1000) / 10).toFixed(1)}% · ${m.sample} dòng` };
}

const giay = (s: number) => (s < 120 ? `${Math.round(s)} giây` : `${Math.round(s / 60)} phút`);

function cachLuc(at: Date, now: Date): string {
  const phut = Math.floor((now.getTime() - at.getTime()) / 60_000);
  return phut < 1 ? "dưới 1 phút trước" : `${phut} phút trước`;
}

/** Các ô chỉ báo, theo thứ tự in. HÀM THUẦN. */
export function asOfCells(input: AsOfInput): AsOfCell[] {
  const cells: AsOfCell[] = [];
  const a = input.asOf;
  if (a !== undefined) cells.push({
    key: "asOf",
    tone: "muted",
    text: !a
      ? "Số liệu tính lúc: —"
      : a.cached
        ? `Số liệu tính lúc ${formatDateTime(a.asOf)} (đệm, ${cachLuc(a.asOf, input.now)})`
        : `Số liệu truy vấn trực tiếp lúc ${formatDateTime(a.asOf)}`,
    title: "Mốc dữ liệu CŨ NHẤT đứng sau các con số trên trang. Đệm báo cáo có thể trả số cũ tới 15 phút rồi mới làm mới phía sau.",
  });
  if (input.lastCodStatementAt !== undefined) {
    cells.push({ key: "codStatement", tone: "muted", text: `Bảng kê COD cuối: ${input.lastCodStatementAt ? formatDateTime(input.lastCodStatementAt) : "—"}` });
  }
  if (input.lastPancakeSyncAt !== undefined) {
    cells.push({
      key: "pancake",
      tone: "muted",
      text: `Đồng bộ đơn Pancake thành công cuối: ${input.lastPancakeSyncAt ? `${formatDateTime(input.lastPancakeSyncAt)} (${cachLuc(input.lastPancakeSyncAt, input.now)})` : "—"}`,
    });
  }
  if (input.orderListImportAt !== undefined) cells.push(webhookGapCell(input.orderListImportAt, input.now));
  if (input.webhookMatch !== undefined) cells.push(webhookMatchCell(input.webhookMatch));
  const l = input.latency;
  if (l !== undefined) {
    if (!l || l.medianSeconds === null || l.sample < WEBHOOK_LATENCY_MIN_SAMPLE) {
      cells.push({ key: "latency", tone: "muted", text: `Trễ ĐVVC: chưa đủ mẫu (${l?.sample ?? 0} gói giờ qua) — CHƯA BIẾT`, title: l?.note });
    } else {
      const nen = l.baselineSeconds === null ? "nền —" : `nền ${giay(l.baselineSeconds)}`;
      const dang = l.verdict === "STALLED" ? " — ĐANG DỒN" : l.verdict === "LAGGING" ? " — chậm hơn nền" : l.verdict === "UNKNOWN" ? " — chưa đủ nền để nói nhanh hay chậm" : "";
      cells.push({
        key: "latency",
        tone: l.verdict === "LAGGING" || l.verdict === "STALLED" ? "warn" : "muted",
        text: `Trễ ĐVVC: trung vị ${giay(l.medianSeconds)} · giờ qua · ${l.sample} gói (${nen})${dang}`,
        title: l.note,
      });
    }
  }
  return cells;
}
