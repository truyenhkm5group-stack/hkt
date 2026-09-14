/**
 * THU CHỨNG CỨ CHO TỪNG MÃ QUẢNG CÁO, rồi chỉ LƯU khi chứng cứ là XÁC ĐỊNH.
 *
 *   npx tsx scripts/ai-ad-evidence.ts --page=<PAGE_ID> [--backfill] [--apply]
 *
 * Mặc định CHẠY THỬ: in bảng đề xuất và không ghi một dòng nào. `--apply` mới lưu, và CHỈ lưu
 * những dòng đạt mức `CONFIRMED`.
 *
 * VÌ SAO KHÔNG ĐỂ MÁY ĐOÁN. Danh mục page này đặt tên sản phẩm bằng chính mã hàng ("Đầm Q004"),
 * còn quảng cáo viết theo lối tiếp thị ("TINH KHÔI", "ĐẦM ĐỎ ĐÔ"). Hai vốn từ ấy không giao nhau,
 * nên mọi phép "khớp gần đúng" ở đây đều là bịa có vẻ hợp lý. Một ánh xạ sai không dừng lại ở một
 * hội thoại: nó gắn SAI cho TOÀN BỘ chiến dịch, và không ai biết cho tới lúc đọc lại đơn.
 *
 * BỐN MỨC, và chỉ mức đầu được tự lưu:
 *   · CONFIRMED  — chứng cứ XÁC ĐỊNH: nhân viên trong chính các hội thoại đến từ quảng cáo ấy đã
 *                  gõ ĐÚNG MỘT mã hàng / SKU có thật, và không mã nào khác cạnh tranh.
 *   · PROPOSED   — có dấu hiệu (câu quảng cáo gợi tới một mẫu) nhưng KHÔNG xác định ⇒ để người duyệt.
 *   · AMBIGUOUS  — nhiều mã cùng xuất hiện ⇒ máy không được chọn hộ.
 *   · UNKNOWN    — không có chứng cứ nào.
 */
import "dotenv/config";
import { and, eq, sql } from "drizzle-orm";
import { getDb, schema, type Db } from "@/db";
import { ensureMigrated } from "@/db/migrate";
import { getPancakePagesClient } from "@/lib/integrations/pancake/pages";
import { normalize } from "@/lib/text";

type Muc = "CONFIRMED" | "PROPOSED" | "AMBIGUOUS" | "UNKNOWN";

type Khoa = {
  adKey: string;
  soHoiThoai: number;
  cau: string;
  postUrl: string;
  mediaUrl: string;
  loai: string[];
  hoiThoaiIds: string[];
};

async function backfill(db: Db, pageId: string) {
  const client = getPancakePagesClient();
  const ds = await db.query.salesConversations.findMany({
    where: pageId ? eq(schema.salesConversations.pageId, pageId) : undefined,
    columns: { id: true, externalId: true, pageId: true, pancakeCustomerId: true },
    limit: 200,
  });
  let n = 0;
  for (const ht of ds) {
    try {
      const tin = await client.listMessages(ht.pageId, ht.externalId, ht.pancakeCustomerId, 30);
      for (const m of tin) {
        if (!m.adId && !m.adMediaUrl && !m.postUrl) continue;
        const r = await db
          .update(schema.salesMessages)
          .set({ adId: m.adId, adDescription: m.adDescription, postUrl: m.postUrl, attachmentTypes: m.attachmentTypes, adMediaUrl: m.adMediaUrl })
          .where(and(eq(schema.salesMessages.conversationId, ht.id), eq(schema.salesMessages.externalId, m.id), eq(schema.salesMessages.adMediaUrl, "")))
          .returning({ id: schema.salesMessages.id });
        n += r.length;
      }
    } catch { /* hội thoại đọc lỗi thì bỏ qua, đã có bài đo báo riêng */ }
  }
  console.log(`  Backfill: điền thêm ${n} tin`);
}

