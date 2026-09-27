import Link from "next/link";
import { AlertTriangle, GitBranch, HelpCircle, Layers, Wand2 } from "lucide-react";
import { BulkDeclarePanel } from "@/app/(dashboard)/models/bulk-declare-panel";
import { ModelsTable } from "@/app/(dashboard)/models/models-table";
import { RegisterModelDialog, RegistrySyncButton } from "@/app/(dashboard)/models/registry-actions";
import { DataTableToolbar } from "@/components/data-table/toolbar";
import { PageHeader } from "@/components/page-header";
import { StatStrip } from "@/components/stat-tile";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { can, requirePermission } from "@/lib/auth/session";
import { loadSource } from "@/lib/constants/model-360";
import { BULK_DECLARE_MAX, buildDeclarePreview } from "@/lib/constants/model-bulk-declare";
import { MODEL_STATE_UNDECLARED_LABEL } from "@/lib/constants/model-lifecycle";
import { formatDateTime, formatNumber } from "@/lib/format";
import { getModelSignalsBatch } from "@/lib/queries/model-signal";
import { getModelsEvidenceBatch, listModels, MODEL_SORTABLE, MODEL_STATE_NONE, modelRegistrySummary, modelStateFacets, previewModelRegistry } from "@/lib/queries/models";
import { parseListParams, type SearchParams } from "@/lib/search-params";
import { cn } from "@/lib/utils";

export const metadata = { title: "Vòng đời mẫu" };

/**
 * ═══════════ SỔ MẪU (Company OS · Agent A) ═══════════
 *
 * Danh sách mẫu theo MÃ CHỦ SHOP (Q001, TK-260925-01), trạng thái vòng đời NGƯỜI khai và người phụ trách.
 * Mẫu mới vào sổ bằng nút đồng bộ (từ sản phẩm Pancake + thiết kế TK) hoặc bằng tay (ý tưởng chưa lên
 * Pancake). Trạng thái của mẫu đồng bộ về luôn TRỐNG — "Chưa khai" — cho tới khi có người khai.
 */
