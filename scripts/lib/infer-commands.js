const fs = require("node:fs");
const path = require("node:path");
const {
	BIOME_STAGED_COMMAND,
	BIOME_STAGED_START,
	OWN_FLAGS,
	OWN_FLAGS_WAY_OUT,
	UNREAD,
	UNRESOLVED_SELECTOR,
	declareCheckStaged,
	mapAsWritten,
	mapBiome,
} = require("./biome-allowlist.js");
const { bracketUnits } = require("./bracket-units.js");
const { caught } = require("./caught.js");
const {
	PackageReadError,
	buildPackageTree,
	readPackage,
} = require("./package-reader.js");
const {
	RUNNER_NAMES,
	findRun,
	isPlainWord,
	namedScriptWord,
	parseNamedDir,
	placedCommands,
	unresolvedSelectorMembers,
	walkRunScripts,
	withoutRun,
} = require("./script-runners.js");
const {
	allCommands,
	isOpaque,
	isUnreadWord,
	simpleCommands,
	tokenise,
	wordOf,
	writtenCommands,
} = require("./shell-tokens.js");
const { escapeRe } = require("./regex-group.js");
const { writeFd } = require("./write-fd.js");

/** @typedef {import("./shell-tokens.js").Word} Word */
/** @typedef {import("./shell-tokens.js").Token} Token */
/** @typedef {import("./script-runners.js").Hop} Hop */
/** @typedef {import("./package-reader.js").PackageTree} PackageTree */
/** @typedef {import("./script-runners.js").Placed} Placed */
/** @typedef {import("./biome-allowlist.js").MappedCommand} MappedCommand */

/**
 * @typedef {{kind: "none"}
 *   | ({kind: "mapped"} & MappedCommand)
 *   | {kind: "refused", refusal: string}} StagedClass
 */

const SCRIPT_NAMES = {
	test: ["test"],
	lint: ["lint"],
	typecheck: ["typecheck", "type-check"],
	check: ["check"],
	check_staged: ["check:staged"],
};

const NPM_INIT_PLACEHOLDER = /no test specified/;

const LINT_STAGED = /(?:^|\/)lint-staged(?:@.*)?$/;

/**
 * @param {string} root
 * @param {string} command
 * @returns {boolean}
 */
function isLintStagedCommand(root, command) {
	const tree = buildPackageTree(root);
	return (
		walkRunScripts(tree, command, (hop) =>
			[...placedCommands(hop)].some((placed) =>
				withoutRun(placed, tree).some((w) => LINT_STAGED.test(w.value)),
			)
				? true
				: undefined,
		) ?? false
	);
}

const BIOME_WORD = /(?:^|\/)biome(?:@.*)?$/;
const CHECK_WORD = /^check$/;
const STAGED_WORD = /^--staged(?:=|$)/;
const BIOME_TEXT = /biome/;

/**
 * @param {Word} word
 * @param {RegExp} re
 */
const isPossibly = (word, re) => re.test(word.value) || isOpaque(word);

const GLOB_SOURCE = new Map([
	["*", ".*"],
	["?", "."],
]);

/** @param {Word} word */
const isBiomeGlob = (word) => {
	if (!word.glob) return false;
	const source = bracketUnits(path.posix.basename(word.value))
		.map((c) => GLOB_SOURCE.get(c) ?? (c.length > 1 ? "." : escapeRe(c)))
		.join("");
	return new RegExp(`^${source}$`).test("biome");
};

/** @param {Word[]} command */
const biomeCheckAt = (command) =>
	command.findIndex((w, i) => {
		const next = command[command[i + 1]?.value === "--" ? i + 2 : i + 1];
		return (
			next !== undefined &&
			(isPossibly(w, BIOME_WORD) || isBiomeGlob(w)) &&
			isPossibly(next, CHECK_WORD)
		);
	});

/** @param {Word[]} command */
const isBiomeCheck = (command) => {
	const at = biomeCheckAt(command);
	return (
		at >= 0 && command.slice(at + 2).some((w) => isPossibly(w, STAGED_WORD))
	);
};

