import { databaseHealth } from "./databaseHealthState";
import { seamlessBackgroundPaused } from "./seamlessMigrationState";

// Database recovery and migration recovery are independent. Notification
// workers only observe these protections; they never clear either state.
export function notificationBackgroundPaused() {
  return databaseHealth.snapshot().state === "unavailable" || seamlessBackgroundPaused();
}
