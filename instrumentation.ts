/** Runs once when a server instance boots: fail fast if the configuration is invalid. */
export async function register(): Promise<void> {
  const { config } = await import('./lib/config');
  config();
}
