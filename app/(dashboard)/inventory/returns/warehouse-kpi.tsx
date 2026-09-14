import { Boxes, CalendarCheck, ClipboardCheck, PackageCheck, Timer, TriangleAlert } from "lucide-react";
import { SectionCard } from "@/components/ui-bits";
import { StatStrip } from "@/components/stat-tile";
import { InfoHint } from "@/components/info-hint";
import { formatNumber } from "@/lib/format";
import { AGE_BUCKET_TONE, RECOVERY_RATE_BASIS, RESTOCKABLE_RATE_BASIS, RETURN_KPI_GAPS, SLA_LEG_LABEL } from "@/lib/constants/return-kpi";
import type { ReturnWarehouseKpi } from "@/lib/queries/return-warehouse-kpi";
import { cn } from "@/lib/utils";

/** Tỷ lệ: `null` = CHƯA ĐO ĐƯỢC ⇒ in "—", không bao giờ in "0%" (AGENTS.md mục 42). */
function pctText(v: number | null): string {
  return v === null ? "—" : `${v.toFixed(1).replace(".", ",")}%`;
}

/** Giờ → chữ đọc được. `null` = nhóm rỗng ⇒ "—", không phải "0 giờ". */
function hoursText(h: number | null): string {
  if (h === null || !Number.isFinite(h)) return "—";
  if (h < 24) return `${Math.floor(h)} giờ`;
  return `${Math.floor(h / 24)} ngày`;
}

/**
 * ═══════════ KHO HÀNG HOÀN HÔM NAY ═══════════
 *
 * Khối này trả lời đúng câu người quản lý hỏi lúc mở máy: *hôm nay kho làm được gì, và có gì đang
 * tắc?* — không bắt họ mở bốn trang rồi tự cộng.
 *
 * Ba con số "hôm nay" cắt theo GIỜ VIỆT NAM. Ca làm của kho kết thúc theo giờ VN; cắt theo UTC là
 * mỗi sáng lại mất một mẩu ca làm vào ngày hôm trước.
 */
export function WarehouseToday({ kpi }: { kpi: ReturnWarehouseKpi }) {
  const quaHan = kpi.slaBreach;
  return (
    <SectionCard
      title={
        <span className="flex items-center gap-1.5">
          <CalendarCheck className="size-4" /> Kho hàng hoàn hôm nay
        </span>
      }
      description={`Hạn xử lý: ${SLA_LEG_LABEL.RECEIVE_TO_INSPECT} ${kpi.slaHours.receiveToInspect} giờ · ${SLA_LEG_LABEL.INSPECT_TO_RESTOCK} ${kpi.slaHours.inspectToRestock} giờ`}
      hint="Ba ô đầu đếm việc ĐÃ LÀM trong ngày hôm nay theo giờ Việt Nam. Ba ô sau là tình trạng đang tồn đọng — chúng không giới hạn theo ngày."
    >
      <StatStrip
        columns={3}
        items={[
          {
            label: "Nhận hôm nay",
            value: formatNumber(kpi.today.received),
            note: "kiện kho ghi nhận đã về",
            icon: PackageCheck,
            tone: kpi.today.received ? "green" : "muted",
          },
          {
            label: "Đếm xong hôm nay",
            value: formatNumber(kpi.today.inspected),
            note: `${formatNumber(kpi.today.restockedQty)} món vào lại tồn`,
            icon: ClipboardCheck,
            tone: kpi.today.inspected ? "green" : "muted",
          },
          {
            label: "Quá hạn đếm",
            value: formatNumber(quaHan),
            note: `chờ quá ${kpi.slaHours.receiveToInspect} giờ`,
            hint: "Kiện đã nằm ở kho lâu hơn hạn mà chưa ai mở ra đếm. Đây là vốn có thật mà sổ chưa biết — và mỗi giờ trôi qua là một giờ kế hoạch sản xuất đặt thừa.",
            icon: TriangleAlert,
            tone: quaHan ? "rose" : "green",
            href: quaHan ? "#tram-dem" : undefined,
          },
        ]}
      />
    </SectionCard>
  );
}

/**
 * ═══════════ BỐN Ô KHÔNG CÓ Ở DẢI THẺ CŨ ═══════════
 *
 * Dải thẻ phía trên đã nói "chờ kho nhận · chờ đếm · đã vào lại tồn · hỏng · thiếu · không đúng
 * hàng". Khối này CỐ Ý không lặp lại một ô nào trong số đó — hai chỗ cùng in một con số là hai chỗ
 * sẽ có ngày nói hai số khác nhau. Ở đây chỉ có phần dải kia chưa trả lời được.
 *
 * "Có thể tái nhập" KHÁC "đã tái nhập": cái đầu là kết luận của người đếm, cái sau là phiếu kho đã
 * lập. Bình thường hai số bằng nhau vì trạm đếm lập phiếu ngay; chúng tách ra đúng lúc có trục
 * trặc, và đó chính là lúc cần nhìn thấy.
 */
