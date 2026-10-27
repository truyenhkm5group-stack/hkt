import { notFound } from "next/navigation";
import { PrintButton } from "@/app/print/production/[id]/print-button";
import { requirePermission } from "@/lib/auth/session";
import { formatDate, formatNumber, formatVND } from "@/lib/format";
import { getQuotation } from "@/lib/queries/wholesale-quotations";
import type { SearchParams } from "@/lib/search-params";
import { QUOTATION_STATUS_LABEL } from "@/lib/wholesale/quotation-engine";

export const dynamic = "force-dynamic";
export const metadata = { title: "Báo giá" };

/**
 * BẢN IN GỬI KHÁCH — CHỈ đọc từ ẢNH CHỤP lúc lập phiên bản (`snapshot`): bảng giá đổi sau đó không làm đổi một con số nào trên
 * giấy (giống kỳ đã chốt, luật 21). Không in giá vốn / biên lợi nhuận / cảnh báo nội bộ. Ship / thuế chưa khai ⇒ ghi rõ «chưa
 * gồm», không in 0. PDF để bước sau — trình duyệt «In / Lưu PDF» đủ dùng.
 */
export default async function PrintQuotationPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<SearchParams> }) {
  const user = await requirePermission("wholesale:view");
  const { id } = await params;
  const raw = await searchParams;
  const data = await getQuotation(user, id);
  if (!data || "unavailable" in data) notFound();
  const s = data.snapshot;
  const t = s.result.totals;
  // Chính thức = không còn chặn VÀ (đã duyệt / đã gửi / khách chấp nhận / nháp KHÔNG cần duyệt). Còn lại in kèm dấu trạng thái.
  const official = data.row.blockerCount === 0 && (data.status === "APPROVED" || data.status === "SENT" || data.status === "ACCEPTED" || (data.status === "DRAFT" && !data.row.requiresApproval));
  return (
    <main className="mx-auto max-w-[900px] bg-white p-6 text-zinc-900 print:p-0">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-zinc-600">{s.seller.organization}</div>
          <h1 className="text-2xl font-bold">BÁO GIÁ {data.row.code}</h1>
          <p className="text-sm text-zinc-600">
            Phiên bản {data.row.version} · ngày {formatDate(s.computedAt)} · hiệu lực đến hết {formatDate(s.input.validUntil)}
          </p>
          {official ? null : <p className="mt-1 text-xs font-semibold uppercase text-rose-700">{QUOTATION_STATUS_LABEL[data.status]}{data.row.blockerCount ? " · còn chặn" : ""} — chưa phải báo giá chính thức</p>}
        </div>
        <PrintButton auto={raw.auto === "1"} />
      </div>

      <section className="mb-4 text-sm">
        <div className="font-semibold">Kính gửi: {s.party.name || "—"}</div>
        {s.party.phone ? <div>Điện thoại: {s.party.phone}</div> : null}
        {s.party.address ? <div>Địa chỉ: {s.party.address}</div> : null}
      </section>

      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b-2 border-zinc-800 text-left">
            <th className="py-1.5">#</th>
            <th className="py-1.5">Sản phẩm</th>
            <th className="py-1.5 text-right">Số lượng</th>
            <th className="py-1.5 text-right">Đơn giá</th>
            <th className="py-1.5 text-right">Chiết khấu</th>
            <th className="py-1.5 text-right">Thành tiền</th>
          </tr>
        </thead>
        <tbody>
          {s.result.lines.map((l) => (
            <tr key={l.lineNo} className="border-b border-zinc-200 align-top">
              <td className="py-1.5">{l.lineNo}</td>
              <td className="py-1.5">
                {l.name || l.variantId}
                {l.sku ? <span className="text-xs text-zinc-500"> · {l.sku}</span> : null}
              </td>
              <td className="py-1.5 text-right tabular-nums">{formatNumber(l.quantity)}</td>
              <td className="py-1.5 text-right tabular-nums">{formatVND(l.unitPrice)}</td>
              <td className="py-1.5 text-right tabular-nums">{l.lineDiscount ? formatVND(l.lineDiscount) : ""}</td>
              <td className="py-1.5 text-right tabular-nums">{formatVND(l.lineTotal)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <dl className="ml-auto mt-3 grid max-w-xs grid-cols-2 gap-y-1 text-sm tabular-nums">
        <dt>Tiền hàng</dt>
        <dd className="text-right">{formatVND(t.subtotal)}</dd>
        {t.discount ? (
          <>
            <dt>Chiết khấu</dt>
            <dd className="text-right">−{formatVND(t.discount)}</dd>
          </>
        ) : null}
        <dt>Vận chuyển</dt>
        <dd className="text-right">{t.shipping === null ? "chưa gồm" : formatVND(t.shipping)}</dd>
        <dt>Thuế{s.result.taxRatePercent !== null ? ` (${s.result.taxRatePercent.toLocaleString("vi-VN")}%)` : ""}</dt>
        <dd className="text-right">{t.tax === null ? "chưa gồm" : formatVND(t.tax)}</dd>
        <dt className="border-t border-zinc-800 pt-1 font-bold">Tổng cộng</dt>
        <dd className="border-t border-zinc-800 pt-1 text-right font-bold">{formatVND(t.total)}</dd>
      </dl>

      <section className="mt-6 space-y-1 text-xs text-zinc-600">
        <p>Đơn vị tiền: VND.{t.shipping === null ? " Giá chưa gồm phí vận chuyển." : ""}{t.tax === null ? " Giá chưa gồm thuế." : ""}</p>
        {s.input.incoterm ? <p>Điều kiện giao hàng: {s.input.incoterm} (Incoterms® 2020).</p> : null}
        <p>Tồn kho xác nhận lại khi chốt đơn.</p>
        {s.input.notes ? <p className="whitespace-pre-line text-zinc-800">{s.input.notes}</p> : null}
        <p>Người lập: {s.seller.preparedBy}</p>
      </section>
    </main>
  );
}
