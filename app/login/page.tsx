import { redirect } from "next/navigation";
import { LoginForm } from "@/app/login/login-form";
import { getSession } from "@/lib/auth/session";
import { integrationStatus } from "@/lib/env";

export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; reason?: string }> }) {
  const session = await getSession();
  const params = await searchParams;
  if (session && params.reason !== "inactive") redirect(params.next && params.next.startsWith("/") ? params.next : "/");
  const status = integrationStatus();

  return (
    <div className="grid min-h-screen lg:grid-cols-[1.1fr_1fr]">
      <div className="relative hidden overflow-hidden bg-sidebar text-sidebar-foreground lg:flex lg:flex-col lg:justify-between lg:p-12">
        <div className="absolute -top-32 -right-32 size-96 rounded-full bg-primary/30 blur-3xl" />
        <div className="absolute -bottom-40 -left-20 size-[28rem] rounded-full bg-chart-2/20 blur-3xl" />
        <div className="relative flex items-center gap-3">
          <span className="flex size-10 items-center justify-center rounded-xl bg-primary text-sm font-black text-primary-foreground">SC</span>
          <div>
            <p className="text-base font-bold">Shop Control ERP</p>
            <p className="text-xs uppercase tracking-[0.18em] text-sidebar-foreground/60">Fashion operations</p>
          </div>
        </div>
        <div className="relative max-w-md space-y-6">
          <h1 className="text-3xl font-bold leading-tight">Đơn hàng, vận đơn, COD và lợi nhuận — trong một màn hình.</h1>
          <p className="text-sm leading-6 text-sidebar-foreground/70">
            Đồng bộ tự động từ Pancake POS và Viettel Post. Mọi thay đổi trạng thái giao hàng được cập nhật theo thời gian thực qua webhook.
          </p>
          <ul className="space-y-2 text-sm text-sidebar-foreground/80">
            <li className="flex items-center gap-2">
              <span className={`size-2 rounded-full ${status.pancake ? "bg-success" : "bg-warning"}`} />
              Pancake POS {status.pancake ? "đã cấu hình" : "chưa cấu hình API key"}
            </li>
            <li className="flex items-center gap-2">
              <span className={`size-2 rounded-full ${status.viettelPost ? "bg-success" : "bg-warning"}`} />
              Viettel Post {status.viettelPost ? "đã cấu hình" : "chưa cấu hình token"}
            </li>
          </ul>
        </div>
        <p className="relative text-xs text-sidebar-foreground/50">© {new Date().getFullYear()} Shop Control · Nội bộ</p>
      </div>
      <div className="flex items-center justify-center p-6">
        <LoginForm next={params.next} reason={params.reason} />
      </div>
    </div>
  );
}
