# SEO OS — P4_MANUAL_VERIFICATION.md

**Phase:** P4 — Content System + Controlled WordPress Execution
**Scope of this checklist:** M5, the QA gate. Publishing and CMS execution are
not built and must still read as **Coming next**.

Run this against a deployed build after `main` is deployed on Railway and the
demo seeds have been run. It takes under ten minutes. Sixteen steps; each one
either matches or it does not.

Nothing in this checklist publishes anything.

---

## A. Sign in

Open the public app URL and sign in with Google.

- [ ] Sign-in completes and lands inside the app, not back on `/login`.

## B. Open the demo workspace

Choose the Investor Demo workspace and its demo website.

- [ ] The website is marked **DEMO DATA**.
- [ ] The real workspace (The Creative SEO → SEO Team → thecreativeseo.com) shows
      no content work, no QA runs, and no approvals.

## C. Command Center

- [ ] Three QA tiles are present: **QA blockers**, **Awaiting final approval**,
      **Approved for CMS**.
- [ ] Their counts are 1, 1 and 1 on the seeded demo.
- [ ] A **Next in QA** line names the blocked piece.
- [ ] Nothing anywhere says published.

## D. QA blockers

Click the **QA blockers** tile.

- [ ] The QA queue opens filtered to blocked work.
- [ ] The row reads **QA blocked**, outcome **Failed**, blocking count 1.

## E. Open the blocked report

- [ ] The header names the exact revision number and a short hash.
- [ ] **Brand facts** reads **Failed**.

## F. Inspect the blocking finding

- [ ] The finding is labelled **Blocking** and **Measured**.
- [ ] It explains that the fact behind the claim is no longer approved.
- [ ] It says what to do next.
- [ ] **Approve for CMS** is not offered; the reason given is the blocking finding.

## G. Open the item awaiting final approval

Go back to the queue and open the row that reads **Awaiting final approval**.

- [ ] The header shows the revision, the hash, the brief version and **Current**.
- [ ] All ten checks are listed, each with an outcome and a **Found by** label.

## H. Inspect a passing report

- [ ] Overall outcome reads **Passed with warnings**.
- [ ] Blocking count is 0.
- [ ] At least one warning is listed with what to do about it.

## I. Inspect an AI-assisted finding

On the refresh story's report (**Approved for CMS**), or any report with a
judged finding:

- [ ] The finding is labelled **AI judged**.
- [ ] Its severity is **Warning** or **For information**, never Blocking.
- [ ] Where it quotes the piece, the quoted words appear in the revision.

## J. Inspect what was not checked

- [ ] A **Not checked** section lists at least one check.
- [ ] It gives a reason and says whether it is missing evidence or a capability
      that is unavailable.
- [ ] It does not read as a pass.

## K. Approve for CMS

On the item awaiting final approval:

- [ ] The form lists the revision, hash, QA run, outcome and counts.
- [ ] It requires the acknowledgement of the checks that did not run.
- [ ] Approving succeeds and the work reads **Approved for CMS**.

## L. Verify what was approved

- [ ] The approval panel shows the exact revision number and short hash.
- [ ] It names the approver and the time.
- [ ] Where the approver also wrote or editorially approved the piece, it reads
      **Self-approval recorded**.

## M. Verify nothing was published

- [ ] The approval panel says no CMS action has been performed.
- [ ] Nothing on the page says published, live, or on WordPress.

## N. The stale story

On the piece that is approved for CMS, change one approved Brand Fact or one
active SEO Rule on this website (any edit will do).

- [ ] The approval still reads **Approved for CMS**.
- [ ] It also reads **QA is now stale**, with the reason.
- [ ] It says a fresh QA run and a fresh approval are needed before execution.
- [ ] The QA queue shows the same for that row.

## O. Return for revision, and the history

On any item at the gate:

- [ ] **Return for revision** requires a reason and confirms first.
- [ ] After returning, the work is back in drafting.
- [ ] The approval is listed as invalidated, with the reason, and is still readable.
- [ ] Every QA run for the work is still listed and can be opened read-only.

## P. Publishing

- [ ] Execution → **Publishing** still reads **Coming next** and is not clickable.
- [ ] No screen offers to publish, push, or create a CMS draft.

---

## If a step does not match

Note the step letter and what you saw instead. Nothing in this checklist
changes content: every step is a read, an approval, or a return, and each of
those is recorded and reversible through the product.
