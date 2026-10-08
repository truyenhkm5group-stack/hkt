/**
 * ═══════════ Ô NHẬP CÓ TÊN Ở CÁC TRANG CHI TIẾT ERP (Commercial Sweep — kiểm 26 trang động P2/P3, 09/10/2026) ═══════════
 *
 * Lượt kiểm đọc mã đếm được hơn 80 ô nhập không có tên cho trình đọc màn hình — chỉ có chữ mờ (`placeholder`, biến mất khi ô có
 * giá trị) hoặc một `<Label>` đứng cạnh không nối `htmlFor`: 36 ô của lô xưởng (một hàm `Field` dùng chung), hồ sơ khách sỉ (13),
 * gọi khách sỉ trên điện thoại, topic sản xuất (7), trạng thái mẫu, góp ý ý tưởng, trình sửa luật tự động (18). Khoá ở mức mã
 * nguồn: mỗi `<Input|Textarea|SelectTrigger|select|input|textarea>` trong các tệp dưới đây phải có `aria-label` / `id` /
 * `aria-labelledby`, hoặc nằm TRONG một `<label>` bọc nó (ô tick, «Khớp khi [chọn]»).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

export const FORM_FILES = [
  "app/(dashboard)/inventory/workshop/workshop-forms.tsx",
  "app/(dashboard)/wholesale/leads/[id]/lead-actions.tsx",
  "app/(dashboard)/wholesale/mobile/lead/[id]/mobile-call.tsx",
  "app/(dashboard)/production/topics/[id]/topic-controls.tsx",
  "app/(dashboard)/models/[id]/model-controls.tsx",
  "app/(dashboard)/models/[id]/suggestion-transition.tsx",
  "app/(dashboard)/ideas/feedback-form.tsx",
  "components/platform/workflow/rule-editor.tsx",
] as const;

const CONTROL = /<(Input|Textarea|SelectTrigger|select|input|textarea)\b/g;

/** Thẻ mở bắt đầu tại `start` (bỏ qua `>` nằm trong `{…}`). */
function openingTag(src: string, start: number): string {
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ">" && depth === 0) return src.slice(start, i + 1);
  }
  return src.slice(start);
}

/** Vị trí `at` nằm trong một `<tag …>…</tag>` đang mở (`label`, hoặc thành phần bọc tự dựng `<label>` như `Field`). */
function inside(src: string, at: number, tag: string): boolean {
  const open = Math.max(src.lastIndexOf(`<${tag} `, at), src.lastIndexOf(`<${tag}>`, at));
  return open > src.lastIndexOf(`</${tag}>`, at);
}

/** Thành phần tự dựng `<label>` quanh `children` — bài kiểm phía dưới chứng minh `Field` làm đúng thế. */
const WRAPPERS: Record<string, readonly string[]> = { "app/(dashboard)/inventory/workshop/workshop-forms.tsx": ["Field"] };

export function unnamedControls(file: string, src: string): string[] {
  const wrappers = ["label", ...(WRAPPERS[file] ?? [])];
  const bad: string[] = [];
  for (const m of src.matchAll(CONTROL)) {
    const at = m.index ?? 0;
    const tag = openingTag(src, at);
    if (/type="hidden"/.test(tag) || /\baria-label(ledby)?=/.test(tag) || /\sid=/.test(tag) || wrappers.some((w) => inside(src, at, w))) continue;
    bad.push(`${file}:${src.slice(0, at).split("\n").length} ${tag.replace(/\s+/g, " ").slice(0, 80)}`);
  }
  return bad;
}

export function testErpFormNames() {
  const bad = FORM_FILES.flatMap((f) => unnamedControls(f, readFileSync(f, "utf8").replace(/\r\n/g, "\n")));
  assert.deepEqual(bad, [], "ô nhập không có tên cho trình đọc màn hình — thêm aria-label (đúng chữ nhãn đang hiện) hoặc bọc trong <label>");

  // Lô xưởng: `Field` bọc ô bằng <label> thật — một chỗ sửa cho 36 ô.
  const ws = readFileSync(FORM_FILES[0], "utf8").replace(/\r\n/g, "\n");
  const field = ws.slice(ws.indexOf("function Field("), ws.indexOf("function MoneyHint"));
  assert.ok(/<label className="block space-y-1\.5">[\s\S]*\{children\}[\s\S]*<\/label>/.test(field), "Field của lô xưởng phải bọc ô trong <label>");

  // Nút chỉ có biểu tượng «xoá bảng nháp».
  assert.match(readFileSync("app/(dashboard)/inventory/planning/orders/[id]/order-actions.tsx", "utf8"), /aria-label="Xoá bảng nháp"/);

  // Tự kiểm bộ dò.
  assert.equal(unnamedControls("x", '<Input value={a} placeholder="b" />').length, 1);
  assert.equal(unnamedControls("x", '<Input aria-label="Tên" value={a} />').length, 0);
  assert.equal(unnamedControls("x", '<label>Ten <input type="checkbox" checked={a > b} /></label>').length, 0);
  assert.equal(unnamedControls("x", '<label>Ten</label><Textarea value={a} />').length, 1);
  console.log(`  ✓ ô nhập ở trang chi tiết ERP có tên: ${FORM_FILES.length} tệp, mọi ô có aria-label / id hoặc nằm trong <label> · Field lô xưởng bọc <label> · nút xoá nháp có tên`);
}
