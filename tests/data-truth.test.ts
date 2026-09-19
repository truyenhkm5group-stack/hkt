import assert from "node:assert/strict";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { schema } from "@/db";
import { CONFIRMED_STAGES } from "@/lib/constants/pancake";
import { metricScope } from "@/lib/queries/metrics";
import { ORDER_OUTCOME, PRIMARY_ATTEMPT } from "@/lib/queries/return-rate";
import type { Period } from "@/lib/search-params";

/**
 * ═══════ HAI CHÊNH LỆCH ĐO ĐƯỢC TRÊN PRODUCTION 19/09/2026, VÀ CẢ HAI LÀ LỖI CỦA BỘ ĐỐI CHIẾU ═══════
 *
 * Cùng một hình dạng sai: **một script kiểm chứng CHÉP TAY một luật nghiệp vụ thay vì nhập lại từ
 * nguồn canonical.** Bản chép đúng vào ngày viết, rồi luật đổi — và từ đó công cụ dùng để chứng minh
 * báo cáo đúng lại đi tố cáo báo cáo sai. Hai lỗi khác hằng số, khác tệp, nên vá riêng.
 *
 * ─── A · KPI-26 (`scripts/kpi-snapshot.ts`) ───
 *
 * Ảnh chụp KPI đỏ: tổng 3.132 đơn nhưng các ô cộng lại 3.158 — **thừa 26**. Lời báo lỗi khi ấy đoán
 * "thiếu một ô kết quả", nhưng chiều lệch nói điều ngược lại: các phần LỚN HƠN tổng thì phải có đơn
 * nằm ở HAI ô cùng lúc.
 *
 * Đo: 31 đơn có nhiều lần gửi; 26 trong số đó mang hai kết quả khác nhau (11 `AWAITING_PICKUP+DELIVERED`
 * · 14 `AWAITING_PICKUP+IN_TRANSIT` · 1 `AWAITING_PICKUP+RETURNED`). `count(distinct o.id)` khử trùng
 * BÊN TRONG từng ô, không ai khử GIỮA các ô. Thiếu `PRIMARY_ATTEMPT` ở điều kiện nối, thế thôi.
 *
 * ─── B · MARKETING-2 (`scripts/marketing-calibrate.ts`) ───
 *
 * Kỳ 01–09/09/2026, hai lượt chạy độc lập cùng ra "lệch 2 đơn không giải thích được": SQL đối chiếu
 * 521, báo cáo 519.
 *
 * Bộ đối chiếu gõ population bằng DANH SÁCH LOẠI TRỪ `stage not in ('NEW','CANCELLED','DELETED')`;
 * canonical dùng DANH SÁCH CHO PHÉP `CONFIRMED_STAGES`. Hai cách chỉ bằng nhau khi enum không có giá
 * trị nào ngoài cả hai — mà nó có: **`WAITING`**. Đúng 2 đơn `WAITING` (3827, 3831) trong kỳ, và đó
 * là toàn bộ chênh lệch.
 *
 * VÌ SAO KHÔNG SỬA ĐỊNH NGHĨA CHO KHỚP: `WAITING` là đơn CHƯA xác nhận. Loại nó khỏi "đơn đã xác
 * nhận" là đúng đặc tả. Báo cáo đúng; bản chép tay sai.
 */
