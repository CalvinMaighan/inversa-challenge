import { z } from "zod";
import type { Context } from "@deepseek-ai/cordis";
import type { JsonValue, ToolDefinition } from "@deepseek-ai/dsh-tools";

import type { CapabilityContext, CapabilityRegistry, Evidence } from "@/server/agent/runtime/registry";
import { viewOf, type ToolViewData } from "@/server/agent/tools/views";
import type { FeedState } from "@/shared/feed-state";

/** Structured details on each tool result. `data` is the UI payload of `tool_end`, with the C17 views. */
export type AgentToolDetails = {
  capabilityName: string;
  ok: boolean;
  data?: { count: number; evidence: Evidence[]; feeds: FeedState[] } & ToolViewData;
  error?: string;
  /** Full JSON result for the model. Dropped from the presentation meta. */
  modelText?: string;
};

/** Evidence returned by tools in this turn. The stream bridge verifies citations against it. */
export class EvidenceLedger {
  private readonly rows = new Map<string, Evidence>();

  add(rows: readonly Evidence[]): void {
    for (const row of rows) this.rows.set(row.id, row);
  }

  get(id: string): Evidence | undefined {
    return this.rows.get(id);
  }

  ids(): string[] {
    return [...this.rows.keys()];
  }
}

/** Register every registry capability as a dsh tool (zod input schema to JSON schema). */
export function bindCapabilityTools(
  agentCtx: Context,
  registry: CapabilityRegistry,
  capCtx: CapabilityContext,
  ledger: EvidenceLedger,
): void {
  for (const cap of registry.list()) {
    if (agentCtx.tools.get?.(cap.name)) continue;
    const parameters = z.toJSONSchema(cap.inputSchema, { io: "input", unrepresentable: "any" }) as Record<
      string,
      unknown
    >;
    const definition: ToolDefinition = {
      name: cap.name,
      description: cap.description,
      parameters,
      output: {
        schema: { type: "object", additionalProperties: true },
        render(_args, value) {
          const details = value as AgentToolDetails;
          if (!details.ok) return [{ type: "text", text: `Error: ${details.error ?? "failed"}` }];
          return [{ type: "text", text: details.modelText ?? JSON.stringify(details.data) }];
        },
        // The model sees the full result; the UI row gets counts, evidence and feed states.
        presentationMeta(_args, value) {
          const meta: AgentToolDetails = { ...(value as AgentToolDetails) };
          delete meta.modelText;
          return JSON.parse(JSON.stringify(meta)) as JsonValue;
        },
      },
      async execute(args) {
        const result = await registry.execute(cap.name, args, capCtx);
        if (!result.ok) {
          return { capabilityName: cap.name, ok: false, error: result.error } satisfies AgentToolDetails;
        }
        ledger.add(result.output.evidence);
        return {
          capabilityName: cap.name,
          ok: true,
          data: { count: result.output.count, evidence: result.output.evidence, feeds: result.output.feeds, ...viewOf(result.output) },
          modelText: JSON.stringify(result.output.data),
        } satisfies AgentToolDetails;
      },
    };
    agentCtx.tools.register(definition);
  }
}
