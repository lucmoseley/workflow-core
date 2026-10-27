#!/usr/bin/env node
/*
 * check-vendored-skills.js — a local edit to a vendored skill body is declared,
 * or it is a finding.
 *
 * Usage:
 *   node scripts/check-vendored-skills.js [--root <dir>] [--json] [--warn]
 *   node scripts/check-vendored-skills.js --declare <path> --issue <n> --why "<one line>"
 *   node scripts/check-vendored-skills.js --drop <path>
 *   node scripts/check-vendored-skills.js --forget <path>
 *   node scripts/check-vendored-skills.js --revendor --at <rev>
 *   node scripts/check-vendored-skills.js --upstream
 *   node scripts/check-vendored-skills.js --covered <dir>
 *
 * THE PROBLEM (mantahostels#1809, specified at mantahostels#1826).
 * `.agents/skills/` holds 24 skills vendored from two upstreams — 23 from
 * mattpocock/skills and `animate` from emilkowalski/skills — symlinked into
 * `.claude/skills/`. Some of their files carry deliberate local edits, and
 * nothing else records which are deliberate, so a re-pull would overwrite them
 * silently and an accidental edit looks identical to a deliberate one.
 *
 * WHY NOT `skills-lock.json`'s `computedHash` ALONE. It is reproducible under
 * the same locale (mantahostels#3522). The construction is
 * `computeSkillFolderHash` in vercel-labs/skills `src/local-lock.ts`, read at
 * 7533583f: sha256 over every file in the SKILL FOLDER, sorted by relative path
 * with `localeCompare`, each file's path then its bytes fed to one digest. Every
 * skill here carrying no declared edit matches its lock entry exactly, and every
 * skill carrying one differs — the test pins it.
 *
 * What still bars it as THE record is granularity and provenance, not
 * arithmetic: the digest is per skill folder, so it names no file; it cannot
 * tell a local edit from an upstream move; and the installer rewrites it at
 * every install, so it records the bytes of the last pull rather than a baseline
 * a reverted edit could be caught against. It is used below as a second signal
 * only — see LOCK-HASH.
 *
 * THE RECORD. `.agents/vendored-skill-edits.json`, two sections:
 *   vendored  every tracked file under .agents/skills/ as the vendoring commit
 *             supplied it, path -> sha256.
 *   edits     only the files that diverge or were added, each with the hash
 *             it was declared at, the issue that approved it and one line of
 *             why. Absence is the pristine state.
 *
 * VERDICTS, per tracked file:
 *   matches vendored, no entry          pristine        silent
 *   matches its entry's editedHash      declared        silent
 *   matches vendored, entry exists      STALE-ENTRY     FAIL — edit reverted
 *   differs, no entry                   UNDECLARED      FAIL
 *   differs, entry disagrees            DRIFTED         FAIL — edited again
 *   absent from the manifest, no entry  UNTRACKED       FAIL — added locally
 *   absent from the manifest, matches   declared        silent — an added file
 *     its entry's editedHash                            is a declared edit too
 *   absent from the manifest, entry     DRIFTED         FAIL — edited again
 *     disagrees
 *   an added file's entry, not on disk  STALE-ENTRY     FAIL — addition removed
 *   in the manifest, absent from disk   REMOVED         WARN — de-vendoring is
 *                                                       a real move (mantahostels#1502,
 *                                                       mantahostels#1757) and lands as a
 *                                                       lock edit, not a bug
 *   lock entry with no directory        LOCK-ORPHAN     WARN
 *   directory with no lock entry        LOCK-MISSING    WARN
 *   lock source the notices miss, or a  NOTICE-MISSING  FAIL — lib/vendored-notices.js
 *   notices section naming none
 *
 * VERDICTS, per skill folder (mantahostels#3522):
 *   folder hash differs from the lock   LOCK-HASH       WARN
 *   the lock cannot be read at all      LOCK-UNREADABLE WARN
 * LOCK-HASH is scoped to a skill whose every file matched the manifest and which
 * carries no declared edit — anywhere else the two are expected to disagree and
 * the digest cannot say why. So it fires where the per-file check is blind: the
 * MANIFEST is wrong, because `--revendor --at <rev>` was pointed at a commit
 * where an undeclared edit had already landed, which bakes those bytes in as
 * "what the vendor supplied" and silences every later verdict on that file. The
 * lock is the installer's own witness of the pull, so it disagrees.
 *
 * That needs the per-file gate to have been defeated first — `HUSKY=0`, a
 * `--warn` run, or the edit riding a commit staging no path this check is scoped
 * to.
 *
 * TWO WAYS IT LIES, both firing on clean skills: an installer that changes the
 * construction, and a lock written under a locale whose `localeCompare` orders
 * two paths differently from the checking machine's. So re-read the port against
 * upstream before acting on a LOCK-HASH that names more than one or two skills.
 *
 * WHERE IT RUNS. `.husky/pre-commit`, scoped to commits that stage a path under
 * `.agents/skills/`, or the manifest, or `skills-lock.json` — an unrelated
 * commit pays nothing. Deliberately NOT a SessionStart notifier: a declared
 * edit is a permanent condition, and a notice on one is noise every session
 * (mantahostels#1809).
 *
 * --upstream is the re-pull mode and the only one that touches the network, so
 * no gate runs it; a gate reads the record it writes instead. It reports which
 * declared edits upstream has ALSO moved under, which is the difference
 * between re-applying an edit cleanly and merging two changes — and, per lock
 * source, whether upstream's licence still reads as NOTICES' section for it,
 * since a re-pull vendors under whatever upstream states now (workflow-core#1951). Its own
 * verdicts:
 *   body differs from the vendored bytes   UPSTREAM-MOVED       WARN
 *   licence differs from the notice        UPSTREAM-LICENCE     WARN
 *   upstream 404s on the path              UPSTREAM-GONE        WARN — the
 *                                                               path, or the
 *                                                               `source` repo;
 *                                                               for a licence,
 *                                                               no LICENSE file
 *   fetch failed, GitHub unreachable       UPSTREAM-UNREADABLE  WARN — and a
 *                                                               run where EVERY
 *                                                               row failed that
 *                                                               way SKIPs
 *   fetch failed, the call itself at fault —                    BROKEN, at once
 *   no source/skillPath in the lock        UPSTREAM-UNRESOLVED  WARN
 *
 * Which of those two a failed fetch is comes from `lib/gh.js`'s
 * `parseGhFailureReason`, never from a rule of this checker's own (mantahostels#3066).
 *
 * THE UPSTREAM RECORD (workflow-core#2394, ruled at workflow-core#2377). A run that neither SKIPs nor
 * breaks, and finds every lock source's licence matching its notice, writes
 * `.agents/vendored-upstream-pass.json`: the sha256 of the lock and of NOTICES
 * as the run read them, the date, and each source's licence verdict. Any other
 * licence row writes none, so a mismatch is cleared by refreshing NOTICES and
 * re-running, never by recording it; UPSTREAM-MOVED does not stop the write.
 * `--covered <dir>` is the offline half, run by `.husky/pre-commit` on a commit
 * staging the lock: it reads the staged lock, NOTICES and record that the hook
 * copies into <dir>, and fails where the record is missing or either hash
 * differs.
 * WFC_UPSTREAM_RECORD_OFF stands it down for one commit, for a GitHub outage
 * that SKIPs --upstream; `.husky/commit-msg` refuses that commit until its
 * `Weakens:` line names the variable.
 *
 * RESIDUAL: `vendoredAt` is single-provenance and the manifest is not.
 * It names upstream's v1.3.1 commit for every file, but `animate`'s two
 * arrived at f13eec839, so every verdict line quoting the field misdescribes
 * those two. Nothing compares against it, so no gate is wrong, and every file
 * of every skill vendored outside a --revendor joins it. workflow-core#906 set it by hand;
 * the next --revendor writes a revision of this repo instead. Per-path
 * provenance, a data-format change plus a write command, was declined at
 * mantahostels#3025; revisit at a third upstream, when the field misdescribes
 * enough of the manifest to pay.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { runCheck, errMessage } = require("./lib/check");
const { gh, parseGhFailureReason } = require("./lib/gh");
const { caught } = require("./lib/caught.js");
const {
	LOCK,
	NOTICES,
	noticeFaults,
	readNoticeLicences,
} = require("./lib/vendored-notices.js");
const { execGit, gitCommonDir } = require("./lib/git.js");

const SIDECAR = ".agents/vendored-skill-edits.json";
const SKILLS_DIR = ".agents/skills";
const RECORD = ".agents/vendored-upstream-pass.json";
const STAND_DOWN = "WFC_UPSTREAM_RECORD_OFF";
/** The files the upstream record vouches for, by their repo paths. */
const COVERED = [LOCK, NOTICES];

