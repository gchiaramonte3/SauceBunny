import { useLayoutEffect, useRef, type RefObject } from "react";
import { usePaneWidth } from "../hooks/use-pane-width";

type Pane = ReturnType<typeof usePaneWidth>;
type Props = { side: boolean; source: boolean };

/**
 * The editor's dividers: beside Ask, Inspector and History; between the
 * source and the record; and above the timeline. There were none, only
 * fixed widths, so what read as the centre divider was a border with the
 * source text's scrollbar against it: grabbing it scrolled the source.
 *
 * Sizes are CSS variables on the editor (transcript-editor.css), and CSS
 * holds the record pane to its minimum by making the source, then the side,
 * give way; so a drag starts from the size as drawn, never the stored one.
 * The editor is found from a divider rather than through a ref handed down:
 * an ancestor's ref is attached only after this component's layout effect
 * has run, so on the first render it would still be empty.
 */
export function EditSplits({ side, source }: Props) {
  const anchor = useRef<HTMLDivElement>(null);
  const editor = () => anchor.current?.closest<HTMLElement>(".cp-te") ?? null;
  const measure = (selector: string, height = false) => () => {
    const box = editor()?.querySelector(selector)?.getBoundingClientRect();
    return box ? (height ? box.height : box.width) : null;
  };
  const sidePane = usePaneWidth({ key: "saucebunny.stringOuts.sideWidth", min: 260, max: 480, fallback: 320, measure: measure(".cp-te-pane-side") });
  const sourcePane = usePaneWidth({ key: "saucebunny.stringOuts.sourceWidth", min: 280, max: 640, fallback: 340, measure: measure(".cp-te-pane-source") });
  // Up to 60% of the page, which CSS enforces, since the page's height is not this hook's to know.
  const timeline = usePaneWidth({ key: "saucebunny.stringOuts.timelineHeight", min: 160, max: 2400, fallback: 280, side: "bottom", measure: measure(".cp-te-lower", true) });
  useLayoutEffect(() => {
    const style = anchor.current?.closest<HTMLElement>(".cp-te")?.style;
    if (!style) return;
    // A hidden side takes no room, so the source's divider moves left with it.
    style.setProperty("--te-side-w", `${side ? sidePane.width : 0}px`);
    style.setProperty("--te-source-w", `${sourcePane.width}px`);
    // Until a height is chosen the timeline keeps its default, a share of the page.
    if (timeline.chosen) style.setProperty("--te-lower-h", `${timeline.width}px`);
    else style.removeProperty("--te-lower-h");
  }, [side, sidePane.width, sourcePane.width, timeline.chosen, timeline.width]);
  return <>
    {side && <Split className="cp-te-split-side" label="Resize Ask, Inspector and History" pane={sidePane} />}
    {source && <Split className="cp-te-split-source" label="Resize the source" pane={sourcePane} />}
    <Split className="cp-te-split-timeline" label="Resize the timeline" pane={timeline} horizontal handle={anchor} />
  </>;
}

function Split({ className, label, pane, horizontal = false, handle }: { className: string; label: string; pane: Pane; horizontal?: boolean; handle?: RefObject<HTMLDivElement> }) {
  return <div ref={handle} className={`cp-te-split ${className} cp-resize-handle ${horizontal ? "horizontal" : "vertical"}${pane.resizing ? " dragging" : ""}`}
    role="separator" aria-label={label} aria-orientation={horizontal ? "horizontal" : "vertical"} aria-valuemin={pane.min} aria-valuemax={pane.max}
    aria-valuenow={Math.round(pane.width)} tabIndex={0} onMouseDown={pane.onMouseDown} onKeyDown={pane.onKeyDown} onDoubleClick={pane.reset}
    title="Drag to resize · arrow keys to nudge · Home to reset" />;
}
