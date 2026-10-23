/**
 * ═══ SRC-5b · VIỆC MUA THỬ TRÊN /work (Tech Lead mở 24/10/2026) ═══
 *
 * Khoá: (1) nguồn SOURCING_TRIAL là PHÉP CHIẾU (SOURCE) — chỉ hai loại «đã duyệt chưa đặt» / «đã đặt chưa về»; chờ duyệt đã là
 * việc của APPROVAL nên KHÔNG xuất hiện ở đây; rời hàng đợi khi bấm đúng action của miền; nút trên /work chỉ MỞ; (2) hạn mặc định
 * khai MỘT lần ở lib/constants/sourcing.ts và work-sla LẤY LẠI (ORDER = hạn hiệu lực lời duyệt, RECEIVE bỏ trống) — ghi đè
 * `work.sla` áp qua `applyWorkConfig`; (3) phòng = nhóm Sản xuất ⇒ hôm nay về Kho theo TEAM_DEPARTMENT_DIVERGENCE (luật 69), ghi đè
 * `work.ownership` theo loại chuyển được; (4) không thêm loại cảnh báo nào trùng độ mịn.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { decideApprovalCore } from "@/lib/approvals/service";
import { APPROVAL_VALID_HOURS } from "@/lib/constants/approval";
import { TEAM_DEPARTMENT, TEAM_DEPARTMENT_DIVERGENCE } from "@/lib/constants/departments";
import { SOURCING_TRIAL_SLA_HOURS, SOURCING_TRIAL_WORK_KINDS } from "@/lib/constants/sourcing";
import { DEFAULT_OWNERSHIP_MAP, departmentFor } from "@/lib/constants/work-ownership";
import { DEFAULT_SLA_MAP, SOURCES_WITHOUT_SLA, slaHoursFor } from "@/lib/constants/work-sla";
import { ALERT_KINDS_OWNED_ELSEWHERE, PROJECTED_SOURCES, WORK_SOURCE_SPEC, actionsOf } from "@/lib/constants/work-sources";
import { adaptSourcingTrials, applyWorkConfig } from "@/lib/queries/work-adapters";
import { addSourcingWeight, createSourcingOffer, type SourcingActor } from "@/lib/sourcing/offer-service";
import { markSourcingTrialOrdered, markSourcingTrialReceived, requestSourcingTrial, saveOfferToShortlist } from "@/lib/sourcing/trial-service";

const P = "src5b-";
const H = 3_600_000;

function testRegistry() {
  const spec = WORK_SOURCE_SPEC.SOURCING_TRIAL;
  assert.deepEqual([spec.statusAuthority, spec.assigneeAuthority, spec.businessEntity, spec.slaHours, spec.outcomeAttributable], ["SOURCE", "WORK", "SOURCING_TRIAL", null, false]);
  assert.ok(PROJECTED_SOURCES.includes("SOURCING_TRIAL"), "phép chiếu, không phải nguồn việc tay");
  assert.deepEqual(spec.actions, ["OPEN_SOURCE"], "nút riêng của nguồn chỉ là MỞ — đóng việc là action thật của miền (luật 19)");
  assert.ok(!actionsOf("SOURCING_TRIAL").some((a) => /DONE|CLOSE|COMPLETE|RESOLVE/.test(a)), "không nút nào «đánh dấu xong» (chỉ thêm nút chung của lớp việc: nhận · ghi chú · hẹn · báo vướng)");
  // Hạn: lấy lại từ hằng số miền, không gõ lại.
  assert.equal(SOURCING_TRIAL_SLA_HOURS.ORDER, APPROVAL_VALID_HOURS, "ORDER = hạn hiệu lực lời duyệt");
  assert.equal(SOURCING_TRIAL_SLA_HOURS.RECEIVE, null, "RECEIVE CỐ Ý bỏ trống");
  for (const k of SOURCING_TRIAL_WORK_KINDS) {
    assert.equal(slaHoursFor("SOURCING_TRIAL", k, null), SOURCING_TRIAL_SLA_HOURS[k]);
    assert.ok(DEFAULT_SLA_MAP[`SOURCING_TRIAL:${k}`] && DEFAULT_OWNERSHIP_MAP[`SOURCING_TRIAL:${k}`], `${k}: có ĐÚNG một dòng ở cả bảng hạn lẫn bảng phòng`);
  }
  assert.ok(!DEFAULT_OWNERSHIP_MAP.SOURCING_TRIAL && !DEFAULT_SLA_MAP.SOURCING_TRIAL, "không có dòng mức nguồn chồng lên dòng mức loại");
  assert.equal(slaHoursFor("SOURCING_TRIAL", "RECEIVE", { "SOURCING_TRIAL:RECEIVE": 120 }), 120, "chủ shop đặt hạn RECEIVE được");
  assert.ok(!SOURCES_WITHOUT_SLA.includes("SOURCING_TRIAL"));
  const sla = readFileSync("lib/constants/work-sla.ts", "utf8");
  assert.ok(sla.includes("hours: SOURCING_TRIAL_SLA_HOURS[kind]") && !/SOURCING_TRIAL[\s\S]{0,400}hours:\s*\d/.test(sla), "work-sla LẤY LẠI số giờ, không gõ số");
  // Phòng: nhóm Sản xuất ⇒ hôm nay về Kho, và chỗ lệch ấy ĐÃ được khai (luật 69).
  assert.equal(spec.department, TEAM_DEPARTMENT.PRODUCTION);
  const lech = TEAM_DEPARTMENT_DIVERGENCE.find((d) => d.team === "PRODUCTION");
  assert.ok(lech && spec.department === lech.routedTo, "việc không rơi vào phòng Sản xuất đang trống — khai lệch như nhóm đặt hàng");
  for (const k of SOURCING_TRIAL_WORK_KINDS) assert.equal(departmentFor("SOURCING_TRIAL", k, spec.department, { [`SOURCING_TRIAL:${k}`]: "PRODUCTION" }), "PRODUCTION", "chuyển sang phòng Sản xuất bằng ghi đè, không cần deploy");
  assert.ok(!ALERT_KINDS_OWNED_ELSEWHERE.some((t) => /SOURC|TRIAL/.test(t)), "không loại cảnh báo nào cùng độ mịn");
}

async function testProjection() {
  const db = await getDb();
  const mk = async (suffix: string, role: "MANAGER" | "ADMIN"): Promise<SourcingActor> => {
    await db.insert(schema.users).values({ id: `${P}${suffix}`, email: `${suffix}@src5b.test`, name: `Người ${suffix}`, passwordHash: "x", role }).onConflictDoNothing();
    return { id: `${P}${suffix}`, email: `${suffix}@src5b.test` };
  };
  const R = await mk("xin", "MANAGER");
  const A = await mk("duyet", "ADMIN");
  const mine = async (at: Date = new Date()) => (await adaptSourcingTrials(at)).filter((w) => w.businessEntityId === trialId);

  const offer = await createSourcingOffer(R, { url: "https://detail.1688.com/offer/677777777777.html", titleVi: "Đầm việc mua thử", titleZh: "", imageUrl: "", supplierShopUrl: "", supplierName: "", tiers: [{ fromQty: 1, price: "10" }], moq: null, colors: "", sizes: "" });
  assert.ok(offer.ok);
  assert.ok((await addSourcingWeight(R, { offerId: offer.id, grams: 300 })).ok);
  assert.ok((await saveOfferToShortlist(R, { offerId: offer.id })).ok);
  const req = await requestSourcingTrial(R, { offerId: offer.id, lines: [{ color: "đen", size: "L", qty: 5 }] });
  assert.ok(req.ok, JSON.stringify(req));
  const trialId = req.id;

  assert.deepEqual(await mine(), [], "chờ duyệt ⇒ KHÔNG có việc ở đây (đã là việc của APPROVAL)");

  const [apr] = await db.select().from(schema.approvalRequests).where(eq(schema.approvalRequests.entityId, trialId));
  assert.ok("ok" in (await decideApprovalCore(db, { ...A, canDecide: true }, apr.id, true, undefined)));
  const [decided] = await db.select().from(schema.approvalRequests).where(eq(schema.approvalRequests.id, apr.id));

  const order = await mine();
  assert.equal(order.length, 1);
  const o = order[0];
  assert.deepEqual([o.kind, o.sourceType, o.statusAuthority, o.department, o.sourceUrl, o.actions], ["ORDER", "SOURCING_TRIAL", "SOURCE", "WAREHOUSE", `/sourcing/trials/${trialId}`, actionsOf("SOURCING_TRIAL")]);
  assert.equal(o.createdAt.getTime(), decided.decidedAt!.getTime(), "mốc bắt đầu = lúc duyệt");
  assert.equal(o.slaAt?.getTime(), decided.decidedAt!.getTime() + APPROVAL_VALID_HOURS * H, "hạn = hạn hiệu lực lời duyệt");
  const moved = applyWorkConfig(o, { sla: { "SOURCING_TRIAL:ORDER": 24 }, ownership: { "SOURCING_TRIAL:ORDER": "PRODUCTION" } });
  assert.deepEqual([moved.department, moved.slaAt?.getTime()], ["PRODUCTION", decided.decidedAt!.getTime() + 24 * H], "ghi đè hạn / phòng áp qua applyWorkConfig");

  // Lời duyệt quá hạn ⇒ rời hàng đợi (phải xin lại — không còn việc «đặt» để làm).
  assert.deepEqual(await mine(new Date(decided.decidedAt!.getTime() + (APPROVAL_VALID_HOURS + 1) * H)), []);

  // Đã đặt ⇒ việc ORDER biến mất, việc RECEIVE xuất hiện, không có hạn mặc định.
  assert.ok((await markSourcingTrialOrdered(R, { trialId, note: "" })).ok);
  const recv = await mine();
  assert.deepEqual(recv.map((w) => [w.kind, w.sourceKey, w.slaAt]), [["RECEIVE", `RECEIVE:${trialId}`, null]], "RECEIVE: khoá riêng, hạn bỏ trống");
  assert.notEqual(recv[0].key, o.key, "hai pha là hai việc — ghi chú / người nhận không kéo từ pha đặt sang pha về");
  const withSla = applyWorkConfig(recv[0], { sla: { "SOURCING_TRIAL:RECEIVE": 168 }, ownership: {} });
  assert.equal(withSla.slaAt?.getTime(), recv[0].createdAt.getTime() + 168 * H);

  // Đã về ⇒ rời hàng đợi.
  assert.ok((await markSourcingTrialReceived(R, { trialId, receiptId: "", note: "" })).ok);
  assert.deepEqual(await mine(), []);

  await db.delete(schema.sourcingTrialRequests);
  await db.delete(schema.approvalRequests).where(eq(schema.approvalRequests.group, "SOURCING_TRIAL"));
  await db.delete(schema.sourcingShortlist);
  await db.delete(schema.sourcingOfferWeights);
  await db.delete(schema.sourcingOfferSnapshots);
  await db.delete(schema.sourcingOffers);
  await db.delete(schema.sourcingSuppliers);
}

export async function testSourcingTrialWork() {
  testRegistry();
  await testProjection();
  console.log("  ✓ SRC-5b việc mua thử trên /work: phép chiếu hai loại (đã duyệt chưa đặt · đã đặt chưa về), chờ duyệt ở APPROVAL · hạn lấy lại từ hằng số miền (ORDER = hạn lời duyệt, RECEIVE bỏ trống) · nhóm Sản xuất về Kho theo chỗ lệch đã khai, ghi đè chuyển được · nút chỉ mở · rời hàng đợi khi bấm đúng action của miền");
}
