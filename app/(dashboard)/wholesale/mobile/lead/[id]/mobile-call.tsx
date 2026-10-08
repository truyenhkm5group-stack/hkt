"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { logCallAction, logCallInitiatedAction } from "@/lib/actions/wholesale";
import { CALL_OUTCOME_ICON, CALL_OUTCOME_LABEL, callOutcomeEffect, MOBILE_CALL_OUTCOMES, QUICK_NOTE_CHIPS, type CallOutcome, type LeadStatus } from "@/lib/wholesale/constants";
import { cn } from "@/lib/utils";
import { FOLLOW_OPTIONS, followIso, suggestedFollow, type FollowKey } from "@/lib/wholesale/followup";
import type { ZaloDraft } from "@/lib/wholesale/leads";
import { ZaloPanel } from "@/app/(dashboard)/wholesale/zalo-panel";

export type MobileLeadInfo = {
  id: string;
  status: LeadStatus;
  phoneE164: string | null;
  phoneDisplay: string | null;
  mapsUrl: string | null;
  website: string | null;
  zaloUrl: string | null;
  doNotContact: boolean;
};

/** Lượt bấm gọi chưa ghi kết quả — sống qua lúc người bán rời sang ứng dụng gọi rồi quay lại (trình duyệt có thể nạp lại trang). */
const PENDING_KEY = "wholesale-mobile-pending-call";
const PENDING_TTL_MS = 2 * 3_600_000;

function readPending(): { id: string; at: number } | null {
  try {
    const v = JSON.parse(localStorage.getItem(PENDING_KEY) ?? "null") as { id?: unknown; at?: unknown } | null;
    return v && typeof v.id === "string" && typeof v.at === "number" && Date.now() - v.at < PENDING_TTL_MS ? { id: v.id, at: v.at } : null;
  } catch {
    return null;
  }
}
function writePending(v: { id: string; at: number } | null) {
  try {
    if (v) localStorage.setItem(PENDING_KEY, JSON.stringify(v));
    else localStorage.removeItem(PENDING_KEY);
  } catch {
    /* chế độ riêng tư / chặn lưu trữ — bảng kết quả vẫn mở bằng nút «Ghi kết quả» */
  }
}

/**
 * Nút GỌI NGAY + bảng «Kết quả cuộc gọi?». Bấm gọi chỉ mở ứng dụng gọi (`tel:`) và ghi lượt BẤM (`CALL_INITIATED`) — không
 * tự coi là đã nói chuyện. Quay lại ERP ⇒ bảng kết quả tự bật; chọn một nút lớn ⇒ ghi chú nhanh + hẹn gọi lại gợi ý sẵn ⇒
 * Lưu ⇒ sang khách tiếp theo. Trạng thái lead do máy chủ suy ra (`callOutcomeEffect`), người bán không phải chọn.
 */
