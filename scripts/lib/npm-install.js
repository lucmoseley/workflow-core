const path = require("node:path");
const {
	boolExact,
	npmCanon,
	shorthandExact,
	treeCommandOf,
} = require("./npm-options.js");
const { ruleOrFallback, spliceCmd } = require("./guard-verdict.js");
const {
	UNREACHABLE,
	ageOf,
	downloadsOf,
	jsonOf,
	legitimacy,
	registryTexts,
	unvettableText,
} = require("./package-vetting.js");
const { isUnder } = require("./is-under.js");
const { parseCommand, walkCommands } = require("./shell-parse.js");
const { literal, scanFlags } = require("./shell-words.js");

const NPX_SWITCHES = new Set(
	"browser always-spawn ignore-existing shell-auto-fallback no-install quiet q version v help h".split(
		" ",
	),
);
const NPX_OPTS = new Set(
	"package p cache userconfig call c shell npm node-arg n".split(" "),
);
const NPX_REMOVED = new Set(
	"always-spawn ignore-existing shell-auto-fallback npm node-arg n".split(" "),
);

/**
 * @typedef {import("./package-vetting.js").Call} Call
 * @typedef {object} NpmInstallPorts
 * @property {(pkg: string) => Call} npmView
 * @property {(pkg: string) => Call} downloads
 * @property {(p: string) => boolean} pathExists
 * @property {(p: string) => string | null} linkTarget
 * @property {() => string} storesDir
 * @typedef {import("./kit-context.js").KitContext & NpmInstallPorts
 *   & import("./package-vetting.js").VettingPorts
 *   & Pick<import("./core-contract.js").CoreContext, "tree">} NpmInstallContext
 * @typedef {{ deny: string }} Verdict
 */

/**
 * @param {string[]} fresh
 * @param {string[]} unvettable
 * @param {NpmInstallContext} ctx
 */
const windowText = (fresh, unvettable, ctx) =>
	`This install adds ${fresh.length + unvettable.length} package(s) this repo does not yet depend on — ${fresh.join(" ")} ${unvettable.join(" ")} — and does not carry \`--ignore-scripts\`: @CMD@

Without \`--ignore-scripts\`: ${ruleOrFallback(ctx, "install-scripts-first", "an install runs its packages' own scripts")}

Re-run with \`--ignore-scripts\`; it is per-invocation, so husky's \`prepare\` bootstrap on a fresh clone is untouched (mantahostels#1767 rejected the repo-wide \`.npmrc\` form for exactly that reason).

Then commit the lockfile.`;

/**
 * @param {string} subject
 * @param {string} fix
 */
const bareNpxText = (subject, fix) =>
	`This runs \`${subject}\` by bare name, which resolves to two different things depending on whether \`node_modules\` happens to exist: @CMD@

npx tries \`node_modules/.bin\` first and the public registry second, and a throwaway worktree has no \`node_modules\` at all. What the registry holds under a bare name can be anyone's: in mantahostels#1538 the bare name \`biome\` fetched an unrelated package that accepts \`ci .\`, prints nothing and exits 0 — a check that went green having checked nothing. \`--no-install\` is not a defence: running the bare form once writes the impostor into \`~/.npm/_npx/\`, after which it resolves silently and offline.

${fix}`;

/**
 * @param {string} subject
 * @param {string | null | undefined} owner
 */
function npxFix(subject, owner) {
	if (owner === undefined)
		return `This guard could not read every dependency's package.json in \`node_modules\` to find which carries \`${subject}\`. Spell it so it resolves to one thing:
  node_modules/.bin/${subject} …    in the canonical checkout
  npx -p <that dependency> ${subject} …    in a worktree`;
	if (owner === null)
		return `No dependency of this repo carries a \`${subject}\` bin. Install the package that provides it, then run \`node_modules/.bin/${subject} …\`.`;
	/* A package runs the bin it is named for, `npx @biomejs/biome`; any other
	 * owner, `typescript` for `tsc`, is named with -p. */
	const ownerLine = isScopedAs(owner, subject)
		? `npx ${owner} …`
		: `npx -p ${owner} ${subject} …`;
	return `Spell it so it resolves to one thing:
  node_modules/.bin/${subject} …    in the canonical checkout
  ${ownerLine}    \`${owner}\`, the dependency that carries it, in a worktree`;
}

