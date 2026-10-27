/*
 * The fake of the launcher's `claude agents --json` and `claude stop`: the
 * installed harness's recorded responses (scripts/fixtures/agents-stop.json,
 * re-recorded by `node scripts/record-claude-responses.js`), as the branches
 * of a bash `claude` stub (#2988).
 */

import fs from "node:fs";
import path from "node:path";

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

/* `text` as one bash ANSI-C word, every `id` in it spliced as "$2". */
const bashWord = (text: string, id?: string) =>
	(id ? text.split(id) : [text])
		.map((part) => `$'${part.replace(/[\\']/g, "\\$&").replace(/\n/g, "\\n")}'`)
		.join('"$2"');

/** The `agents` branch: prints `listing`, or fails where it is null. */
export const buildAgentsBranch = (listing: Row[] | null) =>
	`if [ "$1" = "agents" ]; then ${listing ? `printf '%s' ${bashWord(JSON.stringify(listing))}; exit 0` : "exit 1"}; fi`;

/** The `stop` branch: appends its argv to `log`, then answers as the
 * recording's `kind` stop, of job `$2`. */
export function buildStopBranch(log: string, kind: StopKind = "ok") {
	const r = recorded.stops[kind];
	return `if [ "$1" = "stop" ]; then echo "$*" >> ${JSON.stringify(log)}; printf '%s' ${bashWord(r.stdout, r.id)}; printf '%s' ${bashWord(r.stderr, r.id)} >&2; exit ${r.status}; fi`;
}
