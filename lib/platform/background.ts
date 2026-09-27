import { currentOrganization, withOrganization } from "@/lib/platform/context";

/**
 * ═══════════ VIỆC CHẠY SAU PHẢN HỒI MANG THEO TỔ CHỨC CỦA NGƯỜI BẤM ═══════════
 *
 * Audit ISO-16. `after()` của Next, promise bỏ rơi, hẹn giờ: đó là những chỗ ngữ cảnh DỄ MẤT nhất,
 * và theo P4(3) mất ngữ cảnh nghĩa là rơi về tổ chức nhà — vòng gửi tin hàng loạt của tổ chức B sẽ
 * đọc danh sách khách của VNX và ghi trạng thái vào CSDL VNX. Next có mang ngữ cảnh
 * `AsyncLocalStorage` vào `after()` hay không là chuyện của phiên bản Next, không phải một lời hứa
 * mà kho này dựa vào được.
 *
 * Nên không dựa vào lan truyền ngầm: CHỤP tổ chức NGAY LÚC GỌI (khi request còn sống, cookie phiên
 * còn đọc được), rồi trả về một hàm tự bọc `withOrganization(mã đã chụp)`. `withOrganization` kiểm
 * lại trạng thái tổ chức lúc chạy — tổ chức bị đình chỉ trong lúc chờ thì việc nền NÉM, không chạy.
 *
 *     after(await bindOrganization(async () => { … }));
 *
 * Máy quét `tests/platform-isolation-static.test.ts` đòi MỌI `after(` trong mã đi qua hàm này.
 */
export async function bindOrganization<T>(fn: () => Promise<T>): Promise<() => Promise<T>> {
  const org = await currentOrganization();
  const code = org.code;
  return () => withOrganization(code, fn);
}
