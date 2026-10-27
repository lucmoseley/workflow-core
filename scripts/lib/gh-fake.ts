/*
 * The shared gh fake (§G7, #2207): one answer per fixture file under
 * fixtures/gh/, served in-process by `ghFake`, as the WFC_GH stub executable
 * by `ghFakeScript`, as an inline node fake by `ghAnswerNode`, and as
 * serveGhStub's handler by `ghAnswerHandler`. gh.contract.test.ts holds
 * the first two to the real binary on every fixture and the last two on the
 * logged-out answer alone, since all four serve one GhAnswer. A test names
 * the answer it wants by its fixture path and nothing else — or, where the
 * answer depends on the call, by the computed answer below that builds it.
 * A stub that builds its own REST answers runs each through `asRecorded`,
 * which holds it to a fixture the contract holds.
 */

import fs from "node:fs";
import BLOCKED_BY_PAGE from "./fixtures/gh/blocked-by-page.json" with {
	type: "json",
};
import COMMENTS_PAGE from "./fixtures/gh/comments-page.json" with {
	type: "json",
};
import GRAPHQL_BLOCKED_BY from "./fixtures/gh/graphql-blocked-by.json" with {
	type: "json",
};
import GRAPHQL_ISSUE_STATES from "./fixtures/gh/graphql-issue-states.json" with {
	type: "json",
};
import GRAPHQL_NO_REPO from "./fixtures/gh/graphql-no-repo.json" with {
	type: "json",
};
import ISSUES_PAGE from "./fixtures/gh/issues-page.json" with { type: "json" };
import LOGGED_OUT from "./fixtures/gh/logged-out.json" with { type: "json" };
import NOT_FOUND from "./fixtures/gh/not-found.json" with { type: "json" };
import PARENT_NOT_FOUND from "./fixtures/gh/parent-not-found.json" with {
	type: "json",
};
import PARENT_PAGE from "./fixtures/gh/parent-page.json" with { type: "json" };
import REPO from "./fixtures/gh/repo.json" with { type: "json" };
import SUB_ISSUES from "./fixtures/gh/sub-issues.json" with { type: "json" };
import SUB_ISSUES_NOT_FOUND from "./fixtures/gh/sub-issues-not-found.json" with {
	type: "json",
};
import TIMELINE_PAGE from "./fixtures/gh/timeline-page.json" with {
	type: "json",
};

/** What one gh call answers: its exit status and both streams, verbatim. */
export interface GhAnswer {
	status: number;
	stdout: string;
	stderr: string;
}

/*
 * The recorded failures a stub serves verbatim: a logged-out gh, a REST read
 * of a missing issue, `issues/<n>/parent` of an issue with none, and a
 * GraphQL read of a repository that does not exist. A 5xx cannot be recorded
 * on demand, so a stub failing a read for any reason serves NOT_FOUND:
 * lib/gh.js reads both as broken and retries both once (#3013).
 */
export const GH_LOGGED_OUT: GhAnswer = LOGGED_OUT;
export const GH_NOT_FOUND: GhAnswer = NOT_FOUND;
export const GH_PARENT_NOT_FOUND: GhAnswer = PARENT_NOT_FOUND;
export const GH_GRAPHQL_NO_REPO: GhAnswer = GRAPHQL_NO_REPO;

export function ghAnswer(fixture: string): GhAnswer {
	return JSON.parse(fs.readFileSync(fixture, "utf8"));
}

/** The in-process port: lib/gh.js's `gh(args)`, answering `answer` to every
 *  call. A non-zero status throws what execFileSync throws. */
export function ghServe({
	status,
	stdout,
	stderr,
}: GhAnswer): (args: string[]) => string {
	return (args) => {
		if (status === 0) return stdout;
		throw Object.assign(
			new Error(`Command failed: gh ${args.join(" ")}\n${stderr}`),
			{ status, stdout, stderr, signal: null },
		);
	};
}

export const ghFake = (fixture: string) => ghServe(ghAnswer(fixture));

