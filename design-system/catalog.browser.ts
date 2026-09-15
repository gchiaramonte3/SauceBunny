import { expect, test, type Locator, type Page } from "@playwright/test";

const ids = ["generate", "speakers", "buttons", "icons", "statuses", "fields", "selects", "choices", "tabs", "menus", "tooltips", "dialogs", "tables", "panels", "feedback", "typography", "participants", "preview", "async", "navigation"];
const entry = (page: Page, id: string) => page.getByTestId(`catalog-entry-${id}`);
const proposed = (page: Page, id: string) => entry(page, id).locator('[data-ds-example="proposed"]').first();
const pageErrors = new WeakMap<Page, string[]>();

test("expected speakers uses production violet selection and keyboard focus return", async ({ page }) => {
  await selectFamily(page, "selects");
  const trigger = page.getByRole("button", { name: "Expected speakers: 2" });
  await trigger.click();
  const checked = page.getByRole("menuitemradio", { name: "2", exact: true });
  await expect(checked).toHaveCSS("background-color", "rgb(67, 38, 166)");
  await expect(checked).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Expected speakers: 3" })).toBeFocused();
});

for (const width of [1100, 1680]) for (const enlarged of [false, true]) {
  test(`adopted Finder indicators at ${width}px / ${enlarged ? 125 : 100}% text`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: width === 1100 ? 700 : 1020 });
    await page.getByTestId("catalog-text-scale").setChecked(enlarged);
    await selectFamily(page, "tables");
    const examples = page.getByTestId("clip-tag-examples");
    await examples.scrollIntoViewIfNeeded();
    const cards = examples.locator(".cp-lib-card");
    const rows = examples.locator(".cp-lib-lrow");
    await expect(cards).toHaveCount(10); await expect(rows).toHaveCount(10);
    await expect(cards.locator(".cp-clip-tag-dot")).toHaveCount(8);
    await expect(rows.locator(".cp-clip-tag-stripe")).toHaveCount(8);
    for (let i = 0; i < 10; i++) {
      const card = cards.nth(i), row = rows.nth(i);
      const dot = card.locator(".cp-clip-tag"), stripe = row.locator(".cp-clip-tag");
      if (await dot.count() === 0) continue;
      const d = (await dot.boundingBox())!, s = (await stripe.boundingBox())!, r = (await row.boundingBox())!;
      expect(d.width).toBe(8); expect(d.height).toBe(8);
      expect(s.width).toBe(2); expect(s.x).toBeCloseTo(r.x, 1);
      expect(s.y - r.y).toBe(4); expect(r.height - s.height).toBe(8);
      expect(await dot.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(await stripe.evaluate((el) => getComputedStyle(el).backgroundColor));
      const text = (await card.locator(".cp-lib-card-title").boundingBox())!;
      expect(d.x + d.width).toBeLessThanOrEqual(text.x);
    }
    // Narrow containers and long text use the same production clipping rules.
    await examples.locator(".cp-ds-clip-tag-list").evaluate((el) => { (el as HTMLElement).style.width = "240px"; });
    await cards.last().evaluate((el) => { (el as HTMLElement).style.width = "140px"; });
    const longTitle = cards.last().locator(".cp-lib-card-title");
    expect(await longTitle.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    expect((await cards.last().locator(".cp-clip-tag-dot").boundingBox())!.width).toBe(8);
    await cards.last().focus(); await cards.last().press("Space");
    await expect(cards.last()).toHaveAttribute("aria-pressed", "true");
    await expect(rows.last()).toHaveClass(/selected/);
    await expect(cards.last()).toHaveAttribute("aria-description", "Finder tags: Red, Purple, Client selects");
    await page.screenshot({ path: info.outputPath("finder-tag-catalog.png") });
  });
}

async function selectFamily(page: Page, id: string) {
  await page.getByRole("navigation", { name: "Component families" }).locator(`a[href="#${id}"]`).click();
  await entry(page, id).scrollIntoViewIfNeeded();
  await settleCatalogScroll(page);
}

async function settleCatalogScroll(page: Page) {
  // The normal-motion catalog scrolls smoothly; opening a dismiss-on-scroll
  // menu before movement and queued scroll delivery finish tests an unfinished
  // gesture. Observe the real surface for both navigation and edge positioning.
  await page.evaluate(() => new Promise<void>(resolve => {
    const main = document.querySelector(".cp-ds-main")!;
    let previous = main.scrollTop, stable = 0;
    const frame = () => {
      const next = main.scrollTop;
      stable = Math.abs(next - previous) < .1 ? stable + 1 : 0;
      previous = next;
      if (stable >= 4) resolve(); else requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }));
}

async function expectInsideViewport(locator: Locator, page: Page) {
  const rect = await locator.boundingBox();
  expect(rect).not.toBeNull();
  const viewport = page.viewportSize()!;
  expect(rect!.x).toBeGreaterThanOrEqual(0);
  expect(rect!.y).toBeGreaterThanOrEqual(0);
  expect(rect!.x + rect!.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(rect!.y + rect!.height).toBeLessThanOrEqual(viewport.height + 1);
}

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on("pageerror", error => errors.push(error.message));
  await page.setViewportSize({ width: 1680, height: 1020 });
  // Deterministic screenshots and focus geometry also exercise the reduced-motion recipe.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => {
    const violations: string[] = [];
    Object.defineProperty(window, "__catalogForbiddenCalls", { value: violations });
    function forbidden(label: string) {
      return (..._args: unknown[]) => { violations.push(label); throw new Error(`Catalog attempted ${label}`); };
    }
    for (const method of ["setItem", "removeItem", "clear"] as const) Storage.prototype[method] = forbidden(`storage.${method}`);
    if (window.indexedDB) window.indexedDB.open = forbidden("indexedDB.open") as typeof indexedDB.open;
    if (navigator.mediaDevices) {
      navigator.mediaDevices.getUserMedia = forbidden("getUserMedia") as typeof navigator.mediaDevices.getUserMedia;
      navigator.mediaDevices.getDisplayMedia = forbidden("getDisplayMedia") as typeof navigator.mediaDevices.getDisplayMedia;
    }
    Object.defineProperty(window, "__TAURI_INTERNALS__", { value: { invoke: forbidden("Tauri.invoke") } });
    window.fetch = forbidden("fetch") as typeof fetch;
    XMLHttpRequest.prototype.open = forbidden("XMLHttpRequest.open") as typeof XMLHttpRequest.prototype.open;
    navigator.sendBeacon = forbidden("sendBeacon") as typeof navigator.sendBeacon;
  });
  await page.goto("/design-system.html");
  await expect(page.getByTestId("design-catalog")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
});

