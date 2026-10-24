/*
 * The liveness mod's `$.state` contract: one record per subagent loop it has
 * seen a step from or listed, keyed by `agentId`. Held by the host, so a hot
 * reload of the module keeps it (workflow-core#863 §What it watches).
 */

export interface LivenessRecord {
	/** When a tick first listed the agent; null while the list never has. */
	firstListedAt: number | null;
	/** Its task description and status as last listed. */
	description: string;
	/* The engine's `AgentStatus`, spelled out: a contract imports nothing. */
	status:
		| "pending"
		| "running"
		| "waiting"
		| "idle"
		| "completed"
		| "failed"
		| "killed"
		| null;
	/** Where its quiet clock runs from: its latest step's start, its first
	 * listing where none was seen, or its latest return to `running`. */
	quietSince: number | null;
	/** Model steps started in its loop that this session has seen. */
	steps: number;
	/** When its current phase began: a step's start or end, or its listing. */
	phaseSince: number | null;
	/** True from a step's start until its result or failure. */
	isStepping: boolean;
	/** The tools its latest step's result called, the engine's hand-back left out. */
	tools: string[];
	/** True from a stall's onset until it ends, so a reload never toasts it twice. */
	isStalled: boolean;
}

/** One pane row as the latest tick wrote it, in the list's order (workflow-core#866). */
export interface LivenessRow {
	id: string;
	description: string;
	type: string;
	status: NonNullable<LivenessRecord["status"]>;
	steps: number;
	/** What a `running` agent is doing and for how long; null otherwise. */
	phase: string | null;
	/** How long a stalled agent has been quiet; null while it is not. */
	stall: string | null;
}

declare module "claude-code" {
	interface PluginState {
		"workflow-core": {
			records: Record<string, LivenessRecord>;
			rows: LivenessRow[];
		};
	}
}
