export interface LivenessRecord {
	firstListedAt: number | null;
	description: string;
	status:
		| "pending"
		| "running"
		| "waiting"
		| "idle"
		| "completed"
		| "failed"
		| "killed"
		| null;
	quietSince: number | null;
	steps: number;
	phaseSince: number | null;
	isStepping: boolean;
	tools: string[];
	isStalled: boolean;
}

export interface LivenessRow {
	id: string;
	description: string;
	type: string;
	status: NonNullable<LivenessRecord["status"]>;
	steps: number;
	phase: string | null;
	stall: string | null;
}

