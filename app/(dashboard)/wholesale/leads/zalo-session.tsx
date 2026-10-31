"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { logZaloOpenedAction, logZaloResultAction } from "@/lib/actions/wholesale";
import { zaloSessionPrepareAction } from "@/lib/actions/wholesale-bulk";
import type { ZaloSessionItem } from "@/lib/wholesale/bulk-outreach";

/**
 * PHIÊN NHẮN ZALO TUẦN TỰ (hành động hàng loạt «Nhắn Zalo cho N khách»). ERP KHÔNG tự gửi Zalo: Zalo cá nhân không có API, và
 * gửi tự động là khoá nick + trái ràng buộc dự án. Mỗi khách: tin cá nhân hoá → «Chép tin & mở Zalo» (zalo.me/<số>, chỉ
 * mở app — máy không gọi mạng Zalo) → nhân viên bấm Gửi trong Zalo → bấm «Đã gửi / Không có Zalo / Bỏ qua» (ghi qua đúng
 * `logZaloResultCore` sẵn có) → khách kế. Tiến độ nhớ trong trình duyệt nên dừng giữa chừng vẫn tiếp tục được; khách đã có
 * kết quả Zalo hôm nay (phiên trước / người khác) tự được bỏ qua.
 */

type Mark = "SENT" | "NOT_FOUND" | "SKIP";
const MARK_LABEL: Record<Mark, string> = { SENT: "Đã gửi", NOT_FOUND: "Không có Zalo", SKIP: "Bỏ qua" };

function storageKey(ids: readonly string[]): string {
  const sorted = [...ids].sort().join(",");
  let h = 0;
  for (let i = 0; i < sorted.length; i++) h = (h * 31 + sorted.charCodeAt(i)) | 0;
  return `wholesale-zalo-session:${ids.length}:${(h >>> 0).toString(36)}`;
}