/** @param {Word[]} command */
function parseBiomeSubcommand(command) {
	const at = command.findIndex(
		(w) => BIOME_WORD.test(w.value) || isBiomeGlob(w),
	);
	const rest = command.slice(at + 1);
	if (at < 0 || !rest.some((w) => isPossibly(w, STAGED_WORD))) return;
	const subcommand = rest.find((w) => !w.value.startsWith("-"));
	return subcommand ? subcommand.value : "";
}

const PACKAGE_MANAGERS = [...RUNNER_NAMES, "bunx", "npx"];
const MENTIONS = new RegExp(
	`biome|(?:^|[\\s;&|(\`$"'=/])(?:${PACKAGE_MANAGERS.join("|")})(?=$|[\\s;&|)\`"'@])|\\$'[^']*\\\\`,
);

/** @type {Map<string, (rest: Word[]) => boolean>} */
const INDIRECT = new Map([
	["xargs", (rest) => isHiddenCommand(parseXargsCommand(rest))],
	["eval", (rest) => rest.some(isUnreadWord)],
]);
const SHELLS = new Set(["sh", "bash", "dash", "zsh", "ksh"]);
const SCRIPT_FLAG = /^-[a-z]*c/;
const STDIN_FLAG = /^-[a-zA-Z]*s/;
const SHELL_VALUE_FLAG = /^(?:[-+][a-zA-Z]*[oO]|--rcfile|--init-file)$/;
const EXEC_PREFIXES = new Map([
	["env", new Set(["-u", "--unset", "-C", "--chdir"])],
	["command", new Set()],
	["exec", new Set(["-a"])],
	["nice", new Set(["-n", "--adjustment"])],
	["nohup", new Set()],
	["time", new Set(["-f", "--format", "-o", "--output"])],
]);
const COMMAND_LOOKUP = /^-p?[vV]/;
const ASSIGNMENT = /^[A-Za-z_]\w*=/;
const RESERVED = new Set([
	"if",
	"then",
	"elif",
	"else",
	"while",
	"until",
	"do",
	"!",
]);
const XARGS_VALUE_FLAGS = new Set([
	"-a",
	"--arg-file",
	"-d",
	"--delimiter",
	"-E",
	"-I",
	"-L",
	"--max-lines",
	"-n",
	"--max-args",
	"-P",
	"--max-procs",
	"--process-slot-var",
	"-s",
	"--max-chars",
]);

const HEREDOCS = new Set(["<<", "<<-"]);

/**
 * @param {RegExp} re
 * @param {string} text
 * @param {Token[]} tokens
 */
