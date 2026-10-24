/**
 * ═══════════ ĐỆM RIÊNG /work GIỮ SỐ CŨ KHI NGƯỜI DÙNG GHI (OD-UX-05 mục 2(c), 24/10/2026) ═══════════
 *
 * Khoá:
 *  (i)   clearMemo ⇒ khoá giữ-cũ thành CŨ (đọc được ngay, lượt đọc kế tiếp làm mới phía sau); MỌI khoá khác vẫn bị XOÁ HẲN.
 *  (ii)  lượt ghi xen giữa lúc tính ⇒ kết quả LƯU Ở TRẠNG THÁI CŨ cho khoá giữ-cũ (lượt đọc sau khởi động làm mới), VỨT cho khoá khác.
 *  (iii) khoá dùng chung của tồn kho + cấu hình KHÔNG nằm trong danh sách — màn tồn kho đọc số mới ngay sau ghi.
 *  (iv)  lượt làm mới đổi số ⇒ memo phát sự kiện để trang đang mở tự làm mới.
 *  (v)   việc vừa đóng TỪ MIỀN (đơn huỷ) biến khỏi /work sau lượt làm mới (AGENTS 19): lượt đọc đầu còn thấy (số cũ — chủ ý),
 *        lượt kế tiếp thì không.
 */
import assert from "node:assert/strict";
import { inArray } from "drizzle-orm";
import type { Db } from "@/db";
import { schema } from "@/db";
import { clearMemo, clearMemoAll, memo, memoKeys, memoPeek, registerStaleOnWrite } from "@/lib/cache";
import { WORK_ALERTS_KEY, WORK_FULFILLMENT_KEY, WORK_STALE_ON_WRITE_PREFIXES } from "@/lib/constants/work-cache";
import { subscribe } from "@/lib/realtime/bus";
import { collectWorkItems } from "@/lib/queries/work-adapters";

const cho = async (dk: () => boolean) => {
  for (let i = 0; i < 400 && !dk(); i += 1) await new Promise((r) => setTimeout(r, 5));
};

async function testNguNghiaDem() {
  registerStaleOnWrite(["test-giu:"]);
  clearMemo();
  let lanTinh = 0;
  const giu = (v: string) => memo("test-giu:a", 60_000, async () => ((lanTinh += 1), v));
  assert.equal(await giu("v1"), "v1");
  await memo("test-xoa:b", 60_000, async () => "w1");

  // (i) Xoá đệm do người ghi: khoá giữ-cũ còn nguyên ở trạng thái CŨ, khoá khác mất.
  clearMemo();
  assert.ok(memoKeys().includes("test-giu:a"), "khoá giữ-cũ còn trong đệm");
  assert.ok(!memoKeys().includes("test-xoa:b"), "khoá khác bị xoá hẳn như trước");
  assert.deepEqual(await memoPeek("test-giu:a"), { value: "v1" }, "đọc không tính vẫn thấy số trước lượt ghi");

  // (iv) + CŨ: lượt đọc nhận NGAY số cũ, lượt làm mới chạy phía sau và phát sự kiện vì số đổi.
  const suKien: string[] = [];
  const bo = subscribe((e) => {
    if (e.type === "sync" && e.source === "CACHE") suKien.push(e.job);
  });
  try {
    const truoc = lanTinh;
    assert.equal(await giu("v2"), "v1", "số CŨ trả ngay — không bắt người đọc chờ tính lại");
    assert.equal(await giu("x"), "v2", "lượt đọc kế tiếp dùng chung lượt làm mới ⇒ số mới");
    assert.equal(lanTinh, truoc + 1, "đúng MỘT lượt làm mới");
    await cho(() => suKien.length > 0);
    assert.ok(suKien.some((j) => j.startsWith("memo:")), "số đổi sau làm mới ⇒ phát sự kiện để trang tự làm mới");
  } finally {
    bo();
  }

  // (ii) Lượt ghi xen giữa lúc tính.
  let mo: () => void = () => {};
  const cham = new Promise<void>((r) => (mo = r));
  let vaoGiu = false;
  let vaoXoa = false;
  const p1 = memo("test-giu:c", 60_000, async () => {
    vaoGiu = true;
    await cham;
    return "c1";
  });
  const p2 = memo("test-xoa:d", 60_000, async () => {
    vaoXoa = true;
    await cham;
    return "d1";
  });
  await cho(() => vaoGiu && vaoXoa);
  clearMemo();
  mo();
  assert.deepEqual([await p1, await p2], ["c1", "d1"], "người đang chờ vẫn nhận kết quả");
  assert.ok(memoKeys().includes("test-giu:c"), "khoá giữ-cũ: kết quả tính xong sau lượt ghi được LƯU");
  assert.ok(!memoKeys().includes("test-xoa:d"), "khoá khác: kết quả tính xong sau lượt ghi bị VỨT như trước");
  let lamMoi = 0;
  assert.equal(await memo("test-giu:c", 60_000, async () => ((lamMoi += 1), "c2")), "c1", "lưu ở trạng thái CŨ ⇒ trả ngay số đã lưu…");
  await cho(() => lamMoi > 0);
  assert.equal(lamMoi, 1, "…và khởi động lượt làm mới (không lưu như số tươi)");

  // (iii) Khoá dùng chung của tồn kho / cấu hình KHÔNG được giữ cũ.
  for (const k of ["getStockShortage:24", "getReplenishmentPlan:mac-dinh", "work-config", "payroll-recon-center:2031-01:2031-03"]) {
    assert.ok(!WORK_STALE_ON_WRITE_PREFIXES.some((p) => k.startsWith(p)), `${k} không thuộc danh sách giữ-cũ`);
    await memo(k, 60_000, async () => "x");
  }
  clearMemo();
  for (const k of ["getStockShortage:24", "getReplenishmentPlan:mac-dinh", "work-config", "payroll-recon-center:2031-01:2031-03"]) {
    assert.ok(!memoKeys().includes(k), `${k}: người vừa ghi phải thấy số mới ngay — xoá hẳn`);
  }
  assert.ok([WORK_FULFILLMENT_KEY, WORK_ALERTS_KEY].every((k) => WORK_STALE_ON_WRITE_PREFIXES.some((p) => k.startsWith(p))), "hai khoá bọc của /work nằm trong danh sách");
  clearMemo();
}