test.afterEach(async ({ page }) => {
  const forbidden = await page.evaluate(() => (window as unknown as { __catalogForbiddenCalls: string[] }).__catalogForbiddenCalls);
  expect(forbidden, "Catalog fixtures must not persist, invoke native code, capture devices or perform network calls").toEqual([]);
  expect(pageErrors.get(page), "No uncaught errors in rendered fixtures").toEqual([]);
});

test("all 20 source-backed families are reachable and filters intersect", async ({ page }) => {
  await expect(page.locator('[data-testid^="catalog-entry-"]')).toHaveCount(20);
  for (const id of ids) {
    await selectFamily(page, id);
    await expect(entry(page, id)).toBeVisible();
    await expect(entry(page, id).locator('[data-ds-example="current"]')).toHaveCount(1);
    await expect(entry(page, id).locator('[data-ds-example="proposed"]').first()).toBeVisible();
    const references = entry(page, id).getByText("Usage rules & source references", { exact: true });
    await references.click();
    const links = entry(page, id).locator(".cp-ds-rules a");
    expect(await links.count()).toBeGreaterThan(0);
    for (const link of await links.all()) {
      await expect(link).toHaveAttribute("href", /^\/(?:src|docs)\//);
      await expect(link).toHaveAttribute("target", "_blank");
    }
  }
  await page.getByTestId("catalog-search").fill("HistoryPopover");
  await expect(entry(page, "menus")).toBeVisible();
  await expect(entry(page, "buttons")).toHaveCount(0);
  await page.getByTestId("catalog-workspace").selectOption("Review");
  await page.getByTestId("catalog-group").selectOption("Surfaces");
  await expect(entry(page, "menus")).toBeVisible();
  await page.getByTestId("catalog-group").selectOption("Content");
  await expect(page.getByRole("heading", { name: "No matching patterns" })).toBeVisible();
  await page.getByRole("button", { name: "Clear filters", exact: true }).click();
  await expect(page.locator('[data-testid^="catalog-entry-"]')).toHaveCount(20);
  await page.getByTestId("catalog-group").selectOption("Specialty");
  await expect(page.locator('[data-testid^="catalog-entry-"]')).toHaveCount(2);
  await expect(entry(page, "generate")).toBeVisible();
  await expect(entry(page, "speakers")).toBeVisible();
});

test("passive status is not a command and proposed command density is 30/26px", async ({ page }) => {
  const statuses = proposed(page, "statuses").locator(".cp-ds-status-badge");
  await expect(statuses).toHaveCount(5);
  expect(await statuses.evaluateAll(nodes => nodes.every(node => node.tagName === "SPAN" && !node.hasAttribute("tabindex") && !node.hasAttribute("role")))).toBe(true);
  for (const [density, height] of [["standard", 30], ["compact", 26]] as const) {
    await page.getByTestId("catalog-density").selectOption(density);
    for (const id of ["buttons", "icons"]) {
      const buttons = proposed(page, id).locator("button");
      for (const button of await buttons.all()) {
        expect((await button.boundingBox())!.height).toBe(height);
        if (id === "icons") expect((await button.boundingBox())!.width).toBe(height);
      }
    }
    const select = proposed(page, "selects").getByRole("combobox");
    expect((await select.boundingBox())!.height).toBe(height);
  }
  await page.getByTestId("catalog-state").selectOption("focus");
  await expect(proposed(page, "buttons").getByRole("button", { name: "Start session", exact: true })).toHaveCSS("outline-style", "solid");
  for (const state of ["disabled", "busy"]) {
    await page.getByTestId("catalog-state").selectOption(state);
    for (const button of await proposed(page, "buttons").getByRole("button").all()) await expect(button).toBeDisabled();
  }
  await expect(proposed(page, "buttons").getByRole("button", { name: "Starting…" })).toHaveAttribute("aria-busy", "true");
});

test("proposed flat-surface text maintains readable contrast", async ({ page }) => {
  // Text on solid backgrounds only. Beveled gradients, imagery and focus rings
  // need a separate visual check; do not pretend this measures those surfaces.
  const samples = page.locator('[data-ds-example="proposed"] .cp-ds-status-badge, [data-ds-example="proposed"] .cp-ds-button[data-variant="primary"], [data-ds-example="proposed"] .cp-ds-input, [data-ds-example="proposed"] small');
  const results = await samples.evaluateAll(nodes => {
    const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true })!;
    const rgba = (value: string) => {
      context.clearRect(0, 0, 1, 1); context.fillStyle = value; context.fillRect(0, 0, 1, 1);
      const pixel = [...context.getImageData(0, 0, 1, 1).data]; return [pixel[0], pixel[1], pixel[2], pixel[3] / 255];
    };
    const over = (front: number[], back: number[]) => front.slice(0, 3).map((channel, i) => channel * front[3] + back[i] * (1 - front[3])).concat(1);
    const light = (color: number[]) => color.slice(0, 3).map(channel => { const value = channel / 255; return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4; }).reduce((total, value, i) => total + value * [.2126, .7152, .0722][i], 0);
    return nodes.filter(node => (node as HTMLElement).offsetWidth > 0 && !node.matches(":disabled")).map(node => {
      const lineage: Element[] = []; let current: Element | null = node;
      while (current) { lineage.unshift(current); current = current.parentElement; }
      const background = lineage.reduce((color, ancestor) => over(rgba(getComputedStyle(ancestor).backgroundColor), color), [0, 0, 0, 1]);
      const foreground = over(rgba(getComputedStyle(node).color), background);
      const values = [light(foreground), light(background)].sort((a, b) => b - a);
      return { text: node.textContent?.trim().slice(0, 80) || (node as HTMLInputElement).value, contrast: (values[0] + .05) / (values[1] + .05) };
    });
  });
  expect(results.length).toBeGreaterThan(20);
  expect(results.filter(result => result.contrast < 4.5)).toEqual([]);
});

