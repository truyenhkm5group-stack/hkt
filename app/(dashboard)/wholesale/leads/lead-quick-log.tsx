"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  addLeadNoteAction,
  logCallAction,
  logCallInitiatedAction,
} from "@/lib/actions/wholesale";
import {
  CALL_OUTCOME_ICON,
  CALL_OUTCOME_LABEL,
  callOutcomeEffect,
  MOBILE_CALL_OUTCOMES,
  QUICK_NOTE_CHIPS,
  type CallOutcome,
  type LeadStatus,
} from "@/lib/wholesale/constants";
import {
  FOLLOW_OPTIONS,
  followIso,
  suggestedFollow,
  type FollowKey,
} from "@/lib/wholesale/followup";
import { cn } from "@/lib/utils";

/** «Chỉ ghi chú» — không có cuộc gọi nào (vd khách nhắn Zalo, ghé cửa hàng). */
const NOTE_ONLY = "NOTE_ONLY" as const;
type Choice = CallOutcome | typeof NOTE_ONLY;

/**
 * Ghi kết quả NGAY TRÊN DANH SÁCH lead (chủ shop 05/10/2026: «chưa có trạng thái xử lý khách và note»). Cùng chín kết quả và
 * cùng luật `callOutcomeEffect` với màn điện thoại — trạng thái do máy suy ra; thêm lựa chọn «Chỉ ghi chú» cho việc không phải
 * cuộc gọi. Lưu xong máy chủ làm mới danh sách (revalidatePath trong server action), không phải rời trang.
 */
