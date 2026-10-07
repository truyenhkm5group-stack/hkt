import Link from "next/link";
import { BellRing, ChevronRight, Download, Globe, LifeBuoy, Palette, UserRound } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { SectionCard } from "@/components/ui-bits";
import { can, requireUser } from "@/lib/auth/session";
import type { Permission } from "@/lib/auth/permissions";
import { NOTIFICATIONS_PERMISSION } from "@/lib/messaging/presets";
import { PUBLISH_PERMISSION, publicationOf, type PublishState } from "@/lib/platform/publish";

export const metadata = { title: "Cài đặt" };

const PUBLISH_LABEL: Record<PublishState, string> = { UNTRACKED: "Đang dùng", DRAFT: "Bản nháp — chưa xuất bản", PUBLISHED: "Đã xuất bản" };

type Entry = { href: string; label: string; hint: string; icon: typeof Palette; permission?: Permission };

/**
 * Mục cài đặt của khách Chốt Đơn — ĐÚNG những trang có sẵn mà vỏ app mở (`SALES_AGENT_ALLOWED_PREFIXES`). Bộ dựng của ERP (mô hình
 * dữ liệu, đối tượng, luồng, trang, AI builder, nâng cao) KHÔNG có ở đây và bị chặn ở máy chủ.
 */
const ENTRIES: readonly Entry[] = [
  { href: "/settings/branding", label: "Tên & thương hiệu", hint: "Tên cửa hàng, logo, màu nhấn", icon: Palette, permission: "settings:manage" },
  { href: "/setup", label: "Địa chỉ web & xuất bản", hint: "Tên miền con, trang chat công khai", icon: Globe, permission: PUBLISH_PERMISSION },
  { href: "/settings/notifications", label: "Thông báo nhóm", hint: "Báo nhóm khi có đơn chốt / sửa / huỷ", icon: BellRing, permission: NOTIFICATIONS_PERMISSION },
  { href: "/settings/data-export", label: "Xuất dữ liệu", hint: "Tải toàn bộ dữ liệu của cửa hàng", icon: Download, permission: "settings:manage" },
  { href: "/settings/profile", label: "Tài khoản của tôi", hint: "Tên, mật khẩu, đăng nhập", icon: UserRound },
  { href: "/help", label: "Hướng dẫn sử dụng", hint: "Cách dùng từng màn hình", icon: LifeBuoy },
];

/**
 * CÀI ĐẶT GỌN (vỏ app Chốt Đơn Tự Động · lib/constants/saas-nav.ts) — thông tin cửa hàng + lối vào các trang cài đặt có sẵn mà
 * người xem dùng được. Mỗi mục chỉ hiện khi `can()` của người xem đúng với khoá mà trang đích tự đòi — không có mục dẫn vào trang
 * bị đá ra.
 */
export default async function ShopSettingsPage() {
  const user = await requireUser();
  const org = user.organization;
  const canManage = can(user, PUBLISH_PERMISSION);
  const pub = org && !org.isHome && canManage ? await publicationOf(org.code) : null;
  const entries = ENTRIES.filter((e) => !e.permission || can(user, e.permission));
  return (
    <div className="space-y-5">
      <PageHeader title="Cài đặt" description={org?.name} refresh={false} />

      <SectionCard title="Cửa hàng">
        <dl className="grid gap-x-4 gap-y-3 text-sm sm:grid-cols-3" data-testid="shop-info">
          <div className="min-w-0">
            <dt className="text-xs text-muted-foreground">Tên cửa hàng</dt>
            <dd className="truncate font-semibold">{org?.name ?? "—"}</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-xs text-muted-foreground">Mã cửa hàng</dt>
            <dd className="truncate font-mono text-[13px]">{org?.code ?? "—"}</dd>
          </div>
          {pub ? (
            <div className="min-w-0">
              <dt className="text-xs text-muted-foreground">Trạng thái</dt>
              <dd className="truncate">
                {PUBLISH_LABEL[pub.state]}
                {pub.url ? (
                  <>
                    {" · "}
                    <a href={pub.url} className="text-primary hover:underline" target="_blank" rel="noreferrer">
                      {pub.url.replace(/^https?:\/\//, "")}
                    </a>
                  </>
                ) : null}
              </dd>
            </div>
          ) : null}
        </dl>
      </SectionCard>

      <nav aria-label="Mục cài đặt" className="overflow-hidden rounded-2xl bg-card shadow-[var(--shadow-card)]" data-testid="shop-settings-entries">
        <ul className="divide-y divide-hairline">
          {entries.map((e) => (
            <li key={e.href}>
              <Link href={e.href} className="flex min-h-14 items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/60">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
                  <e.icon className="size-[18px]" aria-hidden />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold">{e.label}</span>
                  <span className="block truncate text-xs text-muted-foreground">{e.hint}</span>
                </span>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}
