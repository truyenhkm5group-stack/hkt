import { CircleHelp, PackageSearch, ShieldQuestion, Wallet } from "lucide-react";
import { SectionCard } from "@/components/ui-bits";
import { StatStrip } from "@/components/stat-tile";
import { InfoHint } from "@/components/info-hint";
import { formatNumber, formatVND } from "@/lib/format";
import { COVERAGE_VERDICT_LABEL, COVERAGE_VERDICT_WHY, EVIDENCE_WHY, QUALITY_COVERAGE_MIN_PCT } from "@/lib/constants/inspection-truth";
import type { InspectionTruth } from "@/lib/queries/inspection-truth";
import { cn } from "@/lib/utils";

function pctText(v: number | null): string {
  return v === null ? "—" : `${v.toFixed(1).replace(".", ",")}%`;
}

/**
 * ═══════════ ĐỘ PHỦ CHỨNG CỨ — CON SỐ QUAN TRỌNG NHẤT CỦA CẢ TRANG ═══════════
 *
 * Khối này tồn tại để trả lời một câu mà mọi tỷ lệ chất lượng phía dưới đều phụ thuộc vào:
 * **bao nhiêu phần hàng thực sự có người nhìn vào?**
 *
 * Đo 14/09/2026: 132 trên 747 món. Nghĩa là mọi câu như "0% hỏng" hôm nay là phát biểu về 17,7%
 * số hàng, và im lặng về phần còn lại. Nên ô "hỏng" ở đây in **—** kèm nhãn, không in **0**.
 */
export function InspectionTruthSection({ truth }: { truth: InspectionTruth }) {
  const duLieuChuaDu = truth.coverage.verdict !== "ENOUGH";
  return (
    <SectionCard
      title={
        <span className="flex items-center gap-1.5">
          <PackageSearch className="size-4" /> Chứng cứ kiểm hàng
          {duLieuChuaDu ? (
            <span className="rounded-md bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-900 dark:bg-amber-950/50 dark:text-amber-200">
              {COVERAGE_VERDICT_LABEL[truth.coverage.verdict]}
            </span>
          ) : null}
        </span>
      }
      hint={
        <>
          <p>{COVERAGE_VERDICT_WHY[truth.coverage.verdict]}</p>
          <p className="mt-1">{`Một món chỉ được tính là "đã kiểm" khi có dòng kết luận RIÊNG cho nó. Kiện có phiếu tái nhập mà không có dòng món nào thì điều kiện từng món là CHƯA BIẾT — phiếu nói hàng đã vào tồn, không nói ai đã nhìn nó. Ngưỡng đủ căn cứ: ${QUALITY_COVERAGE_MIN_PCT}%.`}</p>
        </>
      }
    >
      <StatStrip
        columns={4}
        items={[
          {
            label: "Độ phủ chứng cứ",
            value: pctText(truth.coverage.pct),
            note: `${formatNumber(truth.items.withEvidence)} / ${formatNumber(truth.items.restocked)} món có kết luận riêng`,
            icon: PackageSearch,
            tone: duLieuChuaDu ? "amber" : "green",
          },
          {
            label: "Món chưa ai kết luận",
            value: formatNumber(truth.items.unknown),
            hint: "Đã vào tồn nhưng chưa xem riêng. Những món này vào lại tồn dựa trên một kết luận ở mức CẢ KIỆN. Chúng KHÔNG được coi là hàng tốt — chỉ là chưa ai xem.",
            icon: CircleHelp,
            tone: truth.items.unknown ? "amber" : "green",
          },
          {
            label: "Món kết luận là hỏng",
            /* CHƯA ĐỦ CĂN CỨ ⇒ "—". In 0 ở đây là khẳng định về phần hàng chưa ai mở ra. */
            value: truth.damagedItems === null ? "—" : formatNumber(truth.damagedItems),
            note: truth.damagedItems === null ? "chưa có chứng cứ nào" : `trên ${formatNumber(truth.items.withEvidence)} món đã xem`,
            hint: "Con số này CHỈ nói về phần hàng đã có người xem riêng. Nó không phải tỷ lệ hỏng của cả lô, và không được đọc thành “không có hàng nào hỏng”.",
            icon: ShieldQuestion,
            tone: truth.damagedItems ? "rose" : "muted",
          },
          {
            label: "Tỷ lệ hỏng",
            value: pctText(truth.damagedRate),
            note: truth.damagedRate === null ? COVERAGE_VERDICT_LABEL[truth.coverage.verdict] : "trên phần đã xem",
            hint: `Chỉ hiện khi độ phủ chứng cứ từ ${QUALITY_COVERAGE_MIN_PCT}% trở lên. Dưới ngưỡng thì một tỷ lệ tính trên phần nhỏ sẽ được đọc như tỷ lệ của cả lô — và nó luôn đẹp hơn sự thật, vì phần chưa xem mặc nhiên bị coi là tốt.`,
            icon: ShieldQuestion,
            tone: "muted",
          },
        ]}
      />

      <div className="mt-3 grid gap-2 lg:grid-cols-3">
        <EvidenceCard
          label="Có kết luận từng món"
          parcels={truth.parcels.withItemEvidence}
          total={truth.parcels.total}
          why={EVIDENCE_WHY.ITEM_CONFIRMED}
          tone="green"
        />
        <EvidenceCard
          label="Chỉ có kết luận cả kiện"
          parcels={truth.parcels.parcelLevelOnly}
          total={truth.parcels.total}
          why={EVIDENCE_WHY.PARCEL_LEVEL_ONLY}
          tone="amber"
        />
        <EvidenceCard label="Chưa ai kiểm" parcels={truth.parcels.noEvidence} total={truth.parcels.total} why={EVIDENCE_WHY.NO_EVIDENCE} tone="slate" />
      </div>

      {/* PHÂN LOẠI: chỉ đọc dòng món. "Chưa biết" luôn đứng cuối và không có tỷ lệ — nó không phải một kết luận. */}
      {truth.conditions.length ? (
        <div className="mt-3 flex flex-wrap gap-1.5 text-[12.5px]">
          {truth.conditions.map((c) => (
            <span
              key={c.condition}
              className={cn(
                "rounded-md px-2 py-0.5",
                c.condition === "UNKNOWN"
                  ? "bg-amber-100 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
                  : c.condition === "OK"
                    ? "bg-emerald-100 text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200"
                    : "bg-rose-100 text-rose-900 dark:bg-rose-950/40 dark:text-rose-200",
              )}
            >
              {c.label} · <b className="numeric">{formatNumber(c.items)}</b>
              {c.share !== null ? <span className="opacity-70"> · {c.share.toFixed(0)}%</span> : null}
            </span>
          ))}
        </div>
      ) : null}
    </SectionCard>
  );
}

