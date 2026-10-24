// @vitest-environment node
/*
 * Pins what the grep predictor reads off an issue body — the tracked paths it
 * backticks, the paired roadmap and digest, a size guess kept out of `sizeBand` —
 * and that its provisional entry is stored, or refused, without throwing.
 *
 * The grep predictor (mantahostels#1001). Exercised against a throwaway root, since
 * `storeProvisional` writes into the cache directory under it.
 *
 * Breaking it lets `/pick-next` rank a freshly filed issue on a wrong
 * write-set, or pass an invented size off as a band read's judgement.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const { predict, storeProvisional, pathsNamedIn } =
	require("./write-set-predict.js") as typeof import("./write-set-predict");
const { readEntry, bodyHash, writeEntry } = require("./write-set-cache.js");

let root: string;

/** `trackedFiles()`'s shape, as pick-next.js passes it in. */
const tracked = (files: string[]) => ({ ok: true as const, files });

const REPO = [
	"docs/doc-map.md",
	"docs/reference-roadmap.html",
	"docs/roadmap-digest.md",
	"scripts/pick-next.js",
];

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "write-set-predict-"));
});
afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

describe("predict", () => {
	it("names the tracked paths the body backticks, and nothing else", () => {
		const r = predict(
			{ number: 1, body: "touch `scripts/pick-next.js` and `nowhere.js`" },
			tracked(REPO),
		);
		expect(r).toEqual({
			ok: true,
			why: null,
			writeSet: ["scripts/pick-next.js"],
			predictedSize: "small",
		});
	});

	it("adds docs/doc-map.md wherever a body names a §B entry", () => {
		// A body says it writes the map by naming the entry, never by backticking
		// the file — which is why the collision block alone cannot see the queue.
		expect(
			predict({ number: 1, body: "register it in §B7" }, tracked(REPO)),
		).toMatchObject({ writeSet: ["docs/doc-map.md"] });
	});

	it("adds the digest wherever the roadmap is written, since roadmap-edit regenerates it", () => {
		expect(
			predict(
				{ number: 1, body: "edit `docs/reference-roadmap.html`" },
				tracked(REPO),
			),
		).toMatchObject({
			writeSet: ["docs/reference-roadmap.html", "docs/roadmap-digest.md"],
		});
	});

	it("adds the roadmap wherever only the digest is named, the pair being one unit", () => {
		// mantahostels#1075: 172 of 172 commits touching the digest also touch the roadmap,
		// none solo — so a body naming the digest alone still writes both.
		expect(
			predict(
				{ number: 1, body: "edit `docs/roadmap-digest.md`" },
				tracked(REPO),
			),
		).toMatchObject({
			writeSet: ["docs/reference-roadmap.html", "docs/roadmap-digest.md"],
		});
	});

	it("refuses a wayfinder:map issue, whose substrate is its own body, predicting no write set", () => {
		const r = predict(
			{
				number: 1,
				body: "see `scripts/pick-next.js`",
				labels: ["wayfinder:map"],
			},
			tracked(REPO),
		);
		expect(r.ok).toBe(false);
		expect(r.why).toMatch(/wayfinder:map/);
		expect(r.writeSet).toEqual([]);
	});

	it("refuses where git could not list the tree, rather than naming files that may not exist", () => {
		const r = predict(
			{ number: 1, body: "`scripts/pick-next.js`" },
			{
				ok: false,
				error: "not a repository",
			},
		);
		expect(r.ok).toBe(false);
		expect(r.why).toMatch(/git could not list the tree/);
	});

	it("predicts an empty write-set for a body naming no file, which is an answer", () => {
		expect(predict({ number: 1, body: "just prose" }, tracked(REPO))).toEqual({
			ok: true,
			why: null,
			writeSet: [],
			predictedSize: "small",
		});
	});

	it("resolves a bare filename by unique suffix, the way bodies write one", () => {
		expect(pathsNamedIn("run `pick-next.js`", REPO)).toEqual([
			"scripts/pick-next.js",
		]);
	});
});

describe("the size guess's thresholds", () => {
	/* A body built to carry exactly the three signals the guess reads:
	 * `pathCount` backticked tracked files, `sectionCount` headings, padded to
	 * at least `bodyLength`. */
	const fixtureFiles = Array.from({ length: 8 }, (_, i) => `src/f${i}.js`);
	const sizeOf = ({
		bodyLength,
		pathCount,
		sectionCount,
	}: {
		bodyLength: number;
		pathCount: number;
		sectionCount: number;
	}) => {
		const body = (
			"## s\n".repeat(sectionCount) +
			fixtureFiles
				.slice(0, pathCount)
				.map((f) => `\`${f}\``)
				.join(" ")
		).padEnd(bodyLength, "x");
		return predict({ number: 1, body }, tracked(fixtureFiles)).predictedSize;
	};

	// Thresholds calibrated against this repo's own corpus (measured 24 August
	// 2026, 168 open issues — see the constant block's own comment): every real
	// body here runs well past 800 characters, so a synthetic short body is the
	// only way to exercise `small` at all.
	it("calls a short, low-path, headerless body small", () => {
		expect(sizeOf({ bodyLength: 50, pathCount: 2, sectionCount: 0 })).toBe(
			"small",
		);
	});

	it("calls it large on path count alone", () => {
		expect(sizeOf({ bodyLength: 50, pathCount: 7, sectionCount: 0 })).toBe(
			"large",
		);
	});

	it("calls it large on body length alone", () => {
		expect(sizeOf({ bodyLength: 12_000, pathCount: 0, sectionCount: 0 })).toBe(
			"large",
		);
	});

	it("calls it large on section count alone", () => {
		expect(sizeOf({ bodyLength: 50, pathCount: 0, sectionCount: 5 })).toBe(
			"large",
		);
	});

	it("calls anything between the two floors medium", () => {
		expect(sizeOf({ bodyLength: 5000, pathCount: 1, sectionCount: 0 })).toBe(
			"medium",
		);
		expect(sizeOf({ bodyLength: 50, pathCount: 3, sectionCount: 0 })).toBe(
			"medium",
		);
		expect(sizeOf({ bodyLength: 50, pathCount: 0, sectionCount: 1 })).toBe(
			"medium",
		);
	});
});

