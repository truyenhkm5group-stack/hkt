import { PageHeader } from "@/components/page-header";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { can, requirePermission } from "@/lib/auth/session";
import { DEPT_PERF } from "@/lib/constants/department-performance";
import { DEPARTMENT_LABEL, DEPARTMENT_ORDER, type DepartmentCode } from "@/lib/constants/departments";
import { formatVND } from "@/lib/format";
import { departmentsOfUser } from "@/lib/queries/work";
import { combineScore, getPerformance, type ScoreAxis } from "@/lib/queries/work-performance";
import { getDeptPerformance, type MetricValue } from "@/lib/queries/dept-performance";
import { getScoreWeights, SCORE_AXIS_LABEL } from "@/lib/queries/work-config";
import { listOrgPeople } from "@/lib/queries/work";
import { param, resolvePeriod, type SearchParams } from "@/lib/search-params";
import { cn } from "@/lib/utils";

export const metadata = { title: "Hiệu suất" };

/**
 * ═══════ HIỆU SUẤT — SÁU TRỤC, KHÔNG MỘT CON SỐ ═══════
 *
 * Bảng này CỐ Ý không có cột "điểm". Yêu cầu nghiệp vụ nói thẳng: không làm một con số điểm nhân
 * viên dựa trên số việc. Nên mỗi trục đứng riêng, và mỗi trục mang theo MẪU SỐ của nó — một tỷ lệ
 * 100% trên 2 quan sát không giống 100% trên 200 quan sát, và người đọc phải thấy được điều đó.
 *
 * Cột "Năng suất" không bao giờ đứng một mình: nó luôn kèm độ khó trung bình. Mười ca khó không
 * được đọc thấp hơn một trăm ca tầm thường.
 */
function AxisCell({ axis, suffix = "%" }: { axis: ScoreAxis; suffix?: string }) {
  if (axis.value === null) {
    return (
      <span className="text-xs text-muted-foreground" title={axis.note || "Chưa có quan sát nào trong kỳ"}>
        chưa đo được
      </span>
    );
  }
  return (
    <span className="whitespace-nowrap tabular-nums" title={axis.note}>
      <span className={cn("font-medium", axis.value >= 90 ? "text-success" : axis.value < 60 ? "text-destructive" : "")}>
        {axis.value}
        {suffix}
      </span>
      <span className="ml-1 text-[11px] text-muted-foreground">/{axis.sample}</span>
    </span>
  );
}

