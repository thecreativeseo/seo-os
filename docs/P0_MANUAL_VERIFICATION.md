# P0 — Manual Verification Checklist

Automated tests cover 229 unit and integration cases plus 27 end-to-end cases. What
they cannot cover is anything behind Google sign-in: OAuth needs a real consent
screen, and the alternative — minting sessions with the Supabase service-role key —
would mean wiring a credential into the application that no application code needs.

This checklist is the authenticated half. Run it against `npm run dev` before a
demo, or after any change to authentication, onboarding, or the context lifecycle.

Roughly ten minutes.

---

## 1. Authentication

- [ ] `/` while signed out lands on `/login`
- [ ] **Continue with Google** opens Google's consent screen
- [ ] Completing sign-in returns to the app, not to an error page
- [ ] The sidebar shows your email and role
- [ ] Signing out returns to `/login`
- [ ] Pressing Back after signing out does **not** show a protected page
- [ ] Signing in a second time does not create a second account
      (Team page still lists one member)

## 2. Onboarding — first run

Use a throwaway domain such as `checklist-demo.example.com`, not a real one.

- [ ] A new organization can be created, and you become OWNER
- [ ] Step 1 asks for the website domain
- [ ] Typing `https://www.Example.com/` previews `example.com`
- [ ] **Save & continue** advances to step 2
- [ ] The step rail marks completed steps and links back to them
- [ ] **Back** returns to the previous step with answers intact

## 3. Onboarding — persistence

- [ ] Type into a step, wait a second, and the header shows *Saved*
- [ ] Reload the page mid-step: typed text is still there
- [ ] Close the tab, reopen `/onboarding`: it resumes on the same step
- [ ] Editing an earlier step does not reset later progress
- [ ] Editing the URL to a step you have not reached redirects back

## 4. Onboarding — content rules

- [ ] Competitors can be added without a domain
- [ ] Goals can be added without a baseline
- [ ] "Add another" rows can be left blank without causing an error
- [ ] Review shows **Not provided** for anything you skipped

## 5. Business Context

- [ ] **Publish version** makes the context canonical
- [ ] After publishing, the editor is gone and the version is read-only
- [ ] **Edit this context** creates version 2 as a draft
- [ ] The published version stays current while the draft is open
- [ ] **Save changes** persists; **Discard changes** reverts unsaved typing
- [ ] **Discard this draft** returns to the published version
- [ ] Version history lists both versions; opening version 1 shows its original text
- [ ] Every `?` tooltip opens on hover **and** on keyboard focus

## 6. Governance

- [ ] A goal can be created, activated, and retired
- [ ] A brand fact starts as PROPOSED and only becomes canonical when approved
- [ ] A competitor added without a type records as UNKNOWN
- [ ] An SEO rule can be deactivated and reactivated
- [ ] Technical context saves, and leaving staging unanswered keeps it unanswered

## 7. Connections

- [ ] All seven providers are listed
- [ ] Each states when it becomes available
- [ ] Every provider reads NOT_CONNECTED
- [ ] There is no button that implies connecting is possible

## 8. Command Center

- [ ] Setup completion matches what is actually filled in
- [ ] The percentage is labelled *Setup completion*, never a score
- [ ] Next Best Step points at the first incomplete item
- [ ] Its button navigates to the right page
- [ ] No SEO metric appears anywhere on the page

## 9. Workspace

- [ ] Audit History lists your recent changes with actor and timestamp
- [ ] **What changed** shows before and after
- [ ] No token, key, or password appears in any event
- [ ] Team lists members with roles and marks you
- [ ] Settings renames the workspace, and the rename appears in Audit History

## 10. Tenant isolation — the one worth doing carefully

This is the release-blocking criterion. Automated tests cover it at the service
layer; this confirms it through the browser.

- [ ] Note a website id from the Demo Workspace URL
- [ ] Sign out, sign in as a **different** Google account
- [ ] Create an organization for that account
- [ ] Paste the first account's website id into the URL
- [ ] You get **404**, not 403 and not the page
- [ ] Repeat for `/workspaces/<other-workspace-id>/audit`

Any cross-tenant access here is a **P0 FAIL**, regardless of what the automated
suite reports.

## 11. Accessibility spot check

- [ ] Tab from the top of any page: the first stop is **Skip to content**
- [ ] Focus is visible on every control you tab through
- [ ] The onboarding step rail is reachable and operable by keyboard
- [ ] Tooltips open on focus, not only on hover

---

## Known gaps this checklist cannot close

- Sign-in itself is never exercised by CI, so an OAuth configuration change can
  break it without any test failing.
- The suites run against the development database. A browser test that fails
  mid-flight can leave rows behind; the integration tests clean up, Playwright's
  authenticated paths would not.
