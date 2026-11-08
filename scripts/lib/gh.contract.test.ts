// @vitest-environment node
/*
 * The shared gh fake's contract (§G7, #2207, #2781): each case runs one gh
 * call against the real binary, the WFC_GH stub and the in-process fake, all
 * fed from the fixture the case names, and asserts they give the same verdict
 * from lib/gh.js's own readers and the same JSON shape. The logged-out case
 * also runs it through serveGhStub's server (#3158). Values are never
 * compared: the fixtures are synthetic and the real tracker's data stays out
 * of them. Loosened, every suite stubbing gh stays green while production
 * misreads what a new gh release prints (#2220).
 *
 * Red after a gh upgrade: re-run the case's call by hand, copy what changed
 * into its fixture. A landed write's two recordings go red on no upgrade:
 * re-record them by their command below.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { caught } from "./caught.js";
import {
	answerLinkRead,
	asRecorded,
	BLOCKED_BY_GRAPHQL_FAKE,
	buildCreateAnswer,
	buildJqLines,
	type GhAnswer,
	GRAPHQL_FAKE,
	ghAnswerHandler,
	ghAnswerNode,
	ghComputed,
	ghFake,
	ghFakeScript,
	ghServe,
	LINK_READS,
	RECORDED_SHAPES,
	readGhAnswer,
} from "./gh-fake";
import { buildLinkReadArms, serveGhStub, stubGhScript } from "./gh-stub";
import { shellQuote } from "./sh-quote.js";

const LOGGED_OUT = path.join(__dirname, "fixtures/gh/logged-out.json");
const ISSUE_BODY = path.join(__dirname, "fixtures/gh/issue-body.json");
const ISSUE_LIST = path.join(__dirname, "fixtures/gh/issue-list.json");
const MAP_LIST = path.join(__dirname, "fixtures/gh/map-list.json");
const NOT_FOUND = path.join(__dirname, "fixtures/gh/not-found.json");
const SUB_ISSUES = path.join(__dirname, "fixtures/gh/sub-issues.json");
const SUB_ISSUES_NOT_FOUND = path.join(
	__dirname,
	"fixtures/gh/sub-issues-not-found.json",
);
const GRAPHQL_ISSUE_STATES = path.join(
	__dirname,
	"fixtures/gh/graphql-issue-states.json",
);
const GRAPHQL_BLOCKED_BY = path.join(
	__dirname,
	"fixtures/gh/graphql-blocked-by.json",
);
const ISSUES_PAGE = path.join(__dirname, "fixtures/gh/issues-page.json");
const BLOCKED_BY_PAGE = path.join(
	__dirname,
	"fixtures/gh/blocked-by-page.json",
);
const TIMELINE_PAGE = path.join(__dirname, "fixtures/gh/timeline-page.json");
const PARENT_PAGE = path.join(__dirname, "fixtures/gh/parent-page.json");
const COMMENTS_PAGE = path.join(__dirname, "fixtures/gh/comments-page.json");
const PARENT_NOT_FOUND = path.join(
	__dirname,
	"fixtures/gh/parent-not-found.json",
);
const GRAPHQL_NO_REPO = path.join(
	__dirname,
	"fixtures/gh/graphql-no-repo.json",
);
const REPO = path.join(__dirname, "fixtures/gh/repo.json");
const WSL_LATEST_RELEASE = path.join(
	__dirname,
	"fixtures/gh/wsl-latest-release.json",
);
const WSL_RELEASES = path.join(__dirname, "fixtures/gh/wsl-releases.json");
const { RELEASE_READS } = require("./wsl-currency.js") as {
	RELEASE_READS: { latest: string[]; releases: string[] };
};
const REPO_VIEW = path.join(__dirname, "fixtures/gh/repo-view.json");
const LABELS_PAGE = path.join(__dirname, "fixtures/gh/labels-page.json");
const ISSUE_LIST_ROWS = path.join(
	__dirname,
	"fixtures/gh/issue-list-rows.json",
);
const ISSUE_VIEW = path.join(__dirname, "fixtures/gh/issue-view.json");
const CHECKS_FORBIDDEN = path.join(
	__dirname,
	"fixtures/gh/checks-forbidden.json",
);
const IDLE_ISSUES_PAGE = path.join(
	__dirname,
	"fixtures/gh/idle-issues-page.json",
);
const ISSUE_CREATE = path.join(__dirname, "fixtures/gh/issue-create.json");
const ISSUE_COMMENT = path.join(__dirname, "fixtures/gh/issue-comment.json");
const ISSUE_CREATE_NO_REPO = path.join(
	__dirname,
	"fixtures/gh/issue-create-no-repo.json",
);
const ISSUE_COMMENT_NOT_FOUND = path.join(
	__dirname,
	"fixtures/gh/issue-comment-not-found.json",
);
const UNKNOWN_FLAG = path.join(__dirname, "fixtures/gh/unknown-flag.json");
const VALIDATION_FAILED = path.join(
	__dirname,
	"fixtures/gh/validation-failed.json",
);

const LINK_FIXTURES = {
	".state": path.join(__dirname, "fixtures/gh/issue-state.json"),
	".id": path.join(__dirname, "fixtures/gh/issue-id.json"),
	".[].number": path.join(__dirname, "fixtures/gh/sub-issue-numbers.json"),
};

const LIB = path.resolve(__dirname, "gh.js");
const LINK_SCRIPT = path.resolve(__dirname, "../link-sub-issue.sh");

let dir: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "gh-contract-"));
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const realGh = (process.env.PATH ?? "")
	.split(path.delimiter)
	.map((d) => path.join(d, "gh"))
	.find((f) => {
		try {
			fs.accessSync(f, fs.constants.X_OK);
			return true;
		} catch {
			return false;
		}
	});

type Shape = string | Shape[] | { [key: string]: Shape };

/** A JSON value's keys and types, its values dropped; an array by its first
 *  element. Text that is not JSON is `text`, nothing at all `empty`. */
