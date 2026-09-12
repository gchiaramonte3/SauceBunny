import { test,expect,type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createServer,type ServerResponse } from "node:http";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";
import { tauriMockInit } from "./tauri-mock";

const id="a".repeat(32);
type FileFixture = { url: string; size: number; duration: number; captions?: boolean };
async function expectPremiereReturnFocus(page:Page) {
  const connect=page.locator(".cp-connect-premiere");
  if(await connect.isVisible())await expect(connect).toBeFocused();
  else await expect(page.getByRole("button",{name:"Share",exact:true})).toBeFocused();
}
async function expectPassiveLiveStatus(page:Page) {
  const status=page.locator(".cp-transport .cp-source-status");
  await expect(status).toHaveText("Live");
  await expect(status).not.toHaveClass(/cp-tc/);
  await expect(status).toHaveCSS("border-top-width","0px");
  await expect(status).toHaveCSS("background-color","rgba(0, 0, 0, 0)");
  expect(await status.evaluate(element=>({tag:element.tagName,tabIndex:(element as HTMLElement).tabIndex,
    role:element.getAttribute("role")}))).toEqual({tag:"SPAN",tabIndex:-1,role:null});
  expect((await status.boundingBox())!.width).toBeLessThan(108);
}
async function expectRoomControlsInBounds(page:Page) {
  const main=page.locator(".cp-view-clip .cp-main"),bounds=(await main.boundingBox())!;
  const controls=main.locator(".cp-room-bar > button,.cp-volume > button");
  expect(await controls.count()).toBeGreaterThanOrEqual(8);
  for(const control of await controls.all()) {
    await expect(control).toBeVisible();
    const box=(await control.boundingBox())!,label=await control.getAttribute("aria-label");
    expect(box.x,label??"room control left").toBeGreaterThanOrEqual(bounds.x);
    expect(box.y,label??"room control top").toBeGreaterThanOrEqual(bounds.y);
    expect(box.x+box.width,label??"room control right").toBeLessThanOrEqual(bounds.x+bounds.width);
    expect(box.y+box.height,label??"room control bottom").toBeLessThanOrEqual(bounds.y+bounds.height);
  }
}
async function boot(page:Page,room=true,programUrl?:string,fileReview=false,fileFixture?:FileFixture,dimensions={width:1920,height:1080},name="Synthetic Premiere") {
  await page.addInitScript(tauriMockInit,EXPECTED_BACKEND_BUILD_ID);
  await page.addInitScript(({id,programUrl,room,fileFixture,dimensions,name})=>{
    localStorage.setItem("cp-defaults-v2",JSON.stringify({ytAuthOnboarded:true}));
    localStorage.setItem("saucebunny.welcomed","1");localStorage.setItem("saucebunny.permissioned","1");
    localStorage.setItem("saucebunny.review.author",JSON.stringify("Editor"));localStorage.setItem("e2e.avGranted","1");
    localStorage.setItem("e2e.files","{}");localStorage.setItem("saucebunny.queueDrawerActiveTab","review");
    if(fileFixture)localStorage.setItem("cp-logs-open","true");
    if(fileFixture?.captions) {
      const sourcePath="/e2e-mock/native-review-fixture.mp4",srtPath="/e2e-mock/native-review-fixture.srt";
      localStorage.setItem("cp-captions-on","true");
      localStorage.setItem("e2e.files",JSON.stringify({[srtPath]:"1\n00:00:00,000 --> 00:00:20,000\nFile review caption\n"}));
      localStorage.setItem("saucebunny.transcriptHistory",JSON.stringify([{id:"fixture-transcript",sourcePath,srtPath,
        sourceUrl:null,title:"File review caption",origin:"whisper",createdAt:1,lastOpenedAt:1}]));
      localStorage.setItem("saucebunny.sourceMarks",JSON.stringify({[sourcePath]:{inFrames:30,outFrames:90}}));
    }
    const w=window as unknown as {__TAURI_INTERNALS__:{invoke:(c:string,a?:unknown)=>Promise<unknown>};__ndiCalls:string[]};
    w.__ndiCalls=[];const original=w.__TAURI_INTERNALS__.invoke;let started=false;
    const program={id,name,url:programUrl??`http://127.0.0.1:51730/ndi-fixture/${id}`};
    const telemetry={sourceId:id,phase:"live",error:null,inputWidth:dimensions.width,inputHeight:dimensions.height,outputFps:30,inputFps:30,
      connectionCount:1,receivedFrames:60,ndiDroppedFrames:0,encoderDroppedFrames:0,encoderDroppedAudioSamples:0,
      leftPeak:0,rightPeak:0,lastInputAgeMs:0,encodedBitrateKbps:6000};
    w.__TAURI_INTERNALS__.invoke=(c,a)=>{
      if(fileFixture) {
        const path="/e2e-mock/native-review-fixture.mp4";
        const args=a as {path?:string;offset?:number;length?:number}|undefined;
        if(c==="plugin:dialog|open") {
          const cancel=localStorage.getItem("e2e.cancelNextFile")==="1";
          localStorage.removeItem("e2e.cancelNextFile");
          return Promise.resolve(cancel?null:path);
        }
        if(c==="probe_local_file")return Promise.resolve({path,filename:"native-review-fixture.mp4",size_bytes:fileFixture.size,
          duration:fileFixture.duration,width:1920,height:1080,fps:30,vcodec:"h264",acodec:"aac",has_video:true,has_audio:true});
        if(args?.path===path && c==="get_file_size")return Promise.resolve(fileFixture.size);
        if(args?.path===path && c==="read_file_range") {
          const start=args.offset??0,end=Math.min(fileFixture.size,start+(args.length??fileFixture.size))-1;
          return fetch(fileFixture.url,{headers:{Range:`bytes=${start}-${end}`}}).then(response=>{
            if(!response.ok)throw new Error(`Fixture read failed: ${response.status}`);
            return response.arrayBuffer();
          });
        }
      }
      if(c.startsWith("ndi_"))w.__ndiCalls.push(c);
      if(c==="ndi_sessions")return Promise.resolve({programs:started?[{program,telemetry,encodedReady:true,roomGeneration:1}]:[],
        room:room?{generation:1,presenterEpoch:0,presenting:true,publishedId:null,publicationRevision:null,source:null}:null});
      if(c==="ndi_status")return Promise.resolve({program:started?program:null,telemetry,encodedReady:started,roomGeneration:1});
      if(c==="ndi_preflight")return Promise.resolve({bridgeCompiled:true,runtime:"ready",runtimeVersion:"NDI synthetic test",runtimeOrigin:"bundled",premiereInstalled:true,premiereVersion:"26.3.2",pluginInstalled:true,error:null});
      if(c==="ndi_discover")return Promise.resolve({bridgeCompiled:true,runtime:"ready",runtimeVersion:"NDI synthetic test",error:null,sources:[{name}]});
      if(c==="ndi_start"){started=true;return Promise.resolve(program);}
      if(c==="ndi_publish")return Promise.resolve(1);
      if(c==="ndi_unpublish")return Promise.resolve(null);
      if(c==="ndi_stop")return Promise.resolve(null);
      return original(c,a);
    };
  },{id,programUrl,room,fileFixture,dimensions,name});
  await page.goto("/");await expect(page.locator(".cp-view-home")).toBeVisible();
  if(fileFixture){
    await page.keyboard.press("Meta+3");
    await page.getByRole("button",{name:"Import",exact:true}).click();
    await expect(page.locator(".cp-local-media canvas")).toBeVisible();
  }else if(fileReview){
    await page.keyboard.press("Meta+3");
    await page.locator("input[placeholder^='Paste a video URL']").fill("https://youtube.com/watch?v=aaaa");
    await page.getByRole("button",{name:/^Fetch/}).click();
    await expect(page.locator(".cp-timeline-hint")).toContainText("No marks set");
  }
  await page.locator(".cp-nav-item").filter({hasText:"Review"}).first().click();
  if(!room)return;
  await page.evaluate(()=>{(window as unknown as {__TAURI_MOCK__:{emitTauriEvent:(e:string,p:unknown)=>void}}).__TAURI_MOCK__.emitTauriEvent("session:state",{
    role:"host",code:"ndi-test-room",selfId:"m0",presenter:"m0",presenterEpoch:0,peers:[],title:"NDI review",error:null,
  });});
  await expect(page.locator(".cp-room-head")).toBeVisible();
  await page.getByRole("button",{name:"Share",exact:true}).click();
  await page.getByRole("menuitem",{name:/Source settings/}).click();
}

