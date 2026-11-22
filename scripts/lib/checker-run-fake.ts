import type { CheckerRun } from "./checker-run.js";

const frame = (checker: string, outcome: string, summary: string) => ({
	checker,
	outcome,
	exit: 0,
	count: 0,
	keys: [] as string[],
	noun: "finding(s)",
	summary,
	findings: [] as unknown[],
});

const PRIMITIVES_ENVELOPE = {
	...frame(
		"primitives",
		"OK",
		"primitives: 3 enforced, 0 open breaches, 0 gaps",
	),
	rows: 3,
	countLine: "primitives: 3 enforced, 0 open breaches, 0 gaps",
};

const IDLE_ENVELOPE = {
	...frame(
		"idle-efforts",
		"WARN",
		"The refill loop is not running, so it serves no tracker.",
	),
	trackers: [] as unknown[],
	loopRunning: false,
	damaged: [] as string[],
};

const WSL_SKIP_ENVELOPE = frame(
	"wsl-currency",
	"SKIP",
	"SKIP: the kernel release carries no `microsoft`, so this is not WSL.",
);

export const WSL_UNREAD_ENVELOPE = {
	...frame("wsl-currency", "WARN", "WSL currency not read"),
	state: "UNREAD",
	lines: ["WSL currency not read", "the latest release: "],
};

export const CHECKER_ENVELOPES: Record<string, object> = {
	"check-primitives.js": PRIMITIVES_ENVELOPE,
	"check-idle-efforts.js": IDLE_ENVELOPE,
	"check-wsl-currency.js": WSL_SKIP_ENVELOPE,
};

const printedRun = (envelope: object): CheckerRun => ({
	error: null,
	stdout: `${JSON.stringify(envelope, null, 2)}\n`,
	status: 0,
});

export function checkerFake(envelopes: Record<string, object> = {}) {
	const runOf = (script: string): CheckerRun => {
		const envelope = envelopes[script] ?? CHECKER_ENVELOPES[script];
		if (!envelope) throw new Error(`checker fake: no envelope for ${script}`);
		return printedRun(envelope);
	};
	return {
		runChecker: (script: string) => runOf(script),
		startChecker: (script: string) => ({
			settle: async () => runOf(script),
			stop: () => undefined,
		}),
	};
}
