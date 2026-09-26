// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { MultitrackModelPicker } from "./MultitrackModelPicker";
import type { MultitrackModelChoice } from "../hooks/use-multitrack-transcription";

afterEach(cleanup);
function Picker({ disabled = false }: { disabled?: boolean }) {
  const [choice, setChoice] = useState<MultitrackModelChoice>({ engine: "whisper", modelId: "medium.en" });
  return <MultitrackModelPicker choice={choice} models={[]} onChange={setChoice} disabled={disabled} />;
}
describe("multitrack model subsettings", () => {
  it("keeps options collapsed and accuracy intact until explicitly changed", () => {
    render(<Picker />);
    const summary = screen.getByText("Options · Accurate");
    expect(summary.closest("details")?.open).toBe(false);
    expect((screen.getByLabelText("Decoding") as HTMLSelectElement).value).toBe("accurate");
    fireEvent.change(screen.getByLabelText("Decoding"), { target: { value: "fast" } });
    fireEvent.click(screen.getByLabelText("Skip non-speech"));
    expect(screen.getByText("Options · Fast · Speech filter")).not.toBeNull();
    fireEvent.change(screen.getByLabelText("Engine"), { target: { value: "parakeet" } });
    expect(screen.queryByLabelText("Decoding")).toBeNull();
    fireEvent.change(screen.getByLabelText("Engine"), { target: { value: "whisper" } });
    expect((screen.getByLabelText("Skip non-speech") as HTMLInputElement).checked).toBe(true);
  });
  it("disables configuration during recognition", () => {
    const onChange = vi.fn();
    render(<MultitrackModelPicker choice={{ engine: "whisper", modelId: "medium.en" }} models={[]} disabled onChange={onChange} />);
    expect((screen.getByLabelText("Engine") as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByLabelText("Decoding") as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByLabelText("Skip non-speech") as HTMLInputElement).disabled).toBe(true);
  });
});
