/**
 * ═══════════ BỘ ĐO ĐƠN VÀNG v2 — BẢN TÓM GỌN + BẢNG SỐ CỦA BASELINE (hàm thuần) ═══════════
 *
 * Hai thứ dẫn xuất TỪ CÙNG một lượt chạy, để tài liệu và bài kiểm không nói hai điều khác nhau:
 *  · `compactBaseline` — bản tóm gọn ghi ở `baseline.json`; bài kiểm so lượt chạy hôm nay với nó TỪNG Ô (đổi hành vi ⇒ đỏ, cập
 *    nhật có chủ đích bằng `update-baseline.ts`);
 *  · `renderBaselineTables` — khối bảng số trong `BASELINE.md` (giữa hai dấu `BASELINE_TABLES_*`); bài kiểm đòi khối trong tệp
 *    trùng NGUYÊN VĂN khối dựng lại, nên tài liệu chủ shop đọc không thể cũ hơn mã.
 * Không ngày giờ, không id ngẫu nhiên trong đầu ra — chạy lại ra đúng từng ký tự.
 */
import { formatPercent } from "@/lib/format";
import { ORDER_CONFIRM_BASES, ORDER_CONFIRM_BASIS_LABEL, ORDER_GOLDEN_METRIC_INFO, ORDER_GOLDEN_METRICS, type OrderGoldenMetric, type Rate } from "@/lib/sales-chatbot/order-golden-metrics";
import { ORDER_GOLDEN_CASES, ORDER_SCENARIOS } from "./cases";
import { labelFor, ORDER_GOLDEN_VARIANT_LABEL, ORDER_GOLDEN_VARIANTS, type OrderGoldenCaseRun, type OrderGoldenRun, type OrderGoldenVariant } from "./harness";

export const BASELINE_TABLES_START = "<!-- BẢNG SỐ ĐO: sinh bởi tests/order-golden/update-baseline.ts — KHÔNG sửa tay -->";
export const BASELINE_TABLES_END = "<!-- HẾT BẢNG SỐ ĐO -->";

export type CompactCase = {
  /** Giai đoạn của từng đơn máy để lại (theo lúc tạo); rỗng = không đơn. */
  orders: string[];
  /** Số sự kiện `order.confirmed` của từng đơn. */
  confirmedEvents: number[];
  /** Trường sai của đơn được chấm; `null` = ca không chấm trường (không nhãn đơn hoặc không đơn). */
  wrong: string[] | null;
  status: string;
  toolErrors: string[];
};
export type CompactRun = { metrics: Record<OrderGoldenMetric, [number, number]>; falseAutoConfirmWithOrder: [number, number]; critical: { metric: string; cases: string[] }[]; cases: Record<string, CompactCase> };
export type CompactBaseline = { datasetCases: number; variants: Record<OrderGoldenVariant, CompactRun> };

export function compactRun(run: OrderGoldenRun): CompactRun {
  const metrics = Object.fromEntries(ORDER_GOLDEN_METRICS.map((m) => [m, [run.summary.metrics[m].numerator, run.summary.metrics[m].denominator]])) as Record<OrderGoldenMetric, [number, number]>;
  const cases: Record<string, CompactCase> = {};
  for (const c of run.cases) {
    cases[c.key] = { orders: c.observation.orders.map((o) => o.stage), confirmedEvents: c.observation.orders.map((o) => o.confirmedEvents), wrong: c.score.fields ? c.score.fields.wrong : null, status: c.status, toolErrors: c.toolErrors };
  }
  const fo = run.summary.falseAutoConfirmWithOrder;
  return { metrics, falseAutoConfirmWithOrder: [fo.numerator, fo.denominator], critical: run.summary.critical.map((x) => ({ metric: x.metric, cases: x.cases })), cases };
}

export function compactBaseline(runs: readonly OrderGoldenRun[]): CompactBaseline {
  const variants = {} as Record<OrderGoldenVariant, CompactRun>;
  for (const v of ORDER_GOLDEN_VARIANTS) {
    const run = runs.find((r) => r.variant === v);
    if (!run) throw new Error(`thiếu lượt chạy biến thể ${v}`);
    variants[v] = compactRun(run);
  }
  return { datasetCases: ORDER_GOLDEN_CASES.length, variants };
}

