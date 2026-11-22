#!/usr/bin/env node

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { runCheck, errMessage } = require("./lib/check");
const { gh, isNotFound, parseGhFailureReason } = require("./lib/gh");
const { caught } = require("./lib/caught.js");
const {
	LOCK,
	NOTICES,
	noticeFaults,
	readNoticeLicences,
} = require("./lib/vendored-notices.js");
const { execGit, gitCommonDir } = require("./lib/git.js");
const { isCutOver } = require("./lib/cutover.js");
const { mainCheckout } = require("./lib/main-checkout.js");
const { isUnder } = require("./lib/is-under.js");
const { commitSha } = require("./lib/commit-sha.js");

const SIDECAR = ".agents/vendored-skill-edits.json";
const SKILLS_DIR = ".agents/skills";
const RECORD = ".agents/vendored-upstream-pass.json";
const STAND_DOWN = "WFC_UPSTREAM_RECORD_OFF";
const VENDORED_AT_SHA_WIDTH = 8;
const COVERED = [LOCK, NOTICES];

/**
 * @typedef {{ editedHash: string, issue: number, why: string }} EditEntry
 * @typedef {{ rel: string, content: Buffer }} SkillFile
 * @typedef {{
 *   ranOn: string,
 *   sha256: Record<string, string | null>,
 *   licences: Record<string, "matches">,
 * }} UpstreamRecord
 * @typedef {{
 *   vendoredAt: string,
 *   vendored: Record<string, string>,
 *   edits: Record<string, EditEntry>,
 * }} Sidecar
 */

/** @param {string | Buffer} bytes */
const sha256 = (bytes) =>
	crypto.createHash("sha256").update(bytes).digest("hex");

/**
 * @param {(rel: string) => string} locate
 * @returns {Record<string, string | null>}
 */
const coveredHashes = (locate) =>
	Object.fromEntries(COVERED.map((rel) => [rel, fileHash(locate(rel))]));

/**
 * @param {string} file
 * @returns {string | null}
 */
function fileHash(file) {
	try {
		return sha256(fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n"));
	} catch (e) {
		if (caught(e).code === "ENOENT") return null;
		throw e;
	}
}

/**
 * @param {string} file
 * @param {unknown} value
 */
function writeJson(file, value) {
	fs.writeFileSync(file, `${JSON.stringify(value, null, "\t")}\n`);
}

/**
 * @param {string} root
 * @returns {string[]}
 */
function readVendoredFilesOnDisk(root) {
	const base = path.join(root, SKILLS_DIR);
	/** @type {string[]} */
	const out = [];
	/** @param {string} dir */
	const walk = (dir) => {
		for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
			const p = path.join(dir, e.name);
			if (e.isSymbolicLink()) continue;
			if (e.isDirectory()) walk(p);
			else if (e.isFile()) out.push(path.relative(root, p));
		}
	};
	if (!fs.existsSync(base)) return out;
	walk(base);
	return out.sort();
}

/**
 * A port of `computeSkillFolderHash` in
 * https://github.com/vercel-labs/skills/blob/7533583f/src/local-lock.ts:
 * sha256 over every file in one skill folder, sorted by relative path with
 * `localeCompare`, each file's path then its bytes; `.git` and `node_modules`
 * skipped, hidden files kept, symlinks skipped.
 *
 * @param {string} dir
 * @returns {string}
 */
function skillFolderHash(dir) {
	/** @type {SkillFile[]} */
	const files = [];
	collectSkillFiles(dir, dir, files);
	return hashSkillFiles(files);
}

/**
 * @param {SkillFile[]} files
 * @returns {string}
 */
function hashSkillFiles(files) {
	const sorted = [...files].sort((a, b) => a.rel.localeCompare(b.rel));
	const h = crypto.createHash("sha256");
	for (const f of sorted) {
		h.update(f.rel);
		h.update(f.content);
	}
	return h.digest("hex");
}

/**
 * @param {string} dir
 * @param {string} cur
 * @param {SkillFile[]} files
 */
function collectSkillFiles(dir, cur, files) {
	for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
		const p = path.join(cur, e.name);
		if (e.isSymbolicLink()) continue;
		if (e.isDirectory()) {
			if (e.name === ".git" || e.name === "node_modules") continue;
			collectSkillFiles(dir, p, files);
		} else if (e.isFile())
			files.push({
				rel: path.relative(dir, p).split(path.sep).join("/"),
				content: fs.readFileSync(p),
			});
	}
}

/**
 * @param {string} root
 * @returns {Sidecar}
 */
function loadSidecar(root) {
	const file = path.join(root, SIDECAR);
	let raw;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch (e) {
		throw new Error(`cannot read ${SIDECAR}: ${errMessage(e)}`, {
			cause: e,
		});
	}
	const parsed = JSON.parse(raw);
	if (!parsed || typeof parsed !== "object" || !parsed.vendored)
		throw new Error(`${SIDECAR} has no \`vendored\` manifest.`);
	parsed.edits ||= {};
	return parsed;
}

