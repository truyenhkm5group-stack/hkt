"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { saveEmailAllowedCountriesAction } from "@/lib/actions/wholesale-routing";

/**
 * Cổng pháp lý theo nước cho thư chào hàng (issue #1085). Nước chưa tick ⇒ thư tới nước đó chỉ chạy thử; gửi thật thì nằm chờ
 * «chưa rà luật nước X». Chỉ quản trị sửa, bắt buộc lý do (vào nhật ký audit).
 */
export function EmailCountriesPanel({ allowed, choices, canEdit }: { allowed: string[]; choices: readonly { code: string; label: string }[]; canEdit: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [picked, setPicked] = useState<string[]>(allowed);
  const [reason, setReason] = useState("");
  const toggle = (code: string) => setPicked((p) => (p.includes(code) ? p.filter((c) => c !== code) : [...p, code]));
  const changed = [...picked].sort().join(",") !== [...allowed].sort().join(",");
  return (
    <div className="space-y-3 text-sm">
      <p className="rounded-md bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">
        Chỉ tick nước ĐÃ RÀ LUẬT thư chào hàng (thư lạnh B2B) — mặc định không nước nào, kể cả Việt Nam. Nước chưa tick: thư vẫn chạy thử được, nhưng khi bật gửi thật sẽ nằm chờ với lý do «chưa rà luật nước X». Đây là ghi nhận kỹ thuật, không phải ý kiến pháp lý.
      </p>
      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 lg:grid-cols-4">
        {choices.map((c) => (
          <label key={c.code} className="flex items-center gap-2">
            <input type="checkbox" checked={picked.includes(c.code)} disabled={!canEdit || pending} onChange={() => toggle(c.code)} />
            <span>
              {c.label} <span className="text-muted-foreground">({c.code})</span>
            </span>
          </label>
        ))}
      </div>
      {canEdit ? (
        <div className="flex flex-wrap items-center gap-2">
          <Input className="max-w-md" placeholder="Lý do — đã rà luật nước nào, ai rà, căn cứ gì (bắt buộc)" value={reason} onChange={(e) => setReason(e.target.value)} />
          <Button
            size="sm"
            disabled={pending || !changed}
            onClick={() =>
              start(async () => {
                const r = await saveEmailAllowedCountriesAction({ countries: picked, reason });
                if ("error" in r) toast.error(r.error);
                else {
                  toast.success(`Đã lưu ${r.countries.length} nước đã rà luật`);
                  setReason("");
                  router.refresh();
                }
              })
            }
          >
            Lưu danh sách nước
          </Button>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">Chỉ quản trị (chủ shop) sửa được danh sách này.</p>
      )}
    </div>
  );
}