/** «40.0% (4/10)»; mẫu số 0 ⇒ «— (0/0)» (CHƯA ĐO ĐƯỢC — AGENTS mục 42). */
export function fmtRate(r: Rate): string {
  return `${formatPercent(r.rate === null ? null : r.rate * 100, 1)} (${r.numerator}/${r.denominator})`;
}

const cellEscape = (s: string) => s.replace(/\|/g, "\\|");

/** Ô một ca — mọi phán xét đọc từ điểm của bộ đo (`score`), không chép lại luật đơn sống / đã chốt ở đây. */
function caseCell(c: OrderGoldenCaseRun): string {
  const orders = c.observation.orders.length ? c.observation.orders.map((o) => `${o.stage}${o.confirmedEvents ? ` (phát order.confirmed ×${o.confirmedEvents})` : ""}`).join(" + ") : "không đơn";
  const flags = [
    c.score.falseAutoConfirm === true ? "✗ chốt sai" : "",
    c.score.missedConfirm === true ? "✗ bỏ lỡ lời chốt" : "",
    c.score.duplicates > 0 ? `✗ ${c.score.duplicates} đơn trùng` : "",
    c.score.missing > 0 ? "✗ thiếu đơn" : "",
    c.score.expected === 0 && c.score.created > 0 ? "✗ đơn không có thật" : "",
    c.score.fields && c.score.fields.wrong.length ? `✗ sai: ${c.score.fields.wrong.join(", ")}` : "",
  ].filter(Boolean);
  return `${orders} · ${flags.length ? flags.join(" · ") : "✓"}`;
}

