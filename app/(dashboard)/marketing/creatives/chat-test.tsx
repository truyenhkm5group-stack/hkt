"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { AlertTriangle, CheckCircle2, CircleHelp, Loader2, MessageCircle, Send, Trash2, Upload, XCircle } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { addAdTestColorAction, chatAdTestAction, loadAdTestAction, removeAdTestColorAction, saveAdTestInfoAction, setAdTestLiveAction, setAdTestPageAction, uploadAdTestColorAction } from "@/lib/actions/chatbot-ad-test";
import type { AdTestView, ReadinessStatus } from "@/lib/constants/chatbot-ad-bots";

/**
 * NÚT "CHAT TEST" của một camp: ảnh & màu (AI đổi màu ảnh quảng cáo) → giá & chất vải → chat thử với CHÍNH bot thật →
 * bật cho khách thật. Bảng kiểm bên trên nói page của camp đã vào Pancake chưa, bot đã có token chưa, còn thiếu gì.
 * Luật: tệp máy chủ ad-test.ts trong lib/integrations/chatbot.
 */

type Msg = { role: "user" | "model"; text: string; imageIds?: string[]; handoff?: boolean };
type ActionResult = { ok: true; message: string; warning: string | null } | { error: string };

const STATUS_ICON: Record<ReadinessStatus, React.ReactNode> = {
  OK: <CheckCircle2 className="size-4 text-emerald-600" />,
  MISSING: <XCircle className="size-4 text-destructive" />,
  WARN: <AlertTriangle className="size-4 text-amber-600" />,
  UNKNOWN: <CircleHelp className="size-4 text-muted-foreground" />,
};

const img = (id: string) => `/api/creative/images/${encodeURIComponent(id)}`;

