import { describe,expect,it } from "vitest";
import { MAX_PROGRAM_SEGMENT,ProgramPacketParser,ProgramPacketQueue,programCatchUpTarget } from "./live-program-stream";
function packet(kind:number,data:Uint8Array){const out=new Uint8Array(data.length+5);out[0]=kind;new DataView(out.buffer).setUint32(1,data.length);out.set(data,5);return out;}
describe("native encoded program framing",()=>{
  it("allows native append plus seek delay to settle without starting a catch-up loop",()=>{
    let current=0,pendingUntil=0,seeks=0;
    // SourceBuffer updateend is independent of decoded playback. Advancing
    // currentTime immediately after requesting a seek hid this regression.
    for(let step=1;step<=400;step++) {
      const now=step*0.05,edge=101.2+now;
      if(now>=pendingUntil)current+=0.05;
      const target=programCatchUpTarget(current,[[100,edge]],true,now<pendingUntil);
      if(target!==null){current=target;pendingUntil=now+0.4;seeks++;}
    }
    expect(seeks).toBe(1);
  });
  it("reserves playable media beyond measured WebKit append delays",()=>{
    expect(programCatchUpTarget(9.3,[[9,10]],true,false)).toBeNull();
    expect(programCatchUpTarget(9.3,[[9,10]],false,false)).toBeNull();
    expect(programCatchUpTarget(7,[[6,10]],false,false)).toBe(9.4);
    expect(programCatchUpTarget(8,[[7,10]],true,false)).toBe(9.5);
    expect(programCatchUpTarget(9.7,[[9,10]],true,false)).toBeNull();
  });
  it("never rewinds program audio when the clock reaches the live tail",()=>{
    for(const local of [true,false])for(const current of [10,10.001,10.033,10.5])
      expect(programCatchUpTarget(current,[[8,10]],local,false)).toBeNull();
  });
  it("does not supersede an outstanding catch-up seek on every append",()=>{
    expect(programCatchUpTarget(9.5,[[9,10]],true,true)).toBeNull();
    expect(programCatchUpTarget(0,[[9,10]],true,true)).toBe(9.5);
    expect(programCatchUpTarget(0,[[9,10]],true,false)).toBe(9.5);
    // A newer disjoint range does not invalidate a still-buffered seek.
    expect(programCatchUpTarget(9.5,[[9,10],[10.2,10.8]],true,true)).toBeNull();
    expect(programCatchUpTarget(9.5,[[10.2,10.8]],true,true)).toBe(10.3);
    expect(programCatchUpTarget(0,[],true,false)).toBeNull();
  });
  it("waits for a decode reserve before escaping a leading audio sliver",()=>{
    expect(programCatchUpTarget(12.017333,[[12.010666,12.117333]],true,true)).toBeNull();
    const target=programCatchUpTarget(12.017333,[[12.010666,12.610666]],true,true);
    expect(target).toBeGreaterThan(12.043333); // first 30-fps video keyframe
    expect(target).toBeLessThan(12.610666);
    expect(programCatchUpTarget(0,[[0,0]],true,false)).toBeNull();
    expect(programCatchUpTarget(NaN,[[0,1]],true,false)).toBeNull();
  });
  it("does not continually seek during a normally advancing 30-fps stream",()=>{
    let current=0,seeks=0;
    for(let frame=1;frame<=300;frame++) {
      const edge=frame/30;
      const target=programCatchUpTarget(current,[[0,edge]],true,false);
      if(target!==null){current=target;seeks++;}
      // Begin playback once the initial buffered-position seek is possible.
      if(seeks)current+=1/30;
    }
    expect(seeks).toBe(1);
    expect(current).toBeGreaterThan(9.5);
  });
  it("preserves ordinary append-delay bursts instead of dropping audio segments",()=>{
    const queue=new ProgramPacketQueue();
    for(let i=0;i<5;i++)queue.push({kind:2,data:new Uint8Array([i])});
    expect(Array.from({length:5},()=>queue.shift()?.data[0])).toEqual([0,1,2,3,4]);
  });
  it("reassembles headers and media split across arbitrary network reads",()=>{
    const parser=new ProgramPacketParser(),bytes=packet(2,new Uint8Array([10,20,30]));
    expect([...parser.push(bytes.slice(0,2))]).toEqual([]);expect([...parser.push(bytes.slice(2,6))]).toEqual([]);
    expect([...parser.push(bytes.slice(6))]).toEqual([{kind:2,data:new Uint8Array([10,20,30])}]);
  });
  it("rejects invalid tags, lengths and oversized telemetry before allocation",()=>{
    for(const [kind,length] of [[9,2],[2,MAX_PROGRAM_SEGMENT+1],[3,16385],[1,0]]){
      const header=new Uint8Array(5);header[0]=kind;new DataView(header.buffer).setUint32(1,length);
      expect(()=>[...new ProgramPacketParser().push(header)]).toThrow("Invalid program segment");
    }
  });
  it("accepts a browser read containing multiple large valid segments without concatenating them",()=>{
    const segment=packet(2,new Uint8Array(MAX_PROGRAM_SEGMENT));const read=new Uint8Array(segment.length*2);read.set(segment);read.set(segment,segment.length);
    const iterator=new ProgramPacketParser().push(read);expect(iterator.next().value?.data.length).toBe(MAX_PROGRAM_SEGMENT);expect(iterator.next().value?.data.length).toBe(MAX_PROGRAM_SEGMENT);expect(iterator.next().done).toBe(true);
  });
  it("bounds recovery to initialization and the newest eight complete media segments",()=>{
    const queue=new ProgramPacketQueue();queue.push({kind:1,data:new Uint8Array([1])});
    for(let i=0;i<1000;i++)queue.push({kind:2,data:new Uint8Array([i%256])});
    queue.push({kind:3,data:new Uint8Array([0])});
    expect(queue.length).toBe(9);expect(queue.shift()?.kind).toBe(1);
    expect(Array.from({length:8},()=>queue.shift()?.data[0])).toEqual(Array.from({length:8},(_,i)=>(992+i)%256));
    expect(queue.shift()).toBeUndefined();
  });
});
