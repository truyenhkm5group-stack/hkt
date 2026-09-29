import type { SessionUser } from "@/lib/auth/session";
import { secretsKeyState, selfTestSecrets, SECRETS_KEY_ENV, type SecretsKeyState } from "@/lib/connectors/secrets";
import type { SecretsSelfTestReport } from "@/lib/connectors/types";
import { platformAudit } from "@/lib/platform/audit";
import { getHomeOrganization } from "@/lib/platform/organizations";
import { platformOperatorDenial } from "@/lib/platform-ui/module-toggle";

/**
 * ═══════════ «TỰ KIỂM KHOÁ BÍ MẬT» — LÕI CỦA NÚT Ở /platform (cổng mở bán A) ═══════════
 *
 * Trả lời "khoá `PLATFORM_SECRETS_KEY` trên production có DÙNG ĐƯỢC không" mà KHÔNG cần tổ chức thứ hai (chưa có, và
 * không được tạo khi chưa có yêu cầu): mọi phép thử chạy TRONG BỘ NHỚ trên tổ chức GIẢ (`selfTestSecrets`), không đọc,
 * không ghi `org_connections`. Lượt ghi DUY NHẤT là một dòng `platform_audit_log` (`SECRETS_SELF_TEST`) — ai bấm, lúc
 * nào, kết quả, mã khoá rút gọn — để "hôm deploy khoá, ai đã kiểm và thấy gì" có câu trả lời.
 *
 * Chỉ người vận hành nền tảng (tổ chức nhà + `platform:operate`). Không in giá trị nào: kết quả chỉ có tên phép thử.
 * Nhật ký hỏng ⇒ vẫn trả kết quả (lượt tự kiểm không đổi gì cần hoàn lại) nhưng nói rõ là KHÔNG có vết.
 */
export async function runSecretsSelfTest(user: SessionUser, deps: { keyState?: SecretsKeyState } = {}): Promise<(SecretsSelfTestReport & { audited: boolean }) | { error: string }> {
  const denial = platformOperatorDenial(user);
  if (denial) return { error: denial };
  const report = selfTestSecrets(deps.keyState ?? secretsKeyState());
  let audited = true;
  try {
    const home = await getHomeOrganization();
    await platformAudit({
      action: "SECRETS_SELF_TEST",
      targetOrgCode: home.code,
      subject: SECRETS_KEY_ENV,
      after: { ok: report.ok, keyIdShort: report.keyIdShort, previous: report.previous, failed: report.checks.filter((c) => !c.ok).map((c) => c.name), checks: report.checks.length },
      source: "UI",
      actor: { orgCode: user.organization!.code, userId: user.id, email: user.email },
    });
  } catch {
    audited = false;
  }
  return { ...report, audited };
}
