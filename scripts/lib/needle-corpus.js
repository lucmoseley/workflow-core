/**
 * scripts/lib/needle-corpus.js — the corpus count-guard-fires.test.ts's "every needle is text this repo still
 * prints" assertion reads, and the drift judgement the guard-registry-atomicity core
 * makes against it at commit time (mantahostels#2708).
 *
 * Don't re-derive the walk, or which literals a needle claims, when a guard
 * JUDGES text against it: a private copy drifts from the test it protects,
 * invisibly until the next such commit (mantahostels#2708, on the mantahostels#2685 argument for
 * reading registrations through guard-fires.js).
 */

const fs = require("node:fs");
const path = require("node:path");
const { caught } = require("./caught.js");
const { isUnder } = require("./is-under.js");
const { isCollectedTestOrConftest } = require("./test-kind.js");

/**
 * Every directory a hook could print from, mirroring the test's walk.
 */
const CORPUS_DIRS = [
	"scripts",
	".husky",
	path.join(".claude", "skills"),
	path.join("docs", "agents", "rules"),
];

/**
 * The registry is never a printer: its own copy of every needle would satisfy
 * the containment test against itself, vacuously (mantahostels#2135).
 */
const REGISTRY_REL = path.join("scripts", "guard-fire-needles.json");

/**
 * @typedef {{key: string, id: string, text: string}} NeedleText
 * @typedef {NeedleText & {arriving: boolean}} BrokenNeedle
 * @typedef {{broken: BrokenNeedle[], failOpen: string | null}} Drift
 * @typedef {any} RegistryEntry One guard's entry in the parsed registry. `any`
 *   because JSON.parse types nothing and each field is guarded where it is read.
 */
/**
 * A step's value, or the verdict that ends the judgement early.
 * @template T
 * @typedef {{value: T} | {drift: Drift}} Step
 */

/**
 * A test file — one a runner collects, or pytest's `conftest.py` — is never a
 * printer either, for the same reason the registry is not: a test asserting on
 * a guard's wording carries its own copy of that wording, so a needle keyed on
 * the TEST satisfies containment while measuring nothing about the guard —
 * reword the guard and the check stays green (mantahostels#3288,
 * found on the `guard-npm-install` core's `no-ignore-scripts`).
 *
 * How to key a needle whose printer spells the literal escaped:
 * `docs/agents/guard-authoring.md` surface 7.
 *
 * FIXTURES AND TESTKITS STAY IN, and can hold a guard's wording the same way —
 * `lib/git-fixture.ts`, `lib/arbiter-testkit.ts`, `lib-closure-fixture.ts`.
 * Nothing rests on one today; a spelling convention naming them is what a
 * narrowing would need first.
 *
 * @param {string} rel in the platform's separator, which test-kind.js does not read
 * @returns {boolean}
 */
function isTestAtPlatformPath(rel) {
	return isCollectedTestOrConftest(rel.split(path.sep).join("/"));
}

/**
 * Every corpus file's bytes, keyed by its repo-root-relative path. A path gone
 * by the time it is read (ENOENT) is absent from the tree, so from the map too.
 * Any other failed read THROWS, which needleDrift fails open on: a missing text
 * would otherwise read as a needle its printer dropped (#1983; mantahostels#2671's
 * asymmetry, as readHead).
 *
 * A symlinked directory is not walked (#1983). The tracked ones are vendored
 * skills linked in from `.agents/skills/`, outside CORPUS_DIRS, and no hook
 * prints from them. A symlinked file is read like any other, so a printer
 * reached through a link stays in the corpus.
 *
 * @param {string} root
 * @returns {Map<string, string>}
 */
function corpusFiles(root) {
	/** @type {Map<string, string>} */
	const out = new Map();
	for (const d of CORPUS_DIRS) walkCorpus(root, path.join(root, d), out);
	return out;
}

/**
 * @param {string} root
 * @param {string} dir
 * @param {Map<string, string>} out accumulator: each corpus file's text lands here, via readCorpusFile
 */
