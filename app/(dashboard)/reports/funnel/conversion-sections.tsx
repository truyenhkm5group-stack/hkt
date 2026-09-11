import Link from "next/link";
import { Clock, MessageCircleOff, TrendingDown } from "lucide-react";
import { DimensionTabs } from "@/app/(dashboard)/reports/funnel/dimension-tabs";
import { Money, SectionCard } from "@/components/ui-bits";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  CONVERSION_DIMENSION_LABEL,
  EVIDENCE_TIER_LABEL,
  MIN_CONVERSATIONS_FOR_RATE,
  ORDER_STEP_LABEL,
  UNMEASURABLE_STAGES,
  type ConversionDimension,
} from "@/lib/constants/conversion";
import { LEAKAGE_BUCKET_LABEL } from "@/lib/constants/leakage";
import { RISK_BAND_LABEL, RISK_BAND_TONE } from "@/lib/constants/preship-risk";
import { formatNumber, formatPercent } from "@/lib/format";
import { getPreOrderFunnel } from "@/lib/queries/conversation-funnel";
import { getConversionByDimension, getConversionFunnel } from "@/lib/queries/conversion-funnel";
import { getPreshipRiskBacktest } from "@/lib/queries/preship-risk-backtest";
import { getSalesLeakageQueue } from "@/lib/queries/sales-leakage";
import type { AttributionField } from "@/lib/constants/sales-funnel";
import type { Period } from "@/lib/search-params";
import { cn } from "@/lib/utils";

/**
 * Tỷ lệ dạng chữ. `null` = CHƯA BIẾT ⇒ hiện "—", KHÔNG BAO GIỜ 0%.
 *
 * Tên cố ý khác `pct` của `lib/format.ts`: hàm kia nhận (phần, tổng) và trả số, hàm này nhận tỷ lệ
 * 0–1 và trả chữ. Hai hàm cùng tên khác ngữ nghĩa là cách chắc chắn để một ngày nào đó ai đó nhân
 * thêm 100 lần thứ hai.
 */
function pctOrDash(value: number | null) {
  return value === null ? "—" : formatPercent(value * 100);
}

function hoursOrDash(value: number | null) {
  if (value === null) return "—";
  if (value < 1) return `${Math.round(value * 60)} phút`;
  if (value < 48) return `${value} giờ`;
  return `${Math.round(value / 24)} ngày`;
}

/**
 * ═══════════ PHỄU TRƯỚC ĐƠN — BỐN MỐC TỪ HỘI THOẠI ═══════════
 *
 * Tách thành một khối riêng, KHÔNG nối vào phễu đơn: mẫu số khác nhau về bản chất (hội thoại quét
 * được ≠ toàn bộ hội thoại). Xem `docs/revenue-conversion-contract.md` §1.
 */
