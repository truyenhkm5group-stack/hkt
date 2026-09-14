import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import path from "node:path";

/**
 * ───────────── HỢP ĐỒNG DRILL-DOWN ─────────────
 *
 * Mỗi con số trên bảng điều khiển phải BẤM ĐƯỢC và mở đúng TẬP DỮ LIỆU đã sinh ra nó.
 *
 * Hai cách làm sai mà bài kiểm thử này chặn:
 *  1. Thẻ chỉ số KHÔNG bấm được — chủ shop thấy con số lạ mà không có cách nào kiểm chứng, và
 *     con số đó lập tức mất giá trị ra quyết định.
 *  2. Bấm vào mở một trang KHÔNG mang theo kỳ đang xem — thẻ nói về tháng 9, trang mở ra nói về
 *     30 ngày gần nhất, hai tập đơn khác nhau. Đây là kiểu sai tệ nhất vì trông vẫn hợp lý.
 *
 * Kiểm ở mức MÃ NGUỒN vì đây là ràng buộc về cấu trúc trang, không phải về số liệu.
 */

const DASHBOARD = "app/(dashboard)/page.tsx";

/** Bóc `{`...`}` / `{"..."}` / `"..."` để lấy đường dẫn thô. */
function cleanHref(raw: string): string {
  return raw
    .trim()
    .replace(/^\{/, "")
    .replace(/\}$/, "")
    .trim()
    .replace(/^`|`$/g, "")
    .replace(/^"|"$/g, "");
}

/** Trang không có bộ lọc kỳ — mở ra là toàn bộ trạng thái hiện tại, nên KHÔNG cần mang kỳ theo. */
const PERIODLESS = ["/alerts", "/data-quality", "/inventory/planning", "/integrations", "/products"];

export function testDrilldownContract() {
  const src = readFileSync(DASHBOARD, "utf8");

  /*
    CHỈ SỐ TRÊN BẢNG ĐIỀU KHIỂN NẰM Ở HAI HÌNH DẠNG, VÀ CẢ HAI ĐỀU PHẢI BẤM ĐƯỢC.

    Chỉ số dẫn dắt là `<MetricCard>`; chỉ số theo dõi gom trong một `<StatStrip items={[…]}>`.
    Trước đây mỗi thẻ được bọc thủ công trong `<Link className="block">`, và bài kiểm này dò đúng
    cái vỏ bọc đó. Nay chính thành phần nhận `href` (nhờ vậy thẻ mới có viền tiêu điểm bàn phím —
    thứ mà cái vỏ `<Link>` cũ không có), nên bài kiểm dò `href` thay vì dò vỏ bọc.

    Điều được bảo đảm KHÔNG đổi, và chặt hơn một bậc: mọi chỉ số — kể cả chỉ số nằm trong dải —
    đều phải có đường dẫn, mang đúng kỳ đang xem và trỏ tới trang có thật.
  */
  const cardBlocks = src.split("<MetricCard").slice(1);
  const cardHrefs = cardBlocks.map((block) => {
    // Cắt tại chỗ đóng thẻ để không vợ nhầm href của thẻ đứng sau.
    const body = block.split("/>")[0];
    const m = body.match(/href=\{?[`"]([^`"]+)[`"]\}?/);
    return { href: m?.[1] ?? null, label: body.match(/label="([^"]*)"/)?.[1] ?? "(không nhãn)" };
  });
  for (const c of cardHrefs) {
    assert.ok(c.href, `thẻ chỉ số "${c.label}" không bấm được — chỉ số không kiểm chứng được thì mất giá trị ra quyết định`);
  }

  /*
    Dải chỉ số phụ: mỗi mục có `label:` thì phải có `href:` đi kèm.
    Đếm theo SỐ LƯỢNG hai khoá trong thân `<StatStrip …/>` thay vì cắt từng mục bằng thụt lề —
    thụt lề đổi theo lần định dạng lại mã, còn số lượng khoá thì không.
  */
  const stripHrefs: string[] = [];
  for (const block of src.split("<StatStrip").slice(1)) {
    const body = block.split(/^\s*\/>/m)[0];
    const nhan = [...body.matchAll(/\blabel:\s*[`"]([^`"]*)[`"]/g)].map((m) => m[1]);
    const duongDan = [...body.matchAll(/\bhref:\s*[`"]([^`"]+)[`"]/g)].map((m) => m[1]);
    assert.equal(
      duongDan.length,
      nhan.length,
      `dải chỉ số có ${nhan.length} ô (${nhan.join(", ")}) nhưng chỉ ${duongDan.length} ô bấm được — gom vào dải không phải là lý do để mất lối kiểm chứng`,
    );
    stripHrefs.push(...duongDan);
  }

  const hrefs = [...cardHrefs.map((c) => c.href!), ...stripHrefs];
  const cards = hrefs.length;
  assert.ok(cards >= 8, `bảng điều khiển phải có ít nhất 8 chỉ số, đếm được ${cards}`);

  for (const href of hrefs) {
    assert.ok(href.startsWith("/"), `đường dẫn drill-down phải là đường dẫn nội bộ: ${href}`);
    const route = href.split("?")[0];
    // Trang có bộ lọc kỳ thì PHẢI mang kỳ đang xem sang, nếu không thẻ và trang nói về hai tập
    // đơn khác nhau.
    if (!PERIODLESS.some((p) => route === p || route.startsWith(`${p}/`))) {
      assert.ok(href.includes("period="), `"${href}" mở một trang có bộ lọc kỳ nhưng KHÔNG mang kỳ đang xem theo`);
    }
  }

  // Mọi đường dẫn phải trỏ tới một trang có thật.
  const routes = new Set<string>();
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith("(") || entry.name.startsWith("_")) {
        walk(path.join(dir, entry.name), prefix);
        continue;
      }
      const seg = entry.name.startsWith("[") ? ":param" : entry.name;
      const next = `${prefix}/${seg}`;
      routes.add(next);
      walk(path.join(dir, entry.name), next);
    }
  };
  walk("app", "");
  routes.add("/");

  for (const href of hrefs) {
    const route = cleanHref(href).split("?")[0];
    assert.ok(routes.has(route) || route === "/", `đường dẫn drill-down "${route}" không trỏ tới trang nào có thật`);
  }

  console.log(`✓ Hợp đồng drill-down: ${cards}/${cards} chỉ số trên bảng điều khiển đều bấm được, mang đúng kỳ đang xem và trỏ tới trang có thật`);
}
