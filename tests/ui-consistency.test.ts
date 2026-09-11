import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { OUTCOME_LABEL, OUTCOME_TONE, type OrderOutcome } from "@/lib/constants/returns";
import { VERIFIED_OUTCOME_LABEL } from "@/lib/constants/data-quality";
import { ORDER_STAGE_LABEL } from "@/lib/constants/pancake";
import { COD_STATUS_LABEL, SHIPMENT_STAGE_LABEL } from "@/lib/constants/viettelpost";
import { TRUTH_DIMENSIONS, TRUTH_DIMENSION_ORDER } from "@/lib/constants/truth";
import { CASE_ACTION, CASE_STATUS_LABEL, CASE_STATUS_TONE, CASE_TYPE_LABEL, PRIORITY_LABEL, type CaseType } from "@/lib/constants/action-queue";
import { VERDICT_LABEL, VERDICT_TONE, type ProductVerdict } from "@/lib/constants/product-verdict";
import { STOCK_RISK_ACTION, STOCK_RISK_LABEL, STOCK_RISK_TONE, type StockRisk } from "@/lib/constants/slow-moving";
import { DIMENSION_LABEL, DIMENSION_TONE, type TimelineDimension } from "@/lib/constants/timeline";
import { CRM_SEGMENT_ACTION, CRM_SEGMENT_LABEL, CRM_SEGMENT_ORDER, CRM_SEGMENT_TONE } from "@/lib/constants/crm";
import { AREA_LABEL, AREA_TONE, CONFIDENCE_LABEL, type RecommendationArea } from "@/lib/constants/recommendation";
import { ADS_ANOMALY_LABEL, type AdsAnomalyKind } from "@/lib/constants/ads-anomaly";
import { ATTRIBUTION_FIELDS } from "@/lib/constants/sales-funnel";
import { orderStageEnum, shipmentStageEnum, codStatusEnum } from "@/db/schema";

/**
 * NHẤT QUÁN GIAO DIỆN.
 *
 * Luật quan trọng nhất của TASK 18: trạng thái đơn / trạng thái vận đơn / trạng thái tiền / kết quả
 * đơn là BỐN CHIỀU KHÁC NHAU và không được trình bày khiến người dùng tưởng là một.
 */

function tsxFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) tsxFiles(full, acc);
    else if (entry.name.endsWith(".tsx")) acc.push(full);
  }
  return acc;
}

