/**
 * KHAI SỔ DỮ KIỆN BÁN HÀNG CHO MỘT PAGE, RỒI KIỂM TRA NGAY MÁY TRẢ LỜI ĐƯỢC NHỮNG GÌ.
 *
 *   npx tsx scripts/ai-sales-knowledge.ts --page=<ID> [--apply]
 *
 * Mặc định CHẠY THỬ: in ra nó ĐỊNH ghi gì, lệch gì với ERP, rồi dừng. `--apply` mới ghi.
 *
 * ─── VÌ SAO CÁC CON SỐ NẰM TRONG TỆP NÀY MÀ KHÔNG PHẢI TRONG LỜI NHẮC MÔ HÌNH ───
 *
 * Tệp này là CÁI BƠM: nó đẩy dữ liệu chủ shop đã chốt vào CSDL đúng một lần. Lúc chạy thật, máy
 * đọc CSDL — không đọc tệp này, và không có con số nào trong lời nhắc. Nhờ vậy đổi giá là sửa một
 * ô trên màn hình, không phải đi tìm xem còn bản sao nào của con số ấy trong mã nguồn.
 *
 * ─── MÂU THUẪN THÌ BÁO, KHÔNG ÂM THẦM ĐÈ ───
 *
 * Giá chủ shop chốt cho kênh này có thể khác giá ERP một cách chính đáng. Tệp này ghi giá đã chốt
 * và IN RA chỗ lệch; nó không sửa ERP, và cũng không bỏ giá đã chốt để lấy giá ERP.
 */
