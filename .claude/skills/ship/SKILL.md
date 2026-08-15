---
name: ship
description: Push to production and prove the deployment is live. Runs the sync check and the full suite first, pushes main, then verifies the running deployment answers.
disable-model-invocation: true
---

# Shipping

A push to `main` deploys. There is no staging environment and no preview to look at first, and the users on the other end are real. So the checks come before the push, and the proof comes after it — a successful push is not evidence that anything is running.

This skill is user-invoked only.

## 1 — Look before you push

```bash
git status --short && git log --oneline origin/main..HEAD
```

Report what is uncommitted and what is about to go out. If there is nothing to push, stop and say so. If there are uncommitted changes, ask what to do with them rather than committing them yourself — you do not know whether they were finished.

## 2 — The two checks

```bash
npm run sync:shared -- --check
```

Exits non-zero if any generated copy is stale. Fix it by running `npm run sync:shared` and committing the result, never by editing the copies.

```bash
npm test
```

615 tests, about ten seconds. This is the only thing that checks that the six copies of a behaviour still agree, so a failure here is a failure to ship. A red suite ends the deploy; what needs fixing is the code.

## 3 — Push

```bash
git push origin main
```

An ordinary push of the commits listed in step 1, once both checks above are green.

## 4 — Prove it is live

The deployment takes a moment. Then:

```bash
curl -s --max-time 20 https://panelflow-backend.vercel.app/api/health
```

Expect `{"ok":true,"service":"panelflow-backend"}`. If nothing answers, wait and try once more before reporting a problem — a single timeout is not a failed deployment.

**The URL trap:** production is `panelflow-backend.vercel.app`. The shorter `panelflow.vercel.app` belongs to an unrelated project, so reaching it and getting a 200 proves nothing about PanelFlow. Never use the short name, and do not suggest renaming the Vercel project to claim it — that would break the working URL without freeing the other one.

If the Vercel CLI is installed, confirm the live deployment is the commit just pushed rather than an earlier one:

```bash
vercel ls panelflow-backend
```

If it is not installed, say so and move on; installing it mid-deploy is not the moment.

## 5 — Report

State plainly which commits went out, that both checks passed, and what the health endpoint actually returned. If a step was skipped — no Vercel CLI, a retry needed — say which. "Deployed" without a quoted response is not a report.

## Scope

Shipping is code only. The production database stays as it is: accounts and reading progress are not part of a deploy, and a change that needs a migration is a separate, deliberate act by the user. The Vercel environment variables stay as they are too — the Web Push keys in particular, since every subscription ever handed out is tied to the current public key and would go quiet if it changed.
