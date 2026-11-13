/*
 * file-issue-core.js — scripts/file-issue.js's logic, in-process (#5150):
 * `fileIssue(argv, ports)` returns the exit code and both streams, and
 * scripts/file-issue.js only wires the production ports, writes what comes
 * back and exits. What it refuses, in what order, and the exit codes: that
 * script's header.
 *
 * Every refusal is a returned `{stop}`, never an exit: each step hands back
 * its value or the stop, and fileIssue returns the first stop it meets.
 */

const path = require("node:path");
const { flagValue, parse, CliExit } = require("./cli-args.js");
const { isRouteStep } = require("./decision-labels.js");
const { parseErrLine, ghApiSlurp } = require("./gh.js");
const { buildDistinctFromHint } = require("./similar-titles.js");
const {
	buildStandaloneLine,
	hasStandaloneLine,
} = require("./standalone-line.js");
const { readRuleText } = require("./rule-text.js");
const {
	IMPLEMENT_LABEL,
	buildSizeLineRefusal,
	sizeLineCandidates,
} = require("./size-line-check.js");
const { readSubIssues } = require("./issue-tree.js");
const { fromEnv } = require("./session-id.js");
const { takesLabel, takesRefusal } = require("./takes-label.js");
const { URGENT_LABEL, isPassingDown } = require("./urgent-label.js");
const {
	gateRuleHandover,
	listOpenMaps,
	MAP_LABEL,
	secondMapVerdict,
} = require("./issue-gate.js");
const { addedCheckVerdict } = require("./gate-check.js");
const {
	assignSelf,
	claimIfFree,
	labelNames,
	readIssue,
	readOwnFilings,
	readParent: readIssueParent,
	recordOwnAct,
	similarTitles,
} = require("./tracker-ops.js");
const { requireKey } = require("./workflow-core-config.js");
const { caught } = require("./caught.js");
const { buildFiledLine } = require("./filed-line.js");
const { parseIssueNumber } = require("./issue-number.js");
const { ORIGINS, isOrigin, originLabel } = require("./issue-origin.js");
const {
	appendSignatureLine,
	buildSignatureLine,
	readDeclared,
	withSignatureSection,
} = require("./fault-signature.js");
const { SIGNATURE_LABEL } = require("./signature-label.js");
const { hostRoot, worktreeRoot } = require("./host-root.js");
const { scriptPath } = require("./script-path.js");

const HUMAN_LABEL = takesLabel("human");

const USAGE = `usage: node ${scriptPath("file-issue.js")} --title T --label L [--label L…] (--parent P | --standalone "<why>") --body-file F|- --origin <class> (--fault-signature <file> | --no-fault) [--assign-self] [--distinct-from N[,N…]] [--size-line-checked N[,N…]]\n       node ${scriptPath("file-issue.js")} --check "<title>"`;

/** @type {import("./cli-args.js").CliSpec} */
const SPEC = {
	usage: USAGE,
	flags: {
		"--title": "value",
		"--label": "list",
		"--parent": "value",
		"--standalone": "value",
		"--body-file": "value",
		"--distinct-from": "list",
		"--size-line-checked": "list",
		"--assign-self": "boolean",
		"--origin": "value",
		"--fault-signature": "value",
		"--no-fault": "boolean",
		"--check": "list",
	},
};

/**
 * What the core asks of the world beyond the filesystem, the arbiter and the
 * session's environment, which it reads directly.
 * @typedef {object} FileIssuePorts
 * @property {import("./gh.js").GhRun} gh  every tracker read and write
 * @property {(repo: string, parent: number, child: number) =>
 *   {ok: string, warning?: string} | {error: string}} link  the sub-issue
 *   link, verified from the parent side
 * @property {(body: string) => {refusal: string|null, advice: string}} judge
 *   lib/gate-judge.js's readGateWrite on the file-issue route
 * @property {(file: string) => string} readBody  `-` is standard input;
 *   throws where it cannot be read
 * @property {() => number} now  the signature line's filed-at clock
 */

/** @typedef {{stop: number}} Stop */
/** @typedef {{code: number, stdout: string, stderr: string}} Outcome */

/** @param {unknown} x @returns {x is Stop} */
const isStop = (x) => typeof x === "object" && x !== null && "stop" in x;

