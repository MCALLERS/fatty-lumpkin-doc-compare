# Shipping Fatty Lumpkin — first-time setup

Everything below is run once. After that, `git push` updates the site and
pushing a tag builds new installers.

Environment assumed: Windows + PowerShell, GitHub handle **MCALLERS**,
bombadillo-ai.com on Cloudflare.

---

## 1. Put the code on GitHub

Create the repo in the browser: **github.com/new** → name it
`fatty-lumpkin-doc-compare` → **Public** → leave README / .gitignore / licence
**unchecked** → Create.

> **Why public.** GitHub only serves release assets from a public repo without a
> token. The download page links straight to those `.dmg` and `.exe` files, so a
> private repo would mean colleagues could not download anything. There is
> nothing confidential in the source. If you would rather the binaries were not
> public, the alternative is Cloudflare R2 — say the word and I'll wire it up.

Then, from the project folder:

```powershell
cd <project-folder>
git init -b main
git add -A
git commit -m "Fatty Lumpkin Doc Compare 1.0.0"
git remote add origin https://github.com/MCALLERS/fatty-lumpkin-doc-compare.git
git push -u origin main
```

A browser window pops up for GitHub sign-in on the first push — approve it,
never type credentials into the terminal. Success looks like
`branch 'main' set up to track 'origin/main'`.

## 2. Build the installers

```powershell
git tag v1.0.0
git push --tags
```

Watch **Actions** in the repo. Two jobs run (macOS and Windows, ~5 minutes), then
a **Release** appears with three files:

| Platform | File |
|---|---|
| macOS, Apple Silicon | `Fatty-Lumpkin-Doc-Compare-1.0.0-arm64.dmg` |
| macOS, Intel | `Fatty-Lumpkin-Doc-Compare-1.0.0-x64.dmg` |
| Windows 10 / 11 | `Fatty-Lumpkin-Doc-Compare-Setup-1.0.0.exe` |

Those exact names are what the download page links to. Don't rename them.

## 3. Create the Cloudflare Pages site

dash.cloudflare.com → **Workers & Pages → Create → Pages → Connect to Git** →
authorise GitHub with **Only select repositories** → pick the repo →
**Begin setup**:

| Setting | Value |
|---|---|
| Project name | `fatty-lumpkin` (becomes `fatty-lumpkin.pages.dev`) |
| Production branch | `main` |
| Framework preset | **None** |
| Build command | *(leave empty)* |
| Build output directory | **`site`** ← the one field that matters |

**Save and Deploy** (~1 minute).

## 4. Turn on the password gate

The gate is already in the repo (`functions/_middleware.js`) and **fails closed**:
until you set the variables the site returns *503 — access password has not been
configured*. That is correct, not a bug.

Pages project → **Settings → Environment variables** → add under **both**
Production and Preview:

| Variable | Value |
|---|---|
| `FATTY_USER` | e.g. `bombadil` |
| `FATTY_PASSWORD` | whatever you'll share with colleagues |

Then **Deployments → Retry deployment** — environment variables only take effect
on a new deploy.

Verify: opening `fatty-lumpkin.pages.dev` should prompt for the username and
password.

> Note: the gate protects the *page*. The installers themselves live on GitHub
> Releases and are publicly downloadable by anyone who has the direct link.

## 5. Attach the domain

Pages project → **Custom domains → Set up a custom domain** →
`redline.bombadillo-ai.com` → Activate. DNS and the certificate are automatic
because the domain is already on Cloudflare; it goes Active in a few minutes.

The app's Help menu and the release notes already point at
`https://redline.bombadillo-ai.com`.

## 6. Install it yourself

Download from your own page and follow the on-screen instructions — Windows
SmartScreen: **More info → Run anyway**; macOS: **System Settings → Privacy &
Security → Open Anyway**. The right-click menu installs itself on first launch.

---

## Every update after that

```powershell
cd <repo-root>          # ROOT, not a subfolder
git add -A
git commit -m "what changed"
git push
```

Cloudflare redeploys the page automatically — hard-refresh with
**Ctrl+Shift+R**, browsers cache aggressively.

For a new app version, also bump `app/package.json` and the version strings in
`site/index.html` and `site/app.js`, then push a new tag.

## Troubleshooting

- **Site doesn't show the change** — run `git status` from the repo *root*. If a
  file shows modified-unstaged, the commit was made from a subfolder; always
  `git add -A` from the root. Then check Cloudflare's Deployments tab (latest =
  your commit, Success) and hard-refresh.
- **503 "password not configured"** — the environment variables are missing or
  you haven't redeployed since adding them.
- **Env var change not taking effect** — Retry deployment.
- **Actions build fails on `npm ci`** — `app/package-lock.json` must be
  committed. It is; if it goes missing, run `npm install` in `app/` and commit.
- **Colleague says Windows blocked the .exe** — some managed fleets refuse
  unsigned executables outright. That needs a code-signing certificate, not a
  workaround. Their IT desk can allow the specific file in the meantime.
