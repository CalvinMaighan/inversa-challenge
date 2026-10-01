import type { z } from "zod";

import type { AgentStreamEvent, BBox, EvidenceKind } from "@/shared/agent/events";
import type { FeedState } from "@/shared/feed-state";

/**
 * C14 kinds. `backtest:<species>:<days>` was accepted into C14 after
 * `shared/agent/events.ts` was written, so it is added here until EvidenceKind carries it.
 */
export type CitableKind = EvidenceKind | "backtest";

/** One citable record (PLAN.md C14). `id` is `<kind>:<key>`. */
export type Evidence = { id: string; kind: CitableKind; label: string };

/** What every capability returns: model-facing data plus its evidence and feed envelopes. */
export type CapabilityOutput = {
  /** Serialized to JSON for the model. */
  data: Record<string, unknown>;
  evidence: Evidence[];
  /** C3 envelopes for the sources this result depends on. */
  feeds: FeedState[];
  /** Row count for the UI tool row. */
  count: number;
};

export type AgentView = { bbox: BBox; time: string; layers: string[]; species?: string[]; selection: string | null };

export type CapabilityContext = {
  signal?: AbortSignal;
  /** Reference time for "now", "tonight", lookbacks: the timeline time, else the wall clock. */
  now: Date;
  view?: AgentView;
  /** For side-channel events (`view`). */
  emit: (event: AgentStreamEvent) => void;
};

export type Capability<TInput = unknown> = {
  name: string;
  description: string;
  inputSchema: z.ZodType<TInput>;
  execute: (input: TInput, ctx: CapabilityContext) => Promise<CapabilityOutput>;
};

// Heterogeneous registry: each capability's input type is checked at its own definition.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyCapability = Capability<any>;

export type CapabilityResult =
  | { ok: true; output: CapabilityOutput }
  | { ok: false; code: "invalid_input" | "error" | "unknown"; error: string };

/** Zod-validated capability registry. Every tool call runs through `execute()`. */
export class CapabilityRegistry {
  private readonly capabilities = new Map<string, AnyCapability>();

  register<TInput>(cap: Capability<TInput>): this {
    if (this.capabilities.has(cap.name)) throw new Error(`Capability already registered: ${cap.name}`);
    this.capabilities.set(cap.name, cap as AnyCapability);
    return this;
  }

  list(): AnyCapability[] {
    return [...this.capabilities.values()];
  }

  get(name: string): AnyCapability | undefined {
    return this.capabilities.get(name);
  }

  async execute(name: string, rawInput: unknown, ctx: CapabilityContext): Promise<CapabilityResult> {
    const cap = this.capabilities.get(name);
    if (!cap) return { ok: false, code: "unknown", error: `Unknown capability: ${name}` };
    const parsed = cap.inputSchema.safeParse(rawInput ?? {});
    if (!parsed.success) {
      return {
        ok: false,
        code: "invalid_input",
        error: `Invalid input for ${name}: ${parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "(root)"} ${issue.message}`)
          .join("; ")}`,
      };
    }
    try {
      return { ok: true, output: await cap.execute(parsed.data, ctx) };
    } catch (error) {
      return { ok: false, code: "error", error: error instanceof Error ? error.message : "Capability failed" };
    }
  }
}
