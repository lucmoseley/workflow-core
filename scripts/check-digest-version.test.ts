// @vitest-environment node
/*
 * Pins that check-digest-version.js passes only when the roadmap's and the
 * digest's first version-and-timestamp lines match exactly, and reads BROKEN
 * when either file or line is missing.
 *
 * check-digest-version.js compares one line of two files, so it needs no git —
 * a throwaway directory holding a fake roadmap and a fake digest is the whole
 * fixture.
 *
 * It is a hard gate in .github/workflows/roadmap-digest.yml, and in
 * .husky/pre-commit on a commit staging either file: a false pass ships
 * a digest describing a roadmap that has moved on, and a false fail blocks
 * every roadmap edit.
 *
 * Built for mantahostels#148, which tested this checker and check-doc-map.js as
 * the two untested hard CI gates.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process";

const SCRIPT = path.resolve(__dirname, "check-digest-version.js");
const HTML = "docs/reference-roadmap.html";
const DIGEST = "docs/roadmap-digest.md";

let dir: string;

const write = (file: string, body: string) =>
	fs.writeFileSync(path.join(dir, file), body);

/** The roadmap header as the real file spells it: version inside a tag. */
const html = (version: string) =>
	[
		"<!doctype html>",
		"<body>",
		`<p class="stamp">${version}</p>`,
		"</body>",
	].join("\n");

/** The digest header as the real file spells it: version, then a card count. */
const digest = (version: string, tail = " · 107 cards") =>
	["# Roadmap digest", "", `${version}${tail}`, ""].join("\n");