describe("predict's predictedSize", () => {
	it("reads large off a many-section body naming several files", () => {
		const body =
			"## One\ntouch `docs/doc-map.md`\n## Two\ntouch `scripts/pick-next.js`\n" +
			"## Three\nmore\n## Four\nmore\n## Five\nmore prose";
		const r = predict({ number: 1, body }, tracked(REPO));
		expect(r.predictedSize).toBe("large");
	});

	it("reads medium off a short body with one or two headers", () => {
		const body = "## One\ntouch `docs/doc-map.md`\nmore prose";
		const r = predict({ number: 1, body }, tracked(REPO));
		expect(r.predictedSize).toBe("medium");
	});
});

describe("storeProvisional", () => {
	const issue = {
		number: 7,
		title: "Pre-warm the cache",
		body: "edit `scripts/pick-next.js`",
	};

	it("refuses an issue carrying no number, rather than storing an unaddressable entry (mantahostels#1464)", () => {
		const r = storeProvisional(
			root,
			{ ...issue, number: undefined },
			tracked(REPO),
		);
		expect(r.ok).toBe(false);
		expect(r.why).toMatch(/no number/);
	});

	it("stores the prediction under the body's own key, flagged provisional", () => {
		expect(storeProvisional(root, issue, tracked(REPO)).ok).toBe(true);
		const e = readEntry(root, 7);
		expect(e.provisional).toBe(true);
		expect(e.bodyHash).toBe(bodyHash(issue.body));
		expect(e.writeSet).toEqual(["scripts/pick-next.js"]);
	});

	it("carries no size, because a grep cannot judge one", () => {
		storeProvisional(root, issue, tracked(REPO));
		expect(readEntry(root, 7).sizeBand).toBeNull();
	});

	it("carries a predicted size alongside, never inside `sizeBand`", () => {
		storeProvisional(root, issue, tracked(REPO));
		const e = readEntry(root, 7);
		expect(e.sizeBand).toBeNull();
		expect(e.predictedSize).toBe("small");
	});

	it("uses the title as the gist, which is the only one available unread", () => {
		storeProvisional(root, issue, tracked(REPO));
		expect(readEntry(root, 7).gist).toBe("Pre-warm the cache");
	});

	it("records only the predicted paths git tracks now, so a rename stays detectable", () => {
		storeProvisional(
			root,
			{ ...issue, body: "edit `scripts/pick-next.js` and §B7" },
			tracked(["scripts/pick-next.js"]),
		);
		const e = readEntry(root, 7);
		expect(e.writeSet).toEqual(["docs/doc-map.md", "scripts/pick-next.js"]);
		expect(e.trackedAtDerive).toEqual(["scripts/pick-next.js"]);
	});

	it("discards a superseded band read's size even where the body is unchanged", () => {
		/*
		 * The path-gone miss — a rename under a body an agent has already read.
		 * Carrying its size forward was tried and reverted: the merge test admits
		 * on `sizeBand === "small"` alone, never on source, so a carried size puts a
		 * grep-derived write-set into a test that assumes an agent judged it.
		 */
		writeEntry(root, {
			issue: 7,
			bodyHash: bodyHash(issue.body),
			writeSet: ["scripts/gone.js"],
			trackedAtDerive: ["scripts/gone.js"],
			sizeBand: "small",
			gist: "an agent's line",
		});
		storeProvisional(root, issue, tracked(REPO));
		const e = readEntry(root, 7);
		expect(e.sizeBand).toBeNull();
		expect(e.gist).toBe("Pre-warm the cache");
		expect(e.writeSet).toEqual(["scripts/pick-next.js"]);
		expect(e.provisional).toBe(true);
	});

	it("discards them where the body changed, since they describe prose that is gone", () => {
		writeEntry(root, {
			issue: 7,
			bodyHash: bodyHash("an older body"),
			writeSet: ["scripts/pick-next.js"],
			sizeBand: "S",
			gist: "an agent's line",
		});
		storeProvisional(root, issue, tracked(REPO));
		const e = readEntry(root, 7);
		expect(e.sizeBand).toBeNull();
		expect(e.gist).toBe("Pre-warm the cache");
	});

	it("reports why rather than storing, where no prediction may be made", () => {
		const r = storeProvisional(
			root,
			{ ...issue, labels: ["wayfinder:map"] },
			tracked(REPO),
		);
		expect(r.ok).toBe(false);
		expect(readEntry(root, 7)).toBeNull();
	});

	it("reports an unwritable store rather than throwing, so selection still runs", () => {
		// A file where the cache directory belongs.
		fs.mkdirSync(path.join(root, ".claude", "tmp", "markers"), {
			recursive: true,
		});
		fs.writeFileSync(
			path.join(root, ".claude", "tmp", "markers", ".pick-next"),
			"not a directory",
		);
		const r = storeProvisional(root, issue, tracked(REPO));
		expect(r.ok).toBe(false);
		expect(r.why).toBeTruthy();
	});
});
