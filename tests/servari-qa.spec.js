const { test, expect } = require("@playwright/test");

const base = process.env.SERVARI_QA_BASE || "http://127.0.0.1:8998";
const routes = [
  "/shell",
  "/shell/settings",
  "/shell/org-chart",
  "/shell/agent-apps",
  "/shell/trading",
  "/shell/cv-builder",
  "/shell/standing-orders",
  "/shell/chat",
  "/shell/runtime",
];

async function expectNoHorizontalOverflow(page, label) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2);
  expect(overflow, `${label} overflow`).toBe(false);
}

async function expectCanvasNonBlank(page, selector, label) {
  const result = await page.evaluate((sel) => {
    const root = document.querySelector(sel);
    if (!root) return { present: false, nonblank: false, canvases: 0 };
    const canvases = root.matches("canvas") ? [root] : Array.from(root.querySelectorAll("canvas"));
    for (const canvas of canvases) {
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) continue;
      const width = Math.min(160, canvas.width);
      const height = Math.min(120, canvas.height);
      if (width <= 0 || height <= 0) continue;
      const data = ctx.getImageData(0, 0, width, height).data;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] > 6 || data[i + 1] > 6 || data[i + 2] > 6 || data[i + 3] > 6) {
          return { present: true, nonblank: true, canvases: canvases.length };
        }
      }
    }
    return { present: true, nonblank: false, canvases: canvases.length };
  }, selector);
  expect(result.present, `${label} present`).toBe(true);
  expect(result.nonblank, `${label} nonblank ${JSON.stringify(result)}`).toBe(true);
}

test("SERVARI route walk and visual smoke", async ({ page }) => {
  test.setTimeout(180000);
  const failures = [];
  page.on("console", (msg) => { if (msg.type() === "error") failures.push(msg.text()); });
  page.on("pageerror", (err) => failures.push(err.message));

  for (const route of routes) {
    await page.setViewportSize({ width: 1366, height: 820 });
    await page.goto(base + route, { waitUntil: "domcontentloaded" });
    await expect(page.locator("body")).toBeVisible();
    await page.waitForTimeout(700);
    const bodyText = await page.locator("body").innerText();
    expect(bodyText).not.toContain("UI has not been built yet");
    expect(bodyText.length).toBeGreaterThan(20);
    await expectNoHorizontalOverflow(page, `${route} desktop`);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(250);
    await expectNoHorizontalOverflow(page, `${route} mobile`);
  }

  await page.setViewportSize({ width: 1366, height: 820 });
  await page.goto(base + "/shell/org-chart", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  const graph = page.locator('canvas[data-servari-graph3d="true"]');
  await expect(graph).toBeVisible();
  const box = await graph.boundingBox();
  expect(box).toBeTruthy();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 140, box.y + box.height / 2 + 70, { steps: 8 });
  await page.mouse.up();
  await page.mouse.wheel(0, -420);
  await page.waitForTimeout(300);
  const fixedOffscreen = await page.evaluate(() => Array.from(document.querySelectorAll("*")).some((el) => {
    const style = getComputedStyle(el);
    if (style.position !== "fixed" || style.visibility === "hidden") return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 40 || rect.height < 20) return false;
    return rect.bottom > window.innerHeight + 2 || rect.top < -2 || rect.right > window.innerWidth + 2 || rect.left < -2;
  }));
  expect(fixedOffscreen, "fixed HUDs stay readable").toBe(false);
  const graphInfo = await page.evaluate(() => {
    const canvas = document.querySelector('canvas[data-servari-graph3d="true"]');
    if (!canvas) return { present: false, nonblank: false };
    const gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
    if (!gl) return { present: true, nonblank: false };
    const data = new Uint8Array(128 * 128 * 4);
    gl.readPixels(Math.max(0, Math.floor(canvas.width / 2 - 64)), Math.max(0, Math.floor(canvas.height / 2 - 64)), 128, 128, gl.RGBA, gl.UNSIGNED_BYTE, data);
    for (let i = 0; i < data.length; i += 4) if (data[i] > 3 || data[i + 1] > 3 || data[i + 2] > 3 || data[i + 3] > 3) return { present: true, nonblank: true };
    return { present: true, nonblank: false };
  });
  expect(graphInfo.present).toBe(true);
  expect(graphInfo.nonblank).toBe(true);
  await page.screenshot({ path: "output/playwright/org-chart-3d.png", fullPage: true });

  await page.goto(base + "/shell/trading", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1200);
  await expect(page.locator('[data-servari-trading-chart="true"]')).toBeVisible();
  await expectCanvasNonBlank(page, '[data-servari-trading-chart="true"]', "trading chart");
  await page.getByRole("button", { name: "4H" }).click();
  await page.getByPlaceholder("Symbol").fill("MSFT");
  await page.keyboard.press("Enter");
  await expect(page.getByText("MSFT", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Use last" }).click();
  await page.getByRole("button", { name: "Research" }).first().click();
  await expect(page.getByText("Research Queue")).toBeVisible();
  await expectNoHorizontalOverflow(page, "trading after interactions");
  await page.screenshot({ path: "output/playwright/trading-desk.png", fullPage: true });

  await page.goto(base + "/shell/settings", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(700);
  await expect(page.locator("body")).toContainText("OpenAI Codex CLI");
  await expect(page.locator("body")).toContainText("Claude CLI");
  await expect(page.locator("body")).toContainText("OpenClaw CLI");
  await expect(page.getByRole("link", { name: "OpenAI keys" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open/Login" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Configure" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Dashboard" })).toBeVisible();
  await page.screenshot({ path: "output/playwright/settings.png", fullPage: true });

  await page.goto(base + "/shell/cv-builder", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(700);
  await page.screenshot({ path: "output/playwright/cv-builder.png", fullPage: true });
  await page.goto(base + "/shell/standing-orders", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(700);
  await page.screenshot({ path: "output/playwright/standing-orders.png", fullPage: true });

  expect(failures).toEqual([]);
});
