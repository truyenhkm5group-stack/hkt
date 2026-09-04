import { EventEmitter } from "node:events";

export type RealtimeEvent =
  | { type: "sync"; source: string; job: string; status: string }
  | { type: "order"; orderId: string; action: "created" | "updated" }
  | { type: "shipment"; shipmentId: string; status?: string }
  | { type: "stock"; variantId: string }
  | { type: "ads" }
  | { type: "ping" };

const globalForBus = globalThis as unknown as { erpBus?: EventEmitter };
const bus = globalForBus.erpBus ?? new EventEmitter();
bus.setMaxListeners(500);
if (!globalForBus.erpBus) globalForBus.erpBus = bus;

export function publish(event: RealtimeEvent) {
  bus.emit("event", { ...event, at: Date.now() });
}

export function subscribe(listener: (event: RealtimeEvent & { at: number }) => void) {
  bus.on("event", listener);
  return () => bus.off("event", listener);
}
