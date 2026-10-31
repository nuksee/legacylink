// Muse Spark over the Meta Model API's OpenAI-compatible Chat Completions
// endpoint, with JSON-schema structured output. Checked live on 2026-10-26:
// /v1/models lists muse-spark-1.1, -1.2 and -1.3 (plus -contributor variants,
// which Meta trains on; never use those), and muse-spark-1.3 answers
// json_schema requests. It is a reasoning model: hidden reasoning tokens count
// against the completion budget, so we set no max_tokens.
//
//   MODEL_API_KEY        sent as a Bearer token; leave it unset when a proxy adds the header
//   MUSE_BASE_URL        default https://api.meta.ai/v1
//   MUSE_MODEL           default muse-spark-1.3
//
// Behind an HTTPS proxy, Node's fetch needs NODE_USE_ENV_PROXY=1 (Node >= 22.21).

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
  apiKey?: string; // no key: send no Authorization header (a proxy injects it)
  baseUrl: string;
  model: string;
}

// Without a key there is a config only when live mode is asked for by name.
export function museConfigFromEnv(env = process.env, mode = env.LEGACYLINK_MODEL): MuseConfig | undefined {
  if (!env.MODEL_API_KEY && mode !== 'live') return undefined;
  return {
    apiKey: env.MODEL_API_KEY || undefined,
    baseUrl: (env.MUSE_BASE_URL || 'https://api.meta.ai/v1').replace(/\/$/, ''),
    model: env.MUSE_MODEL || 'muse-spark-1.3',
  };
}

// Retries a call that failed on the way (unreachable, 429, 5xx: the API sometimes answers
// "502 upstream request failed") twice, after 2 s and 5 s. Other errors fail at once.
export async function chat(cfg: MuseConfig, req: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
  for (const wait of [2000, 5000]) {
    try {
      return await chatOnce(cfg, req, signal);
    } catch (e) {
      if (!(e instanceof TransientError) || signal?.aborted) throw e;
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  return chatOnce(cfg, req, signal);
}

class TransientError extends Error {}

async function chatOnce(cfg: MuseConfig, req: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
  const userContent = req.image
    ? [
        { type: 'text', text: req.user },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${req.image}` } },
      ]
    : req.user;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
  const url = `${cfg.baseUrl}/chat/completions`;
  const res = await fetch(url, {
    method: 'POST',
    headers,
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
  }).catch((e: Error & { cause?: { code?: string } }) => {
    const code = e.cause?.code ?? '';
    const hint =
      code === 'ENOTFOUND' && (process.env.HTTPS_PROXY || process.env.https_proxy) && !process.env.NODE_USE_ENV_PROXY
        ? ' (HTTPS_PROXY is set but Node ignores it; run with NODE_USE_ENV_PROXY=1)'
        : '';
    const msg = `Muse Spark API unreachable at ${url}: ${code || e.message}${hint}`;
    throw e.name === 'TimeoutError' || hint ? new Error(msg) : new TransientError(msg);
  });
  const text = await res.text();
  if (!res.ok) {
    const msg = `Muse Spark API ${res.status}: ${text.slice(0, 500)}`;
    throw res.status === 429 || res.status >= 500 ? new TransientError(msg) : new Error(msg);
  }
  const body = JSON.parse(text) as {
    choices?: { finish_reason?: string; message?: { content?: string | null; refusal?: string | null } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const choice = body.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content !== 'string') {
    const why = choice?.message?.refusal ? `refused: ${choice.message.refusal}` : `finish_reason ${choice?.finish_reason ?? 'missing'}`;
    throw new Error(`Muse Spark API returned no message content (${why}): ${text.slice(0, 500)}`);
  }
  return { content, tokensIn: body.usage?.prompt_tokens ?? 0, tokensOut: body.usage?.completion_tokens ?? 0 };
}
