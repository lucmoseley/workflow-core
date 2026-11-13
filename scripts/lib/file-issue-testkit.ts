/*
 * The sandbox file-issue's tests share (#5150): its program cases, which run
 * scripts/file-issue.js through runInProcess against file-issue's gh fake as
 * the WFC_GH stub, the real link underneath, and its module cases, which call
 * lib/file-issue-core.js's fileIssue with the same gh fake in-process and the
 * link fake. One routing source serves both, so a case reads the same
 * whichever seam it runs on.
 */

import fs from "node:fs";
import path from "node:path";
import { vi } from "vitest";
import { freshSandbox, issueClaims } from "./arbiter-testkit";
import { type FileIssuePorts, fileIssue } from "./file-issue-core.js";
import { fileIssueGh, NEW, stubFileIssueGh } from "./file-issue-gh-fake";
import { answerLink } from "./file-issue-link-fake";
import { readGateWrite } from "./gate-judge.js";
import { ORIGINS } from "./issue-origin";
import { MARKERS_REL } from "./marker-root";
import { runInProcess } from "./run-in-process";
import { shellQuote } from "./sh-quote.js";
import { TAKES_VALUES } from "./takes-label";

export const SCRIPT = path.resolve(__dirname, "..", "file-issue.js");
export const ME = "sess-me";
/** The signature line's filed-at clock in a module case. */
export const NOW = Date.parse("2026-11-13T09:00:00.000Z");

export const LABELS = [
	...TAKES_VALUES.map((v) => `takes:${v}`),
	"kind:spec",
	"kind:ticket",
	"kind:brief",
	"wayfinder:map",
	"wayfinder:grilling",
	"wayfinder:research",
	"urgent",
	...ORIGINS.map((o: string) => `origin:${o}`),
	"fault-signature",
];

/* Every filing's declarations (#4796), added to a call that names none. */
export const DECLARED = ["--origin", "triage", "--no-fault"];
const DECLARATION_FLAGS = ["--origin", "--no-fault", "--fault-signature"];

export const issue = (number: number, labels: string[], over: object = {}) => ({
	number,
	title: `issue ${number}`,
	state: "open",
	labels: labels.map((name) => ({ name })),
	body: "",
	parent_issue_url: null,
	...over,
});

export const filing = (labels: string[], placement = ["--parent", "528"]) => [
	"--title",
	"A new ticket",
	...labels.flatMap((l) => ["--label", l]),
	...placement,
	"--body-file",
	"-",
];

export const ASSIGN_CALL = `issue edit ${NEW} --repo acme/widgets --add-assignee @me`;

export interface Row {
	number: number;
	state: string;
	title: string;
}

