/*
 * Shared scaffolding for faking `gh` in tests. A test answering more than one
 * call passes `stubGhRoutes` a route table, never a router of its own; this
 * owns the stub executable and the two ways to inject it — WFC_GH for
 * the node scripts (via scripts/lib/gh.js), PATH for shell hooks that look
 * `gh` up themselves. The canonical failure mode is gh-fake's logged-out
 * answer, which gh.contract.test.ts holds to the real binary (#2220).
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	asRecorded,
	BLOCKED_BY_GRAPHQL_FAKE,
	type GhAnswer,
	ghAnswer,
	ghAnswerNode,
	ghFakeScript,
	ghServeLines,
	quoted,
	type SubIssuesAnswer,
	subIssuesAnswer,
} from "./gh-fake";
import { buildServerClient } from "./gh-stub-server.js";

const LOGGED_OUT = path.join(__dirname, "fixtures/gh/logged-out.json");

const loggedOut = ghAnswer(LOGGED_OUT);

/** What a logged-out gh prints on stderr for any API call, verbatim. */
export const GH_LOGGED_OUT_STDERR = loggedOut.stderr;

export const GH_LOGGED_OUT_EXIT = loggedOut.status;

/** The same answer as node statements, for a test's inline node fake. */
export const GH_LOGGED_OUT_NODE = ghAnswerNode(LOGGED_OUT);

/** What every stub prints when asked to model an unreachable gh: a logged-out gh. */
export const GH_FAILING_SCRIPT = ghFakeScript(LOGGED_OUT);

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

/**
 * One route's answer: the body gh prints for a read of recorded `kind`,
 * built by `asRecorded` and wrapped as `--slurp` wraps one object where
 * `slurp` is set; or a gh-fake answer served verbatim.
 */
export type RouteAnswer =
	| { kind: string; value: unknown; slurp?: boolean }
	| GhAnswer;

/** `rows` as the one page a `--paginate --slurp` list read of `kind` answers. */
export const page = (kind: string, rows: unknown[]): RouteAnswer => ({
	kind,
	value: [rows],
});

/** A call that succeeds printing `stdout`: a write, or a `--jq` read's text. */
export const printed = (stdout = ""): GhAnswer => ({
	status: 0,
	stdout,
	stderr: "",
});

const routeAnswer = (a: RouteAnswer): GhAnswer => {
	if ("status" in a) return a;
	const body = asRecorded(a.kind, a.value);
	return printed(a.slurp ? `[${body}]` : body);
};

/** `key` as a shell `case` pattern in which `*` alone is special. */
const casePattern = (key: string) => key.split("*").map(quoted).join("*");

const BLOCKED_BY_ROUTE = /^[^*]*\/issues\/(\d+)\/dependencies\/blocked_by$/;

const blockerRow = (r: {
	number: number;
	state: string;
	repository_url?: string;
	title?: string;
	body?: string;
	labels?: { name: string }[];
}) => ({
	number: r.number,
	state: r.state,
	repo: r.repository_url?.replace("https://api.github.com/repos/", ""),
	title: r.title,
	body: r.body,
	labels: r.labels?.map((l) => l.name),
});

/**
 * Write a fake `gh` under `dir` serving `routes` (#3168). A
 * `gh api` call routes on the request it sends — its path, then its `-f` and
 * `-F` fields as a query string, keyed `POST <path>?…` where it carries
 * fields and no `-X GET`, as gh then sends it — and any other call on its whole argv: the
 * first key matching wins, `*` in a key matches any run of characters, and a
 * call no key matches fails naming itself. Unless `routes` keys `graphql`
 * exactly — a catch-all `*` does not —
 * `gh api graphql` is lib/blocked-by-batch.js's batched read, answering issue
 * n from the rows of its `blockedByPage` route keyed exactly
 * `…/issues/n/dependencies/blocked_by`, and null — sending n to that REST
 * path — where that route fails or there is none. `failing` is stubGhScript's.
 */
