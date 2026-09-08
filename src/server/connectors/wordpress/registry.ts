import type { CmsAuthType, Connection, Website } from "@/generated/prisma/client";
import { CmsProviderError, type CmsProvider } from "./types";
import { WordPressProvider } from "./client";
import { SimulatedWordPressProvider } from "./simulated";

/**
 * Choosing which WordPress a connection talks to.
 *
 * Explicit, by the connection's stored auth type, with one rule that is not
 * negotiable: the simulated provider is only ever built for a website marked as
 * a demo. A simulated connection on a real website would let a person watch a
 * draft appear and believe their CMS had received it, which is the single worst
 * thing this subsystem could do.
 *
 * The two auth types M6 does not implement fail here by name. They are in the
 * enum because the spec names them, and answering "unsupported" is the honest
 * result until one of them is built.
 */

export type ProviderSelection = {
  provider: CmsProvider;
  authType: CmsAuthType;
};

export function selectProvider(
  connection: Pick<Connection, "id" | "authType">,
  website: Pick<Website, "id" | "isDemo">,
): ProviderSelection {
  const authType = connection.authType;

  if (authType === "APPLICATION_PASSWORD") {
    return { provider: new WordPressProvider(), authType };
  }

  if (authType === "SIMULATED") {
    if (!website.isDemo) {
      // Refused rather than downgraded. A real website with a simulated
      // connection is a misconfiguration, and quietly using the real provider
      // instead would send content somewhere nobody asked for.
      throw new CmsProviderError("policy_denied");
    }
    return { provider: new SimulatedWordPressProvider(website.id), authType };
  }

  // OAUTH2 and CUSTOM_PLUGIN_TOKEN both need a plugin, and neither is built.
  throw new CmsProviderError("auth_required");
}
