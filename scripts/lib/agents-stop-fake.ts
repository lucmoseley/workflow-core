/*
 * The fake of the launcher's `claude agents --json` and `claude stop`: the
 * installed harness's recorded responses (scripts/fixtures/agents-stop.json,
 * re-recorded by `node scripts/record-claude-responses.js`), as the branches
 * of a bash `claude` stub (#2988).
 */

import fs from "node:fs";
import path from "node:path";
import { buildJobIdWord } from "./claude-stub";
import { shellQuote } from "./sh-quote.js";

export type StopKind = "ok" | "noJob";

export type Row = Record<string, string | number>;

interface Stop {
	id: string;
	status: number;
	stdout: string;
	stderr: string;
}

export const recorded: {
	harness: string;
	rows: Row[];
	stops: Record<StopKind, Stop>;
} = JSON.parse(
	fs.readFileSync(
		path.join(__dirname, "..", "fixtures", "agents-stop.json"),
		"utf8",
	),
);

/** Whether `row` is a job's waiting on a permission prompt. */
export const isPermissionRow = (row: Row) => row.status === "waiting";

/* The recorded row printing the most fields, a waiting row's `waitingFor`
 * aside: a just-launched row lacks `pid` and `status`. */
const fullest = recorded.rows
	.filter((row) => !isPermissionRow(row))
	.reduce((a, b) => (Object.keys(b).length > Object.keys(a).length ? b : a));
const printed = new Set(recorded.rows.flatMap((row) => Object.keys(row)));
const pairOf = (row: Row) => `${row.status}/${row.state}`;
const pairs = new Set(recorded.rows.map(pairOf));

/**
 * A listing row of the recording's shape with `over`'s values. A field the
 * harness never printed throws, as does a status and state it never printed
 * together.
 */
export function buildListedRow(over: Row): Row {
	for (const key of Object.keys(over))
		if (!printed.has(key))
			throw new Error(`${recorded.harness} lists no "${key}"`);
	const row = { ...fullest, ...over };
	if (!pairs.has(pairOf(row)))
		throw new Error(`${recorded.harness} lists no ${pairOf(row)} row`);
	return row;
}

/** Job `id`'s listing row in `state`: `busy` while working, else `idle`. */
export const buildJobRow = (id: string, state: string, over: Row = {}): Row =>
	buildListedRow({
		id,
		sessionId: `s-${id}`,
		kind: "background",
		status: state === "working" ? "busy" : "idle",
		state,
		...over,
	});

/** Job `id` blocked on a permission prompt, as the listing shows it. */
export const buildPermissionRow = (id: string): Row =>
	buildJobRow(id, "blocked", {
		status: "waiting",
		waitingFor: "permission prompt",
	});

/** The `agents` branch: prints `listing`, or fails where it is null. */
export const buildAgentsBranch = (listing: Row[] | null) =>
	`if [ "$1" = "agents" ]; then ${listing ? `printf '%s' ${shellQuote(JSON.stringify(listing))}; exit 0` : "exit 1"}; fi`;

/* Stop answers no daemon gives on demand, so none is recorded. */
const noJob = recorded.stops.noJob;
const FAULTS = {
	busy: "echo 'daemon socket is busy' >&2; exit 1",
	warnedNoJob: `echo 'warning: daemon slow to answer' >&2; printf '%s' ${buildJobIdWord(noJob.stderr, noJob.id)} >&2; exit ${noJob.status}`,
	killed: "echo 'going down' >&2; kill -KILL $$",
};

export type StopAnswer = StopKind | keyof typeof FAULTS;

const isFault = (answer: StopAnswer): answer is keyof typeof FAULTS =>
	answer in FAULTS;

const buildAnswer = (answer: StopAnswer) => {
	if (isFault(answer)) return FAULTS[answer];
	const r = recorded.stops[answer];
	return `printf '%s' ${buildJobIdWord(r.stdout, r.id)}; printf '%s' ${buildJobIdWord(r.stderr, r.id)} >&2; exit ${r.status}`;
};

/**
 * The `stop` branch: appends its argv to `log` and, where `envLog` is given,
 * the seat it ran on and the session identity it inherited
 * (`<CLAUDE_CONFIG_DIR> <CLAUDE_CODE_SESSION_ID> <CLAUDE_JOB_DIR>`, `none` for
 * an unset one), then answers job `$2`: as `answer`, or, where `answer` maps
 * seats to answers, as its seat's, a seat it leaves out answering `ok`.
 */
export function buildStopBranch(
	log: string,
	answer: StopAnswer | Record<string, StopAnswer> = "ok",
	envLog?: string,
) {
	const [fallback, bySeat] =
		typeof answer === "string" ? [answer, {}] : (["ok", answer] as const);
	const seatCases = Object.entries(bySeat).map(
		([seat, a]) => `${shellQuote(seat)}) ${buildAnswer(a)} ;;`,
	);
	return [
		'if [ "$1" = "stop" ]; then',
		`echo "$*" >> ${shellQuote(log)}`,
		envLog
			? `echo "\${CLAUDE_CONFIG_DIR:-none} \${CLAUDE_CODE_SESSION_ID:-none} \${CLAUDE_JOB_DIR:-none}" >> ${shellQuote(envLog)}`
			: "",
		`case "$CLAUDE_CONFIG_DIR" in ${seatCases.join(" ")} esac`,
		buildAnswer(fallback),
		"fi",
	]
		.filter(Boolean)
		.join("\n");
}
