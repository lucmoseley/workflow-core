// @vitest-environment node
/*
 * adopter-consent.test.ts — the decline/pending-consent store (#245). Every
 * test points CLAUDE_CONFIG_DIR at a throwaway temp directory — the real
 * config dir otherwise gets a stray adopter-upgrade/ tree.
 *
 * check-plugin-gap.js and reconcile-plugin.js read this store at session start
 * and end: loosen a case here and a declined upgrade is re-asked every session,
 * or a yes never reaches the materialiser and the plugin gap goes unclosed.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	base,
	clearPendingConsent,
	decline,
	isDeclined,
	readPendingConsent,
	setPendingConsent,
} from "./adopter-consent.js";

let dir = "";
const savedEnv = { ...process.env };

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "adopter-consent-"));
	process.env.CLAUDE_CONFIG_DIR = path.join(dir, "claude");
	delete process.env.WFC_CLAUDE_CONFIG_A;
	delete process.env.WFC_CLAUDE_CONFIG_B;
	delete process.env.WFC_CLAUDE_CONFIG_C;
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
	process.env = { ...savedEnv };
});

const REPO = "/home/founder/fantasy-books";

describe("decline", () => {
	it("is unset until written", () => {
		expect(isDeclined(REPO, "v1.1.11")).toBe(false);
	});

	it("silences only the declined tag, never a different tag in the same repo", () => {
		expect(decline(REPO, "v1.1.11")).toBe(true);
		expect(isDeclined(REPO, "v1.1.11")).toBe(true);
		expect(isDeclined(REPO, "v1.1.12")).toBe(false);
	});

	it("never silences a different repo pinned to the same tag", () => {
		decline(REPO, "v1.1.11");
		expect(isDeclined("/home/founder/other-repo", "v1.1.11")).toBe(false);
	});

	it("is permanent — a second read still sees it", () => {
		decline(REPO, "v1.1.11");
		expect(isDeclined(REPO, "v1.1.11")).toBe(true);
		expect(isDeclined(REPO, "v1.1.11")).toBe(true);
	});
});

describe("pending consent", () => {
	it("is absent until a yes is written", () => {
		expect(readPendingConsent(REPO, "v1.1.11")).toBeNull();
	});

	it("is readable by a separate process once written on a yes", () => {
		expect(setPendingConsent(REPO, "v1.1.11")).toBe(true);
		const read = readPendingConsent(REPO, "v1.1.11");
		expect(read).not.toBeNull();
		expect(read?.repo).toBe(REPO);
		expect(read?.tag).toBe("v1.1.11");
		expect(typeof read?.acceptedAt).toBe("string");
	});

	it("clears on a successful materialise and stays cleared", () => {
		setPendingConsent(REPO, "v1.1.11");
		expect(clearPendingConsent(REPO, "v1.1.11")).toBe(true);
		expect(readPendingConsent(REPO, "v1.1.11")).toBeNull();
		expect(clearPendingConsent(REPO, "v1.1.11")).toBe(false);
	});

	it("survives a failed materialise — nothing clears it but clearPendingConsent", () => {
		setPendingConsent(REPO, "v1.1.11");
		expect(readPendingConsent(REPO, "v1.1.11")).not.toBeNull();
	});
});

describe("nothing expresses an accepted-and-completed state", () => {
	it('clearing pending leaves no residue readable as "done"', () => {
		setPendingConsent(REPO, "v1.1.11");
		clearPendingConsent(REPO, "v1.1.11");
		expect(readPendingConsent(REPO, "v1.1.11")).toBeNull();
		expect(isDeclined(REPO, "v1.1.11")).toBe(false);
	});
});

describe("storage location", () => {
	it("lives under the sandbox's config-dir set, never a hard-coded ~/.claude", () => {
		decline(REPO, "v1.1.11");
		// The candidate set is sorted for cross-process agreement, so this need
		// not be CLAUDE_CONFIG_DIR itself — only under this test's own tree.
		expect(base().startsWith(dir)).toBe(true);
		expect(base()).not.toContain(os.homedir());
	});

	it("honours an explicit configDir override, touching CLAUDE_CONFIG_DIR not at all", () => {
		const other = fs.mkdtempSync(path.join(dir, "explicit-"));
		delete process.env.CLAUDE_CONFIG_DIR;
		expect(decline(REPO, "v1.1.11", { configDir: other })).toBe(true);
		expect(isDeclined(REPO, "v1.1.11", { configDir: other })).toBe(true);
		expect(fs.existsSync(path.join(other, "adopter-upgrade"))).toBe(true);
	});
});
