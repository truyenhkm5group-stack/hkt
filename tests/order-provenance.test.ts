/**
 * SỔ NGUỒN Ô ĐƠN HÀNG — sáu ca của đặc tả, viết theo hội thoại thật.
 *
 * Mỗi ca dưới đây là một câu hỏi mà người xử lý khiếu nại sẽ hỏi, không phải một nhánh mã cần phủ.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  CLAIM_OF_SOURCE,
  PROVENANCE_FIELDS,
  PROVENANCE_SOURCE_TYPES,
  diffProvenance,
  isCustomerStated,
  type ProvenanceContext,
} from "@/lib/constants/order-provenance";

const TRONG: ProvenanceContext = { sourceMessageId: null, statedByCustomer: {}, derived: {}, evidence: "", confidence: null };
const ctx = (p: Partial<ProvenanceContext>): ProvenanceContext => ({ ...TRONG, ...p });

test("ca A — «chị lấy đỏ XL» ⇒ đỏ và XL cùng ACTIVE, và cùng là lời KHÁCH", () => {
  const { insert, supersede } = diffProvenance(
    {},
    { color: "đỏ", size: "XL" },
    ctx({ sourceMessageId: "m1", statedByCustomer: { color: "đỏ", size: "XL" }, evidence: "chị lấy đỏ XL", confidence: 0.9 }),
  );
  assert.equal(supersede.length, 0, "chưa có gì để thay thế");
  assert.deepEqual(insert.map((r) => r.field).sort(), ["color", "size"]);
  for (const r of insert) {
    assert.equal(r.sourceType, "CUSTOMER_MESSAGE");
    assert.equal(r.claim, "STATED");
    assert.equal(r.sourceMessageId, "m1", "phải trỏ đúng tin nhắn đã dẫn tới dữ kiện");
    assert.ok(isCustomerStated(r));
  }
});

test("ca B — «đổi đen L» ⇒ đỏ/XL SUPERSEDED, đen/L ACTIVE", () => {
  const { insert, supersede } = diffProvenance(
    { color: "đỏ", size: "XL" },
    { color: "đen", size: "L" },
    ctx({ sourceMessageId: "m2", statedByCustomer: { color: "đen", size: "L" }, evidence: "đổi đen L nhé" }),
  );
  assert.deepEqual([...supersede].sort(), ["color", "size"], "giá trị cũ phải hết hiệu lực, không bị xoá");
  assert.deepEqual(insert.map((r) => r.value).sort(), ["L", "đen"]);
  // Giá trị cũ KHÔNG biến mất — đó là cả điểm của một cuốn sổ. Khép dòng cũ và mở dòng mới là hai
  // việc, và bài kiểm đòi cả hai xảy ra trong cùng một lượt.
  assert.equal(supersede.length + insert.length, 4);
});

test("ca C — «vâng» KHÔNG tạo và KHÔNG sửa ô nào", () => {
  /*
    Ca này khoá một lỗi ĐÃ XẢY RA THẬT trong bộ hồi quy: "vâng" bỏ dấu trùng "vàng" và từng được
    đọc thành MÀU VÀNG. Ở đây phép thử mạnh hơn một ca dịch chữ: dù bộ hiểu có đọc nhầm thế nào,
    nếu trạng thái KHÔNG đổi thì sổ nguồn không được sinh một dòng nào.
  */
  const truoc = { color: "đen", size: "L" };
  const { insert, supersede } = diffProvenance(truoc, { ...truoc }, ctx({ sourceMessageId: "m3", evidence: "vâng" }));
  assert.deepEqual(insert, []);
  assert.deepEqual(supersede, []);
});

test("ca D — khách gửi SĐT ⇒ dòng phone trỏ đúng tin nhắn ấy", () => {
  const { insert } = diffProvenance(
    { color: "đen" },
    { color: "đen", phone: "0901234567" },
    ctx({ sourceMessageId: "m4", statedByCustomer: { phone: "0901234567" }, evidence: "0901234567", confidence: 0.95 }),
  );
  assert.equal(insert.length, 1);
  assert.equal(insert[0].field, "phone");
  assert.equal(insert[0].sourceMessageId, "m4");
  assert.equal(insert[0].claim, "STATED");
  assert.equal(insert[0].confidence, 0.95);
});

test("ca E — size do BẢNG SỐ ĐO suy ra KHÔNG được ghi như lời khách", () => {
  /*
    Ca quan trọng nhất của cả tệp. Khách cho chiều cao/cân nặng, bảng số đo gợi ý size L. Ghi dòng
    ấy thành "khách nói size L" là biến một GỢI Ý thành một CAM KẾT — và khi kiện hàng không vừa,
    hồ sơ sẽ nói khách tự chọn.
  */
  const { insert } = diffProvenance(
    { color: "đen" },
    { color: "đen", size: "L" },
    ctx({ sourceMessageId: "m5", derived: { size: { sourceType: "ERP_SIZE_ENGINE" } }, evidence: "cao 1m60 nặng 55kg ⇒ L" }),
  );
  assert.equal(insert.length, 1);
  assert.equal(insert[0].sourceType, "ERP_SIZE_ENGINE");
  assert.equal(insert[0].claim, "DERIVED", "máy suy ra thì phải là DERIVED, không bao giờ STATED");
  assert.equal(isCustomerStated(insert[0]), false, "hỏi 'khách có tự chọn size này không' phải trả lời KHÔNG");

  // Và chiều ngược lại cũng phải giữ: khách TỰ nói size thì ghi là lời khách, kể cả khi bảng số đo
  // cùng lúc suy ra đúng giá trị ấy. Thiếu vế này thì ca E đúng theo một chiều và sai theo chiều kia.
  const b = diffProvenance(
    {},
    { size: "L" },
    ctx({ statedByCustomer: { size: "L" }, derived: { size: { sourceType: "ERP_SIZE_ENGINE" } }, evidence: "em lấy size L" }),
  );
  assert.equal(b.insert[0].sourceType, "CUSTOMER_MESSAGE");
  assert.ok(isCustomerStated(b.insert[0]));
});

