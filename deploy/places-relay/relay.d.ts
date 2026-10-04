/** Kiểu cho relay.js (trạm chạy JS thuần trên Cloud Run; bài kiểm import qua tệp này). */
export declare const UPSTREAM: string;
export declare const MAX_BODY: number;
export declare function allowed(method: string, path: string): boolean;
export declare function secretOk(given: unknown, secret: unknown): boolean;
export type RelayRequest = { method: string; url: string; headers: Record<string, string | undefined>; body: string };
export type RelayResponse = { status: number; contentType: string; body: string };
export declare function handle(req: RelayRequest, deps: { secret: string; fetchImpl: (input: string, init: RequestInit) => Promise<Response>; timeoutMs?: number }): Promise<RelayResponse>;
