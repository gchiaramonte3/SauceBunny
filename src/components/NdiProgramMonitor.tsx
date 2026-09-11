import { forwardRef,useCallback,useEffect,useImperativeHandle,useRef,useState } from "react";
import { emptyNdiState,type NdiProgram,type NdiState } from "../hooks/use-ndi-input";
import { ProgramPacketParser,ProgramPacketQueue,programCatchUpTarget,type ProgramTimeRange } from "../lib/live-program-stream";
import { forgetPremiereFrame, recordPremiereFrame } from "../lib/premiere-frames";

type Attempt = { key:number; program:NdiProgram };
export type NdiProgramMonitorHandle = { retry:()=>void };
export type NdiProgramAudio = { muted:boolean;volume:number };
/** Local playback recovery, rendered by settings rather than over the picture. */
export type NdiPlaybackRecovery = { error:string|null; label:string; resume:()=>void };
type Props = {
  program:NdiProgram;state:NdiState;onFrameDecoded?:(id:string)=>void;onPictureFailed?:(id:string)=>void;
  /** The main room uses its existing transport; setup owns the expanded controls. */
  chrome?:boolean;active?:boolean;audio?:NdiProgramAudio;
  /** Decode a selected replacement underneath the retained previous surface. */
  pictureVisible?:boolean;
  onRecoveryChange?:(recovery:NdiPlaybackRecovery|null)=>void;
};
export const NdiProgramMonitor = forwardRef<NdiProgramMonitorHandle,Props>(function NdiProgramMonitor({program,state,onFrameDecoded,onPictureFailed,chrome=true,active=true,audio,pictureVisible=true,onRecoveryChange},ref) {
  const [attempts,setAttempts]=useState<Attempt[]>([{key:1,program}]);
  const [painted,setPainted]=useState<number|null>(null);
  const sequence=useRef(1),requested=useRef(1),displayed=useRef<number|null>(null);
  const latest=useRef(program);latest.current=program;
  const callbacks=useRef({onFrameDecoded,onPictureFailed});callbacks.current={onFrameDecoded,onPictureFailed};
  const restart=useCallback(()=>{
    const next={key:++sequence.current,program:latest.current};requested.current=next.key;
    setAttempts(old=>[...old.filter(a=>a.key===displayed.current),next]);
  },[]);
  useImperativeHandle(ref,()=>({retry:restart}),[restart]);
  const previousIdentity=useRef(`${program.id}:${program.url}`),previouslyStopped=useRef(!!program.stopped);
  useEffect(()=>{
    const identity=`${program.id}:${program.url}`;
    if(identity!==previousIdentity.current || (previouslyStopped.current && !program.stopped))restart();
    previousIdentity.current=identity;previouslyStopped.current=!!program.stopped;
  },[program.id,program.url,program.stopped,restart]);
  const decoded=useCallback((attempt:Attempt)=>{
    if(attempt.key!==requested.current || attempt.program.id!==latest.current.id)return;
    displayed.current=attempt.key;setPainted(attempt.key);setAttempts(old=>old.filter(a=>a.key===attempt.key));
    callbacks.current.onFrameDecoded?.(attempt.program.id);
  },[]);
  const failed=useCallback((attempt:Attempt)=>{
    if(attempt.key===requested.current)callbacks.current.onPictureFailed?.(attempt.program.id);
  },[]);
  const last=attempts.find(a=>a.key===painted);
  const waitingForPicture=state.sourceId===program.id && state.inputWidth>0 && state.inputHeight>0 && (state.inputWidth<16 || state.inputHeight<16);
  return <div className="cp-peerstage cp-ndi-monitor" aria-label={`NDI program: ${program.name}`} onClick={event=>event.stopPropagation()}
    style={pictureVisible?undefined:{background:"transparent",pointerEvents:"none"}}>
    {attempts.map(attempt=><NdiDecoder key={attempt.key} attempt={attempt} state={state}
      visible={pictureVisible && attempt.key===painted} controls={attempt.key===requested.current}
      chrome={chrome} active={active} audio={audio}
      onRecoveryChange={onRecoveryChange}
      stopped={!!program.stopped} onDecoded={decoded} onFailed={failed} onRetry={restart}/>)}
    {chrome && painted!==requested.current && <span className="cp-peerstage-badge" role="status">
      {program.name} · {program.stopped?"Sharing stopped":waitingForPicture?"Waiting for an NDI picture. Park inside the sequence.":"Connecting to NDI…"}{last?` · Last picture: ${last.program.name}`:""}
    </span>}
  </div>;
});

