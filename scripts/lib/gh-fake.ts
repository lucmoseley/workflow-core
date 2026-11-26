import fs from "node:fs";
import BLOCKED_BY_PAGE from "./fixtures/gh/blocked-by-page.json" with {
	type: "json",
};
import COMMENTS_PAGE from "./fixtures/gh/comments-page.json" with {
	type: "json",
};
import GRAPHQL_ISSUE_STATES from "./fixtures/gh/graphql-issue-states.json" with {
	type: "json",
};
import GRAPHQL_LINKS from "./fixtures/gh/graphql-links.json" with {
	type: "json",
};
import GRAPHQL_NO_REPO from "./fixtures/gh/graphql-no-repo.json" with {
	type: "json",
};
import IDLE_ISSUES_PAGE from "./fixtures/gh/idle-issues-page.json" with {
	type: "json",
};
import ISSUE from "./fixtures/gh/issue.json" with { type: "json" };
import ISSUE_CREATE from "./fixtures/gh/issue-create.json" with {
	type: "json",
};
import ISSUE_ID from "./fixtures/gh/issue-id.json" with { type: "json" };
import ISSUE_LIST_ROWS from "./fixtures/gh/issue-list-rows.json" with {
	type: "json",
};
import ISSUE_STATE from "./fixtures/gh/issue-state.json" with { type: "json" };
import ISSUE_VIEW from "./fixtures/gh/issue-view.json" with { type: "json" };
import ISSUES_PAGE from "./fixtures/gh/issues-page.json" with { type: "json" };
import LABELS_PAGE from "./fixtures/gh/labels-page.json" with { type: "json" };
import LOGGED_OUT from "./fixtures/gh/logged-out.json" with { type: "json" };
import NOT_FOUND from "./fixtures/gh/not-found.json" with { type: "json" };
import PARENT_NOT_FOUND from "./fixtures/gh/parent-not-found.json" with {
	type: "json",
};
import PARENT_PAGE from "./fixtures/gh/parent-page.json" with { type: "json" };
import REPO from "./fixtures/gh/repo.json" with { type: "json" };
import REPO_FULL_NAME from "./fixtures/gh/repo-full-name.json" with {
	type: "json",
};
import REPO_VIEW from "./fixtures/gh/repo-view.json" with { type: "json" };
import RUN_JOBS from "./fixtures/gh/run-jobs.json" with { type: "json" };
import RUN_LIST from "./fixtures/gh/run-list.json" with { type: "json" };
import SUB_ISSUE_REFS from "./fixtures/gh/sub-issue-refs.json" with {
	type: "json",
};
import SUB_ISSUES from "./fixtures/gh/sub-issues.json" with { type: "json" };
import SUB_ISSUES_NOT_FOUND from "./fixtures/gh/sub-issues-not-found.json" with {
	type: "json",
};
import TIMELINE_PAGE from "./fixtures/gh/timeline-page.json" with {
	type: "json",
};
import VALIDATION_FAILED from "./fixtures/gh/validation-failed.json" with {
	type: "json",
};
import { shellQuote } from "./sh-quote.js";

export interface GhAnswer {
	status: number;
	stdout: string;
	stderr: string;
}

export const GH_LOGGED_OUT: GhAnswer = LOGGED_OUT;
export const GH_NOT_FOUND: GhAnswer = NOT_FOUND;
export const GH_PARENT_NOT_FOUND: GhAnswer = PARENT_NOT_FOUND;
export const GH_GRAPHQL_NO_REPO: GhAnswer = GRAPHQL_NO_REPO;
export const GH_VALIDATION_FAILED: GhAnswer = VALIDATION_FAILED;

export function readGhAnswer(fixture: string): GhAnswer {
	return JSON.parse(fs.readFileSync(fixture, "utf8"));
}

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

export const ghFake = (fixture: string) => ghServe(readGhAnswer(fixture));

export function ghServeLines({ status, stdout, stderr }: GhAnswer): string {
	return (
		(stdout ? `printf '%s' ${shellQuote(stdout)}\n` : "") +
		(stderr ? `printf '%s' ${shellQuote(stderr)} >&2\n` : "") +
		`exit ${status}\n`
	);
}

export function buildGhAnswerScript(
	answer: GhAnswer,
	{ onlyIn }: { onlyIn?: string } = {},
): string {
	const elsewhere = onlyIn
		? `if [ "$PWD" != ${shellQuote(onlyIn)} ]; then\n${ghServeLines(GH_LOGGED_OUT)}fi\n`
		: "";
	return `#!/bin/sh\n${elsewhere}${ghServeLines(answer)}`;
}

export const ghFakeScript = (fixture: string) =>
	buildGhAnswerScript(readGhAnswer(fixture));