for (const scale of [1, 1.25]) test(`Avid setup stays in the gear dialog at 1100px / ${scale * 100}% text`, async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 700 });
  await boot(page, false, undefined, false, undefined, { width: 1920, height: 1080 }, "EDIT-SUITE (Avid Media Composer)");
  await page.evaluate(scale => {
    const root = document.documentElement, css = getComputedStyle(root);
    const values = ["--text-xs", "--text-sm", "--text-base", "--text-md", "--text-lg", "--text-xl", "--text-2xl"]
      .map(token => [token, `${parseFloat(css.getPropertyValue(token)) * scale}px`]);
    for (const [token, value] of values) root.style.setProperty(token, value);
  }, scale);
  const monitor = page.locator(".cp-view-clip .cp-monitor");
  await monitor.evaluate(element => element.setAttribute("data-avid-stage", "retained"));
  const trigger = page.getByRole("button", { name: "Source settings", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "NDI settings" });
  await dialog.getByRole("button", { name: "Avid Media Composer setup" }).click();
  await expect(dialog.getByText(/Avid sequence timecode and live marker delivery are not connected/)).toBeVisible();
  await expect(dialog.getByText(/other NDI receivers may view or record/)).toBeVisible();
  await expect(dialog.getByRole("option", { name: "EDIT-SUITE (Avid Media Composer)" })).toHaveCount(1);
  await expect(page.locator(".cp-queue-drawer .cp-ndi-input")).toHaveCount(0);
  const box = (await dialog.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0); expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(1100); expect(box.y + box.height).toBeLessThanOrEqual(700);
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  const setup = dialog.getByRole("button", { name: "Avid Media Composer setup" });
  await expect(setup).toHaveCSS("padding-left", "0px");
  await dialog.getByText(/Avid sequence timecode and live marker delivery are not connected/).scrollIntoViewIfNeeded();
  await expect(dialog.getByText(/Avid sequence timecode and live marker delivery are not connected/)).toBeInViewport();
  await page.screenshot({ path: test.info().outputPath("avid-ndi-setup.png") });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0); await expect(trigger).toBeFocused();
  await expect(monitor).toHaveAttribute("data-avid-stage", "retained");
  const calls = await page.evaluate(() => (window as unknown as { __ndiCalls: string[] }).__ndiCalls);
  expect(calls).not.toContain("ndi_start"); expect(calls).not.toContain("ndi_publish"); expect(calls).not.toContain("ndi_stop");
});

test("the Preview transport opens private Premiere controls without opening a room",async({page})=>{
  await boot(page,false);
  const trigger=page.locator(".cp-connect-premiere");
  await expect(trigger).toBeVisible();
  await expect(trigger).toBeEnabled();
  await expect(trigger).toHaveAccessibleName("Source settings");
  await expect(trigger).toHaveClass("cp-icon-btn cp-connect-premiere");
  await expect(trigger).toHaveAttribute("aria-haspopup","dialog");
  await expect(trigger).toHaveAttribute("aria-expanded","false");
  for(const size of [{width:1100,height:700},{width:1680,height:1020}]) {
    await page.setViewportSize(size);
    const box=(await trigger.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(24);
    expect(box.width).toBeGreaterThanOrEqual(24);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x+box.width).toBeLessThanOrEqual(size.width);
    expect(box.y+box.height).toBeLessThanOrEqual(size.height);
    const volume=(await page.locator(".cp-transport .cp-volume > button").boundingBox())!;
    expect(box.x-(volume.x+volume.width)).toBeGreaterThanOrEqual(8);
    expect(box.x-(volume.x+volume.width)).toBeLessThanOrEqual(12);
    expect(Math.abs(box.y-volume.y)).toBeLessThanOrEqual(2);
    for(const [name,width,height] of [["Step back one frame",34,34],["Play",46,36],["Step forward one frame",34,34]] as const) {
      const transportBox=(await page.getByRole("button",{name,exact:true}).boundingBox())!;
      expect(transportBox.width).toBe(width);expect(transportBox.height).toBe(height);
    }
  }
  const monitor=page.locator(".cp-view-clip .cp-monitor");
  await monitor.evaluate(element=>element.setAttribute("data-preview-stage","same"));
  await trigger.focus();await trigger.press("Enter");
  await expect(page.getByRole("main",{name:"Review preview"})).toHaveCount(0);
  await expect(page.getByRole("main",{name:"Review",exact:true})).toBeVisible();
  await expect(page.locator(".cp-room")).toHaveCount(0);
  await expect(page.locator('.cp-nav-item.active')).toContainText("Review");
  const panel=page.getByRole("dialog",{name:"NDI settings"});
  await expect(panel).toBeVisible();
  await expect(trigger).toHaveAttribute("aria-expanded","true");
  expect(await trigger.getAttribute("aria-controls")).toBe(await panel.getAttribute("id"));
  expect(await panel.getAttribute("id")).toBeTruthy();
  await expect(panel).toBeFocused();
  await expect(panel).toHaveCSS("outline-style", "solid");
  await expect(panel).toHaveCSS("outline-width", "1px");
  await expect(panel).toHaveCSS("outline-color", "rgba(255, 255, 255, 0.45)");
  await expect(page.locator(".cp-queue-drawer .cp-ndi-input")).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await page.keyboard.press("Shift+Tab");
  await expect(panel.getByRole("button",{name:"Install or set up Premiere…"})).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(panel.getByRole("button",{name:"Close NDI settings"})).toBeFocused();
  await expect(monitor).toHaveAttribute("data-preview-stage","same");
  expect(await page.evaluate(()=>(window as unknown as {__ndiCalls:string[]}).__ndiCalls.includes("ndi_start"))).toBe(false);
  expect(await page.evaluate(()=>(window as unknown as {__ndiCalls:string[]}).__ndiCalls.includes("ndi_publish"))).toBe(false);
  // An empty Preview already shows setup. Opening settings must not replace
  // that rail with an empty notes panel or introduce a redundant setup toggle.
  await expect(page.getByRole("region",{name:"Session setup",exact:true})).toBeVisible();
  await expect(page.getByRole("button",{name:"Session setup…",exact:true})).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(panel).not.toBeVisible();
  await expect(trigger).toHaveAttribute("aria-expanded","false");
  await expectPremiereReturnFocus(page);
  await trigger.press("Space");
  await expect(panel).toBeVisible();
  await expect(trigger).toHaveAttribute("aria-expanded","true");
  await panel.getByRole("button",{name:"Close NDI settings"}).click();
  await expect(panel).not.toBeVisible();
  await expectPremiereReturnFocus(page);
  await page.getByRole("button",{name:"Clip",exact:true}).click();
  await expect(page.getByRole("main",{name:"Clip",exact:true})).toBeVisible();
  await expect(page.getByRole("button",{name:/Connect Premiere/})).toHaveCount(0);
});

