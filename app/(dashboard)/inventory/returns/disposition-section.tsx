"use client";

import { useEffect, useMemo, useRef, useState, useTransition, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronDown, ChevronRight, History, Loader2, PackageX } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { setReturnDisposition } from "@/lib/actions/return-dispositions";
import { COST_BASIS_LABEL, type CostBasis } from "@/lib/constants/inspection-truth";
import { ITEM_CONDITION_LABEL, isItemCondition } from "@/lib/constants/return-lifecycle";
import { CONDITION_LABEL, isReturnCondition } from "@/lib/constants/returns-condition";
import {
  DISPOSITION_ACTION_LABEL,
  DISPOSITION_ALLOWED_FROM,
  DISPOSITION_GRAIN_LABEL,
  DISPOSITION_HINT,
  DISPOSITION_LABEL,
  DISPOSITION_NEEDS_NOTE,
  DISPOSITION_NOTE_MIN,
  DISPOSITION_TONE,
  RETURN_DISPOSITIONS,
  isTerminalDisposition,
  type DispositionGrain,
  type OpenDispositionState,
  type ReturnDisposition,
} from "@/lib/constants/return-disposition";
import { restockAuthorityOf } from "@/lib/constants/return-unidentified";
import { formatDateTime, formatNumber, formatVND } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * ═══════════ HÀNG HOÀN KHÔNG TÁI NHẬP — BƯỚC SAU TRẠM ĐẾM ═══════════
 *
 * Trạm đếm cho món "Đủ" một phiếu tái nhập. Món hỏng / bẩn / sai hàng trước đây dừng ở đó — trên kệ,
 * ngoài sổ. Khối này là lối ra của chúng: mỗi món một dòng, mỗi dòng đúng những nút mà trạng thái
 * hiện tại cho phép (`DISPOSITION_ALLOWED_FROM`), và mọi quyết định để lại một dòng lịch sử có tên
 * người làm. Không có nút "đánh dấu xong": món rời danh sách khi có kết cục cuối cho TOÀN BỘ số lượng.
 *
 * Company OS · Agent R: món hàng hoàn KHÔNG NHÃN (bàn "Hàng hoàn không có mã vận đơn") kết luận không bán
 * được cũng ở đây, gắn nhãn "không nhãn" — cùng nút, cùng luật. Nhập lại sau sửa của món CHƯA nối được
 * đơn đòi quyền "Tái nhập hàng hoàn không xác định nguồn" và lý do, y như nút tái nhập của bàn ấy.
 */

export type DispositionHistoryView = {
  id: string;
  disposition: ReturnDisposition;
  qty: number;
  note: string;
  actorName: string;
  createdAt: string;
  stockReceiptId: string | null;
  valueEstimate: number | null;
  costBasis: string | null;
};

export type DispositionRowView = {
  subjectKey: string;
  grain: DispositionGrain;
  /** Vận đơn của kiện; món không nhãn: vận đơn ĐÃ NỐI hoặc `null`. */
  shipmentId: string | null;
  /** Chỉ món không nhãn: trạng thái xác định nguồn — quyết quyền nhập lại. */
  unidentifiedStatus: string | null;
  code: string | null;
  orderCode: string | null;
  condition: string;
  inspectNote: string;
  inspectedAt: string | null;
  qty: number;
  sku: string;
  productName: string;
  color: string;
  size: string;
  unitCost: number | null;
  costBasis: CostBasis;
  remaining: number;
  state: OpenDispositionState;
  openValueEstimate: number | null;
  expectedVariants: { variantId: string; sku: string; name: string; color: string; size: string; quantity: number }[];
  history: DispositionHistoryView[];
};

export type RecentDispositionView = DispositionHistoryView & { code: string | null; sku: string; productName: string; grain: DispositionGrain | null };

export type DispositionSummaryView = {
  totalOpen: number;
  truncated: boolean;
  openQty: number;
  pendingQty: number;
  reworkQty: number;
  openValueKnown: number;
  openValueUnknownQty: number;
  excludedMissingParcels: number;
  /** Món không nhãn còn mở — nằm TRONG `openQty`. */
  unidentifiedOpenQty: number;
  /** Món không nhãn CHƯA gán mẫu mã — con số cấp shop, không thuộc mẫu nào (luật 35). */
  unidentifiedUnassigned: { subjects: number; openQty: number; writtenOffQty: number; returnedToSupplierQty: number };
};

