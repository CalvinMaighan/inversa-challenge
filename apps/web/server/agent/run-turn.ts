import { randomUUID } from "node:crypto";

import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";

import { recordTokens, tokenBudget } from "@/server/agent/budget";
import { answerCacheKey, readAnswerCache, writeAnswerCache } from "@/server/agent/cache";
import { bootHarness, harnessModels, type HarnessMode } from "@/server/agent/cordis/boot";
import { bindCapabilityTools, EvidenceLedger } from "@/server/agent/cordis/capability-tools";
import { AGENT_LIMITS, attachTurnLimits, type AgentLimits, type LimitHit } from "@/server/agent/cordis/limits";
import { attachStreamBridge, type ToolCallRecord, type TurnUsage } from "@/server/agent/cordis/stream-bridge";
import { AGENT_SYSTEM_PROMPT, viewContext } from "@/server/agent/prompt";
import { resolveAgentEndpoint } from "@/server/agent/runtime/model";
import type { CapabilityRegistry } from "@/server/agent/runtime/registry";
import { appendSessionTurn, sessionHistory, type SessionMessage } from "@/server/agent/session";
import { buildAgentRegistry } from "@/server/agent/tools/capabilities";
import { dataVersion, fetchFeeds } from "@/server/agent/tools/gql";
import type { AgentStreamEvent, AgentStreamRequest } from "@/shared/agent/events";

export type RunTurnParams = AgentStreamRequest & {
  /** Defaults to `AGENT_HARNESS=mock` from the environment, else live. */
  harnessMode?: HarnessMode;
  /** Client disconnect. Cancels the loop and any in-flight GraphQL call. */
  signal?: AbortSignal;
  /** Tests tighten these. */
  limits?: Partial<AgentLimits>;
  registry?: CapabilityRegistry;
  /** Reference time. Defaults to the view's timeline time, else the wall clock. */
  now?: Date;
  /** Set false to bypass the answer cache. */
  cache?: boolean;
};

export type RunTurnResult = {
  content: string;
  citations: string[];
  toolCalls: ToolCallRecord[];
  usage: TurnUsage;
  /** Catalog id of the model that produced the answer, or "cache". */
  model: string;
  cached: boolean;
  limitHit?: LimitHit;
};

/** Events worth replaying on a cache hit. Status, reasoning and context are per-run. */
const REPLAYED = new Set<AgentStreamEvent["type"]>([
  "tool_start",
  "tool_end",
  "view",
  "citation",
  "content_delta",
  "debug",
]);

function harnessModeFromEnv(): HarnessMode {
  return process.env.AGENT_HARNESS?.trim() === "mock" ? "mock" : "live";
}

function referenceTime(params: RunTurnParams): Date {
  if (params.now) return params.now;
  const viewTime = params.view ? Date.parse(params.view.time) : NaN;
  return Number.isFinite(viewTime) ? new Date(viewTime) : new Date();
}

function transcript(history: SessionMessage[]): string {
  return history.map((message) => `${message.role}: ${message.content}`).join("\n");
}

const estimateTokens = (text: string) => Math.ceil(text.length / 4);

type Attempt = {
  content: string;
  citations: string[];
  toolCalls: ToolCallRecord[];
  usage: TurnUsage;
  error?: string;
  streamedContent: boolean;
  limitHit?: LimitHit;
};

/**
 * Runs one agent turn: opens a fresh harness session, binds the capability
 * tools, seeds the prior transcript and the current view, asks the question
 * and streams C7 events. Flash answers; Pro (cordis.yml escalation row) re-runs
 * the turn when Flash fails before any answer text reached the client.
 * Always ends with exactly one `done` event.
 */
export async function runTurn(
  params: RunTurnParams,
  onEvent: (event: AgentStreamEvent) => void,
): Promise<RunTurnResult> {
  let done = false;
  const guarded = (event: AgentStreamEvent) => {
    if (done) return;
    if (event.type === "done") done = true;
    onEvent(event);
  };
  try {
    return await runTurnUnguarded(params, guarded);
  } catch (error) {
    // Boot, data-dir or session I/O failures still end the stream with error + done.
    guarded({ type: "error", message: error instanceof Error ? error.message : "Agent turn failed" });
    guarded({ type: "done", content: "" });
    return {
      content: "",
      citations: [],
      toolCalls: [],
      usage: { promptTokens: 0, completionTokens: 0, cacheRead: 0 },
      model: "none",
      cached: false,
    };
  }
}

