import Link from "next/link";
import { Bot, Users } from "lucide-react";
import { InfoHint } from "@/components/info-hint";
import { PageHeader } from "@/components/page-header";
import { SectionCard } from "@/components/ui-bits";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requirePermission } from "@/lib/auth/session";
import {
  AGENTS,
  AGENT_ZONES,
  AI_AUTONOMY_LABEL,
  AI_RUNGS,
  AI_RUNG_LABEL,
  AI_RUNG_QUESTION,
  AI_STATUS_LABEL,
  AI_STATUS_SHORT,
  AI_STATUS_TONE,
  agentCoverage,
  agentLabel,
  nextRung,
  type AgentZone,
} from "@/lib/constants/department-ai";
import { MODULE_GROUPS, NO_MODULE_REASON } from "@/lib/constants/department-modules";
import { DEPARTMENT_LABEL, DEPARTMENT_ORDER, DEPARTMENT_TONE, TEAM_DEPARTMENT_DIVERGENCE, type DepartmentCode } from "@/lib/constants/departments";
import { activeMembershipsByUser } from "@/lib/org/membership";
import { cn } from "@/lib/utils";

export const metadata = { title: "Bản đồ phòng ban & AI" };

/**
 * ═══════════ BẢN ĐỒ BỘ MÁY: AI SỞ HỮU MÀN HÌNH NÀO, VÀ AGENT ĐANG Ở NẤC NÀO ═══════════
 *
 * Trang này KHÔNG tính gì. Nó in ra hai sổ khai (`department-modules.ts` và `department-ai.ts`) cộng
 * MỘT con số đọc từ CSDL: mỗi phòng đang có bao nhiêu người. Con số ấy cần vì nó đổi hẳn cách đọc
 * bảng — một phòng đầy việc mà không có ai là một vấn đề khác hẳn một phòng thiếu công cụ.
 *
 * Vì sao không tô màu xếp hạng phòng: thang năm nấc nói phòng nào ĐÃ ĐƯỢC ĐẦU TƯ, không nói phòng nào
 * LÀM TỐT. Phòng Kho mãi mãi không có nấc BÀN TAY và đó là quyết định an toàn, không phải điểm kém.
 */
