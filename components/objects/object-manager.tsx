"use client";

/**
 * ═══════════ QUẢN TRỊ ĐỐI TƯỢNG TUỲ BIẾN (Phase 6 · mục 5) ═══════════
 *
 * Bảng đối tượng + khung tạo / sửa. Khoá chỉ nhập lúc TẠO (bất biến), gợi ý từ tên bằng bỏ dấu, luôn mang tiền tố
 * «x_». Biểu tượng chọn trong tập ĐÓNG; nhóm menu và khoá quyền siết chọn trong danh sách có thật — không ô gõ tự do.
 * Câu lỗi của MÁY CHỦ in nguyên văn dưới đúng ô; không `router.refresh()` (action đã `revalidatePath`).
 */
import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { Archive, ArchiveRestore, Pencil, Plus } from "lucide-react";
import { toast } from "sonner";
import { ObjectIcon } from "@/components/objects/object-icon";
import { FieldErrors, SELECT_CLASS } from "@/components/platform/metadata/bits";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { createObjectAction, setObjectArchivedAction, updateObjectAction } from "@/lib/actions/objects";
import type { FieldError } from "@/lib/metadata/types";
import { CUSTOM_OBJECT_ICON_LABEL, CUSTOM_OBJECT_ICONS } from "@/lib/objects/constants";
import type { CustomObjectSummary } from "@/lib/objects/types";
import { errorsFor, stripVietnamese } from "@/lib/platform-ui/metadata-admin-shared";
import { cn } from "@/lib/utils";

type Option = { key: string; label: string };
type Draft = { key: string; label: string; labelPlural: string; icon: string; moduleKey: string; titleLabel: string; description: string; viewPermission: string; writePermission: string };

const BLANK: Draft = { key: "x_", label: "", labelPlural: "", icon: "box", moduleKey: "apps", titleLabel: "Tên", description: "", viewPermission: "records:view", writePermission: "records:write" };

/** Gợi ý khoá từ tên: bỏ dấu, chữ thường, `_`, tiền tố `x_`, không trùng khoá đã có. */
function suggestObjectKey(label: string, taken: ReadonlySet<string>): string {
  let base = stripVietnamese(label).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (!/^[a-z]/.test(base)) base = `d_${base}`.replace(/_+$/, "");
  if (base.length < 2) base = "doi_tuong";
  base = `x_${base}`.slice(0, 43).replace(/_+$/, "");
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base.slice(0, 43 - `_${i}`.length).replace(/_+$/, "")}_${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return base;
}

function toDraft(o: CustomObjectSummary): Draft {
  return { key: o.key, label: o.label, labelPlural: o.labelPlural, icon: o.icon, moduleKey: o.moduleKey, titleLabel: o.titleLabel, description: o.description ?? "", viewPermission: o.viewPermission, writePermission: o.writePermission };
}