test("connection panel fits the minimum window and restores keyboard focus on Escape",async({page})=>{
  await page.setViewportSize({width:1100,height:700});
  await boot(page,false);
  await page.screenshot({path:test.info().outputPath("review-setup-inline-1100.png")});
  await page.setViewportSize({width:1680,height:1020});
  await page.screenshot({path:test.info().outputPath("review-setup-inline-1680.png")});
  await page.setViewportSize({width:1100,height:700});
  await page.locator(".cp-connect-premiere").click();
  const panel=page.getByRole("dialog",{name:"NDI settings"});
  await expect(panel).toBeVisible();
  const bounds=await panel.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.x+bounds!.width).toBeLessThanOrEqual(1100);
  expect(bounds!.y+bounds!.height).toBeLessThanOrEqual(700);
  await page.keyboard.press("Escape");
  await expect(panel).not.toBeVisible();
  await expectPremiereReturnFocus(page);
});

test("private Premiere keeps the real review tabs, saved notes, refresh, and Settings navigation",async({page})=>{
  await page.emulateMedia({reducedMotion:"reduce"});
  await page.route("**/ndi-fixture/**",route=>route.fulfill({status:503,body:"Synthetic source unavailable"}));
  await boot(page,false);
  const trigger=page.locator(".cp-connect-premiere");
  await trigger.click();
  const discoveries=()=>page.evaluate(()=>(window as unknown as {__ndiCalls:string[]}).__ndiCalls.filter(c=>c==="ndi_discover").length);
  const first=await discoveries();
  await page.keyboard.press("Escape");
  await trigger.click();
  await expect.poll(discoveries).toBeGreaterThan(first);
  await expect(page.locator(".cp-ndi-input .cp-premiere-beta")).toHaveText("Beta");
  await expect(page.locator(".cp-ndi-input details")).toHaveCount(0);
  await page.getByRole("combobox",{name:"NDI source"}).selectOption("Synthetic Premiere");
  await page.getByRole("button",{name:"Preview source"}).click();
  const inspector=page.getByRole("dialog",{name:"NDI settings"});
  await expect(inspector.getByRole("heading",{name:"NDI",exact:true})).toBeVisible();
  const topTabs=page.getByRole("tablist",{name:"Right panel sections"});
  const tabBounds=(await topTabs.boundingBox())!;
  // Source settings are a portal, never an inserted section in the note rail.
  await expect(page.locator(".cp-queue-drawer .cp-ndi-input")).toHaveCount(0);
  await inspector.locator(".cp-ndi-input-body").evaluate(element=>{element.scrollTop=element.scrollHeight;});
  expect((await topTabs.boundingBox())!.y).toBe(tabBounds.y);
  for(const label of ["Review","Transcript","AI Summary","Queue"]) {
    await expect(topTabs.getByRole("tab",{name:label,exact:true})).toBeInViewport();
  }
  await inspector.getByRole("button",{name:"Done",exact:true}).click();
  const comment=page.getByRole("textbox",{name:"Comment",exact:true});
  await expect(comment).toBeEnabled();
  await comment.fill("A private Premiere note");
  await comment.evaluate(element=>element.setAttribute("data-draft-identity","same"));
  const drawer=page.locator(".cp-queue-drawer.room"),drawerBounds=await drawer.boundingBox();
  await trigger.click();
  const marker=(await inspector.getByRole("button",{name:"Premiere marker setup…"}).boundingBox())!;
  const reconnect=(await inspector.getByRole("button",{name:"Reconnect picture"}).boundingBox())!;
  expect(reconnect.y-(marker.y+marker.height)).toBeGreaterThanOrEqual(12);
  await inspector.getByRole("button",{name:"Done",exact:true}).click();
  expect(await drawer.boundingBox()).toEqual(drawerBounds);
  await expect(comment).toHaveAttribute("data-draft-identity","same");
  await expect(comment).toHaveValue("A private Premiere note");
  const tabs=page.getByRole("tablist",{name:"Right panel sections"});
  for(const label of ["Transcript","AI Summary","Queue","Review"]) {
    await tabs.getByRole("tab",{name:label,exact:true}).click();
    await expect(tabs.getByRole("tab",{name:label,exact:true})).toHaveAttribute("aria-selected","true");
  }
  await expect(comment).toHaveValue("A private Premiere note");
  await page.getByRole("button",{name:"Post",exact:true}).click();
  await expect(page.locator(".cp-review-comment").filter({hasText:"A private Premiere note"})).toBeVisible();
  const receiver=page.locator(".cp-peerstage-video");
  await receiver.evaluate(element=>element.setAttribute("data-note-preview","same"));
  await page.getByRole("button",{name:"Session setup…",exact:true}).click();
  await expect(page.getByRole("button",{name:"Start session",exact:true})).toBeVisible();
  await page.getByRole("button",{name:"Review notes",exact:true}).click();
  await expect(receiver).toHaveAttribute("data-note-preview","same");
  await expect(page.locator(".cp-review-comment").filter({hasText:"A private Premiere note"})).toBeVisible();
  await expect(page.getByRole("button",{name:"Play",exact:true})).toHaveCount(0);
  await expect(page.locator(".cp-transport .cp-volume")).toHaveCount(1);
  await expect(page.locator(".cp-transport .cp-volume > button")).toHaveAccessibleName("Volume");
  await trigger.click();
  await inspector.getByRole("button",{name:"Install or set up Premiere…"}).click();
  const settings=page.getByRole("dialog");
  await expect(settings).toBeVisible();
  await expect(settings.getByRole("region",{name:"Premiere integration"})).toBeVisible();
  await expect(settings.getByRole("button",{name:"Download NDI Tools for Premiere"})).toBeVisible();
  await expect(settings.getByText("Connection details",{exact:true})).toBeVisible();
  expect(await page.evaluate(()=>(window as unknown as {__ndiCalls:string[]}).__ndiCalls.includes("ndi_publish"))).toBe(false);
});

