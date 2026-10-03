import { defineConfig } from "@playwright/test";
import path from "node:path";

export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  use: {
    baseURL: "http://127.0.0.1:3127",
    browserName: "chromium",
    channel: "chromium",
    headless: true,
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run dev -- --hostname 127.0.0.1 --port 3127",
    url: "http://127.0.0.1:3127",
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      NEXT_DIST_DIR: "output/playwright/next",
      EXAMS_DB_PATH: path.resolve("output/playwright/exams.db"),
      LEARNING_DB_PATH: path.resolve("output/playwright/learning.db"),
      FOUNDRY_PROJECT_ENDPOINT: "",
      FOUNDRY_OPENAI_ENDPOINT: "",
      FOUNDRY_API_KEY: "",
      FOUNDRY_MODEL: "",
    },
  },
});