/**
 * @typedef {{ editedHash: string, issue: number, why: string }} EditEntry
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
 * Each COVERED file's sha256, null where absent, read at `locate(rel)`.
 *
 * @param {(rel: string) => string} locate
 * @returns {Record<string, string | null>}
 */
const coveredHashes = (locate) =>
	Object.fromEntries(COVERED.map((rel) => [rel, fileHash(locate(rel))]));

/**
 * A file's sha256 with CRLF read as LF, or null where it does not exist. The
 * record hashes the worktree and the gate the staged blob, which differ by
 * line endings alone under `core.autocrlf` or an `eol` attribute.
 *
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
 * Biome formats JSON with tabs, and this file is in its scope, so writing any
 * other indent means the next `check:staged` reformats it under us.
 *
 * @param {string} file
 * @param {unknown} value
 */
function writeJson(file, value) {
	fs.writeFileSync(file, `${JSON.stringify(value, null, "\t")}\n`);
}

/**
 * Every tracked file under .agents/skills/, repo-relative, sorted.
 *
 * Walks the filesystem rather than asking git: --root points at a fixture that
 * is not a repository, and the walk is what makes the check work there.
 *
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
			/* Symlinks are skipped: .claude/skills/ points in here, and a link
			 * followed from inside would hash the same bytes twice. */
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
 * `computeSkillFolderHash` from vercel-labs/skills `src/local-lock.ts`, ported
 * (mantahostels#3522): sha256 over every file in one skill folder, sorted by relative path,
 * each file's path then its bytes. Deliberately mirrors upstream rather than
 * improving on it — `localeCompare` over a byte sort, `.git`/`node_modules`
 * skipped, hidden files kept, symlinks skipped as upstream's `Dirent` tests
 * skip them.
 *
 * @param {string} dir
 * @returns {string}
 */
function skillFolderHash(dir) {
	/** @type {{ rel: string, content: Buffer }[]} */
	const files = [];
	collectSkillFiles(dir, dir, files);
	files.sort((a, b) => a.rel.localeCompare(b.rel));
	const h = crypto.createHash("sha256");
	for (const f of files) {
		h.update(f.rel);
		h.update(f.content);
	}
	return h.digest("hex");
}

/**
 * `skillFolderHash`'s walk: push every file under `cur` onto `files`, its path
 * relative to the skill folder `dir`.
 *
 * @param {string} dir
 * @param {string} cur
 * @param {{ rel: string, content: Buffer }[]} files accumulator: each file found is pushed here
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
 * Skill names the lock claims, and skill directories on disk.
 *
 * `null` means the lock or the skills directory is absent, which is not a fault.
 * A lock that exists and will not parse is one, and comes back as
 * `{ unreadable }`.
 *
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

/* --- the write commands ---------------------------------------------------
 *
 * These write and check nothing, the same split check-guard-registry.js --review
 * runs on: a command that both records a divergence and reports on it can
 * always be made green by running it, which is not a gate. */

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
 * Drop a de-vendored file from the manifest.
 *
 * De-vendoring leaves a manifest entry for a file nobody has. Refuses while the
 * file still exists, so it cannot be used to silence an UNDECLARED finding.
 *
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
 * Rebuild the `vendored` manifest from a commit — what a re-pull ends with.
 *
 * Reads the blobs at `rev`, not the working tree: the point is to record what
 * the vendor supplied, and the working tree is exactly where local edits live.
 *
 * @param {string} root
 * @param {string} rev
 */
function revendor(root, rev) {
	const at = execGit(["rev-parse", "--short", rev], {
		cwd: root,
		encoding: "utf8",
	}).trim();
	const listed = execGit(
		["ls-tree", "-r", "--name-only", at, "--", SKILLS_DIR],
		{ cwd: root, encoding: "utf8" },
	)
		.split("\n")
		.filter(Boolean)
		.sort();
	if (listed.length === 0)
		throw new Error(`${at} has no files under ${SKILLS_DIR}/.`);
	/** @type {Record<string, string>} */
	const vendored = {};
	for (const rel of listed)
		vendored[rel] = sha256(
			execGit(["show", `${at}:${rel}`], {
				cwd: root,
			}),
		);
	const sidecar = fs.existsSync(path.join(root, SIDECAR))
		? loadSidecar(root)
		: /** @type {Sidecar} */ ({ vendoredAt: at, vendored: {}, edits: {} });
	sidecar.vendoredAt = at;
	sidecar.vendored = vendored;
	writeJson(path.join(root, SIDECAR), sidecar);
	return `recorded ${listed.length} vendored file(s) as supplied at ${at}`;
}

/** @param {Record<string, any>} obj */
function sortKeys(obj) {
	/** @type {Record<string, any>} */
	const out = {};
	for (const k of Object.keys(obj).sort()) out[k] = obj[k];
	return out;
}

/**
 * Which repo holds a vendored file upstream, and where in it — both read off
 * the file's own lock entry, never assumed (mantahostels#3025).
 *
 * `rel` must be `.agents/skills/<skill>/<tail>`.
 *
 * @param {Record<string, { source?: string, skillPath?: string }>} lock
 * @param {string} rel
 * @returns {{ source: string, remotePath: string } | null}
 */
function remoteFor(lock, rel) {
	const [, , skill, ...tail] = rel.split("/");
	if (skill === undefined || tail.length === 0) return null;
	const entry = lock[skill];
	if (!entry?.source || !entry?.skillPath) return null;
	/* Reference files sit beside SKILL.md upstream, so the lock's skillPath
	 * for the skill gives the directory and the on-disk tail gives the name. */
	return {
		source: entry.source,
		remotePath: `${path.posix.dirname(entry.skillPath)}/${tail.join("/")}`,
	};
}

/**
 * `broken` is REQUIRED, not optional. Omitted, a fetcher's failure would default
 * to `unreadable`, which is the every-row SKIP condition and so exit 0 over a
 * check that never ran.
 *
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
 * The re-pull pre-flight: which declared edits would a re-pull collide with?
 *
 * A declared edit whose upstream body is unchanged since we vendored it can be
 * re-applied verbatim. One whose upstream body has ALSO moved cannot — that is
 * a merge, and the founder has to see it before anything is overwritten.
 *
 * A file we added has no upstream body: a 404 on it is `same`, and any body at
 * that path is `taken`, upstream having shipped a file where ours sits.
 *
 * Any other failed fetch is never folded into either answer. A 404 is `gone` —
 * a collision of its own; a failure the environment explains is `unreadable`,
 * and one the call itself is at fault for is `fault`, which the CLI turns into
 * a BROKEN rather than a finding.
 *
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
 * Each lock source's licence upstream against the text NOTICES holds for it.
 *
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

/**
 * Line endings and trailing whitespace are not terms of a licence, and NOTICES
 * separates its sections with blank lines a LICENSE file does not carry.
 *
 * @param {string} text
 */
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
 * `gh`'s own spelling of a missing path, which is what `notFound` is read off:
 * `gh: Not Found (HTTP 404)`. Anchored to the parenthesised status rather than
 * to a bare `404`, which any error text could carry.
 */
const HTTP_404 = /\(HTTP 404\)/;

/**
 * A base64 `content` field — a contents read's or a licence read's — decoded.
 *
 * @param {string} endpoint
 * @returns {FetchResult}
 */
function ghFetch(endpoint) {
	try {
		const json = gh(["api", endpoint, "--jq", ".content"]);
		return { body: Buffer.from(json.trim(), "base64").toString("utf8") };
	} catch (e) {
		const stderr = String(caught(e).stderr ?? "").trim();
		const notFound = HTTP_404.test(stderr);
		return {
			error: stderr.split("\n")[0] || errMessage(e),
			notFound,
			/* A 404 is answered before this is asked: it is a real answer about
			 * upstream, and `parseGhFailureReason` — knowing nothing of this checker's
			 * subject — calls it a fault in the call. */
			broken: !notFound && parseGhFailureReason(e) === "broken",
		};
	}
}

/** @type {string | undefined} */
let selfPath;
/**
 * The command a finding prints, spelt from where this script lives (workflow-core#2515). In
 * an adopter that is the plugin root, outside the adopter's root, so it prints
 * the absolute path, quoted so a root holding a space pastes whole.
 * Where the plugin root is the cwd, or the canonical checkout a core worktree's
 * plugin root may name, the repo-relative path runs — as `dr_hint` in
 * `.husky/pre-commit` decides it.
 *
 * Residual: a plugin root holding `"`, `$` or a backtick still pastes wrong
 * inside the quotes, as `dr_hint`'s does.
 * @param {string} args
 */
function buildSelfCommand(args) {
	if (selfPath === undefined) {
		const roots = [process.cwd()];
		/* Outside a git checkout the cwd is the only root to compare, and a miss
		 * prints the absolute spelling (workflow-core#2515). */
		const common = gitCommonDir(process.cwd());
		if (common !== null) roots.push(path.dirname(common));
		const real = (/** @type {string} */ dir) => {
			try {
				return fs.realpathSync(dir);
			} catch {
				/* Compared unresolved (workflow-core#2515). */
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
 * The per-file verdicts, and the skills the folder-hash check must stay quiet
 * about.
 *
 * @param {import("./lib/check").CheckContext} ctx
 * @param {{ root: string, sidecar: Sidecar, onDisk: string[], seen: Set<string> }} tree
 * @returns {Set<string>}
 */
function checkFiles(ctx, { root, sidecar, onDisk, seen }) {
	/* Skills the folder-hash check must stay quiet about: one carrying a declared
	 * edit, or any per-file finding, is expected to differ from the lock. */
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
 * One vendored file's verdict: UNTRACKED, STALE-ENTRY, UNDECLARED or DRIFTED.
 *
 * @param {import("./lib/check").CheckContext} ctx
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
 * @param {import("./lib/check").CheckContext} ctx
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
 * A declared added file that is gone: its entry would tell --upstream the
 * addition re-applies cleanly.
 *
 * @param {import("./lib/check").CheckContext} ctx
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
 * The lock's verdicts: LOCK-UNREADABLE, LOCK-ORPHAN, LOCK-MISSING, LOCK-HASH.
 *
 * @param {import("./lib/check").CheckContext} ctx
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
 * @param {import("./lib/check").CheckContext} ctx
 * @param {{ root: string, name: string, locked: string | undefined, notClean: Set<string> }} skill
 */
function lockHashFinding(ctx, { root, name, locked, notClean }) {
	if (!locked || notClean.has(name)) return;
	const got = skillFolderHash(path.join(root, SKILLS_DIR, name));
	if (got !== locked)
		ctx.warn(
			"LOCK-HASH",
			`${SKILLS_DIR}/${name}/ matches the manifest and carries no declared edit, yet its folder hash (${got.slice(0, 12)}) differs from the ${locked.slice(0, 12)} ${LOCK} recorded at install. The manifest is the first suspect, not the files: a --revendor pointed at a commit that already carried an undeclared edit would read exactly like this. Re-run --revendor at the vendoring commit, or re-install the skill. But where several clean skills say this at once, suspect the port instead — this checker's copy of upstream's construction, or the locale it sorts paths under.`,
			{ skill: name },
		);
}

/**
 * The whole verdict, over a tree.
 *
 * @param {import("./lib/check").CheckContext} ctx
 * @param {string} root
 */
function check(ctx, root) {
	// Neither record nor skills: an adopter vendoring nothing (mantahostels#3515
	// F12, workflow-core#2). One without the other is still BROKEN below.
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
		/* The manifest is this checker's own apparatus, not its subject: without it
		 * nothing was checked, so it is BROKEN rather than a green run over a scope
		 * it never looked at. */
		return ctx.broken(errMessage(e));
	}

	const onDisk = readVendoredFilesOnDisk(root);
	const seen = new Set(onDisk);
	const notClean = checkFiles(ctx, { root, sidecar, onDisk, seen });
	warnRemoved(ctx, sidecar, seen);
	failRemovedAdditions(ctx, sidecar, seen);
	checkLock(ctx, root, notClean);
	/* An unparseable lock is LOCK-UNREADABLE's to report, just above. */
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
 * @param {import("./lib/check").CheckContext} ctx
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

/**
 * The write commands, in the order their flags are tried: the first one given
 * runs, and the rest are ignored.
 *
 * @type {[string, (ctx: import("./lib/check").CheckContext, root: string) => { okLine: string }][]}
 */
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
			ctx.say(revendor(root, rev));
			return { okLine: "re-recorded." };
		},
	],
];

/**
 * The warning each colliding upstream state raises; a state absent here
 * ("same") re-applies cleanly and is only said.
 *
 * @type {Record<string, { code: string, message: (r: UpstreamRow, edit: string) => string }>}
 */
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
 * @param {import("./lib/check").CheckContext} ctx
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
 * The --upstream report: the re-pull pre-flight, over every declared edit.
 *
 * @param {import("./lib/check").CheckContext} ctx
 * @param {string} root
 */
function runUpstream(ctx, root) {
	let rows;
	let licences;
	/** @type {Record<string, string | null>} */
	let read;
	try {
		/* Hashed before the fetches, so the record names the bytes the run read. */
		read = coveredHashes((rel) => path.join(root, rel));
		rows = buildUpstreamReport(root);
		licences = buildLicenceReport(root);
	} catch (e) {
		return ctx.broken(errMessage(e));
	}
	/* A fault in the call is not a finding about upstream, so it ends the
	 * run rather than joining the rows (mantahostels#3066). */
	const fault = [...rows, ...licences].find((r) => r.state === "fault");
	if (fault)
		return ctx.broken(
			`the upstream fetch failed, and not because GitHub was unreachable (${fault.detail}).\n        This is a fault in the check, not a finding about upstream.`,
		);
	const unreadable = [...rows, ...licences].filter(
		(r) => r.state === "unreadable",
	);
	/* Upstream is the SUBJECT here, so an unreachable GitHub is a SKIP: a
	 * green run over a fetch that never happened is the failure mode. A 404
	 * is excluded, being an answer rather than a failure to get one.
	 *
	 * The condition is EVERY row, so an unresolved row beside unreadable ones
	 * reports rather than skipping — ruled correct at mantahostels#3066:
	 * UPSTREAM-UNRESOLVED is a finding about the lock, reached without a
	 * network and actionable while GitHub is down. */
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
	/* The recipe re-applies declared edits; a licence finding's way out is the
	 * section refresh its own message names (workflow-core#1951). */
	if (rows.some((r) => UPSTREAM_WARNINGS[r.state]))
		ctx.say(
			"  Re-pull, then: --revendor --at <the pull's commit>, re-apply each edit by hand, and --declare it again.",
		);
	writeRecord(ctx, root, read, licences);
	return {
		okLine: `${rows.length} declared edit(s) and ${licences.length} licence notice(s), none of them colliding with an upstream change.`,
		noun: "upstream finding(s)",
	};
}

/**
 * Write the upstream record where every licence matched; say why not otherwise.
 *
 * @param {import("./lib/check").CheckContext} ctx
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
 * The commit gate's half of the record: does the staged record cover the
 * staged lock and NOTICES? Reads the copies `.husky/pre-commit` stages into
 * `dir` under their basenames.
 *
 * @param {import("./lib/check").CheckContext} ctx
 * @param {string} dir
 */
function runCovered(ctx, dir) {
	if ((process.env[STAND_DOWN] ?? "") !== "")
		return ctx.skip(
			`${STAND_DOWN} is set — the upstream-record check stood down for this commit. Name it on the commit's Weakens: line.`,
		);
	/** @param {string} rel */
	const staged = (rel) => path.join(dir, path.basename(rel));
	/* --upstream cannot run without the manifest, so a repo vendoring nothing
	 * could never write a record. */
	if (!fs.existsSync(staged(SIDECAR)))
		return ctx.skip(
			`no ${SIDECAR} staged — nothing vendored, so no upstream record is owed.`,
		);
	const hashes = coveredHashes(staged);
	if (hashes[LOCK] === null)
		return { okLine: `no ${LOCK} staged, so no upstream record is owed.` };
	const fix = `Run, then stage the ${RECORD} it writes with this commit:\n    ${buildSelfCommand("--upstream")}\n  Only where GitHub is unreachable and that run SKIPs: ${STAND_DOWN}=1 stands this check down for one commit, named on its Weakens: line.`;
	const stale = recordFault(staged(RECORD), hashes);
	if (stale)
		ctx.fail(
			stale.tag,
			`${LOCK} is staged, and ${stale.why} — no completed --upstream run is on record for the lock and licence notices this commit lands (workflow-core#2394). ${fix}`,
			{ path: RECORD },
		);
	for (const f of ctx.findings) ctx.say(`${f.severity}: ${f.message}`);
	return {
		okLine: `${RECORD} covers the staged ${LOCK} and ${NOTICES}.`,
		noun: "upstream-record finding(s)",
	};
}

/**
 * Why the record at `file` does not cover `staged`, or null where it does.
 *
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

const SPEC = {
	name: "check-vendored-skills",
	usage:
		'node check-vendored-skills.js [--root <dir>] [--json] [--warn] | --declare <path> --issue <n> --why "<line>" | --drop <path> | --forget <path> | --revendor --at <rev> | --upstream | --covered <dir>',
	valueFlags: [
		"--root",
		"--covered",
		"--declare",
		"--drop",
		"--forget",
		"--at",
		"--issue",
		"--why",
	],
	flags: ["--revendor", "--upstream"],
	run(/** @type {import("./lib/check").CheckContext} */ ctx) {
		const root = path.resolve(ctx.value("--root", process.cwd()));

		/* The write commands report in prose and raise no findings, so they have
		 * no --json form and nothing to gate on. */
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

		if (ctx.has("--upstream")) return runUpstream(ctx, root);
		if (ctx.has("--covered"))
			return runCovered(ctx, path.resolve(ctx.value("--covered", "")));

		const result = check(ctx, root);
		for (const f of ctx.findings) ctx.say(`${f.severity}: ${f.message}`);
		return result;
	},
};

if (require.main === module) runCheck(SPEC);
