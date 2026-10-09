/**
 * ═══════════ VỎ CHỐT ĐƠN KHÔNG CÓ CHỮ DƯỚI 11 PX (docs/design-system.md mục 10 · Commercial Sweep PR B) ═══════════
 *
 * Khách Chốt Đơn mở app trên điện thoại. Harness 08/10/2026 đo 147× `text-[10px]` + 318× `10.5px` trong app/ + components/, và
 * ba chỗ nằm ngay trong hộp thư của khách (nhãn thẻ lịch sử đơn, dòng tác giả ghi chú). Bài kiểm là CÁI CHỐT, không phải lượt
 * dọn cả kho: chỉ quét bề mặt CHỈ thuộc vỏ — trang dùng chung với ERP (Sản phẩm, Đơn hàng, Khách hàng, Phiếu nhập) mang bảng dày
 * và cần quyết định mật độ riêng. Dưới 11 px chỉ được ở chỗ khai miễn trừ kèm lý do; miễn trừ không còn khớp ⇒ đỏ.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** Bề mặt CHỈ thuộc vỏ Chốt Đơn (lib/constants/saas-nav.ts), không dùng chung trang với ERP. */
export const SHELL_ONLY_SURFACES = [
  "app/(dashboard)/ai/overview/",
  "app/(dashboard)/ai/sales-chatbot/",
  "app/(dashboard)/ai/channels/",
  "app/(dashboard)/settings/plan/",
  "app/(dashboard)/settings/ai-balance/",
  "app/(dashboard)/settings/shop/",
  "app/(dashboard)/settings/profile/",
  "app/(dashboard)/settings/branding/",
  "app/(dashboard)/settings/notifications/",
  "app/(dashboard)/settings/data-export/",
  "app/(dashboard)/billing-locked/",
  "app/(dashboard)/setup/",
  "app/(dashboard)/help/",
  "components/sales-chat/",
  "components/onboarding/",
] as const;

/** `tệp::cỡ` ⇒ lý do. Chỉ cho một ký tự trong huy hiệu tròn ≤ 16 px. */
const MIEN_TRU: Record<string, string> = {
  "app/(dashboard)/ai/sales-chatbot/inbox/avatar.tsx::9": "Chấm kênh trên ảnh đại diện: MỘT ký tự trong huy hiệu tròn size-4 (16 px) — trang trí, tên kênh đọc ở dòng hội thoại.",
};

const CHU_NHO = /text-\[(\d+(?:\.\d+)?)px\]/g;

export function testShellTypography() {
  const tep = execFileSync("git", ["ls-files", ...SHELL_ONLY_SURFACES], { encoding: "utf8" })
    .split("\n")
    .filter((f) => f.endsWith(".tsx"));
  assert.ok(tep.length >= 30, `phải thấy các tệp của vỏ (hộp thư, AI Sales, kênh, gói…) — mới thấy ${tep.length}: danh sách bề mặt có thể đã lệch`);

  const pham: string[] = [];
  const daDung = new Set<string>();
  for (const f of tep) {
    for (const m of readFileSync(f, "utf8").matchAll(CHU_NHO)) {
      const co = Number(m[1]);
      if (co >= 11) continue;
      const khoa = `${f}::${m[1]}`;
      if (MIEN_TRU[khoa]) daDung.add(khoa);
      else pham.push(`${khoa} (${m[0]})`);
    }
  }
  assert.deepEqual(pham, [], "vỏ Chốt Đơn: chữ dưới 11 px — dùng text-xs (12 px) trở lên, hoặc khai MIEN_TRU nếu là một ký tự trong huy hiệu ≤ 16 px");
  const moCoi = Object.keys(MIEN_TRU).filter((k) => !daDung.has(k));
  assert.deepEqual(moCoi, [], "miễn trừ không còn khớp chỗ nào — xoá khỏi MIEN_TRU");

  // Tự kiểm bộ dò.
  assert.deepEqual([..."a text-[10.5px] b text-[11px] text-[9px]".matchAll(CHU_NHO)].map((m) => Number(m[1])).filter((n) => n < 11), [10.5, 9]);
  console.log(`  ✓ vỏ Chốt Đơn: 0 chữ dưới 11 px trên ${tep.length} tệp chỉ thuộc vỏ (${Object.keys(MIEN_TRU).length} miễn trừ có lý do)`);
}
