import { AsyncLocalStorage } from "node:async_hooks";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { currentOrganization } from "@/lib/platform/context";

/**
 * ═══════ KHỬ TRÙNG LƯỢT ĐỌC CẤU HÌNH TRONG MỘT LƯỢT DỰNG (OD-UX-05 mục 3, 24/10/2026) ═══════
 *
 * Đo production 23–24/10: getBusinessBrief nguội 4,6–16,6 s, 74–92 % là CHỜ KẾT NỐI (đỉnh hàng đợi 55 trên bể 5), và câu
 * `settings where key = $1` chạy ×6 tốn 3,5–4,9 s — một câu khoá chính mà ~800 ms/lượt, toàn là xếp hàng. `getSettingJson`
 * không đệm gì: mỗi lần đọc một khoá là một lượt xin kết nối, kể cả khi hàm báo cáo con bên cạnh vừa đọc đúng khoá đó.
 *
 * `withSettingsScope(fn)`: trong `fn`, cùng (tổ chức, khoá) chỉ chạm CSDL MỘT lần — KHÔNG TTL, nên không trễ cấu hình giữa hai
 * lượt dựng. Lồng nhau thì dùng chung phạm vi ngoài. Ghi (`setSettingJson`) trong cùng phạm vi XOÁ mục của khoá đó, nên lượt đọc
 * sau thấy giá trị mới. Lượt đọc LỖI không được giữ lại. Ngoài phạm vi: y như trước.
 */
/** `loi` = câu đọc LỖI (như bản cũ: trả mặc định) — khác `row: null` (chưa có dòng). Lỗi `getDb()` vẫn NÉM như bản cũ. */
type DongCauHinh = { row: { value: string } | null } | { loi: true };
const settingsHolder = globalThis as unknown as { __erpSettingsScope?: AsyncLocalStorage<Map<string, Promise<DongCauHinh>>> };
if (!settingsHolder.__erpSettingsScope) settingsHolder.__erpSettingsScope = new AsyncLocalStorage<Map<string, Promise<DongCauHinh>>>();
const settingsScope = settingsHolder.__erpSettingsScope;

export async function withSettingsScope<T>(fn: () => Promise<T>): Promise<T> {
  if (settingsScope.getStore()) return fn();
  return settingsScope.run(new Map(), fn);
}

/** Khoá của phạm vi mang MÃ TỔ CHỨC: một phạm vi có thể chạy qua `withOrganization` của tổ chức khác — không được lẫn cấu hình. */
const khoaPhamVi = async (key: string) => `${(await currentOrganization()).code}:${key}`;

async function docDongCauHinh(key: string): Promise<DongCauHinh> {
  const doc = async (): Promise<DongCauHinh> => {
    const db = await getDb();
    try {
      const row = await db.query.settings.findFirst({ where: eq(schema.settings.key, key) });
      return { row: row ? { value: row.value } : null };
    } catch {
      return { loi: true };
    }
  };
  const scope = settingsScope.getStore();
  if (!scope) return doc();
  const k = await khoaPhamVi(key);
  const co = scope.get(k);
  if (co) return co;
  const p = doc();
  scope.set(k, p);
  // Lỗi không được «đóng băng» trong phạm vi: lượt đọc sau thử lại.
  const bo = () => {
    if (scope.get(k) === p) scope.delete(k);
  };
  p.then((r) => ("loi" in r ? bo() : undefined), bo);
  return p;
}

