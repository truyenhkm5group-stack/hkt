/**
 * SỔ NGUỒN Ô ĐƠN HÀNG — SÁU CA CHẠY QUA ĐƯỜNG GHI THẬT, ĐỌC LẠI TỪ CSDL.
 *
 * ═══ VÌ SAO CẦN BÀI NÀY KHI ĐÃ CÓ BÀI KIỂM HÀM THUẦN ═══
 *
 * `tests/order-provenance.test.ts` canh `diffProvenance()` — một hàm thuần. Nó chứng minh phép
 * TÍNH đúng, và không chứng minh gì về phép GHI.
 *
 * Trên bản chạy thử 19/09/2026 bảng `order_field_provenance` rỗng sau một mẻ ngầm. Sáu phép kiểm
 * ca viết theo kiểu "rỗng = đạt" nên trên một bảng rỗng chúng ĐẠT MỘT CÁCH VÔ NGHĨA. Đã truy ra
 * nguyên nhân (12/12 lượt không đổi ô nào — hành vi đúng), nhưng điều đó vẫn để lại một khoảng
 * trống thật: **đường ghi chưa bao giờ được quan sát hoạt động.**
 *
 * Bài này lấp đúng khoảng trống ấy. Nó KHÔNG gọi mô hình, KHÔNG cần tin nhắn khách thật, và
 * KHÔNG bịa một cuộc hội thoại để báo cáo đẹp lên — nó dựng một hội thoại KIỂM THỬ, đẩy qua
 * `recordProvenance()` (chính hàm mà dây chuyền gọi), rồi ĐỌC LẠI từ CSDL bằng SQL.
 *
 * ═══ ĐỌC LẠI TỪ CSDL, KHÔNG TIN GIÁ TRỊ TRẢ VỀ ═══
 *
 * `recordProvenance()` trả về `{opened, closed}`. Tin con số ấy là tin vào chính thứ đang kiểm:
 * hàm nuốt lỗi CÓ CHỦ Ý, nên một lượt ghi hỏng vẫn trả về một con số trông bình thường. Mọi
 * khẳng định dưới đây đọc từ bảng.
 */
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import type { Db } from "@/db";
import { schema } from "@/db";
import { recordProvenance, snapshotOf } from "@/lib/ai-workforce/agents/sales/provenance";
import { PROVENANCE_FIELDS, type ProvenanceField } from "@/lib/constants/order-provenance";

type Dong = { field: string; value: string; sourceType: string; claim: string; status: string; sourceMessageId: string | null; supersededAt: Date | null; sourceReference: string };