function shapeOf(out: string): Shape {
	if (!out.trim()) return "empty";
	let value: unknown;
	try {
		value = JSON.parse(out);
	} catch {
		return "text";
	}
	const of = (v: unknown): Shape => {
		if (v === null) return "null";
		if (Array.isArray(v)) return v.length > 0 ? [of(v[0])] : [];
		if (typeof v === "object")
			return Object.fromEntries(
				Object.entries(v as object)
					.sort(([a], [b]) => a.localeCompare(b))
					.map(([k, x]) => [k, of(x)]),
			);
		return typeof v;
	};
	return of(value);
}

/** One call's verdict as lib/gh.js reads it, and the shape of what it printed. */
async function observe(call: (args: string[]) => string, args: string[]) {
	const { parseGhFailureReason } = await import(LIB);
	try {
		return { status: 0, verdict: "ok", shape: shapeOf(call(args)) };
	} catch (e) {
		const { status, stdout, stderr } = caught(e);
		return {
			status,
			verdict: parseGhFailureReason(e),
			shape: shapeOf(String(stdout ?? "")),
			stderr: String(stderr),
		};
	}
}

/** The same call through lib/gh.js with WFC_GH pointing at `bin`. */
async function throughSeam(bin: string, args: string[]) {
	const { gh } = await import(LIB);
	vi.stubEnv("WFC_GH", bin);
	return observe(gh, args);
}

const withoutText = ({ stderr: _, ...rest }: { stderr?: string }) => rest;

const stubbed = (fixture: string) =>
	stubGhScript(path.join(dir, path.basename(fixture)), ghFakeScript(fixture))
		.gh;

/** The same call through lib/gh.js against serveGhStub's server answering
 *  `fixture`, reached through its bash client. */
async function throughServed(fixture: string, args: string[]) {
	const server = await serveGhStub(ghAnswerHandler(fixture));
	try {
		return await throughSeam(
			stubGhScript(fs.mkdtempSync(path.join(dir, "served-")), server.script).gh,
			args,
		);
	} finally {
		await server.close();
	}
}

/*
 * #2220's case, and the one that runs wherever gh is installed: with no token
 * and an empty config dir, gh refuses before opening any socket. Deleting
 * GH_HOST is part of that: set, gh dials the host before it refuses. Its CI
 * markers go too: set, gh swaps that stderr for an automation hint. Its stderr
 * is compared too, being gh's own text rather than tracker data, so a
 * rewording that gh.js still happens to read as unreachable turns it red.
 * After a gh upgrade, repeat `strace -f -e trace=connect` over the call to
 * confirm it still opens no socket.
 */