/**
 * Trộn giá trị đã lưu (`settings.value`, TEXT chứa JSON) với mặc định — hàm THUẦN, dùng chung cho
 * `getSettingJson` và kiểm thử.
 *
 *  · Mặc định là OBJECT (kể cả mảng) ⇒ Y NGUYÊN luật cũ `{ ...fallback, ...parsed }`, cho MỌI giá trị đã
 *    lưu. Mọi khoá cấu hình dạng object đang chạy đọc ra đúng như trước — kiểm thử so từng lời gọi.
 *  · Mặc định là giá trị NGUYÊN THUỶ (boolean / số / chuỗi) hoặc `null` (Company OS · Agent K): luật cũ
 *    trải `{ ...false, ...true }` ra `{}`, nên một cờ boolean KHÔNG BAO GIỜ đọc được (Agent C phải đọc
 *    thẳng dòng để né — handoff-c). Nay:
 *      – đã lưu giá trị nguyên thuỷ CÙNG KIỂU với mặc định (hoặc mặc định `null`) ⇒ trả đúng giá trị đó;
 *      – khác kiểu (chuỗi `"true"` cho một cờ boolean), JSON `null`, JSON hỏng ⇒ mặc định. Không ép kiểu:
 *        đoán `"true"` là `true` là để một dòng gõ tay bật một cờ mà không ai định bật;
 *      – đã lưu một object với mặc định nguyên thuỷ / `null` ⇒ luật cũ (không đổi).
 */
export function mergeSettingJson<T>(raw: string, fallback: T): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fallback;
  }
  const macDinhLaObject = fallback !== null && typeof fallback === "object";
  const daLuuNguyenThuy = parsed === null || typeof parsed !== "object";
  if (!macDinhLaObject && daLuuNguyenThuy) {
    if (parsed === null) return fallback;
    return fallback === null || typeof parsed === typeof fallback ? (parsed as T) : fallback;
  }
  return { ...fallback, ...(parsed as Partial<T>) } as T;
}

/** Đọc cấu hình JSON lưu trong bảng settings. Lỗi CSDL / không có dòng ⇒ `fallback`. */
export async function getSettingJson<T>(key: string, fallback: T): Promise<T> {
  const r = await docDongCauHinh(key);
  const row = "loi" in r ? null : r.row;
  if (!row) return fallback;
  return mergeSettingJson(row.value, fallback);
}

/**
 * Đọc THÔ chuỗi `settings.value` (không trộn mặc định) — cho khoá lưu MẢNG mà `getSettingJson` sẽ gộp thành object
 * (chữ ký đối soát, xác nhận trọng số mã…). Trong `withSettingsScope` dùng chung lượt đọc với `getSettingJson` (OD-UX-05 3c:
 * getReconCenter còn 18 lượt / 10 khoá sau #1037, phần lặp là hai đường đọc thô này). Lỗi câu đọc NÉM như trước: hai nơi gọi
 * hiện không bắt lỗi, và đổi thành «rỗng» là đổi một cổng duyệt tiền.
 */
export async function readSettingValue(key: string): Promise<string | null> {
  const r = await docDongCauHinh(key);
  if (!("loi" in r)) return r.row?.value ?? null;
  // Đọc lại thẳng để ném ĐÚNG lỗi của câu đọc (phạm vi không giữ lượt lỗi).
  const db = await getDb();
  const [row] = await db.select({ value: schema.settings.value }).from(schema.settings).where(eq(schema.settings.key, key)).limit(1);
  return row?.value ?? null;
}

/**
 * Tổ chức đã TỰ KHAI khoá này chưa (có dòng trong `settings`). `false` ⇒ mọi lượt đọc đang đi bằng giá trị MẶC ĐỊNH trong mã —
 * với tổ chức khách, mặc định ấy là số của tổ chức nhà, nên màn hình phải nói ra (F3 Fashion COD). Lỗi CSDL ⇒ `null`
 * (chưa biết — không khẳng định gì).
 */
export async function settingDeclared(key: string): Promise<boolean | null> {
  const db = await getDb();
  try {
    const row = await db.query.settings.findFirst({ where: eq(schema.settings.key, key), columns: { key: true } });
    return !!row;
  } catch {
    return null;
  }
}

export async function setSettingJson(key: string, value: unknown) {
  const db = await getDb();
  const text = JSON.stringify(value);
  await db
    .insert(schema.settings)
    .values({ key, value: text })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: text, updatedAt: new Date() } });
  // Ghi rồi đọc lại trong CÙNG phạm vi phải thấy giá trị mới.
  const scope = settingsScope.getStore();
  if (scope) scope.delete(await khoaPhamVi(key));
}