async function testViecDongBienMat(db: Db) {
  const id = "stale-ow-don-1";
  try {
    await db.insert(schema.orders).values({
      id,
      systemId: 9_876_543,
      billFullName: "Khách giữ cũ",
      billPhone: "0900000000",
      shipAddress: "1 đường A",
      shipProvince: "Hà Nội",
      totalPriceAfterDiscount: 300_000,
      stage: "CONFIRMED",
      insertedAt: new Date(Date.now() - 48 * 3_600_000),
      lastUpdateStatusAt: new Date(Date.now() - 30 * 3_600_000),
    });
    // Mốc đầu phải NGUỘI THẬT (clearMemoAll): bài kiểm trước có thể đã để lại khoá bọc /work, và clearMemo giữ nó ở trạng thái
    // CŨ — đúng ngữ nghĩa đang kiểm, nên lượt đọc đầu sẽ không thấy đơn vừa thêm.
    clearMemoAll();
    const coViec = (r: Awaited<ReturnType<typeof collectWorkItems>>) => r.items.some((i) => i.sourceKey === id);
    const dau = await collectWorkItems({ sources: ["FULFILLMENT_EXCEPTION"] });
    assert.ok(coViec(dau), `đơn chốt chưa rời kho ⇒ có trong /work (nguồn lỗi: ${JSON.stringify(dau.failed)} · ${dau.items.length} việc)`);
    // Đóng TỪ MIỀN: đơn huỷ (không có nút «xong» nào trên /work — AGENTS 19), lượt ghi xoá đệm như mọi server action.
    await db.update(schema.orders).set({ stage: "CANCELLED" }).where(inArray(schema.orders.id, [id]));
    clearMemo();
    const ngay = await collectWorkItems({ sources: ["FULFILLMENT_EXCEPTION"] });
    assert.ok(coViec(ngay), "lượt đọc NGAY sau ghi nhận số cũ (chủ ý: không bắt chờ 3 s) — lượt làm mới đã chạy phía sau");
    const sau = await collectWorkItems({ sources: ["FULFILLMENT_EXCEPTION"] });
    assert.ok(!coViec(sau), "sau lượt làm mới, việc đã đóng ở miền BIẾN khỏi /work");
  } finally {
    await db.delete(schema.orders).where(inArray(schema.orders.id, [id]));
    clearMemoAll();
  }
}

export async function testMemoStaleOnWrite(db: Db) {
  await testNguNghiaDem();
  await testViecDongBienMat(db);
  console.log("✓ Đệm riêng /work giữ số cũ khi ghi (OD-UX-05 2c): xoá đệm ⇒ 3 khoá /work thành CŨ, mọi khoá khác xoá hẳn · ghi xen lúc tính ⇒ lưu CŨ (lượt sau làm mới), khoá khác vứt · tồn kho/cấu hình không giữ cũ · đổi số ⇒ phát sự kiện · việc đóng từ miền biến mất sau lượt làm mới");
}