for (const enlarged of [false, true]) test(`compact native checkbox keeps its label hit area and keyboard access (text ${enlarged ? "125%" : "100%"})`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1100, height: 700 });
  if (enlarged) await page.getByTestId("catalog-text-scale").check();
  await selectFamily(page, "choices");
  const checkbox = entry(page, "choices").getByRole("checkbox", { name: "Local monitoring", exact: true });
  const label = checkbox.locator("..");
  for (const control of [checkbox, page.getByTestId("catalog-text-scale")]) {
    await expect(control).toHaveCSS("width", "13px");
    await expect(control).toHaveCSS("height", "13px");
    const hitArea = await control.locator("..").boundingBox();
    expect(hitArea!.height).toBeGreaterThanOrEqual(26);
    expect(hitArea!.width).toBeGreaterThanOrEqual(24);
  }
  await expect(checkbox).toBeChecked();
  // Click above the glyph, inside its label: shrinking the picture must not
  // shrink the practical pointer target. Native Space must still toggle it.
  await label.click({ position: { x: 6, y: 1 } });
  await expect(checkbox).not.toBeChecked();
  await checkbox.focus();
  await page.keyboard.press("Space");
  await expect(checkbox).toBeChecked();
  await expect(checkbox).toHaveCSS("outline-style", "solid");
  await expect(checkbox).toHaveCSS("outline-width", "2px");
  await expect(checkbox).toHaveCSS("outline-offset", "2px");
  await entry(page, "choices").screenshot({ path: testInfo.outputPath("compact-checkbox.png") });
});

test("field validation is associated and sample actions remain local", async ({ page }) => {
  await selectFamily(page, "fields");
  const field = proposed(page, "fields").getByRole("textbox", { name: "Session name" });
  await field.fill("");
  await expect(field).toHaveAttribute("aria-invalid", "true");
  const error = proposed(page, "fields").getByRole("alert");
  await expect(error).toHaveText("Enter a session name.");
  expect((await field.getAttribute("aria-describedby"))!.split(" ")).toContain(await error.getAttribute("id"));
  await proposed(page, "fields").getByRole("button", { name: "Restore valid field" }).click();
  await expect(field).toHaveAttribute("aria-invalid", "false");
  await proposed(page, "buttons").getByRole("button", { name: "Start session", exact: true }).click();
  await expect(proposed(page, "buttons").getByRole("status")).toContainText("No room was created");
  const jobs = proposed(page, "async");
  await jobs.getByRole("button", { name: "Simulate job" }).click();
  await expect(jobs.getByRole("button", { name: "Simulate job" })).toBeDisabled();
  await expect(jobs.locator(".cp-sbtn-export")).toHaveAttribute("data-phase", "loading");
  await expect(jobs.locator(".cp-sbtn-export")).toBeDisabled();
  await jobs.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(jobs.getByRole("button", { name: "Simulate job" })).toBeEnabled();
  await expect(jobs.locator(".cp-sbtn-export")).toHaveAttribute("data-phase", "idle");
  await expect(jobs.locator(".cp-sbtn-export")).toHaveCSS("height", "36px");
  const exportLabel = await jobs.locator(".cp-sbtn-export").evaluate(button => {
    const range = document.createRange(); range.selectNodeContents(button.querySelector(".cp-sbtn-idle")!);
    const bounds = button.getBoundingClientRect(), text = range.getBoundingClientRect();
    return { buttonWidth: bounds.width, textWidth: text.width, inside: text.left >= bounds.left && text.right <= bounds.right };
  });
  expect(exportLabel.inside, JSON.stringify(exportLabel)).toBe(true);
});

test("current library table fixture retains row geometry, per-cell clipping and a striped floor", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.getByTestId("catalog-text-scale").check();
  await selectFamily(page, "tables");
  for (const id of ["table-current", "table-current-narrow"]) {
    const table = page.getByTestId(id);
    const rows = table.locator(".cp-lib-lrow");
    await expect(rows).toHaveCount(3);
    for (const row of await rows.all()) expect((await row.boundingBox())!.height).toBe(27);
    const metrics = await table.locator(".cp-lib-list").evaluate(node => {
      const list = node.getBoundingClientRect();
      const last = node.querySelector(".cp-lib-lrow:last-of-type") ?? node.querySelectorAll(".cp-lib-lrow")[2];
      const filler = getComputedStyle(node, "::after");
      const rules = node.querySelector(".cp-lib-colrules")!.getBoundingClientRect();
      return { extra: list.bottom - last!.getBoundingClientRect().bottom, fillerHeight: parseFloat(filler.height), background: filler.backgroundImage, rulesHeight: rules.height, listHeight: list.height, scroll: node.scrollWidth, width: node.clientWidth };
    });
    expect(metrics.extra).toBeGreaterThan(27);
    expect(metrics.fillerHeight).toBeGreaterThan(27);
    expect(metrics.background).toContain("repeating-linear-gradient");
    expect(metrics.rulesHeight).toBe(metrics.listHeight);
    expect(metrics.scroll).toBeLessThanOrEqual(metrics.width);
    for (const cell of await rows.locator(".cp-lib-lrow-name, .cp-lib-lrow-size, .cp-lib-lrow-date").all()) await expect(cell).toHaveCSS("overflow-x", "hidden");
    await rows.nth(1).click();
    await expect(rows.nth(1)).toHaveAttribute("aria-pressed", "true");
    await table.getByRole("button", { name: /Sort example files by name/ }).click();
    await expect(table.locator(".cp-lib-sorthead")).toHaveAttribute("data-sort", "descending");
  }
  await page.screenshot({ path: testInfo.outputPath("catalog-tables-1100-125.png") });
});

