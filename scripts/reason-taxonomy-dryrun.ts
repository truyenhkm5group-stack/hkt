/**
 * ═══════════ CHẠY THỬ ĐỔI CÁCH XẾP NHÓM LÝ DO HOÀN — CHỈ ĐỌC ═══════════
 *
 * Dựng CẢ HAI cách xếp (`LEGACY` · `EVIDENCE`) trên CÙNG một tập ca bằng ĐÚNG hàm của màn hình
 * (`getReturnReasonReport` với `taxonomy` ép), rồi in:
 *
 *   1. bất biến: tổng ca hoàn TRƯỚC = SAU, và mỗi cách xếp cộng các nhóm + chưa xác định = tổng;
 *   2. bảng TRƯỚC (nhóm cũ) và SAU (nhóm theo chứng cứ, kèm bậc chứng cứ);
 *   3. ma trận chuyển nhóm cũ → nhóm mới;
 *   4. danh sách ca ĐỔI NGHĨA (nhóm mới khác nhóm mà nhóm cũ dịch thẳng sang) — CHỈ mã đơn · khoá
 *      lý do · nguồn · bậc. KHÔNG chữ gốc, không tên, không SĐT (kho mã PUBLIC; kết quả vẫn MÃ HOÁ);
 *   5. số ca "Không liên lạc được" mà chữ ĐVVC thật ra nói "không có nhà" — để chủ shop quyết có
 *      tách sang "Khách vắng nhà" không (đổi luật chữ là một quyết định riêng, không làm ở đây).
 *
 * KHÔNG ghi gì: không `settings`, không quan sát, không backfill. Bật cách xếp mới là MỘT lượt
 * `set-setting returns.reason-taxonomy '{"taxonomy":"EVIDENCE"}'` sau khi chủ shop duyệt bảng này;
 * `'{"taxonomy":"LEGACY"}'` là về số cũ. (Object, không phải chuỗi: set-setting GỘP object.)
 *
 * ops lấy SCRIPT từ main nhưng lib/ từ IMAGE: chạy được sau lượt deploy mang `return-reason-evidence`.
 *
 *   docker exec -e DRYRUN_PERIOD=all erp-app npx tsx --tsconfig tsconfig.json scripts/reason-taxonomy-dryrun.ts
 */
import "dotenv/config";
import { boDau, type ReturnReason } from "@/lib/constants/return-reason";
import { EVIDENCE_TIER_LABEL, EVIDENCE_TIERS, LEGACY_GROUP_TRANSITION, type ReasonGroupKey } from "@/lib/constants/return-reason-evidence";
import type { ReturnReasonGroup } from "@/lib/constants/return-reason";
import { getReasonGrouping } from "@/lib/queries/return-reason-config";
import { getReturnReasonReport, returnedReasonCases, type ReturnReasonReport } from "@/lib/queries/return-reason-report";
import { resolvePeriod } from "@/lib/search-params";

