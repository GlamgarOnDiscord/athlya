export interface TestAccount {
  readonly role: 'admin' | 'manager' | 'accueil' | 'coach' | 'member';
  readonly displayName: string;
  readonly email: string;
}

export const TEST_STUDIO: Readonly<{ slug: string; name: string }>;

export const TEST_ACCOUNTS: readonly TestAccount[];

export const CONSENTS_VERSION: string;

export function parseArgs(argv: readonly string[]): { allowProduction: boolean };

export function readSeedEnvironment(
  env: Record<string, string | undefined>,
  flags: { allowProduction: boolean },
): { databaseUrl: string; password: string };

export function seedConsents(now: Date): {
  marketing: boolean;
  analytics: boolean;
  thirdParty: boolean;
  version: string;
  updatedAt: string;
};
