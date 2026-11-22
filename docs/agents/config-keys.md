# Config keys — adopter guide

What `.claude/workflow-core.json` means where a key's type alone does not say. `scripts/lib/workflow-core-config.js` reads the file: `KNOWN_KEYS` lists every name it accepts, and the `Config` typedef types each key `readConfig()` returns.

## How a bad value reads

A missing file reads as `{}`. A file that is not a JSON object, or that declares a `contract` this release does not read, makes `readConfig()` throw: the command reading it stops, `resolveKey` and `requireKey` included. Only the path-key resolvers, `readOutputStylePath()` and `declaresLadder()` catch it and fall back to their defaults.

Anything else that is wrong becomes a warning, printed as `WARN <file>: …` unless the caller reads quietly. Two kinds also land in `faults`, which callers select by key and kind, never by the warning's wording:

- **`malformed`**: a key holding an invalid value, whether the wrong type or a right-typed value its rule refuses. It is read as if absent, so its default applies, and the warning ends `— read as its default`.
- **`unknown-key`**: a top-level name not in `KNOWN_KEYS`, or an unknown field inside `commands`, `overrides`, `retro`, `archScan`, `mods` or a `sensitivePaths` entry.

These warn and carry no fault:

- an unknown name in `modules` or in `WFC_MODULES`, which is dropped;
- a `sensitivePaths` entry with no `name` string, which is dropped;
- a `sensitivePaths` entry repeating another's `name`;
- a `globs` item that is not a non-empty string, which is dropped;
- `mutation` on with no `sensitivePaths` glob, so the mutation hold never fires.

Callers branch on faults, never on a warning's text. A malformed `refillLoop` keeps the checkout out of the refill loop and names the fault as the reason. Either kind of fault on `retro` stops its due report; on `archScan` only a malformed one does. A fault on a key a core-written workflow reads, such as `ci` or `landingTester`, makes upgrade skip that workflow rather than write it from a default.

## Keys read as declared, resolved elsewhere

`readConfig()` returns `tracker`, `codeRepo`, `login`, `name` and `corpus` as the file declares them, `undefined` where it does not. Read the value a command uses through `resolveKey(<key>)`, which derives each missing one:

| Key | Absent, it resolves to |
|---|---|
| `tracker` | the `owner/name` of the checkout's GitHub `origin` remote |
| `codeRepo` | that same `origin` remote, else the declared `tracker` |
| `login` | the login `gh api user` reports |
| `name` | the main checkout's directory name, from a worktree too |
| `corpus` | the own tracker, declared or derived, plus `UPSTREAM_TRACKER` (`lucmoseley/workflow-core-tracker`) |

`founder` is never derived: `requireKey("founder")` throws where it is absent. A `corpus` item not shaped `owner/name` makes the whole list malformed. Where no own tracker resolves, the `corpus` verb warns that the corpus is the upstream tracker alone.

## Switches whose default is not `false`

| Key | Absent | Only this changes it |
|---|---|---|
| `refillLoop` | the refill loop may serve the checkout | `false`, or a malformed value, takes it out |
| `landingTester` | `auto`: the lander picks its tester by run length | `local` or `actions` pins one |

`capacityLadder`, `admissionGate` and `refillPanel` are off until set to `true`. Read the ladder switch through `declaresLadder()`, which is `false` where the key is absent, malformed or the config cannot be read. Reading `capacityLadder` itself sees `undefined` in the first two cases, and `readConfig()` throws in the third.

## `overrides.output_style`

A repo-relative path to the style file, such as `.claude/output-styles/mine.md`, never a bare style name: the value must contain a `/` or `\`, must not be absolute and must not climb out with `..`. A bare name is malformed and reads as `null`. `null` or absent loads `.claude/output-styles/core-voice.md`. The `WFC_OUTPUT_STYLE` environment variable, where set, replaces the key; set empty, it reads as `null`.