export function ObjectManager({ objects, modules, permissions }: { objects: CustomObjectSummary[]; modules: Option[]; permissions: Option[] }) {
  const [mode, setMode] = useState<{ kind: "create" } | { kind: "edit"; key: string } | null>(objects.length === 0 ? { kind: "create" } : null);
  const [pending, startTransition] = useTransition();
  const taken = useMemo(() => new Set(objects.map((o) => o.key)), [objects]);
  const moduleLabel = (k: string) => modules.find((m) => m.key === k)?.label ?? k;

  const toggleArchive = (o: CustomObjectSummary) =>
    startTransition(async () => {
      const r = await setObjectArchivedAction(o.key, o.status === "ACTIVE");
      if (r.ok) toast.success(o.status === "ACTIVE" ? `Đã lưu trữ «${o.label}»` : `Đã khôi phục «${o.label}»`);
      else toast.error(r.error);
    });

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button size="sm" onClick={() => setMode({ kind: "create" })} disabled={mode?.kind === "create"}>
          <Plus className="size-4" /> Đối tượng mới
        </Button>
      </div>
      {mode?.kind === "create" ? <ObjectEditor draft={BLANK} creating taken={taken} modules={modules} permissions={permissions} onDone={() => setMode(null)} /> : null}
      <div className="overflow-x-auto rounded-xl border">
        {objects.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">Chưa có đối tượng tuỳ biến nào — bấm «Đối tượng mới» để tạo nghiệp vụ đầu tiên (vd Hợp đồng bảo trì).</p>
        ) : (
          <table className="w-full min-w-[760px] text-sm">
            <thead className="bg-muted/40 text-left text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2">Đối tượng</th>
                <th className="px-3 py-2">Khoá</th>
                <th className="px-3 py-2">Nhóm menu</th>
                <th className="px-3 py-2 text-right">Bản ghi</th>
                <th className="px-3 py-2 text-right">Field</th>
                <th className="px-3 py-2">Cấu hình</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {objects.map((o) => (
                <tr key={o.key} className={cn("border-t border-hairline align-top", o.status === "ARCHIVED" && "opacity-60")}>
                  <td className="px-3 py-2">
                    <span className="flex items-center gap-2 font-medium">
                      <ObjectIcon icon={o.icon} />
                      {o.status === "ACTIVE" ? <Link href={`/o/${o.key}`} className="hover:text-primary hover:underline">{o.labelPlural}</Link> : o.labelPlural}
                      {o.status === "ARCHIVED" ? <span className="rounded bg-muted px-1.5 text-[11px]">Đã lưu trữ</span> : null}
                    </span>
                    {o.description ? <p className="mt-0.5 text-xs text-muted-foreground">{o.description}</p> : null}
                    {mode?.kind === "edit" && mode.key === o.key ? (
                      <div className="mt-3">
                        <ObjectEditor draft={toDraft(o)} creating={false} taken={taken} modules={modules} permissions={permissions} onDone={() => setMode(null)} />
                      </div>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 font-mono text-[12.5px]">{o.key}</td>
                  <td className="px-3 py-2">{moduleLabel(o.moduleKey)}</td>
                  <td className="px-3 py-2 text-right numeric">{o.recordCount}</td>
                  <td className="px-3 py-2 text-right numeric">{o.fieldCount}</td>
                  <td className="px-3 py-2 text-xs">
                    {o.status === "ACTIVE" ? (
                      <span className="flex flex-wrap gap-x-2 gap-y-1">
                        <Link className="text-primary hover:underline" href={`/settings/data-model?object=${o.key}`}>Field</Link>
                        <Link className="text-primary hover:underline" href={`/settings/forms?object=${o.key}`}>Form</Link>
                        <Link className="text-primary hover:underline" href={`/settings/lists?object=${o.key}`}>Danh sách</Link>
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <span className="flex justify-end gap-1">
                      {o.status === "ACTIVE" ? (
                        <Button variant="ghost" size="icon-xs" aria-label={`Sửa ${o.label}`} title="Sửa" onClick={() => setMode({ kind: "edit", key: o.key })}>
                          <Pencil />
                        </Button>
                      ) : null}
                      <Button variant="ghost" size="icon-xs" disabled={pending} aria-label={o.status === "ACTIVE" ? `Lưu trữ ${o.label}` : `Khôi phục ${o.label}`} title={o.status === "ACTIVE" ? "Lưu trữ" : "Khôi phục"} onClick={() => toggleArchive(o)}>
                        {o.status === "ACTIVE" ? <Archive /> : <ArchiveRestore />}
                      </Button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function Row({ label, errors, children, className }: { label: string; errors: readonly FieldError[]; children: React.ReactNode; className?: string }) {
  return (
    <label className={cn("block space-y-1 text-sm", className)}>
      <span className="font-medium">{label}</span>
      {children}
      <FieldErrors errors={errors} />
    </label>
  );
}

function ObjectEditor({ draft: initial, creating, taken, modules, permissions, onDone }: { draft: Draft; creating: boolean; taken: ReadonlySet<string>; modules: Option[]; permissions: Option[]; onDone: () => void }) {
  const [d, setD] = useState<Draft>(initial);
  const [keyTouched, setKeyTouched] = useState(!creating);
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [pending, startTransition] = useTransition();
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((p) => ({ ...p, [k]: v }));
  const shown = ["key", "label", "labelPlural", "icon", "moduleKey", "titleLabel", "description", "viewPermission", "writePermission"];
  const orphan = errors.filter((e) => !shown.some((n) => errorsFor([e], n).length > 0));

  const submit = () => {
    const body = { label: d.label, labelPlural: d.labelPlural || d.label, icon: d.icon, moduleKey: d.moduleKey, titleLabel: d.titleLabel, description: d.description.trim() || null, viewPermission: d.viewPermission, writePermission: d.writePermission };
    startTransition(async () => {
      const r = creating ? await createObjectAction({ key: d.key, ...body }) : await updateObjectAction(d.key, body);
      if (!r.ok) {
        setErrors(r.errors);
        toast.error("Chưa lưu được — xem câu báo dưới từng ô.");
        return;
      }
      setErrors([]);
      toast.success(creating ? `Đã tạo «${d.label}» — thêm field ở Mô hình dữ liệu` : "Đã lưu");
      onDone();
    });
  };

  return (
    <div className="space-y-3 rounded-xl border border-primary/30 bg-surface p-4">
      <FieldErrors errors={orphan} />
      <div className="grid gap-3 sm:grid-cols-3">
        <Row label="Tên (số ít)" errors={errorsFor(errors, "label")}>
          <Input value={d.label} maxLength={60} placeholder="Hợp đồng bảo trì" onChange={(e) => setD((p) => ({ ...p, label: e.target.value, key: keyTouched ? p.key : suggestObjectKey(e.target.value, taken) }))} />
        </Row>
        <Row label="Tên số nhiều (menu, danh sách)" errors={errorsFor(errors, "labelPlural")}>
          <Input value={d.labelPlural} maxLength={60} placeholder={d.label || "Hợp đồng bảo trì"} onChange={(e) => set("labelPlural", e.target.value)} />
        </Row>
        <Row label="Khoá (bất biến)" errors={errorsFor(errors, "key")}>
          <Input
            className="font-mono"
            value={d.key}
            disabled={!creating}
            maxLength={43}
            onChange={(e) => {
              setKeyTouched(true);
              set("key", e.target.value.trim());
            }}
          />
        </Row>
        <Row label="Tên ô tiêu đề của bản ghi" errors={errorsFor(errors, "titleLabel")}>
          <Input value={d.titleLabel} maxLength={40} placeholder="Số hợp đồng" onChange={(e) => set("titleLabel", e.target.value)} />
        </Row>
        <Row label="Nhóm menu" errors={errorsFor(errors, "moduleKey")}>
          <select className={cn(SELECT_CLASS, "h-9 w-full")} value={d.moduleKey} onChange={(e) => set("moduleKey", e.target.value)}>
            {modules.map((m) => (
              <option key={m.key} value={m.key}>
                {m.label}
              </option>
            ))}
          </select>
        </Row>
        <div className="space-y-1 text-sm">
          <span className="font-medium">Biểu tượng</span>
          <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Biểu tượng">
            {CUSTOM_OBJECT_ICONS.map((i) => (
              <button
                key={i}
                type="button"
                role="radio"
                aria-checked={d.icon === i}
                title={CUSTOM_OBJECT_ICON_LABEL[i]}
                onClick={() => set("icon", i)}
                className={cn("flex size-8 items-center justify-center rounded-md border", d.icon === i ? "border-primary bg-primary/10 text-primary" : "border-border hover:bg-muted")}
              >
                <ObjectIcon icon={i} />
              </button>
            ))}
          </div>
          <FieldErrors errors={errorsFor(errors, "icon")} />
        </div>
        <Row label="Khoá quyền XEM (siết thêm — luôn cần «xem bản ghi»)" errors={errorsFor(errors, "viewPermission")}>
          <select className={cn(SELECT_CLASS, "h-9 w-full")} value={d.viewPermission} onChange={(e) => set("viewPermission", e.target.value)}>
            {permissions.map((p) => (
              <option key={p.key} value={p.key}>
                {p.label}
              </option>
            ))}
          </select>
        </Row>
        <Row label="Khoá quyền GHI (siết thêm — luôn cần «tạo & sửa bản ghi»)" errors={errorsFor(errors, "writePermission")}>
          <select className={cn(SELECT_CLASS, "h-9 w-full")} value={d.writePermission} onChange={(e) => set("writePermission", e.target.value)}>
            {permissions.map((p) => (
              <option key={p.key} value={p.key}>
                {p.label}
              </option>
            ))}
          </select>
        </Row>
        <Row label="Mô tả" errors={errorsFor(errors, "description")} className="sm:col-span-3">
          <Textarea value={d.description} maxLength={500} rows={2} onChange={(e) => set("description", e.target.value)} />
        </Row>
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onDone} disabled={pending}>
          Huỷ
        </Button>
        <Button type="button" size="sm" onClick={submit} disabled={pending}>
          {pending ? "Đang lưu…" : creating ? "Tạo đối tượng" : "Lưu"}
        </Button>
      </div>
    </div>
  );
}