const quoted = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/** The shell lines that print `answer`, for a stub's own `case` arm. */
export function ghServeLines({ status, stdout, stderr }: GhAnswer): string {
	return (
		(stdout ? `printf '%s' ${quoted(stdout)}\n` : "") +
		(stderr ? `printf '%s' ${quoted(stderr)} >&2\n` : "") +
		`exit ${status}\n`
	);
}

/** The stub executable answering `fixture`, for gh-stub's `stubGhScript`. */
export const ghFakeScript = (fixture: string) =>
	`#!/bin/sh\n${ghServeLines(ghAnswer(fixture))}`;

/** `fixture`'s answer as node source calling `out`, `err` and `exit`. */
function buildAnswerCalls(
	fixture: string,
	{ out, err, exit }: { out: string; err: string; exit: string },
) {
	const { status, stdout, stderr } = ghAnswer(fixture);
	return `${out}(${JSON.stringify(stdout)}); ${err}(${JSON.stringify(stderr)}); ${exit}(${status});`;
}

export const ghAnswerNode = (fixture: string) =>
	buildAnswerCalls(fixture, {
		out: "process.stdout.write",
		err: "process.stderr.write",
		exit: "process.exit",
	});

/** The handler answering `fixture`, for gh-stub's `serveGhStub`. */
export const ghAnswerHandler = (fixture: string) =>
	buildAnswerCalls(fixture, { out: "out", err: "err", exit: "exit" });

/*
 * Computed answers (#2873): where the answer depends on the call — a batched
 * GraphQL read, one issue's sub-issues — the fake builds it out of the nodes
 * of a fixture the contract holds to the real call, so its keys and types
 * are gh's and only its values are the test's. A GraphQL one is node source
 * defining one function that returns a GhAnswer, for a stub to embed and
 * print with `serveAnswer`, or for `ghComputed` to load in-process.
 */

/* Declarations a computed source embeds; a stub embedding two repeats them
 * harmlessly. `shaped` keeps exactly the template's keys, `answerOf` errs
 * as gh does on a GraphQL `errors` list: exit 1, each message on stderr. */
const HELPERS = String.raw`function shaped(template, values) {
	return Object.fromEntries(Object.keys(template).map((k) => [k, k in values ? values[k] : template[k]]));
}
function notFound(template, path, n) {
	return shaped(template, { path, message: template.message.replace(/\d+\.$/, n + ".") });
}
function answerOf(failed, body, errors) {
	return errors.length === 0
		? { status: 0, stdout: JSON.stringify(body), stderr: "" }
		: { status: failed.status, stdout: JSON.stringify({ ...body, errors }), stderr: "gh: " + errors.map((e) => e.message).join("\n") + "\n" };
}
function serveAnswer(a) {
	process.stdout.write(a.stdout);
	process.stderr.write(a.stderr);
	process.exit(a.status);
}`;

/**
 * The source of `answerGraphql(argv, closed, missing, missingRepos)`:
 * lib/outstanding-line.js's batched issue read, every cited number an open
 * issue unless `closed` or `missing` lists it, every repository found unless
 * `missingRepos` names its `owner/name` (#984). And of
 * `answerIssueData(argv, data)`: the same read answering `data`, a test's own
 * nodes by alias, with gh's errors entry for each null repository or issue.
 */
