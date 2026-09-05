import { cellKey, colorSwatch } from "@/lib/constants/production";
import { matrixTotals } from "@/lib/queries/production";
import { cn } from "@/lib/utils";

export type SheetData = { code: string; productCode: string; productName: string; colors: string[]; sizes: string[]; cells: Record<string, number>; images: { color: string; url: string }[]; note: string; dueDate: Date | null; supplier: string };

/** Bảng chốt SL hàng cần đặt: cột theo màu (tiêu đề tô màu), hàng theo size, tổng dòng/cột, ảnh mẫu theo màu bên dưới */
export function ProductionSheet({ data, compact = false }: { data: SheetData; compact?: boolean }) {
  const t = matrixTotals(data.colors, data.sizes, data.cells);
  return (
    <div className={cn("space-y-4", compact ? "text-sm" : "text-base")}>
      <table className="w-full border-collapse border border-zinc-300 text-center tabular-nums">
        <thead>
          <tr>
            <th className="border border-zinc-300 bg-zinc-100 px-3 py-2 text-left font-bold text-zinc-900">Bảng chốt SL hàng cần đặt</th>
            {data.colors.map((c) => {
              const sw = colorSwatch(c);
              return <th key={c} className="border border-zinc-300 px-3 py-2 font-bold" style={{ background: sw.bg, color: sw.fg }}>{c}</th>;
            })}
            <th className="border border-zinc-300 bg-rose-100 px-3 py-2 font-bold text-zinc-900">Tổng</th>
          </tr>
        </thead>
        <tbody>
          {data.sizes.map((s) => (
            <tr key={s}>
              <td className="border border-zinc-300 px-3 py-1.5 text-right font-semibold text-zinc-900">{s}</td>
              {data.colors.map((c) => <td key={c} className="border border-zinc-300 px-3 py-1.5 text-zinc-900">{data.cells[cellKey(c, s)] || 0}</td>)}
              <td className="border border-zinc-300 bg-rose-50 px-3 py-1.5 font-semibold text-zinc-900">{t.bySize[s] ?? 0}</td>
            </tr>
          ))}
          <tr>
            <td className="border border-zinc-300 bg-zinc-100 px-3 py-2 text-left font-bold text-zinc-900">Tổng</td>
            {data.colors.map((c) => {
              const sw = colorSwatch(c);
              return <td key={c} className="border border-zinc-300 px-3 py-2 font-bold" style={{ background: sw.bg, color: sw.fg }}>{t.byColor[c] ?? 0}</td>;
            })}
            <td className="border border-zinc-300 bg-rose-100 px-3 py-2 font-bold text-zinc-900">{t.total}</td>
          </tr>
        </tbody>
      </table>
      {data.images.length ? (
        <div className="flex flex-wrap gap-4">
          {data.images.map((img) => (
            <figure key={`${img.color}-${img.url}`} className="w-[220px]">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={img.url} alt={img.color} className="h-[300px] w-full rounded-md border object-cover" />
              <figcaption className="mt-1 text-center text-sm font-semibold text-zinc-800">{img.color}</figcaption>
            </figure>
          ))}
        </div>
      ) : null}
      {(data.note || data.dueDate || data.supplier) ? (
        <div className="space-y-0.5 text-sm text-zinc-800">
          {data.supplier ? <p><b>Xưởng:</b> {data.supplier}</p> : null}
          {data.dueDate ? <p><b>Ngày cần hàng:</b> {new Date(data.dueDate).toLocaleDateString("vi-VN")}</p> : null}
          {data.note ? <p className="whitespace-pre-wrap"><b>Ghi chú:</b> {data.note}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
