import * as React from "react";
import { LegalSection as Section, LegalTable as Table, supportMail as mail, type LegalDocumentContent } from "@/components/legal/legal-blocks";
import { COMPANY, SERVICE_COMMITMENTS, TERMS_OF_SERVICE } from "@/lib/constants/company";

/**
 * NỘI DUNG Chính sách quyền riêng tư đang công bố (`/chinh-sach-bao-mat`) — MỘT nguồn cho HAI nơi đọc:
 *   · trang `app/chinh-sach-bao-mat/page.tsx` dựng đúng cây này (tiêu đề, đoạn mở đầu, các mục);
 *   · `lib/constants/legal-documents.ts::legalContentSha256` băm đúng cây này.
 * Tách nguyên văn từ trang ngày 09/10/2026, không đổi một chữ (bài kiểm `tests/legal-registers.test.ts` so HTML trước / sau).
 * Sửa câu chữ ⇒ tăng `PRIVACY_POLICY.version` (lib/constants/company.ts) và cập nhật ghim băm trong `LEGAL_DOCUMENTS`.
 * Mỗi câu cam kết phải là điều hệ thống ĐANG làm được (docs/legal/README.md).
 * `import * as React`: `tsx` (bài kiểm) dựng JSX theo runtime cổ điển, cần `React` trong phạm vi khi tệp được nạp.
 */
