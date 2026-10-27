/*
 * npm-install.js — guard-npm-install.js's core (#2800): the npm install
 * boundary (mantahostels#1803, ruled at mantahostels#1767).
 *
 * The gate on a new dependency: three refusals on one hook, all of them
 * denies (mantahostels#103).
 *
 * THREE CHECKS, in the order they run.
 *
 *   1. THE EXECUTION WINDOW. An install naming a package `package.json` does
 *      not already list must carry `--ignore-scripts`. Between `npm install`
 *      fetching a tarball and anything reading it, that tarball's `preinstall`
 *      runs as the founder. This runs FIRST because it is local and certain.
 *
 *      Per-invocation, deliberately (mantahostels#1767), never a repo-wide
 *      `.npmrc` `ignore-scripts=true`, which would disable husky's `prepare`
 *      bootstrap on a fresh clone. A plain `npm install` naming no package is
 *      untouched for the same reason.
 *
 *   2. NEW-PACKAGE LEGITIMACY. For each named package absent from
 *      `package.json`, three registry facts, keyless (`docs/working-contract.md`
 *      §No paid research or data APIs):
 *
 *        - the name exists            `npm view <pkg> time.created --json`
 *        - it is at least MIN_AGE_DAYS old              (the same call)
 *        - last month's downloads clear MIN_DOWNLOADS
 *                                     `api.npmjs.org/downloads/point/last-month`
 *
 *   3. BARE `npx`. `npx <name>` where <name> is unscoped and not among
 *      `package.json`'s dependencies — check 2's failure with a name that
 *      resolves (mantahostels#1538), which is why it rides on this guard
 *      rather than its own.
 *
 * THE THRESHOLDS, and what in them is a judgement.
 *
 *   MIN_AGE_DAYS=180, MIN_DOWNLOADS=1000 per month.
 *
 * Neither is a measurement; both are chosen for margin (mantahostels#1767).
 * The margin over mantahostels' own dependencies is on mantahostels#1803.
 *
 * THE ESCAPE, `allowNewPackage`, is `WFC_ALLOW_NEW_PACKAGE` in the HOOK's
 * environment (lib/npm-install-host.js), never a leading assignment on the
 * command, which is read but not honoured: an escape a session can spell for
 * itself is not a deny (mantahostels#109). It stands down check 2 alone.
 *
 * WHAT THIS DOES NOT COVER (mantahostels#1767): a legitimate package LATER
 * COMPROMISED. Nothing here is a substitute for a committed lockfile.
 *
 * LIMITS
 *  - npm only. `pnpm add`, `yarn add` and `bun add` are not read.
 *  - Only a registry spec is vetted. `npm i ./local`, `github:user/repo`, a
 *    tarball URL and a `file:` spec cannot be asked of the registry, so they
 *    are DENIED as unvettable rather than waved through.
 *  - A wrapper hides the install: `xargs npm install`, `env`, `sudo`, a
 *    script that installs on the session's behalf. Only a command's own first
 *    word is read.
 *  - Check 3 judges the PACKAGE name, not the bin name, so `npx tsc` is denied
 *    even though `typescript` is a dependency. That is intended: the refusal
 *    names the dependency whose installed `bin` carries it,
 *    `npx -p typescript tsc` (#1806). Only direct dependencies are read, and
 *    only from the host root's `node_modules`.
 *  - `npm` and `npx` options are read as npm's parser (nopt) reads them —
 *    abbreviations, single-dash long forms and shorthands included (#563,
 *    #571) — by lib/npm-options.js, against npm 11.16.0's config list. A
 *    config a later npm adds is read as a name npm does not know. `npx` words
 *    are read with their quoted spans put back; `npm` words are not, so
 *    `npm i --reg"istry" <url> x` reads the URL as a spec, and refuses it as
 *    unvettable.
 *  - `npm exec` and `npm x` run a package the way `npx` does and are NOT read;
 *    check 3 covers the `npx` spelling alone.
 *  - A registry call the host cannot start (`npm` or `curl` missing) reads as
 *    an unreachable registry, so it DENIES, and is logged: a deliberate
 *    departure from mantahostels#103 §6, because an unreachable registry
 *    denies and the escape is a named env var, never silence
 *    (mantahostels#1767).
 *    An unreadable `package.json` is the one fault upstream of a verdict that
 *    allows, logged: every package would read as new.
 */