export default async function DepartmentMapPage() {
  await requirePermission("dashboard:view");

  // Đường đọc tư cách thành viên DUY NHẤT (AGENTS.md mục 32) — không truy vấn `department_members` ở đây.
  const byUser = await activeMembershipsByUser();
  const headcount = new Map<DepartmentCode, number>();
  for (const list of byUser.values()) {
    for (const m of list) headcount.set(m.code, (headcount.get(m.code) ?? 0) + 1);
  }

  const moduleCount = new Map<AgentZone, number>();
  for (const g of MODULE_GROUPS) {
    if (g.zone === "EVERYONE") continue;
    moduleCount.set(g.zone as AgentZone, g.items.length);
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Bộ máy"
        title="Bản đồ phòng ban & AI"
        hint={
          <>
            <p className="mb-1">Phòng nào sở hữu màn hình nào, phòng nào có bao nhiêu người, và agent của từng phòng đang làm được tới nấc nào.</p>
            Hai sổ khai dựng nên trang này: <code>lib/constants/department-modules.ts</code> (mỗi module thuộc đúng một phòng, kèm lý do) và{" "}
            <code>lib/constants/department-ai.ts</code> (năm nấc tự động hoá, mỗi nấc phải chỉ ra tệp mã nguồn đang chạy). Bài kiểm{" "}
            <code>tests/department-map.test.ts</code> mở từng tệp bằng chứng, nên một ô xanh không khai khống được. Thanh menu bên trái đọc cùng sổ, nên bản đồ này
            và menu không bao giờ nói hai điều khác nhau.
          </>
        }
      />

      {/* ───────────── THANG TỰ ĐỘNG HOÁ ───────────── */}
      <SectionCard
        title={
          <span className="flex items-center gap-1.5">
            <Bot className="size-4 text-muted-foreground" aria-hidden />
            Thang tự động hoá của từng phòng
          </span>
        }
        hint={
          <>
          <p className="mb-1">Năm nấc, thứ tự không đảo được. Đưa chuột vào một ô để đọc máy đang làm gì ở nấc đó — hoặc thiếu đúng cái gì.</p>
          <ul className="list-disc space-y-1 pl-4">
            {AI_RUNGS.map((r) => (
              <li key={r}>
                <b>{AI_RUNG_LABEL[r]}</b> — {AI_RUNG_QUESTION[r]}
              </li>
            ))}
            <li className="pt-1">
              Nấc BÀN TAY mà không có nấc ĐỀ NGHỊ là một cỗ máy không có lý lẽ; nấc VÀO VIỆC mà không có nấc ĐO là một hàng đợi không ai kiểm được. Vì thế cột
              cuối luôn chỉ vào nấc THẤP NHẤT còn dở — bỏ qua nấc &quot;cố ý đóng&quot; (AI không được ghi vào tiền, tồn kho, hay thay người ra quyết định).
            </li>
          </ul>
          </>
        }
        contentClassName="p-0"
      >
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[150px]">Phòng</TableHead>
                <TableHead className="w-[160px]">Agent · mức tự chủ</TableHead>
                {AI_RUNGS.map((r) => (
                  <TableHead key={r} className="w-[80px] text-center">
                    {AI_RUNG_LABEL[r]}
                  </TableHead>
                ))}
                <TableHead className="w-[300px] whitespace-normal">Việc phải làm tiếp</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {AGENT_ZONES.map((zone) => {
                const spec = AGENTS[zone];
                const cover = agentCoverage(spec);
                const next = nextRung(spec);
                const people = zone === "SYSTEM" ? null : (headcount.get(zone) ?? 0);
                return (
                  <TableRow key={zone}>
                    <TableCell className="align-top whitespace-normal">
                      <div className="flex flex-col gap-1">
                        <span className="font-semibold">{agentLabel(zone)}</span>
                        <span className="text-xs text-muted-foreground">
                          {moduleCount.get(zone) ?? 0} màn hình ·{" "}
                          {people === null ? (
                            "không phải phòng nhân sự"
                          ) : people === 0 ? (
                            <span className="font-semibold text-amber-700 dark:text-amber-400">chưa có ai</span>
                          ) : (
                            `${people} người`
                          )}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="align-top whitespace-normal">
                      <div className="flex flex-col gap-1">
                        <span className={spec.name ? "font-medium" : "text-muted-foreground"}>{spec.name ?? "Chưa có agent mang tên"}</span>
                        <span className="flex items-center gap-1 text-xs text-muted-foreground">
                          {AI_AUTONOMY_LABEL[spec.autonomy]}
                          <InfoHint>{spec.autonomyWhy}</InfoHint>
                        </span>
                        {spec.home ? (
                          <Link href={spec.home} className="text-xs text-primary underline underline-offset-2">
                            Mở màn hình →
                          </Link>
                        ) : (
                          <span className="text-xs text-muted-foreground">Chưa có lối vào riêng</span>
                        )}
                      </div>
                    </TableCell>
                    {AI_RUNGS.map((r) => {
                      const st = spec.rungs[r];
                      return (
                        <TableCell key={r} className="align-top text-center">
                          {/* Chi tiết đi vào `title`: bảng chín cột phải vừa một màn hình. */}
                          <span
                            title={
                              st.closedByDesign
                                ? `${AI_RUNG_LABEL[r]} — Cố ý đóng: ${st.missing ?? st.what}`
                                : `${AI_RUNG_LABEL[r]} — ${AI_STATUS_LABEL[st.status]}: ${st.what}${st.missing ? ` | Thiếu: ${st.missing}` : ""}`
                            }
                            className={cn(
                              "inline-block rounded-md px-1.5 py-0.5 text-[11px] font-semibold",
                              st.closedByDesign ? "border border-dashed text-muted-foreground" : AI_STATUS_TONE[st.status],
                            )}
                          >
                            {st.closedByDesign ? "Cố ý đóng" : AI_STATUS_SHORT[st.status]}
                          </span>
                        </TableCell>
                      );
                    })}
                    {/*
                      VĂN XUÔI DÀI PHẢI GÃY DÒNG VÀ BỊ CẮT.

                      `TableCell` mặc định `whitespace-nowrap`, nên một câu "thiếu cái gì" dài 200 ký
                      tự đẩy bảng chín cột tràn ngang — đo thật ở 1440px: cột cuối biến mất khỏi màn
                      hình. Cắt ba dòng, câu đầy đủ nằm ở `title`.
                    */}
                    <TableCell className="max-w-[300px] align-top text-xs leading-5 whitespace-normal">
                      {next === null ? (
                        cover.closed > 0 ? (
                          <span className="font-semibold text-emerald-700 dark:text-emerald-400">
                            Đủ mọi nấc được phép — {cover.built}/{cover.total} đang chạy, {cover.closed} cố ý đóng
                          </span>
                        ) : (
                          <span className="font-semibold text-emerald-700 dark:text-emerald-400">Đủ năm nấc — {cover.built}/{cover.total} đang chạy</span>
                        )
                      ) : (
                        <span title={spec.rungs[next].missing} className="line-clamp-3">
                          <span className="font-semibold">{AI_RUNG_LABEL[next]}</span>
                          <span className="text-muted-foreground"> · {spec.rungs[next].missing}</span>
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </SectionCard>

      {/* ───────────── BẢN ĐỒ MÀN HÌNH ───────────── */}
      <SectionCard
        title="Màn hình thuộc phòng nào"
        hint="Mỗi module có đúng một chủ. Dấu ⓘ cạnh mỗi module là lý do phòng đó sở hữu nó, chứ không phải phòng bên cạnh."
      >
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {MODULE_GROUPS.map((g) => (
            <div key={g.zone} className="rounded-lg border bg-surface-sunken/30 p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <h3 className="flex items-center gap-1 text-[13px] font-bold">
                  {g.label}
                  <InfoHint>{g.hint}</InfoHint>
                </h3>
                <span className="text-[11px] text-muted-foreground">{g.items.length} màn hình</span>
              </div>
              <ul className="flex flex-col gap-2">
                {g.items.map((m) => (
                  <li key={m.href} className="flex items-center gap-1">
                    <Link href={m.href} className="text-[13px] font-medium text-primary underline-offset-2 hover:underline">
                      {m.label}
                    </Link>
                    <InfoHint>{m.why}</InfoHint>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        {/* Phòng không sở hữu màn hình nào vẫn phải hiện ra — một ô rỗng đọc như "phòng này không làm gì". */}
        <div className="mt-4 flex flex-col gap-3">
          {DEPARTMENT_ORDER.filter((d) => NO_MODULE_REASON[d]).map((d) => (
            <div key={d} className="rounded-lg border border-dashed p-3">
              <div className="flex items-center gap-2">
                <Badge variant="outline" className={cn("text-[11px]", DEPARTMENT_TONE[d])}>
                  {DEPARTMENT_LABEL[d]}
                </Badge>
                <span className="text-[13px] font-semibold">Chưa có màn hình riêng</span>
                <InfoHint>{NO_MODULE_REASON[d]}</InfoHint>
              </div>
            </div>
          ))}
        </div>
      </SectionCard>

      {/* ───────────── CHỖ LỆCH CỐ Ý ───────────── */}
      <SectionCard
        title={
          <span className="flex items-center gap-1.5">
            <Users className="size-4 text-muted-foreground" aria-hidden />
            Sở hữu màn hình ≠ nhận việc
          </span>
        }
        hint="Hai chiều tách nhau, và chỗ lệch nào cũng phải có lý do đọc được."
      >
        <ul className="flex flex-col gap-3">
          {TEAM_DEPARTMENT_DIVERGENCE.map((d) => (
            <li key={d.team} className="rounded-lg border p-3 text-xs leading-5">
              <div className="flex flex-wrap items-center gap-1.5 text-[13px] font-semibold">
                <span>Việc nhóm {d.team}</span>
                <span className="text-muted-foreground">→ hàng đợi phòng</span>
                <Badge variant="outline" className={cn("text-[11px]", DEPARTMENT_TONE[d.routedTo])}>
                  {DEPARTMENT_LABEL[d.routedTo]}
                </Badge>
                <span className="text-muted-foreground">· màn hình thuộc</span>
                <Badge variant="outline" className={cn("text-[11px]", DEPARTMENT_TONE[d.modulesOwnedBy])}>
                  {DEPARTMENT_LABEL[d.modulesOwnedBy]}
                </Badge>
                <InfoHint>{d.why}</InfoHint>
              </div>
            </li>
          ))}
        </ul>
      </SectionCard>
    </div>
  );
}
