import { Boxes, Users } from "lucide-react";
import { SectionCard } from "@/components/ui-bits";
import { InfoHint } from "@/components/info-hint";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatNumber } from "@/lib/format";
import type { InspectorRow, SkuRecoveryRow, ThroughputDay } from "@/lib/queries/return-warehouse-kpi";
import { WarehouseTrendChart } from "@/app/(dashboard)/inventory/returns/warehouse-trend";
import { cn } from "@/lib/utils";

function pctText(v: number | null): string {
  return v === null ? "—" : `${v.toFixed(0)}%`;
}

function hoursText(h: number | null): string {
  if (h === null || !Number.isFinite(h)) return "—";
  if (h < 1) return `${Math.round(h * 60)} phút`;
  if (h < 24) return `${h.toFixed(1).replace(".", ",")} giờ`;
  return `${(h / 24).toFixed(1).replace(".", ",")} ngày`;
}

/**
 * ═══════════ NĂNG SUẤT THEO NGÀY ═══════════
 *
 * Hai đường trả lời một câu: tốc độ đếm có theo kịp tốc độ nhận không. Đường đếm nằm dưới cột nhận
 * nhiều ngày liên tiếp nghĩa là tồn đọng đang dâng — và đó là lúc phải thêm người, chứ không phải
 * lúc nhìn con số tồn đọng rồi ngạc nhiên.
 */
export function WarehouseThroughput({ data, days }: { data: ThroughputDay[]; days: number }) {
  const nhan = data.reduce((a, d) => a + d.receivedParcels, 0);
  const dem = data.reduce((a, d) => a + d.inspectedParcels, 0);
  const mon = data.reduce((a, d) => a + d.restockedQty, 0);
  return (
    <SectionCard
      title={
        <span className="flex items-center gap-1.5">
          <Boxes className="size-4" /> Năng suất {days} ngày
        </span>
      }
      description={`${formatNumber(nhan)} kiện nhận · ${formatNumber(dem)} kiện đếm xong · ${formatNumber(mon)} món vào lại tồn`}
      hint="KIỆN và MÓN là hai đơn vị khác nhau và không bao giờ được cộng vào nhau: một kiện ba món vẫn là MỘT kiện. Biểu đồ chỉ vẽ kiện; số món nằm ở dòng mô tả."
    >
      <WarehouseTrendChart data={data} />
    </SectionCard>
  );
}

/**
 * ═══════════ THEO NGƯỜI ĐẾM ═══════════
 *
 * Chỉ đo VIỆC HỌ LÀM. Cột "kiện có lệch" mang nhãn *kết quả chung* vì hàng hỏng trên đường về do
 * ĐVVC và do khách đóng gói — người đếm không quyết được (AGENTS.md mục 27). Nó ở đây để biết ai
 * đang gặp lô xấu, KHÔNG để xếp hạng người.
 *
 * Không có cột "điểm tổng": chủ shop chưa khai trọng số, và không có bộ mặc định nào được thêm
 * (AGENTS.md mục 27).
 *
 * Lượt đếm chưa nối được về tài khoản nằm riêng ở dòng cuối — không đoán người cho dòng lịch sử
 * (AGENTS.md mục 35).
 */
