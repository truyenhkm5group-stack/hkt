import Link from "next/link";
import { CREATIVE_VERDICT_LABEL, type CreativeVerdict } from "@/lib/constants/creative-loop";
import {
  VIDEO_AD_ACTION_TAKEN_LABEL,
  VIDEO_AD_STATUS_LABEL,
  VIDEO_ANGLE_LABEL,
  VIDEO_POST_STATUS_LABEL,
  VIDEO_VARIANT_STATUS_LABEL,
  isVideoAngle,
  type VideoAdActionTaken,
  type VideoAdStatus,
  type VideoPostStatus,
  type VideoVariantStatus,
} from "@/lib/constants/video-scale";
import { formatDateTime, formatNumber, formatVND } from "@/lib/format";
import type { ReportSku } from "@/lib/queries/video-scale";
import { cn } from "@/lib/utils";
import { OptimizeNowButton } from "./optimize-now";

export type SkuProfit = { expectedProfit: number; margin: number | null; adSpend: number; orders: number; delivered: number };

const usd = (n: number | null) => (n === null ? "—" : `${n.toFixed(2)} USD`);
const label = <K extends string>(map: Record<K, string>, k: string) => (map as Record<string, string>)[k] ?? k;

/**
 * Tab "Báo cáo": MÃ → VIDEO → REEL → QUẢNG CÁO. Ba nhóm số KHÔNG trộn: số của META (lượt xem, ThruPlay — chỉ để hiểu video),
 * số của ERP (chi từ sổ chi tiêu, đơn qua `ORDER_AD_ID` + `ORDER_OUTCOME` — thứ phán quyết đọc), và lợi nhuận danh nghĩa của
 * CẢ MÃ (mọi nguồn đơn, không chỉ video). Lợi nhuận riêng từng quảng cáo KHÔNG tính — ERP không có công thức ấy, và tự chế
 * một công thức ở đây là thứ AGENTS.md mục 8 cấm.
 */
