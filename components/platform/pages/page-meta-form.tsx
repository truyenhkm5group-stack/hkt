"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { SELECT_CLASS, Tick } from "@/components/platform/metadata/bits";
import { PathErrors } from "@/components/platform/pages/path-errors";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createPageAction, updatePageMetaAction } from "@/lib/actions/page-admin";
import type { ModuleKey } from "@/lib/constants/platform-modules";
import { sameConfig } from "@/lib/platform-ui/metadata-admin-shared";
import { blankPageMeta, checkPageMeta, metaErrorsFor, normalizePageMeta, suggestSlug, type PageMetaInput, type PageMetaOptions, type PagePathError } from "@/lib/platform-ui/page-admin-shared";
import { cn } from "@/lib/utils";

/**
 * ═══════════ THÔNG TIN TRANG ═══════════
 *
 * Tên · đường dẫn `/p/<slug>` (KHOÁ sau lần xuất bản đầu — liên kết đã gửi đi không được gãy) · module chủ (chỉ
 * module đang bật) · quyền xem tuỳ chọn · menu (bật / nhãn / nhóm / thứ tự). Trang mới (`pageId = null`) tạo ở NHÁP
 * rồi mở thẳng trình soạn nội dung.
 */

type Props = {
  pageId: string | null;
  initial: PageMetaInput | null;
  /** Đã xuất bản ít nhất một lần ⇒ đường dẫn bất biến. */
  slugLocked: boolean;
  takenSlugs: string[];
  options: PageMetaOptions;
  disabled?: boolean;
};

