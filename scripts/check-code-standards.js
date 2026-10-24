#!/usr/bin/env node
/*
 * check-code-standards.js — every citation in docs/code-standards.md, and in
 * docs/code-standards-base.md where it is written, still resolves, so a
 * reviewer never cites a rule against the wrong lines; and no §N7 export block
 * offers a name nothing consumes (mantahostels#1799), or only tests consume
 * (#1361); and `pythonRoutes` in .claude/workflow-core.json routes Python as
 * the local file's route table does, which wins (#1863, lib/python-routes.js).
 *
 * Usage:
 *   node scripts/check-code-standards.js [--warn] [--json] [--touching <rev>] [<doc>]
 *   node scripts/check-code-standards.js --review [<doc>] [<pin>…]
 *     re-anchor the bare pins named (`scripts/lib/check.js:50-56`, or a bare
 *     path to take every pin into that file) after re-reading them; with no
 *     pin, re-anchors every bare pin the document carries and drops entries
 *     for pins it no longer carries. <doc> defaults to the local file. Reports
 *     in prose, never JSON, and checks nothing.
 *
 * THE BASE IS READ ONLY WHERE IT IS WRITTEN (#963). Where
 * docs/code-standards-base.md sits in this repo — the core — a run with no
 * <doc> reads it beside the local file, so the export scan reports once. Each
 * document keeps its own anchors file, and --review rewrites only its own. A
 * base line pin the release refuses — one naming no file, or a file it leaves
 * behind — is UNSHIPPED (#961, #1259), and here it warns like every other
 * finding.
 *
 * --touching <rev> IS A SCOPE FILTER, DELIBERATELY NOT lib/check.js's --against
 * (mantahostels#2631). That framework flag is reserved repo-wide for fault-diffing
 * (check-website-copy.js, check-guard-registry.js): run the whole checker
 * twice, at <rev> and at the index, and report the set difference — "did this
 * commit newly break something". runCheck intercepts --against itself before
 * a spec's run() ever sees it (lib/check.js runCheck's `ctx.has(AGAINST)`
 * branch) and demands an AgainstSpec (runAgainst's `!against` refusal), so a
 * checker cannot repurpose the name for a different question. And
 * fault-diffing is the wrong question here regardless: a rule's PROSE can
 * change on a line that cites a file the diff never touches, and the backlog
 * citation sitting on that line was already stale before this commit —
 * set-diffing two identical finding-sets would keep suppressing it forever.
 * So this instead runs the checker once, against the working tree, and
 * FILTERS its findings to the two things mantahostels#2631 named: a finding whose cited
 * file <rev>..working touched, or a finding sitting on a document line
 * <rev>..working touched. A pre-existing backlog entry outside
 * both is silent; touch either side and it resurfaces.
 *
 * THE PROBLEM (mantahostels#1091). The standards documents are derived
 * from the corpus: every rule pins a real file and usually quotes it. The
 * offsets rot while the quotations stay verbatim.
 *
 * REPORT-ONLY, DELIBERATELY. Findings are WARN and this never gates (mantahostels#1091). A
 * stale pin is a documentation defect discovered by whoever edited the cited
 * file, who is not the person who can judge whether the rule still holds; and
 * there is no --fix, because no generator in this repo writes into a
 * source-of-truth prose document. BROKEN is reserved for this script's own
 * apparatus failing: git unable to enumerate the tracked set.
 *
 * THE TWO HALVES OF THE CITATION SURFACE.
 *
 *   QUOTATION-PAIRED PIN — a pin sharing its line with an italic quotation
 *   (*"…"*). Directly checkable: does the quoted text still sit inside the
 *   cited range? If not, where in the file is it now? A quotation that appears
 *   NOWHERE in the file is reported distinctly (ABSENT), because that is a
 *   fabricated or deleted quotation and not an offset slip.
 *
 *   BARE PIN — no quoted text, pointing at a region rather than a sentence
 *   (`scripts/lib/check.js:8-13`, the five-outcome alphabet table). Nothing to
 *   string-match, so each is anchored by a digest of EXACTLY THE CITED LINES,
 *   held in scripts/code-standards-anchors.json, and a change WARNs.
 *
 * WHY A HUNK DIGEST AND NOT A WHOLE-FILE ONE. mantahostels#1091 rejected whole-file
 * anchoring in check-guard-registry.js's mould: it fires when any cited file
 * changes at all. A hunk digest fires only when the cited lines themselves move
 * or change, which is precisely the event that invalidates the pin. The cost is
 * that a pin is re-anchored by hand — one line in an uncontended file, outside
 * guard-file-claim.sh's scope and outside doc-map §A's, exactly as
 * guard-registry-anchors.json is.
 *
 * TWO ROT MODES THIS CANNOT SEE: a rule acquiring a COUNTEREXAMPLE (a new
 * file arriving that breaks a rule), and TOOLING CATCHING UP (a Biome bump
 * making a rule restate what a tool now enforces).
 * Both need a reader, not a digest.
 */

const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { runCheck, errMessage, baselineOf } = require("./lib/check");
const { requiredGroup } = require("./lib/regex-group");
const { isTestKind } = require("./lib/test-kind");
const { pythonRouteDrift } = require("./lib/python-routes.js");
const { CONFIG_PATH, readConfig } = require("./lib/workflow-core-config.js");
const { CHILD_MAX_BUFFER } = require("./lib/child-buffer.js");
const { parseNewSide } = require("./lib/hunk-header.js");
const {
	BASE_LINE_PIN_REMEDY,
	LINE_PIN_RE,
	baseLinePinFault,
	parseLinePins,
} = require("./lib/standards-pins");
/** @typedef {import("./lib/standards-pins").LinePin} LinePin */

/* Relative to the working directory, never to __dirname: it is what lets this
 * be exercised inside a throwaway repository rather than against this one
 * (§X3). */
const ROOT = process.cwd();
const DOC = "docs/code-standards.md";
const ANCHORS = "scripts/code-standards-anchors.json";
const BASE_DOC = "docs/code-standards-base.md";
const BASE_ANCHORS = "scripts/code-standards-base-anchors.json";
/** @param {string} doc */
const anchorsOf = (doc) => (doc === BASE_DOC ? BASE_ANCHORS : ANCHORS);
/**
 * The command that re-anchors `key` in `doc`.
 *
 * @param {string} doc
 * @param {string} [key]
 */
const reviewCommand = (doc, key) =>
	["node scripts/check-code-standards.js --review", doc === DOC ? "" : doc, key]
		.filter(Boolean)
		.join(" ");

/**
 * Every quote character folded to one.
 *
 * A quotation is delimited by double quotes, so source text that itself
 * contains them cannot be transcribed verbatim — *"… passing for 'no names
 * found'"* quotes a line reading `"no names found"`. That substitution is
 * forced by the notation, not a misquotation, so neither side may see it.
 *
 * @param {string} s
 */
