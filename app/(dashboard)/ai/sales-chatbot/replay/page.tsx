import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { can, requirePermission } from "@/lib/auth/session";
import { formatDateTime, formatPercent, formatVND } from "@/lib/format";
import { customerFacing, customerReplayDetail } from "@/lib/saas/visibility";
import { listReplayRuns, loadReplayRun, type ReplayRunRow } from "@/lib/sales-chatbot/replay";
import { REPLAY_FLAG_LABEL, REPLAY_LIMITS, type ReplayFlag } from "@/lib/sales-chatbot/replay-shared";
import { SALES_CHATBOT_MANAGE } from "@/lib/sales-chatbot/settings";
import { cn } from "@/lib/utils";
import { ReplayStartForm } from "./start-form";

export const metadata = { title: "Phát lại hội thoại cũ" };

const pct = (r: number | null | undefined) => formatPercent(r === null || r === undefined ? null : r * 100, 0);
const STATUS_LABEL: Record<string, string> = { RUNNING: "Đang chạy", DONE: "Xong", FAILED: "Hỏng" };
const SPEAKER_LABEL: Record<string, string> = { BOT: "Bot", SHOP: "Người / page", NONE: "Không ai trả lời" };
const FLAG_TONE: Partial<Record<ReplayFlag, string>> = { ERROR: "bg-destructive/10 text-destructive", EMPTY_REPLY: "bg-destructive/10 text-destructive", PRICE_UNGROUNDED: "bg-amber-500/15 text-amber-800 dark:text-amber-300", TOOL_ERROR: "bg-amber-500/15 text-amber-800 dark:text-amber-300" };

