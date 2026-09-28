"use client";

import { Copy, ExternalLink } from "lucide-react";
import { createContext, useContext, useMemo, useState } from "react";
import { toast } from "sonner";
import { InfoHint } from "@/components/info-hint";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useRiskVisible } from "@/app/(dashboard)/products/reserved/risk-view";
import { pancakePosOrderBatches } from "@/lib/constants/pancake";
import { formatNumber } from "@/lib/format";

/**
 * ═══════════ CHỌN ĐƠN CÓ HÀNG → MỞ ĐÚNG CÁC ĐƠN ĐÓ TRÊN POS ĐỂ ĐẨY SANG VIETTEL POST ═══════════
 *
 * ERP KHÔNG đẩy đơn sang ĐVVC (API Pancake không có lệnh đó, và AGENTS.md mục 3.11: không ghi ngược
 * vào Pancake). Việc của trang này là trả lời "đơn nào có hàng để đóng" rồi mở POS lọc sẵn đúng các
 * đơn ấy, để người bấm dùng tính năng đẩy nhiều đơn cùng lúc của POS.
 *
 * Mặc định chọn sẵn đơn CHƯA có vận đơn: đơn đã có mã vận đơn là đã đẩy rồi, chỉ đang chờ bưu tá tới
 * lấy — đẩy lại là tạo vận đơn trùng. Vẫn chọn tay được nếu người bấm biết mình đang làm gì.
 *
 * Chỉ đơn ĐANG HIỆN theo bộ lọc rủi ro (`useRiskVisible`) mới tính là đã chọn: lọc "Ít rủi ro" rồi
 * bấm mở POS thì đơn rủi ro cao đã tích từ trước KHÔNG lọt vào link.
 */
export type PosCandidate = { orderId: string; systemId: number | null; shopId: string | null; hasShipment: boolean };

type Ctx = { selected: Set<string>; toggle: (orderId: string, on: boolean) => void; candidates: PosCandidate[]; setAll: (ids: string[]) => void };
const PosPushContext = createContext<Ctx | null>(null);

export function PosPushProvider({ candidates, children }: { candidates: PosCandidate[]; children: React.ReactNode }) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set(candidates.filter((c) => !c.hasShipment).map((c) => c.orderId)));
  const value = useMemo<Ctx>(
    () => ({
      selected,
      candidates,
      toggle: (orderId, on) =>
        setSelected((cur) => {
          const next = new Set(cur);
          if (on) next.add(orderId);
          else next.delete(orderId);
          return next;
        }),
      setAll: (ids) => setSelected(new Set(ids)),
    }),
    [selected, candidates],
  );
  return <PosPushContext.Provider value={value}>{children}</PosPushContext.Provider>;
}

function usePosPush(): Ctx {
  const ctx = useContext(PosPushContext);
  if (!ctx) throw new Error("PosPush* phải nằm trong PosPushProvider");
  return ctx;
}

export function PosPushCheckbox({ orderId, systemId }: { orderId: string; systemId: number | null }) {
  const { selected, toggle } = usePosPush();
  return <Checkbox checked={selected.has(orderId)} onCheckedChange={(v) => toggle(orderId, v === true)} aria-label={`Chọn đơn #${systemId ?? orderId} để mở trên POS`} />;
}

export function PosPushSelectAll() {
  const { selected, candidates, setAll } = usePosPush();
  const visible = useRiskVisible();
  const shown = candidates.filter((c) => visible(c.orderId));
  const all = shown.length > 0 && shown.every((c) => selected.has(c.orderId));
  const some = !all && shown.some((c) => selected.has(c.orderId));
  return <Checkbox checked={all ? true : some ? "indeterminate" : false} onCheckedChange={(v) => setAll(v === true ? shown.map((c) => c.orderId) : [])} aria-label="Chọn tất cả đơn có hàng đang hiện" />;
}

export function PosPushBar() {
  const { selected, candidates, setAll } = usePosPush();
  const visible = useRiskVisible();
  const shown = candidates.filter((c) => visible(c.orderId));
  const chosen = shown.filter((c) => selected.has(c.orderId));
  const { batches, skipped } = pancakePosOrderBatches(chosen);
  const withShipment = chosen.filter((c) => c.hasShipment).length;
  const notPushed = shown.filter((c) => !c.hasShipment).map((c) => c.orderId);

  const copyIds = async () => {
    try {
      await navigator.clipboard.writeText(chosen.map((c) => c.systemId ?? c.orderId).join(" "));
      toast.success(`Đã sao chép ${formatNumber(chosen.length)} số đơn — dán vào ô tìm kiếm đơn của POS`);
    } catch {
      toast.error("Trình duyệt không cho sao chép");
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs text-muted-foreground">
        Đã chọn <b className="text-foreground">{formatNumber(chosen.length)}</b>/{formatNumber(shown.length)} đơn{shown.length < candidates.length ? " đang hiện" : ""}
        {withShipment ? <span className="text-amber-700 dark:text-amber-300"> · {formatNumber(withShipment)} đơn ĐÃ có vận đơn</span> : null}
      </span>
      <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setAll(notPushed)}>
        Chọn đơn chưa đẩy VTP
      </Button>
      {batches.map((b, i) => (
        <Button key={`${b.shopId}-${i}`} asChild size="sm">
          <a href={b.url} target="_blank" rel="noreferrer" title={`Mở danh sách đơn trên POS lọc sẵn ${b.systemIds.length} đơn: ${b.systemIds.join(" ")}`}>
            <ExternalLink className="size-4" /> Mở {formatNumber(b.systemIds.length)} đơn trên POS{batches.length > 1 ? ` (lượt ${i + 1})` : ""}
          </a>
        </Button>
      ))}
      <Button variant="outline" size="sm" onClick={copyIds} disabled={!chosen.length}>
        <Copy className="size-4" /> Sao chép số đơn
      </Button>
      <InfoHint label="Cách đẩy sang Viettel Post">
        <p>Bấm &ldquo;Mở … đơn trên POS&rdquo;: POS mở danh sách đơn lọc sẵn đúng các số đơn đã chọn. Trên POS, tích chọn tất cả rồi dùng tính năng đẩy nhiều đơn sang Viettel Post — sau đó kho in đơn và đóng hàng.</p>
        <p className="mt-1.5">Đơn đã có mã vận đơn không được chọn sẵn: đẩy lại là tạo vận đơn trùng. Mỗi lượt tối đa 50 đơn để vừa một trang POS.</p>
        <p className="mt-1.5">Nếu POS không lọc đúng danh sách, bấm &ldquo;Sao chép số đơn&rdquo; rồi dán vào ô tìm kiếm đơn của POS.</p>
        {skipped ? <p className="mt-1.5">{formatNumber(skipped)} đơn đã chọn thiếu mã shop / số đơn Pancake nên không đưa được vào link.</p> : null}
      </InfoHint>
    </div>
  );
}
