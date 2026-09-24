import { Activity } from "lucide-react";
import { ExtendButton, PauseNowButton } from "@/app/(dashboard)/marketing/creatives/live-actions";
import { MODE_LABEL, VariantImage } from "@/app/(dashboard)/marketing/creatives/variant-bits";
import { StatStrip } from "@/components/stat-tile";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { getDb } from "@/db";
import { CREATIVE_VERDICT_LABEL, VARIANT_STATUS_LABEL, type CreativeVerdict } from "@/lib/constants/creative-loop";
import { describeRule, metricValue } from "@/lib/creative/judge";
import { formatDate, formatNumber, formatPercent, formatVND, vnShortStamp } from "@/lib/format";
import { LIVE_WINDOW_DAYS, listLiveVariants, type JudgedVariant } from "@/lib/queries/creative-loop";
import { cn } from "@/lib/utils";

/**
 * ═══════════ TAB ĐANG CHẠY ═══════════
 *
 * Mỗi mẫu đã đăng một dòng: số đo (CHƯA BIẾT in `—`, không in 0), phán quyết SỐNG kèm lý do, và luật
 * giữ nào đạt / hụt. Chỉ phán quyết ĐÃ KẾT LUẬN mới mang màu (AGENTS.md mục 44): `RUNNING` ·
 * `AWAITING_ORDERS` · `UNJUDGED` · `PENDING` là "chưa kết luận" — tô chúng xanh hay đỏ là nói trước
 * một điều máy chưa biết.
 */

const VERDICT_TONE: Partial<Record<CreativeVerdict, string>> = {
  WIN: "bg-success/15 text-success",
  PROMISING: "bg-success/10 text-success",
  KILL: "bg-destructive/10 text-destructive",
  LOSE: "bg-destructive/10 text-destructive",
};

function Hai({ top, bottom, title }: { top: React.ReactNode; bottom: React.ReactNode; title?: string }) {
  return (
    <div className="numeric whitespace-nowrap text-right leading-tight" title={title}>
      <div className="font-medium">{top}</div>
      <div className="text-[11px] text-muted-foreground">{bottom}</div>
    </div>
  );
}

function KeepChecks({ v }: { v: JudgedVariant }) {
  if (!v.keepChecks.length) return <p className="text-[11px] text-muted-foreground">Chưa khai luật giữ</p>;
  return (
    <ul className="space-y-0.5 text-[11px]">
      {v.keepChecks.map((c, i) => (
        <li key={i} className="flex gap-1" title={`Giá trị hiện tại: ${c.value === null ? "chưa biết" : c.value.toLocaleString("vi-VN", { maximumFractionDigits: 2 })}`}>
          <span className="w-9 shrink-0 font-semibold">{c.pass === true ? "✓ đạt" : c.pass === false ? "✗ hụt" : "? chưa"}</span>
          <span className="line-clamp-1 text-muted-foreground">{describeRule(c.rule)}</span>
        </li>
      ))}
    </ul>
  );
}

