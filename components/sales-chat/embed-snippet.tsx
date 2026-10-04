"use client";

import { Copy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

/** Thẻ script nhúng ô chat vào website của shop (lib/sales-chatbot/widget.ts) + nút chép. */
export function EmbedSnippet({ snippet }: { snippet: string }) {
  return (
    <div className="space-y-1.5" data-testid="chat-embed-snippet">
      <p className="text-sm font-medium">Gắn ô chat vào website của shop</p>
      <p className="text-xs text-muted-foreground">
        Dán dòng dưới đây vào website (trước thẻ &lt;/body&gt;, hoặc ô «Mã nhúng / Custom code» của Haravan, Sapo Web, WordPress…). Góc
        màn hình hiện nút chat; khách bấm là chat với bot ngay, không rời trang.
      </p>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-md bg-muted px-2 py-1.5 text-[11px]" title={snippet}>
          {snippet}
        </code>
        <Button type="button" size="sm" variant="outline" onClick={() => void navigator.clipboard?.writeText(snippet).then(() => toast.success("Đã chép mã nhúng"))}>
          <Copy className="size-3.5" /> Chép
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Tuỳ chọn: thêm <code>data-color=&quot;#e11d48&quot;</code> (màu nút), <code>data-position=&quot;left&quot;</code> (góc trái),{" "}
        <code>data-label=&quot;Hỏi giá ngay&quot;</code> (chữ cạnh nút) vào thẻ script.
      </p>
    </div>
  );
}
