"use client";

import { useEffect, useState, useTransition } from "react";
import { Bell, BellOff, Loader2, Send } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { disablePushAction, enablePushAction, testPushAction } from "@/lib/actions/push";

type State = "checking" | "unsupported" | "ios-install" | "denied" | "off" | "on";

function keyBytes(b64url: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (b64url.length % 4)) % 4);
  const raw = atob((b64url + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function registration(): Promise<ServiceWorkerRegistration> {
  await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  return navigator.serviceWorker.ready;
}

/**
 * Bật thông báo đẩy cho MÁY ĐANG DÙNG (docs/platform/pwa.md). iPhone / iPad chỉ nhận thông báo khi ERP đã được «Thêm vào Màn
 * hình chính» và mở từ biểu tượng đó — nên ở Safari thường, nút nói rõ bước đó thay vì bật một thứ sẽ không bao giờ tới.
 */
export function PushToggle({ publicKey }: { publicKey: string }) {
  const [state, setState] = useState<State>("checking");
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    void (async () => {
      const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
      const standalone = window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
      if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
        setState(ios && !standalone ? "ios-install" : "unsupported");
        return;
      }
      if (Notification.permission === "denied") {
        setState("denied");
        return;
      }
      try {
        const reg = await registration();
        const sub = await reg.pushManager.getSubscription();
        setState(sub ? "on" : "off");
      } catch {
        setState("unsupported");
      }
    })();
  }, []);

  const enable = () =>
    startTransition(async () => {
      try {
        const permission = await Notification.requestPermission();
        if (permission !== "granted") {
          setState(permission === "denied" ? "denied" : "off");
          return;
        }
        const reg = await registration();
        const existing = await reg.pushManager.getSubscription();
        const sub = existing ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) }));
        const r = await enablePushAction(sub.toJSON(), navigator.userAgent);
        if ("error" in r) {
          toast.error(r.error);
          return;
        }
        setState("on");
        toast.success("Đã bật thông báo trên máy này.");
      } catch {
        toast.error("Trình duyệt không cho đăng ký thông báo. Thử lại, hoặc dùng Chrome / Edge / Safari bản mới.");
      }
    });

  const disable = () =>
    startTransition(async () => {
      try {
        const reg = await registration();
        const sub = await reg.pushManager.getSubscription();
        if (sub) {
          await disablePushAction(sub.endpoint);
          await sub.unsubscribe();
        }
        setState("off");
        toast.success("Đã tắt thông báo trên máy này.");
      } catch {
        toast.error("Không tắt được — thử lại.");
      }
    });

  const test = () =>
    startTransition(async () => {
      const r = await testPushAction();
      if ("error" in r) toast.error(r.error);
      else toast.success(r.message);
    });

  return (
    <div className="space-y-3 text-sm">
      <p className="text-muted-foreground">
        Nhận thông báo ngay trên điện thoại / máy tính khi có tin vào hộp thư của bạn — khách cần người trả lời, chatbot báo lỗi, lương chờ duyệt… Bật riêng cho từng
        máy.
      </p>
      {state === "checking" ? <Loader2 className="size-4 animate-spin text-muted-foreground" /> : null}
      {state === "unsupported" ? <p className="text-muted-foreground">Trình duyệt này không hỗ trợ thông báo đẩy. Dùng Chrome, Edge, Firefox hoặc Safari bản mới.</p> : null}
      {state === "ios-install" ? (
        <p className="text-muted-foreground">
          Trên iPhone / iPad: bấm nút <strong>Chia sẻ</strong> của Safari → <strong>Thêm vào Màn hình chính</strong>, mở ERP từ biểu tượng vừa thêm rồi quay lại đây để bật.
        </p>
      ) : null}
      {state === "denied" ? <p className="text-muted-foreground">Bạn đã chặn thông báo cho trang này. Mở cài đặt trang của trình duyệt (biểu tượng ổ khoá cạnh địa chỉ) → cho phép Thông báo.</p> : null}
      {state === "off" ? (
        <Button onClick={enable} disabled={pending}>
          {pending ? <Loader2 className="size-4 animate-spin" /> : <Bell className="size-4" />} Bật thông báo trên máy này
        </Button>
      ) : null}
      {state === "on" ? (
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={test} disabled={pending}>
            {pending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />} Gửi thử
          </Button>
          <Button variant="ghost" onClick={disable} disabled={pending}>
            <BellOff className="size-4" /> Tắt trên máy này
          </Button>
        </div>
      ) : null}
    </div>
  );
}
