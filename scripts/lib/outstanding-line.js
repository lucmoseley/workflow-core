/*
 * outstanding-line.js — the one home of the founder-facing item grammar and of
 * the check that each item's carrier is an open issue (workflow-core#982, under the workflow-core#958
 * spec).
 *
 * THE ITEM: `#N (gist)`. The leading ref is `#N` (the tracker given), `repo#N`
 * (same owner) or `owner/repo#N`. A ref inside the parentheses is gist and is
 * never checked. A range (`#3615 through #3622`) is refused: list each item.
 *
 * TWO GRAMMARS OVER IT:
 *   outstanding — the `**Outstanding:**` line of a close comment: the bare
 *     word `none`, or items separated by `, ` or `; `. A trailing full stop is
 *     allowed. A sha, a reason or a residual goes on another line, never here.
 *   block — the inventory's `waits on you:` block: one
 *     `- #N (gist)` per line, or the single line `nothing`. The caller strips
 *     the heading, so `waits on you: nothing` arrives as `nothing`.
 *
 * THE OPEN-CHECK is one GraphQL read for every repository named, under
 * TIMEOUT_MS. It refuses a closed issue, a missing number and a pull request,
 * and can also return each cited issue's newest comments. The issue being closed
 * is `self`, refused as its own carrier.
 *
 * FAILS OPEN (mantahostels#103 §6; ruled for this check at workflow-core#911) on an
 * unreachable GitHub, a failed call, an unreadable repo or no resolvable
 * tracker: the items it could not read pass on shape alone. The kind of
 * failure is logged under one constant text per kind, and the detail — gh's
 * own line, the repo — is returned in `unchecked`. In process the record goes
 * through `log` (arbiter-core's error log by default); the CLI logs nothing,
 * for the bash caller to record through lib/guard-log.sh's gl_log, which names
 * the guard.
 *
 * WHAT IT NEVER SEES: GitHub answers a misspelt repo exactly as it answers an
 * unreadable one, so `design-vualt#17 (x)` passes on shape. Nor is a sha
 * or a range inside a gist judged.
 *
 * CLI, for the bash hooks — the text on stdin, a JSON verdict on stdout, a
 * refused one carrying refusalText's `message`. Exit 0 passes (a fail-open
 * included), 1 refuses, 2 is a usage error. `has-line` prints `yes` where the
 * comment carries an unfenced `**Outstanding:**` line, else `no`, and exits 0.
 * Node exits 1 on a crash too, so a caller refuses only on a printed verdict
 * whose `ok` is false, and reads `has-line` from its output (workflow-core#1255).
 */

const fs = require("node:fs");

const { INVENTORY } = require("./inventory-format.js");
const { gh, ghFailureReason, errLine } = require("./gh.js");
const { requiredGroup } = require("./regex-group.js");
const { caught } = require("./caught.js");
const { writeFd } = require("./write-fd.js");

/* The workflow-core#958 spec's ceiling (ruled at workflow-core#911): a guess, under the close guard's
 * 10 s hook budget. Unmeasured — one issue alone read in 0.88-0.92 s there,
 * and a batch of several repos never has been. */
const TIMEOUT_MS = 5000;
/* How far back the posted-round check looks (workflow-core#913): a round is posted just
 * before the ending, so it sits among the newest few. */
const COMMENTS_READ = 5;

const END_RE = /^\.?\s*$/;
const NOTHING_RE = /^nothing\.?$/i;

/* The grammar's shape, carried on every verdict so a reader's refusal can
 * teach it in one retry (workflow-core#958 story 18). */
const LINE_SHAPE =
	"`**Outstanding:** none`, or `**Outstanding:** #N (what is left), owner/repo#M (what is left)` — items only, separated by `, ` or `; `, each citing an open issue";
const BLOCK_SHAPE = `${INVENTORY.itemLines}, each citing an open issue, or the single line \`nothing\``;

const OWNER = "[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?";
const REPO = "[A-Za-z0-9_.-]+";
const REF_RE = new RegExp(`^(?:(${OWNER})\\/(${REPO})|(${REPO}))?#([1-9]\\d*)`);
const RANGE_RE =
	/#\d+[`)]?\s*(?:through|thru|to|until|[-–—]|\.\.\.?)\s*[`(]?(?:[A-Za-z0-9_./-]*#)?\d+/i;