export default async function PerformancePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const user = await requirePermission("performance:view");
  const raw = await searchParams;
  const period = resolvePeriod(raw, "30d");
  const mine = await departmentsOfUser(user.id);

  // Không có `work:all` thì chỉ xem được phòng của mình — thẻ điểm nhân sự là dữ liệu nhạy cảm.
  const crossDept = can(user, "work:all");
  const requested = param(raw, "dept") as DepartmentCode | "";
  const department: DepartmentCode | null = crossDept ? (requested || null) : (mine.find((d) => d.code === requested)?.code ?? mine[0]?.code ?? null);

  const from = period.from ?? new Date(Date.now() - 30 * 24 * 3_600_000);
  const to = period.to ?? new Date();
  const [rows, weights, orgPeople] = await Promise.all([getPerformance({ from, to, department }), getScoreWeights(), listOrgPeople()]);

  /*
    CHỈ SỐ RIÊNG CỦA PHÒNG chỉ tính khi ĐANG XEM MỘT PHÒNG. Ở góc nhìn toàn shop chúng vô nghĩa:
    "đóng ca care trong hạn" không nói gì về người kho, và xếp bảy phòng cạnh nhau trong một bảng
    thì mỗi cột rỗng năm phần sáu.
  */
  const deptPeople = department ? orgPeople.filter((p) => p.departments.some((d) => d.code === department)) : [];
  const deptPerf = department ? await getDeptPerformance({ department, from, to, people: deptPeople.map((p) => ({ id: p.id, name: p.name, email: p.email })) }) : null;

  // Điểm tổng CHỈ hiện khi chủ shop đã tự khai trọng số — xem `SCORE_WEIGHTS_KEY`.
  const hasWeights = Object.keys(weights).length > 0;

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Công việc"
        title="Hiệu suất"
        description={`${period.label} · ${department ? DEPARTMENT_LABEL[department] : "toàn shop"} · ${rows.length} người`}
        hint="KHÔNG có cột điểm tổng. Sáu trục đứng riêng vì chúng nói về sáu thứ khác nhau, và chỉ gộp lại được khi chủ shop tự khai trọng số. Mỗi ô kèm MẪU SỐ (/n) — 100% trên 2 quan sát không giống 100% trên 200. Trục Kết quả chỉ tính việc mà kết quả nằm trong tầm kiểm soát của người xử lý: ĐVVC giao hỏng không phải lỗi CSKH."
      />

      <SectionCard padded={false}>
        {rows.length ? (
          <div className="overflow-x-auto">
            <Table className="min-w-[1180px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Người</TableHead>
                  <TableHead className="w-[110px]">Kết quả</TableHead>
                  <TableHead className="w-[110px]">Chất lượng</TableHead>
                  <TableHead className="w-[110px]">Đúng hạn</TableHead>
                  <TableHead className="w-[170px]">Năng suất</TableHead>
                  <TableHead className="w-[130px]">Thời gian xử lý</TableHead>
                  <TableHead className="w-[110px]">OKR</TableHead>
                  <TableHead className="w-[130px]">Tiền cứu được</TableHead>
                  {hasWeights ? <TableHead className="w-[110px]">Điểm tổng</TableHead> : null}
                  <TableHead className="w-[150px] text-right">Đang cầm</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.key}>
                    <TableCell>
                      <p className="font-medium">{r.name}</p>
                      <p className="text-[11px] text-muted-foreground">{r.departments.map((d) => DEPARTMENT_LABEL[d]).join(", ") || "chưa xếp phòng"}</p>
                    </TableCell>
                    <TableCell><AxisCell axis={r.outcome} /></TableCell>
                    <TableCell><AxisCell axis={r.quality} /></TableCell>
                    <TableCell><AxisCell axis={r.sla} /></TableCell>
                    <TableCell>
                      <span className="tabular-nums">{r.productivity.closed} việc</span>
                      {/* ĐỘ KHÓ LUÔN ĐI CÙNG SỐ LƯỢNG — xem chú thích đầu tệp. */}
                      <span className="block text-[11px] text-muted-foreground">
                        {r.productivity.avgDifficulty === null ? "chưa đo được độ khó" : `độ khó TB ${r.productivity.avgDifficulty}`}
                        {r.productivity.avgMoney !== null ? ` · ${formatVND(r.productivity.avgMoney, { compact: true })}/việc` : ""}
                      </span>
                    </TableCell>
                    <TableCell>
                      {r.resolutionHours.median === null ? (
                        <span className="text-xs text-muted-foreground">chưa đo được</span>
                      ) : (
                        <>
                          <span className="tabular-nums">{r.resolutionHours.median} giờ</span>
                          {/* Trung vị đứng cạnh ca CHẬM NHẤT — một con số giữa không nói gì về đuôi. */}
                          <span className="block text-[11px] text-muted-foreground">chậm nhất {r.resolutionHours.slowest} giờ · {r.resolutionHours.sample} ca</span>
                        </>
                      )}
                    </TableCell>
                    <TableCell><AxisCell axis={r.okr} /></TableCell>
                    <TableCell>
                      {r.recovered.sample ? (
                        <>
                          <span className="tabular-nums">{formatVND(r.recovered.amount, { compact: true })}</span>
                          <span className="block text-[11px] text-muted-foreground">
                            {r.recovered.sample} ca đo được{r.recovered.unknown ? ` · ${r.recovered.unknown} ca chưa tra được` : ""}
                          </span>
                        </>
                      ) : (
                        <span className="text-xs text-muted-foreground" title="Chưa ca nào đóng trong kỳ có số tiền ĐO ĐƯỢC từ chứng từ">chưa đo được</span>
                      )}
                    </TableCell>
                    {hasWeights ? (
                      <TableCell>
                        {(() => {
                          const c = combineScore(r, weights);
                          if (c.score === null) return <span className="text-xs text-muted-foreground">chưa đo được</span>;
                          return (
                            <span className="whitespace-nowrap tabular-nums" title={`Gộp từ ${Object.entries(weights).map(([k, v]) => `${SCORE_AXIS_LABEL[k as keyof typeof SCORE_AXIS_LABEL]} ×${v}`).join(" · ")}`}>
                              <span className={cn("font-medium", c.score >= 90 ? "text-success" : c.score < 60 ? "text-destructive" : "")}>{c.score}</span>
                              {/* ĐỘ PHỦ luôn đi cùng điểm: gộp 2/4 trục rồi gọi là điểm tổng thì con số đó nói về 50% sự thật. */}
                              <span className="ml-1 text-[11px] text-muted-foreground">phủ {Math.round(c.coverage * 100)}%</span>
                            </span>
                          );
                        })()}
                      </TableCell>
                    ) : null}
                    <TableCell className="text-right">
                      <span className="tabular-nums">{r.openNow}</span>
                      {r.overdueNow ? <Badge variant="secondary" className="ml-1.5 bg-rose-100 text-[11px] text-rose-800 dark:bg-rose-950/60 dark:text-rose-300">{r.overdueNow} quá hạn</Badge> : null}
                      {r.blockedNow ? <Badge variant="outline" className="ml-1 text-[11px]">{r.blockedNow} chặn</Badge> : null}
                      {/*
                        VIỆC THUỘC PHÒNG KHÁC ĐƯỢC NÊU TÊN, KHÔNG BỊ GIẤU.
                        Nó không vào bất kỳ trục nào (luật "không trừ điểm vì thứ mình không quyết
                        được"), nhưng người đọc phải biết nó có tồn tại — nếu không, một người gánh
                        nhiều việc của phòng khác sẽ trông như đang rảnh.
                      */}
                      {r.outOfDepartment ? (
                        <span className="block text-[11px] text-muted-foreground" title="Việc đã đóng nhưng thuộc phòng khác — không tính vào các trục bên trái">
                          +{r.outOfDepartment} việc phòng khác
                        </span>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <EmptyState
            title="Chưa có đủ dữ liệu để nói về hiệu suất"
            description="Thẻ điểm đọc từ nhật ký công việc (ai đóng việc nào, lúc nào). Kỳ này chưa có ai đóng việc qua hàng đợi và không ai đang cầm việc nào."
            className="border-0"
          />
        )}
      </SectionCard>

      {deptPerf ? <DeptMetricCards perf={deptPerf} /> : null}

      {!hasWeights ? (
        <p className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          Bảng này CỐ Ý không có cột điểm tổng. Muốn có một con số duy nhất thì chủ shop phải tự khai trọng số cho từng trục ở{" "}
          <strong>Cấu hình → Trọng số điểm tổng</strong> — không có bộ mặc định nào, vì một bộ trọng số mặc định sẽ được đọc như thể nó có căn cứ.
        </p>
      ) : null}

      {/*
        MỖI PHÒNG ĐO BẰNG THỨ HỌ QUYẾT ĐƯỢC — VÀ NÓI THẲNG CÁI GÌ CHƯA ĐO ĐƯỢC.

        Phần "chưa đo được" cố ý nằm trên màn hình chứ không nằm trong một tệp tài liệu. Giấu nó đi
        thì bảng trông đầy đủ và không ai biết còn thiếu gì; bịa ra một con số thì tệ hơn nữa.
      */}
      <SectionCard
        title={department ? `${DEPARTMENT_LABEL[department]} được đánh giá bằng gì` : "Mỗi phòng được đánh giá bằng gì"}
        description="Chỉ số nằm trong tầm kiểm soát của phòng, và những chỉ số chủ shop muốn có mà ERP chưa đọc được ở độ mịn NGƯỜI."
      >
        <div className="space-y-4">
          {(department ? [department] : DEPARTMENT_ORDER).map((code) => {
            const spec = DEPT_PERF[code];
            return (
              <div key={code} className="space-y-1.5">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="text-sm font-medium">{DEPARTMENT_LABEL[code]}</span>
                  <span className="text-xs text-muted-foreground">{spec.focus}</span>
                </div>
                <p className="text-xs text-muted-foreground">
                  <strong className="text-foreground">Không tính cho họ:</strong> {spec.notAttributed}
                </p>
                <ul className="space-y-1 text-xs">
                  {spec.metrics.map((m) => (
                    <li key={m.label} className="flex flex-wrap items-baseline gap-1.5">
                      <Badge
                        variant="secondary"
                        className={cn("text-[10px]", m.availability === "MEASURED" ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300" : "bg-muted text-muted-foreground")}
                      >
                        {m.availability === "MEASURED" ? "đo được" : "chưa đo được"}
                      </Badge>
                      <span className="font-medium">{m.label}</span>
                      <span className="text-muted-foreground">— {m.note}</span>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      </SectionCard>

      <SectionCard title="Cách đọc bảng này" >
        <ul className="space-y-1.5 text-sm text-muted-foreground">
          <li><strong className="text-foreground">Kết quả</strong> — phần việc đã đóng mà kết quả THUỘC TRÁCH NHIỆM người xử lý. Care vận đơn không tính vào đây: bưu tá giao được hay không là chuyện của ĐVVC.</li>
          <li><strong className="text-foreground">Chất lượng</strong> — phần việc đóng rồi KHÔNG phải mở lại.</li>
          <li><strong className="text-foreground">Đúng hạn</strong> — chỉ tính việc CÓ ĐẶT HẠN. Việc không đặt hạn rơi khỏi cả tử lẫn mẫu.</li>
          <li><strong className="text-foreground">Năng suất</strong> — số việc đã đóng, LUÔN đọc cùng độ khó trung bình. Số lượng một mình không phải năng suất.</li>
          <li><strong className="text-foreground">Thời gian xử lý</strong> — TRUNG VỊ số giờ từ lúc việc xuất hiện tới lúc đóng. Trung vị chứ không trung bình: một ca để quên ba tuần sẽ kéo trung bình lên và che mất phần lớn ca xử lý trong vài giờ. Ca chậm nhất đứng ngay cạnh vì một con số giữa không nói gì về đuôi.</li>
          <li><strong className="text-foreground">OKR</strong> — tiến độ Key Result cá nhân, chỉ tính KR đo được.</li>
          <li><strong className="text-foreground">Tiền cứu được</strong> — tiền lấy lại được nhờ việc đã đóng, CHỈ cộng phần đo được từ chứng từ. Nó phụ thuộc giá trị đơn chứ không phụ thuộc người xử lý, nên nó không bao giờ được gộp vào một điểm nào.</li>
          <li><strong className="text-foreground">&ldquo;+n việc phòng khác&rdquo;</strong> — việc người này đã đóng nhưng thuộc phòng khác. Không vào trục nào, vì không ai bị chấm điểm bằng kết quả của phòng khác — nhưng vẫn hiện để người gánh việc hộ không trông như đang rảnh.</li>
          <li><strong className="text-foreground">&ldquo;chưa đo được&rdquo;</strong> — chưa có quan sát nào, KHÔNG phải điểm 0.</li>
        </ul>
      </SectionCard>
    </div>
  );
}

/**
 * ═══════ CHỈ SỐ RIÊNG CỦA PHÒNG — ĐỌC THẲNG TỪ CHỨNG TỪ ═══════
 *
 * Mỗi ô mang theo MẪU SỐ và CĂN CỨ. Ô có cờ "kết quả chung" là ô mà bên ngoài đồng quyết định
 * (ĐVVC giao được hay không, hàng có hỏng trên đường về không) — đọc làm bối cảnh, không phải
 * điểm chấm người. Đó là luật "không phạt nhân viên vì thứ họ không quyết được", thực thi ngay
 * trên nhãn chứ không chỉ trong tài liệu.
 */
function MetricCell({ m }: { m: MetricValue }) {
  if (m.value === null) {
    return (
      <span className="text-xs text-muted-foreground" title={m.basis}>
        chưa đo được
      </span>
    );
  }
  const text =
    m.unit === "PERCENT" ? `${m.value}%` : m.unit === "VND" ? formatVND(m.value, { compact: true }) : m.unit === "DAYS" ? `${m.value} ngày` : m.unit === "HOURS" ? `${m.value} giờ` : String(m.value);
  return (
    <span className="whitespace-nowrap tabular-nums" title={m.basis}>
      <span className={cn("font-medium", m.unit === "PERCENT" && !m.shared ? (m.value >= 90 ? "text-success" : m.value < 60 ? "text-destructive" : "") : "")}>{text}</span>
      <span className="ml-1 text-[11px] text-muted-foreground">/{m.sample}</span>
    </span>
  );
}

function DeptMetricCards({ perf }: { perf: Awaited<ReturnType<typeof getDeptPerformance>> }) {
  const keys: { key: string; label: string; shared: boolean }[] = [];
  for (const p of perf.people) for (const m of p.metrics) if (!keys.some((k) => k.key === m.key)) keys.push({ key: m.key, label: m.label, shared: m.shared });

  return (
    <>
      {perf.team.length ? (
        <SectionCard title={`${perf.label} · chỉ số mức phòng`} description="Đo được ở mức SỔ, không quy về cá nhân — một dòng tiền có thể do nhiều người chạm.">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {perf.team.map((m) => (
              <div key={m.key} className="rounded-lg border p-3">
                <p className="text-xs text-muted-foreground">{m.label}</p>
                <p className="mt-0.5 text-lg font-semibold">
                  <MetricCell m={m} />
                </p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">{m.basis}</p>
              </div>
            ))}
          </div>
        </SectionCard>
      ) : null}

      <SectionCard
        title={`${perf.label} · chỉ số riêng của phòng`}
        description="Đọc thẳng từ bảng nghiệp vụ của phòng (case CSKH, nhật ký care, phiếu kiểm hoàn, nhật ký đối soát) — không phải số việc đã đóng."
        padded={false}
      >
        {keys.length ? (
          <div className="overflow-x-auto">
            <Table className="min-w-[720px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Người</TableHead>
                  {keys.map((k) => (
                    <TableHead key={k.key} className="w-[150px]">
                      {k.label}
                      {k.shared ? <span className="block text-[10px] font-normal text-muted-foreground">kết quả chung</span> : null}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {perf.people.map((p) => (
                  <TableRow key={p.userId}>
                    <TableCell className="font-medium">{p.name}</TableCell>
                    {keys.map((k) => {
                      const m = p.metrics.find((x) => x.key === k.key);
                      return <TableCell key={k.key}>{m ? <MetricCell m={m} /> : <span className="text-xs text-muted-foreground">chưa có ca nào</span>}</TableCell>;
                    })}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <EmptyState
            title="Chưa ai trong phòng có ca nào trong kỳ"
            description="Chỉ số của phòng đọc từ chứng từ thật (case đã đóng, ca care đã kết, phiếu kiểm hoàn, lượt đối soát). Kỳ này chưa có bản ghi nào mang tên người trong phòng."
            className="border-0"
          />
        )}
        {perf.missing.length ? (
          <div className="border-t p-3">
            <p className="text-xs font-medium">Chỉ số chưa đo được ở độ mịn NGƯỜI</p>
            <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
              {perf.missing.map((m) => (
                <li key={m.label}>
                  <strong className="text-foreground">{m.label}</strong> — {m.note}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </SectionCard>
    </>
  );
}
