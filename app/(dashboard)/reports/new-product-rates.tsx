import { SectionCard } from "@/components/ui-bits";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ReturnRateOverride } from "@/app/(dashboard)/reports/assumptions-form";
import { DELIVERY_RATE_SOURCE_LABEL, wilsonInterval } from "@/lib/constants/delivery-rate";
import type { ProfitAssumptions } from "@/lib/constants/profit";
import { formatNumber, formatVND } from "@/lib/format";
import type { NominalRow } from "@/lib/queries/profit-nominal";

/**
 * ═══════════ BẢNG RIÊNG CHO MÃ CHƯA ĐỦ CĂN CỨ ═══════════
 *
 * Chủ shop yêu cầu 23/09/2026: *"tạo bảng riêng về BCLN cho những mã mới, chưa chắc chắn về tỷ lệ
 * hoàn, để tôi chủ động tự đặt và điều chỉnh"*.
 *
 * Bảng này KHÔNG phải một báo cáo thứ hai và không tính lại gì cả — nó là **PHÉP CHIẾU** lên đúng
 * những dòng của Báo cáo lợi nhuận danh nghĩa mà `rateMature = false` (§19: hàng đợi là phép chiếu,
 * không phải bản sao). Cùng một `NominalRow`, cùng một thang bậc; chỉ khác là ở đây bốn thứ mà bảng
 * chính không có chỗ in được đặt cạnh nhau:
 *
 *   · SỐ ĐO THẬT của chính mã, kèm KHOẢNG TIN CẬY — để thấy ngay 6 đơn nói được ít tới mức nào;
 *   · ĐỘ CHÍN — bao nhiêu đơn đã gửi đã đi tới kết cục, và còn bao nhiêu đơn nữa thì máy tự đo;
 *   · ĐỘ NHẠY — mỗi 10 điểm GTC đổi bao nhiêu tiền doanh thu ước tính của mã;
 *   · Ô ĐẶT TAY, kèm lý do.
 *
 * ─── VÌ SAO KHOẢNG TIN CẬY PHẢI ĐỨNG CẠNH SỐ ĐO ───
 *
 * Đầm Q005 ngày 23/09/2026 giao được 5/6 đơn. In "83,3%" một mình thì nó trông như một kết luận.
 * Khoảng Wilson 95% của nó là **43,6% – 97,0%** — rộng hơn toàn bộ dải tỷ lệ giữa mã tốt nhất và mã
 * xấu nhất của shop. Hai con số đứng cạnh nhau nói đúng một câu: *chưa kết luận được, nhưng đây là
 * thứ đang có*.
 */
