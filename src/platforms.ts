import { platformName as publicName, platformNames } from '../shared/platforms';
import { t } from './i18n';
export { platformNames };
export const platformName=(provider:string)=>t(publicName(provider));
