import assert from "node:assert/strict";
import type { Db } from "@/db";
import { schema } from "@/db";
import type { OrderStage } from "@/db/schema";
import {
  COD_TOLERANCE_VND,
  phoneWellFormed,
  validateForShipping,
  VALIDATION_RULES,
  type ValidationCode,
  type ValidationInput,
  type ValidationItem,
} from "@/lib/constants/preship-validation";
import { getOrderValidation, getPreshipValidationQueue } from "@/lib/queries/preship-validation";
import { clearMemo } from "@/lib/cache";

/**
 * ═══════════ SOÁT ĐƠN TRƯỚC KHI GỬI ═══════════
 *
 * Khoá bốn điều:
 *  1. Mỗi lỗi nêu ĐÍCH DANH trường, lý do và việc phải làm — không có lỗi nào chỉ là một cái cờ.
 *  2. CHƯA TRA ĐƯỢC thì IM LẶNG: chưa biết mẫu hàng có phân loại hay không, chưa có vận đơn để so
 *     COD — cả hai đều không được sinh lỗi, và cũng không được kết luận là đạt.
 *  3. Lỗi loại trừ nhau không đếm thành hai việc (địa chỉ trống ≠ địa chỉ chưa chuẩn hoá).
 *  4. Ranh giới CHẶN / CẢNH BÁO đặt ở HẬU QUẢ: gửi đi có tới nơi không.
 *
 * Chạy riêng: npx tsx --tsconfig tsconfig.json tests/preship-validation.test.ts
 */

const DON_SACH: ValidationInput = {
  receiverName: "Nguyễn Thị Hoa",
  phone: "0912345678",
  address: "12 Lê Lợi, Phường Bến Nghé",
  province: "Hà Nội",
  total: 499_000,
  prepaid: 0,
  shipmentCod: 499_000,
  items: [{ variantId: "v1", sku: "AO-DO-M", productName: "Áo sơ mi", variationDetail: "Đỏ / M", quantity: 1, hasVariations: true, isBonus: false }],
};

const codes = (r: ReturnType<typeof validateForShipping>) => r.findings.map((f) => f.code).sort();

