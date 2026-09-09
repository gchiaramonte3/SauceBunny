/** Framing shared with the native encoder/peer transport. Complete, independent
 * fMP4 segments only; never discard arbitrary bytes from a compressed stream. */
export const MAX_PROGRAM_SEGMENT = 2 * 1024 * 1024;
export type ProgramPacket = { kind: 1 | 2 | 3; data: Uint8Array };

export type ProgramTimeRange = readonly [start:number,end:number];

/** Encoded output uses independent 100 ms segments, but native WebKit appends
 * have taken 268 ms in the running app. A 100 ms live-edge reserve repeatedly
 * drained into seeks instead of continuous picture/audio. A 600 ms cutoff
 * then caused 47 seeks in 20 seconds in WKWebView: the seek itself consumed
 * its small hysteresis. Leave room for delivery, append AND seek completion.
 * These are playback-buffer budgets, NOT end-to-end latency measurements. */
export function programCatchUpTarget(current:number,ranges:readonly ProgramTimeRange[],local:boolean,seeking:boolean):number|null {
  if(!Number.isFinite(current) || !ranges.length)return null;
  const [start,end]=ranges[ranges.length-1];
  if(!Number.isFinite(start) || !Number.isFinite(end) || end<=start)return null;
  // AAC packets can begin before the first video keyframe in a recovered
  // fragment. MSE reports that leading sliver as buffered even though a seek
  // there has no video to land on. Stay two output frames inside the range;
  // the reserve below prevents seeking into very short fragments at all.
  const safeStart=start+2/30;
  // A new disjoint range does not invalidate a seek inside an older range.
  // Only retarget when its actual target has been evicted (or is audio-only).
  if(seeking && ranges.some(([a,b])=>current>=a+2/30 && current<=b))return null;
  const reserve=local?0.50:0.60,maximum=local?1.50:2.00;
  // Do not chase a just-arrived fragment whose tail runs out before WebKit
  // can finish seeking. More complete segments continue to be appended.
  if(end-start+1e-6<reserve)return null;
  // At the live tail the media clock may be a few samples beyond the most
  // recent SourceBuffer range. Wait for more media; seeking BACK into the
  // reserve repeats picture/audio and does not repair an under-run.
  return current<safeStart || end-current>maximum ? Math.max(safeStart,end-reserve) : null;
}
export class ProgramPacketParser {
  private header = new Uint8Array(5);
  private headerBytes = 0;
  private payload: Uint8Array | null = null;
  private payloadBytes = 0;
  /** Browser reads can coalesce MANY valid segments. Bound each allocation,
   * not the network chunk, and yield immediately so the decoder can coalesce. */
  *push(chunk: Uint8Array): Generator<ProgramPacket> {
    let offset=0;
    while(offset<chunk.length) {
      if(this.headerBytes<5) {
        const size=Math.min(5-this.headerBytes,chunk.length-offset);
        this.header.set(chunk.subarray(offset,offset+size),this.headerBytes);
        this.headerBytes+=size;offset+=size;
        if(this.headerBytes<5)break;
        const kind=this.header[0],length=new DataView(this.header.buffer).getUint32(1);
        if((kind!==1&&kind!==2&&kind!==3)||length===0||length>MAX_PROGRAM_SEGMENT||(kind===3&&length>16384))throw new Error("Invalid program segment");
        this.payload=new Uint8Array(length);this.payloadBytes=0;
      }
      const payload=this.payload!;
      const size=Math.min(payload.length-this.payloadBytes,chunk.length-offset);
      payload.set(chunk.subarray(offset,offset+size),this.payloadBytes);
      this.payloadBytes+=size;offset+=size;
      if(this.payloadBytes===payload.length) {
        const kind=this.header[0] as ProgramPacket["kind"];
        this.headerBytes=0;this.payload=null;this.payloadBytes=0;
        yield {kind,data:payload};
      }
    }
  }
}
export class ProgramPacketQueue {
  private init: ProgramPacket | null=null;
  private media: ProgramPacket[]=[];
  push(packet: ProgramPacket) {
    if(packet.kind===3)return; // telemetry is consumed before the decoder queue
    if (packet.kind===1) { this.init=packet; this.media=[]; }
    // Eight whole fragments (nominally 800 ms, at most 16 MiB) absorb normal
    // native append delays. Two discarded audible media during 268-ms waits.
    // Sustained overload still drops only complete independent fragments.
    else { this.media.push(packet); if(this.media.length>8)this.media.shift(); }
  }
  shift(): ProgramPacket | undefined {
    if(this.init) { const init=this.init; this.init=null; return init; }
    return this.media.shift();
  }
  get length() { return Number(!!this.init)+this.media.length; }
}
