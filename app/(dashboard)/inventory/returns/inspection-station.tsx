"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Barcode, Check, Loader2, PackageX, ScanLine, Trash2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ItemInspectionDrawer } from "@/app/(dashboard)/inventory/returns/item-inspection-drawer";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui-bits";
import { scanReturnByCode, submitBulkInspection, submitReturnInspection } from "@/lib/actions/returns-warehouse";
import { CONDITION_ACTION_LABEL, CONDITION_LABEL, CONDITION_NEEDS_NOTE, type ReturnCondition } from "@/lib/constants/returns-condition";
import { formatNumber } from "@/lib/format";
import type { InspectionItem } from "@/lib/returns/inspection";
import type { ItemsBasis, OrderLinkBasis } from "@/lib/returns/product-context";
import { cn } from "@/lib/utils";

/**
 * ═══════ TRẠM ĐẾM HÀNG HOÀN — MỘT MÀN HÌNH CHO CẢ VIỆC ═══════
 *
 * 453 kiện đang chờ. Ở nhịp "mở đơn ở tab khác để xem màu/size" thì đó là hơn một ngày công chỉ để
 * chuyển tab. Nên màn hình này gánh cả việc:
 *
 *  · BẮN MÃ → kiện nhảy lên đầu danh sách, tự chọn sẵn. Con trỏ luôn nằm trong ô mã, kể cả sau khi
 *    vừa xử lý xong một kiện — người đếm không bao giờ phải chạm chuột giữa hai kiện.
 *  · MỖI DÒNG hiện sẵn đơn · khách · SĐT · từng mã hàng kèm màu, size, số lượng. Không phải mở đâu cả.
 *  · MỘT CHẠM ra kết luận. "Nhận đủ" là nút to nhất vì đó là ca chiếm đa số.
 *  · HÀNG LOẠT khi nhiều kiện cùng kết luận — mở một xe hàng, mười kiện nguyên seal là một lần bấm.
 *
 * PHẢN HỒI TỨC THÌ, KHÔNG CHỜ MÁY CHỦ: kiện vừa xử lý biến khỏi danh sách ngay, rồi mới đồng bộ
 * lại phía sau. Nếu máy chủ báo lỗi thì kiện đó QUAY LẠI kèm thông báo — không mất việc, và cũng
 * không bắt người đếm đứng nhìn con quay 300ms mỗi kiện.
 */

export type Row = {
  shipmentId: string;
  code: string | null;
  orderId: string | null;
  orderCode: string | null;
  customerName: string;
  customerPhone: string;
  receivedBy: string;
  /** `null` = chưa ghép được đơn ⇒ CHƯA BIẾT số kỳ vọng, không phải 0. */
  expectedQty: number | null;
  itemsBasis: ItemsBasis;
  linkBasis: OrderLinkBasis;
  ageDays: number;
  items: InspectionItem[];
};

/** Kiện không có dòng hàng để đếm: nói đúng VÌ SAO — chưa ghép được đơn khác hẳn đơn không còn hàng. */
const KHONG_DONG_HANG: Record<OrderLinkBasis, string> = {
  AMBIGUOUS: "Mã gốc lần ra NHIỀU đơn — ERP không chọn hộ. Đếm theo thực tế, ghi rõ mã hàng ở ô lý do; CS gắn đơn sau.",
  UNRESOLVED: "Chưa lần ra đơn nào cho kiện này — đếm theo thực tế và ghi rõ mã hàng ở ô lý do.",
  DIRECT: "Đơn không còn dòng hàng nào trong ERP — đếm theo thực tế và ghi rõ ở ô lý do.",
  RETURN_LEG: "Đơn không còn dòng hàng nào trong ERP — đếm theo thực tế và ghi rõ ở ô lý do.",
};

const NHANH: { condition: ReturnCondition; icon: typeof Check; tone: string }[] = [
  { condition: "RESTOCKABLE", icon: Check, tone: "bg-emerald-600 hover:bg-emerald-700 text-white" },
  { condition: "MISSING", icon: TriangleAlert, tone: "" },
  { condition: "DAMAGED", icon: PackageX, tone: "" },
  { condition: "WRONG_ITEM", icon: Barcode, tone: "" },
];

