"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Bell, ListPlus, PenLine, Plus, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { FieldErrors, MoveButtons, SELECT_CLASS, Tick } from "@/components/platform/metadata/bits";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { SectionCard } from "@/components/ui-bits";
import { saveWorkflowRuleAction } from "@/lib/actions/workflow-admin";
import type { FieldError, ListFilterOp } from "@/lib/metadata/types";
import { errorsFor, moveItem, type CatalogField } from "@/lib/platform-ui/metadata-admin-shared";
import {
  ACTION_KIND_LABEL,
  blankAction,
  checkRuleDraft,
  conditionErrorName,
  DEPARTMENT_OPTIONS,
  draftToInput,
  opsForField,
  orphanErrors,
  PRIORITY_OPTIONS,
  eventTakesObject,
  subjectObjectKey,
  suggestRuleKey,
  TRIGGER_KIND_LABEL,
  type ActionDraft,
  type ConditionRowDraft,
  type EventOption,
  type RuleDraft,
  type WorkflowObjectOption,
} from "@/lib/platform-ui/workflow-admin-shared";
import type { TaskPriority, WorkflowRuleStatus } from "@/lib/workflow/types";
import { cn } from "@/lib/utils";

/**
 * ═══════════ FORM LUẬT TỰ ĐỘNG ═══════════
 *
 * Bốn khối ô chọn — KHI NÀO · ĐIỀU KIỆN · LÀM GÌ · CỬA DUYỆT. Không vẽ sơ đồ kéo-thả (phase-3-plan §5): thêm /
 * xoá / lên / xuống bằng nút, bấm được bằng bàn phím.
 *
 * LƯU LUÔN ĐƯA LUẬT VỀ NHÁP + CHẠY THỬ (hợp đồng mục 4): luật đang bật mà bị sửa thì máy thôi chạy nó cho tới khi người
 * bấm «Bật» lại — hộp xác nhận nói điều đó TRƯỚC khi lưu, không để người sửa phát hiện sau.
 *
 * Lỗi: kiểm sớm ở trình duyệt để báo nhanh; câu của MÁY CHỦ in nguyên văn dưới đúng ô (khoá lỗi = đường dẫn
 * đầu vào: `name`, `trigger.to`, `conditions.all.1.value`, `actions.0.title`, `gate.reason`…). Lỗi không khớp ô
 * nào đang hiện in ở đầu form.
 */

export type RuleEditorProps = {
  /** `null` = luật mới. */
  ruleId: string | null;
  status: WorkflowRuleStatus | null;
  initial: RuleDraft;
  takenKeys: string[];
  events: EventOption[];
  objects: WorkflowObjectOption[];
};

function Row({ label, children, errors, hint, className }: { label: string; children: React.ReactNode; errors?: FieldError[]; hint?: string; className?: string }) {
  return (
    <div className={cn("grid content-start gap-1 text-sm", className)} role="group" aria-label={label}>
      <span className="text-xs font-medium text-muted-foreground" title={hint}>
        {label}
      </span>
      {children}
      <FieldErrors errors={errors ?? []} />
    </div>
  );
}

/** Lỗi thuộc khối `prefix` mà không thuộc ô cụ thể nào đã in trong khối. */
function blockErrors(errors: readonly FieldError[], prefix: string, placed: readonly string[]): FieldError[] {
  return errorsFor(errors, prefix).filter((e) => !placed.some((p) => errorsFor([e], p).length > 0));
}