const path = require("node:path");
const { boolExact, npmCanon, shorthandExact } = require("./npm-options.js");
const { spliceCmd } = require("./guard-verdict.js");
const { parseCommand, walkCommands } = require("./shell-parse.js");
const { literal, scanFlags } = require("./shell-words.js");

const MIN_AGE_DAYS = 180;
const MIN_DOWNLOADS = 1000;

/* THE WALL-CLOCK BUDGET, in seconds. The hook's own 60 s timeout is not a
 * verdict: a hook killed at the ceiling emits nothing, which Claude Code reads
 * as no objection — the one fail-open this guard could not record. So it stops
 * asking the registry at 30 s and refuses on what it could not check.
 *
 * 30 s, not 40: the budget is tested BEFORE each package and one package costs
 * up to the npm call's 12 s and curl's 8 s (lib/npm-install-host.js), so a
 * 40 s budget could start a package at 39 s and finish at 59 s — inside the
 * ceiling only by luck (mantahostels#1803's review, H4). 30 + 20 leaves 10 s. */
const BUDGET_S = 30;

/* npm's install aliases, as npm itself accepts them. */
const INSTALL_SUBS = new Set(
	"install i in ins inst insta instal add isnt isnta isntal isntall".split(" "),
);

/* npx rewrites its argv before npm's parser sees it (npm 11.16.0's
 * `bin/npx-cli.js`): it matches each option's key exactly, never as an
 * abbreviation, and puts a `--` before the first word it reads as positional,
 * which ends npm's options there (#491). Every other word is then read by
 * nopt, so the bin is nopt's first positional (#571). Its switches are
 * lib/npm-options.js's Boolean configs plus `browser`, a Boolean that also
 * takes a String. */
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
 * @typedef {{ missing: true } | { status: number | null, stdout: string }} Call
 *   a registry call: `missing` where its program could not be started, else
 *   its exit status (null where it was killed) and stdout
 * @typedef {object} NpmInstallPorts
 * @property {() => { path: string, text: string | null }} readPackageJson the
 *   host root's package.json, `text` null where it cannot be read
 * @property {(dep: string) => string | null} readManifest
 *   `node_modules/<dep>/package.json` under the host root, null where it
 *   cannot be read
 * @property {(pkg: string) => Call} npmView `npm view <pkg> time.created --json`
 * @property {(pkg: string) => Call} downloads last month's downloads endpoint
 *   for `pkg`
 * @property {() => number} now the clock, in epoch milliseconds
 * @property {boolean} allowNewPackage `WFC_ALLOW_NEW_PACKAGE` set in the
 *   hook's own environment
 * @typedef {import("./guard-entry.js").KitContext & NpmInstallPorts} NpmInstallContext
 * @typedef {{ deny: string }} Verdict
 */

/* ----------------------------------------------------------------------- */
/* The refusals.                                                           */
/* ----------------------------------------------------------------------- */

const ESCAPE_NOTE = `The escape is \`WFC_ALLOW_NEW_PACKAGE=1\` in the environment Claude Code itself
was started in — NOT on this command line, which is read but never honoured: an
escape a session can spell for itself is not a deny (mantahostels#109). Otherwise ask the
founder to run the install from their own terminal, which sees no hook.`;

/**
 * @param {string[]} fresh
 * @param {string[]} unvettable
 */
const windowText = (fresh, unvettable) =>
	`This install adds ${fresh.length + unvettable.length} package(s) this repo does not yet depend on — ${fresh.join(" ")} ${unvettable.join(" ")} — and does not carry \`--ignore-scripts\`: @CMD@

A package's \`preinstall\` and \`postinstall\` run as you, before anything reads a byte of it. Re-run with \`--ignore-scripts\`; it is per-invocation, so husky's \`prepare\` bootstrap on a fresh clone is untouched (mantahostels#1767 rejected the repo-wide \`.npmrc\` form for exactly that reason).

Then commit the lockfile.`;

