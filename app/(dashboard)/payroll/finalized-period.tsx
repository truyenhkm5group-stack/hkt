import { Lock } from "lucide-react";
import { DataWarnings } from "@/components/data-warnings";
import { InfoHint } from "@/components/info-hint";
import { Money, SectionCard } from "@/components/ui-bits";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PAYROLL_BASIS_SHORT, PAYROLL_CALC_VERSION, type PayrollBasis } from "@/lib/constants/payroll";
import { formatDateTime, formatNumber, formatVND } from "@/lib/format";
import type { PayrollDrift, PayrollPeriodState } from "@/lib/queries/payroll-period";

/** CHƯA BIẾT in ra "—", không in ra 0 (AGENTS.md mục 42). */
function MoneyOrUnknown({ value, className }: { value: number | null; className?: string }) {
  if (value === null) return <span className="text-xs text-muted-foreground">—</span>;
  return <Money value={value} className={className} />;
}

/**
 * ═══════════ BẢNG LƯƠNG CỦA MỘT KỲ ĐÃ CHỐT ═══════════
 *
 * Mọi con số ở đây đọc từ ẢNH CHỤP, không truy vấn lại một dòng nào. Đó là cả điểm của việc chốt:
 * đổi tỷ lệ, đổi người phụ trách fanpage, nhập thêm phiếu kho về sau KHÔNG làm đổi số của một kỳ
 * đã trả tiền.
 *
 * Không có nút sửa ở đây — sửa hồ sơ nhân sự không đổi được kỳ đã chốt, nên một nút sửa cạnh bảng
 * này chỉ tạo ra kỳ vọng sai.
 */
