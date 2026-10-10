import Link from "next/link";
import { TechNav } from "@/app/(dashboard)/tech/tech-nav";
import { TechPriorityBadge, TechRiskBadge } from "@/app/(dashboard)/tech/badges";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/ui-bits";
import { SyncButton } from "@/components/sync-button";
import { can, requirePermission } from "@/lib/auth/session";
import { TECH_OWNER_ESCALATION_LABEL, type TechOwnerEscalation, type TechPriority, type TechRisk } from "@/lib/constants/tech";
import { formatTimeAgo } from "@/lib/format";
import { techNeedsOwnerQueue } from "@/lib/queries/tech-control-plane";
import { registryDecisionQueue, registrySyncInfo } from "@/lib/queries/tech-registry";

export const metadata = { title: "Cần chủ shop · Phòng Tech AI" };

/**
 * MỘT câu hỏi: "cái gì đang đứng im vì tôi?". Thiết kế cho điện thoại: mỗi dòng là một thẻ to, câu việc
 * phải làm đứng đầu, bấm vào là mở đúng việc để duyệt / gỡ.
 */
export default async function TechNeedsOwnerPage() {
  const user = await requirePermission("tech:view");
  const canManage = can(user, "tech:manage");
  const [items, decisions, sync] = await Promise.all([techNeedsOwnerQueue(), registryDecisionQueue(), registrySyncInfo()]);
  const tong = items.length + decisions.length;

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Phòng Tech AI"
        title="Cần chủ shop"
        description={tong ? `${tong} mục đang chờ đúng một việc của bạn (${decisions.length} quyết định từ sổ Tech Room · ${items.length} việc trong hàng đợi /tech)` : "Không có gì đang chờ bạn"}
        actions={canManage && sync.configured ? <SyncButton job="tech-registry-sync" label="Đọc lại sổ" wait /> : null}
        hint={
          <>
            Ba loại: QUYẾT ĐỊNH Tech Lead ghi vào sổ Tech Room (sứ mệnh mang <code>needs_owner</code>, hoặc BLOCKED với
            tiêu đề «QUYẾT ĐỊNH CHỦ SHOP: …» — ghi bằng <code>npm run ai -- claim owner-&lt;việc&gt; --status=BLOCKED
            --title=&quot;QUYẾT ĐỊNH CHỦ SHOP: …&quot;</code> hoặc <code>--needs-owner=&quot;LOẠI: việc phải làm&quot;</code>), việc máy /
            agent đã dừng lại vì cần bạn (duyệt, cấp khoá, đăng nhập dịch vụ ngoài, quyết định không hoàn tác…) và việc
            mức R2 đang chờ bạn duyệt trước khi deploy. Mọi thứ khác hệ thống tự đi tiếp. Mục của sổ chỉ rời trang này
            khi Tech Lead đổi sổ — trang không có nút «đã xong».
          </>
        }
      />
      <TechNav />

      {decisions.length ? (
        <section className="space-y-3" aria-label="Quyết định từ sổ Tech Room">
          <h2 className="text-sm font-bold">Quyết định từ sổ Tech Room ({decisions.length})</h2>
          {decisions.map((d) => (
            <Link
              key={d.registryId}
              href={`/tech/missions/registry/${encodeURIComponent(d.registryId)}`}
              className="block rounded-xl border-2 border-fuchsia-200 bg-card p-4 shadow-[var(--shadow-card)] transition-colors hover:bg-muted/40 dark:border-fuchsia-900"
            >
              <p className="text-xs font-bold uppercase tracking-wide text-fuchsia-700 dark:text-fuchsia-300">{d.categoryLabel}</p>
              <p className="mt-1 text-base font-semibold leading-snug">{d.question}</p>
              <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                <span className="break-all font-mono font-semibold">{d.registryId}</span>
                <TechPriorityBadge priority={d.priority as TechPriority} />
                <span>· chờ từ {formatTimeAgo(d.waitingSince)}</span>
              </div>
            </Link>
          ))}
        </section>
      ) : !sync.lastAt && sync.configured ? (
        <p className="rounded-xl border bg-card px-3 py-2 text-xs text-muted-foreground">Chưa đọc sổ Tech Room lần nào — quyết định Tech Lead ghi ở sổ chưa hiện ở đây. Bấm «Đọc lại sổ».</p>
      ) : null}

      {items.length === 0 ? (
        decisions.length ? null : <EmptyState title="Không có gì đang chờ bạn" description="Khi một việc cần bạn, nó hiện ở đây kèm đúng việc phải làm." />
      ) : (
        <div className="space-y-3">
          {items.map((t) => (
            <Link
              key={t.id}
              href={`/tech/tasks/${t.id}`}
              className="block rounded-xl border-2 border-fuchsia-200 bg-card p-4 shadow-[var(--shadow-card)] transition-colors hover:bg-muted/40 dark:border-fuchsia-900"
            >
              <p className="text-xs font-bold uppercase tracking-wide text-fuchsia-700 dark:text-fuchsia-300">
                {t.status === "NEEDS_OWNER" ? (TECH_OWNER_ESCALATION_LABEL[t.ownerEscalation as TechOwnerEscalation] ?? t.ownerEscalation) : "Chờ bạn duyệt trước khi deploy"}
              </p>
              <p className="mt-1 text-base font-semibold leading-snug">{t.status === "NEEDS_OWNER" ? t.ownerAction : t.title}</p>
              <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                <span className="font-semibold">{t.code}</span>
                {t.status === "NEEDS_OWNER" ? <span className="truncate">· {t.title}</span> : null}
                <TechPriorityBadge priority={t.priority as TechPriority} />
                <TechRiskBadge risk={t.risk as TechRisk} />
                {t.mission ? <span>· {t.mission.code}</span> : null}
                <span>· chờ {formatTimeAgo(t.updatedAt)}</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
