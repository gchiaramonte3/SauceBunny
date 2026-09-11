import { useEffect, type MutableRefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { currentPremiereRoomContext, premiereRoomReceipts, setPremiereRoomSource, subscribePremiereLink } from "../lib/premiere-link";
import type { SessionState } from "../bindings/SessionState";
import type { ReviewDoc } from "../lib/review";
import type { SessionSource } from "./use-co-review";

/** Publishes the host's authorized Premiere context and sanitized receipts.
 * Source/session revisions and native bridge state remain authoritative. */
export function usePremierePublication({ coSession, sessionSource, sessionDoc,
  coRoleRef, sessionDocRef, coSessionIdRef }: {
  coSession: SessionState;
  sessionSource: SessionSource;
  sessionDoc: ReviewDoc | null;
  coRoleRef: MutableRefObject<SessionState["role"]>;
  sessionDocRef: MutableRefObject<ReviewDoc | null>;
  coSessionIdRef: MutableRefObject<string>;
}) {
  useEffect(() => {
    if (coSession.role !== "host") return;
    setPremiereRoomSource(coSession.presenter === "m0" && sessionSource.kind === "ndi" && sessionSource.liveState !== "stopped" && sessionSource.url
      && /^[a-f0-9]{32}$/i.test(sessionSource.url)
      ? { reviewKey: sessionSource.reviewKey, programId: sessionSource.url, presenterEpoch: coSession.presenterEpoch } : null);
  }, [coSession.role, coSession.code, coSession.presenter, coSession.presenterEpoch,
    sessionSource.kind, sessionSource.url, sessionSource.reviewKey, sessionSource.liveState]);
  useEffect(() => {
    let disposed = false, scheduled = false, last = "";
    const publish = () => {
      if (scheduled || disposed) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        if (disposed || coRoleRef.current !== "host") return;
        const context = currentPremiereRoomContext(), doc = sessionDocRef.current;
        if (!context || !doc || doc.sourceKey !== context.reviewKey) { last = ""; return; }
        const messages = [context, ...premiereRoomReceipts(doc)];
        const key = JSON.stringify(messages);
        if (last === key) return;
        last = key;
        void (async () => {
          try {
            for (const message of messages) {
              if (disposed || coRoleRef.current !== "host" || context.sessionId !== coSessionIdRef.current
                || currentPremiereRoomContext()?.revision !== context.revision) return;
              await invoke("session_broadcast", { msg: { kind: "reviewOp", from: "", op: JSON.stringify(message) } });
            }
          } catch { last = ""; }
        })();
      });
    };
    const unsubscribe = subscribePremiereLink(publish);
    publish();
    // Recovery for a missed status packet; unchanged metadata is not resent.
    const timer = window.setInterval(publish, 2000);
    return () => { disposed = true; unsubscribe(); window.clearInterval(timer); };
  }, [coSession.role, coSession.code, sessionDoc, coRoleRef, sessionDocRef, coSessionIdRef]);
}
