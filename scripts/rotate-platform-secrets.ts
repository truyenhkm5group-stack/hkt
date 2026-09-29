/**
 * XOAY KHOÁ BÍ MẬT KẾT NỐI — `npm run platform:rotate-secrets [-- --apply [--confirm-production]] [-- --org <mã>]`
 *
 * Kế hoạch đầy đủ: docs/platform/launch-gates.md mục A · «Xoay khoá». Tóm tắt:
 *   1. Đặt `PLATFORM_SECRETS_KEY_PREVIOUS` = khoá ĐANG chạy, `PLATFORM_SECRETS_KEY` = khoá MỚI (secret GitHub), deploy.
 *      Từ lúc đó mã hoá bằng khoá mới, bản mã cũ vẫn giải được qua PREVIOUS — không kết nối nào chết.
 *   2. Chạy script này KHÔNG cờ (CHẠY THỬ — không một lượt ghi nào) trong container app, đọc báo cáo.
 *   3. Chạy lại với `--apply --confirm-production`: mã hoá lại mọi dòng mang khoá cũ, ở MỌI tổ chức ACTIVE.
 *   4. Chạy thử lần nữa: `WOULD_REKEY = 0` ở mọi tổ chức, không tổ chức nào bị bỏ qua ⇒ mới được gỡ PREVIOUS.
 *
 * Đọc hai khoá từ môi trường của tiến trình (compose nạp `.env` vào container). KHÔNG in khoá, KHÔNG in bản rõ, KHÔNG
 * in bản mã — chỉ mã connector, phán quyết và 8 ký tự đầu của MÃ khoá. Idempotent: chạy thật lần hai ⇒ mọi dòng
 * `CURRENT`, không byte nào đổi. Giải mã / mã hoá / ghi đều đi qua `rekeyOrgConnections` của
 * `lib/connectors/service.ts` (nơi DUY NHẤT chạm bản mã) — script này chỉ duyệt tổ chức.
 *
 * Tổ chức không ACTIVE (đình chỉ, đang dựng) KHÔNG mở được bằng ngữ cảnh ⇒ báo BỎ QUA và mã thoát ≠ 0: bí mật của nó
 * vẫn sống nhờ PREVIOUS, nên gỡ PREVIOUS trước khi xử lý nó là giết bí mật của nó.
 *
 * Mã thoát: 0 = sạch (chạy thật: không còn gì mang khoá cũ; chạy thử: không có lỗi) · 1 = lỗi chạy · 2 = còn dòng cần
 * người (UNKNOWN_KEY / DECRYPT_FAILED / TRIPWIRE) hoặc tổ chức bị bỏ qua.
 */
import "dotenv/config";
import { rekeyOrgConnections, REKEY_VERDICTS, type RekeyReport, type RekeyVerdict } from "@/lib/connectors/service";
import { secretsKeyPublicStatus, secretsKeyState, SECRETS_KEY_PREVIOUS_ENV, type SecretsKeyState } from "@/lib/connectors/secrets";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations, listOrganizations } from "@/lib/platform/organizations";

export type RotationSummary = {
  apply: boolean;
  reports: RekeyReport[];
  skipped: { orgCode: string; reason: string }[];
  totals: Record<RekeyVerdict, number>;
  /** Được gỡ PREVIOUS chưa: không dòng nào còn mang khoá cũ, không lỗi, không tổ chức bị bỏ qua. */
  previousRemovable: boolean;
  exitCode: 0 | 2;
};

const NEEDS_HUMAN: readonly RekeyVerdict[] = ["UNKNOWN_KEY", "DECRYPT_FAILED", "TRIPWIRE"];