export async function testProvenanceLive(db: Db) {
  // ── DỰNG HỘI THOẠI KIỂM THỬ + hai tin nhắn để ô `source_message_id` trỏ vào thứ CÓ THẬT ──
  const [conv] = await db
    .insert(schema.salesConversations)
    .values({ channel: "PANCAKE", pageId: "page-prov-live", externalId: "conv-prov-live", customerName: "Khách kiểm thử sổ nguồn", stage: "NEW_LEAD" })
    .returning({ id: schema.salesConversations.id });
  const convId = conv.id;

  const tin = async (externalId: string, text: string) => {
    const [m] = await db
      .insert(schema.salesMessages)
      .values({ conversationId: convId, externalId, direction: "IN", senderType: "CUSTOMER", text, sentAt: new Date() })
      .returning({ id: schema.salesMessages.id });
    return m.id;
  };
  const m1 = await tin("prov-m1", "chị lấy đỏ XL");
  const m2 = await tin("prov-m2", "đổi đen L nhé");
  const m3 = await tin("prov-m3", "vâng");
  const m4 = await tin("prov-m4", "0901234567");

  const doc = async (field?: ProvenanceField): Promise<Dong[]> => {
    const rows = await db
      .select({
        field: schema.orderFieldProvenance.field,
        value: schema.orderFieldProvenance.value,
        sourceType: schema.orderFieldProvenance.sourceType,
        claim: schema.orderFieldProvenance.claim,
        status: schema.orderFieldProvenance.status,
        sourceMessageId: schema.orderFieldProvenance.sourceMessageId,
        supersededAt: schema.orderFieldProvenance.supersededAt,
        sourceReference: schema.orderFieldProvenance.sourceReference,
      })
      .from(schema.orderFieldProvenance)
      .where(field ? and(eq(schema.orderFieldProvenance.conversationId, convId), eq(schema.orderFieldProvenance.field, field)) : eq(schema.orderFieldProvenance.conversationId, convId));
    return rows as Dong[];
  };
  const dangDung = (rows: Dong[]) => rows.filter((r) => r.status === "ACTIVE");

  // ═════ CA A — «chị lấy đỏ XL» ⇒ đỏ và XL cùng ACTIVE, cùng là LỜI KHÁCH ═════
  await recordProvenance(
    {
      conversationId: convId,
      runId: null,
      before: snapshotOf({}),
      after: snapshotOf({ color: "đỏ", size: "XL" }),
      ctx: { sourceMessageId: m1, statedByCustomer: { color: "đỏ", size: "XL" }, derived: {}, evidence: "chị lấy đỏ XL", confidence: 0.9 },
    },
    db,
  );
  const sauA = await doc();
  assert.equal(sauA.length, 2, "ca A: phải ghi ĐÚNG hai dòng — và đọc lại từ CSDL, không tin giá trị trả về");
  for (const r of sauA) {
    assert.equal(r.status, "ACTIVE");
    assert.equal(r.claim, "STATED", "khách nói ra thì phải là lời khách");
    assert.equal(r.sourceType, "CUSTOMER_MESSAGE");
    assert.equal(r.sourceMessageId, m1, "phải trỏ đúng tin nhắn đã dẫn tới dữ kiện");
    assert.equal(r.supersededAt, null, "dòng còn hiệu lực không được mang mốc hết hiệu lực");
  }
  assert.deepEqual(sauA.map((r) => `${r.field}=${r.value}`).sort(), ["color=đỏ", "size=XL"]);

  // ═════ CA B — «đổi đen L» ⇒ đỏ/XL SUPERSEDED, đen/L ACTIVE ═════
  await recordProvenance(
    {
      conversationId: convId,
      runId: null,
      before: snapshotOf({ color: "đỏ", size: "XL" }),
      after: snapshotOf({ color: "đen", size: "L" }),
      ctx: { sourceMessageId: m2, statedByCustomer: { color: "đen", size: "L" }, derived: {}, evidence: "đổi đen L nhé", confidence: 0.9 },
    },
    db,
  );
  const sauB = await doc();
  assert.equal(sauB.length, 4, "ca B: hai dòng cũ KHÔNG bị xoá — lịch sử chính là thứ cần giữ");
  const cuB = sauB.filter((r) => r.status === "SUPERSEDED");
  assert.equal(cuB.length, 2);
  for (const r of cuB) {
    assert.ok(r.supersededAt instanceof Date, "dòng hết hiệu lực PHẢI mang mốc — ràng buộc CSDL đòi vậy");
    assert.ok(["đỏ", "XL"].includes(r.value), `giá trị cũ phải là đỏ/XL, đang thấy ${r.value}`);
  }
  assert.deepEqual(dangDung(sauB).map((r) => `${r.field}=${r.value}`).sort(), ["color=đen", "size=L"]);

  // ═════ CA C — «vâng» KHÔNG tạo và KHÔNG sửa ô nào ═════
  //
  // Ca này khoá một lỗi ĐÃ XẢY RA THẬT: "vâng" bỏ dấu trùng "vàng" và từng được đọc thành MÀU
  // VÀNG. Ở đây phép thử mạnh hơn một ca dịch chữ — dù bộ hiểu đọc nhầm thế nào, nếu trạng thái
  // KHÔNG đổi thì sổ không được sinh một dòng nào.
  const truocC = await doc();
  await recordProvenance(
    {
      conversationId: convId,
      runId: null,
      before: snapshotOf({ color: "đen", size: "L" }),
      after: snapshotOf({ color: "đen", size: "L" }),
      ctx: { sourceMessageId: m3, statedByCustomer: {}, derived: {}, evidence: "vâng", confidence: 0.95 },
    },
    db,
  );
  const sauC = await doc();
  assert.equal(sauC.length, truocC.length, "ca C: «vâng» không được đẻ thêm dòng nào");
  assert.deepEqual(dangDung(sauC).map((r) => `${r.field}=${r.value}`).sort(), ["color=đen", "size=L"], "ca C: màu và size phải y nguyên");

  // ═════ CA D — SĐT ⇒ dòng phone trỏ đúng tin nhắn, và tin ấy là tin của KHÁCH ═════
  await recordProvenance(
    {
      conversationId: convId,
      runId: null,
      before: snapshotOf({ color: "đen", size: "L" }),
      after: snapshotOf({ color: "đen", size: "L", phone: "0901234567" }),
      ctx: { sourceMessageId: m4, statedByCustomer: { phone: "0901234567" }, derived: {}, evidence: "0901234567", confidence: 0.95 },
    },
    db,
  );
  const sdt = dangDung(await doc("phone"));
  assert.equal(sdt.length, 1);
  assert.equal(sdt[0].value, "0901234567");
  assert.equal(sdt[0].sourceMessageId, m4);
  assert.equal(sdt[0].claim, "STATED");
  // Tin ấy PHẢI là tin của khách — đọc ngược sang bảng tin nhắn, không tin vào nhãn của chính sổ.
  const tinGoc = await db.query.salesMessages.findFirst({ where: eq(schema.salesMessages.id, m4) });
  assert.equal(tinGoc?.direction, "IN", "dòng SĐT phải trỏ về một tin do KHÁCH gửi");

  // ═════ CA E — SIZE DO MÁY SUY RA KHÔNG ĐƯỢC MANG NHÃN LỜI KHÁCH ═════
  //
  // Ca quan trọng nhất. Khách cho chiều cao/cân nặng, bảng số đo gợi ý size M. Ghi dòng ấy thành
  // "khách nói size M" là biến một GỢI Ý thành một CAM KẾT — và khi kiện hàng không vừa, hồ sơ sẽ
  // nói khách tự chọn.
  const convE = (
    await db
      .insert(schema.salesConversations)
      .values({ channel: "PANCAKE", pageId: "page-prov-live", externalId: "conv-prov-live-e", customerName: "Khách ca E", stage: "NEW_LEAD" })
      .returning({ id: schema.salesConversations.id })
  )[0].id;
  await recordProvenance(
    {
      conversationId: convE,
      runId: null,
      before: snapshotOf({}),
      after: snapshotOf({ size: "M" }),
      ctx: { sourceMessageId: null, statedByCustomer: {}, derived: { size: { sourceType: "ERP_SIZE_ENGINE" } }, evidence: "cao 1m55 nặng 45kg ⇒ M", confidence: 0.8 },
    },
    db,
  );
  const dongE = await db
    .select({ sourceType: schema.orderFieldProvenance.sourceType, claim: schema.orderFieldProvenance.claim })
    .from(schema.orderFieldProvenance)
    .where(and(eq(schema.orderFieldProvenance.conversationId, convE), eq(schema.orderFieldProvenance.field, "size")));
  assert.equal(dongE.length, 1);
  assert.equal(dongE[0].sourceType, "ERP_SIZE_ENGINE");
  assert.equal(dongE[0].claim, "DERIVED", "ca E: máy suy ra thì phải là DERIVED, KHÔNG BAO GIỜ STATED");

  // Và không dòng nào trong CẢ BẢNG có nguồn MÁY mà lại mang nhãn lời khách.
  const viPham = await db
    .select({ id: schema.orderFieldProvenance.id })
    .from(schema.orderFieldProvenance)
    .where(and(eq(schema.orderFieldProvenance.claim, "STATED"), eq(schema.orderFieldProvenance.sourceType, "ERP_SIZE_ENGINE")));
  assert.equal(viPham.length, 0, "ca E: không dòng nào được vừa là máy suy ra vừa mang nhãn lời khách");

  // ═════ CA F — ĐỔI SẢN PHẨM ⇒ MẪU MÃ CŨ KHÔNG ĐƯỢC Ở LẠI ACTIVE ═════
  //
  // Nếu dòng mẫu mã cũ vẫn còn hiệu lực thì sổ đang nói mẫu mã của sản phẩm A thuộc về đơn hàng
  // của sản phẩm B.
  const convF = (
    await db
      .insert(schema.salesConversations)
      .values({ channel: "PANCAKE", pageId: "page-prov-live", externalId: "conv-prov-live-f", customerName: "Khách ca F", stage: "NEW_LEAD" })
      .returning({ id: schema.salesConversations.id })
  )[0].id;
  await recordProvenance(
    {
      conversationId: convF,
      runId: null,
      before: snapshotOf({}),
      after: snapshotOf({ productId: "SP-A", variantId: "SP-A-XL-do", color: "đỏ", size: "XL" }),
      ctx: { sourceMessageId: null, statedByCustomer: { color: "đỏ", size: "XL" }, derived: { product_id: { sourceType: "PRODUCT_RESOLVER", reference: "res-A" }, variant_id: { sourceType: "ERP_CATALOG" } }, evidence: "mẫu A", confidence: 0.9 },
    },
    db,
  );
  await recordProvenance(
    {
      conversationId: convF,
      runId: null,
      before: snapshotOf({ productId: "SP-A", variantId: "SP-A-XL-do", color: "đỏ", size: "XL" }),
      after: snapshotOf({ productId: "SP-B" }),
      ctx: { sourceMessageId: null, statedByCustomer: {}, derived: { product_id: { sourceType: "PRODUCT_RESOLVER", reference: "res-B" } }, evidence: "cho em hỏi mẫu B", confidence: 0.85 },
    },
    db,
  );
  const fRows = (await db
    .select({ field: schema.orderFieldProvenance.field, value: schema.orderFieldProvenance.value, status: schema.orderFieldProvenance.status, sourceReference: schema.orderFieldProvenance.sourceReference })
    .from(schema.orderFieldProvenance)
    .where(eq(schema.orderFieldProvenance.conversationId, convF))) as Dong[];
  const fActive = fRows.filter((r) => r.status === "ACTIVE");
  assert.deepEqual(fActive.map((r) => `${r.field}=${r.value}`).sort(), ["product_id=SP-B"], "ca F: chỉ mã hàng mới còn hiệu lực — mẫu mã/màu/size của sản phẩm cũ phải hết hiệu lực");
  assert.equal(fActive[0].sourceReference, "res-B", "phải trỏ về dòng trong sổ nhận diện sản phẩm");
  assert.equal(fRows.filter((r) => r.field === "variant_id" && r.status === "ACTIVE").length, 0, "ca F: KHÔNG được còn mẫu mã nào của sản phẩm cũ");

  // ═════ BẤT BIẾN TOÀN BẢNG ═════
  // Mỗi (hội thoại, ô) chỉ được MỘT dòng còn hiệu lực. Hai dòng ACTIVE nghĩa là sổ trả lời hai
  // kiểu cho cùng một câu hỏi — và không ai biết nên tin dòng nào.
  for (const convX of [convId, convE, convF]) {
    const rows = (await db
      .select({ field: schema.orderFieldProvenance.field, status: schema.orderFieldProvenance.status })
      .from(schema.orderFieldProvenance)
      .where(eq(schema.orderFieldProvenance.conversationId, convX))) as Dong[];
    const dem = new Map<string, number>();
    for (const r of rows.filter((x) => x.status === "ACTIVE")) dem.set(r.field, (dem.get(r.field) ?? 0) + 1);
    for (const [f, n] of dem) assert.equal(n, 1, `hội thoại ${convX}: ô ${f} có ${n} dòng còn hiệu lực, phải đúng 1`);
    for (const r of rows) assert.ok((PROVENANCE_FIELDS as readonly string[]).includes(r.field), `ô lạ trong sổ: ${r.field}`);
  }

  // ═════ DỌN DỮ LIỆU KIỂM THỬ ═════
  // Hội thoại xoá đi là sổ nguồn theo (khoá ngoại `cascade`) — bài kiểm không được để lại rác cho
  // các bài chạy sau, nhất là khi chúng cũng đếm trên cùng bảng.
  for (const c of [convId, convE, convF]) await db.delete(schema.salesConversations).where(eq(schema.salesConversations.id, c));
  const conLai = await db.select({ id: schema.orderFieldProvenance.id }).from(schema.orderFieldProvenance).where(eq(schema.orderFieldProvenance.conversationId, convId));
  assert.equal(conLai.length, 0, "xoá hội thoại phải cuốn theo sổ nguồn — nếu không, khoá ngoại cascade đã sai");

  console.log("✓ Sổ nguồn ô đơn hàng: sáu ca A–F chạy qua ĐƯỜNG GHI THẬT và ĐỌC LẠI TỪ CSDL · bất biến một-dòng-hiệu-lực giữ · dọn sạch sau khi chạy");
}
