# Deliverable contract — Fatty Lumpkin Doc Compare

## The product
A desktop app (Electron, macOS + Windows) that redlines two Word documents.
The user selects two `.docx` files in Finder / File Explorer, right-clicks, and
picks "Redline with Fatty Lumpkin" → Word (track changes), PDF, or both. The app
opens, asks the single question "which one is the older version?", produces the
output next to the newer file, opens it, and shows a short Tom Bombadil quote as
a small reward.

## Audience
Lawyers, paralegals, contract managers and business professionals. Not technical.
They compare documents many times a day and resent every extra click. They are
often on a locked-down corporate Windows machine; some are on a Mac. Litera
Compare and Word's own Compare are the incumbents — the whole reason this exists
is that both are fiddly.

## Non-negotiables
1. **One obvious next action per screen.** Never make the user read to work out
   what to do.
2. **Word-level redlining.** Additions blue underline, deletions red strikethrough
   in the PDF; native `w:ins`/`w:del` revisions in the Word output.
3. **Nothing leaves the machine.** No network calls, no telemetry, no accounts.
4. **Honest, human error messages.** Never a stack trace or an error code as the
   headline. Say what happened and what to do next.
5. **Keyboard and screen-reader usable.** Every control reachable and operable;
   visible focus; no keyboard traps.
6. **Light and dark.** The app follows the OS colour scheme; both must be first
   class, not an afterthought.

## Brand
Warm parchment and ink, with a storybook mascot — Fatty Lumpkin, Tom Bombadil's
plump pony. Professional restraint in the working screens; the charm is
concentrated in the mascot and the reward quote. Tokens:

| token | light | dark |
|---|---|---|
| paper | `#FBF7EE` | `#15141A` |
| surface | `#FFFFFF` | `#22212A` |
| ink | `#1C1A15` | `#F1ECE2` |
| primary (navy) | `#22406F` | `#93B4E8` |
| accent (gold) | `#A97A1E` | `#DDB362` |
| insertion | `#12489E` | `#7FADF5` |
| deletion | `#A81F13` | `#F09083` |

Typeface: system UI sans for interface, an old-style serif for the quote and for
the PDF body. Radii 8/14/20-22px. Spacing on a 4px grid.

## Deliverables under review
1. **App UI** — `app/src/renderer/` — screens: drop, picker, working, done, error,
   settings sheet. Evidence in `qa/shots/`.
2. **Download page** — `site/` — hosted at redline.bombadillo-ai.com behind a
   password gate. Evidence in `qa/site-shots/`.
3. **PDF redline output** — produced by `app/src/engine/emit-html.js` +
   `pdf-template.js`. Evidence in `qa/out/`.

## Data that must be exactly right
The change counts on screen and in the PDF header come from the engine
(`countChanges` in `app/src/engine/compare.js`). Words added / words deleted /
passages changed must be reproducible from the fixture pair
`fixtures/MSA_v1.docx` → `fixtures/MSA_v2.docx`, whose real diff is:
date changed, "executed by the parties" extended, "generally accepted" inserted,
thirty(30)→forty-five(45), a new interest clause, twelve(12)→twenty-four(24),
a cure-period proviso, a deleted termination-for-convenience clause,
$18,000→$22,000, a Training row replaced by an Advisory row, New York→Delaware,
and a new section 7 (Notices).
