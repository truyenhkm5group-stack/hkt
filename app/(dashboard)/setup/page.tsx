import Link from "next/link";
import { ArrowRight, CheckCircle2, Circle, CircleDashed, ExternalLink } from "lucide-react";
import { visibleGroups } from "@/components/app-sidebar";
import { PageHeader } from "@/components/page-header";
import { SectionCard } from "@/components/ui-bits";
import { getDb, schema } from "@/db";
import { requirePermission } from "@/lib/auth/session";
import { getBranding } from "@/lib/branding/service";
import { moduleDef, type ModuleKey } from "@/lib/constants/platform-modules";
import { env } from "@/lib/env";
import { getGettingStarted } from "@/lib/onboarding/progress";
import { PUBLISH_PERMISSION, publishChecklist } from "@/lib/platform/publish";
import { cn } from "@/lib/utils";
import { isSalesAgentUser, salesAgentNavFor, shellAllows } from "@/lib/constants/saas-nav";
import { and, gt, ne } from "drizzle-orm";
import { DomainForm, PublishPanel } from "./setup-client";

export const metadata = { title: "Thiết lập & xuất bản" };

/**
 * THIẾT LẬP & XUẤT BẢN (0180) — bàn của CHỦ tổ chức vừa tạo: việc cần làm (đo từ dữ liệu thật), XEM TRƯỚC (menu, module,
 * trang, thương hiệu — ERP đang dùng chính là bản xem trước), TÊN MIỀN CON, KIỂM rồi XUẤT BẢN, MỞ ERP CỦA TÔI. Không bước
 * nào cần người vận hành nền tảng, SQL hay deploy.
 */
