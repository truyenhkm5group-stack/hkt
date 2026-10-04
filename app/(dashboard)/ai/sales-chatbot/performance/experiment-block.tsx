import Link from "next/link";
import { SectionCard } from "@/components/ui-bits";
import { formatDateTime, formatNumber, formatPercent, formatVND } from "@/lib/format";
import type { ExperimentReport } from "@/lib/sales-chatbot/experiment-report";
import { drillHref, liftOrNull, MIN_ARM_SAMPLE, type ArmStats } from "@/lib/sales-chatbot/experiment-shared";

const pct = (r: number | null) => formatPercent(r === null ? null : r * 100, 1);
const pp = (r: number | null) => (r === null ? "—" : `${r >= 0 ? "+" : ""}${(r * 100).toFixed(1)} điểm`);
const cnt = (n: number | null) => (n === null ? "chưa đo" : formatNumber(n));

/** Khối «AI vs Người theo nhánh thử nghiệm» của màn Hiệu quả — chỉ hiện khi đã có hội thoại được chia nhánh. */
export function ExperimentBlock({ report, days }: { report: ExperimentReport; days: number }) {
  const { AI: ai, HUMAN: human } = report.arms;
  const rows: [string, (a: ArmStats) => string, string | null][] = [
    ["Hội thoại", (a) => formatNumber(a.conversations), null],
    ["Có đường ghi đơn (độ phủ)", (a) => formatNumber(a.measurableConversations), null],
    ["Đơn", (a) => cnt(a.orders), null],
    ["Ra đơn / hội thoại", (a) => pct(a.conversion), pp(liftOrNull(ai.conversion, human.conversion))],
    ["Đơn giao thành công", (a) => cnt(a.delivered), null],
    ["Giao thành công / hội thoại", (a) => pct(a.deliveredConversion), pp(liftOrNull(ai.deliveredConversion, human.deliveredConversion))],
    ["Tỷ lệ giao (trên đơn đã ngã ngũ)", (a) => pct(a.deliveryRate), pp(liftOrNull(ai.deliveryRate, human.deliveryRate))],
    ["Giá trị đơn trung bình", (a) => formatVND(a.aovVnd), null],
    ["Doanh thu giao thành công", (a) => formatVND(a.deliveredRevenueVnd), null],
  ];
  return (
    <SectionCard
      title="AI vs Người — theo nhánh thử nghiệm"
      description={`Khoá ${report.key} · ${report.running ? `đang chạy, ${report.aiSharePct}% hội thoại mới cho AI` : "đã dừng"}${report.startedAt ? ` · từ ${formatDateTime(report.startedAt)}` : ""}`}
      hint={
        <div className="space-y-1.5 text-xs leading-5">
          <p>Hai nhánh chia NGẪU NHIÊN theo hội thoại và được ghim từ lượt đầu, nên so sánh được. Đọc theo ý định điều trị: đơn gắn với hội thoại thuộc nhánh nào tính cho nhánh đó. Toàn bộ thời gian thử nghiệm — không theo bộ lọc kỳ.</p>
          <p>Nhánh người chỉ có đơn khi «AI ghi đơn hộ nhân viên» bật (fanpage). Tắt ⇒ «chưa đo», không phải 0. Tỷ lệ dưới {MIN_ARM_SAMPLE} hội thoại in «—». Kết cục đơn theo ORDER_OUTCOME.</p>
        </div>
      }
    >
      <table className="w-full text-sm" data-testid="ai-perf-arms">
        <thead>
          <tr className="border-b text-left text-xs text-muted-foreground">
            <th className="py-1.5 pr-3 font-medium" />
            <th className="py-1.5 pr-3 text-right font-medium">
              <Link href={drillHref({ days, arm: "AI" })} className="hover:underline">
                Nhánh AI
              </Link>
            </th>
            <th className="py-1.5 pr-3 text-right font-medium">
              <Link href={drillHref({ days, arm: "HUMAN" })} className="hover:underline">
                Nhánh người
              </Link>
            </th>
            <th className="py-1.5 text-right font-medium">AI − người</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([label, f, lift]) => (
            <tr key={label} className="border-b last:border-0">
              <td className="py-1.5 pr-3">{label}</td>
              <td className="py-1.5 pr-3 text-right tabular-nums">{f(ai)}</td>
              <td className="py-1.5 pr-3 text-right tabular-nums">{f(human)}</td>
              <td className="py-1.5 text-right tabular-nums text-muted-foreground">{lift ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {human.note ? <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">{human.note}</p> : null}
    </SectionCard>
  );
}