export const GRAPHQL_FAKE = String.raw`${HELPERS}
function graphqlRepos(argv) {
	const query = argv.find((a) => a.startsWith("query=")).slice(6);
	return query.split(/ (?=r\d+: repository\()/).slice(1).map((chunk) => {
		const [, owner, name] = chunk.match(/repository\(owner: ("(?:[^"\\]|\\.)*"), name: ("(?:[^"\\]|\\.)*")\)/);
		return {
			alias: chunk.split(":")[0],
			repo: JSON.parse(owner) + "/" + JSON.parse(name),
			numbers: [...chunk.matchAll(/n(\d+): issueOrPullRequest/g)].map((m) => m[1]),
		};
	});
}
function graphqlIssueStates() {
	return ${JSON.stringify(GRAPHQL_ISSUE_STATES)};
}
function answerIssueData(argv, data) {
	const fixture = graphqlIssueStates();
	const issueMissing = JSON.parse(fixture.stdout).errors[0];
	const repoMissing = JSON.parse(${JSON.stringify(GRAPHQL_NO_REPO.stdout)}).errors[0];
	const repos = graphqlRepos(argv);
	// gh lists a missing repository's error before any missing issue's.
	const errors = [
		...repos
			.filter((r) => data[r.alias] === null)
			.map((r) => shaped(repoMissing, { path: [r.alias], message: repoMissing.message.replace(/'.*'/, "'" + r.repo + "'") })),
		...repos.flatMap((r) =>
			Object.entries(data[r.alias] ?? {})
				.filter(([, v]) => v === null)
				.map(([k]) => notFound(issueMissing, [r.alias, k], k.slice(1)))),
	];
	return answerOf(fixture, { data }, errors);
}
function answerGraphql(argv, closed, missing, missingRepos = []) {
	const page = JSON.parse(graphqlIssueStates().stdout);
	const node = Object.values(Object.values(page.data)[0]).find((v) => v !== null);
	const data = {};
	for (const r of graphqlRepos(argv))
		data[r.alias] = missingRepos.includes(r.repo)
			? null
			: Object.fromEntries(r.numbers.map((n) => ["n" + n, missing.includes(n)
				? null
				: shaped(node, { __typename: "Issue", state: closed.includes(n) ? "CLOSED" : "OPEN" })]));
	return answerIssueData(argv, data);
}`;

/**
 * The source of `answerBlockedBy(argv, rowsOf)`: lib/blocked-by-batch.js's
 * batched blockers read. `rowsOf(n)` gives issue n's blockers as
 * `{number, state, repo?, title?, body?, labels?}` rows, or null for an
 * issue GitHub cannot resolve. Each list is cut to the query's own `first:`
 * with the full `totalCount`, as GitHub cuts it, and `{owner}/{repo}`
 * resolves to `o/r`, as gh resolves it to a real name.
 */
export const BLOCKED_BY_GRAPHQL_FAKE = String.raw`${HELPERS}
function answerBlockedBy(argv, rowsOf) {
	const fixture = ${JSON.stringify(GRAPHQL_BLOCKED_BY)};
	const page = JSON.parse(fixture.stdout);
	const issue = Object.values(page.data.repository).find((v) => v && v.blockedBy);
	const node = issue.blockedBy.nodes[0];
	const field = (k) => argv.find((a) => a.startsWith(k + "=")).slice(k.length + 1);
	const query = field("query");
	const self = (field("owner") + "/" + field("name")).replace("{owner}/{repo}", "o/r");
	const first = Number(query.match(/blockedBy\(first: (\d+)\)/)[1]);
	const repository = { nameWithOwner: self };
	const errors = [];
	for (const [, n] of query.matchAll(/i(\d+): issue\(/g)) {
		const rows = rowsOf(Number(n));
		if (!rows) {
			repository["i" + n] = null;
			errors.push(notFound(page.errors[0], ["repository", "i" + n], n));
			continue;
		}
		repository["i" + n] = shaped(issue, { blockedBy: shaped(issue.blockedBy, {
			totalCount: rows.length,
			nodes: rows.slice(0, first).map((r) => shaped(node, {
				number: r.number,
				state: r.state.toUpperCase(),
				title: r.title ?? "issue " + (r.repo ? r.repo + "#" : "") + r.number,
				url: "http://example/" + r.number,
				body: r.body ?? "",
				repository: shaped(node.repository, { nameWithOwner: r.repo ?? self }),
				labels: shaped(node.labels, { nodes: (r.labels ?? []).map((name) => shaped(node.labels.nodes[0], { name })) }),
			})),
		}) });
	}
	return answerOf(fixture, { data: { repository } }, errors);
}`;

