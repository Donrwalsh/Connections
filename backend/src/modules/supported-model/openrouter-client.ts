import { Injectable } from "@nestjs/common";

export interface OpenRouterModel {
  id: string;
  description: string;
  created: number;
  context_length: number;
  pricing: { prompt: string; completion: string };
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
}