/** The issue numbers a similar-title list printed, in its order. */
export const listed = (stdout: string) =>
	[...stdout.matchAll(/^ {2}#(\d+) /gm)].map((m) => Number(m[1]));

/*
 * A small tracker, scored for "Generate a sitemap and robots file": #1 11.7,
 * #5 and #6 8.8, #2 8.6 — cut as the fourth — and #3 5.8, under 6. A hundred
 * filler titles make the four shared words rare.
 */
export const TRACKER: Row[] = [
	{ number: 1, state: "OPEN", title: "Generate the sitemap and robots file" },
	{ number: 2, state: "OPEN", title: "Robots file for the sitemap" },
	{ number: 3, state: "OPEN", title: "Sitemap and robots crawl budget" },
	{ number: 4, state: "CLOSED", title: "Generate the sitemap and robots file" },
	{ number: 5, state: "OPEN", title: "Generate the sitemap file nightly" },
	{ number: 6, state: "OPEN", title: "Generate a robots file" },
	...Array.from({ length: 100 }, (_, i) => ({
		number: 7 + i,
		state: "OPEN",
		title: `Filler ticket ${7 + i}`,
	})),
];

export interface RunOpts {
	stdin?: string;
	sessionId?: string | null;
	bare?: boolean;
	cwd?: string;
	extraEnv?: NodeJS.ProcessEnv;
}

export interface Ran {
	status: number | null;
	stdout: string;
	stderr: string;
}

const declare = (args: string[], bare: boolean) =>
	bare ||
	args.includes("--check") ||
	args.some((a) => DECLARATION_FLAGS.includes(a))
		? args
		: [...args, ...DECLARED];

/** The sandbox, its fixtures and both runners; call once per test file. */
export function fileIssueKit() {
	const sb = freshSandbox((s) => {
		fs.mkdirSync(path.join(s.repo, ".claude"), { recursive: true });
		fs.writeFileSync(
			path.join(s.repo, ".claude", "workflow-core.json"),
			JSON.stringify({ contract: 1, founder: "T", tracker: "acme/widgets" }),
		);
	});

	const at = (name: string) => path.join(sb.dir, name);

	/** Serve `body` for `gh api <apiPath>`. */
	const serve = (apiPath: string, body: unknown) => {
		fs.mkdirSync(at("api"), { recursive: true });
		fs.writeFileSync(
			path.join(at("api"), apiPath.replaceAll("/", "_")),
			JSON.stringify(body),
		);
	};

	/**
	 * Serve `rows` for the similar-title list's `issue list` fetches — the whole
	 * tracker, and its open rows for `--state open` — with no closed-title cache,
	 * so the next call pulls the whole tracker.
	 */
	const serveIssues = (rows: Row[]) => {
		fs.writeFileSync(at("issues"), JSON.stringify(rows));
		fs.writeFileSync(
			at("issues-open"),
			JSON.stringify(rows.filter((r) => r.state === "OPEN")),
		);
		fs.rmSync(path.join(sb.repo, MARKERS_REL, "closed-titles"), {
			recursive: true,
			force: true,
		});
	};

	const setUp = (parentLabels: string[] = ["kind:spec"], over: object = {}) => {
		serve(
			"repos/acme/widgets/labels",
			LABELS.map((name) => ({ name })),
		);
		serve("repos/acme/widgets/issues/528", issue(528, parentLabels, over));
		serve("repos/acme/widgets/issues/528/sub_issues", [[]]);
	};

	/** file-issue's gh fake as the WFC_GH stub. */
	const ghStub = () => stubFileIssueGh(sb.dir);

	/** The liveness oracle, listing exactly `ids`. */
	const oracle = (ids: string[]) => {
		const bin = at("claude-agents");
		fs.writeFileSync(
			bin,
			`#!/bin/sh\necho ${shellQuote(JSON.stringify(ids.map((sessionId) => ({ sessionId }))))}\n`,
		);
		fs.chmodSync(bin, 0o755);
		return bin;
	};

	const readGhCalls = () =>
		fs.existsSync(at("gh-calls"))
			? fs.readFileSync(at("gh-calls"), "utf8").split("\n").filter(Boolean)
			: [];
	const readCreates = () =>
		readGhCalls().filter((c) => c.startsWith("issue create"));
	const readClaimants = () =>
		issueClaims
			.readIssueClaims(NEW)
			.map((e: { record: { sessionId: string } }) => e.record.sessionId);
	const readBodySeen = () => fs.readFileSync(at("body-seen"), "utf8");
	/** Each link the module cases' link fake was asked for, `<parent> <child>`. */
	const readLinks = () =>
		fs.existsSync(at("links"))
			? fs.readFileSync(at("links"), "utf8").split("\n").filter(Boolean)
			: [];

	/** scripts/file-issue.js through runInProcess, on the gh stub. */
	const program = (
		args: string[],
		{
			stdin = "Ticket body.\n",
			sessionId = ME,
			bare = false,
			cwd,
			extraEnv = {},
		}: RunOpts = {},
	): Ran => {
		const env: NodeJS.ProcessEnv = {
			...process.env,
			...ghStub().env,
			WFC_CLAUDE_BIN: oracle([ME]),
			WFC_LINK_SLEEP: "0",
			WFC_LINK_RETRIES: "2",
			CLAUDE_CODE_SESSION_ID: sessionId ?? "",
			...extraEnv,
		};
		if (sessionId === null) delete env.CLAUDE_CODE_SESSION_ID;
		return runInProcess(SCRIPT, declare(args, bare), { env, stdin, cwd });
	};

	const has = (name: string) => fs.existsSync(at(name));

	/** lib/file-issue-core.js's fileIssue, its ports the module cases'. */
	const core = (
		args: string[],
		{
			stdin = "Ticket body.\n",
			sessionId = ME,
			bare = false,
			extraEnv = {},
			ports = {},
		}: Omit<RunOpts, "cwd"> & { ports?: Partial<FileIssuePorts> } = {},
	): Ran => {
		vi.stubEnv("WFC_CLAUDE_BIN", oracle([ME]));
		vi.stubEnv("CLAUDE_CODE_SESSION_ID", sessionId ?? undefined);
		for (const [k, v] of Object.entries(extraEnv)) vi.stubEnv(k, v);
		const { code, stdout, stderr } = fileIssue(declare(args, bare), {
			gh: fileIssueGh(sb.dir),
			link: (_repo, parent, child) => {
				fs.appendFileSync(at("links"), `${parent} ${child}\n`);
				return answerLink(
					parent,
					child,
					has("post-err") ? fs.readFileSync(at("post-err"), "utf8") : null,
				);
			},
			judge: (body) => readGateWrite(body, { route: "file-issue" }),
			readBody: (file) =>
				file === "-" ? stdin : fs.readFileSync(file, "utf8"),
			now: () => NOW,
			...ports,
		});
		return { status: code, stdout, stderr };
	};

	return {
		sb,
		at,
		serve,
		serveIssues,
		setUp,
		ghStub,
		oracle,
		program,
		core,
		readGhCalls,
		readCreates,
		readClaimants,
		readBodySeen,
		readLinks,
	};
}

/*
 * The filing declarations' fixtures (#4796): a session transcript whose line 2
 * is a guard's deny and line 3 the call that met it, a --fault-signature file,
 * and the outcome-signature log a filing appends to.
 */
export function declarationFixtures(kit: ReturnType<typeof fileIssueKit>) {
	const Session = "11111111-2222-3333-4444-555555555555";
	const Slug = "-home-u-repo";
	const DenyText =
		"docs/doc-map.md is held by session 735db33b (pid 1), which is still running.";
	/* A record the case names: a guard's deny, as a tool_result flagged is_error. */
	const caseRecord = {
		type: "user",
		uuid: "u-case",
		timestamp: "2026-11-01T10:00:00.000Z",
		message: {
			content: [
				{
					type: "tool_result",
					tool_use_id: "toolu_1",
					is_error: true,
					content: DenyText,
				},
			],
		},
	};
	/* The call that met the deny, on line 3: a `reads: "call"` case. */
	const callRecord = {
		type: "assistant",
		uuid: "a-call",
		timestamp: "2026-11-01T10:01:00.000Z",
		message: {
			content: [
				{
					type: "tool_use",
					id: "toolu_2",
					name: "Bash",
					input: { command: "git push --force origin main" },
				},
			],
		},
	};
	/** The session's transcript on the second seat, the case record on line 2. */
	const seatTranscript = () => {
		const dir = path.join(
			path.dirname(kit.sb.home),
			".claude2",
			"projects",
			Slug,
		);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			path.join(dir, `${Session}.jsonl`),
			[
				{ type: "user", uuid: "u0", message: { content: "hi" } },
				caseRecord,
				callRecord,
			]
				.map((r) => `${JSON.stringify(r)}\n`)
				.join(""),
		);
	};
	const sigFile = (content: unknown) => {
		const f = kit.at("sig.json");
		fs.writeFileSync(f, JSON.stringify(content));
		return f;
	};
	const declaring = (extra: string[]) => [
		...filing(["takes:implement"]),
		"--origin",
		"code-review",
		...extra,
	];
	const log = () =>
		path.join(kit.sb.repo, "docs", "data", "outcome-signatures.jsonl");
	const readLog = () =>
		fs.existsSync(log())
			? fs
					.readFileSync(log(), "utf8")
					.split("\n")
					.filter(Boolean)
					.map((l) => JSON.parse(l))
			: [];
	const regexSig = (pattern: string, scope = "main") => ({
		signature: { kind: "regex", pattern, scope },
		prediction: "the hold denials stop",
		case: { session: Session, line: 2 },
	});
	return { Session, seatTranscript, sigFile, declaring, readLog, regexSig };
}