/** @param {string} spec */
const unvettableText = (spec) =>
	`This install names a spec the registry cannot be asked about, so its legitimacy is unverifiable: \`${spec}\`

@CMD@

A path, a tarball URL, a \`git:\`/\`github:\` spec and an \`npm:\` alias all bypass the checks this guard runs on a new package — that the name exists, its age, its download history. None of them can be answered for a spec that never touches the registry.

${ESCAPE_NOTE}`;

/**
 * @typedef {"missing" | "young" | "thin" | "budget" | "unreachable"} Refusal
 * @typedef {{ kind: "ok" } | { kind: Refusal, n: string }} RegistryVerdict
 */

/** @type {Record<Refusal, (name: string, n: string) => string>} */
const REGISTRY_TEXT = {
	missing: (name) =>
		`No package named \`${name}\` exists on the npm registry: @CMD@

That is the shape of a hallucinated name. Roughly one in five package references generated by a code model does not exist (Spracklen et al., USENIX Security 2025), and 43% of those names recur across re-runs — which is what makes pre-registering them worth an attacker's time. Check the name against the tool's own documentation before trying again.`,
	young: (name, days) =>
		`\`${name}\` was first published ${days} days ago, under this guard's ${MIN_AGE_DAYS}-day floor: @CMD@

A squat registered against a hallucinated name is days old. A genuinely new package that this project needs is a founder decision, not a session's.

${ESCAPE_NOTE}`,
	thin: (name, dl) =>
		`\`${name}\` was downloaded ${dl} time(s) last month, under this guard's floor of ${MIN_DOWNLOADS}: @CMD@

A package worth installing has real download history. This has none, which is what a squatted name looks like from the outside.

${ESCAPE_NOTE}`,
	budget: (name) =>
		`This guard ran out of its own time budget before it could check \`${name}\`, so nothing is known about it: @CMD@

The budget is ${BUDGET_S} s, under the hook's 60 s ceiling — a hook killed at that ceiling emits nothing at all, which reads as no objection. Install one package at a time and each gets checked.

${ESCAPE_NOTE}`,
	unreachable: (name) =>
		`The npm registry could not be reached to check \`${name}\`, so this install proceeds on nothing: @CMD@

An install whose name, age and download history went unchecked is what this guard exists to prevent, so an unreachable registry refuses rather than waving it through (mantahostels#1767).

${ESCAPE_NOTE}`,
};

/**
 * @param {string} subject
 * @param {string} fix
 */
const bareNpxText = (subject, fix) =>
	`This runs \`${subject}\` by bare name, which resolves to two different things depending on whether \`node_modules\` happens to exist: @CMD@

npx tries \`node_modules/.bin\` first and the public registry second, and a throwaway worktree has no \`node_modules\` at all. What the registry holds under a bare name can be anyone's: in mantahostels#1538 the bare name \`biome\` fetched an unrelated package that accepts \`ci .\`, prints nothing and exits 0 — a check that went green having checked nothing. \`--no-install\` is not a defence: running the bare form once writes the impostor into \`~/.npm/_npx/\`, after which it resolves silently and offline.

${fix}`;

/**
 * The fix line check 3 ends on: the owner of the bin, none, or unknown.
 * @param {string} subject
 * @param {string | null | undefined} owner null where no dependency carries
 *   it, undefined where that could not be told
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
 * `@<scope>/<bin>`.
 * @param {string} dep
 * @param {string} bin
 */
const isScopedAs = (dep, bin) => dep.startsWith("@") && dep.endsWith(`/${bin}`);

/**
 * @param {string} text
 * @param {string} segment masked
 * @returns {Verdict}
 */
const refuse = (text, segment) => ({
	/* Its texts name no core path, so none is respelt. */
	deny: spliceCmd(segment, text),
});

/* ----------------------------------------------------------------------- */
/* package.json — the set of names this repo already depends on.           */
/* ----------------------------------------------------------------------- */