test("proposed tabs, menus, tooltip and dialog honor keyboard behavior", async ({ page }) => {
  await selectFamily(page, "tabs");
  const tabs = proposed(page, "tabs").getByRole("tab");
  await tabs.first().focus();
  await page.keyboard.press("ArrowRight");
  await expect(tabs.nth(1)).toBeFocused();
  await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(proposed(page, "tabs").getByRole("tabpanel", { name: "Review", exact: true })).toBeVisible();
  await page.keyboard.press("End");
  await expect(tabs.last()).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(tabs.first()).toBeFocused();

  await selectFamily(page, "menus");
  const menuTrigger = proposed(page, "menus").getByRole("button", { name: "Example actions" });
  await menuTrigger.click();
  const menu = proposed(page, "menus").getByRole("menu", { name: "Example actions" });
  await expect(menu.getByRole("menuitem").first()).toBeFocused();
  await page.keyboard.press("End");
  await expect(menu.getByRole("menuitem").last()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menuTrigger).toBeFocused();

  await selectFamily(page, "tooltips");
  const tooltipTrigger = proposed(page, "tooltips").getByRole("button", { name: "Source information" });
  await tooltipTrigger.focus();
  const tooltip = proposed(page, "tooltips").locator(".cp-tip");
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toHaveAttribute("aria-hidden", "true");
  await expect(tooltipTrigger).toHaveAccessibleName("Source information");
  await page.keyboard.press("Escape");
  await expect(tooltip).toHaveCount(0);

  await selectFamily(page, "dialogs");
  const opener = proposed(page, "dialogs").getByRole("button", { name: "Open example dialog" });
  await opener.click();
  const dialog = page.getByRole("dialog", { name: "Rename sequence" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("aria-modal", "true");
  await expectInsideViewport(dialog, page);
  const first = dialog.getByRole("button", { name: "Close example dialog" });
  const last = dialog.getByRole("button", { name: "Rename", exact: true });
  await last.focus();
  await page.keyboard.press("Tab");
  await expect(first).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(last).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test("participant densities retain combined states and keyboard-accessible portal details", async ({ page }) => {
  await selectFamily(page, "participants");
  for (const density of ["compact", "expanded", "theater"]) {
    const tile = page.getByTestId(`participant-${density}-m0`);
    await expect(tile).toHaveAttribute("data-muted", "true");
    await expect(tile).toHaveAttribute("data-speaking", "false");
    const trigger = page.getByTestId(`participant-trigger-${density}-m0`);
    await expect(trigger).toHaveAccessibleName(/Host, Presenting, Mic muted, Camera off, Sharing screen, Recording camera and mic, Hand raised/);
    await trigger.focus();
    await trigger.press(density === "expanded" ? "Space" : "Enter");
    const menu = page.getByTestId(`participant-menu-${density}-m0`);
    await expect(menu).toBeVisible();
    expect(await menu.evaluate(node => node.parentElement === document.body)).toBe(true);
    await expectInsideViewport(menu, page);
    const items = menu.getByRole("menuitem");
    await expect(items.first()).toBeFocused();
    await page.keyboard.press("End");
    await expect(items.last()).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(items.first()).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await trigger.click();
    await expect(menu).toBeVisible();
    await trigger.click();
    await expect(menu).toHaveCount(0);
  }
  await entry(page, "participants").getByRole("button", { name: "Switch presenter" }).click();
  for (const density of ["compact", "expanded", "theater"]) {
    await expect(page.getByTestId(`participant-trigger-${density}-m1`)).toHaveAccessibleName(/Presenting/);
    await expect(page.getByTestId(`participant-trigger-${density}-m0`)).not.toHaveAccessibleName(/Presenting/);
  }
  await page.getByTestId("participant-camera-state").click();
  await page.getByTestId("participant-connection-state").click();
  for (const density of ["compact", "expanded", "theater"]) {
    await expect(page.getByTestId(`participant-trigger-${density}-m1`)).toHaveAccessibleName(/Camera on \(fixture\).*disconnected/);
    await expect(page.getByTestId(`participant-${density}-m0`).locator(".cp-person-picture")).toHaveAttribute("data-camera", "on");
  }
  const compact = page.getByTestId("participant-compact-m0");
  await expect(compact.locator(".cp-person-controls")).toBeHidden();
  await page.getByTestId("participant-trigger-compact-m0").click();
  await page.getByRole("menuitem", { name: /My microphone/ }).click();
  for (const density of ["compact", "expanded", "theater"]) {
    await expect(page.getByTestId(`participant-${density}-m0`)).toHaveAttribute("data-muted", "false");
    await expect(page.getByTestId(`participant-${density}-m0`)).toHaveAttribute("data-speaking", "true");
  }
  await page.getByTestId("participant-trigger-compact-m0").click();
  await page.getByRole("menuitem", { name: /My camera/ }).click();
  for (const density of ["compact", "expanded", "theater"]) await expect(page.getByTestId(`participant-trigger-${density}-m0`)).toHaveAccessibleName(/Camera off/);
});

test("approved People and Preview recipes lead; frozen historical defects are collapsed", async ({ page }) => {
  for (const id of ["participants", "preview"]) {
    await selectFamily(page, id);
    const before = page.getByTestId(`${id}-before-fix`);
    const historical = page.getByTestId(`${id === "participants" ? "participants" : "preview"}-current`);
    await expect(before).not.toHaveAttribute("open");
    await expect(historical).toBeHidden();
    await expect(entry(page, id).getByRole("heading", { name: /^Corrected/ }).first()).toBeVisible();
    await before.getByText("Before the fix", { exact: true }).click();
    await expect(historical).toBeVisible();
    await expect(historical.locator(".cp-person, .cp-tc, .cp-toolbar-disclosure, .cp-source-status")).toHaveCount(0);
    await expect(historical).toContainText("Frozen historical styles");
    await before.getByText("Before the fix", { exact: true }).click();
    await expect(historical).toBeHidden();
  }
});

test("Preview preserves one volume control and only discloses source details", async ({ page }) => {
  await selectFamily(page, "preview");
  const preview = page.getByTestId("preview-proposed");
  const source = page.getByTestId("preview-source-disclosure");
  await expect(source).toBeEnabled();
  await expect(source).toHaveClass("cp-toolbar-disclosure");
  await expect(source).toHaveAccessibleName("Premiere");
  await expect(source).toHaveAttribute("aria-controls", "cp-ds-preview-source-details");
  await page.keyboard.press("Tab");
  await source.focus();
  await expect(source).toHaveCSS("outline-style", "solid");
  await expect(source).toHaveCSS("text-transform", "none");
  const live = page.getByTestId("preview-live-status");
  expect(await live.evaluate(node => node.tagName === "SPAN" && !node.hasAttribute("tabindex") && !node.hasAttribute("role"))).toBe(true);
  await expect(live).toHaveCSS("border-top-width", "0px");
  expect((await live.boundingBox())!.width).toBeLessThan(108);
  await expect(page.getByTestId("preview-state-disabled").getByRole("button")).toBeDisabled();
  await expect(page.getByTestId("preview-state-expanded").getByRole("button")).toHaveAttribute("aria-expanded", "true");
  const monitor = preview.locator(".cp-ds-preview-monitor");
  const readout=preview.getByRole("status",{name:"Timeline timecode unavailable"});
  await expect(readout).toHaveText("--:--:--:--");
  const tc=(await readout.boundingBox())!, picture=(await monitor.boundingBox())!;
  expect(tc.y+tc.height).toBeLessThanOrEqual(picture.y);
  expect(Math.abs(tc.x+tc.width/2-picture.x-picture.width/2)).toBeLessThanOrEqual(1);
  await expect(preview.locator(".cp-ndi-publication")).toHaveText("Not shared with room");
  const broadcast = preview.getByRole("status", { name: "Network broadcast" });
  await expect(broadcast).toContainText("Broadcasting to NDI");
  const stop = preview.getByRole("button", { name: "Stop NDI broadcast from Composer (simulation)" });
  const stopBox = (await stop.boundingBox())!;
  expect(stopBox.y + stopBox.height).toBeLessThanOrEqual(picture.y);
  await stop.click();
  await expect(broadcast).toHaveCount(0);
  await expect(preview.locator(".cp-ndi-publication")).toHaveText("Not shared with room");
  await monitor.evaluate(node => node.setAttribute("data-monitor-identity", "original"));
  await expect(preview.locator(".cp-volume")).toHaveCount(1);
  await expect(preview.locator("video, audio, canvas")).toHaveCount(0);
  await expect(page.getByTestId("preview-source-details")).toBeHidden();
  await page.getByTestId("preview-source-disclosure").click();
  await expect(page.getByTestId("preview-source-disclosure")).toHaveAttribute("aria-expanded", "true");
  const details = page.getByTestId("preview-source-details");
  await expect(details).toBeVisible();
  await expect(details).toContainText("Connecting does not share with a room");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(details.locator("details")).toHaveCount(0);
  await expect(details).toContainText("Settings → Integrations");
  await expect(preview.locator(".cp-transport-btn")).toHaveCount(0);
  await preview.getByRole("button", { name: "Volume (muted)", exact: true }).click();
  await expect(preview.getByRole("slider", { name: "Volume", exact: true })).toBeVisible();
  await preview.getByRole("button", { name: "Unmute", exact: true }).click();
  await expect(details).toContainText("Enabled · 65%");
  await page.keyboard.press("Escape");
  await page.getByTestId("preview-source-disclosure").click();
  await expect(details).toBeHidden();
  await expect(monitor).toHaveAttribute("data-monitor-identity", "original");
});

test("production Review starter uses fixture-only actions and preserves link focus", async ({ page }, info) => {
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.getByTestId("catalog-text-scale").check();
  await selectFamily(page, "preview");
  const fixture = page.getByTestId("review-source-start-example");
  const starter = fixture.getByRole("region", { name: "Choose a review source" });
  await expect(starter.getByRole("button")).toHaveCount(6);
  await expect(starter.getByText(/Your preview stays on this Mac/)).toBeVisible();
  await starter.getByRole("button", { name: "Local file A video or audio file" }).click();
  await expect(fixture.getByRole("status")).toHaveText("File picker simulated. No files opened.");
  for (const category of ["Screen", "Window", "Region", "NDI"]) {
    await starter.getByRole("button", { name: new RegExp(`^${category} `) }).click();
    await expect(fixture.getByRole("status")).toHaveText(`${category} settings simulated. No capture or sharing started.`);
  }
  await starter.getByRole("button", { name: "Link Paste a video URL" }).click();
  const url = starter.getByRole("textbox", { name: "Video URL" });
  await expect(url).toBeFocused();
  await url.fill("https://example.invalid/generated-video");
  await starter.getByRole("button", { name: "Open link" }).click();
  await expect(fixture.getByRole("status")).toHaveText("Open link simulated. No network request made.");
  await url.press("Escape");
  await expect(starter.getByRole("button", { name: "Link Paste a video URL" })).toBeFocused();
  await fixture.getByRole("checkbox", { name: "Session copy (fixture)" }).check();
  await expect(starter.getByText(/Live sources preview privately before sharing/)).toBeVisible();
  await expect(fixture.locator("video,audio,canvas")).toHaveCount(0);
  await fixture.screenshot({ path: info.outputPath("review-source-start-catalog.png") });
});

test("capture picker keeps selected hover violet and edits a real fixture region", async ({ page }, info) => {
  await page.setViewportSize({ width: 1100, height: 700 });
  await selectFamily(page, "preview");
  const picker = page.getByTestId("capture-picker-example");
  await picker.scrollIntoViewIfNeeded();
  await expect(picker.getByRole("tab")).toHaveText(["NDI", "Screen", "Window", "Region"]);
  const windows = picker.getByRole("tab", { name: "Window", exact: true });
  await windows.click();
  const chosen = picker.getByRole("button", { name: "Composer · Avid Media Composer · Window 102", exact: true });
  await chosen.click();
  await chosen.hover();
  await expect(chosen).toHaveAttribute("aria-pressed", "true");
  const selectedColor = await windows.evaluate(node => getComputedStyle(node).backgroundColor);
  await expect(chosen).toHaveCSS("background-color", selectedColor);
  await picker.screenshot({ path: info.outputPath("capture-picker-windows-selected-hover.png") });
  await page.mouse.move(0, 0);
  await expect(chosen).toHaveCSS("background-color", selectedColor);

  await picker.getByRole("tab", { name: "Region", exact: true }).click();
  await picker.getByRole("button", { name: "Studio display · 1000 × 600 · fixture", exact: true }).click();
  const surface = picker.getByRole("group", { name: "Studio display crop" });
  await surface.scrollIntoViewIfNeeded();
  const box = (await surface.boundingBox())!;
  expect(Math.abs(box.width / box.height - 1000 / 600)).toBeLessThan(.01);
  expect(box.height).toBeLessThanOrEqual(224.1);
  await page.mouse.move(box.x + box.width * .1, box.y + box.height * .1);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * .6, box.y + box.height * .7);
  await page.mouse.up();
  for (const [name, value] of [["Left", 10], ["Top", 10], ["Width", 50], ["Height", 60]] as const) {
    const actual = Number(await picker.getByRole("spinbutton", { name, exact: true }).inputValue());
    expect(Math.abs(actual - value)).toBeLessThan(.1);
  }
  const systemAudio = picker.getByRole("checkbox", { name: "Include system audio" });
  await expect(systemAudio).toBeEnabled(); await expect(systemAudio).not.toBeChecked();
  await systemAudio.focus(); await page.keyboard.press("Space"); await expect(systemAudio).toBeChecked();
  await expect(picker.getByText(/Hides Sauce Bunny's windows/)).toBeVisible();
  await expect(picker.getByRole("button", { name: "Simulate Preview" })).toBeEnabled();
  await picker.screenshot({ path: info.outputPath("capture-picker-region.png") });
});

test("actual GenerateButton keeps its artwork, source options, progress and outcomes", async ({ page }) => {
  await selectFamily(page, "generate");
  const specimen = page.getByTestId("generate-specialty-current");
  const button = page.getByTestId("generate-primary").getByRole("button");
  const checkbox = specimen.getByRole("checkbox", { name: "Detect speakers" });
  const count = specimen.getByRole("combobox", { name: "Expected speakers" });
  await expect(button).toHaveClass(/cp-gen-btn/);
  await expect(button.locator(".cp-gen-svg path.cp-gen-star")).toHaveCount(3);
  expect(await button.locator(".cp-gen-star").evaluateAll(paths => paths.every(path => (path.getAttribute("d") ?? "").includes("C")))).toBe(true);
  await expect(button.locator(".cp-gen-idle")).toHaveText("Generate transcript + speakers");
  await expect(checkbox).toBeChecked();
  await count.selectOption("3");
  await checkbox.uncheck();
  await expect(count).toHaveCount(0);
  await expect(button.locator(".cp-gen-idle")).toHaveText("Generate transcript");
  await checkbox.check();
  await expect(count).toHaveValue("3");
  await button.click();
  await expect(button).toHaveAttribute("data-phase", "loading");
  await expect(button).toHaveAttribute("aria-busy", "true");
  await expect(button).toBeDisabled();
  await expect(checkbox).toBeDisabled();
  await expect(count).toBeDisabled();
  await expect(button.locator(".cp-gen-fill")).toHaveAttribute("style", /width: 42%/);
  const progress = specimen.getByRole("slider", { name: "Simulated transcription progress" });
  await progress.focus();
  await progress.press("End");
  await expect(button.locator(".cp-gen-fill")).toHaveAttribute("style", /width: 100%/);
  await expect(button.locator(".cp-gen-load")).toHaveText("Transcribing… 100%");
  await specimen.getByRole("combobox", { name: "Pipeline stage" }).selectOption("diarize-process");
  await expect(button.locator(".cp-gen-load")).toHaveText("Detecting speakers…");
  await expect(button.locator(".cp-gen-fill")).toHaveCount(0);
  await expect(specimen.locator(".cp-phase-track")).toHaveAttribute("aria-label", "Pipeline stage: diarize-process");
  await specimen.getByRole("combobox", { name: "Pipeline stage" }).selectOption("diarize-merge");
  await expect(button.locator(".cp-gen-load")).toHaveText("Merging speaker labels…");
  await specimen.getByRole("button", { name: "Success", exact: true }).click();
  await expect(button).toHaveAttribute("data-phase", "success");
  await expect(button.locator(".cp-sbtn-status")).toHaveText("Done");
  await expect(button.locator(".cp-gen-idle")).toHaveText("Generate transcript · run again");
  await specimen.getByRole("button", { name: "Error", exact: true }).click();
  await expect(button).toHaveAttribute("data-phase", "error");
  await expect(button.locator(".cp-sbtn-status")).toHaveText("Failed");
  await expect(button.locator(".cp-gen-idle")).toHaveText("Generate transcript · retry");
  await button.click();
  await expect(button).toHaveAttribute("data-phase", "loading");
  await specimen.getByRole("button", { name: "Reset", exact: true }).click();
  await expect(button).toHaveAttribute("data-phase", "idle");
  await expect(button).toBeEnabled();

  for (const phase of ["disabled", "loading", "success", "error"]) {
    const held = page.getByTestId(`generate-state-${phase}`).getByRole("button");
    await expect(held.locator(".cp-gen-star")).toHaveCount(3);
    await expect(held).toHaveAttribute("data-phase", phase === "disabled" ? "idle" : phase);
    if (phase === "disabled" || phase === "loading") await expect(held).toBeDisabled();
    if (phase === "success" || phase === "error") await expect(held.locator(".cp-sbtn-status")).toHaveText(phase === "success" ? "Done" : "Failed");
  }
  for (const phase of ["idle", "loading", "success", "error"]) {
    const held = page.getByTestId(`stateful-state-${phase}`).getByRole("button");
    await expect(held).toHaveClass(/cp-sbtn-fetch/);
    await expect(held).toHaveAttribute("data-phase", phase);
    if (phase === "loading") await expect(held).toBeDisabled();
  }
});

for (const motion of ["reduce", "no-preference"] as const) {
  test(`Generate specialty states preserve ${motion} motion behavior`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: motion });
    await selectFamily(page, "generate");
    const main = page.getByTestId("generate-primary").getByRole("button");
    const star = main.locator(".cp-gen-star").first();
    await expect(star).toHaveCSS("animation-name", motion === "reduce" ? "none" : "cp-gen-twinkle");
    await expect(main.locator(".cp-gen-letter").first()).toHaveCSS("animation-name", motion === "reduce" ? "none" : "cp-gen-shimmer");
    await expect(page.getByTestId("stateful-state-loading").locator(".cp-sbtn-spin")).toHaveCSS("animation-name", motion === "reduce" ? "none" : "cp-sbtn-spin");
    await main.click();
    await expect(main).toBeDisabled();
    await expect(star).toHaveCSS("animation-name", motion === "reduce" ? "none" : "cp-gen-twinkle");
    if (motion === "no-preference") await expect(star).toHaveCSS("animation-duration", "1.15s");
    await page.getByTestId("generate-specialty-current").getByRole("button", { name: "Reset", exact: true }).click();
    await page.getByTestId("catalog-state").selectOption("disabled");
    await expect(main).toBeDisabled();
    await page.getByTestId("catalog-state").selectOption("busy");
    await expect(main).toHaveAttribute("data-phase", "loading");
    await expect(main).toHaveAttribute("aria-busy", "true");
  });
}

test("speaker checkbox fill is darker while native geometry and keyboard focus stay intact", async ({ page }, testInfo) => {
  await selectFamily(page, "speakers");
  const roster = page.getByTestId("speakers-roster-fixture");
  const gasper = roster.getByRole("checkbox", { name: "Select Gasper", exact: true });
  await gasper.check();
  await roster.getByRole("checkbox", { name: "Select Alexandra", exact: true }).check();
  await expect(roster.getByRole("checkbox", { name: "Select Music", exact: true })).not.toBeChecked();
  await expect(gasper).toHaveCSS("accent-color", "rgb(64, 63, 70)");
  await expect(gasper).toHaveCSS("width", "13px");
  await expect(gasper).toHaveCSS("height", "13px");
  await gasper.focus();
  await gasper.press("Space");
  await expect(gasper).not.toBeChecked();
  await gasper.press("Space");
  await expect(gasper).toBeChecked();
  await expect(gasper).toHaveCSS("outline-style", "solid");
  await roster.screenshot({ path: testInfo.outputPath("speaker-checkbox-fill.png") });
});

test("speaker filters, Tools actions and Manage remain distinct local controls", async ({ page }) => {
  await selectFamily(page, "speakers");
  const speakers = page.getByTestId("speaker-reader-filter");
  const analyzed = page.getByTestId("speaker-reader-analyzed");
  const rows = page.getByTestId("speaker-reader-results").getByRole("listitem");
  await expect(speakers).toHaveText("Speakers");
  await expect(speakers).toHaveAttribute("aria-pressed", "false");
  await expect(rows).toHaveCount(3);
  await speakers.click();
  await expect(speakers).toHaveAttribute("aria-pressed", "true");
  await expect(rows).toHaveCount(2);
  await analyzed.click();
  await expect(analyzed).toHaveAttribute("aria-pressed", "true");
  await expect(rows).toHaveCount(1);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const tools = page.getByTestId("speaker-tools-trigger");
  await tools.focus();
  await tools.press("Enter");
  const menu = page.getByRole("menu", { name: "Transcript tools fixture" });
  const redetect = menu.getByRole("menuitem", { name: "Re-detect speakers", exact: true });
  await expect(redetect).toBeFocused();
  await page.keyboard.press("End");
  await expect(menu.getByRole("menuitem").last()).toBeFocused();
  await page.keyboard.press("Home");
  await redetect.press("Enter");
  await expect(menu).toHaveCount(0);
  await expect(tools).toBeFocused();
  await expect(page.getByTestId("speaker-fixture-status")).toContainText("Speaker-only detection selected. The text is kept.");
  const insights = page.getByTestId("speaker-insights-trigger");
  await expect(insights).toHaveText("Insights");
  await expect(insights).toHaveAttribute("title", "Speaker insights");
  await insights.click();
  await expect(page.getByTestId("speaker-fixture-status")).toContainText("Insights simulation selected");
  const manage = page.getByTestId("speaker-manage-trigger");
  await expect(manage).toHaveText("Manage");
  await manage.click();
  const dialog = page.getByTestId("speaker-fixture-dialog");
  await expect(dialog).toHaveAttribute("aria-modal", "true");
  await expectInsideViewport(dialog, page);
  await dialog.getByRole("textbox", { name: "Filter fixture speakers" }).fill("Alex");
  await expect(dialog.locator(".cp-spk-row")).toHaveCount(1);
  await dialog.getByRole("textbox", { name: "Filter fixture speakers" }).fill("");
  await dialog.getByRole("button", { name: "Name", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Name", exact: true })).toHaveAttribute("aria-pressed", "true");
  await dialog.getByRole("checkbox", { name: "Select Gasper" }).check();
  await expect(dialog.getByRole("checkbox", { name: "Select Gasper" })).toHaveCSS("accent-color", "rgb(64, 63, 70)");
  await expect(dialog.getByRole("combobox", { name: "Merge selected fixture speakers" })).toBeVisible();
  await dialog.getByRole("combobox", { name: "Merge selected fixture speakers" }).selectOption("speaker-2");
  await expect(dialog.locator(".cp-spk-row")).toHaveCount(3);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(manage).toBeFocused();
  await expect(page.getByTestId("speaker-fixture-status")).toContainText("Merge into Alexandra demonstrated without removing rows");
  await page.getByTestId("catalog-state").selectOption("busy");
  await tools.click();
  await expect(menu.getByRole("menuitem", { name: "Detecting speakers…" })).toBeDisabled();
  await expect(menu.getByRole("menuitem", { name: "Transcript history…" })).toBeFocused();
  await page.keyboard.press("Escape");
  await page.getByTestId("catalog-state").selectOption("disabled");
  await expect(tools).toBeDisabled();
  await expect(manage).toBeDisabled();
  await expect(speakers).toBeDisabled();
  await expect(insights).toBeDisabled();
});

for (const viewport of [{ width: 1100, height: 700 }, { width: 1680, height: 1020 }]) {
  for (const enlarged of [false, true]) {
    for (const motion of ["reduce", "no-preference"] as const) {
      test(`specialty geometry at ${viewport.width}×${viewport.height}, text ${enlarged ? "125%" : "100%"}, ${motion}`, async ({ page }, testInfo) => {
        await page.setViewportSize(viewport);
        await page.emulateMedia({ reducedMotion: motion });
        await page.getByTestId("catalog-text-scale").setChecked(enlarged);
        await selectFamily(page, "generate");
        const main = page.getByTestId("generate-primary").getByRole("button");
        const dimensions = () => main.evaluate(node => {
          const bounds = node.getBoundingClientRect(), css = getComputedStyle(node);
          return { width: bounds.width, height: bounds.height, padding: css.padding, radius: css.borderRadius, font: css.fontSize };
        });
        const before = await dimensions();
        expect(before.height).toBeGreaterThan(30);
        expect(before.padding).toBe("9px 14px");
        expect(before.radius).toBe("10px");
        expect(before.font).toBe(enlarged ? "15px" : "12px");
        const fetch = page.getByTestId("stateful-state-idle").getByRole("button");
        const fetchBefore = await fetch.evaluate(node => ({ width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height }));
        await page.getByTestId("catalog-density").selectOption("compact");
        expect(await dimensions()).toEqual(before);
        expect(await fetch.evaluate(node => ({ width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height }))).toEqual(fetchBefore);
        await selectFamily(page, "generate");
        const clipping = await entry(page, "generate").locator('.cp-gen-btn[data-phase="idle"]').evaluateAll(buttons => buttons.flatMap(button => {
          const bounds = button.getBoundingClientRect();
          return Array.from(button.querySelectorAll(".cp-gen-letter, .cp-gen-svg")).flatMap(part => {
            const rect = part.getBoundingClientRect();
            return rect.left < bounds.left || rect.right > bounds.right || rect.top < bounds.top || rect.bottom > bounds.bottom
              ? [{ text: part.textContent, part: part.getAttribute("class"), buttonWidth: bounds.width, partWidth: rect.width }] : [];
          });
        }));
        await testInfo.attach("specialty-generate-clipping", { body: JSON.stringify(clipping, null, 2), contentType: "application/json" });
        expect(clipping, "Record real specialty clipping; do not fix production CSS inside the catalog task").toEqual([]);
        await page.screenshot({ path: testInfo.outputPath("catalog-generate.png"), animations: motion === "reduce" ? "disabled" : "allow" });
        await selectFamily(page, "speakers");
        const filter = page.getByTestId("speaker-reader-filter");
        const filterBounds = await filter.boundingBox();
        await page.getByTestId("catalog-density").selectOption("standard");
        const standardBounds = await filter.boundingBox();
        expect({ width: standardBounds!.width, height: standardBounds!.height }).toEqual({ width: filterBounds!.width, height: filterBounds!.height });
        await selectFamily(page, "speakers");
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
        const inlineNameFont = await page.getByTestId("speakers-roster-fixture").locator(".cp-spk-name").first().evaluate(node => getComputedStyle(node).fontSize);
        await page.screenshot({ path: testInfo.outputPath("catalog-speakers.png"), animations: motion === "reduce" ? "disabled" : "allow" });
        await page.getByTestId("speaker-manage-trigger").click();
        await expectInsideViewport(page.getByTestId("speaker-fixture-dialog"), page);
        await expect(page.getByTestId("speaker-fixture-dialog").locator(".cp-spk-name").first()).toHaveCSS("font-size", inlineNameFont);
        await page.screenshot({ path: testInfo.outputPath("catalog-speaker-manage.png"), animations: motion === "reduce" ? "disabled" : "allow" });
      });
    }
  }
}

for (const viewport of [{ width: 1100, height: 700 }, { width: 1680, height: 1020 }]) {
  for (const enlarged of [false, true]) {
    test(`catalog fits ${viewport.width}×${viewport.height}, text ${enlarged ? "125%" : "100%"}`, async ({ page }, testInfo) => {
      await page.setViewportSize(viewport);
      await page.getByTestId("catalog-text-scale").setChecked(enlarged);
      await page.screenshot({ path: testInfo.outputPath("catalog-overview.png") });
      for (const id of ["participants", "preview"]) {
        await selectFamily(page, id);
        const target = id === "participants" ? page.getByTestId("participants-proposed") : page.getByTestId("preview-proposed");
        const width = await target.evaluate(node => ({ client: node.clientWidth, scroll: node.scrollWidth }));
        expect(width.scroll, `${id} content must not create horizontal clipping`).toBeLessThanOrEqual(width.client + 1);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
        if (id === "preview") {
          const source = (await page.getByTestId("preview-source-disclosure").boundingBox())!;
          const status = (await page.getByTestId("preview-live-status").boundingBox())!;
          expect(source.height).toBe(26);
          expect(status.width).toBeLessThan(108);
          expect(Math.abs(source.y + source.height / 2 - status.y - status.height / 2)).toBeLessThan(.6);
          const narrow = page.getByTestId("preview-state-narrow");
          expect(await narrow.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
          const action = narrow.getByRole("button", { name: "Connect Premiere" });
          expect(await action.evaluate(node => node.scrollWidth <= node.clientWidth && node.scrollHeight <= node.clientHeight)).toBe(true);
        }
        await page.screenshot({ path: testInfo.outputPath(`catalog-${id}.png`) });
      }
      const longAction = page.getByTestId("participant-long-action");
      const longBounds = await longAction.evaluate(node => ({ width: node.clientWidth, scroll: node.scrollWidth, height: node.clientHeight, scrollHeight: node.scrollHeight }));
      expect(longBounds.width).toBeLessThanOrEqual(160);
      expect(longBounds.scroll).toBeLessThanOrEqual(longBounds.width);
      expect(longBounds.scrollHeight).toBeLessThanOrEqual(longBounds.height);
      await selectFamily(page, "participants");
      const compact = page.getByTestId("participant-compact-m0");
      expect((await page.getByTestId("participants-compact").boundingBox())!.width).toBe(72);
      const geometry = await compact.evaluate(node => {
        const picture = node.querySelector(".cp-person-picture")!.getBoundingClientRect();
        const pin = node.querySelector(".cp-person-presenter-pin")!.getBoundingClientRect();
        const signals = Array.from(node.querySelectorAll(".cp-person-signal")).map(signal => signal.getBoundingClientRect()).filter(bounds => bounds.width > 0);
        const controls = Array.from(node.querySelectorAll(".cp-person-ctl")).map(control => control.getBoundingClientRect()).filter(bounds => bounds.width > 0);
        const overlap = (a: DOMRect, b: DOMRect) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > .1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > .1;
        const chrome = [...signals, ...controls];
        return { picture: { width: picture.width, height: picture.height }, outerOverflow: getComputedStyle(node).overflow,
          pictureOverflow: getComputedStyle(node.querySelector(".cp-person-picture")!).overflow,
          pinOutside: pin.right > picture.right && pin.bottom > picture.bottom,
          overlaps: chrome.some((a, i) => chrome.slice(i + 1).some(b => overlap(a, b))),
          chromeAfterPicture: chrome.every(bounds => bounds.top >= pin.bottom),
          controls: controls.map(bounds => ({ width: bounds.width, height: bounds.height })) };
      });
      expect(geometry.picture).toEqual({ width: 48, height: 48 });
      expect(geometry.outerOverflow).toBe("visible");
      expect(geometry.pictureOverflow).toBe("hidden");
      expect(geometry.pinOutside).toBe(true);
      expect(geometry.overlaps).toBe(false);
      expect(geometry.chromeAfterPicture).toBe(true);
      expect(geometry.controls).toEqual([]);
      const trigger = page.getByTestId("participant-trigger-compact-m0");
      await trigger.focus();
      await trigger.press("Enter");
      await expect(page.getByTestId("participant-menu-compact-m0")).toBeVisible();
      const menu = page.getByTestId("participant-menu-compact-m0");
      await expectInsideViewport(menu, page);
      await expect(menu.getByRole("menuitem").first()).toHaveCSS("font-size", enlarged ? "15px" : "12px");
      await page.screenshot({ path: testInfo.outputPath("catalog-participant-details.png") });
      await page.keyboard.press("Escape");
      // Put a real trigger near the bottom edge by scrolling its actual surface,
      // not by replacing bounds or reparenting it into a test-only wrapper.
      await trigger.evaluate(node => {
        const main = node.closest("main")!;
        main.scrollTop += node.getBoundingClientRect().bottom - (window.innerHeight - 16);
      });
      await trigger.focus();
      await settleCatalogScroll(page);
      await trigger.press("Shift+F10");
      await expect(menu).toBeVisible();
      await expectInsideViewport(menu, page);
      await page.screenshot({ path: testInfo.outputPath("catalog-participant-edge.png") });
    });
  }
}