/**
 * The source of `asRecorded(kind, value)`: `value`'s JSON text, refused where
 * it carries a key the recorded answer of `kind` lacks or a type it does not
 * have, for a stub that builds its own REST answers (#2895). A subset is
 * enough: a stub sends only the keys its reader reads, and a key gh dropped
 * would turn the fixture's live case red. A null on either side passes, as gh
 * sends null for an unset field of any type. Each array element is held to
 * the recorded first element.
 */
export const RECORDED_SHAPES = `function asRecorded(kind, value) {
	const recorded = {
		issuesPage: JSON.parse(${JSON.stringify(ISSUES_PAGE.stdout)}),
		// REST answers issues/<n> with the issue object a list page holds.
		issue: JSON.parse(${JSON.stringify(ISSUES_PAGE.stdout)})[0][0],
		blockedByPage: JSON.parse(${JSON.stringify(BLOCKED_BY_PAGE.stdout)}),
		timelinePage: JSON.parse(${JSON.stringify(TIMELINE_PAGE.stdout)}),
		parentPage: JSON.parse(${JSON.stringify(PARENT_PAGE.stdout)}),
		commentsPage: JSON.parse(${JSON.stringify(COMMENTS_PAGE.stdout)}),
		subIssuesPage: JSON.parse(${JSON.stringify(SUB_ISSUES.stdout)}),
		repo: JSON.parse(${JSON.stringify(REPO.stdout)}),
	};
	// This tracker holds no pull request to record, so a listed one's key is
	// GitHub's documented pull_request object (REST, "List repository issues").
	// Residual: no live case holds pull_request, and nothing holds the stub
	// at or below a key recorded as null (milestone, pinned_comment, intent).
	recorded.issuesPage[0][0].pull_request = { url: "", html_url: "", diff_url: "", patch_url: "", merged_at: "" };
	const typeOf = (v) => (Array.isArray(v) ? "array" : typeof v);
	const walk = (t, v, at) => {
		if (t === null || v === null) return;
		if (typeOf(t) !== typeOf(v))
			throw new Error(kind + ": " + at + " is " + typeOf(v) + " where gh sends " + typeOf(t));
		if (Array.isArray(v)) {
			if (v.length > 0 && t.length === 0)
				throw new Error(kind + ": " + at + " holds elements gh's recorded answer lacks");
			for (const x of v) walk(t[0], x, at + "[]");
		} else if (typeof v === "object")
			for (const [k, x] of Object.entries(v)) {
				if (x === undefined) continue;
				if (!(k in t)) throw new Error(kind + ": gh never sends " + at + "." + k);
				walk(t[k], x, at + "." + k);
			}
	};
	if (!(kind in recorded)) throw new Error("no recorded answer for " + kind);
	walk(recorded[kind], value, kind);
	return JSON.stringify(value);
}`;

export const ghComputed = <F>(source: string, name: string): F =>
	new Function(`${source}\nreturn ${name};`)() as F;

/** RECORDED_SHAPES in-process, for a stub that writes its answers from the test. */
export const asRecorded = ghComputed<(kind: string, value: unknown) => string>(
	RECORDED_SHAPES,
	"asRecorded",
);

/** What one issue's `/sub_issues` answers: its rows, an HTTP error, or the
 *  failure lib/gh.js classifies as unreachable. */
export type SubIssuesAnswer = unknown[] | "fail" | "unreachable";

/** `gh api …/sub_issues --paginate --slurp`'s answer: one page of `rows`,
 *  held to the recorded page by `asRecorded`. */
export function subIssuesAnswer(a: SubIssuesAnswer): GhAnswer {
	if (a === "fail") return SUB_ISSUES_NOT_FOUND;
	if (a === "unreachable") return LOGGED_OUT;
	return { ...SUB_ISSUES, stdout: asRecorded("subIssuesPage", [a]) };
}
