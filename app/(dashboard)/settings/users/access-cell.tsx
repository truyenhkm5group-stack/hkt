"use client";

/**
 * Ô "Quyền & phạm vi" trên bảng Người dùng, và hộp thoại sửa ba chiều.
 *
 * Ba chiều hiện cạnh nhau chứ không gộp thành một dòng: gộp lại là quay về đúng cái ERP vừa thoát
 * ra — một ô duy nhất phải gánh ba câu hỏi khác nhau. Chip trống ("chưa đặt") cũng là thông tin.
 */
import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, ShieldAlert, ShieldCheck, SlidersHorizontal } from "lucide-react";
import { toast } from "sonner";
import { PickerMenu } from "@/components/picker-menu";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { previewUserAccess, setUserAccess } from "@/lib/actions/access";
import { ACCESS_SCOPE_HINT, ACCESS_SCOPE_LABEL, ACCESS_SCOPE_TONE, ACCESS_SCOPES, type AccessScope } from "@/lib/constants/access-scope";
import { cn } from "@/lib/utils";

const badge = "inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-0.5 text-[11.5px] font-semibold leading-5";

export type AccessOption = { id: string; name: string; hint?: string };

export type UserAccessView = {
  accessRoleId: string | null;
  accessRoleName: string;
  positionId: string | null;
  positionName: string;
  scope: AccessScope;
};

type PreviewState = {
  permissions: string[];
  dropped: { permission: string; area: string; reason: string }[];
  sourceLabel: string;
  granted: { key: string; label: string }[];
  sensitive: { area: string; department: string; reason: string; allowed: boolean }[];
  departmentCodes: string[];
  departments: { code: string; name: string; isLead: boolean }[];
  resources: { key: string; label: string; read: boolean; write: boolean; sensitive: boolean; note: string }[];
};

export function AccessCell({
  userId,
  userName,
  isAdmin,
  view,
  roles,
  positions,
}: {
  userId: string;
  userName: string;
  isAdmin: boolean;
  view: UserAccessView;
  roles: AccessOption[];
  positions: AccessOption[];
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="group flex flex-col items-start gap-1 text-left" aria-label={`Sửa quyền và phạm vi của ${userName}`}>
        <span className={cn(badge, ACCESS_SCOPE_TONE[view.scope])}>{ACCESS_SCOPE_LABEL[view.scope]}</span>
        <span className="text-[10.5px] text-muted-foreground group-hover:underline">
          {view.accessRoleName ? `Vai trò: ${view.accessRoleName}` : "Vai trò hệ thống"}
          {" · "}
          {view.positionName || "chưa có chức danh"}
        </span>
      </button>
      {open ? <AccessDialog userId={userId} userName={userName} isAdmin={isAdmin} view={view} roles={roles} positions={positions} open={open} onOpenChange={setOpen} /> : null}
    </>
  );
}

