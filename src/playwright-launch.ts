import { parseBoolean } from "./utils.js";

function shouldStartMinimized(headless: boolean): boolean {
  if (headless) return false;
  return parseBoolean(process.env.PW_START_MINIMIZED, false);
}

export function buildPlaywrightLaunchOptions(headless: boolean): {
  headless: boolean;
  args?: string[];
} {
  if (!shouldStartMinimized(headless)) {
    return { headless };
  }

  return {
    headless,
    args: ["--start-minimized"]
  };
}
