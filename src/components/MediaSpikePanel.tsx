import { useEffect, useRef, useState } from "react";

/**
 * DEV-ONLY capture spike (live-presence Prompt 0). Renders ONLY when
 * localStorage saucebunny.devMediaSpike === "1" — ships nothing user-visible.
 *
 * Proves camera+mic capture and in-page recording work in THIS app's
 * WKWebView before live presence is built on top. Run it in `tauri dev` AND
 * a built .app (TCC differs between the two) and record both results under
 * "Spike results" in _design/prompts-live-presence.md.
 *
 * Permission plumbing this spike rides on: NSCameraUsageDescription +
 * NSMicrophoneUsageDescription (Info.plist), device.camera + audio-input
 * entitlements (entitlements.plist). wry 0.55.1 implements WKUIDelegate's
 * requestMediaCapturePermission and grants when the plist keys exist (the
 * wry #1195 lineage), so no version bump is needed.
 */

type StepResult = { id: string; label: string; verdict: "pass" | "fail" | "skip" | "manual"; detail: string };

type Props = {
  appendLog: (tag: "info" | "ok" | "warn" | "err", channel: string, line: string) => void;
  onClose: () => void;
};

export function MediaSpikePanel({ appendLog, onClose }: Props) {
  const [results, setResults] = useState<StepResult[]>([]);
  const [running, setRunning] = useState(false);
  const previewRef = useRef<HTMLVideoElement>(null);
  const playbackRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const report = (r: StepResult) => {
    setResults((prev) => [...prev.filter((p) => p.id !== r.id), r]);
    appendLog(r.verdict === "fail" ? "err" : r.verdict === "pass" ? "ok" : "info", "media", `${r.label}: ${r.verdict} (${r.detail})`);
  };

  const stopStream = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  };
  useEffect(() => stopStream, []);

  const run = async () => {
    setRunning(true);
    setResults([]);
    try {
      // a. getUserMedia + live preview
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        streamRef.current = stream;
        if (previewRef.current) {
          previewRef.current.srcObject = stream;
          await previewRef.current.play().catch(() => undefined);
        }
        report({ id: "a", label: "a. getUserMedia + preview", verdict: "pass", detail: `${stream.getVideoTracks().length} video, ${stream.getAudioTracks().length} audio tracks` });
      } catch (e) {
        report({ id: "a", label: "a. getUserMedia + preview", verdict: "fail", detail: String(e) });
        setRunning(false);
        return; // everything below needs the stream
      }

      // b. enumerateDevices labels
      const devices = await navigator.mediaDevices.enumerateDevices();
      const cams = devices.filter((d) => d.kind === "videoinput");
      const mics = devices.filter((d) => d.kind === "audioinput");
      const labeled = [...cams, ...mics].every((d) => d.label.length > 0);
      report({ id: "b", label: "b. enumerateDevices labels", verdict: labeled ? "pass" : "fail", detail: `${cams.length} cameras, ${mics.length} mics, labels ${labeled ? "populated" : "EMPTY"}` });

      // c. device switch via deviceId
      if (cams.length > 1) {
        try {
          const other = cams.find((c) => c.deviceId !== stream.getVideoTracks()[0].getSettings().deviceId) ?? cams[1];
          const s2 = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: other.deviceId } } });
          s2.getTracks().forEach((t) => t.stop());
          report({ id: "c", label: "c. device switch", verdict: "pass", detail: `switched to ${other.label || other.deviceId.slice(0, 8)}` });
        } catch (e) {
          report({ id: "c", label: "c. device switch", verdict: "fail", detail: String(e) });
        }
      } else {
        report({ id: "c", label: "c. device switch", verdict: "skip", detail: "one camera present" });
      }

      // d. MediaRecorder 5s
      const rec = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      const stopped = new Promise<void>((res) => { rec.onstop = () => res(); });
      rec.start();
      await new Promise((res) => setTimeout(res, 5000));
      rec.stop();
      await stopped;
      const whole = new Blob(chunks, { type: rec.mimeType });
      const okD = whole.size > 10_000;
      report({ id: "d", label: "d. MediaRecorder 5s", verdict: okD ? "pass" : "fail", detail: `mimeType ${rec.mimeType || "(empty)"}, ${whole.size} bytes` });
      if (okD && playbackRef.current) {
        playbackRef.current.src = URL.createObjectURL(whole);
      }

      // d2. timeslice chunk-concat validity
      try {
        const rec2 = new MediaRecorder(stream);
        const parts: Blob[] = [];
        rec2.ondataavailable = (e) => { if (e.data.size) parts.push(e.data); };
        const stop2 = new Promise<void>((res) => { rec2.onstop = () => res(); });
        rec2.start(2000); // timeslice
        await new Promise((res) => setTimeout(res, 6500));
        rec2.stop();
        await stop2;
        const concat = new Blob(parts, { type: rec2.mimeType });
        // Validity check: decode the concatenated bytes in an offscreen <video>.
        const probe = document.createElement("video");
        probe.src = URL.createObjectURL(concat);
        const playable = await new Promise<boolean>((res) => {
          probe.onloadedmetadata = () => res(Number.isFinite(probe.duration) && probe.duration > 3);
          probe.onerror = () => res(false);
          setTimeout(() => res(false), 4000);
        });
        report({ id: "d2", label: "d2. timeslice concat plays", verdict: playable ? "pass" : "fail", detail: `${parts.length} chunks, ${concat.size} bytes, duration ${probe.duration.toFixed(1)}s. Crash-safe chunked recording ${playable ? "OK" : "NOT viable (prompt 3 must buffer whole-blob)"}` });
      } catch (e) {
        report({ id: "d2", label: "d2. timeslice concat plays", verdict: "fail", detail: String(e) });
      }

      // d3. AEC vs program audio: tone through speakers, record with and
      // without echoCancellation, compare recorded energy.
      try {
        const ac = new AudioContext();
        const osc = ac.createOscillator();
        osc.frequency.value = 440;
        const gain = ac.createGain();
        gain.gain.value = 0.25;
        osc.connect(gain).connect(ac.destination);
        osc.start();
        const recordRms = async (aec: boolean) => {
          const s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: aec, noiseSuppression: aec } });
          const src = ac.createMediaStreamSource(s);
          const an = ac.createAnalyser();
          an.fftSize = 2048;
          src.connect(an);
          await new Promise((res) => setTimeout(res, 2000));
          const buf = new Float32Array(an.fftSize);
          let sum = 0;
          for (let i = 0; i < 5; i++) {
            an.getFloatTimeDomainData(buf);
            sum += Math.sqrt(buf.reduce((acc, v) => acc + v * v, 0) / buf.length);
            await new Promise((res) => setTimeout(res, 200));
          }
          s.getTracks().forEach((t) => t.stop());
          return sum / 5;
        };
        const withAec = await recordRms(true);
        const withoutAec = await recordRms(false);
        osc.stop();
        void ac.close();
        const ratio = withoutAec > 0 ? withAec / withoutAec : 1;
        const verdict = ratio < 0.5 ? "pass" : "manual";
        report({ id: "d3", label: "d3. AEC cancels program audio", verdict, detail: `RMS with AEC ${withAec.toFixed(4)} vs without ${withoutAec.toFixed(4)} (ratio ${ratio.toFixed(2)}; <0.5 = substantially cancelled${verdict === "manual" ? ". NOT met: prompt 2 ships the headphones chip" : ""})` });
      } catch (e) {
        report({ id: "d3", label: "d3. AEC cancels program audio", verdict: "fail", detail: String(e) });
      }

      // e. RTCPeerConnection loopback + resolution cap
      try {
        const pc1 = new RTCPeerConnection();
        const pc2 = new RTCPeerConnection();
        stream.getTracks().forEach((t) => pc1.addTrack(t, stream));
        pc1.onicecandidate = (e) => { if (e.candidate) void pc2.addIceCandidate(e.candidate); };
        pc2.onicecandidate = (e) => { if (e.candidate) void pc1.addIceCandidate(e.candidate); };
        const gotTrack = new Promise<boolean>((res) => {
          pc2.ontrack = () => res(true);
          setTimeout(() => res(false), 5000);
        });
        const offer = await pc1.createOffer();
        await pc1.setLocalDescription(offer);
        await pc2.setRemoteDescription(offer);
        const answer = await pc2.createAnswer();
        await pc2.setLocalDescription(answer);
        await pc1.setRemoteDescription(answer);
        const connected = await new Promise<boolean>((res) => {
          const check = () => {
            if (pc1.connectionState === "connected") res(true);
            else if (["failed", "closed"].includes(pc1.connectionState)) res(false);
          };
          pc1.onconnectionstatechange = check;
          check();
          setTimeout(() => res(pc1.connectionState === "connected"), 6000);
        });
        const tracked = await gotTrack;
        let capDetail = "";
        try {
          const sender = pc1.getSenders().find((s) => s.track?.kind === "video");
          if (sender) {
            const params = sender.getParameters();
            params.encodings = params.encodings?.length ? params.encodings : [{}];
            params.encodings[0].scaleResolutionDownBy = 2;
            await sender.setParameters(params);
            const back = sender.getParameters().encodings?.[0]?.scaleResolutionDownBy;
            capDetail = `, scaleResolutionDownBy readback ${back}`;
          }
        } catch (e) {
          capDetail = `, setParameters FAILED: ${String(e)}`;
        }
        pc1.close();
        pc2.close();
        report({ id: "e", label: "e. RTC loopback + res cap", verdict: connected && tracked ? "pass" : "fail", detail: `connectionState ${connected ? "connected" : "never connected"}, tracks ${tracked ? "flowed" : "missing"}${capDetail}` });
      } catch (e) {
        report({ id: "e", label: "e. RTC loopback + res cap", verdict: "fail", detail: String(e) });
      }
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="cp-spike" role="dialog" aria-label="Media capture spike">
      <div className="cp-spike-head">
        <span className="cp-spike-title">Capture spike</span>
        <button type="button" className="btn btn-ghost" onClick={() => { stopStream(); onClose(); }}>Close</button>
      </div>
      <div className="cp-spike-body">
        <button type="button" className="btn btn-primary" disabled={running} onClick={() => void run()}>
          {running ? "Running…" : "Run all steps"}
        </button>
        <div className="cp-spike-videos">
          <video ref={previewRef} muted playsInline className="cp-spike-video" />
          <video ref={playbackRef} controls playsInline className="cp-spike-video" />
        </div>
        <ul className="cp-spike-list">
          {results.map((r) => (
            <li key={r.id} className={`cp-spike-row ${r.verdict}`}>
              <span className="cp-spike-verdict">{r.verdict.toUpperCase()}</span>
              <span className="cp-spike-label">{r.label}</span>
              <span className="cp-spike-detail">{r.detail}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