export default async function SetupPage() {
  const user = await requirePermission(PUBLISH_PERMISSION);
  // Tổ chức nhà luôn đang chạy ở tên miền chính — không nháp, không tên miền con, không bước xuất bản.
  if (!user.organization || user.organization.isHome) {
    return (
      <div className="space-y-5">
        <PageHeader eyebrow={user.organization?.name ?? "Tổ chức"} title="Thiết lập & xuất bản" />
        <SectionCard>
          <p className="text-sm text-muted-foreground">Tổ chức nhà luôn đang chạy ở tên miền chính — không có bản nháp, tên miền con hay bước xuất bản. Trang này dành cho tổ chức khách tự tạo qua /start.</p>
        </SectionCard>
      </div>
    );
  }
  const code = user.organization.code;
  const db = await getDb();
  const [gs, list, branding, pages] = await Promise.all([
    getGettingStarted(user),
    publishChecklist(),
    getBranding(),
    db.select({ slug: schema.metaPages.slug, name: schema.metaPages.name }).from(schema.metaPages).where(and(ne(schema.metaPages.status, "ARCHIVED"), gt(schema.metaPages.publishedVersion, 0))),
  ]);
  const pub = list.publication;
  const modules = (user.modules ?? []) as ModuleKey[];
  // Xem trước menu = ĐÚNG menu người này thấy (`visibleGroups`): cùng luật module, quyền, nguồn số liệu và trang gom của
  // tổ chức khách — không lọc lần thứ hai ở đây (AGENTS.md mục 28).
  // Vỏ app Chốt Đơn: «Xem trước» hiện ĐÚNG thanh tám mục khách thấy, không phải menu ERP (mục ERP bị chặn ở máy chủ).
  // Vỏ Chốt Đơn: câu chữ không «ERP» / «module» (khách không thuê ERP) — chỉ trình bày, luật không đổi.
  const shell = isSalesAgentUser(user);
  const nav = shell ? [{ label: "Ứng dụng Chốt Đơn", items: salesAgentNavFor(user).map((i) => ({ href: i.href, label: i.label })) }] : visibleGroups(user);
  const erpUrl = pub.state === "PUBLISHED" && pub.url ? `${pub.url}/login` : null;
  const stateLabel = pub.state === "PUBLISHED" ? "ĐÃ XUẤT BẢN" : pub.state === "DRAFT" ? "BẢN NHÁP" : "Đang chạy";

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow={user.organization?.name ?? "Tổ chức"}
        title="Thiết lập & xuất bản"
        description={`${stateLabel} · ${gs.done}/${gs.measurable} bước đã xong`}
        hint={
          <div className="space-y-1.5 text-xs leading-5">
            <p>{shell ? "Ứng dụng" : "ERP"} bạn đang dùng CHÍNH LÀ bản xem trước: mọi menu, trang, form ở đây là thứ nhân viên sẽ thấy sau khi xuất bản. Bản nháp chỉ khác một điều: chưa có tên miền con riêng và trang chat công khai chưa nhận khách.</p>
            <p>Xuất bản không deploy, không cần người vận hành nền tảng: máy kiểm lại cấu hình rồi bật địa chỉ riêng của bạn ngay.</p>
          </div>
        }
      />

      <div className="grid gap-5 xl:grid-cols-2">
        <SectionCard title="Việc cần làm" description="Mỗi bước tự đánh dấu xong khi dữ liệu thật xuất hiện." padded={false} contentClassName="p-0">
          <ul className="divide-y divide-hairline" data-setup-steps>
            {gs.steps.map((s) => {
              const Icon = s.done === null ? CircleDashed : s.done ? CheckCircle2 : Circle;
              return (
                <li key={s.key} className="flex items-center gap-3 px-4 py-3" data-step={s.key} data-done={s.done === null ? "unknown" : s.done ? "1" : "0"}>
                  <Icon className={cn("size-5 shrink-0", s.done ? "text-emerald-600" : "text-muted-foreground")} aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold">{s.label}</p>
                    <p className="text-xs text-muted-foreground">{s.detail}</p>
                  </div>
                  <Link href={s.href} className="flex shrink-0 items-center gap-1 text-xs font-medium text-primary hover:underline">
                    {s.cta} <ArrowRight className="size-3.5" />
                  </Link>
                </li>
              );
            })}
          </ul>
        </SectionCard>

        <SectionCard title={shell ? "Xem trước ứng dụng" : "Xem trước ERP"} description="Đúng thứ người dùng thấy — mở từng mục để thử.">
          <div className="space-y-4 text-sm" data-testid="setup-preview">
            <div className="flex items-center gap-3">
              {branding.logoFileId ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src="/api/branding/logo" alt="Logo" className="size-10 rounded-lg border object-contain" />
              ) : (
                <span className="flex size-10 items-center justify-center rounded-lg border text-xs text-muted-foreground">Logo</span>
              )}
              <div>
                <p className="font-semibold">{branding.displayName || user.organization?.name}</p>
                <p className="text-xs text-muted-foreground">
                  <Link href="/settings/branding" className="underline underline-offset-2">
                    Đổi tên hiển thị, màu, logo
                  </Link>
                </p>
              </div>
            </div>
            <div>
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{shell ? `Chức năng đang dùng (${modules.length})` : `Module đang bật (${modules.length})`}</p>
              <p className="text-xs leading-5">{modules.map((m) => moduleDef(m)?.label ?? m).join(" · ")}</p>
              {shellAllows(user, "/settings/modules") ? (
                <Link href="/settings/modules" className="text-xs text-primary underline underline-offset-2">
                  Bật / tắt module
                </Link>
              ) : null}
            </div>
            <div>
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Menu</p>
              <div className="grid gap-2 sm:grid-cols-2">
                {nav.map((g) => (
                  <div key={g.label}>
                    <p className="text-xs font-medium">{g.label}</p>
                    <ul className="text-xs text-muted-foreground">
                      {g.items.map((it) => (
                        <li key={it.href}>
                          <Link href={it.href} className="hover:underline">
                            {it.label}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Trang & form</p>
              <div className="flex flex-wrap gap-2">
                <Link href="/" className="rounded-full border px-3 py-1 text-xs hover:bg-muted">
                  Trang chủ
                </Link>
                {(shellAllows(user, "/p") ? pages : []).map((p) => (
                  <Link key={p.slug} href={`/p/${p.slug}`} className="rounded-full border px-3 py-1 text-xs hover:bg-muted">
                    {p.name}
                  </Link>
                ))}
                <Link href="/orders/new" className="rounded-full border px-3 py-1 text-xs hover:bg-muted">
                  Form tạo đơn
                </Link>
                <Link href="/customers/new" className="rounded-full border px-3 py-1 text-xs hover:bg-muted">
                  Form tạo khách
                </Link>
                {shellAllows(user, "/settings/forms") ? (
                  <Link href="/settings/forms" className="rounded-full border px-3 py-1 text-xs hover:bg-muted">
                    Sửa form
                  </Link>
                ) : null}
              </div>
            </div>
          </div>
        </SectionCard>
      </div>

      {pub.state !== "UNTRACKED" ? (
        <SectionCard id="ten-mien" title="Tên miền con" description={pub.baseDomain ? `Địa chỉ riêng dạng <tên>.${pub.baseDomain}` : shell ? "Tên miền con chưa mở trên hệ thống — vẫn giữ được tên, và cửa hàng mở bằng mã cửa hàng." : "Nền tảng chưa bật định tuyến theo tên miền con (PLATFORM_BASE_DOMAIN) — vẫn giữ được tên, và ERP mở bằng mã tổ chức."}>
          <DomainForm current={pub.slug} baseDomain={pub.baseDomain} locked={pub.state === "PUBLISHED"} />
        </SectionCard>
      ) : null}

      <SectionCard title={pub.state === "PUBLISHED" ? "Đã xuất bản" : "Kiểm trước khi xuất bản"}>
        <PublishPanel
          state={pub.state}
          checks={list.checks}
          ready={list.ready}
          erpUrl={erpUrl}
          chatUrl={pub.state === "PUBLISHED" && pub.url ? `${pub.url}/chat` : null}
          fallbackUrl={`${env.appUrl}/login`}
          orgCode={code}
        />
        {erpUrl ? (
          <p className="mt-3 flex items-center gap-1 text-xs text-muted-foreground">
            <ExternalLink className="size-3.5" /> Gửi địa chỉ này cho nhân viên cùng lời mời (Cài đặt → Người dùng → Mời).
          </p>
        ) : null}
      </SectionCard>
    </div>
  );
}
