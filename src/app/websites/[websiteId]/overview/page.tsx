import { requireWebsiteAccess } from "@/server/auth/guards";
import { PageHeader } from "@/components/governance/primitives";

export const metadata = { title: "Overview · SEO OS" };

/**
 * Overview — intentionally empty.
 *
 * This is where the website's operating picture will go once there is real data to
 * show. There is none in P0: nothing is connected, so anything here would be either
 * a placeholder chart or a restatement of the Command Center. Both would be worse
 * than an empty page that says why it is empty.
 */
export default async function OverviewPage({
  params,
}: {
  params: Promise<{ websiteId: string }>;
}) {
  const { websiteId } = await params;
  await requireWebsiteAccess(websiteId);

  return (
    <main className="space-y-8">
      <PageHeader
        title="Overview"
        description="The operating picture for this website."
      />

      <div className="border-border space-y-2 rounded-lg border border-dashed p-6">
        <p className="text-sm">Nothing to show yet.</p>
        <p className="text-muted-foreground max-w-prose text-sm leading-relaxed">
          This page will hold what is actually happening on the website — search
          visibility, behaviour and the signals derived from them. None of that exists
          until Search Console and Analytics are connected in P1, and SEO OS will not
          fill the space with something it has not measured.
        </p>
        <p className="text-muted-foreground max-w-prose text-sm leading-relaxed">
          Until then, <span className="font-medium">Website Ownership</span> holds the
          site&rsquo;s details and the <span className="font-medium">Command Center</span>{" "}
          shows how completely the business has been described.
        </p>
      </div>
    </main>
  );
}
