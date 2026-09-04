"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function CopyButton({ value, label, className }: { value: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="ghost"
      size={label ? "sm" : "icon"}
      className={cn("h-7 text-muted-foreground", !label && "size-7", className)}
      onClick={async (e) => {
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          toast.success("Đã sao chép");
          setTimeout(() => setCopied(false), 1500);
        } catch {
          toast.error("Không sao chép được");
        }
      }}
      aria-label="Sao chép"
    >
      {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
      {label}
    </Button>
  );
}

export function JsonViewer({ value, className }: { value: unknown; className?: string }) {
  const [open, setOpen] = useState(false);
  const text = JSON.stringify(value, null, 2);
  return (
    <div className={cn("rounded-lg border bg-muted/40", className)}>
      <div className="flex items-center justify-between px-3 py-2">
        <button type="button" className="text-xs font-semibold text-muted-foreground hover:text-foreground" onClick={() => setOpen((o) => !o)}>
          {open ? "Ẩn dữ liệu gốc (JSON)" : "Xem dữ liệu gốc (JSON)"}
        </button>
        <CopyButton value={text} />
      </div>
      {open ? <pre className="max-h-[420px] overflow-auto border-t px-3 py-2 font-mono text-[11px] leading-5">{text}</pre> : null}
    </div>
  );
}
