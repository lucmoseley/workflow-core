// @vitest-environment node
/*
 * review-standards.test.ts — review-standards.sh with the core root resolved
 * and unresolved: pins that it names the base only under a resolved root, and
 * logs an unresolved root or an absent base rather than going quiet. Broken, a
 * route hands its reviewer a rootless `/docs/code-standards-base.md` and logs
 * nothing, so the review runs without the base unmarked (#947's review). It
 * also pins that the host's GLOSSARY.md is named only where it exists, since a
 * glossary named where none exists sends the reviewer after §G8 findings
 * against nothing (#1373). A
 * resolved root is set through WFC_SCRIPT_ROOT, script-path.sh's own test seam.
 * Unresolved is a state no route's own test can reach: every route needs
 * script-path.sh to load, and loaded it always resolves a root — and an empty
 * WFC_SCRIPT_ROOT falls back to it. So only those cases stub sp_core_root. A
 * plain tempdir, not a git repo: gr_root takes CLAUDE_PROJECT_DIR, and nothing
 * here reads git.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { guardErrorsLog } from "./guard-errors-log";

const LIB = path.resolve(__dirname, "review-standards.sh");

let dir: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "review-standards-"));
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

// root "" stubs sp_core_root to print nothing; any other root goes in through
// WFC_SCRIPT_ROOT, the real seam.
const run = (root: string, body: string) =>
	spawnSync(
		"bash",
		[
			"-c",
			`${root === "" ? "sp_core_root() { :; }; " : ""}source "$LIB" && ${body}`,
		],
		{
			encoding: "utf8",
			env: {
				...process.env,
				WFC_SCRIPT_ROOT: root,
				LIB,
				CLAUDE_PROJECT_DIR: dir,
				// gl_log writes under CLAUDE_CONFIG_DIR; unset, a run appends to the
				// founder's own log.
				CLAUDE_CONFIG_DIR: dir,
			},
		},
	);

describe("an unresolved core root (#947 review)", () => {
	it("prints no base path and fails, so the caller keeps its default", () => {
		const r = run("", "review_standards_base");
		expect(r.status).toBe(1);
		expect(r.stdout).toBe("");
	});

	it("reports no state, so the caller hands over both files", () => {
		const r = run("", "review_standards_state");
		expect(r.status).toBe(1);
		expect(r.stdout).toBe("");
	});

	it("logs the review as run with its root unresolved", () => {
		expect(run("", "review_standards_log_missing_base").status).toBe(0);
		expect(guardErrorsLog(dir)).toContain("standards core root unresolved");
	});
});

describe("a resolved core root", () => {
	it("names the base under that root", () => {
		const r = run(dir, "review_standards_base");
		expect(r.status).toBe(0);
		expect(r.stdout).toBe(path.join(dir, "docs", "code-standards-base.md"));
	});

	it("reports neither where neither standards file exists", () => {
		const r = run(dir, "review_standards_state");
		expect(r.status).toBe(0);
		expect(r.stdout).toBe("neither");
	});

	it("logs an absent base as absent, naming its path", () => {
		expect(run(dir, "review_standards_log_missing_base").status).toBe(0);
		const log = guardErrorsLog(dir);
		expect(log).toContain("standards base absent");
		expect(log).toContain(path.join(dir, "docs", "code-standards-base.md"));
	});

	it("logs nothing where the base is present", () => {
		fs.mkdirSync(path.join(dir, "docs"));
		fs.writeFileSync(
			path.join(dir, "docs", "code-standards-base.md"),
			"base\n",
		);
		expect(run(dir, "review_standards_log_missing_base").status).toBe(0);
		expect(guardErrorsLog(dir)).toBe("");
	});
});

describe("the host's glossary (#1373)", () => {
	it("names the host's GLOSSARY.md where it exists", () => {
		fs.writeFileSync(path.join(dir, "GLOSSARY.md"), "# Glossary\n");
		const r = run(dir, "review_standards_glossary");
		expect(r.status).toBe(0);
		expect(r.stdout).toBe(path.join(dir, "GLOSSARY.md"));
	});

	it("prints nothing and fails where the host has none", () => {
		const r = run(dir, "review_standards_glossary");
		expect(r.status).toBe(1);
		expect(r.stdout).toBe("");
	});

	it("words the hand-over sentence round that path, and nothing where there is none", () => {
		expect(run(dir, "review_standards_glossary_line").stdout).toBe("");
		fs.writeFileSync(path.join(dir, "GLOSSARY.md"), "# Glossary\n");
		expect(run(dir, "review_standards_glossary_line").stdout).toBe(
			" Hand the Standards axis `GLOSSARY.md` too, for base §G8.",
		);
	});
});

describe("a path as a session is handed it (#1729)", () => {
	it("names a path under the host root relative to it", () => {
		expect(
			run(dir, `review_standards_shown "${path.join(dir, "docs", "x.md")}"`)
				.stdout,
		).toBe("docs/x.md");
	});

	it("names a path outside the host root whole, as an adopter's plugin-cache base", () => {
		expect(
			run(dir, `review_standards_shown "/elsewhere/docs/x.md"`).stdout,
		).toBe("/elsewhere/docs/x.md");
	});
});

describe("the base as a session is handed it (#1779)", () => {
	it("names a base under the host root relative to it", () => {
		const r = run(dir, "review_standards_base_shown");
		expect(r.status).toBe(0);
		expect(r.stdout).toBe("docs/code-standards-base.md");
	});

	it("names a base outside the host root whole", () => {
		const core = fs.mkdtempSync(path.join(os.tmpdir(), "review-core-"));
		try {
			expect(run(core, "review_standards_base_shown").stdout).toBe(
				path.join(core, "docs", "code-standards-base.md"),
			);
		} finally {
			fs.rmSync(core, { recursive: true, force: true });
		}
	});

	it("prints nothing and fails where the core root is unresolved, so the caller keeps its default", () => {
		const r = run("", "review_standards_base_shown");
		expect(r.status).toBe(1);
		expect(r.stdout).toBe("");
	});
});
