import Link from "next/link";
import { Plus, Settings2 } from "lucide-react";
import { DataTableToolbar, type FacetDef } from "@/components/data-table/toolbar";
import { GateMessage } from "@/components/objects/gate-message";
import { ObjectIcon } from "@/components/objects/object-icon";
import { RecordsTable } from "@/components/objects/records-table";
import { PageHeader } from "@/components/page-header";
import { ScopeDenied } from "@/components/scope-denied";
import { Button } from "@/components/ui/button";
import { requireResource } from "@/lib/auth/scope-guard";
import { can } from "@/lib/auth/session";
import { formatNumber } from "@/lib/format";
import { listRecords } from "@/lib/objects/records";
import { param, parseListParams, type SearchParams } from "@/lib/search-params";

export const metadata = { title: "Ứng dụng tuỳ biến" };

/** Tiền tố tham số URL của bộ lọc theo field tuỳ biến (`f_<khoá>=<giá trị>`). */
const FIELD_FILTER_PREFIX = "f_";

/**
 * DANH SÁCH BẢN GHI của một đối tượng tuỳ biến (Phase 6 · mục 5) — tự sinh, không soạn gì: cột + sắp xếp + bộ lọc
 * mặc định theo danh sách ĐÃ XUẤT BẢN (Phase 2), lọc / sắp / phân trang ở MÁY CHỦ, phạm vi dữ liệu theo người xem.
 * Cổng: quyền + phạm vi (`requireResource`), rồi cổng bản ghi của đối tượng (module · khoá siết) trong `listRecords`.
 */
export default async function ObjectRecordsPage({ params, searchParams }: { params: Promise<{ object: string }>; searchParams: Promise<SearchParams> }) {
  const { object } = await params;
  const { user, decision } = await requireResource("CUSTOM_RECORDS", "records:view");
  if (decision.allow === "NONE") return <ScopeDenied title="Ứng dụng tuỳ biến" reason={decision.reason} fix={decision.fix} />;
  const raw = await searchParams;
  const lp = parseListParams(raw, { defaultPageSize: 25 });
  const fieldEq = Object.fromEntries(
    Object.keys(raw)
      .filter((k) => k.startsWith(FIELD_FILTER_PREFIX))
      .map((k) => [k.slice(FIELD_FILTER_PREFIX.length), param(raw, k)] as const)
      .filter(([, v]) => v),
  );
  const r = await listRecords(object, lp, user, { fieldEq, mine: param(raw, "mine") === "1" });
  if (!r.ok) return <GateMessage failure={r} title="Ứng dụng tuỳ biến" />;

  const facets: FacetDef[] = r.customFields
    .filter((f) => f.filterable && (f.type === "select" || f.type === "status" || f.type === "boolean"))
    .map((f) => ({
      key: `${FIELD_FILTER_PREFIX}${f.key}`,
      label: f.label,
      single: true,
      options: f.type === "boolean" ? [{ value: "true", label: "Có" }, { value: "false", label: "Không" }] : f.options.filter((o) => o.active).map((o) => ({ value: o.value, label: o.label })),
    }));
  facets.push({ key: "mine", label: "Của tôi", single: true, options: [{ value: "1", label: "Tôi phụ trách" }] });

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Ứng dụng tuỳ biến"
        title={
          <span className="flex items-center gap-2">
            <ObjectIcon icon={r.object.icon} className="size-6 text-primary" />
            {r.object.labelPlural}
          </span>
        }
        description={`${formatNumber(r.total)} bản ghi${r.scopeExplain ? ` · ${r.scopeExplain}` : ""}${r.filtersSkipped ? ` · ${r.filtersSkipped} bộ lọc mặc định bị bỏ vì bạn không xem được field đó` : ""}`}
        hint={r.object.description ?? undefined}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {r.canCreate ? (
              <Button asChild size="sm">
                <Link href={`/o/${r.object.key}/new`}>
                  <Plus className="size-4" /> Tạo mới
                </Link>
              </Button>
            ) : null}
            {can(user, "metadata:manage") ? (
              <Button asChild variant="outline" size="sm">
                <Link href={`/settings/data-model?object=${r.object.key}`}>
                  <Settings2 className="size-4" /> Cấu hình
                </Link>
              </Button>
            ) : null}
          </div>
        }
      />
      <DataTableToolbar searchPlaceholder={`Tìm theo ${r.object.titleLabel.toLocaleLowerCase("vi")}…`} facets={facets} />
      <RecordsTable
        objectKey={r.object.key}
        titleLabel={r.object.titleLabel}
        schema={r.schema}
        customFields={r.customFields}
        rows={r.rows}
        total={r.total}
        pageCount={r.pageCount}
        sortable={r.sortable}
        defaultSort={r.sort.id}
        defaultDir={r.sort.dir}
        userNames={r.userNames}
        relationLabels={r.relationLabels}
      />
    </div>
  );
}
