/**
 * ═══ VẬN ĐƠN CHƯA GẮN ĐƠN: NÚT «GẮN ĐƠN» + CARE THEO TỪNG VẬN ĐƠN (vtp-direct-sync (4b), 26/10/2026) ═══
 *
 * Khoá: lượt đối chiếu care mở ca cho vận đơn CHƯA GẮN ĐƠN đang «chờ phát lại» (đường sự kiện vốn đã làm; trước bản này lượt đối chiếu
 * đòi order_id) — chiều hoàn `[số]P[số]` thì không · nút «Gắn đơn» chỉ hiện cho dòng `linkable` (chưa có đơn, không phải chiều hoàn —
 * `legBaseCode`) và chỉ cho người có quyền · nút gọi đúng server action, action qua requireUser + can("shipments:manage") rồi
 * `linkOrphanToOrder` (lõi + audit ở (4a)) · không ghép theo tên.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { inArray } from "drizzle-orm";
import type { Db } from "@/db";
import { schema } from "@/db";
import { reconcileCareCoverage } from "@/lib/care/lifecycle";

export async function testVtpLinkUi(db: Db) {
  const at = new Date(Date.now() - 3 * 3_600_000);
  const base = { carrier: "Viettel Post", stage: "DELIVERY_FAILED" as const, vtpStatus: 507, vtpStatusName: "Chờ phát lại", vtpStatusDate: at, isFinal: false, pickedUpAt: new Date(Date.now() - 48 * 3_600_000), codAmount: 499000 };
  const ids: string[] = [];
  try {
    const [mo] = await db.insert(schema.shipments).values({ ...base, vtpOrderNumber: "155990888001" }).returning({ id: schema.shipments.id });
    const [leg] = await db.insert(schema.shipments).values({ ...base, vtpOrderNumber: "PKELINKUI0011P1" }).returning({ id: schema.shipments.id });
    ids.push(mo.id, leg.id);
    const r = await reconcileCareCoverage(db, new Date(), { shipmentIds: ids });
    assert.equal(r.opened, 1, `một ca: vận đơn chưa gắn đơn, không phải chiều hoàn: ${JSON.stringify(r)}`);
    const ca = await db.select({ shipmentId: schema.shipmentCare.shipmentId, orderId: schema.shipmentCare.orderId }).from(schema.shipmentCare).where(inArray(schema.shipmentCare.shipmentId, ids));
    assert.deepEqual(ca.map((c) => [c.shipmentId, c.orderId]), [[mo.id, null]], "care theo vận đơn, order_id NULL; chiều hoàn không có ca");
  } finally {
    await db.delete(schema.shipmentCare).where(inArray(schema.shipmentCare.shipmentId, ids));
    await db.delete(schema.shipments).where(inArray(schema.shipments.id, ids));
  }

  const cols = readFileSync("app/(dashboard)/shipments/columns.tsx", "utf8");
  assert.match(cols, /canLink && row\.original\.linkable \? <LinkOrderButton shipmentId=\{row\.original\.id\} \/>/, "nút chỉ cho dòng gắn được và người có quyền");
  assert.match(cols, /c\.id === "order" && opts\.canManage \? \{ \.\.\.c, cell: orderCell\(true\) \}/, "quyền đi từ canManage của trang");
  const btn = readFileSync("app/(dashboard)/shipments/link-order-button.tsx", "utf8");
  assert.match(btn, /await linkShipmentToOrder\(\{ shipmentId, orderRef: ref \}\)/, "nút gọi đúng action");
  const act = readFileSync("lib/actions/shipment-link.ts", "utf8");
  assert.match(act, /requireUser\(\);\s*if \(!can\(user, "shipments:manage"\)\)/, "action kiểm quyền có sẵn, không thêm khoá quyền mới");
  assert.match(act, /orderForReference\(db, parsed\.data\.orderRef\)/, "mã đơn nhận đúng dạng webhook / tệp nhận (một luật)");
  assert.match(act, /linkOrphanToOrder\(db, \{/, "ghi qua lõi (4a): chặn chiều hoàn / SĐT lệch + audit");
  assert.doesNotMatch(act, /billFullName|receiverName|ilike/, "không ghép theo tên");
  const q = readFileSync("lib/queries/shipments.ts", "utf8");
  assert.match(q, /linkable: r\.orderId === null && !legBaseCode\(/, "cờ gắn được dùng đúng legBaseCode");
  console.log("✓ Vận đơn chưa gắn đơn: lượt đối chiếu care mở ca theo vận đơn (chiều hoàn không) · nút «Gắn đơn» chỉ cho dòng gắn được + người có quyền · action qua shipments:manage + lõi linkOrphanToOrder, không ghép theo tên");
}
