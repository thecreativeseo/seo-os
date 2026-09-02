import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    /**
     * Server Actions accept 1 MB by default, and P2 imports a Semrush export
     * through one. The import service caps files at 5 MB; this is that cap plus
     * headroom for the multipart envelope, so the service's own limit is what a
     * person actually hits — with an error that explains itself — rather than a
     * framework rejection that does not.
     */
    serverActions: { bodySizeLimit: "6mb" },
  },
};

export default nextConfig;
