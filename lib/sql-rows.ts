/**
 * Lấy mảng dòng ra khỏi kết quả `db.execute`.
 *
 * Trình điều khiển `pg` trả `{ rows }`, còn vài đường khác trả thẳng mảng. Mỗi nơi tự đoán một kiểu
 * thì có nơi quên, và câu truy vấn im lặng trả về rỗng thay vì lỗi — dạng hỏng khó tìm nhất.
 */
export function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as T[];
}
