import type { ComponentProps } from "react";
import { SyncButton } from "@/components/sync-button";
import { syncJobVisible, type ModuleViewer } from "@/lib/platform-ui/module-visibility";

/**
 * Nút «Đồng bộ …» chỉ hiện khi tổ chức của người xem có nguồn của job đó (`syncJobVisible` — MỘT điều kiện theo năng lực
 * tổ chức, lib/platform-ui/module-visibility.ts). Tổ chức nhà bật mọi connector ⇒ nút y như cũ. Dùng ở Server Component
 * (nhận `user` làm `viewer`); ẩn không phải bảo mật — cổng thật vẫn ở `/api/sync/<job>` và `runJob`.
 */
export function ModuleSyncButton({ viewer, ...props }: { viewer: ModuleViewer } & ComponentProps<typeof SyncButton>) {
  return syncJobVisible(viewer, props.job) ? <SyncButton {...props} /> : null;
}
