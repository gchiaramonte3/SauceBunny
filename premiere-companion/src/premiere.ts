import type { premierepro, Project, Sequence, Markers, Marker } from "@adobe/premierepro";
import { MarkerLedger } from "./ledger";
import type { Binding, MarkerNote } from "./protocol";
import { samePremiereBinding as sameBinding } from "../../src/lib/premiere-binding";

export type AdobeApi = Pick<premierepro, "Project" | "Guid" | "Markers" | "TickTime">;
export type MarkerResult = { outcome: "found"; markerGuid: string } | { outcome: "undone" | "absent" | "uncertain" };
export type Placement = { binding: Binding; sequenceTicks: string; frame: string };
const guid = (value: { toString(): string }) => value.toString();
const provenance = (id: string) => `[Sauce Bunny note:${id}]`;

function validTicks(ticks: string, timebase: string) {
  if (!/^[0-9]{1,24}$/.test(ticks) || !/^[1-9][0-9]{0,23}$/.test(timebase)
    || BigInt(ticks) % BigInt(timebase) !== 0n) {
    throw new Error("Premiere did not return a valid sequence-frame position. Park on a frame and try again.");
  }
}

/** All mutable Adobe operations are deliberately confined to insertConfirmed.
 * No method changes the active sequence, CTI, playback or saved project file. */
export class PremiereAdapter {
  constructor(private api: AdobeApi, private ledger: MarkerLedger) {}

  async bindActive(): Promise<Binding> {
    const project = await this.api.Project.getActiveProject();
    if (!project) throw new Error("Open a Premiere project first.");
    const sequence = await project.getActiveSequence();
    if (!sequence || !project.path) throw new Error("Open a sequence in a saved Premiere project first.");
    const path = project.path;
    const [timebaseTicks, display, zero] = await Promise.all([
      sequence.getTimebase(), sequence.getSequenceVideoTimeDisplayFormat(), sequence.getZeroPoint(),
    ]);
    if (project.path !== path) throw new Error("The project changed during binding. Try again.");
    const target = { projectId: guid(project.guid), sequenceId: guid(sequence.guid), projectName: project.name,
      sequenceName: sequence.name, timebaseTicks, displayFormat: String(display.type), zeroPointTicks: zero.ticks };
    // Reconnect to an existing exact local identity. A changed path, timebase or
    // zero point gets a new binding; delayed notes retain their original one.
    const previous = this.ledger.bindings().find(entry => entry.projectPath === path
      && sameBinding(entry.binding, { ...target, bindingId: entry.binding.bindingId }));
    const binding: Binding = { ...target, bindingId: previous?.binding.bindingId
      ?? `binding-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}` };
    validTicks("0", binding.timebaseTicks);
    this.ledger.bind(binding, path);
    return binding;
  }

  private checkTarget(binding: Binding, project: Project, sequence?: Sequence): void {
    const expectedPath = this.ledger.projectPath(binding.bindingId);
    if (!expectedPath) throw new Error("This captured binding is not known on this editor's machine. No marker was placed.");
    if (!project?.guid || guid(project.guid) !== binding.projectId || project.path !== expectedPath) {
      throw new Error("Open the original bound project. A moved or Save As project is not silently substituted.");
    }
    if (sequence && (!sequence.guid || guid(sequence.guid) !== binding.sequenceId))
      throw new Error("The originally bound sequence is unavailable.");
  }

  private async exactTarget(binding: Binding): Promise<{ project: Project; sequence: Sequence }> {
    if (!this.ledger.projectPath(binding.bindingId))
      throw new Error("This captured binding is not known on this editor's machine. No marker was placed.");
    // Await native lookups even where the 26.3 declarations say synchronous.
    // Runtime UXP handles may arrive asynchronously; Promise.guid is undefined.
    const projectId = await this.api.Guid.fromString(binding.projectId);
    const project = await this.api.Project.getProject(projectId);
    this.checkTarget(binding, project);
    const sequenceId = await this.api.Guid.fromString(binding.sequenceId);
    const sequence = await project.getSequence(sequenceId);
    if (!sequence) throw new Error("The originally bound sequence is unavailable.");
    this.checkTarget(binding, project, sequence);
    return { project, sequence };
  }

  private async validateClock(sequence: Sequence, binding: Binding) {
    const [timebase, display, zero] = await Promise.all([
      sequence.getTimebase(), sequence.getSequenceVideoTimeDisplayFormat(), sequence.getZeroPoint(),
    ]);
    if (timebase !== binding.timebaseTicks || String(display.type) !== binding.displayFormat || zero.ticks !== binding.zeroPointTicks) {
      throw new Error("The sequence timing settings changed. This note needs its original timeline position checked.");
    }
  }

