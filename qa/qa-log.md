# QA log — Fatty Lumpkin Doc Compare

Built with the `aaa-critic-loop` method: builders never grade their own work.
Each round captured fresh evidence programmatically, then independent critic
agents scored it against `qa/contract.md` and the skill's rubric. Critics were
given the contract and the evidence only — never a description of what had been
changed — so every round is a genuine re-review.

Evidence is regenerated with:

```
node qa/shoot-app.mjs      # 10 app screens x 4 window sizes x 2 colour schemes,
                           # console capture, tab-order walk, focus probe
node qa/shoot-site.mjs     # download page, 4 viewports, 2 schemes, link + overflow checks
node qa/render-pdf.mjs     # the redline PDF exactly as Electron prints it
node qa/probe-edge.mjs     # engine behaviour on the edge-case fixture set
cd app && npm test         # 42 assertions
```

---

## Round 1

| Axis | Score | Verdict |
|---|---|---|
| Visual — app | 4/10 | NO |
| UX — app | 5/10 | NO |
| Programmatic / a11y / security — app | 4/10 | NO |
| Visual + conversion — download page | 4/10 | NO |
| Redline correctness — output | 5/10 | NO |

### What the critics found, and what changed

**Correctness**

- `guessOlder` compared ISO date **strings** with `+`, which is `NaN`, so the
  timestamp tie-break never ran and the "probably older" badge always pointed at
  the second file. A lawyer following it would have produced a **reversed
  redline**. → `Date.parse`, plus a regression test.
- Changes living only in a **footnote, header or footer** were invisible, and the
  PDF then printed "these two documents are identical". → those parts are now
  loaded, compared, marked up in the `.docx`, and rendered as labelled sections
  in the PDF.
- Deleted list items were numbered by *how many deletions preceded them* rather
  than by their position in the original. → a single old-side counter, and struck
  numbers are bracketed so they cannot be read as live ones.
- Table cell text was concatenated without separators, so `Training` + `$1,200`
  became one token and the word counts were wrong. → separator added.
- A one-word edit in a short paragraph scored 0 on bigram similarity and was
  emitted as a whole paragraph struck and retyped — the exact thing the
  house redlining standard forbids. → token-overlap fallback.
- A paragraph split in two (or two merged) was emitted as identical text deleted
  and re-inserted. → both are now recorded as changes to the paragraph *mark*,
  including the whitespace at the join, so accept and reject are both exact.
- Pre-existing tracked changes were "accepted" without merging deleted paragraph
  marks, manufacturing phantom differences. → real merge.
- `esc()` did not escape quotes but its output landed in attribute position — a
  hostile `.docx` could inject attributes into the printed HTML. → fixed;
  round 2 attacked it with eleven payloads and got nothing.

**App**

- The toast's centring transform was destroyed by its own animation.
- No `color-scheme` declaration, so native controls stayed light inside the dark
  theme; the *unchecked* checkbox was the brightest object in the dialog.
- Fourteen light-mode and thirteen dark-mode token pairs failed WCAG contrast.
- `role="radiogroup"` with none of the role's keyboard contract implemented.
- `user-select:none` on `<body>` made filenames, paths and error text
  uncopyable — while the app shipped an Edit ▸ Copy menu item.
- Live regions were written while hidden, which guarantees silence.
- `sandbox:false`, and `file:open` handed `shell.openPath` an unvalidated string.
- Dropping a second document threw the first one away, so the "waiting for one
  more document" state was a dead end.
- Windows `MultiSelectModel=Player` contradicted the `"%1"` command; the macOS
  Quick Action declared "as arguments" but read stdin.

**Page**

- The hero screenshot showed invented change counts that the PDF screenshot two
  sections below contradicted. → the QA harness now injects **real engine
  output** into the mock, so every number in every screenshot reconciles.

---

## Round 2

| Axis | Score | Verdict |
|---|---|---|
| Visual — app | 5/10 | NO |
| UX — app | 6/10 | "would a busy lawyer use it twice? **YES**" |
| Programmatic / a11y / security — app | 5/10 | NO |
| Visual + conversion — download page | 5/10 | NO |
| Redline correctness — output | 4/10 | NO |

