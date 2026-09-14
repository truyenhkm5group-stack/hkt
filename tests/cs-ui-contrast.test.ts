import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { CS_STATUSES, CS_STATUS_HINT, CS_STATUS_LABEL, CS_STATUS_TONE } from "@/lib/constants/cs";
import { CS_SLA_BUCKETS, CS_SLA_BUCKET_HINT, CS_SLA_BUCKET_LABEL, CS_SLA_BUCKET_TONE } from "@/lib/constants/cs-next-action";
import { NESTED_ROW, ROW_EXPANDED, ROW_PARENT, ROW_SELECTED } from "@/lib/constants/table-ux";
import { dotToneOnly, textToneOnly } from "@/components/status-select";

/**
 * ═══════ NHÌN THẤY CẤU TRÚC TRƯỚC KHI ĐỌC CHỮ ═══════
 *
 * Hai lỗi đo được trên bản chạy thật ở CHẾ ĐỘ TỐI, và bài kiểm này tồn tại để chúng không quay lại:
 *
 *  1. **Khối bung không phân biệt được với dòng cha.** Bảng gom dùng `bg-muted/30`; nền thẻ ở chế
 *     độ tối là `oklch(0.192 …)` nên `muted` ở 30% alpha gần như trùng nó. Một bảng gom mà không
 *     thấy ranh giới gom thì không hơn gì một bảng phẳng.
 *  2. **Mọi lựa chọn trong ô chọn trạng thái cùng một màu.** `<select>` gốc cho `<option>` KẾ THỪA
 *     nền của chính nó, nên mở menu ra là mười một mục mang đúng màu của trạng thái đang chọn.
 *
 * Cả hai đều là lỗi của HỢP ĐỒNG DÙNG CHUNG, không phải của một trang — nên bài kiểm cũng khoá ở
 * mức hợp đồng: biến CSS phải khai cho CẢ HAI chế độ, và lớp dùng chung phải mang đủ bốn dấu hiệu.
 */
