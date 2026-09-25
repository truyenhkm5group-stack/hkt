import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { SectionCard } from "@/components/ui-bits";
import { requirePermission } from "@/lib/auth/session";
import { datumText, OWNER_DECISION_KINDS, OWNER_DECISION_KIND_SPEC, RECOMMENDATION_DECISION_LABEL, type OwnerDecisionKind } from "@/lib/constants/owner-decisions";
import { formatDate, formatDateTime, formatNumber } from "@/lib/format";
import { getOwnerDecisionQueue, listRecentDecisions } from "@/lib/queries/owner-decisions";
import type { SearchParams } from "@/lib/search-params";
import { cn } from "@/lib/utils";
import { KindGroupBlock, SourceWarnings } from "./decision-list";

export const metadata = { title: "Cần anh quyết" };

/**
 * ═══════════ BUỒNG LÁI CHỦ SHOP — ĐỦ DANH SÁCH (Company OS · Agent H) ═══════════
 *
 * Trang chủ hiện 3 dòng đầu mỗi loại; trang này hiện TẤT CẢ, lọc theo loại (`?kind=`), cộng hai thứ trang
 * chủ không có chỗ: đề xuất ĐANG ẨN (bỏ qua / hẹn nhắc — `?an=1`) và phản ứng gần đây. Ẩn không có nghĩa
 * là mất: dòng ẩn vẫn tra được ở đây, kèm ai quyết, lúc nào, lý do gì.
 */
