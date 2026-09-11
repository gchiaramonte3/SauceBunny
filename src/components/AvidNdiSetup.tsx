import { useState } from "react";
import { CollapsibleSection } from "./CollapsibleSection";

/** Passive help only: no installation, discovery, capture, or publication. */
export function AvidNdiSetup() {
  const [open, setOpen] = useState(false);
  return <div className="cp-ndi-sender-setup">
    <CollapsibleSection id="ndi-avid-setup" label="Avid Media Composer setup" open={open} onToggle={() => setOpen(value => !value)}>
      <ol>
        <li>If NewTek NDI is absent, use the Media Composer installer’s NewTek NDI option. Avid must be activated and able to open a sequence.</li>
        <li>In Avid, right-click the HW/SW control, choose NewTek NDI (OpenIO_NDI), then enable the output. Play or park inside your sequence.</li>
        <li>Choose Refresh sources above, select the exact Avid feed, then Preview source. Use the existing speaker control to hear program audio.</li>
      </ol>
      <p>Use Ethernet where possible. Enabling Avid’s NDI output broadcasts onto your network; other NDI receivers may view or record it.</p>
      <p>Avid sequence timecode and live marker delivery are not connected. Use general notes or manually entered sequence timecode; Avid marker-file export is separate from live delivery.</p>
      <p>Compatibility is still being verified. Avid 2026.8 fixes NDI stopping after repeated HW/SW toggles. If output stops, check it in another NDI receiver and record your Avid version before attributing the failure to Sauce Bunny.</p>
    </CollapsibleSection>
  </div>;
}
