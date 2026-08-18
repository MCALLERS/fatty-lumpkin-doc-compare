# Fatty Lumpkin Doc Compare

Redline two Word documents in one right-click. A small desktop app for macOS and
Windows that produces a real track-changes `.docx`, a marked-up PDF, or both —
entirely on your own machine, with no account, no server and no network calls.

```
Select two .docx files  →  right-click  →  Redline with Fatty Lumpkin
        →  "which one is the older version?"  →  done
```

---

## What's in here

```
app/                     the desktop application
  src/engine/            the comparison engine — plain Node, no Electron
  src/main/              Electron main process (windows, IPC, file output, PDF)
  src/renderer/          the interface
  src/shell/             right-click menu installers (registry / Quick Actions)
  src/shared/            Tom Bombadil quotes
  test/                  42 assertions, run with `npm test`
  build/                 app icon
site/                    the download page (Cloudflare Pages build output)
functions/_middleware.js the password gate for that page
fixtures/                .docx pairs the tests and QA screenshots run against
qa/                      contract, screenshot capture, QA log
.github/workflows/       builds the Mac and Windows installers on a tag
```

## Running it locally

```bash
cd app
npm install
npm start          # launch the app
npm test           # 42 engine assertions (no Electron needed)
npm run smoke      # launches the real app and checks the files it writes
```

Regenerate the test documents with `python3 fixtures/make_fixtures.py` and
`python3 fixtures/make_edge_fixtures.py` (needs `python-docx`).

## How the comparison works

1. **Load and settle.** Both documents are unzipped and any tracked changes they
   already carry are accepted, so the comparison is final-text against
   final-text. A deleted paragraph mark really merges its paragraphs.
2. **Align blocks.** Paragraphs and tables are aligned with a patience diff on
   normalised text. Blocks that fall out unmatched are then paired by bigram
   similarity, with a token-overlap fallback so a one-word edit in a five-word
   line is still recognised as an edit rather than a replacement.
3. **Detect splits and merges.** One paragraph that became several (or the
   reverse) is recorded as a change to the paragraph *mark*, never as text
   deleted and re-typed.
4. **Diff words.** Myers over word / whitespace / punctuation tokens, then a
   tidy-up pass so a replacement always reads as one struck span followed by one
   inserted span.
5. **Emit.**
   - `.docx`: real `w:ins` / `w:del` revisions written into the new document,
     including its footnotes, endnotes, headers and footers.
   - PDF: a print stylesheet rendered by Chromium — blue underline for
     additions, red strikethrough for deletions, change bars in the margin,
     repeating table headers, and a header band with the counts.

The strongest guarantee, asserted by the test suite over eleven document pairs:
**accepting every tracked change reproduces the revised document exactly, and
rejecting every change reproduces the original.**

### Known limits

- Moves are shown as a deletion plus an insertion, not as a move.
- Old binary `.doc` files are not supported (the app says so and tells you what
  to do).
- A picture inside a deleted paragraph is marked `[image removed]` rather than
  carried across, because its relationship lives in the other package.
- A hyperlink inside a deleted paragraph keeps its text but loses its target.
- Parts that exist in only one document (an extra header, say) are counted and
  named in the PDF, never silently ignored.

## Shipping a new version

1. Bump `version` in `app/package.json` and the three version strings in
   `site/index.html` / `site/app.js`.
2. Commit, tag, push:
   ```bash
   git add -A && git commit -m "v1.0.1" && git tag v1.0.1 && git push && git push --tags
   ```
3. The workflow builds `.dmg` (arm64 + x64) and `.exe` and attaches them to a
   GitHub release. The download page links to
   `/releases/latest/download/<file>`, so those links never need editing.

See `DEPLOY.md` for the first-time GitHub and Cloudflare setup.

## Quality process

Built with the `aaa-critic-loop` method: a written contract (`qa/contract.md`),
evidence captured programmatically (`qa/shoot-app.mjs`, `qa/shoot-site.mjs`,
`qa/render-pdf.mjs`), and independent critic agents scoring visual design, UX,
accessibility/security and redline correctness against a fixed rubric. Every
round and every finding is recorded in `qa/qa-log.md`.

## Credits

Fatty Lumpkin is Tom Bombadil's pony in J.R.R. Tolkien's *The Lord of the Rings*.
The quotations shown after a successful redline are brief and credited.
