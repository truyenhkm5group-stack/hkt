"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  COPILOT_MAX_REPLY_CHARS,
  COPILOT_REJECT_LABEL,
  COPILOT_REJECT_REASONS,
  isMeaningfulEdit,
  type CopilotRejectReason,
} from "@/lib/constants/sales-copilot";
import { regenerateSuggestion, rejectCopilotSuggestion, releaseConversation, sendCopilotReply, takeoverConversation } from "@/lib/actions/sales-copilot";

/**
 * MỘT HỘI THOẠI TRONG HÀNG ĐỢI — ưu tiên TỐC ĐỘ THAO TÁC, không ưu tiên đẹp.
 *
 * Người bán hàng đang trực chat sẽ mở màn hình này cả buổi. Nên mọi thứ họ cần để quyết định nằm
 * TRÊN MỘT MÀN HÌNH, không phải sau một cú bấm mở rộng: tin khách, câu máy soạn, và DỮ KIỆN máy
 * chủ đã dùng để soạn nó. Giấu dữ kiện đi thì họ phải tin câu chữ mà không kiểm được — đúng thứ
 * nấc trợ lý sinh ra để tránh.
 *
 * Ô soạn là một `textarea` mang sẵn câu máy soạn: sửa xong bấm "Sửa & gửi", không sửa thì bấm
 * "Gửi nguyên văn". Máy chủ tự so hai chuỗi để biết có sửa hay không — giao diện KHÔNG khai báo
 * hộ, vì một cờ do client gửi lên thì client nào cũng đặt được.
 */
export type SendCardProps = {
  conversationId: string;
  suggestionId: string | null;
  suggestedReply: string;
  stale: string | null;
  humanTakeover: boolean;
  canRelease: boolean;
};

export function SendCard({ conversationId, suggestionId, suggestedReply, stale, humanTakeover, canRelease }: SendCardProps) {
  const [text, setText] = useState(suggestedReply);
  const [rejecting, setRejecting] = useState(false);
  const [pending, start] = useTransition();
  const daSua = text.trim() !== suggestedReply.trim();

  const chay = (fn: () => Promise<{ ok: true } | { error: string }>, thanhCong: string) =>
    start(async () => {
      const result = await fn();
      if ("error" in result) toast.error(result.error);
      else toast.success(thanhCong);
    });

  if (humanTakeover) {
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/50 bg-amber-50 p-3 text-xs dark:bg-amber-950/40">
        <span className="font-semibold text-amber-800 dark:text-amber-200">Nhân viên đang cầm hội thoại này — máy không soạn gì thêm.</span>
        {canRelease ? (
          <Button size="sm" variant="outline" disabled={pending} onClick={() => chay(() => releaseConversation({ conversationId }), "Đã trả lại cho máy")}>
            Trả lại cho máy
          </Button>
        ) : (
          <span className="text-muted-foreground">Chỉ người đang cầm việc mới trả lại được.</span>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={4}
        maxLength={COPILOT_MAX_REPLY_CHARS}
        placeholder="Câu gửi cho khách"
        className="w-full rounded-md border border-border bg-background p-2 text-sm"
      />
      <div className="flex flex-wrap items-center gap-2">
        {/*
          HAI NÚT GỬI, MỘT ĐƯỜNG GHI. Cả hai gọi cùng một Server Action với câu trong ô soạn; máy
          chủ so với câu gốc để biết là "gửi nguyên văn" hay "sửa & gửi". Nút chỉ đổi NHÃN theo
          trạng thái ô soạn, để người bấm biết mình đang làm gì.
        */}
        <Button
          size="sm"
          disabled={pending || !text.trim() || Boolean(stale) || !suggestionId}
          onClick={() => chay(() => sendCopilotReply({ suggestionId, finalText: text }), daSua ? "Đã sửa và gửi" : "Đã gửi nguyên văn")}
        >
          {pending ? "Đang gửi…" : daSua ? "Sửa & gửi" : "Gửi nguyên văn"}
        </Button>
        <Button size="sm" variant="outline" disabled={pending} onClick={() => chay(() => regenerateSuggestion({ conversationId }), "Đã xếp việc soạn lại")}>
          Soạn lại
        </Button>
        <Button size="sm" variant="outline" disabled={pending || !suggestionId} onClick={() => setRejecting((v) => !v)}>
          Từ chối
        </Button>
        <Button size="sm" variant="outline" disabled={pending} onClick={() => chay(() => takeoverConversation({ conversationId }), "Đã nhận việc")}>
          Tự nhận việc
        </Button>
        {stale ? <span className="text-[11px] font-semibold text-rose-600 dark:text-rose-400">{stale} — bấm “Soạn lại” trước khi gửi</span> : null}
        {/*
          SỬA NHẸ KHÁC SỬA ĐÁNG KỂ. Đổi một dấu câu không nói lên điều gì về chất lượng câu máy
          soạn; viết lại nửa câu thì có. Hiện ngay tại chỗ để người bấm biết lần sửa của mình sẽ
          được đếm vào đâu.
        */}
        {daSua ? (
          <span className="text-[11px] text-muted-foreground">
            {isMeaningfulEdit(suggestedReply, text) ? "đã sửa ĐÁNG KỂ so với câu máy soạn" : "sửa nhẹ so với câu máy soạn"}
          </span>
        ) : null}
      </div>

      {/*
        TỪ CHỐI LÀ MỘT CÚ BẤM. Bắt nhân viên gõ một đoạn giải thích thì họ bỏ qua ô ấy, và ta mất
        luôn dữ liệu — mà đây chính là dữ liệu nói cho ta biết máy hay hỏng ở đâu nhất.
      */}
      {rejecting ? (
        <div className="flex flex-wrap gap-1 rounded-lg border border-border/60 p-2">
          {COPILOT_REJECT_REASONS.map((r: CopilotRejectReason) => (
            <button
              key={r}
              type="button"
              disabled={pending}
              onClick={() =>
                chay(async () => {
                  const result = await rejectCopilotSuggestion({ suggestionId, reason: r });
                  if ("ok" in result) setRejecting(false);
                  return result;
                }, "Đã ghi lý do từ chối")
              }
              className="rounded border border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:border-rose-500 hover:text-rose-600"
            >
              {COPILOT_REJECT_LABEL[r]}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