function AccessDialog({
  userId,
  userName,
  isAdmin,
  view,
  roles,
  positions,
  open,
  onOpenChange,
}: {
  userId: string;
  userName: string;
  isAdmin: boolean;
  view: UserAccessView;
  roles: AccessOption[];
  positions: AccessOption[];
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const [roleId, setRoleId] = useState(view.accessRoleId ?? "");
  const [positionId, setPositionId] = useState(view.positionId ?? "");
  const [scope, setScope] = useState<AccessScope>(view.scope);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [loading, setLoading] = useState(false);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  /*
    Xem trước chạy lại mỗi lần đổi vai trò hoặc phạm vi — TRƯỚC khi lưu. Chức danh không nằm trong
    danh sách phụ thuộc vì chức danh không sinh quyền: nếu một ngày đổi chức danh làm số quyền
    nhảy, thì hoặc luật đã bị phá, hoặc màn hình này đang nói dối.
  */
  useEffect(() => {
    let huy = false;
    setLoading(true);
    previewUserAccess({ userId, accessRoleId: roleId || null, scope })
      .then((r) => {
        if (huy) return;
        if ("error" in r) {
          setPreview(null);
          return;
        }
        setPreview(r.preview);
      })
      .finally(() => {
        if (!huy) setLoading(false);
      });
    return () => {
      huy = true;
    };
  }, [userId, roleId, scope]);

  const save = () =>
    startTransition(async () => {
      const result = await setUserAccess({ userId, accessRoleId: roleId, positionId, scope });
      if ("error" in result) {
        toast.error(result.error);
        return;
      }
      toast.success(`Đã cập nhật quyền & phạm vi của ${userName}`);
      onOpenChange(false);
      router.refresh();
    });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Quyền & phạm vi — {userName}</DialogTitle>
          <DialogDescription>
            Vai trò nói ĐƯỢC LÀM GÌ · chức danh nói LÀM CHỨC GÌ · phạm vi nói TRÊN DỮ LIỆU NÀO. Ba thứ khác nhau, ERP không suy cái này ra cái kia.
          </DialogDescription>
        </DialogHeader>

        {isAdmin ? (
          <p className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200">
            Quản trị viên luôn có toàn quyền trên toàn công ty. Đặt vai trò tuỳ chỉnh hay phạm vi hẹp cho họ sẽ hiện một giới hạn <strong>không có thật</strong> — hạ vai trò hệ thống trước nếu muốn giới hạn.
          </p>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Vai trò tuỳ chỉnh" hint="Bó quyền do chủ shop đặt tên. Bỏ trống = dùng mẫu quyền của vai trò hệ thống.">
            <PickerMenu
              label={roles.find((r) => r.id === roleId)?.name ?? "Vai trò hệ thống"}
              options={[{ value: "", label: "Vai trò hệ thống", hint: "Mẫu quyền mặc định theo vai trò", checked: !roleId }, ...roles.map((r) => ({ value: r.id, label: r.name, hint: r.hint, checked: r.id === roleId }))]}
              onPick={setRoleId}
              disabled={isAdmin}
              align="start"
              className="w-full"
            />
          </Field>
          <Field label="Chức danh" hint="Chỉ là nhãn tổ chức. KHÔNG sinh thêm một quyền nào.">
            <PickerMenu
              label={positions.find((p) => p.id === positionId)?.name ?? "Chưa đặt"}
              options={[{ value: "", label: "Chưa đặt", checked: !positionId }, ...positions.map((p) => ({ value: p.id, label: p.name, hint: p.hint, checked: p.id === positionId }))]}
              onPick={setPositionId}
              align="start"
              className="w-full"
            />
          </Field>
          <Field label="Phạm vi dữ liệu" hint={ACCESS_SCOPE_HINT[scope]}>
            <PickerMenu
              label={ACCESS_SCOPE_LABEL[scope]}
              options={ACCESS_SCOPES.map((s) => ({ value: s, label: ACCESS_SCOPE_LABEL[s], hint: ACCESS_SCOPE_HINT[s], checked: s === scope }))}
              onPick={(v) => setScope(v as AccessScope)}
              disabled={isAdmin}
              align="start"
              className="w-full"
            />
          </Field>
        </div>

        <section className="rounded-lg border bg-muted/30 p-3">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <SlidersHorizontal className="size-4" /> Sau khi cộng vai trò + phạm vi, người này thực tế được gì
            {loading ? <Loader2 className="size-3.5 animate-spin text-muted-foreground" /> : null}
          </h3>
          {preview ? (
            <div className="mt-2 space-y-3">
              <p className="text-xs text-muted-foreground">
                Nguồn bó quyền: <strong>{preview.sourceLabel}</strong> · {preview.permissions.length} quyền còn hiệu lực
                {preview.departments.length
                  ? ` · ${preview.departments.map((d) => (d.isLead ? `${d.name} (trưởng phòng)` : d.name)).join(" · ")}`
                  : " · chưa thuộc phòng ban nào"}
              </p>

              {/*
                BẢNG NÀY LÀ CÂU TRẢ LỜI CUỐI CÙNG. Danh sách quyền ở dưới nói người này CẦM những
                khoá nào; bảng này nói những khoá ấy MỞ ĐƯỢC CÁI GÌ sau khi phạm vi đã cắt. Chủ shop
                hỏi câu thứ hai, không phải câu thứ nhất.
              */}
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Thực tế đọc / sửa được gì</div>
                <div className="mt-1 overflow-hidden rounded-md border">
                  <table className="w-full text-[11.5px]">
                    <tbody className="divide-y">
                      {preview.resources.map((r) => (
                        <tr key={r.key} className={cn(!r.read && "opacity-55")}>
                          <td className="w-[38%] px-2 py-1 font-medium">
                            {r.label}
                            {r.sensitive ? <span className="ml-1 text-[10px] font-semibold text-amber-600">nhạy cảm</span> : null}
                          </td>
                          <td className="w-[86px] px-2 py-1 whitespace-nowrap">
                            {r.read ? <span className="text-emerald-700 dark:text-emerald-400">đọc</span> : <span className="text-muted-foreground">—</span>}
                            {r.write ? <span className="ml-1 text-amber-700 dark:text-amber-400">· sửa</span> : null}
                          </td>
                          <td className="px-2 py-1 text-[10.5px] leading-snug text-muted-foreground">{r.note}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div>
                <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Vùng nhạy cảm</div>
                <ul className="mt-1 space-y-1">
                  {preview.sensitive.map((s) => (
                    <li key={s.area} className="flex items-start gap-2 text-xs">
                      {s.allowed ? <ShieldAlert className="mt-0.5 size-3.5 shrink-0 text-amber-600" /> : <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-emerald-600" />}
                      <span>
                        <strong>{s.area}</strong> — {s.allowed ? "chạm được" : "không chạm được"}. {s.reason}.
                      </span>
                    </li>
                  ))}
                </ul>
              </div>

              {preview.dropped.length ? (
                <div>
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Phạm vi đã cắt {preview.dropped.length} quyền</div>
                  <ul className="mt-1 space-y-1 text-xs text-muted-foreground">
                    {preview.dropped.map((d) => (
                      <li key={d.permission}>
                        <strong>{d.area}</strong> · {d.reason}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              <details className="text-xs">
                <summary className="cursor-pointer font-semibold text-muted-foreground">Danh sách {preview.granted.length} quyền còn hiệu lực</summary>
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {preview.granted.map((g) => (
                    <span key={g.key} className="rounded bg-background px-1.5 py-0.5 text-[10.5px] ring-1 ring-border">
                      {g.label}
                    </span>
                  ))}
                </div>
              </details>
            </div>
          ) : (
            <p className="mt-2 text-xs text-muted-foreground">{loading ? "Đang tính…" : "Chưa tính được — thử mở lại."}</p>
          )}
        </section>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Huỷ
          </Button>
          <Button onClick={save} disabled={pending || isAdmin}>
            {pending ? <Loader2 className="size-4 animate-spin" /> : null} Lưu
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, hint, children }: { label: string; hint: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
      {children}
      <p className="text-[10.5px] leading-snug text-muted-foreground">{hint}</p>
    </div>
  );
}
