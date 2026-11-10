import { sql, type SQL } from "drizzle-orm";
import type { QueryResultRow } from "pg";
import type { PartnerCreditQueryClient } from "./partnerCreditService.js";

/** Translate trusted ledger SQL ($1, $2, ...) without interpolating any values as SQL. */
export function parameterizePartnerCreditQuery(text: string, values: unknown[] = []): SQL {
  const chunks = text.split(/(\$\d+)/g).map(part => {
    if (!/^\$\d+$/.test(part)) return sql.raw(part);
    const index = Number(part.slice(1)) - 1;
    if (!Number.isSafeInteger(index) || index < 0 || index >= values.length) {
      throw new Error("PARTNER_CREDIT_QUERY_PARAMETER_MISSING");
    }
    return sql`${values[index]}`;
  });
  return sql.join(chunks, sql``);
}

/** Caller supplies the existing transaction's public execute API, never a pool. */
export function createPartnerCreditTransactionQueryClient(
  execute: (query: SQL) => Promise<{ rows: QueryResultRow[] }>,
): PartnerCreditQueryClient {
  return {
    async query<Row extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]) {
      const result = await execute(parameterizePartnerCreditQuery(text, values));
      return { rows: result.rows as Row[] };
    },
  };
}
