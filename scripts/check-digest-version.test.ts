// @vitest-environment node

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

const html = (version: string) =>
	[
		"<!doctype html>",
		"<body>",
		`<p class="stamp">${version}</p>`,
		"</body>",
	].join("\n");

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

	it("fails when the HTML has moved ahead of the digest, quoting both version lines and naming gen-roadmap-digest.js as the way out", () => {
		write(HTML, html("v5.22 · updated 9 July 2026, 09:00"));
		write(DIGEST, digest("v5.21 · updated 8 July 2026, 19:00"));
		const r = check(HTML, DIGEST);
		expect(r.status).toBe(1);
		expect(r.out).toContain("drifted");
		expect(r.out).toContain("v5.22 · updated 9 July 2026, 09:00");
		expect(r.out).toContain("v5.21 · updated 8 July 2026, 19:00");
		expect(r.out).toContain("gen-roadmap-digest.js");
	});

	it("fails on a MINOR-only difference", () => {
		write(HTML, html("v5.22 · updated 8 July 2026, 19:00"));
		write(DIGEST, digest("v5.21 · updated 8 July 2026, 19:00"));
		const r = check(HTML, DIGEST);
		expect(r.status).toBe(1);
		expect(r.out).toContain("drifted");
	});

	it("fails when only the timestamp differs", () => {
		write(HTML, html("v5.21 · updated 8 July 2026, 21:30"));
		write(DIGEST, digest("v5.21 · updated 8 July 2026, 19:00"));
		const r = check(HTML, DIGEST);
		expect(r.status).toBe(1);
		expect(r.out).toContain("drifted");
	});

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

	it("is BROKEN on a version number with no updated-timestamp, reporting no version line found", () => {
		write(HTML, "<p>v5.21</p>");
		write(DIGEST, digest("v5.21 · updated 8 July 2026, 19:00"));
		const r = check(HTML, DIGEST);
		expect(r.status).toBe(2);
		expect(r.out).toContain("no version line found");
	});

	it("stops the version match at the end of its line", () => {
		const v = "v5.21 · updated 8 July 2026, 19:00";
		write(HTML, html(v));
		write(DIGEST, `# Roadmap digest\n\n${v}\n\nPhase 0 — Foundations\n`);
		expect(check(HTML, DIGEST).status).toBe(0);
	});

	it("defaults to the real roadmap and digest paths when given no arguments", () => {
		const v = "v5.21 · updated 8 July 2026, 19:00";
		write(HTML, html(v));
		write(DIGEST, digest(v));
		const r = check();
		expect(r.status).toBe(0);
		expect(r.out).toContain(v);
	});
});
