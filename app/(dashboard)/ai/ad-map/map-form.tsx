"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { setAdProductMapping } from "@/lib/actions/ai-ad-map";

type Choice = { id: string; name: string; code: string };

/**
 * Một dòng = một khoá quảng cáo. Người chọn sản phẩm rồi bấm Lưu; từ đó mọi hội thoại đến từ
 * quảng cáo ấy nhận ra đúng mẫu mà máy không phải đoán lại.
 *
 * Ô trống nghĩa là GỠ ánh xạ — khách sẽ được hỏi lại, chứ không phải trỏ vào một sản phẩm rỗng.
 */
export function MapForm({
  pageId,
  adKey,
  keyKind,
  current,
  choices,
}: {
  pageId: string;
  adKey: string;
  keyKind: string;
  current: string | null;
  choices: Choice[];
}) {
  const [productId, setProductId] = useState(current ?? "");
  const [msg, setMsg] = useState("");
  const [pending, start] = useTransition();

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        className="h-9 min-w-56 rounded-md border border-input bg-background px-2 text-sm"
        value={productId}
        onChange={(e) => setProductId(e.target.value)}
        aria-label={`Sản phẩm cho ${adKey}`}
      >
        <option value="">— chưa trỏ (máy sẽ hỏi lại khách) —</option>
        {choices.map((c) => (
          <option key={c.id} value={c.id}>
            {c.code ? `${c.code} · ` : ""}
            {c.name}
          </option>
        ))}
      </select>
      <Button
        size="sm"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await setAdProductMapping({ pageId, adKey, keyKind, productId: productId || undefined });
            setMsg("error" in r ? r.error : "Đã lưu");
          })
        }
      >
        {pending ? "Đang lưu…" : "Lưu"}
      </Button>
      {msg ? <span className="text-xs text-muted-foreground">{msg}</span> : null}
    </div>
  );
}
