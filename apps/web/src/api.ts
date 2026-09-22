import type {
  ActionIntent,
  DemoSession,
  Health,
  IncidentDetail,
  IncidentSummary,
  PolicyPreview,
  PolicyVersion,
  StreamIssueCard,
  WorkspaceInfo,
} from "@livestream/contracts";

export interface ApiFailure {
  status: number;
  code: string;
  message: string;
  current?: Record<string, unknown>;
}

export class ApiError extends Error {
  failure: ApiFailure;
  constructor(failure: ApiFailure) {
    super(failure.message);
    this.name = "ApiError";
    this.failure = failure;
  }
  get code(): string {
    return this.failure.code;
  }
  get status(): number {
    return this.failure.status;
  }
}

async function request<T>(path: string, init: RequestInit, token: string | null): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (init.headers) Object.assign(headers, init.headers as Record<string, string>);
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(path, { ...init, headers });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? (JSON.parse(text) as unknown) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const b = (body ?? {}) as { code?: string; message?: string; current?: Record<string, unknown> };
    const failure: ApiFailure = {
      status: res.status,
      code: b.code ?? "bad_request",
      message: b.message ?? `Request failed (${res.status}).`,
    };
    if (b.current !== undefined) failure.current = b.current;
    throw new ApiError(failure);
  }
  return body as T;
}

const get = <T,>(path: string, token: string | null): Promise<T> =>
  request<T>(path, { method: "GET" }, token);
const post = <T,>(path: string, token: string | null, body?: unknown, extra?: Record<string, string>): Promise<T> => {
  const init: RequestInit = { method: "POST" };
  if (body !== undefined) init.body = JSON.stringify(body);
  if (extra !== undefined) init.headers = extra;
  return request<T>(path, init, token);
};

export const api = {
  login: (username: string): Promise<DemoSession> =>
    post("/api/demo/login", null, { username }),
  workspace: (ws: string, token: string): Promise<WorkspaceInfo> =>
    get(`/api/workspaces/${ws}`, token),
  incidents: (ws: string, token: string, status: string): Promise<{ incidents: IncidentSummary[]; nextCursor: string | null }> =>
    get(`/api/workspaces/${ws}/incidents?status=${status}&limit=50`, token),
  incident: (ws: string, token: string, id: string, reveal = false): Promise<IncidentDetail> =>
    get(`/api/workspaces/${ws}/incidents/${id}${reveal ? "?reveal=1" : ""}`, token),
  claim: (ws: string, token: string, id: string, expectedVersion: number): Promise<IncidentSummary> =>
    post(`/api/workspaces/${ws}/incidents/${id}/claim`, token, { expectedVersion }),
  release: (ws: string, token: string, id: string): Promise<IncidentSummary> =>
    post(`/api/workspaces/${ws}/incidents/${id}/release`, token, {}),
  resolve: (ws: string, token: string, id: string, expectedVersion: number, disposition: "resolved" | "dismissed", reason: string): Promise<IncidentSummary> =>
    post(`/api/workspaces/${ws}/incidents/${id}/resolve`, token, { expectedVersion, disposition, reason }),
  policy: (ws: string, token: string): Promise<{ policy: PolicyVersion; preview: PolicyPreview }> =>
    get(`/api/workspaces/${ws}/policy`, token),
  policyPreview: (ws: string, token: string, draft: { preset: string; nuance: string; blockedDomains: string[] }): Promise<PolicyPreview> =>
    post(`/api/workspaces/${ws}/policy/preview`, token, draft),
  savePolicy: (ws: string, token: string, draft: { preset: string; nuance: string; blockedDomains: string[] }): Promise<{ policy: PolicyVersion; preview: PolicyPreview }> =>
    post(`/api/workspaces/${ws}/policy`, token, draft),
  setMode: (ws: string, token: string, mode: "preview" | "assist"): Promise<WorkspaceInfo> =>
    post(`/api/workspaces/${ws}/mode`, token, { mode }),
  setPaused: (ws: string, token: string, paused: boolean): Promise<WorkspaceInfo> =>
    post(`/api/workspaces/${ws}/automation/pause`, token, { paused }),
  health: (ws: string, token: string): Promise<Health> =>
    get(`/api/workspaces/${ws}/health`, token),
  streamIssues: (ws: string, token: string): Promise<StreamIssueCard> =>
    get(`/api/workspaces/${ws}/stream-issues`, token),
  createAction: (
    ws: string,
    token: string,
    key: string,
    body: { incidentId: string; action: string; targetMessageId?: string; targetUserId: string; durationSeconds?: number; expectedIncidentVersion: number; expectedPolicyVersion: number }
  ): Promise<ActionIntent> =>
    post(`/api/workspaces/${ws}/actions`, token, body, { "Idempotency-Key": key }),
  approveAction: (ws: string, token: string, id: string, expectedIncidentVersion: number, expectedPolicyVersion: number): Promise<ActionIntent> =>
    post(`/api/workspaces/${ws}/actions/${id}/approve`, token, { expectedIncidentVersion, expectedPolicyVersion }),
  getAction: (ws: string, token: string, id: string): Promise<ActionIntent> =>
    get(`/api/workspaces/${ws}/actions/${id}`, token),
  listActions: (ws: string, token: string, incidentId: string): Promise<{ actions: ActionIntent[] }> =>
    get(`/api/workspaces/${ws}/actions?incidentId=${incidentId}`, token),
  reconcileAction: (ws: string, token: string, id: string): Promise<ActionIntent> =>
    post(`/api/workspaces/${ws}/actions/${id}/reconcile`, token, {}),
};
