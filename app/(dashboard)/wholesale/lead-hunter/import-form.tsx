"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { importLeadsAction } from "@/lib/actions/wholesale";
import type { ImportReport } from "@/lib/wholesale/leads";

export function ImportForm() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [text, setText] = useState("");
  const [report, setReport] = useState<ImportReport | null>(null);
  const onFile = async (f: File | undefined) => {
    if (!f) return;
    if (f.size > 3_000_000) return void toast.error("Tệp quá lớn (tối đa ~3 MB).");
    setText(await f.text());
  };
  return (
    <div className="space-y-2">
      <input type="file" accept=".csv,text/csv" onChange={(e) => onFile(e.target.files?.[0])} className="text-sm" aria-label="Chọn tệp CSV" />
      <Textarea rows={4} placeholder={"Tên,SĐT,Địa chỉ,Tỉnh,Khu vực,Website\nNhà hàng Biển Xanh,0912 345 678,12 Trần Phú,Đà Nẵng,Hải Châu,"} value={text} onChange={(e) => setText(e.target.value)} />
      <Button
        size="sm"
        disabled={pending || !text.trim()}
        onClick={() =>
          start(async () => {
            const r = await importLeadsAction(text);
            if ("error" in r) toast.error(r.error);
            else {
              setReport(r.report);
              toast.success(`Đã nhập ${r.report.created} lead`);
              router.refresh();
            }
          })
        }
      >
        Nhập lead
      </Button>
      {report ? (
        <div className="rounded-md bg-muted/40 p-2 text-sm">
          Tạo mới {report.created} · trùng bỏ qua {report.duplicates} · không liên hệ {report.suppressed}
          {report.errors.length ? (
            <ul className="mt-1 list-disc pl-5 text-xs text-muted-foreground">
              {report.errors.slice(0, 20).map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