// Residual: where no gh is installed this case skips, and the stubs go unchecked.
// The served stub is held on the logged-out answer alone, whose stdout is
// empty; gh-stub-server.test.ts holds its stdout round trip.
describe.skipIf(!realGh)("offline: calls a logged-out gh answers", () => {
	const loggedOut = () => {
		for (const v of [
			"GH_TOKEN",
			"GITHUB_TOKEN",
			"GH_ENTERPRISE_TOKEN",
			"GITHUB_ENTERPRISE_TOKEN",
			"GH_HOST",
			"GITHUB_ACTIONS",
			"CI",
			"BUILD_NUMBER",
			"RUN_ID",
		])
			vi.stubEnv(v, undefined);
		vi.stubEnv("GH_CONFIG_DIR", fs.mkdtempSync(path.join(dir, "gh-config-")));
	};
	const args = ["api", "repos/o/r"];

	it("a logged-out call answers alike from the real gh, the stub, the served stub, the inline node fake and the in-process fake (#2220, #3158)", async () => {
		loggedOut();
		const real = await throughSeam(realGh as string, args);
		expect(real).toMatchObject({ verdict: "unreachable" });
		expect(await throughSeam(stubbed(LOGGED_OUT), args)).toEqual(real);
		expect(await throughServed(LOGGED_OUT, args)).toEqual(real);
		const nodeFake = stubGhScript(
			path.join(dir, "node-fake"),
			`#!/usr/bin/env node\n${ghAnswerNode(LOGGED_OUT)}\n`,
		);
		expect(await throughSeam(nodeFake.gh, args)).toEqual(real);
		expect(await observe(ghFake(LOGGED_OUT), args)).toEqual(real);
	});

	/* gh parses its flags before it looks for a login. Verdict and shape only:
	 * the usage text below the first line changes with every flag gh adds. */
	it("an unknown flag answers alike from the real gh, the stub and the in-process fake", async () => {
		loggedOut();
		const flagged = [...args, "--slrup"];
		const real = await throughSeam(realGh as string, flagged);
		expect(real).toMatchObject({ verdict: "broken" });
		expect(
			withoutText(await throughSeam(stubbed(UNKNOWN_FLAG), flagged)),
		).toEqual(withoutText(real));
		expect(withoutText(await observe(ghFake(UNKNOWN_FLAG), flagged))).toEqual(
			withoutText(real),
		);
	});
});

/*
 * Read-only calls against this repo's own tracker, run where the real gh is
 * logged in (#2207). A failure's stderr carries the tracker's own words, so
 * they compare verdict and shape only.
 */
// Residual: off the founder's machine these skip, and their fixtures go unchecked.
function liveSkipReason(): string | undefined {
	if (!realGh) return "no gh on PATH";
	if (process.env.CI)
		return "CI: the live gh cases run on the founder's machine only";
	const { status } = spawnSync(realGh, ["auth", "status"], {
		stdio: "ignore",
		// A guess: it answered in 0.5 s here, and a hang should skip, not stall.
		timeout: 30_000,
	});
	return status === 0 ? undefined : "gh auth status fails: gh is not logged in";
}
let liveSkip: { reason: string | undefined } | undefined;

