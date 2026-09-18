"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { saveResolutionNotePresets } from "@/lib/actions/care-workbench";
import { CalendarClock, Check, ChevronDown, Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import {
  FOLLOW_UP_CHOICES,
  RESOLUTION_ACTIONS,
  RESOLUTION_HINT,
  RESOLUTION_LABEL,
  RESOLUTION_NOTES_MAX,
  RESOLUTION_RING,
  RESOLUTION_TONE,
  followUpAtFrom,
  type FollowUpChoice,
  type ResolutionAction,
} from "@/lib/constants/care-resolution";
import { RETURN_REASON_GROUPS, RETURN_REASON_GROUP_LABEL, RETURN_REASON_GROUP_OF, RETURN_REASON_LABEL, RETURN_REASONS, type ReturnReason } from "@/lib/constants/return-reason";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * ═══════════ BA NÚT KẾT QUẢ — MỘT BẢN DỰNG, HAI CHỖ DÙNG ═══════════
 *
 * Hàng đợi (`workbench.tsx`) và panel chi tiết (`care-drawer.tsx`) phải hỏi CÙNG một câu, chấp nhận
 * CÙNG một dữ kiện, và gọi CÙNG một Server Action. Dựng hai bản là mở đường cho bản này bắt lý do
 * hoàn còn bản kia thì không — và người dùng học được rằng "bấm ở ngoài thì nhanh hơn", tức là báo
 * cáo lý do hoàn sẽ rỗng đúng ở những ca xử lý nhanh nhất.
 *
 * ─── VÌ SAO "ĐÃ HOÀN" KHÔNG PHẢI MỘT CÚ BẤM ───
 *
 * Hai nút kia bấm phát ăn ngay. "Đã hoàn" mở một bảng nhỏ hỏi LÝ DO, vì máy chủ từ chối quyết định
 * hoàn không kèm lý do (`recordBusinessAction`) — và đó là luật đúng: suy lý do hoàn từ chứng từ
 * ĐVVC chỉ phủ khoảng 22% vận đơn, phần còn lại chỉ người vừa gọi khách mới biết. Bỏ bước đó đi thì
 * báo cáo lý do hoàn rỗng vĩnh viễn, và không ai lấy lại được vì thông tin nằm trong đầu người trực
 * của ngày hôm đó.
 *
 * Cái giá đó được trả bằng MỘT cú bấm thêm, không phải bằng một hộp thoại toàn màn hình: lý do hiện
 * thành chip bấm một phát ngay dưới nút.
 *
 * ─── HAI DÁNG, MỘT LUẬT ───
 *
 *  · `row`   — trong bảng: ba ô hẹp, bấm là chạy. Dấu ▾ mở bảng tuỳ chọn (note / giờ hẹn).
 *  · `panel` — trong panel: ba ô to, bấm là CHỌN rồi mở ô note ngay bên dưới, nút "Ghi nhận" chốt.
 *
 * Khác nhau ở nhịp tay, không khác nhau ở luật: cả hai đều đi qua `onSubmit(action, extra)`.
 */

export type ResolutionExtra = { reasonCode?: string; followUpAt?: Date; note: string };
export type ResolutionEligibility = { ok: boolean; reason: string } | null;

const REASONS_BY_GROUP = RETURN_REASON_GROUPS.filter((g) => g !== "UNKNOWN").map((g) => ({ group: g, reasons: RETURN_REASONS.filter((r) => RETURN_REASON_GROUP_OF[r] === g && r !== "UNKNOWN") }));

/**
 * MẪU NOTE SỬA ĐƯỢC NGAY TẠI CHỖ DÙNG.
 *
 * Bộ mẫu là NGÔN NGỮ CỦA SHOP, không phải hằng số của phần mềm: câu mà đội CS gõ đi gõ lại đổi theo
 * mùa, theo mặt hàng, theo chính sách. Chôn nó vào mã nguồn là mỗi lần đổi một câu phải chờ một lần
 * deploy — và điều thật sự xảy ra là không ai đổi, mọi người gõ tay, rồi mẫu chết dần.
 *
 * Sửa cần `shipments:manage` (trưởng CS / quản trị): đổi mẫu chung là đổi cách CẢ ĐỘI ghi nhận.
 * Ô nhập tự do vẫn luôn có cho mọi người — mẫu để bấm nhanh, không phải để giới hạn người ta nói gì.
 */
function NoteBox({
  presets,
  value,
  onChange,
  onSubmit,
  placeholder,
  canEdit,
  onPresetsChange,
  saving,
}: {
  presets: string[];
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  placeholder: string;
  canEdit?: boolean;
  onPresetsChange?: (next: string[]) => void;
  saving?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [moi, setMoi] = useState("");
  const them = () => {
    const t = moi.trim();
    if (!t || !onPresetsChange) return;
    if (presets.length >= RESOLUTION_NOTES_MAX) return;
    onPresetsChange([...new Set([...presets, t])]);
    setMoi("");
  };
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-[10px] uppercase tracking-wide text-muted-foreground">
        <span>Mẫu nhanh</span>
        {canEdit && onPresetsChange ? (
          <button type="button" className="inline-flex items-center gap-1 rounded px-1 normal-case hover:bg-accent" onClick={() => setEditing((v) => !v)}>
            <Pencil className="size-3" /> {editing ? "Xong" : "Sửa mẫu"}
          </button>
        ) : null}
      </div>
      {presets.length ? (
        <div className="flex max-h-24 flex-wrap gap-1 overflow-y-auto">
          {presets.map((p) => (
            <span key={p} className="inline-flex max-w-full items-stretch overflow-hidden rounded border text-[10.5px]">
              <button type="button" onClick={() => onChange(p)} className={cn("truncate px-1.5 py-px text-left hover:bg-accent", value === p && "bg-primary/10 font-semibold")}>
                {p}
              </button>
              {editing && onPresetsChange ? (
                <button type="button" aria-label={`Xoá mẫu ${p}`} disabled={saving} className="border-l px-1 text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/40" onClick={() => onPresetsChange(presets.filter((x) => x !== p))}>
                  <Trash2 className="size-3" />
                </button>
              ) : null}
            </span>
          ))}
        </div>
      ) : (
        <p className="text-[10.5px] text-muted-foreground">{canEdit ? "Chưa có mẫu — bấm “Sửa mẫu” để thêm." : "Chưa có mẫu chung cho kết quả này."}</p>
      )}
      {editing && onPresetsChange ? (
        <div className="flex gap-1">
          <input
            value={moi}
            onChange={(e) => setMoi(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                them();
              }
            }}
            maxLength={200}
            placeholder={`Mẫu mới… (tối đa ${RESOLUTION_NOTES_MAX})`}
            className="h-7 min-w-0 flex-1 rounded-md border bg-background px-2 text-[11.5px]"
          />
          <button type="button" disabled={saving || !moi.trim()} onClick={them} className="rounded-md border px-2 text-[11.5px] hover:bg-accent disabled:opacity-50">
            {saving ? <Loader2 className="size-3 animate-spin" /> : <Plus className="size-3" />}
          </button>
        </div>
      ) : null}
      <Textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          // Ctrl/⌘ + Enter chốt — người gõ xong một câu không phải rời bàn phím đi tìm nút.
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            onSubmit();
          }
        }}
        placeholder={placeholder}
        className="min-h-[56px] text-[12px]"
      />
    </div>
  );
}

