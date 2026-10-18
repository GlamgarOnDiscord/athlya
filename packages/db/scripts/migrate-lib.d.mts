export function requiresNoTransaction(body: string): boolean;

export function splitSqlStatements(body: string): string[];

export function planMigration(body: string): { transactional: boolean; queries: string[] };
