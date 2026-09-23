import { Bot } from "lucide-react";
import { AgentEnableSwitch, SeedAgentsButton, AgentRiskPicker } from "@/app/(dashboard)/tech/agents/agent-controls";
import { TechNav } from "@/app/(dashboard)/tech/tech-nav";
import { PageHeader } from "@/components/page-header";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { can, requirePermission } from "@/lib/auth/session";
import { TECH_AGENT_ROLE_LABEL, TECH_AGENT_STATUS_LABEL, TECH_AGENT_TEMPLATES, type TechAgentRole, type TechAgentStatus } from "@/lib/constants/tech";
import { formatNumber, formatTimeAgo } from "@/lib/format";
import { chuoiSachTheoAgent, listTechAgents, orphanTechRunCount, techAgentRoleCoverage } from "@/lib/queries/tech-agents";
import { DUNG_VI_LABEL, NGUONG_MO_QA } from "@/lib/constants/agent-clean-streak";
import { cn } from "@/lib/utils";

export const metadata = { title: "Sổ agent AI" };

export default async function TechAgentsPage() {
  const user = await requirePermission("tech:view");
  const canManage = can(user, "tech:manage");
  const [agents, coverage, orphan, chuoi] = await Promise.all([listTechAgents(), techAgentRoleCoverage(), orphanTechRunCount(), chuoiSachTheoAgent()]);
  const thieu = coverage.filter((c) => !c.has);

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Phòng Tech AI"
        title="Sổ agent"
        description={`${formatNumber(agents.filter((a) => a.enabled).length)}/${formatNumber(agents.length)} định nghĩa đang bật · bản khai trong mã nguồn có ${TECH_AGENT_TEMPLATES.length} vai`}
        hint={
          <>
            Phase 1 đây là <b>dữ liệu điều khiển</b>: sổ khai ai được làm gì, chưa có máy thi hành
            nào gọi vào. Một dòng ở đây <b>không phải một con người</b> — nó không nối vào bảng
            người dùng và không bao giờ được đếm như nhân sự ở báo cáo hiệu suất. Mọi agent sinh ra
            ở trạng thái TẮT, và Phase 1 không cho bật agent mang quyền merge / deploy / ghi
            production vì máy thi hành chưa tồn tại.
          </>
        }
        actions={canManage ? <SeedAgentsButton label={agents.length ? "Bổ sung vai còn thiếu" : "Khởi tạo sổ agent"} /> : null}
      />

      <TechNav />

      {agents.length === 0 ? (
        <SectionCard>
          <EmptyState
            title="Sổ agent đang trống"
            description={
              canManage
                ? "Mẫu không tự kích hoạt: bấm “Khởi tạo sổ agent” để đưa bản khai trong mã nguồn vào sổ. Tất cả sẽ ở trạng thái TẮT cho tới khi có người bật từng cái."
                : "Chưa ai khởi tạo sổ agent. Cần quyền quản trị Phòng Tech AI để làm việc đó."
            }
            icon={Bot}
          />
        </SectionCard>
      ) : (
        <SectionCard title="Định nghĩa agent" description="Vai · năng lực · mức rủi ro được phép · trạng thái" padded={false}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Agent</TableHead>
                <TableHead>Được phép</TableHead>
                <TableHead>Việc / lượt chạy</TableHead>
                <TableHead>Trạng thái</TableHead>
                <TableHead className="text-right">Bật</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {agents.map((a) => (
                <TableRow key={a.id}>
                  <TableCell className="align-top">
                    <div className="font-medium">{a.name}</div>
                    <div className="text-[11px] text-muted-foreground">
                      {TECH_AGENT_ROLE_LABEL[a.role as TechAgentRole] ?? a.role} · <span className="font-mono">{a.key}</span>
                    </div>
                    <p className="mt-0.5 max-w-md text-[11.5px] leading-5 text-muted-foreground">{a.description}</p>
                  </TableCell>
                  <TableCell className="align-top text-xs">
                    <div className="mb-1">Rủi ro được phép:</div>
                    <AgentRiskPicker agentId={a.id} name={a.name} allowedRisks={a.allowedRisks} />
                    <div className="mt-0.5 text-muted-foreground">
                      {[a.canCode ? "viết mã" : "", a.canReview ? "review" : "", a.canRunProdRead ? "đọc production" : ""].filter(Boolean).join(" · ") || "chỉ đọc hàng đợi"}
                    </div>
                    {/* Ba quyền chưa tồn tại máy thi hành. Nói thẳng thay vì để người đọc tưởng
                        chúng đang bị giữ lại vì một lý do tạm thời. */}
                    <div className="mt-0.5 text-[11px] text-muted-foreground">merge / deploy / ghi production: chưa xây (Phase 2–4)</div>
                  </TableCell>
                  <TableCell className="align-top text-xs">
                    <div>
                      {formatNumber(a.openTasks)} việc đang mở / {formatNumber(a.totalTasks)} tổng
                    </div>
                    <div className="text-muted-foreground">
                      {formatNumber(a.totalRuns)} lượt chạy
                      {a.failedRuns ? ` · ${formatNumber(a.failedRuns)} lỗi` : ""}
                    </div>
                    {/*
                      CHUỖI LƯỢT CHẠY SẠCH — tiêu chí mở nấc tiếp theo, thành một con số.

                      Trước 23/09/2026 "5 lượt chạy sạch liên tiếp" chỉ là một câu chú thích trong
                      mã; không ai đếm. "Sạch" là phán quyết của NGƯỜI review, không phải của cổng —
                      cổng bắt được thứ hỏng, không bắt được thứ sai. Lượt chờ review đếm RIÊNG,
                      không in thành 0 (mục 42).
                    */}
                    {(() => {
                      const c = chuoi.get(a.id);
                      if (!c) return null;
                      return (
                        <div className="mt-0.5" title={`Chuỗi ${DUNG_VI_LABEL[c.dungVi]}. Lượt sửa theo review không tính; lượt BLOCKED (agent khai không làm được) không cắt chuỗi.`}>
                          {/* KHÔNG tô màu khi chạm ngưỡng: bật vai QA là quyết định của chủ shop, và một ô
                              xanh là màn hình quyết hộ (AGENTS.md mục 38 — không ngưỡng nào đổi màu ô). */}
                          <span className="font-medium">
                            chuỗi sạch {formatNumber(c.chuoi)}/{NGUONG_MO_QA}
                          </span>
                          {c.choReview ? <span className="text-muted-foreground"> · {formatNumber(c.choReview)} chờ review</span> : null}
                        </div>
                      );
                    })()}
                    <div className="text-muted-foreground">
                      {/* CHƯA TỪNG chạy khác hẳn “chạy lúc 0 giờ”. */}
                      {a.lastRunAt ? `Gần nhất ${formatTimeAgo(a.lastRunAt)}` : "Chưa từng chạy"}
                    </div>
                  </TableCell>
                  <TableCell className="align-top text-xs">
                    <div className={cn("font-medium", a.enabled ? "" : "text-muted-foreground")}>{TECH_AGENT_STATUS_LABEL[a.status as TechAgentStatus] ?? a.status}</div>
                    <div className="text-muted-foreground">{a.lastSeenAt ? formatTimeAgo(a.lastSeenAt) : "Chưa thấy hoạt động nào"}</div>
                  </TableCell>
                  <TableCell className="text-right align-top">
                    {canManage ? (
                      <AgentEnableSwitch agentId={a.id} enabled={a.enabled} name={a.name} />
                    ) : (
                      <span className="text-xs text-muted-foreground">{a.enabled ? "Bật" : "Tắt"}</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </SectionCard>
      )}

      {thieu.length > 0 && agents.length > 0 ? (
        <SectionCard title="Vai còn thiếu so với bản khai" description="Bản khai trong mã nguồn có, sổ thì chưa">
          <p className="text-sm text-muted-foreground">{thieu.map((t) => TECH_AGENT_ROLE_LABEL[t.role]).join(" · ")}</p>
        </SectionCard>
      ) : null}

      {orphan > 0 ? (
        <SectionCard title="Lượt chạy mồ côi" description="Lượt chạy không còn gắn với agent nào trong sổ">
          <p className="text-sm">
            {formatNumber(orphan)} lượt chạy có dữ liệu nhưng agent đã bị xoá khỏi sổ. Chúng vẫn tra được ở lịch sử — đếm riêng để không lẫn với “chưa ai chạy”.
          </p>
        </SectionCard>
      ) : null}
    </div>
  );
}
