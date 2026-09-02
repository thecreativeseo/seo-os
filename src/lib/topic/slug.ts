/**
 * Topic slugs.
 *
 * Pure and dependency-free, and here rather than in the topic service for a
 * practical reason: the demo seed needs it, and importing it from the service
 * pulled in the Prisma client at module load — before the seed had loaded its
 * environment. A helper that does arithmetic on a string should not be able to
 * open a database connection as a side effect of being imported.
 */
export function slugify(name: string): string {
  return (
    name
      .normalize("NFKD")
      // Strip combining marks so "Café" and "Cafe" produce one slug.
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80)
  );
}
