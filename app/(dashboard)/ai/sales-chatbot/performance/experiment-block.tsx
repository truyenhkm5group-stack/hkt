import Link from "next/link";
import { SectionCard } from "@/components/ui-bits";
import { formatDateTime, formatNumber, formatPercent, formatVND } from "@/lib/format";
import type { ExperimentReport } from "@/lib/sales-chatbot/experiment-report";
import { aiCostIsLowerBound, aiCostNote, drillHref, liftOrNull, MIN_ARM_SAMPLE, type ArmStats, type ProfitLift } from "@/lib/sales-chatbot/experiment-shared";

const pct = (r: number | null) => formatPercent(r === null ? null : r * 100, 1);
const pp = (r: number | null) => (r === null ? "—" : `${r >= 0 ? "+" : ""}${(r * 100).toFixed(1)} điểm`);
const cnt = (n: number | null) => (n === null ? "chưa đo" : formatNumber(n));
/** Ô chênh lệch LÃI: số có dấu + chiều cận (nếu có). Lý do ở cấp khối (vd thử nghiệm đã dừng) in dưới ô. */
const profitLiftText = (l: ProfitLift) => `${formatVND(l.value, { sign: true })}${l.bound === "UPPER" ? " · cận trên" : l.bound === "LOWER" ? " · cận dưới" : ""}`;

type Row = { label: string; cell: (a: ArmStats) => string; sub?: (a: ArmStats) => string | null; lift?: string; liftNote?: string | null };

/** Vì sao một ô LÃI để trống — in ngay dưới «—». Nhánh chưa đo thì ghi chú cuối khối đã nói, không lặp lại. */
function emptyProfitReason(a: ArmStats, opts: { perConversation: boolean; needsCost: boolean }): string | null {
  if (a.measurableConversations <= 0) return null;
  if ((a.cogsUnknown ?? 0) > 0) return "lãi chưa đủ — còn đơn chưa có giá vốn";
  if (opts.needsCost && a.aiCostVnd === null) return (a.aiUnknownTurns ?? 0) > 0 ? "chi phí AI chưa định giá được" : "chưa có lượt AI nào được định giá";
  if (opts.perConversation && a.measurableConversations < MIN_ARM_SAMPLE) return `dưới ${MIN_ARM_SAMPLE} hội thoại`;
  return null;
}

/** Dòng phụ của ô lãi sau AI: số có mà chi phí là cận dưới ⇒ số này là CẬN TRÊN; số trống ⇒ lý do. */
const afterAiSub = (perConversation: boolean) => (a: ArmStats) =>
  (perConversation ? a.profitAfterAiPerConversationVnd : a.profitAfterAiVnd) === null ? emptyProfitReason(a, { perConversation, needsCost: true }) : aiCostIsLowerBound(a) ? "cận trên (chi phí AI là cận dưới)" : null;