export function testUiConsistency() {
  // ───────── 1. Mọi giá trị của mọi chiều đều có nhãn tiếng Việt ─────────
  for (const stage of orderStageEnum.enumValues) assert.ok(ORDER_STAGE_LABEL[stage], `thiếu nhãn trạng thái đơn ${stage}`);
  for (const stage of shipmentStageEnum.enumValues) assert.ok(SHIPMENT_STAGE_LABEL[stage], `thiếu nhãn trạng thái vận đơn ${stage}`);
  for (const status of codStatusEnum.enumValues) assert.ok(COD_STATUS_LABEL[status], `thiếu nhãn trạng thái tiền ${status}`);
  for (const outcome of Object.keys(OUTCOME_LABEL) as OrderOutcome[]) {
    assert.ok(OUTCOME_LABEL[outcome] && OUTCOME_TONE[outcome], `thiếu nhãn/màu kết quả đơn ${outcome}`);
  }
  assert.ok(VERIFIED_OUTCOME_LABEL.UNVERIFIED.includes("Chưa xác minh"), "trạng thái chưa xác minh phải nói rõ là CHƯA BIẾT");
  // CHƯA BIẾT phải đọc ra là "chưa có chứng từ", không được lẫn với "chưa gửi" hay "đang giao".
  // Ba thứ này khác nhau về nghiệp vụ, và người dùng phải phân biệt được chỉ bằng cách đọc nhãn.
  assert.ok(OUTCOME_LABEL.UNKNOWN.includes("chứng từ"), "nhãn CHƯA BIẾT phải nói rõ là thiếu chứng từ ĐVVC");
  assert.notEqual(OUTCOME_LABEL.UNKNOWN, OUTCOME_LABEL.NOT_SHIPPED, "chưa có chứng từ KHÁC chưa gửi");
  assert.notEqual(OUTCOME_LABEL.UNKNOWN, OUTCOME_LABEL.IN_TRANSIT, "chưa có chứng từ KHÁC đang giao");
  assert.notEqual(OUTCOME_TONE.UNKNOWN, OUTCOME_TONE.IN_TRANSIT, "hai trạng thái khác nghĩa phải khác màu");

  // ───────── 2. Bốn chiều phải phân biệt được TRÊN GIAO DIỆN ─────────
  const badge = readFileSync("components/status-badge.tsx", "utf8");
  for (const dimension of ["order_status", "shipment_status", "payment_status", "shipment_outcome"] as const) {
    assert.ok(badge.includes(`"${dimension}"`), `nhãn trạng thái phải nói rõ nó thuộc chiều ${dimension}`);
  }
  for (const name of ["OrderStageBadge", "ShipmentStageBadge", "CodStatusBadge", "OrderOutcomeBadge", "VerifiedOutcomeBadge"]) {
    assert.ok(badge.includes(`export function ${name}`), `phải có một thành phần dùng chung cho ${name}`);
  }
  assert.ok(badge.includes("DimensionMark"), "mỗi nhãn phải mang dấu hiệu chiều để không đọc nhầm bốn chiều thành một");
  assert.ok(badge.includes("dimensionTitle"), "tooltip phải nói nguồn sự thật và điều cấm suy ra");
  for (const key of TRUTH_DIMENSION_ORDER) {
    assert.ok(TRUTH_DIMENSIONS[key].label.length > 3, `${key} phải có nhãn hiển thị được`);
  }

  // ───────── 3. KHÔNG trang nào tự vẽ lại nhãn kết quả đơn ─────────
  // Vẽ tay thì mỗi trang một kiểu, và người dùng mất luôn dấu hiệu phân biệt chiều.
  const offenders: string[] = [];
  for (const file of tsxFiles("app").concat(tsxFiles("components"))) {
    const rel = file.split(path.sep).join("/");
    if (rel.endsWith("components/status-badge.tsx")) continue;
    const src = readFileSync(file, "utf8");
    if (/OUTCOME_TONE\s*\[/.test(src)) offenders.push(rel);
  }
  assert.deepEqual(offenders, [], `phải dùng <OrderOutcomeBadge/>, không tự vẽ nhãn kết quả đơn: ${offenders.join(", ")}`);

  // ───────── 4. MỌI DANH MỤC MỚI phải đủ nhãn tiếng Việt, đủ màu, và nói được nên làm gì ─────────
  // Thiếu một khoá thì giao diện hiện mã thô kiểu "RETURN_RECEIVED_PENDING_INSPECTION" — người vận
  // hành không đọc được, và cái nhãn đó lập tức trở thành vô dụng.
  let newLabels = 0;
  for (const t of Object.keys(CASE_TYPE_LABEL) as CaseType[]) {
    assert.ok(CASE_TYPE_LABEL[t]?.length > 3, `thiếu nhãn loại việc ${t}`);
    assert.ok(CASE_ACTION[t]?.length > 10, `${t}: phải nói NÊN LÀM GÌ, không chỉ đặt tên vấn đề`);
    newLabels += 1;
  }
  for (const st of Object.keys(CASE_STATUS_LABEL) as (keyof typeof CASE_STATUS_LABEL)[]) {
    assert.ok(CASE_STATUS_LABEL[st]?.length > 2 && CASE_STATUS_TONE[st], `thiếu nhãn/màu trạng thái việc ${st}`);
    newLabels += 1;
  }
  for (const v of Object.keys(VERDICT_LABEL) as ProductVerdict[]) {
    assert.ok(VERDICT_LABEL[v]?.length > 3 && VERDICT_TONE[v], `thiếu nhãn/màu phân loại mẫu mã ${v}`);
    newLabels += 1;
  }
  for (const r of Object.keys(STOCK_RISK_LABEL) as StockRisk[]) {
    assert.ok(STOCK_RISK_LABEL[r]?.length > 3 && STOCK_RISK_TONE[r] && STOCK_RISK_ACTION[r]?.length > 10, `thiếu nhãn/màu/hành động rủi ro tồn ${r}`);
    newLabels += 1;
  }
  for (const d of Object.keys(DIMENSION_LABEL) as TimelineDimension[]) {
    assert.ok(DIMENSION_LABEL[d]?.length > 2 && DIMENSION_TONE[d], `thiếu nhãn/màu chiều dòng thời gian ${d}`);
    newLabels += 1;
  }
  for (const a of Object.keys(AREA_LABEL) as RecommendationArea[]) {
    assert.ok(AREA_LABEL[a]?.length > 2 && AREA_TONE[a], `thiếu nhãn/màu lĩnh vực khuyến nghị ${a}`);
    newLabels += 1;
  }
  for (const k of Object.keys(ADS_ANOMALY_LABEL) as AdsAnomalyKind[]) {
    assert.ok(ADS_ANOMALY_LABEL[k]?.length > 5, `thiếu nhãn bất thường quảng cáo ${k}`);
    newLabels += 1;
  }
  for (const f of ATTRIBUTION_FIELDS) {
    assert.ok(f.label.length > 3 && f.note.length > 5, `${f.field}: vai phải có nhãn và nói rõ dùng cho việc gì`);
    newLabels += 1;
  }
  for (const seg of CRM_SEGMENT_ORDER) {
    assert.ok(CRM_SEGMENT_LABEL[seg]?.length > 3 && CRM_SEGMENT_TONE[seg], `thiếu nhãn/màu phân khúc khách ${seg}`);
    assert.ok(CRM_SEGMENT_ACTION[seg]?.length > 20, `${seg}: phải nói NÊN LÀM GÌ với nhóm khách này`);
    newLabels += 1;
  }
  for (const c of Object.values(CONFIDENCE_LABEL)) assert.ok(c.length > 5, "mức tin cậy phải đọc được bằng tiếng Việt");
  for (const p of Object.values(PRIORITY_LABEL)) assert.ok(p.length > 2, "mức ưu tiên phải đọc được bằng tiếng Việt");

  // Không nhãn nào được lẫn với nhãn khác trong CÙNG một danh mục — trùng nhãn thì người dùng
  // không phân biệt được hai trạng thái khác nghĩa.
  for (const [name, values] of [
    ["trạng thái việc", Object.values(CASE_STATUS_LABEL)],
    ["phân loại mẫu mã", Object.values(VERDICT_LABEL)],
    ["rủi ro tồn kho", Object.values(STOCK_RISK_LABEL)],
    ["chiều dòng thời gian", Object.values(DIMENSION_LABEL)],
    ["phân khúc khách", Object.values(CRM_SEGMENT_LABEL)],
  ] as const) {
    assert.equal(new Set(values).size, values.length, `${name}: có hai giá trị dùng chung một nhãn`);
  }

  // ───────── 5. Mọi trang mới phải có trạng thái RỖNG và bảng phải cuộn ngang được ─────────
  // Bảng rộng không bọc trong khung cuộn sẽ đẩy cả trang trượt ngang trên điện thoại.
  const newPages = [
    "app/(dashboard)/reports/funnel/page.tsx",
    "app/(dashboard)/products/performance/page.tsx",
    "app/(dashboard)/inventory/planning/slow-moving-section.tsx",
    "app/(dashboard)/inventory/purchasing/page.tsx",
    "app/(dashboard)/customers/retention/page.tsx",
    "app/(dashboard)/reports/scenario/page.tsx",
  ];
  // Trang đầy đủ phải nói rõ VÌ SAO trống; mảnh ghép nhúng trong trang khác thì không cần.
  const khongCanTrangThaiRong = ["app/(dashboard)/inventory/planning/slow-moving-section.tsx"];
  for (const page of newPages) {
    const src = readFileSync(page, "utf8");
    assert.ok(src.includes("overflow-x-auto"), `${page}: bảng phải nằm trong khung cuộn ngang`);
    if (khongCanTrangThaiRong.includes(page)) continue;
    assert.ok(/Chưa có|Không có/.test(src), `${page}: phải có trạng thái rỗng nói rõ vì sao trống`);
  }

  console.log(
    `✓ Nhất quán giao diện: ${orderStageEnum.enumValues.length + shipmentStageEnum.enumValues.length + codStatusEnum.enumValues.length + Object.keys(OUTCOME_LABEL).length} trạng thái + ${newLabels} danh mục mới đều có nhãn tiếng Việt · bốn chiều mang dấu hiệu riêng · không trang nào tự vẽ lại nhãn kết quả đơn · trang mới có trạng thái rỗng và bảng cuộn được`,
  );
}

/**
 * MỌI TRANG ĐÃ LÀM XONG PHẢI CÓ LỐI VÀO TỪ MENU.
 *
 * Sự cố thật 09/09/2026: ba trang đã hoàn chỉnh — Mua hàng & xưởng, Giữ chân khách, Mô phỏng kịch
 * bản — nằm trong kho suốt nhưng **không có dòng nào trong menu**. Người dùng chỉ vào được nếu tình
 * cờ bấm một nút trên trang khác, hoặc gõ tay đường dẫn. Một tính năng không có lối vào thì với
 * người dùng nó không tồn tại, và công sức làm ra nó bằng không.
 *
 * Bài kiểm này so DANH SÁCH ROUTE THẬT trong `app/(dashboard)` với danh sách `href` trong menu.
 * Route động (`[id]`) và trang chi tiết cố ý không vào menu — vào được từ danh sách cha.
 */
export function testNavigationCoverage() {
  const sidebar = readFileSync("components/app-sidebar.tsx", "utf8");
  const linked = new Set([...sidebar.matchAll(/href:\s*"([^"]+)"/g)].map((m) => m[1]));

  /** Trang CỐ Ý không có trong menu, kèm lý do — thêm vào đây phải nêu được vì sao. */
  const INTENTIONALLY_UNLINKED: Record<string, string> = {
    "/settings/profile": "vào từ menu người dùng ở góc dưới, không phải điều hướng chính",
    "/inventory/planning/orders": "danh sách con của Kế hoạch SX, vào từ chính trang đó",
    "/inventory/planning/orders/new": "hành động tạo mới, không phải một mục menu",
    "/customers/retention": "vào từ nút 'Giữ chân khách' ngay trên trang Khách hàng, và từ ô lệnh ⌘K",
    "/inventory/purchasing": "vào từ nút 'Mua hàng & xưởng' ngay trên trang Kế hoạch SX, và từ ô lệnh ⌘K",
    "/import-vtp": "vào từ nút 'Bổ sung danh sách vận đơn' ngay trên trang Đối soát COD, và từ ô lệnh ⌘K",
  };

  const pages = walkPages("app/(dashboard)");
  const missing: string[] = [];
  for (const route of pages) {
    if (route.includes("[")) continue; // trang chi tiết: vào từ danh sách cha
    if (linked.has(route) || route in INTENTIONALLY_UNLINKED) continue;
    missing.push(route);
  }

  assert.deepEqual(
    missing,
    [],
    `những trang này đã làm xong nhưng KHÔNG có lối vào từ menu — với người dùng chúng không tồn tại: ${missing.join(", ")}`,
  );

  // Chiều ngược lại cũng phải đúng: menu không được trỏ tới trang không có thật.
  const routeSet = new Set(pages);
  for (const href of linked) {
    const path = href.split("?")[0];
    assert.ok(routeSet.has(path), `menu trỏ tới ${href} nhưng không có trang nào ở đó — bấm vào là 404`);
  }

  console.log(`✓ Điều hướng: ${pages.length} trang, ${linked.size} mục menu, 0 trang bị bỏ quên, 0 mục menu trỏ vào chỗ trống`);
}

/** Liệt kê mọi route có `page.tsx` dưới một thư mục, trả về đường dẫn URL (bỏ nhóm `(...)`). */
function walkPages(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, url: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const seg = entry.name.startsWith("(") && entry.name.endsWith(")") ? "" : `/${entry.name}`;
        walk(`${d}/${entry.name}`, url + seg);
      } else if (entry.name === "page.tsx") {
        out.push(url || "/");
      }
    }
  };
  walk(dir, "");
  return out.sort();
}
