import Link from "next/link";
import { formatDateTime, formatNumber } from "@/lib/format";
import { DataAsOfLine } from "@/components/data-as-of-line";
import type { AsOfInput } from "@/lib/constants/data-as-of";
import type { VtpSyncCoverage } from "@/lib/queries/vtp-sync-coverage";

/**
 * ĐỘ PHỦ ĐỒNG BỘ VIETTEL POST (P0 22/10/2026) — đặt cạnh GTC và trên /shipments để người đọc biết con số đứng trên tập
 * vận đơn nào. Chỉ số đếm của chính ERP; «tổng trên Viettel Post» KHÔNG có (không API) nên in câu «chưa đo được».
 * `formula` (tuỳ chọn) = câu công thức + mẫu số + kỳ của chỉ số đang hiện bên cạnh.
 * `asOf` / `latency` (OD-UX-03, tuỳ chọn) = hàng «số liệu tính lúc · bảng kê COD · Pancake · trễ ĐVVC» — truyền thì in, cùng
 * hai mốc nguồn đọc trong CHÍNH câu SQL của thẻ này.
 */
export function VtpSyncCoverageCard({
  c,
  periodLabel,
  formula,
  asOf,
  latency,
  webhookMatch,
}: {
  c: VtpSyncCoverage;
  periodLabel: string;
  formula?: string;
  asOf?: AsOfInput["asOf"];
  latency?: AsOfInput["latency"];
  /** OD-UX-03b: tỷ lệ khớp webhook ↔ tệp 30 ngày (`webhookMatchFromHealth`). Ô «chỗ hụt webhook» luôn in, từ mốc tệp của thẻ. */
  webhookMatch?: AsOfInput["webhookMatch"];
}) {
  const orphans = c.orphanCancelledBatch + c.orphanUnmatched;
  return (
    <div className="rounded-xl border border-hairline bg-card px-4 py-3 text-[12.5px] leading-relaxed text-muted-foreground">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <span className="font-medium text-foreground">Đồng bộ Viettel Post</span>
        <span>Webhook cuối: {c.lastWebhookAt ? formatDateTime(c.lastWebhookAt) : "—"}</span>
        <span>
          Nhập tệp «Danh sách vận đơn» cuối: {c.lastFileImportAt ? formatDateTime(c.lastFileImportAt) : "—"} ·{" "}
          <Link href="/import-vtp" className="underline-offset-2 hover:underline">
            nhập tệp
          </Link>
        </span>
        <span className={c.syncErrors ? "text-rose-700 dark:text-rose-300" : undefined}>Lỗi đồng bộ trong kỳ: {formatNumber(c.syncErrors)}</span>
      </div>
      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
        <span>
          {periodLabel}: ERP ghi nhận <b className="numeric text-foreground">{formatNumber(c.known)}</b> vận đơn · đã gắn đơn <b className="numeric text-foreground">{formatNumber(c.linked)}</b> · chiều hoàn{" "}
          {formatNumber(c.returnLegs)}
        </span>
        <span>
          Chưa có đơn {formatNumber(orphans)} (lô huỷ {formatNumber(c.orphanCancelledBatch)} ·{" "}
          <Link href="/shipments?view=all&linked=external" className="underline-offset-2 hover:underline">
            chưa ghép được {formatNumber(c.orphanUnmatched)}
          </Link>
          )
        </span>
        <span>Tổng vận đơn trên Viettel Post: {c.carrierTotalNote}</span>
      </div>
      <DataAsOfLine
        className="mt-1 text-[12.5px]"
        input={{ asOf, now: new Date(), lastCodStatementAt: c.lastCodStatementAt, lastPancakeSyncAt: c.lastPancakeSyncAt, orderListImportAt: c.lastFileImportAt, webhookMatch, latency }}
      />
      {formula ? <div className="mt-1">{formula}</div> : null}
    </div>
  );
}