async function main() {
  const pageId = process.argv.find((a) => a.startsWith("--page="))?.split("=")[1] ?? "";
  const apDung = process.argv.includes("--apply");
  await ensureMigrated();
  const db = await getDb();

  if (process.argv.includes("--backfill")) {
    console.log("\n───────── BACKFILL ─────────");
    await backfill(db, pageId);
  }

  // ───── danh mục: mã hàng + SKU của mẫu mã ─────
  const sp = await db
    .select({ id: schema.products.id, name: schema.products.name, code: schema.products.customId })
    .from(schema.products)
    .where(and(eq(schema.products.isRemoved, false), eq(schema.products.isHidden, false)));
  const mauMa = await db
    .select({ id: schema.productVariants.id, productId: schema.productVariants.productId, sku: schema.productVariants.sku, custom: schema.productVariants.customId })
    .from(schema.productVariants)
    .where(eq(schema.productVariants.isRemoved, false));

  console.log(`\n───────── DANH MỤC ĐỐI CHIẾU ─────────`);
  for (const p of sp) console.log(`  ${(p.code || "(chưa mã)").padEnd(8)} ${p.name}`);

  // ───── các khoá quảng cáo có thật trong dữ liệu ─────
  const rows = await db
    .select({
      adKey: schema.salesMessages.adId,
      cau: sql<string>`max(${schema.salesMessages.adDescription})`,
      postUrl: sql<string>`max(${schema.salesMessages.postUrl})`,
      mediaUrl: sql<string>`max(${schema.salesMessages.adMediaUrl})`,
      loai: sql<string[]>`array_agg(distinct t) filter (where t is not null)`,
      soHoiThoai: sql<number>`count(distinct ${schema.salesMessages.conversationId})::int`,
      hoiThoaiIds: sql<string[]>`array_agg(distinct ${schema.salesMessages.conversationId})`,
    })
    .from(schema.salesMessages)
    .leftJoin(sql`lateral unnest(${schema.salesMessages.attachmentTypes}) as t`, sql`true`)
    .where(sql`${schema.salesMessages.adId} <> ''`)
    .groupBy(schema.salesMessages.adId)
    .orderBy(sql`count(distinct ${schema.salesMessages.conversationId}) desc`);

  const khoas: Khoa[] = rows.map((r) => ({
    adKey: r.adKey,
    soHoiThoai: Number(r.soHoiThoai ?? 0),
    cau: (r.cau ?? "").replace(/\s+/g, " ").trim(),
    postUrl: r.postUrl ?? "",
    mediaUrl: r.mediaUrl ?? "",
    loai: r.loai ?? [],
    hoiThoaiIds: r.hoiThoaiIds ?? [],
  }));

  console.log(`\n───────── ${khoas.length} MÃ QUẢNG CÁO CÓ TRONG DỮ LIỆU ─────────`);

  const ketQua: { k: Khoa; muc: Muc; productId: string | null; code: string; evidence: string; confidence: number }[] = [];

  // HỘI THOẠI BẤM NHIỀU QUẢNG CÁO KHÔNG LÀM CHỨNG CHO QUẢNG CÁO NÀO CẢ.
  //
  // Đo ngày 14/09/2026: hai hội thoại `ae981b3a` và `d083eb72` mỗi cái bấm BA quảng cáo khác nhau.
  // Luật đếm đầu tiên gán ba tin "Q003" của mỗi cuộc cho cả ba quảng cáo, nên bốn mã quảng cáo
  // cùng "được xác nhận" là Q003 — trong đó có một quảng cáo rao ĐẦM ĐỎ ĐÔ, tức là chắc chắn sai.
  // Bốn chứng cứ ấy thật ra là HAI, và cả hai đều không nói được nhân viên đang nhắc tới quảng cáo
  // nào trong ba. Một hội thoại chỉ làm chứng khi nó bấm ĐÚNG MỘT quảng cáo.
  const soQCTheoHoiThoai = new Map<string, number>();
  for (const k of khoas) for (const id of k.hoiThoaiIds) soQCTheoHoiThoai.set(id, (soQCTheoHoiThoai.get(id) ?? 0) + 1);

  for (const k of khoas) {
    const sach = k.hoiThoaiIds.filter((id) => (soQCTheoHoiThoai.get(id) ?? 0) === 1);
    const ban = k.soHoiThoai - sach.length;

    // Đếm theo SỐ HỘI THOẠI chứ không theo số tin: nhân viên nhắc một mã ba lần trong một cuộc vẫn
    // chỉ là MỘT quan sát, còn ba cuộc khác nhau cùng nói một mã mới là một khuôn.
    const theoMa = new Map<string, Set<string>>();
    for (const id of sach) {
      const tinNV = await db
        .select({ text: schema.salesMessages.text })
        .from(schema.salesMessages)
        .where(and(eq(schema.salesMessages.conversationId, id), eq(schema.salesMessages.senderType, "PAGE_HUMAN")))
        .limit(200);
      for (const t of tinNV) {
        const kho = normalize(t.text);
        for (const p of sp) {
          const ma = normalize(p.code ?? "").trim();
          if (ma && kho.includes(` ${ma} `)) (theoMa.get(p.id) ?? theoMa.set(p.id, new Set()).get(p.id)!).add(id);
        }
        for (const v of mauMa) {
          for (const x of [v.sku, v.custom]) {
            const ma = normalize(x ?? "").trim();
            if (ma.length >= 4 && kho.includes(` ${ma} `)) (theoMa.get(v.productId) ?? theoMa.set(v.productId, new Set()).get(v.productId)!).add(id);
          }
        }
      }
    }

    let muc: Muc = "UNKNOWN";
    let productId: string | null = null;
    let evidence = "";
    let confidence = 0;
    const ganChu = ban ? ` (${ban}/${k.soHoiThoai} hội thoại bị loại vì bấm nhiều quảng cáo)` : "";

    if (theoMa.size === 1) {
      const [id, cuoc] = [...theoMa.entries()][0];
      const p = sp.find((x) => x.id === id);
      productId = id;
      // MỘT cuộc là một quan sát, không phải một khuôn — để người duyệt.
      if (cuoc.size >= 2) {
        muc = "CONFIRMED";
        confidence = 1;
        evidence = `Nhân viên gõ mã "${p?.code}" trong ${cuoc.size} hội thoại KHÁC NHAU chỉ bấm đúng quảng cáo này; không mã nào khác${ganChu}`;
      } else {
        muc = "PROPOSED";
        confidence = 0.5;
        evidence = `Chỉ MỘT hội thoại làm chứng (nhân viên gõ "${p?.code}") — đủ để đề xuất, chưa đủ để gán cho cả chiến dịch${ganChu}`;
      }
    } else if (theoMa.size > 1) {
      muc = "AMBIGUOUS";
      const ten = [...theoMa.entries()].map(([id, c]) => `${sp.find((x) => x.id === id)?.code}: ${c.size} cuộc`).join(" · ");
      evidence = `Nhiều mã cùng xuất hiện ở các hội thoại sạch: ${ten} — máy KHÔNG chọn hộ${ganChu}`;
    } else if (ban === k.soHoiThoai && k.soHoiThoai > 0) {
      evidence = `Mọi hội thoại của quảng cáo này đều bấm thêm quảng cáo khác — không cuộc nào làm chứng được cho riêng nó`;
    } else if (k.cau) {
      evidence = `Không nhân viên nào gõ mã hàng trong các hội thoại sạch. Câu quảng cáo: "${k.cau.slice(0, 70)}"${ganChu}`;
    } else {
      evidence = "Không có câu quảng cáo, không có mã nào trong tin nhân viên";
    }

    ketQua.push({ k, muc, productId, code: sp.find((x) => x.id === productId)?.code ?? "", evidence, confidence });
  }

  // ───── BẢNG ĐỀ XUẤT ─────
  for (const r of ketQua) {
    console.log(`\n  AD/POST ID   : ${r.k.adKey}`);
    console.log(`  Câu quảng cáo: ${r.k.cau.slice(0, 96) || "(không có)"}`);
    console.log(`  Hội thoại    : ${r.k.soHoiThoai}   loại đính kèm: ${r.k.loai.join(", ") || "(không)"}`);
    console.log(`  Bài viết     : ${r.k.postUrl ? r.k.postUrl.slice(0, 90) : "(không có)"}`);
    console.log(`  Ảnh          : ${r.k.mediaUrl ? "có" : "(không có)"}`);
    console.log(`  Mẫu đề xuất  : ${r.code || "—"}`);
    console.log(`  Căn cứ       : ${r.evidence}`);
    console.log(`  TRẠNG THÁI   : ${r.muc}${r.muc === "CONFIRMED" ? ` (tin cậy ${r.confidence})` : ""}`);
  }

  const chac = ketQua.filter((r) => r.muc === "CONFIRMED" && r.productId);
  console.log(`\n───────── TỔNG ─────────`);
  for (const m of ["CONFIRMED", "PROPOSED", "AMBIGUOUS", "UNKNOWN"] as Muc[]) {
    const ds = ketQua.filter((r) => r.muc === m);
    console.log(`  ${m.padEnd(10)} ${String(ds.length).padStart(2)} khoá · ${ds.reduce((s, r) => s + r.k.soHoiThoai, 0)} hội thoại`);
  }

  if (!apDung) {
    console.log(`\n--dry-run (mặc định): KHÔNG ghi gì. Thêm --apply để lưu ${chac.length} dòng CONFIRMED.`);
    return;
  }

  let daLuu = 0;
  for (const r of chac) {
    const [dangCo] = await db
      .select({ id: schema.salesAdProductMap.id, source: schema.salesAdProductMap.source })
      .from(schema.salesAdProductMap)
      .where(and(eq(schema.salesAdProductMap.pageId, pageId), eq(schema.salesAdProductMap.adKey, r.k.adKey)))
      .limit(1);
    // Dòng do NGƯỜI đặt là sự thật — máy không đụng vào.
    if (dangCo?.source === "HUMAN") continue;
    if (dangCo) {
      await db.update(schema.salesAdProductMap).set({ productId: r.productId, source: "AD_DESCRIPTION", confidence: 1, evidence: r.evidence, adDescription: r.k.cau.slice(0, 1000), updatedAt: new Date() }).where(eq(schema.salesAdProductMap.id, dangCo.id));
    } else {
      await db.insert(schema.salesAdProductMap).values({
        pageId, adKey: r.k.adKey, keyKind: "AD", productId: r.productId,
        source: "AD_DESCRIPTION", confidence: 1, evidence: r.evidence, adDescription: r.k.cau.slice(0, 1000),
      });
    }
    daLuu += 1;
  }
  console.log(`\nĐã lưu ${daLuu} ánh xạ XÁC ĐỊNH. Các khoá PROPOSED/AMBIGUOUS/UNKNOWN để nguyên cho người duyệt ở /ai/ad-map.`);
}

main().catch((e) => { console.error("HỎNG:", (e as Error).message); process.exit(1); });