const PERIOD = process.env.DRYRUN_PERIOD ?? "all";
const so = (n: number) => n.toLocaleString("vi-VN");
const pct = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(1)}%` : "—");
/** Trần danh sách ca đổi nghĩa — giữ kết quả dưới trần 125.000 B của kênh ops (mỗi dòng ~70 B). */
const TRAN_DANH_SACH = 800;
const TRAN_MOI_O = 60;

function inBang(ten: string, bc: ReturnReasonReport) {
  console.log(`\n${ten}  (tổng hoàn ${so(bc.returned)})`);
  console.log("nhóm                                   |   ca |  tỷ trọng* | xác nhận | nhân viên | chỉ ĐVVC | mâu thuẫn");
  console.log("---------------------------------------+------+------------+----------+-----------+----------+----------");
  for (const g of bc.groups) {
    if (!g.count) continue;
    const t = g.tiers;
    console.log(
      `${g.label.padEnd(38)} | ${so(g.count).padStart(4)} | ${pct(g.count, bc.reasonCoverage.known).padStart(10)} | ${so(t.HUMAN_CONFIRMED).padStart(8)} | ${so(t.CARE_REPORTED).padStart(9)} | ${so(t.CARRIER_OBSERVED).padStart(8)} | ${so(t.CONFLICTED).padStart(8)}`,
    );
  }
  console.log(`${"Chưa xếp nhóm (không phải một nhóm)".padEnd(38)} | ${so(bc.ungrouped).padStart(4)} |`);
  console.log("* trên ca ĐÃ BIẾT lý do, như màn hình.");
}

async function main() {
  const period = resolvePeriod({ period: PERIOD }, "all");
  const f = { period, basis: "SHIPPED" as const };
  const [truoc, sau, nhomCu, nhomMoi, ca] = await Promise.all([
    getReturnReasonReport({ ...f, taxonomy: "LEGACY" }),
    getReturnReasonReport({ ...f, taxonomy: "EVIDENCE" }),
    getReasonGrouping("LEGACY"),
    getReasonGrouping("EVIDENCE"),
    returnedReasonCases({ ...f, taxonomy: "EVIDENCE" }),
  ]);

  console.log(`── CHẠY THỬ CÁCH XẾP NHÓM LÝ DO HOÀN · kỳ "${PERIOD}" · mốc SHIPPED · CHỈ ĐỌC ──`);

  /* ─── 1 · BẤT BIẾN ─── */
  // «Chưa xếp nhóm» ≠ «lý do UNKNOWN» ở cách xếp theo chứng cứ (giao chậm chưa xác minh) — bất biến đọc `ungrouped`.
  const tongNhom = (bc: ReturnReasonReport) => bc.groups.reduce((n, g) => n + g.count, 0) + bc.ungrouped;
  const loi: string[] = [];
  if (truoc.returned !== sau.returned) loi.push(`tổng hoàn TRƯỚC ${truoc.returned} ≠ SAU ${sau.returned}`);
  if (tongNhom(truoc) !== truoc.returned) loi.push(`TRƯỚC: nhóm + chưa xếp nhóm = ${tongNhom(truoc)} ≠ ${truoc.returned}`);
  if (tongNhom(sau) !== sau.returned) loi.push(`SAU: nhóm + chưa xếp nhóm = ${tongNhom(sau)} ≠ ${sau.returned}`);
  if (ca.length !== sau.returned) loi.push(`tập ca của ma trận ${ca.length} ≠ tổng hoàn ${sau.returned}`);
  console.log(loi.length ? `\n✗ BẤT BIẾN HỎNG: ${loi.join(" · ")}` : `\n✓ Bất biến: tổng hoàn trước = sau = ${so(sau.returned)} · mỗi cách xếp cộng nhóm + chưa xếp nhóm = tổng · ma trận đứng trên đúng ${so(ca.length)} ca`);

  /* ─── 2 · TRƯỚC / SAU ─── */
  inBang("TRƯỚC — nhóm cũ (cờ LEGACY, đang chạy)", truoc);
  inBang("SAU — nhóm theo chứng cứ (cờ EVIDENCE)", sau);
  console.log(`\nBậc chứng cứ trên ${so(sau.returned)} ca hoàn: ${EVIDENCE_TIERS.map((t) => `${EVIDENCE_TIER_LABEL[t]} ${so(sau.evidenceTiers[t])}`).join(" · ")}`);
  for (const n of sau.taxonomyNotes) console.log(`! ${n}`);

  /* ─── 3 · MA TRẬN CHUYỂN ─── */
  const nhanCu = new Map(nhomCu.groups.map((g) => [g.key, g.label]));
  const nhanMoi = new Map(nhomMoi.groups.map((g) => [g.key, g.label]));
  const o = new Map<string, number>();
  type Doi = { cu: ReasonGroupKey | null; moi: ReasonGroupKey | null; orderId: string; reason: ReturnReason; source: string; tier: string };
  const doiNghia: Doi[] = [];
  let khongCoNha = 0;
  for (const c of ca) {
    const v = c.verdict;
    const cu = v ? nhomCu.groupOf(v) : null;
    const moi = v ? nhomMoi.groupOf(v) : null;
    const k = `${cu ?? "-"}→${moi ?? "-"}`;
    o.set(k, (o.get(k) ?? 0) + 1);
    // "Đổi nghĩa" = nhóm mới KHÁC nhóm mà nhóm cũ dịch thẳng sang. Nhóm cũ không có bản dịch
    // (giao lâu · boom) thì mọi ca của nó đều đổi nghĩa — đó đúng là điều cần duyệt.
    const dichThang = cu === null ? null : (LEGACY_GROUP_TRANSITION[cu as ReturnReasonGroup] ?? undefined);
    if (v && (dichThang === undefined || dichThang !== moi)) doiNghia.push({ cu, moi, orderId: c.orderId, reason: v.reason, source: v.source ?? "-", tier: nhomMoi.tierOf(v) });
    if (v && moi === "KHONG_LIEN_LAC" && boDau(v.rawReason).includes("khong co nha")) khongCoNha += 1;
  }
  console.log("\nMA TRẬN CHUYỂN (nhóm cũ → nhóm mới : số ca)");
  for (const [k, n] of [...o].sort((a, b) => b[1] - a[1])) {
    const [cu, moi] = k.split("→");
    console.log(`  ${(nhanCu.get(cu as ReasonGroupKey) ?? "Chưa xác định").padEnd(18)} → ${(nhanMoi.get(moi as ReasonGroupKey) ?? "Chưa xác định").padEnd(38)} : ${so(n)}`);
  }

  /* ─── 4 · CA ĐỔI NGHĨA ─── */
  console.log(`\nCA ĐỔI NGHĨA: ${so(doiNghia.length)} / ${so(ca.length)} — in tối đa ${TRAN_MOI_O} ca mỗi ô, tổng tối đa ${TRAN_DANH_SACH} dòng (mã đơn · lý do · nguồn · bậc)`);
  const daIn = new Map<string, number>();
  let dong = 0;
  for (const d of doiNghia) {
    const k = `${d.cu ?? "-"}→${d.moi ?? "-"}`;
    if ((daIn.get(k) ?? 0) >= TRAN_MOI_O || dong >= TRAN_DANH_SACH) continue;
    daIn.set(k, (daIn.get(k) ?? 0) + 1);
    dong += 1;
    console.log(`  ${d.orderId} · ${d.cu ?? "-"}→${d.moi ?? "-"} · ${d.reason} · ${d.source} · ${d.tier}`);
  }
  if (dong < doiNghia.length) console.log(`  … còn ${so(doiNghia.length - dong)} ca không in (đã đếm trong ma trận).`);

  /* ─── 5 · VẮNG NHÀ NẰM TRONG "KHÔNG LIÊN LẠC" ─── */
  const kll = sau.groups.find((g) => g.group === "KHONG_LIEN_LAC")?.count ?? 0;
  console.log(`\nVẮNG NHÀ: ${so(khongCoNha)} / ${so(kll)} ca "Không liên lạc được" có chữ ĐVVC "không có nhà" — luật chữ hiện xếp câu ấy vào CUSTOMER_UNREACHABLE. Tách sang "Khách vắng nhà" là quyết định riêng của chủ shop.`);

  const tom = sau.groups
    .filter((g) => g.count)
    .sort((a, b) => b.count - a.count)
    .slice(0, 6)
    .map((g) => `${g.label} ${so(g.count)}`)
    .join(" · ");
  console.log(
    `[ops:tom-tat] reason-taxonomy-dryrun kỳ ${PERIOD}: ${loi.length ? "BẤT BIẾN HỎNG" : "bất biến OK"} · hoàn ${so(sau.returned)} · đổi nghĩa ${so(doiNghia.length)} · mâu thuẫn ${so(sau.evidenceTiers.CONFLICTED)} · xác nhận ${so(sau.evidenceTiers.HUMAN_CONFIRMED)} · nhân viên ${so(sau.evidenceTiers.CARE_REPORTED)} · chỉ ĐVVC ${so(sau.evidenceTiers.CARRIER_OBSERVED)} · vắng nhà trong KLL ${so(khongCoNha)}/${so(kll)} · top: ${tom}`,
  );
  process.exit(loi.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