describe("live: read-only calls", () => {
	it.for([
		{
			what: "an issue listing",
			fixture: ISSUE_LIST,
			args: [
				"issue",
				"list",
				"--limit",
				"1",
				"--state",
				"all",
				"--label",
				"kind:ticket",
				"--json",
				"number,state,title,labels",
			],
		},
		{
			what: "an issue's body, as the takes:human relabel fetches it",
			fixture: ISSUE_BODY,
			args: ["issue", "view", "1", "--json", "body", "--jq", '.body // ""'],
		},
		{
			what: "an issue as the close guard views it",
			fixture: ISSUE_VIEW,
			// #948: closed, commented and labelled, with a parent and sub-issues.
			// Residual: a reaction on its first comment, or its parent unlinked,
			// turns this red with no gh upgrade; re-record from the same call.
			args: [
				"issue",
				"view",
				"948",
				"--json",
				"comments,title,parent,labels,body,subIssues,url,number,state",
			],
		},
		{
			what: "a map listing, as the second-map limb reads it",
			fixture: MAP_LIST,
			args: [
				"issue",
				"list",
				"--label",
				"wayfinder:map",
				"--state",
				"all",
				"--limit",
				"1",
				"--json",
				"number,body",
			],
		},
		{
			what: "a missing issue",
			fixture: NOT_FOUND,
			args: ["api", "repos/{owner}/{repo}/issues/999999999"],
		},
		{
			what: "a container's sub-issues page",
			fixture: SUB_ISSUES,
			// #2260 (a closed spec): closed children, so the page stays put.
			args: [
				"api",
				"repos/{owner}/{repo}/issues/2260/sub_issues",
				"--paginate",
				"--slurp",
			],
		},
		{
			what: "a missing issue's sub-issues",
			fixture: SUB_ISSUES_NOT_FOUND,
			args: [
				"api",
				"repos/{owner}/{repo}/issues/999999999/sub_issues",
				"--paginate",
				"--slurp",
			],
		},
		/* The REST reads whose answers the stubs build through
		 * RECORDED_SHAPES (#2895, #3133). #948 (a closed spec, with a parent) is the
		 * oldest closed issue carrying its three labels, so it stays the first
		 * row shapeOf reads; #2331 has closed blockers. */
		{
			what: "an issue-list page",
			fixture: ISSUES_PAGE,
			args: [
				"api",
				"repos/{owner}/{repo}/issues?state=closed&labels=enhancement,takes:triage,kind:spec&sort=created&direction=asc&per_page=100",
				"--paginate",
				"--slurp",
			],
		},
		{
			what: "an issue's blockers page",
			fixture: BLOCKED_BY_PAGE,
			args: [
				"api",
				"repos/{owner}/{repo}/issues/2331/dependencies/blocked_by",
				"--paginate",
				"--slurp",
			],
		},
		{
			what: "an issue's timeline page",
			fixture: TIMELINE_PAGE,
			args: [
				"api",
				"repos/{owner}/{repo}/issues/948/timeline?per_page=100",
				"--paginate",
				"--slurp",
			],
		},
		{
			what: "an issue's parent",
			fixture: PARENT_PAGE,
			args: [
				"api",
				"repos/{owner}/{repo}/issues/948/parent",
				"--paginate",
				"--slurp",
			],
		},
		{
			what: "an issue's latest-comment page, as check-issue-labels reads it",
			fixture: COMMENTS_PAGE,
			// Page 1 at one a page is #948's oldest comment, so it stays put.
			args: [
				"api",
				"repos/{owner}/{repo}/issues/948/comments?per_page=1&page=1",
				"--paginate",
				"--slurp",
			],
		},
		{
			what: "a parentless issue's parent",
			fixture: PARENT_NOT_FOUND,
			// #1 (a closed ticket) has no parent.
			args: [
				"api",
				"repos/{owner}/{repo}/issues/1/parent",
				"--paginate",
				"--slurp",
			],
		},
		{
			what: "the WSL latest-release read",
			fixture: WSL_LATEST_RELEASE,
			args: RELEASE_READS.latest,
		},
		{
			what: "the WSL release list",
			fixture: WSL_RELEASES,
			args: RELEASE_READS.releases,
		},
		{
			what: "the repo read",
			fixture: REPO,
			args: ["api", "repos/{owner}/{repo}"],
		},
		{
			what: "the default-repo read",
			fixture: REPO_VIEW,
			args: ["repo", "view", "--json", "nameWithOwner"],
		},
		{
			what: "a check-runs read, which the founder's fine-grained token is refused",
			fixture: CHECKS_FORBIDDEN,
			// The root commit. Residual: a token granted checks:read answers 200
			// and turns this red; there the 403 stays recorded, not live.
			args: [
				"api",
				"repos/{owner}/{repo}/commits/f46bfeab4aff66c57d6634b2f62fbbeaff833e11/check-runs",
			],
		},
		{
			what: "a malformed search",
			fixture: VALIDATION_FAILED,
			args: ["api", "search/issues?q="],
		},
		{
			what: "the labels page, as file-issue.js checks a label against it",
			fixture: LABELS_PAGE,
			args: ["api", "repos/{owner}/{repo}/labels", "--paginate", "--slurp"],
		},
		{
			what: "an issue listing with every field a stub's rows carry",
			fixture: ISSUE_LIST_ROWS,
			// #948 again: the oldest closed issue with these labels, and commented.
			args: [
				"issue",
				"list",
				"--state",
				"closed",
				"--search",
				"sort:created-asc label:enhancement label:takes:triage label:kind:spec",
				"--limit",
				"1",
				"--json",
				"number,title,state,createdAt,closedAt,url,body,labels,comments",
			],
		},
		/* Writes that write nothing: the target does not exist. */
		{
			what: "a create on a missing repository",
			fixture: ISSUE_CREATE_NO_REPO,
			args: [
				"issue",
				"create",
				"--repo",
				"wfc-no-such-owner-999999999/wfc-no-such-repo-999999999",
				"--title",
				"x",
				"--body",
				"x",
			],
		},
		{
			what: "a comment on a missing issue",
			fixture: ISSUE_COMMENT_NOT_FOUND,
			args: ["issue", "comment", "999999999", "--body", "x"],
		},
	])(
		"$what answers alike from the real gh, the stub and the in-process fake",
		async ({ fixture, args }, ctx) => {
			liveSkip ??= { reason: liveSkipReason() };
			const { reason } = liveSkip;
			if (reason) return ctx.skip(reason);
			const real = await throughSeam(realGh as string, args);
			expect(withoutText(await throughSeam(stubbed(fixture), args))).toEqual(
				withoutText(real),
			);
			expect(withoutText(await observe(ghFake(fixture), args))).toEqual(
				withoutText(real),
			);
		},
	);
});

