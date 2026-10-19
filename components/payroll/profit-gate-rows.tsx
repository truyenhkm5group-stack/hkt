import { InfoHint } from "@/components/info-hint";
import { Money } from "@/components/ui-bits";
import { MISSING_TEXT } from "@/lib/format";

/**
 * Dòng "thưởng % lợi nhuận chưa đủ điều kiện" trên phiếu lương — dùng CHUNG cho phiếu lương quản trị
 * (`/payroll/payslip`) và phiếu người lao động tự xác nhận (`/my-payslip`), để hai tờ phiếu không bao
 * giờ in hai số thực nhận khác nhau.
 *
 * Phần thưởng tạm tính KHÔNG được duyệt trả (cổng lỗ lũy kế toàn công ty / trần quỹ) in thành một
 * dòng trừ kèm lý do, để các dòng cộng ra đúng số thực nhận và người nhận biết vì sao. Ảnh chụp đời cũ
 * (không có `profitShare`) không in dòng nào — không đoán.
 */
export function ProfitGateRows({ share }: { share: { provisional: number | null; eligible: number | null; withheld: number | null; reasons: string[]; claims: { key: string; provisional: number | null }[] } | undefined }) {
  if (!share || !share.claims.length) return null;
  return (
    <>
      <CodeBonusRow claims={share.claims} />
      <GateRow share={share} />
    </>
  );
}

/** Khoá khoản thưởng theo mã: `${nhân sự}:CODE:${mã}:${vai trò}:${đoạn}` (`lib/payroll/code-ledger.ts`). */
const laKhoanTheoMa = (key: string) => key.includes(":CODE:");

/**
 * THƯỞNG THEO MÃ (Payroll V2) không nằm trong thành phần nào của chính sách lương, nên phải có dòng
 * RIÊNG — thiếu nó thì các dòng của phiếu cộng ra thiếu đúng khoản ấy mà "Thực nhận" lại gồm nó.
 */
function CodeBonusRow({ claims }: { claims: { key: string; provisional: number | null }[] }) {
  const ma = claims.filter((c) => laKhoanTheoMa(c.key));
  if (!ma.length) return null;
  const tong = ma.some((c) => c.provisional === null) ? null : ma.reduce((t, c) => t + (c.provisional ?? 0), 0);
  return (
    <tr className="border-b">
      <td className="py-1.5 pr-3">
        <span className="inline-flex items-center gap-1">
          Thưởng theo mã (OWNER / SUPPORT) — tạm tính
          <InfoHint>{ma.length} khoản theo mã sản phẩm. Phần được duyệt sau cổng lỗ lũy kế công ty nằm ở dòng bên dưới.</InfoHint>
        </span>
      </td>
      <td className="py-1.5 text-right tabular-nums">{tong === null ? <span className="text-muted-foreground">{MISSING_TEXT}</span> : <Money value={tong} sign />}</td>
    </tr>
  );
}

function GateRow({ share }: { share: { provisional: number | null; eligible: number | null; reasons: string[] } }) {
  if (share.eligible === null) {
    return (
      <tr className="border-b">
        <td className="py-1.5 pr-3">
          <span className="inline-flex items-center gap-1">
            Thưởng % lợi nhuận — chưa xét được điều kiện toàn công ty
            {share.reasons.length ? <InfoHint>{share.reasons.join(" ")}</InfoHint> : null}
          </span>
        </td>
        <td className="py-1.5 text-right tabular-nums text-muted-foreground">{MISSING_TEXT}</td>
      </tr>
    );
  }
  /*
    MỘT dòng chênh CÓ DẤU = đủ điều kiện − tạm tính, để các dòng luôn cộng ra đúng số thực nhận — kể cả
    khi một khoản bị giữ lại còn khoản kia vượt tạm tính (chứng từ muộn dương).
  */
  const chenh = share.provisional === null ? 0 : share.eligible - share.provisional;
  if (chenh === 0) return null;
  if (chenh > 0) {
    return (
      <tr className="border-b">
        <td className="py-1.5 pr-3">
          <span className="inline-flex items-center gap-1">
            Thưởng % lợi nhuận đủ điều kiện vượt số tạm tính
            <InfoHint>Lợi nhuận đem xét của tháng gồm chứng từ đến muộn của tháng đã khoá trước đó, nên phần đủ điều kiện lớn hơn số tạm tính theo lợi nhuận riêng của tháng.</InfoHint>
          </span>
        </td>
        <td className="py-1.5 text-right tabular-nums">
          <Money value={chenh} sign />
        </td>
      </tr>
    );
  }
  return (
    <tr className="border-b">
      <td className="py-1.5 pr-3">
        <span className="inline-flex items-center gap-1">
          Thưởng % lợi nhuận chưa đủ điều kiện (không trả)
          {share.reasons.length ? <InfoHint>{share.reasons.join(" ")}</InfoHint> : null}
        </span>
      </td>
      <td className="py-1.5 text-right tabular-nums text-rose-700 dark:text-rose-400">
        <Money value={chenh} sign />
      </td>
    </tr>
  );
}
