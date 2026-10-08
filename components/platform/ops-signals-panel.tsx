import { SectionCard } from "@/components/ui-bits";
import { OPS_LEVEL_LABEL, OPS_SIGNAL_SOURCE, type OpsLevel } from "@/lib/constants/ops-signals";
import { formatDateTime, formatNumber } from "@/lib/format";
import type { OrgOpsSignals } from "@/lib/platform/ops-signals";
import { cn } from "@/lib/utils";

/**
 * Khung «Sự cố 24 giờ / 7 ngày» của `/platform/org/<mã>` (sứ mệnh saas-ops-signals · LAUNCH SPRINT §11). Server component — chỉ in
 * tám dòng `loadOrgOpsSignals` đã dựng (cổng người vận hành nằm ở hàm đọc + trang). Không nút ghi nào.
 *
 * «—» = CHƯA BIẾT (nguồn chưa từng ghi / chưa đo), N/A = không áp dụng — không bao giờ in «0» thay cho chúng (luật 42). Số 7 ngày
 * mang dấu * khi sổ mới bắt đầu đo trong cửa sổ đó.
 */

const LEVEL_STYLE: Record<OpsLevel, string> = {
  CRITICAL: "bg-destructive/10 text-destructive font-semibold",
  WARNING: "bg-amber-500/10 text-amber-700 dark:text-amber-300 font-semibold",
  OK: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  UNKNOWN: "bg-muted text-muted-foreground",
  NA: "bg-muted text-muted-foreground",
};

const th = "px-3 py-2";
const thead = "bg-muted/40 text-left text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground";

function count(v: number | null, level: OpsLevel): string {
  if (level === "NA") return "N/A";
  return v === null ? "—" : formatNumber(v);
}

export function OpsSignalsPanel({ data }: { data: OrgOpsSignals }) {
  const bad = data.lines.filter((l) => l.level === "CRITICAL" || l.level === "WARNING").length;
  return (
    <SectionCard
      id="ops-signals"
      title="Sự cố 24 giờ / 7 ngày"
      description={`${bad ? `${bad}/${data.lines.length} loại đang có sự cố` : "Không loại nào đang cảnh báo"} · đọc lúc ${formatDateTime(data.checkedAt)} · “—” = chưa biết, không phải 0`}
      hint={
        <div className="space-y-1.5 text-xs leading-5">
          <p>Tám loại sự cố của RIÊNG tổ chức này, đọc MỘT câu ở CSDL nhà (gương job sales-health · sổ lỗi đăng nhập · sổ AI) — không mở CSDL của khách.</p>
          <p>«Tương quan» = id hội thoại / mã đơn / page của lần cuối: dùng để tra nhật ký của tổ chức. Định danh đăng nhập đã che, không có mật khẩu hay email thô.</p>
        </div>
      }
      padded={false}
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-sm" data-ops-signals={data.orgCode}>
          <thead className={thead}>
            <tr>
              <th className={th}>Loại</th>
              <th className={th}>Mức</th>
              <th className={cn(th, "text-right")}>24 giờ</th>
              <th className={cn(th, "text-right")}>7 ngày</th>
              <th className={th}>Lần cuối</th>
              <th className={th}>Lý do cuối · tương quan</th>
            </tr>
          </thead>
          <tbody>
            {data.lines.map((l) => (
              <tr key={l.key} className="border-t border-hairline align-top" data-ops-signal={l.key} data-ops-level={l.level}>
                <td className="px-3 py-1.5" title={OPS_SIGNAL_SOURCE[l.key]}>
                  <span className="font-medium">{l.label}</span>
                  {l.detail ? <div className="text-[11px] text-muted-foreground">{l.detail}</div> : null}
                  {l.note ? <div className="text-[11px] text-amber-700 dark:text-amber-300">{l.note}</div> : null}
                </td>
                <td className="px-3 py-1.5">
                  <span className={cn("rounded-full px-2 py-0.5 text-[11px]", LEVEL_STYLE[l.level])}>{OPS_LEVEL_LABEL[l.level]}</span>
                </td>
                <td className="numeric px-3 py-1.5 text-right">{count(l.count24h, l.level)}</td>
                <td className="numeric px-3 py-1.5 text-right" title={l.measuredFrom ? `Sổ bắt đầu đo từ ${formatDateTime(l.measuredFrom)} — số 7 ngày là một phần` : undefined}>
                  {count(l.count7d, l.level)}
                  {l.measuredFrom && l.count7d !== null ? "*" : ""}
                </td>
                <td className="px-3 py-1.5 text-xs">
                  {l.lastAt ? formatDateTime(l.lastAt) : "—"}
                  {l.measuredAt ? <div className={cn("text-[11px]", l.stale ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground")}>đo lúc {formatDateTime(l.measuredAt)}{l.stale ? " (cũ)" : ""}</div> : null}
                </td>
                <td className="px-3 py-1.5 text-xs">
                  {l.lastReasonLabel ?? "—"}
                  {l.lastReason ? <span className="ml-1 font-mono text-[10.5px] text-muted-foreground">{l.lastReason}</span> : null}
                  {l.correlationId ? <div className="font-mono text-[10.5px] text-muted-foreground break-all">{l.correlationId}</div> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data.lines.some((l) => l.measuredFrom) ? <p className="px-5 py-2 text-[11px] text-muted-foreground">* Sổ bắt đầu đo trong 7 ngày qua — số 7 ngày là phần đã ghi được, không phải cả cửa sổ.</p> : null}
    </SectionCard>
  );
}