function walkCorpus(root, dir, out) {
	let entries;
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch (e) {
		if (caught(e).code === "ENOENT") return;
		throw e;
	}
	for (const e of entries) {
		if (e.name === "node_modules" || e.name === "__pycache__") continue;
		const p = path.join(dir, e.name);
		if (e.isSymbolicLink() && !isLinkedFile(p)) continue;
		if (e.isDirectory()) {
			walkCorpus(root, p, out);
			continue;
		}
		readCorpusFile(root, p, out);
	}
}

/**
 * Whether the link at `p` resolves to a regular file. A dangling link is gone
 * from the tree, as readCorpusFile reads an ENOENT; any other failure throws.
 *
 * @param {string} p
 * @returns {boolean}
 */
function isLinkedFile(p) {
	try {
		return fs.statSync(p).isFile();
	} catch (e) {
		if (caught(e).code === "ENOENT") return false;
		throw e;
	}
}

/**
 * @param {string} root
 * @param {string} p the file's path
 * @param {Map<string, string>} out accumulator: the file's text is set under its path, unless `p` is no printer
 */
function readCorpusFile(root, p, out) {
	const rel = path.relative(root, p);
	if (rel === REGISTRY_REL || isTestAtPlatformPath(rel)) return;
	try {
		out.set(rel, fs.readFileSync(p, "utf8"));
	} catch (e) {
		if (caught(e).code !== "ENOENT") throw e;
	}
}

/**
 * Every literal a needle expects to be printed somewhere, flattened: a needle's
 * `text` is one substring or an array of substrings ALL of which must appear,
 * and each of its `unless` literals is one too, or the exclusion it carries
 * goes dead unnoticed.
 *
 * @param {Record<string, any> | null | undefined} registry
 * @returns {NeedleText[]}
 */
function needleTexts(registry) {
	/** @type {NeedleText[]} */
	const out = [];
	for (const section of ["guards", "candidates"]) {
		const entries = registry?.[section];
		if (!entries || typeof entries !== "object") continue;
		for (const [key, entry] of Object.entries(entries))
			out.push(...entryTexts(key, entry));
	}
	return out;
}

/**
 * @param {string} key
 * @param {RegistryEntry} entry
 * @returns {NeedleText[]}
 */
function entryTexts(key, entry) {
	/** @type {NeedleText[]} */
	const out = [];
	for (const n of entry?.needles ?? [])
		for (const t of [
			...(Array.isArray(n.text) ? n.text : [n.text]),
			...(n.unless ?? []),
		])
			if (typeof t === "string" && t) out.push({ key, id: n.id, text: t });
	return out;
}

/**
 * The needle literals this commit breaks: keyed text that prints nowhere after
 * it, and either printed somewhere before it (`arriving: false` — a printer
 * reworded out from under its needle) or arrived with this very commit
 * (`arriving: true` — a needle keyed on wording the tree never held). The two
 * take different refusals, so the flag travels with the entry.
 *
 * ONLY the ones this commit breaks. A literal already missing before it — a
 * neighbour's half-written file, a registry entry that landed ahead of its
 * printer — is not this commit's to answer for.
 *
 * `landing` is the commit's repo-root-relative paths; `readHead(rel)` returns
 * HEAD's bytes for one, `null` where HEAD does not name it, and THROWS where
 * git could not tell. A throw fails open: `broken` comes back empty with
 * `failOpen` naming the reason, because an unreadable HEAD must never read as
 * "the old text was there and is gone" (mantahostels#2671's asymmetry).
 *
 * THE REGISTRY IS READ FROM THE TREE AS IT WILL BE AFTER THE COMMIT — HEAD's
 * copy wherever the commit does not land it. Reading the working tree there
 * acquits `git commit -- scripts/guard-x.sh` with the needle fixed on disk but
 * not named, which is mantahostels#2708's own fault.
 *
 * The CORPUS is read from the working tree for every file the commit does not
 * land — see the guard's LIMITS. That is the allowing direction and it matches
 * what a local suite run sees.
 *
 * `readLanding(rel)`, where given, replaces the working-tree bytes of each
 * LANDING corpus file with the copy the commit actually takes — the index, for
 * a bare `git commit` (mantahostels#2734). It returns `null` where the commit drops the
 * path, and THROWS on a read it could not make, which fails open like readHead.
 *
 * @param {{root: string, landing: string[], readHead: (rel: string) => string | null, readLanding?: ((rel: string) => string | null) | null}} arg
 * @returns {Drift}
 */
