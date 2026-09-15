import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { StatStrip } from "@/components/stat-tile";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SectionCard } from "@/components/ui-bits";
import { DepartmentsPanel, RecurrencePanel } from "@/app/(dashboard)/work/settings/panels";
import { PeoplePanel } from "@/app/(dashboard)/work/settings/people-panel";
import { WorkRulesPanel, type RuleRow } from "@/app/(dashboard)/work/settings/rules-panel";
import { StaffingPanel, type StaffRow } from "@/app/(dashboard)/work/settings/staffing-panel";
import { WeightsPanel } from "@/app/(dashboard)/work/settings/weights-panel";
import { TargetsPanel } from "@/app/(dashboard)/work/settings/targets-panel";
import { ReasonGroupsPanel } from "@/app/(dashboard)/work/settings/reason-groups-panel";
import { LogisticsRulesPanel, type DwellRow } from "@/app/(dashboard)/work/settings/logistics-panel";
import { DWELL_SLA, thresholdOf } from "@/lib/constants/shipment-status-age";
import { SHIPMENT_STAGE_LABEL } from "@/lib/constants/viettelpost";
import { getDwellOverrides, getShipmentStatusAgeQueue } from "@/lib/queries/shipment-status-age";
import { getDuplicateRule } from "@/lib/queries/order-duplicate";
import type { ShipmentStage } from "@/db/schema";
import { listTargetsForAdmin } from "@/lib/queries/metric-targets";
import { listProductCodes } from "@/lib/queries/product-code";
import { getReasonGroupOverrides } from "@/lib/queries/return-reason-config";
import { getPersonAttributionCoverage, keyedShare } from "@/lib/queries/attribution-coverage";
import { requirePermission } from "@/lib/auth/session";
import { getDb, schema } from "@/db";
import { DEFAULT_OWNERSHIP_MAP } from "@/lib/constants/work-ownership";
import { effectiveSlaRules } from "@/lib/constants/work-sla";
import { assignableMembers, listDepartmentMembers, listDepartments, listOrgPeople } from "@/lib/queries/work";
import { getScoreWeights, getWorkConfig } from "@/lib/queries/work-config";
import { getReadiness } from "@/lib/queries/work-readiness";
import { membershipDrift } from "@/lib/org/membership";
import { collectWorkItems } from "@/lib/queries/work-adapters";
import { buildCapacity, getStaffing } from "@/lib/queries/workforce";
import { DEFAULT_WIP_LIMIT } from "@/lib/constants/workforce";
import { WORK_SOURCES } from "@/lib/constants/work-sources";
import { formatVND } from "@/lib/format";
import { cn } from "@/lib/utils";
import { asc, eq } from "drizzle-orm";

export const metadata = { title: "Cấu hình công việc" };

/**
 * Cấu hình tổ chức, luật việc và việc định kỳ. Đặt trong tab cuối của `/work` thay vì một mục
 * sidebar riêng: đây là màn hình mở vài lần một quý, không phải màn hình làm việc hằng ngày.
 *
 * Thứ tự các thẻ là thứ tự phải làm trước ngày đầu tiên nhân viên dùng `/work`:
 * người → phòng ban → luật việc (ai làm, trong bao lâu) → việc định kỳ.
 */
