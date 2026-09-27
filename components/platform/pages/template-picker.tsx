"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { LayoutTemplate } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { createPageFromTemplateAction } from "@/lib/actions/page-admin";
import type { PagePathError } from "@/lib/platform-ui/page-admin-shared";

/**
 * «Tạo từ mẫu» — danh sách mẫu trang; KHÔNG mẫu nào tự tạo (luật 23): chỉ khi người bấm «Tạo nháp» trên một mẫu,
 * và trang sinh ra ở NHÁP (người dùng chưa thấy gì cho tới khi xuất bản). Tạo xong mở thẳng trình soạn của trang.
 */
export function TemplatePicker({ templates }: { templates: { key: string; name: string; description: string }[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<PagePathError[]>([]);
  const [pending, startTransition] = useTransition();

  const create = (key: string) =>
    startTransition(async () => {
      setBusy(key);
      setErrors([]);
      try {
        const r = await createPageFromTemplateAction(key);
        if (r.ok) {
          // Khối mẫu bị bỏ (tổ chức chưa có nguồn / field) và cảnh báo nháp: nói ra nguyên văn, không nuốt (luật 23).
          if (r.notes.length) toast.warning("Đã tạo nháp — có lưu ý", { description: r.notes.map((x) => x.message).join(" · "), duration: 12000 });
          setOpen(false);
          router.push(`/settings/pages/${encodeURIComponent(r.id)}`);
        } else setErrors(r.errors);
      } catch {
        setErrors([{ path: "_", message: "Không tạo được — thử lại." }]);
      } finally {
        setBusy(null);
      }
    });

  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <LayoutTemplate /> Tạo từ mẫu
      </Button>
      <Dialog open={open} onOpenChange={(o) => !pending && setOpen(o)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Tạo trang từ mẫu</DialogTitle>
            <DialogDescription>Trang sinh ra ở NHÁP — sửa, xem trước rồi mới xuất bản. Không mẫu nào tự bật.</DialogDescription>
          </DialogHeader>
          {templates.length === 0 ? (
            <p className="text-sm text-muted-foreground">Chưa có mẫu trang nào trong bản này.</p>
          ) : (
            <ul className="divide-y rounded-lg border">
              {templates.map((t) => (
                <li key={t.key} className="flex items-start gap-3 px-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium">{t.name}</div>
                    <div className="text-xs text-muted-foreground">{t.description}</div>
                  </div>
                  <Button size="xs" disabled={pending} onClick={() => create(t.key)}>
                    {busy === t.key ? "Đang tạo…" : "Tạo nháp"}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {errors.length ? (
            <ul className="space-y-0.5 text-xs text-destructive" role="alert">
              {errors.map((e, i) => (
                <li key={i}>{e.message}</li>
              ))}
            </ul>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