function RunList({ runs, current }: { runs: ReplayRunRow[]; current: string | null }) {
  if (!runs.length) return <EmptyState title="Chưa có lượt phát lại nào" description="Chọn số điểm rồi bấm «Phát lại»." className="m-4" />;
  return (
    <table className="w-full text-sm">
      <tbody>
        {runs.map((r) => (
          <tr key={r.id} className={cn("border-t border-hairline", r.id === current && "bg-primary/5")}>
            <td className="px-3 py-1.5">
              <Link href={`/ai/sales-chatbot/replay?run=${r.id}`} className="font-medium hover:underline">
                {formatDateTime(r.startedAt)}
              </Link>
              <div className="text-xs text-muted-foreground">{r.createdByEmail ?? "—"}</div>
            </td>
            <td className="px-3 py-1.5">{STATUS_LABEL[r.status] ?? r.status}</td>
            <td className="numeric px-3 py-1.5 text-right">
              {r.summary ? `${r.summary.points}/${r.targetPoints} điểm` : `${r.targetPoints} điểm`} · {r.days} ngày
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * PHÁT LẠI HỘI THOẠI CŨ — «nếu AI hôm nay đứng ở đúng chỗ ấy của một hội thoại thật, nó nói gì, và câu đó có căn cứ không?».
 * Báo cáo sẵn sàng trước khi bật tự động: số đo + độ phủ, KHÔNG có ngưỡng đạt / chưa đạt (quyết định là của người).
 */
export default async function ReplayPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requirePermission("ai_sales:view");
  const raw = (await searchParams).run;
  const runId = typeof raw === "string" ? raw : null;
  const list = await listReplayRuns(user);
  const runs = "ok" in list ? list.runs : [];
  const selected = runId ? await loadReplayRun(user, runId) : runs[0] ? await loadReplayRun(user, runs[0].id) : null;
  // Workspace KHÁCH (lib/saas/visibility.ts): câu lỗi lượt / điểm qua danh sách cho phép, không tên công cụ bot đã gọi.
  const customer = customerFacing(user.organization);
  const detail = selected && "ok" in selected ? (customer ? customerReplayDetail(selected) : selected) : null;
  const s = detail?.run.summary ?? null;
  const manage = can(user, SALES_CHATBOT_MANAGE);
  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="AI"
        title="Phát lại hội thoại cũ"
        description="Báo cáo sẵn sàng trước khi để AI tự trả lời"
        hint={
          <div className="space-y-1.5 text-xs leading-5">
            <p>Máy lấy tin KHÁCH THẬT từ hội thoại fanpage / web đã lưu, dựng lại lịch sử tới đúng chỗ đó rồi cho AI (cấu hình, lời nhắc, sổ tay HÔM NAY) trả lời ở kênh THỬ: công cụ chỉ mô phỏng — không tạo khách, đơn, giữ hàng hay tin nào tới khách.</p>
            <p>Chấm bằng luật đọc được: AI hỏng · không trả lời · giá trong câu KHÔNG có căn cứ (không phải giá bảng, không do công cụ trả, không phải phí ship đã khai, không phải số shop đã nói trước đó) · công cụ lỗi · AI chuyển người so với thực tế người trả lời.</p>
            <p>
              {customer ? "Mỗi điểm là một lượt AI thật." : "Mỗi điểm là một lượt AI thật trên khoá của shop."} Tỷ lệ dưới {REPLAY_LIMITS.minSample} mẫu in «—». Không có ngưỡng «đạt»: đọc từng câu rồi quyết.
            </p>
          </div>
        }
        actions={
          <Link href="/ai/sales-chatbot" className="text-sm font-medium text-primary hover:underline">
            ← Chatbot bán hàng
          </Link>
        }
      />
      {"error" in list ? <p className="text-sm text-destructive">{list.error}</p> : null}
      <div className="grid gap-5 xl:grid-cols-[360px_1fr]">
        <SectionCard title="Các lượt" actions={manage ? null : <span className="text-xs text-muted-foreground">Chỉ xem (cần ai_sales:manage để chạy)</span>} padded={false}>
          {manage ? (
            <div className="border-b border-hairline p-3">
              <ReplayStartForm disabled={runs.some((r) => r.status === "RUNNING")} />
            </div>
          ) : null}
          <RunList runs={runs} current={detail?.run.id ?? null} />
        </SectionCard>
        <div className="space-y-5">
          {detail ? (
            <>
              <SectionCard
                title={`Lượt ${formatDateTime(detail.run.startedAt)} · ${STATUS_LABEL[detail.run.status] ?? detail.run.status}`}
                description={detail.run.error ?? (s ? `${s.points} điểm từ ${s.conversations} hội thoại · AI trả lời được ${s.answered}` : "Đang chạy…")}
              >
                {s ? (
                  <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4" data-testid="replay-summary">
                    <div title="Số điểm AI hỏng / tổng điểm">
                      AI hỏng <b className="numeric">{pct(s.errorRate)}</b>
                    </div>
                    <div title={`Trên ${s.pointsWithAmounts} câu AI có nhắc số tiền`}>
                      Giá không căn cứ <b className="numeric">{pct(s.priceUngroundedRate)}</b>
                    </div>
                    <div>
                      Công cụ lỗi <b className="numeric">{pct(s.toolErrorRate)}</b>
                    </div>
                    <div>
                      AI chuyển người <b className="numeric">{pct(s.aiHandoffRate)}</b>
                    </div>
                    <div className="col-span-2 text-xs text-muted-foreground md:col-span-4" title="AI chuyển người × thực tế người / page trả lời câu đó">
                      Chuyển người — cả hai: {s.handoff.bothHuman} · chỉ AI: {s.handoff.aiOnly} · chỉ thực tế: {s.handoff.historyOnly} · không bên nào: {s.handoff.neither}
                    </div>
                  </div>
                ) : null}
              </SectionCard>
              <SectionCard title="Từng điểm" padded={false}>
                {detail.points.length === 0 ? (
                  <EmptyState title="Chưa có điểm nào" description={detail.run.status === "RUNNING" ? "Đang chạy — bấm «Làm mới»." : "Không có hội thoại khách thật trong khoảng ngày đã chọn."} className="m-4" />
                ) : (
                  <div className="divide-y divide-hairline" data-testid="replay-points">
                    {detail.points.map((p) => (
                      <div key={p.id} className="grid gap-2 p-3 text-sm md:grid-cols-3">
                        <div>
                          <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Khách · {p.sourceChannel}</div>
                          <p className="whitespace-pre-wrap">{p.customerText}</p>
                          <div className="mt-1 text-xs text-muted-foreground">{p.historyMessages} tin lịch sử trước đó</div>
                        </div>
                        <div>
                          <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Thực tế · {SPEAKER_LABEL[p.historicalSpeaker] ?? p.historicalSpeaker}</div>
                          <p className="whitespace-pre-wrap text-muted-foreground">{p.historicalReply ?? "—"}</p>
                        </div>
                        <div>
                          <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">AI hôm nay{p.aiStatus === "HANDOFF" ? " · chuyển người" : ""}</div>
                          <p className="whitespace-pre-wrap">{p.aiReply || p.error || "—"}</p>
                          {p.tools.length ? <div className="mt-1 text-xs text-muted-foreground">{p.tools.map((t) => `${t.ok ? "✓" : "✗"} ${t.name}`).join(" · ")}</div> : null}
                          <div className="mt-1 flex flex-wrap gap-1">
                            {p.flags.map((f) => (
                              <span key={f} className={cn("rounded px-1.5 py-0.5 text-[11px]", FLAG_TONE[f] ?? "bg-muted text-muted-foreground")}>
                                {REPLAY_FLAG_LABEL[f] ?? f}
                              </span>
                            ))}
                            {p.ungroundedAmounts.length ? <span className="text-[11px] text-amber-800 dark:text-amber-300">{p.ungroundedAmounts.map((n) => formatVND(n)).join(", ")}</span> : null}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </SectionCard>
            </>
          ) : (
            <EmptyState title="Chọn một lượt" description="Hoặc chạy lượt đầu tiên ở khung bên trái." />
          )}
        </div>
      </div>
    </div>
  );
}
