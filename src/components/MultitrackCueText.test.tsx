// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { MultitrackCueText } from "./MultitrackCueText";

afterEach(cleanup);
const word = (text: string, confidence: number) => ({ text, start_sample: 0, end_sample: 1, confidence });

it("marks only the words the recognizer was unsure of, and keeps the text exactly", () => {
  const { container } = render(<MultitrackCueText text="Rosa moved in May" words={[word("Rosa", 0.31), word("moved", 0.95), word("in", 0.9), word("May", 0.88)]} />);
  expect(container.textContent).toBe("Rosa moved in May");
  expect([...container.querySelectorAll(".cp-multitrack-word-unsure")].map((node) => node.textContent)).toEqual(["Rosa"]);
});

it("is plain text when every word is confident or no word was measured", () => {
  const { container, rerender } = render(<MultitrackCueText text="Rosa moved" words={[word("Rosa", 0.9), word("moved", 0.95)]} />);
  expect(container.querySelector(".cp-multitrack-word-unsure")).toBeNull();
  rerender(<MultitrackCueText text="Rosa moved" />);
  expect(container.textContent).toBe("Rosa moved");
});