export function ChatTestButton({ campKey, defaultOpen = false }: { campKey: string; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <>
      <Button variant="outline" size="sm" className="h-7 px-2 text-[12px]" onClick={() => setOpen(true)}>
        <MessageCircle className="size-3.5" />
        Chat test
      </Button>
      {open ? <ChatTestDialog campKey={campKey} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function ChatTestDialog({ campKey, onClose }: { campKey: string; onClose: () => void }) {
  const [view, setView] = useState<AdTestView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const reload = () =>
    loadAdTestAction(campKey).then((r) => {
      if ("error" in r) setLoadError(r.error);
      else {
        setLoadError(null);
        setView(r.view);
      }
    });
  useEffect(() => {
    const onReload = () => void reload();
    window.addEventListener("chat-test-reload", onReload);
    return () => window.removeEventListener("chat-test-reload", onReload);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campKey]);
  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campKey]);

  const run = (fn: () => Promise<ActionResult>) =>
    start(async () => {
      const r = await fn();
      if ("error" in r) toast.error(r.error);
      else {
        toast.success(r.message);
        if (r.warning) toast.warning(r.warning);
      }
      await reload();
    });

  return (
    <Dialog open onOpenChange={(o) => (!o ? onClose() : null)}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-6xl">
        <DialogHeader>
          <DialogTitle>Chat test — {view?.campaignName ?? "…"}</DialogTitle>
          <DialogDescription>
            Bot riêng cho khách bấm quảng cáo này: ảnh theo màu, giá và chất vải của mẫu test; tư vấn size và chốt đơn theo kịch bản bình thường. Chưa lên đơn POS (chỉ khi mẫu thắng).
          </DialogDescription>
        </DialogHeader>
        {loadError ? <p className="text-sm text-destructive">{loadError}</p> : null}
        {!view && !loadError ? <Loader2 className="size-5 animate-spin" /> : null}
        {view ? (
          <div className="grid gap-5 lg:grid-cols-[1fr_420px]">
            <div className="min-w-0 space-y-5">
              <Readiness view={view} />
              <Colors view={view} pending={pending} run={run} />
              <InfoForm view={view} pending={pending} run={run} />
              <GoLive view={view} pending={pending} run={run} />
            </div>
            <ChatPanel view={view} />
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2 rounded-lg border p-3">
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </section>
  );
}

function Readiness({ view }: { view: AdTestView }) {
  return (
    <Section title="① Page & bot đã sẵn sàng chưa">
      <ul className="space-y-1.5 text-sm">
        {view.readiness.map((c) => (
          <li key={c.key} className="flex gap-2">
            <span className="mt-0.5 shrink-0">{STATUS_ICON[c.status]}</span>
            <span className="min-w-0">
              <b className="font-medium">{c.label}</b>
              {c.detail ? <span className="text-muted-foreground"> — {c.detail}</span> : null}
              {c.fix ? <span className="block text-xs text-amber-700 dark:text-amber-400">Bổ sung: {c.fix}</span> : null}
            </span>
          </li>
        ))}
      </ul>
      <PagePicker view={view} />
    </Section>
  );
}

/** Ô chọn fanpage — luôn hiện để sửa được, nổi bật khi máy chưa đọc được page của camp. */
function PagePicker({ view }: { view: AdTestView }) {
  const [pending, start] = useTransition();
  const [pageId, setPageId] = useState(view.pageId ?? "");
  const save = () =>
    start(async () => {
      const r = await setAdTestPageAction({ campKey: view.campKey, pageId });
      if ("error" in r) toast.error(r.error);
      else toast.success(r.message);
      window.dispatchEvent(new CustomEvent("chat-test-reload"));
    });
  return (
    <div className={`mt-2 flex flex-wrap items-center gap-2 rounded-md p-2 text-sm ${view.pageId ? "" : "border border-destructive/50 bg-destructive/5"}`}>
      <span className="text-xs text-muted-foreground">Fanpage của camp:</span>
      <select className="h-8 rounded-md border bg-background px-2 text-sm" value={pageId} onChange={(e) => setPageId(e.target.value)}>
        <option value="">— chọn fanpage —</option>
        {view.pageOptions.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
            {p.inBot ? "" : " (bot chưa có token)"}
          </option>
        ))}
        {view.pageId && !view.pageOptions.some((p) => p.id === view.pageId) ? <option value={view.pageId}>{view.pageName ?? view.pageId}</option> : null}
      </select>
      <Button size="sm" variant="outline" disabled={pending || !pageId || pageId === view.pageId} onClick={save}>
        Lưu fanpage
      </Button>
      {!view.pageOptions.length ? <span className="text-xs text-muted-foreground">Không đọc được danh sách page (bot hoặc Pancake chưa kết nối).</span> : null}
    </div>
  );
}

function Colors({ view, pending, run }: { view: AdTestView; pending: boolean; run: (fn: () => Promise<ActionResult>) => void }) {
  const [color, setColor] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const colors = view.test?.colors ?? [];
  const add = (mode: "ORIGINAL" | "AI") => {
    const c = color.trim();
    if (!c) return toast.error("Nhập tên màu");
    run(async () => {
      const r = await addAdTestColorAction({ campKey: view.campKey, color: c, mode });
      if (!("error" in r)) setColor("");
      return r;
    });
  };
  return (
    <Section title="② Ảnh & màu">
      <div className="flex flex-wrap gap-3">
        {view.originalImageId ? (
          <figure className="w-28">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={img(view.originalImageId)} alt="Ảnh quảng cáo gốc" className="aspect-square w-28 rounded border object-cover" />
            <figcaption className="text-center text-xs text-muted-foreground">Ảnh quảng cáo gốc</figcaption>
          </figure>
        ) : null}
        {colors.map((c) => (
          <figure key={c.sha} className="relative w-28">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={img(c.imageId)} alt={c.color} className="aspect-square w-28 rounded border object-cover" />
            <figcaption className="text-center text-xs">
              {c.color} <span className="text-muted-foreground">({c.source === "AI" ? "AI" : c.source === "UPLOAD" ? "tải lên" : "gốc"})</span>
            </figcaption>
            <button type="button" disabled={pending} className="absolute top-1 right-1 rounded bg-background/80 p-1" title="Bỏ màu này" onClick={() => run(() => removeAdTestColorAction(view.campKey, c.sha))}>
              <Trash2 className="size-3.5" />
            </button>
          </figure>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Input className="h-8 w-44" placeholder="Tên màu, vd Đỏ đô" value={color} maxLength={40} onChange={(e) => setColor(e.target.value)} />
        {view.originalImageId ? (
          <Button size="sm" variant="outline" disabled={pending} onClick={() => add("ORIGINAL")} title="Màu đang có trên ảnh quảng cáo — không tốn tiền">
            Là màu gốc của ảnh
          </Button>
        ) : null}
        <Button size="sm" variant="outline" disabled={pending} onClick={() => (color.trim() ? fileRef.current?.click() : toast.error("Nhập tên màu trước"))} title="Tải ảnh của màu này lên — không tốn tiền">
          <Upload className="size-4" />
          Tải ảnh màu này lên
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (!f) return;
            const fd = new FormData();
            fd.set("campKey", view.campKey);
            fd.set("color", color.trim());
            fd.set("file", f);
            run(async () => {
              const r = await uploadAdTestColorAction(fd);
              if (!("error" in r)) setColor("");
              return r;
            });
          }}
        />
        <Button size="sm" disabled={pending || !view.canRecolor} onClick={() => add("AI")}>
          {pending ? <Loader2 className="size-4 animate-spin" /> : null}
          AI đổi sang màu này (~{view.estimateUsd.toFixed(2)} USD)
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Mỗi màu cần một ảnh: tải ảnh lên (0đ){view.originalImageId ? ", dùng màu gốc của ảnh quảng cáo (0đ), hoặc để AI vẽ lại ảnh quảng cáo sang màu mới" : ""}. AI vẽ lại ẢNH QUẢNG CÁO của camp sang màu mới, giữ nguyên kiểu dáng (mất khoảng 30–90 giây/ảnh). Đã chi hôm nay {view.spentTodayUsd.toFixed(2)} / {view.limits.maxUsdPerDay} USD · tối đa {view.limits.maxColorsPerAd} màu/camp.
        {view.recolorBlocked ? <span className="block text-amber-700 dark:text-amber-400">{view.recolorBlocked}</span> : null}
      </p>
    </Section>
  );
}

function InfoForm({ view, pending, run }: { view: AdTestView; pending: boolean; run: (fn: () => Promise<ActionResult>) => void }) {
  const t = view.test;
  const [f, setF] = useState({
    name: t?.name ?? view.productName ?? "",
    code: t?.code ?? "",
    price: t?.price != null ? String(t.price) : "",
    shipFee: t?.shipFee != null ? String(t.shipFee) : "25000",
    comboPrice: t?.comboPrice != null ? String(t.comboPrice) : "",
    fabric: t?.fabric ?? "",
    sizes: t?.sizes ?? "",
    offer: t?.offer ?? "",
  });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const field = (k: keyof typeof f, label: string, placeholder: string, wide = false) => (
    <label className={`grid gap-1 text-xs ${wide ? "sm:col-span-2" : ""}`}>
      <span className="text-muted-foreground">{label}</span>
      <Input className="h-8" value={f[k]} placeholder={placeholder} onChange={set(k)} />
    </label>
  );
  return (
    <Section title="③ Giá & chất vải">
      <div className="grid gap-2 sm:grid-cols-2">
        {field("name", "Tên mẫu gọi với khách *", "Đầm maxi da báo")}
        {field("code", "Mã tạm (ghi vào bản chốt đơn) *", "TEST-DB01")}
        {field("price", "Giá 1 chiếc (đ) *", "459000")}
        {field("shipFee", "Phí ship 1 chiếc (đ, 0 = miễn ship)", "25000")}
        {field("comboPrice", "Giá combo 2 chiếc (đ, để trống nếu không có)", "849000")}
        {field("sizes", "Size đang bán", "S, M, L, XL (40–70kg)")}
        {field("fabric", "Chất vải * (tên vải, co giãn, dày/mỏng, lót)", "Thun lạnh co giãn 4 chiều, dày vừa, không lót", true)}
        {field("offer", "Ưu đãi quảng cáo đang hứa (nếu có)", "Giảm 40% trong phiên chat", true)}
      </div>
      <p className="text-xs text-muted-foreground">Giá ở đây là giá DUY NHẤT bot được báo cho mẫu này. Tư vấn size theo bảng size chung của page.</p>
      <div className="flex justify-end">
        <Button size="sm" disabled={pending} onClick={() => run(() => saveAdTestInfoAction({ campKey: view.campKey, ...f }))}>
          Lưu giá & chất vải
        </Button>
      </div>
    </Section>
  );
}

function GoLive({ view, pending, run }: { view: AdTestView; pending: boolean; run: (fn: () => Promise<ActionResult>) => void }) {
  return (
    <Section title="⑤ Bật cho khách thật">
      <label className="flex items-center gap-3 text-sm">
        <Switch checked={view.live} disabled={pending || (!view.live && !view.canGoLive)} onCheckedChange={(v) => run(() => setAdTestLiveAction(view.campKey, v))} />
        {view.live ? (
          <span>
            <Badge>Đang bật</Badge> Khách bấm quảng cáo này chat với bot mẫu test.
          </span>
        ) : (
          <span>{view.canGoLive ? "Chat thử ổn thì bật để bot trả lời khách thật của camp này." : "Chưa bật được — bổ sung các dòng THIẾU ở bảng kiểm ①."}</span>
        )}
      </label>
    </Section>
  );
}

function ChatPanel({ view }: { view: AdTestView }) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.scrollTo({ top: 1e9 });
  }, [msgs]);

  const send = async () => {
    const t = text.trim();
    if (!t || busy) return;
    const next: Msg[] = [...msgs, { role: "user", text: t }];
    setMsgs(next);
    setText("");
    setBusy(true);
    const r = await chatAdTestAction({ campKey: view.campKey, history: next.map(({ role, text }) => ({ role, text })) });
    setBusy(false);
    if ("error" in r) setMsgs([...next, { role: "model", text: `Lỗi: ${r.error}` }]);
    else setMsgs([...next, { role: "model", text: r.reply.text, imageIds: r.reply.imageIds, handoff: r.reply.handoff }]);
  };

  return (
    <section className="flex h-[70vh] min-h-[480px] flex-col rounded-lg border">
      <div className="border-b p-3">
        <h3 className="text-sm font-semibold">④ Chat thử (bạn đóng vai khách)</h3>
        <p className="text-xs text-muted-foreground">Bot thật, đúng bot riêng của camp — không gửi gì lên Pancake / Facebook.{view.chatPageNote ? ` ${view.chatPageNote}` : ""}</p>
      </div>
      <div ref={box} className="flex-1 space-y-2 overflow-y-auto p-3">
        {!view.canChat ? <p className="text-sm text-muted-foreground">Chưa chat thử được — điền đủ ② ảnh & màu và ③ giá & chất vải, và bot phải đang chạy (xem bảng kiểm ①).</p> : null}
        {msgs.map((m, k) => (
          <div key={k} className={`max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap ${m.role === "user" ? "ml-auto bg-primary text-primary-foreground" : "bg-muted"}`}>
            {m.text}
            {m.imageIds?.length ? (
              <div className="mt-2 flex flex-wrap gap-1">
                {m.imageIds.map((id) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img key={id} src={img(id)} alt="" className="size-24 rounded object-cover" />
                ))}
              </div>
            ) : null}
            {m.handoff ? <div className="mt-1 text-xs opacity-70">[Chuyển nhân viên]</div> : null}
          </div>
        ))}
        {busy ? <Loader2 className="size-4 animate-spin" /> : null}
      </div>
      <div className="flex gap-2 border-t p-3">
        <Input
          value={text}
          placeholder="Nhắn như khách, vd: mẫu này giá sao shop"
          disabled={!view.canChat || busy}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <Button size="icon" disabled={!view.canChat || busy || !text.trim()} onClick={() => void send()} title="Gửi">
          <Send className="size-4" />
        </Button>
        <Button size="sm" variant="ghost" disabled={busy || !msgs.length} onClick={() => setMsgs([])}>
          Xoá
        </Button>
      </div>
    </section>
  );
}
