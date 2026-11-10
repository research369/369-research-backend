import { isPriorityOrderIntegrityReady } from './priorityOrderIntegrity.js';
import { isPermissionsSchemaReady } from './permissionsSchema.js';
import { isAccountSecuritySchemaReady } from './accountSecuritySchema.js';
import { isPartnerFinancialSchemaReady } from './partnerFinancialSchema.js';
export type HardeningReadiness = {
  orderIntegrityReady: boolean;
  permissionsSchemaReady: boolean;
  accountSecurityReady: boolean;
  partnerFinancialLedgerReady: boolean;
};
export function allHardeningSchemasReady(state: HardeningReadiness): boolean {
  return state.orderIntegrityReady && state.permissionsSchemaReady
    && state.accountSecurityReady && state.partnerFinancialLedgerReady;
}
export function releaseHardeningReadiness(): HardeningReadiness {
  return {
    orderIntegrityReady: isPriorityOrderIntegrityReady(),
    permissionsSchemaReady: isPermissionsSchemaReady(),
    accountSecurityReady: isAccountSecuritySchemaReady(),
    partnerFinancialLedgerReady: isPartnerFinancialSchemaReady(),
  };
}
