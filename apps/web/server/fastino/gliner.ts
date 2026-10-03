/**
 * Fastino GLiNER2.5-Decide: a small classifier (about 0.7 s here) behind the OpenAI-compatible POST /v1/chat/completions. It
 * scores each label you supply against a text, many at once (`multi_label`), which makes it the right tool for ranking a list;
 * GLiDE (glide.ts) is for single decisions, and slows to 8 to 12 s when it is unsure which of many options wins.
 * Null for any failure or without FASTINO_API_KEY, like GLiDE: the caller carries on without it.
 */
import { glideKey } from "@/server/fastino/glide";

const MODEL = "fastino/gliner2.5-decide";

export type ScoredLabel = { label: string; confidence: number };

export type ClassifyOptions = { apiKey?: string; origin?: string; timeoutMs?: number; signal?: AbortSignal; fetchImpl?: typeof fetch };

/** Every label with the model's confidence for `text`, best first; null when there is no answer. */
export async function scoreLabels(text: string, labels: readonly string[], options: ClassifyOptions = {}): Promise<ScoredLabel[] | null> {
  const key = glideKey(options.apiKey);
  if (!key || labels.length < 2) return null;
  const url = `${(options.origin ?? process.env.FASTINO_API_ORIGIN ?? "https://api.fastino.ai").replace(/\/$/, "")}/v1/chat/completions`;
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 4_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  try {
    const res = await (options.fetchImpl ?? fetch)(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: text }],
        schema: { classifications: [{ task: "pick", labels, multi_label: true, top_k: labels.length }] },
        threshold: 0,
        include_confidence: true,
        store: false,
      }),
      signal,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const parsed = JSON.parse(body.choices?.[0]?.message?.content ?? "null") as { pick?: ScoredLabel[] } | null;
    const known = new Set(labels);
    const scored = (parsed?.pick ?? []).filter((s) => known.has(s.label) && Number.isFinite(s.confidence));
    return scored.length ? scored.sort((a, b) => b.confidence - a.confidence) : null;
  } catch {
    return null;
  }
}
