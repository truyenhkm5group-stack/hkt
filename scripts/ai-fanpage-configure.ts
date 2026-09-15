/**
 * CẤU HÌNH MỘT PAGE RỒI CHẠY THỬ NGẦM NGAY — một lượt, đúng thứ tự vận hành.
 *
 *   npx tsx scripts/ai-fanpage-configure.ts --page=<ID> --win=Q004 \
 *       --test-source=<AD_ID> --test-name="Đầm test cổ lệch đỏ đô" [--apply]
 *
 * Mặc định CHẠY THỬ. `--apply` mới ghi.
 *
 * Mọi trường của mẫu test đều KHÔNG BẮT BUỘC, và đó là chủ ý: mẫu đang thử thường chưa có giá,
 * chưa có bảng số đo. Thiếu thì để TRỐNG rồi máy nói "chưa có" — tuyệt đối không điền hộ bằng dữ
 * liệu của mã WIN.
 */
import "dotenv/config";
import { and, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { ensureMigrated } from "@/db/migrate";
import { classifyConversationSource } from "@/lib/ai-workforce/agents/sales/classify-source";
import { runShadowBenchmark } from "@/lib/queries/shadow-benchmark";
import { loadTestKnowledge, loadWinKnowledge } from "@/lib/queries/sales-knowledge";
import { CAPABILITY_LABEL, SALES_CAPABILITIES } from "@/lib/constants/sales-capabilities";
import { generateTestReply, testIntentOf, type TestFacts } from "@/lib/ai-workforce/agents/sales/generate-test";
import { CLASSIFICATION_SOURCE_LABEL, SOURCE_TYPE_LABEL, TEST_REPLY_DEFAULTS, type ClassificationSource, type SourceType } from "@/lib/constants/fanpage-sales";

const BA_CAU = ["Bao nhiêu em?", "Có màu gì?", "50kg mặc size gì?"];

async function main() {
  const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
  const apDung = process.argv.includes("--apply");
  const pageId = arg("page") ?? "";
  if (!pageId) { console.error("Thiếu --page"); process.exit(1); }
  await ensureMigrated();
  const db = await getDb();

  // ───── 1. MÃ WIN ─────
  const maWin = arg("win") ?? "";
  let winId: string | null = null;
  if (maWin) {
    const [sp] = await db.select({ id: schema.products.id, name: schema.products.name }).from(schema.products).where(eq(schema.products.customId, maWin)).limit(1);
    if (!sp) { console.error(`Không tìm thấy mã hàng "${maWin}"`); process.exit(1); }
    winId = sp.id;
    console.log(`\n① MÃ WIN: ${maWin} · ${sp.name}`);
  }

  const hoSo = await db.query.fanpageSalesProfiles.findFirst({ where: eq(schema.fanpageSalesProfiles.pancakePageId, pageId) });
  const doiBanChat = hoSo && hoSo.activeProductId !== winId;

  if (apDung && winId) {
    if (hoSo) {
      await db.update(schema.fanpageSalesProfiles)
        .set({ activeProductId: winId, version: doiBanChat ? hoSo.version + 1 : hoSo.version, effectiveFrom: doiBanChat ? new Date() : hoSo.effectiveFrom, updatedAt: new Date() })
        .where(eq(schema.fanpageSalesProfiles.id, hoSo.id));
      console.log(`   hồ sơ bản ${hoSo.version}${doiBanChat ? ` → ${hoSo.version + 1}` : " (không đổi)"}`);
    } else {
      await db.insert(schema.fanpageSalesProfiles).values({ pancakePageId: pageId, name: arg("name") ?? "", activeProductId: winId, aiMode: "SHADOW", version: 1, effectiveFrom: new Date() });
      console.log("   tạo hồ sơ mới, bản 1");
    }
  }

  // ───── 2. NGUỒN TEST ─────
  const nguonTest = arg("test-source") ?? "";
  if (nguonTest) {
    const ten = arg("test-name") ?? "Mẫu test chưa đặt tên";
    console.log(`\n② NGUỒN TEST: ${nguonTest} → "${ten}"`);
    if (apDung) {
      let tpId = (await db.query.testProductProfiles.findFirst({ where: eq(schema.testProductProfiles.sourceId, nguonTest) }))?.id ?? null;
      if (!tpId) {
        const nam = new Date().getFullYear();
        const [dem] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.testProductProfiles).where(sql`${schema.testProductProfiles.testCode} like ${`TEST-${nam}-%`}`);
        const testCode = `TEST-${nam}-${String(Number(dem?.n ?? 0) + 1).padStart(3, "0")}`;
        const [moi] = await db.insert(schema.testProductProfiles).values({
          testCode, name: ten, pancakePageId: pageId, sourceId: nguonTest,
          // CỐ TÌNH ĐỂ TRỐNG: giá · màu · chất liệu · bảng số đo. Chưa đo được thì chưa khai, và
          // máy phải cư xử đúng với chỗ trống ấy chứ không mượn của mã WIN.
          price: null, colors: [], material: "", shippingPolicy: "",
          status: "RUNNING", startAt: new Date(),
        }).returning({ id: schema.testProductProfiles.id });
        tpId = moi.id;
        console.log(`   tạo hồ sơ ${testCode} (giá/màu/chất liệu/bảng size để TRỐNG)`);
      }
      const luat = await db.query.salesSourceRules.findFirst({ where: and(eq(schema.salesSourceRules.pancakePageId, pageId), eq(schema.salesSourceRules.sourceId, nguonTest)) });
      if (luat) {
        await db.update(schema.salesSourceRules).set({ sourceType: "TEST", testProductId: tpId, productId: null, updatedAt: new Date() }).where(eq(schema.salesSourceRules.id, luat.id));
      } else {
        await db.insert(schema.salesSourceRules).values({ pancakePageId: pageId, sourceKind: "AD", sourceId: nguonTest, sourceType: "TEST", testProductId: tpId });
      }
      console.log("   đã khai luật nguồn TEST");
    }
  }

  if (!apDung) { console.log("\n--dry-run: KHÔNG ghi gì. Thêm --apply để lưu.\n"); }

  // ───── 3. CHẠY THỬ NGẦM ─────
  const bm = await runShadowBenchmark(pageId);
  console.log(`\n③ CHẠY THỬ NGẦM — ${bm.total} hội thoại có tin khách`);
  for (const k of ["WIN", "TEST", "HUMAN_ONLY", "UNKNOWN"] as SourceType[]) {
    console.log(`   ${SOURCE_TYPE_LABEL[k].padEnd(18)} ${bm.byType[k]}`);
  }
  console.log("   ── căn cứ phân loại ──");
  for (const [k, n] of Object.entries(bm.bySource)) {
    console.log(`   ${CLASSIFICATION_SOURCE_LABEL[k as ClassificationSource].padEnd(26)} ${n}`);
  }
  const tyWin = bm.winTotal ? Math.round((bm.winResolved / bm.winTotal) * 100) : 0;
  const tyTest = bm.testTotal ? Math.round((bm.testResolved / bm.testTotal) * 100) : 0;
  console.log(`   WIN nhận ra mẫu      ${bm.winResolved}/${bm.winTotal} (${tyWin}%)`);
  console.log(`   TEST gắn được hồ sơ  ${bm.testResolved}/${bm.testTotal} (${tyTest}%)`);
  console.log(`   chưa kết luận được   ${bm.unresolved}`);
  console.log(`   TEST BỊ XỬ NHƯ WIN   ${bm.testFellBackToWin}   ${bm.testFellBackToWin === 0 ? "✓ (phải bằng 0)" : "✗ HỎNG"}`);

  // ───── 4. CỔNG NĂNG LỰC CỦA MÃ WIN ─────
  //
  // Đọc qua `loadWinKnowledge()` — một đường đọc duy nhất cho "hồ sơ này còn thiếu gì". Bản kiểm
  // kê riêng từng sống ở `shadow-benchmark.ts` và đã bắt đầu trả lời khác: nó không biết bảng số đo
  // nằm ở máy gợi ý size, cũng không biết quyền nào đang chặn.
  const bd = await loadWinKnowledge(pageId, db);
  if (bd) {
    console.log(`\n④ MÃ WIN ${bd.code || "(chưa khai)"} — đầy đủ dữ liệu ${bd.completeness}% · ${bd.ready ? "SẴN SÀNG" : "CÒN THIẾU"}`);
    for (const c of SALES_CAPABILITIES) {
      const st = bd.capabilities[c];
      const dau = st.status === "READY" ? "🟢" : st.status === "MISSING_DATA" ? "⚪" : "🔒";
      const ly = st.missing.length ? `thiếu: ${st.missing.join(", ")}` : st.blockedBy ? `chặn: ${st.blockedBy}` : "";
      console.log(`   ${dau} ${CAPABILITY_LABEL[c].padEnd(24)} ${ly}`);
    }
  }

  // ───── 5. MẪU TEST SẼ TRẢ LỜI THẾ NÀO ─────
  const mt = nguonTest ? await db.query.testProductProfiles.findFirst({ where: eq(schema.testProductProfiles.sourceId, nguonTest) }) : null;
  if (mt) {
    console.log(`\n⑤ HỒ SƠ MẪU TEST ${mt.testCode} · ${mt.name}`);
    console.log(`   giá        : ${mt.price === null ? "CHƯA CÓ" : `${mt.price.toLocaleString("vi-VN")}đ`}`);
    console.log(`   màu        : ${mt.colors.length ? mt.colors.join(", ") : "CHƯA CÓ"}`);
    console.log(`   chất liệu  : ${mt.material || "CHƯA CÓ"}`);
    const bdT = await loadTestKnowledge(mt.id, db);
    console.log(`   bảng số đo : ${bdT?.knowledge.sizeRuleCount ? `${bdT.knowledge.sizeRuleCount} dòng (bản ${bdT.sizeRuleVersion})` : "CHƯA CÓ"}`);
    console.log(`   giao hàng  : ${mt.shippingPolicy || "CHƯA CÓ"}`);
    console.log(`   được lên đơn: ${mt.allowAutoOrderCreate ? "CÓ" : "KHÔNG"}`);

    const facts: TestFacts = {
      testCode: mt.testCode, name: mt.name, price: mt.price, colors: mt.colors,
      material: mt.material, shippingPolicy: mt.shippingPolicy,
      hasSizeProfile: (bdT?.knowledge.sizeRuleCount ?? 0) > 0, approvedFacts: bdT?.knowledge.approvedFacts ?? [],
      policy: {
        ...TEST_REPLY_DEFAULTS,
        aiReplyEnabled: mt.aiReplyEnabled,
        allowQuotePrice: mt.allowQuotePrice,
        allowCollectPreference: mt.allowCollectPreference,
        allowAutoOrderCreate: mt.allowAutoOrderCreate,
      },
    };

    console.log(`\n   ── máy sẽ trả lời ba câu (nấc SHADOW: SOẠN chứ KHÔNG gửi) ──`);
    for (const cau of BA_CAU) {
      const r = generateTestReply(testIntentOf(cau), facts);
      console.log(`\n   Khách: "${cau}"`);
      console.log(`   Máy  : ${r.text}`);
      console.log(`   → ${r.action}${r.handoffReason ? ` · ${r.handoffReason}` : ""}${r.missing.length ? ` · thiếu: ${r.missing.join(", ")}` : ""}`);
    }

    // Chốt chặn đọc được: câu máy soạn KHÔNG được chứa mã WIN hay giá của mã WIN.
    const winCode = bd?.code ?? "";
    const winPrice = (await db.query.fanpageSalesProfiles.findFirst({ where: eq(schema.fanpageSalesProfiles.pancakePageId, pageId) }))?.unitPrice ?? null;
    const moiCau = BA_CAU.map((c) => generateTestReply(testIntentOf(c), facts).text).join(" ");
    const loWin = Boolean(winCode) && moiCau.includes(winCode);
    const loGia = winPrice !== null && moiCau.includes(String(winPrice));
    console.log(`\n   Kiểm rò rỉ: nhắc mã WIN "${winCode || "(chưa có)"}" → ${loWin ? "✗ CÓ" : "✓ không"} · nhắc giá mã WIN → ${loGia ? "✗ CÓ" : "✓ không"}`);
  }

  // Bảo đảm ảnh chụp không bị lượt chạy này viết vào.
  const [chuaChup] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.salesConversations)
    .where(and(eq(schema.salesConversations.pageId, pageId), eq(schema.salesConversations.sourceType, "")));
  console.log(`\nHội thoại chưa chốt ngữ cảnh: ${chuaChup.n} — lượt chạy này CHỈ ĐỌC, không chụp ảnh cho cuộc nào.`);
  void classifyConversationSource;
}

main().catch((e) => { console.error("HỎNG:", (e as Error).message); process.exit(1); });