/** Sáu lối hẹn + ô chọn giờ. Mốc tính bằng `followUpAtFrom` (hàm thuần) trên đồng hồ của máy đang dùng. */
function FollowUpPicker({ value, onChange }: { value: Date | null; onChange: (d: Date) => void }) {
  const [custom, setCustom] = useState(false);
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap gap-1">
        {FOLLOW_UP_CHOICES.map((c) => (
          <button
            key={c.key}
            type="button"
            onClick={() => {
              setCustom(false);
              onChange(followUpAtFrom(c.key as FollowUpChoice, new Date()));
            }}
            className="rounded border px-1.5 py-0.5 text-[11px] hover:bg-accent"
          >
            {c.label}
          </button>
        ))}
        <button type="button" onClick={() => setCustom((v) => !v)} className={cn("rounded border px-1.5 py-0.5 text-[11px] hover:bg-accent", custom && "border-primary bg-primary/10")}>
          Chọn giờ…
        </button>
      </div>
      {custom ? (
        <input
          type="datetime-local"
          className="h-7 w-full rounded-md border bg-background px-2 text-[11.5px]"
          aria-label="Giờ hẹn xem lại"
          onChange={(e) => {
            const d = new Date(e.target.value);
            if (!Number.isNaN(d.getTime())) onChange(d);
          }}
        />
      ) : null}
      <p className={cn("text-[11px]", value ? "text-foreground" : "text-rose-600 dark:text-rose-400")}>
        <CalendarClock className="mr-1 inline size-3" />
        {value ? `Quay lại lúc ${formatDateTime(value)}` : "Chưa chọn giờ — hẹn không có giờ thì ca chìm khỏi hàng đợi."}
      </p>
    </div>
  );
}