const DEP_FIELDS = [
	"dependencies",
	"devDependencies",
	"optionalDependencies",
	"peerDependencies",
];

/**
 * Every dependency name, sorted, or null where package.json will not read,
 * logged.
 * @param {NpmInstallContext} ctx
 * @returns {string[] | null}
 */
function loadDeps(ctx) {
	const pkg = ctx.readPackageJson();
	if (pkg.text === null) {
		ctx.log(
			`no readable package.json at ${pkg.path} — install allowed unchecked`,
		);
		return null;
	}
	const names = depNames(pkg.text);
	if (names === null)
		ctx.log("package.json did not parse — install allowed unchecked");
	return names;
}

/**
 * The four dependency fields' keys, merged and sorted; null where the text is
 * not JSON or a field is not an object.
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
 * The direct dependency whose installed package.json `bin` names `bin`: an
 * object's keys, or for a string `bin` the package's unscoped name. Null
 * only where every dependency's package.json was read and none names it.
 * Where one is missing or will not parse — a worktree, a partial install —
 * "none" cannot be said, so it falls back to a dependency `@<scope>/<bin>`
 * (#1729), and is undefined where none is one.
 * @param {string} bin
 * @param {string[]} deps
 * @param {NpmInstallContext} ctx
 * @returns {string | null | undefined}
 */
