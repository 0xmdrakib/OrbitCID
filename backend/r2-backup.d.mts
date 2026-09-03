export interface R2BackupConfig {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  prefix?: string;
  retentionDays?: number;
}

export interface R2BackupStatus {
  configured: boolean;
  provider: "cloudflare-r2";
  state: string;
  bucket?: string;
  prefix?: string;
  retentionDays?: number;
  accountHint?: string;
  lastStartedAt?: string | null;
  lastCompletedAt?: string | null;
  lastError?: string | null;
}

export class R2BackupManager {
  constructor(pairing: Record<string, unknown>, options?: { configPath?: string; statusPath?: string; backupDirectory?: string; kuboApi?: string; script?: string });
  save(input: R2BackupConfig): Promise<R2BackupStatus>;
  remove(): Promise<R2BackupStatus>;
  status(): Promise<R2BackupStatus>;
  start(): Promise<R2BackupStatus & { accepted: boolean }>;
  restore(snapshot?: string): Promise<string>;
}
