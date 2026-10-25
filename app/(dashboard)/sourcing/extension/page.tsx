import Link from "next/link";
import { headers } from "next/headers";
import { Download } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { CreateCaptureTokenForm, RevokeCaptureTokenButton } from "@/components/sourcing/capture-token-forms";
import { SectionCard } from "@/components/ui-bits";
import { Button } from "@/components/ui/button";
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
  // Địa chỉ ERP để dán vào tiện ích = gốc của CHÍNH trang người dùng đang mở (proxy đặt x-forwarded-*). Chỉ in ra màn hình, không vào gói.
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = (h.get("x-forwarded-proto") ?? "https").split(",")[0].trim();
  const erpOrigin = host && /^[a-z0-9.-]+(:\d+)?$/i.test(host) ? `${proto === "http" ? "http" : "https"}://${host}` : null;
  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Tìm hàng nguồn"
        title="Tiện ích lưu mẫu từ 1688"
        description="Mở trang sản phẩm trên detail.1688.com, bấm «Lưu mẫu vào ERP» — mẫu, giá theo bậc, giá từng SKU, bảng size và số liệu nhà cung cấp vào kho mẫu, mỗi lần bấm là một lần chụp mới."
      />

      <SectionCard title="Cài tiện ích (một lần cho mỗi máy)" description="Làm lần lượt từng bước. Tiện ích không có trên Chrome Web Store — tải tệp nén ở đây rồi nạp vào Chrome.">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <Button asChild>
            <a href="/api/sourcing/extension" download data-extension-download>
              <Download className="size-4" />
              Tải tiện ích (.zip)
            </a>
          </Button>
          <span className="text-sm text-muted-foreground">Tệp nhỏ (vài chục KB), không chứa token hay địa chỉ ERP — bạn tự dán ở bước 8.</span>
        </div>
        <ol className="list-decimal space-y-2 pl-5 text-sm" data-capture-install-steps>
          <li>
            Bấm nút <b>Tải tiện ích (.zip)</b> ở trên. Tệp <code>VNX-Luu-mau-1688-v….zip</code> về thư mục <b>Tải xuống</b> (Downloads).
          </li>
          <li>
            Mở thư mục Tải xuống, <b>chuột phải</b> vào tệp ⇒ <b>Giải nén tất cả…</b> (Extract All) ⇒ chọn một nơi <b>CỐ ĐỊNH</b>, ví dụ thư mục{" "}
            <b>Tài liệu</b> (Documents) hoặc ổ <b>D:</b> ⇒ bấm <b>Giải nén</b>. Đừng để trong Tải xuống rồi dọn đi: xoá thư mục này là tiện ích mất.
          </li>
          <li>
            Mở Chrome, gõ <code>chrome://extensions</code> vào thanh địa chỉ (chỗ gõ trang web) rồi bấm <b>Enter</b>.
          </li>
          <li>
            Ở góc trên bên phải trang đó, bật công tắc <b>Chế độ dành cho nhà phát triển</b> (Developer mode).
          </li>
          <li>
            Bấm nút <b>Tải tiện ích đã giải nén</b> (Load unpacked) vừa hiện ra ⇒ chọn thư mục <code>VNX-Luu-mau-1688-v…</code> vừa giải nén (thư mục
            có tệp <code>manifest.json</code> bên trong) ⇒ <b>Chọn thư mục</b>. Thấy thẻ «VNX ERP — Lưu mẫu từ 1688» là xong.
          </li>
          <li>
            Bấm biểu tượng <b>mảnh ghép</b> 🧩 cạnh thanh địa chỉ ⇒ bấm <b>ghim</b> 📌 cạnh «VNX ERP — Lưu mẫu từ 1688» để biểu tượng luôn hiện.
          </li>
          <li>
            Ở khung <b>Tạo token cho máy này</b> ngay dưới: đặt tên máy, bấm <b>Tạo token</b>, bấm <b>Chép</b>. Token chỉ hiện MỘT lần.
          </li>
          <li>
            Bấm biểu tượng tiện ích vừa ghim ⇒ trang <b>Cài đặt</b> mở ra ⇒ dán <b>Địa chỉ ERP</b>
            {erpOrigin ? (
              <>
                {" "}
                là <code className="select-all" data-erp-origin>{erpOrigin}</code>
              </>
            ) : (
              <> (phần <code>https://…</code> đầu thanh địa chỉ của trang này, tới trước dấu «/» đầu tiên)</>
            )}{" "}
            và dán <b>Token</b> vừa chép ⇒ bấm <b>Lưu</b> ⇒ Chrome hỏi quyền gửi tới địa chỉ ERP ⇒ bấm <b>Cho phép</b>.
          </li>
          <li>
            Trên 1688, đặt ngôn ngữ về <b>简体中文</b> (nút ngôn ngữ / tiền tệ ở đầu trang 1688). Khi đặt tiếng Việt, CHÍNH 1688 dịch dữ liệu ở máy
            chủ của họ — «M (khuyến nghị 90 ~ 100 kg)» thật ra là 90–100 斤 = 45–50 kg — nên ERP vẫn lưu giá nhưng không đọc bảng size. Muốn đọc
            tiếng Việt thì dùng «Dịch trang» của Chrome: nó chỉ đổi chữ hiển thị, không đổi dữ liệu tiện ích đọc.
          </li>
          <li>
            Mở <b>trang chi tiết của một sản phẩm</b> — địa chỉ dạng <code>detail.1688.com/offer/…html</code> — ⇒ nút đỏ <b>Lưu mẫu vào ERP</b> ở
            góc <b>dưới bên phải</b>.
          </li>
        </ol>
        <p className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-700 dark:bg-amber-950/40" data-extension-where>
          <b>Không thấy nút?</b> Nút CHỈ hiện trên trang chi tiết sản phẩm (<code>detail.1688.com/offer/…</code>) — KHÔNG hiện ở trang tìm kiếm, trang
          chủ 1688 hay trang shop. Bấm vào một sản phẩm để mở trang chi tiết của nó. Đã mở đúng trang mà vẫn không thấy: tải lại trang (F5); ở{" "}
          <code>chrome://extensions</code> kiểm tra tiện ích đang BẬT.
        </p>
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