export function testPreshipValidationPure() {
  /* ─── 1 · Đơn sạch không sinh lỗi nào ─── */
  {
    const r = validateForShipping(DON_SACH);
    assert.deepEqual(r.findings, [], "đơn đủ chứng từ phải sạch — một luật soát kêu oan là luật sẽ bị bỏ qua");
    assert.equal(r.readyToShip, true);
  }

  /* ─── 2 · Mỗi luật nêu đủ trường, lý do, việc phải làm ─── */
  for (const [code, spec] of Object.entries(VALIDATION_RULES)) {
    assert.equal(spec.code, code, `${code}: khoá và mã trong sổ phải trùng`);
    assert.ok(spec.field.trim().length > 2, `${code}: phải nêu tên trường người sửa nhìn thấy`);
    assert.ok(spec.why.trim().length > 30, `${code}: phải nói HẬU QUẢ, không chỉ nói là sai`);
    assert.ok(spec.fix.trim().length > 20, `${code}: phải nói việc phải làm`);
    assert.ok(spec.source.trim().length > 5, `${code}: phải trỏ tới cột thật`);
  }

  /* ─── 3 · Số điện thoại ─── */
  {
    assert.equal(phoneWellFormed("0912345678"), true);
    assert.equal(phoneWellFormed("84912345678"), true);
    assert.equal(phoneWellFormed("+84 912 345 678"), true, "dấu cách và dấu cộng không phải lỗi hình dạng");
    assert.equal(phoneWellFormed("091234567"), false, "thiếu một số");
    assert.equal(phoneWellFormed("0912345678910"), false, "thừa số");
    assert.equal(phoneWellFormed("1912345678"), false, "10 số nhưng không bắt đầu bằng 0");
    assert.equal(phoneWellFormed(""), false);

    const r = validateForShipping({ ...DON_SACH, phone: "091234567" });
    assert.deepEqual(codes(r), ["PHONE_MALFORMED"]);
    assert.ok(r.findings[0].detail.includes("091234567"), "lời báo phải nêu ĐÚNG giá trị đang sai để người sửa đọc là thấy");
    assert.equal(r.readyToShip, false, "gọi không được khách thì không nên gửi");

    // Trống và sai hình dạng là HAI lỗi khác nhau, và không bao giờ cùng lúc.
    const trong = validateForShipping({ ...DON_SACH, phone: "" });
    assert.deepEqual(codes(trong), ["MISSING_PHONE"]);
  }

  /* ─── 4 · Địa chỉ: ba luật loại trừ nhau đúng cách ─── */
  {
    const trong = validateForShipping({ ...DON_SACH, address: "", province: "" });
    assert.deepEqual(codes(trong), ["MISSING_ADDRESS"], "đơn trống địa chỉ chỉ sinh MỘT lỗi — báo thêm 'chưa chuẩn hoá' là đếm một chuyện thành hai việc");

    const ngan = validateForShipping({ ...DON_SACH, address: "Hà Nội" });
    assert.deepEqual(codes(ngan), ["ADDRESS_TOO_SHORT"]);

    const chuaChuanHoa = validateForShipping({ ...DON_SACH, province: "" });
    assert.deepEqual(codes(chuaChuanHoa), ["MISSING_PROVINCE"]);
    assert.ok(chuaChuanHoa.findings[0].fix.includes("CHỌN TAY"), "việc phải làm là chọn tay, KHÔNG phải để máy đoán địa chỉ khách");
  }

  /* ─── 5 · Hàng hoá ─── */
  {
    const khongHang = validateForShipping({ ...DON_SACH, items: [] });
    assert.deepEqual(codes(khongHang), ["NO_ITEMS"]);
    assert.equal(khongHang.readyToShip, false);

    const sp = (extra: Partial<ValidationItem>): ValidationItem => ({
      variantId: "v1",
      sku: "S",
      productName: "Áo",
      variationDetail: "Đỏ / M",
      quantity: 1,
      hasVariations: true,
      isBonus: false,
      ...extra,
    });

    // Chưa ghép mẫu mã là CẢNH BÁO, không phải chặn: người đóng gói vẫn đọc được tên hàng.
    const chuaGhep = validateForShipping({ ...DON_SACH, items: [sp({ variantId: null })] });
    assert.deepEqual(codes(chuaGhep), ["ITEM_NOT_MAPPED"]);
    assert.equal(chuaGhep.readyToShip, true, "chưa ghép mẫu mã làm sai TỒN KHO, không làm kiện hàng đi lạc");
    assert.ok(chuaGhep.warnings[0].why.includes("TỒN KHO"), "phải nói rõ hậu quả là ở tồn kho và giá vốn");

    // Thiếu màu/size khi mẫu hàng CÓ nhiều phân loại là CHẶN: kho phải đoán.
    const thieuPhanLoai = validateForShipping({ ...DON_SACH, items: [sp({ variationDetail: "" })] });
    assert.deepEqual(codes(thieuPhanLoai), ["ITEM_MISSING_VARIATION"]);
    assert.equal(thieuPhanLoai.readyToShip, false);

    // CHƯA TRA ĐƯỢC mẫu hàng có phân loại hay không ⇒ IM LẶNG.
    const chuaBiet = validateForShipping({ ...DON_SACH, items: [sp({ variationDetail: "", hasVariations: null })] });
    assert.deepEqual(codes(chuaBiet), [], "chưa biết thì không kết luận thiếu — cũng không kết luận đủ");

    // Mẫu hàng chỉ có MỘT phân loại thì không có gì để chọn.
    const motPhanLoai = validateForShipping({ ...DON_SACH, items: [sp({ variationDetail: "", hasVariations: false })] });
    assert.deepEqual(codes(motPhanLoai), []);

    const soLuong = validateForShipping({ ...DON_SACH, items: [sp({ quantity: 0 })] });
    assert.deepEqual(codes(soLuong), ["ITEM_BAD_QUANTITY"]);
    assert.equal(soLuong.readyToShip, false);
  }

  /* ─── 6 · Tiền ─── */
  {
    const khongTong = validateForShipping({ ...DON_SACH, total: null, shipmentCod: null });
    assert.deepEqual(codes(khongTong), ["TOTAL_MISSING"]);
    assert.equal(khongTong.readyToShip, true, "đơn 0đ vẫn gửi được — nó làm sai BÁO CÁO, không làm kiện đi lạc");

    const thuaTien = validateForShipping({ ...DON_SACH, total: 499_000, prepaid: 600_000, shipmentCod: 0 });
    assert.ok(codes(thuaTien).includes("PREPAID_EXCEEDS_TOTAL"));
    assert.ok(thuaTien.findings.find((f) => f.code === "PREPAID_EXCEEDS_TOTAL")!.detail.includes("101.000"), "phải in ra số tiền thừa cụ thể");

    // COD lệch quá ngưỡng.
    const lech = validateForShipping({ ...DON_SACH, total: 499_000, prepaid: 0, shipmentCod: 549_000 });
    assert.deepEqual(codes(lech), ["COD_MISMATCH"]);
    assert.equal(lech.readyToShip, true, "COD lệch làm sai ĐỐI SOÁT, không chặn được dây chuyền vì một ô nhập sai");

    // Lệch trong ngưỡng làm tròn ⇒ im lặng.
    const trongNguong = validateForShipping({ ...DON_SACH, shipmentCod: 499_000 + COD_TOLERANCE_VND });
    assert.deepEqual(codes(trongNguong), [], "chênh vài trăm đồng do làm tròn phí thì không báo — báo động vì 1.000đ là dạy người ta bỏ qua cảnh báo");

    // Khách đã chuyển trước: COD đúng phải là phần CÒN LẠI.
    const daChuyen = validateForShipping({ ...DON_SACH, total: 499_000, prepaid: 499_000, shipmentCod: 0 });
    assert.deepEqual(codes(daChuyen), [], "khách chuyển đủ thì COD 0đ là ĐÚNG, không phải thiếu");

    // CHƯA CÓ VẬN ĐƠN ⇒ chưa soát được COD ⇒ im lặng.
    const chuaCoVanDon = validateForShipping({ ...DON_SACH, shipmentCod: null });
    assert.deepEqual(codes(chuaCoVanDon), []);
  }

  /* ─── 7 · Nhiều lỗi cùng lúc: đủ cả, và `readyToShip` theo lỗi NẶNG nhất ─── */
  {
    const r = validateForShipping({
      receiverName: "",
      phone: "",
      address: "",
      province: "",
      total: null,
      prepaid: null,
      shipmentCod: null,
      items: [],
    });
    const expected: ValidationCode[] = ["MISSING_RECEIVER_NAME", "MISSING_PHONE", "MISSING_ADDRESS", "NO_ITEMS", "TOTAL_MISSING"];
    assert.deepEqual(codes(r), [...expected].sort());
    assert.equal(r.readyToShip, false);
    assert.equal(r.blockers.length, 4);
    assert.equal(r.warnings.length, 1);
  }

  console.log("  ✓ soát đơn trước khi gửi (thuần): 7 nhóm");
}