export function ReportPanel({
  skus,
  profit,
  periodLabel,
  periods,
  includeTest,
  lastOptimizeAt,
  canOptimize,
}: {
  skus: ReportSku[];
  profit: Record<string, SkuProfit>;
  periodLabel: string;
  periods: { key: string; label: string; active: boolean }[];
  includeTest: boolean;
  lastOptimizeAt: Date | null;
  canOptimize: boolean;
}) {
  return (
    <div className="space-y-4 text-[13px]">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground">Lợi nhuận mã theo kỳ:</span>
        {periods.map((p) => (
          <Link key={p.key} href={`?tab=bao-cao&period=${p.key}${includeTest ? "&test=1" : ""}`} className={cn("rounded px-2 py-1", p.active ? "bg-primary text-primary-foreground" : "bg-muted")}>
            {p.label}
          </Link>
        ))}
        <Link href={`?tab=bao-cao${includeTest ? "" : "&test=1"}`} className="ml-auto rounded bg-muted px-2 py-1">
          {includeTest ? "Ẩn dữ liệu thử" : "Hiện cả dữ liệu thử"}
        </Link>
      </div>
      <div className="flex flex-wrap items-center gap-2 rounded-lg border p-2">
        <span>
          Vòng tối ưu gần nhất (bộ lập lịch): <b>{lastOptimizeAt ? formatDateTime(lastOptimizeAt) : "chưa chạy lần nào"}</b>
        </span>
        {canOptimize ? <OptimizeNowButton /> : null}
      </div>

      {skus.length === 0 ? <p className="text-muted-foreground">Chưa có video nào.</p> : null}

      {skus.map((s) => {
        const pr = profit[s.productId];
        return (
          <section key={s.productId} className="space-y-2 rounded-lg border p-3">
            <header className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
              <h2 className="text-[14px] font-semibold">
                {s.code ? `${s.code} · ` : ""}
                {s.name}
              </h2>
              <span className="text-muted-foreground">
                {s.runs} vòng · {s.variants.length} video · tiền AI {usd(s.aiUsd)} (ước tính theo bảng giá)
              </span>
              <span className="text-muted-foreground">
                Cả mã, {periodLabel}, MỌI nguồn đơn:{" "}
                {pr ? (
                  <>
                    {formatNumber(pr.orders)} đơn · {formatNumber(pr.delivered)} giao TC · chi QC {formatVND(pr.adSpend)} · lợi nhuận danh nghĩa <b>{formatVND(pr.expectedProfit)}</b>
                  </>
                ) : (
                  "— (mã không có đơn trong kỳ)"
                )}
              </span>
            </header>
            <div className="space-y-2">
              {s.variants.map((v) => (
                <div key={v.id} className="rounded border p-2">
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <b>V{v.seq}</b>
                    <span>{isVideoAngle(v.angle) ? VIDEO_ANGLE_LABEL[v.angle] : v.angle}</span>
                    <span className="text-muted-foreground">&ldquo;{v.hook}&rdquo;</span>
                    <span className="rounded bg-muted px-1.5">{label(VIDEO_VARIANT_STATUS_LABEL as Record<VideoVariantStatus, string>, v.status)}</span>
                    {v.isTest ? <span className="rounded bg-amber-500/20 px-1.5 font-medium">DỮ LIỆU THỬ</span> : null}
                    <span className="text-muted-foreground">tiền AI {usd(v.aiUsd)}</span>
                  </div>
                  {v.posts.map((p) => (
                    <p key={p.id} className="mt-1 text-[12.5px]">
                      Reel {label(VIDEO_POST_STATUS_LABEL as Record<VideoPostStatus, string>, p.status)}
                      {p.permalink ? (
                        <>
                          {" "}
                          ·{" "}
                          <a className="underline" href={p.permalink} target="_blank" rel="noreferrer">
                            mở bài
                          </a>
                        </>
                      ) : null}
                      {p.snapshot ? (
                        p.snapshot.error ? (
                          <span className="text-muted-foreground"> · số đo Reel: không đọc được ({p.snapshot.error})</span>
                        ) : (
                          <span className="text-muted-foreground">
                            {" "}
                            · META: {formatNumber(p.snapshot.plays)} lượt phát · {formatNumber(p.snapshot.reach)} người xem · {formatNumber(p.snapshot.reactions)} cảm xúc · {formatNumber(p.snapshot.comments)} bình luận ·{" "}
                            {formatNumber(p.snapshot.shares)} chia sẻ ({formatDateTime(p.snapshot.capturedAt)})
                          </span>
                        )
                      ) : null}
                    </p>
                  ))}
                  {v.ads.length ? (
                    <div className="mt-1 overflow-x-auto">
                      <table className="w-full min-w-[720px] text-[12px]">
                        <thead className="text-left text-muted-foreground">
                          <tr>
                            <th className="py-1 pr-2">Quảng cáo</th>
                            <th className="pr-2">Ngân sách / ngày</th>
                            <th className="pr-2">ERP: chi · đơn chốt · giao TC · hoàn</th>
                            <th className="pr-2">ERP: doanh thu chốt · giao TC</th>
                            <th className="pr-2">META: phát · ThruPlay · xem hết</th>
                            <th>Phán quyết · hành động</th>
                          </tr>
                        </thead>
                        <tbody>
                          {v.ads.map((a) => (
                            <tr key={a.id} className="border-t align-top">
                              <td className="py-1 pr-2">
                                {label(VIDEO_AD_STATUS_LABEL as Record<VideoAdStatus, string>, a.status)}
                                <span className="block text-muted-foreground">{a.fbAdId || a.adName}</span>
                              </td>
                              <td className="pr-2 tabular-nums">{formatVND(a.dailyBudgetVnd)}</td>
                              <td className="pr-2 tabular-nums">
                                {formatVND(a.erp.spendVnd)} · {a.erp.bookedOrders} · {a.erp.deliveredOrders} · {a.erp.returnedOrders}
                              </td>
                              <td className="pr-2 tabular-nums">
                                {formatVND(a.erp.bookedRevenueVnd)} · {formatVND(a.erp.deliveredRevenueVnd)}
                              </td>
                              <td className="pr-2 tabular-nums">
                                {formatNumber(a.meta.videoPlays)} · {formatNumber(a.meta.thruplays)} · {formatNumber(a.meta.p100)}
                              </td>
                              <td>
                                {a.verdict ? (
                                  <>
                                    <b>{label(CREATIVE_VERDICT_LABEL as Record<CreativeVerdict, string>, a.verdict.verdict)}</b> · {label(VIDEO_AD_ACTION_TAKEN_LABEL as Record<VideoAdActionTaken, string>, a.verdict.action)}
                                    <span className="block text-muted-foreground">{[...a.verdict.reasons, a.verdict.actionResult].filter(Boolean).join(" ")}</span>
                                  </>
                                ) : (
                                  <span className="text-muted-foreground">Chưa chấm</span>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : null}
                  {v.lesson ? <p className="mt-1 text-[12px] italic text-muted-foreground">Bài học: {v.lesson}</p> : null}
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