/*
 * The computed answers (#2873): each fake builds its answer from the call's
 * own arguments, so each case first records the call production makes,
 * through the fake, then sends that call to the real gh. The fake writes its
 * stderr itself, so these compare stderr too: gh prints GraphQL's own
 * messages, which name only the numbers and repository asked. #2331 (a
 * closed ticket) has closed blockers and #2327 is closed, so neither answer
 * moves; 999999999 resolves to nothing.
 */
describe("live: computed answers", () => {
	const answerGraphql = ghComputed<
		(
			argv: string[],
			closed: string[],
			missing: string[],
			missingRepos: string[],
		) => GhAnswer
	>(GRAPHQL_FAKE, "answerGraphql");
	const answerBlockedBy = ghComputed<
		(argv: string[], rowsOf: (n: number) => object[] | null) => GhAnswer
	>(BLOCKED_BY_GRAPHQL_FAKE, "answerBlockedBy");

	/** A WFC_GH stub serving `call` and logging each argv to `log`. */
	const computedStub = (source: string, call: string, log: string) =>
		stubGhScript(
			fs.mkdtempSync(path.join(dir, "computed-")),
			`#!/usr/bin/env node\n${source}\nconst argv = process.argv.slice(2);\nrequire("node:fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify(argv) + "\\n");\nserveAnswer(${call});\n`,
		).gh;

	const noRepo = "wfc-no-such-repo-999999999";
	/** This repo's tracker as `owner/name`, read once from the live gh. */
	let tracker: string | undefined;
	const readTracker = () => {
		tracker ??= spawnSync(
			realGh as string,
			["api", "repos/{owner}/{repo}", "--jq", ".full_name"],
			{ encoding: "utf8" },
		).stdout.trim();
		return tracker;
	};
	const readOwner = () => readTracker().split("/")[0];

	it("each GraphQL fake builds from the fixture its live case holds", () => {
		expect(GRAPHQL_FAKE).toContain(
			JSON.stringify(readGhAnswer(GRAPHQL_ISSUE_STATES)),
		);
		expect(GRAPHQL_FAKE).toContain(
			JSON.stringify(readGhAnswer(GRAPHQL_NO_REPO).stdout),
		);
		expect(BLOCKED_BY_GRAPHQL_FAKE).toContain(
			JSON.stringify(readGhAnswer(GRAPHQL_BLOCKED_BY)),
		);
	});

	const blockers = (n: number) =>
		n === 2331
			? [{ number: 2327, state: "closed", labels: ["kind:ticket"] }]
			: null;

	it.for([
		{
			what: "every issue found",
			refs: "#2327 (a)",
			missing: [] as string[],
			missingRepo: false,
		},
		{
			what: "one issue missing",
			refs: "#2327 (a), #999999999 (b)",
			missing: ["999999999"],
			missingRepo: false,
		},
		{
			what: "one issue and one repository missing",
			refs: `#2327 (a), #999999999 (b), ${noRepo}#3 (c)`,
			missing: ["999999999"],
			missingRepo: true,
		},
	])(
		"lib/outstanding-line.js's batched read, $what, answers alike from the real gh, the stub and the in-process fake",
		async ({ refs, missing, missingRepo }, ctx) => {
			liveSkip ??= { reason: liveSkipReason() };
			if (liveSkip.reason) return ctx.skip(liveSkip.reason);
			const { judge } = await import("./outstanding-line.js");
			const closed = ["2327"];
			const missingRepos = missingRepo ? [`${readOwner()}/${noRepo}`] : [];
			const asked: string[][] = [];
			const recording = (argv: string[]) => {
				asked.push(argv);
				return ghServe(answerGraphql(argv, closed, missing, missingRepos))(
					argv,
				);
			};
			judge(`**Outstanding:** ${refs}`, {
				grammar: "outstanding",
				tracker: readTracker(),
				log: null,
				gh: recording,
			});
			expect(asked).toHaveLength(1);
			const args = asked[0] as string[];
			const real = await throughSeam(realGh as string, args);
			const stub = computedStub(
				GRAPHQL_FAKE,
				`answerGraphql(argv, ${JSON.stringify(closed)}, ${JSON.stringify(missing)}, ${JSON.stringify(missingRepos)})`,
				path.join(dir, "graphql-calls"),
			);
			expect(await throughSeam(stub, args)).toEqual(real);
			expect(
				await observe(
					ghServe(answerGraphql(args, closed, missing, missingRepos)),
					args,
				),
			).toEqual(real);
		},
	);

	it("lib/blocked-by-batch.js's batched read answers alike from the real gh, the stub and the in-process fake", async ({
		skip,
	}) => {
		liveSkip ??= { reason: liveSkipReason() };
		if (liveSkip.reason) return skip(liveSkip.reason);
		const { blockedByMany } = await import("./blocked-by-batch.js");
		const log = path.join(dir, "blocked-by-calls");
		const stub = computedStub(
			BLOCKED_BY_GRAPHQL_FAKE,
			`argv[1] === "graphql" ? answerBlockedBy(argv, ${blockers}) : ${JSON.stringify(readGhAnswer(NOT_FOUND))}`,
			log,
		);
		vi.stubEnv("WFC_GH", stub);
		await blockedByMany([{ number: 2331 }, { number: 999_999_999 }], {
			repo: "{owner}/{repo}",
			home: null,
		});
		const args: string[] = fs
			.readFileSync(log, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line))
			.find((argv: string[]) => argv[1] === "graphql");
		const real = await throughSeam(realGh as string, args);
		expect(real).toMatchObject({ verdict: "broken" });
		expect(await throughSeam(stub, args)).toEqual(real);
		expect(
			await observe(ghServe(answerBlockedBy(args, blockers)), args),
		).toEqual(real);
	});

	/* Production's own flags, narrowed to the issue-list page's rows so #948
	 * stays first and the read stays a few pages (#3833). */
	it("lib/gh.js's issues-since read answers alike from the real gh, the stub and the in-process fake", async ({
		skip,
	}) => {
		liveSkip ??= { reason: liveSkipReason() };
		if (liveSkip.reason) return skip(liveSkip.reason);
		const { ghIssuesUpdatedSince } = await import(LIB);
		const log = path.join(dir, "since-calls");
		vi.stubEnv(
			"WFC_GH",
			computedStub(
				BLOCKED_BY_GRAPHQL_FAKE,
				JSON.stringify(readGhAnswer(ISSUES_PAGE)),
				log,
			),
		);
		ghIssuesUpdatedSince("{owner}/{repo}", "2020-01-01T00:00:00Z");
		const sent: string[] = JSON.parse(
			fs.readFileSync(log, "utf8").trim().split("\n")[0] as string,
		);
		expect(sent).toContain("since=2020-01-01T00:00:00Z");
		const args = [
			...sent,
			"-f",
			"labels=enhancement,takes:triage,kind:spec",
			"-f",
			"sort=created",
			"-f",
			"direction=asc",
		];
		const real = await throughSeam(realGh as string, args);
		expect(withoutText(await throughSeam(stubbed(ISSUES_PAGE), args))).toEqual(
			withoutText(real),
		);
		expect(withoutText(await observe(ghFake(ISSUES_PAGE), args))).toEqual(
			withoutText(real),
		);
	});

	/* lib/idle-efforts.js's QUERY, cut to closed issues with one label and oldest
	 * first: #9 (a closed ticket) has labels, blockers and sub-issues, so every
	 * list in the answer's first row holds a row, and it stays first. */
	it("lib/idle-efforts.js's read answers alike from the real gh, the stub and the in-process fake", async ({
		skip,
	}) => {
		liveSkip ??= { reason: liveSkipReason() };
		if (liveSkip.reason) return skip(liveSkip.reason);
		const { QUERY } = await import("./idle-efforts.js");
		const open = "issues(states: OPEN, first: 50, after: $endCursor)";
		expect(QUERY).toContain(open);
		const [owner, name] = readTracker().split("/");
		const args = [
			"api",
			"graphql",
			"--paginate",
			"--slurp",
			"-f",
			`owner=${owner}`,
			"-f",
			`name=${name}`,
			"-f",
			`query=${QUERY.replace(
				open,
				'issues(states: CLOSED, first: 50, after: $endCursor, labels: ["waiting:external"], orderBy: {field: CREATED_AT, direction: ASC})',
			)}`,
		];
		const real = await throughSeam(realGh as string, args);
		expect(
			withoutText(await throughSeam(stubbed(IDLE_ISSUES_PAGE), args)),
		).toEqual(withoutText(real));
		expect(withoutText(await observe(ghFake(IDLE_ISSUES_PAGE), args))).toEqual(
			withoutText(real),
		);
	});

	/* GRAPHQL_NO_REPO is static: verdict and shape only, its repository name
	 * being synthetic. */
	it("lib/blocked-by-batch.js's batched read of a missing repository answers alike from the real gh, the stub and the in-process fake", async ({
		skip,
	}) => {
		liveSkip ??= { reason: liveSkipReason() };
		if (liveSkip.reason) return skip(liveSkip.reason);
		const { blockedByMany } = await import("./blocked-by-batch.js");
		const log = path.join(dir, "no-repo-calls");
		vi.stubEnv(
			"WFC_GH",
			computedStub(
				BLOCKED_BY_GRAPHQL_FAKE,
				JSON.stringify(readGhAnswer(GRAPHQL_NO_REPO)),
				log,
			),
		);
		await blockedByMany([{ number: 1 }], {
			repo: `${readOwner()}/${noRepo}`,
			home: null,
		});
		const args: string[] = JSON.parse(
			fs.readFileSync(log, "utf8").trim().split("\n")[0] as string,
		);
		expect(args[1]).toBe("graphql");
		const real = await throughSeam(realGh as string, args);
		expect(real).toMatchObject({ verdict: "broken" });
		expect(
			withoutText(await throughSeam(stubbed(GRAPHQL_NO_REPO), args)),
		).toEqual(withoutText(real));
		expect(withoutText(await observe(ghFake(GRAPHQL_NO_REPO), args))).toEqual(
			withoutText(real),
		);
	});
});

