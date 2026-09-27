"use client";

import { useMemo, useState } from "react";
import { X } from "lucide-react";
import { Input } from "@/components/ui/input";

export type PickablePerson = { id: string; name: string; email: string };

/**
 * Ô chọn NHIỀU người để tag vào topic: gõ tìm theo tên / email, tích từng người, hoặc "Chọn tất cả đang lọc"
 * để tag cả nhóm một lượt. Người đã chọn hiện thành thẻ có nút bỏ.
 */
export function PeoplePicker({ people, value, onChange, disabled }: { people: PickablePerson[]; value: string[]; onChange: (ids: string[]) => void; disabled?: boolean }) {
  const [q, setQ] = useState("");
  const chon = useMemo(() => new Set(value), [value]);
  const byId = useMemo(() => new Map(people.map((p) => [p.id, p])), [people]);
  const loc = useMemo(() => {
    const k = q.trim().toLowerCase();
    return k ? people.filter((p) => p.name.toLowerCase().includes(k) || p.email.toLowerCase().includes(k)) : people;
  }, [people, q]);

  const bat = (id: string) => onChange(chon.has(id) ? value.filter((x) => x !== id) : [...value, id]);
  const chonHet = () => onChange([...new Set([...value, ...loc.map((p) => p.id)])]);
  const boHetLoc = () => {
    const bo = new Set(loc.map((p) => p.id));
    onChange(value.filter((x) => !bo.has(x)));
  };

  return (
    <div className="space-y-2">
      {value.length ? (
        <ul className="flex flex-wrap gap-1.5">
          {value.map((id) => {
            const p = byId.get(id);
            return (
              <li key={id} className="flex items-center gap-1 rounded-full border bg-muted/50 py-0.5 pl-2.5 pr-1 text-xs">
                {p ? p.name || p.email : id}
                {disabled ? null : (
                  <button type="button" aria-label={`Bỏ ${p?.name || id}`} onClick={() => bat(id)} className="rounded-full p-0.5 hover:bg-muted">
                    <X className="size-3" />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Tìm người theo tên / email…" className="h-8 max-w-xs" disabled={disabled} />
        <button type="button" onClick={chonHet} disabled={disabled || !loc.length} className="text-xs text-primary hover:underline disabled:opacity-50">
          Chọn tất cả đang lọc ({loc.length})
        </button>
        {value.length ? (
          <button type="button" onClick={boHetLoc} disabled={disabled} className="text-xs text-muted-foreground hover:underline">
            Bỏ chọn đang lọc
          </button>
        ) : null}
      </div>
      <ul className="max-h-48 overflow-y-auto rounded-md border text-sm">
        {loc.length ? (
          loc.map((p) => (
            <li key={p.id}>
              <label className="flex cursor-pointer items-center gap-2 px-2.5 py-1.5 hover:bg-muted/50">
                <input type="checkbox" checked={chon.has(p.id)} onChange={() => bat(p.id)} disabled={disabled} className="size-4" />
                <span className="font-medium">{p.name || "—"}</span>
                <span className="truncate text-xs text-muted-foreground">{p.email}</span>
              </label>
            </li>
          ))
        ) : (
          <li className="px-2.5 py-2 text-xs text-muted-foreground">Không có ai khớp.</li>
        )}
      </ul>
    </div>
  );
}
