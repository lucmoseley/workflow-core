/*
 * pip-install.js — the guard-pip-install core (#5232): the Python install
 * boundary, the twin of lib/npm-install.js's checks 1 and 2.
 *
 * It judges `pip install` (`pip`, `pip3`, `pip3.12`, a venv's `bin/pip`),
 * `python -m pip install` (any `python`, `python3`, `python3.12`), `uv add`
 * and `uv pip install`. Two refusals, both denies (mantahostels#103), in the
 * order they run.
 *
 *   1. THE EXECUTION WINDOW. An install naming a package the repo does not
 *      already declare must carry `--only-binary :all:` (uv: `--no-build`, or
 *      `--only-binary :all:` on `uv pip install`). pip's own "Secure installs" guidance sets the flag
 *      (docs/practice/dependency-and-release-management.md). This runs FIRST
 *      because it is local and certain.
 *
 *   2. NEW-PACKAGE LEGITIMACY. For each new name, normalised per PEP 503,
 *      three facts, keyless (`docs/working-contract.md` §No paid research or
 *      data APIs):
 *
 *        - the name exists        `https://pypi.org/pypi/<name>/json` is 200
 *        - its first upload, the earliest `upload_time_iso_8601` across its
 *          releases, is at least the floor's days old       (the same call)
 *        - last month's downloads clear the floor
 *                                 `https://pypistats.org/api/packages/<name>/recent`
 *
 *      The floors, the budget, the escape and the refusal texts are
 *      lib/package-vetting.js's, shared with the npm core. A name pypistats
 *      has no record of has no download history, and reads as 0.
 *
 * WHAT IS DECLARED. A name in a `requirements*.txt` or `requirements*.in`
 * (git's pathspec, so `requirements/dev.txt` too) or in `pyproject.toml`'s
 * `[project].dependencies`, `[project.optional-dependencies]` or
 * `[dependency-groups]`, tracked or untracked, at the session tree's root. An
 * install naming only declared packages, or none — `pip install -r <file>`,
 * `pip install --group dev` — is untouched. A file that will not read
 * declares nothing, so its packages are vetted like any new one.
 *
 * LIMITS
 *  - Its lib/guard-cores.json row runs it only on a call one of its `if`
 *    clauses admits: `if: Bash(*pip*)`, `if: Bash(*uv *)`.
 *  - Only a PyPI requirement is vetted. A local path, a wheel or sdist file,
 *    a VCS or other URL and a `name @ url` direct reference cannot be asked of
 *    PyPI, so they are DENIED as unvettable — `pip install -e .` included.
 *  - PyPI is asked whatever index the command names: `-i`, `--index-url`,
 *    `--extra-index-url` and `-f` are read past, never judged.
 *  - Options are read by their whole spelling. pip's parser (optparse) also
 *    takes an unambiguous abbreviation: `--only-bin :all:` reads as no
 *    `--only-binary`, and refuses; `--req file` reads `file` as a spec.
 *    `PIP_ONLY_BINARY`, `UV_NO_BUILD` and a
 *    pip.conf are not read either.
 *  - A wrapper hides the install: `sudo`, `env`, `xargs`, a script. Only a
 *    command's own first word is read. `pipx`, `uv tool install`, `uv run
 *    --with` and `uvx` are not read.
 *  - Only the named packages are vetted, never what they depend on.
 *  - A PyPI call the host cannot start (`curl` missing) reads as an
 *    unreachable registry, so it DENIES, and is logged.
 */

const path = require("node:path");
const { spliceCmd } = require("./guard-verdict.js");
const { requiredGroup } = require("./regex-group.js");
const {
	UNREACHABLE,
	ageOf,
	downloadsOf,
	jsonOf,
	legitimacy,
	registryTexts,
	unvettableText,
	vettedRule,
} = require("./package-vetting.js");
const { parseCommand, walkCommands } = require("./shell-parse.js");
const { literal, scanFlags } = require("./shell-words.js");

