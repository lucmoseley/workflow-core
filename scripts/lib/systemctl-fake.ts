/*
 * systemctl-fake.ts — a stub `systemctl` for tests of its callers, injected at
 * WFC_SYSTEMCTL (lib/systemd-bins.js) and held to the real one by
 * systemctl.contract.test.ts (§G7, #3970).
 *
 * FOR TESTS ONLY.
 */
import fs from "node:fs";
import path from "node:path";
import { shellQuote } from "./sh-quote.js";

export interface SystemctlAnswers {
	/** `is-enabled <unit>`'s state by unit; a unit not named is not-found. */
	unitStates?: Record<string, string>;
	/** `show <unit> --property=A,B`'s values by property, printed `A=value`. */
	properties?: Record<string, string>;
	/** A verb that fails, with its exit code and stderr. */
	fails?: Record<string, { exit: number; says?: string }>;
}

/* systemctl(1): is-enabled exits 0 on these states, 4 on not-found, else 1. */
const ENABLED_STATES = [
	"enabled",
	"enabled-runtime",
	"static",
	"alias",
	"indirect",
	"generated",
	"transient",
];

const arms = (entries: [string, string][]) =>
	entries
		.map(([match, body]) => `  ${shellQuote(match)}) ${body};;`)
		.join("\n");

/**
 * A systemctl in `dir`, appending each call's `systemctl <args>` to
 * `dir/calls`. A verb neither failed nor read prints nothing and exits 0.
 * Its path, for WFC_SYSTEMCTL.
 */
export function writeSystemctl(
	dir: string,
	{ unitStates = {}, properties = {}, fails = {} }: SystemctlAnswers = {},
): string {
	fs.mkdirSync(dir, { recursive: true });
	const bin = path.join(dir, "systemctl");
	const states = arms(
		Object.entries(unitStates).map(([unit, state]) => [
			unit,
			`echo ${shellQuote(state)}; exit ${ENABLED_STATES.includes(state) ? 0 : 1}`,
		]),
	);
	const shown = arms(
		Object.entries(properties).map(([name, value]) => [
			name,
			`printf '%s\\n' ${shellQuote(`${name}=${value}`)}`,
		]),
	);
	const failing = arms(
		Object.entries(fails).map(([verb, { exit, says = "" }]) => [
			verb,
			`${says ? `echo ${shellQuote(says)} >&2; ` : ""}exit ${exit}`,
		]),
	);
	fs.writeFileSync(
		bin,
		`#!/bin/sh
echo systemctl "$*" >> ${shellQuote(path.join(dir, "calls"))}
verb= unit= props=
for a in "$@"; do
  case "$a" in
  --property=*) props=\${a#--property=};;
  -*) ;;
  *) if [ -z "$verb" ]; then verb=$a; else unit=$a; fi;;
  esac
done
case "$verb" in
${failing}
esac
case "$verb" in
is-enabled)
  case "$unit" in
${states}
  *) echo not-found; exit 4;;
  esac;;
show)
  IFS=,
  for p in $props; do
    case "$p" in
${shown}
    esac
  done;;
esac
exit 0
`,
		{ mode: 0o755 },
	);
	return bin;
}

/** The calls the systemctl in `dir` took, oldest first. */
export function systemctlCalls(dir: string): string[] {
	const log = path.join(dir, "calls");
	return fs.existsSync(log)
		? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean)
		: [];
}
