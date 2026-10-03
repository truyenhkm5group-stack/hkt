"use client";

import { useState, useTransition, type KeyboardEvent } from "react";
import { Check, Copy, ExternalLink, Loader2, RefreshCw, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { resolveMetaAdPosts, syncMetaAdPosts, type AdPostRow } from "@/lib/actions/meta-ad-post";
import { META_AD_POST_BATCH_MAX, POST_RESOLUTION_SOURCE_LABEL } from "@/lib/constants/meta-ad-post";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

type Notice = { tone: "ok" | "err" | "info"; text: string };

/** Nút chép có phản hồi "Đã chép" 1,5 giây. Không có Clipboard API (http thường) thì nói thẳng. */
function CopyButton({ value, label }: { value: string | null; label: string }) {
  const [state, setState] = useState<"idle" | "done" | "fail">("idle");
  if (!value) return null;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setState("done");
    } catch {
      setState("fail");
    }
    setTimeout(() => setState("idle"), 1500);
  };
  return (
    <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={copy} aria-label={`Chép ${label}`}>
      {state === "done" ? <Check className="size-3.5 text-emerald-600" /> : <Copy className="size-3.5" />}
      <span className="ml-1">{state === "done" ? "Đã chép" : state === "fail" ? "Không chép được" : "Copy"}</span>
    </Button>
  );
}

function Field({ label, value, copy = true, hint }: { label: string; value: string | null; copy?: boolean; hint?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 border-b py-1.5 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
      <span className="shrink-0 text-xs text-muted-foreground" title={hint}>
        {label}
      </span>
      <span className="flex min-w-0 items-center gap-1">
        <span className={cn("min-w-0 break-all font-mono text-sm", !value && "text-muted-foreground")}>{value || "—"}</span>
        {copy ? <CopyButton value={value} label={label} /> : null}
      </span>
    </div>
  );
}

function ErpLine({ row }: { row: AdPostRow }) {
  const erp = row.erp;
  if (!erp) return null;
  const parts: string[] = [];
  if (erp.stored) {
    const same = erp.stored.storyId && erp.stored.storyId === row.objectStoryId;
    parts.push(
      erp.stored.storyId
        ? `ERP đã lưu bài ${same ? "này" : `KHÁC (${erp.stored.storyId})`} · hỏi Meta lần cuối ${formatDateTime(erp.stored.fetchedAt)}`
        : `ERP có mẩu này nhưng chưa có bài · hỏi Meta lần cuối ${formatDateTime(erp.stored.fetchedAt)}`,
    );
  } else parts.push("Chưa có trong sổ quảng cáo của ERP");
  if (erp.creativeVariantIds.length) parts.push(`là mẫu của vòng mẫu (${erp.creativeVariantIds.length})`);
  return <p className="text-xs text-muted-foreground">{parts.join(" · ")}</p>;
}

function OpenPost({ row, compact = false }: { row: AdPostRow; compact?: boolean }) {
  if (!row.openUrl) return null;
  return (
    <Button asChild variant="outline" size="sm" className={cn(compact && "h-7 px-2 text-xs")}>
      <a href={row.openUrl.url} target="_blank" rel="noopener noreferrer" title={row.openUrl.constructed ? "Link DỰNG từ Page ID + Post ID (Meta không trả permalink cho token này). Bài ẩn chỉ mở được khi bạn có quyền trên fanpage." : "permalink_url do Meta trả"}>
        <ExternalLink className="size-3.5" />
        <span className="ml-1">{compact ? "Mở" : row.openUrl.constructed ? "Mở trên Facebook (link dựng)" : "Mở trên Facebook"}</span>
      </a>
    </Button>
  );
}

