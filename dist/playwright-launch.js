import { parseBoolean } from "./utils.js";
function shouldStartMinimized(headless) {
    if (headless)
        return false;
    return parseBoolean(process.env.PW_START_MINIMIZED, false);
}
export function buildPlaywrightLaunchOptions(headless) {
    if (!shouldStartMinimized(headless)) {
        return { headless };
    }
    return {
        headless,
        args: ["--start-minimized"]
    };
}