function buildAnswerCalls(
	fixture: string,
	{ out, err, exit }: { out: string; err: string; exit: string },
) {
	const { status, stdout, stderr } = readGhAnswer(fixture);
	return `${out}(${JSON.stringify(stdout)}); ${err}(${JSON.stringify(stderr)}); ${exit}(${status});`;
}

export const ghAnswerNode = (fixture: string) =>
	buildAnswerCalls(fixture, {
		out: "process.stdout.write",
		err: "process.stderr.write",
		exit: "process.exit",
	});

export const ghAnswerHandler = (fixture: string) =>
	buildAnswerCalls(fixture, { out: "out", err: "err", exit: "exit" });

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
}
function serveHandlerAnswer(a) {
	out(a.stdout);
	err(a.stderr);
	exit(a.status);
}`;

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

export const CITED_GRAPHQL_FAKE = String.raw`${GRAPHQL_FAKE}
function answerCited(argv, issues) {
	const query = argv.find((a) => a.startsWith("query=")).slice(6);
	const data = {};
	for (const chunk of query.split(/ (?=r\d+: repository\()/).slice(1)) {
		const alias = chunk.split(":")[0];
		const [, owner, name] = chunk.match(/repository\(owner: ("(?:[^"\\]|\\.)*"), name: ("(?:[^"\\]|\\.)*")\)/);
		const held = issues[(JSON.parse(owner) + "/" + JSON.parse(name)).toLowerCase()];
		if (!held) {
			data[alias] = null;
			continue;
		}
		data[alias] = {};
		const pages = /n(\d+): issueOrPullRequest\(number: \d+\) \{ __typename \.\.\. on Issue \{ (body )?comments\(first: (\d+)(?:, after: "(\d+)")?\)/g;
		for (const [, n, first, size, after] of chunk.matchAll(pages)) {
			const issue = held[n];
			if (!issue) {
				data[alias]["n" + n] = null;
				continue;
			}
			const comments = issue.comments ?? [];
			const from = Number(after ?? 0);
			const to = from + Number(size);
			data[alias]["n" + n] = {
				__typename: "Issue",
				...(first ? { body: issue.body ?? "" } : {}),
				comments: {
					pageInfo: { hasNextPage: to < comments.length, endCursor: String(to) },
					nodes: comments.slice(from, to).map((body) => ({ body })),
				},
			};
		}
	}
	return answerIssueData(argv, data);
}`;

export const LINKS_GRAPHQL_FAKE = String.raw`${HELPERS}
function answerLinks(argv, nodeOf) {
	const fixture = ${JSON.stringify(GRAPHQL_LINKS)};
	const page = JSON.parse(fixture.stdout);
	const issue = Object.values(page.data.repository).find((v) => v && v.blockedBy);
	const blocker = issue.blockedBy.nodes[0];
	const child = issue.subIssues.nodes[0];
	const field = (k) => argv.find((a) => a.startsWith(k + "=")).slice(k.length + 1);
	const query = field("query");
	const self = (field("owner") + "/" + field("name")).replace("{owner}/{repo}", "o/r");
	const first = (conn) => Number(query.match(new RegExp(conn + "\\(first: (\\d+)\\)"))[1]);
	const conn = (key, rows, row) => shaped(issue[key], {
		totalCount: rows.length,
		nodes: rows.slice(0, first(key)).map(row),
	});
	const repository = { nameWithOwner: self };
	const errors = [];
	for (const [, n] of query.matchAll(/i(\d+): issue\(/g)) {
		const held = nodeOf(self, Number(n));
		if (!held) {
			repository["i" + n] = null;
			errors.push(notFound(page.errors[0], ["repository", "i" + n], n));
			continue;
		}
		repository["i" + n] = shaped(issue, {
			state: (held.state ?? "open").toUpperCase(),
			body: held.body ?? "",
			blockedBy: conn("blockedBy", held.blockedBy ?? [], (r) => shaped(blocker, {
				number: r.number,
				state: r.state.toUpperCase(),
				title: r.title ?? "issue " + (r.repo ? r.repo + "#" : "") + r.number,
				url: "http://example/" + r.number,
				body: r.body ?? "",
				repository: shaped(blocker.repository, { nameWithOwner: r.repo ?? self }),
				labels: shaped(blocker.labels, { nodes: (r.labels ?? []).map((name) => shaped(blocker.labels.nodes[0], { name })) }),
			})),
			subIssues: conn("subIssues", held.subIssues ?? [], (r) => shaped(child, {
				number: r.number,
				state: r.state.toUpperCase(),
				repository: shaped(child.repository, { nameWithOwner: r.repo ?? self }),
			})),
		});
	}
	return answerOf(fixture, { data: { repository } }, errors);
}`;

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
		// gh repo view --json nameWithOwner, which lib/gh.js's ghDefaultRepo reads.
		repoView: JSON.parse(${JSON.stringify(REPO_VIEW.stdout)}),
		labelsPage: JSON.parse(${JSON.stringify(LABELS_PAGE.stdout)}),
		// gh issue list --json with every field a stub's rows carry; a real answer
		// holds only the fields its call asks for.
		issueListRows: JSON.parse(${JSON.stringify(ISSUE_LIST_ROWS.stdout)}),
		// gh issue view --json: lib/issue-close.js's fields, and the queue lander's state.
		issueView: JSON.parse(${JSON.stringify(ISSUE_VIEW.stdout)}),
		// lib/idle-efforts.js's QUERY, --paginate --slurp.
		idleIssuesPage: JSON.parse(${JSON.stringify(IDLE_ISSUES_PAGE.stdout)}),
		// gh run list --json with every field lib/actions-tester.js's listings ask for.
		runList: JSON.parse(${JSON.stringify(RUN_LIST.stdout)}),
		// gh run view <run> --json jobs.
		runJobs: JSON.parse(${JSON.stringify(RUN_JOBS.stdout)}),
	};
	// This tracker holds no pull request to record, so a listed one's key is
	// GitHub's documented pull_request object (REST, "List repository issues").
	recorded.issuesPage[0][0].pull_request = { url: "", html_url: "", diff_url: "", patch_url: "", merged_at: "" };
	const filled = JSON.parse(${JSON.stringify(ISSUE.stdout)});
	for (const issue of [
		recorded.issue,
		recorded.issuesPage[0][0],
		recorded.blockedByPage[0][0],
		recorded.parentPage[0],
		recorded.subIssuesPage[0][0],
	])
		for (const k of Object.keys(issue))
			if (issue[k] === null && filled[k] != null) issue[k] = filled[k];
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
}
// \`value\` cut to the fields \`argv\`'s --json asks for, as gh cuts a row.
function askedFields(argv, value) {
	const asked = (argv[argv.indexOf("--json") + 1] ?? "").split(",");
	return Object.fromEntries(asked.filter((k) => k in value).map((k) => [k, value[k]]));
}
function buildCreateAnswer(repo, number) {
	return ${JSON.stringify(ISSUE_CREATE.stdout)}.replace("synthetic/synthetic", repo).replace(/\\d+\\n$/, number + "\\n");
}`;

export const ghComputed = <F>(source: string, name: string): F =>
	new Function(`${source}\nreturn ${name};`)() as F;

export const asRecorded = ghComputed<(kind: string, value: unknown) => string>(
	RECORDED_SHAPES,
	"asRecorded",
);

export const buildCreateAnswer = ghComputed<
	(repo: string, number: number) => string
>(RECORDED_SHAPES, "buildCreateAnswer");

export type SubIssuesAnswer = unknown[] | "fail" | "unreachable";

export function subIssuesAnswer(a: SubIssuesAnswer): GhAnswer {
	if (a === "fail") return SUB_ISSUES_NOT_FOUND;
	if (a === "unreachable") return LOGGED_OUT;
	return { ...SUB_ISSUES, stdout: asRecorded("subIssuesPage", [a]) };
}

export const LINK_READS = {
	repo: { jq: ".full_name", answer: REPO_FULL_NAME as GhAnswer },
	state: { jq: ".state", answer: ISSUE_STATE as GhAnswer },
	id: { jq: ".id", answer: ISSUE_ID as GhAnswer },
	children: {
		jq: '.[]|"\\(.repository_url)#\\(.number)"',
		answer: SUB_ISSUE_REFS as GhAnswer,
	},
};

export type LinkReadAnswers = Partial<
	Record<keyof typeof LINK_READS, GhAnswer>
>;

export const LINK_READ_FAKE = String.raw`function buildJqLines(...values) {
	return { status: 0, stdout: values.map((v) => v + "\n").join(""), stderr: "" };
}
function buildChildRows(home, ...refs) {
	return buildJqLines(...refs.map((r) =>
		"https://api.github.com/repos/" + (String(r).includes("#") ? r : home + "#" + r)));
}
function answerLinkRead(argv, answers = {}) {
	const reads = ${JSON.stringify(LINK_READS)};
	const filter = argv.includes("--jq") ? argv[argv.indexOf("--jq") + 1] : undefined;
	const key = Object.keys(reads).find((k) => reads[k].jq === filter);
	return key && (answers[key] ?? reads[key].answer);
}`;

export const buildJqLines = ghComputed<(...values: unknown[]) => GhAnswer>(
	LINK_READ_FAKE,
	"buildJqLines",
);

export const buildChildRows = ghComputed<
	(home: string, ...refs: (number | string)[]) => GhAnswer
>(LINK_READ_FAKE, "buildChildRows");

export const answerCited = ghComputed<
	(argv: string[], issues: Record<string, object>) => GhAnswer
>(CITED_GRAPHQL_FAKE, "answerCited");

export const answerLinkRead = ghComputed<
	(argv: string[], answers?: LinkReadAnswers) => GhAnswer | undefined
>(LINK_READ_FAKE, "answerLinkRead");
