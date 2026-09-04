/**
 * Nhập sao kê MB Bank (JSON/CSV từ app "Quản lý giao dịch") thành chi phí ERP, không cần giao diện.
 *   npm run import:bank -- ./giao-dich.csv            # đường dẫn file
 *   cat giao-dich.json | npm run import:bank -- --stdin
 *   npm run import:bank -- ./file.json --dry-run       # chỉ in kế hoạch, không ghi
 *   npm run import:bank -- --prune-non-operating       # xoá các dòng sao kê đã nhập thuộc nhóm Quảng cáo / Nhập hàng
 * Chỉ nhập chi phí VẬN HÀNH: quảng cáo (đã lấy từ tài khoản QC) và nhập hàng (đã nằm trong giá vốn) được bỏ qua.
 * Nhóm chi phí được đoán tự động (nhãn sao kê → tên nhân sự → từ khoá → ≥5 triệu = nhập hàng → Khác);
 * sửa lại trên trang Chi phí nếu cần. Chỉ in số liệu tổng hợp, không in nội dung giao dịch.
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { and, inArray, like } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { EXPENSE_CATEGORY_LABEL } from "@/lib/constants/expenses";
import { existingLedgerReferences, insertLedgerExpenses } from "@/lib/integrations/bank/import";
import { NON_OPERATING_CATEGORIES, parseLedger, planImport, referenceFor, REFERENCE_PREFIX } from "@/lib/integrations/bank/ledger";
import { listEmployees } from "@/lib/queries/payroll";

function vnd(n: number) {
  return `${n.toLocaleString("vi-VN")}đ`;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--prune-non-operating")) {
    const db = await getDb();
    const removed = await db
      .delete(schema.expenses)
      .where(and(like(schema.expenses.reference, `${REFERENCE_PREFIX}%`), inArray(schema.expenses.category, NON_OPERATING_CATEGORIES)))
      .returning({ id: schema.expenses.id, amount: schema.expenses.amount });
    console.log(`Đã xoá ${removed.length} khoản chi sao kê thuộc nhóm Quảng cáo / Nhập hàng · ${vnd(removed.reduce((a, r) => a + r.amount, 0))}.`);
    return;
  }
  const dryRun = args.includes("--dry-run");
  const useStdin = args.includes("--stdin");
  const file = args.find((a) => !a.startsWith("--"));
  const text = useStdin ? readFileSync(0, "utf8") : file ? readFileSync(file, "utf8") : "";
  if (!text.trim()) throw new Error("Truyền đường dẫn file hoặc --stdin");

  const txns = parseLedger(text);
  const [existing, employees] = await Promise.all([existingLedgerReferences(txns.map(referenceFor)), listEmployees()]);
  const plan = planImport(txns, existing, employees);
  const fresh = plan.filter((r) => r.status === "new");
  const sum = (rows: typeof plan) => rows.reduce((a, r) => a + r.amount, 0);

  console.log(`Đọc ${txns.length} giao dịch (${txns[0]?.date ?? "?"} → ${txns[txns.length - 1]?.date ?? "?"})`);
  console.log(`  Tiền vào (bỏ qua):          ${plan.filter((r) => r.status === "inflow").length} dòng · ${vnd(sum(plan.filter((r) => r.status === "inflow")))}`);
  console.log(`  Không tính lãi/lỗ (bỏ qua): ${plan.filter((r) => r.status === "non_pl").length} dòng · ${vnd(sum(plan.filter((r) => r.status === "non_pl")))}`);
  console.log(`  CPQC / nhập hàng (bỏ qua):  ${plan.filter((r) => r.status === "not_operating").length} dòng · ${vnd(sum(plan.filter((r) => r.status === "not_operating")))}`);
  console.log(`  Đã có trong ERP:            ${plan.filter((r) => r.status === "duplicate").length} dòng`);
  console.log(`  Sẽ nhập:                    ${fresh.length} dòng · ${vnd(sum(fresh))}`);
  const byCat = new Map<string, { count: number; amount: number }>();
  for (const r of fresh) {
    const cur = byCat.get(r.category) ?? { count: 0, amount: 0 };
    cur.count++;
    cur.amount += r.amount;
    byCat.set(r.category, cur);
  }
  for (const [cat, v] of byCat) console.log(`    - ${EXPENSE_CATEGORY_LABEL[cat as keyof typeof EXPENSE_CATEGORY_LABEL] ?? cat}: ${v.count} dòng · ${vnd(v.amount)}`);

  if (dryRun || !fresh.length) {
    console.log(dryRun ? "Chạy thử, không ghi." : "Không có gì để nhập.");
    return;
  }
  const result = await insertLedgerExpenses(
    fresh.map((r) => ({ reference: r.reference, date: r.date, amount: r.amount, category: r.category, description: r.description })),
    "import:bank",
  );
  console.log(`Đã ghi ${result.inserted} khoản chi vào ERP${result.skipped ? ` (bỏ qua ${result.skipped} dòng trùng)` : ""}.`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
