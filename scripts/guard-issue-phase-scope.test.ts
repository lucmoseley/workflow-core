// @vitest-environment node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFailOpenRecords } from "./guard-log-fixture";
import {
	buildBashPayload,
	dispatchCoreOutput,
	guardDirs,
} from "./lib/pretool-guard-testkit";

const CORE = "guard-issue-phase-scope";

const ROADMAP = [
	"const ITEMS = [",
	'  {id:"guide-pages",p:0,a:["mkt"],kind:"action",state:"active",t:"Destination guides",',
	'  {id:"search-core",p:1,a:["prod"],kind:"action",state:"active",t:"Search core",',
	"];",
].join("\n");

const register = (...cards: string[]) =>
	[
		"<!-- called-cards:begin -->",
		...cards.map((c) => `- \`${c}\` — called 1 January 2026`),
		"<!-- called-cards:end -->",
		"",
	].join("\n");

let dir: string;
let config: string;

beforeEach(() => {
	({ dir, config } = guardDirs("issue-phase-scope-entry-"));
	execFileSync("git", ["init", "-q", dir]);
	fs.mkdirSync(path.join(dir, "docs"));
	fs.writeFileSync(path.join(dir, "docs/reference-roadmap.html"), ROADMAP);
	fs.writeFileSync(path.join(dir, "docs/called-cards.md"), register());
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const emission = (command: string) =>
	dispatchCoreOutput(CORE, buildBashPayload(command, "s1"), {
		project: dir,
		config,
		cwd: dir,
	});

describe("each exit", () => {
	it("refuses an uncalled Phase-1 card as permissionDecision JSON on exit 0, read off the roadmap on disk", () => {
		const out = emission('gh issue create --title "search-core — a thing"');
		expect(out.hookEventName).toBe("PreToolUse");
		expect(out.permissionDecision).toBe("deny");
		expect(out.permissionDecisionReason).toContain(
			"This opens an issue for `search-core`, a **Phase 1** roadmap card the founder has not called",
		);
		expect(readFailOpenRecords(config, dir)).toEqual([]);
	});

	it("says nothing, exit 0, once the register on disk calls the card, or for a Phase-0 card", () => {
		fs.writeFileSync(
			path.join(dir, "docs/called-cards.md"),
			register("search-core"),
		);
		expect(
			emission('gh issue create --title "search-core — a thing"'),
		).toBeNull();
		expect(
			emission('gh issue create --title "guide-pages — a thing"'),
		).toBeNull();
		expect(readFailOpenRecords(config, dir)).toEqual([]);
	});
});

describe("what it fails open on", () => {
	it("allows a create where no roadmap exists, and records nothing on disk (#5576)", () => {
		fs.rmSync(path.join(dir, "docs/reference-roadmap.html"));
		expect(
			emission('gh issue create --title "search-core — a thing"'),
		).toBeNull();
		expect(readFailOpenRecords(config, dir)).toEqual([]);
	});

	it("allows a create whose roadmap will not read, and records it on disk", () => {
		fs.rmSync(path.join(dir, "docs/reference-roadmap.html"));
		fs.mkdirSync(path.join(dir, "docs/reference-roadmap.html"));
		expect(
			emission('gh issue create --title "search-core — a thing"'),
		).toBeNull();
		expect(readFailOpenRecords(config, dir)).toEqual([
			[
				expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
				CORE,
				"docs/reference-roadmap.html is unreadable — issue creation allowed unchecked",
			],
		]);
	});
});
