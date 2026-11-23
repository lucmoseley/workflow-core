import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	asRecorded,
	CITED_GRAPHQL_FAKE,
	type GhAnswer,
	ghAnswerNode,
	ghFakeScript,
	ghServeLines,
	LINK_READS,
	LINKS_GRAPHQL_FAKE,
	type LinkReadAnswers,
	readGhAnswer,
	type SubIssuesAnswer,
	subIssuesAnswer,
} from "./gh-fake";
import { buildServerClient } from "./gh-server-stub.js";
import { shellQuote } from "./sh-quote.js";

const LOGGED_OUT = path.join(__dirname, "fixtures/gh/logged-out.json");

const loggedOut = readGhAnswer(LOGGED_OUT);

export const GH_LOGGED_OUT_STDERR = loggedOut.stderr;

export const GH_LOGGED_OUT_EXIT = loggedOut.status;

export const GH_LOGGED_OUT_NODE = ghAnswerNode(LOGGED_OUT);

export const GH_FAILING_SCRIPT = ghFakeScript(LOGGED_OUT);

export const catFixture = (file: string) =>
	`#!/bin/sh\ncat ${shellQuote(file)}\n`;

export interface StubGh {
	gh: string;
	env: { WFC_GH: string };
}

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
	};
}

export type RouteAnswer =
	| { kind: string; value: unknown; slurp?: boolean }
	| GhAnswer;

export const page = (kind: string, rows: unknown[]): RouteAnswer => ({
	kind,
	value: [rows],
});

export const printed = (stdout = ""): GhAnswer => ({
	status: 0,
	stdout,
	stderr: "",
});

export const refused = (stderr: string): GhAnswer => ({
	status: 1,
	stdout: "",
	stderr: `${stderr}\n`,
});

const routeAnswer = (a: RouteAnswer): GhAnswer => {
	if ("status" in a) return a;
	const body = asRecorded(a.kind, a.value);
	return printed(a.slurp ? `[${body}]` : body);
};

const casePattern = (key: string) => key.split("*").map(shellQuote).join("*");

const LINK_LIST_ROUTE =
	/^repos\/([^/*]+\/[^/*]+)\/issues\/(\d+)\/(dependencies\/blocked_by|sub_issues)$/;

type LinkNode = { blockedBy?: unknown[]; subIssues?: unknown[] } | null;

function buildLinkNodes(routes: Record<string, RouteAnswer>) {
	const nodes: Record<string, LinkNode> = {};
	for (const [key, a] of Object.entries(routes)) {
		const m = key.match(LINK_LIST_ROUTE);
		if (!m) continue;
		const at = `${(m[1] as string).replace("{owner}/{repo}", "o/r").toLowerCase()}#${m[2]}`;
		if ("status" in a) {
			if (a.status !== 0) nodes[at] = null;
			continue;
		}
		if (nodes[at] === null) continue;
		const rows = (a.value as Parameters<typeof blockerRow>[0][][])
			.flat()
			.map(blockerRow);
		const field = m[3] === "sub_issues" ? "subIssues" : "blockedBy";
		nodes[at] = { ...nodes[at], [field]: rows };
	}
	return nodes;
}

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

export interface CitedFixture {
	body?: string;
	comments?: string[];
}

const lowerKeys = <T>(o: Record<string, T>) =>
	Object.fromEntries(Object.entries(o).map(([k, v]) => [k.toLowerCase(), v]));

export function stubGhRoutes(
	dir: string,
	routes: Record<string, RouteAnswer>,
	{
		log,
		bodies,
		failing = false,
		cited = {},
	}: {
		log?: string;
		bodies?: string;
		failing?: boolean;
		cited?: Record<string, Record<number, CitedFixture>>;
	} = {},
): StubGh {
	const arms = Object.entries(routes).map(
		([key, a]) =>
			`  ${casePattern(key)})\n${ghServeLines(routeAnswer(a))}    ;;`,
	);
	if (!("graphql" in routes)) {
		const file = path.join(dir, "gh-links.js");
		fs.writeFileSync(
			file,
			`${CITED_GRAPHQL_FAKE}
${LINKS_GRAPHQL_FAKE}
const argv = process.argv.slice(2);
const links = ${JSON.stringify(buildLinkNodes(routes))};
const query = argv.find((a) => a.startsWith("query=")) ?? "";
serveAnswer(
	query.includes("issueOrPullRequest") && query.includes("comments(first: ")
		? answerCited(argv, ${JSON.stringify(lowerKeys(cited))})
		: answerLinks(argv, (repo, n) => links[repo.toLowerCase() + "#" + n] ?? null),
);
`,
		);
		arms.unshift(`  graphql) exec node ${shellQuote(file)} "$@" ;;`);
	}
	const script = `#!/bin/sh
${log ? `printf '%s\\n' "$*" >> ${shellQuote(log)}\n` : ""}${bodies ? `case " $* " in *" --body-file - "*) cat >> ${shellQuote(bodies)} ;; esac\n` : ""}route_key() {
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

export function stubGhHandler(dir: string, handler: string): StubGh {
	return stubGhScript(
		dir,
		`#!/usr/bin/env node
const argv = process.argv.slice(2);
const env = process.env;
const cwd = process.cwd();
const stdin = argv.some((x) => x === "-" || x.endsWith("@-")) ? require("node:fs").readFileSync(0, "utf8") : "";
const out = (s) => process.stdout.write(s);
const err = (s) => process.stderr.write(s);
const exit = (code) => process.exit(code);
${handler}`,
	);
}

export interface GhStubServer {
	script: string;
	close: () => Promise<void>;
}

export async function serveGhStub(handler: string): Promise<GhStubServer> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gh-server-stub-"));
	const file = path.join(dir, "handler.js");
	fs.writeFileSync(file, handler);
	const child = spawn(
		process.execPath,
		[path.join(__dirname, "gh-server-stub.js"), file],
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
			reject(new Error(`gh-server-stub exited ${code} before listening`)),
		);
		child.stdout.once("data", (b: Buffer) => {
			const n = Number(String(b));
			if (Number.isInteger(n) && n > 0) resolve(n);
			else reject(new Error(`gh-server-stub printed no port: ${String(b)}`));
		});
	}).catch(async (e) => {
		await close();
		throw e;
	});
	return { script: buildServerClient(port), close };
}

export const HERE = "https://api.github.com/repos/o/here";
export const THERE = "https://api.github.com/repos/o/there";

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

export const subIssuesArm = (dir: string) => `  */sub_issues)
    n=$(echo "$2" | sed 's|.*/issues/||; s|/sub_issues||')
    if [ -f ${shellQuote(dir)}/children-$n.status ]; then
      cat ${shellQuote(dir)}/children-$n.out
      cat ${shellQuote(dir)}/children-$n.err >&2
      exit $(cat ${shellQuote(dir)}/children-$n.status)
    fi
    ${ghServeLines(subIssuesAnswer([]))}    ;;`;

export const buildLinkReadArms = (
	answers: LinkReadAnswers,
	{ childrenWhen }: { childrenWhen?: string } = {},
) =>
	Object.entries(LINK_READS)
		.map(([key, { jq, answer }]) => {
			const lines = ghServeLines(
				answers[key as keyof LinkReadAnswers] ?? answer,
			);
			const gated =
				key === "children" && childrenWhen
					? `if ${childrenWhen}; then\n${lines}fi\nexit 0\n`
					: lines;
			return `  *${shellQuote(` --jq ${jq}`)})\n${gated}    ;;`;
		})
		.join("\n");
