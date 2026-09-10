import Link from "next/link";
import { AlertTriangle, ArrowRight, Banknote, CircleHelp, Clock, UserX } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { MetricCard } from "@/components/metric-card";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { requirePermission } from "@/lib/auth/session";
import { ageLabel } from "@/lib/constants/action-queue";
import { AGING_BUCKETS } from "@/lib/constants/operating-funnel";
import { formatNumber, formatVND } from "@/lib/format";
import { getEstimatorStatus } from "@/lib/queries/impact";
import { getFunnelHealth, getRecoveryScoreboard, type StageHealth, type StageStatus } from "@/lib/queries/stage-health";
import { cn } from "@/lib/utils";

export const metadata = { title: "Điều hành hằng ngày" };

/**
 * ───────────── TRUNG TÂM ĐIỀU HÀNH ─────────────
 *
 * Bốn phần, đúng bốn câu hỏi mà chủ shop hỏi mỗi sáng, theo đúng thứ tự đó:
 *
 *   A. ĐANG KẸT Ở ĐÂU?            B. VIỆC NÀO CẦN LÀM NGAY?
 *   C. AI PHỤ TRÁCH?              D. XỬ LÝ THÌ THU VỀ BAO NHIÊU?
 *
 * Trang này KHÔNG có luật phát hiện riêng và không đếm lại từ đơn. Nó gom chính những việc mà
 * trang Cần xử lý đã phát hiện, rồi xếp chúng theo KHÂU VẬN HÀNH. Nhờ vậy hai trang không bao giờ
 * nói hai con số khác nhau về cùng một chuyện — bấm vào bất kỳ số nào cũng ra đúng danh sách ấy.
 */

const TONE: Record<StageStatus, string> = {
  BLOCKED: "border-rose-300/70 bg-rose-50/60 dark:border-rose-900/60 dark:bg-rose-950/20",
  WARNING: "border-amber-300/70 bg-amber-50/50 dark:border-amber-900/60 dark:bg-amber-950/20",
  OK: "border-border bg-card",
  UNKNOWN: "border-dashed border-border bg-muted/30",
};

const STATUS_LABEL: Record<StageStatus, string> = {
  BLOCKED: "Đang tắc",
  WARNING: "Đang dồn",
  OK: "Thông",
  UNKNOWN: "Chưa đo được",
};

const STATUS_TONE: Record<StageStatus, string> = {
  BLOCKED: "bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300",
  WARNING: "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300",
  OK: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300",
  UNKNOWN: "bg-muted text-muted-foreground",
};

const SOURCE_NOTE = {
  HEALTHY: null,
  DEGRADED: "Nguồn thiếu một phần",
  DATA_UNAVAILABLE: "Chưa có nguồn dữ liệu",
} as const;

/** Thanh tuổi việc: mỗi mốc một đoạn, rộng theo tỷ lệ. Việc để lâu càng nhiều thì đoạn phải càng đậm. */
function AgingBar({ stage }: { stage: StageHealth }) {
  if (!stage.backlog) return null;
  const mau = ["bg-emerald-400/70", "bg-sky-400/70", "bg-amber-400/80", "bg-orange-500/80", "bg-rose-500/85"];
  return (
    <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-muted" title={AGING_BUCKETS.map((b) => `${b.label}: ${stage.aging[b.key]}`).join(" · ")}>
      {AGING_BUCKETS.map((b, i) => {
        const n = stage.aging[b.key];
        if (!n) return null;
        return <div key={b.key} className={mau[i]} style={{ width: `${(n / stage.backlog) * 100}%` }} />;
      })}
    </div>
  );
}

