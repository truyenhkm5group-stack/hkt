import { aiEnv } from "@/lib/ai/config";
import { AnthropicProvider } from "@/lib/ai/providers/anthropic";
import { StubProvider } from "@/lib/ai/providers/stub";
import type { ModelProvider } from "@/lib/ai/providers/types";

const providers = new Map<string, ModelProvider>();

function register(provider: ModelProvider) {
  providers.set(provider.name, provider);
}

register(new StubProvider());
register(new AnthropicProvider());

/**
 * Lấy một nhà cung cấp theo tên. Tên lạ ⇒ null (bộ định tuyến sẽ leo nấc hoặc chuyển người),
 * KHÔNG âm thầm rơi về một nhà cung cấp khác — chi phí và chất lượng khác nhau thì người dùng
 * phải biết mình đang chạy trên cái gì.
 */
export function getProvider(name: string): ModelProvider | null {
  return providers.get(name) ?? null;
}

export function defaultProviderName(): string {
  return aiEnv.provider;
}

export function providerNames(): string[] {
  return [...providers.keys()];
}
