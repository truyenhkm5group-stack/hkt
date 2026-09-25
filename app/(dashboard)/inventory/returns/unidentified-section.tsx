"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Boxes, Check, HelpCircle, Link2, Loader2, PackageSearch, Search, ShieldAlert, Tag } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { InfoHint } from "@/components/info-hint";
import {
  createUnidentifiedReturnAction,
  identifyUnidentifiedReturnAction,
  markUnidentifiableAction,
  restockUnidentifiedReturnAction,
  searchReturnCandidatesAction,
  searchVariantsAction,
  setUnidentifiedConditionAction,
} from "@/lib/actions/returns-unidentified";
import { ITEM_CONDITION_LABEL, ITEM_CONDITION_RESTOCKS, type ItemCondition } from "@/lib/constants/return-lifecycle";
import {
  CONFIDENCE_HINT,
  CONFIDENCE_LABEL,
  SIGNAL_LABEL,
  type Candidate,
  type CandidateSignal,
  type Confidence,
} from "@/lib/constants/return-match";
import {
  UNIDENTIFIED_SOURCE_HINT,
  UNIDENTIFIED_SOURCE_LABEL,
  UNIDENTIFIED_SOURCES,
  UNIDENTIFIED_STATUS_LABEL,
  type UnidentifiedSource,
  type UnidentifiedStatus,
} from "@/lib/constants/return-unidentified";
import type { UnidentifiedRow, UnidentifiedSummary, VariantOption } from "@/lib/returns/unidentified";
import { formatDateTime, formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * ═══════════ HÀNG HOÀN KHÔNG CÒN MÃ VẬN ĐƠN ═══════════
 *
 * Người kho cầm một cái áo. Nhãn mất. Trước bản này màn hình không có chỗ nào cho tình huống ấy,
 * nên họ chỉ còn hai đường — chọn đại một đơn gần giống, hoặc lập một phiếu nhập kho thường. Cả
 * hai đều làm sổ nói dối, và cả hai đều KHÔNG để lại dấu vết nào cho người đọc sổ về sau.
 *
 * Màn hình này tách đúng ba câu hỏi mà kho phải trả lời, theo đúng thứ tự:
 *
 *   1. TRONG TAY TÔI LÀ GÌ  — mẫu mã, số lượng, tình trạng. Ghi được ngay, không cần biết của ai.
 *   2. NÓ CỦA ĐƠN NÀO       — tra ứng viên, NGƯỜI chọn. Máy không bao giờ chọn hộ.
 *   3. CÓ ĐƯỢC VÀO TỒN KHÔNG — một lượt bấm riêng, có người chịu trách nhiệm.
 *
 * Gộp bất kỳ hai bước nào là quay lại đúng chỗ cũ: ERP khẳng định một thứ mà chưa ai kiểm.
 *
 * ─── VÌ SAO GHI TRƯỚC, TRA SAU ───
 *
 * Kiện hàng đã nằm trên bàn rồi. Bắt người kho tra ra đơn TRƯỚC khi được ghi nhận nghĩa là những
 * kiện khó nhất — đúng những kiện cần theo dõi nhất — sẽ không bao giờ vào sổ. Nên bước 1 đứng
 * một mình được, và `UR-…` là cái nhãn viết tay thay cho mã vận đơn đã mất.
 */

const TONE_STATUS: Record<UnidentifiedStatus, string> = {
  PENDING_IDENTIFICATION: "bg-warning/15 text-amber-700 dark:text-amber-300",
  IDENTIFIED: "bg-emerald-500/12 text-emerald-700 dark:text-emerald-400",
  UNIDENTIFIABLE: "bg-destructive/10 text-destructive",
};

const TONE_CONF: Record<Confidence, string> = {
  HIGH: "bg-emerald-600 text-white",
  MEDIUM: "bg-amber-500 text-white",
  LOW: "bg-muted text-muted-foreground",
};

/**
 * BỐN KẾT LUẬN LỚN CỦA KHO, ánh xạ vào `ITEM_CONDITIONS` đã có.
 *
 * Cố ý KHÔNG dựng một danh sách trạng thái thứ hai (SELLABLE / REWORK / DEFECT / MISMATCH) song
 * song với `ITEM_CONDITIONS`: một món hoàn là một món hoàn, dù nó đến kèm mã vận đơn hay không, và
 * hai danh sách cho cùng một thứ thì sớm muộn lệch nhau. Đây chỉ là NHÃN NÚT BẤM.
 */
const KET_LUAN: { condition: ItemCondition; nhan: string; giaiThich: string }[] = [
  { condition: "OK", nhan: "Bán lại được", giaiThich: "Hàng còn nguyên, bán lại ngay được. Đây là kết luận duy nhất có thể đưa hàng vào tồn." },
  { condition: "DIRTY", nhan: "Cần làm lại", giaiThich: "Giặt / ủi / đóng gói lại / sửa nhẹ. KHÔNG vào tồn cho tới khi làm xong và đổi kết luận sang “Bán lại được”." },
  { condition: "DAMAGED", nhan: "Hàng lỗi", giaiThich: "Rách, hỏng, không bán lại được. Không vào tồn." },
  { condition: "WRONG_ITEM", nhan: "Không phải hàng của shop", giaiThich: "Món này không nằm trong danh mục, hoặc là hàng của người khác. Không vào tồn." },
];

// ───────────────────────── Ô CHỌN MẪU MÃ ─────────────────────────

/**
 * TRA MẪU MÃ THEO TỪ KHOÁ, KHÔNG TẢI CẢ DANH MỤC.
 *
 * Danh mục vài nghìn mẫu mã nhồi vào HTML mỗi lượt tải trang là trả tiền cho thứ người kho chỉ gõ
 * hai chữ là xong — và bàn nhận hàng hoàn mở suốt ca.
 */
function VariantPicker({ value, onPick }: { value: VariantOption | null; onPick: (v: VariantOption | null) => void }) {
  const [q, setQ] = React.useState("");
  const [rows, setRows] = React.useState<VariantOption[]>([]);
  const [dangTim, setDangTim] = React.useState(false);

  React.useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setRows([]);
      return;
    }
    // Gõ tới đâu tìm tới đó, nhưng chờ 300ms: mỗi ký tự một lượt truy vấn là bắt máy chủ trả tiền
    // cho từng nhịp bàn phím.
    const t = setTimeout(async () => {
      setDangTim(true);
      const r = await searchVariantsAction(term);
      setDangTim(false);
      setRows(r);
    }, 300);
    return () => clearTimeout(t);
  }, [q]);

  if (value) {
    return (
      <div className="flex items-center gap-2 rounded-lg border bg-muted/40 p-2 text-[12.5px]">
        <Tag className="size-4 shrink-0 text-primary" />
        <span className="min-w-0 flex-1">
          <span className="font-medium">{value.sku || value.name}</span>
          {[value.color, value.size].filter(Boolean).length ? <span className="text-muted-foreground"> · {[value.color, value.size].filter(Boolean).join(" / ")}</span> : null}
          <span className="block text-[11.5px] text-muted-foreground">{value.name}</span>
        </span>
        <Button type="button" variant="ghost" size="sm" className="h-7" onClick={() => onPick(null)}>
          Đổi
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Gõ mã hàng / tên / màu / size để tìm mẫu mã…" className="h-9" autoComplete="off" />
      {dangTim ? <p className="text-[11.5px] text-muted-foreground">Đang tìm…</p> : null}
      {rows.length ? (
        <div className="max-h-48 space-y-1 overflow-y-auto rounded-lg border p-1">
          {rows.map((v) => (
            <button
              key={v.id}
              type="button"
              onClick={() => onPick(v)}
              className="block w-full rounded-md px-2 py-1.5 text-left text-[12.5px] hover:bg-accent"
            >
              <span className="font-medium">{v.sku || v.name}</span>
              {[v.color, v.size].filter(Boolean).length ? <span className="text-muted-foreground"> · {[v.color, v.size].filter(Boolean).join(" / ")}</span> : null}
              <span className="block text-[11px] text-muted-foreground">{v.name}</span>
            </button>
          ))}
        </div>
      ) : q.trim().length >= 2 && !dangTim ? (
        <p className="text-[11.5px] text-muted-foreground">
          Không thấy mẫu mã nào khớp. <span className="font-medium">Để trống cũng được</span> — kiện vẫn ghi nhận được, chỉ là chưa vào tồn được cho tới khi chọn mẫu mã.
        </p>
      ) : null}
    </div>
  );
}

