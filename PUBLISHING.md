# Publishing

This package publishes to npm through GitHub Actions using npm trusted publishing
(OIDC). There is no `NPM_TOKEN` and no long-lived secret anywhere. Once the
one-time setup below is done, releases publish automatically with provenance.

- CI workflow: `.github/workflows/ci.yml` (job name `verify`)
- Release workflow: `.github/workflows/release.yml` (job name `publish`)
- GitHub Actions environment: **`npm-publish`**
- npm package: `library-reads` (unscoped, public)

## How a normal release works (after setup)

1. Bump the version in `package.json` (for example `0.1.0` to `0.1.1`) and add a
   matching section to `CHANGELOG.md`.
2. Commit and push to `main` (CI runs and must be green).
3. Create a GitHub Release for the matching tag (for example `v0.1.1`), with notes
   copied from the CHANGELOG entry.
4. The release workflow re-runs typecheck, test, and build, then publishes to npm
   over OIDC with provenance. No token is involved.

## One-time setup (human-only steps)

These cannot be automated from the repository: the trusted-publisher link lives in
the npmjs.com web UI, and the package must already exist on npm before the link can
be configured.

### Step a. First publish from your machine (local, once)

The package must exist on npm before a trusted publisher can be attached. Publish
the first version locally:

```sh
npm login
pnpm build
npm publish --access public
```

This first publish is done from your machine, so it will not carry CI provenance.
That is expected and fine for the bootstrap; every later release (published by the
workflow) will have provenance.

### Step b. Add the Trusted Publisher on npmjs.com (web UI, once)

Go to the package page on npmjs.com:
`https://www.npmjs.com/package/library-reads` then Settings, and under
"Trusted Publisher" add a GitHub Actions publisher with these values, which must
match the workflow EXACTLY (a mismatch makes publishes fail with a 404):

- Provider: GitHub Actions
- Organization or user: `anthony-liddle`
- Repository: `library-reads`
- Workflow filename: `release.yml`
- Environment: `npm-publish`

Then, under "Allowed actions" (at least one must be selected), check
"Allow npm publish" and leave "Allow npm stage publish" unchecked, since the
release workflow runs a plain `pnpm publish` (a standard, non-staged publish)
rather than the staged two-step flow. Finally, click "Set up connection".

The separate "Publishing access" section on the same page (the two-factor
authentication options) does not need changing: npm notes that trusted publishers
keep working regardless of which option is selected there.

### Step c. Enable branch protection on `main` (GitHub, once, after CI is green)

After the CI workflow has run at least once on `main` so the check is registered,
optionally protect `main`. As a solo maintainer, configure it so you do not lock
yourself out:

In Settings, Branches, add a rule for `main`:

- Require a pull request before merging: ON.
- Require approvals: set to **0** (do not require approvals; you cannot approve your
  own pull requests).
- Require status checks to pass before merging: ON, and select the **`verify`**
  check.
- Require branches to be up to date before merging: optional.
- Do NOT enable "Do not allow bypassing the above settings" / "Include
  administrators", so you can still merge your own pull requests.

This gives you a required green CI gate without a second reviewer and without a
deadlock.

### Step d. From then on

Releases are automatic: bump the version, push to `main`, create a GitHub Release,
and the workflow publishes with provenance and no token. You only repeat steps a
through c if you move the repo, rename the workflow, or change the environment name.