/** One decoder attempt. Old attempts stay mounted until replacement has a
 * decoded frame; retry never depends on a canvas snapshot being origin-clean. */
function NdiDecoder({attempt,state,visible,controls,stopped,onDecoded,onFailed,onRetry,chrome,active,audio,onRecoveryChange}:{
  attempt:Attempt;state:NdiState;visible:boolean;controls:boolean;stopped:boolean;
  chrome:boolean;active:boolean;audio?:NdiProgramAudio;
  onDecoded:(attempt:Attempt)=>void;onFailed:(attempt:Attempt)=>void;onRetry:()=>void;
  onRecoveryChange?:(recovery:NdiPlaybackRecovery|null)=>void;
}) {
  const program=attempt.program;
  const ref=useRef<HTMLVideoElement>(null);
  const [error,setError]=useState<string|null>(null);
  const [muted,setMuted]=useState(program.local);
  const [blocked,setBlocked]=useState(false);
  const [volume,setVolume]=useState(1);
  const [latency,setLatency]=useState<number|null>(null);
  const [receivedState,setReceivedState]=useState<NdiState|null>(null);
  const [painted,setPainted]=useState(false);
  const stopReader=useRef<(()=>void)|null>(null);
  const primed=useRef(false);
  const isStopped=useRef(stopped);isStopped.current=stopped;
  const displayedSurface=useRef({visible,active});displayedSurface.current={visible,active};
  const effectiveVolume=audio?.volume??volume;
  const effectiveMuted=(audio?.muted??muted)||!visible||!controls||stopped||!active;
  useEffect(()=>{if(ref.current)ref.current.volume=effectiveVolume;},[effectiveVolume]);
  useEffect(()=>{
    const video=ref.current;if(!video || !program.url || program.stopped)return;
    const mime='video/mp4; codecs="avc1.4d0028, mp4a.40.2"';
    if(typeof MediaSource==="undefined" || !MediaSource.isTypeSupported(mime)) {setError("This webview cannot play the encoded H.264/AAC program feed.");onFailed(attempt);return;}
    const abort=new AbortController(), ms=new MediaSource(), url=URL.createObjectURL(ms);
    stopReader.current=()=>{abort.abort();video.pause();};
    const queue=new ProgramPacketQueue(),parser=new ProgramPacketParser();
    let sb:SourceBuffer|undefined,disposed=false,failed=false,frameId=0,hasPicture=false;
    let initialized=false;primed.current=false;
    setError(null);setLatency(null);setReceivedState(null);setPainted(false);video.src=url;
    const updated=()=>{if(!disposed && !failed && !hasPicture && video.readyState>=2 && video.videoWidth>0){hasPicture=true;setPainted(true);onDecoded(attempt);}};
    const frameOwner=crypto.randomUUID();
    const frame=(_now:number,metadata:VideoFrameCallbackMetadata)=>{
      updated();
      // A hidden replacement decoder must not overwrite the moment the
      // reviewer actually sees. This is output PTS evidence, NOT sequence TC.
      if(!disposed && displayedSurface.current.visible && displayedSurface.current.active)
        recordPremiereFrame(program.id,frameOwner,metadata.mediaTime,metadata.presentedFrames);
      if(!disposed)frameId=video.requestVideoFrameCallback(frame);
    };
    if(video.requestVideoFrameCallback)frameId=video.requestVideoFrameCallback(frame);
    // loadeddata confirms decode when the compositor throttles an occluded
    // pending surface. timeupdate is the compatibility fallback only.
    video.addEventListener("loadeddata",updated);video.addEventListener("timeupdate",updated);
    // Catch-up can seek again before loadeddata is dispatched. A pending
    // hidden surface may not receive compositor callbacks, but seeked still
    // confirms the replacement frame once current data is available.
    video.addEventListener("seeked",updated);video.addEventListener("canplay",updated);
    const timer=window.setInterval(()=>{
      if(sb?.buffered.length) setLatency(Math.max(0,sb.buffered.end(sb.buffered.length-1)-video.currentTime));
    },1000);
    const fail=(error:unknown)=>{if(!disposed && !failed){failed=true;setError(error instanceof Error?error.message:String(error));onFailed(attempt);}};
    // A media-element decode failure need not also fire SourceBuffer.error.
    // Revoke picture readiness, but leave its current resource/frame mounted.
    const mediaError=()=>{
      const reason=video.error?.code===3?"Could not decode the program picture"
        :video.error?.code===4?"The program format is not supported by this webview":"Program playback stopped";
      fail(new Error(`${reason}. Reconnect the picture to retry.`));abort.abort();
    };
    video.addEventListener("error",mediaError);
    const pump=()=>{
      if(disposed || failed || isStopped.current || !sb || sb.updating)return;
      try {
        const ranges=sb.buffered;
        if(ranges.length) {
          const edge=ranges.end(ranges.length-1);
          if(ranges.start(0)<edge-3) {sb.remove(0,edge-2);return;}
        }
        const packet=queue.shift();
        if(packet) {if(packet.kind===1)initialized=true;if(!initialized)throw new Error("Missing program initialization segment");sb.appendBuffer(packet.data as Uint8Array<ArrayBuffer>);return;}
        // Drain available media first. Seeking before each queued append
        // delayed WebKit processing, dropped fragments, and chased the gaps.
        const buffered=Array.from({length:ranges.length},(_,i):ProgramTimeRange=>[ranges.start(i),ranges.end(i)]);
        if(!primed.current) {
          // Do not autoplay the very first 100 ms fragment and immediately
          // run out of sound. Prime once, even when output PTS starts at zero.
          const first=buffered.at(-1);
          const initial=first?programCatchUpTarget(first[0]-1,buffered,program.local,false):null;
          if(initial===null)return;
          video.currentTime=initial;primed.current=true;
          void video.play().then(()=>{if(!disposed)setBlocked(false);}).catch(()=>{if(!disposed)setBlocked(true);});
          return;
        }
        const target=programCatchUpTarget(video.currentTime,buffered,program.local,video.seeking);
        if(target!==null)video.currentTime=target;
      } catch(error){fail(error);abort.abort();}
    };
    const open=async()=>{
      try {
        if(disposed || failed)return;
        sb=ms.addSourceBuffer(mime);sb.mode="segments";sb.addEventListener("updateend",pump);
        sb.addEventListener("error",()=>{fail(new Error("Could not decode the program feed"));abort.abort();});
        const response=await fetch(program.url,{signal:abort.signal});
        if(!response.ok || !response.body)throw new Error(`Program feed unavailable (${response.status}). Check the host's NDI input.`);
        const reader=response.body.getReader();
        try {while(!disposed){const chunk=await reader.read();if(disposed || chunk.done)break;for(const packet of parser.push(chunk.value)) {
          if(packet.kind===3) {
            const telemetry={...emptyNdiState(),...JSON.parse(new TextDecoder().decode(packet.data))} as NdiState;
            if(telemetry.sourceId===program.id && ["connecting","live","stale","error"].includes(telemetry.phase))setReceivedState(telemetry);
          } else {queue.push(packet);pump();}
        }pump();}}
        finally {await reader.cancel().catch(()=>{});}
        if(!disposed && !abort.signal.aborted)fail(new Error("Program feed disconnected. The last decoded picture is retained."));
      } catch(error){if(!abort.signal.aborted)fail(error);}
    };
    ms.addEventListener("sourceopen",()=>{void open();},{once:true});
    return ()=>{disposed=true;forgetPremiereFrame(program.id,frameOwner);stopReader.current=null;abort.abort();window.clearInterval(timer);if(frameId)video.cancelVideoFrameCallback(frameId);
      video.removeEventListener("loadeddata",updated);video.removeEventListener("timeupdate",updated);video.removeEventListener("seeked",updated);video.removeEventListener("canplay",updated);video.removeEventListener("error",mediaError);if(sb)sb.removeEventListener("updateend",pump);video.pause();video.removeAttribute("src");video.load();URL.revokeObjectURL(url);};
  },[program.id,program.url,program.stopped,program.local,attempt,onDecoded,onFailed]);
  // Preview/volume consent belongs to App's single program-audio control.
  // WebKit may pause a muted autoplay element when it becomes audible; do
  // not leave that pause invisible behind an apparently unmuted speaker.
  useEffect(()=>{
    const video=ref.current;
    if(!video || !primed.current || effectiveMuted || stopped)return;
    let current=true;
    video.muted=false;
    void video.play().then(()=>{if(current)setBlocked(false);}).catch(()=>{if(current)setBlocked(true);});
    return ()=>{current=false;};
  },[effectiveMuted,stopped]);
  useEffect(()=>{if(stopped)stopReader.current?.();},[stopped]);
  useEffect(()=>{
    if(chrome || !active || !controls || !onRecoveryChange)return;
    onRecoveryChange(!stopped && (error || blocked) ? {
      error, label:effectiveMuted ? "Resume program monitor" : "Enable program audio",
      resume:()=>{void ref.current?.play().then(()=>setBlocked(false)).catch(()=>setBlocked(true));},
    } : null);
    return ()=>onRecoveryChange(null);
  },[chrome,active,controls,stopped,error,blocked,effectiveMuted,onRecoveryChange]);
  const toggleAudio=()=>{const next=!muted;setMuted(next);if(ref.current){ref.current.muted=next||!visible||!controls||stopped||!active;void ref.current.play().then(()=>setBlocked(false)).catch(()=>setBlocked(true));}};
  const mediaState=receivedState??(state.sourceId===program.id?state:emptyNdiState());
  const label=stopped?"Sharing stopped · last picture":error || mediaState.error || (mediaState.connectionCount===0?"Input disconnected · last picture"
    :mediaState.phase==="stale" ? mediaState.connectionCount?"Connected · picture parked":"No recent picture · checking input" : !painted ? "Connecting to NDI…" : "Live NDI");
  return <div className="cp-ndi-decoder-shell">
    <div className="cp-ndi-picture" style={{visibility:visible?"visible":"hidden"}}>
      <video ref={ref} className="cp-peerstage-video" playsInline muted={effectiveMuted}
        onPause={()=>{if(active&&visible&&controls&&!stopped)setBlocked(true);}}/>
      {chrome && controls && <span className="cp-peerstage-badge" role="status">{program.name} · {label}</span>}
    </div>
    {chrome && <div className="cp-ndi-audio-bar" style={{visibility:controls?"visible":"hidden"}}>
      <button type="button" onClick={toggleAudio} aria-pressed={!muted}>{muted?"Monitor program audio":"Mute program audio"}</button>
      <label>Program volume<input aria-label="Program volume" type="range" min={0} max={1} step={0.01} value={volume} onChange={e=>setVolume(Number(e.target.value))}/></label>
      <div className="cp-ndi-meters" aria-label="Program audio levels"><label>L<meter min={0} max={1} value={mediaState.leftPeak}/></label><label>R<meter min={0} max={1} value={mediaState.rightPeak}/></label></div>
      {blocked && <button type="button" onClick={()=>{void ref.current?.play().then(()=>setBlocked(false)).catch(()=>setBlocked(true));}}>{effectiveMuted ? "Resume program monitor" : "Enable program audio"}</button>}
      {error && !stopped && <button type="button" onClick={onRetry}>Reconnect picture</button>}
      <details className="cp-ndi-details"><summary>Connection details</summary>
        <p>{mediaState.inputWidth} × {mediaState.inputHeight} · input {mediaState.inputFps?.toFixed(3)??"unavailable"} fps · output {mediaState.outputFps.toFixed(1)} fps</p>
        <p>{mediaState.encodedBitrateKbps?.toLocaleString()??"unavailable"} kbps · drops NDI {mediaState.ndiDroppedFrames} · encoder {mediaState.encoderDroppedFrames} · audio samples {mediaState.encoderDroppedAudioSamples}</p>
        <p>Playback buffer {latency?.toFixed(2)??"unavailable"} s. This is not measured end-to-end delay.</p>
      </details>
      {error && !stopped && <span role="alert">{error}</span>}
    </div>}
  </div>;
}