export function PageMetaForm({ pageId, initial, slugLocked, takenSlugs, options, disabled }: Props) {
  const router = useRouter();
  const start = initial ?? blankPageMeta();
  const [meta, setMeta] = useState<PageMetaInput>(start);
  const [slugTouched, setSlugTouched] = useState(pageId !== null);
  const [errors, setErrors] = useState<PagePathError[]>([]);
  const [pending, startTransition] = useTransition();
  const taken = new Set(takenSlugs);
  const dirty = !sameConfig(meta, start);
  const creating = pageId === null;

  const patch = (p: Partial<PageMetaInput>) => setMeta((m) => ({ ...m, ...p }));
  const patchNav = (p: Partial<PageMetaInput["nav"]>) => setMeta((m) => ({ ...m, nav: { ...m.nav, ...p } }));

  const submit = () =>
    startTransition(async () => {
      const input = normalizePageMeta(meta);
      const early = checkPageMeta(input, { takenSlugs: taken, slugLocked, modules: new Set(options.modules.map((m) => m.key)) });
      setErrors(early);
      if (early.length) return;
      try {
        const r = pageId === null ? await createPageAction(input) : await updatePageMetaAction(pageId, input);
        if (!r.ok) {
          setErrors(r.errors);
          return;
        }
        if (creating) {
          toast.success("Đã tạo trang ở NHÁP — thêm khối rồi xuất bản.");
          router.push(`/settings/pages/${encodeURIComponent(r.id)}`);
        } else toast.success("Đã lưu thông tin trang.");
      } catch {
        setErrors([{ path: "_", message: "Không lưu được — thử lại." }]);
      }
    });

  const err = (name: string) => <PathErrors errors={metaErrorsFor(errors, name)} />;
  const known = new Set(["name", "slug", "moduleKey", "requiredPermission", "nav"]);
  const general = errors.filter((e) => !known.has(e.path.split(".")[0]));
  const label = "grid gap-1 text-xs font-medium text-muted-foreground";

  return (
    <div className={cn("space-y-3", pending && "opacity-70")}>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className={label}>
          Tên trang
          <Input
            className="h-8"
            value={meta.name}
            maxLength={120}
            disabled={disabled}
            onChange={(e) => {
              const name = e.target.value;
              patch(slugTouched || slugLocked ? { name } : { name, slug: suggestSlug(name, taken) });
            }}
          />
          {err("name")}
        </label>
        <label className={label}>
          Đường dẫn
          <div className="flex items-center gap-1">
            <span className="font-mono text-[12.5px] text-foreground">/p/</span>
            <Input
              className="h-8 font-mono text-[12.5px]"
              value={meta.slug}
              maxLength={61}
              disabled={disabled || slugLocked}
              title={slugLocked ? "Đã xuất bản — đường dẫn khoá để liên kết đã gửi đi không gãy" : undefined}
              onChange={(e) => {
                setSlugTouched(true);
                patch({ slug: e.target.value.toLowerCase() });
              }}
            />
          </div>
          {slugLocked ? <span className="font-normal">Khoá sau lần xuất bản đầu.</span> : null}
          {err("slug")}
        </label>
        <label className={label}>
          Module chủ
          <select className={SELECT_CLASS} value={meta.moduleKey} disabled={disabled} onChange={(e) => patch({ moduleKey: e.target.value as ModuleKey })}>
            {options.modules.some((m) => m.key === meta.moduleKey) ? null : <option value={meta.moduleKey}>{meta.moduleKey} (đang tắt)</option>}
            {options.modules.map((m) => (
              <option key={m.key} value={m.key}>
                {m.label}
              </option>
            ))}
          </select>
          {err("moduleKey")}
        </label>
        <label className={label}>
          Quyền xem (tuỳ chọn)
          <select className={SELECT_CLASS} value={meta.requiredPermission ?? ""} disabled={disabled} onChange={(e) => patch({ requiredPermission: e.target.value || null })}>
            <option value="">— chỉ cần đăng nhập + module —</option>
            {meta.requiredPermission && !options.permissions.some((p) => p.key === meta.requiredPermission) ? <option value={meta.requiredPermission}>{meta.requiredPermission}</option> : null}
            {options.permissions.map((p) => (
              <option key={p.key} value={p.key}>
                {p.label}
              </option>
            ))}
          </select>
          {err("requiredPermission")}
        </label>
      </div>

      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-hairline px-3 py-2">
        <label className="inline-flex items-center gap-2 self-center text-sm">
          <Tick checked={meta.nav.enabled} disabled={disabled} label="Hiện trên menu" onChange={(v) => patchNav({ enabled: v })} />
          Hiện trên menu
        </label>
        <label className={label}>
          Nhãn menu
          <Input className="h-8 w-48" value={meta.nav.label} placeholder={meta.name || "Theo tên trang"} maxLength={60} disabled={disabled || !meta.nav.enabled} onChange={(e) => patchNav({ label: e.target.value })} />
        </label>
        <label className={label}>
          Nhóm menu
          <select className={SELECT_CLASS} value={meta.nav.zone ?? ""} disabled={disabled || !meta.nav.enabled} onChange={(e) => patchNav({ zone: e.target.value || null })}>
            {options.zones.map((z) => (
              <option key={z.key} value={z.key}>
                {z.label}
              </option>
            ))}
          </select>
        </label>
        <label className={label}>
          Thứ tự
          <Input className="h-8 w-20" type="number" min={0} value={meta.nav.order} disabled={disabled || !meta.nav.enabled} onChange={(e) => patchNav({ order: e.target.value === "" ? 0 : Number(e.target.value) })} />
        </label>
        <div className="basis-full">{err("nav")}</div>
      </div>

      <PathErrors errors={general} />
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={submit} disabled={disabled || pending || (!creating && !dirty)}>
          {creating ? "Tạo trang (nháp)" : "Lưu thông tin"}
        </Button>
        {!creating && dirty ? (
          <>
            <Button size="sm" variant="outline" disabled={pending} onClick={() => setMeta(start)}>
              Bỏ thay đổi
            </Button>
            <span className="text-xs text-amber-700 dark:text-amber-400">Có thay đổi chưa lưu</span>
          </>
        ) : null}
      </div>
    </div>
  );
}