/**
 * @param {string} dep
 * @param {string} bin
 */
const isScopedAs = (dep, bin) => dep.startsWith("@") && dep.endsWith(`/${bin}`);

/**
 * @param {string} text
 * @param {string} segment
 * @returns {Verdict}
 */
const refuse = (text, segment) => ({
	deny: spliceCmd(segment, text),
});

const DEP_FIELDS = [
	"dependencies",
	"devDependencies",
	"optionalDependencies",
	"peerDependencies",
];

/**
 * @param {NpmInstallContext} ctx
 * @returns {string[] | null}
 */
function loadDeps(ctx) {
	const tree = ctx.tree();
	const pkg = tree.read("package.json");
	if (pkg.state !== "read") {
		ctx.log(
			`package.json at ${tree.root}/package.json is ${pkg.state} — install allowed unchecked`,
		);
		return null;
	}
	const names = depNames(pkg.data);
	if (names === null)
		ctx.log("package.json did not parse — install allowed unchecked");
	return names;
}

/**
 * @param {string} text
 * @returns {string[] | null}
 */
function depNames(text) {
	let pkg;
	try {
		pkg = JSON.parse(text);
	} catch {
		return null;
	}
	if (pkg === null) return [];
	if (typeof pkg !== "object" || Array.isArray(pkg)) return null;
	/** @type {Set<string>} */
	const names = new Set();
	for (const field of DEP_FIELDS) {
		const deps = pkg[field] ?? false;
		if (deps === false) continue;
		if (typeof deps !== "object" || Array.isArray(deps)) return null;
		for (const name of Object.keys(deps)) names.add(name);
	}
	return [...names].sort();
}

/**
 * @param {string} bin
 * @param {string[]} deps
 * @param {NpmInstallContext} ctx
 * @returns {string | null | undefined}
 */
function binOwner(bin, deps, ctx) {
	const tree = ctx.tree();
	const reads = deps.map((dep) =>
		tree.read(`node_modules/${dep}/package.json`),
	);
	// #5585
	let whole = reads.every((r) => r.state === "read");
	/** @type {string | null} */
	let owner = null;
	for (const got of reads) {
		if (got.state !== "read") continue;
		const named = carries(got.data, bin);
		if (named === undefined) {
			ctx.log(
				`a dependency's package.json in node_modules did not parse — the owner of the ${bin} bin is unread`,
			);
			whole = false;
			break;
		}
		if (named !== false) {
			owner = named;
			break;
		}
	}
	if (owner) return owner;
	if (whole) return null;
	return deps.find((dep) => isScopedAs(dep, bin));
}

/**
 * @param {string} text
 * @param {string} bin
 * @returns {string | null | false | undefined}
 */
function carries(text, bin) {
	let m;
	try {
		m = JSON.parse(text);
	} catch {
		return;
	}
	if (m === null) return false;
	if (typeof m !== "object" || Array.isArray(m)) return;
	const named = typeof m.name === "string" && m.name ? m.name : null;
	if (m.bin !== null && typeof m.bin === "object" && !Array.isArray(m.bin))
		return Object.hasOwn(m.bin, bin) ? named : false;
	if (typeof m.bin !== "string") return false;
	if (typeof m.name !== "string") return;
	return m.name.split("/").at(-1) === bin ? named : false;
}

