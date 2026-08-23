export type AuthMethod = "access" | "project_key";

export interface AuthContext {
  actor: string;
  method: AuthMethod;
  scopes: string[];
  projectId?: string;
  keyId?: string;
}

export interface Env {
  DB: D1Database;
  BLOCKS: R2Bucket;
  OBJECTS: R2Bucket;
  STAGING: R2Bucket;
  RECOVERY: R2Bucket;
  CACHE: KVNamespace;
  ANALYTICS?: AnalyticsEngineDataset;
  JOBS: Queue<JobMessage>;
  REPLICATION_WORKFLOW?: { create(input: { id: string; params: Record<string, unknown> }): Promise<unknown> };
  UPLOAD_LOCKS: DurableObjectNamespace;
  SECURITY_GATE: DurableObjectNamespace;
  ASSETS: Fetcher;
  ENVIRONMENT: string;
  ALLOWED_EMAIL?: string;
  ACCESS_AUD?: string;
  ACCESS_TEAM_DOMAIN?: string;
  APP_ORIGIN?: string;
  DASHBOARD_ORIGIN?: string;
  ADMIN_PASSWORD_HASH?: string;
  SESSION_SECRET?: string;
  GATEWAY_HOST: string;
  MAX_UPLOAD_BYTES: string;
  STORAGE_QUOTA_BYTES?: string;
  DAILY_UPLOAD_BYTES?: string;
  MUTATION_RATE_LIMIT_PER_MINUTE?: string;
  LOGIN_RATE_LIMIT_PER_15_MINUTES?: string;
  PUBLIC_GATEWAY_RATE_PER_MINUTE?: string;
  MAX_DAG_DEPTH: string;
  IMPORT_GATEWAYS: string;
  PROJECT_KEY_PEPPER?: string;
  REPLICATION_SIGNING_SECRET?: string;
  KUBO_NODE_PRIMARY_URL?: string;
  KUBO_NODE_SECONDARY_URL?: string;
  KUBO_NODE_PRIMARY_TOKEN?: string;
  KUBO_NODE_SECONDARY_TOKEN?: string;
  RECOVERY_KEY?: string;
  IPNS_SIGNING_KEY?: string;
}

export interface Variables {
  auth: AuthContext;
  projectId?: string;
  projectSlug?: string;
  publicGateway?: boolean;
}

export interface JobMessage {
  id: string;
  type: "verify_pin" | "gc" | "import_cid" | "recovery_snapshot" | "replicate_public" | "unpublish_public";
  payload: Record<string, unknown>;
}

export interface UploadRow {
  id: string;
  project_id: string;
  object_key: string;
  multipart_id: string;
  name: string;
  mime: string;
  size: number;
  chunk_size: number;
  part_size: number;
  part_count: number;
  mode: "standard" | "sealed";
  state: string;
  root_cid: string | null;
  metadata_json: string;
  completed_parts_json: string;
  created_at: string;
  updated_at: string;
  expires_at: string;
  error: string | null;
  created_by_key_id: string | null;
}

export interface ObjectRow {
  root_cid: string;
  object_key: string;
  size: number;
  mime: string;
  name: string;
  mode: "standard" | "sealed";
  metadata_json: string;
  created_at: string;
}
