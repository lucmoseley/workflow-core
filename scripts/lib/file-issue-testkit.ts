/*
 * The sandbox file-issue's tests share (#5150): its program cases, which run
 * scripts/file-issue.js through runInProcess against the gh stub with the real
 * link underneath, and its module cases, which call lib/file-issue-core.js's
 * fileIssue on the in-process gh router and the link fake. Both read one set
 * of sandbox files — `issues`, `issues-open`, `list-fails`, `assign-fails`,
 * `post-err`, `api/` — and both log every gh argv to `gh-calls`, so a case
 * reads the same whichever seam it runs on.
 */

import fs from "node:fs";
import path from "node:path";
import { vi } from "vitest";
import { freshSandbox, issueClaims } from "./arbiter-testkit";
import { fileIssue } from "./file-issue-core.js";
import { readGateWrite } from "./gate-judge.js";
import { asRecorded, buildJqLines, ghServe } from "./gh-fake";
import { buildLinkReadArms, stubGhScript } from "./gh-stub";
import { ORIGINS } from "./issue-origin";
import { runInProcess } from "./run-in-process";
import { shellQuote } from "./sh-quote.js";
import { TAKES_VALUES } from "./takes-label";

export const SCRIPT = path.resolve(__dirname, "..", "file-issue.js");
export const ME = "sess-me";
/** The number the stubbed create returns — nothing a caller could guess. */
export const NEW = 561;
/** The sub-issue id the stub's link reads answer for #NEW. */
export const NEW_ID = 987_654;
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

export const assignCall = `issue edit ${NEW} --repo acme/widgets --add-assignee @me`;

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

	const setUp = (parentLabels: string[] = ["kind:spec"], over: object = {}) => {
		serve(
			"repos/acme/widgets/labels",
			LABELS.map((name) => ({ name })),
		);
		serve("repos/acme/widgets/issues/528", issue(528, parentLabels, over));
		serve("repos/acme/widgets/issues/528/sub_issues", [[]]);
	};

	/**
	 * The `gh` stub. `issue list` answers from the `issues` file, or `[]`;
	 * `issue create` saves its stdin body and prints the new URL;
	 * the sub-issue POST fails with the text in `post-err` where it exists, and
	 * otherwise makes the parent list the child; `api <path>` answers from
	 * serve()'s files. Every argv is logged.
	 */
	const ghStub = () =>
		stubGhScript(
			sb.dir,
			`#!/bin/sh
echo "$*" >> ${shellQuote(at("gh-calls"))}
case "$*" in
  "issue create"*)
    cat > ${shellQuote(at("body-seen"))}
    echo ${shellQuote(`https://github.com/acme/widgets/issues/${NEW}`)}; exit 0 ;;
  "issue list"*)
    if [ -f ${shellQuote(at("list-fails"))} ]; then echo "HTTP 502: Bad Gateway" >&2; exit 1; fi
    f=${shellQuote(at("issues"))}; case "$*" in *"--state open --json number,title,state"*) f=${shellQuote(at("issues-open"))} ;; esac
    if [ -f "$f" ]; then cat "$f"; else echo "[]"; fi
    exit 0 ;;
  "issue edit"*)
    if [ -f ${shellQuote(at("assign-fails"))} ]; then echo "HTTP 403: no" >&2; exit 1; fi
    exit 0 ;;
  *"--method POST"*)
    if [ -f ${shellQuote(at("post-err"))} ]; then cat ${shellQuote(at("post-err"))} >&2; exit 1; fi
    touch ${shellQuote(at("linked"))}; exit 0 ;;
${buildLinkReadArms(
	{ id: buildJqLines(NEW_ID), children: buildJqLines(NEW) },
	{ childrenWhen: `[ -f ${shellQuote(at("linked"))} ]` },
)}
  "api "*)
    f=${shellQuote(at("api"))}/"$(echo "$2" | tr / _)"
    [ -f "$f" ] && cat "$f" && exit 0
    echo "HTTP 404: Not Found" >&2; exit 1 ;;
