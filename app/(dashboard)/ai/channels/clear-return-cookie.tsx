"use client";

import { useEffect } from "react";
import { CHANNELS_RETURN_COOKIE } from "@/lib/channels/overview-shared";

/**
 * Gỡ cờ «lượt kết nối bắt đầu từ màn Kênh kết nối» khi người dùng vào trang Messenger mà cờ còn sống (lượt bỏ dở, hoặc dừng
 * ở route start trước khi tới callback). Trang máy chủ không xoá được cookie lúc dựng, nên việc này làm ở trình duyệt.
 */
export function ClearChannelsReturn() {
  useEffect(() => {
    document.cookie = `${CHANNELS_RETURN_COOKIE}=; path=/; max-age=0; samesite=lax`;
  }, []);
  return null;
}
