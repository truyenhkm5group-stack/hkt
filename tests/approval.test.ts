import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import {
  APPROVAL_GROUPS,
  APPROVAL_GROUP_LABEL,
  APPROVAL_GROUP_REASON,
  APPROVAL_THRESHOLD,
  NO_SECOND_APPROVAL,
  isEnforced,
  overThreshold,
  type ApprovalGroup,
} from "@/lib/constants/approval";

/**
 * ═══════ PHÊ DUYỆT HAI BƯỚC ═══════
 *
 * Cơ chế loại này hỏng theo ba cách, và cả ba đều im lặng:
 *
 *  1. **Người xin tự duyệt** — nút thì có, kiểm soát thì không.
 *  2. **Thiếu người duyệt ⇒ tự cho qua** — cơ chế tự bỏ qua chính mình đúng lúc bị lợi dụng.
 *  3. **Sổ đăng ký không ai gọi** — khai đủ nhóm, viết đủ lý do, và không một thao tác nào hỏi tới.
 *     Đúng lỗi đã gặp năm lần trong kho mã này, nên nó được kiểm ở mức MÃ NGUỒN.
 */
export async function testApproval(db: Db) {
  // ───────── 1. Sổ đăng ký phải đầy đủ và nói được lý do ─────────
  for (const g of APPROVAL_GROUPS) {
    assert.ok(APPROVAL_GROUP_LABEL[g]?.trim(), `${g}: thiếu nhãn tiếng Việt`);
    const lyDo = APPROVAL_GROUP_REASON[g];
    assert.ok(lyDo && lyDo.length > 30, `${g}: phải nói ĐƯỢC vì sao cần người thứ hai — người bị chặn có quyền biết`);
  }
  assert.ok(Object.keys(NO_SECOND_APPROVAL).length >= 4, "phải khai rõ những việc KHÔNG cần duyệt, kèm lý do");
  for (const [k, v] of Object.entries(NO_SECOND_APPROVAL)) {
    assert.ok(v.length > 15, `${k}: miễn duyệt cũng phải có lý do, không được để trống`);
  }

  // ───────── 2. Ngưỡng: CHƯA BIẾT số tiền thì phải coi như VƯỢT ─────────
  //
  // Đoán thấp ở đây là bỏ lọt đúng việc cần canh. Luật 3 của ORDER_OUTCOME áp dụng cả ở đây:
  // NULL là chưa biết, không phải 0.
  const coNguong = Object.keys(APPROVAL_THRESHOLD)[0] as ApprovalGroup;
  const nguong = APPROVAL_THRESHOLD[coNguong] as number;
  assert.equal(overThreshold(coNguong, null), true, "chưa biết số tiền ⇒ coi như vượt ngưỡng, không được cho qua");
  assert.equal(overThreshold(coNguong, undefined), true, "undefined cũng là chưa biết");
  assert.equal(overThreshold(coNguong, nguong), true, "bằng đúng ngưỡng là ĐÃ vượt");
  assert.equal(overThreshold(coNguong, nguong - 1), false, "dưới ngưỡng thì không cần duyệt");
  assert.equal(overThreshold(coNguong, -(nguong + 1)), true, "số âm tính theo GIÁ TRỊ TUYỆT ĐỐI — ghi giảm 30 triệu cũng là 30 triệu");
  assert.equal(overThreshold("BUSINESS_RULE_CHANGE", 0), true, "nhóm KHÔNG có ngưỡng thì mọi việc đều phải duyệt");

  // ───────── 3. Cưỡng chế mặc định TẮT, và bật theo từng nhóm ─────────
  assert.equal(isEnforced(null, "INVENTORY_ADJUSTMENT"), false, "chưa cấu hình ⇒ TẮT (production chỉ có 2 tài khoản, bật đại là chặn chính chủ shop)");
  assert.equal(isEnforced({}, "INVENTORY_ADJUSTMENT"), false, "cấu hình rỗng ⇒ TẮT");
  assert.equal(isEnforced({ INVENTORY_ADJUSTMENT: true }, "INVENTORY_ADJUSTMENT"), true, "bật đúng nhóm được khai");
  assert.equal(isEnforced({ INVENTORY_ADJUSTMENT: true }, "PAYROLL_EDIT"), false, "bật nhóm này KHÔNG kéo theo nhóm khác");
  assert.equal(isEnforced({ INVENTORY_ADJUSTMENT: "true" }, "INVENTORY_ADJUSTMENT"), false, "chỉ đúng boolean true mới là bật — chuỗi 'true' không tính");

  // ───────── 4. CSDL tự chặn người xin tự duyệt ─────────
  //
  // Ứng dụng đã chặn. Nhưng hàng rào ở tầng ứng dụng có thể bị một đường ghi mới nào đó đi vòng qua,
  // nên ràng buộc phải nằm ở CSDL — và bài kiểm này chứng minh CSDL thật sự từ chối.
  await db.insert(schema.users).values({ id: "appr-u1", email: "xin@shop.vn", name: "Người xin", role: "MANAGER", passwordHash: "x" }).onConflictDoNothing();
  await db.insert(schema.users).values({ id: "appr-u2", email: "duyet@shop.vn", name: "Người duyệt", role: "ADMIN", passwordHash: "x" }).onConflictDoNothing();

  const [yc] = await db
    .insert(schema.approvalRequests)
    .values({
      group: "INVENTORY_ADJUSTMENT",
      action: "stock.adjustment",
      entity: "STOCK_RECEIPT",
      summary: "Điều chỉnh kiểm kê 3 mẫu mã · −12 món",
      amount: 3_600_000,
      requestedBy: "appr-u1",
      requestedByEmail: "xin@shop.vn",
    })
    .returning({ id: schema.approvalRequests.id });

  let csdlTuChoi = false;
  try {
    await db
      .update(schema.approvalRequests)
      .set({ status: "APPROVED", decidedBy: "appr-u1", decidedByEmail: "xin@shop.vn", decidedAt: new Date() })
      .where(eq(schema.approvalRequests.id, yc.id));
  } catch {
    csdlTuChoi = true;
  }
  assert.ok(csdlTuChoi, "CSDL phải TỪ CHỐI việc người xin tự duyệt — đây là lý do tồn tại của cả cơ chế");

  // Người KHÁC duyệt thì được.
  await db
    .update(schema.approvalRequests)
    .set({ status: "APPROVED", decidedBy: "appr-u2", decidedByEmail: "duyet@shop.vn", decidedAt: new Date() })
    .where(eq(schema.approvalRequests.id, yc.id));
  const [sauDuyet] = await db.select().from(schema.approvalRequests).where(eq(schema.approvalRequests.id, yc.id));
  assert.equal(sauDuyet.status, "APPROVED", "người khác duyệt thì phải được");
  assert.equal(sauDuyet.decidedByEmail, "duyet@shop.vn", "phải ghi rõ AI đã duyệt");

  // ───────── 5. SỔ ĐĂNG KÝ PHẢI CÓ NGƯỜI GỌI ─────────
  //
  // Bài kiểm quan trọng nhất của tệp này. Một sổ đăng ký đầy đủ mà không thao tác nào hỏi tới thì
  // đúng bằng không có gì — và nó vẫn xanh ở mọi bài kiểm khác. Kho mã này đã gặp đúng lỗi đó năm
  // lần trong một ngày (job không có lịch · phép nối không canh grain · lá chắn chi phí canh sáu
  // tệp · ranh giới ghi canh 15 tệp · khung xương canh 21 tuyến).
  const nhomDaNoi = new Set<string>();
  for (const f of ["lib/actions/stock.ts", "lib/actions/expenses.ts", "lib/actions/payroll.ts"]) {
    const src = readFileSync(f, "utf8");
    for (const g of APPROVAL_GROUPS) if (src.includes(`"${g}"`)) nhomDaNoi.add(g);
  }
  assert.ok(nhomDaNoi.size >= 4, `sổ đăng ký phải được THAO TÁC THẬT gọi tới — mới thấy ${nhomDaNoi.size} nhóm được nối`);
  for (const g of ["INVENTORY_ADJUSTMENT", "INVENTORY_WRITE_OFF", "EXPENSE_EDIT", "PAYROLL_EDIT"] as ApprovalGroup[]) {
    assert.ok(nhomDaNoi.has(g), `${g} khai trong sổ nhưng KHÔNG thao tác nào gọi — sổ đăng ký không ai gọi thì bằng không có`);
  }

  // Nhóm chưa nối phải được biết là chưa nối, không được lặng lẽ nằm đó.
  const chuaNoi = APPROVAL_GROUPS.filter((g) => !nhomDaNoi.has(g));
  console.log(
    `✓ Phê duyệt hai bước: ${APPROVAL_GROUPS.length} nhóm khai · ${nhomDaNoi.size} nhóm đã nối vào thao tác thật · CSDL từ chối người xin tự duyệt · chưa biết số tiền ⇒ coi như vượt ngưỡng · mặc định TẮT` +
      (chuaNoi.length ? ` · CHƯA nối: ${chuaNoi.join(", ")}` : ""),
  );

  await db.delete(schema.approvalRequests).where(sql`${schema.approvalRequests.requestedBy} like 'appr-u%'`);
  await db.delete(schema.users).where(sql`${schema.users.id} like 'appr-u%'`);
}
