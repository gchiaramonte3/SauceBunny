// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { overwrite, paragraphs, placeWords, type Layering, type Timeline, type TimelineWord } from "../lib/edit-model";
import { EditParagraph, type EditSeamInfo } from "./EditParagraph";

afterEach(cleanup);

const word = (id: string, track: string, start: number, end: number): TimelineWord => ({ id, source: "s", track, text: id, start, end });
const base: Timeline = { segments: [{ id: "s", source: "s", srcIn: 0, srcOut: 10 }], mutes: [] };
// Kara's line runs across 3 s.
const kara = [word("okay", "kara", 2, 2.5), word("remind", "kara", 2.8, 3.4)];
const layering: Layering = { carries: () => ["kara", "bo"], home: (lane) => ({ kara: 1, bo: 2 } as Record<string, number>)[lane] };

const draw = (edit: Timeline) => {
  const [paragraph] = paragraphs(placeWords(kara, edit));
  const seams: Record<number, EditSeamInfo> = Object.fromEntries(edit.segments.map((_, index) => [index, { kind: "jump", seconds: null }]));
  return render(<EditParagraph paragraph={paragraph} speaker={{ id: "kara", name: "Kara", track: 1 }} color="#fff" fps={24} recordStart={0} sourceLabel={null}
    offset={0} range={null} caret={null} caretAfter={false} current={null} seams={seams} seam={null} onSeam={() => undefined}
    ghosts={() => []} onRestore={() => undefined} nameOf={(id) => id} corrections={{}} editing={null} onCorrect={() => undefined}
    index={0} onMove={() => undefined} first last />);
};

it("draws an edit point in a line only where that person's own track is cut", () => {
  // Bo overwritten from 1 to 3 s: the edit points at 1 and 3 are not on Kara's track.
  draw(overwrite(base, "s", 20, 22, 1, [{ lane: "bo", layer: 2 }], layering));
  expect(screen.queryByRole("button", { name: "Jump" })).toBeNull();
  cleanup();
  // Kara herself overwritten from 3 s, with a slightly earlier take of her own line: it jumps there.
  draw(overwrite(base, "s", 2.9, 4.9, 3, [{ lane: "kara", layer: 1 }], layering));
  expect(screen.getAllByRole("button", { name: "Jump" })).toHaveLength(1);
});
