#!/usr/bin/env node

const fs = require("node:fs");
const { writeFd } = require("./lib/write-fd.js");
const os = require("node:os");
const path = require("node:path");
const { flagValue, parseOrCode } = require("./lib/cli-args");
const { scriptPath } = require("./lib/script-path.js");
const { caught } = require("./lib/caught.js");
const { CANONICAL, readSiblings } = require("./lib/plan-dirs.js");
const { isUnder } = require("./lib/is-under.js");
const { noop } = require("./lib/noop.js");

const USAGE = `Usage: node ${scriptPath("link-config-dirs.js")} [--check] [--home <dir>]`;

const SHARED = [
	"settings.json",
	"keybindings.json",
	"statusline.sh",
	"CLAUDE.md",
	"practice-crafts.md",
	"skills",
	"plugins",
	"agents",
	"commands",
	"output-styles",
];

const REGISTRIES = {
	"plugins/installed_plugins.json": mergeInstalled,
	"plugins/known_marketplaces.json": mergeMarketplaces,
};

const BACKUP = ".pre-link";

/** @param {string} p */
function readRealOrNull(p) {
	try {
		return fs.realpathSync(p);
	} catch {
		return null;
	}
}

/**
 * @param {string} sibling
 * @param {string} canonical
 * @param {string} entry
 * @returns {"linked"|"absent"|"missing"|"diverged"|"misdirected"}
 */
function state(sibling, canonical, entry) {
	const at = path.join(sibling, entry);
	const want = path.join(canonical, entry);
	let st;
	try {
		st = fs.lstatSync(at);
	} catch {
		return fs.existsSync(want) ? "missing" : "absent";
	}
	if (st.isSymbolicLink()) {
		return path.resolve(sibling, fs.readlinkSync(at)) === want &&
			readRealOrNull(want) !== null
			? "linked"
			: "misdirected";
	}
	return "diverged";
}

/**
 * @param {string} dir
 * @param {string} rel
 */
function isUnit(dir, rel) {
	return (
		fs.existsSync(path.join(dir, ".git")) ||
		/^plugins\/cache\/[^/]+\/[^/]+\/[^/]+$/.test(rel.split(path.sep).join("/"))
	);
}

/**
 * @param {string} sibling
 * @param {string} canonical
 */
function rehomeRegistries(sibling, canonical) {
	for (const [rel, merge] of Object.entries(REGISTRIES)) {
		const at = path.join(canonical, rel);
		let text;
		let parsed;
		try {
			text = fs.readFileSync(at, "utf8");
			parsed = JSON.parse(text);
		} catch {
			continue;
		}
		const base = rel.endsWith("installed_plugins.json")
			? { ...parsed, plugins: {} }
			: {};
		const out = `${JSON.stringify(merge(base, parsed, sibling, canonical), null, 2)}\n`;
		if (out !== text) fs.writeFileSync(at, out);
	}
}

/** @param {string} a @param {string} b */
function sameFile(a, b) {
	const x = fs.readFileSync(a);
	const y = fs.readFileSync(b);
	return x.equals(y);
}

/**
 * @param {unknown} p
 * @param {string} sibling
 * @param {string} canonical
 */
function rehome(p, sibling, canonical) {
	return typeof p === "string" &&
		p !== sibling &&
		isUnder(p, [sibling], path.sep)
		? path.join(canonical, p.slice(sibling.length + 1))
		: p;
}

/**
 * @param {any} ours
 * @param {any} theirs
 */
function newer(ours, theirs) {
	return String(theirs?.lastUpdated ?? "") > String(ours?.lastUpdated ?? "")
		? theirs
		: ours;
}

/**
 * @param {any} ours
 * @param {any} theirs
 * @param {string} sibling
 * @param {string} canonical
 */
function mergeInstalled(ours, theirs, sibling, canonical) {
	const out = { ...ours, plugins: { ...(ours.plugins ?? {}) } };
	const key = (/** @type {any} */ e) => `${e.scope}|${e.projectPath ?? ""}`;
	for (const [id, entries] of Object.entries(theirs.plugins ?? {})) {
		const list = [...(out.plugins[id] ?? [])];
		for (const e of entries) {
			const moved = {
				...e,
				installPath: rehome(e.installPath, sibling, canonical),
			};
			const i = list.findIndex((o) => key(o) === key(e));
			if (i === -1) list.push(moved);
			else list[i] = newer(list[i], moved);
		}
		out.plugins[id] = list;
	}
	return out;
}

