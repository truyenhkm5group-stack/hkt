/**
 * ═══════ KIỂM CHỨNG ĐƯỜNG REALTIME SEPAY TRÊN MÁY CHỦ THẬT ═══════
 *
 * Trả lời đúng những câu mà nhìn vào sổ KHÔNG trả lời được, và trả lời bằng cách LÀM THẬT chứ không
 * bằng cách đọc mã nguồn:
 *
 *   1. Số đo sức khoẻ: nhận lần cuối · thành công · trùng · lỗi · tài khoản chưa xác nhận · gửi lại.
 *   2. IDEMPOTENCY THẬT: phát lại nguyên văn gói tin SePay gần nhất qua đúng cửa HTTP, rồi đếm lại.
 *      Ràng buộc UNIQUE ở CSDL nói rằng dòng thứ hai là bất khả; bài này chứng minh điều đó trên
 *      chính máy chủ đang phục vụ, với chính gói tin thật.
 *   3. Hội tụ với sao kê: có dòng nào mang CẢ dấu vết file lẫn dấu vết webhook không.
 *   4. Lưới an toàn: có cặp nào cùng khoá mà khác mã giao dịch không.
 *
 * AN TOÀN: phép phát lại KHÔNG tạo dữ liệu mới theo thiết kế — nó dùng đúng `id` SePay đã có, nên
 * `bank_txn_provider_uq` chặn ở tầng CSDL. Script vẫn đếm trước/sau và BÁO ĐỎ nếu số dòng đổi, vì
 * "tin là an toàn" không phải là bằng chứng.
 *
 * KHÔNG đụng phân loại kế toán, không đụng lợi nhuận.
 *
 * Dùng: docker exec erp-app npx tsx --tsconfig tsconfig.json scripts/sepay-verify.ts
 */
import { createHmac } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";

const BASE = process.env.ERP_INTERNAL_URL || "http://127.0.0.1:3000";
const secret = process.env.SEPAY_WEBHOOK_SECRET ?? "";
const b = schema.bankTransactions;
const w = schema.webhookEvents;
const acc = schema.bankAccounts;

function line(label: string, value: unknown) {
  console.log(`  ${label.padEnd(34)} ${value}`);
}

