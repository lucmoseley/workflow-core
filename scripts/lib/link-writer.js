#!/usr/bin/env node
/*
 * link-writer.js — the one writer of blocker and sub-issue links (#5070).
 * It resolves a reference to its database id, refuses a link that would
 * close a loop of open issues waiting on each other (lib/wait-graph.js),
 * POSTs, and verifies from the side that answers at once. scripts/
 * link-sub-issue.sh and scripts/link-blocker.js are its CLIs; every in-repo
 * script that links goes through runLinkSync, since a `gh` a script shells
 * out to never reaches a PreToolUse guard.
 *
 * WHY A WRITER. The hand-assembled call fails SILENTLY (mantahostels#1150; the
 * rules it encodes are docs/agents/issue-tracker.md, "Placing a new issue"):
 *
 *  - `-f` sends the id as a JSON string where the endpoint wants an integer,
 *    and the link is never made. Only `-F` sends a number.
 *  - An id read inline sends an EMPTY STRING on a transient error, and the
 *    422 then complains about the type, hiding the cause. So the id is read
 *    first and asserted numeric before the POST.
 *  - A sub-issue's `parent_issue_url` lags the POST by minutes, so a
 *    sub-issue is verified from the PARENT's list, which answers at once; a
 *    blocker's canonical list read in the same breath as its POST answers
 *    empty, so it is read in a separate call after a pause. The retries cover
 *    propagation only, and their count is an unmeasured guess.
 *  - A 422 naming an existing parent is PROOF THE FIRST CALL WORKED. Never
 *    re-POST on it.
 *  - A closed parent is refused before the POST over a child that is not
 *    closed: the link would hide an open child from every map that walks open
 *    issues (#3650). A closed child may go under a closed parent, as into an
 *    archival container (#5086).
 *
 * A LOOP IS REFUSED. "A is blocked by B" and "P gets child C" each add an
 * edge from the waiting issue to the waited-on one; it closes a loop exactly
 * when the waited-on one already reaches the waiting one. Where the walk
 * cannot read a node the link is made anyway, with a warning naming each
 * unread issue: a link write is worth letting through an outage, and
 * check-issue-cycles.js, which fails closed, is the backstop (#5070).
 *
 * EXIT 0 only where the link is in place; 3 refused with nothing changed (a
 * self-link, or a loop), as park-blocked.sh's precondition refusal; 1 any
 * other failure, with a message on stderr. Each failure also names a Reason,
 * set where it is raised, which runLinkSync's callers branch on and never on
 * the message (#5096).
 *
 * WFC_LINK_REPO (owner/name) names the repo a local `#n` is in, else the
 * tracker; runLinkSync sets it for a caller linking in another repo.
 * Test seams: WFC_LINK_RETRIES (verification attempts), WFC_LINK_SLEEP
 * (seconds between them).
 */

const { spawnSync } = require("node:child_process");
const { parseArgs } = require("node:util");
const { ghAsync, parseErrLine } = require("./gh");
const { pathTo, linkText } = require("./wait-graph.js");
const {
	parseQualifiedRef,
	parseRepoOfUrl,
	refKey,
	refLabel,
} = require("./issue-ref.js");
const { resolveKey } = require("./workflow-core-config.js");
const { caught } = require("./caught.js");
const { docPath } = require("./script-path.js");

/** @typedef {import("./wait-graph.js").Ref} Ref */
/** @typedef {import("./wait-graph.js").Link} Link */
/**
 * Why a link was not made: `self` and `loop` refusals; `unlisted`, a
 * POST that succeeded but whose link no read shows; `cap`, a parent at
 * GitHub's 100-child limit; `layers`, a parent 7 layers deep; `closed-parent`;
 * `rejected`, any other 422; `other`, everything else.
 * @typedef {"self"|"loop"|"unlisted"|"cap"|"layers"|"closed-parent"|"rejected"|"other"} Reason
 */
/**
 * A link command's outcome: `out` the success line, `warning` the
 * partial-check lines, `err` the failure or refusal itself and `reason` its
 * kind, each empty where linked.
 * @typedef {{code: 0|1|3, out: string, err: string, warning: string,
 *   reason: Reason|""}} Outcome
 */
/** @typedef {(line: string) => void} Warn takes each partial-check line, kept on success and failure alike */
/** @typedef {{replaceParent: boolean}} LinkOptions `replaceParent` re-roots a sub-issue that already has a parent */

const PLACING = `${docPath("agents/issue-tracker.md")} §Placing a new issue`;

