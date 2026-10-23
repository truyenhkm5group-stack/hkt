/**
 * ═══ SRC-5a · LƯU MẪU TEST- + YÊU CẦU MUA THỬ CÓ DUYỆT + VÒNG PHẢN HỒI (Tech Lead duyệt 24/10/2026) ═══
 *
 * Khoá: (1) lưu mẫu = mã TEST- ở sổ mẫu qua đúng `registerProvisionalModelCore` — không dòng products / variants, lưu lại ra cùng
 * mẫu; (2) mua thử LUÔN phải duyệt (nhóm SOURCING_TRIAL, kể cả khi cưỡng chế tắt), người xin không tự duyệt; (3) ẢNH CHỤP lúc xin
 * bất biến khi tham số đổi; (4) «đã đặt» chỉ người xin, chỉ khi lời duyệt còn hạn, tiêu thụ lời duyệt đúng một lần; «đã về» / «huỷ»
 * mang khoá tài khoản; (5) vòng phản hồi «chưa đo được» khi chưa có mã / phiếu, giá nhập thật bỏ dòng chưa có giá; (6) SERVE-COMPAT
 * 0258 — chưa áp thì không để lại mẫu TEST- hay yêu cầu duyệt mồ côi; (7) không đường nào gọi ra ngoài.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { and, count, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { approvalFingerprint, decideApprovalCore } from "@/lib/approvals/service";
import { ALWAYS_REQUIRE_APPROVAL_GROUPS, APPROVAL_GROUPS_WIRED, APPROVAL_VALID_HOURS } from "@/lib/constants/approval";
import { EMPTY_LANDED_COST, SOURCING_LANDED_COST_KEY, type LandedCostConfig } from "@/lib/constants/sourcing";
import { getOfferShortlist, getSourcingTrial } from "@/lib/queries/sourcing-trials";
import { setSettingJson } from "@/lib/settings";
import { addSourcingWeight, createSourcingOffer, type SourcingActor } from "@/lib/sourcing/offer-service";
import { canCancelTrial, deriveTrialState, parseTrialLines, trialApprovalPayload, validateTrialLines } from "@/lib/sourcing/trial";
import { cancelSourcingTrial, markSourcingTrialOrdered, markSourcingTrialReceived, requestSourcingTrial, saveOfferToShortlist } from "@/lib/sourcing/trial-service";

const P = "src5-";
const CFG: LandedCostConfig = { ...EMPTY_LANDED_COST, cnyToVnd: 3550, fxAsOf: "2026-10-20", fxSource: "VCB", cnDomesticShipCny: 20, intlFreightVndPerKg: 30000, agentFeePercent: 3, dutyVatPercent: 10, otherVndPerUnit: 2000 };

function testPure() {
  assert.ok(ALWAYS_REQUIRE_APPROVAL_GROUPS.includes("SOURCING_TRIAL") && !APPROVAL_GROUPS_WIRED.includes("SOURCING_TRIAL"), "luôn phải duyệt, KHÔNG có công tắc");
  const v = validateTrialLines([
    { color: " đen ", size: "XL", qty: 6 },
    { color: "trắng", size: "XL", qty: 4 },
  ]);
  assert.deepEqual(v, { lines: [{ color: "đen", size: "XL", qty: 6 }, { color: "trắng", size: "XL", qty: 4 }], totalQty: 10 });
  assert.match((validateTrialLines([{ color: "Đen", size: "xl", qty: 1 }, { color: "đen", size: "XL", qty: 2 }]) as { error: string }).error, /trùng màu \/ cỡ/, "không tự gộp — nói ra");
  assert.match((validateTrialLines([{ color: "", size: "", qty: 0 }]) as { error: string }).error, /số nguyên ≥ 1/);
  assert.equal(parseTrialLines([{ color: "đen", size: "XL", qty: "6" }]), null, "jsonb sai kiểu ⇒ null");

  const S = (status: string, stillValid = true) => ({ status, stillValid });
  assert.deepEqual(
    [
      deriveTrialState("REQUESTED", S("PENDING")),
      deriveTrialState("REQUESTED", S("APPROVED")),
      deriveTrialState("REQUESTED", S("APPROVED", false)),
      deriveTrialState("REQUESTED", S("REJECTED")),
      deriveTrialState("REQUESTED", S("EXPIRED")),
      deriveTrialState("REQUESTED", null),
      deriveTrialState("ORDERED", S("EXECUTED")),
      deriveTrialState("CANCELLED", S("PENDING")),
    ],
    ["PENDING_APPROVAL", "APPROVED", "APPROVAL_EXPIRED", "REJECTED", "APPROVAL_EXPIRED", "NO_APPROVAL", "ORDERED", "CANCELLED"],
  );
  assert.deepEqual(["PENDING_APPROVAL", "APPROVED", "ORDERED", "RECEIVED", "REJECTED"].map((s) => canCancelTrial(s as never)), [false, true, true, false, true], "đang chờ duyệt ⇒ người duyệt từ chối là cách rút; hàng về rồi không huỷ");

  // Dấu vân tay lúc xin = lúc tiêu thụ, kể cả khi jsonb đổi thứ tự khoá.
  const a = trialApprovalPayload({ id: "t1", totalQty: 10, quantities: [{ color: "đen", size: "XL", qty: 10 }], unitEstimateVnd: 70702 });
  const b = trialApprovalPayload({ id: "t1", totalQty: 10, quantities: JSON.parse('[{"qty":10,"size":"XL","color":"đen"}]'), unitEstimateVnd: 70702 });
  const fp = (payload: unknown) => approvalFingerprint({ group: "SOURCING_TRIAL", action: "SOURCING_TRIAL_ORDER", entity: "SOURCING_TRIAL", entityId: "t1", payload });
  assert.equal(fp(a), fp(b));
}

async function testDb() {
  const db = await getDb();
  const mk = async (suffix: string, role: "MANAGER" | "ADMIN"): Promise<SourcingActor> => {
    await db.insert(schema.users).values({ id: `${P}${suffix}`, email: `${suffix}@src5.test`, name: `Người ${suffix}`, passwordHash: "x", role }).onConflictDoNothing();
    return { id: `${P}${suffix}`, email: `${suffix}@src5.test` };
  };
  const R = await mk("xin", "MANAGER");
  const A = await mk("duyet", "ADMIN");
  const O = await mk("khac", "MANAGER");
  await setSettingJson(SOURCING_LANDED_COST_KEY, CFG);
  try {
    const productsBefore = Number((await db.select({ n: count() }).from(schema.products))[0].n);
    const offer = await createSourcingOffer(R, { url: "https://detail.1688.com/offer/655555555555.html", titleVi: "Đầm mua thử", titleZh: "", imageUrl: "", supplierShopUrl: "", supplierName: "", tiers: [{ fromQty: 2, price: "12.30" }, { fromQty: 50, price: "11.80" }], moq: 2, colors: "đen, trắng", sizes: "XL" });
    assert.ok(offer.ok, JSON.stringify(offer));
    const offerId = offer.id;
    assert.ok((await addSourcingWeight(R, { offerId, grams: 350 })).ok);

    const early = await requestSourcingTrial(R, { offerId, lines: [{ color: "đen", size: "XL", qty: 10 }] });
    assert.ok(!early.ok && /Lưu mẫu/.test(early.errors[0].message), "phải lưu mẫu trước");

    // (1) Lưu mẫu ⇒ TEST- ở sổ mẫu, không dòng products.
    const s1 = await saveOfferToShortlist(R, { offerId });
    assert.ok(s1.ok, JSON.stringify(s1));
    const s2 = await saveOfferToShortlist(R, { offerId });
    assert.ok(s2.ok && s2.id === s1.id && /từ trước/.test(s2.message), "lưu lại ⇒ cùng mẫu, không cấp mã thứ hai");
    const sv = await getOfferShortlist(offerId);
    assert.ok(!sv.unavailable && sv.shortlist);
    assert.match(sv.shortlist.modelCode, /^TEST-\d{6}-\d{2,}$/);
    assert.equal(sv.shortlist.productId, null, "mẫu TEST- chưa có sản phẩm");
    assert.equal(Number((await db.select({ n: count() }).from(schema.products))[0].n), productsBefore, "không tạo dòng products nào (không tồn kho, không giá vốn)");

    // (2) Xin ⇒ LUÔN cần duyệt, kể cả cưỡng chế tắt (mặc định).
    const req = await requestSourcingTrial(R, { offerId, lines: [{ color: "đen", size: "XL", qty: 6 }, { color: "trắng", size: "XL", qty: 4 }] });
    assert.ok(req.ok, JSON.stringify(req));
    const [row] = await db.select().from(schema.sourcingTrialRequests).where(eq(schema.sourcingTrialRequests.id, req.id));
    assert.deepEqual([row.status, row.totalQty, row.requestedBy], ["REQUESTED", 10, R.id]);
    const [apr] = await db.select().from(schema.approvalRequests).where(eq(schema.approvalRequests.id, row.approvalRequestId!));
    assert.deepEqual([apr.group, apr.status, apr.requestedBy, apr.entity, apr.entityId], ["SOURCING_TRIAL", "PENDING", R.id, "SOURCING_TRIAL", req.id]);
    assert.equal(apr.amount, 70702 * 10, "số tiền trên lời duyệt = ước tính lúc xin × số lượng");
    const d0 = await getSourcingTrial(req.id);
    assert.ok(d0 && !("unavailable" in d0));
    assert.deepEqual([d0.state, d0.snapshot?.landed.kind === "ESTIMATE" && d0.snapshot.landed.totalVnd, d0.snapshot?.weightG], ["PENDING_APPROVAL", 70702, 350], "ảnh chụp mang giá về ước tính lúc xin");

    assert.ok(!(await markSourcingTrialOrdered(R, { trialId: req.id })).ok, "chờ duyệt ⇒ chưa đặt được");
    assert.deepEqual(await decideApprovalCore(db, { ...R, canDecide: true }, apr.id, true, undefined), { error: "Người xin không được tự duyệt việc của mình" });
    assert.deepEqual(await decideApprovalCore(db, { ...A, canDecide: true }, apr.id, true, "ok, mua thử 10"), { ok: true });

    // (3) Ảnh chụp bất biến: đổi tham số sau khi xin không đổi con số đã duyệt.
    await setSettingJson(SOURCING_LANDED_COST_KEY, { ...CFG, cnyToVnd: 4000 });
    const d1 = await getSourcingTrial(req.id);
    assert.ok(d1 && !("unavailable" in d1));
    assert.equal(d1.snapshot?.landed.kind === "ESTIMATE" ? d1.snapshot.landed.totalVnd : null, 70702, "tham số đổi ⇒ ảnh chụp KHÔNG tính lại");
    assert.equal(d1.state, "APPROVED");

    // (4) Đã đặt: chỉ người xin; tiêu thụ đúng một lần.
    const byOther = await markSourcingTrialOrdered(O, { trialId: req.id, note: "đặt hộ" });
    assert.ok(!byOther.ok && /Chỉ người xin/.test(byOther.errors[0].message));
    assert.ok((await markSourcingTrialOrdered(R, { trialId: req.id, note: "đặt trên 1688, đơn 123" })).ok);
    const [apr2] = await db.select().from(schema.approvalRequests).where(eq(schema.approvalRequests.id, apr.id));
    assert.equal(apr2.status, "EXECUTED", "lời duyệt đã tiêu thụ");
    const [row2] = await db.select().from(schema.sourcingTrialRequests).where(eq(schema.sourcingTrialRequests.id, req.id));
    assert.deepEqual([row2.status, row2.orderedBy, row2.orderNote], ["ORDERED", R.id, "đặt trên 1688, đơn 123"], "mang khoá tài khoản người bấm");
    assert.ok(!(await markSourcingTrialOrdered(R, { trialId: req.id })).ok, "đặt lần hai bị chặn");

    // Đã về: phiếu không có / không phải RECEIPT bị chặn; người bấm khác người xin vẫn được.
    assert.ok(!(await markSourcingTrialReceived(O, { trialId: req.id, receiptId: "khong-co" })).ok);
    const [ret] = await db.insert(schema.stockReceipts).values({ kind: "RETURN", receivedAt: new Date(), reference: `${P}rt`, createdBy: "t" }).returning({ id: schema.stockReceipts.id });
    const notReceipt = await markSourcingTrialReceived(O, { trialId: req.id, receiptId: ret.id });
    assert.ok(!notReceipt.ok && /RECEIPT/.test(notReceipt.errors[0].message));
    const [rc] = await db.insert(schema.stockReceipts).values({ kind: "RECEIPT", receivedAt: new Date(), reference: `${P}rc`, createdBy: "t" }).returning({ id: schema.stockReceipts.id });
    assert.ok((await markSourcingTrialReceived(O, { trialId: req.id, receiptId: rc.id, note: "đủ 10" })).ok);

    // (5) Vòng phản hồi: chưa có mã ⇒ chưa đo được.
    const d2 = await getSourcingTrial(req.id);
    assert.ok(d2 && !("unavailable" in d2));
    assert.deepEqual([d2.state, d2.receivedByName, d2.feedback.signal, d2.feedback.realCost, d2.feedback.diffVnd], ["RECEIVED", "Người khac", null, null, null]);
    assert.match(d2.feedback.signalNote!, /chưa có mã chính thức/);
    assert.match(d2.feedback.realCostNote!, /chưa nối sản phẩm/);

    // Mẫu được nối sản phẩm + phiếu có giá ⇒ giá nhập thật; dòng giá 0 không kéo bình quân xuống.
    await db.insert(schema.products).values({ id: `${P}prod`, name: "Đầm mua thử (đã lên mã)" }).onConflictDoNothing();
    await db.insert(schema.productVariants).values({ id: `${P}var`, productId: `${P}prod`, sku: "SRC5-1", retailPrice: 299_000 }).onConflictDoNothing();
    await db.update(schema.productModels).set({ productId: `${P}prod` }).where(eq(schema.productModels.id, sv.shortlist.modelId));
    await db.insert(schema.stockReceiptItems).values([
      { receiptId: rc.id, variantId: `${P}var`, quantity: 10, unitCost: 80_000 },
      { receiptId: rc.id, variantId: `${P}var`, quantity: 2, unitCost: 0 },
    ]);
    const d3 = await getSourcingTrial(req.id);
    assert.ok(d3 && !("unavailable" in d3));
    assert.deepEqual(d3.feedback.realCost, { pricedQty: 10, unpricedQty: 2, unitVnd: 80_000 });
    assert.equal(d3.feedback.diffVnd, 80_000 - 70702, "chênh = giá nhập thật − ước tính TRONG ảnh chụp");
    assert.ok(d3.feedback.signal !== null || d3.feedback.signalNote !== null, "tín hiệu mẫu: có số thật hoặc nói rõ vì sao chưa");

    // Từ chối ⇒ huỷ được; đang chờ ⇒ không huỷ; huỷ hai lần chỉ một dòng nhật ký.
    const req2 = await requestSourcingTrial(R, { offerId, lines: [{ color: "đen", size: "XL", qty: 20 }] });
    assert.ok(req2.ok);
    assert.ok(!(await cancelSourcingTrial(R, { trialId: req2.id, reason: "đổi ý" })).ok, "đang chờ duyệt ⇒ không tự rút");
    const [apr3] = await db.select().from(schema.approvalRequests).where(and(eq(schema.approvalRequests.entityId, req2.id), eq(schema.approvalRequests.group, "SOURCING_TRIAL")));
    assert.deepEqual(await decideApprovalCore(db, { ...A, canDecide: true }, apr3.id, false, undefined), { error: "Từ chối phải nêu lý do — người xin cần biết vì sao" });
    assert.ok("ok" in (await decideApprovalCore(db, { ...A, canDecide: true }, apr3.id, false, "MOQ quá cao")));
    assert.ok((await cancelSourcingTrial(R, { trialId: req2.id, reason: "bị từ chối, bỏ" })).ok);
    assert.ok((await cancelSourcingTrial(R, { trialId: req2.id, reason: "bấm lại" })).ok);
    assert.equal((await db.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.action, "SOURCING_TRIAL_CANCEL"), eq(schema.auditLogs.entityId, req2.id)))).length, 1);

    // Lời duyệt quá hạn ⇒ không đặt được, phải xin lại.
    const req3 = await requestSourcingTrial(R, { offerId, lines: [{ color: "trắng", size: "XL", qty: 5 }] });
    assert.ok(req3.ok);
    const [apr4] = await db.select().from(schema.approvalRequests).where(eq(schema.approvalRequests.entityId, req3.id));
    assert.ok("ok" in (await decideApprovalCore(db, { ...A, canDecide: true }, apr4.id, true, undefined)));
    const late = await markSourcingTrialOrdered(R, { trialId: req3.id }, new Date(Date.now() + (APPROVAL_VALID_HOURS + 1) * 3_600_000));
    assert.ok(!late.ok && /hết hạn/.test(late.errors[0].message), JSON.stringify(late));

    // (6) SERVE-COMPAT 0258: chưa áp ⇒ không cấp TEST-, không xin duyệt.
    const offer2 = await createSourcingOffer(R, { url: "https://detail.1688.com/offer/666666666666.html", titleVi: "Mẫu khi chưa áp", titleZh: "", imageUrl: "", supplierShopUrl: "", supplierName: "", tiers: [{ fromQty: 1, price: "10" }], moq: null, colors: "", sizes: "" });
    assert.ok(offer2.ok);
    const modelsBefore = Number((await db.select({ n: count() }).from(schema.productModels))[0].n);
    const approvalsBefore = Number((await db.select({ n: count() }).from(schema.approvalRequests))[0].n);
    await db.execute(sql.raw(`ALTER TABLE sourcing_trial_requests RENAME TO sourcing_trial_requests_tam`));
    try {
      assert.deepEqual(await getOfferShortlist(offerId), { unavailable: true });
      assert.deepEqual(await getSourcingTrial(req.id), { unavailable: true });
      const w = await saveOfferToShortlist(R, { offerId: offer2.id });
      assert.ok(!w.ok && /0258/.test(w.errors[0].message));
      const w2 = await requestSourcingTrial(R, { offerId, lines: [{ color: "đen", size: "XL", qty: 1 }] });
      assert.ok(!w2.ok && /0258/.test(w2.errors[0].message));
    } finally {
      await db.execute(sql.raw(`ALTER TABLE sourcing_trial_requests_tam RENAME TO sourcing_trial_requests`));
    }
    assert.equal(Number((await db.select({ n: count() }).from(schema.productModels))[0].n), modelsBefore, "chưa áp ⇒ không mẫu TEST- mồ côi");
    assert.equal(Number((await db.select({ n: count() }).from(schema.approvalRequests))[0].n), approvalsBefore, "chưa áp ⇒ không yêu cầu duyệt mồ côi");

    // Dọn (mẫu TEST- ở lại sổ mẫu, như các bài kiểm sổ mẫu khác — gỡ nối sản phẩm để không chạm bài khác).
    await db.update(schema.productModels).set({ productId: null }).where(eq(schema.productModels.id, sv.shortlist.modelId));
    await db.delete(schema.stockReceipts).where(sql`${schema.stockReceipts.reference} like ${`${P}%`}`);
    await db.delete(schema.productVariants).where(eq(schema.productVariants.id, `${P}var`));
    await db.delete(schema.products).where(eq(schema.products.id, `${P}prod`));
    await db.delete(schema.sourcingTrialRequests);
    await db.delete(schema.approvalRequests).where(eq(schema.approvalRequests.group, "SOURCING_TRIAL"));
    await db.delete(schema.sourcingShortlist);
    await db.delete(schema.sourcingOfferWeights);
    await db.delete(schema.sourcingOfferSnapshots);
    await db.delete(schema.sourcingOffers);
    await db.delete(schema.sourcingSuppliers);
  } finally {
    await db.delete(schema.settings).where(eq(schema.settings.key, SOURCING_LANDED_COST_KEY));
  }
}

function testSourceFences() {
  const svc = readFileSync("lib/sourcing/trial-service.ts", "utf8");
  assert.ok(!/\bfetch\(|fetchJson\(|sendMessage|pancake/i.test(svc.replace(/\/\*[\s\S]*?\*\//g, "")), "không đường nào gọi ra ngoài / ghi Pancake");
  assert.ok(!/insert\(schema\.products\)|insert\(schema\.productVariants\)|setEstimatedCost|insert\(schema\.stockReceipts\)/.test(svc), "không tạo sản phẩm / phiếu kho / giá dự tính");
  assert.ok(svc.includes("registerProvisionalModelCore(") && svc.includes('group: "SOURCING_TRIAL"'), "TEST- qua đúng đường có sẵn; duyệt qua lõi chung");
  assert.ok(!/snapshot:\s*[^,}]*\}\)\s*\.where|set\(\{[^}]*snapshot/.test(svc), "ảnh chụp không có đường sửa");
  const act = readFileSync("lib/actions/sourcing-trials.ts", "utf8");
  assert.equal((act.match(/const user = await requireUser\(\);\n {2}if \(!can\(user, "sourcing:write"\)\) return NO_RIGHT;/g) ?? []).length, 5, "năm action hỏi phiên + sourcing:write ngay lượt đầu");
  assert.ok(!/decideApproval/.test(act), "duyệt KHÔNG ở đây — chỉ trang Duyệt của lõi");
  assert.ok(readFileSync("lib/approvals/service.ts", "utf8").includes("ALWAYS_REQUIRE_APPROVAL_GROUPS.includes(input.group) ||"), "cổng chung coi nhóm luôn-phải-duyệt như đang bật");
}

export async function testSourcingTrials() {
  testPure();
  await testDb();
  testSourceFences();
  console.log("  ✓ SRC-5a lưu mẫu + mua thử: TEST- ở sổ mẫu, không dòng products · luôn phải duyệt (kể cả cưỡng chế tắt), người xin không tự duyệt · ảnh chụp lúc xin bất biến · «đã đặt» chỉ người xin, tiêu thụ lời duyệt một lần, quá hạn phải xin lại · đã về / huỷ mang khoá tài khoản · giá nhập thật bỏ dòng chưa có giá · chưa áp 0258 không để lại mồ côi");
}
