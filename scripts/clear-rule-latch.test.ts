// @vitest-environment node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defineTemplate, emptyRepoTemplate } from "./lib/git-fixture";

const HOOK = path.resolve(__dirname, "clear-rule-latch.sh");

const MARKER_OF_ONE = `const fs = require("node:fs");
const path = require("node:path");
const { writeLatches } = require(${JSON.stringify(path.resolve(__dirname, "lib/guard-entry.js"))});
const { hostRoot } = require(${JSON.stringify(path.resolve(__dirname, "lib/host-root.js"))});
const { markersDir } = require(${JSON.stringify(path.resolve(__dirname, "lib/marker-root.js"))});
const root = hostRoot(process.cwd());
writeLatches({ root, payload: { session_id: "sid-1" }, log: () => {} }, [{ name: "one", text: "" }]);
const dir = markersDir(root);
const at = path.join(dir, fs.readdirSync(dir).find((n) => n.endsWith("one-main-sid-1")));
fs.unlinkSync(at);
process.stdout.write(at);`;

describe("clear-rule-latch.sh", () => {
	const emptyRepo = defineTemplate(emptyRepoTemplate);
	let base: string;
	let root: string;

	beforeEach(() => {
		base = fs.mkdtempSync(path.join(os.tmpdir(), "clear-latch-"));
		root = path.join(base, "repo");
		fs.mkdirSync(root);
	});
	afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

	const markersDir = () => path.join(root, ".claude", "tmp", "markers");

	const latch = (name: string) => {
		fs.mkdirSync(markersDir(), { recursive: true });
		fs.writeFileSync(path.join(markersDir(), name), "");
		return name;
	};

	const env = (projectDir: string) => ({
		...process.env,
		CLAUDE_PROJECT_DIR: projectDir,
		CLAUDE_CONFIG_DIR: path.join(base, "config"),
	});

	const run = (payload: string, projectDir = root) =>
		spawnSync(HOOK, [], {
			input: payload,
			encoding: "utf8",
			env: env(projectDir),
		});

	const readMarkerNames = () =>
		fs.existsSync(markersDir()) ? fs.readdirSync(markersDir()).sort() : [];

	it("clears this session's latches", () => {
		latch(".rule-injected-one-main-sid-1");
		latch(".rule-injected-two-main-sid-1");
		const r = run('{"hook_event_name":"PreCompact","session_id":"sid-1"}');
		expect(r.status).toBe(0);
		expect(readMarkerNames()).toEqual([]);
	});

	it("clears a subagent's latches with its parent's", () => {
		latch(".rule-injected-one-aac7cb4a4-sid-1");
		run('{"hook_event_name":"PreCompact","session_id":"sid-1"}');
		expect(readMarkerNames()).toEqual([]);
	});

	it("leaves another session's latches alone", () => {
		latch(".rule-injected-one-main-sid-2");
		run('{"hook_event_name":"PreCompact","session_id":"sid-1"}');
		expect(readMarkerNames()).toEqual([".rule-injected-one-main-sid-2"]);
	});

	it("touches nothing outside the family", () => {
		latch(".concision-nagged-sid-1");
		fs.mkdirSync(markersDir(), { recursive: true });
		fs.writeFileSync(path.join(markersDir(), "README.md"), "");
		run('{"hook_event_name":"PreCompact","session_id":"sid-1"}');
		expect(readMarkerNames()).toEqual([".concision-nagged-sid-1", "README.md"]);
	});

	it("clears on an automatic compaction as well as a manual one", () => {
		latch(".rule-injected-one-main-sid-1");
		run(
			'{"hook_event_name":"PreCompact","session_id":"sid-1","trigger":"auto"}',
		);
		expect(readMarkerNames()).toEqual([]);
	});

	it("exits 0 and clears nothing on a payload with no session_id", () => {
		latch(".rule-injected-one-main-sid-1");
		const r = run('{"hook_event_name":"PreCompact"}');
		expect(r.status).toBe(0);
		expect(readMarkerNames()).toEqual([".rule-injected-one-main-sid-1"]);
	});

	it("exits 0 on a payload that does not parse", () => {
		latch(".rule-injected-one-main-sid-1");
		const r = run("not json");
		expect(r.status).toBe(0);
		expect(readMarkerNames()).toEqual([".rule-injected-one-main-sid-1"]);
	});

	it("exits 0 on an empty payload", () => {
		expect(run("").status).toBe(0);
	});

	it("sanitises the session id before it reaches the glob", () => {
		latch(".rule-injected-one-main-___escape");
		run('{"hook_event_name":"PreCompact","session_id":"../escape"}');
		expect(readMarkerNames()).toEqual([]);
	});

	describe("agrees with the entry's latch on where the latch is", () => {
		const readLatchPath = (projectDir: string) =>
			spawnSync("node", ["-e", MARKER_OF_ONE], {
				encoding: "utf8",
				env: env(projectDir),
			}).stdout;

		it("clears a latch written under a plainly spelled root", () => {
			fs.writeFileSync(readLatchPath(root), "");
			expect(readMarkerNames()).toEqual([".rule-injected-one-main-sid-1"]);
			run('{"hook_event_name":"PreCompact","session_id":"sid-1"}');
			expect(readMarkerNames()).toEqual([]);
		});

		it("clears one written under a root spelled with a trailing slash", () => {
			const slashed = `${root}/`;
			expect(readLatchPath(slashed)).toBe(
				path.join(
					root,
					".claude",
					"tmp",
					"markers",
					".rule-injected-one-main-sid-1",
				),
			);
			fs.writeFileSync(readLatchPath(slashed), "");
			run('{"hook_event_name":"PreCompact","session_id":"sid-1"}', slashed);
			expect(readMarkerNames()).toEqual([]);
		});

		it("clears one written from a subdirectory, with no root in the environment", () => {
			emptyRepo.instantiate(root);
			const sub = path.join(root, "deep");
			fs.mkdirSync(sub);
			const unset: NodeJS.ProcessEnv = {
				...process.env,
				CLAUDE_CONFIG_DIR: path.join(base, "c"),
			};
			delete unset.CLAUDE_PROJECT_DIR;

			const at = spawnSync("node", ["-e", MARKER_OF_ONE], {
				encoding: "utf8",
				cwd: sub,
				env: unset,
			}).stdout;
			expect(at).toBe(
				path.join(
					root,
					".claude",
					"tmp",
					"markers",
					".rule-injected-one-main-sid-1",
				),
			);
			fs.writeFileSync(at, "");

			const r = spawnSync(HOOK, [], {
				input: '{"hook_event_name":"PreCompact","session_id":"sid-1"}',
				encoding: "utf8",
				cwd: sub,
				env: unset,
			});
			expect(r.status).toBe(0);
			expect(fs.existsSync(at)).toBe(false);
		});
	});
});
