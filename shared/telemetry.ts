import { z } from 'zod';
export { telemetryPeriods,type TelemetryPeriod } from './telemetry-periods.js';
const count=z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable();
const amount=z.string().regex(/^(0|[1-9]\d*)(\.\d+)?$/).nullable();
const stamp=z.iso.datetime({offset:true}).nullable();
const period=z.object({requests:count,tokens:count,billedUsd:amount,officialUsd:amount,cacheCreditUsd:amount,
  models:z.array(z.object({model:z.enum(['opus','fable']),usageUsd:amount}).strict()).max(2)}).strict();
export const telemetrySchema=z.object({
  version:z.literal(1),collectedAt:z.iso.datetime({offset:true}),sourceAt:stamp,day:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  source:z.enum(['account_list','account_detail']),detail:z.enum(['available','unavailable']),
  modelsAt:stamp,
  activity:z.object({rpm:count,tpm:count,concurrent:count,sessions:count}).strict(),
  limits:z.object({rpm:count,tpm:count,concurrent:count}).strict(),
  quota:z.object({fiveHour:count,sevenDay:count,reset5h:stamp,reset7d:stamp,updatedAt:stamp}).strict(),
  health:z.object({requests24h:count,successful24h:count,limited24h:count}).strict(),
  // The current supplier APIs do not expose cache tokens with a proven account
  // identity. Never substitute a shared master key's logs or cache credit USD.
  cacheTokens:z.null(),requestLogs:z.literal('unavailable'),
  periods:z.object({today:period,'5h':period,'7d':period,'30d':period}).strict(),
}).strict();
export type AccountTelemetry=z.infer<typeof telemetrySchema>;
export const emptyPeriod=():AccountTelemetry['periods']['today']=>({requests:null,tokens:null,billedUsd:null,officialUsd:null,cacheCreditUsd:null,models:[]});