export function RuleEditor({ ruleId, status, initial, takenKeys, events, objects }: RuleEditorProps) {
  const router = useRouter();
  const creating = ruleId === null;
  const [draft, setDraft] = useState<RuleDraft>(initial);
  const [keyTouched, setKeyTouched] = useState(!creating);
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [confirmSave, setConfirmSave] = useState(false);
  const [pending, startTransition] = useTransition();
  const readOnly = status === "ARCHIVED";

  const taken = useMemo(() => new Set(takenKeys.filter((k) => k !== initial.key)), [takenKeys, initial.key]);
  const set = <K extends keyof RuleDraft>(k: K, v: RuleDraft[K]) => setDraft((p) => ({ ...p, [k]: v }));

  const subjectKey = subjectObjectKey(draft, events);
  const subject = objects.find((o) => o.key === subjectKey) ?? null;
  const catalog: CatalogField[] = subject?.catalog ?? [];
  const statusObjects = objects.filter((o) => o.statusFields.length > 0);
  const statusObject = objects.find((o) => o.key === draft.objectKey) ?? null;
  const statusField = statusObject?.statusFields.find((f) => f.key === draft.fieldKey) ?? null;

  const setName = (name: string) => setDraft((p) => ({ ...p, name, key: keyTouched ? p.key : suggestRuleKey(name, taken) }));

  const shown = ["name", "key", "description", "trigger", "conditions", "actions", "gate"];
  const topErrors = orphanErrors(errors, shown);

  const doSave = () => {
    const input = draftToInput(draft, catalog);
    startTransition(async () => {
      try {
        const r = await saveWorkflowRuleAction(ruleId, input);
        if (!r.ok) {
          setErrors(r.errors);
          toast.error("Chưa lưu được — xem câu báo dưới từng ô.");
          return;
        }
        setErrors([]);
        toast.success(creating ? "Đã tạo luật ở NHÁP + CHẠY THỬ" : "Đã lưu — luật về NHÁP + CHẠY THỬ, bấm «Bật» để chạy lại");
        if (creating) router.push(`/settings/workflows/${encodeURIComponent(r.id)}`);
      } catch {
        setErrors([{ field: "_", message: "Không lưu được — thử lại." }]);
      }
    });
  };

  const submit = () => {
    const early = checkRuleDraft(draft, { creating, takenKeys: taken });
    setErrors(early);
    if (early.length) {
      toast.error("Còn ô chưa hợp lệ.");
      return;
    }
    if (status === "ACTIVE" || status === "PAUSED") setConfirmSave(true);
    else doSave();
  };

  // ───── Điều kiện ─────
  const setCondition = (i: number, patch: Partial<ConditionRowDraft>) => set("conditions", draft.conditions.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const addCondition = () => set("conditions", [...draft.conditions, { field: catalog[0]?.ref ?? "", op: "eq", value: "" }]);

  // ───── Hành động ─────
  const setAction = (i: number, next: ActionDraft) => set("actions", draft.actions.map((a, j) => (j === i ? next : a)));
  const customFields = catalog.filter((c) => !c.system);
  const hasNotify = draft.actions.some((a) => a.kind === "notify");

  return (
    <fieldset disabled={readOnly || pending} className="space-y-4">
      <FieldErrors errors={topErrors} />

      <SectionCard title="Luật" description={creating ? "Luật mới luôn sinh ra ở NHÁP + CHẠY THỬ." : undefined}>
        <div className="grid gap-3 sm:grid-cols-3">
          <Row label="Tên luật" errors={errorsFor(errors, "name")}>
            <Input value={draft.name} onChange={(e) => setName(e.target.value)} maxLength={120} autoFocus={creating} />
          </Row>
          <Row label={creating ? "Khoá (không đổi được sau khi tạo)" : "Khoá (bất biến)"} errors={errorsFor(errors, "key")} hint="Chữ thường không dấu, số và «_». Gợi ý từ tên — sửa được trước khi lưu lần đầu.">
            <Input
              value={draft.key}
              disabled={!creating}
              className="font-mono"
              maxLength={41}
              onChange={(e) => {
                setKeyTouched(true);
                set("key", e.target.value);
              }}
            />
          </Row>
          <Row label="Mô tả (tuỳ chọn)" errors={errorsFor(errors, "description")}>
            <Input value={draft.description} onChange={(e) => set("description", e.target.value)} maxLength={1000} />
          </Row>
        </div>
      </SectionCard>

      {/* ───────────── KHI NÀO ───────────── */}
      <SectionCard
        title="Khi nào"
        hint="Sự kiện hệ thống: đọc từ sổ sự kiện của ERP, chỉ tên ĐANG PHÁT mới chọn được. Trạng thái nghiệp vụ: field tuỳ biến kiểu «Trạng thái nghiệp vụ» (khai ở Mô hình dữ liệu) — luật chạy khi giá trị đổi SANG một giá trị đích."
      >
        <div className="space-y-3">
          <div className="flex flex-wrap gap-4 text-sm" role="radiogroup" aria-label="Loại kích hoạt">
            {(["event", "custom_status"] as const).map((k) => (
              <label key={k} className="inline-flex items-center gap-2">
                <input type="radio" name="trigger-kind" className="accent-[var(--primary)]" checked={draft.triggerKind === k} onChange={() => setDraft((p) => ({ ...p, triggerKind: k }))} />
                {TRIGGER_KIND_LABEL[k]}
              </label>
            ))}
          </div>
          <FieldErrors errors={blockErrors(errors, "trigger", ["trigger.event", "trigger.objectKey", "trigger.fieldKey", "trigger.to", "trigger.from"])} />
          {draft.triggerKind === "event" ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <Row label="Sự kiện" errors={errorsFor(errors, "trigger.event")} className="max-w-xl">
                <select className={cn(SELECT_CLASS, "h-9")} value={draft.event} onChange={(e) => set("event", e.target.value)}>
                  <option value="">— chọn sự kiện —</option>
                  {events.map((ev) => (
                    <option key={ev.name} value={ev.name}>
                      {ev.label === ev.name ? ev.name : `${ev.label} · ${ev.name}`}
                    </option>
                  ))}
                </select>
              </Row>
              {eventTakesObject(draft.event, events) ? (
                /* Phase 6: sự kiện trên bản ghi (tạo / sửa / xoá bản ghi tuỳ biến) — chọn ĐỐI TƯỢNG để luật chỉ nghe
                   bản ghi của nó và điều kiện đọc được field của nó. */
                <Row label="Của đối tượng" errors={errorsFor(errors, "trigger.objectKey")}>
                  <select className={cn(SELECT_CLASS, "h-9")} value={draft.objectKey} onChange={(e) => set("objectKey", e.target.value)}>
                    <option value="">— mọi đối tượng —</option>
                    {objects.map((o) => (
                      <option key={o.key} value={o.key}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </Row>
              ) : null}
            </div>
          ) : statusObjects.length === 0 ? (
            <p className="text-sm text-muted-foreground">Chưa có đối tượng nào có field «Trạng thái nghiệp vụ» — khai ở Mô hình dữ liệu trước.</p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              <Row label="Đối tượng" errors={errorsFor(errors, "trigger.objectKey")}>
                <select className={cn(SELECT_CLASS, "h-9")} value={draft.objectKey} onChange={(e) => setDraft((p) => ({ ...p, objectKey: e.target.value, fieldKey: "", to: [], from: [] }))}>
                  <option value="">— chọn đối tượng —</option>
                  {statusObjects.map((o) => (
                    <option key={o.key} value={o.key}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </Row>
              <Row label="Field trạng thái" errors={errorsFor(errors, "trigger.fieldKey")}>
                <select className={cn(SELECT_CLASS, "h-9")} value={draft.fieldKey} disabled={!statusObject} onChange={(e) => setDraft((p) => ({ ...p, fieldKey: e.target.value, to: [], from: [] }))}>
                  <option value="">— chọn field —</option>
                  {(statusObject?.statusFields ?? []).map((f) => (
                    <option key={f.key} value={f.key}>
                      {f.label} · {f.key}
                    </option>
                  ))}
                </select>
              </Row>
              {statusField ? (
                <>
                  <Row label="Đổi SANG (một trong)" errors={errorsFor(errors, "trigger.to")}>
                    <OptionTicks options={statusField.options} selected={draft.to} onChange={(v) => set("to", v)} name="giá trị đích" />
                  </Row>
                  <Row label="Từ (tuỳ chọn — để trống là từ bất kỳ)" errors={errorsFor(errors, "trigger.from")}>
                    <OptionTicks options={statusField.options} selected={draft.from} onChange={(v) => set("from", v)} name="giá trị nguồn" />
                  </Row>
                </>
              ) : null}
            </div>
          )}
        </div>
      </SectionCard>

      {/* ───────────── ĐIỀU KIỆN ───────────── */}
      <SectionCard
        title="Điều kiện"
        description={draft.conditions.length === 0 && !draft.lockedConditions ? "Không có điều kiện — luật chạy mỗi lần kích hoạt." : undefined}
        hint="So trên field hệ thống và field tuỳ biến của bản ghi mang kích hoạt. «Tất cả» = mọi dòng phải đúng; «Bất kỳ» = một dòng đúng là đủ. Không có biểu thức tự do."
        actions={
          draft.lockedConditions ? null : (
            <Button type="button" size="sm" variant="outline" onClick={addCondition}>
              <Plus /> Thêm điều kiện
            </Button>
          )
        }
      >
        <div className="space-y-2">
          <FieldErrors errors={blockErrors(errors, "conditions", draft.conditions.map((_, i) => conditionErrorName(draft.match, i)))} />
          {draft.lockedConditions ? (
            <div className="space-y-2 text-sm">
              <p className="text-muted-foreground">Điều kiện của luật này lồng nhiều tầng — màn hình chỉ sửa được một tầng, nên lưu sẽ GIỮ NGUYÊN điều kiện cũ.</p>
              <pre className="overflow-x-auto rounded-lg bg-muted/50 p-2 text-xs">{JSON.stringify(draft.lockedConditions, null, 2)}</pre>
              <Button type="button" size="sm" variant="outline" onClick={() => setDraft((p) => ({ ...p, lockedConditions: null, conditions: [] }))}>
                Bỏ và khai lại
              </Button>
            </div>
          ) : draft.conditions.length > 0 ? (
            <>
              <label className="inline-flex items-center gap-2 text-sm">
                Khớp khi
                <select className={SELECT_CLASS} value={draft.match} onChange={(e) => set("match", e.target.value as "all" | "any")}>
                  <option value="all">TẤT CẢ dòng đúng</option>
                  <option value="any">BẤT KỲ dòng nào đúng</option>
                </select>
              </label>
              {subject === null ? <p className="text-xs text-muted-foreground">Sự kiện này không gắn bản ghi nào trong sổ — chỉ so được thông tin của chính sự kiện: gõ «system:payload.khoá» hoặc «system:event.khoá».</p> : null}
              <ul className="space-y-2">
                {draft.conditions.map((c, i) => (
                  <li key={i} className="rounded-lg border border-hairline p-2">
                    <div className="flex flex-wrap items-center gap-2">
                      {subject ? (
                        <select className={cn(SELECT_CLASS, "min-w-44")} aria-label={`Field của điều kiện ${i + 1}`} value={c.field} onChange={(e) => setCondition(i, { field: e.target.value, op: "eq", value: "" })}>
                          <option value="">— field —</option>
                          {catalog.map((f) => (
                            <option key={f.ref} value={f.ref}>
                              {f.label}
                              {f.system ? "" : " (tuỳ biến)"}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <Input className="h-8 w-56 font-mono" aria-label={`Field của điều kiện ${i + 1}`} placeholder="system:payload.khoá" value={c.field} onChange={(e) => setCondition(i, { field: e.target.value })} />
                      )}
                      <select className={SELECT_CLASS} aria-label={`Phép so của điều kiện ${i + 1}`} value={c.op} onChange={(e) => setCondition(i, { op: e.target.value as ListFilterOp })}>
                        {opsForField(c.field, catalog).map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                      <ValueInput field={catalog.find((f) => f.ref === c.field) ?? null} op={c.op} value={c.value} onChange={(value) => setCondition(i, { value })} label={`Giá trị của điều kiện ${i + 1}`} />
                      <Button type="button" variant="ghost" size="icon-xs" aria-label={`Xoá điều kiện ${i + 1}`} title="Xoá" onClick={() => set("conditions", draft.conditions.filter((_, j) => j !== i))}>
                        <Trash2 />
                      </Button>
                    </div>
                    <FieldErrors errors={errorsFor(errors, conditionErrorName(draft.match, i))} />
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      </SectionCard>

      {/* ───────────── LÀM GÌ ───────────── */}
      <SectionCard
        title="Làm gì"
        hint="Tập hành động ĐÓNG: tạo việc cho một phòng, báo trong ERP, ghi giá trị field tuỳ biến của chính bản ghi. Không có hành động đổi đơn / vận đơn / COD / kho. Làm theo thứ tự từ trên xuống."
        actions={
          <span className="inline-flex flex-wrap gap-1.5">
            <Button type="button" size="sm" variant="outline" onClick={() => set("actions", [...draft.actions, blankAction("create_task")])}>
              <ListPlus /> Tạo việc
            </Button>
            <Button type="button" size="sm" variant="outline" disabled={hasNotify} title={hasNotify ? "Mỗi luật tối đa một thông báo — một tin gom cho lượt chạy" : undefined} onClick={() => set("actions", [...draft.actions, blankAction("notify")])}>
              <Bell /> Báo trong ERP
            </Button>
            <Button type="button" size="sm" variant="outline" disabled={customFields.length === 0} title={customFields.length === 0 ? "Bản ghi của kích hoạt này không có field tuỳ biến nào" : undefined} onClick={() => set("actions", [...draft.actions, blankAction("set_custom_value")])}>
              <PenLine /> Ghi giá trị
            </Button>
          </span>
        }
      >
        <div className="space-y-2">
          <FieldErrors errors={blockErrors(errors, "actions", draft.actions.map((_, i) => `actions.${i}`))} />
          {draft.actions.length === 0 ? <p className="text-sm text-muted-foreground">Chưa có hành động nào — thêm ít nhất một.</p> : null}
          <ol className="space-y-2">
            {draft.actions.map((a, i) => (
              <li key={i} className="space-y-2 rounded-lg border border-hairline p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold">
                    {i + 1}. {ACTION_KIND_LABEL[a.kind]}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <MoveButtons index={i} count={draft.actions.length} label={`hành động ${i + 1}`} onMove={(d) => set("actions", moveItem(draft.actions, i, d))} />
                    <Button type="button" variant="ghost" size="icon-xs" aria-label={`Xoá hành động ${i + 1}`} title="Xoá" onClick={() => set("actions", draft.actions.filter((_, j) => j !== i))}>
                      <Trash2 />
                    </Button>
                  </span>
                </div>
                <ActionFields action={a} index={i} customFields={customFields} errors={errors} onChange={(next) => setAction(i, next)} />
              </li>
            ))}
          </ol>
        </div>
      </SectionCard>

      {/* ───────────── CỬA DUYỆT ───────────── */}
      <SectionCard title="Cửa duyệt" hint="Bật thì mỗi lượt khớp luật sinh MỘT yêu cầu duyệt ở hàng đợi duyệt (trang Cần xử lý và /work); máy chỉ làm sau khi một người duyệt, từ chối thì lượt chạy dừng.">
        <div className="space-y-2 text-sm">
          <label className="inline-flex items-center gap-2">
            <Tick checked={draft.gateOn} onChange={(v) => set("gateOn", v)} label="Cần người duyệt trước khi làm" /> Cần người duyệt trước khi làm
          </label>
          <FieldErrors errors={blockErrors(errors, "gate", ["gate.reason"])} />
          {draft.gateOn ? (
            <Row label="Lý do cần duyệt (người duyệt đọc câu này)" errors={errorsFor(errors, "gate.reason")} className="max-w-xl">
              <Input value={draft.gateReason} onChange={(e) => set("gateReason", e.target.value)} maxLength={300} />
            </Row>
          ) : null}
        </div>
      </SectionCard>

      {readOnly ? null : (
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" onClick={submit} disabled={pending}>
            <Save /> {creating ? "Tạo luật (nháp)" : "Lưu (về nháp)"}
          </Button>
          <span className="text-xs text-muted-foreground">Lưu luôn đưa luật về NHÁP + CHẠY THỬ và tăng phiên bản — luật chỉ chạy lại sau khi bấm «Bật».</span>
        </div>
      )}

      <AlertDialog open={confirmSave} onOpenChange={setConfirmSave}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Lưu sẽ đưa luật về NHÁP</AlertDialogTitle>
            <AlertDialogDescription>
              Luật đang {status === "ACTIVE" ? "BẬT" : "tạm dừng"}. Sau khi lưu, luật về NHÁP + CHẠY THỬ: máy THÔI chạy nó cho tới khi bạn bấm «Bật» lại, và muốn chạy thật thì phải bật công tắc lần nữa.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Huỷ</AlertDialogCancel>
            <AlertDialogAction
              disabled={pending}
              onClick={() => {
                setConfirmSave(false);
                doSave();
              }}
            >
              Lưu về nháp
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </fieldset>
  );
}

function OptionTicks({ options, selected, onChange, name }: { options: { value: string; label: string }[]; selected: string[]; onChange: (v: string[]) => void; name: string }) {
  if (options.length === 0) return <span className="text-xs text-muted-foreground">Field chưa có giá trị nào.</span>;
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1.5">
      {options.map((o) => (
        <label key={o.value} className="inline-flex items-center gap-1.5 text-sm">
          <Tick
            checked={selected.includes(o.value)}
            label={`${name}: ${o.label}`}
            onChange={(on) => onChange(on ? [...selected, o.value] : selected.filter((v) => v !== o.value))}
          />
          {o.label}
        </label>
      ))}
    </div>
  );
}

/** Ô giá trị hợp với field: chọn trong tuỳ chọn, có/không, hoặc gõ chữ. `in` = nhiều giá trị, ngăn bằng dấu phẩy. */
function ValueInput({ field, op, value, onChange, label }: { field: CatalogField | null; op: ListFilterOp; value: string; onChange: (v: string) => void; label: string }) {
  if (op === "empty" || op === "not_empty") return null;
  const options = field?.options ?? [];
  if (options.length > 0 && op === "in") {
    const selected = value.split(",").map((s) => s.trim()).filter(Boolean);
    return <OptionTicks options={options} selected={selected} onChange={(v) => onChange(v.join(", "))} name={label} />;
  }
  if (options.length > 0) {
    return (
      <select className={cn(SELECT_CLASS, "min-w-36")} aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">— chọn —</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  }
  if (field?.type === "boolean") {
    return (
      <select className={SELECT_CLASS} aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">— chọn —</option>
        <option value="true">Có</option>
        <option value="false">Không</option>
      </select>
    );
  }
  const numeric = field?.type === "number" || field?.type === "currency";
  return (
    <Input
      className="h-8 w-56"
      aria-label={label}
      inputMode={numeric ? "decimal" : undefined}
      placeholder={op === "in" ? "giá trị 1, giá trị 2" : field?.type === "date" ? "YYYY-MM-DD" : ""}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function ActionFields({ action, index, customFields, errors, onChange }: { action: ActionDraft; index: number; customFields: CatalogField[]; errors: FieldError[]; onChange: (a: ActionDraft) => void }) {
  const at = (name: string) => errorsFor(errors, `actions.${index}.${name}`);
  const placed = action.kind === "create_task" ? ["title", "summary", "departmentCode", "priority", "dueInHours"] : action.kind === "notify" ? ["message"] : ["field", "value"];
  const rest = blockErrors(errors, `actions.${index}`, placed.map((p) => `actions.${index}.${p}`));
  if (action.kind === "create_task") {
    return (
      <div className="space-y-2">
        <div className="grid gap-3 sm:grid-cols-4">
          <Row label="Tiêu đề việc" errors={at("title")} className="sm:col-span-2">
            <Input value={action.title} maxLength={200} onChange={(e) => onChange({ ...action, title: e.target.value })} />
          </Row>
          <Row label="Phòng nhận việc" errors={at("departmentCode")} hint="Để trống = phòng sở hữu mặc định của nguồn việc luật tự động.">
            <select className={cn(SELECT_CLASS, "h-9")} value={action.departmentCode} onChange={(e) => onChange({ ...action, departmentCode: e.target.value })}>
              <option value="">— mặc định —</option>
              {DEPARTMENT_OPTIONS.map((d) => (
                <option key={d.value} value={d.value}>
                  {d.label}
                </option>
              ))}
            </select>
          </Row>
          <div className="grid grid-cols-2 gap-2">
            <Row label="Ưu tiên" errors={at("priority")}>
              <select className={cn(SELECT_CLASS, "h-9")} value={action.priority} onChange={(e) => onChange({ ...action, priority: e.target.value as TaskPriority })}>
                {PRIORITY_OPTIONS.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
            </Row>
            <Row label="Hạn (giờ)" errors={at("dueInHours")} hint="Để trống = hạn theo cấu hình SLA của nguồn việc.">
              <Input inputMode="numeric" value={action.dueInHours} onChange={(e) => onChange({ ...action, dueInHours: e.target.value })} />
            </Row>
          </div>
        </div>
        <Row label="Mô tả việc (tuỳ chọn)" errors={at("summary")}>
          <Textarea rows={2} value={action.summary} maxLength={2000} onChange={(e) => onChange({ ...action, summary: e.target.value })} />
        </Row>
        <FieldErrors errors={rest} />
      </div>
    );
  }
  if (action.kind === "notify") {
    return (
      <div className="space-y-2">
        <Row label="Nội dung báo" errors={at("message")}>
          <Textarea rows={2} value={action.message} maxLength={500} onChange={(e) => onChange({ ...action, message: e.target.value })} />
        </Row>
        <FieldErrors errors={rest} />
      </div>
    );
  }
  const field = customFields.find((f) => f.ref === `custom:${action.field}`) ?? null;
  return (
    <div className="space-y-2">
      <div className="grid gap-3 sm:grid-cols-3">
        <Row label="Field tuỳ biến" errors={at("field")}>
          <select className={cn(SELECT_CLASS, "h-9")} value={action.field} onChange={(e) => onChange({ ...action, field: e.target.value, value: "" })}>
            <option value="">— chọn field —</option>
            {customFields.map((f) => (
              <option key={f.ref} value={f.ref.slice("custom:".length)}>
                {f.label}
              </option>
            ))}
          </select>
        </Row>
        <Row label="Giá trị ghi" errors={at("value")} hint="Máy chủ kiểm hợp lệ và luật chuyển trạng thái như khi người ghi tay.">
          <ValueInput field={field} op="eq" value={action.value} onChange={(value) => onChange({ ...action, value })} label={`Giá trị ghi của hành động ${index + 1}`} />
        </Row>
      </div>
      <FieldErrors errors={rest} />
    </div>
  );
}
