# Config keys — adopter guide

What `.claude/workflow-core.json` means where a key's type alone does not say. `scripts/lib/workflow-core-config.js` reads the file. Its `ConfigBase` typedef lists every key and its type, and `KNOWN_KEYS` lists the names it accepts.

## How a bad value reads

A missing file reads as `{}`. A file that is not a JSON object, or that declares a `contract` this release does not read, throws, and the command reading it stops.

Anything else that is wrong becomes a warning, printed once as `WARN <file>: …`. Two kinds also land in `faults`, which callers select by key and kind, never by the warning's wording:

- **`malformed`**: a key holding the wrong type. It is read as if absent, so its default applies, and the warning ends `— read as its default`.
- **`unknown-key`**: a top-level name not in `KNOWN_KEYS`, or an unknown field inside `commands`, `overrides`, `retro`, `archScan`, `mods` or a `sensitivePaths` entry.

These warn and carry no fault:

- an unknown name in `modules` or in `WFC_MODULES`;
- a `sensitivePaths` entry with no `name` string, which is dropped;
- a `sensitivePaths` entry repeating another's `name`;
- a `globs` item that is not a non-empty string, which is dropped;
- `mutation` on with no `sensitivePaths` glob, so the mutation hold never fires;
- no own tracker resolving, so `corpus` is the upstream tracker alone.

A fault can change what runs, as a warning alone never does. A malformed `refillLoop` keeps the checkout out of the refill loop and names the fault as the reason. A fault on `retro` or `archScan` stops its due report, naming the fault. A fault on a key a core-written workflow reads, such as `ci` or `landingTester`, makes upgrade skip that workflow rather than write it from a default.

## Keys read as declared, resolved elsewhere

`readConfig()` returns `tracker`, `codeRepo`, `login`, `name` and `corpus` as the file declares them, `undefined` where it does not. Read the value a command uses through `resolveKey(<key>)`, which derives each missing one:

| Key | Absent, it resolves to |
|---|---|
| `tracker` | the `owner/name` of the checkout's GitHub `origin` remote |
| `codeRepo` | that same `origin` remote, else the declared `tracker` |
| `login` | the login `gh api user` reports |
| `name` | the checkout directory's name |
| `corpus` | the own tracker, declared or derived, plus `lucmoseley/workflow-core-tracker` |

`founder` is never derived: `requireKey("founder")` throws where it is absent. A `corpus` item not shaped `owner/name` makes the whole list malformed.

## Switches whose default is not `false`

| Key | Absent | Only this changes it |
|---|---|---|
| `refillLoop` | the refill loop may serve the checkout | `false` takes it out |
| `landingTester` | `auto`: the lander picks its tester by run length | `local` or `actions` pins one |

`capacityLadder`, `admissionGate` and `refillPanel` are off until set to `true`. Read the ladder switch through `declaresLadder()`, which is `false` where the key is absent, malformed or the config cannot be read; reading `capacityLadder` itself sees `undefined` in all three cases.

## `overrides.output_style`

A repo-relative path to the style file, such as `.claude/output-styles/mine.md`, never a bare style name: the value must contain a `/` or `\`, must not be absolute and must not climb out with `..`. A bare name is malformed and reads as `null`. `null` or absent loads `.claude/output-styles/core-voice.md`. The `WFC_OUTPUT_STYLE` environment variable, where set, replaces the key; set empty, it reads as `null`.
