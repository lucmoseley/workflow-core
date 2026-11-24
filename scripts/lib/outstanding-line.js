const { INVENTORY } = require("./inventory-format.js");
const { gh, parseGhFailureReason, parseErrLine } = require("./gh.js");
const { requiredGroup } = require("./regex-group.js");
const { caught, ignoreFailure, orFallback } = require("./caught.js");

// guess, workflow-core#911
const TIMEOUT_MS = 5000;
// guess, workflow-core#913
const COMMENTS_READ = 5;

const END_RE = /^\.?\s*$/;
const NOTHING_RE = /^nothing\.?$/i;

const LINE_SHAPE =
	"`**Outstanding:** none`, or `**Outstanding:** #N (what is left), owner/repo#M (what is left)` — items only, separated by `, ` or `; `, each citing an open issue";
const BLOCK_SHAPE = `${INVENTORY.itemLines}, each citing an open issue, or the single line \`nothing\``;

const OWNER = "[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?";
const REPO = "[A-Za-z0-9_.-]+";
const REF_RE = new RegExp(`^(?:(${OWNER})\\/(${REPO})|(${REPO}))?#([1-9]\\d*)`);
const RANGE_RE =
	/#\d+[`)]?\s*(?:through|thru|to|until|[-–—]|\.\.\.?)\s*[`(]?(?:[A-Za-z0-9_./-]*#)?\d+/i;
/** @param {string} lead */
const hexWord = (lead) =>
	new RegExp(`(?<![\\w-])${lead}[0-9a-f]{7,40}(?![\\w-])`);
const HEX_WORD_RE = hexWord("");
const SHA_RE = hexWord("(?=[0-9a-f]{0,39}\\d)(?=[0-9a-f]{0,39}[a-f])");
const MARKER_RE = /^[ \t]*\*\*Outstanding:\*\*(.*)$/;
const FENCE_RE = /^[ \t]{0,3}(```|~~~)/;

/**
 * @typedef {{ref: string, owner: string, repo: string, number: number,
 *   gist: string, raw: string}} Item
 * @typedef {{reason: string, fragment?: string, ref?: string}} Refusal
 * @typedef {{author: string, body: string, createdAt: string, url: string}} Comment
 * @typedef {"open"|"closed"|"missing"|"pull-request"|"self"|"unchecked"} Status
 * @typedef {{author?: {login?: string} | null, body?: string,
 *   createdAt?: string, url?: string}} CommentNode
 * @typedef {{__typename?: string, state?: string,
 *   comments?: {nodes?: (CommentNode | null)[]}} | null} IssueNode
 * @typedef {Record<string, Record<string, IssueNode> | null>} QueryData
 * @typedef {{ok: boolean, none: boolean, items: Item[], refusals: Refusal[],
 *   unchecked: string[], statuses: Record<string, Status>,
 *   comments: Record<string, Comment[]>, shape: string}} Verdict
 * @typedef {{data: QueryData | null | undefined} | {failed: string, kind: string}} QueryResult
 * @typedef {((where: string, what: string) => void) | null} Log
 * @typedef {(args: string[], opts: { timeout: number }) => string} Gh
 */

/**
 * @param {string} [tracker]
 * @returns {string|undefined}
 */
function trackerOf(tracker) {
	if (tracker) return tracker.toLowerCase();
	const t = orFallback(
		() => require("./workflow-core-config").resolveKey("tracker"),
		undefined,
	);
	return typeof t === "string" ? t.toLowerCase() : undefined;
}

/** @param {string} text */
const isNothing = (text) => NOTHING_RE.test(text.trim());

/** @param {string} text */
const hasSha = (text) => SHA_RE.test(text);

/**
 * @param {string} text
 * @param {number} from
 */
function closeParen(text, from) {
	let depth = 1;
	let i = from;
	for (; i < text.length && depth > 0; i++) {
		if (text[i] === "`") {
			const close = text.indexOf("`", i + 1);
			if (close > 0) i = close;
		} else if (text[i] === "(") depth++;
		else if (text[i] === ")") depth--;
	}
	return depth > 0 ? -1 : i;
}