/* Hex with at least one digit and one letter, so a word ("defaced") or a bare
 * number is not read as a sha; and never joined to a word or a hyphen, so a
 * session id's first group is not one either. resolve-ticket.js reads the
 * same test, through hasSha, to decide whether a Door line is owed (workflow-core#1247). */
const SHA_RE =
	/(?<![\w-])(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}(?![\w-])/;
const MARKER_RE = /^[ \t]*\*\*Outstanding:\*\*(.*)$/;
const FENCE_RE = /^[ \t]{0,3}(```|~~~)/;

/**
 * @typedef {{ref: string, owner: string, repo: string, number: number,
 *   gist: string, raw: string}} Item
 *   `ref` is the full `owner/repo#N`, however the item spelled it — unless no
 *   tracker resolves a bare `#N` or `repo#N`, when `ref` is the spelling and
 *   `owner` or `repo` is empty.
 * @typedef {{reason: string, fragment?: string, ref?: string}} Refusal
 * @typedef {{author: string, body: string, createdAt: string, url: string}} Comment
 * @typedef {"open"|"closed"|"missing"|"pull-request"|"self"|"unchecked"} Status
 * @typedef {{author?: {login?: string} | null, body?: string,
 *   createdAt?: string, url?: string}} CommentNode
 * @typedef {{__typename?: string, state?: string,
 *   comments?: {nodes?: (CommentNode | null)[]}} | null} IssueNode
 *   null where the number does not exist; a comment is null where GitHub
 *   errored on it, as a partial answer allows.
 * @typedef {Record<string, Record<string, IssueNode> | null>} QueryData
 *   `r<i>` → `n<number>` → node, as buildQuery aliases them; a repo is null
 *   where it is unreadable.
 * @typedef {{ok: boolean, none: boolean, items: Item[], refusals: Refusal[],
 *   unchecked: string[], statuses: Record<string, Status>,
 *   comments: Record<string, Comment[]>, shape: string}} Verdict
 * @typedef {{data: QueryData | null | undefined} | {failed: string, kind: string}} QueryResult
 * @typedef {((where: string, what: string) => void) | null} Log
 */

/**
 * `owner/name` of the tracker a bare `#N` names, lower-cased as an item's
 * `owner` and `repo` are: the caller's, else the host's declared or derived
 * one. guard-inventory.js compares it with items to tell which ones
 * claim-issue.js can claim.
 * @param {string} [tracker]
 * @returns {string|undefined}
 */
function trackerOf(tracker) {
	if (tracker) return tracker.toLowerCase();
	let t;
	try {
		t = require("./workflow-core-config").resolveKey("tracker");
	} catch {
		// An unreadable config resolves no tracker, as an undeclared one does:
		// judge() passes a bare ref on shape alone and says so in `unchecked`
		// (FAILS OPEN above, workflow-core#911), and guard-inventory.js owes no claim.
	}
	return typeof t === "string" ? t.toLowerCase() : undefined;
}

/**
 * Whether `text` is the block's `nothing` alone, in any letter case (workflow-core#982).
 * guard-inventory.js passes a whole block body: `trim()` drops the blank
 * lines around the word, and `NOTHING_RE`, anchored without the `m` flag,
 * fails on any second non-blank line.
 * @param {string} text
 */
const isNothing = (text) => NOTHING_RE.test(text.trim());

/**
 * Whether `text` names a commit sha anywhere.
 * @param {string} text
 */
const hasSha = (text) => SHA_RE.test(text);

/**
 * The index just past the `)` closing a group whose `(` sits before `from`,
 * or -1 where it never closes. A code span's brackets are text, not nesting.
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

/**
 * `text` with every ref's parenthesised gist cut out, so a range or a sha
 * quoted inside a gist does not name the fault of the text around it.
 * @param {string} text
 */
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
 * A parse that refuses on one fault, keeping any items read before it.
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
 * Reads one item at the head of `text`: the ref, one space or more, then a
 * balanced parenthesised gist.
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
	/* GitHub names ignore case, so a ref is compared lower-cased — else
	 * `Here#40` slips past the self-reference refusal. */
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
 * The reason a fragment failed, sharpened where it holds one of the census's
 * (workflow-core#908 F4) known non-item shapes.
 * @param {string} fragment
 * @param {string} fallback
 */
function shapeReason(fragment, fallback) {
	const outside = withoutGists(fragment);
	if (RANGE_RE.test(outside))
		return "a range is not an item: list each issue as its own `#N (gist)`";
	if (SHA_RE.test(outside))
		return "a commit sha goes on another line of the comment, never on this one";
	return fallback;
}

/**
 * The tail of an `**Outstanding:**` line, parsed.
 * @param {string} tail  what follows the marker
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
			return refusedParse(shapeReason(rest, read.reason), rest, items);
		items.push(read.item);
		rest = read.rest;
		if (END_RE.test(rest)) return { none: false, items, refusals: [] };
		const sep = /^[,;][ \t]+/.exec(rest);
		if (!sep)
			return refusedParse(
				shapeReason(
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
 * Every `**Outstanding:**` line of a comment outside a fenced block.
 * @param {string} comment
 * @returns {string[]}  each line's tail
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

/**
 * Whether a comment carries an `**Outstanding:**` line outside a fence — the
 * close guard's test for reading a close's own `--comment` over the issue's
 * newest one.
 * @param {string} comment
 */
const hasOutstandingLine = (comment) => outstandingTails(comment).length > 0;

/**
 * A close comment's `**Outstanding:**` line, parsed. Exactly one is owed.
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
 * An inventory block below its heading, parsed.
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
			refusals.push({ fragment: line, reason: shapeReason(line, read.reason) });
			continue;
		}
		if (!END_RE.test(read.rest)) {
			refusals.push({
				fragment: line,
				reason: shapeReason(
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
 * The one GraphQL document for every repo and number cited. Aliases carry
 * the index, never the name, so any repo spelling is a legal alias.
 * @param {Map<string, Set<number>>} byRepo  `owner/repo` → numbers
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
 * Runs the batched read. A GraphQL error (a missing number, an unreadable
 * repo) makes gh exit non-zero with the partial `data` still on stdout, so
 * that output is read before the call is judged failed.
 * @param {string} query
 * @param {number} timeoutMs
 * @returns {QueryResult}
 */
function runQuery(query, timeoutMs) {
	try {
		return {
			data: JSON.parse(
				gh(["api", "graphql", "-f", `query=${query}`], { timeout: timeoutMs }),
			).data,
		};
	} catch (e) {
		const out = caught(e).stdout?.toString() ?? "";
		try {
			const parsed = JSON.parse(out);
			if (parsed && typeof parsed.data === "object" && parsed.data !== null)
				return { data: parsed.data };
		} catch {
			// Not JSON: no partial answer to read, so the failure stands.
		}
		const code = caught(e).code;
		const kind =
			code === "ETIMEDOUT" || ghFailureReason(e) === "unreachable"
				? "GitHub unreachable"
				: "the GitHub read failed";
		return { failed: `${kind} (${errLine(e)})`, kind };
	}
}

/** @param {string} where @param {string} what */
function defaultLog(where, what) {
	try {
		require("./arbiter-core").logError(where, what);
	} catch {
		// The error log is unloadable; the verdict still carries `unchecked`.
	}
}

/** @type {Record<string, string>} */
const REFUSED_STATUS = {
	closed: "is closed — a closed issue tracks nothing",
	missing: "does not exist",
	"pull-request": "is a pull request, not an issue",
};

/**
 * The `owner/name` a bare `#N` resolves against, or undefined where none does.
 * @param {string} [tracker]
 */
function homeOf(tracker) {
	const t = trackerOf(tracker);
	return t && /^[^/\s]+\/[^/\s]+$/.test(t) ? t : undefined;
}

/**
 * The full `owner/repo#N` a bare ref spelling names, as an item's `ref`
 * reads — for a reader comparing refs written outside an item, as a
 * status-line tail is. Null where `spelling` is not one ref.
 * @param {string} spelling
 * @param {string} [tracker]
 * @returns {string|null}
 */
function canonicalRef(spelling, tracker) {
	const m = REF_RE.exec(spelling);
	if (!m || m[0] !== spelling) return null;
	const read = readItem(`${spelling} (ref)`, homeOf(tracker));
	return "item" in read ? read.item.ref : null;
}

/**
 * The ref the issue being closed resolves to, or undefined where `self` is
 * absent or reads as no item.
 * @param {number|string|undefined} self
 * @param {string|undefined} home
 * @returns {string|undefined}
 */
function selfRefOf(self, home) {
	if (self === undefined) return;
	const read = readItem(
		`${typeof self === "number" || /^\d+$/.test(self) ? "#" : ""}${self} (self)`,
		home,
	);
	return "item" in read ? read.item.ref : undefined;
}

/**
 * Marks a bare ref no tracker resolves as unchecked, saying so once per
 * verdict.
 * @param {Verdict} verdict accumulator: the verdict being built, filled in place
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
 * Refuses the issue in hand as its own carrier, marks each bare ref no
 * tracker resolves, and groups the rest for the open-check.
 * @param {Verdict} verdict accumulator: the verdict being built, filled in place
 * @param {Item[]} items
 * @param {string|undefined} selfRef
 * @param {Log} log
 * @returns {Map<string, Set<number>>}  `owner/repo` → numbers to read
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
		/* A bare ref with no tracker to resolve it names no repository: its
		 * shape is judged, its carrier is not. */
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
 * Marks an item in an unreadable repo as unchecked, saying so once per repo.
 * @param {Verdict} verdict accumulator: the verdict being built, filled in place
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
 * Records each read item's status, refusing every carrier that is not open.
 * A failed read leaves them all unchecked.
 * @param {Verdict} verdict accumulator: the verdict being built, filled in place
 * @param {Item[]} items
 * @param {QueryResult} read
 * @param {{repos: string[], comments: boolean, log: Log}} how  `repos` is the
 *   read's `owner/repo` keys in alias order; `comments` keeps each open
 *   issue's comments
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
 * Parses `text` in `grammar`, then checks each item's carrier is open.
 *
 * @param {string} text  a close comment (`outstanding`) or a block body (`block`)
 * @param {{grammar: "outstanding"|"block", tracker?: string,
 *   self?: number|string, comments?: boolean,
 *   shapeOnly?: boolean, timeoutMs?: number,
 *   log?: Log}} opts
 *   `self` is the issue being closed — a number in the tracker, or
 *   any ref spelling. `log: null` silences the record.
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
	const home = homeOf(opts.tracker);
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
		selfRefOf(opts.self, home),
		log,
	);
	if (opts.shapeOnly || byRepo.size === 0) {
		verdict.ok = verdict.refusals.length === 0;
		return verdict;
	}

	const read = runQuery(
		buildQuery(byRepo, !!opts.comments),
		opts.timeoutMs ?? TIMEOUT_MS,
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

/**
 * A refused verdict as a reader prints it: each fault, then the shape.
 * @param {Verdict} verdict
 */
function refusalText(verdict) {
	const faults = verdict.refusals.map(
		(r) => `- ${r.reason}${r.fragment ? ` — read: \`${r.fragment}\`` : ""}`,
	);
	const elsewhere =
		verdict.shape === LINE_SHAPE
			? " A sha, a reason or an accepted residual goes on another line of the comment."
			: "";
	return `${faults.join("\n")}\n\nThe shape: ${verdict.shape}.${elsewhere}`;
}

if (require.main === module) {
	const { flagValue, parseOrExit } = require("./cli-args");
	const args = parseOrExit(process.argv.slice(2), {
		usage:
			"usage: node outstanding-line.js <outstanding|block|has-line> [--tracker owner/repo] [--self N] [--comments] [--shape-only]  (text on stdin)",
		flags: {
			"--tracker": "value",
			"--self": "value",
			"--comments": "boolean",
			"--shape-only": "boolean",
		},
		commands: {
			outstanding: { usage: "outstanding: a close comment on stdin" },
			block: { usage: "block: an inventory block on stdin" },
			"has-line": {
				usage:
					"has-line: a comment on stdin; prints yes where it has the line, else no",
			},
		},
	});
	const input = fs.readFileSync(0, "utf8");
	if (args.command === "has-line")
		writeFd(1, hasOutstandingLine(input) ? "yes\n" : "no\n");
	else {
		const verdict = judge(input, {
			grammar: args.command === "block" ? "block" : "outstanding",
			tracker: flagValue(args.flags, "--tracker"),
			self: flagValue(args.flags, "--self"),
			comments: args.flags["--comments"] === true,
			shapeOnly: args.flags["--shape-only"] === true,
			log: null,
		});
		writeFd(
			1,
			`${JSON.stringify(verdict.ok ? verdict : { ...verdict, message: refusalText(verdict) })}\n`,
		);
		process.exitCode = verdict.ok ? 0 : 1;
	}
}

module.exports = {
	canonicalRef,
	hasSha,
	isNothing,
	judge,
	refusalText,
	trackerOf,
};