export function testCsUiContrast() {
  const css = readFileSync(path.join(process.cwd(), "app/globals.css"), "utf8");

  /* ───── 1. BIẾN MÀU PHẢI KHAI CHO CẢ HAI CHẾ ĐỘ ───── */
  /*
    Cắt theo khối khai báo THẬT, không theo lần xuất hiện đầu tiên của chuỗi: `@custom-variant dark`
    ở đầu tệp có chứa ".dark", và cắt theo nó thì khối sáng rỗng còn bài kiểm đỏ vì một lý do sai.
  */
  const khoiSang = css.slice(css.indexOf("\n:root {"), css.indexOf("\n.dark {"));
  const khoiToi = css.slice(css.indexOf("\n.dark {"), css.indexOf("@theme inline"));
  assert.ok(khoiSang.includes("--card:") && khoiToi.includes("--card:"), "không cắt đúng hai khối biến màu");
  for (const bien of ["--row-nested", "--row-selected"]) {
    assert.ok(khoiSang.includes(`${bien}:`), `${bien}: thiếu khai báo ở chế độ SÁNG`);
    assert.ok(khoiToi.includes(`${bien}:`), `${bien}: thiếu khai báo ở chế độ TỐI — một màu chỉ khai một chế độ là một màu sẽ sai ở chế độ kia`);
    assert.ok(css.includes(`--color-${bien.slice(2)}: var(${bien})`), `${bien}: chưa nối vào @theme nên lớp Tailwind tương ứng không tồn tại`);
  }

  /*
    NỀN KHỐI BUNG PHẢI CÁCH NỀN THẺ ĐỦ XA — đây là con số, không phải cảm nhận.

    Ở chế độ tối nền thẻ là `oklch(0.192 …)`; ở chế độ sáng là `oklch(1 …)`. Yêu cầu chênh lệch độ
    sáng ÍT NHẤT 0.03 — đủ để mắt bắt được ranh giới, đủ nhỏ để không chói.
  */
  const doSang = (khoi: string, bien: string): number => {
    const m = new RegExp(`${bien}:\\s*oklch\\(([0-9.]+)`).exec(khoi);
    assert.ok(m, `${bien}: không đọc được độ sáng`);
    return Number(m![1]);
  };
  const nenTheSang = doSang(khoiSang, "--card");
  const nenTheToi = doSang(khoiToi, "--card");
  assert.ok(Math.abs(doSang(khoiSang, "--row-nested") - nenTheSang) >= 0.03, "chế độ SÁNG: khối bung phải cách nền thẻ ít nhất 0.03 độ sáng");
  assert.ok(Math.abs(doSang(khoiToi, "--row-nested") - nenTheToi) >= 0.03, "chế độ TỐI: khối bung phải cách nền thẻ ít nhất 0.03 độ sáng — đây chính là chỗ `bg-muted/30` đã hỏng");
  // Dòng đang CHỌN phải khác dòng bung: chọn và bung là hai trạng thái độc lập, một dòng có thể mang cả hai.
  assert.notEqual(khoiToi.match(/--row-selected:.*/)?.[0], khoiToi.match(/--row-nested:.*/)?.[0]);

  /* ───── 2. LỚP DÙNG CHUNG MANG ĐỦ BỐN DẤU HIỆU ───── */
  assert.match(ROW_EXPANDED, /bg-row-nested/, "khối bung phải có nền riêng");
  assert.match(ROW_EXPANDED, /border-l/, "…và một đường dọc ở mép trái: chỉ đổi nền thì khối vẫn đọc như một dòng ngang hàng");
  assert.match(NESTED_ROW, /border-t/, "dòng con phải có đường kẻ ngăn cách");
  assert.match(NESTED_ROW, /hover:/, "…và trạng thái di chuột riêng");
  assert.match(ROW_PARENT, /cursor-pointer/, "dòng cha bung được thì con trỏ phải nói ra điều đó");
  assert.match(ROW_SELECTED, /bg-row-selected/);
  assert.notEqual(ROW_SELECTED, NESTED_ROW.match(/hover:bg-[\w-]+/)?.[0], "màu ĐANG CHỌN không được trùng màu DI CHUỘT");
  // Không dùng lại `bg-muted/30` ở bất cứ khối bung nào nữa.
  for (const tep of ["app/(dashboard)/cs/customer-queue-table.tsx"]) {
    const src = readFileSync(path.join(process.cwd(), tep), "utf8");
    // Bỏ chú thích trước khi quét: khối chú thích ở đầu tệp CÓ nhắc `bg-muted/30` để kể lại lỗi cũ,
    // và một bài kiểm đỏ vì đọc phải chính lời giải thích của mình là một bài kiểm vô dụng.
    const ma = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    assert.ok(!ma.includes("bg-muted/30"), `${tep}: còn dùng bg-muted/30 cho khối bung — ở chế độ tối nó gần như trùng nền thẻ`);
    assert.ok(ma.includes("ROW_EXPANDED"), `${tep}: phải dùng lớp dùng chung, không tự đặt màu tại chỗ`);
  }

  /* ───── 3. MÀU TRẠNG THÁI CSKH: ĐỦ TƯƠNG PHẢN Ở CẢ HAI CHẾ ĐỘ ───── */
  for (const s of CS_STATUSES) {
    const t = CS_STATUS_TONE[s];
    assert.ok(t, `${s}: thiếu màu`);
    assert.ok(CS_STATUS_LABEL[s], `${s}: thiếu nhãn tiếng Việt`);
    assert.ok(CS_STATUS_HINT[s], `${s}: thiếu câu giải thích — người mới vào ca phải hiểu trước khi bấm`);
    if (t.includes("bg-muted")) continue; // token của hệ, tự lo hai chế độ
    assert.match(t, /dark:bg-/, `${s}: thiếu nền cho chế độ tối`);
    assert.match(t, /text-\w+-900\b/, `${s}: chữ ở chế độ sáng phải đủ đậm`);
    assert.match(t, /dark:text-\w+-200\b/, `${s}: chữ ở chế độ tối phải đủ nhạt — chữ tối trên nền tối là không đọc được`);
  }
  // "Mới" (chưa ai xử lý) và "Đang xử lý" phải khác màu: đó là hai hành động khác nhau của người trực.
  assert.notEqual(CS_STATUS_TONE.OPEN, CS_STATUS_TONE.IN_PROGRESS);
  // Máy đóng KHÔNG được mang màu của người đóng (AGENTS.md: `AUTO_RESOLVED` ≠ `DONE`).
  assert.notEqual(CS_STATUS_TONE.AUTO_RESOLVED, CS_STATUS_TONE.DONE, "máy tự đóng không phải công của ai — không được tô cùng màu 'đã xong'");

  /* ───── 4. CHIP HẠN LÀ BỘ ĐIỀU KHIỂN, KHÔNG PHẢI NHÃN CỦA DÒNG ───── */
  const mauHan = CS_SLA_BUCKETS.map((b) => CS_SLA_BUCKET_TONE[b]);
  assert.equal(new Set(mauHan).size, CS_SLA_BUCKETS.length, "bốn mức hạn đòi bốn mức khẩn khác nhau nên phải bốn màu khác nhau");
  for (const b of CS_SLA_BUCKETS) {
    assert.ok(CS_SLA_BUCKET_LABEL[b], `${b}: thiếu nhãn`);
    assert.ok(CS_SLA_BUCKET_HINT[b], `${b}: thiếu câu giải thích — người dùng phải đoán 'sắp đến hạn' là bao lâu`);
    assert.doesNotMatch(CS_SLA_BUCKET_TONE[b], /\bbg-/, `${b}: chip hạn không được có nền đặc, nếu không nó lẫn với nhãn trạng thái trên dòng`);
    if (CS_SLA_BUCKET_TONE[b].includes("text-muted-foreground")) continue;
    assert.match(CS_SLA_BUCKET_TONE[b], /dark:text-/, `${b}: thiếu màu chữ cho chế độ tối`);
  }
  // Và không trùng dải màu của trạng thái — hai hạng mục thông tin khác nhau.
  const trung = CS_SLA_BUCKETS.filter((b) => CS_STATUSES.some((s) => CS_STATUS_TONE[s] === CS_SLA_BUCKET_TONE[b]));
  assert.deepEqual(trung, [], `chip hạn trùng màu với trạng thái: ${trung.join(", ")}`);

  /* ───── 5. Ô CHỌN TÁCH ĐƯỢC NỀN VÀ CHỮ, VÀ KHÔNG CÓ BẢNG MÀU THỨ HAI ───── */
  assert.equal(textToneOnly(CS_STATUS_TONE.OPEN), "text-rose-900 dark:text-rose-200", "lựa chọn trong menu chỉ lấy phần CHỮ — nền đặc xếp dọc mười một mục là một cầu vồng không ai đọc nổi");
  assert.equal(dotToneOnly(CS_STATUS_TONE.OPEN), "bg-rose-100 dark:bg-rose-950/60", "chấm màu lấy phần NỀN");
  assert.equal(dotToneOnly(CS_STATUS_TONE.AUTO_RESOLVED), "bg-muted", "trạng thái dùng token của hệ vẫn ra một chấm hợp lệ");
  // `<select>` gốc đã bị gỡ khỏi bàn care: nó là nguyên nhân gốc của lỗi màu trong menu.
  const care = readFileSync(path.join(process.cwd(), "app/(dashboard)/shipments/workbench.tsx"), "utf8");
  assert.ok(care.includes("StatusSelect"), "bàn care phải dùng ô chọn dùng chung");
  assert.ok(
    !/<select[\s\S]{0,200}CARE_STATUS_TONE/.test(care),
    "còn `<select>` gốc tô nền theo trạng thái — trình duyệt cho `<option>` kế thừa nền đó và mọi lựa chọn thành một màu",
  );

  console.log(
    `✓ Tương phản CSKH: --row-nested/--row-selected khai đủ hai chế độ và cách nền thẻ ≥ 0.03 · khối bung có nền + đường dọc + kẻ ngăn + hover · ${CS_STATUSES.length} trạng thái đủ tương phản · ${CS_SLA_BUCKETS.length} chip hạn khác màu nhau và không nền đặc · ô chọn tô màu từng lựa chọn`,
  );
}