/**
 * @param {string} root
 * @returns {{ locked: string[], onDisk: string[], hashes: Record<string, string> } | { unreadable: string } | null}
 */
function readLockRoster(root) {
	const lockFile = path.join(root, LOCK);
	const base = path.join(root, SKILLS_DIR);
	if (!fs.existsSync(lockFile) || !fs.existsSync(base)) return null;
	let locked;
	/** @type {Record<string, string>} */
	const hashes = {};
	try {
		const skills = JSON.parse(fs.readFileSync(lockFile, "utf8")).skills;
		locked = Object.keys(skills);
		for (const [name, e] of Object.entries(skills)) {
			const h = /** @type {{ computedHash?: unknown }} */ (e)?.computedHash;
			if (typeof h === "string") hashes[name] = h;
		}
	} catch (e) {
		return { unreadable: errMessage(e) };
	}
	const onDisk = fs
		.readdirSync(base, { withFileTypes: true })
		.filter((e) => e.isDirectory())
		.map((e) => e.name);
	return { locked: locked.sort(), onDisk: onDisk.sort(), hashes };
}

/**
 * @param {string} root
 * @param {string} rel
 * @param {number} issue
 * @param {string} why
 */
function declare(root, rel, issue, why) {
	const sidecar = loadSidecar(root);
	const abs = path.join(root, rel);
	if (!fs.existsSync(abs)) throw new Error(`no such file: ${rel}`);
	const disk = sha256(fs.readFileSync(abs));
	if (sidecar.vendored[rel] === disk)
		throw new Error(
			`${rel} matches the vendored bytes — there is no edit to declare.`,
		);
	sidecar.edits[rel] = { editedHash: disk, issue, why };
	sidecar.edits = sortKeys(sidecar.edits);
	writeJson(path.join(root, SIDECAR), sidecar);
	return `declared ${rel} (#${issue}): ${why}`;
}

/**
 * @param {string} root
 * @param {string} rel
 */
function drop(root, rel) {
	const sidecar = loadSidecar(root);
	if (!(rel in sidecar.edits)) throw new Error(`${rel} is not declared.`);
	delete sidecar.edits[rel];
	writeJson(path.join(root, SIDECAR), sidecar);
	return `dropped the declaration for ${rel}`;
}

/**
 * @param {string} root
 * @param {string} rel
 */
function forget(root, rel) {
	const sidecar = loadSidecar(root);
	if (!(rel in sidecar.vendored))
		throw new Error(`${rel} is not in the vendored manifest.`);
	if (fs.existsSync(path.join(root, rel)))
		throw new Error(
			`${rel} still exists — --forget records a de-vendoring, not an edit.`,
		);
	delete sidecar.vendored[rel];
	delete sidecar.edits[rel];
	writeJson(path.join(root, SIDECAR), sidecar);
	return `forgot ${rel} — de-vendored, no longer expected on disk`;
}

/**
 * @param {string} cwd
 * @param {string} rev
 * @param {string} dir
 * @returns {{ file: string, content: Buffer }[]}
 */
function readBlobsAt(cwd, rev, dir) {
	const rows = execGit(
		["ls-tree", "-r", "-z", "--full-tree", rev, "--", `${dir}/`],
		{ cwd, encoding: "utf8" },
	)
		.split("\0")
		.filter(Boolean);
	const blobs = [];
	for (const row of rows) {
		const mode = row.slice(0, 6);
		if (mode !== "100644" && mode !== "100755") continue;
		const file = row.slice(row.indexOf("\t") + 1);
		blobs.push({ file, content: execGit(["show", `${rev}:${file}`], { cwd }) });
	}
	return blobs;
}

/**
 * @param {string} root
 * @param {string} rev
 */
function revendor(root, rev) {
	const at = execGit(["rev-parse", "--short", rev], {
		cwd: root,
		encoding: "utf8",
	}).trim();
	const blobs = readBlobsAt(root, at, SKILLS_DIR);
	if (blobs.length === 0)
		throw new Error(`${at} has no files under ${SKILLS_DIR}/.`);
	/** @type {Record<string, string>} */
	const vendored = {};
	for (const b of blobs) vendored[b.file] = sha256(b.content);
	const sidecar = fs.existsSync(path.join(root, SIDECAR))
		? loadSidecar(root)
		: /** @type {Sidecar} */ ({ vendoredAt: at, vendored: {}, edits: {} });
	sidecar.vendoredAt = at;
	sidecar.vendored = sortKeys(vendored);
	writeJson(path.join(root, SIDECAR), sidecar);
	return `recorded ${blobs.length} vendored file(s) as supplied at ${at}`;
}

/**
 * @param {string} clone
 * @returns {string}
 */
