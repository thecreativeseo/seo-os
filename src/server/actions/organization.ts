"use server";

import { redirect } from "next/navigation";
import { z } from "zod";

import { requireUser } from "@/server/auth/session";
import { createOrganizationWithWorkspace } from "@/server/services/organization";

const schema = z.object({
  organizationName: z.string().trim().min(2, "Enter at least 2 characters").max(120),
  workspaceName: z.string().trim().min(2, "Enter at least 2 characters").max(120),
});

export type CreateOrganizationState = {
  error?: string;
  fieldErrors?: Partial<Record<"organizationName" | "workspaceName", string>>;
};

export async function createOrganizationAction(
  _previous: CreateOrganizationState,
  formData: FormData,
): Promise<CreateOrganizationState> {
  // Authorization is re-established server-side; the form cannot assert identity.
  const { user, memberships } = await requireUser();

  if (memberships.length > 0) {
    redirect("/");
  }

  const parsed = schema.safeParse({
    organizationName: formData.get("organizationName"),
    workspaceName: formData.get("workspaceName"),
  });

  if (!parsed.success) {
    const fieldErrors: CreateOrganizationState["fieldErrors"] = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0];
      if (key === "organizationName" || key === "workspaceName") {
        fieldErrors[key] = issue.message;
      }
    }
    return { fieldErrors };
  }

  await createOrganizationWithWorkspace(user, parsed.data);

  redirect("/");
}
