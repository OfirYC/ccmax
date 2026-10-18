export const telemetryPeriods=['today','5h','7d','30d'] as const;
export type TelemetryPeriod=typeof telemetryPeriods[number];
