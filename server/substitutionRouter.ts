/**
 * substitutionRouter.ts – tRPC-Endpunkte für Smart Substitution
 *
 * Endpunkte:
 *   substitution.getConfig  – Liest ob Feature aktiviert ist
 *   substitution.setEnabled – Aktiviert/deaktiviert das Feature global
 *
 * Nur Admin-User dürfen den Status ändern.
 * Lesen ist für alle eingeloggten WaWi-User erlaubt.
 */

import { z } from "zod";
import { router, adminProcedure, productManagerProcedure } from "./trpc.js";
import { isSubstitutionEnabled, setSubstitutionEnabled } from "./substitutionService.js";

export const substitutionRouter = router({
  /**
   * Liest die aktuelle Konfiguration.
   * Zugänglich für alle eingeloggten WaWi-User (auch product_manager).
   */
  getConfig: productManagerProcedure.query(async () => {
    const enabled = await isSubstitutionEnabled();
    return { enabled };
  }),

  /**
   * Aktiviert oder deaktiviert Smart Substitution global.
   * Nur Admin-User dürfen das ändern.
   */
  setEnabled: adminProcedure
    .input(z.object({ enabled: z.boolean() }))
    .mutation(async ({ input }) => {
      await setSubstitutionEnabled(input.enabled);
      return { success: true, enabled: input.enabled };
    }),
});