export default async function ModelsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const user = await requirePermission("models:view");
  const canWrite = can(user, "models:write");
  const raw = await searchParams;
  const params = parseListParams(raw, { defaultSort: "code", defaultDir: "asc", filterKeys: ["state", "link"], sortable: MODEL_SORTABLE, defaultPeriod: "all" });
  // Cột "Tín hiệu" (Agent S): TẮT mặc định — lượt nguội của tín hiệu theo lô đọc bảng quyết định quảng cáo và
  // hiệu quả mẫu mã cả shop (vài giây trên production), không bắt mọi lượt mở danh sách trả giá đó.
  const coTinHieu = raw.tinhieu === "1";
  // "Khai theo gợi ý" (Agent Q): chỉ đọc chứng cứ theo lô khi người MỞ bảng (`?khai=goi-y`) và có quyền khai.
  // Tập mẫu = mẫu CHƯA KHAI khớp ô tìm / bộ lọc "Nối với" đang áp (không cắt theo trang), tối đa BULK_DECLARE_MAX.
  const moKhai = canWrite && raw.khai === "goi-y";
  const khaiGoiY = moKhai
    ? loadSource("chứng cứ giai đoạn của mẫu chưa khai", async () => {
        const chuaKhai = await listModels({ ...params, filters: { ...params.filters, state: [MODEL_STATE_NONE] }, page: 1, pageSize: BULK_DECLARE_MAX, sort: "code", dir: "asc" });
        const evidence = await getModelsEvidenceBatch(chuaKhai.rows.map((r) => r.id));
        return { rows: buildDeclarePreview(chuaKhai.rows, evidence), total: chuaKhai.total };
      })
    : Promise.resolve(null);
  const [{ rows, total, pageCount }, facets, summary, preview, tinHieu, goiY] = await Promise.all([
    listModels(params),
    modelStateFacets(),
    modelRegistrySummary(),
    previewModelRegistry(),
    coTinHieu ? loadSource("tín hiệu mẫu", () => getModelSignalsBatch()) : Promise.resolve(null),
    khaiGoiY,
  ]);
  const signals =
    tinHieu && tinHieu.ok
      ? {
          periodLabel: tinHieu.data.periodLabel,
          byModel: Object.fromEntries(
            tinHieu.data.rows.filter((r) => rows.some((x) => x.id === r.model.id)).map((r) => [r.model.id, { signal: r.signal.signal, summary: r.signal.summary, conflicts: r.signal.conflicts.length }]),
          ),
        }
      : undefined;
  /** Bật / tắt một tham số URL, giữ nguyên các tham số còn lại. */
  const hrefToggle = (key: string, value: string, on: boolean) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(raw)) {
      if (k === key || v === undefined) continue;
      for (const x of Array.isArray(v) ? v : [v]) q.append(k, x);
    }
    if (!on) q.set(key, value);
    const s = q.toString();
    return s ? `/models?${s}` : "/models";
  };
  const hrefTinHieu = hrefToggle("tinhieu", "1", coTinHieu);

  const chuaDongBo = summary.total === 0;
  const trangThaiLoc = params.filters.state ?? [];
  const chiChuaKhai = trangThaiLoc.length === 1 && trangThaiLoc[0] === MODEL_STATE_NONE;
  const choDongBo = preview.pendingInsert + preview.pendingLink;

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Sản xuất"
        title="Vòng đời mẫu"
        description={summary.lastSync ? `Đồng bộ sổ gần nhất ${formatDateTime(summary.lastSync.at)} · ${summary.lastSync.detail || summary.lastSync.status}` : "Sổ chưa được đồng bộ lần nào"}
        hint={
          <>
            <b>SỔ MẪU</b> gom một mẫu theo MÃ CHỦ SHOP: sản phẩm Pancake có <code>custom_id</code>, thiết kế TK, hoặc mã người gõ
            cho một ý tưởng. <b>Trạng thái khai</b> là điều NGƯỜI nói về mẫu — mẫu đồng bộ về để trống (&ldquo;Chưa khai&rdquo;), máy
            không tự điền. <b>Giai đoạn ước tính</b> trên trang từng mẫu là điều máy thấy trong chứng cứ, không bao giờ thay lời khai.
          </>
        }
        actions={
          canWrite ? (
            <>
              <RegistrySyncButton />
              <RegisterModelDialog />
            </>
          ) : null
        }
      />

      {chuaDongBo ? (
        <EmptyState
          icon={GitBranch}
          title="Sổ mẫu chưa được đồng bộ"
          description={
            <>
              Sổ đang trống vì chưa ai bấm đồng bộ — không phải vì shop không có mẫu nào. Hiện có <b>{formatNumber(preview.pendingInsert)}</b> mã sẵn sàng vào sổ
              {preview.ambiguous.length ? (
                <>
                  {" "}
                  và <b>{formatNumber(preview.ambiguous.length)}</b> mã mơ hồ cần người quyết (xem bên dưới)
                </>
              ) : null}
              . Mẫu vào sổ ở trạng thái &ldquo;Chưa khai&rdquo;.
              {canWrite ? null : " Cần quyền “Vòng đời mẫu: khai & đồng bộ” để bấm đồng bộ."}
            </>
          }
          action={canWrite ? <RegistrySyncButton label="Đồng bộ sổ mẫu ngay" variant="default" /> : undefined}
        />
      ) : (
        <>
          <StatStrip
            columns={3}
            items={[
              { label: "Mẫu trong sổ", value: formatNumber(summary.total), icon: Layers, href: "/models" },
              {
                label: "Chưa khai trạng thái",
                value: formatNumber(summary.undeclared),
                hint: "Mẫu đồng bộ về chưa có ai khai trạng thái vòng đời. Máy không tự điền — mở từng mẫu, hoặc bấm “Khai theo gợi ý” để xác nhận gợi ý của máy cho cả lô.",
                icon: HelpCircle,
                tone: summary.undeclared ? "amber" : "muted",
                href: `/models?state=${MODEL_STATE_NONE}`,
              },
              {
                label: "Chờ đồng bộ",
                value: formatNumber(choDongBo),
                note: `${formatNumber(preview.pendingInsert)} mẫu mới · ${formatNumber(preview.pendingLink)} liên kết`,
                hint: "Sản phẩm / thiết kế mang mã mà sổ chưa có hoặc chưa nối. Sổ tự bắt kịp sau mỗi lượt đồng bộ sản phẩm (30 phút); muốn ngay thì bấm “Đồng bộ sổ mẫu”. Mã mơ hồ không bao giờ tự nối.",
                icon: GitBranch,
                tone: choDongBo ? "amber" : "muted",
                href: "/models",
              },
            ]}
          />
          {/* Company OS · A2: lọc nhanh "Chưa khai" — cùng facet `state` của thanh lọc, chỉ là một cú bấm ngắn hơn. */}
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <span className="text-muted-foreground">Lọc nhanh:</span>
            <Link
              href="/models"
              className={cn("rounded-full border px-2.5 py-0.5", !chiChuaKhai && !(params.filters.state ?? []).length ? "border-primary bg-primary/10 font-semibold" : "hover:bg-muted")}
            >
              Tất cả ({formatNumber(summary.total)})
            </Link>
            <Link href={`/models?state=${MODEL_STATE_NONE}`} className={cn("rounded-full border px-2.5 py-0.5", chiChuaKhai ? "border-primary bg-primary/10 font-semibold" : "hover:bg-muted")}>
              {MODEL_STATE_UNDECLARED_LABEL} ({formatNumber(summary.undeclared)})
            </Link>
            <span className="ml-2 text-muted-foreground">Cột:</span>
            <Link href={hrefTinHieu} className={cn("rounded-full border px-2.5 py-0.5", coTinHieu ? "border-primary bg-primary/10 font-semibold" : "hover:bg-muted")}>
              {coTinHieu ? "✓ " : ""}Tín hiệu mẫu
            </Link>
            {tinHieu && !tinHieu.ok ? <span className="text-rose-700 dark:text-rose-300">Không đọc được nguồn {tinHieu.source}: {tinHieu.error}</span> : null}
            {canWrite && (summary.undeclared > 0 || moKhai) ? (
              <Link
                href={hrefToggle("khai", "goi-y", moKhai)}
                className={cn("ml-2 inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5", moKhai ? "border-primary bg-primary/10 font-semibold" : "hover:bg-muted")}
              >
                <Wand2 className="size-3.5" />
                {moKhai ? "✓ " : ""}Khai theo gợi ý
              </Link>
            ) : null}
          </div>
          {goiY ? (
            <SectionCard
              title={
                <span className="flex items-center gap-1.5">
                  <Wand2 className="size-4" /> Khai theo gợi ý —{" "}
                  {goiY.ok ? `${formatNumber(goiY.data.rows.length)}${goiY.data.total > goiY.data.rows.length ? ` / ${formatNumber(goiY.data.total)}` : ""} mẫu chưa khai` : "không đọc được"}
                </span>
              }
              hint={`Máy đọc chứng cứ của từng mẫu chưa khai và GỢI Ý giai đoạn (ước tính). Không có gì được ghi cho tới khi bạn bấm “Khai”. Mỗi lời khai mang tên bạn, lý do, và ghi lại gợi ý của máy + bạn có chọn khác không. Mẫu đã có người khai trong lúc bảng còn mở sẽ bị bỏ qua, không đè. Mỗi lượt tối đa ${BULK_DECLARE_MAX} mẫu, theo ô tìm / bộ lọc “Nối với” đang áp.`}
            >
              {goiY.ok ? <BulkDeclarePanel rows={goiY.data.rows} /> : <p className="text-sm text-rose-700 dark:text-rose-300">Không đọc được nguồn {goiY.source}: {goiY.error}</p>}
            </SectionCard>
          ) : null}
          <DataTableToolbar
            searchPlaceholder="Mã mẫu, tên…"
            period={false}
            facets={[
              { key: "state", label: "Trạng thái khai", options: facets },
              {
                key: "link",
                label: "Nối với",
                options: [
                  { value: "product", label: "Có sản phẩm Pancake" },
                  { value: "design", label: "Có thiết kế TK" },
                  { value: "none", label: "Chưa nối gì" },
                  { value: "provisional", label: "Mã tạm — chưa lên mã" },
                ],
              },
            ]}
            resultLabel={`${formatNumber(total)} mẫu phù hợp`}
          />
          <ModelsTable rows={rows} pageCount={pageCount} total={total} signals={signals} emptyDescription="Không mẫu nào khớp bộ lọc — thử bỏ bớt điều kiện." />
        </>
      )}

      {preview.ambiguous.length ? (
        <SectionCard
          title={
            <span className="flex items-center gap-1.5">
              <AlertTriangle className="size-4 text-amber-600" /> Mã mơ hồ — máy không tự nối ({formatNumber(preview.ambiguous.length)})
            </span>
          }
          hint="Một mã khớp HAI sản phẩm Pancake trở lên thì máy không chọn hộ (AGENTS.md mục 35). Sửa mã (custom_id) trên Pancake cho đúng một sản phẩm, đồng bộ sản phẩm, rồi đồng bộ sổ — dòng sẽ tự rời danh sách."
        >
          <ul className="divide-y text-sm">
            {preview.ambiguous.map((a) => (
              <li key={`${a.code}-${a.modelId ?? ""}`} className="py-2">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="font-mono font-semibold">{a.code}</span>
                  {a.modelId ? (
                    <Link href={`/models/${a.modelId}`} className="text-xs underline-offset-2 hover:underline">
                      mở mẫu
                    </Link>
                  ) : null}
                </div>
                <p className="text-xs text-muted-foreground">{a.reason}</p>
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs">
                  {a.products.map((sp) => (
                    <Link key={sp.id} href={`/products/${sp.id}`} className="underline-offset-2 hover:underline">
                      {sp.name || sp.id}
                    </Link>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        </SectionCard>
      ) : null}
    </div>
  );
}