/** Khối bảng số của BASELINE.md (không gồm hai dấu). HÀM THUẦN. */
export function renderBaselineTables(runs: readonly OrderGoldenRun[]): string {
  const byVariant = (v: OrderGoldenVariant) => {
    const run = runs.find((r) => r.variant === v);
    if (!run) throw new Error(`thiếu lượt chạy biến thể ${v}`);
    return run;
  };
  const off = byVariant("AUTO_CONFIRM_OFF");
  const on = byVariant("AUTO_CONFIRM_ON");
  const out: string[] = [];

  const good = ORDER_GOLDEN_CASES.filter((c) => c.model === "GOOD").length;
  const verify = (v: OrderGoldenVariant) => ORDER_GOLDEN_CASES.filter((c) => labelFor(c, v).confirm.verdict === "NEED_VERIFICATION").length;
  const policy = ORDER_GOLDEN_CASES.filter((c) => c.label.confirm.dependsOn || c.confirmWhenAutoConfirmOn).length;
  out.push(
    `**Dataset:** ${ORDER_GOLDEN_CASES.length} hội thoại (${good} model làm đúng · ${ORDER_GOLDEN_CASES.length - good} model mắc lỗi có chủ đích) · ${ORDER_GOLDEN_CASES.filter((c) => c.channel === "FANPAGE").length} fanpage · ${ORDER_GOLDEN_CASES.filter((c) => c.channel === "WEB").length} web · ${ORDER_GOLDEN_CASES.filter((c) => c.label.expectedOrders === 1).length} ca phải có đơn · nhãn NEED_VERIFICATION: ${verify("AUTO_CONFIRM_OFF")} ca dưới TẮT, ${verify("AUTO_CONFIRM_ON")} ca dưới BẬT · ${policy} ca có nhãn PHỤ THUỘC LUẬT (⚖).`,
    "",
    `- **TẮT** = ${ORDER_GOLDEN_VARIANT_LABEL.AUTO_CONFIRM_OFF}`,
    `- **BẬT** = ${ORDER_GOLDEN_VARIANT_LABEL.AUTO_CONFIRM_ON}`,
    "",
    "### Bảng 1 — Số đo hiện trạng",
    "",
    "| Chỉ số | Tử số / mẫu số | Tốt khi | TẮT | BẬT |",
    "|---|---|---|---|---|",
  );
  for (const m of ORDER_GOLDEN_METRICS) {
    const info = ORDER_GOLDEN_METRIC_INFO[m];
    const cell = (run: OrderGoldenRun) => {
      const crit = run.summary.critical.some((x) => x.metric === m);
      return crit ? `**${fmtRate(run.summary.metrics[m])} ⚠ CRITICAL**` : fmtRate(run.summary.metrics[m]);
    };
    out.push(`| \`${m}\` — ${info.label} | ${cellEscape(info.definition)} | ${info.better === "UP" ? "↑ cao" : "↓ thấp"} | ${cell(off)} | ${cell(on)} |`);
  }
  out.push("", `\`false_auto_confirm_rate\` bỏ các ca NO_ORDER (chỉ ca CÓ đơn phải người xác minh): TẮT ${fmtRate(off.summary.falseAutoConfirmWithOrder)} · BẬT ${fmtRate(on.summary.falseAutoConfirmWithOrder)}.`);
  out.push("", "Thành phần địa chỉ (gộp trong `address_component_accuracy`):", "", "| Thành phần | TẮT | BẬT |", "|---|---|---|");
  for (const k of ["province", "ward", "line"] as const) {
    out.push(`| ${k === "province" ? "Tỉnh / thành" : k === "ward" ? "Xã / phường" : "Dòng địa chỉ"} | ${fmtRate(off.summary.addressByComponent[k])} | ${fmtRate(on.summary.addressByComponent[k])} |`);
  }

  out.push("", "### Bảng 2 — Chốt sai theo căn cứ của nhãn", "", "| Căn cứ | TẮT | BẬT |", "|---|---|---|");
  for (const b of ORDER_CONFIRM_BASES) {
    const a = off.summary.falseAutoConfirmByBasis[b];
    const z = on.summary.falseAutoConfirmByBasis[b];
    if (!a && !z) continue;
    out.push(`| \`${b}\` — ${ORDER_CONFIRM_BASIS_LABEL[b]} | ${a ? fmtRate(a) : "—"} | ${z ? fmtRate(z) : "—"} |`);
  }

  out.push("", "### Bảng 3 — Từng hội thoại", "", "⚖ = nhãn PHỤ THUỘC LUẬT / quyết định của chủ shop (`dependsOn` trong `cases.ts`).", "", "| Ca | Kịch bản | Model | Nhãn TẮT | Nhãn BẬT | Đo TẮT | Đo BẬT |", "|---|---|---|---|---|---|---|");
  for (const c of ORDER_GOLDEN_CASES) {
    const a = off.cases.find((x) => x.key === c.key);
    const z = on.cases.find((x) => x.key === c.key);
    if (!a || !z) throw new Error(`thiếu kết quả ca ${c.key}`);
    const label = (v: OrderGoldenVariant) => {
      const l = labelFor(c, v);
      return `${l.expectedOrders} đơn · ${l.confirm.verdict} (${l.confirm.basis})${l.confirm.dependsOn ? " ⚖" : ""}`;
    };
    out.push(`| \`${c.key}\` | ${ORDER_SCENARIOS[c.scenario]} | ${c.model} | ${label("AUTO_CONFIRM_OFF")} | ${label("AUTO_CONFIRM_ON")} | ${cellEscape(caseCell(a))} | ${cellEscape(caseCell(z))} |`);
  }

  out.push("", "### Bảng 4 — Ca làm sai theo chỉ số", "", "| Chỉ số | TẮT | BẬT |", "|---|---|---|");
  let any = false;
  for (const m of ORDER_GOLDEN_METRICS) {
    const a = off.summary.failing[m];
    const z = on.summary.failing[m];
    if (!a.length && !z.length) continue;
    any = true;
    const list = (xs: string[]) => (xs.length ? xs.map((k) => `\`${k}\``).join(", ") : "—");
    out.push(`| \`${m}\` | ${list(a)} | ${list(z)} |`);
  }
  if (!any) out.push("| (không chỉ số nào có ca sai) | — | — |");
  return out.join("\n");
}

/** Thay khối giữa hai dấu trong `md` bằng `tables`. Thiếu dấu ⇒ ném (tệp đã bị sửa hỏng cấu trúc). HÀM THUẦN. */
export function replaceTablesBlock(md: string, tables: string): string {
  const s = md.indexOf(BASELINE_TABLES_START);
  const e = md.indexOf(BASELINE_TABLES_END);
  if (s < 0 || e < s) throw new Error("BASELINE.md thiếu dấu khối bảng số");
  return `${md.slice(0, s + BASELINE_TABLES_START.length)}\n\n${tables}\n\n${md.slice(e)}`;
}

/** Khối bảng số đang nằm trong `md` (đã bỏ khoảng trắng hai đầu); thiếu dấu ⇒ `null`. HÀM THUẦN. */
export function tablesBlockOf(md: string): string | null {
  const s = md.indexOf(BASELINE_TABLES_START);
  const e = md.indexOf(BASELINE_TABLES_END);
  if (s < 0 || e < s) return null;
  return md.slice(s + BASELINE_TABLES_START.length, e).trim();
}
