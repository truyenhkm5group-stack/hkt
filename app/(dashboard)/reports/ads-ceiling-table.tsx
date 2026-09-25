import { EstimatedCostControl, RateOverridePopover, TargetMarginControl } from "@/app/(dashboard)/reports/estimated-cost-control";
import { DataWarnings } from "@/components/data-warnings";
import { Money, SectionCard } from "@/components/ui-bits";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DELIVERY_RATE_SOURCE_LABEL } from "@/lib/constants/delivery-rate";
import { adsCeiling, type AdsCeiling, type AdsCeilingPoint } from "@/lib/constants/estimated-cost";
import { formatNumber, formatVND } from "@/lib/format";
import type { NominalReport, NominalRow } from "@/lib/queries/profit-nominal";
import { cn } from "@/lib/utils";

/**
 * ═══════════ BÀN DỰ TÍNH: GIÁ VỐN · TỶ LỆ GTC · TRẦN CPQC ═══════════
 *
 * Chủ shop yêu cầu 23/09/2026: đặt giá nhập dự tính cho mã chưa có giá thật, xem lợi nhuận và
 * margin theo giá đó cùng tỷ lệ GTC dự tính, *"từ đó căn % CPQC khi chạy ads sao cho tối ưu"*.
 *
 * Bảng này KHÔNG tính lại gì: mỗi dòng là đúng `NominalRow` của bảng lợi nhuận phía trên (đã mang
 * giá dự tính và tỷ lệ GTC theo thang bậc). Nó chỉ thêm MỘT phép tính thuần — `adsCeiling()` — và
 * đặt hai ô sửa (giá vốn, GTC) cạnh con số chúng làm đổi, để chủ shop thấy ngay tác động.
 *
 * ─── CĂN CỨ ĐỨNG CẠNH MỖI TRẦN ───
 *
 * Trần CPQC đúng tới đâu là do giá vốn và tỷ lệ GTC bên dưới nó quyết định. Nên cột trần in ra hai
 * căn cứ ấy là THẬT hay DỰ TÍNH, và mã còn sản phẩm CHƯA BIẾT giá vốn (đang tính 0 ₫) thì nói thẳng
 * là trần đang CAO HƠN THẬT — đúng hướng nguy hiểm, vì nó cho phép tiêu quá tay. Không tô màu xanh
 * đỏ: đây là phép tính trên giả định, không phải một kết luận đạt/không đạt (AGENTS.md mục 44).
 */

function Pct({ v }: { v: number | null }) {
  if (v === null || !Number.isFinite(v)) return <span className="text-muted-foreground">—</span>;
  return <span className="numeric">{v.toFixed(1)}%</span>;
}

/** Một điểm trần: ≤ 0 là câu trả lời thật — lỗ ngay cả khi không chạy quảng cáo. */
function OTran({ p, khongCho }: { p: AdsCeilingPoint; khongCho: string }) {
  if (p.spend <= 0)
    return (
      <>
        <div className="font-semibold">0</div>
        <div className="text-[10.5px] text-muted-foreground">{khongCho}</div>
      </>
    );
  return (
    <>
      <div className="font-semibold">
        <Pct v={p.overPosSales} /> <span className="text-[10.5px] font-normal text-muted-foreground">DS</span>
      </div>
      <div className="text-[10.5px] text-muted-foreground">
        ≤ {p.perOrder === null ? "—" : formatVND(p.perOrder, { compact: true })}/đơn · {formatVND(p.spend, { compact: true })}
      </div>
    </>
  );
}

/** Khoảng cách từ CPQC hiện tại tới trần hoà vốn, theo điểm % doanh số POS. Chữ, không tô màu (mục 44). */
function ConCho({ diem }: { diem: number | null }) {
  if (diem === null) return null;
  return (
    <div className="text-[10.5px] font-normal text-muted-foreground">
      {diem >= 0 ? `còn tăng được ${diem.toFixed(1)} điểm` : `ĐANG VƯỢT ${Math.abs(diem).toFixed(1)} điểm`}
    </div>
  );
}

function giaVonMoiSp(r: NominalRow): number | null {
  // Toàn bộ giá vốn là DỰ TÍNH ⇒ in đúng con số người đặt. Chia cho `expectedQty` (đã làm tròn) ra
  // 250.479 ₫ cho một giá đặt 250.000 ₫ — một con số không ai gõ, trông như có nguồn khác.
  if (r.estimatedCost && r.expectedCogsEstimated === r.expectedCogs) return r.estimatedCost.unitCost;
  return r.expectedQty > 0 && r.cogsKnown ? Math.round(r.expectedCogs / r.expectedQty) : null;
}

