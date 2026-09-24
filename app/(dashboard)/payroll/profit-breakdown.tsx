import Link from "next/link";
import { TableToolsFor } from "@/components/data-table/table-tools";
import { ExternalLink } from "lucide-react";
import { DataWarnings } from "@/components/data-warnings";
import { InfoHint } from "@/components/info-hint";
import { Money, SectionCard } from "@/components/ui-bits";
import { COMPENSATION_PROFIT_LABEL, COMPENSATION_PROFIT_RULES } from "@/lib/constants/compensation-profit";
import { MISSING_TEXT, formatNumber, formatVND } from "@/lib/format";
import type { MarketerProfit } from "@/lib/queries/payroll";
import type { PayrollCarryLine } from "@/lib/queries/payroll";
import { cn } from "@/lib/utils";

/**
 * ═══ BÓC TÁCH LỢI NHUẬN TÍNH LƯƠNG CỦA MỘT NGƯỜI, TỪNG DÒNG MỘT ═══
 *
 * Yêu cầu: admin phải nhìn được doanh thu → giá vốn → quảng cáo → cước → phân bổ → lợi nhuận kỳ,
 * rồi bù lỗ → cơ sở → tỷ lệ → hoa hồng. Và mỗi dòng phải bấm được về chứng từ gốc **nếu ERP có
 * nguồn tương ứng** — chỗ nào chưa có thì nói thẳng là chưa có, không vẽ một cái link chết.
 *
 * ─── VÌ SAO CÓ DÒNG "KIỂM TRA" Ở CUỐI ───
 *
 * Bảng này cộng lại từ các con số ĐÃ tính, nên nó có thể lệch với `personalProfit` nếu một ngày ai
 * đó thêm một khoản vào phép tính mà quên thêm dòng ở đây. Lệch ấy không được im: một bảng bóc
 * tách cộng không ra đúng con số nó đang giải thích là một bảng làm người đọc tin nhầm.
 */
type Row = {
  label: string;
  value: number | null;
  /** `-1` = khoản trừ (in đỏ, có dấu trừ) · `1` = khoản cộng. */
  sign: 1 | -1;
  why: string;
  href?: string | null;
  missingSource?: string;
};

