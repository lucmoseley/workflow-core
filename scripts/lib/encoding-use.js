/*
 * encoding-use.js — was an encoded thing ever USED, read off the transcripts
 * already on disk.
 *
 * Built at mantahostels#1299. `lib/guard-fires.js` owns the same problem for hooks.
 *
 * THE WHOLE PROBLEM IS TELLING AN INVOCATION FROM A MENTION. A skill name and
 * an `npm run` name land in transcripts overwhelmingly as neither: a CLAUDE.md
 * line, an assistant sentence proposing one, a `cat` of package.json, a doc
 * quoting the command (mantahostels#1246). So a hit counts only where it sits in a span the
 * harness writes when something is actually invoked:
 *
 *   ROUTE `tool`    — a `tool_use` block named `Skill`, whose `input.skill` is
 *                     the skill the model invoked.
 *   ROUTE `command` — `<command-name>/x</command-name>`, which the harness
 *                     writes into the user turn when a slash command is typed.
 *   ROUTE `bash`    — a `tool_use` block named `Bash`, whose `input.command`
 *                     carries an `npm run <name>` segment WHOSE OWN VERB IS
 *                     `npm`. Parsing per segment is what keeps a
 *                     `grep 'npm run test'` out of the count.
 *
 * A ZERO IS EVIDENCE ABOUT RETRIEVAL, NEVER ABOUT A RULE'S WORTH (mantahostels#1246's
 * deterrence caveat, which binds identically here): a skill nothing invokes may
 * be a skill nothing needed, one nothing could find, or one whose frontmatter
 * forbids the model invoking it at all.
 *
 * SUBAGENT TRANSCRIPTS HAVE BEEN RETAINED ON THIS MACHINE SINCE 31 JULY 2026
 * (mantahostels#1725, mantahostels#1779) and `streamRecords` below reads both tiers — the caller tags
 * each file's tier once (`lib/guard-fires.js` `transcriptFiles`) and passes it
 * in, rather than this function re-deriving it per file.
 */

const fs = require("node:fs");
const path = require("node:path");
const { mainChainRecords } = require("./transcript");
const { requiredGroup } = require("./regex-group.js");
// The roll-up is the guard census's: a "subject" there is a guard, here a skill
// or an `npm run` name.
const { tally } = require("./guard-fires");

