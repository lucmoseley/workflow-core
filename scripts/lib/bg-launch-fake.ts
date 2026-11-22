import fs from "node:fs";
import path from "node:path";
import { buildJobIdWord } from "./claude-stub";
import { shellQuote } from "./sh-quote.js";

export type LaunchKind = "prompted" | "idle" | "positional" | "named";
export type RmKind = "ok" | "noJob";

export interface Answer {
	id: string;
	status: number;
	stdout: string;
	stderr: string;
}

export const recorded: {
	harness: string;
	launches: Record<LaunchKind, Answer & { argv: string[] }>;
	removals: Record<RmKind, Answer>;
} = JSON.parse(
	fs.readFileSync(
		path.join(__dirname, "..", "fixtures", "bg-launch.json"),
		"utf8",
	),
);

export const UNRECORDED = {
	silent: { status: 0, stdout: "", stderr: "" },
	refused: { status: 1, stdout: "", stderr: "could not start\n" },
};

export function buildRecordedAnswer(id: string, kind: LaunchKind = "prompted") {
	const r = recorded.launches[kind];
	return {
		stdout: r.stdout.replaceAll(r.id, id),
		stderr: r.stderr.replaceAll(r.id, id),
	};
}

export function writeLaunchAnswer(
	dir: string,
	id: string,
	kind: LaunchKind = "prompted",
) {
	const { stdout, stderr } = buildRecordedAnswer(id, kind);
	const out = path.join(dir, "bg-launch.out");
	const err = path.join(dir, "bg-launch.err");
	fs.writeFileSync(out, stdout);
	fs.writeFileSync(err, stderr);
	return { out, err };
}

export function buildAnswerBranch(r: Omit<Answer, "id">) {
	return `printf '%s' ${shellQuote(r.stdout)}; printf '%s' ${shellQuote(r.stderr)} >&2; exit ${r.status}`;
}

export function buildLaunchNodeAnswer(
	idExpr: string,
	kind: LaunchKind = "prompted",
) {
	const r = recorded.launches[kind];
	const print = (stream: string, text: string) =>
		`process.${stream}.write(${JSON.stringify(text)}.replaceAll(${JSON.stringify(r.id)},${idExpr}));`;
	return `${print("stdout", r.stdout)}${print("stderr", r.stderr)}`;
}

export function buildRmBranch(kind: RmKind = "ok") {
	const r = recorded.removals[kind];
	return `if [ "$1" = "rm" ]; then printf '%s' ${buildJobIdWord(r.stdout, r.id)}; printf '%s' ${buildJobIdWord(r.stderr, r.id)} >&2; exit ${r.status}; fi`;
}
