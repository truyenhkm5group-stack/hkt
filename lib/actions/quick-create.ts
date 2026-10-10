"use server";

import { can, requireUser } from "@/lib/auth/session";
import type { CreateKey } from "@/lib/constants/command-catalog";
import { manualOrderGate } from "@/lib/records/order-create";
import { customerCreateGate } from "@/lib/records/customer-create";
import { productCreateGate } from "@/lib/records/product-create";

/**
 * Nút «+ Tạo mới» và nhóm «Tạo mới…» của ô lệnh hỏi ở đây loại nào người này THẬT SỰ tạo được — cùng cổng mà trang tạo
 * và server action ghi dùng, để nút, trang và lượt ghi không nói ba điều khác nhau. Gọi khi người dùng MỞ menu, không
 * gọi ở bố cục: mỗi lần mở trang không phải trả giá ba câu hỏi cổng.
 *
 * Không có nhánh lỗi riêng: hỏi hỏng ⇒ không hiện mục đó (phía HẸP hơn), trang danh sách vẫn ở menu.
 */
export async function allowedCreateKeys(): Promise<CreateKey[]> {
  const user = await requireUser();
  const [order, customer, product] = await Promise.all([
    manualOrderGate(user).then((g) => g.allowed).catch(() => false),
    customerCreateGate(user).then((g) => g.allowed).catch(() => false),
    productCreateGate(user).then((g) => g.allowed).catch(() => false),
  ]);
  const keys: CreateKey[] = [];
  if (order) keys.push("order");
  if (customer) keys.push("customer");
  if (product) keys.push("product");
  if (can(user, "inventory:write")) keys.push("receipt");
  if (can(user, "expenses:write")) keys.push("expense");
  if (can(user, "users:manage")) keys.push("user");
  return keys;
}