Round 2 confirmed the round-1 repairs (attack-tested escaping, survivable
settings corruption, correct dialog keyboard mechanics, a CI pipeline whose
artifact names match the download links exactly) and then found deeper faults.

### Criticals fixed

- **Cancel cancelled nothing.** It hid the screen; the run finished, wrote both
  files into the deal folder and launched Word. → a real `compare:cancel`
  channel, checked before every write and before opening anything, and the print
  window is destroyed on abort.
- **On macOS, closing the window killed the right-click menu.** `second-instance`
  and `open-file` both bailed when `win` was null and nothing recreated it. → a
  `surface()` helper recreates the window.
- **The "Saved N days earlier" badge could be false**, because the guess came
  from the filename while the badge came from an absolute date difference — it
  could sit directly above a line saying the file was saved today. → the engine
  now returns *why* it guessed, and the badge either states a real signed
  difference ("saved 4 hours earlier") or says "looks like the earlier draft".
- **A change only in a picture, or only in bold, was reported as identical.** →
  paragraph keys now carry a formatting signature and a fingerprint of the actual
  image bytes; a formatting-only change emits `w:rPrChange`, which Word shows as
  "Formatted:" and can reject.
- **A deleted image vanished** rather than being marked. → `[image removed]`
  inside the deletion.
- **A deleted table column produced no revision marks at all** while the header
  counted its words. → `cellDelete` branch added.
- **Rejecting a paragraph merge left a stray space, and deleting the last
  paragraph left an empty one** — both invisible to the test suite, because the
  round-trip assertion normalised whitespace and dropped empty paragraphs. → both
  fixed, and the assertion tightened so it can never hide them again.
- **The download page's FAQ was misaligned 140px from its own heading**, the
  mobile fold buried the CTA behind an illegible screenshot, the one shell
  command a stuck Mac user must copy was silently clipped, and Intel Macs were
  served the Apple Silicon build by a WebGL probe that fails on Firefox, on
  Safari, and with hardware acceleration off. → all fixed; the page no longer
  guesses Mac architecture at all.

### Also fixed

Subgrid alignment across the two document cards · sticky action row so the
primary action is never below the fold at the minimum window size · a real
modal scrim in dark mode · custom checkboxes · 44px hit areas · window
recreation · atomic settings writes with an honest "this didn't save" toast ·
tracked-change author is now a setting defaulting to the OS user name · digit
shortcuts no longer fire from inside another control or with a modifier held ·
CJK text diffs per character instead of per sentence · right-to-left paragraphs
keep their direction · change bars now appear in the page margin for a change
buried inside a table cell · table headers repeat across page breaks · page
weight cut from 1.6 MB to ~250 KB on first load · styled 401 and 503 pages.

### Open, and deliberate

| Item | Why it stands |
|---|---|
| Installers are unsigned | Certificates cost money and are the user's call. The page and the release notes say so plainly and give exact instructions; `DEPLOY.md` explains what signing would take. |
| Moves shown as delete + insert | OOXML has `w:moveFrom`/`w:moveTo`; the brief explicitly said moves are not needed, and delete+insert is what most readers prefer. Documented in the README. |
| A compressed type scale (13/15/17/21/28) | The rubric asks for ≥1.25 steps, which suits a web page. Native desktop interfaces run 11/13/15; matching Segoe UI and SF Pro conventions matters more here than the ratio. The number of sizes actually in play was reduced instead. |
| A solid dropzone border rather than dashed | CSS redistributes a dash array per edge, so a wide short box renders long dashes horizontally and short ones vertically. The drop affordance is carried by the copy and by the drag state. |
| Hyperlinks inside deleted paragraphs lose their target | The relationship lives in the other package. Text is preserved; the link is not. |

---

## Standing invariant

The strongest correctness guarantee the product has, asserted over eleven
document pairs on every test run, with no whitespace normalisation and no
dropped empty paragraphs:

> Accepting every tracked change reproduces the revised document exactly.
> Rejecting every tracked change reproduces the original exactly.

42 assertions, `cd app && npm test`.