/** A failure carrying its exit code, its reason and its stderr line. */
class LinkExit extends Error {
	/** @param {1|3} code @param {Reason} reason @param {string} message */
	constructor(code, reason, message) {
		super(message);
		this.code = code;
		this.reason = reason;
	}
}

/** @param {Reason} reason @param {string} message @returns {never} */
function fail(reason, message) {
	throw new LinkExit(1, reason, message);
}
/** @param {"self"|"loop"} reason @param {string} message @returns {never} */
function refuse(reason, message) {
	throw new LinkExit(3, reason, message);
}

/**
 * A failed POST's reason, read from gh's text.
 * KNOWN RESIDUAL: `cap` is matched on gh's prose, so a reword of GitHub's
 * 100-child message demotes it to `rejected`.
 * @param {string} text
 * @returns {Reason}
 */
function postReason(text) {
	if (text.includes("100 sub-issues")) return "cap";
	return /\b422\b/.test(text) ? "rejected" : "other";
}

/** @param {number} ms */
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/** The verification reads' count, and their spacing: 2 s, a first guess, unmeasured. */
const timing = () => ({
	retries: Number(process.env.WFC_LINK_RETRIES ?? 4),
	sleepMs: Number(process.env.WFC_LINK_SLEEP ?? 2) * 1000,
});

/**
 * One `--jq` read's printed text, or null where gh failed.
 * @param {string[]} args
 */
async function readGhText(args) {
	try {
		return (await ghAsync(args)).trim();
	} catch {
		return null;
	}
}

/**
 * The repo every local `#n` names: WFC_LINK_REPO, else the tracker as every
 * tracker script reads it — the config's "tracker", else the origin remote
 * (#3556). gh's `{owner}/{repo}` is resolved to its name, so a walk's keys
 * match the names GitHub answers with.
 */
async function resolveLocalRepo() {
	let repo = process.env.WFC_LINK_REPO || resolveKey("tracker");
	if (typeof repo !== "string" || !repo)
		fail(
			"other",
			'could not resolve the tracker — declare "tracker" in .claude/workflow-core.json or pass WFC_LINK_REPO',
		);
	if (repo.includes("{owner}")) {
		const named = await readGhText([
			"api",
			`repos/${repo}`,
			"--jq",
			".full_name",
		]);
		if (!named || !/^[\w.-]+\/[\w.-]+$/.test(named))
			fail(
				"other",
				`could not resolve ${repo} to its owner/name (got '${named ?? ""}') — nothing was POSTed`,
			);
		repo = named;
	}
	return repo;
}

/**
 * The refusal of a link that closes a loop: the new link, then each existing
 * one, then the rule that fixes the authoring error.
 * @param {Link} link
 * @param {Link[]} path
 * @param {string} home
 */
const buildLoopRefusal = (link, path, home) =>
	[
		`refused — ${linkText(link, home)} would close a loop of open issues waiting on each other, so none of them could ever close:`,
		`  ${linkText(link, home)}   (the new link)`,
		...path.map((l) => `  ${linkText(l, home)}`),
		"Block on the build unit that does the work, never on a spec or map that stays open for its own follow-ups;",
		`a sub-issue holds its parent open (${PLACING}). Nothing was changed.`,
	].join("\n");

/**
 * Refuses `link` where its target already reaches its source; otherwise
 * returns the warning owed where the walk could not read every node, else "".
 * @param {Link} link
 * @param {string} home
 * @returns {Promise<string>}
 */
async function checkLoop(link, home) {
	const { path, unread } = await pathTo(link.to, link.from);
	if (path) refuse("loop", buildLoopRefusal(link, path, home));
	if (unread.length === 0) return "";
	return `warning — the loop check was partial: could not read ${unread
		.map((u) => `${refLabel(u.ref, home)} (${u.error})`)
		.join(", ")}; linking anyway, and check-issue-cycles.js is the backstop.`;
}

/**
 * A numeric database id from a `--jq .id` read of `ref`.
 * @param {Ref} ref
 * @param {string} home
 */
async function readDatabaseId(ref, home) {
	const id = await readGhText([
		"api",
		`repos/${ref.repo}/issues/${ref.number}`,
		"--jq",
		".id",
	]);
	if (!id || !/^[0-9]+$/.test(id))
		fail(
			"other",
			`could not resolve the database id of ${refLabel(ref, home)} (got '${id ?? ""}') — nothing was POSTed`,
		);
	return id;
}

/**
 * Whether `listed()` holds within the retries, pausing between reads, and
 * first where `first` says so.
 * @param {() => Promise<boolean>} listed
 * @param {{retries: number, sleepMs: number, first?: boolean}} t
 */
