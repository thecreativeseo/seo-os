import Link from "next/link";

import { ONBOARDING_STEPS, stepIndex, type OnboardingStepSlug } from "@/lib/onboarding/steps";

/**
 * Onboarding layout: the numbered step rail from the blueprint, plus one question
 * at a time in the right-hand pane.
 *
 * Steps ahead of the user's progress render as plain text, not links — and the
 * server rejects them anyway. UI state is a convenience, never the control.
 */
export function OnboardingShell({
  current,
  active,
  children,
}: {
  current: OnboardingStepSlug;
  active: OnboardingStepSlug;
  children: React.ReactNode;
}) {
  const currentIndex = stepIndex(current);
  const activeIndex = stepIndex(active);

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-10 px-6 py-12 md:flex-row md:gap-14">
      <nav aria-label="Onboarding steps" className="md:w-56 md:shrink-0">
        <p className="text-muted-foreground mb-4 text-xs font-medium tracking-wide uppercase">
          Setup
        </p>
        <ol className="space-y-1">
          {ONBOARDING_STEPS.map((step) => {
            const done = step.index < currentIndex;
            const isActive = step.index === activeIndex;
            const reachable = step.index <= currentIndex;

            return (
              <li key={step.slug}>
                {reachable ? (
                  <Link
                    href={`../${step.slug}` as never}
                    aria-current={isActive ? "step" : undefined}
                    className={`flex items-baseline gap-3 rounded-md px-2 py-1.5 text-sm transition-colors ${
                      isActive
                        ? "bg-accent font-medium"
                        : "text-muted-foreground hover:bg-accent/60"
                    }`}
                  >
                    <span className="w-4 text-right text-xs tabular-nums">
                      {done ? "✓" : step.index}
                    </span>
                    {step.label}
                  </Link>
                ) : (
                  <span className="text-muted-foreground/50 flex items-baseline gap-3 px-2 py-1.5 text-sm">
                    <span className="w-4 text-right text-xs tabular-nums">{step.index}</span>
                    {step.label}
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      </nav>

      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
