import Link from "next/link";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { InvitePanel, RetrySetupButton, RevokeInviteButton } from "@/components/onboarding/platform-signup";
import { ModuleConfigTable } from "@/components/platform/module-config-table";
import { Button } from "@/components/ui/button";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { requirePermission } from "@/lib/auth/session";
import { ORG_TEMPLATES } from "@/lib/constants/platform-modules";
import { listPlans, planKeyOf } from "@/lib/entitlements/check";
import { formatDateTime } from "@/lib/format";
import { INVITE_STATUS_LABEL, listInvites } from "@/lib/onboarding/invites";
import { listOrganizations } from "@/lib/platform/organizations";
import { listOnboardingStates, signupMode } from "@/lib/onboarding/service";
import { platformOperatorDenial } from "@/lib/platform-ui/module-toggle";
import { getPlatformHealth, type OrgHealth } from "@/lib/queries/platform-health";
import { getOrganizationModuleView } from "@/lib/queries/platform-modules";
import { cn } from "@/lib/utils";

export const metadata = { title: "Vận hành nền tảng" };

const STATUS_LABEL: Record<OrgHealth["status"], string> = { ACTIVE: "Đang chạy", SUSPENDED: "Đình chỉ", ARCHIVED: "Lưu trữ", SETUP_FAILED: "Dựng hỏng" };
const SIGNUP_MODE_LABEL = { off: "TẮT — /start chỉ in «chưa mở đăng ký»", invite: "Cần mã mời", open: "Mở (có trần theo IP / ngày)" } as const;

function Measured({ ok, children, note }: { ok: boolean | null; children: React.ReactNode; note?: string | null }) {
  return (
    <span title={note ?? undefined} className={cn("numeric", ok === false && "font-semibold text-destructive", ok === null && "text-muted-foreground")}>
      {children}
    </span>
  );
}

function migrationCell(o: OrgHealth) {
  if (o.migrationsApplied === null) return <Measured ok={null} note={o.migrationsNote}>—</Measured>;
  const expected = o.migrationsExpected;
  return (
    <Measured ok={expected === null ? null : o.migrationsApplied === expected} note={expected === null ? "Không đọc được sổ migration của mã nguồn" : null}>
      {o.migrationsApplied}/{expected ?? "—"}
    </Measured>
  );
}

function platformTablesCell(o: OrgHealth) {
  if (o.isHome) return <span className="text-xs text-muted-foreground" title={o.platformTablesNote ?? undefined}>Mặt phẳng điều khiển</span>;
  if (!o.platformTables) return <Measured ok={null} note={o.platformTablesNote}>—</Measured>;
  const dirty = o.platformTables.filter((t) => t.rows !== null && t.rows > 0);
  const unknown = o.platformTables.some((t) => t.rows === null);
  if (dirty.length) return <Measured ok={false}>{dirty.map((t) => `${t.table}: ${t.rows}`).join(" · ")}</Measured>;
  if (unknown) return <Measured ok={null} note={o.platformTablesNote}>—</Measured>;
  return <Measured ok>Rỗng (4/4)</Measured>;
}

/**
 * VẬN HÀNH NỀN TẢNG — chỉ người của TỔ CHỨC NHÀ có `platform:operate`.
 *
 * Kiểm hai lần: `requirePermission` (khoá) rồi `platformOperatorDenial` (tổ chức nhà) — trang lẫn
 * action đều kiểm, vì trang này nhìn xuyên qua ranh giới giữa các tổ chức.
 *
 * `?org=<mã>` chỉ chọn tổ chức nào hiện bảng sửa module; nó KHÔNG đổi ngữ cảnh tổ chức của phiên
 * (P4) — mọi lượt ghi vẫn đi qua action, và action kiểm lại quyền.
 */