async function main() {
  const db = await getDb();
  let failures = 0;
  const fail = (msg: string) => {
    failures += 1;
    console.error(`  ✗ ${msg}`);
  };

  // ───────── 1. SỐ ĐO SỨC KHOẺ ─────────
  console.log("\n═══ 1. SỐ ĐO ĐƯỜNG REALTIME ═══");
  const [m] = await db
    .select({
      tong: sql<number>`count(*)`,
      lanCuoi: sql<string | null>`max(${w.receivedAt})::text`,
      gio1: sql<number>`count(*) filter (where ${w.receivedAt} >= now() - interval '1 hour')`,
      gio24: sql<number>`count(*) filter (where ${w.receivedAt} >= now() - interval '24 hours')`,
      processed: sql<number>`count(*) filter (where ${w.status} = 'PROCESSED')`,
      trung: sql<number>`count(*) filter (where ${w.status} = 'IGNORED')`,
      loi: sql<number>`count(*) filter (where ${w.status} = 'FAILED')`,
      chuaXacNhan: sql<number>`count(*) filter (where ${w.status} = 'ACCOUNT_UNMAPPED')`,
      guiLai: sql<number>`coalesce(sum(${w.deliveryCount} - 1), 0)`,
    })
    .from(w)
    .where(eq(w.source, "SEPAY"));

  line("gói tin đã nhận", m.tong);
  line("nhận lần cuối", m.lanCuoi ?? "CHƯA TỪNG NHẬN");
  line("1 giờ / 24 giờ qua", `${m.gio1} / ${m.gio24}`);
  line("ghi được dòng mới (PROCESSED)", m.processed);
  line("trùng — đã có trong sổ (IGNORED)", m.trung);
  line("xử lý hỏng (FAILED)", m.loi);
  line("tài khoản chưa xác nhận", m.chuaXacNhan);
  line("SePay phải gửi lại", m.guiLai);
  console.log("  (gói tin sai chữ ký KHÔNG được lưu vào CSDL — chống phình bảng; xem `docker logs erp-app | grep sepay-webhook`)");

  const [tkChua] = await db.select({ n: sql<number>`count(*)` }).from(acc).where(eq(acc.status, "UNCONFIRMED"));
  line("tài khoản ngân hàng chờ đặt tên", tkChua.n);

  // ───────── 2. IDEMPOTENCY TRÊN MÁY CHỦ THẬT ─────────
  console.log("\n═══ 2. PHÁT LẠI GÓI TIN THẬT — KHÔNG ĐƯỢC ĐẺ DÒNG THỨ HAI ═══");
  const [moiNhat] = await db
    .select({ id: w.id, externalId: w.externalId, payload: w.payload })
    .from(w)
    .where(and(eq(w.source, "SEPAY"), sql`${w.status} in ('PROCESSED', 'ACCOUNT_UNMAPPED')`))
    .orderBy(desc(w.receivedAt))
    .limit(1);

  if (!moiNhat) {
    console.log("  Chưa có gói tin SePay nào ghi được vào sổ — bỏ qua phép phát lại.");
  } else if (!secret) {
    fail("SEPAY_WEBHOOK_SECRET không có trong container — không ký lại được để phát lại.");
  } else {
    const before = await db
      .select({ n: sql<number>`count(*)`, tong: sql<number>`coalesce(sum(${b.amount}), 0)` })
      .from(b);
    line("sổ trước khi phát lại", `${before[0].n} dòng · tổng ròng ${Number(before[0].tong).toLocaleString("vi-VN")}₫`);

    const body = JSON.stringify(moiNhat.payload);
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = `sha256=${createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex")}`;
    const res = await fetch(`${BASE}/api/webhooks/sepay`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-sepay-signature": sig, "x-sepay-timestamp": ts },
      body,
    });
    const text = (await res.text()).slice(0, 300);
    line(`phát lại sepay_id=${moiNhat.externalId}`, `HTTP ${res.status} · ${text}`);

    const after = await db
      .select({ n: sql<number>`count(*)`, tong: sql<number>`coalesce(sum(${b.amount}), 0)` })
      .from(b);
    line("sổ sau khi phát lại", `${after[0].n} dòng · tổng ròng ${Number(after[0].tong).toLocaleString("vi-VN")}₫`);

    if (res.status !== 200) fail(`phát lại phải trả 200 (thành công idempotently), thực tế ${res.status}`);
    if (Number(after[0].n) !== Number(before[0].n)) fail(`SỐ DÒNG ĐỔI ${before[0].n} → ${after[0].n} — gói tin gửi lại đã đẻ dòng mới`);
    if (Number(after[0].tong) !== Number(before[0].tong)) fail(`TỔNG TIỀN ĐỔI — dòng tiền bị nhân đôi`);
    if (!text.includes('"created":false')) fail("phản hồi phải nói rõ created=false");
    if (!failures) console.log("  ✓ Phát lại không tạo dòng mới, không đổi một đồng — idempotency đúng trên máy chủ thật.");
  }

  // ───────── 3. HỘI TỤ VỚI SAO KÊ FILE ─────────
  console.log("\n═══ 3. HỘI TỤ FILE ↔ WEBHOOK (không đếm hai lần) ═══");
  const [hoiTu] = await db
    .select({ n: sql<number>`count(*)` })
    .from(b)
    .where(sql`${b.source} = 'IMPORT' and ${b.provider} = 'SEPAY'`);
  line("dòng nhập từ file, webhook xác nhận", hoiTu.n);
  const [chiFile] = await db.select({ n: sql<number>`count(*)` }).from(b).where(eq(b.source, "IMPORT"));
  const [chiWebhook] = await db.select({ n: sql<number>`count(*)` }).from(b).where(eq(b.source, "WEBHOOK"));
  line("dòng do file tạo", chiFile.n);
  line("dòng do webhook tạo", chiWebhook.n);

  // Cùng mã bút toán ngân hàng KHÔNG BAO GIỜ được có hai dòng — `bank_ref` đã UNIQUE, nhưng đo lại
  // ở đây để bài kiểm tự đứng được, không phải tin vào một chỉ mục ở nơi khác.
  const trungRef = await db
    .select({ ref: b.bankRef, n: sql<number>`count(*)` })
    .from(b)
    .groupBy(b.bankRef)
    .having(sql`count(*) > 1`);
  if (trungRef.length) fail(`${trungRef.length} mã bút toán có nhiều hơn một dòng — sổ đã nhân đôi`);
  else console.log("  ✓ Không mã bút toán nào có hai dòng.");

  // ───────── 4. LƯỚI AN TOÀN ─────────
  console.log("\n═══ 4. NGHI TRÙNG (nêu ra, KHÔNG tự gộp) ═══");
  const nghiTrung = await db
    .select({ key: b.matchKey, n: sql<number>`count(*)` })
    .from(b)
    .where(sql`${b.matchKey} <> ''`)
    .groupBy(b.matchKey)
    .having(sql`count(*) > 1`);
  line("cặp nghi trùng cần người xem", nghiTrung.length);
  for (const r of nghiTrung.slice(0, 10)) console.log(`    · khoá ${r.key} — ${r.n} dòng`);

  // ───────── 5. SỐ DƯ LUỸ KẾ ─────────
  console.log("\n═══ 5. SỐ DƯ LUỸ KẾ (0 trên tiền vào là KHÔNG THỂ CÓ) ═══");
  const [duLieu] = await db
    .select({
      coSoDu: sql<number>`count(*) filter (where ${b.balanceAfter} is not null)`,
      chuaBiet: sql<number>`count(*) filter (where ${b.balanceAfter} is null)`,
      khongTheCo: sql<number>`count(*) filter (where ${b.balanceAfter} = 0 and ${b.amount} > 0)`,
    })
    .from(b);
  line("dòng có số dư luỹ kế", duLieu.coSoDu);
  line("dòng CHƯA BIẾT số dư", duLieu.chuaBiet);
  line("dòng số dư 0 trên tiền vào", duLieu.khongTheCo);
  if (Number(duLieu.khongTheCo) > 0) fail("còn dòng số dư 0 trên giao dịch tiền vào — trạng thái không tồn tại được");

  console.log(failures ? `\n✗ ${failures} mục KHÔNG đạt.\n` : "\n✓ TOÀN BỘ ĐẠT — đường realtime SePay hoạt động đúng trên production.\n");
  process.exit(failures ? 1 : 0);
}

void main();