export async function LiveTab({ canWrite }: { canWrite: boolean }) {
  const db = await getDb();
  const now = new Date();
  const rows = await listLiveVariants(db, now);

  const chay = rows.filter((r) => r.status === "LIVE");
  const chi = rows.reduce<number | null>((s, r) => (r.metrics.spendVnd === null ? s : (s ?? 0) + r.metrics.spendVnd), null);
  const hua = rows.filter((r) => r.verdict === "PROMISING").length;
  const tat = rows.filter((r) => r.verdict === "KILL").length;
  const chuaKetLuan = rows.filter((r) => ["RUNNING", "AWAITING_ORDERS", "UNJUDGED", "PENDING"].includes(r.verdict)).length;

  return (
    <div className="space-y-4">
      <StatStrip
        columns={5}
        items={[
          { label: "Đang chạy", value: formatNumber(chay.length), note: `trên ${formatNumber(rows.length)} mẫu đã đăng · ${LIVE_WINDOW_DAYS} ngày` },
          { label: "Đã chi", value: formatVND(chi), note: "chi cấp mẩu QC", hint: "Cộng dòng chi hạt AD của các mẫu trong bảng. Mẫu chưa có dòng chi nào không được cộng như 0 — nếu không mẫu nào có số chi thì in “—”." },
          { label: "Hứa hẹn", value: formatNumber(hua), note: "qua mọi luật giữ — có thể cho tiêu thêm" },
          { label: "Tắt sớm theo luật", value: formatNumber(tat) },
          { label: "Chưa kết luận", value: formatNumber(chuaKetLuan), note: "đang test · chờ đơn · thiếu căn cứ", tone: "muted" },
        ]}
      />

      <SectionCard
        title="Mẫu đã đăng"
        description="Phán quyết tính lại lúc mở trang: luật tắt của lô đã duyệt + luật giữ hiện tại."
        hint={
          <>
            Chi · hiển thị · nhấp · tin nhắn đọc từ dòng chi hạt AD của mẩu QC; đơn đi bằng <code>ad_id</code> Pancake gửi, nên có thể đếm THIẾU (~1/4 đơn thật không
            mang ad_id). Đơn giao / hoàn theo ORDER_OUTCOME. Tỷ số có mẫu số 0 in “—” và không làm luật nào kích hoạt. Chỉ phán quyết đã kết luận (Thắng · Hứa hẹn ·
            Tắt sớm · Loại) mang màu.
          </>
        }
        padded={false}
      >
        {rows.length === 0 ? (
          <div className="p-5">
            <EmptyState icon={Activity} title="Chưa có mẫu nào đã đăng" description={`Không có mẫu nào đăng trong ${LIVE_WINDOW_DAYS} ngày gần nhất. Mẫu xuất hiện ở đây sau khi lô được duyệt và máy đăng lên Facebook.`} />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1040px] text-[12.5px]">
              <thead className="border-b bg-muted/40 text-left text-[11.5px] text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Mẫu</th>
                  <th className="px-2 py-2 text-right font-medium">Chi · CPM</th>
                  <th className="px-2 py-2 text-right font-medium">Hiển thị · nhấp</th>
                  <th className="px-2 py-2 text-right font-medium">CTR · CPC</th>
                  <th className="px-2 py-2 text-right font-medium">Tin nhắn · chi/tin</th>
                  <th className="px-2 py-2 text-right font-medium">Đơn chốt · giao/hoàn</th>
                  <th className="px-3 py-2 font-medium">Phán quyết · luật giữ</th>
                  <th className="px-3 py-2 text-right font-medium">Thao tác</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((v) => {
                  const m = v.metrics;
                  const cpm = metricValue(m, "cpm");
                  const ctr = metricValue(m, "ctr");
                  const cpc = metricValue(m, "cpc");
                  const cpmsg = metricValue(m, "costPerMessage");
                  const coMau = v.verdict in VERDICT_TONE;
                  return (
                    <tr key={v.id} className="border-b border-hairline align-top last:border-b-0">
                      <td className="px-3 py-2">
                        <div className="flex gap-2">
                          <VariantImage imageId={v.imageId} available={v.imageAvailable} alt={v.headline || `Mẫu #${v.slot}`} className="size-12 shrink-0 rounded" iconClassName="size-4" />
                          <div className="min-w-0 max-w-[230px]">
                            <p className="truncate font-medium" title={v.headline}>
                              #{v.slot} {v.headline || <span className="italic text-muted-foreground">không tiêu đề</span>}
                            </p>
                            <p className="truncate text-[11px] text-muted-foreground" title={`${vnShortStamp(v.startAt)} → ${vnShortStamp(v.endAt)}`}>
                              Lô {formatDate(v.batchDay)} · {MODE_LABEL[v.mode]} · {VARIANT_STATUS_LABEL[v.status]}
                            </p>
                            <p className="truncate text-[11px] text-muted-foreground">{v.productName ?? v.productId ?? "—"}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-2 py-2">
                        <Hai top={formatVND(m.spendVnd)} bottom={formatVND(cpm === null ? null : Math.round(cpm))} />
                      </td>
                      <td className="px-2 py-2">
                        <Hai top={formatNumber(m.impressions)} bottom={formatNumber(m.clicks)} />
                      </td>
                      <td className="px-2 py-2">
                        <Hai top={formatPercent(ctr, 2)} bottom={formatVND(cpc === null ? null : Math.round(cpc))} />
                      </td>
                      <td className="px-2 py-2">
                        <Hai top={formatNumber(m.messages)} bottom={formatVND(cpmsg === null ? null : Math.round(cpmsg))} />
                      </td>
                      <td className="px-2 py-2">
                        <Hai
                          top={formatNumber(m.bookedOrders)}
                          bottom={`${formatNumber(m.deliveredOrders)} / ${formatNumber(m.returnedOrders)}`}
                          title="Đơn chốt (không huỷ) mang ad_id của mẩu · giao thành công / hoàn theo ORDER_OUTCOME"
                        />
                      </td>
                      <td className="max-w-[260px] px-3 py-2">
                        <span className={cn("inline-block rounded px-1.5 py-0.5 text-[11px] font-semibold", coMau ? VERDICT_TONE[v.verdict] : "bg-muted text-muted-foreground")}>
                          {CREATIVE_VERDICT_LABEL[v.verdict]}
                        </span>
                        <p className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground" title={v.reasons.join(" ")}>
                          {v.reasons.join(" ")}
                        </p>
                        <KeepChecks v={v} />
                      </td>
                      <td className="px-3 py-2 text-right">
                        {canWrite ? (
                          <div className="flex flex-col items-end gap-1">
                            {v.status === "LIVE" ? <PauseNowButton variantId={v.id} slot={v.slot} /> : null}
                            {v.verdict === "PROMISING" ? <ExtendButton variantId={v.id} slot={v.slot} /> : null}
                          </div>
                        ) : (
                          <span className="text-[11px] text-muted-foreground">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </div>
  );
}