export function ZaloSessionDialog({ leadIds, open, onOpenChange }: { leadIds: string[]; open: boolean; onOpenChange: (v: boolean) => void }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [items, setItems] = useState<ZaloSessionItem[] | null>(null);
  const [outOfScope, setOutOfScope] = useState(0);
  const [marks, setMarks] = useState<Record<string, Mark>>({});
  const key = useMemo(() => storageKey(leadIds), [leadIds]);

  useEffect(() => {
    if (!open || items) return;
    start(async () => {
      const r = await zaloSessionPrepareAction({ leadIds });
      if ("error" in r) return void toast.error(r.error);
      setItems(r.items);
      setOutOfScope(r.outOfScope);
      try {
        const saved = JSON.parse(window.localStorage.getItem(key) ?? "{}") as Record<string, Mark>;
        setMarks(saved && typeof saved === "object" ? saved : {});
      } catch {
        setMarks({});
      }
    });
  }, [open, items, leadIds, key]);

  const save = (next: Record<string, Mark>) => {
    setMarks(next);
    try {
      window.localStorage.setItem(key, JSON.stringify(next));
    } catch {
      /* trình duyệt chặn lưu cục bộ — phiên vẫn chạy, chỉ không nhớ khi đóng */
    }
  };

  const zaloable = (items ?? []).filter((i) => i.link && !i.reason && !i.suggestion);
  const others = (items ?? []).filter((i) => !(i.link && !i.reason && !i.suggestion));
  const isDone = (i: ZaloSessionItem) => Boolean(marks[i.leadId] || i.doneToday);
  const current = zaloable.find((i) => !isDone(i)) ?? null;
  const processed = zaloable.filter(isDone).length;

  const openZalo = (i: ZaloSessionItem) =>
    start(async () => {
      try {
        await navigator.clipboard.writeText(i.text);
        toast.success("Đã chép tin — dán vào ô chat Zalo rồi bấm Gửi");
      } catch {
        toast.error("Trình duyệt chặn sao chép — bôi đen tin rồi Ctrl+C.");
      }
      if (i.link) window.open(i.link, "_blank", "noopener,noreferrer");
      const r = await logZaloOpenedAction(i.leadId);
      if ("error" in r) toast.error(r.error);
    });
  const mark = (i: ZaloSessionItem, m: Mark) =>
    start(async () => {
      if (m !== "SKIP") {
        const r = await logZaloResultAction(i.leadId, { result: m, note: "Phiên nhắn Zalo tuần tự" });
        if ("error" in r) return void toast.error(r.error);
      }
      save({ ...marks, [i.leadId]: m });
    });

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v);
        if (!v) {
          setItems(null);
          router.refresh();
        }
      }}
    >
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Phiên nhắn Zalo — {leadIds.length} khách</DialogTitle>
          <DialogDescription>Nhắn TỪNG khách bằng Zalo của bạn. ERP không tự gửi Zalo (không có API, gửi tự động bị khoá nick) — chỉ chép tin cá nhân hoá, mở đúng khung chat và ghi kết quả.</DialogDescription>
        </DialogHeader>
        {!items ? (
          <p className="text-sm text-muted-foreground">{pending ? "Đang dựng danh sách…" : "Chưa có danh sách."}</p>
        ) : (
          <div className="space-y-3 text-sm">
            <div>
              <div className="flex justify-between text-xs">
                <span>
                  Đã xử lý <b>{processed}</b> / {zaloable.length} khách nhắn được Zalo
                </span>
                {outOfScope ? <span className="text-muted-foreground">{outOfScope} khách ngoài phạm vi dữ liệu — không vào phiên</span> : null}
              </div>
              <div className="mt-1 h-2 overflow-hidden rounded-full bg-muted">
                <div className="h-full bg-primary" style={{ width: `${zaloable.length ? Math.round((processed / zaloable.length) * 100) : 0}%` }} />
              </div>
            </div>
            {current ? (
              <div className="space-y-2 rounded-lg border p-3">
                <div className="font-semibold">{current.name}</div>
                <div className="text-xs text-muted-foreground tabular-nums">{current.phoneDisplay}</div>
                <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap rounded-md bg-muted/40 p-2 text-xs">{current.text}</pre>
                <div className="flex flex-wrap gap-2">
                  <Button onClick={() => openZalo(current)} disabled={pending}>
                    Chép tin & mở Zalo
                  </Button>
                  <Button variant="secondary" onClick={() => mark(current, "SENT")} disabled={pending}>
                    Đã gửi
                  </Button>
                  <Button variant="outline" onClick={() => mark(current, "NOT_FOUND")} disabled={pending}>
                    Không có Zalo
                  </Button>
                  <Button variant="ghost" onClick={() => mark(current, "SKIP")} disabled={pending}>
                    Bỏ qua
                  </Button>
                </div>
              </div>
            ) : (
              <p className="rounded-lg border border-dashed p-3 text-center text-muted-foreground">{zaloable.length ? "Xong phiên — mọi khách nhắn được đều đã có kết quả." : "Không có khách nào nhắn được Zalo trong lựa chọn này."}</p>
            )}
            {zaloable.some(isDone) ? (
              <details>
                <summary className="cursor-pointer text-xs text-muted-foreground">Đã xử lý ({processed})</summary>
                <ul className="mt-1 space-y-0.5 text-xs">
                  {zaloable.filter(isDone).map((i) => (
                    <li key={i.leadId}>
                      {i.name} — {marks[i.leadId] ? MARK_LABEL[marks[i.leadId]!] : `đã có kết quả hôm nay (${i.doneToday})`}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
            {others.length ? (
              <div className="rounded-md border p-2">
                <div className="text-xs font-semibold">Không nhắn Zalo được ({others.length})</div>
                <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                  {others.map((i) => (
                    <li key={i.leadId}>
                      <b className="text-foreground">{i.name}</b> — {i.suggestion ?? i.reason ?? "không có link Zalo"}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
