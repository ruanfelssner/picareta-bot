export function buildPlaywrightLaunchOptions(headless: boolean): { headless: boolean; args?: string[] } {
  const startMinimized = !headless && (process.env.PW_START_MINIMIZED === '1' || process.env.PW_START_MINIMIZED === 'true')
  if (!startMinimized) return { headless }
  return { headless, args: ['--start-minimized'] }
}