/** Khối «AI vs Người theo nhánh thử nghiệm» của màn Hiệu quả — chỉ hiện khi đã có hội thoại được chia nhánh. */
export function ExperimentBlock({ report, days, from = null, to = null }: { report: ExperimentReport; days: number; from?: string | null; to?: string | null }) {
  const { AI: ai, HUMAN: human } = report.arms;
  // Chênh lệch LÃI đọc từ báo cáo (đã chặn khi thử nghiệm dừng) — không tự tính lại ở đây.
  const grossLift = report.profitLifts.grossProfitPerConversation;
  const afterAiLift = report.profitLifts.profitAfterAiPerConversation;
  const rows: Row[] = [
    { label: "Hội thoại", cell: (a) => formatNumber(a.conversations) },
    { label: "Có đường ghi đơn (độ phủ)", cell: (a) => formatNumber(a.measurableConversations) },
    { label: "Đơn", cell: (a) => cnt(a.orders) },
    { label: "Ra đơn / hội thoại", cell: (a) => pct(a.conversion), lift: pp(liftOrNull(ai.conversion, human.conversion)) },
    { label: "Đơn giao thành công", cell: (a) => cnt(a.delivered) },
    { label: "Giao thành công / hội thoại", cell: (a) => pct(a.deliveredConversion), lift: pp(liftOrNull(ai.deliveredConversion, human.deliveredConversion)) },
    { label: "Tỷ lệ giao (trên đơn đã ngã ngũ)", cell: (a) => pct(a.deliveryRate), lift: pp(liftOrNull(ai.deliveryRate, human.deliveryRate)) },
    { label: "Giá trị đơn trung bình", cell: (a) => formatVND(a.aovVnd) },
    { label: "Doanh thu giao thành công", cell: (a) => formatVND(a.deliveredRevenueVnd) },
    {
      label: "Lãi gộp đã giao",
      cell: (a) => formatVND(a.grossProfitVnd),
      sub: (a) => (a.measurableConversations <= 0 ? null : `biên ${formatPercent(a.grossMargin === null ? null : a.grossMargin * 100, 0)}${a.cogsUnknown ? ` · ${formatNumber(a.cogsUnknown)} đơn chưa có giá vốn (${formatVND(a.cogsUnknownRevenueVnd)}) không tính` : ""}`),
    },
    {
      label: "Lãi gộp / hội thoại",
      cell: (a) => formatVND(a.grossProfitPerConversationVnd),
      sub: (a) => (a.grossProfitPerConversationVnd === null ? emptyProfitReason(a, { perConversation: true, needsCost: false }) : null),
      lift: profitLiftText(grossLift),
      liftNote: grossLift.reason,
    },
    ...(report.withMoney
      ? [
          { label: "Chi phí AI (ước tính)", cell: (a: ArmStats) => formatVND(a.aiCostVnd), sub: aiCostNote },
          { label: "Lãi sau chi phí AI (ước tính)", cell: (a: ArmStats) => formatVND(a.profitAfterAiVnd), sub: afterAiSub(false) },
          {
            label: "Lãi sau AI / hội thoại (ước tính)",
            cell: (a: ArmStats) => formatVND(a.profitAfterAiPerConversationVnd),
            sub: afterAiSub(true),
            lift: profitLiftText(afterAiLift),
            liftNote: afterAiLift.reason,
          },
        ]
      : []),
  ];
  return (
    <SectionCard
      title="AI vs Người — theo nhánh thử nghiệm"
      description={`Khoá ${report.key} · ${report.running ? `đang chạy, ${report.aiSharePct}% hội thoại mới cho AI` : "đã dừng"}${report.startedAt ? ` · từ ${formatDateTime(report.startedAt)}` : ""}`}
      hint={
        <div className="space-y-1.5 text-xs leading-5">
          <p>Hai nhánh chia NGẪU NHIÊN theo hội thoại và được ghim từ lượt đầu, nên so sánh được. Đọc theo ý định điều trị: đơn gắn với hội thoại thuộc nhánh nào tính cho nhánh đó. Toàn bộ thời gian thử nghiệm — không theo bộ lọc kỳ.</p>
          <p>Nhánh người chỉ có đơn khi «AI ghi đơn hộ nhân viên» bật (fanpage). Tắt ⇒ «chưa đo», không phải 0. Tỷ lệ dưới {MIN_ARM_SAMPLE} hội thoại in «—». Kết cục đơn theo ORDER_OUTCOME.</p>
          <p>Lãi gộp đã giao = doanh thu đã giao − giá vốn, cùng đường giá vốn với Báo cáo lợi nhuận (giá vốn đã chốt lúc giao). Đơn chưa có giá vốn KHÔNG cộng vào lãi với giá vốn 0 — đếm riêng; còn đơn như vậy thì «lãi / hội thoại» và chênh lệch để trống: lãi chưa đủ thì không chia, không so. Chưa trừ chi phí AI, nhân sự, cước, quảng cáo. Thử nghiệm đã dừng ⇒ không so chênh lệch lãi: ERP chưa lưu lúc dừng nên đơn và tiền AI về sau vẫn cộng vào nhánh — số từng nhánh vẫn in.</p>
          {report.withMoney ? (
            <p>
              Chi phí AI = token thật × bảng giá model × tỷ giá {formatNumber(report.rateVndPerUsd)} ₫/USD — ƯỚC TÍNH: mọi lượt AI của hội thoại thuộc nhánh (cả lượt AI ghi đơn hộ nhân viên ở nhánh người), tính từ NGÀY hội thoại được chia nhánh. Còn lượt chưa định giá ⇒ chi phí là cận dưới, lãi sau AI là cận trên; lãi gộp chưa đủ thì lãi sau AI cũng để trống. Chưa trừ chi phí nhân sự (xem «tiết kiệm nhân sự» ở khung Chi phí AI & ROI), cước, quảng cáo.
            </p>
          ) : null}
        </div>
      }
    >
      <table className="w-full text-sm" data-testid="ai-perf-arms">
        <thead>
          <tr className="border-b text-left text-xs text-muted-foreground">
            <th className="py-1.5 pr-3 font-medium" />
            <th className="py-1.5 pr-3 text-right font-medium">
              <Link href={drillHref({ days, from, to, arm: "AI" })} className="hover:underline">
                Nhánh AI
              </Link>
            </th>
            <th className="py-1.5 pr-3 text-right font-medium">
              <Link href={drillHref({ days, from, to, arm: "HUMAN" })} className="hover:underline">
                Nhánh người
              </Link>
            </th>
            <th className="py-1.5 text-right font-medium">AI − người</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label} className="border-b last:border-0">
              <td className="py-1.5 pr-3">{row.label}</td>
              {[ai, human].map((a, i) => {
                const sub = row.sub ? row.sub(a) : null;
                return (
                  <td key={i} className="py-1.5 pr-3 text-right tabular-nums">
                    {row.cell(a)}
                    {sub ? <div className="text-[11px] leading-4 text-muted-foreground">{sub}</div> : null}
                  </td>
                );
              })}
              <td className="py-1.5 text-right tabular-nums text-muted-foreground">
                {row.lift ?? ""}
                {row.liftNote ? <div className="text-[11px] leading-4">{row.liftNote}</div> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {human.note ? <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">{human.note}</p> : null}
    </SectionCard>
  );
}
