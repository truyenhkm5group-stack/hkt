import type { AsyncLocalStorage } from "node:async_hooks";

/**
 * ═══════════ NHÌN TRỘM NGỮ CẢNH TƯỜNG MINH — KHÔNG KÉO THEO GÌ ═══════════
 *
 * `peekOrganization()` (lib/platform/context.ts) kéo theo sổ tổ chức, CSDL và `jose`. Những tệp
 * nằm RẤT thấp trong đồ thị import — `lib/env.ts` là ví dụ: cả nghìn tệp import nó — không được
 * kéo theo chừng ấy thứ (và `context.ts` lại import `env.ts`, nên import ngược là vòng).
 *
 * Tệp này đọc ĐÚNG holder mà `context.ts` dựng (`globalThis.__erpOrgCtx`) và chỉ `import type`, nên
 * không có dòng mã chạy nào của nó phụ thuộc tệp khác. Holder chưa có ⇒ `context.ts` chưa từng nạp
 * ⇒ chưa ai gọi được `withOrganization` ⇒ không thể có ngữ cảnh tường minh nào: `null` là câu trả
 * lời ĐÚNG, không phải một nhánh lỗi.
 *
 * Chỉ dùng cho getter ĐỒNG BỘ kiểu "đã cấu hình chưa". Mọi quyết định chặn thật vẫn là
 * `assertHomeCredentials()` ở lối gọi mạng — request mang phiên tổ chức khác không có ngữ cảnh
 * tường minh, nên hàm này trả `null` cho nó.
 */
type ExplicitOrg = { code: string; isHome: boolean };

export function peekExplicitNonHomeCode(): string | null {
  const holder = globalThis as unknown as { __erpOrgCtx?: AsyncLocalStorage<ExplicitOrg> };
  const store = holder.__erpOrgCtx?.getStore();
  return store && !store.isHome ? store.code : null;
}
