"use client";

import { useLayoutEffect, useMemo, useRef, useState } from "react";

interface FaqNavigationItem {
  id: string;
  question: string;
  navLabel?: string;
}

interface FaqNavigationSection {
  id: string;
  title: string;
  items: readonly FaqNavigationItem[];
}

interface RailMeasurements {
  contentTops: number[];
  markerTops: number[];
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function smoothstep(value: number) {
  return value * value * (3 - 2 * value);
}

export function FaqNavigation({
  sections,
}: {
  sections: readonly FaqNavigationSection[];
}) {
  const itemIds = useMemo(
    () => sections.flatMap((section) => section.items.map((item) => item.id)),
    [sections],
  );
  const [activeId, setActiveId] = useState(itemIds[0] ?? "");
  const trackRef = useRef<HTMLDivElement>(null);
  const markerRef = useRef<HTMLSpanElement>(null);
  const activeIndexRef = useRef(0);
  const measurementsRef = useRef<RailMeasurements | null>(null);
  const activeSectionId =
    sections.find((section) => section.items.some((item) => item.id === activeId))?.id ??
    sections[0]?.id;

  useLayoutEffect(() => {
    let animationFrame = 0;

    function measureRail() {
      const track = trackRef.current;
      if (!track) return;

      const trackTop = track.getBoundingClientRect().top;
      const contentTops: number[] = [];
      const markerTops: number[] = [];

      for (const id of itemIds) {
        const content = document.getElementById(id);
        const link = document.getElementById(`faq-nav-${id}`);
        if (!content || !link) return;

        const linkRect = link.getBoundingClientRect();
        contentTops.push(content.getBoundingClientRect().top + window.scrollY);
        markerTops.push(
          linkRect.top - trackTop + linkRect.height / 2 - 4,
        );
      }

      measurementsRef.current = { contentTops, markerTops };
      updateRail();
    }

    function updateRail() {
      animationFrame = 0;
      const marker = markerRef.current;
      const measurements = measurementsRef.current;
      if (!marker || !measurements || itemIds.length === 0) return;

      const lastIndex = itemIds.length - 1;
      const atPageEnd =
        window.scrollY + window.innerHeight >=
        document.documentElement.scrollHeight - 4;
      const readingLine = window.scrollY + window.innerHeight * 0.45;

      let activeIndex = 0;
      if (atPageEnd) {
        activeIndex = lastIndex;
      } else {
        while (
          activeIndex < lastIndex &&
          readingLine >= measurements.contentTops[activeIndex + 1]
        ) {
          activeIndex += 1;
        }
      }

      const markerTop = measurements.markerTops[activeIndex] ?? 0;
      marker.style.opacity = "1";
      marker.style.transform = `translate3d(0, ${markerTop}px, 0)`;

      if (activeIndex !== activeIndexRef.current) {
        activeIndexRef.current = activeIndex;
        setActiveId(itemIds[activeIndex]);
      }
    }

    function requestRailUpdate() {
      if (animationFrame) return;
      animationFrame = window.requestAnimationFrame(updateRail);
    }

    function handleResize() {
      window.cancelAnimationFrame(animationFrame);
      animationFrame = window.requestAnimationFrame(measureRail);
    }

    measureRail();
    void document.fonts.ready.then(measureRail);
    window.addEventListener("scroll", requestRailUpdate, { passive: true });
    window.addEventListener("resize", handleResize);
    window.addEventListener("hashchange", requestRailUpdate);

    return () => {
      window.cancelAnimationFrame(animationFrame);
      window.removeEventListener("scroll", requestRailUpdate);
      window.removeEventListener("resize", handleResize);
      window.removeEventListener("hashchange", requestRailUpdate);
    };
  }, [itemIds, activeId]);

  function navigateTo(id: string) {
    setActiveId(id);
  }

  return (
    <>
      <nav
        aria-label="FAQ sections"
        className="grid grid-cols-3 border-b border-border/70 lg:hidden"
      >
        {sections.map((section) => {
          const active = activeSectionId === section.id;
          return (
            <a
              aria-current={active ? "location" : undefined}
              className={
                active
                  ? "flex min-h-12 items-center justify-center border-b-2 border-accent px-2 py-2 text-center text-xs font-semibold leading-4 text-fg"
                  : "flex min-h-12 items-center justify-center border-b-2 border-transparent px-2 py-2 text-center text-xs font-medium leading-4 text-muted transition-colors duration-150 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40 motion-reduce:transition-none"
              }
              href={`#${section.id}`}
              key={section.id}
              onClick={() => navigateTo(section.items[0]?.id ?? "")}
            >
              {section.title}
            </a>
          );
        })}
      </nav>

      <aside className="sticky top-1/2 -translate-y-1/2 hidden self-start lg:block">
        <nav aria-label="FAQ questions" className="py-1 pl-3 pr-2">
          <div className="relative space-y-4" ref={trackRef}>
            <span
              aria-hidden="true"
              className="pointer-events-none absolute -left-[4px] top-0 z-10 h-2 w-2 rounded-full bg-accent opacity-0 shadow-[0_0_0_4px_hsl(var(--accent)/0.18),0_0_12px_hsl(var(--accent)/0.7)] transition-transform duration-200 ease-out will-change-transform motion-reduce:transition-none"
              ref={markerRef}
            />
            {sections.map((section) => (
              <div key={section.id}>
                <a
                  className="text-[11px] font-semibold uppercase tracking-wider text-muted transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 motion-reduce:transition-none"
                  href={`#${section.id}`}
                >
                  {section.title}
                </a>
                <ol className="mt-1.5 border-l border-border/70 pl-3.5">
                  {section.items.map((item) => {
                    const active = activeId === item.id;
                    return (
                      <li key={item.id} className="transition-all duration-150 ease-out">
                        <a
                          aria-current={active ? "location" : undefined}
                          className={`relative block transition-all duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
                            active
                              ? "py-1 text-xs font-semibold text-fg"
                              : "py-0.5 text-xs text-muted/70 hover:text-fg"
                          }`}
                          href={`#${item.id}`}
                          id={`faq-nav-${item.id}`}
                          onClick={() => navigateTo(item.id)}
                        >
                          <span className="block leading-snug">
                            {active ? item.question : (item.navLabel ?? item.question)}
                          </span>
                        </a>
                      </li>
                    );
                  })}
                </ol>
              </div>
            ))}
          </div>
        </nav>
      </aside>
    </>
  );
}