export function FinalizedPeriodTable({ state, basis, drift }: { state: PayrollPeriodState; basis: PayrollBasis; drift: PayrollDrift[] }) {
  const snap = state.snapshot;
  if (!snap) return null;
  const doiCongThuc = state.calcVersion !== null && state.calcVersion !== PAYROLL_CALC_VERSION;

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-100">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Lock className="size-4 shrink-0" aria-hidden />
          <b>Kỳ {snap.period.key} đã CHỐT</b>
          <span>
            · {formatDateTime(state.finalizedAt)}
            {state.finalizedByEmail ? ` · ${state.finalizedByEmail}` : ""} · cơ sở {PAYROLL_BASIS_SHORT[basis]} · phiên bản phép tính {state.calcVersion ?? "?"}
            {state.note ? ` · Ghi chú lúc chốt: “${state.note}”` : ""}
          </span>
          <InfoHint label="Kỳ đã chốt đọc từ đâu">
            <p>
              Mọi con số dưới đây đọc từ ẢNH CHỤP lúc chốt, KHÔNG tính lại. Đổi tỷ lệ thưởng, đổi người phụ trách fanpage hay nhập thêm phiếu kho về sau đều
              không làm đổi kỳ này — đó là điều khiến một kỳ đã trả tiền giữ nguyên được câu trả lời của nó.
            </p>
            {drift.length ? null : (
              <p className="mt-1">
                Tính lại theo dữ liệu hôm nay ra ĐÚNG con số đã chốt — chưa có chứng từ nào phát sinh sau ngày chốt làm đổi kỳ này.
              </p>
            )}
          </InfoHint>
          {/*
            RANH GIỚI PHẢI NÓI RA. Các khối phân tích bên dưới (lợi nhuận theo mã hàng, chi tiết theo
            marketer) tính SỐNG mỗi lần mở — chúng KHÔNG nằm trong ảnh chụp. Để chúng đứng ngay dưới một
            bảng đã chốt mà không nói gì là mời người đọc tưởng cả trang đều bất biến, rồi một hôm thấy
            số đổi và mất tin vào chính bảng lương ở trên.
          */}
          <DataWarnings
            items={[
              doiCongThuc ? (
                <>
                  <b>Kỳ này được chốt bằng phiên bản phép tính {state.calcVersion}, kho mã hiện ở {PAYROLL_CALC_VERSION}.</b> Con số của nó vẫn đúng với luật lúc ấy — nhưng
                  đừng so thẳng với một kỳ chốt bằng phiên bản khác: hai kỳ đứng trên hai công thức, không phải trên một xu hướng.
                </>
              ) : null,
              <>
                Các khối phân tích bên dưới (lợi nhuận theo mã hàng · chi tiết theo marketer) <b>tính sống</b> theo dữ liệu hôm nay và KHÔNG thuộc ảnh chụp của kỳ
                đã chốt. Chúng ở lại để đối chiếu; con số của kỳ nằm ở bảng trên.
              </>,
            ]}
          />
        </div>
      </div>

      <SectionCard
        title={`Bảng lương đã chốt · ${snap.period.key}`}
        description={`${formatNumber(snap.lines.length)} nhân sự · lương cứng chia theo ${formatNumber(snap.fixedBasis.days)} ngày của kỳ · lợi nhuận tổng ${formatVND(snap.totalProfit, { compact: true })}`}
        padded={false}
      >
        <div className="overflow-x-auto">
          <Table className="min-w-[980px]">
            <TableHeader>
              <TableRow>
                <TableHead>Nhân sự</TableHead>
                <TableHead>Cơ chế lúc chốt</TableHead>
                <TableHead className="text-right">LN cá nhân</TableHead>
                <TableHead className="text-right">Lương cứng (thuộc kỳ)</TableHead>
                <TableHead className="text-right">Thưởng % tổng</TableHead>
                <TableHead className="text-right">Thưởng % cá nhân</TableHead>
                <TableHead className="text-right">Thưởng % DT</TableHead>
                <TableHead className="text-right">Tổng lương</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {snap.lines.map((l) => (
                <TableRow key={l.employeeId}>
                  <TableCell>
                    <div className="font-semibold">{l.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {l.shortName} · {l.department}
                    </div>
                  </TableCell>
                  <TableCell className="text-xs">
                    {[
                      l.fixedMonthly ? `cứng ${formatVND(l.fixedMonthly, { compact: true })}/tháng` : null,
                      l.percentTotal ? `${l.percentTotal}% LN tổng` : null,
                      l.percentPersonal ? `${l.percentPersonal}% LN cá nhân` : null,
                      l.percentRevenue ? `${l.percentRevenue}% DT cá nhân` : null,
                    ]
                      .filter(Boolean)
                      .join(" + ") || "—"}
                  </TableCell>
                  <TableCell className="text-right">
                    <MoneyOrUnknown value={l.personalProfit} />
                  </TableCell>
                  <TableCell className="text-right">
                    <MoneyOrUnknown value={l.fixed} />
                  </TableCell>
                  <TableCell className="text-right">
                    <Money value={l.bonusTotal} className={l.bonusTotal ? "" : "text-muted-foreground"} />
                  </TableCell>
                  <TableCell className="text-right">
                    <MoneyOrUnknown value={l.bonusPersonal} />
                  </TableCell>
                  <TableCell className="text-right">
                    <Money value={l.bonusRevenue} className={l.bonusRevenue ? "" : "text-muted-foreground"} />
                  </TableCell>
                  <TableCell className="text-right">
                    <MoneyOrUnknown value={l.salary} className="text-base font-bold" />
                  </TableCell>
                </TableRow>
              ))}
              <TableRow className="bg-muted/40 font-bold hover:bg-muted/40">
                <TableCell colSpan={7}>Tổng lương phải trả của kỳ</TableCell>
                <TableCell className="text-right">
                  <MoneyOrUnknown value={snap.totalSalary} className="text-base" />
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
      </SectionCard>

      {/*
        ĐỀ XUẤT ĐIỀU CHỈNH, KHÔNG PHẢI MỘT LƯỢT GHI ĐÈ.

        Chứng từ vẫn về sau ngày chốt. Tính lại đè lên ảnh chụp là viết lại một kỳ đã trả tiền, im
        lặng; giấu hẳn phần chênh là để chủ shop không bao giờ biết có gì đã đổi. Nên phần tính lại
        HÔM NAY đứng CẠNH ảnh chụp, có dấu vết, và NGƯỜI quyết có sửa hay không.
      */}
      {drift.length ? (
        <SectionCard
          title="Chênh lệch phát sinh SAU khi chốt"
          hint="Tính lại theo dữ liệu hôm nay và so với ảnh chụp. Kỳ đã chốt KHÔNG bị viết lại — đây là đề xuất để chủ shop quyết, không phải một lượt sửa."
        >
          <div className="overflow-x-auto">
            <Table className="min-w-[640px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Con số</TableHead>
                  <TableHead className="text-right">Lúc chốt</TableHead>
                  <TableHead className="text-right">Tính lại hôm nay</TableHead>
                  <TableHead className="text-right">Chênh</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {drift.map((d) => (
                  <TableRow key={d.field}>
                    <TableCell className="text-[13px]">{d.label}</TableCell>
                    <TableCell className="text-right">
                      <MoneyOrUnknown value={d.snapshot} />
                    </TableCell>
                    <TableCell className="text-right">
                      <MoneyOrUnknown value={d.live} />
                    </TableCell>
                    <TableCell className="text-right">
                      {d.diff === null ? (
                        <span className="text-xs text-muted-foreground" title="Một trong hai bên CHƯA BIẾT nên không so được">
                          —
                        </span>
                      ) : (
                        <Money value={d.diff} sign className={d.diff === 0 ? "text-muted-foreground" : d.diff > 0 ? "text-destructive" : "text-success"} />
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </SectionCard>
      ) : null}
    </div>
  );
}