function binOwner(bin, deps, ctx) {
	const texts = deps.map((dep) => ctx.readManifest(dep));
	let whole = texts.every((t) => t !== null);
	/** @type {string | null} */
	let owner = null;
	for (const text of texts) {
		if (text === null) continue;
		const named = carries(text, bin);
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
 * Whether one manifest's `bin` names `bin`: its `name` where it does (null
 * where that is no string), false where it does not, undefined where the
 * manifest will not read as one.
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

/* ----------------------------------------------------------------------- */
/* Package specs.                                                           */
/* ----------------------------------------------------------------------- */

const NAME_RE = /^(@[A-Za-z0-9][A-Za-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * The npm name inside a spec, or null where the spec is not a registry one.
 *
 * Handles `pkg`, `pkg@1.2.3`, `pkg@^1`, `@scope/pkg`, `@scope/pkg@next`.
 * Refuses a path, a URL, a git spec and an alias (`a@npm:b`), none of which
 * the registry can be asked about.
 * @param {string} spec
 * @returns {string | null}
 */
function specName(spec) {
	if (spec === "" || spec.startsWith("-")) return null;
	/* A scope is the only legitimate slash; everything else is a path or a
	 * URL. */
	if (spec.includes("/") && !spec.startsWith("@")) return null;
	/* file:, git:, https:, an npm: alias, the github: shorthand. */
	if (spec.includes(":")) return null;
	/* A leading `.` or `~` is a path. A tilde INSIDE the spec is npm's
	 * approximate-version range — `lodash@~4.17.0` — and denying that as a path
	 * would refuse an ordinary pinned install (mantahostels#1803's review, H1). */
	if (spec.startsWith(".") || spec.startsWith("~")) return null;
	let name;
	if (spec.startsWith("@")) {
		/* A trailing `@<version>` stripped; a scope-only spelling untouched. */
		const rest = spec.slice(1);
		const at = rest.lastIndexOf("@");
		name = `@${at >= 0 ? rest.slice(0, at) : rest}`;
	} else {
		const at = spec.indexOf("@");
		name = at >= 0 ? spec.slice(0, at) : spec;
	}
	/* Uppercase is accepted: npm has refused it for NEW names since 2017, but
	 * the legacy ones are still installable — `JSONStream`, `Base64` — and
	 * rejecting them here would call a real package a path (mantahostels#1803's
	 * review, H3). */
	return NAME_RE.test(name) ? name : null;
}

/* ----------------------------------------------------------------------- */
/* The registry.                                                            */
/* ----------------------------------------------------------------------- */

/** @param {number} ms */
const seconds = (ms) => Math.floor(ms / 1000);

/** @type {RegistryVerdict} */
const UNREACHABLE = { kind: "unreachable", n: "" };
/** @type {RegistryVerdict} */
const OK = { kind: "ok" };

/**
 * One package's registry verdict: ok, missing, unreachable, young or thin,
 * with the figure the refusal quotes. Its age is asked first, so a package
 * too young to pass costs no downloads call.
 * @param {string} pkg
 * @param {NpmInstallContext} ctx
 * @returns {RegistryVerdict}
 */
function registryVerdict(pkg, ctx) {
	const age = ageVerdict(pkg, ctx);
	return age.kind === "ok" ? downloadsVerdict(pkg, ctx) : age;
}

/**
 * `npm view`'s answer: missing, unreachable, young, or ok to go on.
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
	const created = jsonOf(view.stdout);
	if (typeof created !== "string" || !created) return UNREACHABLE;
	const epochMs = Date.parse(created);
	if (Number.isNaN(epochMs)) return UNREACHABLE;
	/* Whole seconds each side and a division truncating towards zero. */
	const days = Math.trunc((seconds(ctx.now()) - seconds(epochMs)) / 86_400);
	if (days < MIN_AGE_DAYS) return { kind: "young", n: String(days) };
	return OK;
}

/**
 * The downloads endpoint's answer: unreachable, thin, or ok.
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
	const dl =
		body !== null && typeof body === "object" && "downloads" in body
			? body.downloads
			: undefined;
	const figure =
		typeof dl === "number" || typeof dl === "string" ? String(dl) : "";
	if (!/^[0-9]+$/.test(figure)) return UNREACHABLE;
	if (Number(figure) < MIN_DOWNLOADS) return { kind: "thin", n: figure };
	return OK;
}

/**
 * @param {string} text
 * @returns {unknown} the parsed value, or null where it is not JSON
 */
function jsonOf(text) {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

/* ----------------------------------------------------------------------- */
/* `npm install` — checks 1 and 2.                                          */
/* ----------------------------------------------------------------------- */

/**
 * The install a canonical npm argv makes: its subcommand, its specs, and
 * whether it carries `--ignore-scripts` or asks for help. `--help` and `-h`
 * reach here as `--usage`.
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
 * What a Boolean option word sets `config` to, or null where it is not that
 * config: `--x`, `--x=true` and `--no-x=false` turn it on; `--x=false`,
 * `--no-x` and `--no-x=true` turn it off.
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
 * @param {string} segment masked
 * @param {string[]} args the words after `npm`, masked
 * @param {State} st
 * @returns {Verdict | null}
 */
function judgeNpm(segment, args, st) {
	/* Only an install is judged, and every spelling of one names its alias. */
	if (!args.some((w) => INSTALL_SUBS.has(w.slice(w.lastIndexOf("=") + 1))))
		return null;
	const { sub, specs, ignore, helping } = readInstall(npmCanon(args));
	if (helping || !INSTALL_SUBS.has(sub)) return null;
	/* `npm install` from the lockfile: untouched. */
	if (specs.length === 0) return null;

	/* Sorted first, judged after — so check 1 below really does run before any
	 * refusal (mantahostels#1803's review, H2). */
	const deps = st.deps();
	if (deps === null) return null;
	const { fresh, unvettable } = sortSpecs(specs, deps);
	if (fresh.length + unvettable.length === 0) return null;

	/* Check 1, the execution window. It counts the unvettable specs too: a
	 * tarball's `preinstall` is exactly the thing `--ignore-scripts` shuts. */
	if (!ignore) return refuse(windowText(fresh, unvettable), segment);

	/* Check 2, legitimacy. The stand-down comes before every refusal it can
	 * raise, the unvettable spec included — a deny whose text names an escape
	 * that does not lift it is worse than no escape (mantahostels#1803's
	 * review, H2). */
	if (st.ctx.allowNewPackage) return null;
	const [first] = unvettable;
	if (first !== undefined) return refuse(unvettableText(first), segment);

	const failed = legitimacy(fresh, st.ctx);
	return failed === null ? null : refuse(failed, segment);
}

/**
 * The specs an install names, sorted: the registry names `deps` does not
 * hold, and the specs the registry cannot be asked about.
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
 * The refusal for the first new package the registry does not vouch for, or
 * null where every one clears. The budget is tested BEFORE each package.
 * @param {string[]} fresh
 * @param {NpmInstallContext} ctx
 * @returns {string | null}
 */
function legitimacy(fresh, ctx) {
	const deadline = seconds(ctx.now()) + BUDGET_S;
	for (const name of fresh) {
		/** @type {RegistryVerdict} */
		const v =
			seconds(ctx.now()) >= deadline
				? { kind: "budget", n: "" }
				: registryVerdict(name, ctx);
		if (v.kind !== "ok") return REGISTRY_TEXT[v.kind](name, v.n);
	}
	return null;
}

/* ----------------------------------------------------------------------- */
/* `npx` — check 3.                                                         */
/* ----------------------------------------------------------------------- */

/**
 * npx's argv as it hands it to npm. A removed option is dropped, and a
 * removed one taking a value drops its value too.
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
 * One npx option word read off `args` into `out`: a shorthand put back on
 * `args` expanded, a removed option dropped with its value, anything else
 * pushed with the next word where npx hands it one.
 * @param {string} word
 * @param {string[]} args accumulator: the words still to read, consumed
 *   and, for a shorthand, refilled
 * @param {string[]} out accumulator: npx's rewritten argv so far
 */
function npxOption(word, args, out) {
	const { key, hasV, v, w } = npxKey(word);
	if (w === null) {
		/* npx looks a shorthand up by its whole key, so `-DE` is never split
		 * and takes the next word below (#1972). */
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
 * Whether npx hands the option `key`, written with no `=`, the word `next`:
 * never a switch, which it matches whole, so `--no-audit` takes the next word
 * (#1972); always one of its own value options; else a word that is no
 * option.
 * @param {string} key
 * @param {string} next
 */
function takesNext(key, next) {
	if (NPX_SWITCHES.has(key) || boolExact(`--${key}`)) return false;
	return NPX_OPTS.has(key) || !next.startsWith("-");
}

/**
 * An npx option word's dash-stripped key, its `=` value, and the word npx
 * rewrites it to — null where it rewrites none.
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
 * The bin an npx argv runs, the packages it names with `--package`, and
 * whether it asks for help. nopt reads a lone `-` as a word, and `package`
 * holds no Boolean, so a bare `--package` is the package `true` and
 * `--no-package` negates its value.
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
 * The package a `--package` word names, or null where it is none.
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
 * @param {string} segment masked
 * @param {string[]} args the words after `npx`, masked
 * @param {State} st
 * @returns {Verdict | null}
 */
function judgeNpx(segment, args, st) {
	/* Quoted spans put back, so `--r"eg"` is `--reg` and `"@biomejs/biome"` is
	 * judged by its name. An unexpanded `$VAR` keeps its visible text. */
	const words = args.map((w) => literal(w, st.spans).text);
	const { bin, pkgs, helping } = readNpx(npmCanon(npxPreparse(words)));
	if (helping) return null;
	/* `-p @scope/pkg biome ci .` states the package outright, so every `-p` is
	 * judged, npm fetching them all (#571); without one the first bare word is
	 * both the package and the bin. */
	const named = pkgs.length > 0 ? pkgs : [bin];
	for (const name of named) {
		/* No registry name, scoped, a path, or a URL/git spec. */
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

/* ----------------------------------------------------------------------- */
/* The walk.                                                                */
/* ----------------------------------------------------------------------- */

/**
 * @typedef {object} State
 * @property {NpmInstallContext} ctx
 * @property {string[]} spans
 * @property {() => string[] | null} deps package.json's names, read once;
 *   null where it will not read, logged once, and every verdict needing it
 *   then allows: the command allowed unchecked
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
			if (name === "npm") verdict = judgeNpm(cmd.segment, args, st);
			else if (name === "npx") verdict = judgeNpx(cmd.segment, args, st);
		},
		ctx,
	);
	return verdict;
}

module.exports = { decide };
