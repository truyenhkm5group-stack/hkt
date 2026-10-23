/**
 * ═══ Mọi dòng [ops:tom-tat] của conv-money-trace + stuck-conversation-audit vừa trần BYTE, không mất chỉ số (23/10/2026) ═══
 *
 * Kênh công khai cắt `cut -c1-300` (GNU: BYTE) sau `che_log`. Khoá: (1) bộ tách ra dòng ≤ SUMMARY_MAX_BYTES với MỌI đầu vào, kể cả ô / từ
 * quá dài; (2) dựng lại được dòng gốc từ các mảnh — không số, không mã nào bị bỏ; (3) trần dưới mức cắt và số dòng dưới `head -n` của
 * workflow; (4) cả hai script đi qua bộ tách, không còn `slice(0, 300)`; (5) bản quét thật trên CSDL thử ra dòng vừa trần.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getDb } from "@/db";
import { continuationLabel, packSummaryLines, splitSummaryLine, SUMMARY_MAX_BYTES, unsplitSummaryLines, utf8Bytes } from "@/lib/ops/summary-lines";
import { scanPatterns } from "@/scripts/conv-money-trace";

/** Bỏ nhãn tiếp nối ở đầu các dòng sau, rồi bỏ khoảng trắng + «·» — phần còn lại phải đúng bằng dòng gốc (cùng phép bỏ). */
const flat = (s: string) => s.replace(/[\s·]+/g, "");
const rebuilt = (orig: string, lines: string[]) => {
  const label = continuationLabel(orig);
  return lines.map((l, i) => (i > 0 && l.startsWith(label) ? l.slice(label.length) : l)).join(" ");
};
const numbersOf = (s: string) => (s.match(/\d[\d.,/%]*/g) ?? []).join("|");

function checkLine(orig: string, why: string, exact = true) {
  const out = splitSummaryLine(orig);
  if (exact) assert.deepEqual(unsplitSummaryLines(out), [orig], `${why}: ghép lại ra ĐÚNG dòng gốc`);
  for (const l of out) assert.ok(utf8Bytes(l) <= SUMMARY_MAX_BYTES, `${why}: ${utf8Bytes(l)} byte > ${SUMMARY_MAX_BYTES}: ${l}`);
  assert.equal(flat(rebuilt(orig, out)), flat(orig), `${why}: dựng lại được dòng gốc (không mất chữ nào)`);
  assert.equal(numbersOf(rebuilt(orig, out)), numbersOf(orig), `${why}: không mất / không thêm số nào`);
  return out;
}

function testPure() {
  assert.deepEqual(splitSummaryLine("ngắn · gọn"), ["ngắn · gọn"], "vừa trần ⇒ giữ nguyên");
  assert.deepEqual(unsplitSummaryLines(["A · 1", "B · 2"]), ["A · 1", "B · 2"], "dòng không phải tiếp nối giữ nguyên");
  // Dòng L thật của conv-money-trace (đã cụt trên log ở «(ME…»).
  const l = "L KNOWN_CUSTOMER_ADDRESS_REASK — tin bot xin lại địa chỉ (không phải câu «như lần trước») khi hội thoại có đơn nối chắc mang địa chỉ từ hơn một ngày trước: 0 tin / 0 hội thoại · mẫu số 0 tin bot xin địa chỉ trong các hội thoại ấy (MEASURED)";
  const outL = checkLine(l, "dòng L");
  assert.ok(outL.length === 2 && outL[1].startsWith("L (tiếp) · mẫu số 0"), outL.join("\n"));
  checkLine(`hslc-hmt-shop B · cần người 42: ${Array.from({ length: 30 }, (_, i) => `LÝ_DO_${i} ${i * 7}`).join(" · ")}`, "dòng B nhiều ô");
  checkLine(`E lời gọi AI: ${Array.from({ length: 60 }, (_, i) => `lượt ${i} chưa đủ mẫu`).join(" ")}`, "ô đầu quá dài, không có « · »");
  checkLine(`D ${"Đ".repeat(500)} · 12 · 34`, "một từ dài hơn trần", false);
  checkLine(`X · ${"ô ".repeat(200)}· cuối 99`, "ô giữa quá dài");
  assert.equal(continuationLabel("hslc-hmt-shop B · x"), "hslc-hmt-shop B (tiếp)");
  assert.equal(continuationLabel("conv-money-trace quét 7 ngày"), "conv-money-trace quét (tiếp)");
  assert.equal(continuationLabel("F CUSTOMER_SELECTED · x"), "F (tiếp)");
  const p = packSummaryLines("p", ["a", "Đ".repeat(400), "b"]);
  assert.ok(p.every((x) => utf8Bytes(x) <= SUMMARY_MAX_BYTES) && p[0] === "p · a" && p[p.length - 1] === "p · b", "ô quá trần bị ngắt, không nuốt ô bên cạnh");
}

