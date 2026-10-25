import { SOURCING_CAPTURE_FLAG_LABEL, SOURCING_DATA_STATUS_LABEL } from "@/lib/constants/sourcing";
import { formatDateTime } from "@/lib/format";
import type { OfferCaptureView } from "@/lib/queries/sourcing";
import { formatCny, formatHundredths } from "@/lib/sourcing/price";
import { formatKgX10 } from "@/lib/sourcing/size-chart";

const SKU_ROWS_SHOWN = 40;

/**
 * Các lần chụp trang chi tiết 1688 (SRC-6). Lần mới nhất in ĐỦ: cờ (chỗ bộ đọc không kết luận được), giá từng SKU, dropship, bảng
 * size ĐÃ QUY RA KG kèm chữ Trung gốc, số liệu nhà cung cấp. Lần cũ chỉ một dòng — chúng vẫn nguyên trong CSDL (chỉ thêm dòng).
 */
export function CaptureHistory({ captures }: { captures: OfferCaptureView[] }) {
  if (!captures.length) return <p className="text-sm text-muted-foreground">Chưa có lần chụp nào từ trang 1688.</p>;
  const [latest, ...older] = captures;
  const f = latest.facts;
  return (
    <div className="space-y-4 text-sm" data-capture-history>
      <div className="text-xs text-muted-foreground">
        {SOURCING_DATA_STATUS_LABEL[latest.source]} · {formatDateTime(latest.capturedAt)} · {latest.capturedByName ?? "—"} · bộ đọc v{latest.parserVersion}
        {latest.hasSnapshot ? " · đã chụp bậc giá" : " · KHÔNG có bậc giá"}
      </div>
      {latest.flags.length ? (
        <ul className="list-disc space-y-0.5 pl-5 text-amber-800 dark:text-amber-300" data-capture-flags>
          {latest.flags.map((k) => (
            <li key={k}>{SOURCING_CAPTURE_FLAG_LABEL[k]}</li>
          ))}
        </ul>
      ) : null}
      {!f ? (
        <p className="text-amber-700 dark:text-amber-300">Dữ liệu lần chụp này không đọc được bằng bộ đọc hiện tại.</p>
      ) : (
        <>
          {f.skus.length ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-capture-skus>
                <thead className="text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="py-1 pr-3 font-medium">Màu</th>
                    <th className="py-1 pr-3 font-medium">Size</th>
                    <th className="py-1 pr-3 font-medium">Giá trang chi tiết</th>
                    <th className="py-1 font-medium">Dropship</th>
                  </tr>
                </thead>
                <tbody>
                  {f.skus.slice(0, SKU_ROWS_SHOWN).map((s, i) => (
                    <tr key={`${s.color}|${s.size}|${i}`} className="border-t">
                      <td className="py-1 pr-3" lang="zh-CN">{s.color || "—"}</td>
                      <td className="py-1 pr-3" lang="zh-CN">{s.size || "—"}</td>
                      <td className="py-1 pr-3 tabular-nums">{formatCny(s.priceFen)}</td>
                      <td className="py-1 tabular-nums">{formatCny(s.dropshipFen)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {f.skus.length > SKU_ROWS_SHOWN ? <p className="mt-1 text-xs text-muted-foreground">… và {f.skus.length - SKU_ROWS_SHOWN} SKU khác (đủ trong CSDL).</p> : null}
            </div>
          ) : null}
          <div className="grid gap-x-6 gap-y-1 md:grid-cols-2">
            {f.titleTranslated ? <div className="md:col-span-2">Tiêu đề (1688 đã dịch): {f.titleTranslated}</div> : null}
            {f.promoSeen ? (
              <div className="md:col-span-2 text-muted-foreground">
                Trang có giá khuyến mãi{f.promoLabel ? <> «<span lang="zh-CN">{f.promoLabel}</span>»</> : null} — không dùng làm giá mua.
              </div>
            ) : null}
            <div>Giá gạch ngang (tham khảo): {formatCny(f.listPriceFen)}</div>
            <div>Dropship (一件代发): {formatCny(f.dropshipFen)}</div>
            <div>MOQ: {f.moq ?? "—"}</div>
            <div>Khối lượng một cái: {f.weightGrams !== null ? `${f.weightGrams} g` : "—"}</div>
            <div>
              Gửi từ: <span lang="zh-CN">{f.supplier.shipFrom ?? "—"}</span>
            </div>
            <div>
              Cam kết giao: <span lang="zh-CN">{f.supplier.deliveryPromise ?? "—"}</span>
            </div>
            <div>Số năm trên 1688: {f.supplier.yearsOnPlatform ?? "—"}</div>
            <div>Tỷ lệ khách quay lại: {f.supplier.repurchaseRateBp !== null ? `${formatHundredths(f.supplier.repurchaseRateBp)}%` : "—"}</div>
            <div>Lấy hàng trong 24 giờ: {f.supplier.pickup24hBp !== null ? `${formatHundredths(f.supplier.pickup24hBp)}%` : "—"}</div>
            <div>Lấy hàng trong 48 giờ: {f.supplier.pickup48hBp !== null ? `${formatHundredths(f.supplier.pickup48hBp)}%` : "—"}</div>
            {f.supplier.scores.map((s) => (
              <div key={s.label}>
                <span lang="zh-CN">{s.label}</span>: {formatHundredths(s.x100)}
              </div>
            ))}
          </div>
          {latest.sizeChart ? (
            <div className="space-y-1" data-capture-size-chart>
              <div className="font-medium">Bảng size (đọc từ chữ Trung gốc)</div>
              {latest.sizeChart.rows.length ? (
                <ul className="space-y-0.5">
                  {latest.sizeChart.rows.map((r) => (
                    <li key={r.size}>
                      <b>{r.size}</b>: {formatKgX10(r.minKgX10)}
                      {r.maxKgX10 !== r.minKgX10 ? `–${formatKgX10(r.maxKgX10)}` : ""} kg
                      {r.unit === "JIN" ? <span className="text-muted-foreground"> (trang ghi «{r.text}» — 斤 = 0,5 kg)</span> : null}
                    </li>
                  ))}
                </ul>
              ) : null}
              <details>
                <summary className="cursor-pointer text-xs text-muted-foreground">Chữ gốc</summary>
                <pre className="mt-1 whitespace-pre-wrap text-xs" lang="zh-CN">
                  {latest.sizeChart.sourceText}
                </pre>
              </details>
            </div>
          ) : null}
        </>
      )}
      {older.length ? (
        <div className="border-t pt-2">
          <div className="text-xs font-medium text-muted-foreground">Lần chụp trước</div>
          <ul className="space-y-0.5 text-xs">
            {older.map((c) => (
              <li key={c.id}>
                {formatDateTime(c.capturedAt)} · {c.capturedByName ?? "—"} · {c.hasSnapshot ? "có bậc giá" : "không có bậc giá"}
                {c.flags.length ? ` · ${c.flags.length} cờ` : ""}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
