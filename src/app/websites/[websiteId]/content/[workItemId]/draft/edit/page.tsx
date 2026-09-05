import { redirect } from "next/navigation";

/**
 * The editor lives in the draft workspace now (M4.4 §4): this route sends
 * older links to the workspace's edit mode, keeping the draft selection.
 */
export default async function EditDraftPage({
  params,
  searchParams,
}: {
  params: Promise<{ websiteId: string; workItemId: string }>;
  searchParams: Promise<{ draft?: string }>;
}) {
  const { websiteId, workItemId } = await params;
  const { draft } = await searchParams;
  redirect(
    `/websites/${websiteId}/content/${workItemId}/draft?mode=edit${draft ? `&draft=${draft}` : ""}`,
  );
}
