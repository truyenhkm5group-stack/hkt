"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ChatOrderForm } from "@/components/orders/chat-order-form";

/**
 * «Tạo đơn» trên một dòng hội thoại (POS tự chủ · P5) — lối bấm TẠM cho form tạo đơn trong khung chat, cho tới khi hộp thư M8
 * gắn `ChatOrderForm` cạnh khung tin nhắn. Form chỉ được dựng khi mở (không hỏi máy chủ cho từng dòng danh sách).
 */
export function ChatOrderButton({ conversationId, customerId }: { conversationId: string; customerId: string | null }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="outline" className="h-7" onClick={() => setOpen(true)}>
        Tạo đơn
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent className="flex w-full flex-col overflow-y-auto sm:max-w-xl">
          <SheetHeader>
            <SheetTitle>Tạo đơn từ hội thoại</SheetTitle>
            <SheetDescription>Đơn của người bán (không phải bot) — gắn về hội thoại này để báo cáo AI / người đếm đúng.</SheetDescription>
          </SheetHeader>
          <div className="px-4 pb-4">{open ? <ChatOrderForm conversationId={conversationId} defaults={{ customerId }} /> : null}</div>
        </SheetContent>
      </Sheet>
    </>
  );
}