export async function testDataTruth(db: Db) {
  /* ═════════ A · ĐƠN GỬI LẠI KHÔNG ĐƯỢC RƠI VÀO HAI Ô KẾT QUẢ ═════════ */

  // Fixture tối thiểu tái hiện ĐÚNG hình dạng của 26 đơn thật: một đơn, hai lần gửi, một lần ĐVVC
  // chưa cầm hàng (`AWAITING_PICKUP`) và một lần đã giao xong (`DELIVERED`).
  const ID = "dt-k26-1";
  await db.insert(schema.orders).values({
    id: ID, systemId: 990001, stage: "DELIVERED", status: 0,
    insertedAt: new Date("2031-03-01T03:00:00Z"), cod: 499000,
  });
  await db.insert(schema.shipments).values([
    // Lần gửi ĐÃ GIAO — có chứng từ tiền nên `ORDER_OUTCOME` ra 'DELIVERED'.
    {
      orderId: ID, carrier: "Viettel Post", vtpOrderNumber: "DTK26A", trackingCode: "DTK26A",
      stage: "DELIVERED", codAmount: 499000, codCollected: 499000, codStatus: "COLLECTED",
      shippingFee: 17000, attemptNo: 1, createdAt: new Date("2031-03-01T04:00:00Z"),
    },
    // Lần gửi lại — ĐVVC CHƯA cầm hàng: có vận đơn, không sự kiện lấy hàng ⇒ 'AWAITING_PICKUP'.
    {
      orderId: ID, carrier: "Viettel Post", vtpOrderNumber: "DTK26B", trackingCode: "DTK26B",
      stage: "PENDING", codAmount: 499000, shippingFee: 17000, attemptNo: 2,
      createdAt: new Date("2031-03-02T04:00:00Z"),
    },
  ]);

  /** Đếm theo đúng hình của ảnh chụp KPI, giới hạn trong fixture này. */
  const dem = async (guard: boolean) => {
    const join = guard ? and(eq(schema.shipments.orderId, schema.orders.id), PRIMARY_ATTEMPT) : eq(schema.shipments.orderId, schema.orders.id);
    const [r] = await db
      .select({
        tong: sql<number>`count(distinct ${schema.orders.id})`,
        delivered: sql<number>`count(distinct ${schema.orders.id}) filter (where ${ORDER_OUTCOME} = 'DELIVERED')`,
        awaiting: sql<number>`count(distinct ${schema.orders.id}) filter (where ${ORDER_OUTCOME} = 'AWAITING_PICKUP')`,
        inTransit: sql<number>`count(distinct ${schema.orders.id}) filter (where ${ORDER_OUTCOME} = 'IN_TRANSIT')`,
        returned: sql<number>`count(distinct ${schema.orders.id}) filter (where ${ORDER_OUTCOME} in ('RETURNED','RETURNED_BY_RULE'))`,
        cancelled: sql<number>`count(distinct ${schema.orders.id}) filter (where ${ORDER_OUTCOME} = 'CANCELLED')`,
        unknown: sql<number>`count(distinct ${schema.orders.id}) filter (where ${ORDER_OUTCOME} = 'UNKNOWN')`,
        notShipped: sql<number>`count(distinct ${schema.orders.id}) filter (where ${ORDER_OUTCOME} = 'NOT_SHIPPED')`,
      })
      .from(schema.orders)
      .leftJoin(schema.shipments, join)
      .where(eq(schema.orders.id, ID));
    const tong = Number(r?.tong ?? 0);
    const phan =
      Number(r?.delivered ?? 0) + Number(r?.awaiting ?? 0) + Number(r?.inTransit ?? 0) +
      Number(r?.returned ?? 0) + Number(r?.cancelled ?? 0) + Number(r?.unknown ?? 0) + Number(r?.notShipped ?? 0);
    return { tong, phan };
  };

  /*
    FIXTURE PHẢI THẬT SỰ TÁI HIỆN ĐƯỢC LỖI, nếu không bài kiểm chỉ chứng minh bản vá chạy được trên
    dữ liệu không có lỗi. Không có `PRIMARY_ATTEMPT`, đơn này PHẢI rơi vào hai ô.
  */
  const khongGuard = await dem(false);
  assert.equal(khongGuard.tong, 1, "một đơn vẫn là một đơn");
  assert.equal(
    khongGuard.phan, 2,
    "fixture phải tái hiện được lỗi: thiếu PRIMARY_ATTEMPT thì đơn gửi lại rơi vào HAI ô kết quả",
  );

  // Và có `PRIMARY_ATTEMPT` thì bất biến "tổng = tổng các phần" trở lại đúng.
  const coGuard = await dem(true);
  assert.equal(coGuard.tong, 1);
  assert.equal(
    coGuard.phan, coGuard.tong,
    `PRIMARY_ATTEMPT phải đưa đơn gửi lại về ĐÚNG MỘT ô (tổng ${coGuard.tong}, các phần ${coGuard.phan})`,
  );

  /* ═════════ B · POPULATION "ĐÃ XÁC NHẬN" PHẢI ĐỌC TỪ CANONICAL ═════════ */

  /*
    SỰ THẬT CẤU TRÚC SINH RA LỖI — khoá lại để nó không im lặng biến mất: `WAITING` nằm NGOÀI cả
    danh sách cho phép lẫn danh sách loại trừ mà bản chép tay dùng. Ngày ai đó thêm một stage mới,
    bài này đỏ trước khi một bộ đối chiếu lại đi tố cáo báo cáo.
  */
  const DENY_LIST_CU = ["NEW", "CANCELLED", "DELETED"];
  const ngoaiCaHai = schema.orderStageEnum.enumValues.filter(
    (v) => !(CONFIRMED_STAGES as readonly string[]).includes(v) && !DENY_LIST_CU.includes(v),
  );
  assert.deepEqual(
    ngoaiCaHai, ["WAITING"],
    "danh sách CHO PHÉP và danh sách LOẠI TRỪ lệch nhau đúng ở `WAITING` — đây là gốc của lệch 2 đơn",
  );

  const KY: Period = {
    key: "custom", label: "kiểm thử", fromKey: "2031-03-01", toKey: "2031-03-31",
    from: new Date("2031-03-01T00:00:00Z"), to: new Date("2031-03-31T23:59:59Z"),
  };
  await db.insert(schema.orders).values([
    { id: "dt-m2-waiting", systemId: 990002, stage: "WAITING", status: 0, insertedAt: new Date("2031-03-05T03:00:00Z") },
    { id: "dt-m2-confirmed", systemId: 990003, stage: "CONFIRMED", status: 0, insertedAt: new Date("2031-03-05T04:00:00Z") },
  ]);
  const TRONG_KY = inArray(schema.orders.id, ["dt-k26-1", "dt-m2-waiting", "dt-m2-confirmed"]);

  const [canon] = await db
    .select({ n: sql<number>`count(*)` })
    .from(schema.orders)
    .where(and(metricScope(KY, "confirmed"), TRONG_KY));

  const [chepTay] = await db
    .select({ n: sql<number>`count(*)` })
    .from(schema.orders)
    .where(and(sql`${schema.orders.stage}::text not in ('NEW','CANCELLED','DELETED')`, TRONG_KY));

  // Fixture tái hiện lỗi: bản chép tay NHẬN đơn WAITING, canonical thì KHÔNG.
  assert.equal(Number(chepTay?.n ?? 0), 3, "bản chép tay nhận cả đơn WAITING (2 đơn hợp lệ + 1 WAITING)");
  assert.equal(Number(canon?.n ?? 0), 2, "population canonical loại đơn WAITING — `WAITING` là đơn CHƯA xác nhận");
  assert.equal(
    Number(chepTay?.n ?? 0) - Number(canon?.n ?? 0), 1,
    "chênh lệch đúng bằng số đơn WAITING — trên production 01–09/09/2026 con số ấy là 2 (đơn 3827, 3831)",
  );

  /*
    ─── VÀ BỘ ĐỐI CHIẾU KHÔNG ĐƯỢC CHÉP LẠI LUẬT LẦN NỮA ───
    Phần trên chứng minh bản chép tay sai; phần này chặn nó quay lại. Quét mã nguồn, vì một bài kiểm
    dữ liệu không thấy được việc ai đó gõ lại danh sách stage vào script.
  */
  const src = await import("node:fs").then((fs) => fs.readFileSync("scripts/marketing-calibrate.ts", "utf8"));
  /*
    BỎ CHÚ THÍCH CHO ĐÚNG — bản đầu của chính bài kiểm này lọc theo "dòng bắt đầu bằng * hoặc //",
    và nó ĐỎ OAN ngay: khối chú thích giải thích bản vá có nhắc lại nguyên văn danh sách loại trừ cũ,
    mà các dòng giữa một khối `/* … *\/` thì không bắt đầu bằng `*`. Một phép quét mã nguồn thô sơ
    sẽ bắt nhầm đúng lời giải thích khiến người sau không lặp lại lỗi — nên phải cắt cả KHỐI.
  */
  const khongChuThich = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  assert.ok(
    !/not in \('NEW','CANCELLED','DELETED'\)/.test(khongChuThich),
    "marketing-calibrate không được gõ lại population bằng danh sách loại trừ — dùng `metricScope(period,'confirmed')`",
  );
  assert.ok(
    khongChuThich.includes('metricScope(period, "confirmed")'),
    "…và phải đọc population từ nguồn canonical",
  );

  /*
    ─── VÀ KHÔNG SCRIPT NÀO ĐƯỢC NỐI orders↔shipments MÀ BỎ `PRIMARY_ATTEMPT` ───

    Phần A chứng minh CÁI GUARD chạy đúng, nhưng nó không chứng minh `kpi-snapshot` có DÙNG guard:
    gỡ `PRIMARY_ATTEMPT` khỏi script thì phần A vẫn xanh. Một bài kiểm không bắt được bản lùi của
    chính bản vá nó đi kèm thì chỉ là trang trí — nên quét luôn mã nguồn.

    Quét `scripts/` vì đó là nơi luật hay bị chép tay: `lib/queries/*` đã nối qua `PRIMARY_ATTEMPT`
    ở mọi chỗ cần (đo 19/09/2026), còn script kiểm chứng thì mỗi cái tự viết truy vấn của mình.
  */
  const fs = await import("node:fs");
  const pathMod = await import("node:path");
  const liet = (thuMuc: string): string[] =>
    fs.readdirSync(thuMuc, { withFileTypes: true }).flatMap((e) => {
      const p = pathMod.join(thuMuc, e.name);
      return e.isDirectory() ? liet(p) : p.endsWith(".ts") ? [p] : [];
    });
  const noiTran: string[] = [];
  for (const tep of liet("scripts")) {
    const noiDung = fs.readFileSync(tep, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    // Nối orders↔shipments theo order_id mà trên cùng dòng không có `PRIMARY_ATTEMPT`.
    for (const dong of noiDung.split("\n")) {
      if (/(leftJoin|innerJoin)\(\s*s(chema\.shipments)?\s*,/.test(dong) && /orderId/.test(dong) && !dong.includes("PRIMARY_ATTEMPT")) {
        noiTran.push(`${tep}: ${dong.trim().slice(0, 100)}`);
      }
    }
  }
  assert.deepEqual(
    noiTran, [],
    "script nối orders↔shipments mà thiếu `PRIMARY_ATTEMPT` — đơn gửi lại sẽ sinh nhiều dòng và rơi vào nhiều ô:\n" + noiTran.join("\n"),
  );

  console.log(
    "✓ DATA TRUTH: đơn gửi lại về ĐÚNG một ô kết quả (thiếu PRIMARY_ATTEMPT ⇒ 2 ô — đã tái hiện) · " +
      "population canonical loại đơn WAITING, bản chép tay thì không (gốc của lệch 2 đơn) · " +
      "bộ đối chiếu không còn chép tay luật · không script nào nối orders↔shipments thiếu PRIMARY_ATTEMPT",
  );
}
