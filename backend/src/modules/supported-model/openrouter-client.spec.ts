import { OpenRouterClient } from "./openrouter-client";

describe("OpenRouterClient", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("returns the parsed model list on success", async () => {
    const body = {
      data: [
        {
          id: "openai/gpt-4.1-nano",
          description: "Fast and cheap.",
          created: 1744651369,
          context_length: 128000,
          pricing: { prompt: "0.0000001", completion: "0.0000004" },
        },
      ],
    };
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(body),
    }) as unknown as typeof fetch;

    const client = new OpenRouterClient();
    const models = await client.listModels();

    expect(global.fetch).toHaveBeenCalledWith("https://openrouter.ai/api/v1/models");
    expect(models).toEqual(body.data);
  });

  it("throws when the response is not ok", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
    }) as unknown as typeof fetch;

    const client = new OpenRouterClient();
    await expect(client.listModels()).rejects.toThrow("OpenRouter request failed: 503");
  });
});