/**
 * @typedef {{ missing: true } | { code: number | null, body: string }} Http
 *   one GET: `missing` where its program could not be started, else the HTTP
 *   status (null where no answer came) and the body
 * @typedef {object} PipInstallPorts
 * @property {(name: string) => Http} pypi PyPI's JSON for a normalised name
 * @property {(name: string) => Http} stats pypistats' recent downloads for it
 * @typedef {import("./kit-context.js").KitContext & PipInstallPorts
 *   & import("./package-vetting.js").VettingPorts
 *   & Pick<import("./core-contract.js").CoreContext, "tree">} PipInstallContext
 * @typedef {import("./package-vetting.js").RegistryVerdict} RegistryVerdict
 * @typedef {{ specs: string[], shut: boolean, tool: string }} Install
 *   the specs an install names, whether its build window is shut, and the
 *   flag that shuts it, as the refusal names it
 */

/* ----------------------------------------------------------------------- */
/* The refusals.                                                           */
/* ----------------------------------------------------------------------- */

const PYPI_TEXTS = registryTexts({
	exists: "exists on PyPI",
	unreached: "PyPI could not be reached to check",
});

/**
 * @param {string[]} fresh
 * @param {string[]} unvettable
 * @param {string} flag
 * @param {PipInstallContext} ctx
 */
const windowText = (fresh, unvettable, flag, ctx) =>
	`This install adds ${fresh.length + unvettable.length} package(s) this repo does not yet declare — ${[...fresh, ...unvettable].join(" ")} — and does not carry \`${flag}\`: @CMD@

Without it, a package published as a source distribution runs its own build code — \`setup.py\` or its build backend — as you, before anything reads a byte of it. A wheel runs nothing at install.

Re-run with \`${flag}\`. A package that publishes no wheel then fails to install, and whether to build it from source is the founder's call.

Then declare it in the repo's requirements or \`pyproject.toml\`.

${vettedRule(ctx)}`;

/**
 * @param {string} text
 * @param {string} segment masked
 */
const refuse = (text, segment) => ({ deny: spliceCmd(segment, text) });

/* ----------------------------------------------------------------------- */
/* Requirement specs.                                                       */
/* ----------------------------------------------------------------------- */

/* PEP 508's name; it ends on a letter or digit. */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*/;
const ARCHIVE_RE = /\.(whl|zip|tar|tgz|tar\.gz|tar\.bz2|tar\.xz)$/i;
/* A version clause, a marker, or the legacy parenthesised version. */
const AFTER_NAME_RE = /^(===|==|!=|~=|<=|>=|<|>|;|\()/;

/**
 * PEP 503's normalised name.
 * @param {string} name
 */
const normalise = (name) => name.toLowerCase().replace(/[-_.]+/g, "-");

/**
 * The normalised PyPI name a requirement spec names, or null where the spec
 * is no PyPI requirement.
 * @param {string} spec
 * @returns {string | null}
 */
function specName(spec) {
	const s = spec.trim();
	if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(s) || ARCHIVE_RE.test(s))
		return null;
	const name = NAME_RE.exec(s)?.[0] ?? "";
	if (name === "" || /[._-]$/.test(name)) return null;
	const rest = afterExtras(s.slice(name.length).trimStart());
	if (rest === null || (rest !== "" && !AFTER_NAME_RE.test(rest))) return null;
	return normalise(name);
}

/**
 * What follows a name's `[extras]`, or the text itself where it has none;
 * null where the bracket never closes.
 * @param {string} text
 * @returns {string | null}
 */
function afterExtras(text) {
	if (!text.startsWith("[")) return text;
	const close = text.indexOf("]");
	return close < 0 ? null : text.slice(close + 1).trimStart();
}

/* ----------------------------------------------------------------------- */
/* What the repo declares.                                                  */
/* ----------------------------------------------------------------------- */

const DECLARING = ["requirements*.txt", "requirements*.in", "pyproject.toml"];

/**
 * Every normalised name the session tree's requirements files and
 * `pyproject.toml` declare.
 * @param {PipInstallContext} ctx
 * @returns {Set<string>}
 */