test("ca F — đổi sản phẩm KHÔNG được để mẫu mã của sản phẩm cũ ở lại ACTIVE", () => {
  /*
    Khách đang hỏi mẫu A (đã chốt mẫu mã), rồi chuyển sang mẫu B. Dây chuyền thật xoá `variantId`
    khi mẫu mã cũ không còn khớp. Sổ phải ghi nhận điều đó: dòng mẫu mã cũ hết hiệu lực, và KHÔNG
    có dòng mẫu mã mới nào được mở ra — vì chưa chốt được mẫu mã nào của sản phẩm mới.

    Nếu dòng cũ vẫn ACTIVE thì sổ đang nói mẫu mã của sản phẩm A thuộc về đơn hàng của sản phẩm B.
  */
  const { insert, supersede } = diffProvenance(
    { product_id: "A", variant_id: "A-XL-do", color: "đỏ", size: "XL" },
    { product_id: "B", variant_id: "", color: "", size: "" },
    ctx({ sourceMessageId: "m6", statedByCustomer: {}, derived: { product_id: { sourceType: "PRODUCT_RESOLVER", reference: "res-9" } }, evidence: "cho em hỏi mẫu B" }),
  );
  assert.deepEqual([...supersede].sort(), ["color", "product_id", "size", "variant_id"]);
  // Chỉ MỘT dòng mới: sản phẩm. Không dòng mẫu mã/màu/size nào của sản phẩm cũ đi theo sang.
  assert.equal(insert.length, 1);
  assert.equal(insert[0].field, "product_id");
  assert.equal(insert[0].value, "B");
  assert.equal(insert[0].sourceReference, "res-9", "phải trỏ về dòng trong sổ nhận diện sản phẩm");
  assert.equal(insert[0].claim, "DERIVED");
});

test("mức khẳng định lấy TỪ BẢNG, nơi gọi không tự điền được", () => {
  // Mọi nguồn phải khai sẵn mức khẳng định; thiếu một dòng là mở đúng cánh cửa ca E.
  for (const s of PROVENANCE_SOURCE_TYPES) assert.ok(CLAIM_OF_SOURCE[s], `${s} chưa khai mức khẳng định`);
  // Không nguồn MÁY nào được mang mức STATED.
  assert.equal(CLAIM_OF_SOURCE.ERP_SIZE_ENGINE, "DERIVED");
  assert.equal(CLAIM_OF_SOURCE.MODEL_INFERENCE, "INFERRED");
  assert.equal(CLAIM_OF_SOURCE.ERP_CATALOG, "DERIVED");
  assert.equal(CLAIM_OF_SOURCE.PRODUCT_RESOLVER, "DERIVED");

  // Và `ProvenanceRecord.claim` không được nhận từ tham số ở bất cứ đâu: `diffProvenance` luôn
  // tra bảng. Quét mã đã vào kho để không ai thêm một đường vòng.
  const nguon = execFileSync("git", ["show", "HEAD:lib/constants/order-provenance.ts"], { encoding: "utf-8" })
    .split("\n")
    .filter((d) => !/^\s*(\/\/|\*|\/\*)/.test(d))
    .join("\n");
  assert.ok(/claim: CLAIM_OF_SOURCE\[/.test(nguon), "mức khẳng định phải tra từ bảng");
  assert.ok(!/claim: ctx\./.test(nguon) && !/ctx\.claim/.test(nguon), "nơi gọi không được tự điền mức khẳng định");
});

test("sổ nguồn KHÔNG được thành máy trạng thái thứ hai", () => {
  /*
    Ranh giới quan trọng nhất: `sales_conversations.state` vẫn là nguồn sự thật cho dây chuyền
    nghiệp vụ. Sổ này chỉ GHI LẠI. Nếu một quyết định bán hàng đọc nó, ta có hai nơi trả lời cùng
    một câu hỏi — và chúng sẽ nói khác nhau vào đúng lúc tệ nhất.
  */
  const nguon = execFileSync("git", ["show", "HEAD:lib/constants/order-provenance.ts"], { encoding: "utf-8" })
    .split("\n")
    .filter((d) => !/^\s*(\/\/|\*|\/\*)/.test(d))
    .join("\n");
  assert.ok(
    !/missingOrderRequirements|ORDER_REQUIREMENTS|buildOrderDraft|nextStage|decide\(/.test(nguon),
    "sổ nguồn đang chạm vào lưới quyết định — nó chỉ được ghi lại, không được quyết",
  );
  assert.equal(PROVENANCE_FIELDS.length, 6, "bản V1 đúng sáu ô; mở rộng phải là một quyết định có chủ đích");
});
