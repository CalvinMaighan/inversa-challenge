/**
 * Asking the real agent through the chat column, for the e2e scripts on the real stack (links, evidence). The
 * page's `fetch` is tapped (an init script) so a turn is known to be over when its `/api/agent/stream` body has
 * been read to the end, whatever the answer says.
 */
import type { Page } from "playwright";

/** One tapped stream: its status, whether it was read to the end, and the events the map acts on (GE7). */
export type Tapped = { status: number; done: boolean; events: { type: string; [k: string]: unknown }[] };

/**
 * Init script: wrap `window.fetch` so every agent stream is recorded with its status and completion, and its `view`,
 * `ui`, `tool_start` and `citation` events (read from a tee of the NDJSON body, so the page reads its own copy).
 */
export function tapAgentStreams(): void {
  const w = window as unknown as { __agentStreams: Tapped[] };
  w.__agentStreams = [];
  const original = window.fetch.bind(window);
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await original(input, init);
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.includes("/api/agent/stream") || !res.body) return res;
    const [mine, theirs] = res.body.tee();
    const entry: Tapped = { status: res.status, done: false, events: [] };
    w.__agentStreams.push(entry);
    void (async () => {
      const reader = mine.getReader();
      const decoder = new TextDecoder();
      let buffered = "";
      const keep = (line: string) => {
        try {
          const event = JSON.parse(line) as Tapped["events"][number];
          if (["view", "ui", "tool_start", "citation"].includes(event.type)) entry.events.push(event);
        } catch {
          // Not a JSON line.
        }
      };
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        const lines = buffered.split("\n");
        buffered = lines.pop() ?? "";
        for (const line of lines) if (line.trim()) keep(line);
      }
      if (buffered.trim()) keep(buffered);
      entry.done = true;
    })();
    return new Response(theirs, { status: res.status, statusText: res.statusText, headers: res.headers });
  }) as typeof fetch;
}

/** Type `text` into the composer, send, and wait until the stream ended and the answer stopped streaming. */
export async function ask(page: Page, text: string, timeoutMs: number): Promise<void> {
  const column = page.locator("[data-chat-column]");
  const before = await page.evaluate(() => (window as unknown as { __agentStreams: Tapped[] }).__agentStreams.length);
  const input = column.getByRole("textbox", { name: "Question" });
  await input.fill(text);
  await input.press("Enter");
  await page.waitForFunction((n) => (window as unknown as { __agentStreams: Tapped[] }).__agentStreams[n]?.done === true, before, { timeout: timeoutMs });
  const status = await page.evaluate((n) => (window as unknown as { __agentStreams: Tapped[] }).__agentStreams[n]!.status, before);
  if (status !== 200) throw new Error(`agent stream answered ${status}`);
  await page.waitForFunction(
    () => !document.querySelector('[data-chat-column] [data-source="text"][data-status="streaming"], [data-chat-column] [data-source="text"][data-status="pending"]'),
    undefined,
    { timeout: 30_000 },
  );
}
