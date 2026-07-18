import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BunnyLoader } from "./BunnyLoader";

// Server-render pins the structure: FOUR traced contours (two ears, body
// silhouette, inner play triangle) x four layers, gradient defs, a11y.
describe("BunnyLoader", () => {
  it("renders three paths per layer and the gradient defs", () => {
    const html = renderToStaticMarkup(<BunnyLoader />);
    expect(html.match(/pathLength="1"/g)?.length).toBe(16);
    expect(html).toContain("linearGradient");
    expect(html).toContain("cp-bl-grad");
    // Brand colors come from tokens via the classed stops (loader.css) —
    // NO mirrored hex literals in the markup (conventions fix).
    expect(html).toContain("cp-bl-stop-a");
    expect(html).toContain("cp-bl-stop-b");
    expect(html).not.toContain("#8627FF");
  });

  it("carries the a11y contract and the sublabel", () => {
    const html = renderToStaticMarkup(<BunnyLoader label="Buffering" sublabel="A few seconds" />);
    expect(html).toContain('role="status"');
    expect(html).toContain("Buffering");
    expect(html).toContain("A few seconds");
  });
});
