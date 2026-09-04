"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { updateUserPermissions } from "@/lib/actions/users";
import { PERMISSION_GROUPS, rolePermissions, type RolePermissionMap } from "@/lib/auth/permissions";
import { ROLE_LABEL } from "@/lib/constants/roles";
import type { UserRow } from "@/lib/queries/users";
import { cn } from "@/lib/utils";

/** Lưới checkbox quyền theo module (dùng chung cho tuỳ chỉnh từng người và mẫu vai trò) */
export function PermissionGrid({ value, onChange, disabled, compare }: { value: Set<string>; onChange: (next: Set<string>) => void; disabled?: boolean; compare?: Set<string> }) {
  const toggle = (key: string, on: boolean) => {
    const next = new Set(value);
    if (on) next.add(key);
    else next.delete(key);
    onChange(next);
  };
  return (
    <div className="grid gap-4 md:grid-cols-3">
      {PERMISSION_GROUPS.map((group) => {
        const keys = group.items.map((i) => i.key);
        const all = keys.every((k) => value.has(k));
        return (
          <div key={group.module} className="rounded-lg border p-3">
            <label className="mb-2 flex items-center gap-2 text-sm font-semibold">
              <Checkbox
                disabled={disabled}
                checked={all ? true : keys.some((k) => value.has(k)) ? "indeterminate" : false}
                onCheckedChange={(v) => {
                  const next = new Set(value);
                  for (const k of keys) {
                    if (v === true) next.add(k);
                    else next.delete(k);
                  }
                  onChange(next);
                }}
              />
              {group.module}
            </label>
            <div className="space-y-1.5">
              {group.items.map((item) => {
                const changed = compare ? compare.has(item.key) !== value.has(item.key) : false;
                return (
                  <label key={item.key} className={cn("flex cursor-pointer items-start gap-2 rounded px-1 py-0.5 text-sm hover:bg-muted/60", changed && "bg-amber-50 dark:bg-amber-950/20", disabled && "cursor-default opacity-70")}>
                    <Checkbox className="mt-0.5" disabled={disabled} checked={value.has(item.key)} onCheckedChange={(v) => toggle(item.key, v === true)} />
                    <span>
                      <span className="font-medium">{item.label}</span>
                      {"hint" in item && item.hint ? <span className="block text-[11px] text-muted-foreground">{item.hint}</span> : null}
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Tuỳ chỉnh quyền riêng cho một người dùng */
export function PermissionsDialog({ user, templates, open, onOpenChange }: { user: UserRow; templates: RolePermissionMap; open: boolean; onOpenChange: (open: boolean) => void }) {
  const roleDefaults = useMemo(() => new Set(rolePermissions(user.role, templates)), [user.role, templates]);
  const [custom, setCustom] = useState<boolean>(Array.isArray(user.permissions));
  const [value, setValue] = useState<Set<string>>(new Set(user.permissions ?? roleDefaults));
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  useEffect(() => {
    if (open) {
      setCustom(Array.isArray(user.permissions));
      setValue(new Set(user.permissions ?? roleDefaults));
    }
  }, [open, user.permissions, roleDefaults]);

  const save = () =>
    startTransition(async () => {
      const result = await updateUserPermissions({ id: user.id, permissions: custom ? [...value] : null });
      if ("error" in result) {
        toast.error(result.error);
        return;
      }
      toast.success(custom ? `Đã lưu quyền tuỳ chỉnh cho ${user.name}` : `${user.name} dùng quyền mặc định của vai trò ${ROLE_LABEL[user.role]}`);
      onOpenChange(false);
      router.refresh();
    });

  const isAdmin = user.role === "ADMIN";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Phân quyền: {user.name}</DialogTitle>
          <DialogDescription>
            Vai trò <b>{ROLE_LABEL[user.role]}</b> là mẫu quyền khởi điểm. Bật “Tuỳ chỉnh riêng” để bật/tắt từng quyền cho người này; các ô nền vàng là quyền khác với mẫu vai trò. Quyền có hiệu lực ngay ở lần tải trang tiếp theo.
          </DialogDescription>
        </DialogHeader>
        {isAdmin ? (
          <p className="rounded-md border bg-muted/40 p-3 text-sm">Quản trị viên luôn có toàn quyền. Đổi vai trò (menu Sửa) nếu muốn giới hạn người này.</p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-4 text-sm">
              <label className="flex items-center gap-2">
                <input type="radio" name="perm-mode" checked={!custom} onChange={() => setCustom(false)} /> Theo vai trò {ROLE_LABEL[user.role]} (mặc định)
              </label>
              <label className="flex items-center gap-2">
                <input type="radio" name="perm-mode" checked={custom} onChange={() => setCustom(true)} /> Tuỳ chỉnh riêng
              </label>
              {custom ? (
                <Button type="button" size="sm" variant="ghost" onClick={() => setValue(new Set(roleDefaults))}>
                  Lấy lại theo vai trò
                </Button>
              ) : null}
            </div>
            <PermissionGrid value={custom ? value : roleDefaults} onChange={setValue} disabled={!custom} compare={custom ? roleDefaults : undefined} />
          </>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Huỷ
          </Button>
          {!isAdmin ? (
            <Button type="button" onClick={save} disabled={pending}>
              {pending ? <Loader2 className="size-4 animate-spin" /> : null} Lưu
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