function loadDeclared(ctx) {
	const tree = ctx.tree();
	const listed = tree.git(
		[
			"ls-files",
			"--cached",
			"--others",
			"--exclude-standard",
			"-z",
			"--",
			...DECLARING,
		],
		[],
	);
	/** @type {string[]} */
	let files;
	if (listed.ok) files = listed.out.split("\0").filter(Boolean);
	else {
		ctx.log(
			`git ls-files did not answer (${listed.why}) — reading the root's requirements.txt, requirements.in and pyproject.toml alone`,
		);
		files = ["requirements.txt", "requirements.in", "pyproject.toml"];
	}
	/** @type {Set<string>} */
	const names = new Set();
	for (const rel of [...new Set(files)]) {
		const text = readDeclaring(tree, rel, ctx);
		if (text === null) continue;
		const specs =
			path.basename(rel) === "pyproject.toml"
				? pyprojectSpecs(text)
				: requirementLines(text);
		for (const spec of specs) {
			const name = specName(spec);
			if (name !== null) names.add(name);
		}
	}
	return names;
}

/**
 * @param {import("./guard-host-ports.js").TreePorts} tree
 * @param {string} rel
 * @param {PipInstallContext} ctx
 * @returns {string | null}
 */
function readDeclaring(tree, rel, ctx) {
	try {
		return tree.readText(rel);
	} catch {
		ctx.log(`${rel} did not read — its packages are vetted as new`);
		return null;
	}
}

/**
 * The requirement lines of a requirements file: comments cut, continuations
 * joined, option lines (`-r`, `-e`, `--hash`, …) dropped.
 * @param {string} text
 * @returns {string[]}
 */