function needleDrift({ root, landing, readHead, readLanding = null }) {
	const landsRegistry = landing.includes(REGISTRY_REL);

	const after = readAfterCorpus(root, landing, readLanding);
	if ("drift" in after) return after.drift;
	const headText = readHeadCorpusText(landing, readHead);
	if ("drift" in headText) return headText.drift;

	const afterBytes = landsRegistry
		? readLandingRegistryBytes(root, readLanding)
		: readHeadRegistryBytes(readHead);
	if ("drift" in afterBytes) return afterBytes.drift;
	const registryAfter = readRegistry(() => afterBytes.value);
	if (registryAfter.error)
		return bail(`could not read ${REGISTRY_REL}: ${registryAfter.error}`);

	/** @type {Step<Set<string>>} */
	const added = landsRegistry
		? addedNeedles(readHead, registryAfter.value)
		: { value: new Set() };
	if ("drift" in added) return added.drift;

	const afterText = [...after.value.values()].join("\n");
	return {
		broken: brokenNeedles(
			registryAfter.value,
			afterText,
			headText.value,
			added.value,
		),
		failOpen: null,
	};
}

/**
 * @param {Record<string, RegistryEntry> | null} registry the registry after the commit
 * @param {string} afterText the corpus after the commit
 * @param {string} headText HEAD's copies of the landing corpus files
 * @param {Set<string>} added needle texts this commit's registry adds
 * @returns {BrokenNeedle[]}
 */
function brokenNeedles(registry, afterText, headText, added) {
	/** @type {BrokenNeedle[]} */
	const broken = [];
	for (const n of needleTexts(registry)) {
		if (afterText.includes(n.text)) continue;
		const printedBefore = headText.includes(n.text);
		if (!printedBefore && !added.has(n.text)) continue;
		broken.push({ ...n, arriving: !printedBefore });
	}
	return broken;
}

/**
 * @param {string} why
 * @returns {Drift}
 */
function bail(why) {
	return { broken: [], failOpen: why };
}

/**
 * @param {string} why
 * @returns {{drift: Drift}}
 */
function bailStep(why) {
	return { drift: bail(why) };
}

/**
 * No registry to judge, which allows.
 * @returns {{drift: Drift}}
 */
function noNeedles() {
	return { drift: { broken: [], failOpen: null } };
}

/**
 * The corpus as this commit leaves it.
 * @param {string} root
 * @param {string[]} landing
 * @param {((rel: string) => string | null) | null} readLanding
 * @returns {Step<Map<string, string>>}
 */
function readAfterCorpus(root, landing, readLanding) {
	let after;
	try {
		after = corpusFiles(root);
	} catch (e) {
		return bailStep(
			`could not read the source corpus under ${root}: ${caught(e).message}`,
		);
	}
	if (after.size === 0)
		return bailStep(`the source corpus under ${root} is empty`);

	// The after-tree's copy of each landing corpus file, where the caller can
	// name one the working tree does not hold.
	if (readLanding) return readLandingOverlay(after, landing, readLanding);
	return { value: after };
}

/**
 * @param {Map<string, string>} before
 * @param {string[]} landing
 * @param {(rel: string) => string | null} readLanding
 * @returns {Step<Map<string, string>>} `before` with each landing file's text
 *   in place of its own, or the fail-open verdict where a read throws
 */
function readLandingOverlay(before, landing, readLanding) {
	const after = new Map(before);
	for (const rel of landing) {
		if (rel === REGISTRY_REL || !inCorpus(rel)) continue;
		let bytes;
		try {
			bytes = readLanding(rel);
		} catch (e) {
			return bailStep(
				`could not read this commit's ${rel}: ${caught(e).message}`,
			);
		}
		if (bytes === null) after.delete(rel);
		else after.set(rel, bytes);
	}
	return { value: after };
}