/*
 * link-sub-issue.sh is run for real against a recording stub, so the reads sent
 * to the live gh are the ones the script sends, and a read LINK_READS lacks turns
 * this red. Its POST stays in the stub. #2260 (a closed spec) has closed
 * children, of which #2327 is one, so neither answer moves (#3652).
 */
describe("live: link-sub-issue.sh's reads", () => {
	it("each answers alike from the real gh, the stub and both fakes", async ({
		skip,
	}) => {
		liveSkip ??= { reason: liveSkipReason() };
		if (liveSkip.reason) return skip(liveSkip.reason);
		const log = path.join(dir, "link-calls");
		const stub = stubGhScript(
			fs.mkdtempSync(path.join(dir, "link-")),
			`#!/bin/sh
printf '%s\\n' "$*" >> ${shellQuote(log)}
case "$*" in
${buildLinkReadArms({ children: buildJqLines(2327) })}
  *"--method POST"*) exit 0 ;;
esac
exit 1
`,
		).gh;
		const run = spawnSync("bash", [LINK_SCRIPT, "2260", "2327"], {
			encoding: "utf8",
			env: {
				...process.env,
				CLAUDE_PROJECT_DIR: dir,
				WFC_GH: stub,
				WFC_LINK_REPO: "{owner}/{repo}",
				WFC_LINK_RETRIES: "1",
				WFC_LINK_SLEEP: "0",
			},
		});
		expect(run.status, run.stderr).toBe(0);
		const reads = fs
			.readFileSync(log, "utf8")
			.trim()
			.split("\n")
			.filter((call) => !call.includes("--method POST"))
			.map((call) => call.split(" "));
		const filters = reads.map((args) => args.at(-1) as string);
		expect(filters).toEqual(Object.values(LINK_READS).map((r) => r.jq));
		expect(filters.sort()).toEqual(Object.keys(LINK_FIXTURES).sort());
		// The script's own reader branches on these exact words; shape alone is "text".
		expect(
			spawnSync(realGh as string, reads[0] as string[], { encoding: "utf8" })
				.stdout,
		).toMatch(/^(open|closed)\n$/);
		for (const args of reads) {
			const fixture = LINK_FIXTURES[args.at(-1) as keyof typeof LINK_FIXTURES];
			const real = await throughSeam(realGh as string, args);
			expect(withoutText(await throughSeam(stubbed(fixture), args))).toEqual(
				withoutText(real),
			);
			expect(withoutText(await observe(ghFake(fixture), args))).toEqual(
				withoutText(real),
			);
			expect(answerLinkRead(args)).toEqual(readGhAnswer(fixture));
			const lines = readGhAnswer(fixture).stdout.trim().split("\n");
			expect(
				withoutText(await observe(ghServe(buildJqLines(...lines)), args)),
			).toEqual(withoutText(real));
		}
	});
});

