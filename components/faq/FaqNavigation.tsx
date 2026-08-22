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
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

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
          linkRect.top - trackTop + Math.min(linkRect.height, 20) / 2 - 3,
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
        document.documentElement.scrollHeight - 2;
      const readingLine = window.scrollY + Math.min(window.innerHeight * 0.32, 280);

      let fromIndex = 0;
      if (atPageEnd) {
        fromIndex = lastIndex;
      } else {
        while (
          fromIndex < lastIndex &&
          readingLine >= measurements.contentTops[fromIndex + 1]
        ) {
          fromIndex += 1;
        }
      }

      const toIndex = Math.min(fromIndex + 1, lastIndex);
      const start = measurements.contentTops[fromIndex];
      const end = measurements.contentTops[toIndex];
      const rawProgress =
        fromIndex === toIndex ? 0 : clamp((readingLine - start) / (end - start), 0, 1);
      const travelProgress = reducedMotion.matches
        ? rawProgress >= 0.7
          ? 1
          : 0
        : smoothstep(rawProgress);
      const emphasisProgress = reducedMotion.matches
        ? travelProgress
        : smoothstep(clamp((rawProgress - 0.5) / 0.4, 0, 1));
      const markerTop =
        measurements.markerTops[fromIndex] +
        (measurements.markerTops[toIndex] - measurements.markerTops[fromIndex]) *
          travelProgress;

      marker.style.opacity = "1";
      marker.style.transform = `translate3d(0, ${markerTop}px, 0)`;

      for (const [index, id] of itemIds.entries()) {
        const link = document.getElementById(`faq-nav-${id}`);
        if (!link) continue;

        let emphasis = 0;
        if (fromIndex === toIndex && index === fromIndex) emphasis = 1;
        else if (index === fromIndex) emphasis = 1 - emphasisProgress;
        else if (index === toIndex) emphasis = emphasisProgress;
        link.style.opacity = String(0.55 + emphasis * 0.45);
      }

      const nextActiveIndex = emphasisProgress >= 0.5 ? toIndex : fromIndex;
      if (nextActiveIndex !== activeIndexRef.current) {
        activeIndexRef.current = nextActiveIndex;
        setActiveId(itemIds[nextActiveIndex]);
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
    reducedMotion.addEventListener("change", requestRailUpdate);

    return () => {
      window.cancelAnimationFrame(animationFrame);
      window.removeEventListener("scroll", requestRailUpdate);
      window.removeEventListener("resize", handleResize);
      window.removeEventListener("hashchange", requestRailUpdate);
      reducedMotion.removeEventListener("change", requestRailUpdate);
    };
  }, [itemIds]);

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

      <aside className="sticky top-16 hidden self-start lg:block">
        <nav
          aria-label="FAQ questions"
          className="max-h-[calc(100vh-5rem)] overflow-y-auto py-1 pr-2 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
        >
          <div className="relative space-y-4" ref={trackRef}>
            <span
              aria-hidden="true"
              className="pointer-events-none absolute -left-[3px] top-0 z-10 h-1.5 w-1.5 rounded-full bg-accent opacity-0 shadow-[0_0_0_4px_hsl(var(--accent)/0.12),0_0_12px_hsl(var(--accent)/0.65)] will-change-transform motion-reduce:transition-none"
              ref={markerRef}
            />
            {sections.map((section) => (
              <div key={section.id}>
                <a
                  className="text-xs font-semibold uppercase tracking-wider text-muted transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 motion-reduce:transition-none"
                  href={`#${section.id}`}
                >
                  {section.title}
                </a>
                <ol className="mt-1.5 border-l border-border/70 pl-3.5">
                  {section.items.map((item) => {
                    const active = activeId === item.id;
                    return (
                      <li key={item.id}>
                        <a
                          aria-current={active ? "location" : undefined}
                          className="relative block py-0.5 text-xs leading-5 text-fg opacity-55 transition-opacity duration-150 hover:!opacity-100 focus-visible:!opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                          href={`#${item.id}`}
                          id={`faq-nav-${item.id}`}
                          onClick={() => navigateTo(item.id)}
                        >
                          {item.navLabel ?? item.question}
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
