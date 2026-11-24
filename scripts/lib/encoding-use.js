const fs = require("node:fs");
const path = require("node:path");
const { mainChainRecords } = require("./transcript");
const { requiredGroup } = require("./regex-group.js");
const { tally } = require("./guard-fires");

const HEREDOC_OPEN = /<<-?\s*["']?([A-Za-z_][\w]*)["']?/;
const TYPED_COMMAND = /<command-name>\/([\w:-]+)<\/command-name>/g;

/**
 * @param {string} file
 * @param {"main" | "subagent"} tier
 * @param {number} [chunkSize]
 * @returns {Generator<import("./transcript.js").TranscriptRecord>}
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
			carry = lines.pop() ?? "";
			for (const line of lines) yield* mainChainRecords(line, tier);
		}
		yield* mainChainRecords(carry, tier);
	} finally {
		fs.closeSync(fd);
	}
}

/**
 * @param {string[]} roots
 * @returns {{skills: Array<{name: string, roots: string[], modelInvocable: boolean}>, unreadable: string[]}}
 */
function readSkillInventory(roots) {
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
			const head = readSkillHead(root, e);
			if (head === null) continue;
			const row = map.get(e.name) ?? {
				name: e.name,
				roots: [],
				modelInvocable: true,
			};
			row.roots.push(root);
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
 * @param {string} root
 * @param {import("node:fs").Dirent} e
 * @returns {string | null}
 */
function readSkillHead(root, e) {
	// workflow-core#5529
	if (!e.isDirectory() && !e.isSymbolicLink()) return null;
	const file = path.join(root, e.name, "SKILL.md");
	try {
		return fs.readFileSync(file, "utf8").slice(0, 4096);
	} catch {
		return null;
	}
}

/**
 * @param {Record<string, any>} pkg
 * @returns {string[]}
 */
function npmScripts(pkg) {
	return Object.keys(pkg?.scripts ?? {});
}

/**
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
 * @param {string} text
 * @returns {string[]}
 */
function parseLogicalLines(text) {
	const out = [];
	let buf = "";
	for (const line of text.split("\n")) {
		buf = buf ? `${buf} ${line}` : line;
		if (openQuote(buf)) continue;
		out.push(buf);
		buf = "";
	}
	if (buf) out.push(buf);
	return out;
}

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
 * @param {string} command
 * @returns {string[]}
 */
function segments(command) {
	return parseLogicalLines(stripHeredocs(command))
		.flatMap((line) => line.split(/&&|\|\||[;|]/))
		.map((s) => s.replace(/[(){}`]|\$\(/g, " ").trim())
		.filter(Boolean);
}

const PREFIXES = /^(?:[A-Za-z_][\w]*=\S*|sudo|time|command|exec|nohup|!)$/;

/**
 * @param {string} segment
 * @returns {string[]}
 */
function verbTokens(segment) {
	const words = segment.split(/\s+/).filter((w) => w && !/^[0-9]*[<>]/.test(w));
	const verb = words.findIndex((w) => !PREFIXES.test(w));
	return verb === -1 ? [] : words.slice(verb);
}

const PATH_VERBS = new Set(["node", "python", "python3", "bash", "sh", "npx"]);
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
const BARE = /^[a-z][a-z0-9:._-]*$/;

/**
 * @param {string} segment
 * @returns {string | null}
 */
function commandShape(segment) {
	const words = verbTokens(segment);
	const [first] = words;
	if (first === undefined) return null;
	const verb = first.replace(/^["']|["']$/g, "");
	if (verb.includes("/")) return verb.replace(/^\.\//, "");
	// workflow-core#5529
	if (!/^[a-z_][\w.:-]*$/.test(verb) || KEYWORDS.has(verb)) return null;

	if (PATH_VERBS.has(verb)) return pathVerbShape(verb, words);
	if (SUB_VERBS.has(verb)) return subVerbShape(verb, words);
	return verb;
}

/**
 * @param {string} verb
 * @param {string[]} words
 * @returns {string}
 */
function pathVerbShape(verb, words) {
	const inline = words.slice(1).find((w) => w === "-c" || w === "-e");
	if (inline) return `${verb} ${inline}`;
	const target = (words.slice(1).find((w) => !w.startsWith("-")) ?? "")
		.replace(/["']/g, "")
		.trim();
	return target ? `${verb} ${target}` : verb;
}

/**
 * @param {string} verb
 * @param {string[]} words
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
 * @param {import("./transcript.js").TranscriptRecord} record
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

	for (const m of parseUserText(content).matchAll(TYPED_COMMAND)) {
		const name = requiredGroup(m, 1, TYPED_COMMAND);
		add("skill", name, "command", `${record.uuid ?? ""} ${name}`);
	}

	return out;
}

/** @typedef {{name?: string, input?: {skill?: unknown, command?: string}}} ToolUseBlock */

/**
 * @param {ToolUseBlock} part
 * @returns {Array<{kind: "skill"|"npm", name: string, route: string}>}
 */
function toolCallUses(part) {
	if (part.name === "Skill") {
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
 * @param {unknown} content
 * @returns {string}
 */
function parseUserText(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((p) => p?.type === "text" && typeof p.text === "string")
		.map((p) => p.text)
		.join("\n");
}

/**
 * @param {import("./transcript.js").TranscriptRecord} record
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
			if (!shape || seen.has(shape)) continue;
			seen.add(shape);
			out.push({ shape, at, key: `${shape} ${id}` });
		}
	}
	return out;
}

/**
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
	if (/(^|[\s/])(scripts|\.husky|\.claude|\.agents)\//.test(shape)) return true;
	return words.some((w) => encoded.skills.has(w.replace(/^\//, "")));
}

module.exports = {
	streamRecords,
	readSkillInventory,
	npmScripts,
	recordUses,
	recordShapes,
	tally,
	isEncoded,
};
