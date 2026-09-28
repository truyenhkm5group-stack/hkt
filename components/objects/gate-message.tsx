import { notFound } from "next/navigation";
import { ShieldAlert } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/ui-bits";
import type { ObjectsFailure } from "@/lib/objects/types";

/**
 * Lời từ chối của cổng bản ghi tuỳ biến (`recordGate`) trên trang: không tồn tại ⇒ 404 (không cho dò khoá / id nào có
 * thật); module tắt / thiếu quyền / phạm vi ⇒ nói rõ VÌ SAO — không trả trang rỗng lặng lẽ.
 */
export function GateMessage({ failure, title }: { failure: ObjectsFailure; title: string }) {
  if (failure.code === "NOT_FOUND" || failure.code === "OBJECT_UNKNOWN") notFound();
  const why = failure.errors.map((e) => e.message).join(" · ");
  return (
    <div className="space-y-5">
      <PageHeader eyebrow="Ứng dụng tuỳ biến" title={title} />
      <EmptyState icon={ShieldAlert} title={failure.code === "MODULE_DISABLED" ? "Module chưa bật cho tổ chức" : "Bạn không mở được màn hình này"} description={why} />
    </div>
  );
}