export function ProfitBreakdown({
  marketer,
  carry,
  commissionPercent,
  commission,
  periodQs,
}: {
  marketer: MarketerProfit;
  carry: PayrollCarryLine | null;
  commissionPercent: number;
  commission: number | null;
  periodQs: string;
}) {
  const rows: Row[] = [
    {
      label: "Doanh thu giao thành công quy kết",
      value: marketer.attributedRevenue,
      sign: 1,
      why: "Chỉ đơn có kết quả DELIVERED theo ORDER_OUTCOME — tiền thật đã về, không phải đơn đã chốt.",
      href: `/orders?${periodQs}&outcome=DELIVERED`,
    },
    {
      label: "Giá vốn hàng đã giao",
      value: marketer.cogsCharged,
      sign: -1,
      why: COMPENSATION_PROFIT_RULES.COGS.why,
      href: `/inventory?${periodQs}`,
    },
    {
      label: "Quảng cáo của chính người này",
      value: marketer.adSpend,
      sign: -1,
      why: COMPENSATION_PROFIT_RULES.ADS.why,
      href: `/ads?${periodQs}&marketer=${marketer.marketerId ?? ""}`,
    },
    {
      label: "Quảng cáo thử (chưa thuộc mã nào)",
      value: marketer.testSpend,
      sign: -1,
      why: "Tiền quảng cáo chưa ghép được vào mã hàng nào. Vẫn là tiền thật đã chi, nên nó trừ vào người chạy chứ không biến mất.",
      href: `/ads?${periodQs}`,
    },
    {
      label: "Cước vận chuyển và phí hoàn",
      value: marketer.shippingCharged,
      sign: -1,
      why: COMPENSATION_PROFIT_RULES.SHIPPING.why,
      href: `/shipments?${periodQs}`,
    },
    {
      label: "Chi phí cố định và vận hành phân bổ",
      value: marketer.operatingCharged,
      sign: -1,
      why: "Chia theo tỷ trọng doanh thu giao thành công của từng mã (largest remainder, nên Σ các mã = đúng tổng chi phí, không lệch vì làm tròn).",
      href: `/expenses?${periodQs}`,
    },
    {
      label: "Chia % với chủ mã",
      value: marketer.ownerBonusPaid - marketer.ownerBonusReceived,
      sign: -1,
      why: "Người đẩy chéo trích một phần lợi nhuận cho chủ mã; chủ mã nhận phần ấy. Số âm ở đây nghĩa là NHẬN nhiều hơn trả.",
      missingSource: "",
    },
  ];

  const tongTru = rows.filter((r) => r.sign === -1).reduce((t, r) => t + (r.value ?? 0), 0);
  const congLai = marketer.attributedRevenue - tongTru;
  /** Lệch giữa bảng bóc tách và con số máy đã tính. Phải bằng 0 — nếu không thì nói ra. */
  const lech = congLai - marketer.personalProfit;

  return (
    <SectionCard
      title={`Bóc tách ${COMPENSATION_PROFIT_LABEL.toLowerCase()} — ${marketer.name}`}
      hint="Mỗi dòng bấm được về chứng từ gốc. Hoa hồng KHÔNG nằm trong cơ sở này — nó được tính TỪ cơ sở, rồi trừ ở bước sau để ra lợi nhuận kế toán."
      actions={
        lech !== 0 ? (
          <DataWarnings
            tone="danger"
            align="end"
            items={[
              <>
                Bảng bóc tách cộng ra {formatVND(congLai)} nhưng máy tính ra {formatVND(marketer.personalProfit)} — lệch {formatVND(lech)}. Một khoản đã vào phép tính mà chưa có dòng ở đây; đừng tin bảng này
                cho tới khi lệch về 0.
              </>,
            ]}
          />
        ) : null
      }
    >
      <TableToolsFor tableId="payroll-profit-breakdown-1" />
      <div className="overflow-x-auto">
        <table id="payroll-profit-breakdown-1" className="w-full min-w-[720px] text-[13px]">
          <tbody>
            {rows.map((r) => (
              <tr key={r.label} className="border-b align-top last:border-b-0">
                <td className="py-1.5 pr-3">
                  <span className="inline-flex items-center gap-1 font-medium">
                    {r.label}
                    <InfoHint>{r.why}</InfoHint>
                  </span>
                </td>
                <td className="w-40 py-1.5 pr-3 text-right tabular-nums">
                  <span className={cn(r.sign === -1 && (r.value ?? 0) !== 0 ? "text-rose-700 dark:text-rose-400" : "")}>
                    {r.value === null ? MISSING_TEXT : `${r.sign === -1 && r.value !== 0 ? "−" : ""}${formatVND(Math.abs(r.value))}`}
                  </span>
                </td>
                <td className="w-24 py-1.5 text-right">
                  {r.href ? (
                    <Link href={r.href} className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground hover:underline">
                      Chứng từ <ExternalLink className="size-3" />
                    </Link>
                  ) : (
                    <span className="text-[11px] text-muted-foreground">tính trong bảng lương</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 font-semibold">
              <td className="py-2 pr-3">{COMPENSATION_PROFIT_LABEL} của kỳ</td>
              <td className="py-2 pr-3 text-right tabular-nums">
                <Money value={marketer.personalProfit} />
              </td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>

      {/* ═══ BƯỚC HAI: BÙ LỖ, RỒI MỚI TỚI TIỀN ═══ */}
      {carry ? (
        <>
          <TableToolsFor tableId="payroll-profit-breakdown-2" />
          <div className="mt-4 overflow-x-auto rounded-lg border bg-muted/30 p-3">
            <p className="mb-2 flex items-center gap-1 text-[12px] font-medium">
              Bù lỗ lũy kế · tháng {carry.monthKey}
              <InfoHint>
                {carry.commissionBase === 0
                  ? "Số dư sau bù vẫn âm nên hoa hồng bằng 0, và phần âm còn lại chuyển sang kỳ sau — con số âm KHÔNG bị xoá."
                  : "Đã bù hết lỗ cũ; hoa hồng chỉ tính trên phần lợi nhuận CÒN LẠI sau khi bù."}{" "}
                Căn cứ số dư đầu kỳ: {carry.openingReason}
              </InfoHint>
            </p>
            <table id="payroll-profit-breakdown-2" className="w-full min-w-[520px] text-[13px]">
              <tbody>
                <tr className="border-b">
                  <td className="py-1.5 pr-3">Lỗ mang sang từ kỳ trước</td>
                  <td className="py-1.5 text-right tabular-nums">
                    <Money value={carry.openingBalance} />
                  </td>
                </tr>
                <tr className="border-b">
                  <td className="py-1.5 pr-3">{COMPENSATION_PROFIT_LABEL} của kỳ</td>
                  <td className="py-1.5 text-right tabular-nums">
                    <Money value={carry.realProfit} />
                  </td>
                </tr>
                <tr className="border-b">
                  <td className="py-1.5 pr-3">Phần lỗ cũ được bù trong kỳ</td>
                  <td className="py-1.5 text-right tabular-nums">
                    <Money value={carry.lossApplied} />
                  </td>
                </tr>
                <tr className="border-b font-medium">
                  <td className="py-1.5 pr-3">Cơ sở tính hoa hồng sau bù lỗ</td>
                  <td className="py-1.5 text-right tabular-nums">
                    <Money value={carry.commissionBase} />
                  </td>
                </tr>
                <tr className="border-b">
                  <td className="py-1.5 pr-3">Tỷ lệ hoa hồng</td>
                  <td className="py-1.5 text-right tabular-nums">{formatNumber(commissionPercent)}%</td>
                </tr>
                <tr className="border-b font-semibold">
                  <td className="py-1.5 pr-3">Hoa hồng phải trả</td>
                  <td className="py-1.5 text-right tabular-nums">
                    <Money value={commission} />
                  </td>
                </tr>
                <tr>
                  <td className="py-1.5 pr-3">Lỗ chuyển sang kỳ sau</td>
                  <td className="py-1.5 text-right tabular-nums">
                    <Money value={carry.closingBalance} />
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <p className="mt-3 flex items-center gap-1 text-[12px] text-muted-foreground">
          Bù lỗ lũy kế: không áp dụng
          <InfoHint>
            Sổ bù lỗ lũy kế KHÔNG áp dụng cho kỳ này (chưa bật, kỳ không phải một tháng lịch, hoặc tháng nằm trước mốc mở sổ). Đây là “không áp dụng”, khác hẳn “số dư bằng 0”.
          </InfoHint>
        </p>
      )}
    </SectionCard>
  );
}
