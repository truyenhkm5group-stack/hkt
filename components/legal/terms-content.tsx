import * as React from "react";
import { LegalSection as Section, supportMail as mail, type LegalDocumentContent } from "@/components/legal/legal-blocks";
import { TRIAL_DAYS, TRIAL_GRACE_DAYS, BILLING_DEFAULT_GRACE_DAYS } from "@/lib/billing/rules";
import { COMPANY, PRIVACY_POLICY, SERVICE_COMMITMENTS as C } from "@/lib/constants/company";

/**
 * NỘI DUNG Điều khoản sử dụng đang công bố (`/dieu-khoan-su-dung`) — MỘT nguồn cho HAI nơi đọc:
 *   · trang `app/dieu-khoan-su-dung/page.tsx` dựng đúng cây này (tiêu đề, đoạn mở đầu, các mục);
 *   · `lib/constants/legal-documents.ts::legalContentSha256` băm đúng cây này — sổ chấp thuận (M-ACCEPT) ghi băm của chữ
 *     người đọc THẤY, không phải của một bản chép tay có thể lệch.
 * Tách nguyên văn từ trang ngày 09/10/2026, không đổi một chữ (bài kiểm `tests/legal-registers.test.ts` so HTML trước / sau).
 * Sửa câu chữ ⇒ tăng `TERMS_OF_SERVICE.version` (lib/constants/company.ts) và cập nhật ghim băm trong `LEGAL_DOCUMENTS`.
 * `import * as React`: `tsx` (bài kiểm) dựng JSX theo runtime cổ điển, cần `React` trong phạm vi khi tệp được nạp.
 */