/** Both streams, collected in the order written. */
function buildStreams() {
	/** @type {string[]} */
	const out = [];
	/** @type {string[]} */
	const err = [];
	return {
		/** @param {string} text */
		out: (text) => {
			out.push(text);
		},
		/** @param {string} text */
		raw: (text) => {
			err.push(text);
		},
		/** @param {string} text */
		warn: (text) => {
			err.push(`file-issue: ${text}\n`);
		},
		/**
		 * The refusal line, and the stop carrying its exit code.
		 * @param {string} text
		 * @param {number} code
		 * @returns {Stop}
		 */
		fail: (text, code) => {
			err.push(`file-issue: ${text}\n`);
			return { stop: code };
		},
		/** @param {number} code @returns {Outcome} */
		end: (code) => ({ code, stdout: out.join(""), stderr: err.join("") }),
	};
}

/** @typedef {ReturnType<typeof buildStreams>} Streams */

/**
 * @typedef {{title?: string, labels: string[], parent?: number,
 *   standalone?: string, bodyFile?: string, assignSelf: boolean,
 *   distinct: Set<number>, sizeChecked: Set<number>, origin?: string,
 *   signatureFile?: string, noFault: boolean}} Opts
 */

/**
 * The whole run: the exit code and what it wrote to each stream.
 * @param {string[]} argv
 * @param {FileIssuePorts} ports
 * @returns {Outcome}
 */
function fileIssue(argv, ports) {
	const io = buildStreams();
	/** @type {import("./cli-args.js").Parsed} */
	let parsed;
	try {
		parsed = parse(argv, SPEC);
	} catch (e) {
		if (!(e instanceof CliExit)) throw e;
		(e.code === 0 ? io.out : io.raw)(e.text);
		return io.end(e.code);
	}
	const titles = parsed.lists["--check"];
	const r = titles
		? checkTitle(io, ports, parsed, titles)
		: run(io, ports, parsed);
	return io.end(isStop(r) ? r.stop : 0);
}

/**
 * @param {Streams} io
 * @returns {string | Stop}
 */
function readTracker(io) {
	try {
		return requireKey("tracker");
	} catch (e) {
		return io.fail(caught(e).message, 2);
	}
}

/**
 * @param {Streams} io
 * @param {import("./cli-args.js").Parsed} parsed
 * @returns {Opts | Stop}
 */
function readOpts(io, { flags, lists }) {
	const distinct = parseIssueList(
		io,
		"--distinct-from",
		lists["--distinct-from"] ?? [],
	);
	if (isStop(distinct)) return distinct;
	const sizeChecked = parseIssueList(
		io,
		"--size-line-checked",
		lists["--size-line-checked"] ?? [],
	);
	if (isStop(sizeChecked)) return sizeChecked;
	/** @type {Opts} */
	const opts = {
		title: flagValue(flags, "--title"),
		origin: flagValue(flags, "--origin"),
		signatureFile: flagValue(flags, "--fault-signature"),
		noFault: flags["--no-fault"] === true,
		labels: lists["--label"] ?? [],
		standalone: flagValue(flags, "--standalone"),
		bodyFile: flagValue(flags, "--body-file"),
		assignSelf: flags["--assign-self"] === true,
		distinct,
		sizeChecked,
	};
	const parent = flagValue(flags, "--parent");
	if (parent !== undefined) {
		const n = parseIssueNumber(parent);
		if (n === null)
			return io.fail(`--parent '${parent}' is not an issue number.`, 2);
		opts.parent = n;
	}
	if (!opts.title?.trim()) return io.fail(`--title is required. ${USAGE}`, 2);
	if (opts.labels.length === 0)
		return io.fail(`at least one --label is required. ${USAGE}`, 2);
	if (opts.bodyFile === undefined)
		return io.fail(
			`--body-file is required — a file, or - for standard input; never a shell string. ${USAGE}`,
			2,
		);
	if ((opts.parent === undefined) === (opts.standalone === undefined))
		return io.fail(
			'give exactly one of --parent <n> or --standalone "<why>": an issue with no parent sits outside every map, so /wayfinder\'s frontier never offers it.',
			2,
		);
	if (opts.standalone !== undefined && !opts.standalone.trim())
		return io.fail(
			"--standalone needs its reason, written into the body unless it carries its own Standalone: line.",
			2,
		);
	return checkDeclarations(io, opts) ?? opts;
}

