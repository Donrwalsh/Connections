import { Injectable } from "@nestjs/common";

export interface OpenRouterModel {
  id: string;
  description: string;
  created: number;
  context_length: number;
  pricing: { prompt: string; completion: string };
}

export interface OpenRouterEndpoint {
  provider_name: string;
  base_url: string;
  pricing: {
    prompt: string;
    completion: string;
    request?: string;
    image?: string;
    web_search?: string;
    internal_reasoning?: string;
  };
}

/**
 * Thin client for OpenRouter's public, unauthenticated model list —
 * https://openrouter.ai/api/v1/models. No API key needed; this is public
 * catalog data, not a proxied inference call.
 */
@Injectable()
export class OpenRouterClient {
  private readonly url = "https://openrouter.ai/api/v1/models";

  async listModels(): Promise<OpenRouterModel[]> {
    const response = await fetch(this.url);
    if (!response.ok) {
      throw new Error(`OpenRouter request failed: ${response.status}`);
    }
    const body = (await response.json()) as { data: OpenRouterModel[] };
    return body.data;
  }

  /**
   * The per-provider endpoints OpenRouter routes a model to, keyed by
   * provider_name (e.g. "Groq", "OpenAI", "Together"). Each endpoint carries
   * the price *that provider* charges when the routing hits it — which can
   * differ from the model-level aggregate pricing on the list endpoint, and
   * is what a priceScopeProvider-scoped model's cost should be measured
   * against.
   */
  async getModelEndpoints(id: string): Promise<OpenRouterEndpoint[]> {
    const response = await fetch(`${this.url}/${encodeURIComponent(id)}/endpoints`);
    if (!response.ok) {
      throw new Error(`OpenRouter endpoints request failed: ${response.status}`);
    }
    const body = (await response.json()) as {
      data: { id: string; endpoints: OpenRouterEndpoint[] };
    };
    return body.data?.endpoints ?? [];
  }
}
