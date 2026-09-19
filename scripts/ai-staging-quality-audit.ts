/**
 * SOI LẠI CHẤT LƯỢNG TRÊN DỮ LIỆU THẬT ĐÃ CHẠY — CHỈ ĐỌC.
 *
 *   npx tsx scripts/ai-staging-quality-audit.ts [--days=7] [--limit=2000] [--since=<ISO>]
 *
 * ═══ NÓ TRẢ LỜI ĐƯỢC GÌ, VÀ KHÔNG TRẢ LỜI ĐƯỢC GÌ ═══
 *
 * Bản chạy thử có gần một nghìn lượt gợi ý và KHÔNG MỘT LƯỢT NÀO được chấm tay. Không được kết
 * luận "AI tốt" từ con số đó — nhưng cũng không được ngồi đợi: một phần chất lượng là KIỂM ĐƯỢC
 * BẰNG MÁY, và phần ấy phải đo ngay.
 *
 * ĐO ĐƯỢC (khẳng định kiểm chứng được, không cần ai đọc câu chữ):
 *   · câu nói một con số tiền mà máy chủ KHÔNG hề tính ra;
 *   · câu hứa còn hàng trong khi sổ kho CHƯA BIẾT;
 *   · câu khuyên một size trong khi KHÔNG có bảng số đo;
 *   · câu xin số đo trong khi không có bảng để tra;
 *   · câu hứa thời gian giao / hứa giảm giá — ERP không có gì đứng sau hai lời ấy;
 *   · MẤT TRẠNG THÁI giữa hai lượt liên tiếp của cùng một hội thoại.
 *
 * KHÔNG ĐO ĐƯỢC (phải người đọc, và `/ai/review` mới là chỗ của nó):
 *   hiểu đúng ý khách chưa · chọn đúng sản phẩm chưa · giọng có tự nhiên không · chuyển người có
 *   đúng lúc không. Tệp này KHÔNG in một con số "tỷ lệ đạt" nào, vì nó không có quyền nói câu đó.
 *
 * ═══ VÌ SAO SOI LẠI KHI ĐÃ CÓ LƯỚI SOI LÚC SOẠN ═══
 *
 * `guardGeneratedText()` chỉ chạy cho câu DO MÔ HÌNH viết (`pipeline.ts`: chỉ khi
 * `routed.tier !== "HUMAN" && routed.value`). Câu dựng từ MẪU đi thẳng ra ngoài không qua lưới.
 * Mẫu câu là do người viết nên "chắc là an toàn" — nhưng nó ghép với dữ liệu chạy, và chính phép
 * ghép mới là chỗ sinh lỗi. Soi lại trên dữ liệu đã lưu là cách duy nhất biết được điều đó.
 *
 * Và nó dùng ĐÚNG hàm `safetyFlags()` của đường chạy thật, với ĐÚNG cách dựng đầu vào mà
 * `pipeline.ts` dùng — chép một bản khác ở đây thì bài soi đo một lưới khác lưới đang bảo vệ khách.
 *
 * KHÔNG GHI GÌ. Không gửi gì. Nội dung khách bị CHE khi in — kho mã này PUBLIC.
 */
import "dotenv/config";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { moneyMentions } from "@/lib/ai-workforce/agents/sales/generate";
import { safetyFlags, SAFETY_FLAG_LABEL, type SafetyFlag } from "@/lib/constants/sales-quality";
import { parseSalesState } from "@/lib/ai-workforce/agents/sales/state";
import { findColor, findSize } from "@/lib/ai-workforce/agents/sales/understand";

function arg(name: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : "";
}

/** Che nội dung: đủ để nhận ra dạng câu, không đủ để lộ câu chữ của khách. */
function mask(s: string, keep = 60): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= keep ? t : `${t.slice(0, keep)}…`;
}

