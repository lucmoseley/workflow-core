/*
 * rule-emission.js — the rule bytes ONE SESSION can be made to pay through
 * each PreToolUse tool (route (f)), and through each hook that fires once its
 * call has run.
 *
 * THE UNIT IS THE SESSION, NOT THE EVENT (mantahostels#2046). gp_rule latches per (rule,
 * agent, session) — lib/guard-parse.sh's marker loop — so an id is delivered
 * once in a session's life however many events could carry it. What a session
 * can be made to pay through one tool is therefore the sum of the DISTINCT ids
 * every guard that tool wires can reach. Nor is the event a truncation
 * boundary: the harness persists 10,000 characters PER HOOK ENTRY (mantahostels#1868) and
 * each guard is registered as its own entry, so GP_RULE_CAP — enforced
 * inside gp_rule, per entry — is the whole of the truncation guarantee.
 *
 * THIS MODULE ANSWERS TWO QUESTIONS and nothing else: for a hook wiring,
 * a set of guard sources and a fragment store, what is the byte total each
 * PreToolUse tool can be made to deliver over a session (reachableByTool), and
 * what each AFTER_EVENTS hook can (reachableAfterCall, workflow-core#2144).
 *
 * THE ARITHMETIC:
 *   one guard   = the sum of its own DISTINCT ids' fragment bytes, over every
 *                 gp_rule call it makes — never the maximum over calls, because
 *                 two mutually exclusive branches are still both reachable
 *                 across a session's many events;
 *   one tool    = the sum over the UNION of the ids its wired guards reach, so
 *                 an id two guards both name is counted once, the latch making
 *                 the second guard's call a no-op;
 *   the ratchet = the same union taken across every wired guard at once.
 *
 * A DIRECT `rule_text` CALL IS NOT PRICED HERE (mantahostels#2055). The figures are route
 * (f)'s, and docs/doc-map.md §Capture and placement §3 defines that route as a
 * guard injecting the rule BEFORE the call it governs; a guard that composes the
 * text itself is delivering on the branch where it has already fired, which is
 * route (e) and owes no shed. Those calls are censused instead, as `direct`
 * below.
 *
 * WHICH IDS A GUARD REACHES IS READ FROM ITS EFFECTIVE SOURCE (mantahostels#2488) — its own
 * text plus every lib it `source`s, transitively. WHERE the fragment is SPENT is
 * read from the guard's own text alone; §emissionSites says why the two differ.
 *
 * WHAT NEITHER CAN SEE: a call whose id is a VARIABLE (`rule_text "$id"`, the
 * shape at lib/guard-parse.sh and lib/rule-text.sh), and a lib behind a path
 * this cannot resolve — see §sourcedLibs.
 *
 * GP_RULE_SKIP DOES NOT ENTER IT. A skip sits behind its own condition on the
 * command in front of the guard, so a ceiling must assume it does not fire, and
 * an id deferred past GP_RULE_CAP on one event simply arrives on a later one.
 *
 * JOINS ARE NOT COUNTED. gp_rule's separator is 2 B per fragment beyond the
 * first IN ONE DELIVERY, and how a session's ids fall across deliveries is not
 * statically knowable. The omission is under 2 B per id.
 *
 * KEYED ON TOOL NAMES, NOT MATCHER STRINGS. Matchers overlap — `Bash` and
 * `Bash|Read|ListAgents` both cover `Bash` — so a per-matcher figure would
 * under-report every overlapping group.
 *
 * WHY NOT IMPORT hook-wiring.ts. It is TypeScript and the consuming checker is
 * a plain-Node CLI that cannot require it.
 */

const fs = require("node:fs");
const path = require("node:path");

const { ruleText } = require("./rule-text");
const { hostRoot } = require("./host-root.js");
const { moduleOn } = require("./workflow-core-config");
const { requiredGroup } = require("./regex-group.js");
const { caught } = require("./caught.js");
const { expandRuleTables, ruleTableRows } = require("./rule-table.js");
const { ownHooks } = require("./core-hooks.js");

/*
 * CAP_FILE names guard-parse.sh, which ships beside this file, so it is reached
 * from THIS DIRECTORY and a plugin install still finds it (workflow-core#1). Every other root
 * below — the hook wiring, and the guard sources its commands point at — is
 * host content and reads through hostRoot().
 */
const CAP_FILE = path.join(__dirname, "guard-parse.sh");

/** The event gp_rule emits on, and the only one route (f)'s caps price (spec
 * mantahostels#1932). */
const EVENT = "PreToolUse";

/**
 * The events that fire once a call has run (workflow-core#2144). reachableAfterCall prices
 * their hooks; no cap does (docs/doc-map.md §Capture and placement §3).
 */
const AFTER_EVENTS = ["PostToolUse", "PostToolUseFailure", "PostToolBatch"];

/** Where GP_RULE_CAP is assigned, relative to the repo root. */
const CAP_SOURCE = path.join("scripts", "lib", "guard-parse.sh");

/**
 * The pre-emptive emitter's call shape, shared with
 * scripts/check-guard-registry.js so the two readings cannot drift.
 *
 * One call takes several ids, so the whole argument run is captured and split
 * by RULE_ARG_RE below rather than matched one id at a time.
 *
 * STATEMENT-INITIAL, and that anchoring is load-bearing: `gp_rule` is a bare
 * word, so an unanchored pattern would match every mention of it in a comment
 * or a header. The cost is that `if …; then gp_rule x; fi` is invisible.
 *
 * THE UNQUOTED ARGUMENT MUST END AT WHITESPACE. `rule:` is optional, so without
 * that boundary a token the id grammar cannot follow — `rule:-x` — matches the
 * `rule` in front of it and enters the run as a phantom id.
 */
const RULE_ID = "(?:rule:)?[a-z0-9]+(?:-[a-z0-9]+)*";
/**
 * A call's whole id run, as a capturing group; `end` is the lookahead a bare
 * id must stop at. Shared with lib/census-digest.js, whose minified source
 * ends an id at `;` too.
 * @param {string} end
 */
const ruleArgs = (end) =>
	`((?:[ \\t]+(?:"${RULE_ID}"|'${RULE_ID}'|${RULE_ID}(?=${end})))+)`;
const RULE_ARGS = ruleArgs("[ \\t]|$");
const EMIT_RULE_RE = new RegExp(`^[ \\t]*gp_rule${RULE_ARGS}`, "gm");

/**
 * The bare ids in one gp_rule call's argument run.
 *
 * ONE optional `rule:` comes off, because `gp_rule` bares one before it latches
 * (mantahostels#2719). Without it a prefixed argument would end the run captured above, and
 * the call would read as fewer ids — or, on the first argument, as no call.
 */