export default async function WorkSettingsPage() {
  await requirePermission("work:admin");
  const db = await getDb();
  const now = new Date();
  const [departments, members, people, cfg, readiness, staffing, queue, weights, recurrences] = await Promise.all([
    listDepartments(true),
    assignableMembers(),
    listOrgPeople(),
    getWorkConfig(),
    getReadiness(now),
    getStaffing(),
    collectWorkItems({ now }),
    getScoreWeights(),
    db.select().from(schema.workRecurrences).orderBy(asc(schema.workRecurrences.title)),
  ]);
  const [targets, positions, coverage, maHang, nhomLyDo] = await Promise.all([
    listTargetsForAdmin(),
    db.select({ id: schema.positions.id, name: schema.positions.name }).from(schema.positions).where(eq(schema.positions.active, true)).orderBy(asc(schema.positions.sortOrder)),
    getPersonAttributionCoverage(),
    // Mã hàng để đặt đích RIÊNG cho một mã. Danh mục thật, không ô gõ tự do: gõ nhầm một mã không
    // tồn tại thì dòng đích nằm im và màn hình vẫn nói "chưa đặt mục tiêu" mà không báo lỗi.
    listProductCodes(),
    getReasonGroupOverrides(),
  ]);

  /*
    LUẬT GIAO VẬN: ngưỡng đang hiệu lực + DÂN SỐ THẬT của từng chặng.

    Con số "đang chạy" đọc từ chính hàng đợi mà `/operations/dwell` dùng (đệm 60 giây), nên bảng
    cấu hình và màn hình vận hành không thể nói hai con số khác nhau.
  */
  const [dwellOv, dwellQueue, dupRule] = await Promise.all([getDwellOverrides(), getShipmentStatusAgeQueue(), getDuplicateRule()]);
  const danSo = new Map<string, number>();
  for (const r of dwellQueue.rows) danSo.set(r.stage, (danSo.get(r.stage) ?? 0) + 1);
  const dwellRows: DwellRow[] = (Object.keys(DWELL_SLA) as ShipmentStage[])
    // Chặng KẾT THÚC và `UNKNOWN` cố ý không đặt hạn — bày ô nhập cho chúng là mời người ta đặt
    // một cái hạn cho việc đã xong. Lý do đầy đủ ở lib/constants/shipment-status-age.ts.
    .filter((st) => DWELL_SLA[st] !== null)
    .map((st) => {
      const hieuLuc = thresholdOf(st, dwellOv);
      const macDinh = DWELL_SLA[st];
      return {
        stage: st,
        stageLabel: SHIPMENT_STAGE_LABEL[st],
        why: macDinh?.why ?? "",
        watch: hieuLuc?.watch ?? null,
        warning: hieuLuc?.warning ?? null,
        exception: hieuLuc?.exception ?? null,
        overridden: Object.hasOwn(dwellOv, st),
        defaultWatch: macDinh?.watch ?? null,
        defaultWarning: macDinh?.warning ?? null,
        defaultException: macDinh?.exception ?? null,
        live: danSo.get(st) ?? 0,
      };
    });
  // BÁO CÁO LỆCH — chạy thử, không sửa gì. Cố ý không có nút "sửa hàng loạt": xem `membershipDrift`.
  const drift = await membershipDrift();
  const openItems = queue.items.filter((i) => i.status !== "DONE" && i.status !== "CANCELLED");
  const capacity = buildCapacity(people, openItems, staffing, now);
  const staffRows: StaffRow[] = capacity.map((c) => ({
    userId: c.userId,
    name: c.name,
    email: c.email,
    departments: c.departments,
    load: c.load,
    limit: c.limit,
    limitIsOwn: typeof staffing.userWip[c.userId] === "number",
    skills: c.skills,
    away: c.away,
  }));
  const membersByDept = await Promise.all(departments.map(async (d) => ({ id: d.id, members: await listDepartmentMembers(d.id) })));

  /*
    GHÉP HAI BẢNG LUẬT THÀNH MỘT LƯỚI. Khoá của chúng cố ý trùng nhau (`<nguồn>` hoặc
    `<nguồn>:<loại>`) nên phép ghép này là tra bản đồ, không phải đoán. Dòng nào không có luật
    phòng ban (việc tay, việc định kỳ) thì cột đó hiện "theo người giao" chứ không hiện ô chọn giả.
  */
  const rules: RuleRow[] = effectiveSlaRules(cfg.sla).map((r) => {
    const own = DEFAULT_OWNERSHIP_MAP[r.key];
    const ovDept = cfg.ownership[r.key];
    return {
      key: r.key,
      label: r.label,
      why: r.why,
      alsoShownOn: r.alsoShownOn,
      hours: r.hours,
      defaultHours: r.defaultHours,
      hoursOverridden: r.overridden,
      department: own ? (ovDept ?? own.department) : null,
      defaultDepartment: own?.department ?? null,
      departmentOverridden: Boolean(own && ovDept),
    };
  });

  const chuaCoPhong = people.filter((p) => p.departments.length === 0).length;
  const chuaCoTruong = departments.filter((d) => d.active && !d.leadUserId).length;

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Công việc"
        title="Cấu hình"
        description={
          chuaCoPhong || chuaCoTruong
            ? `Còn ${chuaCoPhong} người chưa có phòng ban · ${chuaCoTruong} phòng chưa có trưởng phòng.`
            : "Mọi người đã có phòng ban và mọi phòng đã có trưởng phòng."
        }
        hint="Phòng ban quyết định việc nào hiện ở hàng đợi của ai. Một người có thể ở nhiều phòng — ở shop nhỏ chuyện đó là bình thường. Xoá thành viên chỉ NGỪNG HOẠT ĐỘNG chứ không xoá dòng, vì lịch sử “ai từng ở phòng nào” là căn cứ của báo cáo kỳ đã chốt."
      />

      {/*
        ═══════ MỨC SẴN SÀNG VẬN HÀNH ═══════

        Đặt Ở ĐẦU màn hình cấu hình chứ không dựng một trang riêng: đây vừa là số đo vừa là DANH
        SÁCH VIỆC PHẢI LÀM, và mọi nút để làm những việc đó đều nằm ngay dưới nó. Một trang báo cáo
        riêng sẽ nói "còn 3 phòng chưa có trưởng" rồi để người đọc tự đi tìm chỗ sửa.
      */}
      <SectionCard
        title="Mức sẵn sàng vận hành"
        description="Ngày mai nhân viên mở “Việc của tôi” lên thì nó có dùng được không — và còn thiếu đúng cái gì."
        hint="Độ phủ hạn xử lý là con số dễ bị bỏ qua nhất: nếu chỉ 30% việc có hạn thì con số “quá hạn” bên cạnh đang nói về 30% đó, và trưởng phòng đang lái bằng một đồng hồ chỉ đo một phần. Nguồn nào không đọc được sẽ được nêu tên, số của nó KHÔNG bị coi là 0."
      >
        <div className="space-y-4">
          <StatStrip
            columns={5}
            items={[
              { label: "Việc đang mở", value: readiness.total, note: "mọi nguồn cộng lại" },
              { label: "Chưa ai nhận", value: readiness.unassigned, tone: readiness.unassigned ? "amber" : "muted", note: "đang nằm ở hàng đợi phòng" },
              { label: "Quá hạn", value: readiness.overdue, tone: readiness.overdue ? "rose" : "muted" },
              {
                label: "Có đặt hạn",
                value: readiness.slaCoverage.rate === null ? "—" : `${Math.round(readiness.slaCoverage.rate * 100)}%`,
                tone: readiness.slaCoverage.rate !== null && readiness.slaCoverage.rate < 0.6 ? "amber" : "muted",
                note: `${readiness.slaCoverage.withoutSla} việc không đặt hạn`,
              },
              {
                label: "Tiền đang treo",
                value: readiness.money.known ? formatVND(readiness.money.atRisk, { compact: true }) : "—",
                note: readiness.money.unknown ? `${readiness.money.unknown} việc chưa tra được` : "đã tra được hết",
              },
            ]}
          />

          {readiness.failedSources.length ? (
            <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
              Chưa đọc được: {readiness.failedSources.map((f) => `${f.source} (${f.error})`).join(" · ")}. Số của các nguồn này KHÔNG được coi là 0 — con số ở trên đang thiếu phần đó.
            </p>
          ) : null}

          <div className="overflow-x-auto">
            <Table className="min-w-[760px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Nguồn việc</TableHead>
                  <TableHead className="w-[90px] text-right">Đang mở</TableHead>
                  <TableHead className="w-[90px] text-right">Quá hạn</TableHead>
                  <TableHead className="w-[110px] text-right">Chưa ai nhận</TableHead>
                  <TableHead className="w-[100px] text-right">Có hạn</TableHead>
                  <TableHead className="w-[260px]">Còn thiếu</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {readiness.sources.map((s) => (
                  <TableRow key={s.source}>
                    <TableCell className="font-medium">{s.label}</TableCell>
                    <TableCell className="text-right tabular-nums">{s.count}</TableCell>
                    <TableCell className={cn("text-right tabular-nums", s.overdue && "font-semibold text-destructive")}>{s.overdue}</TableCell>
                    <TableCell className="text-right tabular-nums">{s.unassigned}</TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">{s.count ? `${s.withSla}/${s.count}` : "—"}</TableCell>
                    <TableCell className="text-xs">
                      {s.gap ? (
                        <span className="flex items-start gap-1 text-amber-700 dark:text-amber-400">
                          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                          {s.gap}
                        </span>
                      ) : (
                        <span className="flex items-center gap-1 text-muted-foreground">
                          <CheckCircle2 className="size-3.5 shrink-0 text-emerald-600" /> đủ luật và có nút xử lý tại chỗ
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            {(
              [
                ["Người chưa có phòng ban", readiness.gaps.peopleWithoutDepartment],
                ["Phòng chưa có trưởng phòng", readiness.gaps.departmentsWithoutLead],
                ["Phòng chưa có thành viên nào", readiness.gaps.departmentsWithoutMember],
                ["Nguồn chưa có luật hạn xử lý", readiness.gaps.sourcesWithoutSla],
                ["Nguồn chưa có luật phòng ban", readiness.gaps.sourcesWithoutOwner],
                ["Loại cảnh báo chưa có hạn", readiness.gaps.alertTypesWithoutSla],
                ["Loại cảnh báo chưa có phòng", readiness.gaps.alertTypesWithoutOwner],
                ["Nguồn phải mở sang màn hình gốc mới xử lý xong", readiness.gaps.sourcesWithoutRealAction],
              ] as const
            ).map(([label, list]) => (
              <div key={label} className="rounded-lg border p-2.5 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{label}</span>
                  <Badge variant="secondary" className={cn("text-[10px]", list.length ? "bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300" : "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300")}>
                    {list.length || "không còn"}
                  </Badge>
                </div>
                {list.length ? <p className="mt-1 text-muted-foreground">{list.join(" · ")}</p> : null}
              </div>
            ))}
          </div>

          <p className="text-xs text-muted-foreground">
            Chủ shop đã sửa <strong>{readiness.overrides.sla}</strong> luật hạn xử lý và <strong>{readiness.overrides.ownership}</strong> luật phòng ban khỏi mặc định.
            Số 0 không phải lỗi — nó nghĩa là mọi thứ đang chạy bằng con số mặc định lấy từ chính các module nghiệp vụ.
          </p>
        </div>
      </SectionCard>

      {drift.length ? (
        <SectionCard
          title={`Dữ liệu tổ chức đang lệch · ${drift.length} dòng`}
          description="Báo cáo CHẠY THỬ — ERP không tự sửa gì. Mỗi dòng nói lệch cái gì và cách sửa; sửa bằng chính các nút bên dưới, mỗi lượt một dòng nhật ký."
          hint="Không có nút “sửa hàng loạt”, và đó là quyết định: ba trong năm loại lệch có hơn một cách sửa đúng (bỏ ghế trưởng phòng hay thêm lại người đó làm thành viên? tuỳ việc chủ shop định làm). Một lượt sửa hàng loạt trên dữ liệu tổ chức là thứ không gỡ lại được."
        >
          <ul className="space-y-1.5 text-sm">
            {drift.map((d, i) => (
              <li key={`${d.kind}-${d.departmentId}-${d.userId}-${i}`} className="flex flex-wrap items-baseline gap-1.5">
                <Badge variant="secondary" className="bg-amber-50 text-[10px] text-amber-700 dark:bg-amber-950/60 dark:text-amber-300">
                  {d.label}
                </Badge>
                <span className="font-medium">{d.userName}</span>
                <span className="text-muted-foreground">· {d.department} —</span>
                <span className="text-xs text-muted-foreground">{d.fix}</span>
              </li>
            ))}
          </ul>
        </SectionCard>
      ) : null}

      <SectionCard
        title="Nhân sự và phòng ban"
        description="Mỗi người phải thuộc ít nhất một phòng thì hàng đợi của họ mới có việc."
        hint="ERP KHÔNG tự đoán phòng ban từ vai trò phân quyền. Vai trò nói người đó được xem gì; phòng ban nói họ làm việc gì. Hai người cùng vai “Quản lý” có thể phụ trách hai mảng chẳng liên quan, nên máy chỉ gợi ý bằng chữ và để người quyết."
        padded={false}
      >
        <PeoplePanel
          people={people.map((p) => ({ ...p, departments: p.departments.map((d) => ({ ...d, roleInDept: d.roleInDept as "LEAD" | "MEMBER" })) }))}
          departments={departments.map((d) => ({ id: d.id, code: d.code, name: d.name, leadUserId: d.leadUserId, active: d.active }))}
        />
      </SectionCard>

      <SectionCard
        title="Sức chứa và phân việc"
        description="Một người cầm được bao nhiêu việc, ai làm loại việc gì, ai đang nghỉ — ba thứ máy phân việc cần mà CSDL nghiệp vụ không biết."
        hint={`Trần mặc định ${DEFAULT_WIP_LIMIT} việc là một con số KHAI BÁO, không phải số đo: hàng đợi chưa chạy đủ lâu để đo được. Nó tồn tại để khi hết chỗ thì máy phân việc DỪNG và báo thiếu người, thay vì nhồi cho hết. Phân việc tự động mặc định TẮT ở mọi phòng — nút bấm tay luôn dùng được và luôn cho xem trước. Leo thang SLA mặc định BẬT vì nó chỉ đổi thứ tự đọc, không đổi chủ của việc nào.`}
        padded={false}
      >
        <StaffingPanel
          rows={staffRows}
          departmentWip={staffing.departmentWip}
          autoAssign={staffing.autoAssign}
          escalationOff={staffing.escalationOff}
          sources={[...WORK_SOURCES]}
        />
      </SectionCard>

      <SectionCard
        title="Luật việc · ai làm và trong bao lâu"
        description="Hạn xử lý và phòng chịu trách nhiệm của từng loại việc. Sửa ở đây có hiệu lực ngay, không cần deploy."
        hint="Con số mặc định được lấy lại từ chính hằng số mà các module đang chạy (hàng đợi cần xử lý, care vận đơn, nút thắt kho), không gõ lại — nên khi chưa ai sửa thì mọi báo cáo giữ nguyên số cũ. Bỏ trống ô hạn nghĩa là CỐ Ý không đặt hạn: loại việc đó không sinh ra “quá hạn”, khác hẳn với 0 giờ."
        padded={false}
      >
        <WorkRulesPanel rows={rules} />
      </SectionCard>

      <SectionCard
        title="Luật giao vận · kiện đứng yên bao lâu thì báo"
        description="Ngưỡng tuổi CHẶNG của vận đơn, và cửa sổ dò đơn trùng. Sửa ở đây có hiệu lực ngay, không cần deploy."
        hint="Tuổi chặng KHÁC “ĐVVC im lặng”: im lặng hỏi ERP có biết kiện ở đâu không, tuổi chặng hỏi kiện có đi tới đâu không — một kiện nhận tin mỗi giờ vẫn có thể đứng yên. Cột “Đang chạy” là số kiện thật đang ở chặng đó ngay lúc mở trang: sửa một ngưỡng mà không nhìn dân số của nó là sửa mù. Cấu hình hỏng KHÔNG làm sập bộ phát hiện — chặng đó rơi về mặc định của mã."
        padded={false}
      >
        <LogisticsRulesPanel rows={dwellRows} duplicate={dupRule} />
      </SectionCard>

      <SectionCard
        title="Trọng số điểm tổng"
        description="Bốn ô, tất cả bắt đầu rỗng. Rỗng hết = màn hình Hiệu suất KHÔNG có cột điểm tổng — và đó là trạng thái mặc định lâu dài."
        hint="Sáu trục của thẻ điểm nói về sáu thứ khác nhau. Gộp chúng thành một số chỉ có nghĩa khi có người CHỊU TRÁCH NHIỆM chọn tỉ lệ. Ghi sẵn một bộ mặc định là lén quyết định thay chủ shop, rồi ba tháng sau không ai nhớ ai chọn các con số đó."
      >
        <WeightsPanel weights={weights} />
      </SectionCard>

      <SectionCard
        id="muc-tieu-chi-so"
        title="Mục tiêu chỉ số"
        description="Công ty → phòng ban → chức danh, và MÃ HÀNG cho chỉ số đọc được ở mức mã. Tầng hẹp hơn đè tầng rộng hơn."
        hint="Bảng này bắt đầu rỗng và ở rỗng cho tới khi chủ shop tự điền — ERP KHÔNG đặt sẵn con số nào. Chưa có mục tiêu thì màn hình Hiệu suất và bảng Rủi ro theo mã hàng vẫn hiện số thực tế và vẫn xếp hạng, chỉ là không kết luận đạt hay không đạt; một con số không có mục tiêu vẫn đọc được, còn bịa ra mục tiêu để có màu xanh đỏ thì không."
      >
        <TargetsPanel rows={targets} positions={positions} productCodes={maHang.map((p) => ({ code: p.code, name: p.name }))} />
      </SectionCard>

      <SectionCard
        id="nhom-ly-do-hoan"
        title="Cách xếp nhóm lý do hoàn"
        description="Lý do chi tiết là QUAN SÁT (không bao giờ sửa). Nhóm là CÁCH NHÌN — đổi ở đây, báo cáo xếp lại lúc đọc."
        hint="Đổi một dòng ở đây KHÔNG chạy UPDATE lên một dòng lịch sử nào: mỗi ca hoàn giữ nguyên lý do chi tiết và CHỮ GỐC nguyên văn của ĐVVC, còn nhóm được suy lúc đọc. Nhờ vậy xếp lại nhóm vẫn tra ngược được về chứng từ. Hai dòng “Chưa xác định được” và “Lý do khác” bị KHOÁ: chúng là chỗ TRỐNG, kéo sang một nhóm quy lỗi là biến số ca chưa ai hỏi thành một lời buộc tội."
      >
        <ReasonGroupsPanel overrides={nhomLyDo} />
      </SectionCard>

      <SectionCard
        title="Quy kết được bao nhiêu phần công việc"
        description="Thẻ điểm chỉ đáng tin bằng phần dữ liệu nối được về đúng một tài khoản. Bảng này ĐẾM trên chính dữ liệu, không đọc một bản khai."
        hint="“Là máy” tách riêng khỏi “chưa ai nhận”: việc đã được chạm, chỉ là chạm bởi một job chứ không phải người. Gộp hai cột đó lại thì báo cáo nói có người đang làm trong khi con số thật là không ai."
        padded={false}
      >
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Miền</TableHead>
                <TableHead className="text-right">Tổng</TableHead>
                <TableHead className="text-right">Có khoá</TableHead>
                <TableHead className="text-right">Chỉ có chữ</TableHead>
                <TableHead className="text-right">Là máy</TableHead>
                <TableHead className="text-right">Chưa ai</TableHead>
                <TableHead className="text-right">Quy kết được</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {coverage.map((c) => {
                const phan = keyedShare(c);
                return (
                  <TableRow key={c.key}>
                    <TableCell className="text-sm">
                      <div className="font-medium">{c.label}</div>
                      <div className="text-[11px] text-muted-foreground" title={c.meaning}>{c.source}</div>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{c.total}</TableCell>
                    <TableCell className="text-right tabular-nums font-medium">{c.withKey}</TableCell>
                    <TableCell className={cn("text-right tabular-nums", c.textOnly > 0 && "text-amber-600 dark:text-amber-400")}>{c.textOnly}</TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">{c.machine || "—"}</TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">{c.unassigned}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {/* 0/0 KHÔNG phải 0% — chưa có dòng nào thì chưa biết, không phải quy kết kém. */}
                      {phan === null ? <span className="text-xs text-muted-foreground">chưa có dòng nào</span> : <span className={cn("font-medium", phan >= 100 ? "text-success" : phan < 60 ? "text-destructive" : "")}>{phan}%</span>}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </SectionCard>

      <SectionCard title="Phòng ban" description="Thêm phòng, đổi trưởng phòng, ngừng dùng một phòng." padded={false}>
        <DepartmentsPanel
          departments={departments.map((d) => ({ ...d, members: membersByDept.find((m) => m.id === d.id)?.members ?? [] }))}
          people={members.map((m) => ({ id: m.id, name: m.name }))}
        />
      </SectionCard>

      <SectionCard
        title="Việc định kỳ"
        description="Đối soát hằng ngày, review quảng cáo, kiểm kê, chốt công — việc lặp theo lịch, sinh tự động."
        hint="Bốn nhịp cố định thay cho ô nhập cron: một chuỗi cron gõ sai sẽ im lặng không sinh việc nào và không ai phát hiện. Việc hằng tháng chỉ chọn được ngày 1–28 vì ngày 29–31 không tồn tại ở mọi tháng."
        padded={false}
      >
        <RecurrencePanel
          rows={recurrences.map((r) => ({
            id: r.id,
            title: r.title,
            cadence: r.cadence,
            cadenceDay: r.cadenceDay,
            hourOfDay: r.hourOfDay,
            dueInHours: r.dueInHours,
            active: r.active,
            departmentId: r.departmentId,
            assigneeId: r.assigneeId,
            lastGeneratedKey: r.lastGeneratedKey,
          }))}
          departments={departments.map((d) => ({ id: d.id, code: d.code, name: d.name }))}
          people={members.map((m) => ({ id: m.id, name: m.name }))}
        />
      </SectionCard>
    </div>
  );
}
