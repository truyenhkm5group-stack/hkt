"use client";

import { useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { WORKFLOW_CADENCE_DEFAULT_MINUTES } from "@/lib/constants/workflow-cadence";
import { confirmPilotUatAction, disableOrgConnectionAction, setOrgBrandAction, setOrgPlanAction, setOrgSuspendedAction, setPilotStageAction, setWorkflowsPausedAction } from "@/lib/actions/platform-ops";
import { PILOT_OVERRIDE_MIN_REASON, PILOT_REASON_MIN, PILOT_STAGE_LABEL, PILOT_STAGES, type PilotStage } from "@/lib/constants/pilot";

/**
 * Nút của «Vòng đời pilot» và «Công tắc khẩn» ở `/platform/org/<mã>`. Mọi nút GHI: ô lý do → hộp xác nhận in NGUYÊN VĂN
 * hệ quả → server action (kiểm lại người vận hành, lý do, ghi nhật ký nền tảng). Không có nút nào ghi mà không qua hộp.
 */

export type Outcome = { ok: true; message?: string } | { error: string };

export function ConfirmWithReason(props: {
  id: string;
  label: string;
  title: string;
  consequence: string;
  minReason: number;
  placeholder: string;
  variant?: "default" | "destructive" | "outline";
  disabled?: boolean;
  children?: React.ReactNode;
  run: (reason: string) => Promise<Outcome>;
}) {
  const [reason, setReason] = useState("");
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const ready = reason.trim().length >= props.minReason;

  const apply = () =>
    start(async () => {
      setError(null);
      const r = await props.run(reason);
      setOpen(false);
      if ("error" in r) {
        setError(r.error);
        return;
      }
      setReason("");
      toast.success(r.message ?? "Đã ghi");
    });

  return (
    <div className="space-y-1.5">
      <div className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
        <div className="space-y-1">
          <Label htmlFor={props.id}>{props.minReason > 0 ? `Lý do (ít nhất ${props.minReason} ký tự — vào nhật ký nền tảng)` : "Ghi chú (không bắt buộc — vào nhật ký nền tảng)"}</Label>
          <Input id={props.id} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={props.placeholder} maxLength={500} disabled={props.disabled || pending} />
        </div>
        <Button type="button" variant={props.variant ?? "outline"} disabled={props.disabled || pending || !ready} onClick={() => setOpen(true)}>
          {pending ? <Loader2 className="size-4 animate-spin" /> : null}
          {props.label}
        </Button>
      </div>
      {props.children}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <AlertDialog open={open} onOpenChange={(o) => !pending && setOpen(o)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{props.title}</AlertDialogTitle>
            <AlertDialogDescription>{props.consequence}</AlertDialogDescription>
          </AlertDialogHeader>
          <p className="text-xs text-muted-foreground">Lý do: {reason.trim()}</p>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Huỷ</AlertDialogCancel>
            <AlertDialogAction
              disabled={pending}
              onClick={(e) => {
                e.preventDefault();
                apply();
              }}
            >
              {pending ? "Đang ghi…" : "Xác nhận"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

const toOutcome = (r: { ok: true; message?: string } | { ok: true; changed: boolean; stage: unknown } | { error: string }, fallback: string): Outcome =>
  "error" in r ? r : { ok: true, message: "message" in r && r.message ? r.message : fallback };

// ═══ Công tắc khẩn ═══

/** Đổi gói của tổ chức (sau lúc tạo). Danh sách gói do trang truyền vào — đã bỏ gói nội bộ. */
export function OrgPlanControl({ orgCode, orgName, current, plans }: { orgCode: string; orgName: string; current: string; plans: { key: string; name: string }[] }) {
  const [planKey, setPlanKey] = useState(current);
  const target = plans.find((x) => x.key === planKey);
  return (
    <ConfirmWithReason
      id={`plan-${orgCode}`}
      label="Đổi gói…"
      title={`Chuyển «${orgName}» sang gói ${target?.name ?? planKey}?`}
      consequence="Hạn mức của gói mới (người dùng, trang, luật, dung lượng, AI) áp cho lượt TẠO kế tiếp. Hạ gói không xoá dữ liệu nào: phần đang vượt trần giữ nguyên, chỉ không tạo thêm được. Ghi vào nhật ký nền tảng."
      minReason={PILOT_REASON_MIN}
      placeholder="Khách chốt UAT, cần thêm người dùng"
      disabled={planKey === current}
      run={async (reason) => toOutcome(await setOrgPlanAction({ orgCode, planKey, reason }), "Đã đổi gói")}
    >
      <div className="flex items-center gap-2 text-xs">
        <Label htmlFor={`plan-select-${orgCode}`}>Gói mới</Label>
        <select id={`plan-select-${orgCode}`} value={planKey} onChange={(e) => setPlanKey(e.target.value)} className="h-9 w-full rounded-md border bg-background px-2 text-sm sm:w-60" data-org-plan={current}>
          {plans.map((x) => (
            <option key={x.key} value={x.key}>
              {x.name}
              {x.key === current ? " (đang dùng)" : ""}
            </option>
          ))}
        </select>
      </div>
    </ConfirmWithReason>
  );
}

/**
 * Thương hiệu của tổ chức (0215) — quyết định liên kết gửi cho người của tổ chức về phần mềm nào. `current = null`: không
 * theo dõi (tổ chức có từ trước) ⇒ liên kết về erp.vnxcommerce.com như cũ. Danh sách nhãn do trang truyền vào.
 */
export function OrgBrandControl({ orgCode, orgName, current, options }: { orgCode: string; orgName: string; current: string | null; options: { key: string; label: string }[] }) {
  const [brand, setBrand] = useState(current ?? "");
  const target = options.find((x) => x.key === brand);
  return (
    <ConfirmWithReason
      id={`brand-${orgCode}`}
      label="Đổi thương hiệu…"
      title={`Đặt «${orgName}» thuộc ${target?.label ?? "…"}?`}
      consequence="Liên kết mời, đặt lại mật khẩu và tin nhóm Lark / Telegram của tổ chức từ nay về phần mềm của thương hiệu này. Không đổi dữ liệu, quyền, gói hay module. Ghi vào nhật ký nền tảng."
      minReason={PILOT_REASON_MIN}
      placeholder="Khách đăng ký từ chotdontudong.com ngày 04/10"
      disabled={!brand || brand === current}
      run={async (reason) => toOutcome(await setOrgBrandAction({ orgCode, brand, reason }), "Đã đổi thương hiệu")}
    >
      <div className="flex items-center gap-2 text-xs">
        <Label htmlFor={`brand-select-${orgCode}`}>Thương hiệu</Label>
        <select id={`brand-select-${orgCode}`} value={brand} onChange={(e) => setBrand(e.target.value)} className="h-9 w-full rounded-md border bg-background px-2 text-sm sm:w-72" data-org-brand={current ?? ""}>
          <option value="" disabled>
            Chọn thương hiệu
          </option>
          {options.map((x) => (
            <option key={x.key} value={x.key}>
              {x.label}
              {x.key === current ? " (đang dùng)" : ""}
            </option>
          ))}
        </select>
      </div>
    </ConfirmWithReason>
  );
}

export function SuspendSwitch({ orgCode, orgName, suspended }: { orgCode: string; orgName: string; suspended: boolean }) {
  return (
    <ConfirmWithReason
      id={`suspend-${orgCode}`}
      label={suspended ? "Bật lại tổ chức…" : "Đình chỉ tổ chức…"}
      variant={suspended ? "outline" : "destructive"}
      title={suspended ? `Bật lại «${orgName}»?` : `Đình chỉ «${orgName}»?`}
      consequence={
        suspended
          ? "Người của tổ chức đăng nhập lại được; job, webhook, luật tự động chạy lại từ lượt kế tiếp (luật đang tạm dừng riêng thì vẫn dừng). Không có dữ liệu nào bị đổi."
          : "Mọi phiên đang mở của tổ chức bị chặn ở lượt bấm kế tiếp (máy chủ khác trễ tối đa 10 giây), không ai đăng nhập được; job của tổ chức bị BỎ QUA, webhook bị từ chối, lịch không gọi tổ chức này. Dữ liệu GIỮ NGUYÊN — bật lại bất cứ lúc nào."
      }
      minReason={PILOT_REASON_MIN}
      placeholder={suspended ? "Khách đã thanh toán, mở lại" : "Nghi lộ mật khẩu quản trị — khoá tạm để kiểm"}
      run={async (reason) => toOutcome(await setOrgSuspendedAction({ orgCode, suspend: !suspended, reason }), "Đã đổi")}
    />
  );
}

export function WorkflowPauseSwitch({ orgCode, orgName, paused }: { orgCode: string; orgName: string; paused: boolean }) {
  return (
    <ConfirmWithReason
      id={`pause-${orgCode}`}
      label={paused ? "Cho luật chạy lại…" : "Tạm dừng mọi luật…"}
      variant={paused ? "outline" : "destructive"}
      title={paused ? `Cho luật tự động của «${orgName}» chạy lại?` : `Tạm dừng MỌI luật tự động của «${orgName}»?`}
      consequence={
        paused
          ? `Lượt kế tiếp (lịch tự chạy — mặc định ${WORKFLOW_CADENCE_DEFAULT_MINUTES} phút, theo gói — hoặc nút «Chạy lượt kiểm tra ngay» của tổ chức) xét tiếp đúng từ sự kiện đã dừng — mỗi sự kiện vẫn chỉ tạo đúng một lượt chạy, không làm lại việc đã làm.`
          : "Bộ máy luật bỏ qua tổ chức này từ lượt kế tiếp: không xét sự kiện mới, không thực thi lượt nào, kể cả lượt đã được duyệt. Lượt đang chờ duyệt GIỮ NGUYÊN. Luật của khách không bị sửa; tổ chức vẫn dùng ERP bình thường."
      }
      minReason={PILOT_REASON_MIN}
      placeholder={paused ? "Đã sửa luật gửi tin lặp" : "Luật gửi tin đang lặp vô hạn"}
      run={async (reason) => toOutcome(await setWorkflowsPausedAction({ orgCode, paused: !paused, reason }), "Đã đổi")}
    />
  );
}

export function DisableConnectionButton({ orgCode, connectorKey, label }: { orgCode: string; connectorKey: string; label: string }) {
  return (
    <ConfirmWithReason
      id={`conn-${orgCode}-${connectorKey}`}
      label="Tắt kết nối…"
      variant="destructive"
      title={`Tắt kết nối «${label}»?`}
      consequence="Kết nối về trạng thái TẮT qua sổ kết nối của tổ chức (nhật ký của tổ chức ghi bạn + lý do). Người vận hành chỉ TẮT được: bật lại là việc của quản trị tổ chức ở trang Kết nối dữ liệu, sau một lần Kiểm tra ĐẠT."
      minReason={PILOT_REASON_MIN}
      placeholder="Webhook trả 401 liên tục, chặn tới khi khách đổi khoá"
      run={async (reason) => toOutcome(await disableOrgConnectionAction({ orgCode, connectorKey, reason }), "Đã tắt")}
    />
  );
}

// ═══ Vòng đời pilot ═══

export function PilotStageControls(props: { orgCode: string; stage: PilotStage | null; next: PilotStage | null; missingNext: string[] }) {
  const [override, setOverride] = useState(false);
  const [back, setBack] = useState<PilotStage | "">("");
  const blocked = props.missingNext.length > 0;
  const earlier = props.stage ? PILOT_STAGES.slice(0, PILOT_STAGES.indexOf(props.stage)) : [];

  return (
    <div className="space-y-4">
      {props.next ? (
        <ConfirmWithReason
          id={`stage-next-${props.orgCode}`}
          label={`Chuyển sang «${PILOT_STAGE_LABEL[props.next]}»…`}
          variant="default"
          title={`Chuyển «${props.orgCode}» sang «${PILOT_STAGE_LABEL[props.next]}»?`}
          consequence={
            blocked
              ? `Danh sách kiểm CHƯA đạt: ${props.missingNext.join(" · ")}. ${override ? "Bạn đang GHI ĐÈ — nhật ký nền tảng ghi cổng nào đã bị vượt kèm lý do." : "Không ghi đè thì máy chủ sẽ từ chối."}`
              : "Danh sách kiểm của giai đoạn này đã đạt. Lượt chuyển ghi vào nhật ký nền tảng."
          }
          minReason={blocked && override ? PILOT_OVERRIDE_MIN_REASON : props.stage === null ? PILOT_REASON_MIN : 0}
          placeholder={blocked ? "Khách không dùng trang riêng — chỉ dùng danh sách lõi" : "Ghi chú (không bắt buộc)"}
          disabled={blocked && !override}
          run={async (reason) => toOutcome(await setPilotStageAction({ orgCode: props.orgCode, stage: props.next!, reason, override: blocked && override }), `Đã chuyển sang «${PILOT_STAGE_LABEL[props.next!]}»`)}
        >
          {blocked ? (
            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} />
              Ghi đè danh sách kiểm (lý do ≥ {PILOT_OVERRIDE_MIN_REASON} ký tự)
            </label>
          ) : null}
        </ConfirmWithReason>
      ) : (
        <p className="text-xs text-muted-foreground">Đã ở giai đoạn cuối.</p>
      )}
      {earlier.length ? (
        <div className="space-y-1.5">
          <Label htmlFor={`stage-back-${props.orgCode}`}>Lùi về</Label>
          <select id={`stage-back-${props.orgCode}`} value={back} onChange={(e) => setBack(e.target.value as PilotStage | "")} className="h-9 w-full rounded-md border bg-background px-2 text-sm sm:w-60">
            <option value="">— chọn giai đoạn —</option>
            {earlier.map((s) => (
              <option key={s} value={s}>
                {PILOT_STAGE_LABEL[s]}
              </option>
            ))}
          </select>
          {back ? (
            <ConfirmWithReason
              id={`stage-back-reason-${props.orgCode}`}
              label={`Lùi về «${PILOT_STAGE_LABEL[back]}»…`}
              title={`Lùi «${props.orgCode}» về «${PILOT_STAGE_LABEL[back]}»?`}
              consequence={`Lùi giai đoạn không bật / tắt gì của tổ chức. ${PILOT_STAGES.indexOf(back) < PILOT_STAGES.indexOf("READY_FOR_UAT") ? "Xác nhận UAT cũ (nếu có) bị xoá — cấu hình sắp đổi nên UAT cũ không còn chứng minh gì." : ""}`}
              minReason={PILOT_REASON_MIN}
              placeholder="Khách đổi quy trình duyệt, cần cấu hình lại"
              run={async (reason) => toOutcome(await setPilotStageAction({ orgCode: props.orgCode, stage: back, reason, override: false }), `Đã lùi về «${PILOT_STAGE_LABEL[back]}»`)}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function UatConfirmForm({ orgCode }: { orgCode: string }) {
  return (
    <ConfirmWithReason
      id={`uat-${orgCode}`}
      label="Xác nhận UAT…"
      title="Xác nhận khách đã nghiệm thu (UAT)?"
      consequence="Ghi người xác nhận + ghi chú vào tổ chức và nhật ký nền tảng. Đây là mục cuối của cổng sang «Đang dùng thật» (cùng với bản sao lưu đêm đầu tiên)."
      minReason={PILOT_REASON_MIN}
      placeholder="Chị Lan (kế toán) + anh Tuấn (kho) chạy thử 3 ngày: nhập đơn, duyệt, xuất kho — đạt"
      run={async (note) => toOutcome(await confirmPilotUatAction({ orgCode, note }), "Đã xác nhận UAT")}
    />
  );
}