function EvidenceCard({ label, parcels, total, why, tone }: { label: string; parcels: number; total: number; why: string; tone: "green" | "amber" | "slate" }) {
  return (
    <div
      className={cn(
        "rounded-md border px-3 py-2",
        parcels === 0
          ? "bg-muted/30"
          : tone === "green"
            ? "border-emerald-300 bg-emerald-50/60 dark:border-emerald-900/60 dark:bg-emerald-950/20"
            : tone === "amber"
              ? "border-amber-300 bg-amber-50/60 dark:border-amber-900/60 dark:bg-amber-950/20"
              : "bg-muted/30",
      )}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="inline-flex items-center gap-1 text-[12.5px] font-medium">
          {label}
          <InfoHint>{why}</InfoHint>
        </span>
        <b className="numeric text-lg">{formatNumber(parcels)}</b>
      </div>
      <p className="mt-0.5 text-[11px] text-muted-foreground">
        {total > 0 ? `${((parcels / total) * 100).toFixed(0)}% số kiện` : "—"}
      </p>
    </div>
  );
}

/**
 * ═══════════ GIÁ TRỊ HÀNG THU HỒI — CHỈ PHẦN BIẾT GIÁ VỐN ═══════════
 *
 * Chỉ HIỂN THỊ, không ghi một bút toán nào. Giá vốn lấy từ phiếu NHẬP KHO gần nhất của chính mẫu
 * mã — chứng từ thật, kiểm chứng lại được. Món không tra được giá vốn KHÔNG được ước lượng: nó
 * đứng riêng ở ô "chưa biết giá vốn", vì một tổng tiền trộn cả phần chưa biết là một tổng trông
 * như chính xác mà không phải.
 */
export function RecoveredValueSection({ truth }: { truth: InspectionTruth }) {
  const duGiaVon = truth.cost.unknownQty === 0;
  return (
    <SectionCard
      title={
        <span className="flex items-center gap-1.5">
          <Wallet className="size-4" /> Giá trị hàng đã thu hồi
        </span>
      }
      hint={
        <>
          <p>Chỉ tính phần BIẾT giá vốn, lấy từ phiếu nhập kho gần nhất.</p>
          <p className="mt-1">
            Đây là con số ĐỌC, không phải bút toán: bản này không ghi một dòng kế toán nào. Giá vốn không bao giờ lấy từ giá bán hay doanh thu — đó là lấy thứ khách trả làm thứ shop bỏ ra.
          </p>
          <p className="mt-1">
            <b>Chưa tính giá trị thất thoát.</b> Nó cần điều kiện CUỐI CÙNG của từng món, mà hôm nay {formatNumber(truth.items.unknown)} món chưa ai kết luận riêng —
            nhân một con số giá vốn với một điều kiện chưa biết thì ra một khoản lỗ chưa ai chứng minh được.
          </p>
          <p className="mt-1">
            Khi độ phủ chứng cứ đủ, phần này sẽ hiện giá trị của hàng kết luận KHÔNG bán lại được. Bản phát hành này cố ý dừng ở chỗ đọc số — không ghi bút toán
            kế toán nào.
          </p>
        </>
      }
    >
      <StatStrip
        columns={3}
        items={[
          {
            label: "Giá trị đã quay lại tồn",
            value: formatVND(truth.cost.knownRecoveredValue),
            note: `${formatNumber(truth.cost.qtyWithCost)} món biết giá vốn`,
            icon: Wallet,
            tone: "green",
          },
          {
            label: "Chưa biết giá vốn",
            value: formatNumber(truth.cost.unknownQty),
            note: duGiaVon ? "mọi mẫu mã đều tra được giá" : undefined,
            hint: "Món KHÔNG được ước lượng thành tiền. Món không tra được giá vốn nằm ngoài tổng tiền bên trái. Cộng chúng vào với giá 0đ sẽ làm tổng trông đầy đủ trong khi nó thiếu đúng bằng phần này.",
            icon: CircleHelp,
            tone: duGiaVon ? "green" : "amber",
          },
          {
            label: "Độ phủ giá vốn",
            value: pctText(truth.cost.coveragePct),
            note: `${formatNumber(truth.cost.qtyWithCost)} / ${formatNumber(truth.cost.restockedQty)} món`,
            icon: Wallet,
            tone: duGiaVon ? "green" : "amber",
          },
        ]}
      />
    </SectionCard>
  );
}
