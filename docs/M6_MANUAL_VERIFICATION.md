# M6 — manual browser verification

What a person should check in a browser after deploying M6.4. The automated
suite covers the logic with an injected transport; this covers the parts only a
person looking at a screen can confirm — that the words say what is true, that
the secret never appears, and that there is nowhere to publish from.

**Status: MANUAL BROWSER VERIFICATION — NOT PERFORMED.** This environment has no
browser session against a deployed instance. The checklist below is written to
be executed by a person.

**Real WordPress:** use a disposable site. Never a customer's production
WordPress. The simulated provider on a demo website covers the whole flow
without any WordPress at all.

---

## 1. Connections — configuring WordPress

Go to **Data Sources** (`/websites/<id>/connections`) as an **owner or admin**.

- [ ] The WordPress card reads **Available**, with purpose "Content drafts for
      review" — not "publishing".
- [ ] It shows Authentication **Application Password**, Publishing mode
      **DRAFT ONLY**, and the sentence that SEO OS creates a draft for review,
      does not publish, does not change an existing page, and does not write
      Yoast/Rank Math fields.
- [ ] Before configuring: Site "Not configured", Credentials "Not configured",
      all three permissions **Unknown — not checked yet**.

### The secret

- [ ] The application password field is a password field (characters masked).
- [ ] Save a connection, then reload the page. The password field is **empty**,
      with placeholder "Stored — enter a new one to replace it".
- [ ] View source / DevTools → search the page HTML for the password you typed.
      **It must not appear.** Check the React server-component payload too
      (search for the string anywhere in the document).
- [ ] The username field is also empty after saving — it is stored encrypted
      alongside the password and is never read back.
- [ ] Enter a wrong password and save. The error does not echo what you typed.

### The address

- [ ] `http://…` is refused.
- [ ] `https://example.com/wp-json/wp/v2` is refused — it is a REST endpoint,
      not a site address.
- [ ] `https://localhost`, `https://127.0.0.1`, `https://169.254.169.254` are
      refused.
- [ ] A subdirectory install such as `https://example.com/blog` is accepted.

### Testing

- [ ] After saving, the card shows the connection is not yet connected and
      offers **Test connection**.
- [ ] Press it. On success the status becomes **CONNECTED**, the account name
      appears, "Last tested" fills in, and the three permissions show what
      WordPress actually reported.
- [ ] Nothing was created in WordPress by the test — check the site's Posts and
      Pages lists; there must be no new draft.
- [ ] With an account that cannot create posts, "Create draft — post" reads
      **Not granted** and the CMS Drafts screen refuses to offer that target.
- [ ] Break the password and test again: the status becomes **ERROR** with a
      plain sentence, and no raw WordPress JSON is shown.

### Permission

- [ ] As an **SEO lead**, the WordPress card shows the configuration but says an
      owner or admin configures it — no form.
- [ ] As a **member** or **viewer**, likewise no form.

---

## 2. CMS Drafts — the execution workspace

Go to **Execution → CMS Drafts** (`/websites/<id>/cms-drafts`).

- [ ] The nav shows **CMS Drafts** between QA and Publishing, and **Publishing**
      is still greyed with "Coming next" and is not a link.
- [ ] The page header says SEO OS creates drafts for review and does not publish.

### Ready to create

- [ ] A work item approved at the QA gate appears with state **Ready to create**
      and the sentence "Approved for the CMS. Nothing has been sent to WordPress
      yet."
- [ ] It shows who approved it, the approved revision number and short hash.
- [ ] **Create WordPress Draft** is offered only when the connection is ready.

### The confirmation

- [ ] Pressing Create opens a confirmation that names the site and says
      "This will create a new **draft** in WordPress… **SEO OS will not publish
      it.**"
- [ ] There is a **Cancel**, and the confirm button says "Create WordPress
      Draft" — not "OK".
- [ ] If both post and page are permitted, a target selector appears; if only
      one is, it is stated rather than offered as a choice.
- [ ] Cancel closes it and nothing is sent.

### After creating

- [ ] State becomes **Verified**, with the WordPress id, the target, the site,
      and each check listed: Draft status, Title, Content, Excerpt, and Slug
      marked **advisory**.
- [ ] The row says "SEO plugin metadata: not written in this version".
- [ ] In WordPress: exactly **one** new draft exists, with status Draft. It is
      not published and not scheduled.
- [ ] Press Create again (reload first). It does **not** create a second draft —
      the row now offers Re-verify instead.

### Verification failed

- [ ] Edit the draft's body in WordPress, then press **Re-verify**.
- [ ] The state becomes **Verification failed**, the Content check reads Fail
      with a difference kind, and the WordPress id is still shown.
- [ ] WordPress was **not** changed back — SEO OS does not overwrite it.
- [ ] The approved revision in SEO OS is unchanged.
- [ ] Change only the slug in WordPress and re-verify: the row stays
      **Verified**, with the slug noted as advisory.

### Reconciliation

To produce an uncertain attempt, stop the app mid-create or point the connection
at a site that accepts the request and then fails — otherwise use the simulated
provider on a demo website.

- [ ] The row reads **Reconciliation required** and offers **Reconcile**, not
      Create.
- [ ] The Reconcile control says it will search WordPress and will not create
      another draft.
- [ ] With exactly one matching draft: it is attached and then verified, and the
      result says the draft was found and verified.
- [ ] With no matching draft: the result says none was found and that creating
      one may be attempted again — and **nothing is created automatically**. A
      person must press Create again.

### Roles

- [ ] As a **member** or **viewer**, the page still lists the work and its state,
      and says "You can view this execution, but you do not have permission to
      create or reconcile CMS drafts." No action controls appear.

---

## 3. Elsewhere

- [ ] **Command Center** shows four CMS tiles — ready to create, needs
      reconciliation, verification failed, verified — each linking to CMS Drafts,
      and a line saying SEO OS does not publish.
- [ ] The **QA report** for an approved work item links to CMS Drafts and says
      that creating the draft is a separate, explicit act.

---

## 4. Demo

On a **demo** website with a simulated connection:

- [ ] Executions are marked **DEMO EXECUTION**.
- [ ] Nothing implies a real WordPress was contacted.
- [ ] On a non-demo website, a simulated connection refuses to run at all.

---

## 5. Safety sweep

- [ ] There is no Publish button anywhere in the product.
- [ ] There is no schedule, update-live, or delete-CMS-content control.
- [ ] There is no control to change the publishing mode away from DRAFT ONLY.
- [ ] No screen shows a stack trace, a Prisma error, raw WordPress JSON, or an
      Authorization header.