export default async function CockpitPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const user = await requirePermission("dashboard:view");
  const raw = await searchParams;
  const kindParam = typeof raw.kind === "string" && (OWNER_DECISION_KINDS as readonly string[]).includes(raw.kind) ? (raw.kind as OwnerDecisionKind) : null;
  const showHidden = raw.an === "1";
  const [q, recent] = await Promise.all([getOwnerDecisionQueue({ viewer: user }), listRecentDecisions(user, 20)]);
  const groups = kindParam ? q.groups.filter((g) => g.kind === kindParam) : q.groups;
  const hidden = kindParam ? q.hidden.filter((h) => h.kind === kindParam) : q.hidden;
  const countOf = (k: OwnerDecisionKind) => q.groups.find((g) => g.kind === k)?.count ?? 0;
  const href = (k: OwnerDecisionKind | null, an = showHidden) => {
    const p = new URLSearchParams();
    if (k) p.set("kind", k);
    if (an) p.set("an", "1");
    const s = p.toString();
    return s ? `/cockpit?${s}` : "/cockpit";
  };

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Ban điều hành"
        title="Cần anh quyết"
        description={`${formatNumber(q.total)} quyết định đang chờ · ${formatNumber(q.hidden.length)} đang ẩn`}
        hint={
          <>
            <p>Mỗi dòng là một quyết định của người điều hành, đọc từ màn hình đang chạy — CÁI GÌ · VÌ SAO · SỐ LIỆU · TÁC ĐỘNG · nút mở màn hình chủ. Không có công thức hay ngưỡng mới nào ở đây; số trên dòng là số của màn hình chủ.</p>
            <p className="mt-1.5">Chấp nhận: vẫn hiện tới khi điều kiện ở nguồn hết (chấp nhận không phải đã làm). Bỏ qua: bắt buộc lý do, ẩn tới khi nguồn đổi kết luận. Nhắc lại sau: ẩn tới ngày chọn. Mọi phản ứng được lưu kèm ảnh chụp đề xuất để đo sau.</p>
          </>
        }
      />

      <nav className="flex flex-wrap gap-1.5" aria-label="Lọc theo loại quyết định">
        <Link href={href(null)} className={cn("rounded-full border px-3 py-1 text-xs font-semibold", !kindParam ? "border-primary bg-primary text-primary-foreground" : "hover:bg-muted")}>
          Tất cả · {formatNumber(q.total)}
        </Link>
        {q.kinds.map((k) => (
          <Link key={k} href={href(k)} className={cn("rounded-full border px-3 py-1 text-xs", kindParam === k ? "border-primary bg-primary text-primary-foreground" : "hover:bg-muted", countOf(k) === 0 && kindParam !== k && "text-muted-foreground")}>
            {OWNER_DECISION_KIND_SPEC[k].label} · {formatNumber(countOf(k))}
          </Link>
        ))}
        <Link href={href(kindParam, !showHidden)} className={cn("rounded-full border px-3 py-1 text-xs", showHidden ? "border-primary bg-primary/10 font-semibold" : "hover:bg-muted")}>
          {showHidden ? "Ẩn danh sách đang ẩn" : `Xem ${formatNumber(q.hidden.length)} đang ẩn`}
        </Link>
      </nav>

      {!q.kinds.length ? (
        <SectionCard>
          <p className="text-center text-sm text-muted-foreground">Tài khoản này chưa có quyền với màn hình chủ của loại quyết định nào.</p>
        </SectionCard>
      ) : (
        <SectionCard title="Đang chờ quyết" padded={false}>
          {groups.length ? (
            groups.map((g) => <KindGroupBlock key={g.kind} group={g} limit={null} from="cockpit" />)
          ) : (
            <p className="px-5 py-6 text-center text-sm text-muted-foreground">
              {q.failed.length ? "Các nguồn đọc được không có quyết định nào đang chờ — xem dòng cảnh báo bên dưới." : "Không có quyết định nào đang chờ."}
            </p>
          )}
          <SourceWarnings failed={q.failed} notes={q.notes} />
        </SectionCard>
      )}

      {showHidden ? (
        <SectionCard title="Đang ẩn" description="Vẫn có ở nguồn — ẩn vì đã bỏ qua hoặc đang hẹn nhắc lại." padded={false}>
          {hidden.length ? (
            <div className="divide-y">
              {hidden.map((h) => (
                <div key={h.sourceKey} className="flex flex-col gap-1 px-5 py-2.5 text-sm lg:flex-row lg:items-center lg:gap-4">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-semibold">{h.what}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {h.data
                        .slice(0, 3)
                        .map((d) => `${d.label} ${datumText(d.value)}`)
                        .join(" · ")}
                    </p>
                  </div>
                  <p className="shrink-0 text-xs text-muted-foreground lg:w-[420px]">
                    <b>{h.latest ? RECOMMENDATION_DECISION_LABEL[h.latest.decision] : "—"}</b>
                    {h.latest?.decision === "SNOOZED" ? ` tới ${formatDate(h.latest.snoozeUntil)}` : ""} · {h.latest?.decidedBy || "—"} · {formatDateTime(h.latest?.decidedAt)}
                    {h.latest?.reason ? ` · “${h.latest.reason}”` : ""}
                  </p>
                  <Link href={h.action.href} className="shrink-0 text-xs font-semibold text-primary hover:underline">
                    {h.action.label}
                  </Link>
                </div>
              ))}
            </div>
          ) : (
            <p className="px-5 py-6 text-center text-sm text-muted-foreground">Không có đề xuất nào đang ẩn.</p>
          )}
        </SectionCard>
      ) : null}

      <SectionCard title="Phản ứng gần đây" hint="20 phản ứng mới nhất với đề xuất thuộc loại anh được xem. Ảnh chụp đề xuất lúc quyết nằm trong sổ, để sau này đo đề xuất nào đúng." padded={false}>
        {recent.length ? (
          <div className="divide-y">
            {recent.map((r) => (
              <div key={r.id} className="flex items-center gap-3 px-5 py-2 text-xs">
                <span className="w-24 shrink-0 font-semibold">{RECOMMENDATION_DECISION_LABEL[r.decision]}</span>
                <span className="min-w-0 flex-1 truncate">{r.what}</span>
                <span className="shrink-0 text-muted-foreground">
                  {r.decidedBy || "—"} · {formatDateTime(r.decidedAt)}
                  {r.decision === "SNOOZED" ? ` · tới ${formatDate(r.snoozeUntil)}` : ""}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="px-5 py-6 text-center text-sm text-muted-foreground">Chưa có phản ứng nào.</p>
        )}
      </SectionCard>
    </div>
  );
}