/** Duyệt tổ chức và gọi lõi. `codes` chỉ để bài kiểm giới hạn vào tổ chức của chính nó. */
export async function rotateAllOrganizations(opts: { apply: boolean; keyState?: SecretsKeyState; codes?: readonly string[] }): Promise<RotationSummary> {
  invalidateOrganizations();
  const orgs = (await listOrganizations()).filter((o) => !opts.codes || opts.codes.includes(o.code)).sort((a, b) => a.code.localeCompare(b.code));
  const reports: RekeyReport[] = [];
  const skipped: RotationSummary["skipped"] = [];
  for (const org of orgs) {
    if (org.status !== "ACTIVE") {
      skipped.push({ orgCode: org.code, reason: `tổ chức đang ${org.status} — không mở được bằng ngữ cảnh; giữ ${SECRETS_KEY_PREVIOUS_ENV} tới khi xử lý xong nó` });
      continue;
    }
    try {
      const r = await withOrganization(org.code, () => rekeyOrgConnections({ apply: opts.apply, keyState: opts.keyState }));
      if ("error" in r) skipped.push({ orgCode: org.code, reason: r.error });
      else reports.push(r);
    } catch (e) {
      skipped.push({ orgCode: org.code, reason: e instanceof Error ? e.message.slice(0, 200) : "lỗi không rõ" });
    }
  }
  const totals = Object.fromEntries(REKEY_VERDICTS.map((v) => [v, reports.reduce((s, r) => s + r.counts[v], 0)])) as Record<RekeyVerdict, number>;
  const humans = NEEDS_HUMAN.reduce((s, v) => s + totals[v], 0);
  return {
    apply: opts.apply,
    reports,
    skipped,
    totals,
    previousRemovable: totals.WOULD_REKEY === 0 && humans === 0 && skipped.length === 0,
    exitCode: humans === 0 && skipped.length === 0 ? 0 : 2,
  };
}

async function main() {
  const apply = process.argv.includes("--apply");
  const i = process.argv.indexOf("--org");
  const only = i >= 0 ? process.argv[i + 1] : undefined;
  if (apply && process.env.NODE_ENV === "production" && !process.argv.includes("--confirm-production")) {
    throw new Error("Chạy THẬT trên production ghi lại bản mã của mọi tổ chức: chạy thử trước (bỏ --apply), đọc báo cáo, rồi thêm --confirm-production.");
  }
  const state = secretsKeyState();
  const pub = secretsKeyPublicStatus(state);
  if (!pub.ready) throw new Error(pub.reason);
  console.log(`[xoay-khoá] ${apply ? "CHẠY THẬT" : "CHẠY THỬ — không ghi gì"} · khoá hiện tại ${pub.keyIdShort} · ${SECRETS_KEY_PREVIOUS_ENV}: ${pub.previous === "ready" ? pub.previousKeyIdShort : pub.previous === "invalid" ? "ĐẶT NHƯNG KHÔNG DÙNG ĐƯỢC" : "không đặt"}`);
  if (pub.previous !== "ready") console.log(`[xoay-khoá] Không có ${SECRETS_KEY_PREVIOUS_ENV} dùng được ⇒ không có gì để mã hoá lại; báo cáo dưới chỉ phân loại dòng.`);
  const sum = await rotateAllOrganizations({ apply, keyState: state, codes: only ? [only] : undefined });
  for (const r of sum.reports) {
    const nonZero = REKEY_VERDICTS.filter((v) => r.counts[v] > 0).map((v) => `${v} ${r.counts[v]}`);
    console.log(`  ${r.orgCode}: ${r.rows.length} dòng${nonZero.length ? ` · ${nonZero.join(" · ")}` : ""}`);
    for (const row of r.rows.filter((x) => x.verdict !== "CURRENT" && x.verdict !== "NO_SECRETS")) console.log(`    - ${row.connectorKey}: ${row.verdict} (${row.keyBefore ?? "—"} → ${row.keyAfter ?? "—"})`);
  }
  for (const s of sum.skipped) console.log(`  BỎ QUA ${s.orgCode}: ${s.reason}`);
  console.log(`[xoay-khoá] Tổng: ${REKEY_VERDICTS.map((v) => `${v} ${sum.totals[v]}`).join(" · ")} · bỏ qua ${sum.skipped.length} tổ chức`);
  console.log(`[xoay-khoá] Gỡ ${SECRETS_KEY_PREVIOUS_ENV}: ${sum.previousRemovable ? "ĐƯỢC — không dòng nào còn cần khoá cũ" : "CHƯA — còn dòng mang khoá cũ, dòng cần người, hoặc tổ chức bị bỏ qua"}`);
  process.exitCode = sum.exitCode;
}

if (process.argv[1] && /rotate-platform-secrets\.ts$/.test(process.argv[1])) {
  main().then(
    () => process.exit(process.exitCode ?? 0),
    (e) => {
      console.error(`[xoay-khoá] LỖI: ${e instanceof Error ? e.message : "không rõ"}`);
      process.exit(1);
    },
  );
}
