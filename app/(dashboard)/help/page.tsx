import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { can, requireUser } from "@/lib/auth/session";
import { COMPANY } from "@/lib/constants/company";
import { HELP_FAQ, HELP_GUIDES, HELP_TOPIC_LABEL, HELP_TOPIC_ORDER, helpAudienceMatches, helpGuideVisible } from "@/lib/constants/help-guides";
import { isSalesAgentUser } from "@/lib/constants/saas-nav";

export const metadata = { title: "Hướng dẫn sử dụng" };

/**
 * HƯỚNG DẪN SỬ DỤNG — mọi tài khoản mở được (lối vào: menu tài khoản). Chỉ in bài dẫn tới trang người xem VÀO ĐƯỢC:
 * quyền + module đang bật + bài dành cho tổ chức khách (lib/constants/help-guides.ts). Nội dung là hằng số trong mã,
 * khoá chống lỗi thời ở tests/help-guides.test.ts.
 */
export default async function HelpPage() {
  const user = await requireUser();
  // Vỏ Chốt Đơn: chỉ bài viết cho vỏ (gọi đúng tên menu của vỏ, mọi link mở được); ngoài vỏ: bài của ERP như cũ.
  const shell = isSalesAgentUser(user);
  const viewer = { modules: user.modules, isHome: user.organization?.isHome ?? true, shell };
  const guides = HELP_GUIDES.filter((g) => helpGuideVisible(g, viewer, (p) => can(user, p)));
  const faq = HELP_FAQ.filter((f) => helpAudienceMatches(f.audience, shell));
  const topics = HELP_TOPIC_ORDER.map((t) => ({ topic: t, items: guides.filter((g) => g.topic === t) })).filter((x) => x.items.length > 0);

  return (
    <div className="space-y-5">
      <PageHeader eyebrow={shell ? undefined : "Hệ thống"} title="Hướng dẫn sử dụng" description="Các việc thường làm, từng bước — chỉ hiện những việc tài khoản của bạn làm được." refresh={false} />

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
          {faq.map((f) => (
            <div key={f.q}>
              <dt className="font-medium">{f.q}</dt>
              <dd className="text-muted-foreground">{f.a}</dd>
            </div>
          ))}
        </dl>
      </SectionCard>

      {/* TẦNG LIÊN HỆ (HELP_CENTER §5): một khối, một nguồn (lib/constants/company.ts). Tin nhắn chỉ cần mang TÊN CỬA HÀNG, không dữ liệu khách. */}
      <SectionCard title="Chưa tìm thấy câu trả lời?" description="Nhắn cho đội hỗ trợ — ghi kèm tên cửa hàng để được xử lý nhanh.">
        <div className="flex flex-wrap gap-2 text-sm" data-testid="help-contact">
          <a href={COMPANY.zaloHref} target="_blank" rel="noreferrer" className="inline-flex h-11 items-center rounded-full bg-primary px-4 font-medium text-primary-foreground hover:bg-primary/90">
            Nhắn Zalo {COMPANY.zalo}
          </a>
          <a href={`mailto:${COMPANY.email}?subject=${encodeURIComponent(`Hỗ trợ: ${user.organization?.name ?? ""}`)}`} className="inline-flex h-11 items-center rounded-full border px-4 font-medium hover:bg-muted">
            Email {COMPANY.email}
          </a>
          <a href={`tel:${COMPANY.phoneHref}`} className="inline-flex h-11 items-center rounded-full border px-4 font-medium hover:bg-muted">
            Gọi {COMPANY.phone}
          </a>
        </div>
      </SectionCard>
    </div>
  );
}