/**
 * @param {any} ours
 * @param {any} theirs
 * @param {string} sibling
 * @param {string} canonical
 */
function mergeMarketplaces(ours, theirs, sibling, canonical) {
	const out = { ...ours };
	for (const [name, m] of Object.entries(theirs)) {
		const moved = {
			...m,
			installLocation: rehome(m.installLocation, sibling, canonical),
		};
		out[name] = name in out ? newer(out[name], moved) : moved;
	}
	return out;
}

/**
 * @param {string} from
 * @param {string} to
 * @param {string} rel
 * @param {{sibling: string, canonical: string, kept: string[]}} ctx
 */
function union(from, to, rel, ctx) {
	const st = fs.lstatSync(from);
	if (!fs.existsSync(to) && !isLink(to)) {
		fs.cpSync(from, to, {
			recursive: true,
			preserveTimestamps: true,
			verbatimSymlinks: true,
		});
		return;
	}
	if (st.isDirectory() && fs.lstatSync(to).isDirectory()) {
		unionDirs(from, to, rel, ctx);
		return;
	}
	const tt = fs.lstatSync(to);
	if (st.isSymbolicLink() && tt.isSymbolicLink()) {
		if (fs.readlinkSync(from) !== fs.readlinkSync(to)) ctx.kept.push(rel);
		return;
	}
	if (!st.isFile() || !tt.isFile()) {
		ctx.kept.push(rel);
		return;
	}
	if (sameFile(from, to)) return;
	if (mergeRegistry(from, to, rel, ctx)) return;
	ctx.kept.push(rel);
}

/**
 * @param {string} from
 * @param {string} to
 * @param {string} rel
 * @param {{sibling: string, canonical: string, kept: string[]}} ctx
 */
function unionDirs(from, to, rel, ctx) {
	if (isUnit(from, rel) || isUnit(to, rel)) {
		ctx.kept.push(rel);
		return;
	}
	for (const child of fs.readdirSync(from)) {
		union(
			path.join(from, child),
			path.join(to, child),
			path.join(rel, child),
			ctx,
		);
	}
}

/**
 * @param {string} from
 * @param {string} to
 * @param {string} rel
 * @param {{sibling: string, canonical: string, kept: string[]}} ctx
 * @returns {boolean}
 */
function mergeRegistry(from, to, rel, ctx) {
	const merge = REGISTRIES[/** @type {keyof typeof REGISTRIES} */ (rel)];
	if (!merge) return false;
	try {
		const merged = merge(
			JSON.parse(fs.readFileSync(to, "utf8")),
			JSON.parse(fs.readFileSync(from, "utf8")),
			ctx.sibling,
			ctx.canonical,
		);
		const pre = unique(path.join(ctx.canonical, BACKUP, rel));
		fs.mkdirSync(path.dirname(pre), { recursive: true });
		fs.copyFileSync(to, pre);
		fs.writeFileSync(to, `${JSON.stringify(merged, null, 2)}\n`);
		return true;
	} catch {
		return false;
	}
}

/** @param {string} p */
function isLink(p) {
	try {
		return fs.lstatSync(p).isSymbolicLink();
	} catch {
		return false;
	}
}

/** @param {string} p */
function unique(p) {
	let dest = p;
	for (let n = 1; fs.existsSync(dest) || isLink(dest); n++) dest = `${p}.${n}`;
	return dest;
}

/**
 * @param {string} sibling
 * @param {string} entry
 */
function backUp(sibling, entry) {
	const dir = path.join(sibling, BACKUP);
	fs.mkdirSync(dir, { recursive: true });
	const dest = unique(path.join(dir, entry));
	fs.renameSync(path.join(sibling, entry), dest);
	return dest;
}

/**
 * @param {string} sibling
 * @param {string} canonical
 * @param {string} entry
 */
function link(sibling, canonical, entry) {
	const at = path.join(sibling, entry);
	fs.symlinkSync(path.relative(sibling, path.join(canonical, entry)), at);
}