export const PRIVACY_CONTENT: LegalDocumentContent = {
  title: "Chính sách quyền riêng tư",
  intro: (
    <p>
      Chính sách này giải thích cách {COMPANY.name} («<strong>VNXcommerce</strong>», «chúng tôi») thu thập, sử dụng, lưu trữ
      và bảo vệ dữ liệu cá nhân khi bạn dùng phần mềm quản lý bán hàng VNXcommerce tại <strong>vnxcommerce.com</strong> và{" "}
      <strong>erp.vnxcommerce.com</strong> («Nền tảng»).
    </p>
  ),
  body: (
    <>
      <Section id="ve-chung-toi" title="1. Về chúng tôi">
        <ul className="list-disc space-y-1 pl-5">
          <li>Tên doanh nghiệp: {COMPANY.name}</li>
          <li>Mã số thuế: {COMPANY.taxCode}</li>
          <li>Địa chỉ: {COMPANY.address}</li>
          <li>
            Email: {mail} · Điện thoại: <a href={`tel:${COMPANY.phoneHref}`} className="font-medium text-primary underline">{COMPANY.phone}</a>
          </li>
        </ul>
      </Section>

      <Section id="pham-vi" title="2. Hai nhóm dữ liệu, hai vai trò">
        <Table
          head={["Nhóm dữ liệu", "Ví dụ", "Vai trò của VNXcommerce"]}
          rows={[
            [<strong key="a">A. Dữ liệu của Khách thuê và Người dùng</strong>, "Họ tên, email, số điện thoại người đăng ký; tài khoản nhân viên; nhật ký đăng nhập, địa chỉ IP; thông tin thanh toán phí thuê bao", "Bên kiểm soát và xử lý dữ liệu"],
            [<strong key="b">B. Dữ liệu khách hàng của Khách thuê</strong>, "Tên, số điện thoại, địa chỉ giao hàng, lịch sử mua, hội thoại với chatbot / fanpage, công nợ, lịch hẹn", "Bên xử lý dữ liệu, theo chỉ dẫn của Khách thuê"],
          ]}
        />
        <p>
          «Khách thuê» là doanh nghiệp / cửa hàng đăng ký dùng Nền tảng; «Người dùng» là người đăng nhập vào tài khoản của Khách
          thuê. Với nhóm B, Khách thuê quyết định thu thập gì và dùng vào việc gì, và phải có căn cứ hợp pháp (ví dụ sự đồng ý
          của khách hàng) trước khi đưa dữ liệu vào phần mềm.
        </p>
      </Section>

      <Section id="dang-nhap" title="3. Đăng nhập bằng Google hoặc Facebook">
        <p>
          Khi bạn chọn «Tiếp tục với Google» hoặc «Tiếp tục với Facebook», chúng tôi chỉ nhận từ nhà cung cấp: <strong>mã định danh
          tài khoản</strong>, <strong>họ tên</strong> và <strong>địa chỉ email đã xác minh</strong>. Chúng tôi dùng các thông tin này
          duy nhất để tạo tài khoản, nhận ra bạn ở lần đăng nhập sau và liên hệ về dịch vụ.
        </p>
        <ul className="list-disc space-y-1 pl-5">
          <li>Chúng tôi <strong>không</strong> đăng bài, không đọc danh sách bạn bè, tin nhắn cá nhân hay bất kỳ dữ liệu nào khác trong tài khoản Google / Facebook của bạn.</li>
          <li>Chúng tôi không nhận và không lưu mật khẩu Google / Facebook của bạn.</li>
          <li>
            Việc sử dụng thông tin nhận từ API của Google tuân thủ{" "}
            <a href="https://developers.google.com/terms/api-services-user-data-policy" className="text-primary underline" rel="noopener noreferrer" target="_blank">
              Chính sách dữ liệu người dùng của Dịch vụ API Google
            </a>
            , bao gồm các yêu cầu Sử dụng giới hạn (Limited Use).
          </li>
          <li>Bạn có thể gỡ quyền của VNXcommerce bất kỳ lúc nào trong phần cài đặt bảo mật của tài khoản Google / Facebook.</li>
        </ul>
      </Section>

      <Section id="muc-dich" title="4. Mục đích sử dụng">
        <ul className="list-disc space-y-1 pl-5">
          <li>Nhóm A: tạo và quản lý tài khoản; xác thực đăng nhập; chống truy cập trái phép (ví dụ chặn dò mật khẩu theo địa chỉ IP); thu phí thuê bao và đối chiếu chuyển khoản; hỗ trợ kỹ thuật; thông báo về dịch vụ.</li>
          <li>
            Nhóm B: chỉ để thực hiện các tính năng Khách thuê dùng — lưu đơn, giao hàng, nhắc mua lại, trả lời khách qua chatbot,
            báo cáo. Chúng tôi <strong>không</strong> dùng dữ liệu nhóm B cho mục đích riêng, <strong>không bán</strong>, không
            chia sẻ cho tổ chức khác trên Nền tảng.
          </li>
        </ul>
      </Section>

      <Section id="bao-ve" title="5. Lưu trữ và bảo vệ">
        <ul className="list-disc space-y-1 pl-5">
          <li>Máy chủ đặt tại trung tâm dữ liệu của VNPT (Tập đoàn Bưu chính Viễn thông Việt Nam) tại Việt Nam.</li>
          <li>Mỗi Khách thuê có cơ sở dữ liệu riêng; phần mềm chặn truy cập chéo giữa các tổ chức ở nhiều lớp và có kiểm thử tự động cho việc đó.</li>
          <li>Mật khẩu chỉ lưu dạng băm; liên kết mời và liên kết đặt lại mật khẩu chỉ lưu dạng băm, dùng một lần, có hạn.</li>
          <li>Thông tin kết nối dịch vụ bên thứ ba (khoá API, token) được mã hoá trong cơ sở dữ liệu.</li>
          <li>Mọi thao tác quan trọng được ghi nhật ký kèm tài khoản thực hiện.</li>
          <li>Sao lưu định kỳ trên máy chủ và bản sao ngoài máy chủ (Google Drive) ở dạng <strong>đã mã hoá</strong> — bên lưu trữ chỉ thấy dữ liệu mã hoá.</li>
        </ul>
      </Section>

      <Section id="ben-thu-ba" title="6. Bên thứ ba xử lý dữ liệu">
        <Table
          head={["Bên thứ ba", "Dữ liệu đi qua", "Khi nào"]}
          rows={[
            ["VNPT (máy chủ tại Việt Nam)", "Toàn bộ dữ liệu (lưu trữ)", "Luôn luôn"],
            ["Google Drive (Google LLC)", "Bản sao lưu đã mã hoá", "Luôn luôn"],
            ["Google (Gemini) hoặc nhà cung cấp mô hình AI khác do Khách thuê chọn", "Nội dung hội thoại, thông tin sản phẩm cần để trả lời", "Khi bật chatbot / tính năng AI"],
            ["Google, Facebook (đăng nhập)", "Mã định danh, họ tên, email (mục 3)", "Khi bạn chọn đăng nhập bằng Google / Facebook"],
            ["Pancake, Facebook (fanpage)", "Hội thoại, đơn hàng của fanpage", "Khi Khách thuê kết nối"],
            ["Viettel Post", "Thông tin giao hàng của đơn", "Khi Khách thuê kết nối"],
            ["Ngân hàng / dịch vụ đối soát chuyển khoản (SePay)", "Nội dung và số tiền giao dịch", "Khi đối soát thanh toán"],
          ]}
        />
        <p>Ngoài các bên trên, chúng tôi chỉ cung cấp dữ liệu khi cơ quan nhà nước có thẩm quyền yêu cầu theo quy định của pháp luật.</p>
      </Section>

      <Section id="thoi-gian-luu" title="7. Thời gian lưu">
        <ul className="list-disc space-y-1 pl-5">
          <li>Trong thời gian sử dụng: dữ liệu được giữ cho tới khi Khách thuê xoá.</li>
          <li>
            Khi ngừng thuê hoặc quá hạn thanh toán: dữ liệu <strong>không bị xoá tự động</strong> — tài khoản chuyển sang chế độ chỉ
            xem để Khách thuê xuất dữ liệu hoặc quay lại, ít nhất {SERVICE_COMMITMENTS.retainAfterExpiryDays} ngày; sau đó chúng tôi chỉ xoá sau khi báo
            trước {SERVICE_COMMITMENTS.deletionNoticeDays} ngày tới email quản trị (
            <a href={`${TERMS_OF_SERVICE.path}#du-lieu`} className="text-primary underline">
              Điều khoản sử dụng, mục 7
            </a>
            ). Khách thuê yêu cầu xoá vĩnh viễn sớm hơn theo mục 9.
          </li>
          <li>Bản sao lưu tự hết hạn theo lịch xoay vòng: bản hằng ngày giữ 7 ngày, bản hằng tuần giữ 4 tuần.</li>
          <li>Chứng từ thanh toán phí thuê bao được lưu theo thời hạn pháp luật về kế toán, thuế quy định.</li>
        </ul>
      </Section>

      <Section id="quyen" title="8. Quyền của bạn">
        <p>
          Người dùng (nhóm A) có quyền được biết, xem, sửa, yêu cầu xoá dữ liệu của mình, rút lại sự đồng ý và khiếu nại — liên hệ
          theo mục 11. Khách hàng của Khách thuê (nhóm B) gửi yêu cầu tới chính cửa hàng đã thu thập dữ liệu; chúng tôi hỗ trợ cửa
          hàng thực hiện yêu cầu đó trong thời hạn pháp luật quy định.
        </p>
      </Section>

      <Section id="xoa-du-lieu" title="9. Cách yêu cầu xoá dữ liệu">
        <ol className="list-decimal space-y-1 pl-5">
          <li>
            Gửi email tới {mail} với tiêu đề «<strong>Yêu cầu xoá dữ liệu</strong>», ghi rõ: email hoặc số điện thoại đã đăng ký, tên
            cửa hàng (nếu có), và phạm vi muốn xoá (tài khoản của bạn, hoặc toàn bộ dữ liệu cửa hàng).
          </li>
          <li>Chúng tôi xác minh bạn là chủ tài khoản / quản trị của cửa hàng (qua email hoặc số điện thoại đã đăng ký) trước khi xoá.</li>
          <li>Chúng tôi xoá dữ liệu trong vòng <strong>30 ngày</strong> kể từ khi xác minh xong và gửi email xác nhận. Bản sao lưu cũ chứa dữ liệu đó tự hết hạn theo lịch ở mục 7.</li>
        </ol>
        <p>
          Nếu bạn đăng nhập bằng Facebook: bạn cũng có thể gỡ VNXcommerce trong Facebook → Cài đặt → Ứng dụng và trang web; sau đó gửi
          email như trên để chúng tôi xoá dữ liệu đã nhận từ Facebook (mã định danh, họ tên, email).
        </p>
      </Section>

      <Section id="su-co" title="10. Sự cố dữ liệu">
        <p>
          Khi phát hiện sự cố có thể làm lộ dữ liệu cá nhân, chúng tôi thông báo cho Khách thuê bị ảnh hưởng và cơ quan có thẩm quyền
          trong thời hạn pháp luật quy định, kèm mô tả sự cố và biện pháp khắc phục.
        </p>
      </Section>

      <Section id="lien-he" title="11. Liên hệ và thay đổi chính sách">
        <p>
          Mọi câu hỏi, yêu cầu về dữ liệu cá nhân: {mail} · {COMPANY.phone} · {COMPANY.address}.
        </p>
        <p>
          Khi chính sách thay đổi, chúng tôi cập nhật trang này kèm số phiên bản và ngày hiệu lực mới; thay đổi quan trọng được thông
          báo tới quản trị của Khách thuê trong phần mềm.
        </p>
      </Section>
    </>
  ),
};