export function NewProductRates({
  rows,
  assumptions,
  canWrite,
}: {
  rows: NominalRow[];
  assumptions: ProfitAssumptions;
  canWrite: boolean;
}) {
  /*
    LỌC THEO NGUỒN, KHÔNG THEO ĐỘ CHÍN.

    Bản đầu lọc `!rateMature`. Nhưng một mã có thể ĐÃ CHÍN mà con số của nó vẫn chưa đo được — đo
    23/09/2026: Đầm Q005 vừa chạm 10 đơn kết thúc thì rời bảng này, trong khi 79% tử số của nó vẫn
    đi mượn. Câu hỏi bảng này trả lời là *"con số đang hiện có phải một số đo không"*, và câu trả
    lời ấy nằm ở `returnRateSource`, không nằm ở số đơn.
  */
  const chuaChin = rows
    .filter((r) => r.orders > 0 && (r.returnRateSource === "blended" || r.returnRateSource === "default"))
    .sort((a, b) => b.salesAfterDiscount - a.salesAfterDiscount);
  if (!chuaChin.length) return null;

  const tongDoanhSo = chuaChin.reduce((a, r) => a + r.salesAfterDiscount, 0);

  return (
    <SectionCard
      title="Mã mới · chưa đủ căn cứ để máy tự đo"
      description={`${formatNumber(chuaChin.length)} mã · ${formatVND(tongDoanhSo, { compact: true })} doanh số POS đang được tính bằng một tỷ lệ CHƯA ĐO ĐƯỢC. Đặt tay ở cột cuối; con số tự nhường chỗ cho số đo ngay khi mô hình đo được mã ấy bằng dữ liệu của chính nó.`}
      hint={
        <>
          <p>
            Một mã vào bảng này khi con số của nó CHƯA PHẢI MỘT SỐ ĐO, vì một trong hai lý do. <b>Chưa chín</b>: số đơn đã kết
            thúc của chính mã chưa đạt {formatNumber(assumptions.rateMatureMinFinished)} — cột “Độ chín” đếm ngược.{" "}
            <b>Mô hình còn mượn</b>: mã đủ đơn rồi, nhưng phần lớn tử số dự báo vẫn là xác suất học từ mã khác, vì hợp đồng
            đòi 10 quan sát cho MỖI ô (trạng thái ĐVVC × tuổi kiện) và mã chưa đủ ở ô nào. Vế sau KHÔNG tự hết theo thời
            gian như vế trước.
          </p>
          <p>
            Cả hai trường hợp, tỷ lệ của mã KHÔNG được lấy từ tỷ lệ nền của toàn shop: tỷ lệ nền là bình quân có trọng số
            theo số đơn, nên mã bán chạy nhất và hoàn nhiều nhất quyết định gần hết con số, và mọi mã mới thừa hưởng vấn đề
            của nó.
          </p>
          <p>
            Thay vào đó máy CO NGÓT số đo của chính mã về tỷ lệ khai ở Giả định
            ({(100 - assumptions.defaultReturnRate).toFixed(0)}% GTC): mã chưa có đơn nào kết thúc thì bằng đúng tỷ lệ khai,
            và càng nhiều đơn kết thúc thì càng trôi về số đo thật của chính nó. Đây KHÔNG phải một số đo, nên nó không được
            tô màu và không được xếp hạng.
          </p>
          <p>
            Ô đặt tay ghi vào cùng một chỗ với ghi đè ở Giả định (<code>profit.assumptions.overrides</code>) — một kênh duy
            nhất, không có nguồn sự thật thứ hai. Mặc định nó là TẠM: đủ {formatNumber(assumptions.minFinishedOrders)} đơn kết
            thúc thì máy tự chuyển sang số đo. Tick “giữ cả khi đã chín” là đè lên cả số đo thật, nên nhánh đó cần người thứ
            hai duyệt.
          </p>
        </>
      }
      padded={false}
    >
      <div className="overflow-x-auto">
        <Table className="min-w-[1000px]">
          <TableHeader>
            <TableRow>
              <TableHead>Mã hàng</TableHead>
              <TableHead className="text-right" title="Doanh số POS của mã trong kỳ — số tiền đang phụ thuộc vào tỷ lệ chưa đo được này.">Doanh số POS</TableHead>
              <TableHead className="text-right" title="Số đo THẬT của chính mã: giao thành công ÷ đơn đã kết thúc (ORDER_OUTCOME). Dòng nhỏ là khoảng tin cậy 95% (Wilson) — mẫu càng nhỏ thì khoảng càng rộng.">Số đo của mã</TableHead>
              <TableHead className="text-right" title="Bao nhiêu đơn đã gửi của mã đã đi tới kết cục. Còn thiếu bao nhiêu đơn nữa thì máy tự đo.">Độ chín</TableHead>
              <TableHead className="text-right" title="Tỷ lệ đang được dùng để tính DT GTC ƯT và lợi nhuận của mã. KHÔNG tô màu: đây chưa phải một số đo.">TL GTC đang dùng</TableHead>
              <TableHead className="text-right" title="Mỗi 10 điểm phần trăm GTC đổi bao nhiêu tiền doanh thu GTC ước tính của mã (= Doanh số POS × 10%). Đây là độ lớn của thứ đang chưa chắc chắn.">10 điểm GTC =</TableHead>
              <TableHead>Chủ shop đặt</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {chuaChin.map((r) => {
              const kt = wilsonInterval(
                r.measuredDeliveryRate === null ? 0 : Math.round((r.measuredDeliveryRate / 100) * r.rateOwnFinished),
                r.rateOwnFinished,
              );
              const conThieu = Math.max(0, r.rateMatureAt - r.rateOwnFinished);
              return (
                <TableRow key={r.productId}>
                  <TableCell>
                    <div className="font-medium">{r.productName}</div>
                    <div className="text-[10.5px] text-muted-foreground">
                      {r.code ? `${r.code} · ` : ""}
                      {formatNumber(r.orders)} đơn · giao thật {formatNumber(r.delivered)} · hoàn {formatNumber(r.returned)}
                    </div>
                  </TableCell>
                  <TableCell className="numeric text-right">{formatVND(r.salesAfterDiscount)}</TableCell>
                  <TableCell className="numeric text-right">
                    {/* CHƯA CÓ ĐƠN NÀO KẾT THÚC LÀ "—", không phải 0% (§42). */}
                    <div className="font-semibold">{r.measuredDeliveryRate === null || r.rateOwnFinished === 0 ? "—" : `${r.measuredDeliveryRate.toFixed(1)}%`}</div>
                    <div className="text-[10.5px] text-muted-foreground">
                      {kt === null ? "chưa có đơn kết thúc" : `95%: ${kt.low.toFixed(1)}–${kt.high.toFixed(1)}%`}
                    </div>
                  </TableCell>
                  <TableCell className="numeric text-right">
                    <div>
                      {formatNumber(r.rateOwnFinished)}/{formatNumber(r.rateMatureAt)}
                    </div>
                    {/* ĐỢI THÊM ĐƠN và MÔ HÌNH CHƯA ĐỦ Ô là hai việc phải làm khác nhau — không gộp một câu. */}
                    <div className="text-[10.5px] text-muted-foreground">
                      {r.blendReason === "MOSTLY_BORROWED"
                        ? `đủ đơn · mô hình mượn ${r.borrowedShare === null ? "phần lớn" : `${Math.round(r.borrowedShare * 100)}%`}`
                        : conThieu
                          ? `còn ${formatNumber(conThieu)} đơn nữa`
                          : "đủ ở lượt tính sau"}
                    </div>
                  </TableCell>
                  <TableCell className="numeric text-right">
                    <div className="font-semibold text-muted-foreground">{r.deliveryRate === null ? "—" : `${r.deliveryRate.toFixed(1)}%`}</div>
                    <div className="text-[10.5px] text-muted-foreground">
                      {r.returnRateSource === "override" || r.returnRateSource === "projected" || r.returnRateSource === "blended" || r.returnRateSource === "history" || r.returnRateSource === "default"
                        ? DELIVERY_RATE_SOURCE_LABEL[r.returnRateSource].toLowerCase()
                        : "chưa đo được"}
                    </div>
                  </TableCell>
                  <TableCell className="numeric text-right text-muted-foreground">± {formatVND(Math.round(r.salesAfterDiscount * 0.1), { compact: true })}</TableCell>
                  <TableCell>
                    <ReturnRateOverride
                      productId={r.productId}
                      assumptions={assumptions}
                      current={r.deliveryRate ?? Math.round((100 - r.baseReturnRate) * 10) / 10}
                      source={r.returnRateSource}
                      canWrite={canWrite}
                      mature={r.rateMature}
                    />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </SectionCard>
  );
}
