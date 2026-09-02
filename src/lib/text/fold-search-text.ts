/**
 * The one place SEO OS folds a piece of search text into an identity.
 *
 * Two things have to agree exactly: a Search Console query and a Semrush keyword.
 * When they are the same string they must normalize to the same value, or the
 * first-party evidence will never join to the market evidence — and a keyword with
 * demand but no clicks is a data bug that looks exactly like an insight, which is
 * the worst kind.
 *
 * Rather than trusting two implementations to stay in step, both call this.
 *
 * Deliberately conservative. No stemming, no de-pluralisation, no stop-word
 * removal: "seo agency" and "seo agencies" are typed differently, rank differently
 * and are bid on differently. Merging them would hide the very splits this product
 * exists to surface. Only typographic noise is folded.
 */
export function foldSearchText(input: string): string {
  return (
    input
      // Unicode spaces, tabs and newlines all become a single space.
      .replace(/\s+/gu, " ")
      .trim()
      // Curly quotes and dashes are typographic variants of the same text.
      .replace(/[‘’‛′]/gu, "'")
      .replace(/[“”‟″]/gu, '"')
      .replace(/[‐-―]/gu, "-")
      // Combining marks are folded so the two spellings of "café" are one string.
      // Base accented characters are left alone: "cafe" and "café" stay distinct,
      // because they are typed and ranked separately.
      .normalize("NFC")
      .toLowerCase()
  );
}