/** A heredoc's opener, capturing its delimiter word. */
const HEREDOC_OPEN = /<<-?\s*["']?([A-Za-z_][\w]*)["']?/;
/** A typed slash command as user-turn text, capturing its name. */
const TYPED_COMMAND = /<command-name>\/([\w:-]+)<\/command-name>/g;

/**
 * Every record of one transcript, read a line at a time.
 *
 * The family convention is that a scan never loads a whole transcript, and this
 * corpus holds single sessions in the tens of MB. One line is a one-line text,
 * so the shared parser reads it unchanged.
 *
 * The 1 MiB chunk is a first guess: large enough that the biggest transcript here (~40 MB) costs ~40 reads, and small enough that a
 * corpus-wide scan never holds a whole session in memory.
 *
 * @param {string} file
 * @param {"main" | "subagent"} tier
 * @param {number} [chunkSize]
 * @returns {Generator<Record<string, any>>}
 */
function* streamRecords(file, tier, chunkSize = 1 << 20) {
	const fd = fs.openSync(file, "r");
	try {
		const buf = Buffer.alloc(chunkSize);
		let carry = "";
		for (;;) {
			const read = fs.readSync(fd, buf, 0, chunkSize, null);
			if (read === 0) break;
			const lines = (carry + buf.toString("utf8", 0, read)).split("\n");
			// The last element is a partial line until the next chunk completes it.
			carry = lines.pop() ?? "";
			for (const line of lines) yield* mainChainRecords(line, tier);
		}
		yield* mainChainRecords(carry, tier);
	} finally {
		fs.closeSync(fd);
	}
}

/**
 * Every skill defined under `roots`, by name, with the roots defining it.
 *
 * Derived from the directories, never a hand-list — the idiom
 * `hook-registrations.test.ts` uses, so a new skill cannot arrive uncounted.
 * A name defined in more than one root is ONE row: an invocation names a skill,
 * never a file, so this method cannot say which copy was loaded.
 *
 * A root that cannot be read is NAMED rather than skipped: it would otherwise
 * render as a repo with no skills, which reads as a corpus finding rather than
 * a mistyped path (mantahostels#1299; the fail-open rule is §N5).
 *
 * @param {string[]} roots
 * @returns {{skills: Array<{name: string, roots: string[], modelInvocable: boolean}>, unreadable: string[]}}
 */
function skillInventory(roots) {
	/** @type {Map<string, {name: string, roots: string[], modelInvocable: boolean}>} */
	const map = new Map();
	/** @type {string[]} */
	const unreadable = [];
	for (const root of roots) {
		let entries;
		try {
			entries = fs.readdirSync(root, { withFileTypes: true });
		} catch {
			unreadable.push(root);
			continue;
		}
		for (const e of entries) {
			const head = skillHead(root, e);
			if (head === null) continue;
			const row = map.get(e.name) ?? {
				name: e.name,
				roots: [],
				modelInvocable: true,
			};
			row.roots.push(root);
			// One root forbidding it is enough: the founder must type the command.
			if (/^disable-model-invocation:\s*true\s*$/m.test(head))
				row.modelInvocable = false;
			map.set(e.name, row);
		}
	}
	return {
		skills: [...map.values()].sort((a, b) => a.name.localeCompare(b.name)),
		unreadable,
	};
}

/**
 * The head of an entry's `SKILL.md`, or `null` where the entry is not a
 * directory or holds none.
 * @param {string} root
 * @param {import("node:fs").Dirent} e
 * @returns {string | null}
 */
function skillHead(root, e) {
	// A SYMLINK COUNTS. Most of `.claude/skills` symlinks the `.agents`
	// copy, and isDirectory() reads the link itself, not its target.
	if (!e.isDirectory() && !e.isSymbolicLink()) return null;
	const file = path.join(root, e.name, "SKILL.md");
	try {
		// 4 KiB: the frontmatter block this reads is the first ~10 lines of a
		// SKILL.md, and the longest in this repo ends by 700 B.
		return fs.readFileSync(file, "utf8").slice(0, 4096);
	} catch {
		return null;
	}
}

/**
 * Every `npm run` name in a parsed package.json, in file order.
 * @param {Record<string, any>} pkg
 * @returns {string[]}
 */
function npmScripts(pkg) {
	return Object.keys(pkg?.scripts ?? {});
}

/**
 * A command with its heredoc BODIES removed.
 *
 * A heredoc body is data, not commands, and this repo writes big ones — python
 * through `python3 <<'PY'`, prose through `cat <<EOF`. Left in, its lines
 * normalise as shapes of their own.
 *
 * @param {string} command
 * @returns {string}
 */
function stripHeredocs(command) {
	const lines = String(command || "").split("\n");
	const out = [];
	/** @type {string | null} */
	let until = null;
	for (const line of lines) {
		if (until !== null) {
			if (line.trim() === until) until = null;
			continue;
		}
		out.push(line);
		const open = line.match(HEREDOC_OPEN);
		if (open) until = requiredGroup(open, 1, HEREDOC_OPEN);
	}
	return out.join("\n");
}

/**
 * Is a quote still open at the end of `text`? Returns the open quote character,
 * or `null`.
 *
 * A backslash escapes the next character; a `\'` inside single quotes does not,
 * but reading it as if it did closes the string one character early and the
 * next line rejoins anyway, so the error is self-correcting.
 *
 * @param {string} text
 * @returns {string | null}
 */
function openQuote(text) {
	let open = null;
	for (let i = 0; i < text.length; i += 1) {
		const c = text[i];
		if (c === "\\") {
			i += 1;
			continue;
		}
		if (open) {
			if (c === open) open = null;
		} else if (c === "'" || c === '"') open = c;
	}
	return open;
}

/**
 * A command's lines, with a line inside an unclosed quote joined to the one
 * that opened it.
 *
 * A multi-line inline script — `python3 -c "..."`, `node -e '...'` — is one
 * command, and splitting it per line files each of its OWN lines as a shape:
 * unjoined, this corpus put `print` and `import` in the top twenty-five.
 *
 * @param {string} text
 * @returns {string[]}
 */
function logicalLines(text) {
	const out = [];
	let buf = "";
	for (const line of text.split("\n")) {
		buf = buf ? `${buf} ${line}` : line;
		if (openQuote(buf)) continue;
		out.push(buf);
		buf = "";
	}
	// An unterminated quote at the end: keep it rather than drop the command.
	if (buf) out.push(buf);
	return out;
}

/** Shell grammar that is never a command: a loop, a conditional, a block. */
const KEYWORDS = new Set([
	"for",
	"do",
	"done",
	"if",
	"then",
	"elif",
	"else",
	"fi",
	"while",
	"until",
	"case",
	"esac",
	"in",
	"function",
	"return",
	"local",
	"export",
	"set",
	"trap",
]);

/**
 * One shell command split into the segments a verb can start: `&&`, `||`, `;`,
 * `|` and newlines, with heredoc bodies dropped and a subshell's or a
 * substitution's brackets dropped.
 *
 * Quoting is NOT parsed — a `;` inside a quoted string splits a segment it
 * should not. That mis-splits a shape; it cannot invent an `npm run`, because
 * the fragment it produces has the wrong verb.
 *
 * @param {string} command
 * @returns {string[]}
 */
function segments(command) {
	return logicalLines(stripHeredocs(command))
		.flatMap((line) => line.split(/&&|\|\||[;|]/))
		.map((s) => s.replace(/[(){}`]|\$\(/g, " ").trim())
		.filter(Boolean);
}

/** Leading noise that is not the verb: an env assignment, a wrapper, a redirect. */
const PREFIXES = /^(?:[A-Za-z_][\w]*=\S*|sudo|time|command|exec|nohup|!)$/;

/**
 * The tokens of one segment with that noise stripped, or `[]` where nothing is
 * left.
 * @param {string} segment
 * @returns {string[]}
 */
function verbTokens(segment) {
	const words = segment
		.split(/\s+/)
		// A redirection is not an argument: `python3 <<'PY'` is a `python3` shape.
		.filter((w) => w && !/^[0-9]*[<>]/.test(w));
	const verb = words.findIndex((w) => !PREFIXES.test(w));
	return verb === -1 ? [] : words.slice(verb);
}

/** Verbs whose identity is the FILE they run, so the path is part of the shape. */
const PATH_VERBS = new Set(["node", "python", "python3", "bash", "sh", "npx"]);
/** Verbs whose identity is their SUBCOMMAND, up to two words of it. */
const SUB_VERBS = new Set([
	"git",
	"gh",
	"npm",
	"pnpm",
	"yarn",
	"docker",
	"cargo",
	"pip",
	"pip3",
]);
/** A bare subcommand word — never a flag, a path, a glob or a filename. */
const BARE = /^[a-z][a-z0-9:._-]*$/;

/**
 * One segment reduced to a normalised command SHAPE, or `null` where it has no
 * verb.
 *
 * Three grammars, because one rule fits none of them: `node scripts/x.js` is
 * identified by its path, `gh issue view` by two subcommand words, and `cat
 * whatever` by the verb alone — a `cat` shape carrying its filename would be
 * one shape per file and would count nothing.
 *
 * @param {string} segment
 * @returns {string | null}
 */
function commandShape(segment) {
	const words = verbTokens(segment);
	const [first] = words;
	if (first === undefined) return null;
	const verb = first.replace(/^["']|["']$/g, "");
	// A verb that is itself a path runs a FILE — `./scripts/guard-x.sh`. Keep the
	// path: reducing it to a basename is what would hide that it is repo-encoded.
	if (verb.includes("/")) return verb.replace(/^\.\//, "");
	// LOWERCASE-INITIAL, deliberately: an uppercase first letter is prose out of a
	// heredoc this parser could not close, never a command. Nothing this repo runs
	// is spelled with a capital; a machine that ran one would undercount it.
	if (!/^[a-z_][\w.:-]*$/.test(verb) || KEYWORDS.has(verb)) return null;

	if (PATH_VERBS.has(verb)) return pathVerbShape(verb, words);
	if (SUB_VERBS.has(verb)) return subVerbShape(verb, words);
	return verb;
}

/**
 * A `PATH_VERBS` verb's shape: the verb and the file it runs.
 * @param {string} verb
 * @param {string[]} words the segment's tokens, the verb first
 * @returns {string}
 */
function pathVerbShape(verb, words) {
	// An INLINE script has no path to name it, and its first word is program
	// text: `python3 -c "import os"` reduced by the rule below would file itself
	// under `import`, which is how `print` and `import` reach a shape table.
	const inline = words.slice(1).find((w) => w === "-c" || w === "-e");
	if (inline) return `${verb} ${inline}`;
	const target = (words.slice(1).find((w) => !w.startsWith("-")) ?? "")
		.replace(/["']/g, "")
		.trim();
	return target ? `${verb} ${target}` : verb;
}

/**
 * A `SUB_VERBS` verb's shape: the verb and up to two bare subcommand words.
 * @param {string} verb
 * @param {string[]} words the segment's tokens, the verb first
 * @returns {string}
 */
function subVerbShape(verb, words) {
	const subs = [];
	for (const w of words.slice(1)) {
		if (subs.length === 2 || !BARE.test(w) || w.includes("/")) break;
		subs.push(w);
	}
	return [verb, ...subs].join(" ");
}

/**
 * The `npm run` names one command invokes.
 *
 * `npm test` and `npm start` are npm's own aliases for the same scripts and
 * count as invocations of them; nothing else npm does is a script run.
 *
 * @param {string} command
 * @returns {string[]}
 */
function npmRunNames(command) {
	const names = [];
	for (const segment of segments(command)) {
		const words = verbTokens(segment);
		if (words[0] !== "npm") continue;
		const rest = words.slice(1).filter((w) => !w.startsWith("-"));
		if (rest[0] === "run" || rest[0] === "run-script") {
			if (rest[1]) names.push(rest[1]);
		} else if (rest[0] === "test" || rest[0] === "start") names.push(rest[0]);
	}
	return names;
}

/**
 * Every invocation one record carries, each with a dedupe key.
 *
 * One assistant turn writes one JSONL line PER CONTENT BLOCK (mantahostels#1141), so the
 * same `tool_use` id can arrive more than once; the key is that id.
 *
 * @param {Record<string, any>} record
 * @returns {Array<{kind: "skill"|"npm", name: string, route: string, at: string|null, key: string}>}
 */
function recordUses(record) {
	const at = typeof record.timestamp === "string" ? record.timestamp : null;
	/** @type {Array<{kind: "skill"|"npm", name: string, route: string, at: string|null, key: string}>} */
	const out = [];
	/** @param {"skill"|"npm"} kind @param {string} name @param {string} route @param {string} id */
	const add = (kind, name, route, id) =>
		out.push({ kind, name, route, at, key: `${kind} ${name} ${route} ${id}` });

	const content = record?.message?.content;
	for (const part of Array.isArray(content) ? content : []) {
		if (part?.type !== "tool_use") continue;
		const id = part.id ?? record.uuid ?? "";
		for (const use of toolCallUses(part))
			add(use.kind, use.name, use.route, id);
	}

	// A TYPED slash command reaches the transcript as user-turn text, never as a
	// tool call — so the two routes never double-count one invocation.
	for (const m of userText(content).matchAll(TYPED_COMMAND)) {
		const name = requiredGroup(m, 1, TYPED_COMMAND);
		add("skill", name, "command", `${record.uuid ?? ""} ${name}`);
	}

	return out;
}

/**
 * A `tool_use` content block of a transcript record. Parsed JSON, so only the
 * fields read here are named, and none is guaranteed.
 * @typedef {{name?: string, input?: {skill?: unknown, command?: string}}} ToolUseBlock
 */

/**
 * The invocations one `tool_use` block makes: a Skill call's skill, or the
 * `npm run` names a Bash call's command runs.
 * @param {ToolUseBlock} part
 * @returns {Array<{kind: "skill"|"npm", name: string, route: string}>}
 */
function toolCallUses(part) {
	if (part.name === "Skill") {
		// `plugin:skill` names a plugin's copy of the same skill.
		const skill = String(part.input?.skill ?? "")
			.split(":")
			.pop();
		return skill ? [{ kind: "skill", name: skill, route: "tool" }] : [];
	}
	if (part.name === "Bash")
		return npmRunNames(part.input?.command ?? "").map((name) => ({
			kind: "npm",
			name,
			route: "bash",
		}));
	return [];
}

/**
 * The plain text of a record's message: a string content, or every `text` block
 * of an array one.
 * @param {unknown} content
 * @returns {string}
 */
function userText(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((p) => p?.type === "text" && typeof p.text === "string")
		.map((p) => p.text)
		.join("\n");
}

/**
 * Every Bash command SHAPE one record carries, deduped by tool call.
 *
 * The tool_use input only — a shape read off stdout would count whatever a
 * session `cat`ed.
 *
 * @param {Record<string, any>} record
 * @returns {Array<{shape: string, at: string|null, key: string}>}
 */
function recordShapes(record) {
	const at = typeof record.timestamp === "string" ? record.timestamp : null;
	const content = record?.message?.content;
	const out = [];
	for (const part of Array.isArray(content) ? content : []) {
		if (part?.type !== "tool_use" || part.name !== "Bash") continue;
		const id = part.id ?? record.uuid ?? "";
		const seen = new Set();
		for (const segment of segments(part.input?.command ?? "")) {
			const shape = commandShape(segment);
			// One call running `git status` twice is one use of the shape.
			if (!shape || seen.has(shape)) continue;
			seen.add(shape);
			out.push({ shape, at, key: `${shape} ${id}` });
		}
	}
	return out;
}

/**
 * Does this Bash shape already correspond to something encoded?
 *
 * Section 2 asks what is still done BY HAND, so a shape that runs a repo script,
 * an `npm run` name or a skill is not an answer to it.
 *
 * @param {string} shape
 * @param {{npm: Set<string>, skills: Set<string>}} encoded
 * @returns {boolean}
 */
function isEncoded(shape, encoded) {
	const words = shape.split(" ");
	if (words[0] === "npm") {
		if (words[1] === "run" || words[1] === "run-script") return true;
		return encoded.npm.has(words[1] ?? "");
	}
	// `node scripts/x.js`, `python3 scripts/measure-*/y.py`, `.husky/pre-commit`.
	if (/(^|[\s/])(scripts|\.husky|\.claude|\.agents)\//.test(shape)) return true;
	return words.some((w) => encoded.skills.has(w.replace(/^\//, "")));
}

module.exports = {
	streamRecords,
	skillInventory,
	npmScripts,
	recordUses,
	recordShapes,
	tally,
	isEncoded,
};
