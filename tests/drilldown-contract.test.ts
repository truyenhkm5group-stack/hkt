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

  // Mỗi <MetricCard> phải nằm trong một <Link>. Bắt cặp bằng cách quét lần lượt.
  const cards = src.split("<MetricCard").length - 1;
  assert.ok(cards >= 8, `bảng điều khiển phải có ít nhất 8 chỉ số, đếm được ${cards}`);

  // Đường dẫn có thể là chuỗi mẫu chứa ${...} nên KHÔNG được cấm dấu ngoặc nhọn; chỉ chặn
  // xuống dòng để mỗi lần khớp đúng một thẻ.
  const linkBlocks = [...src.matchAll(/<Link href=(.*?)\s+className="block">\s*<MetricCard/g)];
  assert.equal(linkBlocks.length, cards, `có ${cards} thẻ chỉ số nhưng chỉ ${linkBlocks.length} thẻ bấm được — chỉ số không kiểm chứng được thì mất giá trị ra quyết định`);

  for (const m of linkBlocks) {
    const href = cleanHref(m[1]);
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

  for (const m of linkBlocks) {
    const route = cleanHref(m[1]).split("?")[0];
    assert.ok(routes.has(route) || route === "/", `đường dẫn drill-down "${route}" không trỏ tới trang nào có thật`);
  }

  console.log(`✓ Hợp đồng drill-down: ${cards}/${cards} chỉ số trên bảng điều khiển đều bấm được, mang đúng kỳ đang xem và trỏ tới trang có thật`);
}
