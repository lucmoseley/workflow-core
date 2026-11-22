// @vitest-environment node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkScratchDir } from "./git-fixture";

const { buildHostPorts } = require("./push-rules-host.js") as {
	buildHostPorts: (env: {
		root: string;
		log: (what: string, detail?: string) => void;
	}) => {
		markerSum: (session: string) => string;
		deploysVercel: () => boolean;
	};
};

let root: string;

beforeEach(() => {
	root = mkScratchDir("push-rules-host-");
	vi.stubEnv("WFC_MODULES", undefined);
	vi.stubEnv("CLAUDE_PROJECT_DIR", root);
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

const ports = () => buildHostPorts({ root, log: () => undefined });

const write = (rel: string, body: string) => {
	fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
	fs.writeFileSync(path.join(root, rel), body);
};

const declare = (cfg: object) =>
	write(".claude/workflow-core.json", JSON.stringify({ contract: 1, ...cfg }));

describe("the declared deploy", () => {
	it.each([
		[{ deploy: "vercel" }, true],
		[{ deploy: "netlify" }, false],
		[{}, false],
	])("%j deploys to Vercel: %s", (cfg, vercel) => {
		declare(cfg);
		expect(ports().deploysVercel()).toBe(vercel);
	});

	it("a host with no config deploys nothing", () => {
		expect(ports().deploysVercel()).toBe(false);
	});
});

describe("the session's review marker", () => {
	const marker = path.join(".claude", "tmp", "markers", ".codereview-pass-s1");

	it("is a checksum of its bytes, so a rewritten marker reads as new", () => {
		write(marker, "base=x\n");
		expect(ports().markerSum("s1")).toBe(
			crypto.createHash("sha256").update("base=x\n").digest("hex"),
		);
		write(marker, "base=y\n");
		expect(ports().markerSum("s1")).not.toBe(
			crypto.createHash("sha256").update("base=x\n").digest("hex"),
		);
	});

	it("reads as empty where there is none, or no session to own one", () => {
		expect(ports().markerSum("s1")).toBe("");
		write(marker, "base=x\n");
		expect(ports().markerSum("")).toBe("");
	});
});
