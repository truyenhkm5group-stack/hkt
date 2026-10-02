import { SectionCard } from "@/components/ui-bits";
import { formatNumber, formatVND } from "@/lib/format";
import type { ChatCostDay, ChatCostReport } from "@/lib/sales-chatbot/cost-report";

const dayLabel = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;

/** Chi phí AI của bot theo ngày — trên đơn chốt và trên SĐT khách để lại (lib/sales-chatbot/cost-report.ts). */
export function ChatCostPanel({ report }: { report: ChatCostReport }) {
  const today = report.days[0];
  const shown = report.days.filter((d, i) => i === 0 || d.turns > 0 || d.orders > 0 || d.phones > 0 || d.testCostVnd !== null || d.learnCostVnd !== null);
  const maxCost = Math.max(1, ...shown.map((d) => d.costVnd ?? 0));
  const t = report.total;
  const stats: { label: string; value: string }[] = [
    { label: "lượt AI trả lời", value: formatNumber(today.turns) },
    { label: "chi phí AI (ước tính)", value: formatVND(today.costVnd) },
    { label: "đơn bot chốt", value: formatNumber(today.orders) },
    { label: "AI / 1 đơn", value: formatVND(today.costPerOrder) },
    { label: "SĐT khách để lại", value: formatNumber(today.phones) },
    { label: "AI / 1 SĐT", value: formatVND(today.costPerPhone) },
  ];
  return (
    <SectionCard
      title="Chi phí AI theo ngày"
      description="Tiền token bot đã dùng, chia cho đơn chốt và SĐT khách để lại trong cùng ngày (giờ Việt Nam)."
      hint={
        <div className="space-y-1.5 text-xs leading-5">
          <p>Chi phí = token thật × bảng giá model × tỷ giá {formatNumber(report.rateVndPerUsd)} ₫/USD — là ƯỚC TÍNH; số chuẩn là hoá đơn của nhà cung cấp AI.</p>
          <p>Chỉ tính hội thoại fanpage và trang chat. Khung thử và «Học từ hội thoại cũ» là tiền thật nhưng KHÔNG chia vào đơn / SĐT — in riêng bên dưới.</p>
          <p>Đơn = đơn bot chốt thật (đã giữ hàng). SĐT = số khách để lại qua bot, đếm không trùng. Ngày không có đơn / SĐT thì «AI / đơn» để trống, không phải 0.</p>
        </div>
      }
    >
      <div className="space-y-4" data-testid="chat-cost-panel">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
          {stats.map((s) => (
            <div key={s.label} className="rounded-lg border bg-muted/30 px-3 py-2">
              <div className="text-lg font-semibold tabular-nums">{s.value}</div>
              <div className="text-xs text-muted-foreground">{s.label}</div>
            </div>
          ))}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="py-1.5 pr-3 font-medium">Ngày</th>
                <th className="py-1.5 pr-3 text-right font-medium">Lượt AI</th>
                <th className="py-1.5 pr-3 font-medium">Chi phí AI</th>
                <th className="py-1.5 pr-3 text-right font-medium">Đơn chốt</th>
                <th className="py-1.5 pr-3 text-right font-medium">AI / đơn</th>
                <th className="py-1.5 pr-3 text-right font-medium">SĐT</th>
                <th className="py-1.5 text-right font-medium">AI / SĐT</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((d) => (
                <CostRow key={d.day} d={d} label={d === today ? "Hôm nay" : dayLabel(d.day)} maxCost={maxCost} />
              ))}
              <tr className="border-t font-semibold">
                <td className="py-1.5 pr-3">{report.days.length} ngày</td>
                <td className="py-1.5 pr-3 text-right tabular-nums">{formatNumber(t.turns)}</td>
                <td className="py-1.5 pr-3 tabular-nums">{formatVND(t.costVnd)}</td>
                <td className="py-1.5 pr-3 text-right tabular-nums">{formatNumber(t.orders)}</td>
                <td className="py-1.5 pr-3 text-right tabular-nums">{formatVND(t.costPerOrder)}</td>
                <td className="py-1.5 pr-3 text-right tabular-nums">{formatNumber(t.phones)}</td>
                <td className="py-1.5 text-right tabular-nums">{formatVND(t.costPerPhone)}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <ul className="space-y-0.5 text-xs text-muted-foreground">
          <li>
            Ngoài phần trên ({report.days.length} ngày): khung thử {formatVND(t.testCostVnd)} · học hội thoại {formatVND(t.learnCostVnd)}.
          </li>
          {t.unknownCost > 0 ? <li className="text-amber-700 dark:text-amber-400">{formatNumber(t.unknownCost)} lượt AI dùng model chưa có trong bảng giá — chi phí trên là CẬN DƯỚI.</li> : null}
          {report.phonesWithoutDate > 0 ? <li>{formatNumber(report.phonesWithoutDate)} SĐT để lại trước 02/10/2026 chưa có mốc ngày — không đếm vào bảng (không đoán ngày).</li> : null}
        </ul>
      </div>
    </SectionCard>
  );
}

function CostRow({ d, label, maxCost }: { d: ChatCostDay; label: string; maxCost: number }) {
  const w = d.costVnd === null ? 0 : Math.max(2, Math.round((d.costVnd / maxCost) * 100));
  return (
    <tr className="border-b border-hairline last:border-0">
      <td className="py-1.5 pr-3 whitespace-nowrap">{label}</td>
      <td className="py-1.5 pr-3 text-right tabular-nums">{formatNumber(d.turns)}</td>
      <td className="py-1.5 pr-3">
        <div className="flex items-center gap-2">
          <span className="w-20 shrink-0 tabular-nums">
            {formatVND(d.costVnd)}
            {d.unknownCost > 0 ? "+" : ""}
          </span>
          <span className="h-1.5 w-24 overflow-hidden rounded bg-muted">
            <span className="block h-full rounded bg-primary/70" style={{ width: `${w}%` }} />
          </span>
        </div>
      </td>
      <td className="py-1.5 pr-3 text-right tabular-nums">{formatNumber(d.orders)}</td>
      <td className="py-1.5 pr-3 text-right tabular-nums">{formatVND(d.costPerOrder)}</td>
      <td className="py-1.5 pr-3 text-right tabular-nums">{formatNumber(d.phones)}</td>
      <td className="py-1.5 text-right tabular-nums">{formatVND(d.costPerPhone)}</td>
    </tr>
  );
}