/**
 * HEAD's copy of every corpus file this commit lands, and nothing else. A
 * literal absent from the tree after the commit is absent from every file the
 * commit does not touch too — those files ARE the after-tree — so these few
 * bytes settle "was it printed before" on their own.
 * @param {string[]} landing
 * @param {(rel: string) => string | null} readHead
 * @returns {Step<string>} the copies joined
 */
function readHeadCorpusText(landing, readHead) {
	const headCopies = [];
	for (const rel of landing) {
		if (rel === REGISTRY_REL || !inCorpus(rel)) continue;
		try {
			const head = readHead(rel);
			if (head !== null) headCopies.push(head);
		} catch (e) {
			return bailStep(`could not read HEAD's ${rel}: ${caught(e).message}`);
		}
	}
	return { value: headCopies.join("\n") };
}

/**
 * HEAD's registry, for a commit that does not land one.
 * @param {(rel: string) => string | null} readHead
 * @returns {Step<string>}
 */
function readHeadRegistryBytes(readHead) {
	let bytes;
	try {
		bytes = readHead(REGISTRY_REL);
	} catch (e) {
		return bailStep(
			`could not read HEAD's ${REGISTRY_REL}: ${caught(e).message}`,
		);
	}
	// No registry in HEAD and none landing: there are no needles to judge.
	if (bytes === null) return noNeedles();
	return { value: bytes };
}

/**
 * The registry as this commit lands it. A commit DELETING it leaves no needles
 * to judge.
 * @param {string} root
 * @param {((rel: string) => string | null) | null} readLanding
 * @returns {Step<string>}
 */
function readLandingRegistryBytes(root, readLanding) {
	let bytes;
	try {
		bytes = readLanding
			? readLanding(REGISTRY_REL)
			: fs.readFileSync(path.join(root, REGISTRY_REL), "utf8");
	} catch (e) {
		return bailStep(
			`could not read this commit's ${REGISTRY_REL}: ${caught(e).message}`,
		);
	}
	if (bytes === null) return noNeedles();
	return { value: bytes };
}

/**
 * A needle this commit ADDS was printed nowhere before it either, so the
 * printed-before test acquits it — and a literal keyed on wording the tree
 * never held is the same drift written the other way round. So HEAD's
 * registry is read too, wherever the commit lands one over it.
 * @param {(rel: string) => string | null} readHead
 * @param {Record<string, RegistryEntry> | null} registryAfter
 * @returns {Step<Set<string>>} the needle texts HEAD's registry lacks
 */
function addedNeedles(readHead, registryAfter) {
	/** @type {string | null} */
	let headBytes;
	try {
		headBytes = readHead(REGISTRY_REL);
	} catch (e) {
		return bailStep(
			`could not read HEAD's ${REGISTRY_REL}: ${caught(e).message}`,
		);
	}
	// A registry HEAD does not name yet adds no needles, which allows:
	// nothing here may refuse on an absence git could not explain.
	if (headBytes === null) return { value: new Set() };
	const bytes = headBytes;
	const registryBefore = readRegistry(() => bytes);
	if (registryBefore.error)
		return bailStep(
			`could not read HEAD's ${REGISTRY_REL}: ${registryBefore.error}`,
		);
	const had = new Set(needleTexts(registryBefore.value).map((n) => n.text));
	return {
		value: new Set(
			needleTexts(registryAfter)
				.map((n) => n.text)
				.filter((t) => !had.has(t)),
		),
	};
}

/**
 * Is the repo-root-relative path $1 one the corpus walk reads?
 *
 * @param {string} rel
 * @returns {boolean}
 */
function inCorpus(rel) {
	if (isTestAtPlatformPath(rel)) return false;
	return isUnder(rel, CORPUS_DIRS, path.sep);
}

/**
 * @param {() => string} read
 * @returns {{value: Record<string, any> | null, error: string | null}}
 */
function readRegistry(read) {
	try {
		return { value: JSON.parse(read()), error: null };
	} catch (e) {
		return { value: null, error: caught(e).message };
	}
}

module.exports = {
	CORPUS_DIRS,
	needleDrift,
};
