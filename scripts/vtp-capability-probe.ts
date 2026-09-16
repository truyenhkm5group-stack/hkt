/**
 * ═══════════ VẬN ĐƠN NÀO TÀI KHOẢN API ĐỌC ĐƯỢC, VẬN ĐƠN NÀO KHÔNG ═══════════
 *
 * ─── VÌ SAO CẦN MỘT LƯỢT DÒ RIÊNG ───
 *
 * Bộ đối chiếu định kỳ (`syncViettelPostShipments`) CỐ Ý không hỏi lại vận đơn đã kết luận
 * `WEBHOOK_ONLY` — đó là điểm của luật "thôi hỏi những vận đơn đã chứng minh là không hỏi được".
 * Nhưng vì thế nó cũng không bao giờ trả lời được câu "hôm nay tài khoản API đã nhìn thấy chúng
 * chưa?". Ngày chủ shop trỏ ERP về đúng tài khoản Viettel Post mà Pancake dùng, phải có một lượt
 * dò CHỦ ĐỘNG mới phát hiện ra điều đó.
 *
 * Script này là lượt dò ấy: lấy MỘT MẪU vận đơn (mặc định 30, gần nhất trước), hỏi API từng cái,
 * rồi xếp loại. MẶC ĐỊNH CHẠY THỬ — `--apply` mới ghi `tracking_capability`.
 *
 * ─── KHÔNG IN SECRET ───
 *
 * Kho mã này PUBLIC và log của Actions ai cũng đọc được. Script in DANH TÍNH TÀI KHOẢN ở dạng đã
 * che (mã khách hàng giữ 3 ký tự đầu, số điện thoại giữ 4 số cuối) — đủ để trả lời "có phải cùng
 * một tài khoản với Pancake không", không đủ để ai đó dùng lại. Token, mật khẩu, khoá API KHÔNG
 * bao giờ được in, kể cả một phần.
 *
 * ─── TÔN TRỌNG GIỚI HẠN TẦN SUẤT ───
 *
 * `ViettelPostClient.rawCall` đã tự giãn 200ms giữa hai lệnh gọi. Mẫu 30 vận đơn ⇒ khoảng 6 giây
 * gọi API. Trần cứng 100 để một lần gõ nhầm không thành một cơn bão request.
 *
 *   npx tsx --tsconfig tsconfig.json scripts/vtp-capability-probe.ts [--limit=30] [--apply] [--all]
 */
