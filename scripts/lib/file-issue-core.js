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
	selfReviewRefusal,
} = require("./issue-gate.js");
const { addedCheckVerdict } = require("./gate-check.js");
const {
	assignSelf,
	claimIfFree,
	labelNames,
	readIssue,
	readParent: readIssueParent,
	similarTitles,
} = require("./tracker-ops.js");
const { readOwnFilings, recordOwnAct } = require("./own-acts.js");
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
const { docPath, scriptPath } = require("./script-path.js");
const { SHA, buildCauseLine } = require("./cause-line.js");

const HUMAN_LABEL = takesLabel("human");

const USAGE = `usage: node ${scriptPath("file-issue.js")} --title T --label L [--label L…] (--parent P | --standalone "<why>") --body-file F|- --origin <class> (--fault-signature <file> | --no-fault) [--caused-by SHA[,SHA…]] [--assign-self] [--distinct-from N[,N…]] [--size-line-checked N[,N…]]\n       node ${scriptPath("file-issue.js")} --check "<title>"`;

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
		"--caused-by": "list",
		"--check": "list",
	},
};

// workflow-core#5150
/**
 * @typedef {object} FileIssuePorts
 * @property {import("./gh.js").GhRun} gh
 * @property {(repo: string, parent: number, child: number) =>
 *   {ok: string, warning?: string} | {error: string}} link
 * @property {(body: string) => {refusal: string|null, advice: string}} judge
 * @property {(file: string) => string} readBody
 * @property {(rev: string) => ReturnType<typeof import("./commit-sha.js").readCommit>} readCommit
 * @property {() => number} now
 */

/** @typedef {{stop: number}} Stop */
/** @typedef {{code: number, stdout: string, stderr: string}} Outcome */

/** @param {unknown} x @returns {x is Stop} */
const isStop = (x) => typeof x === "object" && x !== null && "stop" in x;

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

class FileIssueCrash extends Error {
	/**
	 * @param {Outcome} written
	 * @param {{cause: unknown}} options
	 */
	constructor(written, { cause }) {
		super(caught(cause).message, { cause });
		this.name = "FileIssueCrash";
		this.written = written;
	}
}

/**
 * @param {string[]} argv
 * @param {FileIssuePorts} ports
 * @returns {Outcome}
 */
function fileIssue(argv, ports) {
	const io = buildStreams();
	try {
		return runAll(io, argv, ports);
	} catch (e) {
		throw new FileIssueCrash(io.end(1), { cause: e });
	}
}

/**
 * @param {Streams} io
 * @param {string[]} argv
 * @param {FileIssuePorts} ports
 * @returns {Outcome}
 */
function runAll(io, argv, ports) {
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
 * @param {Streams} io
 * @param {Opts} opts
 * @returns {Stop | null}
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
	return null;
}

/**
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
 * @param {string[]} titles
 * @returns {Stop | null}
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
	return null;
}

/**
 * @param {Streams} io
 * @param {FileIssuePorts} ports
 * @param {import("./cli-args.js").Parsed} parsed
 * @returns {Stop | null}
 */
function run(io, ports, parsed) {
	const filing = checkFiling(io, ports, parsed);
	return isStop(filing) ? filing : fileAndPlace(io, ports, filing);
}

/**
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
	const causes = resolveCauses(io, ports, parsed.lists["--caused-by"]);
	if (isStop(causes)) return causes;

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
	return { opts, body, declared, causes, repo, parent, added, labels };
}

/**
 * @param {Streams} io
 * @param {FileIssuePorts} ports
 * @param {string[]} [given]
 * @returns {string[] | Stop}
 */
