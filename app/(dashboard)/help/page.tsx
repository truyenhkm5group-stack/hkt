import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { can, requireUser } from "@/lib/auth/session";
import { HELP_FAQ, HELP_GUIDES, HELP_TOPIC_LABEL, HELP_TOPIC_ORDER, helpGuideVisible } from "@/lib/constants/help-guides";

export const metadata = { title: "Hướng dẫn sử dụng" };

/**
 * HƯỚNG DẪN SỬ DỤNG — mọi tài khoản mở được (lối vào: menu tài khoản). Chỉ in bài dẫn tới trang người xem VÀO ĐƯỢC:
 * quyền + module đang bật + bài dành cho tổ chức khách (lib/constants/help-guides.ts). Nội dung là hằng số trong mã,
 * khoá chống lỗi thời ở tests/help-guides.test.ts.
 */
export default async function HelpPage() {
  const user = await requireUser();
  const viewer = { modules: user.modules, isHome: user.organization?.isHome ?? true };
  const guides = HELP_GUIDES.filter((g) => helpGuideVisible(g, viewer, (p) => can(user, p)));
  const topics = HELP_TOPIC_ORDER.map((t) => ({ topic: t, items: guides.filter((g) => g.topic === t) })).filter((x) => x.items.length > 0);

  return (
    <div className="space-y-5">
      <PageHeader eyebrow="Hệ thống" title="Hướng dẫn sử dụng" description="Các việc thường làm, từng bước — chỉ hiện những việc tài khoản của bạn làm được." refresh={false} />

      {topics.length ? (
        <nav aria-label="Mục lục" className="flex flex-wrap gap-2">
          {topics.flatMap((t) => t.items).map((g) => (
            <a key={g.key} href={`#${g.key}`} className="rounded-full border px-3 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">
              {g.title}
            </a>
          ))}
        </nav>
      ) : (
        <EmptyState title="Chưa có hướng dẫn cho vai trò này" description="Tài khoản của bạn chưa mở được trang nào có hướng dẫn. Xem phần câu hỏi thường gặp bên dưới." />
      )}

      {topics.map(({ topic, items }) => (
        <section key={topic} className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">{HELP_TOPIC_LABEL[topic]}</h2>
          <div className="grid gap-4 lg:grid-cols-2">
            {items.map((g) => (
              <SectionCard
                key={g.key}
                id={g.key}
                title={g.title}
                description={g.summary}
                actions={
                  <Link href={g.href} className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline">
                    Mở trang <ArrowRight className="size-3.5" />
                  </Link>
                }
              >
                <ol className="list-decimal space-y-1.5 pl-5 text-sm">
                  {g.steps.map((s, i) => (
                    <li key={i}>
                      {s.text}
                      {s.href && s.href !== g.href ? (
                        <>
                          {" "}
                          <Link href={s.href} className="text-primary hover:underline">
                            Mở
                          </Link>
                        </>
                      ) : null}
                    </li>
                  ))}
                </ol>
              </SectionCard>
            ))}
          </div>
        </section>
      ))}

      <SectionCard title="Câu hỏi thường gặp">
        <dl className="space-y-3 text-sm">
          {HELP_FAQ.map((f) => (
            <div key={f.q}>
              <dt className="font-medium">{f.q}</dt>
              <dd className="text-muted-foreground">{f.a}</dd>
            </div>
          ))}
        </dl>
      </SectionCard>
    </div>
  );
}