export function WarehouseKpiBlock({ kpi }: { kpi: ReturnWarehouseKpi }) {
  const chenhLech = kpi.restockableParcels - kpi.restockedParcels;
  return (
    <div className="space-y-3">
      <StatStrip
        columns={4}
        items={[
          {
            label: "Đã kiểm",
            value: formatNumber(kpi.inspectedParcels),
            note: `trên ${formatNumber(kpi.receivedParcels)} kiện đã về`,
            icon: ClipboardCheck,
            tone: "default",
          },
          {
            label: "Có thể tái nhập",
            value: formatNumber(kpi.restockableParcels),
            note: chenhLech > 0 ? `${formatNumber(chenhLech)} kiện chưa lập phiếu` : "đã lập phiếu hết",
            hint: "Kết luận của người đếm là hàng còn bán lại được. Khác với “đã tái nhập” — cái đó đếm phiếu kho đã lập. Hai số lệch nhau nghĩa là có kiện đếm xong mà tồn vẫn chưa đổi.",
            icon: Boxes,
            tone: chenhLech > 0 ? "amber" : "green",
          },
          {
            label: "Tỷ lệ bán lại được",
            value: pctText(kpi.restockableRate),
            note: RESTOCKABLE_RATE_BASIS,
            hint: "Mẫu số là kiện ĐÃ ĐẾM, không phải kiện đã nhận: kiện chưa đếm thì chưa ai biết nó bán lại được hay không, và ném nó vào mẫu số là khẳng định 'không bán lại được' cho thứ chưa ai mở ra.",
            icon: PackageCheck,
            tone: kpi.restockableRate === null ? "muted" : "default",
          },
          {
            label: "Tỷ lệ thu hồi tồn",
            value: pctText(kpi.recoveryRate),
            note: RECOVERY_RATE_BASIS,
            hint: "Phần món đếm được đã quay lại tồn bán được. Mẫu số là MÓN ĐẾM ĐƯỢC của kiện đã đếm — cố ý không lấy vận đơn mang trạng thái 'đã hoàn', vì hàng đó có thể còn đang trên đường và tỷ lệ sẽ thấp giả tạo.",
            icon: Boxes,
            tone: kpi.recoveryRate === null ? "muted" : "default",
          },
        ]}
      />

      {/* TUỔI TỒN ĐỌNG THEO GIỜ — ranh giới 24/48/72 trùng đúng hạn xử lý, nên hai con số không đá nhau. */}
      {kpi.pendingInspection > 0 ? (
        <div className="rounded-xl border bg-card px-3 py-2.5">
          <p className="mb-2 flex items-center gap-1.5 text-[12.5px] font-medium">
            <Timer className="size-3.5 opacity-70" /> Tuổi kiện chờ đếm
            <InfoHint>
              Đo từ lúc kho ghi nhận đã về tới BÂY GIỜ. Nhóm cuối trùng đúng hạn {kpi.slaHours.receiveToInspect} giờ, nên số ở nhóm ấy luôn bằng ô “quá hạn đếm”
              phía trên — cùng một tập kiện, cố ý.
            </InfoHint>
          </p>
          <div className="flex flex-wrap gap-1.5 text-[12.5px]">
            {kpi.aging.map((b) => (
              <span
                key={b.key}
                className={cn(
                  "rounded-md px-2 py-0.5",
                  b.parcels === 0
                    ? "bg-muted text-muted-foreground"
                    : AGE_BUCKET_TONE[b.key] === "rose"
                      ? "bg-rose-100 text-rose-900 dark:bg-rose-950/40 dark:text-rose-200"
                      : AGE_BUCKET_TONE[b.key] === "amber"
                        ? "bg-amber-100 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
                        : "bg-emerald-100 text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200",
                )}
              >
                {b.label} · <b className="numeric">{formatNumber(b.parcels)}</b>
                {b.parcels > 0 ? <span className="opacity-70"> · cũ nhất {hoursText(b.oldestHours)}</span> : null}
              </span>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * ═══════════ BA CHỖ CHƯA ĐO ĐƯỢC — HIỆN RA, KHÔNG GIẤU ═══════════
 *
 * AGENTS.md mục 24 và 37: chỉ số chủ shop muốn mà ERP chưa đọc được phải khai `UNAVAILABLE` kèm lý
 * do và **hiện ra màn hình** — không giấu đi, không thay bằng một truy vấn gần đúng. Khối này tồn
 * tại để người quản lý biết vì sao vài ô họ mong đợi không có ở đây, và cần làm gì để có.
 */
export function WarehouseKpiGaps() {
  return (
    <SectionCard
      title={
        <span className="flex items-center gap-1.5">
          <TriangleAlert className="size-4" /> Ba chỉ số ERP chưa đo được
        </span>
      }
      description="Khai ra thay vì in thành 0 — mỗi dòng nói rõ thiếu gì để đo được"
      hint="Một ô trống có lý do đọc được thì người quản lý biết phải làm gì. Một ô in 0 thì họ tưởng đã đo và kết quả bằng không — sai theo hướng dễ chịu, và không ai đi sửa."
    >
      <div className="grid gap-2 lg:grid-cols-3">
        {RETURN_KPI_GAPS.map((g) => (
          <div key={g.key} className="rounded-md border border-dashed px-3 py-2">
            <p className="text-[12.5px] font-medium">{g.label}</p>
            <p className="mt-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-400">Đo được: {g.measured}</p>
            <p className="mt-1 text-[11px] leading-snug text-muted-foreground">{g.why}</p>
            <p className="mt-1.5 text-[11px] leading-snug">
              <span className="font-medium">Cần gì để đo được: </span>
              <span className="text-muted-foreground">{g.missingWhat}</span>
            </p>
            <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
              <span className="font-medium">Đang chặn: </span>
              {g.blocks}
            </p>
          </div>
        ))}
      </div>
    </SectionCard>
  );
}
