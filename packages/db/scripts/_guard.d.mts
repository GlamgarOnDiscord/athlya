export function guardConnectionString(
  connectionString: string,
  opts?: { destructive?: boolean },
): void;

export function readPasswordFromStdin(prompt?: string): Promise<string>;