import "dotenv/config";
import { eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { ensureMigrated } from "@/db/migrate";
import { rowsOf } from "@/lib/sql-rows";
import { answerFromKnowledge, winIntentOf } from "@/lib/ai-workforce/agents/sales/answer-win";
import { extractColor, extractMeasurements, extractSize } from "@/lib/ai-workforce/agents/sales/extract-slots";
import { checkSellability } from "@/lib/queries/sellability";
import { generateTestReply, testIntentOf, type TestFacts } from "@/lib/ai-workforce/agents/sales/generate-test";
import { CAPABILITY_LABEL, SALES_CAPABILITIES } from "@/lib/constants/sales-capabilities";
import { discoverKnowledgeGaps, loadTestKnowledge, loadWinKnowledge, sizeRuleFor } from "@/lib/queries/sales-knowledge";
import { runShadowBenchmark } from "@/lib/queries/shadow-benchmark";

/**
 * DỮ LIỆU CHỦ SHOP ĐÃ XÁC NHẬN cho mã Q004.
 *
 * Không có ô nào ở đây là phỏng đoán. Ô nào chủ shop chưa phát biểu thì KHÔNG có mặt trong bảng
 * này — nó ở lại danh sách "còn thiếu" chứ không được điền bằng một giá trị nghe hợp lý.
 * Cụ thể: BẢNG SỐ ĐO và CHÍNH SÁCH ĐỔI TRẢ cố tình vắng mặt.
 */
const XAC_NHAN = {
  unitPrice: 499_000,
  shippingFee: 25_000,
  comboPricing: [{ quantity: 2, price: 849_000, freeShipping: true }],
  availableColors: ["Đỏ", "Nâu", "Đen"],
  material: "Rayon co giãn 4 chiều",
  codPolicy: "Bên em có ship COD, chị nhận hàng rồi thanh toán cho shipper",
  inspectionPolicy: "Chị được kiểm hàng trước khi thanh toán",
  deliveryEstimate: "2–4 ngày",
} as const;

/**
 * BẢNG SỐ ĐO — KHÔNG CÓ Ở ĐÂY, VÀ ĐÓ LÀ CÂU TRẢ LỜI ĐÚNG.
 *
 * Chủ shop chưa phát biểu bảng cao/nặng ↔ size cho Q004. Bằng chứng đo được: câu shop gửi nhiều
 * nhất trên chính page này là "Chị cho em xin Chiều Cao + Cân Nặng để em tư vấn size cho chị nha"
 * (16 lần) — tức chính shop cũng hỏi rồi quyết bằng tay, không đọc từ một bảng nào.
 *
 * Nhãn size trong danh mục (M · L · XL · 2XL) KHÔNG suy ra được bảng: ERP biết mẫu có size nào,
 * không biết ai mặc vừa size nào. Điền hộ một bảng nghe hợp lý là gửi đi những kiện hàng không
 * vừa, và tỷ lệ hoàn là con số cả hệ thống này sinh ra để giữ.
 *
 * Bảng khai ở `/ai/fanpage` → mục "Bảng số đo", ghi vào `settings["ai.sizeRules"]`.
 */

/** Câu khách hay hỏi nhất — dùng làm mốc đối chiếu khi bật mô hình thật. */
const CAU_HOI_WIN = [
  "Bao nhiêu em?",
  "Mua 2 cái bao nhiêu?",
  "Ship bao nhiêu?",
  "Có màu gì?",
  "50kg mặc size gì?",
  "Eo 74 thì mặc size gì?",
  "Màu đỏ size L còn không?",
  "Có được kiểm hàng không?",
  "Bao lâu nhận được?",
  "Không vừa có đổi được không?",
  "Chị lấy đỏ size L",
  "Chốt cho chị 2 cái",
];
const CAU_HOI_TEST = ["Bao nhiêu em?", "Có màu gì?", "50kg mặc size gì?", "chốt cho em 1 cái"];

function inNangLuc(caps: Record<string, { on: boolean; missing: string[] }>) {
  for (const c of SALES_CAPABILITIES) {
    const st = caps[c];
    console.log(`   ${st.on ? "🟢" : "⚪"} ${CAPABILITY_LABEL[c].padEnd(24)} ${st.on ? "" : `thiếu: ${st.missing.join(", ")}`}`);
  }
}

async function main() {
  const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
  const apDung = process.argv.includes("--apply");
  const pageId = arg("page") ?? "";
  await ensureMigrated();
  const db = await getDb();

  // Thiếu --page thì LIỆT KÊ page có thật rồi dừng, thay vì báo "thiếu tham số". Người chạy lệnh
  // này thường không thuộc lòng id page của Pancake, và bắt họ đi tra ở một chỗ khác là bắt họ mở
  // thêm một màn hình cho một việc đáng lẽ một lệnh.
  if (!pageId) {
    const ds = await db.execute(sql`
      select c.page_id, count(*)::int as n, coalesce(f.name, '') as ten, coalesce(p.custom_id, '') as ma
      from sales_conversations c
      left join fanpage_sales_profiles f on f.pancake_page_id = c.page_id
      left join products p on p.id = f.active_product_id
      where c.page_id <> '' group by 1, 3, 4 order by 2 desc limit 20
    `);
    console.log("\nThiếu --page. Các page đang có hội thoại trong bản chạy thử:");
    for (const r of rowsOf<Record<string, unknown>>(ds)) {
      console.log(`   --page=${r.page_id}   ${String(r.n).padStart(4)} hội thoại   ${r.ten || "(chưa khai hồ sơ)"}   ${r.ma ? `mã WIN ${r.ma}` : "chưa có mã WIN"}`);
    }
    process.exit(1);
  }

  const [hoSo] = await db.select().from(schema.fanpageSalesProfiles).where(eq(schema.fanpageSalesProfiles.pancakePageId, pageId)).limit(1);
  if (!hoSo) { console.error(`Page ${pageId} chưa có hồ sơ bán hàng — khai mã WIN trước ở /ai/fanpage`); process.exit(1); }

  // ───── ① ĐỊNH GHI GÌ, VÀ LỆCH GÌ SO VỚI ĐANG CÓ ─────
  console.log(`\n① SỔ DỮ KIỆN ĐỊNH GHI CHO PAGE ${pageId}${apDung ? "" : "  (CHẠY THỬ — chưa ghi)"}`);
  const doi: string[] = [];
  const giu = (ten: string, cu: unknown, moi: unknown) => {
    const a = JSON.stringify(cu ?? null);
    const b = JSON.stringify(moi ?? null);
    if (a !== b) doi.push(`   · ${ten}: ${a} → ${b}`);
  };
  giu("giá bán", hoSo.unitPrice, XAC_NHAN.unitPrice);
  giu("phí ship", hoSo.shippingFee, XAC_NHAN.shippingFee);
  giu("giá combo", hoSo.comboPricing, XAC_NHAN.comboPricing);
  giu("màu", hoSo.availableColors, XAC_NHAN.availableColors);
  giu("chất liệu", hoSo.material, XAC_NHAN.material);
  giu("COD", hoSo.codPolicy, XAC_NHAN.codPolicy);
  giu("kiểm hàng", hoSo.inspectionPolicy, XAC_NHAN.inspectionPolicy);
  giu("thời gian giao", hoSo.deliveryEstimate, XAC_NHAN.deliveryEstimate);
  console.log(doi.length ? doi.join("\n") : "   (không đổi gì)");
  console.log("   KHÔNG ghi: bảng số đo · chính sách đổi trả — chủ shop chưa phát biểu, và máy không được điền hộ.");
  console.log("   (bảng số đo khai ở /ai/fanpage mục 2; chính sách đổi trả ở mục 3 — cả hai đều CÓ MÀN KHAI, không phải chờ ai sửa mã)");

  if (apDung && doi.length) {
    await db
      .update(schema.fanpageSalesProfiles)
      .set({
        ...XAC_NHAN,
        comboPricing: [...XAC_NHAN.comboPricing],
        availableColors: [...XAC_NHAN.availableColors],
        // Đổi GIÁ ⇒ bản điều kiện bán mới. Đổi CHÍNH SÁCH ⇒ bản sổ dữ kiện mới. Hai số riêng.
        version: hoSo.unitPrice !== XAC_NHAN.unitPrice || hoSo.shippingFee !== XAC_NHAN.shippingFee ? hoSo.version + 1 : hoSo.version,
        knowledgeVersion: hoSo.knowledgeVersion + 1,
        effectiveFrom: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(schema.fanpageSalesProfiles.id, hoSo.id));
    console.log("   ✓ đã ghi");
  }

  const bd = await loadWinKnowledge(pageId, db);
  if (!bd) { console.error("Không đọc lại được hồ sơ"); process.exit(1); }

  // ───── ② ĐỐI CHIẾU ERP ─────
  console.log(`\n② ĐỐI CHIẾU VỚI ERP (mã ${bd.code || "chưa khai"})`);
  if (!bd.conflicts.length) console.log("   (không có gì để đối chiếu)");
  for (const c of bd.conflicts) {
    const nhan = c.kind === "CONFLICT" ? "⚠️  LỆCH" : c.kind === "CORROBORATED" ? "✓  khớp" : "·  ERP im";
    console.log(`   ${nhan}  ${c.field}: khai ${c.declared} | ERP ${c.erp}`);
    console.log(`            ${c.note}`);
  }

  // ───── ③ CỔNG NĂNG LỰC ─────
  console.log(`\n③ MÁY ĐƯỢC LÀM GÌ — đầy đủ ${bd.completeness}% · ${bd.ready ? "SẴN SÀNG" : "CÒN THIẾU: " + bd.missing.join(", ")}`);
  inNangLuc(bd.capabilities);

  // ───── ④ DỮ LIỆU CÒN THIẾU ─────
  console.log("\n④ DỮ LIỆU CÒN THIẾU — đã đi hỏi đâu, ai phải cung cấp");
  for (const g of await discoverKnowledgeGaps(pageId, db)) {
    console.log(`   [${g.verdict}] ${g.field}${g.code ? ` · ${g.code}` : ""}`);
    console.log(`        thấy: ${g.found}`);
    if (g.todo) console.log(`        việc: ${g.todo}`);
    console.log(`        tra:  ${g.lookedAt}`);
  }

  // ───── ⑤ MÁY TRẢ LỜI 10 CÂU — có nguồn từng con số ─────
  // Bảng số đo và danh sách size đang bán — tra MỘT LẦN, dùng cho cả mười hai câu.
  const sizeRule = await sizeRuleFor({ productId: hoSo.activeProductId, productCode: bd.code });
  const sizeERP = hoSo.activeProductId
    ? (await db
        .select({ size: schema.productVariants.size })
        .from(schema.productVariants)
        .where(eq(schema.productVariants.productId, hoSo.activeProductId))).map((r) => r.size).filter(Boolean)
    : [];

  console.log("\n⑤ TRẢ LỜI THỬ (KHÔNG gọi mô hình — luật thuần, chạy lại ra đúng một câu)");
  for (const q of CAU_HOI_WIN) {
    // Bóc màu / size / số đo từ chính câu khách — cùng bộ luật dây chuyền thật dùng.
    const mau = extractColor(q, bd.knowledge.colors);
    const sz = extractSize(q, sizeERP);
    const sl = hoSo.activeProductId ? await checkSellability({ productId: hoSo.activeProductId, color: mau, size: sz }, db) : null;
    const tl = answerFromKnowledge(winIntentOf(q), bd.knowledge, bd.permissions, {
      sizeRule,
      body: extractMeasurements(q),
      sellability: sl,
      policy: bd.policy,
      facts: bd.facts,
    });
    // CÔNG CỤ ĐÃ GỌI — nói thẳng ra, vì "máy lấy số ở đâu" và "máy đã hỏi ai" là hai câu khác
    // nhau, và câu thứ hai mới trả lời được "vì sao nó chắc chắn thế".
    const congCu = [
      tl.intent === "SIZE" ? "size-engine.recommendSize" : "",
      sl ? "sellability.checkSellability" : "",
      tl.intent === "EXCHANGE" ? "sales-policy.branchSentence" : "",
      "sales-knowledge.loadWinKnowledge",
    ].filter(Boolean);
    console.log(`\n   ❓ ${q}`);
    console.log(`   → [${tl.action}${tl.humanReview ? " · CHUYỂN NGƯỜI" : ""}] ${tl.text}`);
    console.log(`      ý định ${tl.intent} · năng lực ${tl.capability ?? "—"} (${tl.capability ? bd.capabilities[tl.capability].status : "—"})`);
    if (tl.missing.length) console.log(`      THIẾU DỮ LIỆU: ${tl.missing.join(", ")}`);
    if (tl.blockedBy) console.log(`      CHẶN BỞI QUYỀN: ${tl.blockedBy}`);
    console.log(`      công cụ: ${congCu.join(" · ")}`);
    console.log(`      nguồn: ${tl.provenance.length ? tl.provenance.map((p) => `${p.field}=${p.value} ← ${p.source}`).join(" | ") : "(không dữ kiện nào — đúng, vì câu này máy không trả lời)"}`);
  }

  // ───── ⑥ MẪU TEST: cùng cổng ấy, dữ liệu của chính nó ─────
  const test = await db.select().from(schema.testProductProfiles).limit(5);
  for (const t of test) {
    const bdT = await loadTestKnowledge(t.id, db);
    if (!bdT) continue;
    console.log(`\n⑥ MẪU TEST ${t.testCode} · ${t.name} — đầy đủ ${bdT.completeness}%`);
    inNangLuc(bdT.capabilities);
    const facts: TestFacts = {
      testCode: t.testCode, name: t.name, price: t.price, colors: t.colors, material: t.material,
      shippingPolicy: t.shippingPolicy, hasSizeProfile: bdT.knowledge.sizeRuleCount > 0, approvedFacts: bdT.knowledge.approvedFacts,
      policy: {
        aiReplyEnabled: t.aiReplyEnabled, allowQuotePrice: t.allowQuotePrice, allowAnswerMaterial: t.allowAnswerMaterial,
        allowAskSize: t.allowAskSize, allowCollectPreference: t.allowCollectPreference, allowCollectIntent: t.allowCollectIntent,
        allowCollectPhone: t.allowCollectPhone, allowCollectAddress: t.allowCollectAddress, allowOfferProduct: t.allowOfferProduct,
        allowAutoOrderCreate: t.allowAutoOrderCreate, allowConfirmOrder: t.allowConfirmOrder, allowPromotion: t.allowPromotion,
        allowUpsell: t.allowUpsell, allowFollowUp: t.allowFollowUp,
      },
    };
    let ro = 0;
    for (const q of CAU_HOI_TEST) {
      const tl = generateTestReply(testIntentOf(q), facts);
      // RÒ RỈ = câu trả lời cho mẫu test mang một con số hoặc mã của mẫu thắng.
      const ro1 = [String(XAC_NHAN.unitPrice / 1000), "849", bd.code].filter(Boolean).some((x) => tl.text.includes(x));
      if (ro1) ro += 1;
      console.log(`   ❓ ${q}`);
      console.log(`   → [${tl.action}${tl.handoffReason ? ` · ${tl.handoffReason}` : ""}] ${tl.text}`);
      console.log(`      dùng: ${tl.used.join(", ") || "—"} · thiếu: ${tl.missing.join(", ") || "—"}${ro1 ? "   ⛔ RÒ RỈ DỮ LIỆU MÃ WIN" : ""}`);
    }
    console.log(`   ⇒ rò rỉ sang mã WIN: ${ro} (phải bằng 0)`);
  }

  // ───── ⑦ CHẠY THỬ NGẦM ─────
  const bm = await runShadowBenchmark(pageId);
  console.log(`\n⑦ CHẠY THỬ NGẦM · ${bm.total} hội thoại có tin khách`);
  console.log(`   WIN ${bm.byType.WIN} · TEST ${bm.byType.TEST} · HUMAN_ONLY ${bm.byType.HUMAN_ONLY} · UNKNOWN ${bm.byType.UNKNOWN}`);
  console.log(`   WIN giải được ${bm.winResolved}/${bm.winTotal} · TEST gắn hồ sơ ${bm.testResolved}/${bm.testTotal}`);
  console.log(`   TEST bị xử như WIN: ${bm.testFellBackToWin}  ${bm.testFellBackToWin === 0 ? "✓" : "⛔ PHẢI BẰNG 0"}`);

  if (!apDung) console.log("\n(CHẠY THỬ — chưa ghi gì. Thêm --apply để ghi.)");
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
