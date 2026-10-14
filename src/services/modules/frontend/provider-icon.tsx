// Drop-in for morline-main/src/components/moor/provider-icon.tsx
//
// Renders the icon in front of an AI progress step ("Adding Resend email" with the Resend logo).
// Steps stay plain strings for old messages; new ones may be { text, icon }.
// If a logo file is missing the step falls back to the existing bulb, so nothing breaks while
// logos are being added.

import {
  Activity, BookOpen, Clock, Database, Eye, Gauge, Globe, KeyRound, Layers, Lightbulb, Mail,
  ShieldCheck, UserRound, type LucideIcon,
} from "lucide-react";

export type Step = string | { text: string; icon?: string | null };

export const stepText = (s: Step): string => (typeof s === "string" ? s : s.text);

// Logos live in src/assets/providers (new) and src/assets/stack (existing: postgresql, mongodb, redis).
// Files in providers/ win if a name exists in both.
const files = {
  ...import.meta.glob("../../assets/stack/*.svg", { eager: true, import: "default" }),
  ...import.meta.glob("../../assets/providers/*.svg", { eager: true, import: "default" }),
} as Record<string, string>;
const logos: Record<string, string> = Object.fromEntries(
  Object.entries(files).map(([path, url]) => [path.split("/").pop()!.replace(/\.svg$/, ""), url]),
);

// Single-colour logos are drawn as a mask in the current text colour so they work in light and dark mode.
// Keep in sync with the "monochrome" list in AGENT_BRIEF.md.
const MONOCHROME = new Set(["resend", "openai", "anthropic"]);

// The generic (non-brand) icons the engine can ask for, as "lucide:<name>".
const GENERIC: Record<string, LucideIcon> = {
  activity: Activity,
  "book-open": BookOpen,
  clock: Clock,
  database: Database,
  gauge: Gauge,
  globe: Globe,
  "key-round": KeyRound,
  layers: Layers,
  mail: Mail,
  "shield-check": ShieldCheck,
  "user-round": UserRound,
};

const SIZE = "h-3.5 w-3.5 shrink-0";

export function StepIcon({ step }: { step: Step }) {
  const icon = typeof step === "string" ? null : (step.icon ?? null);

  if (icon?.startsWith("lucide:")) {
    const Generic = GENERIC[icon.slice(7)];
    if (Generic) return <Generic className={SIZE} />;
  } else if (icon && logos[icon]) {
    const url = logos[icon];
    if (MONOCHROME.has(icon)) {
      return (
        <span
          aria-hidden
          className={`${SIZE} inline-block bg-current`}
          style={{
            WebkitMaskImage: `url(${url})`,
            maskImage: `url(${url})`,
            WebkitMaskSize: "contain",
            maskSize: "contain",
            WebkitMaskRepeat: "no-repeat",
            maskRepeat: "no-repeat",
            WebkitMaskPosition: "center",
            maskPosition: "center",
          }}
        />
      );
    }
    return <img src={url} alt="" className={`${SIZE} object-contain`} />;
  }

  // Previous behaviour: reading steps get an eye, everything else a bulb.
  const Fallback = /^(read|review|look|check|fetch|inspect|scan)/i.test(stepText(step)) ? Eye : Lightbulb;
  return <Fallback className={SIZE} />;
}
