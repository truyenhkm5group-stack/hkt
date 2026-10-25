import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { CreateCaptureTokenForm, RevokeCaptureTokenButton } from "@/components/sourcing/capture-token-forms";
import { SectionCard } from "@/components/ui-bits";
import { can, requirePermission } from "@/lib/auth/session";
import { formatDateTime } from "@/lib/format";
import { listCaptureTokens } from "@/lib/sourcing/capture-tokens";

export const metadata = { title: "Tiện ích lưu mẫu 1688" };

/**
 * Tiện ích Chrome «Lưu mẫu vào ERP» (SRC-6): token của từng người + cách cài. Người có `sourcing:approve` thấy và thu hồi được token
 * của mọi người trong tổ chức (máy mất, nhân viên nghỉ); người khác chỉ thấy token của chính mình.
 */
export default async function SourcingExtensionPage() {
  const user = await requirePermission("sourcing:view");
  const canWrite = can(user, "sourcing:write");
  const seeAll = can(user, "sourcing:approve");
  const tokens = await listCaptureTokens(seeAll ? null : user.id);
  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Tìm hàng nguồn"
        title="Tiện ích lưu mẫu từ 1688"
        description="Mở trang sản phẩm trên detail.1688.com, bấm «Lưu mẫu vào ERP» — mẫu, giá theo bậc, giá từng SKU, bảng size và số liệu nhà cung cấp vào kho mẫu, mỗi lần bấm là một lần chụp mới."
      />

      <SectionCard title="Cài tiện ích (một lần cho mỗi máy)" description="Tiện ích không lên Chrome Web Store — cài dạng «unpacked» từ thư mục trong kho mã.">
        <ol className="list-decimal space-y-1.5 pl-5 text-sm" data-capture-install-steps>
          <li>
            Lấy thư mục <code>extensions/sourcing-1688</code> (người vận hành gửi tệp nén, giải nén ra một thư mục cố định — xoá thư mục là
            tiện ích mất).
          </li>
          <li>
            Mở Chrome, gõ <code>chrome://extensions</code> vào thanh địa chỉ, bật <b>Chế độ dành cho nhà phát triển</b> (góc trên bên phải).
          </li>
          <li>
            Bấm <b>Tải tiện ích đã giải nén</b> (Load unpacked) ⇒ chọn thư mục <code>sourcing-1688</code>.
          </li>
          <li>
            Bấm biểu tượng tiện ích ⇒ <b>Cài đặt</b>: dán <b>địa chỉ ERP</b> (phần <code>https://…</code> đầu thanh địa chỉ của chính trang này, tới trước dấu «/» đầu tiên) và <b>token</b> tạo ở dưới, bấm
            «Lưu» — Chrome hỏi quyền gửi tới địa chỉ ERP đó, bấm «Cho phép».
          </li>
          <li>
            Trên 1688, đặt ngôn ngữ về <b>简体中文</b> (nút ngôn ngữ / tiền tệ ở đầu trang). Khi đặt tiếng Việt, CHÍNH 1688 dịch dữ liệu trang
            ở máy chủ của họ — «M (khuyến nghị 90 ~ 100 kg)» thật ra là 90–100 斤 = 45–50 kg — nên ERP vẫn lưu được giá nhưng KHÔNG đọc bảng
            size. Muốn đọc tiếng Việt thì dùng «Dịch trang» của Chrome: nó chỉ đổi chữ hiển thị, không đổi dữ liệu tiện ích đọc.
          </li>
          <li>
            Mở một trang <code>detail.1688.com/offer/…</code> ⇒ nút <b>Lưu mẫu vào ERP</b> ở góc dưới bên phải.
          </li>
        </ol>
        <p className="mt-3 text-sm text-muted-foreground">
          Tiện ích chỉ chạy khi BẠN bấm, chỉ trên trang chi tiết đang mở — không tự quét, không duyệt hàng loạt, không gửi cookie hay tài khoản 1688
          của bạn về ERP. Giá trên thẻ tìm kiếm / giá khách mới (新人价) không được dùng làm giá mua.
        </p>
      </SectionCard>

      {canWrite ? (
        <SectionCard title="Tạo token cho máy này" description="Mỗi máy / trình duyệt một token, tối đa 5 token còn hiệu lực mỗi người. Token chỉ gửi được việc «lưu mẫu» — đúng việc bạn làm được bằng tay.">
          <CreateCaptureTokenForm />
        </SectionCard>
      ) : null}

      <SectionCard title={seeAll ? "Token của tổ chức" : "Token của bạn"} description="ERP chỉ giữ 4 ký tự cuối để bạn nhận ra token; token đầy đủ không bao giờ hiện lại.">
        {tokens === null ? (
          <p className="text-sm text-muted-foreground">CSDL của tổ chức chưa áp migration 0260 — báo người vận hành.</p>
        ) : tokens.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-capture-tokens>
              <thead className="text-left text-xs text-muted-foreground">
                <tr>
                  <th className="py-1 pr-3 font-medium">Tên</th>
                  {seeAll ? <th className="py-1 pr-3 font-medium">Người</th> : null}
                  <th className="py-1 pr-3 font-medium">Đuôi</th>
                  <th className="py-1 pr-3 font-medium">Tạo lúc</th>
                  <th className="py-1 pr-3 font-medium">Dùng lần cuối</th>
                  <th className="py-1 font-medium">Trạng thái</th>
                </tr>
              </thead>
              <tbody>
                {tokens.map((t) => (
                  <tr key={t.id} className="border-t align-top">
                    <td className="py-1.5 pr-3">{t.label}</td>
                    {seeAll ? <td className="py-1.5 pr-3">{t.userName ?? "—"}</td> : null}
                    <td className="py-1.5 pr-3 font-mono text-xs">…{t.hint}</td>
                    <td className="py-1.5 pr-3 whitespace-nowrap">{formatDateTime(t.createdAt)}</td>
                    <td className="py-1.5 pr-3 whitespace-nowrap">{t.lastUsedAt ? formatDateTime(t.lastUsedAt) : "chưa dùng"}</td>
                    <td className="py-1.5">{t.revokedAt ? `Đã thu hồi ${formatDateTime(t.revokedAt)}` : <RevokeCaptureTokenButton tokenId={t.id} />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Chưa có token nào.</p>
        )}
      </SectionCard>

      <p className="text-sm">
        <Link href="/sourcing" className="underline underline-offset-2">
          ← Về Tìm hàng nguồn
        </Link>
      </p>
    </div>
  );
}