function ReasonPicker({ value, onChange }: { value: ReturnReason | ""; onChange: (r: ReturnReason) => void }) {
  return (
    <div className="max-h-44 space-y-1.5 overflow-y-auto">
      {REASONS_BY_GROUP.map(({ group, reasons }) => (
        <div key={group}>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{RETURN_REASON_GROUP_LABEL[group]}</div>
          <div className="mt-0.5 flex flex-wrap gap-1">
            {reasons.map((r) => (
              <button key={r} type="button" onClick={() => onChange(r)} className={cn("rounded border px-1.5 py-px text-[10.5px] hover:bg-accent", value === r && "border-primary bg-primary/10 font-semibold")}>
                {RETURN_REASON_LABEL[r]}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Nội dung bảng tuỳ chọn cho MỘT kết quả — dùng chung cho cả popover (dáng row) lẫn khối trong panel. */
function ResolutionForm({
  action,
  presets,
  pending,
  onSubmit,
  onCancel,
  autoFocusNote,
  canEdit,
  onPresetsChange,
  saving,
}: {
  action: ResolutionAction;
  presets: string[];
  pending: boolean;
  onSubmit: (extra: ResolutionExtra) => void;
  onCancel?: () => void;
  autoFocusNote?: boolean;
  canEdit?: boolean;
  onPresetsChange?: (next: string[]) => void;
  saving?: boolean;
}) {
  const [note, setNote] = useState("");
  const [reason, setReason] = useState<ReturnReason | "">("");
  // Mặc định 2 giờ: bấm "Xử lý sau" rồi không chọn gì vẫn ra một cái hẹn THẬT, không ra `null`.
  const [at, setAt] = useState<Date | null>(() => (action === "FOLLOW_UP_LATER" ? followUpAtFrom("2h", new Date()) : null));
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (autoFocusNote) boxRef.current?.querySelector("textarea")?.focus();
  }, [autoFocusNote]);

  const ready = action !== "RETURNED" || reason !== "";
  const send = () => {
    if (!ready || pending) return;
    onSubmit({ note: note.trim(), reasonCode: action === "RETURNED" ? reason || undefined : undefined, followUpAt: action === "FOLLOW_UP_LATER" ? (at ?? undefined) : undefined });
  };

  return (
    <div ref={boxRef} className="space-y-2">
      <p className="text-[11px] leading-snug text-muted-foreground">{RESOLUTION_HINT[action]}</p>
      {action === "RETURNED" ? (
        <div className="space-y-1">
          <div className="text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground">Lý do hoàn (bắt buộc)</div>
          <ReasonPicker value={reason} onChange={setReason} />
        </div>
      ) : null}
      {action === "FOLLOW_UP_LATER" ? <FollowUpPicker value={at} onChange={setAt} /> : null}
      <NoteBox presets={presets} value={note} onChange={setNote} onSubmit={send} placeholder="Khách nói gì? (Ctrl/⌘ + Enter để lưu)" canEdit={canEdit} onPresetsChange={onPresetsChange} saving={saving} />
      <div className="flex items-center justify-end gap-1">
        {onCancel ? (
          <button type="button" className="rounded px-2 py-1 text-[11.5px] text-muted-foreground hover:bg-accent" onClick={onCancel} disabled={pending}>
            Huỷ
          </button>
        ) : null}
        <button
          type="button"
          disabled={!ready || pending}
          onClick={send}
          className={cn("inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-[11.5px] font-semibold", RESOLUTION_TONE[action], "disabled:cursor-not-allowed disabled:opacity-50")}
        >
          {pending ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />} Ghi nhận “{RESOLUTION_LABEL[action]}”
        </button>
      </div>
      {action === "RETURNED" && !ready ? <p className="text-right text-[10.5px] text-muted-foreground">Chọn lý do rồi mới ghi nhận được.</p> : null}
    </div>
  );
}

export function ResolutionControl({
  value,
  eligibility,
  pending,
  presets,
  onSubmit,
  variant = "row",
  openFor,
  onOpenForChange,
  canEditPresets = false,
}: {
  /** Kết quả ĐANG CÓ — đọc từ `care.lastDecision`, không phải từ bộ nhớ màn hình. */
  value: ResolutionAction | null;
  /** Kiện có đang ở đúng trạng thái ĐVVC để làm việc này không. `null` = không cần hỏi ĐVVC. */
  eligibility: (a: ResolutionAction) => ResolutionEligibility;
  pending: boolean;
  presets: Record<ResolutionAction, string[]>;
  onSubmit: (a: ResolutionAction, extra: ResolutionExtra) => void;
  variant?: "row" | "panel";
  /** Điều khiển từ ngoài (phím tắt trong panel). Bỏ trống thì tự quản. */
  openFor?: ResolutionAction | null;
  onOpenForChange?: (a: ResolutionAction | null) => void;
  /** `shipments:manage` ⇒ sửa được bộ mẫu note dùng chung cả shop. */
  canEditPresets?: boolean;
}) {
  const [openTrong, setOpenTrong] = useState<ResolutionAction | null>(null);
  /*
    BỘ MẪU LÀ TRẠNG THÁI CỦA MÀN HÌNH cho tới khi máy chủ xác nhận: sửa xong thấy ngay, và lỗi thì
    trả về đúng bộ máy chủ đang giữ (`r.data`) chứ không giữ lại thứ vừa gõ — giữ lại là màn hình
    hiện một bộ mẫu không tồn tại ở đâu cả.
  */
  const [boMau, setBoMau] = useState(presets);
  const [saving, startSave] = useTransition();
  useEffect(() => setBoMau(presets), [presets]);
  const luuMau = (a: ResolutionAction, next: string[]) => {
    const truoc = boMau;
    setBoMau({ ...boMau, [a]: next });
    startSave(async () => {
      const r = await saveResolutionNotePresets({ action: a, presets: next });
      if ("error" in r) {
        setBoMau(truoc);
        toast.error(r.error);
        return;
      }
      setBoMau(r.data);
    });
  };
  const open = openFor !== undefined ? openFor : openTrong;
  const setOpen = (a: ResolutionAction | null) => {
    setOpenTrong(a);
    onOpenForChange?.(a);
  };

  const kich = variant === "panel" ? "px-3 py-1.5 text-[12.5px]" : "px-1.5 py-0.5 text-[11px]";

  const nut = (a: ResolutionAction) => {
    const e = eligibility(a);
    const khoa = e !== null && !e.ok;
    const dangChon = value === a;
    return (
      <button
        key={a}
        type="button"
        disabled={pending || khoa}
        aria-pressed={dangChon}
        title={khoa ? e!.reason : RESOLUTION_HINT[a]}
        onClick={() => {
          if (khoa) return;
          /*
            "Phát tiếp" bấm là CHẠY: không có dữ kiện nào bắt buộc, nên hỏi thêm một câu là bắt
            người trực trả giá cho một thứ họ không cần. "Đã hoàn" (cần lý do) và "Xử lý sau" (cần
            giờ) mở bảng — dữ kiện đó KHÔNG đoán được, và đoán hộ là cách nhanh nhất để có một báo
            cáo đầy số mà không ai tin.

            Trong panel thì cả ba đều mở bảng: ở đó nhịp làm việc là đọc → gọi → chọn → ghi note.
          */
          if (variant === "row" && a === "REDELIVER") onSubmit(a, { note: "" });
          else setOpen(open === a ? null : a);
        }}
        className={cn(
          "rounded-md border font-medium transition-colors",
          kich,
          dangChon ? cn(RESOLUTION_TONE[a], RESOLUTION_RING[a], "font-semibold") : "border-transparent bg-muted/60 text-muted-foreground hover:bg-accent hover:text-foreground",
          khoa && "cursor-not-allowed opacity-40",
        )}
      >
        {RESOLUTION_LABEL[a]}
        {dangChon ? <Check className="ml-1 inline size-3" /> : null}
      </button>
    );
  };

  return (
    <div className={cn("flex flex-wrap items-center", variant === "panel" ? "gap-1.5" : "gap-1")}>
      {RESOLUTION_ACTIONS.map((a) =>
        // Dáng `row`: mỗi nút là một `PopoverTrigger` riêng để bảng tuỳ chọn neo ĐÚNG dưới nút vừa
        // bấm. Dáng `panel`: bảng nằm dưới cả cụm, vì ở đó nó là bước tiếp theo của quy trình.
        variant === "row" ? (
          /*
            POPOVER ĐIỀU KHIỂN HOÀN TOÀN TỪ NGOÀI, và `onOpenChange` chỉ nhận lệnh ĐÓNG.

            Radix mở popover ngay khi người ta bấm trúng `PopoverTrigger`. Với "Phát tiếp" thì cú
            bấm ấy phải CHẠY chứ không phải mở bảng — nên lệnh mở của Radix bị bỏ qua, và trạng thái
            mở do chính `onClick` của nút quyết định. Lệnh ĐÓNG vẫn nhận, nếu không thì bấm ra ngoài
            không đóng được bảng.
          */
          <Popover key={a} open={open === a} onOpenChange={(o) => !o && setOpen(null)}>
            <PopoverTrigger asChild>{nut(a)}</PopoverTrigger>
            <PopoverContent align="start" className="w-[20rem] p-3" onClick={(e) => e.stopPropagation()}>
              <ResolutionForm
                action={a}
                presets={boMau[a]}
                pending={pending}
                saving={saving}
                canEdit={canEditPresets}
                onPresetsChange={(next) => luuMau(a, next)}
                autoFocusNote={a === "REDELIVER"}
                onCancel={() => setOpen(null)}
                onSubmit={(extra) => {
                  setOpen(null);
                  onSubmit(a, extra);
                }}
              />
            </PopoverContent>
          </Popover>
        ) : (
          nut(a)
        ),
      )}
      {variant === "row" ? (
        <button
          type="button"
          disabled={pending}
          title="Ghi note / chọn giờ hẹn cho “Phát tiếp”"
          aria-label="Tuỳ chọn cho Phát tiếp"
          onClick={() => setOpen(open === "REDELIVER" ? null : "REDELIVER")}
          className="rounded border border-transparent px-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <ChevronDown className="size-3" />
        </button>
      ) : null}
      {variant === "panel" && open ? (
        <div className="mt-1 w-full rounded-lg border bg-muted/30 p-2.5">
          <ResolutionForm
            action={open}
            presets={boMau[open]}
            pending={pending}
            saving={saving}
            canEdit={canEditPresets}
            onPresetsChange={(next) => luuMau(open, next)}
            autoFocusNote
            onCancel={() => setOpen(null)}
            onSubmit={(extra) => {
              setOpen(null);
              onSubmit(open, extra);
            }}
          />
        </div>
      ) : null}
    </div>
  );
}

/** Nhãn đọc — dùng ở cột danh sách và đầu panel để trả lời "đã quyết gì" mà không phải mở gì. */
export function ResolutionBadge({ value, at, by, className }: { value: ResolutionAction | null; at?: Date | null; by?: string; className?: string }) {
  if (!value) return <span className={cn("text-[10.5px] text-muted-foreground", className)}>Chưa quyết định</span>;
  return (
    <span className={cn("inline-flex items-center rounded px-1.5 py-px text-[10.5px] font-semibold", RESOLUTION_TONE[value], className)} title={`${RESOLUTION_HINT[value]}${at ? `\n— ${by || "không rõ người"} · ${formatDateTime(at)}` : ""}`}>
      {RESOLUTION_LABEL[value]}
    </span>
  );
}
