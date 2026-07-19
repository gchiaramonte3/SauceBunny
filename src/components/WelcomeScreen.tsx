import { useEffect } from "react";
import logoUrl from "../assets/saucebunny.svg";
import { IconCoReview, IconHome, IconLink, IconTranscript } from "./Icons";

/**
 * First-launch welcome. Shows exactly once (App gates on the
 * `saucebunny.welcomed` localStorage flag), lists what the app does in
 * four kid-simple lines, and gets out of the way with one button.
 *
 * Design: the brand mark over a dark stage washed by two soft radial
 * gradients (brand green + novella purple - the only place the two mix),
 * staggered rise-in for the rows, all motion removed under
 * prefers-reduced-motion. The CTA is the grey chip per the house rule.
 */
export function WelcomeScreen({ onDone }: { onDone: () => void }) {
  // Esc = same as Get started (capture phase so app shortcuts don't fire).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "Enter") {
        e.stopPropagation();
        onDone();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onDone]);

  const rows = [
    { icon: <IconLink size={16} />, title: "Pull in any video", sub: "Paste a link or drop a file." },
    { icon: <IconTranscript size={16} />, title: "Turn talk into text", sub: "Transcripts with speaker names." },
    { icon: <IconCoReview size={16} />, title: "Watch together", sub: "Live rooms with voice, camera, and screen share." },
    { icon: <IconHome size={16} />, title: "Yours alone", sub: "Everything stays on your Mac. No cloud, no accounts." },
  ];

  return (
    <div className="cp-welcome" role="dialog" aria-modal="true" aria-label="Welcome to Sauce Bunny">
      <div className="cp-welcome-stage">
        <img className="cp-welcome-mark" src={logoUrl} alt="" />
        <h1 className="cp-welcome-title">Welcome to Sauce Bunny</h1>
        <p className="cp-welcome-sub">Watch, transcribe, and review video together.</p>
        <ul className="cp-welcome-rows">
          {rows.map((r, i) => (
            <li key={r.title} className="cp-welcome-row" style={{ animationDelay: `${180 + i * 90}ms` }}>
              <span className="cp-welcome-row-icon">{r.icon}</span>
              <span className="cp-welcome-row-text">
                <strong>{r.title}</strong>
                <span>{r.sub}</span>
              </span>
            </li>
          ))}
        </ul>
        <button type="button" className="btn cp-welcome-cta" onClick={onDone} autoFocus>
          Get started
        </button>
      </div>
    </div>
  );
}