async function runTurnUnguarded(
  params: RunTurnParams,
  onEvent: (event: AgentStreamEvent) => void,
): Promise<RunTurnResult> {
  const mode = params.harnessMode ?? harnessModeFromEnv();
  const limits: AgentLimits = { ...AGENT_LIMITS, ...params.limits };
  const now = referenceTime(params);
  const question = params.question.trim();
  const empty: TurnUsage = { promptTokens: 0, completionTokens: 0, cacheRead: 0 };
  const finish = (result: RunTurnResult): RunTurnResult => {
    onEvent({ type: "done", content: result.content });
    return result;
  };

  const budget = tokenBudget();
  if (budget.remaining <= 0) {
    onEvent({
      type: "error",
      message: `Daily agent token budget (${budget.limit.toLocaleString("en-US")}) is used up. It resets at 00:00 UTC.`,
    });
    return finish({ content: "", citations: [], toolCalls: [], usage: empty, model: "none", cached: false });
  }

  const history = sessionHistory(params.sessionId);

  // Cache only standalone questions: a follow-up's meaning depends on the transcript.
  let cacheKey: string | undefined;
  if (params.cache !== false && history.length === 0) {
    try {
      const version = dataVersion(await fetchFeeds(params.signal));
      if (version) cacheKey = answerCacheKey(question, version, { bbox: params.view?.bbox, now });
    } catch (error) {
      onEvent({
        type: "debug",
        text: `answer cache skipped: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  const hit = cacheKey ? readAnswerCache(cacheKey) : undefined;
  if (hit) {
    onEvent({ type: "debug", text: "answer cache hit" });
    for (const event of hit.events) onEvent(event);
    appendSessionTurn(params.sessionId, question, hit.content);
    return finish({
      content: hit.content,
      citations: hit.citations,
      toolCalls: [],
      usage: empty,
      model: "cache",
      cached: true,
    });
  }

  const recorded: AgentStreamEvent[] = [];
  const emit = (event: AgentStreamEvent) => {
    if (REPLAYED.has(event.type)) recorded.push(event);
    onEvent(event);
  };

  const registry = params.registry ?? buildAgentRegistry();
  const root = await bootHarness(mode);
  const models = harnessModels(root);
  const primary = resolveAgentEndpoint(models.primary.model);
  const context = viewContext(params.view, now);
  const prior = transcript(history);
  emit({
    type: "context",
    windowTokens: primary.contextWindow,
    segments: [
      { label: "system", tokens: estimateTokens(AGENT_SYSTEM_PROMPT) },
      {
        label: "tools",
        tokens: estimateTokens(registry.list().map((cap) => `${cap.name}\n${cap.description}`).join("\n")),
      },
      { label: "history", tokens: estimateTokens(prior) },
      { label: "input", tokens: estimateTokens(`${context}\n${question}`) },
    ],
  });

  const deadline = AbortSignal.timeout(limits.maxRuntimeMs);
  const turnSignal = params.signal ? AbortSignal.any([params.signal, deadline]) : deadline;

  // Reasoning effort is the adapter's per-model default (resolveModel), so the mock and Fireworks both accept it.
  const attempt = async (
    entry: { provider: string; model: string },
    emit: (event: AgentStreamEvent) => void,
  ): Promise<Attempt> => {
    const endpoint = resolveAgentEndpoint(entry.model);
    const ledger = new EvidenceLedger();
    const agentOptions = { provider: entry.provider, model: endpoint.catalogId, maxTokens: endpoint.maxTokens };
    const handle = await root.agents.create({
      sessionId: SessionId(`${params.sessionId}-${randomUUID()}`),
      agentOptions,
      setup(agentCtx) {
        agentCtx.systemPrompt.section({ name: "inversa:analyst", order: 0, text: AGENT_SYSTEM_PROMPT });
        bindCapabilityTools(agentCtx, registry, { signal: turnSignal, now, view: params.view, emit }, ledger);
        agentCtx.on("agent/request", async (_payload, next) => ({ ...(await next()), ...agentOptions }));
      },
    });
    const agent = handle.agent;
    let limitHit: LimitHit | undefined;
    const onLimit = (hit: LimitHit) => {
      limitHit ??= hit;
      const what = hit.kind === "runtime" ? `${hit.limit / 1000} s runtime` : `${hit.limit} ${hit.kind.replace("_", " ")}`;
      emit({ type: "debug", text: `limit reached: ${what}` });
    };
    attachTurnLimits(agent, agent.ctx, limits, onLimit);
    const bridge = attachStreamBridge(agent, ledger, emit);
    const cancel = () => {
      if (deadline.aborted) onLimit({ kind: "runtime", limit: limits.maxRuntimeMs });
      agent.cancel({ kind: "hook", reason: "timeout-or-client-abort" });
    };
    if (turnSignal.aborted) cancel();
    else turnSignal.addEventListener("abort", cancel, { once: true });
    try {
      if (prior) {
        agent.inject(
          createUserMessage({
            content: [{ type: "text", text: `Conversation so far:\n${prior}` }],
            source: { kind: "plugin", plugin: "inversa-history", form: "recall" },
          }),
        );
      }
      agent.inject(
        createUserMessage({
          content: [{ type: "text", text: context }],
          source: { kind: "plugin", plugin: "inversa-view", form: "recall" },
        }),
      );
      agent.followup(createUserMessage({ content: [{ type: "text", text: question }], source: { kind: "user" } }));
      await agent.whenIdle();
      return {
        content: bridge.finalText(),
        citations: bridge.citations(),
        toolCalls: bridge.toolCalls,
        usage: bridge.usage,
        error: bridge.finishError,
        streamedContent: bridge.streamedContent,
        limitHit,
      };
    } finally {
      turnSignal.removeEventListener("abort", cancel);
      await handle.dispose();
    }
  };

  let model = primary.catalogId;
  let result: Attempt;
  try {
    // Hold the primary's error events until we know whether Pro takes over.
    const heldErrors: AgentStreamEvent[] = [];
    result = await attempt(models.primary, (event) => (event.type === "error" ? heldErrors.push(event) : emit(event)));
    const failedEarly = !result.streamedContent && (result.error !== undefined || !result.content);
    if (!(failedEarly && !result.limitHit && !turnSignal.aborted)) {
      for (const event of heldErrors) emit(event);
    } else {
      model = resolveAgentEndpoint(models.escalation.model).catalogId;
      emit({ type: "debug", text: `escalating to ${model}: ${result.error ?? "empty reply"}` });
      const first = result;
      result = await attempt(models.escalation, emit);
      result.usage = {
        promptTokens: first.usage.promptTokens + result.usage.promptTokens,
        completionTokens: first.usage.completionTokens + result.usage.completionTokens,
        cacheRead: first.usage.cacheRead + result.usage.cacheRead,
      };
      result.toolCalls = [...first.toolCalls, ...result.toolCalls];
    }
  } catch (error) {
    emit({ type: "error", message: error instanceof Error ? error.message : "Agent turn failed" });
    return finish({ content: "", citations: [], toolCalls: [], usage: empty, model, cached: false });
  }

  recordTokens(result.usage.promptTokens + result.usage.completionTokens);
  if (!result.content && !result.error) {
    emit({
      type: "error",
      message: result.limitHit
        ? `Stopped at the ${result.limitHit.kind.replace("_", " ")} limit before an answer.`
        : "The model returned an empty reply.",
    });
  }
  appendSessionTurn(params.sessionId, question, result.content);
  const clean = result.content && !result.error && !result.limitHit;
  if (cacheKey && clean) {
    writeAnswerCache(cacheKey, { events: recorded, content: result.content, citations: result.citations });
  }
  return finish({
    content: result.content,
    citations: result.citations,
    toolCalls: result.toolCalls,
    usage: result.usage,
    model,
    cached: false,
    limitHit: result.limitHit,
  });
}