type Row = {
  runId: string | null;
  conversationId: string;
  createdAt: Date;
  reply: string;
  facts: Record<string, unknown> | null;
  stateAfter: unknown;
  action: string;
  customerText: string;
  handoffReason: string;
  coQuyetDinh: boolean;
};

/**
 * MẤT TRẠNG THÁI — ô đã có giá trị ĐÚNG ở lượt trước, lượt sau thành rỗng.
 *
 * Đây là dạng lỗi đắt nhất của bán hàng qua chat, và là dạng KHÔNG bài kiểm đơn vị nào bắt được:
 * mỗi hàm đều đúng, chỉ dây chuyền đi sai ở lượt thứ hai. Ví dụ đã đo được ngày 19/09/2026: khách
 * chốt "đỏ đô / XL" rồi nhắn "vâng", và chữ "vâng" bị đọc thành màu Vàng nên mẫu mã đã chốt bị xoá.
 *
 * Chỉ tính là MẤT khi lượt sau về RỖNG. Khách đổi từ "Đen" sang "Đỏ" là ĐỔI Ý — hoàn toàn hợp lệ,
 * và đếm nó thành lỗi sẽ chôn những lần mất thật giữa hàng trăm lần đổi ý bình thường.
 */
const O_THEO_DOI = ["size", "color", "phone", "address"] as const;