import "dotenv/config";
import { and, desc, eq, isNotNull, ne, or, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { getViettelPostClient } from "@/lib/integrations/viettelpost/client";
import { CAPABILITY_PROBE_LIMIT, type TrackingCapability } from "@/lib/constants/logistics-freshness";

const argv = process.argv.slice(2);
const apply = argv.includes("--apply");
/** Mặc định chỉ dò vận đơn CHƯA kết luận + vận đơn từng tra được. `--all` gồm cả WEBHOOK_ONLY. */
const all = argv.includes("--all");
const limitArg = Number((argv.find((a) => a.startsWith("--limit=")) ?? "").split("=")[1]);
const LIMIT = Math.min(Number.isFinite(limitArg) && limitArg > 0 ? limitArg : 30, 100);

/** Giữ đầu và đuôi, bỏ ruột. Đủ để so hai tài khoản có trùng nhau không, không đủ để dùng lại. */
function che(value: unknown, giuDau = 3, giuCuoi = 2): string {
  const text = String(value ?? "").trim();
  if (!text) return "(trống)";
  if (text.length <= giuDau + giuCuoi) return "*".repeat(text.length);
  return `${text.slice(0, giuDau)}${"*".repeat(Math.max(3, text.length - giuDau - giuCuoi))}${text.slice(-giuCuoi)}`;
}


async function main() {
  const db = await getDb();
  const client = getViettelPostClient();

  // ───────── 1. DANH TÍNH TÀI KHOẢN API (che) ─────────
  console.log("═══ TÀI KHOẢN API VIETTEL POST ERP ĐANG DÙNG ═══");
  let accountLabel = "(không đọc được)";
  try {
    const info = await client.testConnection();
    const acc = info as unknown as Record<string, unknown>;
    const account = (acc.account ?? {}) as Record<string, unknown>;
    accountLabel = [
      `ok=${String(acc.ok ?? "?")}`,
      `mã KH=${che(account.CUSTOMER_CODE ?? account.customerCode ?? account.MA_KHACH_HANG)}`,
      `tên=${che(account.NAME ?? account.FULLNAME ?? account.name, 2, 0)}`,
      `SĐT=${che(account.PHONE ?? account.phone, 0, 4)}`,
      `kho=${String((acc.inventories as unknown[] | undefined)?.length ?? "?")}`,
    ].join(" · ");
  } catch (e) {
    accountLabel = `lỗi: ${e instanceof Error ? e.message : String(e)}`;
  }
  console.log(accountLabel);

  // ───────── 2. MẪU VẬN ĐƠN ─────────
  const where = and(
    or(isNotNull(schema.shipments.vtpOrderNumber), isNotNull(schema.shipments.trackingCode)),
    all ? undefined : ne(schema.shipments.trackingCapability, "WEBHOOK_ONLY"),
  );
  const rows = await db
    .select({
      id: schema.shipments.id,
      code: sql<string>`coalesce(nullif(${schema.shipments.vtpOrderNumber}, ''), ${schema.shipments.trackingCode})`,
      capability: schema.shipments.trackingCapability,
      probes: schema.shipments.capabilityProbes,
      stage: schema.shipments.stage,
      createdAt: schema.shipments.createdAt,
    })
    .from(schema.shipments)
    .where(where)
    .orderBy(desc(schema.shipments.createdAt))
    .limit(LIMIT);

  console.log(`\n═══ DÒ ${rows.length} VẬN ĐƠN GẦN NHẤT ${all ? "(gồm cả WEBHOOK_ONLY)" : "(bỏ qua WEBHOOK_ONLY đã kết luận)"} ═══`);
  console.log(apply ? "CHẾ ĐỘ GHI: sẽ cập nhật tracking_capability" : "CHẠY THỬ: không ghi gì (thêm --apply để ghi)");

  const dem = { found: 0, notFound: 0, authError: 0, otherError: 0 };
  const loiMau: string[] = [];

  for (const r of rows) {
    if (!r.code) continue;
    try {
      const record = await client.getOrderDetail(r.code);
      if (record) {
        dem.found += 1;
        if (apply && r.capability !== "API_TRACKABLE") {
          await db.update(schema.shipments).set({ trackingCapability: "API_TRACKABLE", capabilityProbes: 0 }).where(eq(schema.shipments.id, r.id));
        }
      } else {
        // API trả "không tồn tại" là câu trả lời DỨT KHOÁT, không phải lỗi tạm thời.
        dem.notFound += 1;
        const soLan = (r.probes ?? 0) + 1;
        const ketLuan: TrackingCapability | null = r.capability !== "API_TRACKABLE" && soLan >= CAPABILITY_PROBE_LIMIT ? "WEBHOOK_ONLY" : null;
        if (apply) {
          await db
            .update(schema.shipments)
            .set({ capabilityProbes: soLan, ...(ketLuan ? { trackingCapability: ketLuan } : {}) })
            .where(eq(schema.shipments.id, r.id));
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Lỗi QUYỀN / PHIÊN khác hẳn lỗi mạng: cái đầu nói về tài khoản, cái sau nói về lần gọi.
      if (/token|đăng nhập|unauthor|401|403|quyền/i.test(msg)) dem.authError += 1;
      else dem.otherError += 1;
      if (loiMau.length < 5) loiMau.push(msg.slice(0, 160));
    }
  }

  console.log(`\n═══ KẾT QUẢ ═══`);
  console.log(`tổng dò            : ${rows.length}`);
  console.log(`API đọc được       : ${dem.found}`);
  console.log(`API không thấy     : ${dem.notFound}`);
  console.log(`lỗi quyền/phiên    : ${dem.authError}`);
  console.log(`lỗi khác           : ${dem.otherError}`);
  for (const m of loiMau) console.log(`  · ${m}`);

  const tong = await db
    .select({ capability: schema.shipments.trackingCapability, n: sql<number>`count(*)::int` })
    .from(schema.shipments)
    .groupBy(schema.shipments.trackingCapability);
  console.log(`\n═══ PHÂN LOẠI TOÀN BẢNG ${apply ? "(SAU khi ghi)" : "(chưa ghi gì)"} ═══`);
  for (const t of tong) console.log(`${t.capability.padEnd(20)} ${t.n}`);

  if (dem.found === 0 && rows.length > 0) {
    console.log(
      `\nKẾT LUẬN: tài khoản API hiện tại KHÔNG đọc được vận đơn nào trong mẫu. Đây là PHẠM VI TÀI KHOẢN, không phải lỗi lần chạy —\n` +
        `vận đơn do Pancake tạo thuộc tài khoản Viettel Post khác. Với chúng, webhook + nhập tệp là toàn bộ nguồn tin.`,
    );
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
