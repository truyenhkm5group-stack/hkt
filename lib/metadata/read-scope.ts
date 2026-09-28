/**
 * ═══════════ ĐỌC METADATA MỘT LẦN TRONG MỘT LƯỢT DỰNG (Phase 11 · H2) — CHỈ MÁY CHỦ ═══════════
 *
 * Đo trên tổ chức thử (scripts/platform-load-probe.ts --shapes): một lượt dựng trang 20 khối bắn 94 câu, trong đó
 * 31 câu đọc CÙNG MỘT dòng `meta_objects` và 22 câu đọc CÙNG MỘT danh sách `meta_custom_fields` — mỗi khối, mỗi cổng
 * (`recordGate` → `resolveObject`, `getCustomValues` → `requireObject` + `loadCustomDefs`, `objectFields` →
 * `listFields`…) tự hỏi lại. Số câu ấy tăng theo SỐ KHỐI, và trên bể 2 kết nối của CSDL tổ chức mỗi câu thừa là một
 * lượt xếp hàng.
 *
 * Đây KHÔNG phải đệm trong tiến trình (hợp đồng M13 giữ nguyên): phạm vi mở bằng `withMetadataReadScope` sống đúng
 * MỘT lượt gọi (một lượt dựng trang / một khối), rồi mất. Lượt kế tiếp — của tiến trình này hay tiến trình khác — đọc
 * lại CSDL, nên tạo / sửa / lưu trữ đối tượng hay field vẫn có hiệu lực ở lượt đọc kế tiếp như trước. Ngoài phạm vi,
 * `scopedMetadataRead` gọi thẳng `load()` — mọi đường khác (ghi, luật, job) không đổi một câu nào.
 *
 * Khoá theo HANDLE CSDL (`getDb()` của tổ chức hiện hành) + khoá đọc: một lượt lỡ đổi tổ chức giữa chừng
 * (`withOrganization`) đọc CSDL khác thì cũng là ô đệm khác — không có đường nào để metadata của tổ chức này trả lời
 * câu hỏi của tổ chức kia. Chỉ bọc đường CHỈ ĐỌC: lượt nào ghi metadata thì không mở phạm vi này.
 */
import { AsyncLocalStorage } from "node:async_hooks";

type Scope = WeakMap<object, Map<string, Promise<unknown>>>;

const holder = globalThis as unknown as { __erpMetadataReadScope?: AsyncLocalStorage<Scope> };
if (!holder.__erpMetadataReadScope) holder.__erpMetadataReadScope = new AsyncLocalStorage<Scope>();
const storage = holder.__erpMetadataReadScope;

/** Chạy `fn` trong một phạm vi đọc metadata. Đã ở trong phạm vi ⇒ dùng lại phạm vi ngoài (một lượt = một ô đệm). */
export function withMetadataReadScope<T>(fn: () => Promise<T>): Promise<T> {
  if (storage.getStore()) return fn();
  return storage.run(new WeakMap(), fn);
}

/**
 * Đọc qua phạm vi: trong phạm vi ⇒ lượt đọc ĐẦU chạy `load()`, các lượt sau (kể cả đang song song) dùng chung lời hứa
 * đó; lời hứa hỏng thì bị gỡ để lượt sau đọc lại. Ngoài phạm vi ⇒ `load()` như chưa có tệp này.
 */
export function scopedMetadataRead<T>(db: object, key: string, load: () => Promise<T>): Promise<T> {
  const scope = storage.getStore();
  if (!scope) return load();
  let byDb = scope.get(db);
  if (!byDb) {
    byDb = new Map();
    scope.set(db, byDb);
  }
  const hit = byDb.get(key);
  if (hit) return hit as Promise<T>;
  const bucket = byDb;
  const pending = load().catch((error: unknown) => {
    bucket.delete(key);
    throw error;
  });
  bucket.set(key, pending);
  return pending;
}