export function LeadQuickLog({
  lead,
}: {
  lead: {
    id: string;
    name: string | null;
    status: LeadStatus;
    phone: string | null;
    phoneDisplay: string | null;
  };
}) {
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<Choice | null>(null);
  const [note, setNote] = useState("");
  const [follow, setFollow] = useState<FollowKey>("none");
  const [custom, setCustom] = useState("");
  const [saving, setSaving] = useState(false);
  const done = lead.status === "DO_NOT_CONTACT";

  const reset = () => {
    setChoice(null);
    setNote("");
    setFollow("none");
    setCustom("");
  };
  const choose = (c: Choice) => {
    setChoice(c);
    setFollow(
      c === NOTE_ONLY
        ? "none"
        : suggestedFollow(callOutcomeEffect(lead.status, c).followupDays),
    );
  };
  const addChip = (c: string) =>
    setNote((n) => (n.trim() ? `${n.trim()}; ${c}` : c));
  const save = async () => {
    if (!choice || saving) return;
    if (choice === NOTE_ONLY && !note.trim())
      return void toast.error("Ghi chú trống");
    setSaving(true);
    const nextFollowupAt = followIso(follow, custom);
    const r =
      choice === NOTE_ONLY
        ? await addLeadNoteAction(lead.id, {
            note,
            nextFollowupAt,
            nextAction: "",
          })
        : await logCallAction(lead.id, {
            outcome: choice,
            note,
            nextFollowupAt,
          });
    setSaving(false);
    if ("error" in r) return void toast.error(r.error);
    toast.success(
      choice === NOTE_ONLY
        ? "Đã thêm ghi chú"
        : `Đã lưu: ${CALL_OUTCOME_LABEL[choice]}`,
    );
    setOpen(false);
    reset();
  };
  const effect =
    choice && choice !== NOTE_ONLY
      ? callOutcomeEffect(lead.status, choice)
      : null;
  const ends =
    choice === "NOT_INTERESTED" ||
    choice === "WRONG_NUMBER" ||
    choice === "DO_NOT_CONTACT";

  // Sự kiện React đi xuyên cổng (portal) lên dòng bảng: bấm nền tối để đóng hộp sẽ mở trang lead nếu không chặn ở đây.
  return (
    <div onClick={(e) => e.stopPropagation()} data-no-row-link>
      <Dialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) reset();
        }}
      >
        <DialogTrigger asChild>
          <Button
            size="sm"
            variant="outline"
            disabled={done}
            title={done ? "Khách ở danh sách KHÔNG LIÊN HỆ" : undefined}
          >
            Ghi kết quả
          </Button>
        </DialogTrigger>
        {/* data-no-row-link: cú bấm trong hộp (cả ô chữ) không được mở trang lead của dòng bên dưới. */}
        <DialogContent
          data-no-row-link
          className="max-h-[90vh] overflow-y-auto sm:max-w-xl"
        >
          <DialogHeader>
            <DialogTitle className="truncate">
              {lead.name ?? "Khách sỉ"}
            </DialogTitle>
          </DialogHeader>
          {lead.phone ? (
            <a
              href={`tel:${lead.phone}`}
              onClick={() =>
                void logCallInitiatedAction(lead.id).catch(() => undefined)
              }
              className="flex min-h-11 items-center justify-center rounded-lg bg-emerald-600 text-sm font-semibold text-white"
            >
              📞 Gọi {lead.phoneDisplay}
            </a>
          ) : null}
          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
            {MOBILE_CALL_OUTCOMES.map((o) => (
              <button
                key={o}
                type="button"
                onClick={() => choose(o)}
                className={cn(
                  "flex min-h-10 items-center gap-1.5 rounded-lg border px-2 text-left text-sm font-medium",
                  choice === o
                    ? "border-primary bg-primary/10 ring-2 ring-primary"
                    : "hover:bg-muted",
                )}
              >
                <span>{CALL_OUTCOME_ICON[o]}</span>
                {CALL_OUTCOME_LABEL[o]}
              </button>
            ))}
            <button
              type="button"
              onClick={() => choose(NOTE_ONLY)}
              className={cn(
                "flex min-h-10 items-center gap-1.5 rounded-lg border px-2 text-left text-sm font-medium",
                choice === NOTE_ONLY
                  ? "border-primary bg-primary/10 ring-2 ring-primary"
                  : "hover:bg-muted",
              )}
            >
              <span>📝</span>Chỉ ghi chú
            </button>
          </div>
          {choice ? (
            <div className="space-y-2.5">
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={3}
                autoFocus
                placeholder={
                  choice === NOTE_ONLY ? "Ghi chú (bắt buộc)" : "Ghi chú nhanh…"
                }
                className="w-full rounded-lg border bg-background p-2 text-sm"
              />
              <div className="flex flex-wrap gap-1">
                {QUICK_NOTE_CHIPS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => addChip(c)}
                    className="rounded-full border px-2.5 py-1 text-xs hover:bg-muted"
                  >
                    {c}
                  </button>
                ))}
              </div>
              {!ends ? (
                <div>
                  <div className="mb-1 text-xs font-medium text-muted-foreground">
                    Hẹn gọi lại
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {FOLLOW_OPTIONS.map((f) => (
                      <button
                        key={f.key}
                        type="button"
                        onClick={() => setFollow(f.key)}
                        className={cn(
                          "rounded-full border px-2.5 py-1 text-xs",
                          follow === f.key
                            ? "border-primary bg-primary text-primary-foreground"
                            : "hover:bg-muted",
                        )}
                      >
                        {f.label}
                      </button>
                    ))}
                  </div>
                  {follow === "custom" ? (
                    <input
                      type="date"
                      value={custom}
                      onChange={(e) => setCustom(e.target.value)}
                      className="mt-1.5 h-9 rounded-md border bg-background px-2 text-sm"
                    />
                  ) : null}
                  {effect?.followupRequired && follow === "none" ? (
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      Kết quả này cần hẹn — không chọn thì máy hẹn{" "}
                      {effect.followupDays} ngày nữa lúc 9 giờ.
                    </p>
                  ) : null}
                </div>
              ) : null}
              <Button className="w-full" disabled={saving} onClick={save}>
                {saving ? "Đang lưu…" : "Lưu"}
              </Button>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
