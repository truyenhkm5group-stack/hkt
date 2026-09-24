import { PageHeader } from "@/components/page-header";
import { SectionCard } from "@/components/ui-bits";
import { requirePermission } from "@/lib/auth/session";
import { formatDateTime } from "@/lib/format";
import { getChatbotStatus } from "@/lib/integrations/chatbot/client";
import { ChatbotImportForm } from "@/app/(dashboard)/chatbot/import-form";

export const metadata = { title: "Bot chat bán hàng" };
export const dynamic = "force-dynamic";

/**
 * Bot chat bán hàng (Pancake + Gemini) chạy 24/7 trong container `erp-chatbot` trên VPS. Trang này
 * gác cửa và nhúng NGUYÊN giao diện quản trị của bot — cài đặt page, prompt, chat thử, hội thoại,
 * nhật ký — để mọi chốt chặn đã chạy thật trên máy Windows giữ nguyên, không viết lại lần hai.
 */
export default async function ChatbotPage() {
  await requirePermission("cs:config");
  const status = await getChatbotStatus();

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Bán hàng · chốt đơn"
        title="Bot chat bán hàng"
        description="Bot tự trả lời khách trên fanpage qua Pancake, tự ghi đơn nháp vào POS — chạy 24/7 trên VPS."
        hint="Mã bot nằm ở thư mục chatbot/ của kho. Khoá (Gemini, token page, POS) chỉ nằm trên VPS, nạp từ trang này — không bao giờ vào kho mã."
      />

      {status.state === "UNREACHABLE" ? (
        <SectionCard title="Bot chưa chạy trên VPS">
          <p className="text-sm">{status.error}</p>
          <p className="mt-2 text-xs text-muted-foreground">Chạy workflow “Deploy ERP to VPS” để dựng container erp-chatbot, rồi mở lại trang này.</p>
        </SectionCard>
      ) : null}

      {status.state === "NEEDS_SETUP" ? (
        <SectionCard title="Bước 1 — Nạp cấu hình từ máy Windows" description="Bot đã chạy trên VPS nhưng chưa có khoá, đang ở chế độ chờ nạp: không đọc tin khách, không gọi AI.">
          <ChatbotImportForm firstTime />
        </SectionCard>
      ) : null}

      {status.state === "RUNNING" ? (
        <>
          <div className="overflow-hidden rounded-lg border bg-[#0b0f14]">
            <iframe src="/api/chatbot/admin" title="Quản lý bot chat" className="block h-[calc(100vh-190px)] min-h-[640px] w-full" />
          </div>
          <details className="rounded-lg border p-4">
            <summary className="cursor-pointer text-sm font-medium">Nạp lại dữ liệu từ máy Windows · tệp đang có trên VPS</summary>
            <ul className="mt-3 grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
              {status.files.map((f) => (
                <li key={f.name}>
                  <span className="font-mono">{f.name}</span>: {f.present ? `${Math.max(1, Math.round(f.bytes / 1024))} KB · ${f.updatedAt ? formatDateTime(f.updatedAt) : "—"}` : "chưa có"}
                </li>
              ))}
            </ul>
            <div className="mt-4">
              <ChatbotImportForm firstTime={false} />
            </div>
          </details>
        </>
      ) : null}
    </div>
  );
}