const RULE_ARG_RE = /["']?(?:rule:)?([a-z0-9]+(?:-[a-z0-9]+)*)["']?/g;

/**
 * The DIRECT accessor call — `rule_text <id>` — which a guard splices into text
 * it composes itself rather than handing to gp_rule.
 *
 * UNANCHORED, unlike EMIT_RULE_RE: the call sits inside a condition rather than
 * at the head of its own statement. The cost is that a mention in a comment
 * matches. That over-reports a census and also a CALL COUNT (mantahostels#2283),
 * so a commented-out call can turn a `bounded` id `ambiguous` — the safe
 * direction, a bound withdrawn rather than invented.
 *
 * `gp_rule_text <id> <fallback>`, lib/guard-parse.sh's fetch with a fallback
 * sentence, is the same call and read as one (workflow-core#772).
 *
 * Shared with scripts/check-guard-registry.js, which reads the same calls to
 * decide which guard prints which fragment.
 */
const DIRECT_RULE_RE =
	/\b(?:gp_)?rule_text\s+(?:"(?:rule:)?([a-z0-9-]+)"|'(?:rule:)?([a-z0-9-]+)'|(?:rule:)?([a-z0-9-]+))/g;

/**
 * The bound on a direct call: `gp_rule_told <id>`, which asks whether this
 * session has already been handed the fragment the guard is about to compose
 * (mantahostels#2275). A guard that asks pays the fragment once a session rather than once
 * per firing.
 *
 * ANCHORED, admitting only the `if` and `!` a test can carry in front of it, so
 * a mention in a header reads as no bound. A call spelled some other way reads
 * as no bound too.
 *
 * A BOUND IS CREDITED only where the guard makes exactly ONE direct
 * `rule_text <id>` call AND spends it at exactly ONE emission site
 * (mantahostels#2283, mantahostels#2354). Two or more of either read as `ambiguous`, as does an
 * emission the scan cannot correlate with the fetch at all — see
 * §emissionSites.
 *
 * ONE SITE EACH IS STILL NOT PROOF: the bound may sit on a branch that never
 * reaches the emission, or after it. §emissionSites names the rest.
 */
const LATCHED_RULE_RE =
	/^[ \t]*(?:if[ \t]+)?(?:![ \t]+)?gp_rule_told[ \t]+(?:"(?:rule:)?([a-z0-9-]+)"|'(?:rule:)?([a-z0-9-]+)'|(?:rule:)?([a-z0-9-]+))/gm;

/**
 * The other half of the bound: `gp_rule_mark_told <id>`, which records that the
 * fragment has now been delivered. TWO CALLS, NOT ONE, the emission sitting
 * between them (guard-parse.sh §gp_rule_told).
 *
 * A `gp_rule_told` with no matching mark never becomes true, so the bound is
 * stranded permanently and the fragment is paid on every firing — the second
 * blind spot mantahostels#2283 names.
 *
 * ANCHORED as LATCHED_RULE_RE is, minus the `if`/`!`: the mark is a statement,
 * never a test.
 *
 * `gp_rule_latch_after <id>` COUNTS AS A MARK (mantahostels#2528) — the same record,
 * deferred into `gp_rule`. Both spellings anchor the same way, and an id
 * passed as a variable is invisible to either.
 */
const MARKED_RULE_RE =
	/^[ \t]*(?:gp_rule_mark_told|gp_rule_latch_after)[ \t]+(?:"(?:rule:)?([a-z0-9-]+)"|'(?:rule:)?([a-z0-9-]+)'|(?:rule:)?([a-z0-9-]+))/gm;

/**
 * `gp_rule_module <module> <id>...`, which skips the ids at run time unless the
 * host has <module> on (workflow-core#449), and `gp_rule_unless_module`, which skips them
 * where it is on (workflow-core#2409). Anchored as EMIT_RULE_RE is.
 */
const MODULE_RULE_RE = new RegExp(
	`^[ \\t]*gp_rule_(module|unless_module)[ \\t]+([a-z]+)${RULE_ARGS}`,
	"gm",
);

/**
 * Each module gate a gp_rule_path_rows table puts on its row's id: the words
 * after the path.
 *
 * @param {string} text
 * @returns {{ module: string, id: string }[]}
 */
function tableGates(text) {
	return ruleTableRows(text).flatMap(([id, , ...modules]) =>
		modules.map((module) => ({ module, id })),
	);
}

/**
 * A repo-relative script path inside a hook command string.
 *
 * There are two house spellings (mantahostels#2059): the shell form
 * `"$CLAUDE_PROJECT_DIR"/scripts/x.sh` and the exec form
 * `${CLAUDE_PROJECT_DIR}/scripts/x.sh`, which carries an `args` key. Both put a
 * slash immediately before the path, which is why the preceding character class
 * admits `/`; it admits whitespace for the `node scripts/x.js` spelling.
 * Shared with scripts/check-guard-registry.js, which reads the same settings
 * file to decide which script a command wires.
 *
 * Every caller runs it over hookCommandLine() below rather than over `command`
 * alone (mantahostels#2266), so the interpreter spelling — `"command": "node", "args":
 * ["…/scripts/x.js"]` — has its path seen rather than reading as unwired.
 */
const WIRED_SCRIPT_RE =
	/(?:^|[\s"'/=([])((?:scripts|\.husky|\.claude)\/[\w.-]+(?:\/[\w.-]+)*\.(?:sh|js|mjs|cjs|ts))/g;

/**
 * A tool name as a matcher may spell one. Anything else in an alternation — a
 * character class, a wildcard, an empty match-all — names no tool and so opens
 * no group of its own, while still covering the groups it matches.
 */
const TOOL_NAME_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * The settings-shaped hook wiring this module reads, `{ hooks }`. Deliberately looser
 * than scripts/lib/hook-wiring.ts's SettingsShape: an event key this module
 * does not know still parses, because a group must never vanish through a
 * narrow type.
 *
 * @typedef {{ hooks?: Record<string, Array<{ matcher?: string, hooks?: Array<{ command?: string, args?: unknown }> }>> }} Settings
 */

/** One hook registration, flattened out of the entry carrying its matcher.
 * @typedef {{ matcher: string | undefined, commandLine: string }} Registration */

/**
 * One hook entry as the single command line it runs — `command` and the exec
 * form's `args` joined, which is the spelling both forms share and the one the
 * transcript records (mantahostels#2266).
 *
 * Shared with scripts/check-guard-registry.js on WIRED_SCRIPT_RE's own grounds,
 * stated below it.
 *
 * The hooks file is untyped JSON, so an `args` that is not an array of
 * strings contributes nothing rather than throwing.
 *
 * @param {{ command?: string, args?: unknown }} entry
 * @returns {string}
 */
function hookCommandLine(entry) {
	const args = Array.isArray(entry?.args)
		? entry.args.filter((a) => typeof a === "string")
		: [];
	return [entry?.command ?? "", ...args].join(" ");
}

/** One contributing guard, as reachableByTool reports it. `ids` are the
 * distinct rule ids it can reach and `bytes` their total — which may overlap
 * another guard's, so a tool's own figure is the union and not this sum.
 * @typedef {{ file: string, bytes: number, calls: number, ids: string[] }} GuardFigure */

/** Thrown where an input this module reads the repo WITH cannot be read, or
 * where a gp_rule call it reads can never fire at all. */
class RuleEmissionError extends Error {
	/**
	 * @param {string} message
	 * @param {ErrorOptions} [options]
	 */
	constructor(message, options) {
		super(message, options);
		this.name = "RuleEmissionError";
	}
}

/**
 * GP_RULE_CAP, read out of the bash library that enforces it.
 *
 * @param {string} [file] absolute path of the assigning file
 * @returns {number} the ceiling in bytes
 * @throws {RuleEmissionError} where the file cannot be read, or holds no
 *   anchored `GP_RULE_CAP=<digits>` assignment — never a default, which would
 *   pass a group that will really be truncated.
 */
function gpRuleCap(file = CAP_FILE) {
	let text;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch (e) {
		throw new RuleEmissionError(
			`rule-emission: cannot read ${file}, where GP_RULE_CAP is assigned: ${caught(e).message}`,
			{ cause: e },
		);
	}
	const m = /^[ \t]*GP_RULE_CAP=(\d+)[ \t]*$/m.exec(text);
	if (!m)
		throw new RuleEmissionError(
			`rule-emission: no anchored GP_RULE_CAP=<digits> assignment in ${file}, ` +
				"and the ceiling is read rather than restated here, so there is no fallback.",
		);
	return Number(m[1]);
}

/**
 * Every gp_rule call in one guard's source, as its list of ids.
 *
 * A call naming the same id twice yields it once, matching gp_rule's own latch
 * loop, which skips a repeat before the marker is written.
 *
 * @param {string} text the guard's source
 * @returns {string[][]} one entry per call, ids in the order given
 */
function ruleCalls(text) {
	/** @type {string[][]} */
	const calls = [];
	for (const m of text.matchAll(EMIT_RULE_RE)) {
		/** @type {string[]} */
		const ids = [];
		for (const a of (m[1] ?? "").matchAll(RULE_ARG_RE))
			if (a[1] && !ids.includes(a[1])) ids.push(a[1]);
		if (ids.length > 0) calls.push(ids);
	}
	return calls;
}

/**
 * The ids one guard's source gates off for the host at <root>: through
 * gp_rule_module on a module it has off, through gp_rule_unless_module on one
 * it has on, and through a gp_rule_path_rows row's module it has off.
 *
 * @param {string} text the guard's source
 * @param {string} root the host root whose config decides
 * @returns {Set<string>}
 */
function gatedOffIds(text, root) {
	/** @type {Set<string>} */
	const off = new Set();
	for (const m of text.matchAll(MODULE_RULE_RE)) {
		/* Unchecked cast: moduleOn itself throws on a name it does not know. */
		const module = /** @type {import("./workflow-core-config").Module} */ (
			m[2]
		);
		if (moduleOn(module, { root }) === (m[1] === "module")) continue;
		for (const a of (m[3] ?? "").matchAll(RULE_ARG_RE)) if (a[1]) off.add(a[1]);
	}
	for (const { module, id } of tableGates(text)) {
		/* Unchecked cast, as above. */
		const gate = /** @type {import("./workflow-core-config").Module} */ (
			module
		);
		if (!moduleOn(gate, { root })) off.add(id);
	}
	return off;
}

/**
 * Every DIRECT `rule_text` call in one guard's source, as id → how many CALL
 * SITES name it, in the order given.
 *
 * @param {string} text the guard's source
 * @returns {Map<string, number>}
 */
function directRuleCounts(text) {
	/** @type {Map<string, number>} */
	const counts = new Map();
	for (const m of text.matchAll(DIRECT_RULE_RE)) {
		const id = m[1] ?? m[2] ?? m[3];
		if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
	}
	return counts;
}
/*
 * WHERE THE BYTES ARE ACTUALLY SPENT (mantahostels#2354).
 *
 * A `rule_text <id>` FETCH costs nothing on its own; the fragment is paid at the
 * EMISSION that carries it — `gp_context`, `gp_warn`, `gp_deny`. The count below
 * is over emissions, not over fetches.
 *
 * IT IS STILL LEXICAL, and over-approximates where it can: a name that could
 * hold the fragment counts wherever it appears, and a fetch whose route to an
 * emission this cannot follow yields ZERO sites — both read `ambiguous`, which
 * withdraws a bound rather than inventing one.
 *
 * THE DIRECTION IS NOT GUARANTEED, and that is the standing residual. A second
 * emission the statement splitter fails to separate out is a bound INVENTED.
 * Two shapes are known to defeat it: an emission reached only through `eval`
 * or a variable holding a command name, and one whose helper is called
 * through a name this cannot resolve — `$fn` or a dispatch table.
 */

/** The accessors that spend a fragment's bytes, at the head of their statement. */
const EMIT_ACCESSOR_RE = /^(?:gp_context|gp_warn|gp_deny)\b([\s\S]*)$/;

/** The keywords a statement can carry in front of a command. */
const STMT_KEYWORD_RE = /^(?:if|elif|then|else|while|until|do|!)[ \t]+/;

/** A house-style function head: `name() {` alone on its line. */
const FUNC_HEAD_RE =
	/^([A-Za-z_][A-Za-z0-9_]*)[ \t]*\([ \t]*\)[ \t]*\{[ \t]*$/gm;

/**
 * An assignment, with the declaration keyword bash allows in front of it, `+=`
 * included (workflow-core#2144).
 *
 * The value may not start with a space, which is what tells `reason="…"` apart
 * from the one-shot environment prefix in `IFS= read … reason`.
 */
const ASSIGN_RE =
	/^(?:(local|export|declare|typeset)[ \t]+)?(?:-\w+[ \t]+)*([A-Za-z_][A-Za-z0-9_]*)\+?=([^ \t][\s\S]*|)$/;

/** A `for` loop's head, which fills its variable from each word in turn
 * (workflow-core#2144). */
const FOR_RE = /^for[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]+in\b([\s\S]*)$/;

/**
 * `read` filling a variable, which is how the guards build a multi-line deny
 * reason: `IFS= read -r -d '' reason <<EOF`. The name is the last bare word
 * before the redirection.
 */
const READ_RE = /\bread\b[\s\S]*?([A-Za-z_][A-Za-z0-9_]*)[ \t]*<<-?/;

/** A heredoc redirection and the delimiter that ends its body. */
const HEREDOC_RE = /^<<(-?)[ \t]*(?:"([^"]+)"|'([^']+)'|([A-Za-z_][\w]*))/;

/** `HEREDOC_RE` unanchored, for a line-wise search. */
const HEREDOC_IN_LINE_RE = new RegExp(HEREDOC_RE.source.slice(1));

/**
 * The delimiter a heredoc match closes its body on: whichever of its three
 * spellings — double-quoted, single-quoted, bare — took part. None taking part
 * is a broken invariant, which throws rather than closing the body on the text
 * "undefined" (workflow-core#1341).
 *
 * @param {RegExpExecArray} h a match of `HEREDOC_RE`'s groups
 * @returns {string}
 * @throws {RuleEmissionError}
 */
function heredocDelimiter(h) {
	const delim = h[2] ?? h[3] ?? h[4];
	if (delim === undefined)
		throw new RuleEmissionError(
			`rule-emission: a heredoc match took no delimiter group: ${JSON.stringify(h[0])}`,
		);
	return delim;
}

/**
 * Every function body in one guard's source, as name and the offsets it spans.
 *
 * Both house spellings: `name() {` opening a block that a `}` at column 0
 * closes, and the one-liner `name() { …; }`. The search runs over a copy with
 * heredoc bodies blanked, so a `}` at column 0 inside a deny reason cannot close
 * a span early. A function closed some other way runs to the end of the file,
 * which over-scopes rather than under-scopes.
 *
 * @param {string} text the guard's source
 * @returns {{ name: string, start: number, end: number }[]}
 */
function functionSpans(text) {
	const masked = maskHeredocs(text);
	/** @type {{ name: string, start: number, end: number }[]} */
	const spans = [];
	for (const m of masked.matchAll(FUNC_HEAD_RE)) {
		const start = (m.index ?? 0) + m[0].length;
		const eol = masked.indexOf("\n", start);
		const oneLine = masked.slice(start, eol === -1 ? masked.length : eol);
		const name = requiredGroup(m, 1, FUNC_HEAD_RE);
		if (/\}[ \t]*$/.test(oneLine)) {
			spans.push({
				name,
				start,
				end: start + oneLine.lastIndexOf("}"),
			});
			continue;
		}
		const close = masked.indexOf("\n}", start);
		spans.push({ name, start, end: close === -1 ? text.length : close });
	}
	return spans;
}

/**
 * The same source with every heredoc body replaced by spaces, offsets intact.
 *
 * Line-wise and quote-blind, so a `<<EOF` inside a comment or a string blanks
 * text that is not a body. That over-blanks, lengthening a function span rather
 * than shortening it.
 *
 * @param {string} text
 * @returns {string}
 */
function maskHeredocs(text) {
	/* One iterator for both loops, so the lines a body consumes are not walked
	 * again as code. */
	const lines = text.split("\n")[Symbol.iterator]();
	/** @type {string[]} */
	const out = [];
	for (const line of lines) {
		out.push(line);
		const h = HEREDOC_IN_LINE_RE.exec(line);
		if (!h || /\$\(\(/.test(line)) continue;
		const delim = heredocDelimiter(h);
		const closes = h[1] ? /^[ \t]*/ : /^/;
		for (const body of lines) {
			if (body.replace(closes, "") === delim) {
				out.push(body);
				break;
			}
			out.push(" ".repeat(body.length));
		}
	}
	return out.join("\n");
}

/**
 * The function an offset sits in, or the empty string for top level.
 *
 * @param {number} at
 * @param {{ name: string, start: number, end: number }[]} spans
 * @returns {string}
 */
function scopeAt(at, spans) {
	for (const s of spans) if (at >= s.start && at < s.end) return s.name;
	return "";
}

/**
 * A literal for splicing into a `new RegExp`, its metacharacters defanged.
 *
 * @param {string} s
 * @returns {string}
 */
function reLiteral(s) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** One statement of a guard's source, tagged with the function it sits in and
 * whether it is a function head.
 * @typedef {{ text: string, scope: string, head: boolean }} BashStatement */

/**
 * bashStatements' lexer state, threaded through its per-character steps.
 *
 * @typedef {object} StatementScan
 * @property {string} text the guard's source
 * @property {{ name: string, start: number, end: number }[]} spans
 * @property {BashStatement[]} out
 * @property {number} i the offset being read
 * @property {string} buf the statement read so far
 * @property {number} start the offset `buf` began at
 * @property {boolean} single
 * @property {boolean} double
 * @property {number} arith `$((` … `))`, where `<<` is a left shift and not a
 *   redirection
 * @property {number} depth unquoted parenthesis nesting, which tells a group's
 *   `)` from a case arm's
 */

/**
 * Ends the statement read so far, keeping it unless blank, and starts the next
 * at `next`.
 *
 * @param {StatementScan} scan accumulator: the statement walk's state, advanced in place
 * @param {number} next
 */
function flushStatement(scan, next) {
	const s = scan.buf.trim();
	if (s)
		scan.out.push({
			text: s,
			scope: scopeAt(scan.start, scan.spans),
			head: /^[A-Za-z_]\w*[ \t]*\([ \t]*\)/.test(s),
		});
	scan.buf = "";
	scan.start = next;
}

/**
 * Takes an escape or a quote at the read offset into the statement.
 *
 * @param {StatementScan} scan accumulator: the statement walk's state, advanced in place
 * @returns {boolean} whether the offset was one
 */
function consumeQuoting(scan) {
	const { text, i } = scan;
	const c = text[i];
	if (c === "\\" && !scan.single) {
		scan.buf += c + (text[i + 1] ?? "");
		scan.i++;
		return true;
	}
	if (c === "'" && !scan.double) {
		scan.single = !scan.single;
		scan.buf += c;
		return true;
	}
	if (c === '"' && !scan.single) {
		scan.double = !scan.double;
		scan.buf += c;
		return true;
	}
	return false;
}

/**
 * The offset a heredoc opening at `i` ends at: the newline after its closing
 * delimiter, else the end of the text.
 *
 * @param {string} text
 * @param {number} i
 * @param {RegExpExecArray} h a match of `HEREDOC_RE` at `i`
 * @returns {number}
 */
function heredocEnd(text, i, h) {
	const delim = heredocDelimiter(h);
	const body = text.indexOf("\n", i);
	const at =
		body === -1
			? -1
			: text
					.slice(body)
					.search(
						new RegExp(
							`\\n${h[1] ? "[ \\t]*" : ""}${reLiteral(delim)}[ \\t]*(?:\\n|$)`,
						),
					);
	const raw =
		body === -1 || at === -1
			? -1
			: text.indexOf("\n", body + at + 1 + delim.length);
	return raw === -1 ? text.length : raw;
}

/**
 * Skips a comment opening at the read offset, to the end of its line.
 *
 * @param {StatementScan} scan accumulator: the statement walk's state, advanced in place
 * @returns {boolean} whether one opened there
 */
function skipComment(scan) {
	const { text, i } = scan;
	const prev = text[i - 1];
	if (text[i] !== "#" || !(prev === undefined || /[\s;&|(]/.test(prev)))
		return false;
	const nl = text.indexOf("\n", i);
	scan.i = nl === -1 ? text.length : nl - 1;
	return true;
}

/**
 * Ends the statement at a parenthesis bash reads as grouping, not as `$(` or
 * the `()` of a function head: both of those keep their `(` attached to the
 * character in front of it. An unmatched `)` closes a CASE ARM, whose command
 * follows on the same line.
 *
 * @param {StatementScan} scan accumulator: the statement walk's state, advanced in place
 * @returns {boolean} whether it ended one
 */
function breakAtParen(scan) {
	const { text, i } = scan;
	const c = text[i];
	if (c === "(") {
		scan.depth++;
		if (/[$\w(]/.test(text[i - 1] ?? " ")) return false;
		flushStatement(scan, i + 1);
		return true;
	}
	if (c !== ")") return false;
	const arm = scan.depth === 0;
	if (!arm) scan.depth--;
	if (!arm && /[$(]/.test(text[i - 1] ?? " ")) return false;
	flushStatement(scan, i + 1);
	return true;
}

/**
 * Ends the statement at a statement separator, a grouping parenthesis or a
 * reserved brace. A brace is a reserved word only as a word of its own;
 * `${x}` is not.
 *
 * @param {StatementScan} scan
 * @returns {boolean} whether it ended one
 */
function breakAtBoundary(scan) {
	const { text, i } = scan;
	const c = text[i];
	if (c === "\n" || c === ";" || c === "|" || c === "&") {
		flushStatement(scan, i + 1);
		return true;
	}
	if (breakAtParen(scan)) return true;
	if (
		(c === "{" || c === "}") &&
		/[\s;&|]/.test(text[i - 1] ?? " ") &&
		/[\s;&|]/.test(text[i + 1] ?? " ")
	) {
		flushStatement(scan, i + 1);
		return true;
	}
	return false;
}

/**
 * Takes an unquoted heredoc, comment or boundary at the read offset, tracking
 * `$((` … `))` on the way.
 *
 * @param {StatementScan} scan accumulator: the statement walk's state, advanced in place
 * @returns {boolean} whether the offset was one
 */
function consumeUnquoted(scan) {
	const { text, i } = scan;
	if (text.startsWith("$((", i)) scan.arith++;
	else if (scan.arith && text.startsWith("))", i)) scan.arith--;
	const h = scan.arith ? null : HEREDOC_RE.exec(text.slice(i));
	if (h) {
		const stop = heredocEnd(text, i, h);
		scan.buf += text.slice(i, stop);
		scan.i = stop - 1;
		return true;
	}
	return skipComment(scan) || breakAtBoundary(scan);
}

/**
 * One guard's source split into statements, each tagged with the function it
 * sits in.
 *
 * Quote-aware, and a heredoc body belongs to the statement that opens it: the
 * guards' deny text runs over many lines inside one quoted span, and a
 * line-wise split would strand the `$(…)` carrying the fragment.
 *
 * BOUNDARIES ARE WIDE ON PURPOSE — newline, `;`, `|`, `&`, `(`, `)` and a
 * reserved `{`/`}`. A boundary missed is an emission read as part of its
 * neighbour and never counted, which is the direction that invents a bound; a
 * boundary taken where bash would not take one only splits a statement in two.
 *
 * @param {string} text the guard's source
 * @param {{ name: string, start: number, end: number }[]} spans
 * @returns {BashStatement[]}
 */
function bashStatements(text, spans) {
	/** @type {StatementScan} */
	const scan = {
		text,
		spans,
		out: [],
		i: 0,
		buf: "",
		start: 0,
		single: false,
		double: false,
		arith: 0,
		depth: 0,
	};
	for (; scan.i < text.length; scan.i++) {
		if (consumeQuoting(scan)) continue;
		if (!scan.single && !scan.double && consumeUnquoted(scan)) continue;
		scan.buf += text[scan.i];
	}
	flushStatement(scan, text.length);
	return scan.out;
}

/**
 * What can carry one id's fragment through one guard's source. emissionSites
 * grows `fns` and `vars` to a fixed point, and isCarrier reads them as they
 * stand at each test.
 *
 * @typedef {object} Carriers
 * @property {RegExp} fetch the `rule_text` call on the id itself
 * @property {Set<string>} fns function names whose output can hold the fragment
 * @property {{ scope: string, name: string }[]} vars every variable that can
 *   hold the fragment, each with the function bash scopes it to — the empty
 *   string for a global
 * @property {Map<string, Set<string>>} reaches which functions each function
 *   can call, transitively, for `local`'s reach
 */

/**
 * Adds to `reaches` every function one statement calls, with what each of
 * those reaches.
 *
 * @param {BashStatement} s
 * @param {Set<string>} names every function the guard defines
 * @param {Map<string, Set<string>>} reaches
 * @returns {boolean} whether anything was added
 */
function widenReach(s, names, reaches) {
	let grew = false;
	for (const n of names) {
		const from = reaches.get(s.scope);
		if (s.head || !from || from.has(n)) continue;
		if (!new RegExp(`\\b${reLiteral(n)}\\b`).test(s.text)) continue;
		for (const r of reaches.get(n) ?? []) from.add(r);
		grew = true;
	}
	return grew;
}

/**
 * Which functions each function can call, transitively; "" is top level.
 *
 * @param {Set<string>} names every function the guard defines
 * @param {BashStatement[]} stmts
 * @returns {Map<string, Set<string>>}
 */
function callReach(names, stmts) {
	const reaches = new Map([...names, ""].map((n) => [n, new Set([n])]));
	for (let grew = true; grew; ) {
		grew = false;
		for (const s of stmts) if (widenReach(s, names, reaches)) grew = true;
	}
	return reaches;
}

/**
 * @param {string} t a statement, or the part of one that can hold the fragment
 * @param {string} scope the function `t` sits in
 * @param {Carriers} c
 * @returns {boolean}
 */
function isCarrier(t, scope, c) {
	if (c.fetch.test(t)) return true;
	for (const f of c.fns)
		if (new RegExp(`\\b${reLiteral(f)}\\b`).test(t)) return true;
	return c.vars.some(
		(v) =>
			(v.scope === "" || c.reaches.get(v.scope)?.has(scope)) &&
			new RegExp(`\\$\\{?${reLiteral(v.name)}\\b`).test(t),
	);
}

/**
 * Records the variable one statement fills from a carrier.
 *
 * @param {BashStatement} s
 * @param {Carriers} c accumulator: a new carrier is recorded in it
 * @param {Map<string, Set<string>>} scopedTo variable name → the scopes it is
 *   local to
 * @returns {boolean} whether the variable was new
 */
function learnVariable(s, c, scopedTo) {
	const a = ASSIGN_RE.exec(s.text);
	const f = a ? null : FOR_RE.exec(s.text);
	const r = a || f ? null : READ_RE.exec(s.text);
	const filled = a?.[2] ?? f?.[1] ?? r?.[1];
	let source = s.text;
	if (a) source = requiredGroup(a, 3, ASSIGN_RE);
	else if (f) source = requiredGroup(f, 2, FOR_RE);
	if (!filled || !isCarrier(source, s.scope, c)) return false;
	const scope = scopedTo.get(filled)?.has(s.scope) ? s.scope : "";
	if (c.vars.some((v) => v.scope === scope && v.name === filled)) return false;
	c.vars.push({ scope, name: filled });
	return true;
}

/**
 * Records one statement's function as a carrier where the statement carries.
 *
 * @param {BashStatement} s
 * @param {Carriers} c accumulator: a new carrier is recorded in it
 * @returns {boolean} whether the function was new
 */
function learnFunction(s, c) {
	if (
		!s.scope ||
		s.head ||
		c.fns.has(s.scope) ||
		!isCarrier(s.text, s.scope, c)
	)
		return false;
	c.fns.add(s.scope);
	return true;
}

/**
 * A statement with its leading keywords (`if`, `then`, `!` …) cut away.
 *
 * @param {string} text
 * @returns {string}
 */
function stripKeywords(text) {
	let head = text;
	for (let cut = head.replace(STMT_KEYWORD_RE, ""); cut !== head; ) {
		head = cut;
		cut = head.replace(STMT_KEYWORD_RE, "");
	}
	return head;
}

/**
 * How many carrying emissions each function holds; "" is top level.
 *
 * @param {BashStatement[]} stmts
 * @param {Carriers} c
 * @returns {Map<string, number>}
 */
function carryingEmissions(stmts, c) {
	/** @type {Map<string, number>} */
	const emits = new Map();
	for (const s of stmts) {
		if (s.head) continue;
		const e = EMIT_ACCESSOR_RE.exec(stripKeywords(s.text));
		if (e && isCarrier(requiredGroup(e, 1, EMIT_ACCESSOR_RE), s.scope, c))
			emits.set(s.scope, (emits.get(s.scope) ?? 0) + 1);
	}
	return emits;
}

/**
 * The emissions counted at their functions' call sites, top level's once.
 *
 * @param {Map<string, number>} emits
 * @param {BashStatement[]} stmts
 * @returns {number}
 */
function siteCount(emits, stmts) {
	let sites = emits.get("") ?? 0;
	for (const [fn, n] of emits) {
		if (!fn) continue;
		const callers = stmts.filter(
			(s) =>
				!s.head &&
				s.scope !== fn &&
				new RegExp(`\\b${reLiteral(fn)}\\b`).test(s.text),
		).length;
		sites += n * Math.max(1, callers);
	}
	return sites;
}

/**
 * How many EMISSION sites in one guard's source can carry a given id's fragment
 * (mantahostels#2354).
 *
 * A name CARRIES the fragment if it is the fetch itself, a function whose body
 * touches a carrier, or a variable assigned from one — taken to a fixed point,
 * so a helper two statements away from the fetch still counts.
 *
 * AN EMISSION INSIDE A HELPER IS COUNTED AT THE HELPER'S CALL SITES, not once
 * where it is written: a `deny()` two branches both call has two paths through
 * it, and counting the written emission alone would credit a bound covering
 * only one of them. A helper nothing calls counts once.
 *
 * VARIABLE SCOPE IS BASH'S, WHICH IS DYNAMIC: a name declared `local` in a
 * function is visible to every function that one calls, and to nothing else.
 *
 * @param {string} text the guard's source
 * @param {string} id the fragment id
 * @returns {number} emission statements that can spend it
 */
function emissionSites(text, id) {
	const spans = functionSpans(text);
	const stmts = bashStatements(text, spans);
	const names = new Set(spans.map((s) => s.name));
	/** @type {Carriers} */
	const carriers = {
		fetch: new RegExp(
			`\\b(?:gp_)?rule_text\\s+["']?${reLiteral(id)}["']?(?![\\w-])`,
		),
		fns: new Set(),
		vars: [],
		reaches: callReach(names, stmts),
	};
	/** @type {Map<string, Set<string>>} variable name → the scopes it is local to */
	const scopedTo = new Map();
	for (const s of stmts)
		for (const d of declaredNames(s.text))
			scopedTo.set(d, (scopedTo.get(d) ?? new Set()).add(s.scope));
	/* A fixed point, not one pass: a carrier learnt late makes an earlier
	 * statement carry too. */
	for (let grew = true; grew; ) {
		grew = false;
		for (const s of stmts) {
			if (learnVariable(s, carriers, scopedTo)) grew = true;
			if (learnFunction(s, carriers)) grew = true;
		}
	}
	return siteCount(carryingEmissions(stmts, carriers), stmts);
}

/**
 * The names one statement declares `local` to its own function, if any.
 *
 * @param {string} stmt
 * @returns {string[]}
 */
function declaredNames(stmt) {
	const declRe = /^(?:local|declare|typeset)[ \t]+((?:-\w+[ \t]+)*)([\s\S]*)$/;
	const nameRe = /^([A-Za-z_]\w*)(?:=|$)/;
	const m = declRe.exec(stmt);
	if (!m) return [];
	/** @type {string[]} */
	const names = [];
	for (const w of requiredGroup(m, 2, declRe).split(/[ \t]+/)) {
		const n = nameRe.exec(w);
		if (n) names.push(requiredGroup(n, 1, nameRe));
	}
	return names;
}

/**
 * How well one guard's `gp_rule_told` bound covers its own direct calls on an
 * id (mantahostels#2283).
 *
 * `none` — no bound at all, or a `gp_rule_told` with no matching
 *   `gp_rule_mark_told` (MARKED_RULE_RE's docstring above) — either way the
 *   fragment is paid on every firing.
 * `bounded` — a bound, one fetch site, and one emission site spending it.
 * `ambiguous` — a bound whose target cannot be read off the text: more than one
 *   fetch site, more than one emission site, or no emission site the scan can
 *   correlate with the fetch (mantahostels#2354).
 *
 * @typedef {"none" | "bounded" | "ambiguous"} LatchState
 */

/** Worst-first, so a set of states is aggregated by taking the minimum: one
 * guard's unbounded path decides the id however well its neighbours bound
 * theirs.
 * @type {Record<LatchState, number>} */
const LATCH_RANK = { none: 0, ambiguous: 1, bounded: 2 };

/**
 * The least-covered of a set of latch states.
 *
 * @param {LatchState} a
 * @param {LatchState} b
 * @returns {LatchState}
 */
function weakerLatch(a, b) {
	return LATCH_RANK[a] <= LATCH_RANK[b] ? a : b;
}

/**
 * The distinct ids one guard's source latches through `gp_rule_told`.
 *
 * @param {string} text the guard's source
 * @returns {string[]}
 */
function latchedRuleIds(text) {
	return idsMatching(text, LATCHED_RULE_RE);
}

/**
 * The distinct ids one guard's source RECORDS as delivered, through
 * `gp_rule_mark_told` or `gp_rule_latch_after`.
 *
 * @param {string} text the guard's source
 * @returns {string[]}
 */
function markedRuleIds(text) {
	return idsMatching(text, MARKED_RULE_RE);
}

/**
 * The distinct ids a three-alternative id pattern finds, in the order given.
 *
 * @param {string} text
 * @param {RegExp} re a global pattern whose groups 1-3 are the quoting variants
 * @returns {string[]}
 */
function idsMatching(text, re) {
	/** @type {string[]} */
	const ids = [];
	for (const m of text.matchAll(re)) {
		const id = m[1] ?? m[2] ?? m[3];
		if (id && !ids.includes(id)) ids.push(id);
	}
	return ids;
}

/**
 * Total of an id→bytes map's values, the shape every figure below is summed in.
 *
 * @param {Iterable<number>} ns
 * @returns {number}
 */
function sum(ns) {
	let t = 0;
	for (const n of ns) t += n;
	return t;
}

/**
 * The DISTINCT rule ids one guard can reach, and the bytes they resolve to.
 *
 * EVERY FRAGMENT IS RESOLVED, including one that would fall past GP_RULE_CAP on
 * a crowded call: gp_rule resolves its whole argument list before it emits
 * anything and exits 2 on any id the store cannot answer for, so an unresolvable
 * id is a store fault wherever it sits.
 *
 * A FRAGMENT OVER THE CAP ON ITS OWN IS NOT A THROW (mantahostels#2054): gp_rule can never
 * emit it whole — offered first in a call with nothing else emitted yet, it
 * exits 2 and denies the tool call outright; offered after other ids, it is
 * deferred instead (guard-parse.sh's `break`), unlatched, so the same refusal
 * lands once those have latched and it is first in line. Either way it is the
 * repo's own rule text, not this module's apparatus — a fact for the caller to
 * report as a finding, not a fault this module raises. It is excluded from
 * `ids`/`bytes` (a call that can never emit it pays nothing) and named in
 * `overCap` instead, so the caller can tell "pays nothing" from "was never
 * even offered".
 *
 * @param {string[][]} calls the guard's gp_rule calls
 * @param {(id: string) => string} resolve
 * @param {number} cap GP_RULE_CAP
 * @returns {{ ids: string[], bytes: Map<string, number>, overCap: { id: string, bytes: number }[] }}
 */
function guardIds(calls, resolve, cap) {
	/** @type {string[]} */
	const ids = [];
	/** @type {Map<string, number>} */
	const bytes = new Map();
	/** @type {{ id: string, bytes: number }[]} */
	const overCap = [];
	const seen = new Set();
	for (const id of calls.flat()) {
		if (seen.has(id)) continue;
		seen.add(id);
		const n = Buffer.byteLength(resolve(id), "utf8");
		if (n > cap) {
			overCap.push({ id, bytes: n });
			continue;
		}
		ids.push(id);
		bytes.set(id, n);
	}
	return { ids, bytes, overCap };
}

/**
 * One guard's source from an explicit `sources` map.
 *
 * @param {Record<string, string>} sources
 * @param {string} rel
 * @returns {string}
 * @throws {RuleEmissionError} where the map does not carry the path
 */
function sourceOf(sources, rel) {
	const source = sources[rel];
	if (source === undefined)
		throw new RuleEmissionError(
			`rule-emission: the wiring names ${rel}, which the supplied sources do not carry.`,
		);
	return source;
}

/**
 * A `source` or `.` line's argument, at the head of its statement.
 *
 * ANCHORED, like EMIT_RULE_RE and for the same reason: `source` and `.` are
 * bare words, and the shellcheck directive above every real one
 * (`# shellcheck source=lib/guard-parse.sh`) would otherwise match as a second
 * source line for the same lib. A conditional `[ -f x ] && source x` is
 * invisible; no guard spells one that way.
 */
const SOURCE_LINE_RE = /^[ \t]*(?:source|\.)[ \t]+(\S.*)$/gm;

/**
 * The shell expansion in front of a sourced path, taken to the LAST of them —
 * `$here/`, `${BASH_SOURCE[0]%/*}/` and `$(dirname "${BASH_SOURCE[0]}")/` are
 * the repo's three, guards using the first and libs the other two. Every one
 * ends `$`, `}` or `)`, then an optional word, then the slash, which is what
 * this matches rather than the expansions themselves.
 */
const SOURCE_PREFIX_RE = /^.*[$})]\w*\//;

/**
 * The libs one file `source`s, as repo-relative paths, in the order given.
 *
 * RESOLVED AGAINST THE SOURCING FILE'S OWN DIRECTORY, which is what every
 * expansion above computes. Bash would resolve a BARE `source lib/x.sh` against
 * the caller's working directory instead.
 *
 * DROPPED, both silently: an absolute path, and one escaping the repo root.
 * A PATH STILL HOLDING A VARIABLE names no file and yields nothing here.
 *
 * @param {string} text the file's source
 * @param {string} rel the file's own repo-relative path
 * @returns {string[]}
 */
function sourcedLibs(text, rel) {
	const dir = path.posix.dirname(rel.split(path.sep).join("/"));
	/** @type {string[]} */
	const out = [];
	for (const m of text.matchAll(SOURCE_LINE_RE)) {
		const tail = (m[1] ?? "")
			.replace(SOURCE_PREFIX_RE, "")
			.replace(/["'\s].*$/, "");
		if (!/^[\w.-]+(?:\/[\w.-]+)*\.sh$/.test(tail)) continue;
		const resolved = path.posix.normalize(path.posix.join(dir, tail));
		if (resolved.startsWith("..")) continue;
		if (!out.includes(resolved)) out.push(resolved);
	}
	return out;
}

/**
 * One guard's EFFECTIVE source: its own text, then every lib it sources,
 * transitively, joined by newlines.
 *
 * NOT FOR `emissionSites`, WHICH KEEPS THE GUARD'S OWN TEXT. It counts the
 * emissions that can spend a fragment, and the accessors it counts —
 * `gp_context`, `gp_warn`, `gp_deny` — are DEFINED in lib/guard-parse.sh. Hand
 * it the effective source and each definition reads as a second emission,
 * turning a real bound `ambiguous` (mantahostels#2488). Residual: a guard whose
 * emission sits inside a lib helper is uncorrelated and reads `ambiguous`.
 *
 * AN UNREADABLE LIB IS SKIPPED SILENTLY (mantahostels#2488), unlike an unreadable wired
 * guard, which throws. A source line may name a path this module has no
 * business insisting on — a test's `sources` map carries the wired guards and
 * not their libs. IT IS A FAIL-OPEN AND NOTHING REPORTS IT: a lib whose
 * accessor calls go unread reads as absent.
 *
 * WHAT THE WIDENING COSTS IN THE OTHER DIRECTION. DIRECT_RULE_RE is unanchored
 * and lib/guard-parse.sh is sourced by every guard, so a literal `rule_text`
 * fetch — or a mention of one in a lib COMMENT — becomes a splice for all of
 * them, and an unlatched one strands the self-composing predicate of every
 * guard that reads as splicing nothing today.
 *
 * @param {string} rel the guard's repo-relative path
 * @param {string} text the guard's own source
 * @param {(rel: string) => string | null} readLib a lib's source, or null where
 *   it cannot be read
 * @returns {string}
 */
function effectiveSource(rel, text, readLib) {
	return [text, ...sourcedClosure(rel, text, readLib).values()].join("\n");
}

/**
 * Every lib one guard sources, transitively, as path → source in the order
 * read; a lib `readLib` cannot read is left out, and its own libs with it.
 * The one walk, so the files --against fetches and the source measured from
 * them cannot disagree (workflow-core#1120).
 *
 * @param {string} rel the guard's repo-relative path
 * @param {string} text the guard's own source
 * @param {(rel: string) => string | null} readLib
 * @returns {Map<string, string>}
 */
function sourcedClosure(rel, text, readLib) {
	const seen = new Set([rel]);
	/** @type {Map<string, string>} */
	const libs = new Map();
	const queue = sourcedLibs(text, rel);
	while (queue.length > 0) {
		const next = /** @type {string} */ (queue.shift());
		if (seen.has(next)) continue;
		seen.add(next);
		const libText = readLib(next);
		if (libText === null) continue;
		libs.set(next, libText);
		queue.push(...sourcedLibs(libText, next));
	}
	return libs;
}

/**
 * One guard's source from disk.
 *
 * @param {string} abs
 * @param {string} rel
 * @returns {string}
 * @throws {RuleEmissionError} on any read failure, ENOENT included — a hook
 *   naming a script that is not there is a wiring fault, not an empty guard
 */
function readGuard(abs, rel) {
	try {
		return fs.readFileSync(abs, "utf8");
	} catch (e) {
		throw new RuleEmissionError(
			`rule-emission: cannot read ${rel}, which a registered hook runs: ${caught(e).message}`,
			{ cause: e },
		);
	}
}

/**
 * Every registration on `event` in a settings object, flattened.
 *
 * @param {Settings} settings
 * @param {string} event
 * @returns {Registration[]}
 */
function registrationsOn(settings, event) {
	const entries = settings?.hooks?.[event];
	if (entries === undefined) return [];
	if (!Array.isArray(entries))
		throw new RuleEmissionError(
			`rule-emission: settings.hooks.${event} is not an array, so no group can be computed.`,
		);
	return entries.flatMap((entry) =>
		(entry?.hooks ?? []).map((h) => ({
			matcher: entry?.matcher,
			commandLine: hookCommandLine(h),
		})),
	);
}

/**
 * Does `matcher` cover `tool`? Anchored exactly as hookIsWired anchors, so
 * `Write` does not answer for `WriteFile`.
 *
 * AN ABSENT OR EMPTY MATCHER COVERS EVERY TOOL. `undefined` is the settings
 * shape for the events that take no matcher; `""` is the shape Claude Code
 * reads as match-all, and anchoring it literally would produce `/^()$/`, which
 * covers nothing and would silently drop that guard from every group.
 *
 * A MATCHER THAT IS NOT A VALID REGEX THROWS, naming itself — `"*"` is the
 * shape that does.
 *
 * @param {string | undefined} matcher
 * @param {string} tool
 * @returns {boolean}
 * @throws {RuleEmissionError} where `matcher` is not a valid regex
 */
function matcherCovers(matcher, tool) {
	if (matcher === undefined || matcher === "") return true;
	let re;
	try {
		re = new RegExp(`^(${matcher})$`);
	} catch (e) {
		throw new RuleEmissionError(
			`rule-emission: the ${EVENT} matcher ${JSON.stringify(matcher)} is not a ` +
				`valid regular expression, so the tools it covers cannot be read: ${caught(e).message}`,
			{ cause: e },
		);
	}
	return re.test(tool);
}

/** One id's direct-call census entry within one guard.
 * @typedef {{ bytes: number | null, latch: LatchState }} DirectFigure */

/** A `gp_rule_told` bound covering nothing, before reachableByTool names its
 * guard.
 * @typedef {{ id: string, resolves: boolean, bound: boolean, marked: boolean }} LatchFault */

/** What one wired guard reaches.
 * @typedef {{ ids: string[], bytes: Map<string, number>, overCap: { id: string, bytes: number }[], calls: number, direct: Map<string, DirectFigure>, latchFaults: LatchFault[] }} GuardReach */

/**
 * @param {string} name
 * @param {string | undefined} value undefined deletes the variable
 */
function setEnv(name, value) {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

/**
 * `read`'s result with the fragment store at `rulesDir` and its fallback layer
 * at `rulesFallbackDir`, both restored after; untouched where `rulesDir` is
 * undefined.
 *
 * @template T
 * @param {string | undefined} rulesDir
 * @param {string | undefined} rulesFallbackDir
 * @param {() => T} read
 * @returns {T}
 */
function withRuleStore(rulesDir, rulesFallbackDir, read) {
	const before = process.env.WFC_RULES_DIR;
	const fallbackBefore = process.env.WFC_RULES_FALLBACK_DIR;
	if (rulesDir !== undefined) {
		setEnv("WFC_RULES_DIR", rulesDir);
		setEnv("WFC_RULES_FALLBACK_DIR", rulesFallbackDir);
	}
	try {
		return read();
	} finally {
		if (rulesDir !== undefined) {
			setEnv("WFC_RULES_DIR", before);
			setEnv("WFC_RULES_FALLBACK_DIR", fallbackBefore);
		}
	}
}

/**
 * One guard's own source and its effective source, from `sources` where given,
 * else from disk under `root`.
 *
 * @param {string} rel
 * @param {Record<string, string> | undefined} sources
 * @param {string} root
 * @returns {{ own: string, effective: string }}
 */
function guardSources(rel, sources, root) {
	/* A guard the wiring names but this module cannot read throws rather
	 * than contributing 0 B: a silent skip deflates the total in the one
	 * direction that makes an over-cap group look compliant. */
	const own = sources
		? sourceOf(sources, rel)
		: readGuard(path.join(root, rel), rel);
	const effective = effectiveSource(rel, own, (lib) => {
		if (sources) return sources[lib] ?? null;
		try {
			return fs.readFileSync(path.join(root, lib), "utf8");
		} catch {
			return null;
		}
	});
	return { own, effective };
}

/**
 * One guard's gp_rule calls, each with its module-off ids dropped and an
 * emptied call dropped with them.
 *
 * @param {string} rel
 * @param {string} effective the guard's effective source
 * @param {string} root
 * @returns {string[][]}
 */
function liveRuleCalls(rel, effective, root) {
	let off;
	try {
		off = gatedOffIds(effective, root);
	} catch (e) {
		throw new RuleEmissionError(`rule-emission: ${rel}: ${caught(e).message}`, {
			cause: e,
		});
	}
	return ruleCalls(expandRuleTables(effective))
		.map((ids) => ids.filter((id) => !off.has(id)))
		.filter((ids) => ids.length);
}

/**
 * @param {string} rel
 * @param {string[][]} calls
 * @param {number} cap
 * @returns {ReturnType<typeof guardIds>}
 */
function reachedIds(rel, calls, cap) {
	/* rule-text's throw names the id and not the caller, and the caller is
	 * what a session has to open to fix it. */
	try {
		return guardIds(calls, ruleText, cap);
	} catch (e) {
		const { message } = caught(e);
		throw new RuleEmissionError(
			e instanceof RuleEmissionError
				? `rule-emission: ${rel}: ${message}`
				: `rule-emission: ${rel} calls gp_rule with an id the store cannot ` +
						`resolve: ${message}`,
			{ cause: e },
		);
	}
}

/**
 * The direct-call census of one guard, id by id.
 *
 * The direct census never throws where guardIds does. A gp_rule id the
 * store cannot answer for denies the tool call at run time, so it is a
 * fault worth stopping on; a direct call falls back to the guard's own
 * hardcoded sentence and still fires, so the same id costs a census
 * entry reading `unresolved` and nothing more.
 *
 * @param {Map<string, number>} counts direct call sites per id
 * @param {Set<string>} latched
 * @param {Set<string>} marked
 * @param {string} own the guard's own source, for emissionSites
 * @returns {Map<string, DirectFigure>}
 */
function directCensus(counts, latched, marked, own) {
	/** @type {Map<string, DirectFigure>} */
	const direct = new Map();
	for (const [id, sites] of counts) {
		let n = null;
		try {
			n = Buffer.byteLength(ruleText(id), "utf8");
		} catch {
			n = null;
		}
		/** @type {LatchState} */
		let latch = "ambiguous";
		if (!latched.has(id) || !marked.has(id)) latch = "none";
		else if (sites === 1 && emissionSites(own, id) === 1) latch = "bounded";
		direct.set(id, { bytes: n, latch });
	}
	return direct;
}

/**
 * @param {Map<string, number>} counts direct call sites per id
 * @param {Set<string>} latched
 * @param {Set<string>} marked
 * @param {string[][]} calls the guard's live gp_rule calls
 * @returns {LatchFault[]}
 */
function guardLatchFaults(counts, latched, marked, calls) {
	/* A bound that covers nothing (mantahostels#2283): a typo strands the latch forever
	 * while the census reports the real fragment bounded. */
	/** @type {LatchFault[]} */
	const latchFaults = [];
	/* A guard composing its own text and latching THAT, which gp_rule_told
	 * was built for (mantahostels#2275), has no fragment to resolve and no accessor to
	 * bind, so those two limbs read as failures on a working bound (mantahostels#2446).
	 *
	 * ORPHAN SPLICE is what separates it from the mantahostels#2283 typo, whose misspelt
	 * id also resolves to nothing and binds to nothing: an id the guard
	 * FETCHES and never latches is a splice the typo could have been meant
	 * for, and a guard with none has nothing for it to be a typo of. Both
	 * fetch routes count, `rule_text` and `gp_rule` alike — over `counts`
	 * alone a guard reaching the store only through `gp_rule` reads as having
	 * no splices at all, and its typo goes unreported (mantahostels#2470).
	 *
	 * BACKTICK EVERY ACCESSOR NAMED IN PROSE HERE. check-guard-registry.js
	 * scans this file for accessor calls lexically, and an unquoted
	 * `rule_text` followed by a bare word reads as a call on a rule id that
	 * does not exist, failing the build. */
	const spliced = new Set([...counts.keys(), ...calls.flat()]);
	const orphanSplice = [...spliced].some((k) => !latched.has(k));
	for (const id of latched) {
		let resolves = true;
		try {
			ruleText(id);
		} catch {
			resolves = false;
		}
		/* `counts` and `marked` read the EFFECTIVE source (mantahostels#2488), so a
		 * call or a `gp_rule_mark_told` in a sourced lib is seen. What
		 * neither can still say is that the call does not EXIST: an id
		 * passed as a variable is invisible either way (mantahostels#2283, mantahostels#2378).
		 * check-context-budget.js hedges both fault messages accordingly
		 * ("no direct accessor call ... is visible" / "no gp_rule_mark_told
		 * call ... is visible"), pinned in
		 * check-context-budget-session-cap.test.ts. */
		const bound = counts.has(id);
		const isMarked = marked.has(id);
		/* `!resolves` keeps the "meant to splice it, forgot the accessor
		 * call" fault reported, its fragment being live and never emitted.
		 *
		 * `spliced` reads the EFFECTIVE source (mantahostels#2488), so a guard whose
		 * only fetch sits in a sourced lib splices what that lib fetches and
		 * its mantahostels#2283 typo is reported. THE RESIDUAL IS NARROWER, not
		 * gone: a lib fetching under an id passed as an ARGUMENT splices
		 * nothing this can see, and that guard's typo still reads as
		 * self-composed. Closing that needs the latch to DECLARE what it
		 * bounds, priced and declined at mantahostels#2446.
		 *
		 * The narrower gap mantahostels#2470 accepted in taking this signal: a guard that
		 * latches every id it splices and separately mistypes a latch for a
		 * fragment it never fetches has no orphan splice, so that typo reads
		 * as self-composed. */
		const selfBounding = !orphanSplice && !resolves && !bound;
		/* Both limbs read as PASSING on a self-bounding latch rather than
		 * being dropped from the object: the fault's consumer composes its
		 * message limb by limb, so a false here would send the reader after
		 * a fragment and an accessor the guard is right not to have. */
		const resolvesLimb = selfBounding || resolves;
		const boundLimb = selfBounding || bound;
		if (!resolvesLimb || !boundLimb || !isMarked)
			latchFaults.push({
				id,
				resolves: resolvesLimb,
				bound: boundLimb,
				marked: isMarked,
			});
	}
	return latchFaults;
}

/**
 * @param {string} rel
 * @param {Record<string, string> | undefined} sources
 * @param {string} root
 * @param {number} cap
 * @returns {GuardReach}
 */
function guardReach(rel, sources, root, cap) {
	const { own, effective } = guardSources(rel, sources, root);
	const calls = liveRuleCalls(rel, effective, root);
	const reached = reachedIds(rel, calls, cap);
	const counts = directRuleCounts(effective);
	const latched = new Set(latchedRuleIds(effective));
	const marked = new Set(markedRuleIds(effective));
	const direct = directCensus(counts, latched, marked, own);
	const latchFaults = guardLatchFaults(counts, latched, marked, calls);
	return { ...reached, calls: calls.length, direct, latchFaults };
}

/**
 * Every tool any matcher names, so a group with no emitter still reports.
 *
 * @param {Registration[]} registrations
 * @returns {Set<string>}
 */
function matcherTools(registrations) {
	/** @type {Set<string>} */
	const tools = new Set();
	for (const { matcher } of registrations)
		for (const token of (matcher ?? "").split("|"))
			if (TOOL_NAME_RE.test(token)) tools.add(token);
	return tools;
}

/**
 * One tool's figure: the union of the ids its wired guards reach, and each
 * contributing guard, biggest first.
 *
 * @param {string} tool
 * @param {Registration[]} registrations
 * @param {Map<string, GuardReach>} byGuard
 * @returns {{ bytes: number, ids: string[], guards: GuardFigure[] }}
 */
function toolFigure(tool, registrations, byGuard) {
	/** @type {GuardFigure[]} */
	const guards = [];
	/* A guard wired twice on one tool is read once. */
	const seen = new Set();
	/** @type {Map<string, number>} */
	const union = new Map();
	for (const { matcher, commandLine } of registrations) {
		if (!matcherCovers(matcher, tool)) continue;
		for (const m of commandLine.matchAll(WIRED_SCRIPT_RE)) {
			const rel = requiredGroup(m, 1, WIRED_SCRIPT_RE);
			const g = byGuard.get(rel);
			if (!g || g.ids.length === 0 || seen.has(rel)) continue;
			seen.add(rel);
			for (const [id, n] of g.bytes) union.set(id, n);
			guards.push({
				file: rel,
				bytes: sum(g.bytes.values()),
				calls: g.calls,
				ids: g.ids,
			});
		}
	}
	guards.sort((a, b) => b.bytes - a.bytes || a.file.localeCompare(b.file));
	return { bytes: sum(union.values()), ids: [...union.keys()], guards };
}

/**
 * One entry per over-cap id, not per (guard, id) pair: two guards reaching
 * the same over-cap fragment are the same repo fault, so the caller reports
 * it once, naming every guard that reaches it.
 *
 * @param {Map<string, GuardReach>} byGuard
 * @returns {{ id: string, bytes: number, guards: string[] }[]}
 */
function overCapRows(byGuard) {
	/** @type {Map<string, { bytes: number, guards: string[] }>} */
	const overCapById = new Map();
	for (const [rel, g] of byGuard)
		for (const o of g.overCap) {
			const entry = overCapById.get(o.id);
			if (entry) entry.guards.push(rel);
			else overCapById.set(o.id, { bytes: o.bytes, guards: [rel] });
		}
	/* Sorted, not insertion order: guards is founder-facing text, and insertion
	 * order is an accident of registration order in the hooks file. */
	return [...overCapById.entries()].map(([id, v]) => ({
		id,
		bytes: v.bytes,
		guards: v.guards.slice().sort(),
	}));
}

/**
 * One entry per (guard, id), not per id: `bound` is a property of the guard's
 * own source, so two guards latching the same stranded id are two dead bounds
 * to repair and not one.
 *
 * @param {Map<string, GuardReach>} byGuard
 * @returns {(LatchFault & { guard: string })[]}
 */
function latchFaultRows(byGuard) {
	return [...byGuard]
		.flatMap(([rel, g]) => g.latchFaults.map((f) => ({ ...f, guard: rel })))
		.sort((a, b) => a.id.localeCompare(b.id) || a.guard.localeCompare(b.guard));
}

/**
 * The direct-call census (mantahostels#2055).
 *
 * NOTHING IS DROPPED: a direct call does not consult gp_rule's latch, so it
 * is paid again every time its guard fires. That is true of an id gp_rule
 * ALSO reaches — the figures carry its once-a-session pre-emission, never
 * its repeats — so such an id is flagged `counted` rather than omitted, and
 * a reader adding this census to the tool and ratchet figures does not double
 * it.
 *
 * A CALLER MAY BOUND ITS OWN REPEAT, through gp_rule_told's separate latch
 * (mantahostels#2275), and `latched` says which do. That changes no figure here: the
 * bytes are still route (e) and still uncapped.
 *
 * @param {Map<string, GuardReach>} byGuard
 * @param {Map<string, number>} acrossGuards the ratchet's union
 * @returns {{ id: string, bytes: number | null, guards: string[], counted: boolean, latched: LatchState }[]}
 */
function directRows(byGuard, acrossGuards) {
	/** @type {Map<string, { bytes: number | null, guards: string[], latched: LatchState }>} */
	const directById = new Map();
	for (const [rel, g] of byGuard)
		for (const [id, d] of g.direct) {
			const entry = directById.get(id);
			/* The weakest guard's reading decides the id. */
			if (entry) {
				entry.guards.push(rel);
				entry.latched = weakerLatch(entry.latched, d.latch);
			} else
				directById.set(id, {
					bytes: d.bytes,
					guards: [rel],
					latched: d.latch,
				});
		}
	return [...directById.entries()]
		.map(([id, v]) => ({
			id,
			bytes: v.bytes,
			guards: v.guards.slice().sort(),
			counted: acrossGuards.has(id),
			latched: v.latched,
		}))
		.sort(
			(a, b) => (b.bytes ?? 0) - (a.bytes ?? 0) || a.id.localeCompare(b.id),
		);
}

/**
 * What reachableByTool and reachableAfterCall read.
 *
 * @typedef {object} ReachOptions
 * @property {Settings} [settings] the hook wiring; defaults to the hooks
 *   `root` registers itself (lib/core-hooks.js's `ownHooks`).
 * @property {Record<string, string>} [sources] repo-relative guard path → its
 *   source text, for tests that must not read the tree. Where absent, each
 *   wired command's path is read from `root`.
 * @property {string} [root] repo root the sources are read from.
 * @property {string} [rulesDir] the fragment store, as WFC_RULES_DIR spells
 *   it. Set around the resolution and restored after, because rule-text.js
 *   reads that variable at call time by design.
 * @property {string} [rulesFallbackDir] the layer beneath it, as
 *   WFC_RULES_FALLBACK_DIR spells it (workflow-core#101). Set and restored with `rulesDir`,
 *   and cleared where omitted, so a test's throwaway store inherits nothing: an
 *   override implies no core layer (rule-text.js rulesDirs()). Ignored without
 *   `rulesDir`.
 * @property {string} [capFile] absolute path of the GP_RULE_CAP assignment.
 */

/**
 * The route (f) bytes a session can be made to pay through each PreToolUse
 * tool, and the same union taken across every wired guard at once.
 *
 * @param {ReachOptions} [options]
 * @returns {{ cap: number, tools: Record<string, { bytes: number, ids: string[], guards: GuardFigure[] }>, ratchet: { bytes: number, ids: string[] }, overCap: { id: string, bytes: number, guards: string[] }[], direct: { id: string, bytes: number | null, guards: string[], counted: boolean, latched: LatchState }[], latchFaults: { id: string, guard: string, resolves: boolean, bound: boolean, marked: boolean }[], fragmentBytes: Record<string, number> }}
 *   Every tool any PreToolUse matcher names gets an entry, at zero where its
 *   group emits nothing. `overCap` names every fragment a wired guard
 *   reaches that gp_rule can never emit (mantahostels#2054), one entry per id naming every
 *   guard that reaches it. `direct` is the census of every id a wired guard
 *   reaches through a direct `rule_text` call (mantahostels#2055): route (e) delivery, so
 *   no figure above prices it. `counted` marks an id the figures DO carry by
 *   the pre-emptive route, whose direct repeats they still do not. `latched`
 *   reads `bounded` where every direct caller bounds its own repeat through
 *   `gp_rule_told` (mantahostels#2275) AND that bound correlates with the call it covers,
 *   `ambiguous` where a caller's cannot be correlated, `none` otherwise
 *   (mantahostels#2283). `bytes` is null on an id the store cannot answer for, which a direct call
 *   survives. `latchFaults` names every `gp_rule_told` bounding nothing —
 *   `resolves: false` for an id no fragment answers to, `bound: false` for one
 *   its own guard makes no visible direct call on, `marked: false` for one its
 *   own guard makes no visible `gp_rule_mark_told` call on, so the bound never
 *   comes true — and over WIRED guards only, so a dead latch in an unwired
 *   script is invisible. A guard reaching the store by neither route composes
 *   its own text and is judged on the `marked` limb alone (mantahostels#2446).
 *   `fragmentBytes` is every reachable id's bytes
 *   by either route, over cap or not (mantahostels#2260).
 * @throws {RuleEmissionError} on an unreadable cap source or a malformed
 *   settings shape; and it lets rule-text's own throw escape, so a gp_rule call
 *   naming an id with no fragment surfaces there rather than counting as zero.
 */
function reachableByTool(options = {}) {
	const root = options.root ?? hostRoot();
	const settings = settingsOf(options, root);
	const cap = gpRuleCap(options.capFile);
	const registrations = registrationsOn(settings, EVENT);
	const tools = matcherTools(registrations);
	const byGuard = guardReaches(registrations, options, root, cap);

	/** @type {Record<string, { bytes: number, ids: string[], guards: GuardFigure[] }>} */
	const out = {};
	/* The ratchet's union, taken over EVERY WIRED GUARD rather than over the
	 * tools walked below: a match-all matcher (`""` or absent) names no tool and
	 * so opens no group, and accumulating inside that loop would report its
	 * guards' bytes as zero. */
	/** @type {Map<string, number>} */
	const acrossGuards = new Map();
	for (const g of byGuard.values())
		for (const [id, n] of g.bytes) acrossGuards.set(id, n);
	for (const tool of [...tools].sort())
		out[tool] = toolFigure(tool, registrations, byGuard);

	const overCap = overCapRows(byGuard);
	const direct = directRows(byGuard, acrossGuards);

	/* Every id a wired guard reaches, and its bytes, over cap or not (mantahostels#2260).
	 *
	 * THE TWO gp_rule SETS ARE DISJOINT BY CONSTRUCTION, not merged here:
	 * guardIds() puts an over-cap id in `overCap` and excludes it from `bytes`,
	 * so neither loop below can overwrite the other's entry.
	 *
	 * THE DIRECT CENSUS IS SEEDED FIRST and so never overwrites a gp_rule
	 * figure, which is the one the caps are taken against. It is included at
	 * all because an id can move BETWEEN the routes. */
	/** @type {Record<string, number>} */
	const fragmentBytes = {};
	for (const d of direct) if (d.bytes !== null) fragmentBytes[d.id] = d.bytes;
	for (const [id, n] of acrossGuards) fragmentBytes[id] = n;
	for (const o of overCap) fragmentBytes[o.id] = o.bytes;

	return {
		cap,
		tools: out,
		direct,
		latchFaults: latchFaultRows(byGuard),
		ratchet: {
			bytes: sum(acrossGuards.values()),
			ids: [...acrossGuards.keys()],
		},
		overCap,
		fragmentBytes,
	};
}

/**
 * @param {ReachOptions} options
 * @param {string} root
 * @returns {Settings}
 */
function settingsOf(options, root) {
	return options.settings ?? { hooks: ownHooks(root) ?? {} };
}

/**
 * What each guard `registrations` wire reaches, read once per guard: its
 * reachable set is the same wherever it is wired.
 *
 * @param {Registration[]} registrations
 * @param {ReachOptions} options
 * @param {string} root
 * @param {number} cap
 * @returns {Map<string, GuardReach>}
 */
function guardReaches(registrations, options, root, cap) {
	const { sources, rulesDir, rulesFallbackDir } = options;
	/** @type {Map<string, GuardReach>} */
	const byGuard = new Map();
	withRuleStore(rulesDir, rulesFallbackDir, () => {
		for (const { commandLine } of registrations)
			for (const m of commandLine.matchAll(WIRED_SCRIPT_RE)) {
				const rel = requiredGroup(m, 1, WIRED_SCRIPT_RE);
				if (!byGuard.has(rel))
					byGuard.set(rel, guardReach(rel, sources, root, cap));
			}
	});
	return byGuard;
}

/**
 * One guard's ids split by what a latch bounds: id → bytes paid once a
 * session, and the direct calls paid on every firing.
 *
 * @param {GuardReach} g
 * @returns {{ once: Map<string, number>, perFire: { id: string, bytes: number | null }[] }}
 */
function afterSplit(g) {
	const once = new Map(g.bytes);
	/** @type {{ id: string, bytes: number | null }[]} */
	const perFire = [];
	for (const [id, d] of g.direct)
		if (d.latch === "bounded" && d.bytes !== null) once.set(id, d.bytes);
		else perFire.push({ id, bytes: d.bytes });
	return { once, perFire };
}

/** One hook on an AFTER_EVENTS event, as reachableAfterCall reports it.
 * @typedef {{ event: string, matcher: string | undefined, file: string, once: { bytes: number, ids: string[] }, perFire: { id: string, bytes: number | null }[] }} AfterHook */

/**
 * The rule text each hook on AFTER_EVENTS can hand a session (workflow-core#2144), priced
 * as reachableByTool prices a PreToolUse guard: an id is paid once a session
 * where a latch bounds it — gp_rule's own, or a direct call's `bounded`
 * gp_rule_told — and the session figure is the union of those ids.
 *
 * AN UNBOUNDED DIRECT CALL IS PAID EVERY TIME ITS HOOK FIRES, so it goes in
 * `perFire` and on no session figure; `ambiguous` counts as unbounded, the
 * safe direction. A `?` id the store cannot answer for is listed with null
 * bytes.
 *
 * KEYED ON THE HOOK, NOT THE TOOL: a guard wired on two events is two rows,
 * and the union counts its ids once. Each row lists every id its guard
 * reaches, whatever event branch the guard takes them on — the safe
 * direction. It is not unioned with the PreToolUse ratchet: gp_rule_told's
 * latch is not gp_rule's, so an id both routes reach is paid by each.
 *
 * `overCap` and `latchFaults` are reachableByTool's, over these guards.
 *
 * @param {ReachOptions} [options] as reachableByTool's
 * @returns {{ cap: number, hooks: AfterHook[], once: { bytes: number, ids: string[] }, overCap: { id: string, bytes: number, guards: string[] }[], latchFaults: (LatchFault & { guard: string })[] }}
 */
function reachableAfterCall(options = {}) {
	const root = options.root ?? hostRoot();
	const settings = settingsOf(options, root);
	const wired = AFTER_EVENTS.flatMap((event) =>
		registrationsOn(settings, event).map((r) => ({ ...r, event })),
	);
	/* Nothing wired reads no GP_RULE_CAP: a host need not ship guard-parse.sh
	 * to have no hooks. */
	if (wired.length === 0)
		return {
			cap: 0,
			hooks: [],
			once: { bytes: 0, ids: [] },
			overCap: [],
			latchFaults: [],
		};
	const cap = gpRuleCap(options.capFile);
	const byGuard = guardReaches(wired, options, root, cap);
	/** @type {AfterHook[]} */
	const hooks = [];
	/** @type {Map<string, number>} */
	const union = new Map();
	for (const { event, matcher, commandLine } of wired)
		for (const m of commandLine.matchAll(WIRED_SCRIPT_RE)) {
			const file = requiredGroup(m, 1, WIRED_SCRIPT_RE);
			const g = byGuard.get(file);
			if (!g)
				throw new Error(
					`rule-emission: ${file} is wired but guardReaches read no figure for it`,
				);
			const { once, perFire } = afterSplit(g);
			if (once.size === 0 && perFire.length === 0) continue;
			for (const [id, n] of once) union.set(id, n);
			hooks.push({
				event,
				matcher,
				file,
				once: { bytes: sum(once.values()), ids: [...once.keys()] },
				perFire,
			});
		}
	return {
		cap,
		hooks,
		once: { bytes: sum(union.values()), ids: [...union.keys()] },
		overCap: overCapRows(byGuard),
		latchFaults: latchFaultRows(byGuard),
	};
}

module.exports = {
	AFTER_EVENTS,
	CAP_SOURCE,
	EVENT,
	registrationsOn,
	DIRECT_RULE_RE,
	MARKED_RULE_RE,
	EMIT_RULE_RE,
	RULE_ARG_RE,
	WIRED_SCRIPT_RE,
	directRuleCounts,
	ruleArgs,
	gpRuleCap,
	hookCommandLine,
	sourcedClosure,
	reachableAfterCall,
	reachableByTool,
};