function canCu(r: NominalRow): string {
  const gv = r.cogsUncoveredQty > 0 ? "giá vốn CHƯA BIẾT" : r.expectedCogsEstimated > 0 ? "giá vốn dự tính" : "giá vốn thật";
  const gtc = r.returnRateSource === "projected" || r.returnRateSource === "history" ? "GTC đo được" : r.returnRateSource === "override" ? "GTC đặt tay" : r.returnRateSource === "unmeasured" ? "GTC chưa đo được" : "GTC mục tiêu";
  return `${gv} · ${gtc}`;
}

export function AdsCeilingTable({
  report,
  canWrite,
  targetMargin,
}: {
  report: NominalReport;
  canWrite: boolean;
  targetMargin: number | null;
}) {
  const o = report.assumptions.otherCostPercentOfAds ?? 0;
  const tinh = (r: { netProfit: number; adSpend: number; otherCost: number; expectedRevenue: number; salesAfterDiscount: number }, orders: number): AdsCeiling =>
    adsCeiling({ netProfit: r.netProfit, adSpend: r.adSpend, otherCost: r.otherCost, expectedRevenue: r.expectedRevenue, posSales: r.salesAfterDiscount, orders, otherCostPercentOfAds: o, targetMarginPct: targetMargin });

  // Mã cần chủ shop gõ giá (còn sản phẩm chưa có giá thật) đứng đầu; trong mỗi nhóm xếp theo doanh số.
  const rows = report.rows
    .filter((r) => r.orders > 0)
    .sort((a, b) => Number(b.cogsUnknownQty > 0) - Number(a.cogsUnknownQty > 0) || b.salesAfterDiscount - a.salesAfterDiscount);
  if (!rows.length) return null;
  const t = report.totals;
  const chuaGia = rows.filter((r) => r.cogsUncoveredQty > 0).length;
  const tong = tinh(t, t.ordersDistinct);

  return (
    <SectionCard
      title="Bàn dự tính · giá vốn · tỷ lệ GTC · trần CPQC"
      description={
        <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-1">
          {`${formatNumber(rows.length)} mã có đơn${t.estimatedCostProducts ? ` · ${formatNumber(t.estimatedCostProducts)} mã dùng giá dự tính (${formatVND(t.expectedCogsEstimated, { compact: true })} giá vốn)` : ""}`}
          <DataWarnings items={chuaGia ? [`${formatNumber(chuaGia)} mã còn sản phẩm CHƯA BIẾT giá vốn (đang tính 0 ₫ — lợi nhuận và trần CPQC của chúng đang cao hơn thật)`] : []} />
        </span>
      }
      hint={
        <>
          <p className="mb-2">
            Trần CPQC = mức quảng cáo tối đa để mã còn hoà vốn / còn giữ được biên bạn gõ.
            {chuaGia ? "" : " Mọi mã đều đã có giá vốn thật hoặc dự tính."}
          </p>
          <p>
            <b>Trần CPQC</b> = (LN danh nghĩa + CPQC + CP khác) ÷ (1 + {o}% CP khác theo QC) — tức toàn bộ số tiền mã làm ra sau giá
            vốn, vận chuyển, vận hành, rủi ro tồn kho, thuế, trước khi trả quảng cáo. Có biên mục tiêu m% thì trừ thêm m% × DT GTC ước
            tính. Quy ra hai đơn vị: <b>% doanh số POS</b> (cùng mẫu số với cột CPQC “DS” ở bảng trên — so thẳng được) và{" "}
            <b>CPQC tối đa mỗi đơn chốt</b> (so với chi phí mỗi kết quả trên Trình quản lý quảng cáo).
          </p>
          <p className="mt-2">
            Đây là phép tính TẠI ĐIỂM HIỆN TẠI: giữ nguyên tỷ lệ GTC, giá bán bình quân và phần vận hành đã phân bổ. Chạy mạnh hơn thì
            vận hành cố định chia cho nhiều đơn hơn nên trần thật nhích lên chút ít — con số nghiêng về phía thận trọng.
          </p>
          <p className="mt-2">
            <b>Giá vốn dự tính</b> chỉ lấp sản phẩm KHÔNG có phiếu nhập / giá Pancake, và tự đứng sang một bên khi mã có giá thật. Chỉ
            tab này dùng nó: bảng lương, báo cáo marketer ở trang Quảng cáo, dòng tiền thực và sổ kho vẫn coi sản phẩm đó là chưa biết
            giá vốn. <b>Đặt GTC</b> dùng đúng ô ghi đè của bảng “Mã mới” — một kênh, không có bản thứ hai.
          </p>
        </>
      }
      actions={<TargetMarginControl value={targetMargin} />}
      padded={false}
    >
      <div className="overflow-x-auto">
        <Table className="min-w-[1000px]">
          <TableHeader>
            <TableRow>
              <TableHead>Mã hàng</TableHead>
              <TableHead className="text-right" title="Giá vốn bình quân mỗi sản phẩm giao thành công ước tính. Nhãn nói nó là giá THẬT (phiếu nhập / Pancake), DỰ TÍNH (chủ shop đặt), hay CHƯA BIẾT (đang tính 0 ₫).">Giá vốn/sp</TableHead>
              <TableHead className="text-right" title="Tỷ lệ giao thành công ước tính đang dùng cho mã, và nguồn của nó.">TL GTC</TableHead>
              <TableHead className="text-right" title="DT GTC ước tính. Dòng nhỏ: doanh số POS — mẫu số của mọi tỷ lệ % DS trong bảng này.">DT GTC ƯT</TableHead>
              <TableHead className="text-right" title="Lợi nhuận danh nghĩa (đúng con số bảng trên). Dòng nhỏ: margin trên DT GTC ước tính.">LN danh nghĩa</TableHead>
              <TableHead className="text-right" title="CPQC đã quy kết về mã trong kỳ. Dòng nhỏ: % doanh số POS và CPQC mỗi đơn chốt.">CPQC hiện tại</TableHead>
              <TableHead className="text-right" title="Mức CPQC tối đa để LN danh nghĩa của mã = 0. Dòng nhỏ: tối đa mỗi đơn chốt · số tiền cả kỳ, rồi khoảng cách từ CPQC hiện tại tới trần (dương = còn tăng được, âm = đang vượt — mỗi đồng thêm là lỗ thêm). Rê chuột để xem trần đứng trên giá vốn / tỷ lệ GTC thật hay dự tính. Khác “CPO hoà vốn · LN góp” ở bảng quyết định /ads: CÙNG một hàm (lib/constants/break-even-cpo.ts), nhưng tử số ở đây đã trừ vận hành, cố định, thuế, rủi ro tồn kho nên luôn chặt hơn.">Trần hoà vốn</TableHead>
              <TableHead className="text-right" title="Mức CPQC tối đa để còn giữ được biên LN bạn gõ ở góc trên (trên DT GTC ước tính). Chưa gõ biên thì cột này trống.">
                Trần giữ biên {targetMargin === null ? "…" : `${targetMargin}%`}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => {
              const c = tinh(r, r.orders);
              const gv = giaVonMoiSp(r);
              // Ô đặt giá dự tính hiện khi mã có hàng BÁN RA chưa biết giá vốn, HOẶC phiếu nhập trong kỳ thiếu
              // đơn giá — giá dự tính định giá cả phần đó ở bảng "LN theo hàng nhập" (chủ shop chốt 25/09/2026).
              const coCho = r.cogsUnknownQty > 0 || r.purchaseUnpricedQty > 0;
              return (
                <TableRow key={r.productId} className={cn(r.cogsUncoveredQty > 0 && "bg-amber-50/60 dark:bg-amber-950/20")}>
                  <TableCell className="max-w-[230px] whitespace-normal align-top">
                    <div className="font-medium">{r.productName}</div>
                    <div className="text-[10.5px] text-muted-foreground">
                      {r.code ? `${r.code} · ` : ""}
                      {formatNumber(r.orders)} đơn · giao {formatNumber(r.delivered)} · hoàn {formatNumber(r.returned)} · đang {formatNumber(r.inTransit)}
                    </div>
                  </TableCell>
                  <TableCell className="text-right align-top">
                    <div className="numeric flex items-center justify-end gap-0.5 font-semibold">
                      {r.cogsUncoveredQty > 0 ? <span className="text-amber-700 dark:text-amber-300">chưa biết</span> : gv === null ? "—" : formatVND(gv)}
                      {coCho && r.estimatedCost ? <EstimatedCostControl productId={r.productId} current={r.estimatedCost} canWrite={canWrite} /> : null}
                    </div>
                    <div className="text-[10.5px] text-muted-foreground">
                      {r.cogsUncoveredQty > 0
                        ? `${formatNumber(r.cogsUncoveredQty)} sp đang tính 0 ₫`
                        : r.estimatedCost
                          ? r.expectedCogsEstimated === r.expectedCogs
                            ? `dự tính ${formatVND(r.estimatedCost.unitCost, { compact: true })}/sp`
                            : `gồm ${formatNumber(r.cogsUnknownQty)} sp dự tính ${formatVND(r.estimatedCost.unitCost, { compact: true })}`
                          : "giá nhập thật"}
                    </div>
                    {coCho && !r.estimatedCost ? (
                      <div className="mt-1 flex justify-end">
                        <EstimatedCostControl productId={r.productId} current={r.estimatedCost} canWrite={canWrite} />
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-right align-top">
                    <div className="numeric flex items-center justify-end gap-0.5 font-semibold">
                      {r.deliveryRate === null ? "—" : `${r.deliveryRate.toFixed(1)}%`}
                      <RateOverridePopover
                        productId={r.productId}
                        assumptions={report.assumptions}
                        current={r.deliveryRate ?? Math.round((100 - r.baseReturnRate) * 10) / 10}
                        source={r.returnRateSource}
                        canWrite={canWrite}
                        mature={r.rateMature}
                      />
                    </div>
                    <div className="text-[10.5px] text-muted-foreground">{r.returnRateSource === "unmeasured" ? "chưa đo được" : DELIVERY_RATE_SOURCE_LABEL[r.returnRateSource].toLowerCase()}</div>
                  </TableCell>
                  <TableCell className="text-right align-top">
                    <Money value={r.expectedRevenue} />
                    <div className="text-[10.5px] text-muted-foreground">DS {formatVND(r.salesAfterDiscount, { compact: true })}</div>
                  </TableCell>
                  <TableCell className="text-right align-top">
                    <Money value={r.netProfit} className="font-semibold" />
                    <div className="text-[10.5px] text-muted-foreground">
                      <Pct v={r.netMargin} />
                    </div>
                  </TableCell>
                  <TableCell className="text-right align-top">
                    <Money value={r.adSpend} />
                    <div className="text-[10.5px] text-muted-foreground">
                      <Pct v={r.ads.overPosSales} /> DS{r.cpo === null ? "" : ` · ${formatVND(Math.round(r.cpo), { compact: true })}/đơn`}
                    </div>
                  </TableCell>
                  <TableCell className="text-right align-top" title={`Căn cứ: ${canCu(r)}`}>
                    <OTran p={c.breakEven} khongCho="lỗ cả khi không chạy QC" />
                    {r.cogsUncoveredQty > 0 ? (
                      <div className="text-[10.5px] font-medium text-amber-700 dark:text-amber-300">CAO HƠN THẬT — thiếu giá vốn</div>
                    ) : (
                      <ConCho diem={c.headroomPoints} />
                    )}
                  </TableCell>
                  <TableCell className="text-right align-top">
                    {c.target ? <OTran p={c.target} khongCho={`dưới ${targetMargin}% cả khi không QC`} /> : <span className="text-muted-foreground">—</span>}
                  </TableCell>
                </TableRow>
              );
            })}
            <TableRow className="bg-muted/40 font-bold hover:bg-muted/40">
              <TableCell className="max-w-[230px] whitespace-normal align-top">
                Toàn shop
                <div className="text-[10.5px] font-normal text-muted-foreground">
                  gồm cả QC chưa quy kết{report.unmatchedAdSpend ? ` (${formatVND(report.unmatchedAdSpend, { compact: true })})` : ""} · {formatNumber(t.ordersDistinct)} đơn đếm một lần
                </div>
              </TableCell>
              <TableCell className="text-right align-top text-[10.5px] font-normal text-muted-foreground">{t.cogsUncoveredQty ? `${formatNumber(t.cogsUncoveredQty)} sp chưa biết giá` : ""}</TableCell>
              <TableCell className="text-right align-top">
                <Pct v={t.weightedDeliveryRate} />
              </TableCell>
              <TableCell className="text-right align-top">
                <Money value={t.expectedRevenue} />
                <div className="text-[10.5px] font-normal text-muted-foreground">DS {formatVND(t.salesAfterDiscount, { compact: true })}</div>
              </TableCell>
              <TableCell className="text-right align-top">
                <Money value={t.netProfit} />
                <div className="text-[10.5px] font-normal text-muted-foreground">
                  <Pct v={t.netMargin} />
                </div>
              </TableCell>
              <TableCell className="text-right align-top">
                <Money value={t.adSpend} />
                <div className="text-[10.5px] font-normal text-muted-foreground">
                  <Pct v={t.ads.overPosSales} /> DS
                </div>
              </TableCell>
              <TableCell className="text-right align-top">
                <OTran p={tong.breakEven} khongCho="lỗ cả khi không chạy QC" />
                <ConCho diem={tong.headroomPoints} />
              </TableCell>
              <TableCell className="text-right align-top">{tong.target ? <OTran p={tong.target} khongCho={`dưới ${targetMargin}% cả khi không QC`} /> : <span className="text-muted-foreground">—</span>}</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>
    </SectionCard>
  );
}
