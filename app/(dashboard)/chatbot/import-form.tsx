"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

/**
 * Nạp cấu hình bot từ máy Windows lên VPS. Tệp đọc NGAY TRÊN TRÌNH DUYỆT rồi gửi thẳng qua cửa
 * `/api/chatbot/...` (đã kiểm quyền) tới bot — không đi qua kho mã, không đi qua GitHub, không lưu
 * vào CSDL ERP. Tên đích do danh sách dưới đây quyết định, không theo tên tệp người chọn.
 */
const SLOTS = [
  { key: "bot.env", label: ".env", where: "pancake-gemini-bot\\.env", required: true, hint: "Khoá Gemini, token page, khoá POS, nhịp quét." },
  { key: "pages.json", label: "pages.json", where: "pancake-gemini-bot\\data\\pages.json", required: false, hint: "Cài đặt riêng từng page: hướng dẫn riêng, mẫu chủ lực, bảng size, xả kho." },
  { key: "pages_tokens.json", label: "pages_tokens.json", where: "pancake-gemini-bot\\data\\pages_tokens.json", required: false, hint: "Page đã thêm bằng nút “Thêm page” trong app (token nằm ở đây, không nằm trong .env)." },
  { key: "state.json", label: "state.json", where: "pancake-gemini-bot\\data\\state.json", required: false, hint: "Tin đã trả lời, tin do bot gửi — thiếu thì bot không phân biệt được tin của bot với tin nhân viên." },
  { key: "system.md", label: "system.md", where: "pancake-gemini-bot\\prompts\\system.md", required: false, hint: "Prompt chung đang chạy (nếu đã sửa trong app)." },
] as const;

export function ChatbotImportForm({ firstTime }: { firstTime: boolean }) {
  const router = useRouter();
  const [files, setFiles] = useState<Record<string, File | null>>({});
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const chosen = SLOTS.filter((s) => files[s.key]);
    if (firstTime && !files["bot.env"]) {
      toast.error("Lần đầu phải có tệp .env");
      return;
    }
    if (!chosen.length) {
      toast.error("Chưa chọn tệp nào");
      return;
    }
    setBusy(true);
    try {
      const payload: Record<string, string> = {};
      for (const s of chosen) payload[s.key] = await files[s.key]!.text();
      const res = await fetch("/api/chatbot/api/erp/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ files: payload }) });
      const body = (await res.json().catch(() => ({}))) as { error?: string; written?: string[] };
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      toast.success(`Đã nạp ${body.written?.join(", ")}. Bot đang khởi động lại ở chế độ CHỈ LOG, KHÔNG GỬI.`, { duration: 8000 });
      setFiles({});
      // Bot thoát rồi Docker dựng lại — vài giây.
      setTimeout(() => router.refresh(), 5000);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="grid gap-2">
        {SLOTS.map((s) => (
          <label key={s.key} className="grid gap-1 rounded-md border p-3 sm:grid-cols-[180px_1fr] sm:items-center">
            <div>
              <div className="text-sm font-medium">
                {s.label} {s.required && firstTime ? <span className="text-destructive">*</span> : null}
              </div>
              <div className="font-mono text-[11px] text-muted-foreground">{s.where}</div>
            </div>
            <div className="space-y-1">
              <input type="file" className="block w-full text-sm file:mr-3 file:rounded file:border-0 file:bg-muted file:px-3 file:py-1.5" onChange={(e) => setFiles((f) => ({ ...f, [s.key]: e.target.files?.[0] ?? null }))} />
              <p className="text-xs text-muted-foreground">{s.hint}</p>
            </div>
          </label>
        ))}
      </div>
      <Button onClick={submit} disabled={busy}>
        {busy ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
        Nạp lên bot trên VPS
      </Button>
      <p className="text-xs text-muted-foreground">
        Nạp xong bot LUÔN về chế độ <b>chỉ log, không gửi</b>. Tắt bot trên máy Windows trước, rồi mới bấm “Gửi thật” trong app bên dưới — hai bot cùng chạy thì khách nhận hai câu trả lời.
      </p>
    </div>
  );
}
