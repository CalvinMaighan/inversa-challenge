/** Split streamed content when a model embeds thinking in `<think>` tags (deedee `llm-thinking-stream`). */

const OPEN_TAG = /<(think|redacted_thinking)>/i;
const CLOSE_TAG = /<\/(think|redacted_thinking)>/i;

export type ThinkingPartition = { phase: "outside" | "inside"; pending: string };

export const createThinkingPartition = (): ThinkingPartition => ({ phase: "outside", pending: "" });

/** Chars to hold back when the tail may be the start of a think tag (`a < b` is not). */
function holdBack(buf: string): number {
  const lastLt = buf.lastIndexOf("<");
  if (lastLt === -1) return 0;
  const tail = buf.slice(lastLt);
  return /^<\/?[a-z_]{0,18}$/i.test(tail) ? tail.length : 0;
}

export function partitionThinking(
  state: ThinkingPartition,
  delta: string,
): { reasoningDelta: string; contentDelta: string } {
  let reasoningDelta = "";
  let contentDelta = "";
  let buf = state.pending + delta;
  state.pending = "";
  while (buf.length > 0) {
    const tag = state.phase === "outside" ? OPEN_TAG.exec(buf) : CLOSE_TAG.exec(buf);
    if (!tag) {
      const hold = holdBack(buf);
      const emitLen = buf.length - hold;
      if (state.phase === "outside") contentDelta += buf.slice(0, emitLen);
      else reasoningDelta += buf.slice(0, emitLen);
      state.pending = buf.slice(emitLen);
      break;
    }
    if (state.phase === "outside") contentDelta += buf.slice(0, tag.index);
    else reasoningDelta += buf.slice(0, tag.index);
    buf = buf.slice(tag.index + tag[0].length);
    state.phase = state.phase === "outside" ? "inside" : "outside";
  }
  return { reasoningDelta, contentDelta };
}