export function stubGhRoutes(
	dir: string,
	routes: Record<string, RouteAnswer>,
	{ log, failing = false }: { log?: string; failing?: boolean } = {},
): StubGh {
	const arms = Object.entries(routes).map(
		([key, a]) =>
			`  ${casePattern(key)})\n${ghServeLines(routeAnswer(a))}    ;;`,
	);
	if (!("graphql" in routes)) {
		const blockers: Record<number, unknown[]> = {};
		for (const [key, a] of Object.entries(routes)) {
			const n = key.match(BLOCKED_BY_ROUTE)?.[1];
			if (n && "kind" in a && a.kind === "blockedByPage")
				blockers[Number(n)] = (a.value as Parameters<typeof blockerRow>[0][][])
					.flat()
					.map(blockerRow);
		}
		const file = path.join(dir, "gh-blockers.js");
		fs.writeFileSync(
			file,
			`${BLOCKED_BY_GRAPHQL_FAKE}
const blockers = ${JSON.stringify(blockers)};
serveAnswer(answerBlockedBy(process.argv.slice(2), (n) => blockers[n] ?? null));
`,
		);
		arms.unshift(`  graphql) exec node ${quoted(file)} "$@" ;;`);
	}
	const script = `#!/bin/sh
${log ? `printf '%s\\n' "$*" >> ${quoted(log)}\n` : ""}route_key() {
  [ "$1" = api ] || { printf '%s' "$*"; return; }
  [ "$2" = graphql ] && { printf graphql; return; }
  key=$2 sep='?' fields= get=
  case "$key" in *\\?*) sep='&' ;; esac
  shift 2
  while [ $# -gt 0 ]; do
    case "$1" in
      -f|-F|--field|--raw-field) key="$key$sep$2" sep='&' fields=1; shift ;;
      -X|--method) [ "$2" = GET ] && get=1; shift ;;
    esac
    shift
  done
  [ -n "$fields" ] && [ -z "$get" ] && key="POST $key"
  printf '%s' "$key"
}
case "$(route_key "$@")" in
${arms.join("\n")}
  *) printf 'gh route stub: no route for: %s\\n' "$*" >&2; exit 1 ;;
esac
`;
	return stubGhScript(dir, script, { failing });
}

export interface GhStubServer {
	/** The stub executable's text, for `stubGhScript`. */
	script: string;
	close: () => Promise<void>;
}

/**
 * Serve a stateful stub from one long-lived process (gh-stub-server.js), so a
 * suite making hundreds of gh calls pays a node start once, not per call
 * (#2877). `handler` is the body gh-stub-server.js runs per call. Keep its
 * state in files the call's environment names, never in the handler's
 * memory, so each test's fixture stays its own.
 */
export async function serveGhStub(handler: string): Promise<GhStubServer> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gh-stub-server-"));
	const file = path.join(dir, "handler.js");
	fs.writeFileSync(file, handler);
	const child = spawn(
		process.execPath,
		[path.join(__dirname, "gh-stub-server.js"), file],
		{ stdio: ["pipe", "pipe", "inherit"] },
	);
	const exited = new Promise<void>((resolve) =>
		child.once("close", () => resolve()),
	);
	const close = async () => {
		child.stdin.end();
		child.kill();
		await exited;
		fs.rmSync(dir, { recursive: true, force: true });
	};
	const port = await new Promise<number>((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code) =>
			reject(new Error(`gh-stub-server exited ${code} before listening`)),
		);
		child.stdout.once("data", (b: Buffer) => {
			const n = Number(String(b));
			if (Number.isInteger(n) && n > 0) resolve(n);
			else reject(new Error(`gh-stub-server printed no port: ${String(b)}`));
		});
	}).catch(async (e) => {
		await close();
		throw e;
	});
	return { script: buildServerClient(port), close };
}

/** Two repos' REST prefixes, for a parent or child in another repo (#778). */
export const HERE = "https://api.github.com/repos/o/here";
export const THERE = "https://api.github.com/repos/o/there";

/** Write the files `subIssuesArm` serves from: each issue's answer as
 *  gh-fake builds it, its streams and status a file each. */
export function writeSubIssues(
	dir: string,
	answers: Record<number, SubIssuesAnswer>,
) {
	for (const [n, a] of Object.entries(answers)) {
		const { status, stdout, stderr } = subIssuesAnswer(a);
		fs.writeFileSync(path.join(dir, `children-${n}.out`), stdout);
		fs.writeFileSync(path.join(dir, `children-${n}.err`), stderr);
		fs.writeFileSync(path.join(dir, `children-${n}.status`), String(status));
	}
}

/**
 * A shell `case` arm answering `gh api …/issues/N/sub_issues` from the files
 * `writeSubIssues` wrote under `dir`, and no sub-issue for any other N. It
 * matches the path, so the stub's `case` must switch on `$2`.
 */
export const subIssuesArm = (dir: string) => `  */sub_issues)
    n=\`echo "$2" | sed 's|.*/issues/||; s|/sub_issues||'\`
    if [ -f ${dir}/children-$n.status ]; then
      cat ${dir}/children-$n.out
      cat ${dir}/children-$n.err >&2
      exit \`cat ${dir}/children-$n.status\`
    fi
    ${ghServeLines(subIssuesAnswer([]))}    ;;`;
