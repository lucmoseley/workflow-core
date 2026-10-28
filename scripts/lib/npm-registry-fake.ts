/*
 * The fake of the registry ports lib/npm-install-host.js wires into
 * the guard-npm-install core: `npm view <pkg> time.created --json` and curl
 * on the npm downloads endpoint (#2207, #2912), in-process and as WFC_NPM and
 * WFC_CURL stubs. lib/npm-registry.contract.test.ts holds it to the real npm
 * and curl. The bodies are synthetic in value and the real tools' in shape.
 */

import fs from "node:fs";
import path from "node:path";
import type { Call } from "./npm-install.js";

export type { Call } from "./npm-install.js";

/**
 * What the fake registry answers. `created` is an ISO date or a failure mode:
 * `E404` (no such package), `FAIL` (the registry unreachable) or `MISSING`
 * (npm will not start). `downloads` is a figure, `FAIL` or `MISSING`.
 */
export interface Registry {
	created: string;
	downloads: number | "FAIL" | "MISSING";
	/** Raw stdout for `npm view`, in place of the one `created` gives. */
	viewOut?: string;
	/** `npm view`'s exit status, in place of the one `created` gives. */
	viewStatus?: number | null;
	/** Raw stdout for the downloads call, in place of `downloads`'s. */
	dlOut?: string;
	/** The downloads call's exit status, in place of `downloads`'s. */
	dlStatus?: number | null;
}

/**
 * A package clearing both of the core's floors (180 days, 1,000 downloads a
 * month) by a wide margin, so a case moving one figure moves only that check.
 */
export const buildPassingRegistry = (now: number): Registry => ({
	created: new Date(now - 4000 * 86_400_000).toISOString(),
	downloads: 9_000_000,
});

const buildNpmError = (code: string, summary: string, detail: string) =>
	`${JSON.stringify({ error: { code, summary, detail } }, null, 2)}\n`;

function npmViewMode(created: string): Call {
	if (created === "MISSING") return { missing: true };
	if (created === "E404")
		return {
			status: 1,
			stdout: buildNpmError(
				"E404",
				"Not Found - GET https://registry.example/the-package - Not found",
				"The requested resource 'the-package@*' could not be found.",
			),
		};
	if (created === "FAIL")
		return {
			status: 1,
			stdout: buildNpmError(
				"ECONNREFUSED",
				"FetchError: request to https://registry.example/the-package failed",
				"If you are behind a proxy, please make sure that the 'proxy' config is set properly.",
			),
		};
	return { status: 0, stdout: `"${created}"\n` };
}

function downloadsMode(downloads: Registry["downloads"]): Call {
	if (downloads === "MISSING") return { missing: true };
	/* curl -f's exit on a refused connection; its stdout stays empty. */
	if (downloads === "FAIL") return { status: 7, stdout: "" };
	return {
		status: 0,
		stdout: JSON.stringify({
			downloads,
			start: "2026-01-01",
			end: "2026-01-30",
			package: "the-package",
		}),
	};
}

const overridden = (
	call: Call,
	status: number | null | undefined,
	stdout: string | undefined,
): Call =>
	"missing" in call
		? call
		: {
				status: status === undefined ? call.status : status,
				stdout: stdout ?? call.stdout,
			};

export const npmViewAnswer = (reg: Registry): Call =>
	overridden(npmViewMode(reg.created), reg.viewStatus, reg.viewOut);

export const downloadsAnswer = (reg: Registry): Call =>
	overridden(downloadsMode(reg.downloads), reg.dlStatus, reg.dlOut);

/**
 * Writes the `npm` and `curl` stubs under `dir` and returns the environment
 * that serves a registry's answers through them. Each stub logs its argv to
 * `$STUB_CALLS`; npm also writes to stderr, which the adapter drops.
 */
export function writeRegistryStubs(dir: string) {
	fs.mkdirSync(dir, { recursive: true });
	const buildStubScript = (name: string, tool: string, extra = "") =>
		`#!/usr/bin/env bash
echo "${tool} $*" >> "$STUB_CALLS"
${extra}printf '%s' "$STUB_${name}_OUT"
exit "$STUB_${name}_STATUS"
`;
	for (const [name, tool, extra] of [
		["NPM", "npm", `echo "noise on stderr" >&2\n`],
		["CURL", "curl", ""],
	] as const) {
		const file = path.join(dir, tool);
		fs.writeFileSync(file, buildStubScript(name, tool, extra));
		fs.chmodSync(file, 0o755);
	}
	const buildServedEnv = (
		name: string,
		tool: string,
		call: Call,
	): NodeJS.ProcessEnv =>
		"missing" in call
			? { [`WFC_${name}`]: path.join(dir, `no-such-${tool}`) }
			: {
					[`WFC_${name}`]: path.join(dir, tool),
					[`STUB_${name}_OUT`]: call.stdout,
					[`STUB_${name}_STATUS`]: String(call.status),
				};
	return (reg: Registry): NodeJS.ProcessEnv => ({
		...buildServedEnv("NPM", "npm", npmViewAnswer(reg)),
		...buildServedEnv("CURL", "curl", downloadsAnswer(reg)),
	});
}