function DetailCard({ row, canSync, syncing, onSync }: { row: AdPostRow; canSync: boolean; syncing: boolean; onSync: (ids: string[]) => void }) {
  return (
    <div className="rounded-xl border p-4">
      <p className={cn("mb-2 text-sm font-medium", row.ok ? "text-emerald-700 dark:text-emerald-400" : "text-destructive")}>
        {row.ok ? "✓ Đã tìm thấy" : `✗ ${row.message}`}
      </p>
      {row.adFound ? (
        <div className="grid gap-x-6 sm:grid-cols-2">
          <Field label="Tên quảng cáo" value={row.adName} copy={false} />
          <Field label="Ad ID" value={row.adId} />
          <Field label="Chiến dịch" value={row.campaignName || row.campaignId} copy={false} />
          <Field label="Tài khoản QC" value={row.adAccountId ? `act_${row.adAccountId}` : null} />
          <Field label="Creative ID" value={row.creativeId} />
          <Field label="Fanpage" value={row.pageName} copy={false} hint={row.pageNameSource === "ERP_FANPAGE" ? "Tên lấy từ sổ fanpage của ERP (Meta không cho đọc tên trang)" : undefined} />
          <Field label="Page ID" value={row.pageId} />
          <Field label="Post ID" value={row.postId} />
          <Field label="Object Story ID" value={row.objectStoryId} hint={row.resolutionSource ? `Nguồn: ${POST_RESOLUTION_SOURCE_LABEL[row.resolutionSource]}` : undefined} />
          <Field label="Nguồn" value={row.resolutionSource ? POST_RESOLUTION_SOURCE_LABEL[row.resolutionSource] : null} copy={false} />
        </div>
      ) : (
        <Field label="Ad ID" value={row.adId} />
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <OpenPost row={row} />
        {canSync && row.adFound ? (
          <Button type="button" size="sm" onClick={() => onSync([row.adId])} disabled={syncing}>
            {syncing ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
            <span className="ml-1">Đồng bộ vào ERP</span>
          </Button>
        ) : null}
      </div>
      <div className="mt-2">
        <ErpLine row={row} />
      </div>
    </div>
  );
}

function BatchTable({ rows, canSync, syncing, onSync }: { rows: AdPostRow[]; canSync: boolean; syncing: boolean; onSync: (ids: string[]) => void }) {
  const found = rows.filter((r) => r.adFound).map((r) => r.adId);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm">
          {rows.filter((r) => r.ok).length}/{rows.length} mẩu ra được bài viết
        </p>
        {canSync && found.length ? (
          <Button type="button" size="sm" onClick={() => onSync(found)} disabled={syncing}>
            {syncing ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
            <span className="ml-1">Đồng bộ {found.length} mẩu vào ERP</span>
          </Button>
        ) : null}
      </div>
      <div className="overflow-x-auto rounded-xl border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-xs text-muted-foreground">
            <tr>
              <th className="px-2 py-1.5 text-left font-medium">Ad ID</th>
              <th className="px-2 py-1.5 text-left font-medium">Tên quảng cáo</th>
              <th className="px-2 py-1.5 text-left font-medium">Creative</th>
              <th className="px-2 py-1.5 text-left font-medium">Fanpage</th>
              <th className="px-2 py-1.5 text-left font-medium">Post ID</th>
              <th className="px-2 py-1.5 text-left font-medium">Trạng thái</th>
              <th className="px-2 py-1.5 text-right font-medium" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.adId} className="border-t align-top">
                <td className="px-2 py-1.5 font-mono text-xs">{r.adId}</td>
                <td className="max-w-[16rem] px-2 py-1.5">
                  <span className="line-clamp-2" title={r.adName}>
                    {r.adName || "—"}
                  </span>
                </td>
                <td className="px-2 py-1.5 font-mono text-xs">{r.creativeId || "—"}</td>
                <td className="px-2 py-1.5 text-xs" title={r.pageId ?? undefined}>
                  {r.pageName || r.pageId || "—"}
                </td>
                <td className="px-2 py-1.5 font-mono text-xs" title={r.objectStoryId ?? undefined}>
                  {r.postId || "—"}
                </td>
                <td className="px-2 py-1.5 text-xs">
                  {r.ok ? <span className="text-emerald-700 dark:text-emerald-400">✓ Tìm thấy</span> : <span className="text-destructive" title={r.message}>{r.error}</span>}
                </td>
                <td className="px-2 py-1.5">
                  <div className="flex justify-end gap-1">
                    <CopyButton value={r.objectStoryId} label="Object Story ID" />
                    <OpenPost row={r} compact />
                    {canSync && r.adFound ? (
                      <Button type="button" variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={() => onSync([r.adId])} disabled={syncing}>
                        Sync
                      </Button>
                    ) : null}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">Nút Copy trong bảng chép Object Story ID (PAGEID_POSTID) — đủ cả Page ID lẫn Post ID. Rê chuột lên mã lỗi để đọc lý do.</p>
    </div>
  );
}

export function PostResolverPanel({ canSync }: { canSync: boolean }) {
  const [input, setInput] = useState("");
  const [rows, setRows] = useState<AdPostRow[] | null>(null);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [resolving, startResolve] = useTransition();
  const [syncing, startSync] = useTransition();
  const [allowSync, setAllowSync] = useState(canSync);

  const resolve = () =>
    startResolve(async () => {
      setNotices([]);
      const r = await resolveMetaAdPosts(input);
      if ("error" in r) {
        setRows(null);
        setNotices([{ tone: "err", text: r.error }]);
        return;
      }
      setRows(r.rows);
      setAllowSync(r.canSync);
      const n: Notice[] = [];
      for (const p of r.previewLinks) {
        const scanned = r.previewScan ? ` (dò ${r.previewScan.scannedAds.toLocaleString("vi-VN")} mẩu ở ${r.previewScan.scannedAccounts}/${r.previewScan.totalAccounts} tài khoản)` : "";
        n.push(p.adId ? { tone: "ok", text: `Link chia sẻ → Ad ID ${p.adId}: Meta khai mẩu này mang đúng link đó${scanned}.` } : { tone: "err", text: `Link chia sẻ "${p.url.slice(0, 60)}" chưa ra Ad ID — ${p.reason}` });
      }
      if (r.invalid.length) n.push({ tone: "info", text: `Bỏ qua ${r.invalid.length} dòng không phải Ad ID: ${r.invalid.slice(0, 3).map((i) => `"${i.raw.slice(0, 40)}" — ${i.reason}`).join(" · ")}${r.invalid.length > 3 ? " …" : ""}` });
      if (r.duplicates) n.push({ tone: "info", text: `Gộp ${r.duplicates} mã trùng.` });
      if (r.overflow) n.push({ tone: "err", text: `Chỉ tra ${META_AD_POST_BATCH_MAX} mã mỗi lượt — còn ${r.overflow} mã chưa tra, dán lại ở lượt sau.` });
      setNotices(n);
    });

  const sync = (ids: string[]) =>
    startSync(async () => {
      const r = await syncMetaAdPosts(ids);
      if ("error" in r) {
        setNotices([{ tone: "err", text: r.error }]);
        return;
      }
      // Kết quả tra LẠI ở máy chủ thay cho dòng cũ trên màn hình — đó là thứ vừa được ghi.
      setRows((cur) => (cur ?? []).map((row) => r.rows.find((x) => x.adId === row.adId) ?? row));
      const s = r.saved;
      const text = `Đã đồng bộ: ${s.inserted} mẩu mới · ${s.updated} mẩu cập nhật · ${s.unchanged} mẩu không đổi${s.skipped.length ? ` · ${s.skipped.length} mẩu KHÔNG ghi (Meta không trả về)` : ""}.`;
      setNotices([{ tone: s.skipped.length ? "info" : "ok", text }]);
    });

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter = tra; Shift+Enter = xuống dòng để dán nhiều mã.
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (!resolving && input.trim()) resolve();
    }
  };

  return (
    <section className="space-y-4">
      <div className="rounded-xl border p-4">
        <p className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground">META AD → POST</p>
        <form
          className="flex flex-col gap-2 sm:flex-row sm:items-start"
          onSubmit={(e) => {
            e.preventDefault();
            resolve();
          }}
        >
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            rows={input.includes("\n") ? 5 : 1}
            placeholder="Ad ID, ví dụ 120248409213230618 — link feed_demo_ad=… — hoặc link chia sẻ https://fb.me/adspreview/facebook/…  (Shift+Enter để dán nhiều mã)"
            aria-label="Facebook Ad ID"
            className="min-h-9 flex-1 resize-y font-mono text-sm"
            autoFocus
          />
          <Button type="submit" disabled={resolving || !input.trim()} className="shrink-0">
            {resolving ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
            <span className="ml-1">{resolving ? "Đang hỏi Meta…" : "Lấy Post ID"}</span>
          </Button>
        </form>
        <p className="mt-1.5 text-xs text-muted-foreground">Mỗi dòng một mã, tối đa {META_AD_POST_BATCH_MAX} mã. feed_demo_ad chỉ là Ad ID để tra — không phải Post ID. Link chia sẻ (nút Chia sẻ trong Xem trước quảng cáo, dòng &quot;đăng nhập bằng Facebook&quot;) không chứa Ad ID: ERP dò mẩu nào Meta khai mang đúng link đó, nên mất vài giây.</p>
      </div>

      {notices.map((n, i) => (
        <p
          key={i}
          role={n.tone === "err" ? "alert" : "status"}
          className={cn("rounded-lg border px-3 py-2 text-sm", n.tone === "err" ? "border-destructive/40 text-destructive" : n.tone === "ok" ? "border-emerald-500/40 text-emerald-700 dark:text-emerald-400" : "text-muted-foreground")}
        >
          {n.text}
        </p>
      ))}

      {rows && rows.length === 1 ? <DetailCard row={rows[0]} canSync={allowSync} syncing={syncing} onSync={sync} /> : null}
      {rows && rows.length > 1 ? <BatchTable rows={rows} canSync={allowSync} syncing={syncing} onSync={sync} /> : null}
    </section>
  );
}