function testWorkflowAndSource() {
  const yml = readFileSync(".github/workflows/ops-vps.yml", "utf8");
  const line = yml.split("\n").find((x) => x.includes("_tt=") && x.includes("ops:tom-tat") && x.includes("cut -c1-"));
  assert.ok(line, "ops-vps.yml còn dòng gom kênh tóm tắt");
  const cut = Number(line.match(/cut -c1-(\d+)/)?.[1]);
  const head = Number(line.match(/head -n (\d+)/)?.[1]);
  assert.ok(SUMMARY_MAX_BYTES < cut, `trần ${SUMMARY_MAX_BYTES} phải dưới mức cắt cut -c1-${cut} (chừa chỗ cho che_log)`);
  assert.ok(head >= 60, `workflow giữ tối đa ${head} dòng tóm tắt`);
  for (const f of ["scripts/conv-money-trace.ts", "scripts/stuck-conversation-audit.ts"]) {
    const src = readFileSync(f, "utf8");
    assert.match(src, /const tomTat = \(s: string\) => \{\n\s+for \(const line of splitSummaryLine\(s\)\) console\.log\(`\[ops:tom-tat\] \$\{line\}`\);\n\};/, `${f}: tomTat đi qua bộ tách`);
    assert.doesNotMatch(src, /\[ops:tom-tat\] \$\{s\.slice\(0, 300\)\}/, `${f}: không còn cắt 300 KÝ TỰ`);
    assert.equal((src.match(/console\.log\(`\[ops:tom-tat\]/g) ?? []).length, 1, `${f}: chỉ tomTat in kênh tóm tắt`);
  }
  return head;
}

async function testScanOutput(maxLines: number) {
  const printed: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => void printed.push(a.map(String).join(" "));
  try {
    await scanPatterns(await getDb(), 1, new Date());
  } finally {
    console.log = orig;
  }
  const tt = printed.filter((l) => l.startsWith("[ops:tom-tat] ")).map((l) => l.slice("[ops:tom-tat] ".length));
  assert.ok(tt.length > 10, `bản quét in đủ dòng tóm tắt: ${tt.length}`);
  for (const l of tt) assert.ok(utf8Bytes(l) <= SUMMARY_MAX_BYTES, `bản quét thật: ${utf8Bytes(l)} byte > ${SUMMARY_MAX_BYTES}: ${l}`);
  assert.ok(tt.length <= maxLines, `bản quét ${tt.length} dòng tóm tắt > head -n ${maxLines} của workflow — dòng cuối sẽ mất`);
  return tt.length;
}

export async function testOpsSummaryLines() {
  testPure();
  const head = testWorkflowAndSource();
  const n = await testScanOutput(head);
  console.log(`  ✓ dòng tóm tắt ops: mọi dòng ≤ ${SUMMARY_MAX_BYTES} byte · dựng lại được dòng gốc (không mất số / mã) · bản quét thật ${n} dòng ≤ head -n ${head} · hai script đi qua bộ tách`);
}

if (process.argv[1] && /ops-summary-lines\.test\.ts$/.test(process.argv[1])) {
  import("./setup-env")
    .then(() => import("@/db/migrate"))
    .then(({ ensureMigrated }) => ensureMigrated())
    .then(testOpsSummaryLines)
    .then(
      () => process.exit(0),
      (e: unknown) => {
        console.error(e);
        process.exit(1);
      },
    );
}