/*
 * RECORDED_SHAPES holds a stub's own JSON answers to the fixtures the live
 * cases above hold to the real gh (#2895).
 */
describe("offline: the recorded shapes", () => {
	it("builds from the fixture each live case holds", () => {
		for (const fixture of [
			ISSUES_PAGE,
			BLOCKED_BY_PAGE,
			TIMELINE_PAGE,
			PARENT_PAGE,
			COMMENTS_PAGE,
			SUB_ISSUES,
			REPO,
			REPO_VIEW,
			LABELS_PAGE,
			ISSUE_LIST_ROWS,
			ISSUE_VIEW,
			IDLE_ISSUES_PAGE,
		])
			expect(RECORDED_SHAPES).toContain(
				JSON.stringify(readGhAnswer(fixture).stdout),
			);
	});

	/*
	 * A write that lands cannot be a live case (§G7 (2)), so these two are kept
	 * as recorded answers. Re-record on the tracker,
	 * then close what they made as not planned:
	 *   echo x | gh issue create --title x --label takes:triage --body-file - >out 2>err
	 *   echo x | gh issue comment <n> --body-file - >out 2>err
	 */
	it("a landed write's recording prints its URL and nothing else", () => {
		const created = readGhAnswer(ISSUE_CREATE);
		expect(created).toMatchObject({ status: 0, stderr: "" });
		expect(created.stdout).toMatch(/^https:\/\/\S+\/issues\/\d+\n$/);
		const commented = readGhAnswer(ISSUE_COMMENT);
		expect(commented).toMatchObject({ status: 0, stderr: "" });
		expect(commented.stdout).toMatch(
			/^https:\/\/\S+\/issues\/\d+#issuecomment-\d+\n$/,
		);
	});

	it("a create's answer names the call's repository and its number", () => {
		expect(buildCreateAnswer("acme/wfc", 7)).toBe(
			"https://github.com/acme/wfc/issues/7\n",
		);
	});

	it("passes a subset of the recorded keys, a null and a listed pull request", () => {
		expect(
			JSON.parse(
				asRecorded("issuesPage", [
					[{ number: 1, parent_issue_url: null, pull_request: { url: "x" } }],
				]),
			),
		).toEqual([
			[{ number: 1, parent_issue_url: null, pull_request: { url: "x" } }],
		]);
		expect(asRecorded("repo", { open_issues_count: 3 })).toBe(
			'{"open_issues_count":3}',
		);
	});

	it.for([
		{
			kind: "issuesPage",
			what: "a key gh never sends",
			value: [[{ number: 1, repo: "o/r" }]],
			error: /gh never sends issuesPage\[\]\[\]\.repo/,
		},
		{
			kind: "issuesPage",
			what: "a nested key gh never sends",
			value: [[{ labels: [{ title: "x" }] }]],
			error: /gh never sends issuesPage\[\]\[\]\.labels\[\]\.title/,
		},
		{
			kind: "issuesPage",
			what: "a type gh never sends",
			value: [[{ number: "1" }]],
			error: /\.number is string where gh sends number/,
		},
		{
			kind: "issuesPage",
			what: "an object where gh sends a page",
			value: { number: 1 },
			error: /issuesPage is object where gh sends array/,
		},
		{
			kind: "repo",
			what: "an element where gh recorded an empty list",
			value: { topics: ["x"] },
			error: /repo\.topics holds elements gh's recorded answer lacks/,
		},
		{
			kind: "pullRequest",
			what: "a kind with no recording",
			value: {},
			error: /no recorded answer for pullRequest/,
		},
	])("refuses $what, naming the offending path", ({ kind, value, error }) => {
		expect(() => asRecorded(kind, value)).toThrow(error);
	});
});