esac
exit 0
`,
		);

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
	const ok = (stdout: string) => ({ status: 0, stdout, stderr: "" });
	const failed = (stderr: string) => ({ status: 1, stdout: "", stderr });

	/** `issue list`: the `issues` rows, or `issues-open` for the open read,
	 *  as written — a case's rows carry fields (a map's labels) the real
	 *  `--json` read never asks for, so no recorded shape holds them. */
	const answerList = (joined: string) => {
		if (has("list-fails")) return failed("HTTP 502: Bad Gateway\n");
		const f = joined.includes("--state open --json number,title,state")
			? at("issues-open")
			: at("issues");
		return ok(fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "[]\n");
	};

	/** `api <path>`: serve()'s file for it, or gh's 404. */
	const answerApi = (apiPath: string) => {
		const f = path.join(at("api"), apiPath.replaceAll("/", "_"));
		if (!fs.existsSync(f)) return failed("HTTP 404: Not Found\n");
		return ok(recordedApi(apiPath, fs.readFileSync(f, "utf8")));
	};

	/** What the stub answers `args`, in-process, through the shared fake. */
	const ghRouter = (args: string[], opts: { input?: unknown } = {}): string => {
		const joined = args.join(" ");
		fs.appendFileSync(at("gh-calls"), `${joined}\n`);
		let answer = ok("");
		if (joined.startsWith("issue create")) {
			fs.writeFileSync(at("body-seen"), String(opts.input ?? ""));
			answer = ok(
				has("create-silent")
					? ""
					: `https://github.com/acme/widgets/issues/${NEW}\n`,
			);
		} else if (joined.startsWith("issue list")) answer = answerList(joined);
		else if (joined.startsWith("issue edit"))
			answer = has("assign-fails") ? failed("HTTP 403: no\n") : ok("");
		else if (args[0] === "api") answer = answerApi(String(args[1]));
		return ghServe(answer)(args);
	};

	/** lib/file-issue-core.js's fileIssue, its ports the module cases'. */
	const core = (
		args: string[],
		{
			stdin = "Ticket body.\n",
			sessionId = ME,
			bare = false,
			extraEnv = {},
		}: RunOpts = {},
	): Ran => {
		vi.stubEnv("WFC_CLAUDE_BIN", oracle([ME]));
		vi.stubEnv("CLAUDE_CODE_SESSION_ID", sessionId ?? undefined);
		for (const [k, v] of Object.entries(extraEnv)) vi.stubEnv(k, v);
		const { code, stdout, stderr } = fileIssue(declare(args, bare), {
			gh: ghRouter,
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
		});
		return { status: code, stdout, stderr };
	};

	return {
		sb,
		at,
		serve,
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

/**
 * A served `api` answer, held to gh's recorded shape where one is recorded:
 * an issue, a sub-issues page, the labels.
 * @param apiPath
 * @param text the served JSON
 */
function recordedApi(apiPath: string, text: string): string {
	const value = JSON.parse(text);
	if (/^repos\/[^/]+\/[^/]+\/issues\/\d+$/.test(apiPath))
		return asRecorded("issue", value);
	if (apiPath.endsWith("/sub_issues"))
		return asRecorded("subIssuesPage", value);
	return text;
}

/**
 * What lib/link-writer.js's runLinkSync answers, mapped as
 * scripts/file-issue.js maps it, for the link of `child` under `parent` on the
 * stub: a POST failing with `postErr`, or landing where it is null — the
 * loop check partial there, since the stub's reads never reach the child.
 * file-issue-link.contract.test.ts holds every answer to the real call.
 * @param parent
 * @param child
 * @param postErr  the POST's stderr, or null where it lands
 */
export function answerLink(
	parent: number,
	child: number,
	postErr: string | null,
): { ok: string; warning?: string } | { error: string } {
	if (postErr === null)
		return {
			ok: `linked #${child} as a sub-issue of #${parent}`,
			warning: `warning — the loop check was partial: could not read #${child} (HTTP 404: Not Found); linking anyway, and check-issue-cycles.js is the backstop.`,
		};
	if (/7 layers/.test(postErr))
		return {
			error: `#${parent} is 7 layers deep — give #${child} the SAME parent as #${parent} instead, and say in its body why it is a peer (docs/agents/issue-tracker.md)`,
		};
	return { error: `POST failed: ${postErr.trim()}` };
}