// ───────────────────────── TRA ỨNG VIÊN ─────────────────────────

function SignalChips({ signals }: { signals: CandidateSignal[] }) {
  return (
    <span className="flex flex-wrap gap-1">
      {signals.map((s) => (
        <span key={s} className="rounded bg-muted px-1.5 py-0.5 text-[10.5px]">
          {SIGNAL_LABEL[s]}
        </span>
      ))}
    </span>
  );
}

/**
 * TRA ĐƠN CHO MỘT KIỆN MẤT NHÃN.
 *
 * Ứng viên hiện kèm BẰNG CHỨNG đã khớp, không chỉ một điểm số. Điểm số một mình luôn chọn được ra
 * một đơn và luôn trông thuyết phục — kể cả khi toàn bộ căn cứ chỉ là "mã hàng này bán chạy".
 */
function CandidateFinder({
  seed,
  onPick,
  picked,
}: {
  seed: { sku: string; color: string; size: string };
  picked: Candidate | null;
  onPick: (c: Candidate | null) => void;
}) {
  const [f, setF] = React.useState({ tracking: "", orderCode: "", phone: "", customerName: "", ...seed });
  const [rows, setRows] = React.useState<Candidate[] | null>(null);
  const [dangTim, setDangTim] = React.useState(false);
  const [loi, setLoi] = React.useState("");

  React.useEffect(() => setF((x) => ({ ...x, ...seed })), [seed]);

  async function tim() {
    setDangTim(true);
    setLoi("");
    const r = await searchReturnCandidatesAction(f);
    setDangTim(false);
    if ("error" in r) {
      setRows(null);
      setLoi(r.error);
      return;
    }
    setRows(r.rows);
    if (!r.rows.length) setLoi("Không có đơn nào khớp. Thử bỏ bớt một ô, hoặc tạo kiện chưa xác định rồi tra lại sau.");
  }

  if (picked) {
    return (
      <div className="space-y-2 rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-2.5 text-[12.5px]">
        <div className="flex items-start gap-2">
          <Link2 className="mt-0.5 size-4 shrink-0 text-emerald-600" />
          <div className="min-w-0 flex-1">
            <p className="font-medium">
              Sẽ nối với vận đơn <span className="font-mono">{picked.code ?? picked.shipmentId}</span>
            </p>
            <p className="text-muted-foreground">
              {picked.receiverName || "—"} · {picked.receiverPhone || "—"}
              {picked.orderCode ? ` · đơn ${picked.orderCode}` : ""}
            </p>
            <SignalChips signals={picked.signals} />
          </div>
          <Button type="button" variant="ghost" size="sm" className="h-7" onClick={() => onPick(null)}>
            Bỏ chọn
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="grid gap-2 sm:grid-cols-2">
        <Input value={f.tracking} onChange={(e) => setF({ ...f, tracking: e.target.value })} placeholder="Phần mã vận đơn còn đọc được" className="h-9 font-mono" autoComplete="off" />
        <Input value={f.orderCode} onChange={(e) => setF({ ...f, orderCode: e.target.value })} placeholder="Mã đơn Pancake" className="h-9 font-mono" autoComplete="off" />
        <Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} placeholder="Số điện thoại khách" className="h-9" autoComplete="off" inputMode="tel" />
        <Input value={f.customerName} onChange={(e) => setF({ ...f, customerName: e.target.value })} placeholder="Tên khách" className="h-9" autoComplete="off" />
        <Input value={f.sku} onChange={(e) => setF({ ...f, sku: e.target.value })} placeholder="Mã hàng" className="h-9" autoComplete="off" />
        <div className="grid grid-cols-2 gap-2">
          <Input value={f.color} onChange={(e) => setF({ ...f, color: e.target.value })} placeholder="Màu" className="h-9" autoComplete="off" />
          <Input value={f.size} onChange={(e) => setF({ ...f, size: e.target.value })} placeholder="Size" className="h-9" autoComplete="off" />
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Button type="button" size="sm" className="h-9" onClick={() => void tim()} disabled={dangTim}>
          {dangTim ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
          Tìm đơn khớp
        </Button>
        <span className="text-[11.5px] text-muted-foreground">Không cần điền hết. Một ô định danh (mã / SĐT) đáng giá hơn cả ba ô mô tả cộng lại.</span>
      </div>

      {loi ? <p className="rounded-md bg-muted px-2 py-1.5 text-[11.5px] text-muted-foreground">{loi}</p> : null}

      {rows?.length ? (
        <div className="max-h-72 space-y-1.5 overflow-y-auto rounded-lg border p-1.5">
          {rows.map((c) => (
            <div key={c.shipmentId} className="rounded-md border bg-background p-2 text-[12.5px]">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className={cn("rounded px-1.5 py-0.5 text-[10.5px] font-medium", TONE_CONF[c.confidence])} title={CONFIDENCE_HINT[c.confidence]}>
                  {CONFIDENCE_LABEL[c.confidence]}
                </span>
                <span className="font-mono font-medium">{c.code ?? c.shipmentId}</span>
                {c.orderCode ? <span className="text-muted-foreground">đơn {c.orderCode}</span> : null}
                <span className="text-muted-foreground">
                  {c.receiverName || "—"} · {c.receiverPhone || "—"}
                </span>
                <span className="ml-auto">
                  {c.alreadyInspected ? (
                    <span className="rounded bg-destructive/10 px-1.5 py-0.5 text-[10.5px] text-destructive">Đã đếm — không nối được</span>
                  ) : (
                    <Button type="button" size="sm" className="h-7" onClick={() => onPick(c)}>
                      Chọn đơn này
                    </Button>
                  )}
                </span>
              </div>
              <p className="mt-1 text-[11.5px] text-muted-foreground">
                {c.ctx.items.length
                  ? c.ctx.items.map((it) => `${it.sku || it.name}${[it.color, it.size].filter(Boolean).length ? ` ${[it.color, it.size].filter(Boolean).join("/")}` : ""} ×${it.quantity}`).join(" · ")
                  : "Đơn không còn dòng hàng nào trong ERP"}
              </p>
              <div className="mt-1">
                <SignalChips signals={c.signals} />
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ───────────────────────── PHIẾU NHẬN KIỆN MẤT NHÃN ─────────────────────────

function NhanKienSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const [source, setSource] = React.useState<UnidentifiedSource>("NO_TRACKING_LABEL");
  const [variant, setVariant] = React.useState<VariantOption | null>(null);
  const [qty, setQty] = React.useState("1");
  const [condition, setCondition] = React.useState<ItemCondition>("OK");
  const [note, setNote] = React.useState("");
  const [warehouseNote, setWarehouseNote] = React.useState("");
  const [picked, setPicked] = React.useState<Candidate | null>(null);
  const [dangGui, setDangGui] = React.useState(false);

  const seed = React.useMemo(() => ({ sku: variant?.sku ?? "", color: variant?.color ?? "", size: variant?.size ?? "" }), [variant]);
  const canDoLyDo = !ITEM_CONDITION_RESTOCKS[condition];

  function reset() {
    setSource("NO_TRACKING_LABEL");
    setVariant(null);
    setQty("1");
    setCondition("OK");
    setNote("");
    setWarehouseNote("");
    setPicked(null);
  }

  async function gui() {
    const n = Number(qty);
    if (!Number.isFinite(n) || n < 1) return toast.error("Số lượng phải từ 1 trở lên");
    if (canDoLyDo && !note.trim()) return toast.error(`Kết luận “${ITEM_CONDITION_LABEL[condition]}” thì phải ghi rõ vì sao`);
    setDangGui(true);
    const r = await createUnidentifiedReturnAction({
      source,
      variantId: variant?.id ?? null,
      quantity: n,
      condition,
      note: note.trim(),
      warehouseNote: warehouseNote.trim(),
      linkShipmentId: picked?.shipmentId ?? null,
    });
    setDangGui(false);
    if ("error" in r) return toast.error(r.error);
    toast.success(r.message, { duration: 9000 });
    reset();
    onOpenChange(false);
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>Nhận kiện hàng hoàn không có mã vận đơn</SheetTitle>
          <SheetDescription>
            Ghi nhận hàng ĐANG CÓ THẬT trong kho. Không cộng tồn ở bước này — kể cả khi hàng còn bán lại được.
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-4 p-4">
          {/* ── BƯỚC 1: TRONG TAY TÔI LÀ GÌ ── */}
          <div className="space-y-2">
            <p className="text-[12.5px] font-medium">1 · Trong tay bạn là gì</p>
            <VariantPicker value={variant} onPick={setVariant} />
            <div className="grid grid-cols-[100px_1fr] gap-2">
              <Input value={qty} onChange={(e) => setQty(e.target.value)} type="number" min={1} className="h-9" aria-label="Số lượng" />
              <select
                value={source}
                onChange={(e) => setSource(e.target.value as UnidentifiedSource)}
                className="h-9 rounded-md border bg-background px-2 text-[12.5px]"
                aria-label="Vì sao kiện này không có mã vận đơn"
              >
                {UNIDENTIFIED_SOURCES.map((s) => (
                  <option key={s} value={s}>
                    {UNIDENTIFIED_SOURCE_LABEL[s]}
                  </option>
                ))}
              </select>
            </div>
            <p className="text-[11.5px] text-muted-foreground">{UNIDENTIFIED_SOURCE_HINT[source]}</p>

            <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
              {KET_LUAN.map((k) => (
                <button
                  key={k.condition}
                  type="button"
                  title={k.giaiThich}
                  onClick={() => setCondition(k.condition)}
                  className={cn(
                    "rounded-lg border px-2 py-2 text-[12px] font-medium transition-colors",
                    condition === k.condition ? (k.condition === "OK" ? "border-emerald-600 bg-emerald-600 text-white" : "border-amber-500 bg-amber-500 text-white") : "hover:bg-accent",
                  )}
                >
                  {k.nhan}
                </button>
              ))}
            </div>
            <Input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={canDoLyDo ? "BẮT BUỘC: vì sao không bán lại được…" : "Ghi chú tình trạng hàng (không bắt buộc)"}
              className={cn("h-9", canDoLyDo && !note.trim() && "border-destructive")}
            />
          </div>

          {/* ── BƯỚC 2: CỦA ĐƠN NÀO ── */}
          <div className="space-y-2 border-t pt-3">
            <p className="text-[12.5px] font-medium">
              2 · Của đơn nào <span className="font-normal text-muted-foreground">— bỏ qua được, tra lại sau cũng được</span>
            </p>
            <CandidateFinder seed={seed} picked={picked} onPick={setPicked} />
          </div>

          <div className="space-y-2 border-t pt-3">
            <Input value={warehouseNote} onChange={(e) => setWarehouseNote(e.target.value)} placeholder="Ghi chú kho: kiện về cùng lô nào, để ở kệ nào…" className="h-9" />
            <div className="flex items-center gap-2">
              <Button type="button" className="h-10 flex-1" onClick={() => void gui()} disabled={dangGui}>
                {dangGui ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
                Ghi nhận kiện
              </Button>
              <Button type="button" variant="outline" className="h-10" onClick={() => onOpenChange(false)} disabled={dangGui}>
                Đóng
              </Button>
            </div>
            <p className="text-[11.5px] text-muted-foreground">
              Ghi xong, ERP cấp một mã nội bộ dạng <span className="font-mono">UR-…</span> — viết nó lên kiện thay cho nhãn đã mất.
            </p>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ───────────────────────── MỘT DÒNG HÀNG GIỮ TẠM ─────────────────────────

function HoldingRow({ row, canOverride, inLedger }: { row: UnidentifiedRow; canOverride: boolean; inLedger: boolean }) {
  const router = useRouter();
  const [dangChay, setDangChay] = React.useState(false);
  const [moTra, setMoTra] = React.useState(false);
  const [picked, setPicked] = React.useState<Candidate | null>(null);
  const [lyDo, setLyDo] = React.useState("");

  const daVaoTon = Boolean(row.stockReceiptId);
  // Món đã vào sổ kết cục (Agent R): sổ là chủ của nó — không tái nhập nguyên món / đổi kết luận ở đây.
  const canRestock = !inLedger && ITEM_CONDITION_RESTOCKS[row.condition] && Boolean(row.variantId);
  const canDoQuyen = row.status !== "IDENTIFIED";
  const seed = React.useMemo(() => ({ sku: row.sku, color: row.color, size: row.size }), [row.sku, row.color, row.size]);

  async function chay<T extends { message?: string } | { error: string }>(fn: () => Promise<T>) {
    setDangChay(true);
    const r = await fn();
    setDangChay(false);
    if ("error" in r && r.error) {
      toast.error(r.error, { duration: 10_000 });
      return false;
    }
    toast.success(("message" in r && r.message) || "Đã cập nhật", { duration: 8000 });
    router.refresh();
    return true;
  }

  return (
    <div className={cn("rounded-lg border p-2.5 text-[12.5px]", daVaoTon && "bg-muted/40")}>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-mono font-medium">{row.code}</span>
        <span className={cn("rounded px-1.5 py-0.5 text-[10.5px] font-medium", TONE_STATUS[row.status])}>{UNIDENTIFIED_STATUS_LABEL[row.status]}</span>
        {daVaoTon ? (
          <Badge variant="secondary" className="text-[10.5px]">
            Đã vào tồn +{formatNumber(row.quantity)}
            {row.restockAuthority === "MANAGER_OVERRIDE" ? " · không chứng từ đơn" : ""}
          </Badge>
        ) : (
          <Badge variant="outline" className="text-[10.5px]">
            Giữ tạm — chưa vào tồn
          </Badge>
        )}
        <span className="text-muted-foreground">
          {row.sku || "chưa chọn mẫu mã"}
          {[row.color, row.size].filter(Boolean).length ? ` · ${[row.color, row.size].filter(Boolean).join(" / ")}` : ""} × {formatNumber(row.quantity)} ·{" "}
          {ITEM_CONDITION_LABEL[row.condition]}
        </span>
        {row.linkedTrackingNumber ? <span className="font-mono text-[11.5px] text-muted-foreground">↔ {row.linkedTrackingNumber}</span> : null}
      </div>

      <p className="mt-1 text-[11.5px] text-muted-foreground">
        {UNIDENTIFIED_SOURCE_LABEL[row.source]} · nhận {formatDateTime(row.receivedAt)} bởi {row.receivedBy || "—"}
        {row.identifiedAt ? ` · nối đơn ${formatDateTime(row.identifiedAt)} bởi ${row.identifiedBy}` : ""}
        {row.restockedAt ? ` · vào tồn ${formatDateTime(row.restockedAt)} bởi ${row.restockedBy}` : ""}
        {row.note ? ` · ${row.note}` : ""}
        {row.unidentifiableReason ? ` · không lần ra đơn: ${row.unidentifiableReason}` : ""}
        {row.restockReason ? ` · lý do tái nhập: ${row.restockReason}` : ""}
      </p>

      {!daVaoTon ? (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <Button type="button" size="sm" variant="outline" className="h-7" onClick={() => setMoTra((v) => !v)} disabled={dangChay}>
            <Search className="size-3.5" />
            {row.status === "IDENTIFIED" ? "Đổi đơn đã nối" : "Tra đơn"}
          </Button>

          {/*
            NÚT TÁI NHẬP LÀ NÚT DUY NHẤT CHẠM VÀO TỒN — và nó nói rõ mình đang làm gì.
            Không nối được đơn thì nó đổi màu và đổi chữ: người bấm phải thấy rằng đây là một quyết
            định không có chứng từ, chứ không phải một thao tác kho thường ngày.
          */}
          {canRestock ? (
            canDoQuyen ? (
              canOverride ? (
                <span className="flex items-center gap-1.5">
                  <Input value={lyDo} onChange={(e) => setLyDo(e.target.value)} placeholder="Lý do BẮT BUỘC (vd: mất nhãn, hàng còn tem)" className="h-7 w-72 text-[11.5px]" />
                  <Button
                    type="button"
                    size="sm"
                    className="h-7 bg-amber-600 text-white hover:bg-amber-700"
                    disabled={dangChay || !lyDo.trim()}
                    onClick={() => void chay(() => restockUnidentifiedReturnAction({ id: row.id, reason: lyDo.trim() }))}
                  >
                    <ShieldAlert className="size-3.5" />
                    Tái nhập không xác định nguồn
                  </Button>
                </span>
              ) : (
                <span className="rounded bg-muted px-2 py-1 text-[11px] text-muted-foreground">
                  Chưa nối được đơn — cần quyền “Tái nhập hàng hoàn không xác định nguồn” để đưa vào tồn.
                </span>
              )
            ) : (
              <Button
                type="button"
                size="sm"
                className="h-7 bg-emerald-600 text-white hover:bg-emerald-700"
                disabled={dangChay}
                onClick={() => void chay(() => restockUnidentifiedReturnAction({ id: row.id, reason: "" }))}
              >
                <Boxes className="size-3.5" />
                Tái nhập +{formatNumber(row.quantity)}
              </Button>
            )
          ) : inLedger ? (
            <a href={`/inventory/returns?xu-ly=${encodeURIComponent(`unidentified:${row.id}`)}#hang-khong-tai-nhap`} className="rounded bg-sky-500/12 px-2 py-1 text-[11px] text-sky-700 hover:underline dark:text-sky-300">
              Đã vào sổ kết cục — xử lý tiếp ở “Hàng hoàn không tái nhập” (sửa → nhập lại theo số đếm · huỷ · trả xưởng)
            </a>
          ) : (
            <span className="rounded bg-muted px-2 py-1 text-[11px] text-muted-foreground">
              {!row.variantId ? "Chưa chọn mẫu mã nên chưa biết cộng vào đâu." : `Kết luận “${ITEM_CONDITION_LABEL[row.condition]}” không vào tồn được.`}
            </span>
          )}

          {!inLedger && !ITEM_CONDITION_RESTOCKS[row.condition] && row.variantId ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7"
              disabled={dangChay}
              onClick={() => void chay(() => setUnidentifiedConditionAction({ id: row.id, condition: "OK", note: "", variantId: null }))}
            >
              Đã làm lại xong · chuyển “Bán lại được”
            </Button>
          ) : null}

          {row.status === "PENDING_IDENTIFICATION" ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7"
              disabled={dangChay}
              onClick={() => {
                const r = window.prompt("Đã tra những gì, và vì sao kết luận không lần ra được đơn?");
                if (r?.trim()) void chay(() => markUnidentifiableAction({ id: row.id, reason: r.trim() }));
              }}
            >
              <HelpCircle className="size-3.5" />
              Không lần ra được đơn
            </Button>
          ) : null}
        </div>
      ) : null}

      {moTra && !daVaoTon ? (
        <div className="mt-2 rounded-lg border bg-background p-2">
          <CandidateFinder seed={seed} picked={picked} onPick={setPicked} />
          {picked ? (
            <Button
              type="button"
              size="sm"
              className="mt-2 h-8"
              disabled={dangChay}
              onClick={async () => {
                const ok = await chay(() => identifyUnidentifiedReturnAction({ id: row.id, shipmentId: picked.shipmentId }));
                if (ok) {
                  setPicked(null);
                  setMoTra(false);
                }
              }}
            >
              <Link2 className="size-3.5" />
              Nối {row.code} với vận đơn này
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ───────────────────────── KHỐI CHÍNH ─────────────────────────

export function UnidentifiedSection({
  rows,
  summary,
  canWrite,
  canOverride,
  inLedger = [],
}: {
  rows: UnidentifiedRow[];
  summary: UnidentifiedSummary;
  canWrite: boolean;
  /** Có quyền `inventory:restock-unidentified` — mở được nút tái nhập không chứng từ. */
  canOverride: boolean;
  /** Id các món đã có dòng ở sổ kết cục (Agent R) — nút tái nhập nguyên món / đổi kết luận ẩn đi. */
  inLedger?: string[];
}) {
  const soKetCuc = React.useMemo(() => new Set(inLedger), [inLedger]);
  const [moNhan, setMoNhan] = React.useState(false);

  return (
    <SectionCard
      title={`Hàng hoàn không có mã vận đơn${summary.holding ? ` · ${formatNumber(summary.holding)} kiện giữ tạm` : ""}`}
      description="Kiện mất nhãn vẫn phải vào sổ. Hàng có thật trong kho nhưng KHÔNG nằm trong tồn bán được cho tới khi có người quyết."
      hint="Ba lớp tách bạch: kiện vật lý đã về · đã biết của đơn nào · đã đủ điều kiện bán lại. ERP không bao giờ suy lớp sau từ lớp trước. Món chưa nối được đơn chỉ vào tồn được bằng quyết định của người có quyền “Tái nhập hàng hoàn không xác định nguồn”, kèm lý do và nhật ký."
      actions={
        canWrite ? (
          <Button type="button" size="sm" className="h-8" onClick={() => setMoNhan(true)}>
            <PackageSearch className="size-4" />
            Không có mã vận đơn
          </Button>
        ) : null
      }
      padded={false}
    >
      <div className="space-y-3 p-3">
        <div className="flex flex-wrap items-center gap-1.5 text-[11.5px]">
          <span className="rounded-md bg-warning/15 px-2 py-1 text-amber-700 dark:text-amber-300">
            Giữ tạm: <span className="numeric font-medium">{formatNumber(summary.holding)}</span> kiện · {formatNumber(summary.holdingUnits)} món
          </span>
          <span className="rounded-md bg-muted px-2 py-1">Chờ xác định: {formatNumber(summary.pending)}</span>
          <span className="rounded-md bg-muted px-2 py-1">Đã nối đơn, chờ tái nhập: {formatNumber(summary.identified)}</span>
          <span className="rounded-md bg-muted px-2 py-1">Kết luận không lần ra: {formatNumber(summary.unidentifiable)}</span>
          <span className="rounded-md bg-emerald-500/12 px-2 py-1 text-emerald-700 dark:text-emerald-400">Đã vào tồn sau khi nối đơn: {formatNumber(summary.restockedIdentified)}</span>
          {/*
            LƯỢT TÁI NHẬP KHÔNG CHỨNG TỪ ĐỨNG RIÊNG, CỐ Ý.
            Gộp nó vào tổng "đã tái nhập" là làm biến mất đúng con số mà chủ shop cần nhìn: bao
            nhiêu hàng đã vào tồn mà không có đơn nào đối chiếu.
          */}
          <span className={cn("rounded-md px-2 py-1", summary.restockedOverride ? "bg-amber-500/15 text-amber-700 dark:text-amber-300" : "bg-muted")}>
            Vào tồn KHÔNG có chứng từ đơn: <span className="numeric font-medium">{formatNumber(summary.restockedOverride)}</span>
            <InfoHint>Quản lý kho quyết đưa vào tồn dù không lần ra được đơn nào. Mỗi lượt đều có lý do và nhật ký; con số này cố ý không gộp vào tổng tái nhập.</InfoHint>
          </span>
          {summary.reworkRestockedUnits ? (
            <span className={cn("rounded-md px-2 py-1", summary.reworkRestockedOverrideUnits ? "bg-amber-500/15 text-amber-700 dark:text-amber-300" : "bg-muted")}>
              Nhập lại sau sửa: <span className="numeric font-medium">{formatNumber(summary.reworkRestockedUnits)}</span> món
              {summary.reworkRestockedOverrideUnits ? ` · ${formatNumber(summary.reworkRestockedOverrideUnits)} món KHÔNG có chứng từ đơn` : ""}
            </span>
          ) : null}
          {summary.oldestPendingDays !== null ? <span className="rounded-md bg-muted px-2 py-1">Kiện chờ lâu nhất: {formatNumber(summary.oldestPendingDays)} ngày</span> : null}
        </div>

        {rows.length ? (
          <div className="space-y-1.5">
            {rows.map((r) => (
              <HoldingRow key={r.id} row={r} canOverride={canOverride} inLedger={soKetCuc.has(r.id)} />
            ))}
          </div>
        ) : (
          <EmptyState
            icon={PackageSearch}
            title="Chưa có kiện hàng hoàn nào mất nhãn"
            description={canWrite ? "Khi gặp kiện không còn mã vận đơn, bấm “Không có mã vận đơn” để ghi nhận — đừng chọn đại một đơn gần giống." : "Bạn không có quyền cập nhật kho nên chỉ xem được danh sách."}
          />
        )}
      </div>

      {canWrite ? <NhanKienSheet open={moNhan} onOpenChange={setMoNhan} /> : null}
    </SectionCard>
  );
}
