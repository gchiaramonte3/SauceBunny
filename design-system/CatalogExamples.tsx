import { CommandExamples } from "./CommandExamples";
import { FieldExamples } from "./FieldExamples";
import { NavigationExamples } from "./NavigationExamples";
import { SurfaceExamples } from "./SurfaceExamples";
import { ParticipantExamples } from "./ParticipantExamples";
import { PreviewExamples } from "./PreviewExamples";
import { SpecialtyExamples } from "./SpecialtyExamples";
import { MultitrackExamples } from "./MultitrackExamples";
import type { ExampleProps } from "./example-types";

export function CatalogExamples(props: ExampleProps) {
  if (["generate", "speakers"].includes(props.kind)) return <SpecialtyExamples {...props} />;
  if (props.kind === "participants") return <ParticipantExamples />;
  if (props.kind === "preview") return <PreviewExamples />;
  if (props.kind === "panels") return <><SurfaceExamples {...props} /><MultitrackExamples /></>;
  if (["buttons", "icons", "statuses", "async"].includes(props.kind)) return <CommandExamples {...props} />;
  if (["fields", "selects", "choices"].includes(props.kind)) return <FieldExamples {...props} />;
  if (["tabs", "menus", "navigation"].includes(props.kind)) return <NavigationExamples {...props} />;
  return <SurfaceExamples {...props} />;
}
