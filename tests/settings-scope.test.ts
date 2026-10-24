/**
 * Khử trùng lượt đọc cấu hình trong một lượt dựng (OD-UX-05 mục 3, 24/10/2026). Đo production: getBusinessBrief nguội 74–92 %
 * là chờ kết nối, câu `settings where key = $1` ×6 tốn 3,5–4,9 s (xếp hàng). Khoá:
 *  · trong withSettingsScope cùng khoá chỉ chạm CSDL một lần (sửa thẳng dòng giữa chừng không lộ vào phạm vi);
 *  · ghi (setSettingJson) trong cùng phạm vi ⇒ lượt đọc sau thấy giá trị MỚI;
 *  · lồng nhau dùng chung phạm vi ngoài; hai phạm vi song song KHÔNG thấy của nhau; ngoài phạm vi y như trước (không TTL);
 *  · getBusinessBrief và getDashboardData chạy trong phạm vi.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { eq, inArray } from "drizzle-orm";
import type { Db } from "@/db";
import { schema } from "@/db";
import { getSettingJson, setSettingJson, withSettingsScope } from "@/lib/settings";

export async function testSettingsScope(db: Db) {
  const K = "test-scope:a";
  const K2 = "test-scope:b";
  const sua = (key: string, v: number) => db.update(schema.settings).set({ value: JSON.stringify({ v }) }).where(eq(schema.settings.key, key));
  const doc = (key: string) => getSettingJson<{ v: number }>(key, { v: -1 });
  try {
    await setSettingJson(K, { v: 1 });
    await setSettingJson(K2, { v: 10 });

    // Cùng khoá trong phạm vi: một lượt chạm CSDL — sửa thẳng dòng giữa chừng không lộ vào phạm vi.
    const trong = await withSettingsScope(async () => {
      const a = await doc(K);
      await sua(K, 2);
      const b = await doc(K);
      // Lồng nhau: dùng chung phạm vi ngoài.
      const c = await withSettingsScope(() => doc(K));
      return [a.v, b.v, c.v];
    });
    assert.deepEqual(trong, [1, 1, 1], "cùng khoá trong một lượt dựng ⇒ một lần đọc, lồng nhau dùng chung");
    assert.equal((await doc(K)).v, 2, "ngoài phạm vi ⇒ đọc thẳng CSDL, không TTL");

    // Ghi rồi đọc lại trong CÙNG phạm vi ⇒ giá trị mới.
    const sauGhi = await withSettingsScope(async () => {
      await doc(K);
      await setSettingJson(K, { v: 3 });
      return (await doc(K)).v;
    });
    assert.equal(sauGhi, 3, "ghi trong phạm vi ⇒ lượt đọc sau thấy giá trị MỚI");

    // Hai phạm vi song song không thấy của nhau.
    let mo: () => void = () => {};
    const cho = new Promise<void>((r) => (mo = r));
    let aDaDoc: () => void = () => {};
    const daDoc = new Promise<void>((r) => (aDaDoc = r));
    const pA = withSettingsScope(async () => {
      const x = await doc(K2);
      aDaDoc();
      await cho;
      return [x.v, (await doc(K2)).v];
    });
    const pB = withSettingsScope(async () => {
      await daDoc; // A đã đọc xong lượt đầu ⇒ sửa dòng SAU đó, không đua.
      await sua(K2, 20);
      const y = (await doc(K2)).v;
      mo();
      return y;
    });
    const [a, b] = await Promise.all([pA, pB]);
    assert.deepEqual(a, [10, 10], "phạm vi A giữ số nó đã đọc");
    assert.equal(b, 20, "phạm vi B đọc riêng — không đi nhờ phạm vi A");

    // Khoá chưa có dòng ⇒ mặc định, như trước.
    assert.deepEqual(await withSettingsScope(() => doc("test-scope:chua-co")), { v: -1 });
  } finally {
    await db.delete(schema.settings).where(inArray(schema.settings.key, [K, K2]));
  }

  // Hai báo cáo trang chủ chạy trong phạm vi.
  const brief = readFileSync("lib/queries/business-brief.ts", "utf8");
  const dash = readFileSync("lib/queries/dashboard.ts", "utf8");
  assert.match(brief, /memo\(`businessBrief:\$\{periodKey\(period\)\}`, 600_000, \(\) => withSettingsScope\(\(\) => buildBusinessBrief\(period\)\)\)/);
  assert.match(dash, /memo\(`getDashboardData:\$\{periodKey\(period\)\}`, 300_000, \(\) => withSettingsScope\(\(\) => getDashboardDataUncached\(period\)\)\)/);
  /*
    OD-UX-05 mục 3b (perf-probe 24/10/2026 «ĐỌC CẤU HÌNH TRONG TỪNG HÀM»): trang chủ chỉ lặp 1 khoá (6 lượt / 5 khoá), còn
    getReconCenter 202 lượt / 10 khoá · getMyWork 17 / 11 · getPayrollReport 15 / 7 · getAdsPerformance & getMarketerReport 11 / 6.
  */
  const goc = (f: string) => readFileSync(f, "utf8");
  assert.match(goc("lib/queries/payroll-recon-center.ts"), /memo\(`payroll-recon-center:\$\{fromMonth\}:\$\{toMonth\}`, 120_000, \(\) => withSettingsScope\(async \(\) => \{/, "getReconCenter tính trong phạm vi");
  assert.match(goc("lib/queries/payroll.ts"), /return withSettingsScope\(\(\) => getPayrollReportInScope\(period, basis, gateMode\)\);/, "getPayrollReport tính trong phạm vi");
  assert.match(goc("lib/queries/payroll.ts"), /\(\) => withSettingsScope\(\(\) => getMarketerReportUncached\(period, basis\)\)/, "getMarketerReport tính trong phạm vi");
  assert.match(goc("lib/queries/ads-performance.ts"), /\(\) => withSettingsScope\(\(\) => getAdsPerformanceUncached\(period\)\)/, "getAdsPerformance tính trong phạm vi");
  assert.match(goc("lib/queries/work-adapters.ts"), /return withSettingsScope\(\(\) => collectWorkItemsInScope\(opts\)\);/, "collectWorkItems (getMyWork · /work) gom trong phạm vi");
  // Khoá phạm vi mang mã tổ chức — hai tổ chức không đọc lẫn cấu hình.
  assert.match(readFileSync("lib/settings.ts", "utf8"), /\(await currentOrganization\(\)\)\.code\}:\$\{key\}/);
  console.log("✓ Khử trùng đọc cấu hình theo lượt dựng (OD-UX-05 3): cùng khoá một lần · ghi trong phạm vi ⇒ đọc lại thấy mới · lồng nhau dùng chung · hai phạm vi song song tách biệt · ngoài phạm vi không TTL · trang chủ + đối soát lương + bảng lương + /ads + /work chạy trong phạm vi");
}