const check = (...args: string[]) => {
	const r = runInProcess(SCRIPT, args, { cwd: dir });
	return {
		status: r.status,
		out: `${r.stdout}${r.stderr}`,
	};
};

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "digest-version-test-"));
	fs.mkdirSync(path.join(dir, "docs"));
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("check-digest-version", () => {
	it("passes when the two version lines agree, and names the version", () => {
		const v = "v5.21 · updated 8 July 2026, 19:00";
		write(HTML, html(v));
		write(DIGEST, digest(v));
		const r = check(HTML, DIGEST);
		expect(r.status).toBe(0);
		expect(r.out).toContain("OK");
		expect(r.out).toContain(v);
	});

	// The failure this guard exists for: the half-update. HTML edited by hand or
	// by roadmap-edit, digest never regenerated.
	it("fails when the HTML has moved ahead of the digest, quoting both version lines and naming gen-roadmap-digest.js as the way out", () => {
		write(HTML, html("v5.22 · updated 9 July 2026, 09:00"));
		write(DIGEST, digest("v5.21 · updated 8 July 2026, 19:00"));
		const r = check(HTML, DIGEST);
		expect(r.status).toBe(1);
		expect(r.out).toContain("drifted");
		// both sides quoted, or the reader cannot tell which file to regenerate
		expect(r.out).toContain("v5.22 · updated 9 July 2026, 09:00");
		expect(r.out).toContain("v5.21 · updated 8 July 2026, 19:00");
		// the failure has to carry the way out
		expect(r.out).toContain("gen-roadmap-digest.js");
	});

	it("fails on a MINOR-only difference", () => {
		write(HTML, html("v5.22 · updated 8 July 2026, 19:00"));
		write(DIGEST, digest("v5.21 · updated 8 July 2026, 19:00"));
		const r = check(HTML, DIGEST);
		expect(r.status).toBe(1);
		expect(r.out).toContain("drifted");
	});

	// Same version, different timestamp: a regeneration that ran against an older
	// HTML still counts as drift, because the stamp carries both.
	it("fails when only the timestamp differs", () => {
		write(HTML, html("v5.21 · updated 8 July 2026, 21:30"));
		write(DIGEST, digest("v5.21 · updated 8 July 2026, 19:00"));
		const r = check(HTML, DIGEST);
		expect(r.status).toBe(1);
		expect(r.out).toContain("drifted");
	});

	// The two files legitimately carry different trailing content — "</p>" in the
	// HTML, " · 107 cards" in the digest. If the match ran past the timestamp the
	// guard would fail every single roadmap commit.
	it("ignores each file's trailing content after the timestamp", () => {
		const v = "v5.21 · updated 8 July 2026, 19:00";
		write(HTML, html(v));
		write(DIGEST, digest(v, " · 107 cards · 12 phases"));
		expect(check(HTML, DIGEST).status).toBe(0);
	});

	it("compares the first version line when a file quotes another later", () => {
		const v = "v5.21 · updated 8 July 2026, 19:00";
		write(HTML, `${html(v)}\n<p>superseded v4.0 · updated 1 Jan 2026</p>\n`);
		write(DIGEST, `${digest(v)}\nHistory: v4.0 · updated 1 Jan 2026\n`);
		expect(check(HTML, DIGEST).status).toBe(0);
	});

	/* A file this guard cannot read or cannot parse is BROKEN (exit 2), not a
	 * finding (exit 1): nothing was compared, so there is no conclusion about the
	 * digest either way. Both files are tracked in the repo, which is what puts
	 * this on BROKEN rather than SKIP (mantahostels#155 — the checker family's
	 * exit-code and severity model — decision 6). */
	it("is BROKEN when the roadmap HTML is missing, naming the file", () => {
		write(DIGEST, digest("v5.21 · updated 8 July 2026, 19:00"));
		const r = check(HTML, DIGEST);
		expect(r.status).toBe(2);
		expect(r.out).toContain("cannot read roadmap HTML");
		expect(r.out).toContain(HTML);
	});

	it("is BROKEN when the digest is missing, naming the file", () => {
		write(HTML, html("v5.21 · updated 8 July 2026, 19:00"));
		const r = check(HTML, DIGEST);
		expect(r.status).toBe(2);
		expect(r.out).toContain("cannot read digest");
		expect(r.out).toContain(DIGEST);
	});

	it("is BROKEN when the HTML carries no version line", () => {
		write(HTML, "<p>roadmap, no stamp</p>");
		write(DIGEST, digest("v5.21 · updated 8 July 2026, 19:00"));
		const r = check(HTML, DIGEST);
		expect(r.status).toBe(2);
		expect(r.out).toContain("no version line found in roadmap HTML");
	});

	it("is BROKEN when the digest carries no version line", () => {
		write(HTML, html("v5.21 · updated 8 July 2026, 19:00"));
		write(DIGEST, "# Roadmap digest\n\n107 cards\n");
		const r = check(HTML, DIGEST);
		expect(r.status).toBe(2);
		expect(r.out).toContain("no version line found in digest");
	});

	// A version without the " · updated <date>" half is not a stamp. This is what
	// stops a bare "v2" in card prose being read as the file's identity.
	it("is BROKEN on a version number with no updated-timestamp, reporting no version line found", () => {
		write(HTML, "<p>v5.21</p>");
		write(DIGEST, digest("v5.21 · updated 8 July 2026, 19:00"));
		const r = check(HTML, DIGEST);
		expect(r.status).toBe(2);
		expect(r.out).toContain("no version line found");
	});

	// The stamp is one line. A digest whose version line carries no " · N cards"
	// tail is followed straight by prose, and a match that ran past the newline
	// would swallow it.
	it("stops the version match at the end of its line", () => {
		const v = "v5.21 · updated 8 July 2026, 19:00";
		write(HTML, html(v));
		write(DIGEST, `# Roadmap digest\n\n${v}\n\nPhase 0 — Foundations\n`);
		expect(check(HTML, DIGEST).status).toBe(0);
	});

	// The workflow invokes it bare, so the defaults are part of the contract.
	it("defaults to the real roadmap and digest paths when given no arguments", () => {
		const v = "v5.21 · updated 8 July 2026, 19:00";
		write(HTML, html(v));
		write(DIGEST, digest(v));
		const r = check();
		expect(r.status).toBe(0);
		expect(r.out).toContain(v);
	});
});
