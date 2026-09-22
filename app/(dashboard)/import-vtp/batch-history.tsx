import { NavLink } from "@/components/nav-progress";
import { TableToolsFor } from "@/components/data-table/table-tools";
import { listVtpImportBatches } from "@/lib/queries/vtp-import-batches";
import { formatNumber, formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * ═══════════ "CON SỐ NÀY TỚI TỪ LẦN NHẬP NÀO" ═══════════
 *
 * Sổ lần nhập đã ghi từ bản trước nhưng chưa màn hình nào đọc nó — và một cuốn sổ không ai mở được
 * thì tương đương không có sổ.
 *
 * CHẠY THỬ hiện CÙNG bảng với lần ghi thật, nhãn riêng. Cố ý: nó trả lời "hôm qua ai đã xem trước
 * tệp này và thấy gì" khi con số sau đó gây tranh cãi, nhưng người đọc phải phân biệt được NGAY
 * lượt nào đã đổi dữ liệu và lượt nào không.
 */
export async function BatchHistory() {
  const rows = await listVtpImportBatches(25);
  if (!rows.length) return <p className="text-sm text-muted-foreground">Chưa có lần nhập tệp nào.</p>;

  return (
    <>
      <TableToolsFor tableId="import-vtp-batch-history" />
      <div className="overflow-x-auto rounded-md border">
        <table id="import-vtp-batch-history" className="w-full text-[12.5px]">
          <thead className="bg-muted/50 text-left text-muted-foreground">
            <tr>
              <th className="p-2 font-medium">Lúc</th>
              <th className="p-2 font-medium">Tệp</th>
              <th className="p-2 font-medium">Lượt</th>
              <th className="p-2 text-right font-medium">Dòng</th>
              <th className="p-2 text-right font-medium">Đã ghi</th>
              <th className="p-2 font-medium">Đo chất lượng webhook</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((b) => (
              <tr key={b.id} className={cn("border-t", b.mode === "PREVIEW" && "opacity-70")}>
                <td className="numeric p-2 whitespace-nowrap">
                  <NavLink href={`/import-vtp/${b.id}`} className="hover:underline">
                    {formatDateTime(b.createdAt)}
                  </NavLink>
                  <span className="block text-[11px] text-muted-foreground">{b.uploadedBy || "—"}</span>
                </td>
                <td className="max-w-[260px] truncate p-2" title={b.filename}>
                  {b.filename}
                </td>
                <td className="p-2">
                  <span className={cn("rounded px-1.5 py-0.5 text-[11px] font-medium", b.mode === "APPLY" ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300" : "bg-muted text-muted-foreground")}>
                    {b.mode === "APPLY" ? "đã ghi" : "chạy thử"}
                  </span>
                </td>
                <td className="numeric p-2 text-right">{formatNumber(b.rows)}</td>
                <td className="numeric p-2 text-right">{b.mode === "APPLY" ? formatNumber(b.applied) : "—"}</td>
                <td className="p-2 text-[11.5px] text-muted-foreground">
                  {/*
                    Ba con số này là lý do một lần nhập vẫn đáng chạy kể cả khi nó không đổi một vận
                    đơn nào. Lần nhập CŨ (trước khi phép đo tồn tại) giữ 0 — và phải nói ra là chưa
                    đo, không được đọc thành "không có khoảng hụt nào".
                  */}
                  {b.checked ? (
                    <>
                      đối chiếu {formatNumber(b.checked)} dòng · ERP biết trước {formatNumber(b.webhookOk)}
                      {b.webhookGaps ? <span className="ml-1 font-medium text-amber-700 dark:text-amber-400">· {formatNumber(b.webhookGaps)} khoảng hụt</span> : " · không khoảng hụt nào"}
                    </>
                  ) : (
                    <span>chưa đo</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
