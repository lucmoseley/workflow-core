/*
 * The shared checker-run fake (§G7, #5148): lib/morning-review-filing.js's
 * `runChecker` and `startChecker` ports, answering each core checker's
 * `--json` run with a recorded envelope in-process, never a node start.
 * checker-run.contract.test.ts holds each envelope to its real checker's,
 * run as the shell's adapters run it: the same keys, each of the same type,
 * and the same outcome.
 */

export interface CheckerRun {
	error?: Error | null;
	stdout: string;
	status: number | null;
}

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

/** check-primitives.js on a tree whose tables name no program: its count line. */
export const PRIMITIVES_ENVELOPE = {
	...frame(
		"primitives",
		"OK",
		"primitives: 3 enforced, 0 open breaches, 0 gaps",
	),
	rows: 3,
	countLine: "primitives: 3 enforced, 0 open breaches, 0 gaps",
};

/** check-idle-efforts.js with the refill loop stopped and no tracker read. */
export const IDLE_ENVELOPE = {
	...frame(
		"idle-efforts",
		"WARN",
		"The refill loop is not running, so it serves no tracker.",
	),
	trackers: [] as unknown[],
	loopRunning: false,
	damaged: [] as string[],
};

/** check-wsl-currency.js off WSL: a SKIP. */
export const WSL_SKIP_ENVELOPE = frame(
	"wsl-currency",
	"SKIP",
	"SKIP: the kernel release carries no `microsoft`, so this is not WSL.",
);

/** Each core checker's envelope, by script. */
export const CHECKER_ENVELOPES: Record<string, object> = {
	"check-primitives.js": PRIMITIVES_ENVELOPE,
	"check-idle-efforts.js": IDLE_ENVELOPE,
	"check-wsl-currency.js": WSL_SKIP_ENVELOPE,
};

/** `envelope` as its checker prints it, exit 0. */
export const printedRun = (envelope: object): CheckerRun => ({
	error: null,
	stdout: `${JSON.stringify(envelope, null, 2)}\n`,
	status: 0,
});

/**
 * The two checker ports, each script answered by `runs`, the recorded
 * envelopes where it names none.
 */
export function checkerFake(runs: Record<string, CheckerRun> = {}) {
	const runOf = (script: string): CheckerRun => {
		const given = runs[script];
		if (given) return given;
		const envelope = CHECKER_ENVELOPES[script];
		if (!envelope) throw new Error(`checker fake: no envelope for ${script}`);
		return printedRun(envelope);
	};
	return {
		runChecker: (script: string) => runOf(script),
		startChecker: (script: string) => ({
			settle: async () => runOf(script),
			/* A recorded run has no process to kill. */
			stop: () => undefined,
		}),
	};
}