test("opening a file before hosting keeps the existing Preview workspace",async({page})=>{
  await boot(page,false);
  await page.evaluate(()=>{
    const w=window as unknown as {__TAURI_INTERNALS__:{invoke:(c:string,a?:unknown)=>Promise<unknown>}};
    const original=w.__TAURI_INTERNALS__.invoke,path="/e2e-mock/standalone-preview.mp4";
    w.__TAURI_INTERNALS__.invoke=(command,args)=>{
      if(command==="plugin:dialog|open")return Promise.resolve(path);
      if(command==="probe_local_file")return Promise.resolve({path,filename:"standalone-preview.mp4",size_bytes:16,
        duration:10,width:1920,height:1080,fps:30,vcodec:"h264",acodec:null,has_video:true,has_audio:false});
      if(command==="get_file_size")return Promise.resolve(16);
      if(command==="read_file_range")return Promise.resolve(new Uint8Array(16).buffer);
      return original(command,args);
    };
  });
  const monitor=page.locator(".cp-view-clip .cp-monitor");
  await monitor.evaluate(element=>element.setAttribute("data-standalone-preview","same"));
  await page.getByRole("button",{name:"File",exact:true}).click();
  await expect(page.getByRole("button",{name:"Clear",exact:true})).toBeVisible();
  await expect(page.getByRole("main",{name:"Review",exact:true})).toBeVisible();
  await expect(page.locator(".cp-nav-item.active")).toContainText("Review");
  await expect(monitor).toHaveAttribute("data-standalone-preview","same");
  await expect(page.locator(".cp-room")).toHaveCount(0);
});

for(const size of [{width:1100,height:700},{width:1680,height:1020}]){
  test(`private testing preserves file-room layout and note composition at ${size.width}px`,async({page})=>{
    await page.setViewportSize(size);
    await page.route("**/ndi-fixture/**",route=>route.fulfill({status:503,body:"Synthetic source unavailable"}));
    await boot(page,true,undefined,true);
    await page.keyboard.press("Escape");
    await expectPremiereReturnFocus(page);
    await expectRoomControlsInBounds(page);
    const geometry=()=>page.locator(".cp-room-head,.cp-view-clip .cp-monitor,.cp-transport,.cp-timeline,.cp-queue-drawer.room,.cp-people:not(.strip)").evaluateAll(elements=>elements.map(el=>{
      const {x,y,width,height}=el.getBoundingClientRect();return {x,y,width,height};
    }));
    const before=await geometry();
    await page.screenshot({path:test.info().outputPath(`review-before-private-${size.width}.png`)});
    const comment=page.getByRole("textbox",{name:"Comment",exact:true});
    await expect(comment).toBeEnabled();await comment.fill("Keep this file note");
    await page.getByRole("button",{name:"Share",exact:true}).click();await page.getByRole("menuitem",{name:/Source settings/}).click();
    await page.getByRole("combobox",{name:"NDI source"}).selectOption("Synthetic Premiere");
    await page.getByRole("button",{name:"Preview source"}).click();
    await page.getByRole("button",{name:"Done",exact:true}).click();
    // Closing source controls is not a source switch. Return explicitly.
    await expect(comment).toHaveValue("Keep this file note");
    await page.getByRole("button",{name:"Return to room",exact:true}).click();
    await expect.poll(geometry).toEqual(before);
    await expectRoomControlsInBounds(page);
    await expect(comment).toBeEnabled();await expect(comment).toHaveValue("Keep this file note");
    await comment.press("Enter");await expect(page.locator(".cp-review-comment").filter({hasText:"Keep this file note"})).toBeVisible();
    await expect(page.locator(".cp-monitor .cp-ndi-monitor")).toHaveCount(1);
    await expect(page.locator(".cp-monitor .cp-ndi-monitor")).not.toBeVisible();
    await page.screenshot({path:test.info().outputPath(`review-after-private-${size.width}.png`)});
    // Theater remains reachable at the same window size, without forcing a
    // click through clipped controls or expanding the window first.
    await page.getByRole("button",{name:"Theater: widen the stage"}).click();
    await expect(page.locator(".cp-body.cp-room-theater")).toBeVisible();
    await expectRoomControlsInBounds(page);
    await page.screenshot({path:test.info().outputPath(`review-theater-${size.width}.png`)});
  });
}

