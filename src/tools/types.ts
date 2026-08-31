import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { ZodType, output } from "zod";
import type { DeribitClient } from "../deribit/client.js";

export type ToolGroup = "public" | "private-read" | "private-write";

export interface ToolModule {
	name: string;
	title: string;
	description: string;
	group: ToolGroup;
	/**
	 * The Deribit RPC methods this tool calls.
	 * scripts/check-api-drift.mjs aggregates the full method list from here to
	 * reconcile against the official spec, so any added or changed call must be
	 * mirrored here — this is the single source of truth for coverage.
	 */
	methods: readonly string[];
	inputSchema: ZodType;
	annotations: ToolAnnotations;
	handler: (client: DeribitClient, args: never) => Promise<Record<string, unknown>>;
}

export const READ_ONLY_ANNOTATIONS: ToolAnnotations = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: true,
};

/** Creates something new without destroying anything existing: placing orders, creating combos. */
export const PLACE_ANNOTATIONS: ToolAnnotations = {
	readOnlyHint: false,
	destructiveHint: false,
	idempotentHint: false,
	openWorldHint: true,
};

/** Mutates or wipes existing state: editing orders, cancelling, closing positions. */
export const DESTRUCTIVE_ANNOTATIONS: ToolAnnotations = {
	readOnlyHint: false,
	destructiveHint: true,
	idempotentHint: false,
	openWorldHint: true,
};

export function defineTool<S extends ZodType>(spec: {
	name: string;
	title: string;
	description: string;
	group: ToolGroup;
	methods: readonly string[];
	inputSchema: S;
	annotations?: ToolAnnotations;
	handler: (client: DeribitClient, args: output<S>) => Promise<Record<string, unknown>>;
}): ToolModule {
	return {
		...spec,
		annotations: spec.annotations ?? READ_ONLY_ANNOTATIONS,
	} as ToolModule;
}