/**
 * The origin and the fault declaration every filing carries (#4796).
 * @param {Streams} io
 * @param {Opts} opts
 * @returns {Stop | undefined}
 */
function checkDeclarations(io, { origin, signatureFile, noFault }) {
	if (origin === undefined || !isOrigin(origin))
		return io.fail(
			`${origin === undefined ? "--origin is required" : `--origin '${origin}' is not on the list`}: name the flow filing this, one of ${ORIGINS.join(", ")}. Nothing filed.`,
			2,
		);
	if ((signatureFile === undefined) === !noFault)
		return io.fail(
			"give exactly one of --fault-signature <file> or --no-fault: does this ticket claim to stop a recurring fault? --no-fault is a cut, refactor, rename or new capability. The file's shape: scripts/lib/fault-signature.js. Nothing filed.",
			2,
		);
}

/**
 * A list flag's issue numbers, refused where any part of a list is not one.
 * @param {Streams} io
 * @param {string} flag
 * @param {string[]} csvs
 * @returns {Set<number> | Stop}
 */
function parseIssueList(io, flag, csvs) {
	/** @type {Set<number>} */
	const numbers = new Set();
	for (const csv of csvs)
		for (const part of csv.split(",")) {
			const n = parseIssueNumber(part);
			if (n === null)
				return io.fail(
					`${flag} '${csv}' is not a comma-separated list of issue numbers.`,
					2,
				);
			numbers.add(n);
		}
	return numbers;
}

/**
 * @param {Streams} io
 * @param {FileIssuePorts} ports
 * @param {string} file
 * @returns {string | Stop}
 */
function readBody(io, ports, file) {
	try {
		return ports.readBody(file);
	} catch (e) {
		const { code, message } = caught(e);
		return io.fail(
			`could not read the body from ${file} (${code ?? message}). Write it first, or pipe it in with --body-file -.`,
			2,
		);
	}
}

/**
 * @param {Streams} io
 * @param {FileIssuePorts} ports
 * @param {import("./cli-args.js").Parsed} parsed
 * @param {string[]} titles  the `--check` values
 * @returns {Stop | undefined}
 */
function checkTitle(io, ports, { flags, lists }, titles) {
	const [title, ...more] = titles;
	if (
		title === undefined ||
		more.length > 0 ||
		Object.keys(flags).length > 0 ||
		Object.keys(lists).length !== 1 ||
		!title.trim()
	)
		return io.fail(`--check takes one title and nothing else. ${USAGE}`, 2);
	const repo = readTracker(io);
	if (isStop(repo)) return repo;
	try {
		io.out(similarTitles(repo, title, ports.gh).text);
	} catch (e) {
		return io.fail(`could not list ${repo}'s issues (${parseErrLine(e)}).`, 1);
	}
}

/**
 * A filing, from its options to its claim.
 * @param {Streams} io
 * @param {FileIssuePorts} ports
 * @param {import("./cli-args.js").Parsed} parsed
 * @returns {Stop | undefined}
 */
function run(io, ports, parsed) {
	const filing = checkFiling(io, ports, parsed);
	return isStop(filing) ? filing : fileAndPlace(io, ports, filing);
}

/**
 * Every refusal before the create, in the header's order, and what the
 * create needs.
 * @param {Streams} io
 * @param {FileIssuePorts} ports
 * @param {import("./cli-args.js").Parsed} parsed
 */
function checkFiling(io, ports, parsed) {
	const opts = readOpts(io, parsed);
	if (isStop(opts)) return opts;
	const body = readBody(io, ports, /** @type {string} */ (opts.bodyFile));
	if (isStop(body)) return body;
	if (!body.trim())
		return io.fail(
			"the body is empty — nothing to act on. Write the body into the file, or pipe it in with --body-file -.",
			2,
		);
	const bodyStop = checkBody(io, ports, opts.labels, body);
	if (bodyStop) return bodyStop;
	const declared = checkSignatureFile(io, opts.signatureFile);
	if (isStop(declared)) return declared;

	const repo = readTracker(io);
	if (isStop(repo)) return repo;
	const mapStop = checkSecondMap(io, ports, repo, opts.labels);
	if (mapStop) return mapStop;

	const given = [
		...new Set([
			...opts.labels,
			originLabel(/** @type {typeof ORIGINS[number]} */ (opts.origin)),
			...(declared === null ? [] : [SIGNATURE_LABEL]),
		]),
	];
	const read =
		opts.parent === undefined
			? undefined
			: readParent(io, ports, { repo, number: opts.parent, labels: given });
	if (isStop(read)) return read;
	const parent = read?.parent;
	const added = read?.added ?? [];
	const labels = [...given, ...added];
	const before =
		checkKnownLabels(io, ports, repo, labels) ??
		checkSimilar(io, ports, repo, opts) ??
		checkSizeLine(io, ports, { repo, labels, body, opts });
	if (before) return before;
	return { opts, body, declared, repo, parent, added, labels };
}

