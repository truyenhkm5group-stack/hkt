import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { audit } from "@/lib/audit";
import { clearMemo, memo, registerStaleOnWrite } from "@/lib/cache";
import { withOrganization } from "@/lib/platform/context";

/*
  ═══ XOÁ ĐỆM THEO TỔ CHỨC (24/10/2026) ═══

  Đo production 24/10 05:50Z: /reports/returns của nhà mở lần hai (đáng ra trúng đệm) mất 9,2 s, trong khi CSDL nhà chỉ
  có 3 dòng nhật ký trong 20 phút (db-query 40069757141) — bot HSLC ghi liên tục vào CSDL của HSLC, và mỗi lượt ghi
  xoá đệm của MỌI tổ chức trong tiến trình. Bất biến khoá ở đây:

    1. ghi ở tổ chức B (ngữ cảnh tường minh — đúng đường của bot / webhook) ⇒ đệm của B mất, đệm của NHÀ còn nguyên;
    2. ghi ở nhà ⇒ đệm nhà mất, đệm của B còn nguyên;
    3. không có ngữ cảnh tường minh ⇒ xoá TẤT CẢ như cũ (phía an toàn của đệm);
    4. `audit()` trong ngữ cảnh B chỉ xoá B — kể cả khi action có đổi số liệu;
    5. lượt tính ĐANG CHẠY của nhà vẫn được LƯU khi B xoá đệm; bị VỨT khi chính nhà xoá (như cũ);
    6. khoá giữ-cũ (#1025): chỉ bị đánh dấu cũ khi CHÍNH tổ chức của nó ghi.

  Gọi từ `testPlatformProcessIsolation`, nơi tổ chức B đã được dựng (dựng thêm một tổ chức chỉ cho bài này là trả giá
  một CSDL PGlite nữa).
*/
export async function testMemoOrgScope(B: string, homeCode: string) {
  const K = "mos:probe";
  let lan = 0;
  const tinh = (nhan: string) => async () => {
    lan += 1;
    return `${nhan}#${lan}`;
  };
  const nha = (fn: () => Promise<string>) => memo(K, 60_000, fn);
  const beta = (fn: () => Promise<string>) => withOrganization(B, () => memo(K, 60_000, fn));

  clearMemo("ALL");
  const nha1 = await nha(tinh("nha"));
  const beta1 = await beta(tinh("beta"));

  // 1. B ghi (ngữ cảnh tường minh) ⇒ chỉ B mất.
  await withOrganization(B, async () => clearMemo());
  assert.equal(await nha(tinh("nha")), nha1, "B xoá đệm ⇒ đệm NHÀ còn nguyên (trúng, không tính lại)");
  const beta2 = await beta(tinh("beta"));
  assert.notEqual(beta2, beta1, "B xoá đệm ⇒ đệm của B tính lại");

  // 2. nhà ghi (ngữ cảnh tường minh của nhà) ⇒ chỉ nhà mất.
  await withOrganization(homeCode, async () => clearMemo());
  const nha2 = await nha(tinh("nha"));
  assert.notEqual(nha2, nha1, "nhà xoá đệm ⇒ đệm nhà tính lại");
  assert.equal(await beta(tinh("beta")), beta2, "nhà xoá đệm ⇒ đệm của B còn nguyên");

  // 3. không ngữ cảnh tường minh (server action theo phiên, script) ⇒ TẤT CẢ, như trước.
  clearMemo();
  assert.notEqual(await nha(tinh("nha")), nha2, "không ngữ cảnh ⇒ xoá cả nhà");
  assert.notEqual(await beta(tinh("beta")), beta2, "không ngữ cảnh ⇒ xoá cả B");

  // 4. audit() trong ngữ cảnh B — action CÓ đổi số liệu (không ở KHONG_DOI_SO_LIEU) — chỉ xoá B.
  const nha3 = await nha(tinh("nha"));
  const beta3 = await beta(tinh("beta"));
  await withOrganization(B, () => audit({ userId: null, userEmail: "agent:tests/memo-org-scope.test.ts", actorKind: "AGENT", action: "MOS_PROBE_WRITE", entity: "TEST", entityId: "mos" }));
  assert.equal(await nha(tinh("nha")), nha3, "audit() ở B không được xoá đệm nhà");
  assert.notEqual(await beta(tinh("beta")), beta3, "audit() ở B xoá đệm của B");

  // 5. lượt tính đang chạy của nhà: B xoá giữa chừng ⇒ vẫn LƯU; nhà xoá giữa chừng ⇒ VỨT (lượt sau tính lại).
  const K2 = "mos:inflight";
  for (const [ai, luu] of [
    [B, true],
    [homeCode, false],
  ] as const) {
    clearMemo("ALL");
    let mo!: () => void;
    const cong = new Promise<void>((r) => (mo = r));
    // memo() còn `await currentOrganization()` trước khi chụp phiên bản: phải ĐỢI lượt tính vào hẳn hàm rồi mới xoá,
    // không thì lượt xoá chạy trước lượt tính và bài kiểm không đo điều nó nói.
    let daVao!: () => void;
    const vao = new Promise<void>((r) => (daVao = r));
    const p = memo(K2, 60_000, async () => {
      daVao();
      await cong;
      return "dang-chay";
    });
    await vao;
    await withOrganization(ai, async () => clearMemo());
    mo();
    assert.equal(await p, "dang-chay");
    const sau = await memo(K2, 60_000, async () => "tinh-lai");
    assert.equal(sau, luu ? "dang-chay" : "tinh-lai", luu ? "B xoá đệm giữa chừng ⇒ lượt tính của nhà VẪN được lưu" : "nhà xoá đệm giữa chừng ⇒ kết quả bị vứt như cũ");
  }

  // 6. khoá giữ-cũ (#1025) của nhà: B ghi ⇒ vẫn TƯƠI (không làm mới); nhà ghi ⇒ CŨ (trả số cũ + làm mới phía sau).
  const KG = "mos:giucu:x";
  registerStaleOnWrite(["mos:giucu:"]);
  clearMemo("ALL");
  let goi = 0;
  const fn = async () => {
    goi += 1;
    return `v${goi}`;
  };
  assert.equal(await memo(KG, 60_000, fn), "v1");
  await withOrganization(B, async () => clearMemo());
  assert.equal(await memo(KG, 60_000, fn), "v1");
  assert.equal(goi, 1, "B ghi ⇒ khoá giữ-cũ của nhà không bị đánh dấu cũ, không lượt làm mới nào");
  await withOrganization(homeCode, async () => clearMemo());
  assert.equal(await memo(KG, 60_000, fn), "v1", "nhà ghi ⇒ khoá giữ-cũ trả số CŨ ngay (#1025)");
  for (let i = 0; i < 100 && goi < 2; i += 1) await new Promise((r) => setTimeout(r, 5));
  assert.equal(goi, 2, "…và làm mới phía sau đúng một lần");

  // Ghi vào CSDL NỀN TẢNG (mọi tổ chức đọc) phải xoá TẤT CẢ tường minh.
  assert.match(readFileSync("lib/platform/publish.ts", "utf8"), /clearMemo\("ALL"\)/, "xuất bản tổ chức ghi CSDL nền tảng ⇒ clearMemo(\"ALL\")");

  clearMemo("ALL");
  console.log("  ✓ Đệm theo tổ chức: B ghi không xoá đệm nhà (và ngược lại) · không ngữ cảnh ⇒ xoá tất cả · audit() ở B chỉ xoá B · lượt tính của nhà sống qua lượt xoá của B · khoá giữ-cũ chỉ cũ khi chính tổ chức nó ghi · xuất bản ⇒ ALL");
}
