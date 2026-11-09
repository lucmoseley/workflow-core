/*
 * loginctl-fake.ts — a stub `loginctl` for tests of its callers, injected at
 * WFC_LOGINCTL (lib/systemd-bins.js) and held to the real one by
 * loginctl.contract.test.ts (§G7, #4594).
 *
 * FOR TESTS ONLY.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { shellQuote } from "./sh-quote.js";

export interface LoginctlAnswers {
	/** `show-user`'s Linger property. */
	linger?: "yes" | "no";
	/** A verb that fails, with its exit code and stderr. */
	fails?: Record<string, { exit: number; says?: string }>;
}

function buildScript(
	log: string,
	{ linger = "yes", fails = {} }: LoginctlAnswers,
): string {
	const failing = Object.entries(fails)
		.map(
			([verb, { exit, says = "" }]) =>
				`  ${shellQuote(verb)}) ${says ? `echo ${shellQuote(says)} >&2; ` : ""}exit ${exit};;`,
		)
		.join("\n");
	return `#!/bin/sh
echo loginctl "$*" >> ${shellQuote(log)}
verb= who= props= next=
for a in "$@"; do
  if [ -n "$next" ]; then props="$props,$a"; next=; continue; fi
  case "$a" in
  -p|--property) next=1;;
  --property=*) props="$props,\${a#--property=}";;
  -*) ;;
  *) if [ -z "$verb" ]; then verb=$a; else who=$a; fi;;
  esac
done
case "$verb" in
${failing}
esac
case "$verb" in
show-user)
  if [ "$who" != ${shellQuote(os.userInfo().username)} ]; then
    echo "Failed to look up user $who: No such process" >&2; exit 1
  fi
  IFS=,
  for p in $props; do
    [ "$p" = Linger ] && echo ${shellQuote(`Linger=${linger}`)}
  done;;
esac
exit 0
`;
}

/**
 * A loginctl in `dir` that knows only the running user, appending each call's `loginctl <args>` to `dir/calls`.
 * A verb neither failed nor modelled, `enable-linger` among them, prints
 * nothing and exits 0, as does `show-user` for a property other than Linger.
 * Its path, for WFC_LOGINCTL.
 */
export function writeLoginctl(
	dir: string,
	answers: LoginctlAnswers = {},
): string {
	fs.mkdirSync(dir, { recursive: true });
	const bin = path.join(dir, "loginctl");
	fs.writeFileSync(bin, buildScript(path.join(dir, "calls"), answers), {
		mode: 0o755,
	});
	return bin;
}