/**
 * @typedef {object} EntryFix
 * @property {string} sibling
 * @property {string} canonical
 * @property {string} entry
 * @property {"missing"|"diverged"|"misdirected"} s
 * @property {(line: string) => void} out
 * @property {string[]} kept
 */

/**
 * @param {EntryFix} fix
 * @returns {string | null}
 */
function fixEntry(fix) {
	const { sibling, canonical, entry, s, out } = fix;
	const at = path.join(sibling, entry);
	const want = path.join(canonical, entry);
	if (s === "misdirected" && !fs.existsSync(want)) {
		const target = readRealOrNull(at);
		if (target === null) {
			out(`left ${at}: it resolves nowhere and ~/.claude has no ${entry}`);
			return null;
		}
		fs.cpSync(target, want, {
			recursive: true,
			preserveTimestamps: true,
			verbatimSymlinks: true,
		});
	}
	if (s === "diverged") {
		relinkDiverged(fix, at, want);
	} else {
		if (s === "misdirected") backUp(sibling, entry);
		link(sibling, canonical, entry);
		out(`linked ${at} -> ${want}`);
	}
	return at;
}

/**
 * @param {EntryFix} fix @param {string} at @param {string} want
 */
function relinkDiverged(fix, at, want) {
	const { sibling, canonical, entry, out, kept } = fix;
	if (fs.existsSync(want)) {
		/** @type {{sibling: string, canonical: string, kept: string[]}} */
		const ctx = { sibling, canonical, kept: [] };
		union(at, want, entry, ctx);
		for (const k of ctx.kept) kept.push(path.join(sibling, k));
	} else {
		fs.cpSync(at, want, {
			recursive: true,
			preserveTimestamps: true,
			verbatimSymlinks: true,
		});
	}
	if (entry === "plugins") rehomeRegistries(sibling, canonical);
	const moved = backUp(sibling, entry);
	link(sibling, canonical, entry);
	out(`linked ${at} -> ${want} (its own copy kept at ${moved})`);
}

/**
 * @param {{home: string, check?: boolean, out?: (line: string) => void}} at
 * @returns {{drift: {sibling: string, entry: string, state: string}[],
 *   fixed: string[], kept: string[]}}
 */
function run({ home, check = false, out = noop }) {
	const canonical = path.join(home, CANONICAL);
	const drift = [];
	const fixed = [];
	/** @type {string[]} */
	const kept = [];
	for (const sibling of readSiblings(home)) {
		for (const entry of SHARED) {
			const s = state(sibling, canonical, entry);
			if (s === "linked" || s === "absent") continue;
			drift.push({ sibling, entry, state: s });
			if (check) continue;
			const at = fixEntry({ sibling, canonical, entry, s, out, kept });
			if (at !== null) fixed.push(at);
		}
	}
	for (const k of kept)
		out(
			`kept ~/.claude's copy over a differing ${k} (the sibling's is under ${BACKUP}/)`,
		);
	return { drift, fixed, kept };
}

/** @param {string[]} argv */
function main(argv) {
	const parsed = parseOrCode(argv, {
		usage: USAGE,
		flags: {
			"--home": "value",
			"--check": "boolean",
		},
	});
	if (typeof parsed === "number") return parsed;
	const { flags } = parsed;
	const home = flagValue(flags, "--home") ?? os.homedir();
	const check = flags["--check"] === true;
	const out = (/** @type {string} */ l) => writeFd(1, `${l}\n`);
	let result;
	try {
		result = run({ home, check, out });
	} catch (err) {
		writeFd(2, `link-config-dirs: ${caught(err).message}\n`);
		return 2;
	}
	return report(result.drift, check, out);
}

/**
 * @param {{sibling: string, entry: string, state: string}[]} drift
 * @param {boolean} check
 * @param {(line: string) => void} out
 * @returns {number}
 */
function report(drift, check, out) {
	if (check) {
		for (const d of drift) out(`${d.state}\t${path.join(d.sibling, d.entry)}`);
		if (drift.length === 0)
			out("OK: every shared entry is linked to ~/.claude");
		else out(`Fix: node ${path.join(__dirname, "link-config-dirs.js")}`);
		return drift.length > 0 ? 1 : 0;
	}
	if (drift.length === 0) out("every shared entry is linked to ~/.claude");
	return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { run, SHARED };
