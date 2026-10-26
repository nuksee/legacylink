// Muse Spark over the Meta Model API's OpenAI-compatible Chat Completions
// endpoint, with JSON-schema structured output. Endpoint, auth and model ids
// follow the public provider docs (promptfoo, Oct 2026) and have not yet been
// checked against our own key; override them with the env vars below.
//
//   MODEL_API_KEY        required
//   MUSE_BASE_URL        default https://api.meta.ai/v1
//   MUSE_MODEL           default muse-spark-1.3

export interface ChatRequest {
  system: string;
  user: string; // JSON text
  image?: string; // base64 PNG
  schemaName: string;
  schema: object;
}

export interface ChatResponse {
  content: string;
  tokensIn: number;
  tokensOut: number;
}

export interface MuseConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export function museConfigFromEnv(env = process.env): MuseConfig | undefined {
  if (!env.MODEL_API_KEY) return undefined;
  return {
    apiKey: env.MODEL_API_KEY,
    baseUrl: (env.MUSE_BASE_URL || 'https://api.meta.ai/v1').replace(/\/$/, ''),
    model: env.MUSE_MODEL || 'muse-spark-1.3',
  };
}

export async function chat(cfg: MuseConfig, req: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
  const userContent = req.image
    ? [
        { type: 'text', text: req.user },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${req.image}` } },
      ]
    : req.user;
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: cfg.model,
      temperature: 0,
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content: userContent },
      ],
      response_format: { type: 'json_schema', json_schema: { name: req.schemaName, schema: req.schema, strict: false } },
    }),
    signal: signal ?? AbortSignal.timeout(120_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Muse Spark API ${res.status}: ${text.slice(0, 500)}`);
  const body = JSON.parse(text) as {
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const content = body.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error(`Muse Spark API returned no message content: ${text.slice(0, 500)}`);
  return { content, tokensIn: body.usage?.prompt_tokens ?? 0, tokensOut: body.usage?.completion_tokens ?? 0 };
}
