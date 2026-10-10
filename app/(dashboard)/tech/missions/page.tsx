import Link from "next/link";
import { MissionControlTable } from "@/app/(dashboard)/tech/missions/mission-control-table";
import { MissionForm } from "@/app/(dashboard)/tech/missions/mission-form";
import { TechNav } from "@/app/(dashboard)/tech/tech-nav";
import { DataTableToolbar } from "@/components/data-table/toolbar";
import { PageHeader } from "@/components/page-header";
import { SyncButton } from "@/components/sync-button";
import { can, requirePermission } from "@/lib/auth/session";
import {
  MISSION_CONTROL_FILTER_KEYS,
  MISSION_CONTROL_LABEL,
  MISSION_CONTROL_PAGE_SIZE,
  MISSION_CONTROL_SORTABLE,
  REGISTRY_STALE_HOURS,
  TECH_REGISTRY_BRANCH,
  registryProjectLabel,
} from "@/lib/constants/tech-registry";
import { formatDateTime, formatNumber, formatTimeAgo } from "@/lib/format";
import { listTechProjects } from "@/lib/queries/tech-control-plane";
import { listMissionControl, registrySyncInfo, shortOwner } from "@/lib/queries/tech-registry";
import { parseListParams, type SearchParams } from "@/lib/search-params";

export const metadata = { title: "Sứ mệnh · Phòng Tech AI" };

/** Sổ đọc tay ⇒ quá chừng này phút là in cảnh báo «sổ có thể đã cũ» ngay đầu trang. */
const REGISTRY_READ_STALE_MINUTES = 30;

/**
 * MISSION CONTROL — mọi sứ mệnh ở MỘT chỗ: sổ Tech Room (nguồn sự thật điều phối, chiếu chỉ đọc) + sứ mệnh tạo tay
 * trong `/tech`. Trạng thái theo bộ chuẩn của chủ shop; «xong» chỉ khi có bằng chứng kiểm hành vi trên production.
 */
export default async function TechMissionsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const raw = await searchParams;
  const user = await requirePermission("tech:view");
  const canManage = can(user, "tech:manage");
  const params = parseListParams(raw, { defaultSort: "updatedAt", filterKeys: MISSION_CONTROL_FILTER_KEYS, sortable: MISSION_CONTROL_SORTABLE, defaultPageSize: MISSION_CONTROL_PAGE_SIZE });
  const now = new Date();
  const [list, sync, projects] = await Promise.all([listMissionControl(params, now), registrySyncInfo(), listTechProjects()]);
  const activeProjects = projects.filter((p) => p.active).map((p) => ({ key: p.key, name: p.name }));
  const f = list.facets;
  const count = (k: string) => f.state.find(([s]) => s === k)?.[1] ?? 0;
  const soCu = !sync.lastAt || now.getTime() - sync.lastAt.getTime() > REGISTRY_READ_STALE_MINUTES * 60_000;

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Phòng Tech AI"
        title="Sứ mệnh"
        description={`${formatNumber(list.totalAll)} sứ mệnh · ${count("RUNNING")} đang chạy · ${count("WAITING_APPROVAL")} chờ anh quyết · ${count("COMPLETED")} xong đã kiểm production · ${count("DONE_UNVERIFIED")} DONE chưa kiểm production`}
        actions={
          <div className="flex flex-wrap gap-2">
            {canManage && sync.configured ? <SyncButton job="tech-registry-sync" label="Đọc lại sổ" wait /> : null}
            {canManage ? <MissionForm projects={activeProjects} /> : null}
          </div>
        }
        hint={
          <>
            Nguồn sự thật là <b>sổ Tech Room</b> (nhánh <code>{TECH_REGISTRY_BRANCH}</code>, ghi bằng <code>npm run ai -- …</code>).
            Trang này CHỈ ĐỌC sổ — muốn đổi trạng thái thì đổi ở sổ rồi bấm «Đọc lại sổ». <b>Xong</b> chỉ khi có bằng
            chứng kiểm hành vi thật trên production; sổ ghi DONE mà chỉ có health / phiên bản thì hiện «DONE (chưa kiểm
            production)». «Đứng im» = đang chạy mà không có nhịp / cập nhật quá {REGISTRY_STALE_HOURS} giờ (tính lúc mở
            trang). Dự án suy từ tiền tố mã sứ mệnh — sổ chưa có trường dự án.
          </>
        }
      />
      <TechNav />

      <div className={`rounded-xl border px-3 py-2 text-xs ${soCu ? "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200" : "bg-card text-muted-foreground"}`}>
        {!sync.configured ? (
          <>Chưa đọc được sổ: {sync.reason}</>
        ) : sync.lastAt ? (
          <>
            Đọc sổ lần cuối <b>{formatTimeAgo(sync.lastAt)}</b> ({formatDateTime(sync.lastAt)})
            {sync.commitSha ? (
              <>
                {" "}
                · commit sổ <span className="font-mono">{sync.commitSha.slice(0, 7)}</span>
              </>
            ) : null}{" "}
            · {sync.repo}
            {soCu ? <> — sổ đọc TAY (chưa có lịch tự động), số trên trang có thể đã cũ. Bấm «Đọc lại sổ».</> : null}
          </>
        ) : (
          <>Chưa đọc sổ lần nào — bảng dưới chỉ có sứ mệnh tạo tay. Bấm «Đọc lại sổ» để nạp {sync.repo ? `sổ của ${sync.repo}` : "sổ"}.</>
        )}
      </div>

      <DataTableToolbar
        searchPlaceholder="Mã, tiêu đề, nhánh…"
        period={false}
        quickCount={3}
        facets={[
          {
            key: "state",
            label: "Trạng thái",
            options: [
              ...f.state.map(([s, n]) => ({ value: s, label: MISSION_CONTROL_LABEL[s], count: n })),
              ...(f.stale ? [{ value: "STALE", label: "Đứng im (đang chạy, không nhịp)", count: f.stale }] : []),
            ],
          },
          { key: "project", label: "Dự án", options: f.project.map(([p, n]) => ({ value: p, label: registryProjectLabel(p), count: n })) },
          { key: "priority", label: "Ưu tiên", options: f.priority.map(([p, n]) => ({ value: p, label: p, count: n })) },
          { key: "owner", label: "Phụ trách", options: f.owner.map(([o, n]) => ({ value: o, label: o ? shortOwner(o) : "—", count: n })) },
          {
            key: "source",
            label: "Nguồn",
            options: [
              ...f.source.map(([s, n]) => ({ value: s, label: s === "REGISTRY" ? "Sổ Tech Room" : "Tạo tay trong /tech", count: n })),
              { value: "REMOVED", label: "Gồm cả sứ mệnh đã biến khỏi sổ" },
            ],
          },
        ]}
        resultLabel={`${formatNumber(list.total)} sứ mệnh`}
      />

      <MissionControlTable rows={list.rows} pageCount={list.pageCount} total={list.total} repo={sync.repo} />

      <p className="text-[11px] text-muted-foreground">
        Mục chờ anh quyết cũng hiện ở{" "}
        <Link href="/tech/needs-owner" className="font-semibold text-primary hover:underline">
          Cần chủ shop
        </Link>
        .
      </p>
    </div>
  );
}