function requirementLines(text) {
	return text
		.replace(/\\\r?\n/g, " ")
		.split(/\r?\n/)
		.map((line) => line.replace(/(^|\s)#.*$/, "").trim())
		.filter((line) => line !== "" && !line.startsWith("-"));
}

/* Each a table's key path, JSON-spelt, so a quoted `.` stays inside its key. */
const TARGET_TABLES = new Set(
	[["project", "optional-dependencies"], ["dependency-groups"]].map((keys) =>
		JSON.stringify(keys),
	),
);

/** @param {string[]} keys */
const isTarget = (keys) => TARGET_TABLES.has(JSON.stringify(keys));

/**
 * The requirement strings of `pyproject.toml`'s three dependency tables. A
 * reader of just that much TOML: a table header, a `key = [` array, a
 * `key = {` inline table read as the table `<header>.key` (#5238), and the
 * strings in their arrays outside any further inline table, which is PEP 735's
 * `{ include-group = … }` and names no package. What it misreads it drops, so
 * the package is vetted as new.
 * @param {string} text
 * @returns {string[]}
 */
function pyprojectSpecs(text) {
	/** @type {string[]} */
	const specs = [];
	/** @type {string[] | null} */
	let table = [];
	for (let at = 0; at < text.length; ) {
		const end = lineEnd(text, at);
		const line = text.slice(at, end);
		const kv = KEY_VALUE_RE.exec(line);
		if (/^\s*\[/.test(line)) table = tableOf(line);
		else if (kv !== null) {
			const open = at + kv[0].length - 1;
			const read = valueStrings(text, open);
			const key = requiredGroup(kv, 1, KEY_VALUE_RE);
			if (isDependencyValue(table, key, text[open]))
				specs.push(...read.strings);
			at = lineEnd(text, read.end) + 1;
			continue;
		}
		at = end + 1;
	}
	return specs;
}

const KEY_VALUE_RE = /^\s*("[^"]*"|'[^']*'|[A-Za-z0-9_-]+)\s*=\s*[[{]/;
const HEADER_RE = /^\s*\[([^[\]]+)\]\s*(#.*)?$/;
/* A comment, a basic or literal one-line string, or a bracket or brace. */
const TOKEN_RE = /#[^\n]*|"((?:\\.|[^"\\\n])*)"|'([^'\n]*)'|[{}[\]]/g;

/**
 * @param {string} text
 * @param {number} at
 */
const lineEnd = (text, at) => {
	const nl = text.indexOf("\n", at);
	return nl < 0 ? text.length : nl;
};

/**
 * A header line's table path: null for an array of tables, `[[…]]`, or a
 * header it cannot parse, which no key under it escapes into a target table.
 * @param {string} line
 * @returns {string[] | null}
 */
const tableOf = (line) => {
	const name = HEADER_RE.exec(line)?.[1];
	return name === undefined ? null : keyPath(name);
};

/* One key of a dotted key: basic with no escape, literal, or bare. */
const KEY_PART_RE = /\s*(?:"([^"\\]*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*(\.|$)/y;

/**
 * A dotted key's keys, unquoted: null where it is not one this reader spells.
 * @param {string} spelt
 * @returns {string[] | null}
 */
function keyPath(spelt) {
	/** @type {string[]} */
	const keys = [];
	const part = new RegExp(KEY_PART_RE.source, "y");
	for (;;) {
		const m = part.exec(spelt);
		if (m === null) return null;
		keys.push(m[1] ?? m[2] ?? requiredGroup(m, 3, KEY_PART_RE));
		if (m[4] !== ".") return keys;
	}
}

/**
 * Whether `key = [` under `table` is `[project]`'s `dependencies` or an array
 * of a target table, or `key = {` is an inline target table.
 * @param {string[] | null} table [] above the first header
 * @param {string} key as written, quoted or bare
 * @param {string | undefined} opener `[` or `{`
 */
const isDependencyValue = (table, key, opener) => {
	const name = keyPath(key);
	if (table === null || name === null) return false;
	if (opener === "[")
		return (
			(JSON.stringify(table) === '["project"]' && name[0] === "dependencies") ||
			isTarget(table)
		);
	return isTarget([...table, ...name]);
};

/**
 * A string token's text: group 1 for a basic string, 2 for a literal one.
 * @param {RegExpExecArray} m
 */
const stringOf = (m) =>
	m[0].startsWith('"')
		? requiredGroup(m, 1, TOKEN_RE)
		: requiredGroup(m, 2, TOKEN_RE);

/**
 * What each bracket and brace adds to the array and inline-table depths.
 * @type {Record<string, [number, number]>}
 */
const NESTING = { "[": [1, 0], "]": [-1, 0], "{": [0, 1], "}": [0, -1] };

/**
 * The strings directly in the arrays of the TOML array or inline table opening
 * at `open`, and where it closes. A value that never closes, or an inline table
 * a header line breaks into, reads as no strings, ending where the header
 * starts.
 * @param {string} text
 * @param {number} open the index of its `[` or `{`
 * @returns {{ strings: string[], end: number }}
 */
function valueStrings(text, open) {
	/** @type {string[]} */
	const strings = [];
	const stringBraces = text[open] === "{" ? 1 : 0;
	let brackets = 0;
	let braces = 0;
	const tokens = new RegExp(TOKEN_RE.source, "g");
	tokens.lastIndex = open;
	for (let m = tokens.exec(text); m !== null; m = tokens.exec(text)) {
		if (stringBraces === 1 && opensHeader(text, m, brackets))
			return { strings: [], end: text.lastIndexOf("\n", m.index) };
		const step = NESTING[m[0]];
		if (step !== undefined) {
			brackets += step[0];
			braces += step[1];
		} else if (
			!m[0].startsWith("#") &&
			brackets === 1 &&
			braces === stringBraces
		)
			strings.push(stringOf(m));
		if ((stringBraces === 1 ? braces : brackets) === 0)
			return { strings, end: m.index };
	}
	return { strings: [], end: text.length };
}

/**
 * Whether token `m`, met outside any array, is a `[` opening a later line: a
 * table header.
 * @param {string} text
 * @param {RegExpExecArray} m
 * @param {number} brackets
 */
const opensHeader = (text, m, brackets) => {
	if (m[0] !== "[" || brackets !== 0) return false;
	const nl = text.lastIndexOf("\n", m.index - 1);
	return nl >= 0 && text.slice(nl + 1, m.index).trim() === "";
};

/* ----------------------------------------------------------------------- */
/* PyPI.                                                                    */
/* ----------------------------------------------------------------------- */

/**
 * One package's PyPI verdict. Its age is asked first, so a package too young
 * to pass costs no downloads call.
 * @param {string} name normalised
 * @param {PipInstallContext} ctx
 * @returns {RegistryVerdict}
 */
function registryVerdict(name, ctx) {
	const age = ageVerdict(name, ctx);
	return age.kind === "ok" ? downloadsVerdict(name, ctx) : age;
}

/**
 * PyPI's answer: missing, unreachable, young, or ok to go on. A name with no
 * file uploaded under it has nothing to install, so it reads as missing.
 * @param {string} name
 * @param {PipInstallContext} ctx
 * @returns {RegistryVerdict}
 */
function ageVerdict(name, ctx) {
	const got = ctx.pypi(name);
	if ("missing" in got) {
		ctx.log(
			`curl not found — legitimacy of ${name} could not be checked, denying`,
		);
		return UNREACHABLE;
	}
	if (got.code === 404) return { kind: "missing", n: "" };
	if (got.code !== 200) return UNREACHABLE;
	const body = jsonOf(got.body);
	if (body === null || typeof body !== "object" || !("releases" in body))
		return UNREACHABLE;
	const first = firstUpload(body.releases);
	if (first === undefined) return UNREACHABLE;
	if (first === null) return { kind: "missing", n: "" };
	return ageOf(first, ctx);
}

/**
 * @param {unknown} t
 * @returns {t is string}
 */
const isDate = (t) => typeof t === "string" && !Number.isNaN(Date.parse(t));

/**
 * The earliest upload time across every release's files: null where there
 * is no file, undefined where `releases` is not the shape PyPI gives.
 * @param {unknown} releases
 * @returns {string | null | undefined}
 */
function firstUpload(releases) {
	if (releases === null || typeof releases !== "object") return;
	const lists = Object.values(releases);
	if (!lists.every(Array.isArray)) return;
	/** @type {unknown[]} */
	const times = lists.flat().map((file) => file?.upload_time_iso_8601);
	const dated = times.filter(isDate);
	if (dated.length < times.length) return;
	return dated.reduce(
		(/** @type {string | null} */ first, t) =>
			first === null || Date.parse(t) < Date.parse(first) ? t : first,
		null,
	);
}

/**
 * pypistats' answer: unreachable, thin, or ok.
 * @param {string} name
 * @param {PipInstallContext} ctx
 * @returns {RegistryVerdict}
 */
function downloadsVerdict(name, ctx) {
	const got = ctx.stats(name);
	if ("missing" in got) {
		ctx.log(
			`curl not found — download history of ${name} could not be checked, denying`,
		);
		return UNREACHABLE;
	}
	if (got.code === 404) return downloadsOf(0);
	if (got.code !== 200) return UNREACHABLE;
	const body = jsonOf(got.body);
	const data =
		body !== null && typeof body === "object" && "data" in body
			? body.data
			: undefined;
	return downloadsOf(
		data !== null && typeof data === "object" && "last_month" in data
			? data.last_month
			: undefined,
	);
}

/* ----------------------------------------------------------------------- */
/* Reading the commands.                                                    */
/* ----------------------------------------------------------------------- */

/* pip's options that take a value, by their whole spelling: its general
 * options and `install`'s (pip 25). */
const PIP_VALUED = new Set(
	`--python --log --log-file --proxy --retries --timeout --exists-action
--trusted-host --cert --client-cert --cache-dir --use-feature --use-deprecated
--keyring-provider --resume-retries --requirement --constraint --editable
--target --platform --python-version --implementation --abi --root --prefix
--src --upgrade-strategy --config-settings --global-option --no-binary
--only-binary --progress-bar --root-user-action --report --index-url
--extra-index-url --find-links --group --build-constraint --local-log`.split(
		/\s+/,
	),
);
/** The scanFlags spec of pip's value-taking options. */
const PIP_ARGV = [...PIP_VALUED, ..."-r -c -e -t -C -i -f".split(" ")].join(
	" ",
);

/* uv's options that take a value, across its global options, `uv add` and
 * `uv pip install` (uv 0.9), less `UV_PIP_ONLY`. */
const UV_VALUED = new Set(
	`--cache-dir --directory --project --config-file --color --python-preference
--allow-insecure-host --python --requirements --requirement --constraints
--constraint --overrides --build-constraints --marker --optional --group
--bounds --rev --tag --branch --extra --package --script --index --index-url
--default-index --extra-index-url --find-links --index-strategy
--keyring-provider --config-setting --config-settings --resolution
--prerelease --exclude-newer --exclude-newer-package --link-mode
--reinstall-package --refresh-package --upgrade-package --no-build-package
--no-binary-package --no-build-isolation-package --no-install-package
--config-settings-package --python-version --python-platform --target
--prefix --torch-backend --fork-strategy`.split(/\s+/),
);
/* The ones that take a value on `uv pip install` and are plain flags on
 * `uv add`. */
const UV_PIP_ONLY = "--only-binary --no-binary --editable -e";
/** The scanFlags specs of uv's value-taking options, by subcommand. */
const UV_ADD_ARGV = [
	...UV_VALUED,
	..."-r -c -m -b -i -f -C -P -p".split(" "),
].join(" ");
const UV_PIP_ARGV = `${UV_ADD_ARGV} ${UV_PIP_ONLY}`;

/** @typedef {{ name: string, value: string }} Opt */

/**
 * An argv read into its option values, by name, and its positional words,
 * through scanFlags.
 * @param {string[]} words
 * @param {string} spec the value-taking options, as scanFlags reads them
 */
function parseArgv(words, spec) {
	/** @type {Opt[]} */
	const opts = [];
	/** @type {string[]} */
	const args = [];
	scanFlags(spec, words, (kind, name, value) => {
		if (kind === "arg") args.push(value);
		else opts.push({ name, value });
	});
	return { opts, args };
}

/**
 * Whether the binary-only options shut the build window: an `--only-binary`
 * list holding `:all:`, not reopened by `:none:` or a later `--no-binary`.
 * @param {Opt[]} opts
 */
function isBinaryOnly(opts) {
	let shut = false;
	for (const { name, value } of opts) {
		const list = value.split(",");
		if (name === "--only-binary") {
			if (list.includes(":all:")) shut = true;
			if (list.includes(":none:")) shut = false;
		} else if (name === "--no-binary" && list.some((v) => v !== ":none:"))
			shut = false;
	}
	return shut;
}

/**
 * The specs a pip argv's `install` names, or null where it is no install.
 * `-e` names a spec of its own.
 * @param {string[]} words the words after `pip`
 * @returns {Install | null}
 */
function parsePip(words) {
	const { opts, args } = parseArgv(words, PIP_ARGV);
	if (args[0] !== "install") return null;
	if (opts.some((o) => o.name === "--help" || o.name === "-h")) return null;
	return {
		specs: [...args.slice(1), ...editables(opts)],
		shut: isBinaryOnly(opts),
		tool: "--only-binary :all:",
	};
}

/**
 * @param {Opt[]} opts
 * @returns {string[]}
 */
const editables = (opts) =>
	opts
		.filter((o) => o.name === "--editable" || o.name === "-e")
		.map((o) => o.value);

/**
 * The specs a uv argv's `add` or `pip install` names, or null where it is
 * neither.
 * @param {string[]} words the words after `uv`
 * @returns {Install | null}
 */
function parseUv(words) {
	const { args: sub } = parseArgv(words, UV_ADD_ARGV);
	const add = sub[0] === "add";
	const { opts, args } = parseArgv(words, add ? UV_ADD_ARGV : UV_PIP_ARGV);
	const has = (/** @type {string} */ name) => opts.some((o) => o.name === name);
	if (has("--help") || has("-h")) return null;
	const noBuild = has("--no-build");
	if (add)
		return {
			specs: args.slice(1),
			shut: noBuild && !has("--no-binary"),
			tool: "--no-build",
		};
	if (args[0] === "pip" && args[1] === "install")
		return {
			specs: [...args.slice(2), ...editables(opts)],
			shut: noBuild || isBinaryOnly(opts),
			tool: "--no-build",
		};
	return null;
}

/**
 * The words after a Python interpreter's `-m pip`, or null where it runs no
 * pip.
 * @param {string[]} words the words after the interpreter
 * @returns {string[] | null}
 */
function pythonPip(words) {
	for (let i = 0, w = words[0]; w !== undefined; w = words[i]) {
		const step = pythonOption(w, words, i);
		if ("pip" in step) return step.pip;
		i = step.next;
	}
	return null;
}

/** @type {{ pip: null }} */
const NO_PIP = { pip: null };

/**
 * What the interpreter word at `i` makes of the command: the words after
 * `-m pip`, no pip at all (a script, `-`, `--`, `-c`, another module), or the
 * index of the next word to read, past an option's value.
 * @param {string} w the word at `i`
 * @param {string[]} words
 * @param {number} i
 * @returns {{ pip: string[] | null } | { next: number }}
 */
function pythonOption(w, words, i) {
	if (!w.startsWith("-") || w === "-" || w === "--") return NO_PIP;
	if (w === "--check-hash-based-pycs") return { next: i + 2 };
	const ends = w.startsWith("--") ? null : clusterEnd(w);
	if (ends === null) return { next: i + 1 };
	if (ends.letter === "c") return NO_PIP;
	const valueAt = ends.rest === "" ? i + 1 : i;
	if (ends.letter !== "m") return { next: valueAt + 1 };
	const value = ends.rest === "" ? words[valueAt] : ends.rest;
	return value === "pip" ? { pip: words.slice(valueAt + 1) } : NO_PIP;
}

/**
 * The first letter of a CPython short-option cluster that takes a value —
 * `c`, `m`, `W` or `X` — and the rest of the word after it, or null.
 * @param {string} w
 */
function clusterEnd(w) {
	const at = w.slice(1).search(/[cmWX]/);
	return at < 0 ? null : { letter: w[at + 1], rest: w.slice(at + 2) };
}

/**
 * What a command installs.
 * @param {string[]} words literal
 * @returns {Install | null}
 */
function parseInstall(words) {
	const [head = "", ...rest] = words;
	const name = path.basename(head);
	if (/^pip(\d+(\.\d+)*)?$/.test(name)) return parsePip(rest);
	if (/^python(\d+(\.\d+)*)?$/.test(name)) {
		const pip = pythonPip(rest);
		return pip === null ? null : parsePip(pip);
	}
	if (name === "uv") return parseUv(rest);
	return null;
}

/* ----------------------------------------------------------------------- */
/* The verdict.                                                             */
/* ----------------------------------------------------------------------- */

/**
 * @param {Install} install
 * @param {string} segment masked
 * @param {() => Set<string>} declared
 * @param {PipInstallContext} ctx
 * @returns {{ deny: string } | null}
 */
function judge(install, segment, declared, ctx) {
	if (install.specs.length === 0) return null;
	/** @type {string[]} */
	const fresh = [];
	/** @type {string[]} */
	const unvettable = [];
	for (const spec of install.specs) {
		const name = specName(spec);
		if (name === null) unvettable.push(spec);
		else if (!declared().has(name) && !fresh.includes(name)) fresh.push(name);
	}
	if (fresh.length + unvettable.length === 0) return null;

	/* Check 1. It counts the unvettable specs too: a local path or a URL
	 * builds as readily as an sdist. */
	if (!install.shut)
		return refuse(windowText(fresh, unvettable, install.tool, ctx), segment);

	/* Check 2. The stand-down comes before every refusal it can raise. */
	if (ctx.allowNewPackage) return null;
	const [first] = unvettable;
	if (first !== undefined)
		return refuse(
			unvettableText(
				first,
				"A local path, a wheel or sdist file, a VCS or other URL and a `name @ url` direct reference",
				ctx,
			),
			segment,
		);
	const failed = legitimacy(
		fresh,
		ctx,
		(name) => registryVerdict(name, ctx),
		PYPI_TEXTS,
	);
	return failed === null ? null : refuse(failed, segment);
}

/**
 * @param {string} command
 * @param {PipInstallContext} ctx
 * @returns {import("./guard-entry.js").Decision}
 */
function decide(command, ctx) {
	const parsed = parseCommand(command);
	/** @type {Set<string> | undefined} */
	let names;
	const declared = () => {
		if (names === undefined) names = loadDeclared(ctx);
		return names;
	};
	/** @type {{ deny: string } | null} */
	let verdict = null;
	walkCommands(
		parsed,
		(cmd) => {
			if (verdict !== null) return;
			/* Quoted spans put back: `"requests>=2"` is judged by its name. */
			const words = cmd.words.map((w) => literal(w, parsed.spans).text);
			const install = parseInstall(words);
			if (install !== null)
				verdict = judge(install, cmd.segment, declared, ctx);
		},
		ctx,
	);
	return verdict;
}

module.exports = { field: "command", noun: "command", decide };