  async restoreBinding(binding: Binding): Promise<Binding> {
    const { sequence } = await this.exactTarget(binding);
    await this.validateClock(sequence, binding);
    await this.exactTarget(binding);
    return binding;
  }

  async capturePlacement(binding: Binding): Promise<Placement> {
    const { project, sequence } = await this.exactTarget(binding);
    const activeProject = await this.api.Project.getActiveProject();
    const activeSequence = await project.getActiveSequence();
    if (!activeProject || !activeSequence || guid(activeProject.guid) !== binding.projectId
      || guid(activeSequence.guid) !== binding.sequenceId) {
      throw new Error("Activate and park the bound sequence before confirming this note.");
    }
    await this.validateClock(sequence, binding);
    const position = await sequence.getPlayerPosition();
    validTicks(position.ticks, binding.timebaseTicks);
    await this.exactTarget(binding); // Save As may mutate the Project handle across await.
    return { binding, sequenceTicks: position.ticks, frame: (BigInt(position.ticks) / BigInt(binding.timebaseTicks)).toString() };
  }

  private find(markers: Markers, note: MarkerNote): Marker | undefined {
    const known = this.ledger.delivery(note.id);
    return markers.getMarkers().find(marker =>
      (known?.markerGuid !== null && known?.markerGuid !== undefined && guid(marker.guid) === known.markerGuid)
      || marker.getComments().endsWith(`\n${provenance(note.id)}`));
  }

  async reconcile(note: MarkerNote): Promise<MarkerResult> {
    const binding = note.request.anchor.binding;
    const { sequence } = await this.exactTarget(binding);
    const markers = await this.api.Markers.getMarkers(sequence);
    await this.exactTarget(binding);
    const found = this.find(markers, note);
    if (found) {
      const markerGuid = guid(found.guid);
      if (!markerGuid) throw new Error("Premiere 26.3 marker identifiers are required.");
      this.ledger.added(note.id, binding.bindingId, markerGuid);
      return { outcome: "found", markerGuid };
    }
    const prior = this.ledger.delivery(note.id);
    if (prior?.state === "added" || note.status === "added" || note.status === "removed_in_premiere") return { outcome: "undone" };
    return { outcome: prior?.state === "attempted" ? "uncertain" : "absent" };
  }

  async insertConfirmed(note: MarkerNote, placement: Placement, requireCurrent: () => void = () => {}): Promise<MarkerResult> {
    const binding = note.request.anchor.binding;
    if (note.status !== "dispatching" || !sameBinding(binding, placement.binding) || note.sequenceTicks !== placement.sequenceTicks) {
      throw new Error("This insertion does not match the editor's confirmed note and position.");
    }
    validTicks(placement.sequenceTicks, binding.timebaseTicks);
    const result = await this.reconcile(note);
    requireCurrent();
    if (result.outcome !== "absent") return result;
    const { project, sequence } = await this.exactTarget(binding);
    await this.validateClock(sequence, binding);
    const markers = await this.api.Markers.getMarkers(sequence);
    await this.exactTarget(binding);
    requireCurrent();
    if (this.ledger.delivery(note.id)) return this.reconcile(note);
    this.ledger.attempted(note.id, binding.bindingId);
    let applied = false;
    project.lockedAccess(() => {
      requireCurrent();
      // No asynchronous native lookup inside the project lock. Check the
      // resolved handles' synchronous properties again at the mutation edge.
      this.checkTarget(binding, project, sequence);
      // Recheck within the project lock. Other local requests must not create
      // a second marker while the durable queue waits for its acknowledgement.
      if (this.find(markers, note)) return;
      applied = project.executeTransaction(compound => {
        compound.addAction(markers.createAddMarkerAction(
          `Sauce Bunny · ${note.request.author}`.slice(0, 240), "Comment",
          this.api.TickTime.createWithTicks(placement.sequenceTicks), this.api.TickTime.createWithTicks("0"),
          `${note.request.author}\n${note.request.body}\n\nSauce Bunny live review; editor-confirmed position.\n${provenance(note.id)}`,
        ));
      }, "Add Sauce Bunny review note");
    });
    const found = this.find(markers, note);
    if (found) {
      const markerGuid = guid(found.guid);
      if (!markerGuid) throw new Error("Marker created, but its identifier was unavailable. Reconcile before retrying.");
      this.ledger.added(note.id, binding.bindingId, markerGuid);
      return { outcome: "found", markerGuid };
    }
    if (!applied) {
      this.ledger.notExecuted(note.id);
      throw new Error("Premiere declined the marker transaction. The review note remains saved.");
    }
    // A successful transaction with no matching marker is uncertain, never a
    // reason to run the action twice. Saving the Premiere project is separate.
    return { outcome: "uncertain" };
  }
}
