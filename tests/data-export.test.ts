/**
 * ═══════════ XUẤT DỮ LIỆU CỦA TỔ CHỨC (/settings/data-export · docs/platform/data-export.md) ═══════════
 *
 *  1. THUẦN — ô CSV bọc nháy đúng (phẩy, nháy, xuống dòng, chấm phẩy), `null` ⇒ ô trống, tệp có BOM UTF-8; mọi loại khai
 *     một module có thật; nơi tải của đơn / sản phẩm là route xuất SẴN CÓ (không bộ cột thứ hai).
 *  2. TỔ CHỨC THẬT (`dx-shop`): bốn tệp mang đúng dòng của CHÍNH tổ chức; liệu trình đếm đã làm / đang giữ đúng THEO GÓI
 *     (hai gói khác số — bỏ điều kiện theo gói thì đỏ); phiếu huỷ vẫn có mặt kèm lý do.
 *  3. MÃ NGUỒN — route qua `apiGuard("settings:manage")`, hỏi module trước khi đọc, ghi nhật ký mỗi lượt tải; trang chỉ liệt
 *     kê loại của module đang bật; lượt tải không xoá đệm báo cáo (`DATA_EXPORT` trong danh sách không đổi số liệu).
 */
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { eq } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import { csvCellOf, csvDocument, DATA_EXPORT_ENTRIES, DATA_EXPORT_KINDS, dataExportModule } from "@/lib/constants/data-export";
import { moduleDef } from "@/lib/constants/platform-modules";
import { buildTenantExport } from "@/lib/exports/tenant-data";
import { invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";

const ORG = "dx-shop";

async function cleanupOrg() {
  const pdb = await getPlatformDb();
  const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, ORG) });
  if (org) {
    await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
    await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
  }
  invalidateOrganizations();
  invalidateCapabilities();
  rmSync(organizationDatabaseUrl({ code: ORG, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
}

/** Tách CSV đủ cho kiểm thử (ô có nháy được nối lại). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const s = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  return rows;
}

function testPure() {
  assert.equal(csvCellOf("Hà Nội, Việt Nam"), '"Hà Nội, Việt Nam"');
  assert.equal(csvCellOf('Chị "Hoa"'), '"Chị ""Hoa"""');
  assert.equal(csvCellOf("a;b"), '"a;b"');
  assert.equal(csvCellOf("dòng 1\ndòng 2"), '"dòng 1\ndòng 2"');
  assert.equal(csvCellOf(null), "", "chưa biết ⇒ ô trống, không phải 0");
  assert.equal(csvCellOf(0), "0", "0 thật vẫn là 0");
  const doc = csvDocument(["A", "B"], [[1, "x,y"]]);
  assert.ok(doc.startsWith("\uFEFFA,B\r\n"), "BOM UTF-8 để Excel đọc đúng tiếng Việt");
  assert.deepEqual(parseCsv(doc), [["A", "B"], ["1", "x,y"]]);
  for (const e of DATA_EXPORT_ENTRIES) assert.ok(moduleDef(e.module), `${e.key}: module lạ ${e.module}`);
  for (const k of DATA_EXPORT_KINDS) assert.equal(DATA_EXPORT_ENTRIES.find((e) => e.key === k)?.href, `/api/export/data/${k}`);
  assert.equal(DATA_EXPORT_ENTRIES.find((e) => e.key === "orders")?.href, "/api/export/orders?period=all", "đơn hàng dùng lại route xuất sẵn có, MỌI kỳ");
  assert.equal(dataExportModule("appointments"), "appointments");

  const route = readFileSync("app/api/export/data/[kind]/route.ts", "utf8");
  assert.ok(route.includes('apiGuard("settings:manage"'), "chỉ quản trị tổ chức");
  assert.ok(route.indexOf("canUseModule(") < route.indexOf("buildTenantExport("), "hỏi module TRƯỚC khi đọc");
  assert.ok(route.includes('action: "DATA_EXPORT"'), "mỗi lượt tải ghi nhật ký");
  assert.ok(readFileSync("lib/audit.ts", "utf8").includes('"DATA_EXPORT"'), "lượt tải không xoá đệm báo cáo");
  const page = readFileSync("app/(dashboard)/settings/data-export/page.tsx", "utf8");
  assert.ok(page.includes('requirePermission("settings:manage")') && page.includes("moduleOn(user, e.module)"));
}

export async function testDataExport() {
  testPure();
  await cleanupOrg();
  await provisionOrganization({ code: ORG, name: "Xuất dữ liệu thử", plan: "standard", modules: ["customers", "products", "orders", "appointments"], admin: { email: `admin@${ORG}.local`, name: "QT", password: "XuatDuLieu@123" }, source: "TEST", actor: null });
  try {
    await withOrganization(ORG, async () => {
      const db = await getDb();
      const [hoa] = await db.insert(schema.customers).values({ name: 'Chị "Hoa"', phone: "0903000111", phones: ["0903000111", "0912000222"], address: "12 Lê Lợi, Quận 1", province: "Hồ Chí Minh", tags: ["sỉ", "vip"] }).returning();
      const [minh] = await db.insert(schema.customers).values({ name: "Anh Minh", phone: "0903000333" }).returning();
      const [p1] = await db.insert(schema.customerPackages).values({ customerId: hoa.id, name: "Gội đầu — 10 buổi", totalSessions: 10 }).returning();
      const [p2] = await db.insert(schema.customerPackages).values({ customerId: minh.id, name: "Massage — 5 buổi", totalSessions: 5 }).returning();
      const t = (h: number) => new Date(Date.now() + h * 3_600_000);
      await db.insert(schema.appointments).values([
        { customerId: hoa.id, serviceName: "Gội đầu", startsAt: t(-48), endsAt: t(-47), status: "DONE", packageId: p1.id },
        { customerId: hoa.id, serviceName: "Gội đầu", startsAt: t(-24), endsAt: t(-23), status: "DONE", packageId: p1.id },
        { customerId: hoa.id, serviceName: "Gội đầu", startsAt: t(24), endsAt: t(25), status: "BOOKED", packageId: p1.id },
        { customerId: minh.id, serviceName: "Massage", startsAt: t(26), endsAt: t(27), status: "CANCELLED", cancelReason: "Khách bận", packageId: p2.id },
      ]);
      await db.insert(schema.orders).values({ id: "erp-dx-o1", stage: "DELIVERED", customerId: hoa.id, totalPriceAfterDiscount: 500_000, cod: 0, prepaid: 0, insertedAt: t(-72) });
      await db.insert(schema.orderPayments).values([
        { orderId: "erp-dx-o1", kind: "RECEIPT", method: "CASH", amount: 300_000, paidAt: t(-30) },
        { orderId: "erp-dx-o1", kind: "RECEIPT", method: "BANK_TRANSFER", amount: 200_000, paidAt: t(-20), status: "VOIDED", voidedAt: t(-19), voidReason: "Ghi nhầm số" },
      ]);

      const customers = parseCsv((await buildTenantExport("customers")).csv);
      assert.equal(customers.length, 3, "tiêu đề + 2 khách");
      const hoaRow = customers.find((r) => r[1] === "0903000111")!;
      assert.deepEqual([hoaRow[0], hoaRow[2], hoaRow[4], hoaRow[6], hoaRow[11]], ['Chị "Hoa"', "0912000222", "12 Lê Lợi, Quận 1", "sỉ | vip", "ERP"]);

      const pk = parseCsv((await buildTenantExport("packages")).csv);
      const byName = (n: string) => pk.find((r) => r[2] === n)!;
      // [Tổng, Đã làm, Đang giữ, Còn đặt được] — hai gói khác số: đếm sai bảng thì cả hai cùng một số.
      assert.deepEqual(byName("Gội đầu — 10 buổi").slice(3, 7), ["10", "2", "1", "7"]);
      assert.deepEqual(byName("Massage — 5 buổi").slice(3, 7), ["5", "0", "0", "5"], "lịch huỷ không trừ, không giữ");

      const ap = parseCsv((await buildTenantExport("appointments")).csv);
      assert.equal(ap.length, 5);
      assert.ok(ap.some((r) => r[6] === "Đã huỷ" && r[9] === "Khách bận"), "lịch huỷ có lý do");

      const pay = parseCsv((await buildTenantExport("payments")).csv);
      assert.equal(pay.length, 3, "phiếu huỷ VẪN có mặt");
      const voided = pay.find((r) => r[7] === "Đã huỷ")!;
      assert.deepEqual([voided[6], voided[12]], ["200000", "Ghi nhầm số"]);
      assert.ok(pay.slice(1).every((r) => r[2] === 'Chị "Hoa"'), "phiếu nối đúng khách của đơn");
    });
    // Tổ chức nhà không có lịch hẹn của dx-shop: tệp chỉ đọc CSDL của tổ chức trong ngữ cảnh.
    const home = parseCsv((await buildTenantExport("appointments")).csv);
    assert.ok(!home.some((r) => r[2] === 'Chị "Hoa"'), "không lẫn sang tổ chức khác");
  } finally {
    await cleanupOrg();
  }
  console.log("  ✓ xuất dữ liệu: CSV bọc nháy đúng + BOM, chưa biết ⇒ ô trống; khách / lịch hẹn / liệu trình (đếm theo đúng gói) / phiếu thu (kể cả phiếu huỷ kèm lý do) của đúng tổ chức; route chỉ quản trị, hỏi module trước, ghi nhật ký");
}
