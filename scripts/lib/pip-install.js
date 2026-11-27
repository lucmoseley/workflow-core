const path = require("node:path");
const { spliceCmd } = require("./guard-verdict.js");
const { requiredGroup } = require("./regex-group.js");
const {
	BUDGET,
	OK,
	UNREACHABLE,
	ageOf,
	downloadsOf,
	idleOf,
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
 * @typedef {object} PipInstallPorts
 * @property {(name: string) => Http} pypi
 * @property {(name: string) => Http} status
 * @property {(name: string) => Http} stats
 * @typedef {import("./kit-context.js").KitContext & PipInstallPorts
 *   & import("./package-vetting.js").VettingPorts
 *   & Pick<import("./core-contract.js").CoreContext, "tree">} PipInstallContext
 * @typedef {import("./package-vetting.js").RegistryVerdict} RegistryVerdict
 * @typedef {{ specs: string[], local: string[], shut: boolean, tool: string }} Install
 */

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
 * @param {string} segment
 */
const refuse = (text, segment) => ({ deny: spliceCmd(segment, text) });

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*/;
const ARCHIVE_RE = /\.(whl|zip|tar|tgz|tar\.gz|tar\.bz2|tar\.xz)$/i;
const AFTER_NAME_RE = /^(===|==|!=|~=|<=|>=|<|>|;|\()/;

/** @param {string} name */
const normalise = (name) => name.toLowerCase().replace(/[-_.]+/g, "-");

/**
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
 * @param {string} text
 * @returns {string | null}
 */
function afterExtras(text) {
	if (!text.startsWith("[")) return text;
	const close = text.indexOf("]");
	return close < 0 ? null : text.slice(close + 1).trimStart();
}

const DECLARING = ["requirements*.txt", "requirements*.in", "pyproject.toml"];

/**
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
	const got = tree.read(rel);
	if (got.state === "unreadable")
		ctx.log(`${rel} did not read — its packages are vetted as new`);
	return got.state === "read" ? got.data : null;
}

/**
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

const TARGET_TABLES = new Set(
	[["project", "optional-dependencies"], ["dependency-groups"]].map((keys) =>
		JSON.stringify(keys),
	),
);

/** @param {string[]} keys */
const isTarget = (keys) => TARGET_TABLES.has(JSON.stringify(keys));

/**
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
		at = pastLine(text, at, end);
	}
	return specs;
}

/**
 * @param {string} text
 * @param {number} at
 * @param {number} end
 */
function pastLine(text, at, end) {
	if (!MULTI_LINE_OPENER.test(text.slice(at, end))) return end + 1;
	for (const token of tokensFrom(text, at)) {
		if (token.match.index >= end) break;
		if (token.end > end) return lineEnd(text, token.end) + 1;
	}
	return end + 1;
}

/**
 * @param {string} text
 * @param {number} at
 * @returns {Generator<{ match: RegExpExecArray, end: number, multiLine: boolean }>}
 */
function* tokensFrom(text, at) {
	const tokens = new RegExp(TOKEN_RE.source, "g");
	tokens.lastIndex = at;
	for (let m = tokens.exec(text); m !== null; m = tokens.exec(text)) {
		const multiLine = OPENER_TOKEN_RE.test(m[0]);
		const end = multiLine
			? multiLineClose(text, m.index)
			: m.index + m[0].length;
		tokens.lastIndex = end;
		yield { match: m, end, multiLine };
	}
}

/**
 * @param {string} text
 * @param {number} open
 */
function multiLineClose(text, open) {
	const quote = text[open];
	const delimiter = text.slice(open, open + 3);
	for (let i = open + 3; i < text.length; ) {
		if (quote === '"' && text[i] === "\\") i += 2;
		else if (text.startsWith(delimiter, i)) {
			let close = i + 3;
			for (let extra = 0; extra < 2 && text[close] === quote; extra++) close++;
			return close;
		} else i++;
	}
	return text.length;
}

const MULTI_LINE_OPENER = /"""|'''/;
const OPENER_TOKEN_RE = new RegExp(`^(?:${MULTI_LINE_OPENER.source})$`);
const KEY_VALUE_RE = /^\s*("[^"]*"|'[^']*'|[A-Za-z0-9_-]+)\s*=\s*[[{]/;
const HEADER_RE = /^\s*\[([^[\]]+)\]\s*(#[^\n]*)?$/;
const TOKEN_RE = /#[^\n]*|"""|'''|"((?:\\.|[^"\\\n])*)"|'([^'\n]*)'|[{}[\]]/g;

/**
 * @param {string} text
 * @param {number} at
 */
const lineEnd = (text, at) => {
	const nl = text.indexOf("\n", at);
	return nl < 0 ? text.length : nl;
};

/**
 * @param {string} line
 * @returns {string[] | null}
 */
const tableOf = (line) => {
	const name = HEADER_RE.exec(line)?.[1];
	return name === undefined ? null : keyPath(name);
};

const KEY_PART_RE = /\s*(?:"([^"\\]*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*(\.|$)/y;

/**
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
 * @param {string[] | null} table
 * @param {string} key
 * @param {string | undefined} opener
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

/** @param {RegExpExecArray} m */
const stringOf = (m) =>
	m[0].startsWith('"')
		? requiredGroup(m, 1, TOKEN_RE)
		: requiredGroup(m, 2, TOKEN_RE);

/** @type {Record<string, [number, number]>} */
const NESTING = { "[": [1, 0], "]": [-1, 0], "{": [0, 1], "}": [0, -1] };

/**
 * @param {string} text
 * @param {number} open
 * @returns {{ strings: string[], end: number }}
 */
function valueStrings(text, open) {
	/** @type {string[]} */
	const strings = [];
	const stringBraces = text[open] === "{" ? 1 : 0;
	let brackets = 0;
	let braces = 0;
	for (const { match: m, multiLine } of tokensFrom(text, open)) {
		if (stringBraces === 1 && opensHeader(text, m, brackets))
			return { strings: [], end: text.lastIndexOf("\n", m.index) };
		const step = NESTING[m[0]];
		if (step !== undefined) {
			brackets += step[0];
			braces += step[1];
		} else if (
			!multiLine &&
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
 * @param {string} text
 * @param {RegExpExecArray} m
 * @param {number} brackets
 */
const opensHeader = (text, m, brackets) => {
	if (m[0] !== "[" || brackets !== 0) return false;
	const nl = text.lastIndexOf("\n", m.index - 1);
	return nl >= 0 && text.slice(nl + 1, m.index).trim() === "";
};

/**
 * @param {string} name
 * @param {PipInstallContext} ctx
 * @param {() => boolean} spent
 * @returns {RegistryVerdict}
 */
function registryVerdict(name, ctx, spent) {
	for (const check of [uploadsVerdict, statusVerdict, downloadsVerdict]) {
		const v = spent() ? BUDGET : check(name, ctx);
		if (v.kind !== "ok") return v;
	}
	return OK;
}

const INACTIVE = new Set(["archived", "deprecated", "quarantined"]);

/**
 * @param {string} name
 * @param {PipInstallContext} ctx
 * @returns {RegistryVerdict}
 */
function statusVerdict(name, ctx) {
	const got = ctx.status(name);
	if ("missing" in got) {
		ctx.log(
			`curl not found — project status of ${name} could not be checked, denying`,
		);
		return UNREACHABLE;
	}
	if (got.code !== 200) return UNREACHABLE;
	const body = jsonOf(got.body);
	if (body === null || typeof body !== "object") return UNREACHABLE;
	if (!("project-status" in body)) return OK;
	const marker = body["project-status"];
	if (marker === null || typeof marker !== "object") return UNREACHABLE;
	if (!("status" in marker) || marker.status === "active") return OK;
	const { status } = marker;
	return typeof status === "string" && INACTIVE.has(status)
		? { kind: "inactive", n: status }
		: UNREACHABLE;
}

/**
 * @param {string} name
 * @param {PipInstallContext} ctx
 * @returns {RegistryVerdict}
 */
function uploadsVerdict(name, ctx) {
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
	const span = uploadSpan(body.releases);
	if (span === undefined) return UNREACHABLE;
	if (span === null) return { kind: "missing", n: "" };
	const age = ageOf(span.first, ctx);
	return age.kind === "ok" ? idleOf(span.latest, ctx) : age;
}

/**
 * @param {unknown} t
 * @returns {t is string}
 */
const isDate = (t) => typeof t === "string" && !Number.isNaN(Date.parse(t));

/**
 * @param {unknown} releases
 * @returns {{ first: string, latest: string } | null | undefined}
 */
function uploadSpan(releases) {
	if (releases === null || typeof releases !== "object") return;
	const lists = Object.values(releases);
	if (!lists.every(Array.isArray)) return;
	/** @type {unknown[]} */
	const times = lists.flat().map((file) => file?.upload_time_iso_8601);
	const dated = times.filter(isDate);
	if (dated.length < times.length) return;
	const [first, ...rest] = dated.sort((a, b) => Date.parse(a) - Date.parse(b));
	if (first === undefined) return null;
	return { first, latest: rest.at(-1) ?? first };
}

/**
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
const PIP_ARGV = [...PIP_VALUED, ..."-r -c -e -t -C -i -f".split(" ")].join(
	" ",
);

const UV_HIDDEN =
	"--trusted-host --config-settings --python-preference --preview-features --python-fetch";

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
--prefix --torch-backend --fork-strategy ${UV_HIDDEN}`.split(/\s+/),
);
const UV_PIP_ONLY = "--only-binary --no-binary --editable -e";
const UV_ADD_ARGV = [
	...UV_VALUED,
	..."-r -c -m -b -i -f -C -P -p".split(" "),
].join(" ");
const UV_PIP_ARGV = `${UV_ADD_ARGV} ${UV_PIP_ONLY}`;

// measured uv 0.13.8 --help per runner, workflow-core#5239
const UV_TOOL_SHARED = `--index --default-index -i --index-url --extra-index-url -f
--find-links --index-strategy --keyring-provider -P --upgrade-package
--upgrade-group --resolution --prerelease --prerelease-package --fork-strategy
--exclude-newer --exclude-newer-package --no-sources-package
--reinstall-package --link-mode -C --config-setting --config-settings-package
--no-build-isolation-package --no-build-package --no-binary-package
--cache-dir --refresh-package -p --python --color --allow-insecure-host
--directory --project --config-file --python-platform ${UV_HIDDEN}`;
const UV_TOOL_RUN_ARGV = `${UV_TOOL_SHARED} --from -w --with --with-editable
--with-requirements -c --constraints -b --build-constraints --overrides
--env-file --torch-backend --constraint --build-constraint --override`;
const UV_RUN_ARGV = `${UV_TOOL_SHARED} --extra --no-extra --group --no-group
--only-group --no-editable-package --env-file -w --with --with-editable
--with-requirements --package`;
const UV_TOOL_INSTALL_ARGV = `${UV_TOOL_SHARED} -w --with --with-requirements
--with-editable --with-executables-from -c --constraints --overrides
--excludes -b --build-constraints --torch-backend --constraint
--build-constraint --override --exclude`;

const PIPX_ARGV = `--include-resources-from --upgrade-strategy --suffix
--python --fetch-python --preinstall --app --lock --index-url --pip-args
--cooldown --backend --output --python-args --with --spec -r --requirement
-i`;
const PIPX_INSTALL_RE = /^--ins(t(a(l(l)?)?)?)?$/;

/** @typedef {{ name: string, value: string }} Opt */

/**
 * @param {string[]} words
 * @param {string} spec
 * @param {number} [stopAfter]
 */
function parseArgv(words, spec, stopAfter = Number.POSITIVE_INFINITY) {
	/** @type {Opt[]} */
	const opts = [];
	/** @type {string[]} */
	const args = [];
	scanFlags(spec.replace(/\s+/g, " "), words, (kind, name, value) => {
		if (kind === "arg") {
			args.push(value);
			return args.length < stopAfter;
		}
		opts.push({ name, value });
		return true;
	});
	/** @param {string[]} names */
	const all = (...names) =>
		opts.filter((o) => names.includes(o.name)).map((o) => o.value);
	/** @param {string[]} names */
	const has = (...names) => opts.some((o) => names.includes(o.name));
	return { opts, args, has, all, help: has("--help") || has("-h") };
}

/** @param {Opt[]} opts */
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
 * @param {string[]} words
 * @returns {Install | null}
 */
function parsePip(words) {
	const { opts, args, all, help } = parseArgv(words, PIP_ARGV);
	if (args[0] !== "install" || help) return null;
	return {
		specs: args.slice(1),
		local: all("--editable", "-e"),
		shut: isBinaryOnly(opts),
		tool: "--only-binary :all:",
	};
}

/**
 * @param {string[]} words
 * @returns {Install | null}
 */
function parseUv(words) {
	const first = parseArgv(words, UV_ADD_ARGV);
	const [sub, verb] = first.args;
	if (sub === "add")
		return first.help
			? null
			: buildUvInstall(first.args.slice(1), [], first.has);
	if (sub === "pip" && verb === "install") {
		const { opts, args, has, all, help } = parseArgv(words, UV_PIP_ARGV);
		if (help) return null;
		const install = buildUvInstall(args.slice(2), all("--editable", "-e"), has);
		return { ...install, shut: has("--no-build") || isBinaryOnly(opts) };
	}
	if (sub === "run") return uvRun(words);
	if (sub === "tool" && (verb === "run" || verb === "uvx"))
		return uvToolRun(words, 3);
	if (sub === "tool" && verb === "install") return uvToolInstall(words);
	return null;
}

/**
 * @param {string[]} specs
 * @param {string[]} local
 * @param {(...names: string[]) => boolean} has
 * @returns {Install}
 */
const buildUvInstall = (specs, local, has) => ({
	specs,
	local,
	shut: has("--no-build") && !has("--no-binary"),
	tool: "--no-build",
});

/**
 * @param {(...names: string[]) => string[]} all
 * @param {string[]} names
 * @returns {string[]}
 */
const withSpecs = (all, ...names) => all(...names).flatMap(splitWith);

/**
 * @param {string} value
 * @returns {string[]}
 */
function splitWith(value) {
	/** @type {string[]} */
	const parts = [];
	let depth = 0;
	let from = 0;
	for (let i = 0; i < value.length; i++) {
		const c = value[i];
		if (c === "[") depth++;
		else if (c === "]") depth--;
		else if (
			c === "," &&
			depth === 0 &&
			/^\s*[A-Za-z0-9]/.test(value.slice(i + 1))
		) {
			parts.push(value.slice(from, i));
			from = i + 1;
		}
	}
	return [...parts, value.slice(from)];
}

/**
 * @param {string[]} words
 * @returns {Install | null}
 */
function uvRun(words) {
	const { all, has, help } = parseArgv(words, UV_RUN_ARGV, 2);
	if (help) return null;
	return buildUvInstall(
		withSpecs(all, "--with", "-w"),
		all("--with-editable"),
		has,
	);
}

const UV_PYTHON_RE = /^python(\d+(\.\d+)*)?(@.*)?$/;

/**
 * @param {string[]} words
 * @param {number} at
 * @returns {Install | null}
 */
function uvToolRun(words, at) {
	const { args, all, has, help } = parseArgv(words, UV_TOOL_RUN_ARGV, at);
	const command = args[at - 1];
	if (help || command === undefined) return null;
	const from = all("--from").at(-1);
	const target =
		from ?? (UV_PYTHON_RE.test(command) ? undefined : toRequirement(command));
	return buildUvInstall(
		[
			...(target === undefined ? [] : [target]),
			...withSpecs(all, "--with", "-w"),
		],
		all("--with-editable"),
		has,
	);
}

/**
 * @param {string[]} words
 * @returns {Install | null}
 */
function uvToolInstall(words) {
	const { args, all, has, help } = parseArgv(words, UV_TOOL_INSTALL_ARGV);
	const target = args[2];
	if (help || target === undefined) return null;
	const editable = has("-e", "--editable");
	return buildUvInstall(
		[
			...(editable ? [] : [toRequirement(target)]),
			...withSpecs(all, "--with", "-w", "--with-executables-from"),
		],
		[...(editable ? [target] : []), ...all("--with-editable")],
		has,
	);
}

const AT_VERSION_RE =
	/^([A-Za-z0-9][A-Za-z0-9._-]*(?:\[[^\]]*\])?)@([^\s:/@]+)$/;

/** @param {string} spec */
function toRequirement(spec) {
	const m = AT_VERSION_RE.exec(spec);
	if (m === null) return spec;
	const name = requiredGroup(m, 1, AT_VERSION_RE);
	const version = requiredGroup(m, 2, AT_VERSION_RE);
	return version === "latest" ? name : `${name}==${version}`;
}

/**
 * @param {string[]} words
 * @param {PipInstallContext} ctx
 * @returns {Install | null}
 */
function parsePipx(words, ctx) {
	const sub = parseArgv(words, PIPX_ARGV, 1).args[0];
	const pipx = parseArgv(
		words,
		PIPX_ARGV,
		sub === "run" ? 2 : Number.POSITIVE_INFINITY,
	);
	if (pipx.help) return null;
	if (sub === "runpip")
		return pipxRunpip(words.slice(words.indexOf(sub) + 1), ctx);
	/** @type {string[]} */
	let named;
	if (sub === "install" || (sub === "upgrade" && hasInstallFlag(pipx.opts)))
		named = pipx.args.slice(1);
	else if (sub === "inject") named = pipx.args.slice(2);
	else if (sub === "run") named = pipxRunTarget(pipx);
	else return null;
	const local = pipx.has("--editable", "-e")
		? named
		: named.filter((spec) => /\.py$/i.test(spec) || pipx.has("--path"));
	return {
		specs: [
			...named.filter((spec) => !local.includes(spec)),
			...pipx.all("--preinstall", "--with"),
		],
		local,
		shut: isPipArgsShut(pipx.all("--pip-args").at(-1), ctx),
		tool: "--pip-args='--only-binary :all:'",
	};
}

/** @param {Opt[]} opts */
const hasInstallFlag = (opts) => opts.some((o) => PIPX_INSTALL_RE.test(o.name));

/**
 * @param {string[]} words
 * @param {PipInstallContext} ctx
 * @returns {Install | null}
 */
function pipxRunpip(words, ctx) {
	const dash = words.indexOf("--");
	const rest =
		dash < 0 ? words : [...words.slice(0, dash), ...words.slice(dash + 1)];
	const venv = rest.findIndex((w) => !w.startsWith("-"));
	const pipargs = rest.slice(venv + 1);
	const [line] = pipargs;
	return venv < 0
		? null
		: parsePip(
				pipargs.length === 1 && line !== undefined && /\s/.test(line)
					? shellWords(line, ctx).flat()
					: pipargs,
			);
}

/**
 * @param {{ args: string[], all: (...names: string[]) => string[] }} pipx
 * @returns {string[]}
 */
function pipxRunTarget({ args, all }) {
	const spec = all("--spec").at(-1);
	if (spec !== undefined) return [spec];
	const app = args[1];
	return app === undefined ? [] : [app];
}

/**
 * @param {string | undefined} value
 * @param {PipInstallContext} ctx
 */
function isPipArgsShut(value, ctx) {
	if (value === undefined) return false;
	const argvs = shellWords(value, ctx);
	const [argv] = argvs;
	return (
		argvs.length === 1 &&
		argv !== undefined &&
		isBinaryOnly(parseArgv(argv, PIP_ARGV).opts)
	);
}

/**
 * @param {string} value
 * @param {PipInstallContext} ctx
 * @returns {string[][]}
 */
function shellWords(value, ctx) {
	const parsed = parseCommand(value);
	/** @type {string[][]} */
	const argvs = [];
	walkCommands(
		parsed,
		(cmd) => argvs.push(cmd.words.map((w) => literal(w, parsed.spans).text)),
		ctx,
	);
	return argvs;
}

/**
 * @param {string[]} words
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
 * @param {string} w
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

/** @param {string} w */
function clusterEnd(w) {
	const at = w.slice(1).search(/[cmWX]/);
	return at < 0 ? null : { letter: w[at + 1], rest: w.slice(at + 2) };
}

/**
 * @param {string[]} words
 * @param {PipInstallContext} ctx
 * @returns {Install | null}
 */
function parseInstall(words, ctx) {
	const [head = "", ...rest] = words;
	const name = path.basename(head);
	if (/^pip(\d+(\.\d+)*)?$/.test(name)) return parsePip(rest);
	if (/^python(\d+(\.\d+)*)?$/.test(name)) {
		const pip = pythonPip(rest);
		return pip === null ? null : parsePip(pip);
	}
	if (name === "uv") return parseUv(rest);
	if (name === "uvx") return uvToolRun(rest, 1);
	if (name === "pipx") return parsePipx(rest, ctx);
	return null;
}

/**
 * @param {Install} install
 * @param {string} segment
 * @param {() => Set<string>} declared
 * @param {PipInstallContext} ctx
 * @returns {{ deny: string } | null}
 */
function judge(install, segment, declared, ctx) {
	if (install.specs.length + install.local.length === 0) return null;
	/** @type {string[]} */
	const fresh = [];
	/** @type {string[]} */
	const unvettable = [];
	for (const spec of install.specs) {
		const name = specName(spec);
		if (name === null) unvettable.push(spec);
		else if (!declared().has(name) && !fresh.includes(name)) fresh.push(name);
	}
	unvettable.push(...install.local);
	if (fresh.length + unvettable.length === 0) return null;

	if (!install.shut)
		return refuse(windowText(fresh, unvettable, install.tool, ctx), segment);

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
		(name, spent) => registryVerdict(name, ctx, spent),
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
			const words = cmd.words.map((w) => literal(w, parsed.spans).text);
			const install = parseInstall(words, ctx);
			if (install !== null)
				verdict = judge(install, cmd.segment, declared, ctx);
		},
		ctx,
	);
	return verdict;
}

module.exports = { field: "command", noun: "command", decide };
