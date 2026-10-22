/**
 * ═══ ops `pos-reship-link` — GẮN MÃ VẬN ĐƠN VTP TẠO LẠI VÀO ĐƠN PANCAKE POS (P0 22/10/2026) ═══
 *
 * Khoá các luật đã duyệt: mặc định CHẠY THỬ · `--apply` bắt buộc kèm `--limit` · thân PUT CHỈ khối partner (không status) · không đè mã
 * lạ · idempotent · đọc lại + so field khác · ghi nhật ký · ops khai đủ bốn chỗ. Không gọi mạng.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { linkBody, linkPlan, parseReshipArgs, partnerOf, unexpectedChanges } from "../scripts/pos-reship-link";

export function testPosReshipLink() {
  // Đối số: chạy thử mặc định; ghi thì PHẢI có --limit.
  assert.deepEqual(parseReshipArgs([]), { apply: false, limit: 20, pilot: false, order: null });
  assert.deepEqual(parseReshipArgs(["--apply"]), { error: "--apply bắt buộc kèm --limit=N (pilot: --limit=1)" }, "không bao giờ ghi hàng loạt vì quên một cờ");
  assert.deepEqual(parseReshipArgs(["--apply", "--limit=1", "--pilot"]), { apply: true, limit: 1, pilot: true, order: null });
  assert.ok("error" in parseReshipArgs(["--limit=0"]) && "error" in parseReshipArgs(["--limit=1001"]) && "error" in parseReshipArgs(["--limit=abc"]));
  assert.ok("error" in parseReshipArgs(["--order=1;drop"]), "mã đơn chỉ chữ / số");
  assert.equal((parseReshipArgs(["--order=1234567"]) as { order: string }).order, "1234567");

  // Kế hoạch: đã đúng ⇒ không PUT; trống / mã gốc ⇒ gắn; mã lạ ⇒ không đè.
  const OLD = "PKE111";
  const NEW = "PKE222";
  assert.equal(linkPlan({ extend_code: NEW, order_number_vtp: NEW }, OLD, NEW), "ALREADY", "idempotent");
  assert.equal(linkPlan({ extend_code: OLD, order_number_vtp: OLD }, OLD, NEW), "LINK");
  assert.equal(linkPlan({ extend_code: null, order_number_vtp: null }, OLD, NEW), "LINK", "đơn chưa có mã ⇒ gắn");
  assert.equal(linkPlan({ extend_code: null, order_number_vtp: OLD }, OLD, NEW), "LINK");
  assert.equal(linkPlan({ extend_code: "GHN999", order_number_vtp: null }, OLD, NEW), "FOREIGN_CODE", "mã ĐVVC khác ⇒ không đè");
  assert.equal(linkPlan({ extend_code: "pke111", order_number_vtp: null }, OLD, NEW), "LINK", "mã gốc viết thường không phải mã lạ");
  assert.equal(linkPlan({ extend_code: "pke222", order_number_vtp: " PKE222 " }, OLD, NEW), "ALREADY", "mã mới viết thường ⇒ đã gắn, không PUT lại");
  assert.deepEqual(partnerOf({ partner: { extend_code: " pke222 ", order_number_vtp: "" } }), { extend_code: "PKE222", order_number_vtp: null });
  assert.deepEqual(partnerOf({}), { extend_code: null, order_number_vtp: null });

  // Thân PUT: ĐÚNG khối partner hai mã — không status, không field nào khác.
  assert.deepEqual(linkBody(NEW), { partner: { extend_code: NEW, order_number_vtp: NEW } });
  assert.ok(!JSON.stringify(linkBody(NEW)).includes("status"), "không bao giờ đổi trạng thái đơn");

  // So trước / sau: chỉ hai mã + dấu vết sửa được đổi; field khác đổi ⇒ liệt kê TÊN.
  const before = { status: 2, total_price: 400_000, note: "x", partner: { extend_code: OLD, order_number_vtp: OLD, partner_status: "delivered", total_fee: 30_000 }, updated_at: "a", last_editor: { id: "1" } };
  const ok = { ...before, partner: { ...before.partner, extend_code: NEW, order_number_vtp: NEW }, updated_at: "b", last_editor: { id: "2" } };
  assert.deepEqual(unexpectedChanges(before, ok), [], "chỉ đổi đúng hai mã ⇒ không báo");
  assert.deepEqual(unexpectedChanges(before, { ...ok, status: 3, partner: { ...ok.partner, partner_status: "returned" } }), ["partner.partner_status", "status"], "PUT làm đổi field khác ⇒ báo đúng tên");

  // Mã nguồn: chạy thử chỉ đọc; PUT chỉ trong nhánh --apply + LINK; đọc lại ngay; ghi nhật ký; tóm tắt không mang mã đơn.
  const src = readFileSync("scripts/pos-reship-link.ts", "utf8");
  assert.match(src, /if \(CHAY_THANG && !process\.argv\.includes\("--apply"\)\) process\.env\.ERP_READ_ONLY = "1";/, "chạy thử ⇒ CSDL chỉ đọc");
  assert.equal((src.match(/pos\("PUT"/g) ?? []).length, 1, "đúng MỘT chỗ PUT");
  const putAt = src.indexOf('pos("PUT"');
  assert.ok(src.lastIndexOf('if (!args.apply || plan !== "LINK") continue;', putAt) > 0, "PUT chỉ chạy khi --apply và kế hoạch là LINK");
  assert.ok(src.indexOf('pos("GET", p.orderId).catch', putAt) > putAt, "đọc lại NGAY sau PUT");
  assert.match(src, /await audit\(\{[\s\S]*?action: "pos\.reship_link"/, "ghi nhật ký ERP");
  assert.match(src, /assertHomeCredentials\("pancake"\)/, "chỉ khoá POS của tổ chức nhà");
  assert.match(src, /maskPancakeKey\(/, "câu lỗi che khoá");
  assert.doesNotMatch(src.replace(/\/\*[\s\S]*?\*\//g, ""), /tomTat\([^\n]*\$\{p\.(orderId|oldCode|newCode)/, "tóm tắt không mang mã đơn / mã vận đơn");
  assert.doesNotMatch(src, /bill_full_name|bill_phone_number|phone_number/, "không đọc / in tên, SĐT");

  // ops khai đủ bốn chỗ.
  const ops = readFileSync(".github/workflows/ops-vps.yml", "utf8");
  assert.match(ops, /- pos-reship-link\s+#/, "lựa chọn");
  assert.match(ops, /OPS_THAO_TAC_MA_HOA: "[^"]*\bpos-reship-link\b/, "kết quả MÃ HOÁ");
  assert.match(ops, /DOC_NANG="[^"]*\bpos-reship-link\b/, "làn chạy riêng");
  assert.match(ops, /pos-reship-link\)\n[\s\S]*?scripts\/pos-reship-link\.ts ;;/, "nhánh chạy");
  console.log("✓ ops pos-reship-link: chạy thử mặc định · --apply bắt buộc --limit · PUT chỉ partner (không status) · không đè mã lạ · idempotent · đọc lại + so field · nhật ký · ops khai đủ");
}