for(const viewport of [{width:1100,height:700},{width:1680,height:1020}]) for(const scale of [1,1.25]) {
  test(`NDI settings stays outside comments with clear spacing at ${viewport.width}px / ${scale}`,async({page})=>{
    await page.setViewportSize(viewport);
    await page.emulateMedia({reducedMotion:"reduce"});
    await page.route("**/ndi-fixture/**",route=>route.fulfill({status:503,body:"Synthetic source unavailable"}));
    const name="EDIT-SUITE-MAC-STUDIO.LOCAL (Adobe Premiere Pro) · Very long sequence source name";
    await boot(page,false,undefined,false,undefined,undefined,name);
    if(scale!==1)await page.evaluate(scale=>{
      const tokens=["--text-xs","--text-sm","--text-base","--text-md","--text-lg","--text-xl","--text-2xl"];
      const css=getComputedStyle(document.documentElement);
      const values=tokens.map(token=>[token,`${parseFloat(css.getPropertyValue(token))*scale}px`]);
      for(const [token,value] of values)document.documentElement.style.setProperty(token,value);
    },scale);
    const head=(await page.locator(".cp-preview-head").boundingBox())!;
    const stage=(await page.locator(".cp-monitor-wrap").boundingBox())!;
    expect(stage.y-head.y-head.height).toBeGreaterThanOrEqual(12);
    const link=(await page.getByPlaceholder("Paste a link to watch together").boundingBox())!;
    expect(head.y+head.height-link.y-link.height).toBeGreaterThanOrEqual(12);
    await page.getByRole("button",{name:"Source settings",exact:true}).click();
    const dialog=page.getByRole("dialog",{name:"NDI settings"});
    await dialog.getByRole("combobox",{name:"NDI source"}).selectOption(name);
    await dialog.getByRole("button",{name:"Preview source"}).click();
    await expect(dialog.locator(".cp-ndi-input-connection > strong")).toHaveText(name);
    const box=(await dialog.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(16);expect(box.y).toBeGreaterThanOrEqual(16);
    expect(box.x+box.width).toBeLessThanOrEqual(viewport.width-16);
    expect(box.y+box.height).toBeLessThanOrEqual(viewport.height-16);
    expect(await dialog.evaluate(el=>el.scrollWidth-el.clientWidth)).toBeLessThanOrEqual(1);
    const sourceLabel=(await dialog.getByText("NDI source",{exact:true}).boundingBox())!;
    const refresh=(await dialog.getByRole("button",{name:"Refresh sources"}).boundingBox())!;
    expect(refresh.x-sourceLabel.x-sourceLabel.width).toBeGreaterThanOrEqual(12);
    const marker=(await dialog.getByRole("button",{name:"Premiere marker setup…"}).boundingBox())!;
    const retry=(await dialog.getByRole("button",{name:"Reconnect picture"}).boundingBox())!;
    expect(retry.y-marker.y-marker.height).toBeGreaterThanOrEqual(12);
    await page.screenshot({path:test.info().outputPath("ndi-settings-popup.png")});
    await dialog.getByRole("button",{name:"Done",exact:true}).click();
    await expectPremiereReturnFocus(page);
    const drawer=page.locator(".cp-queue-drawer.room");
    await expect(drawer.locator(".cp-ndi-input")).toHaveCount(0);
    await expect(drawer.getByRole("textbox",{name:"Comment",exact:true})).toBeVisible();
    await expect(drawer.getByRole("button",{name:"Post",exact:true})).toBeInViewport();
    for(const label of ["Review","Transcript","AI Summary","Queue"]) {
      await expect(drawer.getByRole("tab",{name:label,exact:true})).toBeInViewport();
    }
    const picture=page.locator(".cp-view-clip .cp-monitor"),pictureBox=(await picture.boundingBox())!;
    const notesBox=(await drawer.boundingBox())!;
    expect(pictureBox.x+pictureBox.width).toBeLessThanOrEqual(notesBox.x);
    await expect(page.getByRole("button",{name:"Source settings",exact:true})).toBeInViewport();
    await expect(picture.locator(".cp-peerstage-badge,.cp-preview-picture-status")).toHaveCount(0);
    const status=(await page.locator(".cp-ndi-publication").boundingBox())!;
    const timecode=page.getByRole("status",{name:"Timeline timecode unavailable"});
    await expect(timecode).toHaveText("--:--:--:--");
    const tc=(await timecode.boundingBox())!;
    expect(status.y+status.height).toBeLessThanOrEqual(pictureBox.y);
    expect(tc.y+tc.height).toBeLessThanOrEqual(pictureBox.y);
    expect(Math.abs(tc.x+tc.width/2-pictureBox.x-pictureBox.width/2)).toBeLessThanOrEqual(1);
    const timing=(await page.getByText("Timeline timecode unavailable",{exact:true}).boundingBox())!;
    const playback=(await page.getByText("Playback controlled at source",{exact:true}).boundingBox())!;
    expect(Math.abs(timing.y-playback.y)).toBeLessThanOrEqual(1);
    expect(playback.x+playback.width).toBeLessThanOrEqual(stage.x+stage.width);
    await expect(page.locator(".cp-timeline-hint")).toHaveCount(0);
    await page.screenshot({path:test.info().outputPath("ndi-comments-sidebar.png")});
  });
}

test("portrait Premiere input sizes the monitor without pretending to have sequence timecode",async({page})=>{
  await page.route("**/ndi-fixture/**",route=>route.fulfill({status:503,body:"Synthetic source not running"}));
  await boot(page,false,undefined,false,undefined,{width:720,height:1280});
  await page.locator(".cp-connect-premiere").click();
  await page.getByRole("combobox",{name:"NDI source"}).selectOption("Synthetic Premiere");
  await page.getByRole("button",{name:"Preview source"}).click();
  const monitor=page.locator(".cp-view-clip .cp-monitor");
  await expect.poll(async()=>{ const rect=(await monitor.boundingBox())!;return Math.abs(rect.width/rect.height-720/1280); }).toBeLessThan(.01);
  await expect(page.getByText("Timeline timecode unavailable",{exact:true})).toBeVisible();
  await expect(page.locator(".cp-transport .cp-tc")).toHaveCount(0);
  await expect(page.locator(".cp-transport .cp-volume")).toHaveCount(1);
});

test("private NDI uses the Preview monitor and preserves its prepared decoder on navigation",async({page})=>{
  await page.route("**/ndi-fixture/**",route=>route.fulfill({status:503,body:"Synthetic source not running"}));
  await boot(page);
  expect(await page.evaluate(()=>(window as unknown as {__ndiCalls:string[]}).__ndiCalls.includes("ndi_discover"))).toBe(true);
  await page.getByRole("combobox",{name:"NDI source"}).selectOption("Synthetic Premiere");
  await page.getByRole("button",{name:"Preview source"}).click();
  await expect(page.getByRole("dialog",{name:"NDI settings"})).toBeVisible();
  await expectPassiveLiveStatus(page);
  const video=page.locator(".cp-peerstage-video");await expect(video).toBeAttached();
  await expect(page.locator(".cp-monitor .cp-empty")).toHaveAttribute("inert", "");
  await expect(page.getByRole("button",{name:"Share NDI with room"})).toBeDisabled();
  await expect(page.locator(".cp-monitor .cp-ndi-monitor")).toHaveCount(1);
  await expect(page.locator(".cp-ndi-input video,.cp-ndi-input canvas,.cp-ndi-input input[type=range]")).toHaveCount(0);
  await expect(page.locator(".cp-monitor-source-bar")).toHaveCount(0);
  await video.evaluate(el=>{el.setAttribute("data-mount-canary","same");});
  await page.getByRole("button",{name:"Done",exact:true}).click();
  await expect(page.locator('[aria-modal="true"]')).toHaveCount(0);
  await page.keyboard.press("Meta+3");await expect(video).toHaveAttribute("data-mount-canary","same");
  await expect(page.getByRole("button",{name:/Change Premiere source/})).toHaveCount(0);
  await expect(video).not.toBeVisible();
  await page.locator(".cp-nav-item").filter({hasText:"Review"}).first().click();
  await expect(video).toHaveAttribute("data-mount-canary","same");
  await page.getByRole("button",{name:"Share",exact:true}).click();
  await page.getByRole("menuitem",{name:/Source settings/}).click();
  await expect(page.getByRole("dialog",{name:"NDI settings"})).toBeVisible();
  await expect(video).toHaveAttribute("data-mount-canary","same");
  expect(await video.evaluate(el=>(el as HTMLVideoElement).muted)).toBe(true);
});

function framedCapture(path:string):Buffer {
  const bytes=readFileSync(path);const init:Buffer[]=[],segments:Buffer[]=[];let current:Buffer[]=[];
  for(let offset=0;offset<bytes.length;){
    const size=bytes.readUInt32BE(offset),type=bytes.toString("ascii",offset+4,offset+8);
    if(size<8||offset+size>bytes.length)throw new Error("Invalid synthetic MP4 box");
    const box=bytes.subarray(offset,offset+size);offset+=size;
    if(type==="ftyp"||type==="moov")init.push(box);
    else {if(type==="moof"&&current.some(b=>b.toString("ascii",4,8)==="moof")){segments.push(Buffer.concat(current));current=[];}current.push(box);}
  }
  if(current.length)segments.push(Buffer.concat(current));
  return Buffer.concat([Buffer.concat(init),...segments].map((data,index)=>{
    const header=Buffer.alloc(5);header[0]=index===0?1:2;header.writeUInt32BE(data.length,1);return Buffer.concat([header,data]);
  }));
}

async function liveCapture(media:Buffer,file?:Buffer,delivery:"backlog"|"jitter"="backlog") {
  const packets:Buffer[]=[];for(let i=0;i<media.length;){const n=5+media.readUInt32BE(i+1);packets.push(media.subarray(i,i+n));i+=n;}
  const streams=new Set<ServerResponse>();
  const server=createServer((_request,response)=>{
    if(file && _request.url==="/file.mp4") {
      const range=/^bytes=(\d+)-(\d*)$/.exec(_request.headers.range??"");
      const start=range?Number(range[1]):0,end=range&&range[2]?Math.min(Number(range[2]),file.length-1):file.length-1;
      response.writeHead(range?206:200,{"Content-Type":"video/mp4","Access-Control-Allow-Origin":"*",
        "Accept-Ranges":"bytes","Content-Length":end-start+1,...(range?{"Content-Range":`bytes ${start}-${end}/${file.length}`}:{})});
      response.end(file.subarray(start,end+1));return;
    }
    response.writeHead(200,{"Content-Type":"application/octet-stream","Access-Control-Allow-Origin":"*"});
    streams.add(response);response.on("close",()=>streams.delete(response));
    // Stress a backlog burst, followed by real 100 ms source cadence. A
    // finite all-at-once file is not a running input: after coalescing it can
    // leave less than the decoder's startup reserve and no future frames.
    const tail=delivery==="jitter"?1:Math.max(1,packets.length-20);
    response.write(Buffer.concat(packets.slice(0,tail)));
    let index=tail;
    let tick=0;
    const clock=setInterval(()=>{
      tick++;
      if(delivery==="jitter") {
        // Every second, hold three fragments and deliver them together. This
        // is delivery jitter, NOT source silence and NOT dropped media.
        if(tick%10===5 || tick%10===6)return;
        const end=Math.min(1+tick,packets.length);
        if(index<end){response.write(Buffer.concat(packets.slice(index,end)));index=end;}
      } else if(index<packets.length)response.write(packets[index++]);
    },100);
    response.on("close",()=>clearInterval(clock));
  });
  await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",resolve);});
  const address=server.address();
  if(!address || typeof address==="string")throw new Error("No live fixture port");
  return {url:`http://127.0.0.1:${address.port}/capture`,fileUrl:`http://127.0.0.1:${address.port}/file.mp4`,disconnect:()=>{for(const response of streams)response.end();},
    close:async()=>{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}};
}

test("opt-in: a playing MediaBunny file keeps decoding while Premiere is previewed privately",async({page})=>{
  test.skip(!process.env.SAUCE_NDI_CAPTURE,"Run scripts/test-ndi.sh and provide SAUCE_NDI_CAPTURE");
  const capture=process.env.SAUCE_NDI_CAPTURE!;
  const file=readFileSync(capture),media=framedCapture(capture);
  const duration=Number(execFileSync(fileURLToPath(new URL("../src-tauri/binaries/ffprobe-aarch64-apple-darwin",import.meta.url)),
    ["-v","error","-show_entries","format=duration","-of","default=noprint_wrappers=1:nokey=1",capture],{encoding:"utf8"}).trim());
  expect(duration).toBeGreaterThan(5);
  const stream=await liveCapture(media,file);
  try {
    await boot(page,true,stream.url,false,{url:stream.fileUrl,size:file.length,duration});
    await page.keyboard.press("Escape");
    const canvas=page.locator(".cp-local-media canvas");
    await expect.poll(()=>canvas.evaluate(el=>(el as HTMLCanvasElement).width)).toBe(1920);
    await canvas.evaluate(el=>el.setAttribute("data-file-player","same"));
    const picture=()=>canvas.evaluate(el=>(el as HTMLCanvasElement).toDataURL());
    const initial=await picture();
    await page.getByRole("button",{name:"Play",exact:true}).click();
    await expect.poll(picture).not.toBe(initial);
    await page.getByRole("button",{name:"Share",exact:true}).click();
    await page.getByRole("menuitem",{name:/Source settings/}).click();
    await page.getByRole("combobox",{name:"NDI source"}).selectOption("Synthetic Premiere");
    await page.getByRole("button",{name:"Preview source"}).click();
    await expectNativePicture(page);
    await page.screenshot({path:test.info().outputPath("ndi-private-inline-1280.png")});
    const whilePreviewing=await picture();
    await expect.poll(picture).not.toBe(whilePreviewing);
    await expect(canvas).toHaveAttribute("data-file-player","same");
    await expect(page.locator(".cp-monitor .cp-ndi-monitor")).toBeVisible();
    await page.getByRole("button",{name:"Done",exact:true}).click();
    await page.getByRole("button",{name:"Return to room",exact:true}).click();
    await expect(page.getByRole("button",{name:"Pause",exact:true})).toBeVisible();
    await expect(page.getByRole("textbox",{name:"Comment",exact:true})).toBeEnabled();
    await expect(canvas).toHaveAttribute("data-file-player","same");
  } catch(error) {
    console.log("File playback before teardown",await page.locator(".cp-logs").textContent());
    throw error;
  } finally {await stream.close();}
});

test("opt-in: returning from Premiere restores file marks, captions, and controls",async({page})=>{
  test.skip(!process.env.SAUCE_NDI_CAPTURE,"Run scripts/test-ndi.sh and provide SAUCE_NDI_CAPTURE");
  const capture=process.env.SAUCE_NDI_CAPTURE!;
  const file=readFileSync(capture),media=framedCapture(capture);
  const duration=Number(execFileSync(fileURLToPath(new URL("../src-tauri/binaries/ffprobe-aarch64-apple-darwin",import.meta.url)),
    ["-v","error","-show_entries","format=duration","-of","default=noprint_wrappers=1:nokey=1",capture],{encoding:"utf8"}).trim());
  const stream=await liveCapture(media,file);
  try {
    await boot(page,true,stream.url,false,{url:stream.fileUrl,size:file.length,duration,captions:true});
    await page.keyboard.press("Escape");
    await expect(page.locator(".cp-caption-cue")).toHaveText("File review caption");
    await expect(page.locator(".cp-track-selection")).toHaveCount(1);
    const marks=()=>page.evaluate(()=>JSON.parse(localStorage.getItem("saucebunny.sourceMarks")??"{}"));
    const originalMarks=await marks();
    await page.locator(".cp-local-media canvas").evaluate(el=>el.setAttribute("data-return-file","same"));
    const selectionStyle=await page.locator(".cp-track-selection").getAttribute("style");
    await expect(page.locator(".cp-track.has-filmstrip")).toBeVisible();
    const timelineHeight=(await page.getByRole("region",{name:"Timeline",exact:true}).boundingBox())!.height;
    await page.getByRole("button",{name:"Share",exact:true}).click();
    await page.getByRole("menuitem",{name:/Source settings/}).click();
    await page.getByRole("combobox",{name:"NDI source"}).selectOption("Synthetic Premiere");
    await page.getByRole("button",{name:"Preview source"}).click();
    await expectNativePicture(page);
    await page.getByRole("button",{name:"Share NDI with room"}).click();
    await expect(page.getByRole("region",{name:"Live timeline"})).toBeVisible();
    await expectPassiveLiveStatus(page);
    expect((await page.getByRole("region",{name:"Live timeline"}).boundingBox())!.height).toBe(timelineHeight);
    await expect(page.locator(".cp-caption-cue")).toHaveCount(0);
    await expect(page.locator(".cp-track-selection")).toHaveCount(0);
    await expect(page.getByRole("button",{name:"Captions",exact:true})).toHaveCount(0);
    await expect(page.getByRole("button",{name:"Step forward one frame"})).toHaveCount(0);
    // A live review must not adopt the hidden file's frame marks in storage.
    expect(await marks()).toEqual(originalMarks);
    const beforeCancel=await page.evaluate(()=>(window as unknown as {__ndiCalls:string[]}).__ndiCalls.length);
    await page.evaluate(()=>localStorage.setItem("e2e.cancelNextFile","1"));
    await page.getByRole("button",{name:"File",exact:true}).click();
    await expect(page.getByRole("button",{name:"Shared with room",exact:true})).toBeVisible();
    const cancelledCalls=await page.evaluate(start=>(window as unknown as {__ndiCalls:string[]}).__ndiCalls.slice(start),beforeCancel);
    expect(cancelledCalls).not.toContain("ndi_unpublish");
    expect(cancelledCalls).not.toContain("ndi_stop");
    await page.getByRole("button",{name:"Shared with room",exact:true}).click();
    await page.getByRole("menuitem",{name:/Stop sharing with room/}).click();
    await expect(page.getByRole("region",{name:"Live timeline"})).toBeVisible();
    await expect(page.locator(".cp-caption-cue")).toHaveCount(0);
    // Explicit file selection, not Stop sharing, returns the room to a file.
    await page.getByRole("button",{name:"File",exact:true}).click();
    await expect(page.getByRole("region",{name:"Live timeline"})).toHaveCount(0);
    await expect(page.locator(".cp-source-status")).toHaveCount(0);
    await expect(page.locator(".cp-transport-side.left .cp-tc")).toBeVisible();
    await expect(page.locator(".cp-caption-cue")).toHaveText("File review caption");
    await expect(page.locator(".cp-track-selection")).toHaveAttribute("style",selectionStyle!);
    await expect(page.locator(".cp-track.has-filmstrip")).toBeVisible();
    expect((await page.getByRole("region",{name:"Timeline",exact:true}).boundingBox())!.height).toBe(timelineHeight);
    expect(await marks()).toEqual(originalMarks);
    await expect(page.getByRole("button",{name:"Captions",exact:true})).toBeEnabled();
    await expect(page.getByRole("button",{name:"Captions",exact:true})).toHaveAttribute("aria-pressed","true");
    await expect(page.getByRole("button",{name:"Step forward one frame"})).toBeEnabled();
    const canvas=page.locator(".cp-local-media canvas");
    await expect(canvas).toHaveAttribute("data-return-file","same");
    await expect.poll(()=>canvas.evaluate(el=>(el as HTMLCanvasElement).width)).toBe(1920);
    const picture=()=>canvas.evaluate(el=>(el as HTMLCanvasElement).toDataURL());
    const initial=await picture();
    await page.getByRole("button",{name:"Play",exact:true}).click();
    await expect.poll(picture).not.toBe(initial);
  } finally {await stream.close();}
});

async function expectNativePicture(page:Page) {
  // Include decoder evidence in a failed assertion, not just a disabled Share
  // button. On retry the last element is the new attempt, not the held frame.
  await expect.poll(()=>page.locator(".cp-peerstage-video").last().evaluate(element=>{
    const video=element as HTMLVideoElement;
    return {width:video.videoWidth,hasFrames:video.getVideoPlaybackQuality().totalVideoFrames>1,
      mediaError:video.error?`${video.error.code}: ${video.error.message}`:null,
      readyState:video.readyState,paused:video.paused,currentTime:video.currentTime,
      buffered:Array.from({length:video.buffered.length},(_,i)=>[video.buffered.start(i),video.buffered.end(i)])};
  }),{message:"The requested native NDI attempt must decode real picture"}).toMatchObject({width:1920,hasFrames:true,mediaError:null});
}

test("opt-in: sustained native NDI audio and picture survive repeated delivery jitter",async({page})=>{
  test.skip(!process.env.SAUCE_NDI_CONTINUOUS_CAPTURE,"Run scripts/test-ndi.sh 24/1 continuous and provide SAUCE_NDI_CONTINUOUS_CAPTURE");
  const media=framedCapture(process.env.SAUCE_NDI_CONTINUOUS_CAPTURE!);
  const stream=await liveCapture(media,undefined,"jitter");
  try {
    await boot(page,false,stream.url);
    await page.getByRole("button",{name:"Source settings",exact:true}).click();
    await page.getByRole("combobox",{name:"NDI source"}).selectOption("Synthetic Premiere");
    await page.getByRole("button",{name:"Preview source"}).click();
    await expectNativePicture(page);
    await page.getByRole("button",{name:"Done",exact:true}).click();
    const result=await page.locator(".cp-ndi-monitor video").evaluate(async element=>{
      const video=element as HTMLVideoElement,context=new AudioContext();
      const source=context.createMediaElementSource(video),split=context.createChannelSplitter(2);
      const meters=[context.createAnalyser(),context.createAnalyser()];
      source.connect(split);source.connect(context.destination);
      meters.forEach((meter,index)=>{meter.fftSize=1024;split.connect(meter,index);});
      await context.resume();await video.play();
      // Exclude initial AAC priming and the receiver's startup reserve only.
      await new Promise(resolve=>setTimeout(resolve,2000));
      let seeks=0,waiting=0,maxQuietMs=0,maxFrozenMs=0,quietSince=0,frozenSince=0;
      const seeking=()=>seeks++,wait=()=>waiting++;
      video.addEventListener("seeking",seeking);video.addEventListener("waiting",wait);
      const samples=meters.map(meter=>new Float32Array(meter.fftSize)),start=performance.now(),startTime=video.currentTime;
      let previousTime=startTime,observations=0,silentObservations=0;
      const frames=video.getVideoPlaybackQuality().totalVideoFrames;
      try {
        while(performance.now()-start<15000) {
          const now=performance.now();observations++;
          const audible=meters.every((meter,index)=>{
            meter.getFloatTimeDomainData(samples[index]);
            return samples[index].some(sample=>Math.abs(sample)>0.005);
          });
          if(!audible){silentObservations++;quietSince||=now;maxQuietMs=Math.max(maxQuietMs,now-quietSince);}else quietSince=0;
          if(video.currentTime<=previousTime){frozenSince||=now;maxFrozenMs=Math.max(maxFrozenMs,now-frozenSince);}else frozenSince=0;
          previousTime=video.currentTime;
          await new Promise(resolve=>setTimeout(resolve,20));
        }
        return {seeks,waiting,maxQuietMs,maxFrozenMs,observations,silentObservations,
          advance:video.currentTime-startTime,frames:video.getVideoPlaybackQuality().totalVideoFrames-frames,
          muted:video.muted,error:video.error?.message??null};
      } finally {
        video.removeEventListener("seeking",seeking);video.removeEventListener("waiting",wait);
        source.disconnect();split.disconnect();meters.forEach(meter=>meter.disconnect());await context.close();
      }
    });
    console.log("NDI sustained continuity",result);
    expect(result.error).toBeNull();expect(result.muted).toBe(false);
    expect(result.observations).toBeGreaterThan(400);
    expect(result.advance).toBeGreaterThan(14.5);expect(result.advance).toBeLessThan(15.5);
    expect(result.frames).toBeGreaterThan(400);
    expect(result.seeks,"steady delivery must not cause repeated live-edge seeks").toBeLessThanOrEqual(1);
    expect(result.maxQuietMs,"no stop-start holes in either decoded tone channel").toBeLessThan(100);
    expect(result.maxFrozenMs,"picture clock keeps advancing through burst delivery").toBeLessThan(150);
  } finally {await stream.close();}
});

test("opt-in: browser decodes the real native NDI H.264/AAC capture",async({page})=>{
  test.skip(!process.env.SAUCE_NDI_CAPTURE,"Run scripts/test-ndi.sh and provide SAUCE_NDI_CAPTURE");
  const media=framedCapture(process.env.SAUCE_NDI_CAPTURE!);
  const stream=await liveCapture(media);
  try {
  // A direct loopback URL exercises fetch's real streaming/cancellation path.
  await boot(page,true,stream.url);
  const fileTimelineHeight = (await page.locator(".cp-view-clip .cp-timeline").boundingBox())!.height;
  await page.getByRole("combobox",{name:"NDI source"}).selectOption("Synthetic Premiere");
  await page.getByRole("button",{name:"Preview source"}).click();
  await expectNativePicture(page);
  await expect(page.getByRole("button",{name:"Share NDI with room"})).toBeEnabled();
  expect(await page.evaluate(()=>(window as unknown as {__ndiCalls:string[]}).__ndiCalls.includes("ndi_publish"))).toBe(false);
  const oldVideo=page.locator(".cp-peerstage-video");
  await oldVideo.evaluate(el=>el.setAttribute("data-last-good-picture","yes"));
  stream.disconnect();
  await expect(page.getByRole("alert").filter({hasText:"disconnected"}).first()).toBeVisible();
  await expect(page.getByRole("button",{name:"Share NDI with room"})).toBeDisabled();
  await expect(oldVideo).toHaveAttribute("data-last-good-picture","yes");
  await oldVideo.dispatchEvent("loadeddata");
  await expect(page.getByRole("button",{name:"Share NDI with room"})).toBeDisabled();
  await page.getByRole("dialog",{name:"NDI settings",exact:true}).getByRole("button",{name:"Reconnect picture"}).click();
  await expectNativePicture(page);
  await expect(page.getByRole("button",{name:"Share NDI with room"})).toBeEnabled();
  await expect(page.locator('[data-last-good-picture="yes"]')).toHaveCount(0);
  await page.screenshot({path:test.info().outputPath("ndi-native-picture.png")});
  for (const size of [{width:1680,height:1020},{width:1100,height:700}]) {
    await page.setViewportSize(size);
    await expectRoomControlsInBounds(page);
    await page.screenshot({path:test.info().outputPath("ndi-private-inline-"+size.width+".png")});
  }
  await page.setViewportSize({width:1680,height:1020});
  const promotedVideo=page.locator(".cp-peerstage-video").last();
  await promotedVideo.evaluate(el=>el.setAttribute("data-promoted-picture","same"));
  await expect(page.locator(".cp-transport .cp-volume")).toHaveCount(1);
  await expect(page.locator(".cp-ndi-input input[type=range],.cp-ndi-audio-bar")).toHaveCount(0);
  // Preview source explicitly enables local monitoring; it is no longer
  // silently muted until a second, undiscoverable opt-in.
  await expect.poll(()=>promotedVideo.evaluate(el=>(el as HTMLVideoElement).muted)).toBe(false);
  // Recovery is a real settings button acting on the existing decoder. It
  // stays available after closing/reopening, but never covers the picture.
  const settings=page.getByRole("dialog",{name:"NDI settings"});
  await settings.getByRole("button",{name:"Done",exact:true}).click();
  await promotedVideo.evaluate(el=>(el as HTMLVideoElement).pause());
  await expect(page.locator(".cp-monitor button:visible,.cp-monitor .cp-peerstage-badge:visible")).toHaveCount(0);
  await page.getByRole("button",{name:"Source settings",exact:true}).click();
  const resume=settings.getByRole("button",{name:"Enable program audio"});
  await expect(resume).toBeVisible();
  await resume.focus();await page.keyboard.press("Escape");
  await expect(settings).toHaveCount(0);await expectPremiereReturnFocus(page);
  await page.getByRole("button",{name:"Source settings",exact:true}).click();
  await resume.click();
  await expect.poll(()=>promotedVideo.evaluate(el=>(el as HTMLVideoElement).paused)).toBe(false);
  await expect(resume).toHaveCount(0);
  await expect(promotedVideo).toHaveAttribute("data-promoted-picture","same");
  await expect(page.locator(".cp-monitor video")).toHaveCount(1);
  const peaks=await promotedVideo.evaluate(async element=>{
    const video=element as HTMLVideoElement,context=new AudioContext();
    const source=context.createMediaElementSource(video),split=context.createChannelSplitter(2);
    const meters=[context.createAnalyser(),context.createAnalyser()];
    source.connect(split);source.connect(context.destination);
    meters.forEach((meter,index)=>{meter.fftSize=2048;split.connect(meter,index);});
    await context.resume();
    const peaks=[0,0],samples=meters.map(meter=>new Float32Array(meter.fftSize));
    const end=performance.now()+800;
    while(performance.now()<end){
      meters.forEach((meter,index)=>{meter.getFloatTimeDomainData(samples[index]);
        for(const sample of samples[index])peaks[index]=Math.max(peaks[index],Math.abs(sample));});
      await new Promise(resolve=>requestAnimationFrame(resolve));
    }
    // Keep the element's audible graph alive for the remaining mute checks.
    return peaks;
  });
  expect(peaks[0],"decoded left-channel audio").toBeGreaterThan(0.005);
  expect(peaks[1],"decoded right-channel audio").toBeGreaterThan(0.005);
  await page.getByRole("dialog",{name:"NDI settings"}).getByRole("button",{name:"Done",exact:true}).click();
  await page.locator(".cp-transport .cp-volume > button").click();
  await page.locator(".cp-volume-popover").getByRole("button",{name:"Mute",exact:true}).click();
  await expect.poll(()=>promotedVideo.evaluate(el=>(el as HTMLVideoElement).muted)).toBe(true);
  await page.locator(".cp-transport .cp-volume > button").click();
  await page.locator(".cp-connect-premiere").click();
  await page.getByRole("button",{name:"Share NDI with room"}).click();
  await expect(page.getByRole("dialog",{name:"NDI settings"})).not.toBeVisible();
  await expect(page.locator(".cp-monitor [data-promoted-picture=same]")).toBeVisible();
  await expectNativePicture(page);
  await expect(page.locator(".cp-monitor .cp-ndi-audio-bar")).toHaveCount(0);
  await expect(page.getByRole("region",{name:"Live timeline"})).toBeVisible();
  expect((await page.getByRole("region",{name:"Live timeline"}).boundingBox())!.height).toBe(fileTimelineHeight);
  await expect(page.locator(".cp-preview-composer-gate")).toBeEnabled();
  } catch(error) {
    console.log("NDI before teardown",JSON.stringify(await page.locator(".cp-peerstage-video").evaluateAll(elements=>elements.map(element=>{
      const video=element as HTMLVideoElement;
      return {readyState:video.readyState,currentTime:video.currentTime,seeking:video.seeking,paused:video.paused,
        frames:video.getVideoPlaybackQuality().totalVideoFrames,error:video.error?.message,
        buffered:Array.from({length:video.buffered.length},(_,i)=>[video.buffered.start(i),video.buffered.end(i)])};
    }))));
    throw error;
  } finally {await stream.close();}
});
