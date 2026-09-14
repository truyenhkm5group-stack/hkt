"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * ═══════════ SAO CHÉP MỘT GIÁ TRỊ — MỘT NÚT, DÙNG LẠI Ở MỌI MÀN ═══════════
 *
 * CSKH đọc số điện thoại rồi gõ lại sang Pancake, đọc mã vận đơn rồi gõ lại sang trang Viettel
 * Post. Mỗi lần gõ lại là một cơ hội sai một chữ số, và sai một chữ số ở mã vận đơn thì tra ra
 * đơn của người khác. Nút này tồn tại để chuỗi đi thẳng từ CSDL sang clipboard, không qua mắt và
 * ngón tay ai.
 *
 * ─── BỐN LUẬT ───
 *
 *  1. **Chép GIÁ TRỊ, không chép thứ đang vẽ trên màn hình.** `value` phải là chuỗi chuẩn lấy từ
 *     CSDL ("0981234567"), không phải chữ trong ô ("Khách hàng 0981234567 · Đơn #4179"). Nơi gọi
 *     chịu trách nhiệm điều đó; ở đây không cắt, không định dạng lại, không bỏ số 0 đầu.
 *  2. **Bấm nút KHÔNG được kích hoạt dòng.** Nhiều bảng cho bấm cả dòng để mở chi tiết; chặn nổi
 *     bọt ngay tại đây thay vì bắt từng nơi gọi nhớ bọc một `<div onClick={stopPropagation}>`.
 *     Bàn phím cũng đi qua đúng đường này: Enter/Space trên `<button>` phát ra chính sự kiện
 *     click đó.
 *  3. **`what` là DANH TỪ của thứ được chép**, để nhãn trợ năng, tooltip và lời báo cùng nói một
 *     câu ("Sao chép SĐT" · "Đã sao chép SĐT"). Người dùng trình đọc màn hình gặp mười nút
 *     "Sao chép" giống hệt nhau trên một trang thì không nút nào dùng được.
 *  4. **Hỏng thì nói thẳng.** `navigator.clipboard` KHÔNG tồn tại ngoài ngữ cảnh bảo mật (HTTP
 *     thuần, một số WebView), và trình duyệt có thể từ chối quyền. Có đường lui bằng
 *     `document.execCommand`; cả hai cùng hỏng thì báo lỗi, không im lặng giả vờ đã chép.
 */
export function CopyButton({ value, what, label, className }: { value: string; what?: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const ten = what ? `Sao chép ${what}` : "Sao chép";

  async function chep(text: string): Promise<boolean> {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      // Rơi xuống đường lui bên dưới — một lần từ chối quyền không có nghĩa là hết cách.
    }
    try {
      // Đường lui cho ngữ cảnh không bảo mật. `readOnly` + `position: fixed` để trình duyệt di
      // động không bật bàn phím và không cuộn trang khi ô được focus.
      const o = document.createElement("textarea");
      o.value = text;
      o.setAttribute("readonly", "");
      o.style.position = "fixed";
      o.style.top = "0";
      o.style.opacity = "0";
      document.body.appendChild(o);
      o.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(o);
      return ok;
    } catch {
      return false;
    }
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size={label ? "sm" : "icon"}
      className={cn(
        // Mờ vừa đủ để không tranh chỗ với chính con số, rõ hẳn khi rê chuột hoặc khi đi bằng
        // bàn phím. `focus-visible` là bắt buộc: mờ mà không có trạng thái focus thì người dùng
        // bàn phím không biết mình đang đứng ở đâu.
        "h-7 text-muted-foreground opacity-60 transition-opacity hover:opacity-100 focus-visible:opacity-100 group-hover:opacity-100",
        !label && "size-7",
        className,
      )}
      onClick={async (e) => {
        // Dừng cả hai: nổi bọt (dòng cha) và hành vi mặc định (nút nằm trong <a> hoặc <label>).
        e.stopPropagation();
        e.preventDefault();
        if (await chep(value)) {
          setCopied(true);
          toast.success(what ? `Đã sao chép ${what}` : "Đã sao chép");
          setTimeout(() => setCopied(false), 1500);
        } else {
          toast.error(`Không sao chép được${what ? ` ${what}` : ""} — trình duyệt không cho phép. Bôi đen và nhấn Ctrl+C.`);
        }
      }}
      aria-label={ten}
      title={ten}
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