async function main() {
  const days = Number(arg("days")) || 7;
  const limit = Number(arg("limit")) || 2000;
  const sinceArg = arg("since");
  const since = sinceArg ? new Date(sinceArg) : new Date(Date.now() - days * 86_400_000);

  const db = await getDb();
  const s = schema.salesSuggestions;
  const r = schema.aiRuns;

  const rows: Row[] = (
    await db
      .select({
        runId: s.runId,
        conversationId: s.conversationId,
        createdAt: s.createdAt,
        reply: s.suggestedReply,
        facts: s.factsJson,
        action: s.action,
        stateAfter: r.stateAfter,
        decision: r.decision,
        triggerMessageId: s.triggerMessageId,
        customerText: sql<string>`coalesce((select m.text from sales_messages m where m.id = ${s.triggerMessageId}), '')`,
      })
      .from(s)
      .leftJoin(r, eq(r.id, s.runId))
      .where(and(gte(s.createdAt, since)))
      .orderBy(desc(s.createdAt))
      .limit(limit)
  ).map((x) => ({
    runId: x.runId,
    conversationId: x.conversationId,
    createdAt: x.createdAt,
    reply: x.reply ?? "",
    facts: (x.facts ?? null) as Record<string, unknown> | null,
    stateAfter: x.stateAfter,
    action: x.action ?? "",
    customerText: String(x.customerText ?? ""),
    handoffReason: String(((x.decision ?? {}) as Record<string, unknown>).handoffReason ?? ""),
    // CÓ BẢN GHI QUYẾT ĐỊNH hay không là một câu hỏi KHÁC câu "quyết định có ghi lý do không".
    // Gộp hai thứ ấy làm một lỗi dữ liệu trông y như một lỗi nghiệp vụ.
    coQuyetDinh: x.decision !== null && x.decision !== undefined,
  }));

  console.log("═══════ SOI LẠI CHẤT LƯỢNG TRÊN DỮ LIỆU THẬT ═══════");
  console.log(`  cửa sổ      : từ ${since.toISOString()} (${days} ngày)`);
  console.log(`  lượt lấy ra : ${rows.length}`);
  const coChu = rows.filter((x) => x.reply.trim().length > 0);
  console.log(`  lượt CÓ CÂU : ${coChu.length} (phần còn lại máy không soạn gì — chuyển người hoặc đứng ngoài)`);
  if (!rows.length) {
    console.log("\nKhông có lượt nào trong cửa sổ. Nới --days hoặc kiểm lại bộ nạp.");
    process.exit(0);
  }

  /* ───────── 1. LƯỚI SOI AN TOÀN, CHẠY LẠI TRÊN CÂU ĐÃ LƯU ───────── */
  const dem = new Map<SafetyFlag, number>();
  const viDu = new Map<SafetyFlag, { conversationId: string; runId: string | null; text: string }[]>();
  let khongCoAnhChup = 0;

  for (const row of coChu) {
    const f = row.facts;
    if (!f) {
      // KHÔNG có ảnh chụp dữ kiện ⇒ KHÔNG soi được. Đếm riêng chứ không coi là sạch: một lượt
      // không đo được mà tính vào nhóm "không lỗi" là tự làm đẹp con số.
      khongCoAnhChup += 1;
      continue;
    }
    // ĐÚNG cách dựng đầu vào mà `pipeline.ts` dùng lúc soạn — không phải một bản chép lại.
    const quotedTotal = typeof f.quotedTotal === "number" ? f.quotedTotal : null;
    const shippingFee = typeof f.shippingFee === "number" ? f.shippingFee : null;
    const goodsTotal = typeof f.goodsTotal === "number" ? f.goodsTotal : null;
    const allowedAmounts = [quotedTotal ?? 0, shippingFee ?? 0, goodsTotal ?? 0].filter((n) => n > 0);
    const stockKnown = f.stockKnown === true;
    const sizeCode = typeof f.sizeCode === "string" ? f.sizeCode : null;
    // `sizeAdvice` là null khi lượt ấy không hỏi tới size ⇒ CHƯA HỎI, không phải "có bảng".
    const sizeChartAvailable = sizeCode ? sizeCode !== "SIZE_DATA_MISSING" : false;

    const co = safetyFlags({
      text: row.reply,
      allowedAmounts,
      mentionedAmounts: moneyMentions(row.reply),
      stockKnown,
      sizeChartAvailable,
    });
    for (const flag of co) {
      dem.set(flag, (dem.get(flag) ?? 0) + 1);
      const ds = viDu.get(flag) ?? [];
      if (ds.length < 3) ds.push({ conversationId: row.conversationId, runId: row.runId, text: mask(row.reply, 110) });
      viDu.set(flag, ds);
    }
  }

  console.log("\n───────── 1. LƯỚI SOI AN TOÀN CHẠY LẠI TRÊN CÂU ĐÃ LƯU ─────────");
  console.log(`  soi được        : ${coChu.length - khongCoAnhChup}/${coChu.length} câu`);
  if (khongCoAnhChup) console.log(`  KHÔNG soi được  : ${khongCoAnhChup} (thiếu ảnh chụp dữ kiện — CHƯA BIẾT, không phải "sạch")`);
  const tongCo = [...dem.values()].reduce((a, b) => a + b, 0);
  if (tongCo === 0) {
    console.log("  ✓ Không câu nào bật cờ nào.");
  } else {
    for (const [flag, n] of [...dem.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`\n  ✗ ${n} × ${SAFETY_FLAG_LABEL[flag]} [${flag}]`);
      for (const v of viDu.get(flag) ?? []) console.log(`      ${v.conversationId} · lượt ${v.runId ?? "—"}\n        "${v.text}"`);
    }
  }

  /* ───────── 2. MẤT TRẠNG THÁI GIỮA HAI LƯỢT LIÊN TIẾP ───────── */
  const theoHoiThoai = new Map<string, Row[]>();
  for (const row of rows) {
    const ds = theoHoiThoai.get(row.conversationId) ?? [];
    ds.push(row);
    theoHoiThoai.set(row.conversationId, ds);
  }
  type Mat = { conversationId: string; o: string; truoc: string; runTruoc: string | null; runSau: string | null; luc: Date; cauKhach: string };
  const mat: Mat[] = [];
  /** Khách nói màu/size mới trong chính tin ấy ⇒ ĐỔI Ý, hành vi đúng. Đếm riêng để thấy tỷ lệ. */
  const doiY: Mat[] = [];
  let soHoiThoaiNhieuLuot = 0;

  for (const [conversationId, ds] of theoHoiThoai) {
    if (ds.length < 2) continue;
    soHoiThoaiNhieuLuot += 1;
    // `rows` lấy theo thứ tự GIẢM DẦN, nên đảo lại để đi xuôi thời gian.
    const xuoi = [...ds].reverse();
    for (let i = 1; i < xuoi.length; i += 1) {
      const truoc = parseSalesState(xuoi[i - 1].stateAfter);
      const sau = parseSalesState(xuoi[i].stateAfter);
      for (const o of O_THEO_DOI) {
        const a = String(truoc[o] ?? "").trim();
        const b = String(sau[o] ?? "").trim();
        // CHỈ tính khi lượt sau về RỖNG. Đổi giá trị là khách đổi ý — hợp lệ.
        if (a && !b) {
          mat.push({ conversationId, o, truoc: a, runTruoc: xuoi[i - 1].runId, runSau: xuoi[i].runId, luc: xuoi[i].createdAt, cauKhach: xuoi[i].customerText });
        }
      }
      /*
        MẤT ≠ ĐỔI Ý, VÀ DỤNG CỤ ĐO PHẢI PHÂN BIỆT ĐƯỢC HAI THỨ.

        Bản đầu của bài soi đếm mọi lần `variantId` về rỗng là MẤT, và nó báo 2 lần trên dữ liệu
        thật. Đọc ra câu của khách thì cả hai đều là khách ĐỔI Ý: "Đổi cho mầu xanh số M nhé" và
        một tin chốt combo hai đầm. Mẫu mã cũ bị xoá vì lựa chọn MỚI chưa khớp được về một mẫu mã
        duy nhất — đó là hành vi ĐÚNG, không phải lỗi.

        Một dụng cụ đo gộp "đổi ý" với "mất" sẽ báo động giả mãi mãi, và người đọc sẽ thôi tin nó.
        Nên: khách có nhắc tới màu hoặc size trong chính tin ấy ⇒ ĐỔI Ý. Không nhắc gì mà mẫu mã
        vẫn bay ⇒ MẤT, và đó mới là thứ đáng gọi dậy lúc nửa đêm.
      */
      if (truoc.variantId && !sau.variantId) {
        const cau = xuoi[i].customerText;
        const khachDoiY = Boolean(findColor(cau) || findSize(cau));
        (khachDoiY ? doiY : mat).push({
          conversationId, o: "variantId", truoc: truoc.variantLabel || truoc.variantId,
          runTruoc: xuoi[i - 1].runId, runSau: xuoi[i].runId, luc: xuoi[i].createdAt, cauKhach: cau,
        });
      }
    }
  }

  console.log("\n───────── 2. MẤT TRẠNG THÁI GIỮA HAI LƯỢT LIÊN TIẾP ─────────");
  console.log(`  hội thoại có ≥2 lượt : ${soHoiThoaiNhieuLuot}`);
  console.log(`  khách ĐỔI Ý (hợp lệ) : ${doiY.length}  — nói màu/size mới trong chính tin ấy`);
  console.log(`  lần MẤT đáng ngờ     : ${mat.length}  — mẫu mã bay mà khách KHÔNG nhắc màu/size nào`);
  if (mat.length) {
    const theoO = new Map<string, number>();
    for (const m of mat) theoO.set(m.o, (theoO.get(m.o) ?? 0) + 1);
    for (const [o, n] of [...theoO.entries()].sort((a, b) => b[1] - a[1])) console.log(`    ${String(n).padStart(4)} × mất ô "${o}"`);
    console.log("\n  Ví dụ (tối đa 8):");
    for (const m of mat.slice(0, 8)) {
      console.log(`    ${m.conversationId} · ô "${m.o}" đang là "${mask(m.truoc, 30)}" → rỗng · ${m.luc.toISOString()}`);
      // CÂU CỦA KHÁCH LÀM MẤT — không có nó thì "2 lần mất" là một con số không đi tới đâu.
      console.log(`      khách vừa nhắn: "${mask(m.cauKhach, 80) || "(không có chữ)"}"`);
      console.log(`      lượt trước ${m.runTruoc ?? "—"} → lượt sau ${m.runSau ?? "—"}`);
    }
  } else {
    console.log("  ✓ Không lần nào một ô đã có giá trị bị về rỗng ở lượt kế tiếp.");
  }

  /* ───────── 3. VIỆC MÁY CHỌN LÀM, PHÂN BỐ ───────── */
  const theoViec = new Map<string, number>();
  for (const row of rows) theoViec.set(row.action, (theoViec.get(row.action) ?? 0) + 1);
  console.log("\n───────── 3. VIỆC MÁY CHỌN LÀM ─────────");
  for (const [a, n] of [...theoViec.entries()].sort((x, y) => y[1] - x[1])) {
    console.log(`    ${String(n).padStart(4)} × ${a || "(rỗng)"}`);
  }

  /* ───────── 4. VÌ SAO CHUYỂN NGƯỜI ───────── */
  const chuyen = rows.filter((x) => x.action === "HANDOFF_HUMAN");
  console.log("\n───────── 4. VÌ SAO CHUYỂN NGƯỜI ─────────");
  console.log(`  tổng chuyển người : ${chuyen.length}/${rows.length} lượt (${rows.length ? ((chuyen.length / rows.length) * 100).toFixed(1) : "—"}%)`);
  const theoLyDo = new Map<string, number>();
  for (const c of chuyen) {
    // BA RỔ, không hai. "Không có bản ghi quyết định" là lỗi DỮ LIỆU (lượt chạy ghi dở); "có bản
    // ghi mà thiếu lý do" là lỗi NGHIỆP VỤ (luật 13: chuyển người phải có mã lý do). Gộp lại thì
    // một lỗi hạ tầng trông y như một lỗi nghiệp vụ và người đọc đi sửa nhầm chỗ.
    const khoa = c.handoffReason || (c.coQuyetDinh ? "⚠ CÓ bản ghi nhưng THIẾU mã lý do" : "⚠ KHÔNG có bản ghi quyết định");
    theoLyDo.set(khoa, (theoLyDo.get(khoa) ?? 0) + 1);
  }
  for (const [ly, n] of [...theoLyDo.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(n).padStart(4)} × ${ly}`);
  }
  // Một lý do chiếm áp đảo KHÔNG phải tin xấu tự nó — nhưng nó nói chỗ duy nhất đáng sửa tiếp theo.
  const dauBang = [...theoLyDo.entries()].sort((a, b) => b[1] - a[1])[0];
  if (dauBang && chuyen.length) {
    console.log(`\n  ⇒ ${((dauBang[1] / chuyen.length) * 100).toFixed(0)}% số lần chuyển người là vì "${dauBang[0]}".`);
    console.log("    Đây là chỗ đáng sửa tiếp theo — không phải vì chuyển người là sai, mà vì một lý do");
    console.log("    chiếm áp đảo nghĩa là MỘT việc đang chặn phần lớn hội thoại.");
  }

  console.log("\n───────── KẾT LUẬN ─────────");
  console.log(`  Phần KIỂM ĐƯỢC BẰNG MÁY: ${tongCo} lần bật cờ an toàn · ${mat.length} lần mất trạng thái.`);
  console.log("  Phần CHỈ NGƯỜI CHẤM ĐƯỢC (hiểu đúng ý, đúng sản phẩm, giọng, chuyển người đúng lúc)");
  console.log("  vẫn CHƯA ĐO — mở /ai/review. Tệp này cố ý KHÔNG in một tỷ lệ đạt nào.");
  console.log("  Không một lời gọi GHI nào được thực hiện.");
}

main().catch((e) => {
  console.error("Lỗi:", e instanceof Error ? e.message : e);
  process.exit(1);
});
