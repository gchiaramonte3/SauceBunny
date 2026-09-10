// Only this independently identified fixture seeds preferences. Production
// startup, session hook, review UI, persistence, and transport are imported.
localStorage.setItem("cp-defaults-v2", JSON.stringify({ ytAuthOnboarded: true,
  keepStreamCopy: false, autoSaveReceived: false, stunUrl: "" }));
localStorage.setItem("saucebunny.welcomed", "1");
localStorage.setItem("saucebunny.permissioned", "1");
localStorage.setItem("saucebunny.review.author", JSON.stringify("Marker guest test"));
localStorage.setItem("saucebunny.mediaDevices", JSON.stringify({ cameraOff: true, micMuted: true }));
void import("../src/main");
