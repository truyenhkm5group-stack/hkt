/** Nhãn tiếng Việt cho bảng tham chiếu (table_name) trong nhật ký kho Pancake */
export const INVENTORY_TABLE_LABEL: Record<string, string> = {
  orders: "Đơn hàng",
  purchases: "Nhập hàng",
  purchase_orders: "Nhập hàng",
  warehouse_transfers: "Chuyển kho",
  transfers: "Chuyển kho",
  returns: "Trả hàng",
  order_returns: "Trả hàng",
  stocktakings: "Kiểm kho",
  inventory_checks: "Kiểm kho",
  adjustments: "Điều chỉnh",
  none: "Khác",
};

export function inventoryTableLabel(tableName: string | null | undefined) {
  if (!tableName) return INVENTORY_TABLE_LABEL.none;
  return INVENTORY_TABLE_LABEL[tableName] ?? tableName.replace(/_/g, " ");
}

/** Màu nhãn theo bảng tham chiếu */
export const INVENTORY_TABLE_TONE: Record<string, string> = {
  orders: "bg-blue-50 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300",
  purchases: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300",
  purchase_orders: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300",
  warehouse_transfers: "bg-violet-50 text-violet-700 dark:bg-violet-950/60 dark:text-violet-300",
  transfers: "bg-violet-50 text-violet-700 dark:bg-violet-950/60 dark:text-violet-300",
  returns: "bg-orange-50 text-orange-700 dark:bg-orange-950/60 dark:text-orange-300",
  order_returns: "bg-orange-50 text-orange-700 dark:bg-orange-950/60 dark:text-orange-300",
  stocktakings: "bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300",
};