const hasMatch = (re, text, tokens) =>
	re.test(text.replace(/["'\\]/g, "")) ||
	re.test(text) ||
	allCommands(tokens).some((c) => c.some((w) => re.test(w.value)));

/**
 * @param {Word[]} command
 * @returns {Word[]}
 */
function withoutPrefix(command) {
	const at = command.findIndex(
		(w) => !ASSIGNMENT.test(w.value) && !RESERVED.has(w.value),
	);
	const head = command[at];
	if (!head) return [];
	const flags = EXEC_PREFIXES.get(path.posix.basename(head.value));
	const rest = command.slice(at + 1);
	if (!flags) return command.slice(at);
	const [first] = rest;
	if (head.value === "command" && first && COMMAND_LOOKUP.test(first.value))
		return [];
	const next = rest.findIndex((w, i) => isPlainWord(w, rest[i - 1], flags));
	return next < 0 ? [] : withoutPrefix(rest.slice(next));
}

/** @param {Word[]} words */
function parseXargsCommand(words) {
	const at = words.findIndex((w, i) =>
		isPlainWord(w, words[i - 1], XARGS_VALUE_FLAGS),
	);
	return at < 0 ? [] : words.slice(at);
}

/** @param {Word[]} command */
function parseShellScript(command) {
	const [head, ...rest] = withoutPrefix(command);
	if (!head || !SHELLS.has(path.posix.basename(head.value))) return;
	const flag = rest.findIndex((w) => SCRIPT_FLAG.test(w.value));
	return flag < 0 ? undefined : rest[flag + 1];
}

/** @param {Word[]} words */
function isStdinScript(words) {
	let at = 0;
	for (let word = words[0]; word; word = words[at]) {
		if (word.value === "--") {
			at += 1;
			break;
		}
		if (!/^[-+]/.test(word.value)) break;
		at += SHELL_VALUE_FLAG.test(word.value) ? 2 : 1;
	}
	return (
		at >= words.length ||
		words.slice(0, at).some((w) => STDIN_FLAG.test(w.value))
	);
}

/** @param {Word[]} command */
function isHiddenCommand(command) {
	const [head, ...rest] = withoutPrefix(command);
	if (!head) return false;
	if (isUnreadWord(head) || head.glob) return true;
	const name = path.posix.basename(head.value);
	if (name === "parallel") return true;
	const indirect = INDIRECT.get(name);
	if (indirect) return indirect(rest);
	if (!SHELLS.has(name)) return false;
	if (!rest.some((w) => SCRIPT_FLAG.test(w.value))) return isStdinScript(rest);
	const script = parseShellScript(command);
	return (
		script !== undefined &&
		(isUnreadWord(script) ||
			writtenCommands(tokenise(script.value)).some(isHiddenCommand))
	);
}

/**
 * @param {Hop} hop
 * @param {PackageTree} tree
 * @returns {boolean}
 */
const isUnreadable = (hop, tree) =>
	hop.tokens.some((t) => {
		const word = wordOf(t);
		return (
			(t.type === "redirect" && HEREDOCS.has(t.op)) ||
			(word?.type === "word" && isUnreadWord(word))
		);
	}) ||
	[...placedCommands(hop)].some((placed) => {
		const script = parseShellScript(placed.command);
		const name = namedScriptWord(placed, tree);
		return (
			placed.command.some(
				(w) => w !== name && INDIRECT.has(path.posix.basename(w.value)),
			) ||
			(script !== undefined &&
				isUnreadable({ ...hop, tokens: tokenise(script.value) }, tree))
		);
	});

/** @param {Token[]} tokens */
const isPlain = (tokens) =>
	tokens.every((t) => t.type === "word" && t.subs.length === 0);

/** @param {Token[]} tokens */
const onlyCommand = (tokens) => {
	const [only, ...more] = simpleCommands(tokens);
	return isPlain(tokens) && more.length === 0 ? only : undefined;
};

/**
 * @param {Hop} hop
 * @returns {Hop}
 */
function pastBiomeStaged(hop) {
	const start = BIOME_STAGED_START.exec(hop.text);
	if (!start) return hop;
	const end = hop.tokens.findIndex((t) => t.type !== "word");
	const own = end < 0 ? hop.tokens : hop.tokens.slice(0, end);
	const [, , ...handed] = own;
	if (handed.some((t) => t.type === "word" && isUnreadWord(t))) return hop;
	return {
		...hop,
		text: hop.text.slice(start[0].length),
		tokens: end < 0 ? [] : hop.tokens.slice(end),
	};
}

/**
 * @param {Placed|undefined} placed
 * @param {string} top
 */
function findElsewhere(placed, top) {
	if (!placed) return;
	const own = parseNamedDir(placed.command);
	const dirs = placed.dirs.map((d) => path.resolve(d, own));
	return dirs.every((d) => d !== top) ? dirs[0] : undefined;
}

/**
 * @param {string} root
 * @param {string} command
 * @param {{inferred: boolean}} how
 * @returns {StagedClass}
 */
function classifyCheckStaged(root, command, { inferred }) {
	if (command.trim().startsWith(BIOME_STAGED_COMMAND)) return { kind: "none" };
	const tree = buildPackageTree(root);
	const { root: top, readCachedPackage } = tree;
	/**
	 * @param {Hop} hop
	 * @param {string[]} [members]
	 */
	const hasBiomeEvidence = ({ text, tokens, dir }, members = []) => {
		const hasEvidence = (/** @type {string} */ d) =>
			readCachedPackage(d).biomeEvident;
		return (
			hasMatch(BIOME_TEXT, text, tokens) ||
			hasEvidence(top) ||
			hasEvidence(dir) ||
			members.some(hasEvidence) ||
			allCommands(tokens).some((c) =>
				hasEvidence(path.resolve(dir, parseNamedDir(c))),
			)
		);
	};
	const hit = walkRunScripts(
		tree,
		command,
		/** @param {Hop} hop @param {Hop[]} hops */
		(hop, hops) => {
			const judged = pastBiomeStaged(hop);
			const { text, tokens } = judged;
			const placed = [...placedCommands(judged)];
			const candidates = placed.map((p) => withoutRun(p, tree));
			const segment = candidates.find(isBiomeCheck);
			const subcommand = candidates
				.map(parseBiomeSubcommand)
				.find((s) => s !== undefined);
			const biomeCommand = segment !== undefined || subcommand !== undefined;
			const unread =
				((biomeCommand || hasMatch(MENTIONS, text, tokens)) &&
					isUnreadable(judged, tree)) ||
				writtenCommands(tokens).some(isHiddenCommand);
			const unresolvedMembers = placed
				.map((p) => unresolvedSelectorMembers(p, tree))
				.find((members) => members !== undefined);
			if (
				(!unread && !unresolvedMembers && !biomeCommand) ||
				!hasBiomeEvidence(hop, unresolvedMembers)
			)
				return;
			if (unread) return { hops, unread: UNREAD };
			if (unresolvedMembers) return { hops, unread: UNRESOLVED_SELECTOR };
			if (segment === undefined) return { hops, subcommand, unread: null };
			const only = onlyCommand(tokens);
			const own =
				only !== undefined &&
				segment === candidates[0] &&
				segment.length === only.length;
			return {
				hops,
				segment,
				own,
				elsewhere: findElsewhere(placed[candidates.indexOf(segment)], top),
				unread: null,
			};
		},
	);
	if (!hit) return { kind: "none" };
	const via = hit.hops
		.slice(1)
		.map(
			(h) =>
				` through package.json script "${h.name}" ("${h.text}")${h.handed ? `, handed${h.handed}` : ""}`,
		)
		.join(",");
	const single =
		hit.own &&
		hit.hops.every((h) => h.alone) &&
		hit.hops.slice(0, -1).every((h) => {
			const only = onlyCommand(h.tokens);
			return only !== undefined && findRun(only)?.at === 0;
		});
	/** @param {string} shape @param {string} wayOut @param {string} [runs] */
	const refused = (shape, wayOut, runs = "runs") => ({
		kind: /** @type {const} */ ("refused"),
		refusal: `${runs} biome check --staged${via}, which lints each staged path's worktree bytes, unstaged hunks included (#2583), and ${shape}. ${wayOut}`,
	});
	if (hit.unread)
		return refused(hit.unread.shape, hit.unread.wayOut, "may run");
	if (hit.segment === undefined)
		return {
			kind: "refused",
			refusal: `runs biome${hit.subcommand ? ` ${hit.subcommand}` : ""} --staged${via}, which reads or rewrites each staged path's worktree bytes, unstaged hunks included (#2583), in a shape biome-staged.js does not map. ${OWN_FLAGS_WAY_OUT}`,
		};
	if (hit.elsewhere)
		return refused(
			`runs it in ${path.relative(top, hit.elsewhere)}, where biome-staged.js, which runs from the work tree's top, cannot follow`,
			OWN_FLAGS_WAY_OUT,
		);
	if (!single) {
		const part = mapBiome(hit.segment, readCachedPackage(top).biome, inferred);
		return refused(
			"holds more than that one command",
			declareCheckStaged(
				`instead as '${"command" in part ? part.command : OWN_FLAGS}' for the Biome part, and put the rest in a gate of its own`,
			),
		);
	}
	const mapped = mapAsWritten(
		hit.segment,
		readCachedPackage(top).biome,
		inferred,
	);
	if (!("command" in mapped)) return refused(mapped.shape, mapped.wayOut);
	if (!inferred)
		return refused(
			`would map${mapped.note ? ` (${mapped.note})` : ""}, and an explicit value is never rewritten`,
			declareCheckStaged(`instead as '${mapped.command}'`),
		);
	return { kind: "mapped", ...mapped };
}

/** @param {string} root */
function hasPytestConfig(root) {
	/** @type {[string, RegExp|null][]} */
	const files = [
		["pytest.ini", null],
		["pyproject.toml", /^\[tool\.pytest\.ini_options\]/m],
		["setup.cfg", /^\[tool:pytest\]/m],
		["tox.ini", /^\[pytest\]/m],
	];
	return files.some(([file, section]) => {
		try {
			const text = fs.readFileSync(path.join(root, file), "utf8");
			return section === null || section.test(text);
		} catch {
			return false;
		}
	});
}

const NODE_TEST_FILE = /^(?:.*[.\-_]test|test-.*|test)\.[cm]?js$/;
const NODE_TEST_DIR_FILE = /\.[cm]?js$/;

/**
 * @param {string} dir
 * @param {boolean} [underTest]
 * @returns {boolean}
 */
function hasNodeTestFile(dir, underTest = false) {
	let entries;
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return false;
	}
	const testPattern = underTest ? NODE_TEST_DIR_FILE : NODE_TEST_FILE;
	for (const e of entries) {
		if (e.isFile() && testPattern.test(e.name)) return true;
	}
	return entries.some(
		(e) =>
			e.isDirectory() &&
			!e.name.startsWith(".") &&
			e.name !== "node_modules" &&
			hasNodeTestFile(path.join(dir, e.name), underTest || e.name === "test"),
	);
}

/** @typedef {MappedCommand & {from: string}} Inferred */

/**
 * @param {string} root
 * @param {string} key
 * @param {string} name
 * @returns {MappedCommand}
 */
function scriptCommand(root, key, name) {
	const kept = `npm run ${name}`;
	if (key !== "check_staged") return { command: kept };
	const c = classifyCheckStaged(root, kept, { inferred: true });
	if (c.kind !== "mapped") return { command: kept };
	const { kind: _, ...mapped } = c;
	return mapped;
}

/**
 * @param {string} root
 * @returns {Partial<Record<keyof typeof SCRIPT_NAMES, Inferred>>}
 */
function inferCommands(root) {
	const { scripts } = readPackage(root);
	/** @type {Partial<Record<keyof typeof SCRIPT_NAMES, Inferred>>} */
	const found = {};
	for (const [command, names] of Object.entries(SCRIPT_NAMES)) {
		const name = names.find(
			(n) =>
				typeof scripts[n] === "string" &&
				scripts[n].trim() &&
				!(n === "test" && NPM_INIT_PLACEHOLDER.test(scripts[n])),
		);
		if (name)
			found[/** @type {keyof typeof SCRIPT_NAMES} */ (command)] = {
				...scriptCommand(root, command, name),
				from: "package.json",
			};
	}
	if (!found.test && hasPytestConfig(root))
		found.test = { command: "python3 -m pytest", from: "pytest config" };
	else if (!found.test && hasNodeTestFile(root))
		found.test = {
			command: "node --test",
			from: "node --test's default test files",
		};
	return found;
}

/**
 * @param {string[]} argv
 * @returns {0|1|2}
 */
function main(argv) {
	const [verb, command, ...more] = argv;
	if (verb !== "check-staged" || command === undefined || more.length > 0) {
		writeFd(2, "usage: infer-commands.js check-staged <command>\n");
		return 2;
	}
	const named = `pre-commit: check_staged "${command}" (.claude/workflow-core.json)`;
	try {
		const verdict = classifyCheckStaged(process.cwd(), command, {
			inferred: false,
		});
		if (verdict.kind !== "refused") return 0;
		writeFd(2, `${named} ${verdict.refusal}\n`);
	} catch (err) {
		const why =
			err instanceof PackageReadError
				? `${err.fault}. Fix it, or declare check_staged in .claude/workflow-core.json as '${OWN_FLAGS}' or another command naming no ${PACKAGE_MANAGERS.join(", ")} or biome and with no expansion or glob for a command's name, no parallel and no shell reading stdin, which the hook checks without reading package.json.`
				: caught(err).message;
		writeFd(2, `${named} cannot be checked: ${why}\n`);
	}
	return 1;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = {
	inferCommands,
	isLintStagedCommand,
	classifyCheckStaged,
};
