"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, ExternalLink, Loader2, Rocket, XCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { checkDomainSlugAction, publishAction, setDomainSlugAction } from "@/lib/actions/publish";
import { domainSlugProblem } from "@/lib/platform/host";
import type { PublishCheck, PublishState } from "@/lib/platform/publish";
import { cn } from "@/lib/utils";

/** Ô chọn tên miền con: kiểm dạng ngay trên trình duyệt (cùng hàm với máy chủ), kiểm trùng ở máy chủ, rồi giữ tên. */
export function DomainForm({ current, baseDomain, locked }: { current: string | null; baseDomain: string | null; locked: boolean }) {
  const router = useRouter();
  const [slug, setSlug] = useState(current ?? "");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const local = slug ? domainSlugProblem(slug) : null;

  const check = () =>
    start(async () => {
      const r = await checkDomainSlugAction(slug);
      setMsg("error" in r ? { ok: false, text: r.error } : { ok: true, text: r.url ? `Dùng được: ${r.url.replace(/^https?:\/\//, "")}` : "Tên dùng được." });
    });
  const save = () =>
    start(async () => {
      const r = await setDomainSlugAction(slug);
      if ("error" in r) setMsg({ ok: false, text: r.error });
      else {
        setMsg({ ok: true, text: r.message });
        toast.success(r.message);
        router.refresh();
      }
    });

  if (locked) return <p className="text-sm">Tên miền con đã khoá sau khi xuất bản: <b>{current}</b>{baseDomain ? `.${baseDomain}` : ""}</p>;
  return (
    <div className="max-w-xl space-y-2">
      <div className="flex items-center gap-2">
        <Input value={slug} maxLength={31} placeholder="vd hslc" aria-label="Tên miền con" onChange={(e) => {
          setSlug(e.target.value.trim().toLowerCase());
          setMsg(null);
        }} />
        {baseDomain ? <span className="shrink-0 text-sm text-muted-foreground">.{baseDomain}</span> : null}
      </div>
      {local ? <p className="text-xs text-destructive">{local.message}</p> : null}
      {msg ? <p className={cn("text-xs", msg.ok ? "text-emerald-700" : "text-destructive")} data-testid="slug-message">{msg.text}</p> : null}
      <div className="flex gap-2">
        <Button type="button" size="sm" variant="outline" disabled={pending || !slug || Boolean(local)} onClick={check}>
          Kiểm tra
        </Button>
        <Button type="button" size="sm" disabled={pending || !slug || Boolean(local) || slug === current} onClick={save}>
          {pending ? <Loader2 className="size-4 animate-spin" /> : null}
          Giữ tên này
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">Chữ thường không dấu, số, gạch ngang; 2–31 ký tự. Đổi được tới lúc xuất bản.</p>
    </div>
  );
}

/**
 * Danh sách kiểm + nút Xuất bản + «Mở ERP của tôi». Máy chủ kiểm LẠI toàn bộ khi bấm — màn hình chỉ là bản đọc. `shell` (vỏ Chốt
 * Đơn): chỉ đổi CHỮ của nút — «cửa hàng» thay «ERP».
 */
export function PublishPanel({ state, checks, ready, erpUrl, chatUrl, fallbackUrl, orgCode, shell = false }: { state: PublishState; checks: PublishCheck[]; ready: boolean; erpUrl: string | null; chatUrl: string | null; fallbackUrl: string; orgCode: string; shell?: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [result, setResult] = useState<{ url: string | null; message: string } | null>(null);
  const [failed, setFailed] = useState<PublishCheck[] | null>(null);
  const publish = () =>
    start(async () => {
      const r = await publishAction();
      if ("error" in r) {
        toast.error(r.error);
        if (r.checks) setFailed(r.checks);
      } else {
        toast.success(r.message);
        setResult({ url: r.publication.url ? `${r.publication.url}/login` : null, message: r.message });
        router.refresh();
      }
    });
  const shown = failed ?? checks;
  const openUrl = result?.url ?? erpUrl;
  return (
    <div className="space-y-3">
      <ul className="space-y-1.5" data-testid="publish-checks">
        {shown.map((c) => (
          <li key={c.key} className="flex items-start gap-2 text-sm" data-check={c.key} data-ok={c.ok ? "1" : "0"}>
            {c.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600" /> : <XCircle className={cn("mt-0.5 size-4 shrink-0", c.blocking ? "text-destructive" : "text-amber-500")} />}
            <span>
              <b>{c.label}</b>
              {c.blocking ? "" : " (nhắc)"} — {c.detail}{" "}
              {c.href && !c.ok ? (
                <a href={c.href} className="text-xs text-primary underline underline-offset-2">
                  Sửa
                </a>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
      {state === "PUBLISHED" || result ? (
        <div className="flex flex-wrap items-center gap-3">
          {openUrl ? (
            <Button asChild data-testid="open-my-erp">
              <a href={openUrl} target="_blank" rel="noreferrer">
                <ExternalLink /> {shell ? "MỞ CỬA HÀNG CỦA TÔI" : "MỞ ERP CỦA TÔI"}
              </a>
            </Button>
          ) : (
            <Button asChild variant="outline" data-testid="open-my-erp">
              <a href={fallbackUrl} target="_blank" rel="noreferrer">
                <ExternalLink /> {shell ? "MỞ CỬA HÀNG CỦA TÔI" : "MỞ ERP CỦA TÔI"} ({shell ? "mã cửa hàng" : "mã tổ chức"} «{orgCode}»)
              </a>
            </Button>
          )}
          {chatUrl ? (
            <a href={chatUrl} target="_blank" rel="noreferrer" className="text-sm text-primary underline underline-offset-2">
              Trang chat công khai
            </a>
          ) : null}
        </div>
      ) : (
        <Button type="button" onClick={publish} disabled={pending || !ready} data-testid="publish-button">
          {pending ? <Loader2 className="size-4 animate-spin" /> : <Rocket />}
          XUẤT BẢN
        </Button>
      )}
      {!ready && state !== "PUBLISHED" ? <p className="text-xs text-destructive">Sửa các mục đỏ trước khi xuất bản.</p> : null}
    </div>
  );
}
