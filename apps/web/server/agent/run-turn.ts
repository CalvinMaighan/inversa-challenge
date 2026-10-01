import { randomUUID } from "node:crypto";

import { createUserMessage, type LlmCallConfig } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";

import { answerProblems, capturing, revisionRequest, type ToolCapture } from "@/server/agent/answer-check";
import { recordUsage, spendRefusal } from "@/server/agent/budget";
import { answerCacheKey, readAnswerCache, writeAnswerCache } from "@/server/agent/cache";
import { bootHarness, harnessModel } from "@/server/agent/cordis/boot";
import { bindCapabilityTools, EvidenceLedger } from "@/server/agent/cordis/capability-tools";
import { filterCitations } from "@/server/agent/cordis/citations";
import { AGENT_LIMITS, attachTurnLimits, type AgentLimits, type LimitHit } from "@/server/agent/cordis/limits";
import { attachStreamBridge, type ToolCallRecord, type TurnUsage } from "@/server/agent/cordis/stream-bridge";
import { agentSystemPrompt, viewContext } from "@/server/agent/prompt";
import { MISSING_KEY_MESSAGE, openRouterApiKey, resolveAgentEndpoint } from "@/server/agent/runtime/model";
import { scopeGuard } from "@/server/agent/scope";
import type { CapabilityRegistry } from "@/server/agent/runtime/registry";
import { appendSessionTurn, sessionHistory, type SessionMessage } from "@/server/agent/session";
import { buildAgentRegistry } from "@/server/agent/tools/capabilities";
import { dataVersion, fetchFeeds } from "@/server/agent/tools/gql";
import type { AgentStreamEvent, AgentStreamRequest } from "@/shared/agent/events";
import { getApp } from "@/shared/apps";

