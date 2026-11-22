#!/usr/bin/env node

const fs = require("node:fs");
const { listedSessionIds } = require("./lib/agent-liveness");
const { scriptPath } = require("./lib/script-path.js");
const { flagValue, parseOrExit } = require("./lib/cli-args.js");
const { parseIssueNumber } = require("./lib/issue-number.js");
const { parseErrLine, ghGetRetrying } = require("./lib/gh");
const { blockedByMany } = require("./lib/blocked-by-batch");
const { resolveGate } = require("./lib/issue-gate");
const store = require("./lib/arbiter-store");
const { execGit } = require("./lib/git.js");
const { isRouteStep } = require("./lib/decision-labels.js");

/** @param {string} msg */
const say = (msg) => process.stderr.write(`wayfinder-frontier: ${msg}\n`);

const REPO = "{owner}/{repo}";

/**
 * @param {string} dir
 * @returns {string | null}
 */
function readRealOrNull(dir) {
	try {
		return fs.realpathSync(dir);
	} catch {
		return null;
	}
}

function storeElsewhere() {
	let cwdRoot;
	try {
		cwdRoot = execGit(["rev-parse", "--show-toplevel"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return {
			unknown:
				"you are not in a git repository, so the claim store's tree cannot be compared with yours",
		};
	}
	const a = readRealOrNull(store.paths.repoRoot());
	const b = readRealOrNull(cwdRoot);
	if (!a)
		return {
			unknown: `the claim store's root (${store.paths.repoRoot()}) does not resolve`,
		};
	if (!b)
		return {
			unknown: `your own repository root (${cwdRoot}) does not resolve`,
		};
	return a === b ? null : { store: a, cwd: b };
}

const USAGE =
	"usage: wayfinder-frontier.js [--numbers | --map <n>]\n" +
	"  (no flag)  one line per claim: #issue, holding session, claimed-at\n" +
	"  --numbers  bare issue numbers, one per line, for a shell step\n" +
	"  --map <n>  the frontier of map <n>: its open, typed, unblocked,\n" +
	"             unclaimed children, bare numbers in map order\n";

/**
 * @param {Record<string, string | true>} flags
 * @returns {{ error: string } | { numbers: boolean, map: number | null }}
 */
function parseArgs(flags) {
	const numbers = flags["--numbers"] === true;
	const raw = flagValue(flags, "--map");
	if (raw === undefined) return { numbers, map: null };
	const map = parseIssueNumber(raw);
	if (map === null) return { error: `--map wants an issue number, not ${raw}` };
	if (numbers)
		return { error: "--numbers and --map are alternatives, not a pair" };
	return { numbers, map };
}

/**
 * @param {number} map
 * @returns {Promise<{ error: string } | { total: number, children: {number: number, body: string, labels: string[]}[] }>}
 */
async function openChildren(map) {
	const r = await ghGetRetrying(`repos/${REPO}/issues/${map}/sub_issues`, {
		strict: true,
	});
	if (!r.ok)
		return { error: `could not read the children of #${map} (${r.error})` };
	return {
		total: r.out.length,
		children: r.out
			.filter(
				/** @param {{ state: string, pull_request?: unknown }} i */
				(i) => i.state === "open" && !i.pull_request,
			)
			.map(
				/** @param {{ number: number, body?: string | null, labels?: {name: string}[] }} i */
				(i) => ({
					number: i.number,
					body: i.body ?? "",
					labels: (i.labels ?? []).map((l) => l.name),
				}),
			),
	};
}

/**
 * @param {{number: number, labels: string[]}[]} children
 * @returns {Set<number>}
 */
function untypedChildren(children) {
	const untyped = new Set();
	for (const { number, labels } of children) {
		if (isRouteStep(labels)) continue;
		untyped.add(number);
		if (labels.includes("kind:spec"))
			say(
				`#${number} is a kind:spec, whose work sits on its tickets, so it is left off the frontier.`,
			);
		else if (labels.includes("kind:brief"))
			say(
				`#${number} is a kind:brief, awaiting its spec, so it is left off the frontier.`,
			);
		else
			say(
				`#${number} carries no wayfinder:<type> label, so it is left off the frontier — label it if it is a decision.`,
			);
	}
	return untyped;
}

/**
 * @param {{number: number, body: string}[]} children
 * @returns {Set<number>}
 */
function gatedChildren(children) {
	const gated = new Set();
	for (const { number, body } of children) {
		const {
			gate: until,
			gateOn: on,
			conflict,
			gateHolds,
			gateOnHolds,
		} = resolveGate(body);
		if (conflict) {
			say(
				`#${number} carries both **Gated until:** and **Gated on:**, so neither gates and it stays on the frontier — one gate line per issue.`,
			);
			continue;
		}
		if (until?.malformed) {
			say(
				`#${number} carries a **Gated until:** line that does not parse (${until.raw}), so it is left on the frontier — repair the marker.`,
			);
			continue;
		}
		if (gateHolds) {
			gated.add(number);
			continue;
		}
		if (on?.malformed) {
			say(
				`#${number} carries a **Gated on:** line that does not parse (${on.reason}: ${on.raw}), so it is left on the frontier — repair the marker.`,
			);
			continue;
		}
		if (gateOnHolds) gated.add(number);
	}
	return gated;
}

/**
 * @param {number[]} children
 * @returns {Promise<{ error: string } | { blocked: Set<number> }>}
 */
async function blockedChildren(children) {
	const reads = await blockedByMany(
		children.map((number) => ({ number })),
		{ repo: REPO, home: REPO, strict: true },
	);
	const results = reads.map(({ issue, read }) => ({
		n: issue.number,
		r: read,
	}));
	const failed = results.filter((x) => !x.r.ok);
	const first = failed[0];
	if (first && !first.r.ok)
		return {
			error:
				`could not read the blockers of #${first.n} (${first.r.error})` +
				(failed.length > 1 ? `, and ${failed.length - 1} more` : ""),
		};
	return {
		blocked: new Set(
			results
				.filter((x) => x.r.ok && x.r.edges.some((b) => b.state === "open"))
				.map((x) => x.n),
		),
	};
}

/**
 * @param {number} map
 * @param {Set<number>} liveIssues
 */
async function frontier(map, liveIssues) {
	const kids = await openChildren(map);
	if ("error" in kids) {
		say(
			`${kids.error}, so the frontier is unknown — not empty. Drop nothing on this answer.`,
		);
		return 1;
	}
	if (!kids.total) {
		say(
			`#${map} has no sub-issues at all, so it is either not a map or its children were never linked. Refusing rather than reading that as an empty frontier.`,
		);
		return 1;
	}
	if (kids.children.length === 0) return 0;

	const untyped = untypedChildren(kids.children);
	const typed = kids.children.filter((c) => !untyped.has(c.number));
	if (typed.length === 0) return 0;

	const numbers = typed.map((c) => c.number);
	const blocked = await blockedChildren(numbers);
	if ("error" in blocked) {
		say(
			`${blocked.error}, so the frontier is unknown — not empty. Drop nothing on this answer.`,
		);
		return 1;
	}
	const gated = gatedChildren(typed);

	for (const n of numbers)
		if (!blocked.blocked.has(n) && !liveIssues.has(n) && !gated.has(n))
			process.stdout.write(`${n}\n`);
	return 0;
}

/** @param {string[]} argv */
async function main(argv) {
	const { flags } = parseOrExit(argv, {
		usage: USAGE.trimEnd(),
		flags: { "--numbers": "boolean", "--map": "value" },
	});
	const args = parseArgs(flags);
	if ("error" in args) {
		say(args.error);
		process.stderr.write(USAGE);
		return 2;
	}
	const { numbers: numbersOnly, map } = args;

	const elsewhere = storeElsewhere();
	if (elsewhere?.store)
		say(
			`the claim store belongs to ${elsewhere.store}, not the tree you are in (${elsewhere.cwd}), so an empty list here means the wrong store was read — not that nothing is claimed.`,
		);
	if (elsewhere && map !== null) {
		say(
			`${elsewhere.unknown ?? "the claim store belongs to another tree"}, so the claim filter cannot be vouched for and a frontier built on it could offer work another session is already doing. Refusing.`,
		);
		return 1;
	}

	const live = liveClaims();
	if (typeof live === "number") return live;

	if (map !== null) return frontier(map, new Set(live.map((c) => c.issue)));
	printLive(live, numbersOnly);
	return 0;
}

function liveClaims() {
	// lucmoseley/mantahostels#174
	const { held, kept, why } = store.heldIssues(listedSessionIds());
	if (why && !kept) {
		say(
			`${why}, so what is claimed is unknown — not nothing. Drop nothing on this answer. See: node ${scriptPath("check-guard-errors.js")}`,
		);
		return 1;
	}
	if (kept)
		say(
			`${why}, so every claim below stands and an issue excluded as claimed may in fact be free.`,
		);

	const listedClaims = store.listIssueClaims();
	if (listedClaims === null) {
		say(
			`could not read the issue-claim store at ${store.paths.issueClaimsDir()}, so what is claimed is unknown — not nothing. Drop nothing on this answer.`,
		);
		return 1;
	}
	if (listedClaims.why) {
		say(`${listedClaims.why}. Drop nothing on this answer.`);
		return 1;
	}
	const claims = listedClaims.claims;

	return claims
		.filter((c) => held.has(c.issue))
		.sort((a, b) => a.issue - b.issue);
}

/**
 * @param {{ issue: number, sessionId: string, claimedAt: string }[]} live
 * @param {boolean} numbersOnly
 */
function printLive(live, numbersOnly) {
	if (numbersOnly) {
		for (const issue of new Set(live.map((c) => c.issue)))
			process.stdout.write(`${issue}\n`);
		return;
	}
	if (live.length === 0) {
		process.stdout.write("No issues are claimed by a live session.\n");
		return;
	}
	for (const c of live)
		process.stdout.write(`#${c.issue}\t${c.sessionId}\tsince ${c.claimedAt}\n`);
}

module.exports = { main };

if (require.main === module)
	main(process.argv.slice(2)).then(
		(code) => {
			// process.exit() can cut off pending writes to a piped stdout: https://nodejs.org/api/process.html#processexitcode
			process.exitCode = code;
		},
		(e) => {
			say(
				`${parseErrLine(e)} — an unexpected failure, so nothing above is an answer. Drop nothing.`,
			);
			process.exitCode = 1;
		},
	);
