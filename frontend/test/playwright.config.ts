import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "node:url";

// Camera-capture tests need a video device. By default CI uses a synthetic
// stream via Chrome flags; set REAL_CAMERA=1 to use the actual hardware
// (only with --headed so the user can grant permission).
const realCamera = process.env.REAL_CAMERA === "1";
const chromiumCameraArgs = realCamera ? [] : ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"];

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 1,
  reporter: process.env.CI ? "blob" : "html",
  use: {
    baseURL: process.env.E2E_BASE_URL || "http://localhost:3000",
    trace: "on-all-retries",
    video: "retry-with-video",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: {
          args: chromiumCameraArgs,
        },
      },
    },
    {
      name: "firefox",
      use: {
        ...devices["Desktop Firefox"],
        launchOptions: {
          firefoxUserPrefs: {
            "media.navigator.permission.disabled": true,
            // Firefox's fake device: media.getusermedia.fake.devices.* prefs are limited;
            // camera tests are skipped on FF for now (handled by test.skip if needed).
          },
        },
      },
    },
    {
      name: "webkit",
      use: { ...devices["Desktop Safari"] },
    },
  ],
  globalTeardown: fileURLToPath(new URL("./playwright.teardown.ts", import.meta.url)),
});