const TONE: Record<string, string> = {
  amber: "bg-warning/15 text-amber-700 dark:text-amber-300",
  blue: "bg-sky-500/12 text-sky-700 dark:text-sky-300",
  green: "bg-emerald-500/12 text-emerald-700 dark:text-emerald-400",
  rose: "bg-destructive/10 text-destructive",
  slate: "bg-muted text-muted-foreground",
};

function conditionLabel(grain: DispositionGrain, c: string) {
  if (grain !== "PARCEL" && isItemCondition(c)) return ITEM_CONDITION_LABEL[c];
  if (grain === "PARCEL" && isReturnCondition(c)) return CONDITION_LABEL[c];
  return c || "—";
}

function DispositionBadge({ d }: { d: ReturnDisposition }) {
  return <Badge variant="secondary" className={cn("text-[11px]", TONE[DISPOSITION_TONE[d]])}>{DISPOSITION_LABEL[d]}</Badge>;
}

/** Khoá chống bấm đúp: MỘT khoá cho mỗi lượt mở biểu mẫu, gửi lại bao nhiêu lần cũng chỉ ghi một dòng. */
function newRequestKey() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function ActionForm({ row, disposition, onDone, canOverride }: { row: DispositionRowView; disposition: ReturnDisposition; onDone: () => void; canOverride: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const terminal = isTerminalDisposition(disposition);
  const [qty, setQty] = useState(String(row.remaining));
  const [note, setNote] = useState("");
  const [variantId, setVariantId] = useState(row.expectedVariants.length === 1 ? row.expectedVariants[0].variantId : "");
  const requestKey = useRef(newRequestKey());
  const canVariant = row.grain === "PARCEL" && (disposition === "RESTOCK_AFTER_REWORK" || disposition === "WRITE_OFF");
  /* Món KHÔNG NHÃN chưa nối được đơn: nhập lại là cộng tồn không chứng từ — quyền riêng + lý do bắt buộc
     (máy chủ kiểm lại bằng `checkUnidentifiedRestock`; ở đây chỉ để người bấm biết trước). */
  const khongChungTu = row.grain === "UNIDENTIFIED" && disposition === "RESTOCK_AFTER_REWORK" && restockAuthorityOf(row.unidentifiedStatus ?? "") === "MANAGER_OVERRIDE";
  const thieuQuyen = khongChungTu && !canOverride;
  const needNote = DISPOSITION_NEEDS_NOTE[disposition] || khongChungTu;
  const noteMin = DISPOSITION_NEEDS_NOTE[disposition] ? DISPOSITION_NOTE_MIN : 1;

  const gui = () =>
    start(async () => {
      const r = await setReturnDisposition({
        subjectKey: row.subjectKey,
        disposition,
        qty: terminal ? Number(qty) || null : null,
        note,
        variantId: canVariant && variantId ? variantId : null,
        requestKey: requestKey.current,
      });
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      toast.success(
        disposition === "RESTOCK_AFTER_REWORK"
          ? `Đã nhập lại ${qty} món vào tồn qua phiếu tái nhập`
          : `Đã ghi: ${DISPOSITION_LABEL[disposition]}${terminal ? ` · ${qty} món` : ""}`,
      );
      onDone();
      router.refresh();
    });

  return (
    <div className="mt-2 space-y-2 rounded-lg border bg-muted/30 p-2.5 text-xs">
      <p className="text-muted-foreground">{DISPOSITION_HINT[disposition]}</p>
      {khongChungTu ? (
        <p className="rounded bg-warning/15 px-2 py-1 text-amber-700 dark:text-amber-300">
          {thieuQuyen
            ? "Món không nhãn này chưa nối được đơn — nhập lại là cộng tồn KHÔNG chứng từ, cần quyền “Tái nhập hàng hoàn không xác định nguồn”. Nhờ người có quyền bấm, hoặc nối đơn trước."
            : "Món không nhãn chưa nối được đơn — nhập lại là cộng tồn KHÔNG chứng từ: bắt buộc ghi lý do, lượt này được ghi riêng (không chứng từ đơn)."}
        </p>
      ) : null}
      <div className="flex flex-wrap items-end gap-2">
        {terminal ? (
          <label className="flex flex-col gap-0.5">
            <span className="text-muted-foreground">Số món {disposition === "RESTOCK_AFTER_REWORK" ? "ĐẾM ĐƯỢC còn bán được" : ""} (còn {row.remaining})</span>
            <Input type="number" min={1} max={row.remaining} value={qty} onChange={(e) => setQty(e.target.value)} className="h-8 w-24" />
          </label>
        ) : null}
        {canVariant ? (
          <label className="flex flex-col gap-0.5">
            <span className="text-muted-foreground">Mẫu mã {disposition === "RESTOCK_AFTER_REWORK" ? "(bắt buộc)" : "(để định giá — bỏ trống = chưa biết)"}</span>
            <select value={variantId} onChange={(e) => setVariantId(e.target.value)} className="h-8 rounded-md border bg-background px-2">
              <option value="">— chọn mẫu mã —</option>
              {row.expectedVariants.map((v) => (
                <option key={v.variantId} value={v.variantId}>
                  {[v.sku || v.name, v.color, v.size].filter(Boolean).join(" · ")} (kỳ vọng {v.quantity})
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label className="flex min-w-[220px] flex-1 flex-col gap-0.5">
          <span className="text-muted-foreground">{needNote ? `Lý do (bắt buộc${noteMin > 1 ? `, ≥ ${noteMin} ký tự` : ""})` : "Ghi chú"}</span>
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder={disposition === "WRITE_OFF" ? "Rách không vá được, mốc…" : disposition === "RETURN_TO_SUPPLIER" ? "Trả xưởng nào, lỗi gì…" : ""} className="h-8" />
        </label>
        <Button
          size="sm"
          className="h-8"
          disabled={pending || thieuQuyen || (needNote && note.trim().length < noteMin) || (disposition === "RESTOCK_AFTER_REWORK" && row.grain === "PARCEL" && !variantId)}
          onClick={gui}
        >
          {pending ? <Loader2 className="size-3.5 animate-spin" /> : null} Ghi
        </Button>
        <Button size="sm" variant="ghost" className="h-8" onClick={onDone} disabled={pending}>
          Thôi
        </Button>
      </div>
      {disposition === "WRITE_OFF" ? (
        <p className="text-[11px] text-muted-foreground">
          Giá trị ghi lại là ƯỚC TÍNH (
          {row.grain === "PARCEL"
            ? "theo giá vốn gần nhất của mẫu mã đã chọn; không chọn thì là chưa biết"
            : row.unitCost === null
              ? "chưa biết giá vốn"
              : `${formatVND(row.unitCost)}/món theo ${COST_BASIS_LABEL[row.costBasis].toLowerCase()}`}
          ). Huỷ bỏ không ghi sổ kho và đi qua duyệt hai bước “Ghi giảm / huỷ hàng” khi nhóm này được bật.
        </p>
      ) : null}
    </div>
  );
}

function Row({ row, canWrite, canOverride, focused }: { row: DispositionRowView; canWrite: boolean; canOverride: boolean; focused: boolean }) {
  const [open, setOpen] = useState<ReturnDisposition | null>(null);
  const [showHistory, setShowHistory] = useState(focused);
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: "center" });
  }, [focused]);
  const allowed = RETURN_DISPOSITIONS.filter((d) => DISPOSITION_ALLOWED_FROM[d].includes(row.state));
  const ten = [row.sku || row.productName || "Món chưa rõ mẫu mã", row.color, row.size].filter(Boolean).join(" · ");

  return (
    <li ref={ref} className={cn("p-3", focused && "bg-primary/5")}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <DispositionBadge d={row.state} />
            {row.grain === "UNIDENTIFIED" ? (
              <Badge variant="outline" className="border-amber-500/50 text-[11px] text-amber-700 dark:text-amber-300" title="Hàng hoàn không có mã vận đơn — ghi nhận ở bàn “Hàng hoàn không có mã vận đơn”">
                không nhãn
              </Badge>
            ) : null}
            <span className="text-sm font-medium">{ten}</span>
            <span className="text-xs text-muted-foreground">
              còn <b className="numeric text-foreground">{formatNumber(row.remaining)}</b>/{formatNumber(row.qty)} món
            </span>
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11.5px] text-muted-foreground">
            <span>
              {DISPOSITION_GRAIN_LABEL[row.grain]} · {conditionLabel(row.grain, row.condition)}
              {row.inspectNote ? ` — ${row.inspectNote}` : ""}
            </span>
            {row.grain === "UNIDENTIFIED" ? (
              <>
                <span className="font-mono">{row.code ?? "—"}</span>
                {row.shipmentId ? (
                  <Link href={`/shipments/${row.shipmentId}`} className="text-primary hover:underline">
                    đã nối vận đơn
                  </Link>
                ) : (
                  <span>chưa nối đơn</span>
                )}
              </>
            ) : row.shipmentId ? (
              <Link href={`/shipments/${row.shipmentId}`} className="font-mono text-primary hover:underline">
                {row.code ?? row.shipmentId}
              </Link>
            ) : (
              <span className="font-mono">{row.code ?? "—"}</span>
            )}
            {row.orderCode ? <span>đơn {row.orderCode}</span> : null}
            <span>
              {row.grain === "UNIDENTIFIED" ? "nhận" : "kiểm"} {formatDateTime(row.inspectedAt)}
            </span>
            <span title={row.unitCost === null ? "Chưa có giá vốn nào cho mẫu mã này" : `Ước tính theo ${COST_BASIS_LABEL[row.costBasis].toLowerCase()}`}>
              ≈ {row.openValueEstimate === null ? "—" : formatVND(row.openValueEstimate)} (ước tính)
            </span>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1 sm:justify-end">
          {canWrite
            ? allowed.map((d) => (
                <Button key={d} size="sm" variant={open === d ? "default" : "outline"} className="h-7 px-2 text-xs" title={DISPOSITION_HINT[d]} onClick={() => setOpen(open === d ? null : d)}>
                  {DISPOSITION_ACTION_LABEL[d]}
                </Button>
              ))
            : null}
          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setShowHistory((v) => !v)} title="Lịch sử quyết định của món này">
            {showHistory ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />} {row.history.length} dòng
          </Button>
        </div>
      </div>
      {open ? <ActionForm key={open} row={row} disposition={open} canOverride={canOverride} onDone={() => setOpen(null)} /> : null}
      {showHistory ? (
        row.history.length ? (
          <ul className="mt-2 space-y-1 border-l-2 pl-3 text-[11.5px]">
            {row.history.map((h) => (
              <HistoryLine key={h.id} h={h} />
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-[11.5px] text-muted-foreground">Chưa có quyết định nào — món đang ở trạng thái mặc định “Chưa quyết”.</p>
        )
      ) : null}
    </li>
  );
}

function HistoryLine({ h, extra }: { h: DispositionHistoryView; extra?: ReactNode }) {
  return (
    <li className="flex flex-wrap items-center gap-1.5">
      <DispositionBadge d={h.disposition} />
      {isTerminalDisposition(h.disposition) ? <span className="numeric">{formatNumber(h.qty)} món</span> : null}
      {extra}
      <span className="text-muted-foreground">
        {h.actorName || "—"} · {formatDateTime(h.createdAt)}
      </span>
      {h.stockReceiptId ? (
        <Link href="/inventory/receipts" className="text-primary hover:underline" title={`Phiếu tái nhập ${h.stockReceiptId}`}>
          phiếu tái nhập
        </Link>
      ) : null}
      {h.disposition === "WRITE_OFF" ? (
        <span className="text-muted-foreground" title={h.costBasis && h.costBasis in COST_BASIS_LABEL ? `Ước tính theo ${COST_BASIS_LABEL[h.costBasis as CostBasis].toLowerCase()}` : undefined}>
          ≈ {h.valueEstimate === null ? "—" : formatVND(h.valueEstimate)} (ước tính)
        </span>
      ) : null}
      {h.note ? <span className="text-muted-foreground">— {h.note}</span> : null}
    </li>
  );
}

export function DispositionSection({
  rows,
  summary,
  recent,
  canWrite,
  canOverride,
  focusKey,
}: {
  rows: DispositionRowView[];
  summary: DispositionSummaryView;
  recent: RecentDispositionView[];
  canWrite: boolean;
  /** Có quyền `inventory:restock-unidentified` — nhập lại sau sửa món không nhãn chưa nối đơn. */
  canOverride: boolean;
  focusKey: string | null;
}) {
  const [showRecent, setShowRecent] = useState(false);
  const moTa = useMemo(
    () =>
      [
        `${formatNumber(summary.pendingQty)} món chưa quyết`,
        summary.reworkQty ? `${formatNumber(summary.reworkQty)} món đang sửa / giặt` : "",
        `≈ ${formatVND(summary.openValueKnown)} ước tính${summary.openValueUnknownQty ? ` + ${formatNumber(summary.openValueUnknownQty)} món chưa biết giá vốn` : ""}`,
        summary.unidentifiedOpenQty ? `trong đó ${formatNumber(summary.unidentifiedOpenQty)} món không nhãn` : "",
        summary.unidentifiedUnassigned.subjects
          ? `không nhãn, chưa gán mẫu: ${formatNumber(summary.unidentifiedUnassigned.openQty)} món còn mở · ${formatNumber(summary.unidentifiedUnassigned.writtenOffQty)} đã huỷ · ${formatNumber(summary.unidentifiedUnassigned.returnedToSupplierQty)} trả xưởng (không thuộc mẫu nào)`
          : "",
        summary.excludedMissingParcels ? `${formatNumber(summary.excludedMissingParcels)} kiện “Thiếu hàng” cả kiện không vào đây` : "",
      ]
        .filter(Boolean)
        .join(" · "),
    [summary],
  );

  return (
    <SectionCard
      id="hang-khong-tai-nhap"
      title={
        <span className="flex items-center gap-1.5">
          <PackageX className="size-4" /> Hàng hoàn không tái nhập · {formatNumber(summary.totalOpen)} món chờ kết cục
        </span>
      }
      description={moTa}
      hint={
        <>
          <p>Món đã kiểm là KHÔNG bán ngay được (hỏng, bẩn, sai hàng…). Mỗi món phải đi tới một kết cục: sửa / giặt rồi đếm lại để nhập tồn, trả xưởng, hoặc huỷ có lý do.</p>
          <p className="mt-1">Nhập lại tồn chỉ đi SAU bước sửa, theo SỐ ĐẾM THỰC TẾ, qua một phiếu tái nhập. Huỷ bỏ không ghi sổ kho (hàng chưa từng vào lại tồn) — giá trị là ước tính và chưa vào báo cáo lợi nhuận.</p>
          <p className="mt-1">Kiện kết luận “Thiếu hàng” cả kiện không vào đây: con số không bán được của chúng là hàng KHÔNG có mặt.</p>
          <p className="mt-1">
            Món <b>không nhãn</b> (bàn “Hàng hoàn không có mã vận đơn”) kết luận không bán được cũng ở đây. Nhập lại sau sửa của món chưa nối được đơn cần quyền “Tái nhập hàng hoàn
            không xác định nguồn” và lý do. Món chưa nhận diện được mẫu mã không được quy về mẫu nào — nó đứng ở con số “không nhãn, chưa gán mẫu”.
          </p>
        </>
      }
      padded={false}
    >
      {rows.length ? (
        <ul className="divide-y">
          {rows.map((r) => (
            <Row key={r.subjectKey} row={r} canWrite={canWrite} canOverride={canOverride} focused={focusKey === r.subjectKey} />
          ))}
        </ul>
      ) : (
        <div className="p-3">
          <EmptyState icon={PackageX} title="Không còn món hàng hoàn nào chờ kết cục" description="Món kiểm là không bán được sẽ hiện ở đây ngay sau khi đếm." />
        </div>
      )}
      {summary.truncated ? (
        <p className="border-t px-3 py-2 text-[11.5px] text-muted-foreground">
          Đang hiện {formatNumber(rows.length)} món cũ nhất trong tổng {formatNumber(summary.totalOpen)}. Xử lý bớt thì phần còn lại tự lên.
        </p>
      ) : null}
      <div className="border-t px-3 py-2">
        <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setShowRecent((v) => !v)}>
          <History className="size-3.5" /> Quyết định gần đây ({formatNumber(recent.length)})
        </Button>
        {showRecent ? (
          recent.length ? (
            <ul className="mt-1 space-y-1 text-[11.5px]">
              {recent.map((h) => (
                <HistoryLine
                  key={h.id}
                  h={h}
                  extra={
                    <span>
                      {h.sku || h.productName || "—"} · <span className="font-mono">{h.code ?? "—"}</span>
                      {h.grain === "UNIDENTIFIED" ? " · không nhãn" : ""}
                    </span>
                  }
                />
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-[11.5px] text-muted-foreground">Chưa có quyết định nào.</p>
          )
        ) : null}
      </div>
    </SectionCard>
  );
}