export function WarehousePeople({ rows, unattributed, days, slaHours }: { rows: InspectorRow[]; unattributed: number; days: number; slaHours: number }) {
  if (!rows.length && !unattributed) return null;
  return (
    <SectionCard
      title={
        <span className="flex items-center gap-1.5">
          <Users className="size-4" /> Người đếm hàng hoàn · {days} ngày
        </span>
      }
      hint={
        <>
          <p>Đo đoạn ĐẾM — đoạn NHẬN chưa quy kết được theo người.</p>
          <p className="mt-1">{`Đúng hạn = đếm xong trong ${slaHours} giờ kể từ lúc ghi nhận kiện đã về — cùng một phép đo với thẻ điểm phòng ban, nên hai màn hình không nói hai con số.`}</p>
        </>
      }
    >
      <div className="overflow-x-auto">
        <Table className="min-w-[720px]">
          <TableHeader>
            <TableRow>
              <TableHead>Người đếm</TableHead>
              <TableHead className="text-right">Kiện đã đếm</TableHead>
              <TableHead className="text-right">Đúng hạn</TableHead>
              <TableHead className="text-right">Thời gian đếm (trung vị)</TableHead>
              <TableHead className="text-right">Món vào tồn</TableHead>
              <TableHead className="text-right">
                <span className="inline-flex items-center gap-1">
                  Kiện có lệch
                  <InfoHint>
                    KẾT QUẢ CHUNG, không phải điểm chấm người: hàng hỏng hoặc thiếu trên đường về do đơn vị vận chuyển và cách khách đóng gói quyết định. Đọc để
                    biết ai đang gặp lô xấu.
                  </InfoHint>
                </span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.userId}>
                <TableCell className="font-medium">{r.name}</TableCell>
                <TableCell className="text-right numeric">{formatNumber(r.inspectedParcels)}</TableCell>
                <TableCell className={cn("text-right numeric", r.onTimeRate !== null && r.onTimeRate < 80 ? "text-amber-600 dark:text-amber-400" : "")}>
                  {pctText(r.onTimeRate)}
                </TableCell>
                <TableCell className="text-right numeric">{hoursText(r.medianHours)}</TableCell>
                <TableCell className="text-right numeric">{formatNumber(r.restockQty)}</TableCell>
                <TableCell className="text-right numeric text-muted-foreground">{formatNumber(r.withIssue)}</TableCell>
              </TableRow>
            ))}
            {unattributed ? (
              <TableRow className="bg-muted/40">
                <TableCell className="text-muted-foreground">
                  <span className="inline-flex items-center gap-1">
                    Chưa quy kết được về tài khoản
                    <InfoHint>Lượt đếm không có khoá tài khoản — không đoán người cho dòng lịch sử, nên chúng không vào thẻ điểm của ai.</InfoHint>
                  </span>
                </TableCell>
                <TableCell className="text-right numeric text-muted-foreground">{formatNumber(unattributed)}</TableCell>
                <TableCell colSpan={4} />
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </div>
    </SectionCard>
  );
}

/**
 * ═══════════ MẪU MÃ NÀO QUAY LẠI TỒN ═══════════
 *
 * Đọc từ PHIẾU KHO (`stock_receipt_items` của phiếu `RETURN`) — chứng từ duy nhất làm đổi tồn thật.
 *
 * Không có cột "hỏng / thiếu / sai hàng" theo mẫu mã, và đó là câu trả lời đúng: kết luận hiện chỉ
 * có ở mức CẢ KIỆN, nên một kiện ba mẫu mã kết luận "hỏng" không nói được mẫu nào hỏng. Chia đều
 * cho ba mẫu là bịa ra một con số trông như đo được — xem khối "ba chỉ số ERP chưa đo được".
 */
export function WarehouseBySku({ rows, days }: { rows: SkuRecoveryRow[]; days: number }) {
  if (!rows.length) return null;
  const tong = rows.reduce((a, r) => a + r.restockedQty, 0);
  return (
    <SectionCard
      title={`Mẫu mã quay lại tồn · ${days} ngày`}
      description={`${formatNumber(tong)} món đã tái nhập qua phiếu kho`}
      hint="Chỉ đếm món ĐÃ có phiếu tái nhập — tức là hàng đã thực sự vào lại tồn bán được, không phải hàng mới về tới kho."
    >
      <div className="overflow-x-auto">
        <Table className="min-w-[620px]">
          <TableHeader>
            <TableRow>
              <TableHead>Mẫu mã</TableHead>
              <TableHead>Sản phẩm</TableHead>
              <TableHead className="text-right">Món vào lại tồn</TableHead>
              <TableHead className="text-right">Số kiện</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.variantId}>
                <TableCell className="font-medium">
                  {r.sku}
                  {r.color || r.size ? <span className="ml-1.5 text-[11.5px] text-muted-foreground">{[r.color, r.size].filter(Boolean).join(" · ")}</span> : null}
                </TableCell>
                <TableCell className="max-w-[260px] truncate text-muted-foreground">{r.productName}</TableCell>
                <TableCell className="text-right numeric">{formatNumber(r.restockedQty)}</TableCell>
                <TableCell className="text-right numeric text-muted-foreground">{formatNumber(r.parcels)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </SectionCard>
  );
}
