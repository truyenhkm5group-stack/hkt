"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { createSupplier, updateSupplier } from "@/lib/actions/suppliers";
import { formatNumber } from "@/lib/format";

export type CatalogSupplier = { id: string; name: string; aliases: string[]; phone: string; note: string; active: boolean };
export type CatalogUnmatched = { name: string; productionOrders: number; receipts: number; ambiguous: boolean };

const tach = (raw: string) =>
  raw
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

/**
 * DANH MỤC XƯỞNG — thêm, sửa, ngừng dùng, và gom các cách gõ cũ về đúng xưởng.
 *
 * "Gộp vào xưởng…" chỉ THÊM một tên gọi khác: không dòng lịch sử nào bị sửa, và gỡ tên đi là tách
 * ra lại. Máy chủ từ chối mọi tên đã thuộc một xưởng khác (một cách gõ, một xưởng).
 */
export function SupplierCatalog({ suppliers, unmatched, canWrite }: { suppliers: CatalogSupplier[]; unmatched: CatalogUnmatched[]; canWrite: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState({ name: "", aliases: "", phone: "", note: "" });
  const [moi, setMoi] = useState({ name: "", aliases: "", phone: "" });

  const run = (fn: () => Promise<{ ok: true; id: string } | { error: string }>, okText: string, after?: () => void) =>
    start(async () => {
      const r = await fn();
      if ("error" in r) toast.error(r.error);
      else {
        toast.success(okText);
        after?.();
        router.refresh();
      }
    });

  const payload = (s: CatalogSupplier, over: Partial<CatalogSupplier> = {}) => ({ name: s.name, aliases: s.aliases, phone: s.phone, note: s.note, active: s.active, ...over });
  const dangDung = suppliers.filter((s) => s.active);

  return (
    <div className="space-y-4">
      <div className="overflow-x-auto">
        <Table className="min-w-[760px]">
          <TableHeader>
            <TableRow>
              <TableHead className="w-[200px]">Xưởng</TableHead>
              <TableHead>Tên gọi khác</TableHead>
              <TableHead className="w-[130px]">Điện thoại</TableHead>
              <TableHead className="w-[110px]">Trạng thái</TableHead>
              {canWrite ? <TableHead className="w-[170px] text-right" /> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {suppliers.map((s) =>
              editing === s.id ? (
                <TableRow key={s.id}>
                  <TableCell>
                    <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} className="h-8" />
                  </TableCell>
                  <TableCell>
                    <Input value={draft.aliases} onChange={(e) => setDraft({ ...draft, aliases: e.target.value })} placeholder="Cách nhau bằng dấu phẩy" className="h-8" />
                  </TableCell>
                  <TableCell>
                    <Input value={draft.phone} onChange={(e) => setDraft({ ...draft, phone: e.target.value })} className="h-8" />
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{s.active ? "Đang dùng" : "Ngừng dùng"}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button size="sm" disabled={pending} onClick={() => run(() => updateSupplier(s.id, payload(s, { name: draft.name, aliases: tach(draft.aliases), phone: draft.phone, note: draft.note })), "Đã lưu xưởng", () => setEditing(null))}>
                        Lưu
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                        Huỷ
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ) : (
                <TableRow key={s.id} className={s.active ? "" : "opacity-60"}>
                  <TableCell className="font-medium">{s.name}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{s.aliases.join(", ") || "—"}</TableCell>
                  <TableCell className="text-xs">{s.phone || "—"}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{s.active ? "Đang dùng" : "Ngừng dùng"}</TableCell>
                  {canWrite ? (
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setEditing(s.id);
                            setDraft({ name: s.name, aliases: s.aliases.join(", "), phone: s.phone, note: s.note });
                          }}
                        >
                          Sửa
                        </Button>
                        <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => updateSupplier(s.id, payload(s, { active: !s.active })), s.active ? "Đã ngừng dùng" : "Đã dùng lại")}>
                          {s.active ? "Ngừng dùng" : "Dùng lại"}
                        </Button>
                      </div>
                    </TableCell>
                  ) : null}
                </TableRow>
              ),
            )}
            {!suppliers.length ? (
              <TableRow>
                <TableCell colSpan={canWrite ? 5 : 4} className="py-6 text-center text-sm text-muted-foreground">
                  Chưa có xưởng nào trong danh mục — thêm bên dưới, hoặc bấm &quot;Thêm làm xưởng mới&quot; ở các tên đang gõ tay.
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </div>

      {canWrite ? (
        <div className="flex flex-wrap items-end gap-2 px-4">
          <div className="space-y-1">
            <p className="text-xs font-medium">Thêm xưởng</p>
            <Input value={moi.name} onChange={(e) => setMoi({ ...moi, name: e.target.value })} placeholder="Tên xưởng" className="h-8 w-48" />
          </div>
          <Input value={moi.aliases} onChange={(e) => setMoi({ ...moi, aliases: e.target.value })} placeholder="Tên gọi khác, cách nhau dấu phẩy" className="h-8 w-64" />
          <Input value={moi.phone} onChange={(e) => setMoi({ ...moi, phone: e.target.value })} placeholder="Điện thoại" className="h-8 w-36" />
          <Button
            size="sm"
            disabled={pending || !moi.name.trim()}
            onClick={() => run(() => createSupplier({ name: moi.name, aliases: tach(moi.aliases), phone: moi.phone }), "Đã thêm xưởng", () => setMoi({ name: "", aliases: "", phone: "" }))}
          >
            Thêm
          </Button>
        </div>
      ) : null}

      {unmatched.length ? (
        <div className="border-t pt-3">
          <p className="px-4 pb-2 text-xs text-muted-foreground">
            <b className="text-foreground">{formatNumber(unmatched.length)} tên xưởng gõ tay chưa quy được về danh mục</b> — các lô và phiếu mang tên này đang đứng riêng
            trên mọi con số theo xưởng. Thêm làm xưởng mới, hoặc gộp vào một xưởng đã có (thành tên gọi khác). Không dòng cũ nào bị sửa.
          </p>
          <div className="overflow-x-auto">
            <Table className="min-w-[700px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Tên đang gõ</TableHead>
                  <TableHead className="w-[110px] text-right">Lô đặt</TableHead>
                  <TableHead className="w-[110px] text-right">Phiếu nhập</TableHead>
                  {canWrite ? <TableHead className="w-[320px] text-right" /> : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {unmatched.map((u) => (
                  <TableRow key={u.name}>
                    <TableCell className="font-medium">
                      {u.name}
                      {u.ambiguous ? <span className="ml-1.5 text-[11px] font-normal text-amber-600 dark:text-amber-400">khớp nhiều xưởng — sửa danh mục</span> : null}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(u.productionOrders)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(u.receipts)}</TableCell>
                    {canWrite ? (
                      <TableCell className="text-right">
                        {u.ambiguous ? null : (
                          <div className="flex justify-end gap-1">
                            <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => createSupplier({ name: u.name }), `Đã thêm xưởng "${u.name}"`)}>
                              Thêm làm xưởng mới
                            </Button>
                            {dangDung.length ? (
                              <select
                                className="h-8 rounded-md border bg-background px-2 text-xs"
                                defaultValue=""
                                disabled={pending}
                                onChange={(e) => {
                                  const s = suppliers.find((x) => x.id === e.target.value);
                                  if (!s) return;
                                  run(() => updateSupplier(s.id, payload(s, { aliases: [...s.aliases, u.name] })), `Đã gộp "${u.name}" vào ${s.name}`);
                                }}
                              >
                                <option value="" disabled>
                                  Gộp vào xưởng…
                                </option>
                                {dangDung.map((s) => (
                                  <option key={s.id} value={s.id}>
                                    {s.name}
                                  </option>
                                ))}
                              </select>
                            ) : null}
                          </div>
                        )}
                      </TableCell>
                    ) : null}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      ) : null}
    </div>
  );
}