function resolveCauses(io, ports, given = []) {
	const full = [];
	for (const sha of given
		.flatMap((csv) => csv.split(","))
		.map((t) => t.trim())) {
		/** @type {ReturnType<FileIssuePorts["readCommit"]>} */
		const read = SHA.test(sha)
			? ports.readCommit(sha)
			: { ok: true, sha: null };
		if (!read.ok)
			return io.fail(
				`could not check --caused-by '${sha}' against this repo: ${read.why}. Run it from a checkout of this repo, or file without --caused-by and write the line in a comment once git can read it. Nothing filed.`,
				1,
			);
		if (read.sha === null)
			return io.fail(
				`--caused-by '${sha}' names no commit in this repo: give a sha of 7 to 40 lowercase hex digits that \`git rev-parse\` resolves here. Nothing filed.`,
				2,
			);
		full.push(read.sha);
	}
	return full;
}

/**
 * @param {Streams} io
 * @param {FileIssuePorts} ports
 * @param {Exclude<ReturnType<typeof checkFiling>, Stop>} filing
 * @returns {Stop | null}
 */
function fileAndPlace(
	io,
	ports,
	{ opts, body, declared, causes, repo, parent, added, labels },
) {
	const hasOwnStandalone = hasStandaloneLine(body);
	const { filedBody, pending } = buildFiledBody(ports, {
		body:
			causes.length > 0
				? `${body.trimEnd()}\n\n${buildCauseLine(causes)}\n`
				: body,
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
		return null;
	}
	return claimFiled(io, ports, { repo, n, sessionId });
}

/**
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
 * @param {Streams} io
 * @param {Record<string, unknown> | null} pending
 * @param {string} issue
 * @returns {Stop | null}
 */
function logSignature(io, pending, issue) {
	if (pending === null) return null;
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
	return null;
}

/**
 * @param {Streams} io
 * @param {FileIssuePorts} ports
 * @param {string[]} labels
 * @param {string} body
 * @returns {Stop | null}
 */
function checkBody(io, ports, labels, body) {
	if (labels.includes(HUMAN_LABEL))
		io.raw(`${readRuleText("founder-deliverable")}\n\n`);
	const takes = takesRefusal(labels, body);
	if (takes) return io.fail(`${takes} Nothing filed.`, 2);

	const handover = gateRuleHandover("", body, () =>
		readRuleText("roadmap-gating"),
	);
	if (handover) io.raw(handover);
	const selfReview = selfReviewRefusal(body);
	if (selfReview)
		return io.fail(`Nothing filed: the body carries ${selfReview}`, 2);
	const { refusal, advice } = ports.judge(body);
	if (refusal) return io.fail(`Nothing filed: the body carries ${refusal}`, 2);
	if (advice) io.raw(`${advice}\n\n`);
	const checks = addedCheckVerdict("", body, { run: true });
	for (const w of checks.warnings) io.warn(w);
	if (checks.refusals.length > 0)
		return io.fail(`Nothing filed: ${checks.refusals.join(" ")}`, 2);
	return null;
}

/**
 * @param {Streams} io
 * @param {FileIssuePorts} ports
 * @param {string} repo
 * @param {string[]} labels
 * @returns {Stop | null}
 */
function checkSecondMap(io, ports, repo, labels) {
	const map = secondMapVerdict(labels, () => listOpenMaps(repo, ports.gh));
	if (map && "refusal" in map)
		return io.fail(`${map.refusal} Nothing filed.`, 2);
	if (map && "unreadable" in map) {
		io.warn(`${map.unreadable} — filing without the second-map check.`);
		require("./arbiter-core.js").logError(
			"file-issue second-map",
			map.unreadable,
		);
	}
	return null;
}

// GitHub nests sub-issues eight levels deep:
// https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/adding-sub-issues
const MAX_DEPTH = 7;

/** @typedef {ReturnType<typeof readIssue>} Issue */

/**
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
 * @param {Streams} io
 * @param {FileIssuePorts} ports
 * @param {{repo: string, number: number, labels: string[]}} at
 * @returns {{parent: Issue, added: string[]} | Stop}
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
			`#${number} is ${parent.state} — a child filed under it drops off every map (workflow-core#3637). ${openAncestorRemedy(ports, repo, parent)} Nothing filed.`,
			2,
		);
	const carrier =
		labels.includes(URGENT_LABEL) && readUrgentCarrier(io, ports, repo, parent);
	if (carrier)
		return io.fail(
			`${carrier === parent ? `#${number}` : `#${carrier.number}, an ancestor of #${number},`} carries urgent, which already covers every descendant (rule:urgent-label, workflow-core#3250); a hard-coded copy keeps outranking once it is removed there. Drop --label ${URGENT_LABEL}; where only some children are urgent, move urgent off #${carrier.number} onto them, or order them with blocking edges. Nothing filed.`,
			2,
		);
	const added =
		parent.labels.includes("kind:spec") && !labels.includes("kind:ticket")
			? ["kind:ticket"]
			: [];
	// workflow-core#578, workflow-core#714
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
 * @param {Streams} io
 * @param {FileIssuePorts} ports
 * @param {string} repo
 * @param {string[]} labels
 * @returns {Stop | null}
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
			`${unknown.join(", ")} ${unknown.length === 1 ? "is" : "are"} not a label on ${repo} — gh would abort the create and still exit 0. Fix the spelling; a new label is a vocabulary change (${docPath("agents/triage-labels.md")}). Nothing filed.`,
			2,
		);
	return null;
}

/**
 * @param {Streams} io
 * @param {FileIssuePorts} ports
 * @param {string} repo
 * @param {Opts} opts
 * @returns {Stop | null}
 */
function checkSimilar(io, ports, repo, opts) {
	let similar;
	try {
		similar = similarTitles(repo, /** @type {string} */ (opts.title), ports.gh);
	} catch (e) {
		// workflow-core#536
		io.out(
			`Could not list similar open issues (${parseErrLine(e)}) — filing without the check.\n`,
		);
	}
	if (!similar) return null;
	const unchecked = similar.found.filter(
		(c) => !opts.distinct.has(c.number) && c.number !== opts.parent,
	);
	if (unchecked.length > 0)
		return io.fail(
			`${similar.text}Nothing filed: ${unchecked.map((c) => `#${c.number}`).join(", ")} ${unchecked.length === 1 ? "is" : "are"} not yet checked. Read each listed issue. A duplicate is not filed — add to it instead; a natural parent is --parent. Where every one is different, re-run with ${buildDistinctFromHint(similar.found.map((c) => c.number))}`,
			2,
		);
	io.out(similar.text);
	return null;
}

/**
 * @param {Streams} io
 * @param {FileIssuePorts} ports
 * @param {{repo: string, labels: string[], body: string, opts: Opts}} at
 * @returns {Stop | null}
 */
function checkSizeLine(io, ports, { repo, labels, body, opts }) {
	if (!labels.includes(IMPLEMENT_LABEL)) return null;
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
	return null;
}

/**
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
 * @param {Streams} io
 * @param {FileIssuePorts} ports
 * @param {{repo: string, parent: Issue, n: number, claimLater: string}} at
 * @returns {Stop | null}
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
	return null;
}

/**
 * @param {string} error
 * @param {Issue} parent
 * @param {number} n
 * @returns {string}
 */
function linkRemedy(error, parent, n) {
	const grand = parent.parentPath?.match(/(?<!\d)(\d+)$/)?.[1];
	if (/7 layers/.test(error))
		return `#${parent.number} is at GitHub's 7-layer cap: give #${n} #${parent.number}'s own parent${grand ? ` — ${scriptPath("link-sub-issue.sh")} ${grand} ${n}` : ""} — and say in its body why it is a peer.`;
	if (/100 sub-issues/.test(error))
		return `#${parent.number} is at GitHub's 100-child cap: node ${scriptPath("archive-closed-children.js")} ${parent.number}, then ${scriptPath("link-sub-issue.sh")} ${parent.number} ${n}.`;
	return `Finish it with ${scriptPath("link-sub-issue.sh")} ${parent.number} ${n} once the cause is fixed.`;
}

/**
 * @param {Streams} io
 * @param {FileIssuePorts} ports
 * @param {{repo: string, n: number, sessionId: string|null}} at
 * @returns {Stop | null}
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
	return null;
}

module.exports = { fileIssue, FileIssueCrash };
