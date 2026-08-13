/** Hero/header stub for the leaderboard homepage. Components exist so a later
 * visual pass can flesh them out without restructuring the page. Site-level
 * navigation (Today's puzzle / Leaderboard / calendar) lives in the shared
 * header. */
export function HeroHeader() {
  return (
    <section className="bench-hero">
      <h1 className="bench-hero__title">Connections Lab</h1>
      <p className="bench-hero__description">
        Benchmark how puzzle-solving strategies compare across every ingested puzzle.
      </p>
    </section>
  );
}