export type RunTurnParams = AgentStreamRequest & {
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
  /** OpenRouter model id that produced the answer, "cache", or "none". */
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

function referenceTime(params: RunTurnParams): Date {
  if (params.now) return params.now;
  const viewTime = params.view ? Date.parse(params.view.time) : NaN;
  return Number.isFinite(viewTime) ? new Date(viewTime) : new Date();
}

function transcript(history: SessionMessage[]): string {
  return history.map((message) => `${message.role}: ${message.content}`).join("\n");
}

const estimateTokens = (text: string) => Math.ceil(text.length / 4);

/**
 * Runs one agent turn: opens a fresh harness session, binds the capability
 * tools, seeds the prior transcript and the current view, asks the question
 * and streams C7 events. Always ends with exactly one `done` event.
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
  const limits: AgentLimits = { ...AGENT_LIMITS, ...params.limits };
  const now = referenceTime(params);
  const question = params.question.trim();
  // Persona, scope, tools and API prefix all follow the request's app (C-A5). Sessions and cached answers are
  // per app too: a carp transcript must never seed a python turn, nor a python answer satisfy a carp question.
  const app = getApp(params.app);
  const sessionId = `${app.id}-${params.sessionId}`;
  const systemPrompt = agentSystemPrompt(app);
  const empty: TurnUsage = { promptTokens: 0, completionTokens: 0, cacheRead: 0 };
  const finish = (result: RunTurnResult): RunTurnResult => {
    onEvent({ type: "done", content: result.content });
    return result;
  };
  const refuse = (message: string) => {
    onEvent({ type: "error", message });
    return finish({ content: "", citations: [], toolCalls: [], usage: empty, model: "none", cached: false });
  };

  const overSpend = spendRefusal(app.id);
  if (overSpend) return refuse(overSpend.message);
  if (!openRouterApiKey()) return refuse(MISSING_KEY_MESSAGE);

  // P4: another app's species is refused from the config, without a model call.
  const refusal = scopeGuard(app, question);
  if (refusal) {
    onEvent({ type: "status", state: "generating" });
    onEvent({ type: "content_delta", text: refusal });
    appendSessionTurn(sessionId, question, refusal);
    return finish({ content: refusal, citations: [], toolCalls: [], usage: empty, model: "scope-guard", cached: false });
  }

  const history = sessionHistory(sessionId);

  // Cache only standalone questions: a follow-up's meaning depends on the transcript.
  let cacheKey: string | undefined;
  if (params.cache !== false && history.length === 0) {
    try {
      const version = dataVersion(await fetchFeeds({ app, signal: params.signal }));
      if (version) cacheKey = answerCacheKey(app.id, question, version, { bbox: params.view?.bbox, now });
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
    appendSessionTurn(sessionId, question, hit.content);
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

  // Every successful tool output is kept for the generic answer check (numbers trace, feed-state disclosure).
  const captures: ToolCapture[] = [];
  const registry = capturing(params.registry ?? buildAgentRegistry(app), captures);
  const root = await bootHarness();
  const entry = harnessModel(root);
  const endpoint = resolveAgentEndpoint(entry.model, app.id);
  const context = viewContext(params.view, now, app);
  const prior = transcript(history);
  emit({
    type: "context",
    windowTokens: endpoint.contextWindow,
    segments: [
      { label: "system", tokens: estimateTokens(systemPrompt) },
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

  // Reasoning effort follows the app's endpoint (resolveAgentEndpoint); the adapter reads it from the request.
  const ledger = new EvidenceLedger();
  // The effort id is the adapter's own vocabulary (`openRouterEffort`), spelled the same as dsh-llm's branded id.
  const agentOptions = { provider: entry.provider, model: endpoint.model, maxTokens: endpoint.maxTokens, reasoningEffort: endpoint.reasoningEffort as LlmCallConfig["reasoningEffort"] };
  let handle: Awaited<ReturnType<typeof root.agents.create>>;
  try {
    handle = await root.agents.create({
      sessionId: SessionId(`${app.id}-${params.sessionId}-${randomUUID()}`),
      agentOptions,
      setup(agentCtx) {
        agentCtx.systemPrompt.section({ name: "inversa:analyst", order: 0, text: systemPrompt });
        bindCapabilityTools(agentCtx, registry, { app, signal: turnSignal, now, view: params.view, emit }, ledger);
        agentCtx.on("agent/request", async (_payload, next) => ({ ...(await next()), ...agentOptions }));
      },
    });
  } catch (error) {
    emit({ type: "error", message: error instanceof Error ? error.message : "Agent turn failed" });
    return finish({ content: "", citations: [], toolCalls: [], usage: empty, model: endpoint.model, cached: false });
  }

  const agent = handle.agent;
  let limitHit: LimitHit | undefined;
  const onLimit = (hit: LimitHit) => {
    limitHit ??= hit;
    const what = hit.kind === "runtime" ? `${hit.limit / 1000} s runtime` : `${hit.limit} ${hit.kind.replace("_", " ")}`;
    emit({ type: "debug", text: `limit reached: ${what}` });
  };
  attachTurnLimits(agent, agent.ctx, limits, onLimit);
  // The final answer is held until the generic answer check has seen it; a lead-in line before the first tool
  // call still streams at once. One revision is asked for when something is missing (answer-check.ts).
  const bridge = attachStreamBridge(agent, ledger, emit, { holdFinal: true });
  const cancel = () => {
    if (deadline.aborted) onLimit({ kind: "runtime", limit: limits.maxRuntimeMs });
    agent.cancel({ kind: "hook", reason: "timeout-or-client-abort" });
  };
  if (turnSignal.aborted) cancel();
  else turnSignal.addEventListener("abort", cancel, { once: true });
  let failed = false;
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
    const draft = bridge.heldText();
    if (draft !== undefined && !limitHit && !bridge.finishError && !turnSignal.aborted) {
      const verified = filterCitations(draft, (id) => ledger.get(id) !== undefined);
      const problems = answerProblems({ app, question, content: verified.text, captures });
      if (problems.length) {
        emit({ type: "debug", text: `answer revised: ${problems.join("; ")}` });
        bridge.beginRevision();
        agent.followup(createUserMessage({ content: [{ type: "text", text: revisionRequest(problems) }], source: { kind: "user" } }));
        await agent.whenIdle();
        const revision = bridge.endRevision();
        // A revision the provider fails or leaves empty is not worth an error: the draft stands.
        if (revision.error || !revision.text?.trim()) {
          emit({ type: "debug", text: `revision failed (${revision.error ?? "empty reply"}): keeping the draft` });
          bridge.releaseText(draft);
        }
      }
    }
  } catch (error) {
    failed = true;
    emit({ type: "error", message: error instanceof Error ? error.message : "Agent turn failed" });
  } finally {
    bridge.releaseHeld();
    turnSignal.removeEventListener("abort", cancel);
    await handle.dispose();
  }

  const content = bridge.finalText();
  const usage = bridge.usage;
  recordUsage(app.id, usage);
  if (!content && !bridge.finishError && !failed) {
    emit({
      type: "error",
      message: limitHit
        ? `Stopped at the ${limitHit.kind.replace("_", " ")} limit before an answer.`
        : "The model returned an empty reply.",
    });
  }
  appendSessionTurn(sessionId, question, content);
  const clean = content && !bridge.finishError && !failed && !limitHit;
  if (cacheKey && clean) {
    writeAnswerCache(cacheKey, { events: recorded, content, citations: bridge.citations() });
  }
  return finish({
    content,
    citations: bridge.citations(),
    toolCalls: bridge.toolCalls,
    usage,
    model: endpoint.model,
    cached: false,
    limitHit,
  });
}