export const TERMS_CONTENT: LegalDocumentContent = {
  title: "Điều khoản sử dụng",
  intro: (
    <p>
      Điều khoản này là thoả thuận giữa {COMPANY.name} («
      <strong>VNXcommerce</strong>», «Nền tảng») và cá nhân, hộ kinh doanh hoặc doanh nghiệp đăng ký sử dụng phần mềm VNXcommerce («
      <strong>Khách thuê</strong>»). Bằng việc tạo cửa hàng hoặc tiếp tục sử dụng, Khách thuê đồng ý với Điều khoản này và{" "}
      <a href={PRIVACY_POLICY.path} className="text-primary underline">
        Chính sách quyền riêng tư
      </a>
      .
    </p>
  ),
  body: (
    <>
      <Section id="cac-ben" title="1. Các bên">
        <ul className="list-disc space-y-1 pl-5">
          <li>
            <strong>Nền tảng:</strong> {COMPANY.name}, mã số thuế {COMPANY.taxCode}, địa chỉ {COMPANY.address}.
          </li>
          <li>
            <strong>Khách thuê:</strong> người tạo cửa hàng (tổ chức) trên phần mềm, do tài khoản quản trị đầu tiên đại diện.
          </li>
          <li>
            <strong>Người dùng:</strong> mọi tài khoản Khách thuê tạo hoặc mời vào cửa hàng. Khách thuê chịu trách nhiệm về thao tác của Người dùng trong cửa
            hàng của mình.
          </li>
        </ul>
      </Section>

      <Section id="dich-vu" title="2. Dịch vụ">
        <ul className="list-disc space-y-1 pl-5">
          <li>
            Phần mềm quản lý bán hàng trực tuyến theo hình thức thuê bao: sản phẩm, đơn hàng, khách hàng, kho, chatbot AI bán hàng và các tính năng khác tuỳ gói
            và module Khách thuê bật.
          </li>
          <li>Dữ liệu của mỗi cửa hàng nằm trong một cơ sở dữ liệu riêng, tách biệt với cửa hàng khác.</li>
          <li>
            Một số tính năng chỉ chạy khi Khách thuê tự kết nối dịch vụ bên thứ ba (Pancake, Facebook, Viettel Post, ngân hàng, nhà cung cấp AI…). Các dịch vụ
            đó theo điều khoản riêng của bên thứ ba; Nền tảng không chịu trách nhiệm khi bên thứ ba ngừng, đổi hoặc giới hạn dịch vụ của họ.
          </li>
        </ul>
      </Section>

      <Section id="tai-khoan" title="3. Tài khoản và bảo mật">
        <ul className="list-disc space-y-1 pl-5">
          <li>Khách thuê cung cấp thông tin đăng ký đúng sự thật và giữ bí mật mật khẩu của các tài khoản trong cửa hàng.</li>
          <li>Khách thuê tự phân quyền cho Người dùng; mọi thao tác quan trọng được ghi nhật ký kèm tài khoản thực hiện.</li>
          <li>Nghi tài khoản bị lộ: đổi mật khẩu ngay trong phần mềm và báo Nền tảng qua {mail}.</li>
          <li>Nền tảng chỉ hỗ trợ khôi phục quyền quản trị sau khi xác minh người yêu cầu là đại diện của Khách thuê.</li>
        </ul>
      </Section>

      <Section id="dung-thu" title="4. Dùng thử miễn phí">
        <ul className="list-disc space-y-1 pl-5">
          <li>
            Cửa hàng tự đăng ký được dùng thử <strong>{TRIAL_DAYS} ngày miễn phí</strong>, tính cả ngày đăng ký, không cần thẻ hay chuyển khoản trước. Phần mềm
            hiện số ngày dùng thử còn lại ở đầu trang.
          </li>
          <li>
            Hết hạn dùng thử mà chưa chọn gói: sau {TRIAL_GRACE_DAYS} ngày ân hạn, cửa hàng chuyển sang chế độ <strong>chỉ xem</strong> — vẫn đăng nhập, xem và
            xuất được dữ liệu, chưa tạo / sửa được. Dữ liệu <strong>không bị xoá</strong>; chọn gói và thanh toán là dùng tiếp ngay.
          </li>
          <li>Thanh toán trong thời gian dùng thử thì kỳ trả tiền bắt đầu sau ngày dùng thử cuối cùng — không mất ngày dùng thử nào.</li>
        </ul>
      </Section>

      <Section id="phi" title="5. Phí dịch vụ và thanh toán">
        <ul className="list-disc space-y-1 pl-5">
          <li>
            Phí theo gói và phần mua thêm Khách thuê chọn, công bố trong phần mềm (Cài đặt → Gói & thanh toán) tại thời điểm thanh toán. Giá công bố là số tiền
            Khách thuê thanh toán.
          </li>
          <li>
            Thanh toán trả trước bằng chuyển khoản theo mã thanh toán phần mềm tạo (mã QR). Thời hạn sử dụng được gia hạn tự động khi khoản tiền khớp mã về tài
            khoản của Nền tảng.
          </li>
          <li>
            Quá hạn thanh toán: sau {BILLING_DEFAULT_GRACE_DAYS} ngày ân hạn (hoặc số ngày ghi trong phần mềm), cửa hàng chuyển sang chế độ chỉ xem cho tới khi
            gia hạn. Quá hạn <strong>không</strong> làm xoá dữ liệu.
          </li>
          <li>
            Hoá đơn: Khách thuê khai thông tin xuất hoá đơn trong Gói & thanh toán; Nền tảng xuất hoá đơn theo quy định pháp luật về thuế cho khoản đã thanh
            toán.
          </li>
          <li>
            Đổi giá gói: thông báo trong phần mềm ít nhất <strong>{C.priceChangeNoticeDays} ngày</strong>; giá mới áp dụng từ lần gia hạn sau ngày thông báo.
            Hoá đơn đã tạo giữ giá cũ.
          </li>
        </ul>
      </Section>

      <Section id="hoan-tien" title="6. Hoàn tiền">
        <ul className="list-disc space-y-1 pl-5">
          <li>
            <strong>Lần thanh toán đầu tiên</strong> của một cửa hàng được <strong>hoàn 100%</strong> nếu Khách thuê yêu cầu trong{" "}
            <strong>{C.firstPaymentRefundDays} ngày</strong> kể từ ngày tiền về, không cần nêu lý do. Gửi yêu cầu tới {mail}, kèm tên cửa hàng và mã thanh toán
            (ERPHD…). Tiền hoàn về đúng tài khoản đã chuyển.
          </li>
          <li>Các lần gia hạn và phần mua thêm sau đó không hoàn cho thời gian đã dùng.</li>
          <li>Nền tảng chấm dứt dịch vụ không do lỗi của Khách thuê: hoàn phần thời gian đã trả mà chưa dùng, tính theo ngày.</li>
        </ul>
      </Section>

      <Section id="du-lieu" title="7. Dữ liệu của Khách thuê">
        <ul className="list-disc space-y-1 pl-5">
          <li>
            Dữ liệu Khách thuê nhập hoặc đồng bộ vào phần mềm (sản phẩm, đơn hàng, khách hàng, hội thoại…) <strong>thuộc về Khách thuê</strong>. Nền tảng chỉ xử
            lý dữ liệu đó để cung cấp dịch vụ, theo Chính sách quyền riêng tư.
          </li>
          <li>
            Với dữ liệu cá nhân của khách hàng của Khách thuê, Khách thuê quyết định mục đích xử lý và chịu trách nhiệm có căn cứ hợp pháp để thu thập và sử
            dụng; Nền tảng xử lý theo chỉ dẫn của Khách thuê.
          </li>
          <li>
            Nền tảng sao lưu dữ liệu hằng ngày và lưu bản sao ngoài máy chủ ở dạng mã hoá. Sao lưu để khôi phục khi có sự cố hệ thống, không thay thế việc Khách
            thuê tự lưu dữ liệu quan trọng (phần mềm có chức năng xuất dữ liệu).
          </li>
          <li>
            Sau khi hết hạn (dùng thử hoặc trả tiền), dữ liệu được giữ ở chế độ chỉ xem <strong>ít nhất {C.retainAfterExpiryDays} ngày</strong>. Sau thời hạn
            đó, Nền tảng chỉ xoá dữ liệu sau khi đã báo trước ít nhất <strong>{C.deletionNoticeDays} ngày</strong> tới email quản trị của cửa hàng. Khách thuê
            có thể yêu cầu xoá sớm hơn theo{" "}
            <a href={`${PRIVACY_POLICY.path}#xoa-du-lieu`} className="text-primary underline">
              mục 9 Chính sách quyền riêng tư
            </a>
            .
          </li>
        </ul>
      </Section>

      <Section id="su-dung-hop-le" title="8. Sử dụng hợp lệ">
        <p>
          Khách thuê không dùng phần mềm để: vi phạm pháp luật; gửi tin nhắn quảng cáo trái quy định hoặc trái chính sách của nền tảng nhắn tin (Facebook,
          Zalo…); bán hàng cấm; thu thập dữ liệu cá nhân trái phép; tìm cách truy cập dữ liệu của cửa hàng khác; tấn công, dò quét hoặc làm quá tải hệ thống;
          bán lại dịch vụ khi chưa có thoả thuận. Vi phạm nghiêm trọng thì Nền tảng có quyền tạm đình chỉ cửa hàng sau khi thông báo, trừ trường hợp khẩn cấp để
          bảo vệ hệ thống hoặc khách hàng khác.
        </p>
      </Section>

      <Section id="ai" title="9. Tính năng AI">
        <ul className="list-disc space-y-1 pl-5">
          <li>
            Chatbot và các tính năng AI tạo câu trả lời tự động dựa trên dữ liệu Khách thuê cung cấp (sản phẩm, giá, tồn kho, chính sách). Câu trả lời có thể
            sai; Khách thuê chịu trách nhiệm kiểm tra cấu hình và theo dõi hội thoại của bot.
          </li>
          <li>
            Mỗi gói có hạn mức AI theo tháng. Hết hạn mức thì bot tạm ngừng trả lời tới kỳ sau hoặc tới khi nâng gói; tin nhắn của khách vẫn về fanpage để nhân
            viên trả lời.
          </li>
        </ul>
      </Section>

      <Section id="trach-nhiem" title="10. Mức độ dịch vụ và giới hạn trách nhiệm">
        <ul className="list-disc space-y-1 pl-5">
          <li>
            Nền tảng nỗ lực duy trì dịch vụ liên tục và thông báo trước các đợt bảo trì có kế hoạch. Nền tảng chưa cam kết một tỷ lệ thời gian hoạt động bằng
            con số.
          </li>
          <li>
            Tổng trách nhiệm bồi thường của Nền tảng đối với mọi thiệt hại phát sinh từ dịch vụ không vượt quá tổng phí Khách thuê đã trả trong 3 tháng gần
            nhất, trừ trường hợp pháp luật quy định khác.
          </li>
          <li>Nền tảng không chịu trách nhiệm về thiệt hại gián tiếp như mất doanh thu, mất cơ hội kinh doanh.</li>
        </ul>
      </Section>

      <Section id="cham-dut" title="11. Chấm dứt">
        <ul className="list-disc space-y-1 pl-5">
          <li>Khách thuê ngừng gia hạn bất kỳ lúc nào; dịch vụ dừng ghi khi hết thời hạn đã trả, dữ liệu xử lý theo mục 7.</li>
          <li>Nền tảng có thể chấm dứt khi Khách thuê vi phạm mục 8 và không khắc phục sau 7 ngày kể từ khi được thông báo.</li>
        </ul>
      </Section>

      <Section id="sua-doi" title="12. Sửa đổi điều khoản">
        <p>
          Nền tảng có thể sửa đổi Điều khoản này và thông báo trong phần mềm ít nhất {C.termsChangeNoticeDays} ngày trước khi áp dụng. Bản mới mang số phiên bản
          và ngày hiệu lực mới trên trang này.
        </p>
      </Section>

      <Section id="luat" title="13. Luật áp dụng và giải quyết tranh chấp">
        <p>
          Điều khoản này theo pháp luật Việt Nam. Tranh chấp được ưu tiên thương lượng; không thương lượng được thì đưa ra Toà án nhân dân có thẩm quyền tại Hà
          Nội.
        </p>
      </Section>

      <Section id="lien-he" title="14. Liên hệ">
        <p>
          {mail} · {COMPANY.phone} · {COMPANY.address}.
        </p>
      </Section>
    </>
  ),
};