const NAME_RE = /^(@[A-Za-z0-9][A-Za-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * @param {string} spec
 * @returns {string | null}
 */
function specName(spec) {
	if (spec === "" || spec.startsWith("-")) return null;
	if (spec.includes("/") && !spec.startsWith("@")) return null;
	if (spec.includes(":")) return null;
	if (spec.startsWith(".") || spec.startsWith("~")) return null;
	let name;
	if (spec.startsWith("@")) {
		const rest = spec.slice(1);
		const at = rest.lastIndexOf("@");
		name = `@${at >= 0 ? rest.slice(0, at) : rest}`;
	} else {
		const at = spec.indexOf("@");
		name = at >= 0 ? spec.slice(0, at) : spec;
	}
	return NAME_RE.test(name) ? name : null;
}

/** @typedef {import("./package-vetting.js").RegistryVerdict} RegistryVerdict */

const NPM_TEXTS = registryTexts({
	exists: "exists on the npm registry",
	unreached: "The npm registry could not be reached to check",
});

/**
 * @param {string} pkg
 * @param {NpmInstallContext} ctx
 * @returns {RegistryVerdict}
 */
function registryVerdict(pkg, ctx) {
	const age = ageVerdict(pkg, ctx);
	return age.kind === "ok" ? downloadsVerdict(pkg, ctx) : age;
}

/**
 * @param {string} pkg
 * @param {NpmInstallContext} ctx
 * @returns {RegistryVerdict}
 */
function ageVerdict(pkg, ctx) {
	const view = ctx.npmView(pkg);
	if ("missing" in view) {
		ctx.log(
			`npm not found — legitimacy of ${pkg} could not be checked, denying`,
		);
		return UNREACHABLE;
	}
	if (view.status !== 0)
		return view.stdout.includes("E404")
			? { kind: "missing", n: "" }
			: UNREACHABLE;
	return ageOf(jsonOf(view.stdout), ctx);
}

/**
 * @param {string} pkg
 * @param {NpmInstallContext} ctx
 * @returns {RegistryVerdict}
 */
function downloadsVerdict(pkg, ctx) {
	const got = ctx.downloads(pkg);
	if ("missing" in got) {
		ctx.log(
			`curl not found — download history of ${pkg} could not be checked, denying`,
		);
		return UNREACHABLE;
	}
	if (got.status !== 0) return UNREACHABLE;
	const body = jsonOf(got.stdout);
	return downloadsOf(
		body !== null && typeof body === "object" && "downloads" in body
			? body.downloads
			: undefined,
	);
}

/**
 * @param {string[]} canon
 */
function parseTreeWrite(canon) {
	/** @type {string | undefined} */
	let command;
	let positional = 0;
	let fix = false;
	let prefix = "";
	let off = false;
	scanFlags("", canon, (kind, name, value) => {
		if (kind === "arg") {
			positional++;
			if (positional === 1) command = treeCommandOf(value);
			else if (positional === 2) fix = value === "fix";
			return;
		}
		if (name === "--prefix") prefix = value;
		if (isTreelessOption(name, value)) off = true;
	});
	if (off || (command === "audit" && !fix)) command = undefined;
	return { command, prefix };
}

/**
 * @param {string} name
 * @param {string} value
 */
const isTreelessOption = (name, value) =>
	(name === "--location" && value === "global") ||
	["global", "package-lock-only", "dry-run", "usage"].some(
		(config) => switchOf(config, name, value) === true,
	);

/**
 * @param {string} dir
 * @param {NpmInstallContext} ctx
 */
function localPrefix(dir, ctx) {
	for (let at = dir; ; at = path.dirname(at)) {
		if (
			ctx.pathExists(path.join(at, "package.json")) ||
			ctx.pathExists(path.join(at, "node_modules"))
		)
			return at;
		if (path.dirname(at) === at) return dir;
	}
}

/**
 * @param {string[]} canon
 * @param {string} cwd
 * @param {State} st
 * @returns {string | null}
 */
function storeWriteRefusal(canon, cwd, st) {
	const { command, prefix } = parseTreeWrite(canon);
	if (command === undefined) return null;
	if (cwd === "") {
		st.ctx.log(
			`npm ${command}: where it runs did not resolve — a store link left unchecked`,
		);
		return null;
	}
	const at = prefix
		? path.resolve(cwd, literal(prefix, st.spans).text)
		: localPrefix(cwd, st.ctx);
	const link = path.join(at, "node_modules");
	const target = st.ctx.linkTarget(link);
	if (target === null) return null;
	const store = path.resolve(at, target);
	if (!isUnder(store, [st.ctx.storesDir()], path.sep)) return null;
	return `\`npm ${command}\` would write through ${link}, a link to ${store}: a dependency store every worktree on this lockfile shares, and none installs into (#4255).
To change the dependencies, run the same command with \`--package-lock-only\`, which writes package.json and package-lock.json alone; then \`node ${st.ctx.scriptPath("session-checkout.js")} attach\` points this worktree at the store for its new lockfile, building it once where none exists. A lockfile left unchanged already has its store.`;
}

/**
 * @param {string[]} canon
 */
function readInstall(canon) {
	let sub = "";
	/** @type {string[]} */
	const specs = [];
	let ignore = false;
	let helping = false;
	scanFlags("", canon, (kind, name, value) => {
		if (kind === "arg") {
			if (sub === "") sub = value;
			else specs.push(value);
			return;
		}
		const set = switchOf("ignore-scripts", name, value);
		if (set !== null) ignore = set;
		const usage = switchOf("usage", name, value);
		if (usage !== null) helping = usage;
	});
	return { sub, specs, ignore, helping };
}

/**
 * @param {string} config
 * @param {string} name
 * @param {string} value
 * @returns {boolean | null}
 */
function switchOf(config, name, value) {
	if (name === `--${config}`) {
		if (value === "" || value === "true") return true;
		return value === "false" ? false : null;
	}
	if (name === `--no-${config}`) {
		if (value === "" || value === "true") return false;
		return value === "false" ? true : null;
	}
	return null;
}

/**
 * @param {string} segment
 * @param {string[]} args
 * @param {string} cwd
 * @param {State} st
 * @returns {Verdict | null}
 */
function judgeNpm(segment, args, cwd, st) {
	const named = args.map((w) => w.slice(w.lastIndexOf("=") + 1));
	if (!named.some((w) => treeCommandOf(w) !== undefined)) return null;
	const canon = npmCanon(args);
	const store = storeWriteRefusal(canon, cwd, st);
	if (store !== null) return refuse(store, segment);
	if (!named.some((w) => treeCommandOf(w) === "install")) return null;
	const { sub, specs, ignore, helping } = readInstall(canon);
	if (helping || treeCommandOf(sub) !== "install") return null;
	if (specs.length === 0) return null;

	const deps = st.deps();
	if (deps === null) return null;
	const { fresh, unvettable } = sortSpecs(specs, deps);
	if (fresh.length + unvettable.length === 0) return null;

	if (!ignore) return refuse(windowText(fresh, unvettable, st.ctx), segment);

	if (st.ctx.allowNewPackage) return null;
	const [first] = unvettable;
	if (first !== undefined)
		return refuse(
			unvettableText(
				first,
				"A path, a tarball URL, a `git:`/`github:` spec and an `npm:` alias",
				st.ctx,
			),
			segment,
		);

	const failed = legitimacy(
		fresh,
		st.ctx,
		(name) => registryVerdict(name, st.ctx),
		NPM_TEXTS,
	);
	return failed === null ? null : refuse(failed, segment);
}

/**
 * @param {string[]} specs
 * @param {string[]} deps
 */
function sortSpecs(specs, deps) {
	/** @type {string[]} */
	const fresh = [];
	/** @type {string[]} */
	const unvettable = [];
	for (const spec of specs) {
		const name = specName(spec);
		if (name === null) unvettable.push(spec);
		else if (!deps.includes(name)) fresh.push(name);
	}
	return { fresh, unvettable };
}

/**
 * @param {string[]} words
 * @returns {string[]}
 */
function npxPreparse(words) {
	const args = [...words];
	/** @type {string[]} */
	const out = [];
	for (let w = args.shift(); w !== undefined; w = args.shift()) {
		if (w === "--") return [...out, "--", ...args];
		if (!w.startsWith("-")) return [...out, "--", w, ...args];
		npxOption(w, args, out);
	}
	return out;
}

/**
 * @param {string} word
 * @param {string[]} args
 * @param {string[]} out
 */
function npxOption(word, args, out) {
	const { key, hasV, v, w } = npxKey(word);
	if (w === null) {
		const exp = shorthandExact(key);
		if (exp !== null && !NPX_REMOVED.has(key)) {
			args.unshift(...exp, ...(hasV ? [v] : []));
			return;
		}
	}
	if (NPX_REMOVED.has(key)) {
		if (NPX_OPTS.has(key) && !hasV && args.length > 0) args.shift();
		return;
	}
	out.push(w ?? word);
	const next = args[0];
	if (!hasV && next !== undefined && takesNext(key, next)) {
		out.push(next);
		args.shift();
	}
}

/**
 * @param {string} key
 * @param {string} next
 */
function takesNext(key, next) {
	if (NPX_SWITCHES.has(key) || boolExact(`--${key}`)) return false;
	return NPX_OPTS.has(key) || !next.startsWith("-");
}

/**
 * @param {string} word
 */
function npxKey(word) {
	const bare = word.replace(/^-+/, "");
	const eqAt = bare.indexOf("=");
	const hasV = eqAt >= 0;
	const key = hasV ? bare.slice(0, eqAt) : bare;
	const v = hasV ? bare.slice(eqAt + 1) : "";
	const eqPart = word.includes("=") ? word.slice(word.indexOf("=")) : "";
	/** @type {string | null} */
	let w = null;
	if (key === "p") w = `--package${eqPart}`;
	else if (key === "shell") w = `--script-shell${eqPart}`;
	else if (key === "no-install") w = "--yes=false";
	return { key, hasV, v, w };
}

/**
 * @param {string[]} canon
 */
function readNpx(canon) {
	let bin = "";
	let helping = false;
	/** @type {string[]} */
	const pkgs = [];
	scanFlags("", canon, (kind, name, value) => {
		if (kind === "arg") {
			if (bin === "") bin = value;
			return;
		}
		if (name === "-" && bin === "") bin = "-";
		const pkg = packageOf(name, value);
		if (pkg !== null) pkgs.push(pkg);
		const usage = switchOf("usage", name, value);
		if (usage !== null) helping = usage;
	});
	return { bin, pkgs, helping };
}

/**
 * @param {string} name
 * @param {string} value
 * @returns {string | null}
 */
function packageOf(name, value) {
	if (name === "--package") return value === "" ? "true" : value;
	if (name !== "--no-package") return null;
	if (value === "" || value === "true") return "false";
	return value === "false" ? "true" : value;
}

/**
 * @param {string} segment
 * @param {string[]} args
 * @param {State} st
 * @returns {Verdict | null}
 */
function judgeNpx(segment, args, st) {
	const words = args.map((w) => literal(w, st.spans).text);
	const { bin, pkgs, helping } = readNpx(npmCanon(npxPreparse(words)));
	if (helping) return null;
	const named = pkgs.length > 0 ? pkgs : [bin];
	for (const name of named) {
		if (
			name === "" ||
			name.startsWith("-") ||
			name.includes("/") ||
			name.startsWith(".") ||
			name.includes(":")
		)
			continue;
		const deps = st.deps();
		if (deps === null) return null;
		if (!deps.includes(name))
			return refuse(
				bareNpxText(name, npxFix(name, binOwner(name, deps, st.ctx))),
				segment,
			);
	}
	return null;
}

/**
 * @typedef {object} State
 * @property {NpmInstallContext} ctx
 * @property {string[]} spans
 * @property {() => string[] | null} deps
 */

/**
 * @param {string} command
 * @param {NpmInstallContext} ctx
 * @returns {import("./guard-entry.js").Decision}
 */
function decide(command, ctx) {
	const parsed = parseCommand(command);
	/** @type {string[] | null | undefined} */
	let deps;
	/** @type {State} */
	const st = {
		ctx,
		spans: parsed.spans,
		deps: () => {
			if (deps === undefined) deps = loadDeps(ctx);
			return deps;
		},
	};
	/** @type {Verdict | null} */
	let verdict = null;
	walkCommands(
		parsed,
		(cmd) => {
			if (verdict !== null) return;
			const [head = "", ...args] = cmd.words;
			const name = path.basename(head);
			if (name === "npm") verdict = judgeNpm(cmd.segment, args, cmd.cwd, st);
			else if (name === "npx") verdict = judgeNpx(cmd.segment, args, st);
		},
		ctx,
	);
	return verdict;
}

module.exports = { field: "command", noun: "command", decide };
