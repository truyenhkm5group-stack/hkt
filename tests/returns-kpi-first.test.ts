import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { clearMemo } from "@/lib/cache";
import { setSettingJson } from "@/lib/settings";
import { choKpiHoacTran, KPI_FIRST_CAP_MS, KPI_FIRST_FLAG_TTL_MS, KPI_FIRST_SETTING_KEY, kpiFirstEnabled, loadReturnsPage, returnsPageParams } from "@/lib/queries/returns-report-page";

/*
  ═══ /reports/returns: KPI KHỞI CHẠY TRƯỚC (hướng B, 25/10/2026) ═══

  Khoá ba điều:
    1. cổng mở khi KPI xong, hoặc ở trần — và KPI LỖI không được chặn các khối khác;
    2. bật hay tắt cờ, trang ra ĐÚNG cùng một dữ liệu (chỉ đổi THỨ TỰ khởi chạy, không đổi lời gọi / tham số / khoá đệm);
    3. ở mức mã nguồn: mọi nhánh nặng của `startReturnsPage` đi qua cổng `sau(…)`, còn KPI + hai danh mục của thanh lọc
       khởi chạy ngay — thêm một nhánh mới mà quên cổng thì nó lại chen hàng với KPI.
*/

const cho = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function testReturnsKpiFirstPure() {
  assert.ok(Number.isInteger(KPI_FIRST_CAP_MS) && KPI_FIRST_CAP_MS > 0 && KPI_FIRST_CAP_MS <= 2_000, "trần là một số ms dương, ngắn (thân tổng chịu tối đa ngần ấy)");

  // KPI nhanh hơn trần ⇒ mở theo KPI.
  let t = Date.now();
  await choKpiHoacTran(cho(20), 2_000);
  assert.ok(Date.now() - t < 1_000, "KPI xong trước trần ⇒ mở ngay khi KPI xong, không đợi đủ trần");

  // KPI chậm hơn trần ⇒ mở ở trần.
  t = Date.now();
  await choKpiHoacTran(cho(5_000), 30);
  assert.ok(Date.now() - t < 1_000, "KPI chậm ⇒ mở ở trần, không bắt các khối khác đợi KPI");

  // KPI lỗi ⇒ vẫn mở (và không ném): lỗi của thẻ KPI đi đường của chính nó, không được chặn cả trang.
  t = Date.now();
  await choKpiHoacTran(Promise.reject(new Error("thử")), 2_000);
  assert.ok(Date.now() - t < 1_000, "KPI lỗi ⇒ mở ngay");

  // Mã nguồn: nhánh nào đi qua cổng, nhánh nào khởi chạy ngay.
  const src = readFileSync("lib/queries/returns-report-page.ts", "utf8");
  const dau = src.indexOf("export function startReturnsPage(");
  const than = src.slice(dau, src.indexOf("\n}\n", dau));
  for (const ham of ["getReturnRateByVariant", "getReturnRateBySource", "logisticsPerformance", "getReturnRateByTier", "listOrdersForVariant", "listReturnSummaryOrders", "getReturnReasonReport"]) {
    const goi = [...than.matchAll(new RegExp(`\\b${ham}\\(`, "g"))];
    assert.ok(goi.length > 0, `${ham}: phải còn được gọi trong startReturnsPage`);
    // `startReturnsPage` là hàm ĐỒNG BỘ: một `await` trước lời gọi chỉ có thể nằm trong callback chạy SAU một lời hứa đã qua
    // cổng (kỳ trước của bảng nguyên nhân, trong `reasonP.then`) — nên nó cũng đứng sau cổng.
    for (const g of goi) {
      const truoc = than.slice(Math.max(0, (g.index ?? 0) - 12), g.index);
      assert.ok(truoc.includes("sau(() =>") || truoc.includes("await "), `${ham}: phải khởi chạy qua cổng sau(…) — nếu không nó chen hàng với KPI`);
    }
  }
  for (const ham of ["getReturnRateSummary", "listProductCodes", "listAttributedMarketers"]) {
    const g = new RegExp(`const \\w+ = ${ham}\\(`).exec(than);
    assert.ok(g, `${ham}: khởi chạy NGAY (thân trang chờ nó)`);
  }
  console.log(`  ✓ KPI khởi chạy trước: cổng mở theo KPI / theo trần ${KPI_FIRST_CAP_MS} ms / khi KPI lỗi · 7 nhánh nặng qua cổng, KPI + 2 danh mục khởi chạy ngay`);
}

/** Bật hay tắt cờ, `loadReturnsPage` (đường job giữ ấm + trang) ra ĐÚNG cùng một dữ liệu. */
export async function testReturnsKpiFirstDb() {
  const thamSo = returnsPageParams({});
  const chup = async (bat: boolean) => {
    await setSettingJson(KPI_FIRST_SETTING_KEY, { on: bat });
    clearMemo();
    return JSON.parse(JSON.stringify(await loadReturnsPage(thamSo)));
  };
  try {
    const tat = await chup(false);
    const bat = await chup(true);
    assert.equal(await kpiFirstEnabled(), true, "lượt bật thật sự đi nhánh bật — nếu không phép so dưới so hai lượt TẮT");
    // So NGUYÊN KHỐI: đủ 17 trường của loadReturnsPage (bảng mẫu mã · tóm tắt · nguồn đơn · lý do · intel · bậc giá · nguyên nhân …).
    assert.deepEqual(Object.keys(bat).sort(), Object.keys(tat).sort());
    assert.deepEqual(bat, tat, "bật cờ KPI-trước chỉ đổi THỨ TỰ khởi chạy — dữ liệu trang phải y hệt");

    // Cờ hỏng ⇒ TẮT: chuỗi trần, số, mảng, object thiếu `on` / `on` không phải true.
    for (const hong of ["true", 1, [true], {}, { on: "true" }, { on: 1 }]) {
      await setSettingJson(KPI_FIRST_SETTING_KEY, hong);
      clearMemo();
      assert.equal(await kpiFirstEnabled(), false, `cờ ${JSON.stringify(hong)} ⇒ TẮT`);
    }
    assert.ok(KPI_FIRST_FLAG_TTL_MS > 0 && KPI_FIRST_FLAG_TTL_MS <= 60_000, "TTL cờ ngắn — người đo phải chờ đủ TTL sau set-setting");
  } finally {
    await setSettingJson(KPI_FIRST_SETTING_KEY, { on: false });
    clearMemo();
  }
  console.log(`  ✓ KPI khởi chạy trước: bật / tắt cờ ⇒ loadReturnsPage ra cùng một dữ liệu (mọi khối, mọi số) · cờ hỏng ⇒ TẮT · đệm cờ ${KPI_FIRST_FLAG_TTL_MS / 1000} s`);
}