/**
 * The create, then the link or the Standalone line, then the claim.
 * @param {Streams} io
 * @param {FileIssuePorts} ports
 * @param {Exclude<ReturnType<typeof checkFiling>, Stop>} filing
 * @returns {Stop | undefined}
 */
function fileAndPlace(
	io,
	ports,
	{ opts, body, declared, repo, parent, added, labels },
) {
	const hasOwnStandalone = hasStandaloneLine(body);
	const { filedBody, pending } = buildFiledBody(ports, {
		body,
		standalone: hasOwnStandalone ? undefined : opts.standalone,
		declared,
	});
	const created = create(io, ports, {
		repo,
		title: /** @type {string} */ (opts.title),
		labels,
		filedBody,
	});
	if (isStop(created)) return created;
	const { n, url } = created;
	recordOwnAct("file", repo, n);
	io.out(
		`${buildFiledLine(n, url)}\nlabels: ${labels.join(", ")}${added.length > 0 ? ` (${added.join(", ")} added: #${opts.parent} is a spec)` : ""}\n`,
	);
	const logStop = logSignature(io, pending, `${repo}#${n}`);
	if (logStop) return logStop;

	const sessionId = fromEnv();
	// Residual (#2314): a map filed with no session id is held by nobody, so
	// its children are launchable.
	const willClaim =
		opts.assignSelf || (labels.includes(MAP_LABEL) && sessionId !== null);
	const claimLater = willClaim
		? ` It is not yet claimed: node ${scriptPath("claim-issue.js")} ${n} once it is placed.`
		: "";
	if (parent) {
		const linkStop = linkFiled(io, ports, { repo, parent, n, claimLater });
		if (linkStop) return linkStop;
	} else {
		io.out(
			hasOwnStandalone
				? "Standalone: the body's own Standalone line was kept; the flag's was not written.\n"
				: `Standalone: ${opts.standalone?.trim()} — written into the body.\n`,
		);
	}

	if (!willClaim) {
		io.out(`#${n} is unassigned.\n`);
		return;
	}
	return claimFiled(io, ports, { repo, n, sessionId });
}

/**
 * The body as filed, and the signature line it records, its issue left blank
 * until the create gives the number. A body carrying its own Standalone line
 * keeps it, never gaining a second (#1027).
 * Residual: the flag's reason is then dropped even where it differs.
 * @param {FileIssuePorts} ports
 * @param {{body: string, standalone: string | undefined,
 *   declared: import("./fault-signature.js").Declared | null}} at
 */
function buildFiledBody(ports, { body, standalone, declared }) {
	const placed =
		standalone === undefined
			? body
			: `${body.trimEnd()}\n\n${buildStandaloneLine(standalone.trim())}\n`;
	if (declared === null) return { filedBody: placed, pending: null };
	const filedAt = new Date(ports.now()).toISOString();
	const pending = buildSignatureLine({ issue: "", filedAt, declared });
	return { filedBody: withSignatureSection(placed, pending), pending };
}

/**
 * The signature file, checked for shape and against its case, or refused;
 * null under --no-fault.
 * @param {Streams} io
 * @param {string|undefined} file
 * @returns {import("./fault-signature.js").Declared | null | Stop}
 */
function checkSignatureFile(io, file) {
	if (file === undefined) return null;
	const read = readDeclared(file, { root: hostRoot() });
	if ("error" in read)
		return io.fail(`--fault-signature ${read.error} Nothing filed.`, 2);
	return read.declared;
}

/**
 * The filed ticket's line in the signature log, which the caller commits;
 * nothing under --no-fault.
 * @param {Streams} io
 * @param {Record<string, unknown> | null} pending  the line, its issue blank
 * @param {string} issue
 * @returns {Stop | undefined}
 */
function logSignature(io, pending, issue) {
	if (pending === null) return;
	const line = { ...pending, issue };
	try {
		const root = worktreeRoot();
		const file = appendSignatureLine(root, line);
		io.out(
			`Signature logged in ${file} — commit it with your work: node ${scriptPath("commit-paths.js")} -m "<what>" -- ${path.relative(root, file)}\n`,
		);
	} catch (e) {
		return io.fail(
			`${issue} was filed, but its signature line was not written (${caught(e).message}). Do NOT file it again: append ${JSON.stringify(line)} to docs/data/outcome-signatures.jsonl by hand.`,
			1,
		);
	}
}

/**
 * The body's own refusals — the `takes:` tests, the basis check and a gate
 * `check:` that prints no reading (#3487) — and the model reading of its
 * waits and bases (#4964), whose faults refuse unless a `**Gate judge
 * override:**` line gives a reason (#4970).
 * @param {Streams} io
 * @param {FileIssuePorts} ports
 * @param {string[]} labels
 * @param {string} body
 * @returns {Stop | undefined}
 */
function checkBody(io, ports, labels, body) {
	// The template, handed over before the takes:human checks can refuse (#983).
	if (labels.includes(HUMAN_LABEL))
		io.raw(`${readRuleText("founder-deliverable")}\n\n`);
	const takes = takesRefusal(labels, body);
	if (takes) return io.fail(`${takes} Nothing filed.`, 2);

	// Advice, handed over before the basis check can refuse (#823).
	const handover = gateRuleHandover("", body, () =>
		readRuleText("roadmap-gating"),
	);
	if (handover) io.raw(handover);
	const { refusal, advice } = ports.judge(body);
	if (refusal) return io.fail(`Nothing filed: the body carries ${refusal}`, 2);
	if (advice) io.raw(`${advice}\n\n`);
	const checks = addedCheckVerdict("", body, { run: true });
	for (const w of checks.warnings) io.warn(w);
	if (checks.refusals.length > 0)
		return io.fail(`Nothing filed: ${checks.refusals.join(" ")}`, 2);
}

/**
 * Refuses a second `wayfinder:map` while an open one's Destination is
 * unfilled.
 * @param {Streams} io
 * @param {FileIssuePorts} ports
 * @param {string} repo
 * @param {string[]} labels
 * @returns {Stop | undefined}
 */
function checkSecondMap(io, ports, repo, labels) {
	const map = secondMapVerdict(labels, () => listOpenMaps(repo, ports.gh));
	if (map && "refusal" in map)
		return io.fail(`${map.refusal} Nothing filed.`, 2);
	// Fails open, recorded, as the /new-repo spec rules (#713).
	if (map && "unreadable" in map) {
		io.warn(`${map.unreadable} — filing without the second-map check.`);
		require("./arbiter-core.js").logError(
			"file-issue second-map",
			map.unreadable,
		);
	}
}

/* gh refuses a link past 7 layers ("You can't add more than 7 layers of
 * sub-issues", linkRemedy's case), so no chain holds more ancestors. */
const MAX_DEPTH = 7;

/** @typedef {ReturnType<typeof readIssue>} Issue */

/**
 * Each ancestor of `issue` in this repository, nearest first: the only ones
 * link-sub-issue.sh can link under. A failed read throws.
 * @param {FileIssuePorts} ports
 * @param {string} repo
 * @param {Issue} issue
 * @returns {Generator<Issue>}
 */
function* readAncestors(ports, repo, issue) {
	let at = issue;
	for (let depth = 0; depth < MAX_DEPTH; depth++) {
		if (!at.parentPath?.startsWith(`repos/${repo}/issues/`)) return;
		const up = readIssueParent(at, ports.gh);
		if (!up) return;
		yield up;
		at = up;
	}
}

/**
 * Where a child of closed `issue` goes instead: its nearest open ancestor, or
 * --standalone.
 * @param {FileIssuePorts} ports
 * @param {string} repo
 * @param {Issue} issue
 */
function openAncestorRemedy(ports, repo, issue) {
	try {
		for (const up of readAncestors(ports, repo, issue))
			if (up.state === "open")
				return `Its nearest open ancestor is #${up.number} (${up.title}): --parent ${up.number}, or --standalone "<why>".`;
	} catch (e) {
		return `Its ancestors could not be read (${parseErrLine(e)}): place it under an open issue, or --standalone "<why>".`;
	}
	return `No ancestor of #${issue.number} in ${repo} is open: place it under another open issue, or --standalone "<why>".`;
}

/**
 * The issue already passing `urgent` down to a child of open `parent`: the
 * parent, or an ancestor the chain reaches by isPassingDown. Null where none is,
 * or where an ancestor cannot be read, saying so: a hard-coded urgent is only
 * redundant, so this check never blocks filing on a failed read (#3648).
 * @param {Streams} io
 * @param {FileIssuePorts} ports
 * @param {string} repo
 * @param {Issue} parent
 */
function readUrgentCarrier(io, ports, repo, parent) {
	if (parent.labels.includes(URGENT_LABEL)) return parent;
	try {
		for (const up of readAncestors(ports, repo, parent)) {
			if (!isPassingDown(up)) return null;
			if (up.labels.includes(URGENT_LABEL)) return up;
		}
	} catch (e) {
		io.out(
			`Could not read #${parent.number}'s ancestors (${parseErrLine(e)}) — filing without the urgent check.\n`,
		);
		return null;
	}
	return null;
}

/**
 * The --parent issue, refused where it cannot take a child, and the family
 * label it implies.
 * @param {Streams} io
 * @param {FileIssuePorts} ports
 * @param {{repo: string, number: number, labels: string[]}} at
 * @returns {{parent: Issue, added: string[]} | Stop} the parent, and the
 *   labels it adds to `labels`
 */
function readParent(io, ports, { repo, number, labels }) {
	let parent;
	try {
		parent = readIssue(repo, number, ports.gh);
	} catch (e) {
		return io.fail(
			`could not read parent #${number} from ${repo} (${parseErrLine(e)}). Nothing filed.`,
			1,
		);
	}
	if (parent.isPullRequest)
		return io.fail(
			`#${number} is a pull request, not an issue. Nothing filed.`,
			2,
		);
	if (parent.state !== "open")
		return io.fail(
			`#${number} is ${parent.state} — a child filed under it drops off every map (#3637). ${openAncestorRemedy(ports, repo, parent)} Nothing filed.`,
			2,
		);
	const carrier =
		labels.includes(URGENT_LABEL) && readUrgentCarrier(io, ports, repo, parent);
	if (carrier)
		return io.fail(
			`${carrier === parent ? `#${number}` : `#${carrier.number}, an ancestor of #${number},`} carries urgent, which already covers every descendant (rule:urgent-label, #3250); a hard-coded copy keeps outranking once it is removed there. Drop --label ${URGENT_LABEL}; where only some children are urgent, move urgent off #${carrier.number} onto them, or order them with blocking edges. Nothing filed.`,
			2,
		);
	const added =
		parent.labels.includes("kind:spec") && !labels.includes("kind:ticket")
			? ["kind:ticket"]
			: [];
	// A spec or brief under a map takes no type — place-new-issue.sh's
	// exemption (#578, #714), hand-copied: nothing keeps the two in step.
	// `isRouteStep`, not `isDecisionTicket`: the frontier reads the type.
	if (
		isRouteStep(parent.labels) &&
		!isRouteStep(labels) &&
		!labels.includes("kind:spec") &&
		!labels.includes("kind:brief")
	)
		return io.fail(
			`#${number} is a wayfinder map or a map's child (${parent.labels.join(", ")}), so a child of it takes a wayfinder:<type> — research, prototype, grilling or task — or the map's frontier cannot read it; a kind:spec or kind:brief is exempt. Nothing filed.`,
			2,
		);
	return { parent, added };
}

/**
 * Refuses any label the tracker does not know.
 * @param {Streams} io
 * @param {FileIssuePorts} ports
 * @param {string} repo
 * @param {string[]} labels
 * @returns {Stop | undefined}
 */
function checkKnownLabels(io, ports, repo, labels) {
	let known;
	try {
		known = new Set(
			ghApiSlurp([`repos/${repo}/labels`], {}, ports.gh).map(
				(/** @type {{name: string}} */ l) => l.name,
			),
		);
	} catch (e) {
		return io.fail(
			`could not read ${repo}'s label list (${parseErrLine(e)}). Nothing filed.`,
			1,
		);
	}
	const unknown = labels.filter((l) => !known.has(l));
	if (unknown.length > 0)
		return io.fail(
			`${unknown.join(", ")} ${unknown.length === 1 ? "is" : "are"} not a label on ${repo} — gh would abort the create and still exit 0. Fix the spelling; a new label is a vocabulary change (docs/agents/triage-labels.md). Nothing filed.`,
			2,
		);
}

/**
 * The similar-title list, refused while any listed issue is neither named in
 * --distinct-from nor the --parent.
 * @param {Streams} io
 * @param {FileIssuePorts} ports
 * @param {string} repo
 * @param {Opts} opts
 * @returns {Stop | undefined}
 */
function checkSimilar(io, ports, repo, opts) {
	let similar;
	try {
		similar = similarTitles(repo, /** @type {string} */ (opts.title), ports.gh);
	} catch (e) {
		// Fails open: a gh outage would otherwise stop every filing.
		io.out(
			`Could not list similar open issues (${parseErrLine(e)}) — filing without the check.\n`,
		);
	}
	if (!similar) return;
	const unchecked = similar.found.filter(
		(c) => !opts.distinct.has(c.number) && c.number !== opts.parent,
	);
	if (unchecked.length > 0)
		return io.fail(
			`${similar.text}Nothing filed: ${unchecked.map((c) => `#${c.number}`).join(", ")} ${unchecked.length === 1 ? "is" : "are"} not yet checked. Read each listed issue. A duplicate is not filed — add to it instead; a natural parent is --parent. Where every one is different, re-run with ${buildDistinctFromHint(similar.found.map((c) => c.number))}`,
			2,
		);
	io.out(similar.text);
}

/**
 * The size-line refusal scripts/file-issue.js's header describes. Each read
 * fails open, saying so.
 * @param {Streams} io
 * @param {FileIssuePorts} ports
 * @param {{repo: string, labels: string[], body: string, opts: Opts}} at
 * @returns {Stop | undefined}
 */
function checkSizeLine(io, ports, { repo, labels, body, opts }) {
	if (!labels.includes(IMPLEMENT_LABEL)) return;
	const overlaps = sizeLineCandidates({
		body,
		filed: readOwnFiledIssues(io, ports, repo),
		siblings: readSiblings(io, ports, repo, opts.parent),
		confirmed: opts.sizeChecked,
	});
	if (overlaps.length > 0)
		return io.fail(
			buildSizeLineRefusal(
				readRuleText("size-line"),
				overlaps,
				opts.sizeChecked,
			),
			2,
		);
}

/**
 * The issues this session filed in `repo`, each read. An unreadable ledger or
 * issue is passed over, saying so: fails open, as the similar-title list
 * does (#4450).
 * @param {Streams} io
 * @param {FileIssuePorts} ports
 * @param {string} repo
 */
function readOwnFiledIssues(io, ports, repo) {
	const { numbers, unreadable } = readOwnFilings(repo);
	if (unreadable)
		io.out(
			"Could not read this session's acts ledger — filing without weighing its earlier filings under rule:size-line.\n",
		);
	const read = [];
	for (const n of numbers) {
		try {
			read.push(readIssue(repo, n, ports.gh));
		} catch (e) {
			io.out(
				`Could not read #${n}, filed by this session (${parseErrLine(e)}) — filing without weighing it under rule:size-line.\n`,
			);
		}
	}
	return read;
}

/**
 * The sub-issues of `parent`. A failed read is passed over, saying so (#4450).
 * @param {Streams} io
 * @param {FileIssuePorts} ports
 * @param {string} repo
 * @param {number|undefined} parent
 */
function readSiblings(io, ports, repo, parent) {
	if (parent === undefined) return [];
	try {
		return readSubIssues(parent, repo, {}, ports.gh).map(
			(
				/** @type {{number: number, state: string, body?: string, labels?: {name: string}[]}} */ k,
			) => ({
				number: k.number,
				state: k.state,
				body: k.body ?? "",
				labels: labelNames(k),
			}),
		);
	} catch (e) {
		io.out(
			`Could not list #${parent}'s sub-issues (${parseErrLine(e)}) — filing without the shared-file check.\n`,
		);
		return [];
	}
}

/**
 * The create, with every label, and the number read back off its URL.
 * @param {Streams} io
 * @param {FileIssuePorts} ports
 * @param {{repo: string, title: string, labels: string[], filedBody: string}} at
 * @returns {{n: number, url: string} | Stop}
 */
function create(io, ports, { repo, title, labels, filedBody }) {
	const createArgs = [
		"issue",
		"create",
		"--repo",
		repo,
		"--title",
		title,
		"--body-file",
		"-",
	];
	for (const l of labels) createArgs.push("--label", l);
	let created;
	try {
		created = ports.gh(createArgs, {
			input: filedBody,
			stdio: ["pipe", "pipe", "pipe"],
		});
	} catch (e) {
		return io.fail(
			`gh issue create failed (${parseErrLine(e)}). Search ${repo}'s open issues for the title before re-running — a create can land and still report failure.`,
			1,
		);
	}
	const url = created.match(/https:\/\/\S+\/issues\/(\d+)/);
	if (!url)
		return io.fail(
			`gh issue create printed no issue URL ("${created.trim()}"), so nothing can be linked or verified. Search ${repo}'s open issues for the title before re-running.`,
			1,
		);
	return { n: Number(url[1]), url: url[0] };
}

/**
 * The link under the parent; a failure exits 1 naming the remedy that fits
 * GitHub's refusal.
 * @param {Streams} io
 * @param {FileIssuePorts} ports
 * @param {{repo: string, parent: Issue, n: number, claimLater: string}} at
 * @returns {Stop | undefined}
 */
function linkFiled(io, ports, { repo, parent, n, claimLater }) {
	const linked = ports.link(repo, parent.number, n);
	if ("error" in linked)
		return io.fail(
			`#${n} was filed but not linked under #${parent.number}: ${linked.error}\n${linkRemedy(linked.error, parent, n)} Do NOT file it again.${claimLater}`,
			1,
		);
	if (linked.warning) io.warn(linked.warning);
	io.out(`${linked.ok}\n`);
}

/**
 * How to finish a link GitHub refused.
 * @param {string} error
 * @param {Issue} parent
 * @param {number} n
 * @returns {string}
 */
function linkRemedy(error, parent, n) {
	const grand = parent.parentPath?.match(/(?<!\d)(\d+)$/)?.[1];
	// Both caps are told apart by gh's 422 prose alone, as link-sub-issue.sh
	// tells the 7-layer one: a reword by GitHub demotes either to the
	// generic remedy, which still names the finishing link.
	if (/7 layers/.test(error))
		return `#${parent.number} is at GitHub's 7-layer cap: give #${n} #${parent.number}'s own parent${grand ? ` — ${scriptPath("link-sub-issue.sh")} ${grand} ${n}` : ""} — and say in its body why it is a peer.`;
	if (/100 sub-issues/.test(error))
		return `#${parent.number} is at GitHub's 100-child cap: node ${scriptPath("archive-closed-children.js")} ${parent.number}, then ${scriptPath("link-sub-issue.sh")} ${parent.number} ${n}.`;
	return `Finish it with ${scriptPath("link-sub-issue.sh")} ${parent.number} ${n} once the cause is fixed.`;
}

/**
 * --assign-self, or a map filed under a session id: the arbiter record where
 * a session id is set, then @me.
 * @param {Streams} io
 * @param {FileIssuePorts} ports
 * @param {{repo: string, n: number, sessionId: string|null}} at
 * @returns {Stop | undefined}
 */
function claimFiled(io, ports, { repo, n, sessionId }) {
	let recorded =
		"No session id (CLAUDE_CODE_SESSION_ID is unset), so no arbiter record was written — assigned only.";
	if (sessionId) {
		const claim = claimIfFree(n, sessionId);
		if (claim.status !== "claimed" && claim.status !== "reclaimed")
			return io.fail(
				`#${n} is filed and placed, but the arbiter would not record the claim (${claim.status === "unreadable" ? claim.why : claim.status}). Claim it with node ${scriptPath("claim-issue.js")} ${n}.`,
				1,
			);
		recorded = `Recorded the arbiter claim for session ${sessionId}.`;
	}
	const assignError = assignSelf(repo, n, ports.gh);
	if (assignError)
		return io.fail(
			`${recorded} But assigning #${n} failed (${assignError}) — re-run node ${scriptPath("claim-issue.js")} ${n} to assign.`,
			1,
		);
	io.out(`${recorded} Assigned #${n} to @me.\n`);
}

module.exports = { fileIssue, USAGE };
