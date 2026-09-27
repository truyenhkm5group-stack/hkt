"use client";

import * as React from "react";
import { BlockPlaceholder } from "@/components/pages/block-placeholder";

/**
 * RÀO LỖI CỦA MỘT KHỐI (G9): lỗi lúc VẼ phía trình duyệt (dữ liệu hình dạng lạ, thư viện biểu đồ ném) dừng ở
 * khối đó — các khối khác và cả trang vẫn đứng. Lỗi phía máy chủ đã được trình phân giải bắt thành `BlockIssue`
 * trước khi tới đây; rào này là lớp thứ hai.
 *
 * Chỉ in mã `digest` (Next gắn cho lỗi máy chủ) cho người chẩn đoán — không bao giờ in `error.message` hay stack.
 */
type Props = { blockId: string; title?: string; diagnose: boolean; children: React.ReactNode };
type State = { failed: boolean; digest: string | null };

export class BlockBoundary extends React.Component<Props, State> {
  state: State = { failed: false, digest: null };

  static getDerivedStateFromError(error: unknown): State {
    const digest = typeof error === "object" && error !== null && typeof (error as { digest?: unknown }).digest === "string" ? (error as { digest: string }).digest : null;
    return { failed: true, digest };
  }

  componentDidCatch() {
    // Cố ý không log chi tiết ra console của trình duyệt người xem — máy chủ đã có nhật ký của nó.
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <BlockPlaceholder
        title={this.props.title}
        diagnose={this.props.diagnose}
        issue={{ code: "DATA_ERROR", blockId: this.props.blockId, message: this.state.digest ? `lỗi khi vẽ khối (mã ${this.state.digest})` : "lỗi khi vẽ khối phía trình duyệt" }}
      />
    );
  }
}
