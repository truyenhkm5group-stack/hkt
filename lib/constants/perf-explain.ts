/**
 * ═══════════ HAI PHÉP TÍNH CỦA PHÉP ĐO JIT BẬT / JIT TẮT ═══════════
 *
 * Tách khỏi `scripts/perf-probe.ts` vì script ấy CHỈ chạy được trên Postgres thật có JIT — PGlite
 * không có JIT, và máy này không có Postgres. Nên phần tính toán phải kiểm được ở nơi khác, nếu
 * không lần chạy đầu trên production chính là lần kiểm đầu tiên, và một trung vị sai sẽ đi thẳng
 * vào tệp chứng từ.
 */

/**
 * `Execution Time: 8051.037 ms` → `8051.037`. Không có dòng ấy ⇒ `null`, KHÔNG phải 0: một lượt
 * EXPLAIN không in thời gian là một lượt chưa đo được, không phải một lượt chạy tức thì (mục 42).
 */
export function thoiGianThucThi(dong: readonly string[]): number | null {
  const l = dong.find((x) => x.trim().startsWith("Execution Time"));
  if (!l) return null;
  const m = /([0-9]+(?:\.[0-9]+)?)\s*ms/.exec(l);
  return m ? Number(m[1]) : null;
}

/**
 * Trung vị. Rỗng ⇒ `null`. Số phần tử CHẴN ⇒ trung bình hai phần tử giữa — chỗ lỗi cổ điển:
 * lấy `xs[n/2]` cho mảng chẵn là lấy phần tử lệch về phía LỚN, và với ba lượt đo trên máy đang
 * tranh tài nguyên thì lệch ấy không nhỏ.
 *
 * Không đụng mảng gốc — sắp một bản sao.
 */
export function trungVi(xs: readonly number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const g = Math.floor(s.length / 2);
  return s.length % 2 ? s[g] : (s[g - 1] + s[g]) / 2;
}