export default async function PlatformPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requirePermission("platform:operate");
  if (platformOperatorDenial(user)) redirect("/?forbidden=1");
  const raw = (await searchParams).org;
  const selectedCode = typeof raw === "string" ? raw : undefined;

  const health = await getPlatformHealth();
  const selected = selectedCode ? health.organizations.find((o) => o.code === selectedCode) : undefined;
  const editor = selected ? await getOrganizationModuleView(selected.code) : null;
  const withProblems = health.organizations.filter((o) => o.problems.length > 0);
  const [onboarding, invites, plans, registry] = await Promise.all([listOnboardingStates(), listInvites(30), listPlans(), listOrganizations()]);
  const planOfCode = (code: string, isHome: boolean) => planKeyOf({ isHome, plan: registry.find((r) => r.code === code)?.plan ?? null });
  const planName = (key: string) => plans.find((p) => p.key === key)?.name ?? key;

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Hệ thống"
        title="Vận hành nền tảng"
        description={`${health.organizations.length} tổ chức · ${withProblems.length ? `${withProblems.length} tổ chức có vấn đề` : "không phát hiện vấn đề"} · đo lúc ${formatDateTime(new Date(health.checkedAt))}`}
        hint={
          <div className="space-y-1.5 text-xs leading-5">
            <p>Mỗi tổ chức một CSDL (mô hình silo): không có dòng dữ liệu nào thiếu chủ theo nghĩa thiếu cột tổ chức. Máy quét kiểm ba điều tương đương:</p>
            <p>① CSDL của tổ chức mở được · ② đã áp đủ migration của mã nguồn ({health.migrationsExpected ?? "—"} mục) · ③ bốn bảng platform_* trong CSDL tổ chức KHÁC nhà phải rỗng — chỉ bản ở CSDL nhà là thật.</p>
            <p>Cộng hai lỗi cấu hình: module khai bật mà thiếu phụ thuộc, và dòng module mang khoá không có trong sổ.</p>
            <p>“—” là CHƯA ĐO ĐƯỢC (rê chuột để xem lý do), không phải 0. Mở CSDL tổ chức lần đầu trong tiến trình sẽ tự áp migration.</p>
          </div>
        }
      />

      {health.registryProblems.length ? (
        <div role="alert" className="rounded-xl border border-destructive/40 bg-destructive/5 px-4 py-2.5 text-sm">
          {health.registryProblems.map((p) => (
            <p key={p}>{p}</p>
          ))}
        </div>
      ) : null}

      <SectionCard title="Tổ chức & sức khoẻ" description={health.journalNote ?? "Kết nối · migration · bảng platform_* · cấu hình module"} padded={false}>
        {health.organizations.length === 0 ? (
          <EmptyState title="Chưa có tổ chức nào trong sổ" description="Sổ tổ chức rỗng — migration nền tảng chưa áp? Tổ chức nhà luôn phải có một dòng." className="m-4" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[980px] text-sm">
              <thead className="bg-muted/40 text-left text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">Tổ chức</th>
                  <th className="px-3 py-2">Trạng thái</th>
                  <th className="px-3 py-2">Mẫu</th>
                  <th className="px-3 py-2 text-right">Module bật</th>
                  <th className="px-3 py-2">Kết nối</th>
                  <th className="px-3 py-2 text-right">Migration</th>
                  <th className="px-3 py-2">Bảng platform_*</th>
                  <th className="px-3 py-2">Vấn đề</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {health.organizations.map((o) => (
                  <tr key={o.code} className={cn("border-t border-hairline align-top", o.code === selected?.code && "bg-primary/5")}>
                    <td className="px-3 py-2">
                      <div className="font-semibold">
                        {o.name}
                        {o.isHome ? <span className="ml-1.5 rounded-full bg-sky-100 px-1.5 py-0.5 text-[10.5px] font-medium text-sky-900 dark:bg-sky-950 dark:text-sky-200">Nhà</span> : null}
                      </div>
                      <div className="font-mono text-[11px] text-muted-foreground">{o.code}</div>
                    </td>
                    <td className="px-3 py-2">
                      <span className={cn(o.status === "SETUP_FAILED" && "font-semibold text-destructive")}>{STATUS_LABEL[o.status] ?? o.status}</span>
                      {onboarding[o.code] && onboarding[o.code].state !== "DONE" ? (
                        <div className="max-w-[260px] space-y-1 text-[11px] text-muted-foreground">
                          <p>
                            Dựng {onboarding[o.code].state === "RUNNING" ? "đang chạy" : "hỏng"}
                            {onboarding[o.code].failedStep ? ` ở bước ${onboarding[o.code].failedStep}` : ""} · {onboarding[o.code].runs} lượt
                          </p>
                          {onboarding[o.code].error ? <p className="text-destructive">{onboarding[o.code].error}</p> : null}
                          {o.status === "SETUP_FAILED" ? <RetrySetupButton orgCode={o.code} /> : null}
                        </div>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {o.templateKey ? (ORG_TEMPLATES[o.templateKey]?.label ?? o.templateKey) : <span className="text-muted-foreground">—</span>}
                      <div className="text-[11px] text-muted-foreground">Gói {planName(planOfCode(o.code, o.isHome))}</div>
                    </td>
                    <td className="numeric px-3 py-2 text-right" title={`Dòng module thiếu = ${o.moduleDefault === "ENABLED" ? "BẬT" : "TẮT"}`}>
                      {o.enabledModules ?? "—"}/{o.totalModules}
                    </td>
                    <td className="px-3 py-2">
                      <Measured ok={o.connected} note={o.connectNote}>
                        {o.connected === null ? "—" : o.connected ? "Được" : "Không"}
                      </Measured>
                    </td>
                    <td className="px-3 py-2 text-right">{migrationCell(o)}</td>
                    <td className="px-3 py-2 text-xs">{platformTablesCell(o)}</td>
                    <td className="max-w-[320px] px-3 py-2 text-xs">
                      {o.problems.length === 0 ? (
                        <span className="text-muted-foreground">Không phát hiện</span>
                      ) : (
                        <ul className="list-disc space-y-0.5 pl-4 text-destructive">
                          {o.problems.map((p) => (
                            <li key={p}>{p}</li>
                          ))}
                        </ul>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Link href={`/platform?org=${encodeURIComponent(o.code)}`} className="whitespace-nowrap text-xs font-medium text-primary hover:underline">
                        Sửa module
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      <SectionCard
        title="Tự phục vụ — mã mời & tạo tổ chức"
        description={`Đăng ký công khai: ${SIGNUP_MODE_LABEL[signupMode()]} (biến môi trường PLATFORM_SIGNUP_MODE, đọc ở máy chủ)`}
        hint="Người vận hành luôn tạo được tổ chức cho khách qua /start — cùng luồng với khách, không cần cờ, và phiên của bạn không đổi. Mã mời dùng một lần, có hạn; CSDL chỉ giữ băm của mã. Dựng hỏng giữa chừng ⇒ tổ chức ở «Dựng hỏng» (bảng trên) kèm nút Chạy lại — không có CSDL nào bị xoá tự động."
        actions={
          <Button asChild size="sm">
            <Link href="/start">Tạo tổ chức cho khách</Link>
          </Button>
        }
      >
        <div className="space-y-4">
          <InvitePanel plans={plans.filter((p) => p.key !== "internal").map((p) => ({ key: p.key, name: p.name }))} />
          {invites.length === 0 ? (
            <EmptyState title="Chưa có mã mời nào" description="Tạo mã ở trên rồi gửi liên kết cho khách." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-sm">
                <thead className="bg-muted/40 text-left text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2">Ghi chú</th>
                    <th className="px-3 py-2">Gói</th>
                    <th className="px-3 py-2">Trạng thái</th>
                    <th className="px-3 py-2">Hạn</th>
                    <th className="px-3 py-2">Tổ chức sinh ra</th>
                    <th className="px-3 py-2">Người tạo</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {invites.map((i) => (
                    <tr key={i.id} className="border-t border-hairline">
                      <td className="px-3 py-2">{i.note ?? <span className="text-muted-foreground">—</span>}</td>
                      <td className="px-3 py-2 text-xs">{planName(i.planKey ?? "trial")}</td>
                      <td className="px-3 py-2 text-xs">{INVITE_STATUS_LABEL[i.status]}</td>
                      <td className="px-3 py-2 text-xs">{formatDateTime(i.expiresAt)}</td>
                      <td className="px-3 py-2 font-mono text-xs">{i.organizationCode ?? "—"}</td>
                      <td className="px-3 py-2 text-xs">{i.createdByEmail ?? "máy"}</td>
                      <td className="px-3 py-2 text-right">{i.status === "ACTIVE" ? <RevokeInviteButton id={i.id} /> : null}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </SectionCard>

      {selectedCode && !selected ? <EmptyState title={`Không có tổ chức mã "${selectedCode}"`} description="Chọn lại từ bảng phía trên." /> : null}

      {editor && selected ? (
        <SectionCard
          id="module-editor"
          title={`Module của ${editor.organization.name}`}
          description={`${editor.view.enabledCount}/${editor.view.total} đang bật · tính năng chỉ xem ở đây — chỉnh chi tiết là việc của quản trị tổ chức đó`}
          hint="Đổi module của tổ chức khác ghi vào nhật ký nền tảng VÀ nhật ký của chính tổ chức đó, kèm lý do bạn nhập. Phụ thuộc chặn và giải thích như ở trang Module của tổ chức."
          actions={
            <Link href="/platform" className="text-xs text-muted-foreground hover:text-foreground">
              Đóng
            </Link>
          }
          padded={false}
          contentClassName="p-3"
        >
          <ModuleConfigTable groups={editor.view.groups} target={{ kind: "org", orgCode: editor.organization.code, orgName: editor.organization.name }} />
        </SectionCard>
      ) : null}
    </div>
  );
}