export async function testPreshipValidationDb(db: Db) {
  const P = "pval-";
  let seq = 0;

  async function seedOrder(
    id: string,
    opts: {
      stage?: OrderStage;
      name?: string;
      phone?: string;
      address?: string;
      province?: string;
      total?: number;
      prepaid?: number;
      items?: { sku: string; qty: number; productId?: string | null; variantId?: string | null; detail?: string }[];
    },
  ) {
    await db
      .insert(schema.orders)
      .values({
        id: P + id,
        systemId: 9_900_000 + seq,
        billFullName: opts.name === undefined ? "Nguyễn Thị Hoa" : opts.name,
        billPhone: opts.phone === undefined ? "0912345678" : opts.phone,
        shipAddress: opts.address === undefined ? "12 Lê Lợi, Phường Bến Nghé" : opts.address,
        shipProvince: opts.province === undefined ? "Hà Nội" : opts.province,
        totalPriceAfterDiscount: opts.total ?? 499_000,
        prepaid: opts.prepaid ?? 0,
        stage: opts.stage ?? "CONFIRMED",
        insertedAt: new Date(Date.now() - (seq + 1) * 3_600_000),
      })
      .onConflictDoNothing();
    // Mặc định là một dòng hàng ĐÃ GHÉP mẫu mã đầy đủ, để mỗi ca thử chỉ mang đúng MỘT lỗi của nó.
    for (const it of opts.items ?? [{ sku: "AO-M", qty: 1, productId: `${P}prod`, variantId: `${P}var-M`, detail: "Đỏ / M" }]) {
      await db
        .insert(schema.orderItems)
        .values({
          id: `${P}${id}-${it.sku}`,
          orderId: P + id,
          variantId: it.variantId ?? null,
          productId: it.productId ?? null,
          sku: it.sku,
          productName: `SP ${it.sku}`,
          variationDetail: it.detail ?? "Đỏ / M",
          quantity: it.qty,
          unitPrice: 499_000,
          lineTotal: 499_000 * it.qty,
        })
        .onConflictDoNothing();
    }
    seq += 1;
  }

  // Sản phẩm thật với HAI mẫu mã — để luật "thiếu màu/size" có căn cứ tra được.
  await db.insert(schema.products).values({ id: `${P}prod`, name: "Áo sơ mi lụa" }).onConflictDoNothing();
  for (const v of ["M", "L"]) {
    await db
      .insert(schema.productVariants)
      .values({ id: `${P}var-${v}`, productId: `${P}prod`, sku: `AO-${v}`, detail: `Đỏ / ${v}`, color: "Đỏ", size: v })
      .onConflictDoNothing();
  }

  await seedOrder("sach", { items: [{ sku: "AO-M", qty: 1, productId: `${P}prod`, variantId: `${P}var-M`, detail: "Đỏ / M" }] });
  await seedOrder("thieu-sdt", { phone: "" });
  await seedOrder("sai-sdt", { phone: "091234" });
  await seedOrder("thieu-tinh", { province: "" });
  await seedOrder("thieu-mau", { items: [{ sku: "AO-M", qty: 1, productId: `${P}prod`, variantId: `${P}var-M`, detail: "" }] });
  await seedOrder("chua-ghep", { items: [{ sku: "LA-1", qty: 1, productId: null, variantId: null, detail: "" }] });
  await seedOrder("da-gui", { stage: "READY_TO_SHIP", phone: "" });

  clearMemo();
  const q = await getPreshipValidationQueue();
  const byId = new Map(q.rows.map((r) => [r.orderId, r]));
  const codesOf = (id: string) => (byId.get(P + id)?.blockers ?? []).concat(byId.get(P + id)?.warnings ?? []).map((f) => f.code).sort();

  assert.ok(!byId.has(`${P}sach`), "đơn đủ chứng từ không được xuất hiện trong hàng đợi");
  assert.deepEqual(codesOf("thieu-sdt"), ["MISSING_PHONE"]);
  assert.deepEqual(codesOf("sai-sdt"), ["PHONE_MALFORMED"]);
  assert.deepEqual(codesOf("thieu-tinh"), ["MISSING_PROVINCE"]);
  assert.deepEqual(codesOf("thieu-mau"), ["ITEM_MISSING_VARIATION"], "mẫu hàng có hai phân loại mà đơn không ghi màu/size ⇒ chặn");

  // Dòng hàng chưa có `product_id` ⇒ chưa tra được có phân loại hay không ⇒ KHÔNG báo thiếu màu/size.
  const chuaGhep = codesOf("chua-ghep");
  assert.ok(chuaGhep.includes("ITEM_NOT_MAPPED"), "dòng chưa ghép mẫu mã phải được nêu");
  assert.ok(!chuaGhep.includes("ITEM_MISSING_VARIATION"), "chưa tra được thì IM LẶNG — không được suy ra là thiếu");

  // Mỗi dòng phải có phòng chịu trách nhiệm và việc phải làm.
  for (const r of q.rows) {
    assert.ok(r.nextAction.trim().length > 20, `${r.orderId}: phải có việc phải làm`);
    assert.ok(r.teamLabel.trim().length > 0, `${r.orderId}: phải có phòng chịu trách nhiệm`);
    assert.ok(r.blockers.length + r.warnings.length > 0, `${r.orderId}: không có lỗi thì không được vào hàng đợi`);
    assert.equal(r.readyToShip, r.blockers.length === 0, `${r.orderId}: readyToShip phải suy từ lỗi chặn`);
  }

  // Nhóm lỗi quyết định phòng sửa.
  assert.equal(byId.get(`${P}thieu-sdt`)!.team, "CS");
  assert.equal(byId.get(`${P}chua-ghep`)!.team, "WAREHOUSE", "ghép mẫu mã là việc của kho, không phải CSKH");

  // Đơn ĐÃ tới READY_TO_SHIP mà vẫn thiếu dữ liệu: đúng cái mà chủ shop muốn chặn.
  const daGui = byId.get(`${P}da-gui`);
  assert.ok(daGui, "đơn đã sẵn sàng gửi mà thiếu SĐT phải bị nêu");
  assert.equal(daGui!.readyToShip, false);
  assert.equal(daGui!.stage, "READY_TO_SHIP");

  // Bảng đếm theo mã lỗi có mẫu số.
  assert.ok(q.scanned >= q.rows.length, "số đơn đã soát phải là mẫu số của số đơn hỏng");
  assert.ok(q.byCode.length > 0);
  assert.equal(q.byCode.reduce((t, c) => t + c.count, 0), q.rows.reduce((t, r) => t + r.blockers.length + r.warnings.length, 0), "tổng bảng đếm phải bằng tổng lỗi");

  // Bản soát một đơn dùng CÙNG một hàm luật — hai đường đọc không được ra hai kết quả.
  const mot = await getOrderValidation(`${P}sai-sdt`);
  assert.equal(mot.found, true);
  assert.deepEqual(
    mot.report.findings.map((f) => f.code).sort(),
    codesOf("sai-sdt"),
    "bản soát một đơn và bản soát cả hàng đợi phải nói cùng một điều",
  );
  const khongCo = await getOrderValidation("khong-ton-tai");
  assert.equal(khongCo.found, false);
  assert.deepEqual(khongCo.report.findings, [], "đơn không tồn tại thì không bịa ra lỗi");

  console.log(`  ✓ soát đơn trước khi gửi (CSDL): ${q.scanned} đơn đã soát · ${q.blocked} chưa gửi được · ${q.warned} gửi được nhưng số sẽ sai`);
}