export default async function OperationsPage() {
  await requirePermission("dashboard:view");
  const [health, estimator, bang] = await Promise.all([getFunnelHealth(), getEstimatorStatus(), getRecoveryScoreboard(7)]);

  // Câu B lấy ngoại lệ của MỌI khâu rồi xếp theo tiền treo — người vận hành cần biết việc nào
  // đáng làm trước trong cả shop, không phải trong từng khâu.
  const viecGap = health.stages
    .flatMap((s) => s.exceptions.map((e) => ({ ...e, stage: s.label, team: s.teamLabel })))
    .sort((a, b) => b.amount - a.amount || b.breached - a.breached)
    .slice(0, 8);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Điều hành hằng ngày"
        description="Bốn câu hỏi, theo đúng thứ tự: đang kẹt ở đâu · việc nào làm ngay · ai phụ trách · thu về được bao nhiêu."
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          label="Việc đang mở"
          value={formatNumber(health.totalBacklog)}
          note={health.worst ? `Nặng nhất: ${health.worst.label}` : "Không khâu nào đang dồn"}
          icon={Clock}
          tone={health.totalBacklog > 0 ? "amber" : "green"}
        />
        <MetricCard
          label="Tiền đang treo"
          value={formatVND(health.totalAtRisk)}
          note="Số thật từ đơn và vận đơn — không nhân hệ số nào"
          hint="Đây là tổng giá trị đơn / COD nằm trong các việc chưa xử lý. Nó KHÔNG phải khoản lỗ: một phần vẫn về đích. Phần ước tính thu hồi để riêng, không gộp vào con số này."
          icon={Banknote}
          tone={health.totalAtRisk > 0 ? "rose" : "slate"}
        />
        <MetricCard
          label="Ước tính thu hồi"
          value={health.totalRecoverable === null ? "Chưa đo được" : formatVND(health.totalRecoverable)}
          note={estimator.note}
          hint="Ước tính chỉ bật khi có đủ ca ĐÃ ĐƯỢC NGƯỜI XỬ LÝ để đo tỷ lệ thật. Nhân tiền treo với một hệ số phỏng đoán sẽ ra một con số trông như tiền thật mà không kiểm chứng được."
          icon={CircleHelp}
          tone="slate"
        />
        <MetricCard
          label="Việc chưa ai nhận"
          value={formatNumber(health.byTeam.reduce((a, t) => a + t.unassigned, 0))}
          note="Việc không có chủ là việc sẽ trôi"
          icon={UserX}
          tone={health.byTeam.some((t) => t.unassigned > 0) ? "amber" : "green"}
        />
      </div>

      {/* ───────── A. ĐANG KẸT Ở ĐÂU ───────── */}
      <SectionCard
        title="A · Đang kẹt ở đâu"
        description="Từng khâu của dòng chảy, theo thứ tự hàng đi. Màu thanh nói tuổi việc: xanh là mới, đỏ là để quá ba ngày."
        hint="Khâu 'Chưa đo được' KHÔNG có nghĩa là đang khoẻ — nghĩa là chưa có nguồn dữ liệu hoặc chưa có luật phát hiện nào cho khâu đó. Xem ghi chú nguồn của từng khâu."
        padded={false}
      >
        <ul className="divide-y">
          {health.stages.map((s) => (
            <li key={s.key} className={cn("px-4 py-3", TONE[s.status])}>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="w-5 shrink-0 text-[11px] text-muted-foreground">{s.order}</span>
                <Link href={s.href} className="text-[13.5px] font-semibold hover:underline">
                  {s.label}
                </Link>
                <span className={cn("rounded px-1.5 py-0.5 text-[10.5px] font-semibold", STATUS_TONE[s.status])}>{STATUS_LABEL[s.status]}</span>
                <span className="text-[11.5px] text-muted-foreground">{s.teamLabel}</span>

                <div className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px]">
                  {s.backlog > 0 ? (
                    <>
                      <span>
                        <b className="numeric">{formatNumber(s.backlog)}</b> việc
                      </span>
                      {s.unassigned > 0 ? <span className="text-amber-700 dark:text-amber-300">{formatNumber(s.unassigned)} chưa ai nhận</span> : null}
                      {s.breached > 0 ? <span className="text-rose-600 dark:text-rose-400">{formatNumber(s.breached)} trễ hạn</span> : null}
                      <span className="text-muted-foreground">cũ nhất {s.oldestLabel}</span>
                      {s.impact.moneyAtRisk > 0 ? <span className="numeric font-semibold">{formatVND(s.impact.moneyAtRisk)}</span> : null}
                    </>
                  ) : (
                    <span className="text-muted-foreground">{SOURCE_NOTE[s.sourceStatus] ?? "không có việc tồn"}</span>
                  )}
                </div>
              </div>

              {s.backlog > 0 ? (
                <div className="mt-2 space-y-1.5">
                  <AgingBar stage={s} />
                  {/* TIỀN Ở KHÂU NÀY NGHĨA LÀ GÌ — không nói thì mỗi người hiểu một kiểu và cộng nhầm. */}
                  <p className="text-[11.5px] leading-snug text-muted-foreground">{s.moneyMeaning}</p>
                </div>
              ) : s.sourceStatus !== "HEALTHY" ? (
                <p className="mt-1.5 text-[11.5px] leading-snug text-muted-foreground">{s.sourceNote}</p>
              ) : null}
            </li>
          ))}
        </ul>
      </SectionCard>

      {/* ───────── B. VIỆC NÀO CẦN LÀM NGAY ───────── */}
      <SectionCard
        title="B · Việc nào cần làm ngay"
        description="Xếp theo tiền đang treo, không theo thứ tự phát hiện. Mỗi dòng nói rõ phải làm gì, không chỉ báo là có vấn đề."
        padded={false}
      >
        {viecGap.length === 0 ? (
          <EmptyState title="Không còn việc nào đang mở" description="Mọi khâu đều thông." className="m-4" />
        ) : (
          <ul className="divide-y">
            {viecGap.map((e) => (
              <li key={`${e.stage}-${e.type}`} className="flex flex-wrap items-start gap-x-3 gap-y-1.5 px-4 py-3">
                <div className="min-w-[260px] flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[13.5px] font-semibold">{e.label}</span>
                    <span className="numeric rounded bg-muted px-1.5 py-0.5 text-[11px] font-semibold">{formatNumber(e.count)}</span>
                    {e.breached > 0 ? (
                      <span className="rounded bg-rose-100 px-1.5 py-0.5 text-[10.5px] font-semibold text-rose-800 dark:bg-rose-950/60 dark:text-rose-300">
                        {formatNumber(e.breached)} trễ hạn
                      </span>
                    ) : null}
                    <span className="text-[11.5px] text-muted-foreground">
                      {e.stage} · {e.team} · cũ nhất {ageLabel(e.oldestHours)}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[12.5px] leading-snug text-muted-foreground">{e.action}</p>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  {e.amount > 0 ? <span className="numeric text-[13px] font-semibold">{formatVND(e.amount)}</span> : null}
                  <Link href={e.href} className="inline-flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-[12px] font-medium hover:bg-accent">
                    Mở danh sách <ArrowRight className="size-3.5" />
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <div className="grid gap-5 lg:grid-cols-2">
        {/* ───────── C. AI PHỤ TRÁCH ───────── */}
        <SectionCard title="C · Ai phụ trách" description="Tải việc theo bộ phận. Cột 'chưa ai nhận' quan trọng hơn tổng số việc." padded={false}>
          {health.byTeam.length === 0 ? (
            <EmptyState title="Không bộ phận nào đang có việc tồn" className="m-4" />
          ) : (
            <ul className="divide-y">
              {health.byTeam.map((t) => (
                <li key={t.team} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
                  <span className="text-[13.5px] font-semibold">{t.label}</span>
                  {t.worstStage ? <span className="text-[11.5px] text-muted-foreground">nặng nhất: {t.worstStage}</span> : null}
                  <div className="ml-auto flex items-center gap-3 text-[12px]">
                    <span>
                      <b className="numeric">{formatNumber(t.backlog)}</b> việc
                    </span>
                    {t.unassigned > 0 ? <span className="text-amber-700 dark:text-amber-300">{formatNumber(t.unassigned)} chưa nhận</span> : null}
                    {t.breached > 0 ? <span className="text-rose-600 dark:text-rose-400">{formatNumber(t.breached)} trễ</span> : null}
                    {t.moneyAtRisk > 0 ? <span className="numeric font-semibold">{formatVND(t.moneyAtRisk)}</span> : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        {/* ───────── D. THU VỀ ĐƯỢC BAO NHIÊU ───────── */}
        <SectionCard
          title="D · Xử lý thì thu về bao nhiêu"
          description="Tiền đang treo là SỰ THẬT. Ước tính thu hồi là ƯỚC TÍNH. Hai dòng riêng, không bao giờ gộp."
        >
          <dl className="space-y-3 text-sm">
            <div className="flex items-baseline justify-between gap-3 rounded-lg border bg-muted/30 px-3 py-2.5">
              <dt>
                <div className="font-semibold">Tiền đang treo</div>
                <div className="text-[11.5px] text-muted-foreground">Đếm từ đơn và vận đơn có thật</div>
              </dt>
              <dd className="numeric shrink-0 text-lg font-bold">{formatVND(health.totalAtRisk)}</dd>
            </div>

            <div className="flex items-baseline justify-between gap-3 rounded-lg border border-dashed px-3 py-2.5">
              <dt>
                <div className="font-semibold">Ước tính thu hồi</div>
                <div className="text-[11.5px] leading-snug text-muted-foreground">{estimator.note}</div>
              </dt>
              <dd className="numeric shrink-0 text-lg font-bold text-muted-foreground">
                {health.totalRecoverable === null ? "chưa đo được" : formatVND(health.totalRecoverable)}
              </dd>
            </div>

            {/*
              VÒNG PHẢN HỒI: việc làm xong đã đem về gì. Không có khối này thì hàng đợi chỉ có đầu
              vào mà không có đầu ra, và người vận hành không bao giờ thấy công của mình.
            */}
            <div className="rounded-lg border px-3 py-2.5">
              <div className="flex items-baseline justify-between gap-3">
                <dt className="font-semibold">7 ngày qua · người xử lý</dt>
                <dd className="numeric shrink-0 font-bold">{formatNumber(bang.closedByPeople)} việc</dd>
              </div>
              <p className="mt-1 text-[11.5px] leading-snug text-muted-foreground">
                {bang.closedByPeople === 0 ? (
                  <>
                    Chưa việc nào được người bấm đóng ({formatNumber(bang.closedAutomatically)} việc tự đóng vì điều kiện hết — không phải công của ai). Mỗi lần bấm
                    XONG là một mẫu để đo &quot;xử lý thì thu về bao nhiêu&quot;.
                  </>
                ) : (
                  <>
                    Mang theo <b className="numeric">{formatVND(bang.valueHandled)}</b>, trong đó <b className="numeric">{formatVND(bang.recoveredValue)}</b> đã về đích
                    ({formatNumber(bang.deliveredCases)} đơn giao thành công). Đây là số ĐO ĐƯỢC từ kết quả đơn, không phải ước tính.
                  </>
                )}
              </p>
            </div>

            {health.unestimatedAtRisk > 0 ? (
              <p className="flex gap-2 rounded-lg bg-muted/40 px-3 py-2 text-[12px] leading-snug text-muted-foreground">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                <span>
                  <b className="numeric">{formatVND(health.unestimatedAtRisk)}</b> nằm ở loại việc chưa có cách đo &quot;cứu được bao nhiêu&quot; — ví dụ COD quá hạn
                  (cứu được nghĩa là tiền về, kết quả đơn không nói gì) hay hàng hoàn chờ đếm (cứu được nghĩa là hàng vào lại tồn).
                </span>
              </p>
            ) : null}
          </dl>
        </SectionCard>
      </div>
    </div>
  );
}