export async function PreOrderFunnelSection({ period }: { period: Period }) {
  const pre = await getPreOrderFunnel(period);
  const chuaCoDuLieu = pre.coverage.sourceStatus === "DATA_UNAVAILABLE";

  return (
    <SectionCard
      title="Phễu trước đơn · từ hội thoại Pancake"
      description="Khách nhắn tin → được trả lời → cho SĐT → cho địa chỉ."
      hint="KHÔNG nối vào phễu đơn bên dưới: mẫu số ở đây là hội thoại QUÉT ĐƯỢC (cửa sổ 48 giờ, page có đơn trong 90 ngày, tối đa 200 hội thoại mỗi page mỗi lượt), không phải toàn bộ hội thoại. Nối hai mẫu số khác nhau lại là dựng ra một tỷ lệ không mô tả cái gì."
      padded={false}
    >
      {/* ĐỘ PHỦ NÓI TRƯỚC MỌI CON SỐ — không có nó thì mọi tỷ lệ đều có thể là số bịa. */}
      <p
        className={cn(
          "border-b px-5 py-2 text-xs",
          chuaCoDuLieu ? "bg-muted/50 text-muted-foreground" : pre.coverage.periodCovered ? "text-muted-foreground" : "bg-warning/5 text-warning",
        )}
      >
        {pre.coverage.note}
        {pre.coverage.truncated > 0 ? ` · ${formatNumber(pre.coverage.truncated)} hội thoại thuộc page đã CHẠM TRẦN lượt quét — phần đếm bị cắt.` : ""}
      </p>

      <div className="overflow-x-auto">
        <Table className="min-w-[760px]">
          <TableHeader>
            <TableRow>
              <TableHead>Mốc</TableHead>
              <TableHead className="text-right">Số hội thoại</TableHead>
              <TableHead className="text-right">So với mốc trước</TableHead>
              <TableHead className="text-right">Rơi</TableHead>
              <TableHead>Bằng chứng</TableHead>
              <TableHead>Phải đọc kèm</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pre.markers.map((m) => (
              <TableRow key={m.key}>
                <TableCell className="font-medium">{m.label}</TableCell>
                <TableCell className="text-right tabular-nums">{m.count === null ? "—" : formatNumber(m.count)}</TableCell>
                <TableCell className="text-right tabular-nums">{pctOrDash(m.ofPrevious)}</TableCell>
                <TableCell className="text-right tabular-nums">{m.dropOff === null ? "—" : formatNumber(m.dropOff)}</TableCell>
                <TableCell className="text-xs text-muted-foreground">{EVIDENCE_TIER_LABEL[m.tier]}</TableCell>
                <TableCell className="max-w-[260px] text-xs text-muted-foreground">{m.caveat || "—"}</TableCell>
              </TableRow>
            ))}
            {/*
              DÒNG "KHÔNG ĐO ĐƯỢC" — hiện tường minh thay vì lặng lẽ thiếu một bước.
              Xem `UNMEASURABLE_STAGES`: mọi căn cứ nghĩ ra được đều là đổi tên một sự thật đã đếm,
              hoặc là tìm từ khoá — đúng loại suy diễn đã dựng ra 181 case sai.
            */}
            {Object.entries(UNMEASURABLE_STAGES).map(([key, u]) => (
              <TableRow key={key} className="bg-muted/30">
                <TableCell className="font-medium text-muted-foreground">{u.label}</TableCell>
                <TableCell className="text-right font-semibold text-muted-foreground">KHÔNG ĐO ĐƯỢC</TableCell>
                <TableCell colSpan={4} className="text-xs text-muted-foreground">
                  {u.reason} <span className="font-medium">{u.insteadUse}</span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <div className="grid gap-px border-t bg-border sm:grid-cols-2 lg:grid-cols-4">
        {[
          { label: "Chưa ai trả lời", value: pre.unanswered === null ? "—" : formatNumber(pre.unanswered), note: "Khách nhắn mà shop im lặng" },
          { label: "Trung vị thời gian trả lời", value: pre.medianFirstReplyMinutes === null ? "—" : `${pre.medianFirstReplyMinutes} phút`, note: `p90 ${pre.p90FirstReplyMinutes === null ? "—" : `${pre.p90FirstReplyMinutes} phút`}` },
          {
            label: "Hội thoại → đơn",
            value: pctOrDash(pre.conversionToOrder),
            note:
              pre.conversionToOrder === null
                ? `Chưa công bố: cần kỳ nằm trong khoảng đã quét VÀ ≥ ${MIN_CONVERSATIONS_FOR_RATE} hội thoại`
                : `${formatNumber(pre.converted ?? 0)} hội thoại đã thành đơn`,
          },
          {
            label: "Một SĐT nhiều đơn",
            value: pre.ambiguous === null ? "—" : formatNumber(pre.ambiguous),
            // Nhóm này KHÔNG được gộp vào "chưa có đơn": gộp là biến "không biết" thành "biết là chưa".
            note: "KHÔNG kết luận được — đếm riêng, không gộp vào 'chưa có đơn'",
          },
        ].map((x) => (
          <div key={x.label} className="bg-card px-5 py-3">
            <div className="text-xs text-muted-foreground">{x.label}</div>
            <div className="text-lg font-semibold tabular-nums">{x.value}</div>
            <div className="text-xs text-muted-foreground">{x.note}</div>
          </div>
        ))}
      </div>
    </SectionCard>
  );
}

/**
 * ═══════════ ĐƠN ĐANG KẸT Ở ĐÂU, VÀ KẸT BAO LÂU ═══════════
 *
 * Phễu đã có ở trên đếm SỐ LƯỢNG. Khối này trả lời câu khác: **rơi ở bước nào** và **kẹt bao lâu** —
 * thứ làm được gì đó ngay. Đặc biệt là bước "đã tạo vận đơn → hàng đã rời kho": mã đã in mà bưu tá
 * chưa lấy là khoảng trống của kho, và phễu cũ nhảy qua nó.
 */
export async function StuckStepsSection({ period }: { period: Period }) {
  const f = await getConversionFunnel(period);
  const worst = [...f.steps].sort((a, b) => b.dropOff - a.dropOff)[0];

  return (
    <SectionCard
      title="Đơn kẹt ở bước nào"
      description={worst && worst.dropOff > 0 ? `Chỗ rơi lớn nhất: ${worst.label} — mất ${formatNumber(worst.dropOff)} đơn.` : "Không bước nào rơi đáng kể."}
      hint="Bước 'Đã tạo vận đơn' là bước phễu cũ KHÔNG có: có mã vận đơn chưa nghĩa là hàng đã ra khỏi kho (vận đơn PENDING là hàng còn trong kho), và khoảng trống đó là việc của kho. Cột thời gian là TRUNG VỊ từ bước trước tới bước này; 'đo được' cho biết bao nhiêu phần đơn có đủ cặp mốc — thiếu mốc là CHƯA BIẾT, không tính là 0 giờ."
      padded={false}
    >
      <div className="overflow-x-auto">
        <Table className="min-w-[900px]">
          <TableHeader>
            <TableRow>
              <TableHead>Bước</TableHead>
              <TableHead className="text-right">Số đơn</TableHead>
              <TableHead className="text-right">Qua được</TableHead>
              <TableHead className="text-right">Rơi</TableHead>
              <TableHead className="text-right">Trung vị</TableHead>
              <TableHead className="text-right">p90</TableHead>
              <TableHead className="text-right">Đo được</TableHead>
              <TableHead>Phải đọc kèm</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {f.steps.map((s) => (
              <TableRow key={s.key} className={cn(worst && s.key === worst.key && s.dropOff > 0 && "bg-warning/5")}>
                <TableCell className="font-medium">{s.label}</TableCell>
                <TableCell className="text-right tabular-nums">{formatNumber(s.count)}</TableCell>
                <TableCell className="text-right tabular-nums">{s.key === "CREATED" ? "—" : pctOrDash(s.ofPrevious)}</TableCell>
                <TableCell className="text-right tabular-nums">{s.key === "CREATED" ? "—" : formatNumber(s.dropOff)}</TableCell>
                <TableCell className="text-right tabular-nums">{hoursOrDash(s.timing.medianHours)}</TableCell>
                <TableCell className="text-right tabular-nums">{hoursOrDash(s.timing.p90Hours)}</TableCell>
                <TableCell className="text-right tabular-nums text-xs text-muted-foreground">{pctOrDash(s.timing.coverage)}</TableCell>
                <TableCell className="max-w-[280px] text-xs text-muted-foreground">{s.caveat || s.timing.note}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {/*
        KHUYẾT CHỨNG TỪ HIỆN THÀNH SỐ, KHÔNG BỊ KẸP LẶNG LẼ.
        Một đơn "giao thành công" mà không có vận đơn nào là kết luận dựa trên trạng thái Pancake —
        người đọc phải biết có bao nhiêu đơn như thế trước khi tin vào cột thời gian.
      */}
      <div className="border-t px-5 py-2 text-xs text-muted-foreground">
        Khuyết chứng từ trong kỳ: <strong>{formatNumber(f.evidenceGaps.deliveredWithoutShipment)}</strong> đơn kết luận giao thành công mà KHÔNG có vận đơn nào (dựa trên
        trạng thái Pancake) · <strong>{formatNumber(f.evidenceGaps.shipmentWithoutConfirm)}</strong> đơn có vận đơn mà Pancake còn ở trạng thái chờ ·{" "}
        <strong>{formatNumber(f.evidenceGaps.noStatusHistory)}</strong> đơn không có dòng lịch sử trạng thái nào nên KHÔNG đo được thời gian xác nhận ·{" "}
        <strong>{formatNumber(f.cancelledAfterConfirm)}</strong> đơn huỷ SAU khi đã rời trạng thái chờ (bước &ldquo;đã xác nhận&rdquo; đang gánh phần này).
      </div>
    </SectionCard>
  );
}

/** ═══════════ CHUYỂN ĐỔI THEO CHIỀU ═══════════ */
export async function ConversionByDimensionSection({ period, dimension, role }: { period: Period; dimension: ConversionDimension; role: AttributionField }) {
  const r = await getConversionByDimension(period, dimension, role);
  const isTime = dimension === "day" || dimension === "hour";

  return (
    <SectionCard
      title={`Chuyển đổi theo ${CONVERSION_DIMENSION_LABEL[dimension].toLowerCase()}`}
      description="Mỗi dòng nói rõ nó đang rò ở bước nào, và rò bao nhiêu đơn."
      hint="Cột 'Rò ở bước' tính theo SỐ ĐƠN rơi, không theo tỷ lệ: một dòng rơi 90% của 2 đơn không phải vấn đề của shop, một dòng rơi 20% của 400 đơn thì đúng là chỗ mất tiền. Mẫu số của tỷ lệ giao là đơn ĐÃ RỜI KHO. Đơn không gán được nằm ở dòng 'Chưa gán' cuối bảng, KHÔNG chia đều cho ai."
      actions={<DimensionTabs current={dimension} />}
      padded={false}
    >
      {r.lowCoverage ? (
        <p className="border-b bg-warning/5 px-5 py-2 text-xs text-warning">
          Chỉ {formatPercent(r.coverage * 100)} số đơn trong kỳ gán được theo chiều này. Bảng dưới mô tả đúng phần đó, không mô tả toàn shop.
        </p>
      ) : null}
      <div className="overflow-x-auto">
        <Table className="min-w-[980px]">
          <TableHeader>
            <TableRow>
              <TableHead>{CONVERSION_DIMENSION_LABEL[dimension]}</TableHead>
              <TableHead className="text-right">Đơn</TableHead>
              <TableHead className="text-right">Xác nhận</TableHead>
              <TableHead className="text-right">Có vận đơn</TableHead>
              <TableHead className="text-right">Rời kho</TableHead>
              <TableHead className="text-right">Giao TC</TableHead>
              <TableHead className="text-right">Tỷ lệ giao</TableHead>
              <TableHead className="text-right">TB xác nhận</TableHead>
              <TableHead>Rò ở bước</TableHead>
              <TableHead className="text-right">Doanh thu giao TC</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {r.rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={10} className="py-8 text-center text-sm text-muted-foreground">
                  Chưa có đơn nào trong kỳ.
                </TableCell>
              </TableRow>
            ) : (
              r.rows.slice(0, isTime ? 40 : 25).map((row) => (
                <TableRow key={row.key} className={cn(row.unassigned && "text-muted-foreground")}>
                  <TableCell className="font-medium">
                    {row.label}
                    {row.unassigned ? <span className="ml-1 text-xs">· không gán được, không chia đều</span> : null}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatNumber(row.created)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatNumber(row.confirmed)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatNumber(row.shipmentCreated)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatNumber(row.leftWarehouse)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatNumber(row.delivered)}</TableCell>
                  <TableCell className="text-right tabular-nums">{pctOrDash(row.deliveryRate)}</TableCell>
                  <TableCell className="text-right tabular-nums">{hoursOrDash(row.medianHoursToConfirm)}</TableCell>
                  <TableCell className="text-xs">
                    {row.worstStep ? (
                      <>
                        {ORDER_STEP_LABEL[row.worstStep]} <span className="text-muted-foreground">· {formatNumber(row.worstStepDropOff)} đơn</span>
                      </>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <Money value={row.deliveredRevenue} />
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </SectionCard>
  );
}

/** ═══════════ HÀNG ĐỢI RÒ RỈ DOANH THU ═══════════ */
export async function LeakageSection() {
  const q = await getSalesLeakageQueue({ limit: 200 });

  return (
    <SectionCard
      title="Rò rỉ doanh thu · việc làm được ngay"
      description={`${formatNumber(q.cases.length)} ca còn cứu được · ${formatNumber(q.unassigned)} chưa ai nhận · ${formatNumber(q.breached)} đã quá hạn.`}
      hint="CHỈ ca còn cứu được: ca quá tuổi vẫn được đếm trong phễu (nó là sự thật đã xảy ra) nhưng KHÔNG vào đây — gọi lại khách nhắn 10 ngày trước không phải thu hồi doanh thu, đó là làm khách khó chịu. Hai nhóm cuối đọc lại từ Hàng đợi việc nên người nhận và hạn xử lý là CÙNG MỘT bản ghi, không phải bản sao."
      padded={false}
    >
      {!q.conversationDataAvailable ? (
        <p className="border-b bg-muted/50 px-5 py-2 text-xs text-muted-foreground">
          Ba nhóm đầu (hội thoại) chưa có số vì chưa ghi được hội thoại nào — job &ldquo;Case CSKH từ hội thoại Pancake&rdquo; phải chạy ít nhất một lượt. Đây là
          sự thật về dữ liệu, không phải lỗi hiển thị.
        </p>
      ) : null}
      <div className="overflow-x-auto">
        <Table className="min-w-[820px]">
          <TableHeader>
            <TableRow>
              <TableHead>Nhóm</TableHead>
              <TableHead className="text-right">Ca</TableHead>
              <TableHead className="text-right">Chưa ai nhận</TableHead>
              <TableHead className="text-right">Quá hạn</TableHead>
              <TableHead className="text-right">Tiền của đơn thật</TableHead>
              <TableHead className="text-right">Chưa quy ra tiền</TableHead>
              <TableHead className="text-right">Ca cũ nhất</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {q.buckets.map((b) => (
              <TableRow key={b.bucket}>
                <TableCell className="font-medium">{LEAKAGE_BUCKET_LABEL[b.bucket]}</TableCell>
                <TableCell className="text-right tabular-nums">{formatNumber(b.count)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatNumber(b.unassigned)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatNumber(b.breached)}</TableCell>
                <TableCell className="text-right">{b.actualValue > 0 ? <Money value={b.actualValue} /> : "—"}</TableCell>
                <TableCell className="text-right tabular-nums">{b.unknownValue > 0 ? `${formatNumber(b.unknownValue)} ca` : "—"}</TableCell>
                <TableCell className="text-right tabular-nums">{b.oldestHours > 0 ? hoursOrDash(b.oldestHours) : "—"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/*
        TIỀN THẬT VÀ TIỀN ƯỚC TÍNH ĐỨNG Ở HAI DÒNG KHÁC NHAU, có nhãn.
        `lib/queries/order-intake.ts` đã từ chối ước tính tiền cho khách chưa có đơn; luật đó giữ
        nguyên — ước tính chỉ được hiện KÈM CĂN CỨ và không bao giờ cộng vào tiền thật.
      */}
      <div className="grid gap-px border-t bg-border sm:grid-cols-3">
        <div className="bg-card px-5 py-3">
          <div className="text-xs text-muted-foreground">Tiền treo ở đơn CÓ THẬT</div>
          <div className="text-lg font-semibold">
            <Money value={q.actualValueAtRisk} />
          </div>
          <div className="text-xs text-muted-foreground">Sự thật, cộng được</div>
        </div>
        <div className="bg-card px-5 py-3">
          <div className="text-xs text-muted-foreground">Ước tính cho khách CHƯA có đơn</div>
          <div className="text-lg font-semibold">{q.estimatedValueAtRisk === null ? "—" : <Money value={q.estimatedValueAtRisk} />}</div>
          <div className="text-xs text-muted-foreground">{q.estimateBasis ?? "Chưa page nào đủ mẫu để lấy trung vị"}</div>
        </div>
        <div className="bg-card px-5 py-3">
          <div className="text-xs text-muted-foreground">Ca chưa quy ra tiền được</div>
          <div className="text-lg font-semibold tabular-nums">{formatNumber(q.unknownValueCases)}</div>
          <div className="text-xs text-muted-foreground">Khách chưa chốt mẫu mã ⇒ chưa có giá trị nào. CHƯA BIẾT, không phải 0đ.</div>
        </div>
      </div>

      {q.suppressed.length > 0 ? (
        <div className="border-t px-5 py-2 text-xs text-muted-foreground">
          Đã BỎ khỏi hàng đợi: {q.suppressed.map((s) => `${formatNumber(s.count)} ca — ${s.label}`).join(" · ")}.{" "}
          <span className="font-medium">Mọi lần bỏ đều được đếm và nêu lý do</span> — một hàng đợi lặng lẽ bỏ ca là hàng đợi không ai kiểm chứng được.
        </div>
      ) : null}

      {q.cases.length > 0 ? (
        <div className="overflow-x-auto border-t">
          <Table className="min-w-[980px]">
            <TableHeader>
              <TableRow>
                <TableHead>Ca</TableHead>
                <TableHead>Nhóm</TableHead>
                <TableHead>Người nhận</TableHead>
                <TableHead className="text-right">Tuổi</TableHead>
                <TableHead>Bằng chứng</TableHead>
                <TableHead className="text-right">Giá trị</TableHead>
                <TableHead>Việc cần làm</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {q.cases.slice(0, 15).map((c) => (
                <TableRow key={c.id} className={cn(c.breached && "bg-warning/5")}>
                  <TableCell className="font-medium">
                    <Link href={c.href} className="underline-offset-4 hover:underline" target={c.href.startsWith("http") ? "_blank" : undefined}>
                      {c.title}
                    </Link>
                  </TableCell>
                  <TableCell className="text-xs">{c.bucketLabel}</TableCell>
                  <TableCell className="text-xs">{c.owner ?? <span className="text-warning">chưa ai nhận</span>}</TableCell>
                  <TableCell className="text-right tabular-nums text-xs">{c.ageLabel}</TableCell>
                  <TableCell className="max-w-[300px] text-xs text-muted-foreground">{c.evidence}</TableCell>
                  <TableCell className="text-right text-xs">
                    {c.estimatedValue === null ? <span title="Khách chưa chốt mẫu mã">—</span> : <Money value={c.estimatedValue} />}
                    {c.valueBasis === "PAGE_MEDIAN" ? <div className="text-muted-foreground">ước tính</div> : null}
                  </TableCell>
                  <TableCell className="max-w-[260px] text-xs text-muted-foreground">{c.nextAction}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <div className="flex items-center gap-2 border-t px-5 py-4 text-sm text-muted-foreground">
          <MessageCircleOff className="size-4" /> Không ca nào đang chờ trong cửa sổ còn cứu được.
        </div>
      )}
    </SectionCard>
  );
}

/** ═══════════ KIỂM ĐỊNH ĐIỂM RỦI RO ═══════════ */
export async function RiskBacktestSection({ period }: { period: Period }) {
  const bt = await getPreshipRiskBacktest(period);
  const tone =
    bt.verdict === "PHÂN BIỆT ĐƯỢC" ? "bg-success/10 text-success" : bt.verdict === "KHÔNG PHÂN BIỆT ĐƯỢC" ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground";

  return (
    <SectionCard
      title="Kiểm định điểm rủi ro trước khi giao"
      description="Điểm rủi ro có THẬT SỰ tách được nhóm hoàn khỏi nhóm giao thành công trên dữ liệu của shop hay không."
      hint="Chia theo THỜI GIAN: tỷ lệ hoàn lịch sử học từ nửa CŨ, chấm điểm cho đơn của nửa MỚI. Học và chấm trên cùng một tập là tự chấm bài của mình. Chỉ kết luận 'phân biệt được' khi nhóm rủi ro cao hoàn nhiều hơn mặt bằng ít nhất 1,3 lần VÀ biên dưới khoảng tin cậy 95% vẫn cao hơn mặt bằng — dưới mức đó thì mọi dao động ngẫu nhiên cũng thành 'có tác dụng'."
      actions={<Badge className={cn("font-normal", tone)}>{bt.verdict}</Badge>}
      padded={false}
    >
      <p className="border-b px-5 py-2 text-xs text-muted-foreground">{bt.verdictReason}</p>
      <div className="overflow-x-auto">
        <Table className="min-w-[720px]">
          <TableHeader>
            <TableRow>
              <TableHead>Nhóm rủi ro</TableHead>
              <TableHead className="text-right">Đơn đã kết thúc</TableHead>
              <TableHead className="text-right">Giao TC</TableHead>
              <TableHead className="text-right">Hoàn</TableHead>
              <TableHead className="text-right">Tỷ lệ hoàn</TableHead>
              <TableHead className="text-right">So mặt bằng</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {bt.bands.map((b) => (
              <TableRow key={b.band}>
                <TableCell>
                  <Badge className={cn("font-normal", RISK_BAND_TONE[b.band])}>{RISK_BAND_LABEL[b.band]}</Badge>
                </TableCell>
                <TableCell className="text-right tabular-nums">{formatNumber(b.orders)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatNumber(b.delivered)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatNumber(b.returned)}</TableCell>
                {/* Nhóm dưới cỡ mẫu ⇒ KHÔNG có tỷ lệ. Một con số từ 4 đơn là mời người ta tin vào nhiễu. */}
                <TableCell className="text-right tabular-nums">{pctOrDash(b.returnRate)}</TableCell>
                <TableCell className="text-right tabular-nums">{b.lift === null ? "—" : `${b.lift}×`}</TableCell>
              </TableRow>
            ))}
            <TableRow className="bg-muted/30">
              <TableCell className="font-medium">Mặt bằng cả kỳ</TableCell>
              <TableCell className="text-right tabular-nums">{formatNumber(bt.orders)}</TableCell>
              <TableCell colSpan={2} className="text-right text-xs text-muted-foreground">
                nửa kiểm tra · nửa học {formatNumber(bt.trainOrders)} đơn
              </TableCell>
              <TableCell className="text-right tabular-nums">{pctOrDash(bt.baselineReturnRate)}</TableCell>
              <TableCell className="text-right">—</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>
      <div className="grid gap-px border-t bg-border sm:grid-cols-3">
        <div className="bg-card px-5 py-3">
          <div className="text-xs text-muted-foreground">Soát 10 đơn thì mấy đơn đáng soát</div>
          <div className="text-lg font-semibold tabular-nums">{pctOrDash(bt.highPrecision)}</div>
          <div className="text-xs text-muted-foreground">Trong nhóm rủi ro cao, phần thật sự hoàn</div>
        </div>
        <div className="bg-card px-5 py-3">
          <div className="text-xs text-muted-foreground">Soát được bao nhiêu phần vấn đề</div>
          <div className="text-lg font-semibold tabular-nums">{pctOrDash(bt.highRecall)}</div>
          <div className="text-xs text-muted-foreground">Trong số đơn thật sự hoàn, phần bị chấm cao</div>
        </div>
        <div className="bg-card px-5 py-3">
          <div className="text-xs text-muted-foreground">Thứ tự nhóm đúng chiều</div>
          <div className="text-lg font-semibold">{bt.monotone ? "Có" : "Không"}</div>
          <div className="text-xs text-muted-foreground">cao ≥ trung bình ≥ thấp về tỷ lệ hoàn</div>
        </div>
      </div>
      <ul className="space-y-1 border-t px-5 py-3 text-xs text-muted-foreground">
        <li className="flex items-center gap-1.5 font-medium text-foreground">
          <Clock className="size-3.5" /> Giới hạn của chính phép kiểm định này
        </li>
        {bt.limitations.map((l) => (
          <li key={l} className="flex gap-1.5">
            <TrendingDown className="mt-0.5 size-3 shrink-0" />
            <span>{l}</span>
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}