/** @param {string} text */
function withoutGists(text) {
	const ref = /#\d+[ \t]+\(/g;
	let out = "";
	let from = 0;
	for (let m = ref.exec(text); m; m = ref.exec(text)) {
		const end = closeParen(text, m.index + m[0].length);
		if (end < 0) break;
		out += text.slice(from, m.index + m[0].length - 1);
		from = end;
		ref.lastIndex = end;
	}
	return out + text.slice(from);
}

/**
 * @param {string} reason
 * @param {string} [fragment]
 * @param {Item[]} [items]
 */
const refusedParse = (reason, fragment, items = []) => ({
	none: false,
	items,
	refusals: [fragment === undefined ? { reason } : { fragment, reason }],
});

/**
 * @param {string} text
 * @param {string|undefined} tracker
 * @returns {{item: Item, rest: string} | {reason: string}}
 */
function readItem(text, tracker) {
	const m = REF_RE.exec(text);
	if (!m)
		return {
			reason: "an item starts with its issue: `#N`, `repo#N` or `owner/repo#N`",
		};
	const [owner = "", name = ""] = tracker ? tracker.split("/") : [];
	const itemOwner = (m[1] ?? owner).toLowerCase();
	const itemRepo = (m[2] ?? m[3] ?? name).toLowerCase();
	let i = m[0].length;
	const gap = /^[ \t]+\(/.exec(text.slice(i));
	if (!gap)
		return {
			reason: `${m[0]} needs its gist in parentheses: \`${m[0]} (what is left)\``,
		};
	i += gap[0].length;
	const start = i;
	i = closeParen(text, i);
	if (i < 0) return { reason: `${m[0]}'s gist never closes its parenthesis` };
	const gist = text.slice(start, i - 1).trim();
	if (!gist) return { reason: `${m[0]}'s gist is empty: say what is left` };
	return {
		item: {
			ref: itemOwner && itemRepo ? `${itemOwner}/${itemRepo}#${m[4]}` : m[0],
			owner: itemOwner,
			repo: itemRepo,
			number: Number(m[4]),
			gist,
			raw: text.slice(0, i),
		},
		rest: text.slice(i),
	};
}

/**
 * @param {string} fragment
 * @param {string} fallback
 */
function buildShapeReason(fragment, fallback) {
	const outside = withoutGists(fragment);
	if (RANGE_RE.test(outside))
		return "a range is not an item: list each issue as its own `#N (gist)`";
	if (SHA_RE.test(outside))
		return "a commit sha goes on another line of the comment, never on this one";
	return fallback;
}

/**
 * @param {string} tail
 * @param {string|undefined} tracker
 * @returns {{none: boolean, items: Item[], refusals: Refusal[]}}
 */
function parseOutstandingTail(tail, tracker) {
	const text = tail.trim();
	if (/^none\.?$/i.test(text)) return { none: true, items: [], refusals: [] };
	if (/^none\b/i.test(text))
		return refusedParse(
			"`none` stands alone: a reason, a sha or a residual goes on another line, and owed work is an item",
			text,
		);
	if (!text) return refusedParse("the line is empty");
	/** @type {Item[]} */
	const items = [];
	let rest = text;
	for (;;) {
		const read = readItem(rest, tracker);
		if ("reason" in read)
			return refusedParse(buildShapeReason(rest, read.reason), rest, items);
		items.push(read.item);
		rest = read.rest;
		if (END_RE.test(rest)) return { none: false, items, refusals: [] };
		const sep = /^[,;][ \t]+/.exec(rest);
		if (!sep)
			return refusedParse(
				buildShapeReason(
					rest,
					"only another item may follow an item, after `, ` or `; ` — prose goes on another line",
				),
				rest.trim(),
				items,
			);
		rest = rest.slice(sep[0].length);
	}
}

/**
 * @param {string} comment
 * @returns {string[]}
 */
function outstandingTails(comment) {
	const tails = [];
	let fenced = false;
	for (const line of comment.split(/\r?\n/)) {
		if (FENCE_RE.test(line)) fenced = !fenced;
		else if (!fenced) {
			const m = MARKER_RE.exec(line);
			if (m) tails.push(requiredGroup(m, 1, MARKER_RE));
		}
	}
	return tails;
}

/** @param {string} comment */
const hasOutstandingLine = (comment) => outstandingTails(comment).length > 0;

/**
 * @param {string} comment
 * @param {string|undefined} tracker
 */
function parseOutstanding(comment, tracker) {
	const tails = outstandingTails(comment);
	const [only, ...more] = tails;
	if (only !== undefined && more.length === 0)
		return parseOutstandingTail(only, tracker);
	return refusedParse(
		tails.length > 0
			? `the comment holds ${tails.length} **Outstanding:** lines; one is owed`
			: "the comment has no **Outstanding:** line",
	);
}

/**
 * @param {string} block
 * @param {string|undefined} tracker
 * @returns {{none: boolean, items: Item[], refusals: Refusal[]}}
 */
function parseBlock(block, tracker) {
	const lines = block
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter(Boolean);
	const [only, ...more] = lines;
	if (only !== undefined && more.length === 0 && isNothing(only))
		return { none: true, items: [], refusals: [] };
	if (lines.length === 0)
		return refusedParse(
			"the block is empty; write `nothing` when nothing waits",
		);
	/** @type {Item[]} */
	const items = [];
	/** @type {Refusal[]} */
	const refusals = [];
	for (const line of lines) {
		if (isNothing(line)) {
			refusals.push({
				fragment: line,
				reason: "`nothing` stands alone, never beside items",
			});
			continue;
		}
		const bullet = /^-[ \t]+/.exec(line);
		const read = bullet
			? readItem(line.slice(bullet[0].length), tracker)
			: { reason: "each item is its own `- #N (gist)` line" };
		if ("reason" in read) {
			refusals.push({
				fragment: line,
				reason: buildShapeReason(line, read.reason),
			});
			continue;
		}
		if (!END_RE.test(read.rest)) {
			refusals.push({
				fragment: line,
				reason: buildShapeReason(
					read.rest,
					"one item per line: prose after the gist goes elsewhere",
				),
			});
			continue;
		}
		items.push(read.item);
	}
	return { none: false, items, refusals };
}

/** @param {string} s */
const gqlString = (s) => JSON.stringify(s);

/**
 * @param {Map<string, Set<number>>} byRepo
 * @param {boolean} comments
 */
function buildQuery(byRepo, comments) {
	const commentsField = comments
		? ` comments(last: ${COMMENTS_READ}) { nodes { author { login } body createdAt url } }`
		: "";
	const repos = [...byRepo].map(([full, numbers], r) => {
		const [owner, name] = full.split("/");
		if (owner === undefined || name === undefined)
			throw new Error(`repo key "${full}" is not owner/repo`);
		const fields = [...numbers].map(
			(n) =>
				`n${n}: issueOrPullRequest(number: ${n}) { __typename ... on Issue { state${commentsField} } }`,
		);
		return `r${r}: repository(owner: ${gqlString(owner)}, name: ${gqlString(name)}) { ${fields.join(" ")} }`;
	});
	return `query { ${repos.join(" ")} }`;
}

/**
 * @param {string} query
 * @param {number} timeoutMs
 * @param {Gh} [run]
 * @returns {QueryResult}
 */
function runQuery(query, timeoutMs, run = gh) {
	try {
		return {
			data: JSON.parse(
				run(["api", "graphql", "-f", `query=${query}`], { timeout: timeoutMs }),
			).data,
		};
	} catch (e) {
		const out = caught(e).stdout?.toString() ?? "";
		const parsed = orFallback(() => JSON.parse(out), undefined);
		if (parsed && typeof parsed.data === "object" && parsed.data !== null)
			return { data: parsed.data };
		const code = caught(e).code;
		const kind =
			code === "ETIMEDOUT" || parseGhFailureReason(e) === "unreachable"
				? "GitHub unreachable"
				: "the GitHub read failed";
		return { failed: `${kind} (${parseErrLine(e)})`, kind };
	}
}

/** @param {string} where @param {string} what */
function defaultLog(where, what) {
	ignoreFailure(() => require("./arbiter-core").logError(where, what));
}

/** @type {Record<string, string>} */
const REFUSED_STATUS = {
	closed: "is closed — a closed issue tracks nothing",
	missing: "does not exist",
	"pull-request": "is a pull request, not an issue",
};

/** @param {string} [tracker] */
function homeOf(tracker) {
	const t = trackerOf(tracker);
	return t && /^[^/\s]+\/[^/\s]+$/.test(t) ? t : undefined;
}

/**
 * @param {string} spelling
 * @param {string} [tracker]
 * @returns {string|null}
 */
function readCanonicalRef(spelling, tracker) {
	const m = REF_RE.exec(spelling);
	if (!m || m[0] !== spelling) return null;
	const read = readItem(`${spelling} (ref)`, homeOf(tracker));
	return "item" in read ? read.item.ref : null;
}

/**
 * @param {number|string|undefined} self
 * @param {string|undefined} home
 * @returns {string|undefined}
 */
function readSelfRef(self, home) {
	if (self === undefined) return;
	const read = readItem(
		`${typeof self === "number" || /^\d+$/.test(self) ? "#" : ""}${self} (self)`,
		home,
	);
	return "item" in read ? read.item.ref : undefined;
}

/**
 * @param {Verdict} verdict
 * @param {string} ref
 * @param {Log} log
 * @returns {void}
 */
function markUnresolved(verdict, ref, log) {
	verdict.statuses[ref] = "unchecked";
	if (verdict.unchecked.length > 0) return;
	verdict.unchecked.push("no tracker resolves a bare ref; shape check only");
	log?.(
		"outstanding-line",
		"open-check skipped: no tracker resolves; shape check only",
	);
}

/**
 * @param {Verdict} verdict
 * @param {Item[]} items
 * @param {string|undefined} selfRef
 * @param {Log} log
 * @returns {Map<string, Set<number>>}
 */
function groupForRead(verdict, items, selfRef, log) {
	/** @type {Map<string, Set<number>>} */
	const byRepo = new Map();
	for (const item of items) {
		if (item.ref === selfRef) {
			verdict.statuses[item.ref] = "self";
			verdict.refusals.push({
				ref: item.ref,
				reason: `${item.ref} is the issue in hand — it cannot carry its own leftovers; file a new issue`,
			});
			continue;
		}
		if (!item.owner || !item.repo) {
			markUnresolved(verdict, item.ref, log);
			continue;
		}
		const key = `${item.owner}/${item.repo}`;
		if (!byRepo.has(key)) byRepo.set(key, new Set());
		byRepo.get(key)?.add(item.number);
	}
	return byRepo;
}

/**
 * @param {Verdict} verdict
 * @param {Item} item
 * @param {Log} log
 * @returns {void}
 */
function markUnreadable(verdict, item, log) {
	verdict.statuses[item.ref] = "unchecked";
	const why = `${item.owner}/${item.repo} is unreadable; ${item.ref} passes on shape only`;
	if (verdict.unchecked.includes(why)) return;
	verdict.unchecked.push(why);
	log?.(
		"outstanding-line",
		"open-check skipped for an unreadable repo; shape check only",
	);
}

/**
 * @param {IssueNode | undefined} node
 * @returns {Status}
 */
function statusOf(node) {
	if (!node) return "missing";
	if (node.__typename === "PullRequest") return "pull-request";
	return node.state === "OPEN" ? "open" : "closed";
}

/**
 * @param {IssueNode | undefined} node
 * @returns {Comment[]}
 */
function commentsOf(node) {
	return (node?.comments?.nodes ?? [])
		.filter((c) => c !== null)
		.map((c) => ({
			author: c.author?.login ?? "",
			body: c.body ?? "",
			createdAt: c.createdAt ?? "",
			url: c.url ?? "",
		}));
}

/**
 * @param {Verdict} verdict
 * @param {Item[]} items
 * @param {QueryResult} read
 * @param {{repos: string[], comments: boolean, log: Log}} how
 * @returns {void}
 */
function applyRead(verdict, items, read, how) {
	const { repos, comments, log } = how;
	for (const item of items) {
		if (verdict.statuses[item.ref]) continue;
		if ("failed" in read) {
			verdict.statuses[item.ref] = "unchecked";
			continue;
		}
		const repoNode =
			read.data?.[`r${repos.indexOf(`${item.owner}/${item.repo}`)}`];
		if (!repoNode) {
			markUnreadable(verdict, item, log);
			continue;
		}
		const node = repoNode[`n${item.number}`];
		const status = statusOf(node);
		verdict.statuses[item.ref] = status;
		if (status !== "open")
			verdict.refusals.push({
				ref: item.ref,
				reason: `${item.ref} ${REFUSED_STATUS[status]}; cite an open issue that carries the work`,
			});
		else if (comments) verdict.comments[item.ref] = commentsOf(node);
	}
}

/**
 * @param {string} text
 * @param {{grammar: "outstanding"|"block", tracker?: string | null,
 *   self?: number|string, comments?: boolean,
 *   shapeOnly?: boolean, timeoutMs?: number,
 *   log?: Log, gh?: Gh}} opts
 * @returns {Verdict}
 */
function judge(text, opts) {
	/** @type {Verdict} */
	const verdict = {
		ok: false,
		none: false,
		items: [],
		refusals: [],
		unchecked: [],
		statuses: {},
		comments: {},
		shape: opts.grammar === "block" ? BLOCK_SHAPE : LINE_SHAPE,
	};
	const log = opts.log === undefined ? defaultLog : opts.log;
	const home = opts.tracker === null ? undefined : homeOf(opts.tracker);
	const parsed =
		opts.grammar === "block"
			? parseBlock(text, home)
			: parseOutstanding(text, home);
	verdict.none = parsed.none;
	verdict.items = parsed.items;
	verdict.refusals.push(...parsed.refusals);
	if (verdict.refusals.length > 0) return verdict;

	const byRepo = groupForRead(
		verdict,
		parsed.items,
		readSelfRef(opts.self, home),
		log,
	);
	if (opts.shapeOnly || byRepo.size === 0) {
		verdict.ok = verdict.refusals.length === 0;
		return verdict;
	}

	const read = runQuery(
		buildQuery(byRepo, !!opts.comments),
		opts.timeoutMs ?? TIMEOUT_MS,
		opts.gh,
	);
	if ("failed" in read) {
		verdict.unchecked.push(`${read.failed}; shape check only`);
		log?.(
			"outstanding-line",
			`open-check skipped: ${read.kind}; shape check only`,
		);
	}
	applyRead(verdict, parsed.items, read, {
		repos: [...byRepo.keys()],
		comments: !!opts.comments,
		log,
	});
	verdict.ok = verdict.refusals.length === 0;
	return verdict;
}

/** @param {Verdict} verdict */
function buildRefusalText(verdict) {
	const faults = verdict.refusals.map(
		(r) => `- ${r.reason}${r.fragment ? ` — read: \`${r.fragment}\`` : ""}`,
	);
	const elsewhere =
		verdict.shape === LINE_SHAPE
			? " A sha, a reason or an accepted residual goes on another line of the comment."
			: "";
	return `${faults.join("\n")}\n\nThe shape: ${verdict.shape}.${elsewhere}`;
}

module.exports = {
	COMMENTS_READ,
	HEX_WORD_RE,
	hasOutstandingLine,
	readCanonicalRef,
	hasSha,
	isNothing,
	judge,
	buildRefusalText,
	trackerOf,
};
