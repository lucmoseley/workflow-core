# Comment kinds

A comment in code is refused unless it is one of the seven kinds below (workflow-core#5455). A directive a tool reads is code, not a comment, and is not judged here: a JSDoc type annotation `checkJs` reads, a pragma such as `@vitest-environment`, the hook shim's mark, a `code-edges loads: <path> [<key>]` line in JS, TypeScript or shell and a `code-edges caller: <name>…` line in shell, which the verdict proof's walk reads, and a plugin checker's marker (`full-sweep-only:`, `Unbuilt caller: <path>`) followed by a bare pointer and nothing else.

**Tie rule: where you are unsure whether a comment is its kind, it is not, and the comment dies.**

| Kind | Keep it only when | Its form |
|---|---|---|
| K1 licence | it is a licence or copyright notice | an SPDX or copyright line at the top of the file |
| K2 forced from outside | it states a fact about something outside this repo that the code must obey and cannot reshape: an API's limit, a platform's quirk, a dependency's bug | it names its source: a URL, or a dependency in the manifest, in backticks as the manifest spells it. On a mixed comment the outside fact stays and the choice we built on it is cut |
| K3 suppression | it silences a lint rule that is style-only or faulty | the tool's own suppression naming the rule (`biome-ignore`, `noqa`, `shellcheck disable`). A suppression of a correctness rule is refused: fix the code |
| K4 outside contract | a party outside the repo relies on what it documents: an adopter importing the export, a hook runner, a person at the CLI, a tool reading the output | it sits on that export, entry point or output: a usage block, a hook's input and output, an exported function's behaviour |
| K5 issue or RFC pointer | a reader would otherwise undo the code's shape, and the issue or RFC says why | the bare `#N` or RFC link, with no reasoning beside it. A test pinning the behaviour may cite the same `#N` beside its descriptive title |
| ADR pointer | as K5, for a decision recorded as an ADR | the bare `ADR-NNNN`, resolving to a file in `docs/adr/` |
| Value derivation | a chosen value (a threshold, a size, a timeout) whose origin its name cannot carry | one line on the constant holding the `#N` with the detail and either `measured` and the figure, or `guess` |

A comment's form alone does not make it its kind: a URL that forces nothing is not K2, a doc comment on an export nothing outside the repo uses is not K4, and a `#N` no reader would undo the code without is not K5.

**What these refuse, most often:** what the code does; why our own code is shaped this way; a file header giving what the file is, its why or its ticket; a rejected alternative; a `TODO`; commented-out code.

**What replaces a refused comment:** nothing, or the name, type, test or check that can carry it, with the reasoning on the issue.