export function InspectionStation({ rows: initial, canWrite }: { rows: Row[]; canWrite: boolean }) {
  const router = useRouter();
  const [rows, setRows] = React.useState<Row[]>(initial);
  const [chon, setChon] = React.useState<Set<string>>(new Set());
  const [ma, setMa] = React.useState("");
  const [lyDo, setLyDo] = React.useState("");
  const [dangChay, setDangChay] = React.useState(false);
  const oMa = React.useRef<HTMLInputElement>(null);

  // Danh sách phía máy chủ đổi (sau refresh) thì lấy lại — nhưng KHÔNG đè lên phần vừa xử lý cục bộ.
  React.useEffect(() => setRows(initial), [initial]);

  /** Con trỏ LUÔN quay về ô mã. Đây là thứ giữ nhịp bắn mã liên tục không cần chạm chuột. */
  const tuTuMa = React.useCallback(() => {
    requestAnimationFrame(() => oMa.current?.focus());
  }, []);

  React.useEffect(() => {
    tuTuMa();
  }, [tuTuMa]);

  const boKien = (id: string) => {
    setRows((r) => r.filter((x) => x.shipmentId !== id));
    setChon((c) => {
      const n = new Set(c);
      n.delete(id);
      return n;
    });
  };

  async function quet(e: React.FormEvent) {
    e.preventDefault();
    const q = ma.trim();
    if (!q) return;
    setDangChay(true);
    const r = await scanReturnByCode(q);
    setDangChay(false);
    setMa("");
    tuTuMa();
    if ("error" in r) {
      toast.error(r.error);
      return;
    }
    const found = r.found;
    // Đưa lên ĐẦU danh sách và chọn sẵn: bắn xong là mắt nhìn thấy ngay, tay bấm được ngay.
    setRows((prev) => [found as Row, ...prev.filter((x) => x.shipmentId !== found.shipmentId)]);
    setChon((c) => new Set(c).add(found.shipmentId));
    toast.success(`Đã tìm thấy ${found.code ?? found.shipmentId}`);
  }

  async function motKien(row: Row, condition: ReturnCondition, soLuong?: number) {
    if (!canWrite) return;
    if (CONDITION_NEEDS_NOTE[condition] && !lyDo.trim()) {
      toast.error(`Kết luận “${CONDITION_LABEL[condition]}” phải ghi lý do ở ô bên dưới trước khi bấm`);
      return;
    }
    // Không biết số kỳ vọng (kiện chưa ghép được đơn) thì KHÔNG được suy ra số nào — phải có số đếm tay.
    if (row.expectedQty === null && soLuong === undefined) {
      toast.error("Kiện này chưa ghép được đơn nên không biết số kỳ vọng — nhập số đếm được rồi mới kết luận");
      return;
    }
    const expected = row.expectedQty ?? soLuong ?? 0;
    const restock = condition === "RESTOCKABLE" ? (soLuong ?? expected) : 0;
    const unsellable = condition === "RESTOCKABLE" ? Math.max(0, expected - restock) : expected;

    // Biến mất NGAY. Máy chủ chạy phía sau.
    boKien(row.shipmentId);
    tuTuMa();

    const r = await submitReturnInspection({
      shipmentId: row.shipmentId,
      condition,
      restockQty: restock,
      unsellableQty: unsellable,
      note: lyDo.trim(),
    });
    if ("error" in r) {
      // Trả kiện về đúng chỗ cũ — không mất việc.
      setRows((prev) => [row, ...prev]);
      toast.error(`${row.code ?? row.shipmentId}: ${r.error}`);
      return;
    }
    toast.success(r.message);
    router.refresh();
  }

  async function hangLoat(condition: ReturnCondition) {
    if (!canWrite || !chon.size) return;
    if (CONDITION_NEEDS_NOTE[condition] && !lyDo.trim()) {
      toast.error(`Kết luận “${CONDITION_LABEL[condition]}” phải ghi lý do trước khi xử lý hàng loạt`);
      return;
    }
    const ids = [...chon];
    const giuLai = rows.filter((x) => chon.has(x.shipmentId));
    setRows((r) => r.filter((x) => !chon.has(x.shipmentId)));
    setChon(new Set());
    setDangChay(true);
    const r = await submitBulkInspection({ shipmentIds: ids, condition, note: lyDo.trim() });
    setDangChay(false);
    tuTuMa();
    if ("error" in r) {
      setRows((prev) => [...giuLai, ...prev]);
      toast.error(r.error);
      return;
    }
    // Kiện nào hỏng thì QUAY LẠI danh sách kèm tên — không nuốt lỗi.
    if (r.failed.length) {
      const hong = new Set(r.failed.map((f) => f.shipmentId));
      setRows((prev) => [...giuLai.filter((x) => hong.has(x.shipmentId)), ...prev]);
      toast.error(`${r.message}: ${r.failed.slice(0, 3).map((f) => f.error).join(" · ")}`);
    } else {
      toast.success(r.message);
    }
    router.refresh();
  }

  const tatCa = rows.length > 0 && chon.size === rows.length;

  return (
    <div className="space-y-4">
      {/* ── Ô BẮN MÃ ── */}
      <form onSubmit={quet} className="flex flex-wrap items-center gap-2 rounded-xl border bg-card p-3">
        <ScanLine className="size-5 shrink-0 text-primary" />
        <Input
          ref={oMa}
          value={ma}
          onChange={(e) => setMa(e.target.value)}
          placeholder="Bắn mã vận đơn hoặc mã đơn rồi Enter…"
          className="h-10 min-w-[240px] flex-1 font-mono text-sm"
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="search"
        />
        <Button type="submit" className="h-10" disabled={dangChay || !ma.trim()}>
          {dangChay ? <Loader2 className="size-4 animate-spin" /> : "Tìm kiện"}
        </Button>
        <span className="text-[12px] text-muted-foreground">Con trỏ tự về ô này sau mỗi lần xử lý — bắn liên tục không cần chạm chuột.</span>
      </form>

      {/* ── Ô LÝ DO dùng chung: mọi kết luận KHÔNG vào tồn đều bắt buộc có ── */}
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={lyDo}
          onChange={(e) => setLyDo(e.target.value)}
          placeholder="Lý do / bằng chứng (bắt buộc khi kết luận không phải “nhận đủ”)"
          className="h-9 min-w-[260px] flex-1 text-sm"
        />
        {lyDo ? (
          <Button variant="ghost" size="sm" className="h-9" onClick={() => setLyDo("")}>
            <Trash2 className="size-4" /> Xoá lý do
          </Button>
        ) : null}
      </div>

      {/* ── THANH HÀNG LOẠT ── */}
      {chon.size > 0 && canWrite ? (
        <div className="sticky top-2 z-20 flex flex-wrap items-center gap-2 rounded-xl border border-primary/40 bg-primary/5 p-3 shadow-sm">
          <span className="text-sm font-semibold">Đã chọn {chon.size} kiện</span>
          {NHANH.map(({ condition, icon: Icon, tone }) => (
            <Button key={condition} size="sm" className={cn("h-9", tone)} variant={condition === "RESTOCKABLE" ? "default" : "outline"} disabled={dangChay} onClick={() => hangLoat(condition)}>
              <Icon className="size-4" /> {CONDITION_ACTION_LABEL[condition]}
            </Button>
          ))}
          <Button size="sm" variant="ghost" className="h-9" onClick={() => setChon(new Set())}>
            Bỏ chọn
          </Button>
          <span className="text-[12px] text-muted-foreground">“Nhận đủ” hàng loạt = đúng bằng số ERP đã xuất; muốn khai số khác thì đếm từng kiện.</span>
        </div>
      ) : null}

      {/* ── DANH SÁCH ── */}
      {rows.length === 0 ? (
        <EmptyState title="Không còn kiện nào chờ đếm" description="Mọi kiện đã về kho đều đã được đếm. Kiện mới sẽ hiện ở đây khi kho bấm “đã nhận”." />
      ) : (
        <div className="space-y-2">
          <label className="flex items-center gap-2 px-1 text-[12.5px] text-muted-foreground">
            <input type="checkbox" checked={tatCa} onChange={(e) => setChon(e.target.checked ? new Set(rows.map((r) => r.shipmentId)) : new Set())} className="size-4" />
            Chọn tất cả {rows.length} kiện đang hiện
          </label>
          {rows.map((row) => (
            <KienHang
              key={row.shipmentId}
              row={row}
              chon={chon.has(row.shipmentId)}
              canWrite={canWrite}
              onChon={(v) =>
                setChon((c) => {
                  const n = new Set(c);
                  if (v) n.add(row.shipmentId);
                  else n.delete(row.shipmentId);
                  return n;
                })
              }
              onKetLuan={(condition, qty) => motKien(row, condition, qty)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function KienHang({
  row,
  chon,
  canWrite,
  onChon,
  onKetLuan,
}: {
  row: Row;
  chon: boolean;
  canWrite: boolean;
  onChon: (v: boolean) => void;
  onKetLuan: (condition: ReturnCondition, qty?: number) => void;
}) {
  const [qty, setQty] = React.useState(row.expectedQty === null ? "" : String(row.expectedQty));
  const soDem = Math.max(0, Math.trunc(Number(qty) || 0));
  /** `null` = không có mốc để so (chưa biết kỳ vọng). */
  const thieu = row.expectedQty === null ? null : row.expectedQty - soDem;

  return (
    <div className={cn("rounded-xl border bg-card p-3 transition-colors", chon && "border-primary/50 bg-primary/5", row.ageDays >= 7 && "border-l-4 border-l-rose-500")}>
      <div className="flex flex-wrap items-start gap-3">
        <input type="checkbox" checked={chon} onChange={(e) => onChon(e.target.checked)} className="mt-1 size-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm font-semibold">{row.code ?? row.shipmentId}</span>
            {row.orderCode ? <Badge variant="outline" className="text-[11px]">Đơn {row.orderCode}</Badge> : null}
            <Badge variant={row.ageDays >= 7 ? "destructive" : row.ageDays >= 3 ? "secondary" : "outline"} className="text-[11px]">
              chờ {row.ageDays} ngày
            </Badge>
            <span className="text-[12px] text-muted-foreground">
              {row.customerName || "—"}
              {row.customerPhone ? ` · ${row.customerPhone}` : ""} · kho nhận bởi {row.receivedBy || "—"}
            </span>
          </div>

          {/* Từng mã hàng kèm màu / size — thứ người đếm cần nhìn khi mở kiện ra. */}
          <div className="mt-2 flex flex-wrap gap-1.5">
            {row.items.length === 0 ? (
              <span className="text-[12px] text-muted-foreground">{KHONG_DONG_HANG[row.linkBasis]}</span>
            ) : (
              row.items.map((it, i) => (
                <span key={`${it.sku}-${i}`} className="rounded-md border bg-muted/40 px-2 py-1 text-[12px]">
                  <b className="font-mono">{it.sku || it.name}</b>
                  {it.color ? ` · ${it.color}` : ""}
                  {it.size ? ` · ${it.size}` : ""}
                  <b className="ml-1">×{it.quantity}</b>
                </span>
              ))
            )}
          </div>
        </div>

        {canWrite ? (
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1">
              <span className="text-[12px] text-muted-foreground">Đếm được</span>
              <Input value={qty} onChange={(e) => setQty(e.target.value)} inputMode="numeric" className="h-9 w-16 text-center font-mono text-sm" />
              <span className="text-[12px] text-muted-foreground" title={row.expectedQty === null ? "Chưa ghép được đơn — không biết số kỳ vọng" : undefined}>/ {row.expectedQty === null ? "—" : formatNumber(row.expectedQty)}</span>
            </div>
            {/* "Nhận đủ" đổi nghĩa theo ô đếm: đếm thiếu thì nút tự nói ra phần thiếu, không im lặng cộng đủ. */}
            <Button size="sm" className="h-9 bg-emerald-600 text-white hover:bg-emerald-700" onClick={() => onKetLuan("RESTOCKABLE", soDem)} disabled={soDem <= 0}>
              <Check className="size-4" /> {thieu === null ? `Nhận ${soDem} (chưa có mốc kỳ vọng)` : thieu > 0 ? `Nhận ${soDem}, hụt ${thieu}` : "Nhận đủ"}
            </Button>
            {/* Kiện chưa ghép được đơn: số "không bán được" là số ĐẾM TAY, không có mốc kỳ vọng nào để suy. */}
            {NHANH.filter((n) => n.condition !== "RESTOCKABLE").map(({ condition, icon: Icon }) => (
              <Button key={condition} size="sm" variant="outline" className="h-9" onClick={() => onKetLuan(condition, row.expectedQty === null && soDem > 0 ? soDem : undefined)}>
                <Icon className="size-4" /> {CONDITION_ACTION_LABEL[condition]}
              </Button>
            ))}
            {/*
              ĐƯỜNG THỨ HAI, KHÔNG THAY ĐƯỜNG THỨ NHẤT.
              Các nút trên là đếm nhanh CẢ KIỆN — đúng cho kiện một mẫu mã, và đó là đa số. Kiện
              nhiều món mà mỗi món một tình trạng thì ép về một kết luận là mất thông tin, nên có
              lối riêng vào ngăn kéo đếm từng món. Chỉ hiện khi kiện thực sự có dòng hàng để đếm.
            */}
            {row.items.length ? (
              <ItemInspectionDrawer
                shipmentId={row.shipmentId}
                code={row.code}
                orderCode={row.orderCode}
                itemsBasis={row.itemsBasis}
                items={row.items.map((it) => ({ variantId: it.variantId ?? null, sku: it.sku, name: it.name, color: it.color, size: it.size, quantity: it.quantity }))}
              />
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
