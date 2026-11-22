import { execFileSync } from "node:child_process";
import crypto from "node:crypto";

const SHORT = 7;
const SHAPES = {
	digits: new RegExp(`^\\d{${SHORT}}`),
	letters: new RegExp(`^[a-f]{${SHORT}}`),
};
// measured odds of all missing e^-111, #3230
const TRIES = 100_000;
const FIRST_DATE = 1_700_000_000;

const buildCommitBody = (
	tree: string,
	parent: string,
	at: number,
	subject: string,
) =>
	`tree ${tree}\nparent ${parent}\nauthor t <t@t> ${at} +0000\ncommitter t <t@t> ${at} +0000\n\n${subject}\n`;

const gitIn = (cwd: string) => (args: string[], input?: string) =>
	execFileSync("git", args, { cwd, encoding: "utf8", input }).trim();

const readHead = (cwd: string) => {
	const git = gitIn(cwd);
	return {
		tree: git(["rev-parse", "HEAD^{tree}"]),
		parent: git(["rev-parse", "HEAD"]),
	};
};

const commitWriter = (cwd: string) => (body: string) =>
	gitIn(cwd)(["hash-object", "-t", "commit", "-w", "--stdin"], body);

const shaOf = (body: string) =>
	crypto
		.createHash("sha1")
		.update(`commit ${Buffer.byteLength(body)}\0${body}`)
		.digest("hex");

export function hexShaCommit(
	cwd: string,
	subject: string,
	shape: keyof typeof SHAPES,
): { sha: string; short: string } {
	const { tree, parent } = readHead(cwd);
	const writeCommit = commitWriter(cwd);
	for (let at = FIRST_DATE; at < FIRST_DATE + TRIES; at++) {
		const body = buildCommitBody(tree, parent, at, subject);
		const sha = shaOf(body);
		if (!SHAPES[shape].test(sha)) continue;
		writeCommit(body);
		gitIn(cwd)(["update-ref", "HEAD", sha]);
		return { sha, short: sha.slice(0, SHORT) };
	}
	throw new Error(`no all-${shape} short sha in ${TRIES} dates`);
}

// measured odds of all missing e^-149, #3233
const PAIR_TRIES = 200_000;

export function sharedShortShaCommits(
	cwd: string,
	subjects: [string, string],
): { shas: [string, string]; short: string } {
	const { tree, parent } = readHead(cwd);
	const writeCommit = commitWriter(cwd);
	const seen: [Map<string, string>, Map<string, string>] = [
		new Map(),
		new Map(),
	];
	for (let at = FIRST_DATE; at < FIRST_DATE + PAIR_TRIES; at++) {
		for (const side of [0, 1] as const) {
			const body = buildCommitBody(tree, parent, at, subjects[side]);
			const short = shaOf(body).slice(0, SHORT);
			const other = seen[side === 0 ? 1 : 0].get(short);
			if (other === undefined) {
				seen[side].set(short, body);
				continue;
			}
			const bodies = side === 0 ? [body, other] : [other, body];
			const shas = bodies.map(writeCommit) as [string, string];
			return { shas, short };
		}
	}
	throw new Error(`no shared short sha in ${PAIR_TRIES} dates a side`);
}