const foldQuotes = (s) => s.replace(/[\u2018\u2019\u201c\u201d'"]/g, '"');

/**
 * Comment furniture removed and whitespace collapsed, so a quotation matches a
 * comment however it happens to be wrapped. `/*`, ` * `, `//` and a leading `#`
 * are stripped at the head of the line only — mid-line they are content.
 *
 * @param {string} line
 */
const normalise = (line) =>
	foldQuotes(line)
		.replace(/^\s*(?:\/\*+|\*+\/?|\/\/+|#+)\s?/, "")
		.replace(/\s+/g, " ")
		.trim();

/**
 * The lines from `from` to `to` as one searchable string, with the map back to
 * line numbers.
 *
 * @param {string[]} lines
 * @param {number} from 1-based, inclusive
 * @param {number} to   1-based, inclusive
 */
function haystack(lines, from, to) {
	let text = "";
	/** @type {{at: number, line: number}[]} */
	const marks = [];
	const start = Math.max(1, from);
	for (const [k, line] of lines.slice(start - 1, to).entries()) {
		const n = start + k;
		const piece = normalise(line);
		if (!piece) continue;
		if (text) text += " ";
		marks.push({ at: text.length, line: n });
		text += piece;
	}
	return { text, marks };
}

/**
 * The line an offset into a haystack came from.
 *
 * @param {{at: number, line: number}[]} marks
 * @param {number} offset
 */
function lineAt(marks, offset) {
	const [first] = marks;
	let line = first === undefined ? 0 : first.line;
	for (const m of marks) if (m.at <= offset) line = m.line;
	return line;
}

/**
 * A quotation as the fragments that must appear, in order.
 *
 * AN ELLIPSIS IS A JOIN, NOT A CHARACTER. Several quotations elide — *"the
 * widest query any checker makes … was 26.67 MB across 2,456 issues"* — so a
 * verbatim match would report every one of them as fabricated.
 *
 * A TRAILING FULL STOP IS DROPPED from the last fragment. A quotation cut short
 * closes with a full stop the source does not carry there (*"… exercised
 * in-process."*, where the source runs on to `against ./fake-llm-port`), and
 * that is ordinary prose rather than a misquotation.
 *
 * @param {string} quote
 * @returns {string[]}
 */
function fragmentsOf(quote) {
	const parts = foldQuotes(quote)
		.split(/…|\.\.\./)
		.map((p) => p.replace(/\s+/g, " ").trim())
		.filter(Boolean);
	const last = parts.pop();
	if (last !== undefined) parts.push(last.replace(/\.$/, ""));
	return parts.filter(Boolean);
}

/**
 * Where a quotation starts in a haystack, or -1.
 *
 * @param {string} text
 * @param {string[]} parts
 * @returns {number}
 */
function findFragments(text, parts) {
	const [head, ...rest] = parts;
	if (head === undefined) return -1;
	const first = text.indexOf(head);
	if (first === -1) return -1;
	let at = first + head.length;
	for (const part of rest) {
		const next = text.indexOf(part, at);
		if (next === -1) return -1;
		at = next + part.length;
	}
	return first;
}

/**
 * The longest leading run of the quotation's words that the file does carry.
 *
 * A quotation that matches for two lines and then diverges is a MISQUOTATION,
 * and saying where it parts company is the whole of the fix. Reported apart
 * from a quotation matching nothing at all, which is fabricated or deleted.
 *
 * @param {string} text
 * @param {string[]} parts
 * @returns {{words: number, at: number, prefix: string} | null}
 */
function longestPrefix(text, parts) {
	/* A quotation can fold away to nothing — *"."* loses its only fragment to
	 * fragmentsOf's trailing-full-stop strip — and there is then no prefix to
	 * report, which is what null already means here. Without it the checker
	 * dies with BROKEN on the document it is reporting on (mantahostels#1064). */
	const first = parts[0];
	if (first === undefined) return null;
	const words = first.split(" ");
	let best = null;
	for (let n = 1; n <= words.length; n++) {
		const probe = words.slice(0, n).join(" ");
		const at = text.indexOf(probe);
		if (at === -1) break;
		best = { words: n, at, prefix: probe };
	}
	return best;
}

/**
 * @param {string[]} lines
 * @param {number} from
 * @param {number} to
 */
function hunkDigest(lines, from, to) {
	const slice = lines.slice(from - 1, to).join("\n");
	return crypto.createHash("sha256").update(slice).digest("hex").slice(0, 16);
}

/**
 * The canonical anchor key: how the document spells the pin, path resolved.
 *
 * @param {string} rel
 * @param {number} from
 * @param {number} to
 */
const keyOf = (rel, from, to) =>
	from === to ? `${rel}:${from}` : `${rel}:${from}-${to}`;

/**
 * @param {string} file
 * @returns {Record<string, string>}
 */
function loadAnchors(file) {
	try {
		const raw = JSON.parse(fs.readFileSync(path.join(ROOT, file), "utf8"));
		/* Tolerate anything non-object rather than crashing the whole check. */
		return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
	} catch {
		return {};
	}
}

/**
 * @param {string} file
 * @param {Record<string, string>} anchors
 */
function saveAnchors(file, anchors) {
	const sorted = Object.fromEntries(
		Object.keys(anchors)
			.sort()
			.map((k) => [k, anchors[k]]),
	);
	fs.mkdirSync(path.dirname(path.join(ROOT, file)), { recursive: true });
	fs.writeFileSync(
		path.join(ROOT, file),
		`${JSON.stringify(sorted, null, "\t")}\n`,
	);
}

/**
 * The paths <rev>..working-tree touched, repo-relative. git failing here is
 * APPARATUS (an unresolvable rev, most often), so it is BROKEN — the same
 * rule trackedFiles below applies.
 *
 * @param {string} rev
 * @param {(m: string) => never} broken
 * @returns {Set<string>}
 */
function changedFiles(rev, broken) {
	let out = "";
	try {
		out = execFileSync("git", ["diff", "--name-only", rev], {
			cwd: ROOT,
			encoding: "utf8",
			maxBuffer: CHILD_MAX_BUFFER,
		});
	} catch (e) {
		broken(`git diff --name-only ${rev} failed: ${errMessage(e)}`);
	}
	return new Set(out.split("\n").filter(Boolean));
}

/**
 * The 1-based line numbers <rev>..working-tree touched in `rel`, on the
 * NEW (working-tree) side. `-U0` carries no context, so this is exactly the
 * added lines — a pure deletion (0 new lines) contributes nothing: there is
 * no new-side line left to attribute a citation to.
 *
 * @param {string} rev
 * @param {string} rel
 * @param {(m: string) => never} broken
 * @returns {Set<number>}
 */
function changedLines(rev, rel, broken) {
	let out = "";
	try {
		out = execFileSync("git", ["diff", "-U0", rev, "--", rel], {
			cwd: ROOT,
			encoding: "utf8",
			maxBuffer: CHILD_MAX_BUFFER,
		});
	} catch (e) {
		broken(`git diff -U0 ${rev} -- ${rel} failed: ${errMessage(e)}`);
	}
	/** @type {Set<number>} */
	const lines = new Set();
	for (const line of out.split("\n")) {
		const hunk = parseNewSide(line);
		if (hunk === null) continue;
		for (let n = hunk.start; n < hunk.start + hunk.count; n++) lines.add(n);
	}
	return lines;
}

/**
 * The tracked set, by full path and by basename.
 *
 * git failing here is APPARATUS, not subject: it is what this reads the repo
 * with, so it is BROKEN and gates, per check.js:16-26.
 *
 * @param {(m: string) => never} broken
 */
function trackedFiles(broken) {
	let out = "";
	try {
		out = execFileSync("git", ["ls-files"], {
			cwd: ROOT,
			encoding: "utf8",
			maxBuffer: CHILD_MAX_BUFFER,
		});
	} catch (e) {
		broken(
			`git ls-files failed, so the tracked set cannot be read: ${errMessage(e)}`,
		);
	}
	const paths = out.split("\n").filter(Boolean);
	/** @type {Map<string, string[]>} */
	const byBase = new Map();
	for (const p of paths) {
		const base = p.slice(p.lastIndexOf("/") + 1);
		byBase.set(base, [...(byBase.get(base) ?? []), p]);
	}
	return { set: new Set(paths), byBase };
}

/**
 * A cited path resolved to a repo path.
 *
 * The document cites by BASENAME wherever the section has already named the
 * directory (`strip.ts:23-25`, `check.js:50-56`), so a basename is resolved
 * against the tracked set and an ambiguous one is reported rather than guessed,
 * since a wrong guess would accuse a file the rule never cited.
 *
 * @param {string} rawPath
 * @param {{set: Set<string>, byBase: Map<string, string[]>}} tracked
 * @returns {{rel: string} | {fault: string, detail: string}}
 */
function resolveCited(rawPath, tracked) {
	if (!rawPath)
		return {
			fault: "UNRESOLVED",
			detail: "a bare pin with no path named earlier on its line",
		};
	if (rawPath.includes("/")) {
		if (tracked.set.has(rawPath)) return { rel: rawPath };
		return {
			fault: "MISSING-PATH",
			detail: `${rawPath} is not a tracked file`,
		};
	}
	const hits = tracked.byBase.get(rawPath) ?? [];
	const [only, ...others] = hits;
	if (only !== undefined && others.length === 0) return { rel: only };
	if (hits.length === 0)
		return {
			fault: "MISSING-PATH",
			detail: `no tracked file is named ${rawPath}`,
		};
	return {
		fault: "AMBIGUOUS-PATH",
		detail: `${hits.length} tracked files are named ${rawPath} (${hits.join(", ")}) — cite the full path`,
	};
}

/** @param {string} rel */
function readLines(rel) {
	try {
		return fs.readFileSync(path.join(ROOT, rel), "utf8").split("\n");
	} catch {
		return null;
	}
}

/** @param {string} rel */
function readText(rel) {
	try {
		return fs.readFileSync(path.join(ROOT, rel), "utf8");
	} catch {
		return null;
	}
}

/*
 * §N7's SECOND HALF, and §G6, scanned rather than cited (mantahostels#1799,
 * #1361): an export block offering names nothing takes, or only tests do.
 *
 * WARN, like every finding here.
 *
 * THE RESIDUAL IT CANNOT CLOSE: a real consumer that reaches the name through
 * a string. That one is deliberately silent.
 */

/**
 * The files §N7 governs: the `scripts/` executables and seams, plus the
 * skills' own scripts.
 */
const EXPORT_SCOPE =
	/^(?:scripts\/|\.claude\/skills\/[^/]+\/scripts\/)[\w./-]+\.js$/;
/**
 * The trailing `module.exports = { … }` §N7 fixes as the only form. Global, and
 * the LAST match is the one read: a file may quote the form in a header comment
 * (`pick-next.js:72`), and §N7 puts the real one at the end.
 */
const EXPORT_BLOCK = /\nmodule\.exports = \{([\s\S]*?)\};/g;
/** One entry in it: `name,` or the re-export form `name: other.thing,`. */
const EXPORT_ENTRY = /^\s*([A-Za-z_$][\w$]*)\s*(?::\s*[\w.$]+)?\s*,?$/;
/** A comment-shaped line — the exemption's whole test, its content unread. */
const COMMENT_LINE = /^\s*(?:\/\/|\*|\/\*)/;
/** Every identifier a file spells. */
const TOKEN_RE = /[A-Za-z_$][\w$]*/g;
/** A top-level binding, which is what makes a speller its own definer. */
const DEFINITION_RE =
	/^(?:const|let|var|function|class|async function)\s+([A-Za-z_$][\w$]*)/gm;
/**
 * A property read. It is what rescues the file that takes an export and
 * rebinds it under the same name — `pick-next.js`'s
 * `const DOC_MAP_HINT = writeSetPredict.DOC_MAP_HINT`, a definer by the line
 * above and a real consumer.
 */
const MEMBER_RE = /\.\s*([A-Za-z_$][\w$]*)/g;
/**
 * A path's last segment, and the `/` or quote opening it where one does —
 * `./thing` in a `require`, `scripts/thing.js` in a spawned command,
 * `"thing.js"` in a `path.join`. A segment a `/` follows is a directory, not a
 * module, so it is no match.
 */
const PATH_TAIL_RE = /([/"'`])?([\w-]+(?:\.[\w-]+)*)(?![\w/-])/g;
const SCRIPT_EXT = /\.[cm]?[jt]sx?$/;
/** The opening comment block, shebang and blank lines included — a file's header. */
const HEADER = /^(?:#![^\n]*\n)?(?:\s*(?:\/\*[\s\S]*?\*\/|\/\/[^\n]*))*/;
/**
 * A header line naming the unbuilt caller a module was built ahead of, and
 * that caller's ticket — `Unbuilt caller: app/reviews/page.tsx (#575)`. Its
 * exports are interface, not test-only (base §G6).
 * Detected by presence, like the comment escape.
 */
const UNBUILT_CALLER = /^\s*(?:\/\*+|\*|\/\/)\s*Unbuilt caller:.*#\d+/im;
/**
 * The harness whose generic `entry.exports?.main` read IS the run-in-process
 * consumption the entry-point exemption models, so it vouches for no `main`
 * (#1361) — nor does `require.main`, a program's own guard.
 */
const RUN_IN_PROCESS = "scripts/lib/run-in-process.js";
const REQUIRE_MAIN = /\brequire\.main\b/g;
/** Tracked bytes no identifier can be hiding in. */
const BINARY_EXT =
	/\.(?:png|jpe?g|gif|webp|avif|ico|pdf|woff2?|ttf|zip|gz|xlsx?|docx?|ods)$/i;

/**
 * @typedef {object} ExportBlock
 * @property {string} rel
 * @property {{name: string, exempt: boolean}[]} entries
 * @property {number} unparsed  entries no `EXPORT_ENTRY` shape fits
 */

/**
 * Every §N7 export block, with each entry's name and whether a comment exempts
 * it.
 *
 * A COMMENT DIRECTLY ABOVE THE ENTRY IS THE EXEMPTION, and the one-line form
 * takes a comment above the whole block instead — it has no per-entry line to
 * carry one, so without this every short block is inexemptible.
 *
 * @param {{set: Set<string>}} tracked
 * @returns {ExportBlock[]}
 */
function exportBlocks(tracked) {
	/** @type {ExportBlock[]} */
	const out = [];
	for (const rel of [...tracked.set].sort()) {
		/* A test-kind file's exports are meant for tests. */
		if (!EXPORT_SCOPE.test(rel) || isTestKind(rel)) continue;
		const text = readText(rel);
		if (text === null) continue;
		const block = exportBlockOf(rel, text);
		if (block) out.push(block);
	}
	return out;
}

/**
 * One file's last §N7 export block, or null where it has none.
 *
 * @param {string} rel
 * @param {string} text
 * @returns {ExportBlock | null}
 */
function exportBlockOf(rel, text) {
	const hasUnbuiltCaller = UNBUILT_CALLER.test(HEADER.exec(text)?.[0] ?? "");
	/* runInProcessAsync calls the exported `main` of a program carrying a
	 * `require.main` guard, and refuses one without (run-in-process.js), so
	 * that `main` is how the program is run, not a test-only export (#1361).
	 * Textual: `require.main` spelled anywhere, a comment included, counts. */
	const isEntryPoint = text.includes("require.main");
	let block = null;
	const exportBlock = new RegExp(EXPORT_BLOCK);
	for (let m = exportBlock.exec(text); m; m = exportBlock.exec(text)) block = m;
	if (!block) return null;

	const inner = requiredGroup(block, 1, EXPORT_BLOCK);
	const oneLine = !inner.includes("\n");
	const entries = oneLine
		? inner.split(",").map((s) => s.trim())
		: inner.split("\n");
	const before = text.slice(0, block.index).split("\n");
	const blockExempt =
		hasUnbuiltCaller || (oneLine && COMMENT_LINE.test(before.at(-1) ?? ""));

	const { named, unparsed } = blockEntries(entries, {
		blockExempt,
		isEntryPoint,
	});
	return { rel, entries: named, unparsed };
}

/**
 * Each entry's name and whether a comment exempts it, and how many entries no
 * `EXPORT_ENTRY` shape fits.
 *
 * @param {string[]} entries
 * @param {{blockExempt: boolean, isEntryPoint: boolean}} block
 */
function blockEntries(entries, { blockExempt, isEntryPoint }) {
	/** @type {{name: string, exempt: boolean}[]} */
	const named = [];
	let unparsed = 0;
	/** @type {string | undefined} */
	let previous;
	for (const entry of entries) {
		const above = previous;
		previous = entry;
		if (!entry.trim()) continue;
		const hit = EXPORT_ENTRY.exec(entry);
		if (!hit) {
			/* A spread, a call, an object literal — a shape §N7 does not describe. */
			if (!COMMENT_LINE.test(entry)) unparsed += 1;
			continue;
		}
		const name = requiredGroup(hit, 1, EXPORT_ENTRY);
		named.push({
			name,
			exempt:
				blockExempt ||
				(isEntryPoint && name === "main") ||
				(above !== undefined && COMMENT_LINE.test(above)),
		});
	}
	return { named, unparsed };
}

/**
 * For each exported name, and each module exporting it, the tracked files
 * that spell it WITHOUT defining it, bar a definer reading it off an object
 * (`MEMBER_RE`), and that reach that module — the consumers.
 *
 * ONE TOKENISATION PASS, NOT A SEARCH PER NAME (mantahostels#1799 holds the measurement).
 *
 * WHY A SPELLER MUST REACH THE MODULE (#1616). Spelling alone made every
 * common-word export — `review`, `record`, `shape` — consumed by any file
 * using the word, so it was never reported test-only (#1411). A file reaches a
 * module by naming its basename as a path's last segment (`modulesNamed`).
 * Two modules sharing a basename are reached together.
 *
 * WHY DEFINERS ARE SUBTRACTED. A file exporting `main` spells `main`, so a
 * plain speller-count has two consumer-less exporters of one name vouching for
 * each other permanently.
 *
 * DELIBERATELY TEXTUAL, and so biased towards silence. A name or path spelled
 * in a comment, a JSON value or a shell string counts, which is what keeps a
 * module reached only through a string (a dynamic `require`, a spawned
 * command) out of the findings.
 *
 * @param {Set<string>} paths
 * @param {ExportBlock[]} blocks
 * @returns {Map<string, Map<string, Set<string>>>} name → exporter → consumers
 */
function consumersOf(paths, blocks) {
	/** @type {Map<string, Map<string, Set<string>>>} */
	const consumers = new Map();
	for (const { rel, entries } of blocks)
		for (const { name } of entries) {
			const byExporter = consumers.get(name) ?? new Map();
			byExporter.set(rel, new Set());
			consumers.set(name, byExporter);
		}
	for (const rel of paths) {
		if (BINARY_EXT.test(rel)) continue;
		const text = readText(rel)?.replace(REQUIRE_MAIN, "require");
		if (text === undefined) continue;
		addConsumer(consumers, rel, text);
	}
	return consumers;
}

/**
 * Records `rel` against every exported name it spells without defining, for
 * each exporter of that name it reaches.
 *
 * @param {Map<string, Map<string, Set<string>>>} consumers accumulator: `rel`
 *   joins each reached exporter's set
 * @param {string} rel
 * @param {string} text
 */
function addConsumer(consumers, rel, text) {
	const defined = firstGroups(DEFINITION_RE, text);
	const read = firstGroups(MEMBER_RE, text);
	const reached = modulesNamed(text);
	for (const token of new Set(text.match(TOKEN_RE) ?? [])) {
		if (defined.has(token) && !read.has(token)) continue;
		if (token === "main" && rel === RUN_IN_PROCESS) continue;
		for (const [exporter, takers] of consumers.get(token) ?? [])
			if (reached.has(path.basename(exporter).replace(SCRIPT_EXT, "")))
				takers.add(rel);
	}
}

/**
 * The module basenames `text` names as a path's last segment: any segment
 * with a script extension, and a bare one only where a `/` or quote opens it,
 * so prose spelling the word `review` reaches no `review.js`.
 *
 * @param {string} text
 * @returns {Set<string>}
 */
function modulesNamed(text) {
	/** @type {Set<string>} */
	const out = new Set();
	const local = new RegExp(PATH_TAIL_RE);
	for (let m = local.exec(text); m; m = local.exec(text)) {
		const tail = requiredGroup(m, 2, PATH_TAIL_RE);
		if (SCRIPT_EXT.test(tail)) out.add(tail.replace(SCRIPT_EXT, ""));
		else if (m[1]) out.add(tail);
	}
	return out;
}

/**
 * Group 1 of every match of a global regex in `text`.
 *
 * @param {RegExp} re
 * @param {string} text
 * @returns {Set<string>}
 */
function firstGroups(re, text) {
	/** @type {Set<string>} */
	const out = new Set();
	const local = new RegExp(re);
	for (let m = local.exec(text); m; m = local.exec(text))
		out.add(requiredGroup(m, 1, re));
	return out;
}

/**
 * Every exported name no tracked file consumes, tests aside: a name only
 * test-kind files spell is reported like one nothing spells (#1361).
 *
 * @param {ExportBlock[]} blocks
 * @param {Map<string, Map<string, Set<string>>>} consumers
 */
function deadExports(blocks, consumers) {
	/** @type {Finding[]} */
	const findings = [];
	let names = 0;
	let unparsed = 0;
	let testOnly = 0;
	for (const { rel, entries, unparsed: skipped } of blocks) {
		unparsed += skipped;
		for (const { name, exempt } of entries) {
			names += 1;
			if (exempt) continue;
			/* `rel` itself only lands here on the re-export form (`a: b`), where the
			 * file spells the exported name without defining it. */
			const takers = [...(consumers.get(name)?.get(rel) ?? [])].filter(
				(f) => f !== rel,
			);
			const tests = takers.filter((f) => isTestKind(f));
			if (tests.length < takers.length) continue;
			if (tests.length > 0) testOnly += 1;
			findings.push({
				kind: "DEAD-EXPORT",
				docLine: 0,
				where: rel,
				rel,
				pin: name,
				detail: deadDetail(name, rel, tests),
			});
		}
	}
	return { findings, blocks: blocks.length, names, unparsed, testOnly };
}

/**
 * @param {string} name
 * @param {string} rel
 * @param {string[]} tests the test-kind files consuming it
 */
function deadDetail(name, rel, tests) {
	return tests.length > 0
		? `only tests consume ${name} — ${tests.join(", ")}. ` +
				"Test through the program or the exports its real callers use and drop the export (§G6); " +
				"a comment is no fix. A module built ahead of its caller names it on an `Unbuilt caller: <caller> (#N)` header line"
		: `no tracked file consumes ${name} — every file spelling it defines one of its own or never reaches ${rel}. ` +
				"Make it file-local (§N7), or keep it and write the caller that wants it in a comment directly above the entry";
}

/**
 * @typedef {object} Finding
 * @property {string} kind
 * @property {string} [doc] the document carrying the pin; absent on a DEAD-EXPORT
 * @property {number} docLine
 * @property {string} pin
 * @property {string} detail
 * @property {string} [where] where to go, for a finding that is not about a
 *   line in the document
 * @property {string} [rel] the cited file, where the pin resolved to one —
 *   what --touching scopes a finding by (mantahostels#2631)
 * @property {string[]} [scopedBy] files any change to which brings the finding
 *   into --touching scope wherever it sits: a ROUTE-DRIFT's two copies, since
 *   deleting a table row leaves no changed line to scope it by
 */

/**
 * Judge every pin in one document. Returns the findings and what the OK line
 * has to state.
 *
 * @param {string} doc
 * @param {LinePin[]} pins
 * @param {{set: Set<string>, byBase: Map<string, string[]>}} tracked
 * @param {((rel: string) => boolean) | null} shipped whether the release ships
 *   a path; null for a document whose line pins are not read at the plugin root
 */
function judge(doc, pins, tracked, shipped) {
	const anchorsFile = anchorsOf(doc);
	const anchors = loadAnchors(anchorsFile);
	/** @type {Judging} */
	const j = {
		doc,
		tracked,
		shipped,
		anchorsFile,
		anchors,
		findings: [],
		filesCited: new Set(),
		liveKeys: new Set(),
		quoted: 0,
		bare: 0,
	};
	for (const pin of pins) judgePin(j, pin);
	const { findings, filesCited, liveKeys } = j;

	for (const key of Object.keys(anchors).sort())
		if (!liveKeys.has(key))
			findings.push({
				kind: "ORPHAN-ANCHOR",
				doc,
				docLine: 0,
				pin: key,
				detail: `anchored in ${anchorsFile} but no bare pin in ${doc} cites it — drop it with: ${reviewCommand(doc)}`,
				/* key is keyOf's `rel:from` or `rel:from-to` — LINE_PIN_RE parses that same
				 * shape, so group 1 is the file back off the trailing range. */
				rel: LINE_PIN_RE.exec(key)?.[1],
			});

	return { findings, filesCited, quoted: j.quoted, bare: j.bare, liveKeys };
}

/**
 * One document's judging state: what every pin is judged against, and what
 * the pins judged so far have added.
 *
 * @typedef {object} Judging
 * @property {string} doc
 * @property {{set: Set<string>, byBase: Map<string, string[]>}} tracked
 * @property {((rel: string) => boolean) | null} shipped
 * @property {string} anchorsFile
 * @property {Record<string, string>} anchors
 * @property {Finding[]} findings
 * @property {Set<string>} filesCited
 * @property {Set<string>} liveKeys
 * @property {number} quoted
 * @property {number} bare
 */

/** @typedef {(kind: string, detail: string) => number} Push */

/**
 * Judge one pin: its path, its range, then its quotations or its anchor.
 *
 * @param {Judging} j accumulator: findings, filesCited, liveKeys, quoted and bare are filled; the rest is read
 * @param {LinePin} pin
 */
function judgePin(j, pin) {
	const at = `${j.doc}:${pin.line}`;
	const resolved = resolveCited(pin.rawPath, j.tracked);
	/** The pin's cited file, once resolved — undefined while the path itself is
	 * the fault (UNRESOLVED/MISSING-PATH/AMBIGUOUS-PATH have nothing to scope by).
	 * @type {string | undefined} */
	const citedRel = "rel" in resolved ? resolved.rel : undefined;
	/** @type {Push} */
	const push = (kind, detail) =>
		j.findings.push({
			kind,
			doc: j.doc,
			docLine: pin.line,
			pin: pin.raw,
			detail,
			rel: citedRel,
		});

	/* Judged before a path fault ends the pin, since the release refuses a
	 * pin naming no file too: the UNSHIPPED set is exactly what it refuses. */
	const unshipped = j.shipped && baseLinePinFault(ROOT, pin, j.shipped);
	if (unshipped)
		push(
			"UNSHIPPED",
			citedRel && citedRel !== pin.rawPath
				? `a base line pin is read at the plugin root, where the bare name ${pin.rawPath} opens nothing — cite ${citedRel} in full; the release refuses it as it stands (#961)`
				: `${unshipped}, so an adopter reading the base finds no evidence — ${BASE_LINE_PIN_REMEDY}; the release refuses it as it stands (#961)`,
		);

	if ("fault" in resolved) {
		push(resolved.fault, resolved.detail);
		return;
	}
	const rel = resolved.rel;
	j.filesCited.add(rel);

	const lines = readLines(rel);
	if (lines === null) {
		push("MISSING-PATH", `${rel} is tracked but cannot be read`);
		return;
	}
	if (pin.from > lines.length || pin.to > lines.length) {
		push(
			"OUT-OF-RANGE",
			`${rel} has ${lines.length} lines, so ${pin.raw} points past its end`,
		);
		return;
	}

	if (pin.quotes.length > 0) {
		j.quoted += pin.quotes.length;
		for (const quote of pin.quotes)
			judgeQuote(j.tracked, { pin, quote, rel, lines, at }, push);
		return;
	}

	j.bare += 1;
	const key = keyOf(rel, pin.from, pin.to);
	j.liveKeys.add(key);
	const now = hunkDigest(lines, pin.from, pin.to);
	const was = j.anchors[key];
	const { doc, anchorsFile } = j;
	if (!was)
		push(
			"UNANCHORED",
			`${key} has no entry in ${anchorsFile}, so nothing records that these lines were ever read against the rule — clear with: ${reviewCommand(doc, key)}`,
		);
	else if (was !== now)
		push(
			"MOVED",
			`the lines ${key} cites have changed since they were last read (anchored ${was}, now ${now}) — re-read them against the rule at ${at}, then: ${reviewCommand(doc, key)}`,
		);
}

/**
 * Judge one quotation of a pin: found where the line says, DRIFTED,
 * MISQUOTED or ABSENT.
 *
 * @param {{set: Set<string>, byBase: Map<string, string[]>}} tracked
 * @param {{pin: LinePin, quote: string, rel: string, lines: string[], at: string}} q
 * @param {Push} push
 */
function judgeQuote(tracked, { pin, quote, rel, lines, at }, push) {
	const parts = fragmentsOf(quote);
	const gist = quote.length > 60 ? `${quote.slice(0, 60)}…` : quote;

	/* Checked against EVERY pin on the document line, not just the one it
	 * pairs to. A sentence is often cited at two pins at once, and insisting
	 * on the paired pin would report a quotation that is demonstrably where
	 * the line says it is. Residual: a quotation cited at the wrong one of two
	 * pins passes. */
	if (isQuotedAtPin(pin, { rel, lines, parts, tracked })) return;

	const whole = haystack(lines, 1, lines.length);
	const elsewhere = findFragments(whole.text, parts);
	if (elsewhere !== -1) {
		push(
			"DRIFTED",
			`the quotation "${gist}" has moved to ${rel}:${lineAt(whole.marks, elsewhere)} — repin ${at}`,
		);
		return;
	}

	const prefix = longestPrefix(whole.text, parts);
	if (prefix && prefix.words >= 5) {
		const after = whole.text.slice(
			prefix.at + prefix.prefix.length,
			prefix.at + prefix.prefix.length + 70,
		);
		/* Matches, then parts company: the document quoted a sentence it
		 * then cut or paraphrased. The fix is in the DOCUMENT — quote it
		 * verbatim, or mark the cut with an ellipsis, which this reads. */
		push(
			"MISQUOTED",
			`the quotation "${gist}" matches ${rel}:${lineAt(whole.marks, prefix.at)} for ${prefix.words} word(s) and then diverges — the source reads "…${prefix.prefix.slice(-30)}${after}"`,
		);
		return;
	}
	/* Nowhere in the file at all: the quotation was fabricated, or the
	 * line it quoted is gone. Reported apart from a slipped offset
	 * because the fix is different — re-read the file, do not renumber. */
	push(
		"ABSENT",
		`the quotation "${gist}" appears nowhere in ${rel} — fabricated, or the line it quoted is gone`,
	);
}

/**
 * Whether a quotation sits inside the range of its pin or of any sibling pin
 * on the same document line.
 *
 * @param {LinePin} pin
 * @param {{rel: string, lines: string[], parts: ReturnType<typeof fragmentsOf>, tracked: {set: Set<string>, byBase: Map<string, string[]>}}} q
 * @returns {boolean}
 */
function isQuotedAtPin(pin, { rel, lines, parts, tracked }) {
	for (const sib of pin.siblings) {
		const target = sib === pin ? { rel } : resolveCited(sib.rawPath, tracked);
		if ("fault" in target) continue;
		const sibLines = sib === pin ? lines : readLines(target.rel);
		if (sibLines === null) continue;
		/* From the pin's first line to the end of the file, so a quotation
		 * running PAST its cited range still counts as being where the pin
		 * says it starts. */
		const tail = haystack(sibLines, sib.from, sibLines.length);
		const at = findFragments(tail.text, parts);
		if (at !== -1 && lineAt(tail.marks, at) <= sib.to) return true;
	}
	return false;
}

/**
 * Every bare pin whose path resolves, keyed as its anchor is.
 *
 * @param {LinePin[]} pins
 * @param {{set: Set<string>, byBase: Map<string, string[]>}} tracked
 */
function liveBarePins(pins, tracked) {
	/** @type {Map<string, {rel: string, from: number, to: number, docLine: number}>} */
	const live = new Map();
	for (const pin of pins) {
		if (pin.quotes.length > 0) continue; // verified verbatim; never anchored
		const resolved = resolveCited(pin.rawPath, tracked);
		if ("fault" in resolved) continue;
		live.set(keyOf(resolved.rel, pin.from, pin.to), {
			rel: resolved.rel,
			from: pin.from,
			to: pin.to,
			docLine: pin.line,
		});
	}
	return live;
}

/**
 * Whether a --review target names a pin key: the key itself, or a bare path
 * meaning every pin into that file.
 *
 * @param {string} target
 * @param {string} key
 * @returns {boolean}
 */
function isTargetOf(target, key) {
	return key === target || key.startsWith(`${target}:`);
}

/**
 * Re-anchor the bare pins named and end the process. A write command: it
 * reports no findings, so it has no outcome and never reaches the reporting
 * below — the §N4 exception check-guard-registry.js's --review already takes.
 *
 * @param {string} doc
 * @param {string[]} targets      pin keys, or bare paths meaning every pin into that file
 * @param {LinePin[]} pins
 * @param {{set: Set<string>, byBase: Map<string, string[]>}} tracked
 * @returns {never}
 */
function reanchor(doc, targets, pins, tracked) {
	const anchorsFile = anchorsOf(doc);
	const anchors = loadAnchors(anchorsFile);
	const live = liveBarePins(pins, tracked);

	const wanted =
		targets.length > 0
			? [...live.keys()].filter((k) => targets.some((t) => isTargetOf(t, k)))
			: [...live.keys()];

	/* A named target matching no live pin is the reviewer's typo, and silently
	 * anchoring nothing would read as success. */
	const unmatched = targets.filter(
		(t) => !wanted.some((k) => isTargetOf(t, k)),
	);

	const next = targets.length > 0 ? { ...anchors } : {};
	for (const key of wanted.sort()) {
		const spot = live.get(key);
		if (!spot) continue;
		const lines = readLines(spot.rel);
		if (lines === null) {
			console.log(`skipped ${key} — cannot read ${spot.rel}`);
			continue;
		}
		next[key] = hunkDigest(lines, spot.from, spot.to);
		console.log(
			`anchored ${key} @ ${next[key]}  (cited at ${doc}:${spot.docLine})`,
		);
	}

	if (targets.length === 0)
		for (const key of Object.keys(anchors).sort())
			if (!(key in next)) console.log(`dropped ${key} — no bare pin cites it`);

	saveAnchors(anchorsFile, next);
	for (const t of unmatched)
		console.log(`skipped ${t} — no bare pin matches it`);
	console.log(
		`\n${Object.keys(next).length} bare pin(s) anchored in ${anchorsFile}. ` +
			"Re-anchoring asserts the cited lines were re-read against the rule citing them.",
	);
	process.exit(0);
}

/**
 * @param {string | undefined} arg
 * @returns {boolean}
 */
function isDocumentArg(arg) {
	return arg !== undefined && [DOC, BASE_DOC].includes(arg);
}

/**
 * The documents to read: the one named — under --review `reviewDoc`, the
 * document its first argument named, else DOC — or the local document and,
 * where present, the base.
 *
 * @param {import("./lib/check").Ctx} ctx
 * @param {boolean} reviewing
 * @param {string | undefined} reviewDoc
 * @returns {string[]}
 */
function docsFor(ctx, reviewing, reviewDoc) {
	const named = reviewing ? (reviewDoc ?? DOC) : ctx.args[0];
	if (named) return [named];
	if (fs.existsSync(path.join(ROOT, BASE_DOC))) return [DOC, BASE_DOC];
	return [DOC];
}

/**
 * Each document's pins, and why each unreadable one could not be read.
 *
 * @param {string[]} docs
 */
function readDocs(docs) {
	/** @type {{doc: string, text: string, pins: LinePin[]}[]} */
	const read = [];
	/** @type {string[]} */
	const unread = [];
	for (const doc of docs) {
		try {
			const text = fs.readFileSync(path.join(ROOT, doc), "utf8");
			read.push({ doc, text, pins: parseLinePins(text) });
		} catch (e) {
			unread.push(`${doc} could not be read: ${errMessage(e)}`);
		}
	}
	return { read, unread };
}

/**
 * plugin-tree.js is left behind by the release, so it is required only
 * where the base is read — the core — never in an adopter (#963). The
 * release's surface closure reads requires lexically, lazy ones too, so
 * it would fault this edge if this checker joined helper-surface.json.
 * Failing to load it fails open (§N5): the release still refuses an
 * unshipped line pin, and a BROKEN here would gate every core commit.
 *
 * @param {import("./lib/check").Ctx} ctx
 * @returns {((rel: string) => boolean) | null}
 */
function loadShipped(ctx) {
	try {
		const { isShipped } = require("./lib/plugin-tree");
		return (/** @type {string} */ rel) => isShipped(ROOT, rel);
	} catch (e) {
		ctx.say(
			`  the release's shipped-path seam could not be loaded, so no base line pin was judged UNSHIPPED: ${errMessage(e)}\n`,
		);
		return null;
	}
}

/**
 * Each row on which the local file's route table and `pythonRoutes` disagree
 * about Python, and how many table rows reach it; nothing where the local
 * file was not asked for. An absent local file is an empty table, so every
 * `pythonRoutes` row is then one no table holds. A config that does not
 * parse fails open (§N5, #1863): readConfig's other readers report it, and
 * this checker never gates.
 *
 * @param {import("./lib/check").Ctx} ctx
 * @param {string[]} docs
 * @param {{doc: string, text: string}[]} read
 * @returns {{rows: number, findings: Finding[]}}
 */
function routeDrift(ctx, docs, read) {
	if (!docs.includes(DOC)) return { rows: 0, findings: [] };
	let declared;
	try {
		declared = readConfig({ root: ROOT, quiet: true }).pythonRoutes;
	} catch (e) {
		ctx.say(
			`  ${CONFIG_PATH} could not be read, so pythonRoutes went unchecked against the route table: ${errMessage(e)}\n`,
		);
		return { rows: 0, findings: [] };
	}
	const text = read.find((r) => r.doc === DOC)?.text ?? "";
	const { rows, drift } = pythonRouteDrift(text, declared);
	return {
		rows,
		findings: drift.map(({ line, glob, detail }) => ({
			kind: "ROUTE-DRIFT",
			doc: DOC,
			docLine: line,
			pin: glob,
			detail,
			where: line === 0 ? CONFIG_PATH : undefined,
			scopedBy: [DOC, CONFIG_PATH],
		})),
	};
}

/**
 * Judge every document read, and total what the OK line states.
 *
 * @param {import("./lib/check").Ctx} ctx
 * @param {{doc: string, pins: LinePin[]}[]} read
 * @param {{set: Set<string>, byBase: Map<string, string[]>}} tracked
 */
function judgeDocs(ctx, read, tracked) {
	/** @type {Finding[]} */
	const stale = [];
	/** @type {Set<string>} */
	const filesCited = new Set();
	let citations = 0;
	let quoted = 0;
	let bare = 0;
	for (const { doc, pins } of read) {
		const judged = judge(
			doc,
			pins,
			tracked,
			doc === BASE_DOC ? loadShipped(ctx) : null,
		);
		stale.push(...judged.findings);
		for (const rel of judged.filesCited) filesCited.add(rel);
		citations += pins.length;
		quoted += judged.quoted;
		bare += judged.bare;
	}
	return { stale, filesCited, citations, quoted, bare };
}

/**
 * The findings a --touching diff reaches, and the note saying how far it
 * scoped them.
 *
 * @param {import("./lib/check").Ctx} ctx
 * @param {{touching: string, findings: Finding[], read: {doc: string}[]}} scope
 */
function scopeToTouching(ctx, { touching, findings, read }) {
	/* An adopter's first commit is made on an unborn HEAD, which has no
	 * standards file and so reaches here (#1376). */
	const rev = baselineOf(touching);
	const touchedFiles = changedFiles(rev, (m) => ctx.broken(m));
	const touchedDocLines = new Map(
		read.map(({ doc }) => [doc, changedLines(rev, doc, (m) => ctx.broken(m))]),
	);
	const inScope = (/** @type {Finding} */ f) =>
		(f.rel !== undefined && touchedFiles.has(f.rel)) ||
		(f.scopedBy?.some((rel) => touchedFiles.has(rel)) ?? false) ||
		(f.doc !== undefined &&
			f.docLine !== 0 &&
			(touchedDocLines.get(f.doc)?.has(f.docLine) ?? false));
	const before = findings.length;
	const scoped = findings.filter(inScope);
	const scopeNote =
		`  --touching ${touching} scoped ${before} finding(s) across the whole\n` +
		`  document down to ${scoped.length}: only a citation whose cited file\n` +
		"  this diff touched, or one sitting on a document line the diff changed.\n";
	return { findings: scoped, scopeNote };
}

/* The kinds that are no citation, so neither citations_stale nor the "fix
 * the document" line takes them. UNSHIPPED is a citation, but the release,
 * not the document, may be what is wrong. */
const NOT_CITATIONS = ["DEAD-EXPORT", "ROUTE-DRIFT"];

/**
 * @param {import("./lib/check").Ctx} ctx
 * @param {Finding[]} findings
 */
function reportFindings(ctx, findings) {
	for (const f of findings) {
		const where =
			f.where ??
			(f.docLine ? `${f.doc}:${f.docLine}` : anchorsOf(f.doc ?? DOC));
		/* The pin, never `where` (mantahostels#2490): `where` resolves to a document LINE
		 * number, which every edit above it moves while the stale citation stays
		 * the same stale citation. */
		ctx.warn(
			f.kind,
			`${f.kind}  ${where}  ${f.pin} — ${f.detail}`,
			{},
			`${f.kind}\t${f.pin}`,
		);
		ctx.say(`${f.kind}  ${where}  ${f.pin}`);
		ctx.say(`  ${f.detail}\n`);
	}

	if (
		findings.some(
			(f) => !NOT_CITATIONS.includes(f.kind) && f.kind !== "UNSHIPPED",
		)
	)
		ctx.say(
			"  Every citation finding is a pin that no longer resolves. Fix the\n" +
				"  DOCUMENT, never the cited file. Report-only — this never fails a\n" +
				"  build (mantahostels#1091).\n",
		);
	if (findings.some((f) => f.kind === "DEAD-EXPORT"))
		ctx.say(
			"  Every DEAD-EXPORT is a breach in the CODE, not in the document: §G6\n" +
				"  where only tests consume the name, §N7 where nothing does.\n" +
				"  The scan is textual, so verify the name is unreachable by string too\n" +
				"  before deleting it (mantahostels#1799).\n",
		);
	if (findings.some((f) => f.kind === "ROUTE-DRIFT"))
		ctx.say(
			`  Every ROUTE-DRIFT is ${CONFIG_PATH}'s pythonRoutes, which the\n` +
				`  swallowed-error gate routes Python by, out of step with ${DOC}'s\n` +
				"  route table. The table wins: fix pythonRoutes, unless the table\n" +
				"  is what is wrong (#1863).\n",
		);
}

/**
 * @param {{citations: number, filesCited: Set<string>, read: {doc: string}[], quoted: number, bare: number, dead: {names: number, blocks: number, unparsed: number}, pythonRows: number, routeDrifts: number, touching: string | null, findings: Finding[]}} r
 */
function okLineOf({
	citations,
	filesCited,
	read,
	quoted,
	bare,
	dead,
	pythonRows,
	routeDrifts,
	touching,
	findings,
}) {
	return (
		`${citations} citation(s) across ${filesCited.size} file(s)` +
		(read.length > 1 ? ` in ${read.map((r) => r.doc).join(" and ")}` : "") +
		" resolve — " +
		`${quoted} quotation(s) found verbatim inside their cited range, ` +
		`${bare} bare pin(s) unchanged since they were last read; ` +
		`every one of ${dead.names} name(s) across ${dead.blocks} §N7 export block(s) is spelled by a non-test file that does not define it` +
		(dead.unparsed
			? `, and ${dead.unparsed} entr(ies) were of no shape §N7 describes and went unread.`
			: ".") +
		(routeDrifts === 0
			? ` pythonRoutes agrees with the ${pythonRows} route row(s) reaching Python.`
			: "") +
		(touching ? ` (--touching ${touching}: ${findings.length} in scope)` : "")
	);
}

runCheck({
	name: "code-standards",
	usage:
		"node check-code-standards.js [--warn] [--json] [--touching <rev>] [<doc>] | --review [<doc>] [<pin>…]",
	valueFlags: ["--touching"],
	flags: ["--review"],
	run(/** @type {import("./lib/check").Ctx} */ ctx) {
		const reviewAt = ctx.argv.indexOf("--review");
		const reviewing = reviewAt !== -1;
		const touching = ctx.value("--touching");
		/* Refused rather than emitting an envelope describing a run that never
		 * happened. */
		if (reviewing && ctx.asJson)
			ctx.usageError(
				"--review writes anchors and reports no findings, so it has no --json form.",
			);
		if (reviewing && touching)
			ctx.usageError(
				"--review re-anchors after a read; --touching scopes a report. Not both at once.",
			);

		/* --review's first argument may name the document; a pin never does. */
		const targets = ctx.argv
			.slice(reviewAt + 1)
			.filter((a) => !a.startsWith("--"));
		const reviewDoc =
			reviewing && isDocumentArg(targets[0]) ? targets.shift() : undefined;
		const docs = docsFor(ctx, reviewing, reviewDoc);

		const { read, unread } = readDocs(docs);
		/* A document is the citation scan's SUBJECT. Absent, --review has nothing
		 * to re-anchor and no defect in the repo, so SKIP (check.js:16-26). The
		 * export scan's subject is the code, so a repo keeping no local file —
		 * one with no choices of its own keeps none (#947) — still has its
		 * exports judged, which §G6's migration step lists them with (#1376). */
		const [primary] = read;
		if (reviewing && primary === undefined)
			ctx.skip(`${unread[0]} — so there are no citations to check`);
		for (const why of unread)
			ctx.say(`  ${why} — its citations go unchecked.\n`);

		const tracked = trackedFiles((m) => ctx.broken(m));

		if (reviewing && primary)
			reanchor(primary.doc, targets, primary.pins, tracked);

		const { stale, filesCited, citations, quoted, bare } = judgeDocs(
			ctx,
			read,
			tracked,
		);

		/* The export scan reads no part of either document, so it runs once
		 * whatever was read. */
		const blocks = exportBlocks(tracked);
		const dead = deadExports(blocks, consumersOf(tracked.set, blocks));
		const routes = routeDrift(ctx, docs, read);

		let findings = [...stale, ...dead.findings, ...routes.findings];
		let scopeNote = "";
		if (touching)
			({ findings, scopeNote } = scopeToTouching(ctx, {
				touching,
				findings,
				read,
			}));
		reportFindings(ctx, findings);
		if (scopeNote) ctx.say(scopeNote);

		return {
			okLine: okLineOf({
				citations,
				filesCited,
				read,
				quoted,
				bare,
				dead,
				pythonRows: routes.rows,
				routeDrifts: routes.findings.length,
				touching,
				findings,
			}),
			noun: "stale citation(s), export(s) nothing consumes and Python route row(s) out of step",
			data: {
				citations,
				documents: read.map((r) => r.doc),
				files: filesCited.size,
				quotations: quoted,
				barePins: bare,
				exportBlocks: dead.blocks,
				exportedNames: dead.names,
				exportEntriesUnread: dead.unparsed,
				exportsTestOnly: dead.testOnly,
				/* NOT `findings`: runCheck spreads the checker's payload first so the
				 * envelope's own keys win, and this one was silently replaced by
				 * ctx.findings (check.js:219-222). Scoped to what was actually
				 * reported, under --touching, same as the warn()/say() loop above. */
				citations_stale: findings.filter(
					(f) => !NOT_CITATIONS.includes(f.kind),
				),
				exports_dead: findings.filter((f) => f.kind === "DEAD-EXPORT"),
				routes_drift: findings.filter((f) => f.kind === "ROUTE-DRIFT"),
			},
		};
	},
});