export function MobileCall({ lead, nextHref, canWork, zalo }: { lead: MobileLeadInfo; nextHref: string; canWork: boolean; zalo: ZaloDraft | null }) {
  const router = useRouter();
  const [sheet, setSheet] = useState(false);
  const [outcome, setOutcome] = useState<CallOutcome | null>(null);
  const [note, setNote] = useState("");
  const [follow, setFollow] = useState<FollowKey>("none");
  const [custom, setCustom] = useState("");
  const [saving, setSaving] = useState(false);
  const [channel, setChannel] = useState<"PHONE_CALL" | "ZALO">("PHONE_CALL");

  useEffect(() => {
    const check = () => {
      if (document.visibilityState === "visible" && readPending()?.id === lead.id) setSheet(true);
    };
    check();
    document.addEventListener("visibilitychange", check);
    return () => document.removeEventListener("visibilitychange", check);
  }, [lead.id]);

  const onCall = () => {
    writePending({ id: lead.id, at: Date.now() });
    // Không chờ: trình duyệt đang chuyển sang ứng dụng gọi. Lỗi ghi lượt bấm không được chặn cuộc gọi.
    void logCallInitiatedAction(lead.id).catch(() => undefined);
  };
  const choose = (o: CallOutcome) => {
    setOutcome(o);
    setFollow(suggestedFollow(callOutcomeEffect(lead.status, o).followupDays));
  };
  const addChip = (c: string) => setNote((n) => (n.trim() ? `${n.trim()}; ${c}` : c));
  const save = async () => {
    if (!outcome || saving) return;
    setSaving(true);
    const r = await logCallAction(lead.id, { outcome, note, nextFollowupAt: followIso(follow, custom), channel });
    if ("error" in r) {
      setSaving(false);
      toast.error(r.error);
      return;
    }
    writePending(null);
    toast.success(`Đã lưu: ${CALL_OUTCOME_LABEL[outcome]}`);
    router.push(nextHref);
  };
  const effect = outcome ? callOutcomeEffect(lead.status, outcome) : null;
  const small = "flex min-h-11 flex-1 items-center justify-center gap-1 rounded-xl border bg-card px-2 text-sm font-medium active:bg-muted";

  return (
    <div className="space-y-3">
      {/* Nhắn Zalo TRƯỚC (chủ shop 06/10/2026): đã gửi ⇒ sang khách kế tiếp; không có Zalo ⇒ ở lại gọi điện. */}
      {canWork && zalo && (zalo.link || zalo.zaloStatus === "NOT_FOUND") ? (
        <ZaloPanel leadId={lead.id} initial={zalo} big onResult={(r) => (r === "NOT_FOUND" ? router.refresh() : router.push(nextHref))} />
      ) : null}
      {lead.doNotContact ? (
        <p className="rounded-xl bg-rose-50 p-3 text-sm text-rose-900 dark:bg-rose-950 dark:text-rose-200">Khách ở danh sách KHÔNG LIÊN HỆ — không gọi.</p>
      ) : lead.phoneE164 ? (
        <a href={`tel:${lead.phoneE164}`} onClick={onCall} className="flex min-h-16 w-full items-center justify-center rounded-2xl bg-emerald-600 text-lg font-bold text-white shadow-md active:scale-[0.99]">
          📞 GỌI NGAY · {lead.phoneDisplay}
        </a>
      ) : (
        <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">Chưa có SĐT — mở Google Maps để xem.</p>
      )}
      <div className="flex gap-2">
        {lead.phoneDisplay ? (
          <button
            type="button"
            className={small}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(lead.phoneDisplay!.replace(/\s/g, ""));
                toast.success("Đã chép SĐT");
              } catch {
                toast.error("Trình duyệt không cho chép");
              }
            }}
          >
            📋 Chép SĐT
          </button>
        ) : null}
        {lead.mapsUrl ? (
          <a href={lead.mapsUrl} target="_blank" rel="noopener noreferrer" className={small}>
            🗺 Bản đồ
          </a>
        ) : null}
        {lead.zaloUrl ? (
          <a href={lead.zaloUrl} target="_blank" rel="noopener noreferrer" className={small}>
            💬 Zalo
          </a>
        ) : null}
        {lead.website ? (
          <a href={lead.website} target="_blank" rel="noopener noreferrer nofollow" className={small}>
            🌐 Web
          </a>
        ) : null}
      </div>
      {canWork && !lead.doNotContact ? (
        <div className="flex gap-2">
          <button type="button" onClick={() => setSheet(true)} className="flex min-h-12 flex-1 items-center justify-center rounded-xl border-2 border-primary text-base font-semibold text-primary">
            ✍️ Ghi kết quả cuộc gọi
          </button>
          <Link href={nextHref} className="flex min-h-12 items-center justify-center rounded-xl border px-4 text-sm font-medium">
            Bỏ qua ⏭
          </Link>
        </div>
      ) : null}

      {sheet && canWork ? (
        <div className="fixed inset-0 z-50 flex items-end bg-black/40" onClick={() => !saving && setSheet(false)}>
          <div className="max-h-[90vh] w-full overflow-y-auto rounded-t-2xl bg-background px-4 pt-4 shadow-xl" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Kết quả cuộc gọi">
            <div className="mx-auto mb-3 h-1.5 w-10 rounded-full bg-muted" />
            <div className="mb-2 text-center text-lg font-bold">Kết quả cuộc gọi?</div>
            <div className="mb-3 flex justify-center gap-1.5 text-sm">
              {(["PHONE_CALL", "ZALO"] as const).map((c) => (
                <button key={c} type="button" onClick={() => setChannel(c)} className={cn("rounded-full border px-3 py-1.5", channel === c ? "border-primary bg-primary text-primary-foreground" : "bg-card")}>
                  {c === "ZALO" ? "💬 Khách trả lời Zalo" : "📞 Gọi điện"}
                </button>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-2">
              {MOBILE_CALL_OUTCOMES.map((o) => (
                <button key={o} type="button" onClick={() => choose(o)} className={cn("flex min-h-14 items-center gap-2 rounded-xl border px-3 text-left text-sm font-semibold", outcome === o ? "border-primary bg-primary/10 ring-2 ring-primary" : "bg-card active:bg-muted")}>
                  <span className="text-xl">{CALL_OUTCOME_ICON[o]}</span>
                  {CALL_OUTCOME_LABEL[o]}
                </button>
              ))}
            </div>
            {outcome ? (
              <div className="mt-4 space-y-3">
                <textarea aria-label="Ghi chú cuộc gọi" value={note} onChange={(e) => setNote(e.target.value)} rows={3} autoFocus placeholder="Ghi chú nhanh… (bấm micro trên bàn phím để nói)" className="w-full rounded-xl border bg-background p-3 text-base" />
                <div className="flex flex-wrap gap-1.5">
                  {QUICK_NOTE_CHIPS.map((c) => (
                    <button key={c} type="button" onClick={() => addChip(c)} className="rounded-full border bg-card px-3 py-1.5 text-sm active:bg-muted">
                      {c}
                    </button>
                  ))}
                </div>
                {outcome !== "NOT_INTERESTED" && outcome !== "WRONG_NUMBER" && outcome !== "DO_NOT_CONTACT" ? (
                  <div>
                    <div className="mb-1.5 text-sm font-medium">Hẹn gọi lại</div>
                    <div className="flex flex-wrap gap-1.5">
                      {FOLLOW_OPTIONS.map((f) => (
                        <button key={f.key} type="button" onClick={() => setFollow(f.key)} className={cn("rounded-full border px-3 py-1.5 text-sm", follow === f.key ? "border-primary bg-primary text-primary-foreground" : "bg-card")}>
                          {f.label}
                        </button>
                      ))}
                    </div>
                    {follow === "custom" ? <input aria-label="Ngày hẹn gọi lại" type="date" value={custom} onChange={(e) => setCustom(e.target.value)} className="mt-2 h-11 w-full rounded-xl border bg-background px-3 text-base" /> : null}
                    {effect?.followupRequired && follow === "none" ? <p className="mt-1 text-xs text-muted-foreground">Kết quả này cần hẹn gọi lại — không chọn thì máy hẹn {effect.followupDays} ngày nữa lúc 9 giờ.</p> : null}
                  </div>
                ) : null}
                <div className="sticky bottom-0 -mx-4 border-t bg-background px-4 pb-6 pt-3">
                  <button type="button" disabled={saving} onClick={save} className="flex min-h-14 w-full items-center justify-center rounded-xl bg-primary text-base font-bold text-primary-foreground disabled:opacity-60">
                    {saving ? "Đang lưu…" : "Lưu & gọi khách tiếp theo ⏭"}
                  </button>
                </div>
              </div>
            ) : (
              <div className="h-6" />
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
