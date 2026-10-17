/**
 * Standalone "Watch" section. Holds the auto-invest demo video, which swapped
 * places with the agent-team walkthrough now playing in the hero. It plays
 * inline, with no card frame around it.
 */
export function VideoShowcaseSection() {
  return (
    <section id="walkthrough" className="relative border-t border-border py-24 lg:py-32">
      <div className="mx-auto max-w-5xl px-5 lg:px-8">
        <div className="text-center">
          <div className="text-xs font-medium uppercase tracking-[0.2em] text-primary">
            Watch
          </div>
          <h2 className="font-display mt-3 text-4xl tracking-tight lg:text-5xl">
            See the agents work
          </h2>
          <p className="mx-auto mt-4 max-w-2xl text-lg text-muted-foreground">
            A walkthrough of one full cycle — the analysts gathering evidence, the bull and bear
            debate, and the risk agent sizing the position that comes out of it.
          </p>
        </div>

        <div className="relative mt-10 aspect-video w-full">
          <iframe
            className="absolute inset-0 h-full w-full"
            src="https://www.youtube.com/embed/Sns0krBn5WA?rel=0&playsinline=1"
            title="Auto-invest Demo"
            loading="lazy"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            allowFullScreen
          />
        </div>
      </div>
    </section>
  )
}
