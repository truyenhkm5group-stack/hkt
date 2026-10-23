import { SOURCING_FX_STALE_DAYS } from "@/lib/constants/sourcing";
import { formatVND } from "@/lib/format";
import { LANDED_PARTS, LANDED_PART_LABEL, type LandedCost } from "@/lib/sourcing/landed-cost";

/**
 * Một ô giá về Việt Nam (SRC-4): tổng ƯỚC TÍNH, hai căn cứ (giá mua — căn cứ phí mua hộ; trị giá CIF — căn cứ thuế) và từng khoản
 * trong `<details>`. Thiếu ⇒ «—» kèm lý do, không bao giờ một số mặc định. Không tô màu, không xếp hạng.
 */
export function LandedCostCell({ value }: { value: LandedCost }) {
  if (value.kind === "NO_PRICE") return <span className="text-xs text-muted-foreground">— · {value.reason}</span>;
  if (value.kind === "BELOW_MOQ")
    return (
      <span className="text-xs text-muted-foreground">
        — · dưới MOQ ({value.moq} cái), không tính
      </span>
    );
  return (
    <div className="space-y-1" data-landed-cost>
      <div className="font-medium tabular-nums">
        {value.totalVnd === null ? "—" : formatVND(value.totalVnd)}
        <span className="ml-1 text-[11px] font-normal text-muted-foreground">ước tính</span>
      </div>
      {value.missing.length ? <div className="text-[11px] text-amber-700 dark:text-amber-300">Chưa tính được: {value.missing.join(" · ")}.</div> : null}
      {value.fxStale ? <div className="text-[11px] text-amber-700 dark:text-amber-300">Tỷ giá đã quá {SOURCING_FX_STALE_DAYS} ngày.</div> : null}
      <details className="text-[11px] text-muted-foreground">
        <summary className="cursor-pointer select-none">Từng khoản</summary>
        <ul className="mt-1 space-y-0.5">
          {LANDED_PARTS.map((k) => (
            <li key={k} className="flex justify-between gap-2">
              <span>{LANDED_PART_LABEL[k]}</span>
              <span className="tabular-nums">{value.parts[k].vnd === null ? "—" : formatVND(value.parts[k].vnd)}</span>
            </li>
          ))}
        </ul>
        <p className="mt-1">
          Phí mua hộ tính trên giá mua ({value.bases.purchaseVnd === null ? "—" : formatVND(value.bases.purchaseVnd)}). Thuế / phí nhập tính trên trị giá CIF = giá mua + cước nội địa + cước Trung Quốc → Việt Nam (
          {value.bases.cifVnd === null ? "—" : formatVND(value.bases.cifVnd)}).
        </p>
        {value.dutyDeclaredZero ? <p className="mt-1">Thuế khai 0% — thường là đơn vị vận chuyển báo giá «bao thuế theo kg», khi đó cước / kg đã gồm thuế.</p> : null}
      </details>
    </div>
  );
}