function readCloneSource(clone) {
	let url;
	try {
		url = execGit(["config", "--get", "remote.origin.url"], {
			cwd: clone,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch (e) {
		throw new Error(
			`${clone} has no \`origin\` remote, so nothing says which upstream it is a clone of. Clone the upstream repo from GitHub and pass that.`,
			{ cause: e },
		);
	}
	const m = /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec(url);
	if (!m?.[1])
		throw new Error(
			`${clone}'s \`origin\` (${url}) is not a GitHub repo, so it matches no \`source\` in ${LOCK}.`,
		);
	return m[1];
}

/**
 * @param {string} clone
 * @param {string} sha
 * @param {string} folder
 * @returns {SkillFile[]}
 */
function readUpstreamFolder(clone, sha, folder) {
	return readBlobsAt(clone, sha, folder)
		.map((b) => ({ rel: b.file.slice(folder.length + 1), content: b.content }))
		.filter((f) => !f.rel.split("/").includes("node_modules"));
}

/**
 * @param {Record<string, string>} vendored
 * @param {string} name
 * @param {SkillFile[]} supplied
 */
function replaceSkillRows(vendored, name, supplied) {
	const dir = `${SKILLS_DIR}/${name}`;
	for (const rel of Object.keys(vendored))
		if (isUnder(rel, [dir])) delete vendored[rel];
	for (const f of supplied) vendored[`${dir}/${f.rel}`] = sha256(f.content);
}

/**
 * @param {string} root
 * @param {string} rev
 * @param {string} from
 */
function revendorFrom(root, rev, from) {
	const clone = path.resolve(from);
	if (!fs.existsSync(clone)) throw new Error(`no such directory: ${from}`);
	const source = readCloneSource(clone);
	const sha = commitSha(clone, rev);
	if (sha === null)
		throw new Error(
			`${rev} names no commit in ${from} — fetch the tag there, or check its spelling.`,
		);
	const lockFile = path.join(root, LOCK);
	const lock = JSON.parse(fs.readFileSync(lockFile, "utf8"));
	const sidecar = loadSidecar(root);
	const skills = Object.entries(
		/** @type {Record<string, { source?: string, skillPath?: string, computedHash?: string }>} */ (
			lock.skills
		),
	).filter(
		([name, e]) =>
			e.source === source &&
			e.skillPath &&
			fs.existsSync(path.join(root, SKILLS_DIR, name)),
	);
	if (skills.length === 0)
		throw new Error(
			`${LOCK} sources no skill under ${SKILLS_DIR}/ from ${source}, which is what ${from}'s \`origin\` names.`,
		);
	const vendored = { ...sidecar.vendored };
	let files = 0;
	/** @type {string[]} */
	const moved = [];
	for (const [name, entry] of skills) {
		const folder = path.posix.dirname(/** @type {string} */ (entry.skillPath));
		const supplied = readUpstreamFolder(clone, sha, folder);
		if (supplied.length === 0)
			throw new Error(
				`${source} has no ${folder}/ at ${rev}, where ${LOCK} places "${name}" — renamed or dropped upstream. Nothing was written: correct its skillPath in ${LOCK}, or de-vendor it, then run this again.`,
			);
		replaceSkillRows(vendored, name, supplied);
		files += supplied.length;
		const hash = hashSkillFiles(supplied);
		if (entry.computedHash !== hash) moved.push(name);
		entry.computedHash = hash;
	}
	const short = execGit(
		["rev-parse", `--short=${VENDORED_AT_SHA_WIDTH}`, sha],
		{
			cwd: clone,
			encoding: "utf8",
		},
	).trim();
	sidecar.vendoredAt = `${source}@${short}${sha.startsWith(rev) ? "" : ` (${rev})`}`;
	sidecar.vendored = sortKeys(vendored);
	writeJson(path.join(root, SIDECAR), sidecar);
	fs.writeFileSync(lockFile, `${JSON.stringify(lock, null, 2)}\n`);
	const lockLine =
		moved.length > 0
			? `${LOCK} takes a new computedHash for ${moved.join(", ")}`
			: `${LOCK} already held every computedHash`;
	return `recorded ${files} file(s) of ${skills.length} skill(s) as ${sidecar.vendoredAt} supplies them; ${lockLine}.`;
}

/** @param {Record<string, any>} obj */
function sortKeys(obj) {
	/** @type {Record<string, any>} */
	const out = {};
	for (const k of Object.keys(obj).sort()) out[k] = obj[k];
	return out;
}

/**
 * @param {Record<string, { source?: string, skillPath?: string }>} lock
 * @param {string} rel
 * @returns {{ source: string, remotePath: string } | null}
 */
function remoteFor(lock, rel) {
	const [, , skill, ...tail] = rel.split("/");
	if (skill === undefined || tail.length === 0) return null;
	const entry = lock[skill];
	if (!entry?.source || !entry?.skillPath) return null;
	return {
		source: entry.source,
		remotePath: `${path.posix.dirname(entry.skillPath)}/${tail.join("/")}`,
	};
}

/**
 * @typedef {{ body: string }
 *   | { error: string, notFound: boolean, broken: boolean }} FetchResult
 * @typedef {{
 *   rel: string,
 *   entry: EditEntry,
 *   state: "moved" | "taken" | "same" | "gone" | "unreadable" | "unresolved" | "fault",
 *   detail?: string,
 * }} UpstreamRow
 * @typedef {{
 *   source: string,
 *   state: "differs" | "same" | "gone" | "unreadable" | "fault",
 *   detail?: string,
 * }} LicenceRow
 */

/**
 * @param {string} root
 * @returns {UpstreamRow[]}
 */
function buildUpstreamReport(root) {
	const sidecar = loadSidecar(root);
	const lock = JSON.parse(
		fs.readFileSync(path.join(root, LOCK), "utf8"),
	).skills;
	/** @type {UpstreamRow[]} */
	const rows = [];
	for (const [rel, entry] of Object.entries(sidecar.edits)) {
		const remote = remoteFor(lock, rel);
		if (!remote) {
			rows.push({
				rel,
				entry,
				state: "unresolved",
				detail: `${LOCK} gives no source and skillPath for "${rel.split("/")[2]}"`,
			});
			continue;
		}
		const where = `${remote.source}/${remote.remotePath}`;
		const got = ghFetch(`repos/${remote.source}/contents/${remote.remotePath}`);
		const added = sidecar.vendored[rel] === undefined;
		if (added && "error" in got && got.notFound) {
			rows.push({ rel, entry, state: "same" });
			continue;
		}
		if ("error" in got) {
			rows.push({
				rel,
				entry,
				state: failedState(got),
				detail: `${where}: ${got.error}`,
			});
			continue;
		}
		/** @type {UpstreamRow["state"]} */
		let state = "moved";
		if (added) state = "taken";
		else if (sha256(got.body) === sidecar.vendored[rel]) state = "same";
		rows.push({ rel, entry, state });
	}
	return rows;
}

/**
 * @param {string} root
 * @returns {LicenceRow[]}
 */
function buildLicenceReport(root) {
	/** @type {LicenceRow[]} */
	const rows = [];
	for (const [source, notice] of readNoticeLicences(root)) {
		const got = ghFetch(`repos/${source}/license`);
		if ("error" in got)
			rows.push({
				source,
				state: failedState(got),
				detail: `${source} licence: ${got.error}`,
			});
		else
			rows.push({
				source,
				state:
					normalisedLicence(got.body) === normalisedLicence(notice)
						? "same"
						: "differs",
			});
	}
	return rows;
}

/** @param {string} text */
const normalisedLicence = (text) =>
	text
		.split(/\r?\n/)
		.map((l) => l.trimEnd())
		.join("\n")
		.trim();

/**
 * @param {{ notFound: boolean, broken: boolean }} failed
 * @returns {"gone" | "fault" | "unreadable"}
 */
function failedState(failed) {
	if (failed.notFound) return "gone";
	return failed.broken ? "fault" : "unreadable";
}

/**
 * @param {string} endpoint
 * @returns {FetchResult}
 */
function ghFetch(endpoint) {
	try {
		const json = gh(["api", endpoint, "--jq", ".content"]);
		return { body: Buffer.from(json.trim(), "base64").toString("utf8") };
	} catch (e) {
		const stderr = String(caught(e).stderr ?? "").trim();
		const notFound = isNotFound(e);
		return {
			error: stderr.split("\n")[0] || errMessage(e),
			notFound,
			broken: !notFound && parseGhFailureReason(e) === "broken",
		};
	}
}

/** @type {string | undefined} */
let selfPath;
/** @param {string} args */
function buildSelfCommand(args) {
	if (selfPath === undefined) {
		const roots = [process.cwd()];
		const common = gitCommonDir(process.cwd());
		if (common !== null) roots.push(path.dirname(common));
		const real = (/** @type {string} */ dir) => {
			try {
				return fs.realpathSync(dir);
			} catch {
				return dir;
			}
		};
		const rel = path.join("scripts", path.basename(__filename));
		const self = real(__filename);
		selfPath = roots.some((r) => real(path.join(r, rel)) === self)
			? rel
			: `"${__filename}"`;
	}
	return `node ${selfPath} ${args}`;
}

/** @param {string} rel */
const buildDeclareCommand = (rel) =>
	buildSelfCommand(`--declare ${rel} --issue <n> --why "<one line>"`);

/** @param {string} rel */
function skillOf(rel) {
	const skill = rel.split("/")[2];
	if (skill === undefined)
		throw new Error(`${rel} names no skill: want ${SKILLS_DIR}/<skill>/…`);
	return skill;
}

/**
 * @param {import("./lib/check").Ctx} ctx
 * @param {{ root: string, sidecar: Sidecar, onDisk: string[], seen: Set<string> }} tree
 * @returns {Set<string>}
 */
function checkFiles(ctx, { root, sidecar, onDisk, seen }) {
	/** @type {Set<string>} */
	const notClean = new Set();
	for (const rel of Object.keys(sidecar.vendored))
		if (!seen.has(rel)) notClean.add(skillOf(rel));

	for (const rel of onDisk) {
		const disk = sha256(fs.readFileSync(path.join(root, rel)));
		const vendored = sidecar.vendored[rel];
		const entry = sidecar.edits[rel];
		if (entry || disk !== vendored) notClean.add(skillOf(rel));
		fileFinding(ctx, {
			rel,
			disk,
			vendored,
			entry,
			vendoredAt: sidecar.vendoredAt,
		});
	}
	return notClean;
}

/**
 * @param {import("./lib/check").Ctx} ctx
 * @param {{ rel: string, disk: string, vendored: string | undefined, entry: EditEntry | undefined, vendoredAt: string }} file
 */
function fileFinding(ctx, { rel, disk, vendored, entry, vendoredAt }) {
	if (vendored === undefined && !entry) {
		ctx.fail(
			"UNTRACKED",
			`${rel} is not in the vendored manifest — it was added locally after ${vendoredAt}. Declare it, or remove it:\n    ${buildDeclareCommand(rel)}`,
			{ path: rel },
		);
		return;
	}
	if (disk === vendored) {
		if (entry)
			ctx.fail(
				"STALE-ENTRY",
				`${rel} is declared as a local edit (#${entry.issue}: ${entry.why}) but now matches the vendored bytes — the edit was reverted. Drop the declaration:\n    ${buildSelfCommand(`--drop ${rel}`)}`,
				{ path: rel },
			);
		return;
	}
	if (!entry) {
		ctx.fail(
			"UNDECLARED",
			`${rel} differs from the bytes vendored at ${vendoredAt}, and nothing says the edit was deliberate. A re-pull would revert it silently. Declare it:\n    ${buildDeclareCommand(rel)}`,
			{ path: rel },
		);
		return;
	}
	if (entry.editedHash !== disk)
		ctx.fail(
			"DRIFTED",
			`${rel} has been edited again since it was declared (#${entry.issue}: ${entry.why}). Re-declare it so the record says what the file now holds:\n    ${buildDeclareCommand(rel)}`,
			{ path: rel },
		);
}

/**
 * @param {import("./lib/check").Ctx} ctx
 * @param {Sidecar} sidecar
 * @param {Set<string>} seen
 */
function warnRemoved(ctx, sidecar, seen) {
	for (const rel of Object.keys(sidecar.vendored))
		if (!seen.has(rel))
			ctx.warn(
				"REMOVED",
				`${rel} is in the vendored manifest but not on disk. De-vendoring is a real move (mantahostels#1502, mantahostels#1757) — if that is what happened, record it:\n    ${buildSelfCommand(`--forget ${rel}`)}`,
				{ path: rel },
			);
}

/**
 * @param {import("./lib/check").Ctx} ctx
 * @param {Sidecar} sidecar
 * @param {Set<string>} seen
 */
function failRemovedAdditions(ctx, sidecar, seen) {
	for (const [rel, entry] of Object.entries(sidecar.edits))
		if (!(rel in sidecar.vendored) && !seen.has(rel))
			ctx.fail(
				"STALE-ENTRY",
				`${rel} is declared as an added file (#${entry.issue}: ${entry.why}) but is not on disk — the addition was removed. Drop the declaration:\n    ${buildSelfCommand(`--drop ${rel}`)}`,
				{ path: rel },
			);
}

/**
 * @param {import("./lib/check").Ctx} ctx
 * @param {string} root
 * @param {Set<string>} notClean
 */
function checkLock(ctx, root, notClean) {
	const roster = readLockRoster(root);
	if (!roster) return;
	if ("unreadable" in roster) {
		ctx.warn(
			"LOCK-UNREADABLE",
			`${LOCK} is on disk but will not parse (${roster.unreadable}), so every verdict that reads it — LOCK-ORPHAN, LOCK-MISSING, LOCK-HASH — went unrun. Fix the file, or a re-pull will act on it as it stands.`,
			{ path: LOCK },
		);
		return;
	}
	for (const name of roster.locked)
		if (!roster.onDisk.includes(name))
			ctx.warn(
				"LOCK-ORPHAN",
				`${LOCK} lists "${name}" but ${SKILLS_DIR}/${name}/ does not exist — a re-pull would re-fetch a skill nobody has.`,
				{ skill: name },
			);
	for (const name of roster.onDisk)
		if (!roster.locked.includes(name))
			ctx.warn(
				"LOCK-MISSING",
				`${SKILLS_DIR}/${name}/ exists but ${LOCK} does not list it — a re-pull would leave it behind.`,
				{ skill: name },
			);
	for (const name of roster.onDisk)
		lockHashFinding(ctx, { root, name, locked: roster.hashes[name], notClean });
}

/**
 * @param {import("./lib/check").Ctx} ctx
 * @param {{ root: string, name: string, locked: string | undefined, notClean: Set<string> }} skill
 */
function lockHashFinding(ctx, { root, name, locked, notClean }) {
	if (!locked || notClean.has(name)) return;
	const got = skillFolderHash(path.join(root, SKILLS_DIR, name));
	if (got !== locked)
		ctx.warn(
			"LOCK-HASH",
			`${SKILLS_DIR}/${name}/ matches the manifest and carries no declared edit, yet its folder hash (${got.slice(0, 12)}) differs from the ${locked.slice(0, 12)} ${LOCK} recorded at install. The manifest is the first suspect, not the files: a --revendor pointed at a commit that already carried an undeclared edit would read exactly like this. Re-run --revendor at what was pulled (--at <tag> --from <a clone of the upstream repo>, or --at <the vendoring commit>), or re-install the skill. But where several clean skills say this at once, suspect the port instead — this checker's copy of upstream's construction, or the locale it sorts paths under.`,
			{ skill: name },
		);
}

/**
 * @param {import("./lib/check").Ctx} ctx
 * @param {string} root
 */
function check(ctx, root) {
	if (
		!fs.existsSync(path.join(root, SIDECAR)) &&
		!fs.existsSync(path.join(root, SKILLS_DIR))
	)
		return ctx.skip(
			`this repo has no ${SIDECAR} and no ${SKILLS_DIR} — nothing vendored to check`,
		);
	let sidecar;
	try {
		sidecar = loadSidecar(root);
	} catch (e) {
		return ctx.broken(errMessage(e));
	}

	const onDisk = readVendoredFilesOnDisk(root);
	const seen = new Set(onDisk);
	const notClean = checkFiles(ctx, { root, sidecar, onDisk, seen });
	warnRemoved(ctx, sidecar, seen);
	failRemovedAdditions(ctx, sidecar, seen);
	checkLock(ctx, root, notClean);
	const roster = readLockRoster(root);
	if (roster && !("unreadable" in roster))
		for (const fault of noticeFaults(root))
			ctx.fail("NOTICE-MISSING", fault, { path: LOCK });

	const declared = Object.keys(sidecar.edits).length;
	return {
		okLine: `${onDisk.length} vendored file(s) match what was supplied at ${sidecar.vendoredAt}, bar ${declared} declared local edit(s).`,
		noun: "vendored-skill finding(s)",
		data: {
			vendoredAt: sidecar.vendoredAt,
			files: onDisk.length,
			declared,
		},
	};
}

/**
 * @param {import("./lib/check").Ctx} ctx
 * @param {string} root
 */
function runDeclare(ctx, root) {
	const rel = ctx.value("--declare", "");
	const issue = Number(ctx.value("--issue", ""));
	const why = ctx.value("--why", "");
	if (!Number.isInteger(issue) || issue <= 0)
		ctx.usageError(
			"--declare needs --issue <n>: an edit nobody approved is not an intended divergence.",
		);
	if (!why.trim())
		ctx.usageError(
			'--declare needs --why "<one line>": a hash with no reason is the state this replaced.',
		);
	ctx.say(declare(root, rel, issue, why));
	return { okLine: "declared." };
}

/** @type {[string, (ctx: import("./lib/check").Ctx, root: string) => { okLine: string }][]} */
const WRITE_COMMANDS = [
	["--declare", runDeclare],
	[
		"--drop",
		(ctx, root) => {
			ctx.say(drop(root, ctx.value("--drop", "")));
			return { okLine: "dropped." };
		},
	],
	[
		"--forget",
		(ctx, root) => {
			ctx.say(forget(root, ctx.value("--forget", "")));
			return { okLine: "forgotten." };
		},
	],
	[
		"--revendor",
		(ctx, root) => {
			const rev = ctx.value("--at", "");
			if (!rev) ctx.usageError("--revendor needs --at <rev>.");
			const from = ctx.value("--from", "");
			ctx.say(from ? revendorFrom(root, rev, from) : revendor(root, rev));
			return { okLine: "re-recorded." };
		},
	],
];

/** @type {Record<string, { code: string, message: (r: UpstreamRow, edit: string) => string }>} */
const UPSTREAM_WARNINGS = {
	moved: {
		code: "UPSTREAM-MOVED",
		message: (r, edit) =>
			`${r.rel} carries a local edit (${edit}) AND has moved upstream since we vendored it. A re-pull is a merge here, not a re-apply.`,
	},
	taken: {
		code: "UPSTREAM-TAKEN",
		message: (r, edit) =>
			`${r.rel} was added locally (${edit}) AND upstream now ships a file at the same path. A re-pull is a merge here, not a re-apply.`,
	},
	gone: {
		code: "UPSTREAM-GONE",
		message: (r, edit) =>
			`${r.rel} carries a local edit (${edit}) and GitHub 404s on it — the path was renamed or dropped, or the repo ${LOCK} names is gone, private or misspelt. Check the source before treating this as an upstream move. ${r.detail}`,
	},
	unreadable: {
		code: "UPSTREAM-UNREADABLE",
		message: (r, edit) =>
			`${r.rel} carries a local edit (${edit}) and its upstream body could not be fetched, so whether a re-pull collides is unknown. ${r.detail}`,
	},
	unresolved: {
		code: "UPSTREAM-UNRESOLVED",
		message: (r, edit) =>
			`${r.rel} carries a local edit (${edit}) and there is no upstream to ask: ${r.detail}.`,
	},
};

/**
 * @type {Partial<Record<LicenceRow["state"], { code: string, message: (r: LicenceRow) => string }>>}
 */
const LICENCE_WARNINGS = {
	differs: {
		code: "UPSTREAM-LICENCE",
		message: (r) =>
			`${r.source}'s licence upstream differs from the text under ${NOTICES}'s \`## ${r.source}\` section — upstream may have relicensed or changed its copyright line, or the section never held it verbatim. Refresh that section's licence text verbatim from upstream:\n    gh api repos/${r.source}/license --jq .content | base64 -d`,
	},
	gone: {
		code: "UPSTREAM-GONE",
		message: (r) =>
			`${r.source} has no licence GitHub can find — its LICENSE file was dropped, or the repo ${LOCK} names is gone, private or misspelt. Check the source before a re-pull: ${NOTICES}'s \`## ${r.source}\` section may name terms upstream no longer grants. ${r.detail}`,
	},
	unreadable: {
		code: "UPSTREAM-UNREADABLE",
		message: (r) =>
			`${r.source}'s licence could not be fetched, so whether ${NOTICES}'s \`## ${r.source}\` section still matches upstream is unknown. ${r.detail}`,
	},
};

/**
 * @param {import("./lib/check").Ctx} ctx
 * @param {UpstreamRow} r
 */
function reportUpstreamRow(ctx, r) {
	const edit = `#${r.entry.issue}: ${r.entry.why}`;
	const warning = UPSTREAM_WARNINGS[r.state];
	if (warning)
		ctx.warn(warning.code, warning.message(r, edit), { path: r.rel });
	else
		ctx.say(
			`  ${r.rel} — upstream unchanged; the edit (#${r.entry.issue}) re-applies cleanly.`,
		);
}

/**
 * @param {import("./lib/check").Ctx} ctx
 * @param {string} root
 */
function runUpstream(ctx, root) {
	let rows;
	let licences;
	/** @type {Record<string, string | null>} */
	let read;
	try {
		read = coveredHashes((rel) => path.join(root, rel));
		rows = buildUpstreamReport(root);
		licences = buildLicenceReport(root);
	} catch (e) {
		return ctx.broken(errMessage(e));
	}
	const fault = [...rows, ...licences].find((r) => r.state === "fault");
	if (fault)
		return ctx.broken(
			`the upstream fetch failed, and not because GitHub was unreachable (${fault.detail}).\n        This is a fault in the check, not a finding about upstream.`,
		);
	const unreadable = [...rows, ...licences].filter(
		(r) => r.state === "unreadable",
	);
	const [firstUnreadable] = unreadable;
	if (firstUnreadable && unreadable.length === rows.length + licences.length) {
		const unread = [
			rows.length > 0 && `${rows.length} edited file(s)`,
			licences.length > 0 && `${licences.length} licence(s)`,
		]
			.filter(Boolean)
			.join(" or ");
		return ctx.skip(
			`could not read upstream's copy of the ${unread} checked — GitHub unreachable, or \`gh\` unauthenticated. First: ${firstUnreadable.detail}`,
		);
	}
	for (const r of rows) reportUpstreamRow(ctx, r);
	for (const r of licences) {
		const warning = LICENCE_WARNINGS[r.state];
		if (warning) ctx.warn(warning.code, warning.message(r), { path: NOTICES });
	}
	for (const f of ctx.findings) ctx.say(`${f.severity}: ${f.message}`);
	if (rows.some((r) => UPSTREAM_WARNINGS[r.state]))
		ctx.say(
			"  Re-pull, then: --revendor --at <the pulled tag> --from <a clone of the upstream repo>, re-apply each edit by hand, and --declare it again.",
		);
	writeRecord(ctx, root, read, licences);
	return {
		okLine: `${rows.length} declared edit(s) and ${licences.length} licence notice(s), none of them colliding with an upstream change.`,
		noun: "upstream finding(s)",
	};
}

/**
 * @param {import("./lib/check").Ctx} ctx
 * @param {string} root
 * @param {Record<string, string | null>} read
 * @param {LicenceRow[]} licences
 */
function writeRecord(ctx, root, read, licences) {
	const unmatched = licences.filter((r) => r.state !== "same");
	if (unmatched.length > 0) {
		ctx.say(
			`  No ${RECORD} written: the licence of ${unmatched.map((r) => r.source).join(", ")} was not read as matching. A commit staging ${LOCK} is refused until a run writes one.`,
		);
		return;
	}
	if (!ctx.has("--write")) {
		ctx.say(
			`  ${RECORD} is due: run again with --write to write it, then stage it with ${LOCK}.`,
		);
		return;
	}
	/** @type {UpstreamRecord} */
	const record = {
		ranOn: new Date().toISOString().slice(0, 10),
		sha256: read,
		licences: Object.fromEntries(
			licences.map((r) => [r.source, /** @type {const} */ ("matches")]),
		),
	};
	writeJson(path.join(root, RECORD), record);
	ctx.say(`  Wrote ${RECORD}; stage it with ${LOCK}.`);
}

/**
 * @param {import("./lib/check").Ctx} ctx
 * @param {string} dir
 */
function runCovered(ctx, dir) {
	if ((process.env[STAND_DOWN] ?? "") !== "")
		return ctx.skip(
			`${STAND_DOWN} is set — the upstream-record check stood down for this commit. Name it on the commit's Weakens: line.`,
		);
	/** @param {string} rel */
	const staged = (rel) => path.join(dir, path.basename(rel));
	if (!fs.existsSync(staged(SIDECAR)))
		return ctx.skip(
			`no ${SIDECAR} staged — nothing vendored, so no upstream record is owed.`,
		);
	const hashes = coveredHashes(staged);
	if (hashes[LOCK] === null)
		return { okLine: `no ${LOCK} staged, so no upstream record is owed.` };
	const fix = `Run, then stage the ${RECORD} it writes with this commit:\n    ${buildSelfCommand("--upstream --write")}\n  Only where GitHub is unreachable and that run SKIPs: ${STAND_DOWN}=1 stands this check down for one commit, named on its Weakens: line.`;
	const stale = recordFault(staged(RECORD), hashes);
	if (stale)
		ctx.fail(
			stale.tag,
			`${LOCK} is staged, and ${stale.why} — no completed --upstream run is on record for the lock and licence notices this commit lands (#2394). ${fix}`,
			{ path: RECORD },
		);
	for (const f of ctx.findings) ctx.say(`${f.severity}: ${f.message}`);
	return {
		okLine: `${RECORD} covers the staged ${LOCK} and ${NOTICES}.`,
		noun: "upstream-record finding(s)",
	};
}

/**
 * @param {string} file
 * @param {Record<string, string | null>} staged
 * @returns {{ tag: string, why: string } | null}
 */
function recordFault(file, staged) {
	let raw;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch (e) {
		if (caught(e).code !== "ENOENT") throw e;
		return { tag: "RECORD-MISSING", why: `${RECORD} is not staged` };
	}
	/** @type {Partial<UpstreamRecord> | null} */
	let record;
	try {
		record = JSON.parse(raw);
	} catch (e) {
		return {
			tag: "RECORD-UNREADABLE",
			why: `the staged ${RECORD} will not parse (${errMessage(e)})`,
		};
	}
	const hashes = record?.sha256;
	if (!hashes || typeof hashes !== "object")
		return {
			tag: "RECORD-UNREADABLE",
			why: `the staged ${RECORD} holds no sha256 map`,
		};
	const differ = Object.keys(staged).filter(
		(rel) => hashes[rel] !== staged[rel],
	);
	return differ.length === 0
		? null
		: {
				tag: "RECORD-STALE",
				why: `the staged ${RECORD} (run on ${record?.ranOn ?? "an unrecorded date"}) was written over a different ${differ.join(" and ")}`,
			};
}

/** @param {string} root */
function isCutOverMainCheckout(root) {
	const top = mainCheckout(root);
	if (top === null || fs.realpathSync(top) !== fs.realpathSync(root))
		return false;
	return isCutOver(top);
}

/**
 * @param {import("./lib/check").Ctx} ctx
 * @param {string} root
 */
function upstreamMode(ctx, root) {
	if (ctx.has("--write") && isCutOverMainCheckout(root))
		ctx.usageError(
			`--write refused: ${root} is the main checkout, which takes no edits once cut over (#4229). Run it in your own worktree.`,
		);
	return runUpstream(ctx, root);
}

const SPEC = {
	name: "check-vendored-skills",
	usage:
		'node check-vendored-skills.js [--root <dir>] [--json] [--warn] | --declare <path> --issue <n> --why "<line>" | --drop <path> | --forget <path> | --revendor --at <rev> [--from <upstream clone>] | --upstream [--write] | --covered <dir>',
	valueFlags: [
		"--root",
		"--covered",
		"--declare",
		"--drop",
		"--forget",
		"--at",
		"--from",
		"--issue",
		"--why",
	],
	flags: ["--revendor", "--upstream", "--write"],
	run(/** @type {import("./lib/check").Ctx} */ ctx) {
		const root = path.resolve(ctx.value("--root", process.cwd()));

		for (const flag of ["--declare", "--drop", "--forget", "--revendor"])
			if (ctx.has(flag) && ctx.asJson)
				ctx.usageError(
					`${flag} writes and checks nothing, so it has no --json form.`,
				);

		try {
			for (const [flag, command] of WRITE_COMMANDS)
				if (ctx.has(flag)) return command(ctx, root);
		} catch (e) {
			return ctx.broken(errMessage(e));
		}

		if (ctx.has("--from"))
			ctx.usageError(
				"--from names the clone --revendor reads, so it needs --revendor.",
			);
		if (ctx.has("--upstream")) return upstreamMode(ctx, root);
		if (ctx.has("--write"))
			ctx.usageError(
				"--write names --upstream's record, so it needs --upstream.",
			);
		if (ctx.has("--covered"))
			return runCovered(ctx, path.resolve(ctx.value("--covered", "")));

		const result = check(ctx, root);
		for (const f of ctx.findings) ctx.say(`${f.severity}: ${f.message}`);
		return result;
	},
};

module.exports = { SPEC };
if (require.main === module) runCheck(SPEC);
