/*
 * Shared scaffolding for faking `gh` in tests. Each test still writes the
 * serving logic that is genuinely its own (which fixtures, which responses);
 * this owns the stub executable, the canonical failure mode, and the two ways
 * to inject it — WFC_GH for the node scripts (via scripts/lib/gh.js), PATH
 * for shell hooks that look `gh` up themselves.
 */

import fs from "node:fs";
import path from "node:path";

/** What a logged-out gh 2.95.0 prints on stderr for any API call, verbatim;
 *  gh.test.ts's contract case holds it to the real binary (#2220). */
export const GH_LOGGED_OUT_STDERR =
	"To get started with GitHub CLI, please run:  gh auth login\n" +
	"Alternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.\n";

/** The exit code gh's manual gives an authentication failure. */
export const GH_LOGGED_OUT_EXIT = 4;

/** The shell lines that answer as a logged-out gh does. */
const LOGGED_OUT_LINES = `printf '%s' '${GH_LOGGED_OUT_STDERR}' >&2\nexit ${GH_LOGGED_OUT_EXIT}\n`;

/** The same answer as node statements, for a test's inline node fake. */
export const GH_LOGGED_OUT_NODE = `process.stderr.write(${JSON.stringify(GH_LOGGED_OUT_STDERR)}); process.exit(${GH_LOGGED_OUT_EXIT});`;

/** What every stub prints when asked to model an unreachable gh: a logged-out gh. */
export const GH_FAILING_SCRIPT = `#!/bin/sh\n${LOGGED_OUT_LINES}`;

/** A stub that serves one fixture file verbatim, whatever the arguments. */
export const catFixture = (file: string) => `#!/bin/sh\ncat ${file}\n`;

export interface StubGh {
	/** The stub executable — what WFC_GH points at. */
	gh: string;
	/** For scripts routed through scripts/lib/gh.js. */
	env: { WFC_GH: string };
	/** For shell hooks that resolve `gh` on PATH. */
	PATH: string;
}

/**
 * Write `script` as a fake `gh` under `dir` and return its injection points.
 * `failing: true` substitutes the canonical unreachable-gh stub.
 */
export function stubGhScript(
	dir: string,
	script: string,
	{ failing = false } = {},
): StubGh {
	const bin = path.join(dir, "bin");
	fs.mkdirSync(bin, { recursive: true });
	const gh = path.join(bin, "gh");
	fs.writeFileSync(gh, failing ? GH_FAILING_SCRIPT : script, { mode: 0o755 });
	return {
		gh,
		env: { WFC_GH: gh },
		PATH: `${bin}${path.delimiter}${process.env.PATH}`,
	};
}

/** Two repos' REST prefixes, for a parent or child in another repo (#778). */
export const HERE = "https://api.github.com/repos/o/here";
export const THERE = "https://api.github.com/repos/o/there";

/** What `writeSubIssues` serves for one issue: its rows, an HTTP error, or
 *  the failure lib/gh.js classifies as unreachable. */
export type SubIssuesAnswer = unknown[] | "fail" | "unreachable";

/** Write the files `subIssuesArm` serves from. */
export function writeSubIssues(
	dir: string,
	answers: Record<number, SubIssuesAnswer>,
) {
	for (const [n, a] of Object.entries(answers))
		if (a === "fail" || a === "unreachable")
			fs.writeFileSync(path.join(dir, `children-${n}.${a}`), "");
		else
			fs.writeFileSync(
				path.join(dir, `children-${n}.json`),
				JSON.stringify([a]),
			);
}

/**
 * A shell `case` arm answering `gh api …/issues/N/sub_issues` from the files
 * `writeSubIssues` wrote under `dir`, and no sub-issue for any other N. It
 * matches the path, so the stub's `case` must switch on `$2`.
 */
export const subIssuesArm = (dir: string) => `  */sub_issues)
    n=\`echo "$2" | sed 's|.*/issues/||; s|/sub_issues||'\`
    if [ -f ${dir}/children-$n.fail ]; then
      echo "HTTP 502 (sub_issues/$n)" >&2
      exit 1
    fi
    if [ -f ${dir}/children-$n.unreachable ]; then
      ${LOGGED_OUT_LINES}    fi
    if [ -f ${dir}/children-$n.json ]; then
      cat ${dir}/children-$n.json
    else
      echo '[[]]'
    fi
    ;;`;

/**
 * The source of `answerGraphql(argv, closed, missing)`, for a stub to embed and
 * call: lib/outstanding-line.js's batched issue read, answered with every cited
 * number an open issue unless `closed` or `missing` lists it (#984).
 */
export const GRAPHQL_FAKE = `function answerGraphql(argv, closed, missing) {
	const query = argv.find((a) => a.startsWith("query=")).slice(6);
	const data = {};
	for (const chunk of query.split(/ (?=r\\d+: repository\\()/).slice(1)) {
		const repo = {};
		for (const [, n] of chunk.matchAll(/n(\\d+): issueOrPullRequest/g))
			repo["n" + n] = missing.includes(n)
				? null
				: { __typename: "Issue", state: closed.includes(n) ? "CLOSED" : "OPEN" };
		data[chunk.split(":")[0]] = repo;
	}
	return { data };
}`;
