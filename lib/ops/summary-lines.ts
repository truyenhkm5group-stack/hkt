/**
 * ═══ Dòng tóm tắt ops vừa kênh [ops:tom-tat] (23/10/2026) ═══
 *
 * ops-vps.yml cắt kênh tóm tắt bằng `cut -c1-300`, và GNU cut -c đếm BYTE: chữ Việt 2–3 byte nên dòng ≤ 300 ký tự vẫn cụt (dòng 2B ngày
 * 22/10 mất từ «CART_TOTAL_C…»; dòng L của conv-money-trace mất từ «(ME…»). `che_log` chạy TRƯỚC `cut` và có thể làm dòng DÀI thêm (mỗi
 * «•» 3 byte) ⇒ trần 280. Hàm THUẦN, không đọc gì — script ops lấy từ main nhưng lib lấy từ image, nên tệp này không được kéo phụ thuộc.
 */

export const SUMMARY_MAX_BYTES = 280;
export const utf8Bytes = (s: string) => Buffer.byteLength(s, "utf8");

/**
 * Ngắt một chuỗi theo khoảng trắng thành các mảnh ≤ trần: mảnh ĐẦU mang `firstLead`, các mảnh SAU mang `lead`. Từ đơn lẻ dài hơn trần thì
 * cắt theo ký tự. Nối các mảnh (bỏ tiền tố) bằng dấu cách ⇒ đúng chuỗi gốc, trừ chỗ cắt giữa một từ quá dài.
 */
function wrapWords(firstLead: string, lead: string, text: string, max: number): string[] {
  const out: string[] = [];
  const pre = () => (out.length ? lead : firstLead);
  let cur = "";
  for (const w of text.split(" ")) {
    const next = cur ? `${cur} ${w}` : `${pre()}${w}`;
    if (utf8Bytes(next) <= max) {
      cur = next;
      continue;
    }
    if (cur) out.push(cur);
    let rest = w;
    cur = `${pre()}${rest}`;
    while (utf8Bytes(cur) > max) {
      let n = rest.length;
      while (n > 1 && utf8Bytes(`${pre()}${rest.slice(0, n)}`) > max) n -= 1;
      out.push(`${pre()}${rest.slice(0, n)}`);
      rest = rest.slice(n);
      cur = `${pre()}${rest}`;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** Dồn các ô vào các dòng `<tiền tố> · ô · ô…`, mỗi dòng ≤ trần; ô tự nó quá dài thì ngắt theo từ, không nuốt ô bên cạnh. HÀM THUẦN. */
export function packSummaryLines(prefix: string, cells: readonly string[], max = SUMMARY_MAX_BYTES): string[] {
  const out: string[] = [];
  let cur = "";
  for (const c of cells) {
    const next = cur ? `${cur} · ${c}` : `${prefix} · ${c}`;
    if (utf8Bytes(next) <= max) {
      cur = next;
      continue;
    }
    if (cur) out.push(cur);
    const alone = `${prefix} · ${c}`;
    if (utf8Bytes(alone) <= max) cur = alone;
    else {
      // Mảnh SAU của cùng một ô nối bằng dấu cách (không « · ») — ghép lại phải ra đúng ô gốc.
      out.push(...wrapWords(`${prefix} · `, `${prefix} `, c, max));
      cur = "";
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** Nhãn của dòng tiếp nối: từ đầu (thêm từ thứ hai khi từ đầu là mã có gạch nối — mã tổ chức / tên script) + «(tiếp)». */
export function continuationLabel(line: string): string {
  const [a = "", b = ""] = line.split(" ");
  return `${a.includes("-") && b && !/\d/.test(b) && b.length <= 12 ? `${a} ${b}` : a} (tiếp)`;
}

/**
 * Một dòng tóm tắt bất kỳ ⇒ các dòng ≤ trần. Vừa trần thì giữ nguyên; dài thì tách theo ô « · », dòng sau mang `continuationLabel` —
 * không chữ nào bị bỏ (bài kiểm dựng lại dòng gốc từ các mảnh). HÀM THUẦN.
 */
export function splitSummaryLine(line: string, max = SUMMARY_MAX_BYTES): string[] {
  if (utf8Bytes(line) <= max) return [line];
  const cells = line.split(" · ");
  const label = continuationLabel(line);
  const first = utf8Bytes(cells[0]) <= max ? [cells[0]] : wrapWords("", `${label} `, cells[0], max);
  const lines = first.slice(0, -1);
  let cur = first[first.length - 1];
  for (const c of cells.slice(1)) {
    const next = `${cur} · ${c}`;
    if (utf8Bytes(next) <= max) {
      cur = next;
      continue;
    }
    lines.push(cur);
    const packed = packSummaryLines(label, [c], max);
    cur = packed.pop()!;
    lines.push(...packed);
  }
  lines.push(cur);
  return lines;
}

/**
 * Ngược của `splitSummaryLine` cho người ĐỌC kênh tóm tắt (bài kiểm, công cụ phân tích log): dòng bắt đầu bằng nhãn tiếp nối của dòng
 * trước được nối lại — « · » nếu tách theo ô, dấu cách nếu ngắt theo từ. Dòng không phải tiếp nối giữ nguyên. HÀM THUẦN.
 */
export function unsplitSummaryLines(lines: readonly string[]): string[] {
  const out: string[] = [];
  for (const l of lines) {
    const prev = out[out.length - 1];
    const label = prev === undefined ? null : continuationLabel(prev);
    if (label && l.startsWith(`${label} · `)) out[out.length - 1] = `${prev} · ${l.slice(label.length + 3)}`;
    else if (label && l.startsWith(`${label} `)) out[out.length - 1] = `${prev} ${l.slice(label.length + 1)}`;
    else out.push(l);
  }
  return out;
}