async function waitFor(listed, { retries, sleepMs, first = false }) {
	for (let i = 0; i < retries; i++) {
		if (first || i > 0) await pause(sleepMs);
		if (await listed()) return true;
	}
	return false;
}

/**
 * @param {string[]} rest
 * @returns {{parent: number, child: number}}
 */
function parseSubIssueArgs(rest) {
	if (rest.length !== 2) fail("other", USAGE["sub-issue"]);
	const [p = "", c = ""] = rest.map((a) => a.replace(/^#/, ""));
	if (!/^[0-9]{1,9}$/.test(p))
		fail("other", `parent '${rest[0]}' is not an issue number`);
	if (!/^[0-9]{1,9}$/.test(c))
		fail("other", `child '${rest[1]}' is not an issue number`);
	if (p === c) refuse("self", `an issue cannot be its own parent (#${p})`);
	return { parent: Number(p), child: Number(c) };
}

/**
 * Makes `child` a sub-issue of `parent`, in one repo.
 * @param {string[]} args `<parent> <child>`
 * @param {Warn} warn
 * @param {LinkOptions} opts
 * @returns {Promise<string>} stdout
 */
async function linkSubIssue(args, warn, { replaceParent }) {
	const { parent, child } = parseSubIssueArgs(args);
	const repo = await resolveLocalRepo();
	const t = timing();
	const listsChild = async () => {
		const listed = await readGhText([
			"api",
			`repos/${repo}/issues/${parent}/sub_issues`,
			"--paginate",
			"--jq",
			".[].number",
		]);
		return listed?.split("\n").includes(String(child)) ?? false;
	};

	await assertParentHidesNoOpenChild(repo, parent, child);
	const id = await readDatabaseId({ repo, number: child }, repo);
	const warning = await checkLoop(
		{
			from: { repo, number: parent },
			to: { repo, number: child },
			kind: "child",
		},
		repo,
	);
	if (warning) warn(warning);
	const already = await postSubIssue({
		repo,
		parent,
		child,
		id,
		replaceParent,
		listsChild,
		t,
	});
	if (already) return already;
	if (await waitFor(listsChild, t))
		return `linked #${child} as a sub-issue of #${parent}\n`;
	return fail(
		"unlisted",
		`POST returned success but #${parent} still does not list #${child} after ${t.retries} reads — do NOT re-POST; check the link in the web UI`,
	);
}

/** @param {string} repo @param {number} n */
const readState = (repo, n) =>
	readGhText(["api", `repos/${repo}/issues/${n}`, "--jq", ".state"]);

/**
 * Refuses a parent whose state cannot be read, or a closed one over a child
 * that is not closed: the link would hide an open child from every map that
 * walks open issues (#3650). A closed child may go under a closed parent, as
 * into an archival container.
 * @param {string} repo
 * @param {number} parent
 * @param {number} child
 */
async function assertParentHidesNoOpenChild(repo, parent, child) {
	const state = await readState(repo, parent);
	if (state === "closed" && (await readState(repo, child)) !== "closed")
		fail(
			"closed-parent",
			`#${parent} is closed — link #${child} under an open issue, or file it with file-issue.js --standalone "<why>"; nothing was POSTed`,
		);
	if (state !== "open" && state !== "closed")
		fail(
			"other",
			`could not read the state of #${parent} (got '${state ?? ""}') — nothing was POSTed; check \`gh auth status\` and re-run`,
		);
}

/**
 * The POST, and what its refusal means: the already-parented 422 reads as
 * success where the parent lists the child.
 * @param {{repo: string, parent: number, child: number, id: string,
 *   replaceParent: boolean, listsChild: () => Promise<boolean>,
 *   t: {retries: number, sleepMs: number}}} at
 * @returns {Promise<string|null>} the line to print where it was already linked
 */
async function postSubIssue({
	repo,
	parent,
	child,
	id,
	replaceParent,
	listsChild,
	t,
}) {
	try {
		await ghAsync([
			"api",
			"--method",
			"POST",
			`repos/${repo}/issues/${parent}/sub_issues`,
			"-F",
			`sub_issue_id=${id}`,
			...(replaceParent ? ["-F", "replace_parent=true"] : []),
		]);
		return null;
	} catch (e) {
		const out = `${caught(e).stderr ?? ""}${caught(e).stdout ?? ""}`;
		// The one failure meaning the opposite of what it says: the child is
		// already parented. KNOWN RESIDUAL: both 422s below are matched on gh's
		// prose, GitHub's status being 422 for either; a reword demotes this to
		// the generic failure, the one place a reader might re-POST by hand.
		if (out.includes("only have one parent")) {
			if (await waitFor(listsChild, t))
				return `#${child} was already a sub-issue of #${parent}\n`;
			fail(
				"other",
				`#${child} already has a different parent — re-root it with link-sub-issue.sh ${parent} ${child} --replace-parent, or detach it first: gh api --method DELETE repos/${repo}/issues/<parent>/sub_issue -F sub_issue_id=${id}`,
			);
		}
		if (out.includes("7 layers"))
			fail(
				"layers",
				`#${parent} is 7 layers deep — give #${child} the SAME parent as #${parent} instead, and say in its body why it is a peer (${docPath("agents/issue-tracker.md")})`,
			);
		const text = out.trim() || parseErrLine(e);
		return fail(postReason(text), `POST failed: ${text}`);
	}
}

/**
 * `#n`, `n` or `owner/name#n` as a ref, a bare number in `home`.
 * @param {string} text
 * @param {() => Promise<string>} home
 * @returns {Promise<Ref|null>}
 */
async function parseRef(text, home) {
	const q = parseQualifiedRef(text);
	if (q) return q;
	const m = /^#?([0-9]{1,9})$/.exec(text);
	return m ? { repo: await home(), number: Number(m[1]) } : null;
}

/**
 * Whether `blocked`'s canonical blocker list names `blocker`.
 * @param {Ref} blocked
 * @param {Ref} blocker
 */
async function listsBlocker(blocked, blocker) {
	try {
		const out = await ghAsync([
			"api",
			`repos/${blocked.repo}/issues/${blocked.number}/dependencies/blocked_by`,
			"--paginate",
			"--slurp",
		]);
		/** @type {{number: number, repository_url?: string}[]} */
		const rows = out.trim() ? JSON.parse(out).flat() : [];
		return rows.some(
			(r) =>
				refKey({
					repo: parseRepoOfUrl(r.repository_url) ?? blocked.repo,
					number: r.number,
				}) === refKey(blocker),
		);
	} catch {
		return false;
	}
}

/**
 * Makes `blocker` block `blocked`, in any repos.
 * @param {string[]} args `<blocked> <blocker>`, each `n`, `#n` or `owner/name#n`
 * @param {Warn} warn
 * @returns {Promise<string>} stdout
 */
async function linkBlocker(args, warn) {
	if (args.length !== 2) fail("other", USAGE.blocker);
	/** @type {string|undefined} */
	let local;
	const home = async () => {
		local ??= await resolveLocalRepo();
		return local;
	};
	const [a = "", b = ""] = args;
	const blocked = await parseRef(a, home);
	if (!blocked)
		fail("other", `blocked issue '${a}' is not a number or owner/name#n`);
	const blocker = await parseRef(b, home);
	if (!blocker) fail("other", `blocker '${b}' is not a number or owner/name#n`);
	// Labels read from the session's own tracker, so its own issues print as
	// `#n`; where none resolves, from the blocked issue's repo.
	const view = await home().catch(() => blocked.repo);
	if (refKey(blocked) === refKey(blocker))
		refuse("self", `an issue cannot block itself (${refLabel(blocked, view)})`);
	const label = refLabel(blocker, view);
	const subject = refLabel(blocked, view);
	const id = await readDatabaseId(blocker, view);
	const warning = await checkLoop(
		{ from: blocked, to: blocker, kind: "blocker" },
		view,
	);
	if (warning) warn(warning);

	const t = timing();
	const listed = () => listsBlocker(blocked, blocker);
	try {
		await ghAsync([
			"api",
			"--method",
			"POST",
			`repos/${blocked.repo}/issues/${blocked.number}/dependencies/blocked_by`,
			"-F",
			`issue_id=${id}`,
		]);
	} catch (e) {
		if (await waitFor(listed, { ...t, retries: 1, first: true }))
			return `${subject} was already blocked by ${label}\n`;
		const text = parseErrLine(e);
		fail(postReason(text), `POST failed: ${text}`);
	}
	if (await waitFor(listed, { ...t, first: true }))
		return `linked ${subject} as blocked by ${label}\n`;
	return fail(
		"unlisted",
		`POST returned success but ${subject}'s blocked_by list still does not name ${label} after ${t.retries} reads — do NOT re-POST; check the link in the web UI`,
	);
}

/**
 * A failure no link step raised, a bad command line among them.
 * @param {string} err
 * @param {string} [warning]
 * @returns {Outcome}
 */
const otherFailure = (err, warning = "") => ({
	code: 1,
	out: "",
	err,
	warning,
	reason: "other",
});

/**
 * Runs one link command, never throwing.
 * @param {"sub-issue"|"blocker"} kind
 * @param {string[]} args
 * @param {LinkOptions} opts
 * @returns {Promise<Outcome>}
 */
async function runLink(kind, args, opts) {
	/** @type {string[]} */
	const warnings = [];
	/** @type {Warn} */
	const warn = (line) => warnings.push(line);
	try {
		const out = await (kind === "blocker"
			? linkBlocker(args, warn)
			: linkSubIssue(args, warn, opts));
		return { code: 0, out, err: "", warning: warnings.join("\n"), reason: "" };
	} catch (e) {
		const warning = warnings.join("\n");
		if (!(e instanceof LinkExit)) return otherFailure(parseErrLine(e), warning);
		return { code: e.code, out: "", err: e.message, warning, reason: e.reason };
	}
}

const USAGE = {
	blocker:
		"usage: link-blocker.js <blocked> <blocker> [--json] — each a bare number or owner/name#n",
	"sub-issue":
		"usage: link-sub-issue.sh <parent> <child> [--replace-parent] [--json]",
};

/**
 * The CLI: reads the command line strictly, prints the outcome under the
 * command's name, or as one JSON object on stdout where `--json` is anywhere
 * in argv, and exits with its code.
 * @param {"sub-issue"|"blocker"} kind
 * @param {string[]} argv
 * @returns {Promise<void>}
 */
function runCli(kind, argv) {
	const name = kind === "blocker" ? "link-blocker" : "link-sub-issue";
	const json = argv.includes("--json");
	/** @param {Outcome} r */
	const print = (r) => {
		if (json) process.stdout.write(`${JSON.stringify(r)}\n`);
		else {
			if (r.warning) process.stderr.write(`${name}: ${r.warning}\n`);
			process.stdout.write(r.out);
			if (r.err) process.stderr.write(`${name}: ${r.err}\n`);
		}
		process.exitCode = r.code;
	};
	/** @type {string[]} */
	let args;
	/** @type {LinkOptions} */
	let opts;
	try {
		const { values, positionals } = parseArgs({
			args: argv,
			allowPositionals: true,
			strict: true,
			options: {
				help: { type: "boolean" },
				json: { type: "boolean" },
				...(kind === "sub-issue"
					? { "replace-parent": { type: "boolean" } }
					: {}),
			},
		});
		if (values.help) {
			process.stdout.write(`${USAGE[kind]}\n`);
			return Promise.resolve();
		}
		args = positionals;
		opts = { replaceParent: values["replace-parent"] === true };
	} catch (e) {
		print(otherFailure(`${parseErrLine(e)} — ${USAGE[kind]}`));
		return Promise.resolve();
	}
	return runLink(kind, args, opts).then(print, (e) =>
		print(otherFailure(parseErrLine(e))),
	);
}

/**
 * runLink for a synchronous caller: the CLI in a child process with `--json`,
 * `repo` the repo a local `#n` names. A child that died before printing its
 * outcome reads as `other`, its stderr the error.
 * @param {"sub-issue"|"blocker"} kind
 * @param {string[]} args
 * @param {{repo?: string}} [opts]
 * @returns {Outcome}
 */
function runLinkSync(kind, args, { repo } = {}) {
	const r = spawnSync(process.execPath, [__filename, kind, ...args, "--json"], {
		encoding: "utf8",
		env: repo ? { ...process.env, WFC_LINK_REPO: repo } : process.env,
	});
	return (
		parseOutcome(r.stdout ?? "") ??
		otherFailure(
			(r.stderr || r.error?.message || "")
				.trim()
				.replace(/^link-(?:sub-issue|blocker|writer): /gm, "") ||
				`the link command exited ${r.status ?? r.signal} without an outcome`,
		)
	);
}

/**
 * The child's `--json` outcome, or null where stdout holds none.
 * @param {string} stdout
 * @returns {Outcome|null}
 */
function parseOutcome(stdout) {
	try {
		const o = JSON.parse(stdout);
		return o &&
			typeof o === "object" &&
			typeof o.code === "number" &&
			typeof o.err === "string"
			? /** @type {Outcome} */ (o)
			: null;
	} catch {
		return null;
	}
}

/**
 * The CLI's entry: `sub-issue|blocker <args>`.
 * @returns {Promise<void>}
 */
function main() {
	const [kind, ...args] = process.argv.slice(2);
	if (kind === "sub-issue" || kind === "blocker") return runCli(kind, args);
	process.stderr.write("usage: link-writer.js sub-issue|blocker <args>\n");
	process.exitCode = 1;
	return Promise.resolve();
}

module.exports = { runLinkSync, runCli, main };
if (require.main === module)
	main().catch((e) => {
		process.stderr.write(`link-writer: ${e}\n`);
		process.exitCode = 1;
	});
