import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { ApiError, api } from "./api";

const DEMO_USERS = [
  { username: "alice", label: "Alice — Owner (Alpha)" },
  { username: "bob", label: "Bob — Moderator (Alpha)" },
  { username: "cara", label: "Cara — Moderator (Alpha)" },
  { username: "dave", label: "Dave — Owner (Beta)" },
  { username: "erin", label: "Erin — Moderator (Beta)" },
];

function severityLabel(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function categoryLabel(c: string): string {
  return c
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function actionStateLabel(a: ActionIntent): string {
  const sim = "simulated";
  switch (a.state) {
    case "awaiting_approval":
      return "Awaiting approval";
    case "queued":
      return `Queued (${sim})`;
    case "submitting":
      return `Submitting (${sim})`;
    case "succeeded":
      return `Simulated — recorded in simulation ledger (not a live action)`;
    case "unknown":
      return "Outcome unknown — reconcile before any retry";
    case "reconciled_succeeded":
      return "Reconciled: simulated effect confirmed in ledger";
    case "refused":
      return "Refused";
    case "expired":
      return "Expired — re-request against current evidence";
    case "cancelled":
      return "Cancelled";
    case "superseded":
      return "Superseded — evidence or policy changed";
    default:
      return a.state;
  }
}

export function App(): JSX.Element {
  const [session, setSession] = useState<DemoSession | null>(() => {
    try {
      const raw = sessionStorage.getItem("demo-session");
      return raw ? (JSON.parse(raw) as DemoSession) : null;
    } catch {
      return null;
    }
  });
  const [loginError, setLoginError] = useState<string | null>(null);

  const login = useCallback(async (username: string) => {
    setLoginError(null);
    try {
      const s = await api.login(username);
      sessionStorage.setItem("demo-session", JSON.stringify(s));
      setSession(s);
    } catch (err) {
      setLoginError(err instanceof ApiError ? err.message : "Login failed.");
    }
  }, []);

  const logout = useCallback(() => {
    sessionStorage.removeItem("demo-session");
    setSession(null);
  }, []);

  return (
    <div className="app">
      <div className="demo-banner" role="banner" data-testid="demo-banner">
        DEMO — synthetic data only. No real chat, no live moderation, no real viewers.
      </div>
      {!session ? (
        <LoginView onLogin={login} error={loginError} />
      ) : (
        <WorkspaceView session={session} onLogout={logout} />
      )}
    </div>
  );
}

function LoginView(props: { onLogin: (u: string) => void; error: string | null }): JSX.Element {
  return (
    <main className="login">
      <h1>Livestream Copilot — Demo</h1>
      <p>
        Keep up with chat without handing it over to a ban bot. This demo uses labeled fictional
        chat across two isolated workspaces. Preview makes no changes anywhere.
      </p>
      <h2>Choose a seeded demo identity</h2>
      <div className="login-grid">
        {DEMO_USERS.map((u) => (
          <button key={u.username} data-testid={`login-${u.username}`} onClick={() => props.onLogin(u.username)}>
            {u.label}
          </button>
        ))}
      </div>
      {props.error ? (
        <p role="alert" className="error">
          {props.error}
        </p>
      ) : null}
      <p className="muted">Development demo auth only. Production refuses demo login.</p>
    </main>
  );
}

function WorkspaceView(props: { session: DemoSession; onLogout: () => void }): JSX.Element {
  const { session } = props;
  const ws = session.workspaceId;
  const token = session.token;
  const [info, setInfo] = useState<WorkspaceInfo | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [stream, setStream] = useState<StreamIssueCard | null>(null);
  const [filter, setFilter] = useState<string>("open");
  const [incidents, setIncidents] = useState<IncidentSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<IncidentDetail | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [announce, setAnnounce] = useState<string>("");
  const [freezeList, setFreezeList] = useState(false);
  const [showPolicy, setShowPolicy] = useState(false);
  const [confirmAssist, setConfirmAssist] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selectedId;

  const refreshAll = useCallback(async () => {
    try {
      const [w, h, s] = await Promise.all([
        api.workspace(ws, token),
        api.health(ws, token),
        api.streamIssues(ws, token),
      ]);
      setInfo(w);
      setHealth(h);
      setStream(s);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : "Failed to load workspace.");
    }
  }, [ws, token]);

  const refreshList = useCallback(async () => {
    try {
      const res = await api.incidents(ws, token, filter);
      setIncidents(res.incidents);
      const prevCount = 0;
      void prevCount;
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : "Failed to load incidents.");
    }
  }, [ws, token, filter]);

  const refreshDetail = useCallback(
    async (id: string, reveal = false) => {
      try {
        const d = await api.incident(ws, token, id, reveal);
        setDetail(d);
      } catch (err) {
        setError(err instanceof ApiError ? `${err.code}: ${err.message}` : "Failed to load incident.");
      }
    },
    [ws, token]
  );

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  useEffect(() => {
    if (!freezeList) void refreshList();
  }, [refreshList, freezeList]);

  useEffect(() => {
    if (selectedId) void refreshDetail(selectedId);
    else setDetail(null);
  }, [selectedId, refreshDetail]);

  // Live updates: SSE with polling fallback. List refresh is skipped while
  // frozen so controls never move under the cursor.
  useEffect(() => {
    let stopped = false;
    let es: EventSource | null = null;
    try {
      es = new EventSource(`/api/workspaces/${ws}/events?token=${encodeURIComponent(token)}`);
      es.addEventListener("update", () => {
        if (stopped) return;
        void refreshAll();
        if (!freezeList) void refreshList();
        const id = selectedRef.current;
        if (id) void refreshDetail(id);
      });
    } catch {
      es = null;
    }
    const fallback = setInterval(() => {
      if (stopped) return;
      void refreshAll();
      if (!freezeList) void refreshList();
    }, 8000);
    return () => {
      stopped = true;
      clearInterval(fallback);
      if (es) es.close();
    };
  }, [ws, token, freezeList, refreshAll, refreshList, refreshDetail]);

  const criticalCount = useMemo(
    () => incidents.filter((i) => i.severity === "critical").length,
    [incidents]
  );
  useEffect(() => {
    if (criticalCount > 0) setAnnounce(`${criticalCount} critical incident(s) in view.`);
    else setAnnounce("");
  }, [criticalCount]);

  const selectIncident = useCallback(
    (id: string) => {
      setSelectedId(id);
      setNotice(null);
    },
    []
  );

  const doClaim = useCallback(async () => {
    if (!detail) return;
    setNotice(null);
    try {
      const updated = await api.claim(ws, token, detail.id, detail.version);
      setNotice(`Claimed incident (version ${updated.version}).`);
      await refreshDetail(detail.id);
      if (!freezeList) await refreshList();
    } catch (err) {
      setNotice(err instanceof ApiError ? `Claim failed [${err.code}]: ${err.message}` : "Claim failed.");
      if (detail) await refreshDetail(detail.id);
    }
  }, [detail, ws, token, refreshDetail, refreshList, freezeList]);

  const doResolve = useCallback(
    async (disposition: "resolved" | "dismissed") => {
      if (!detail) return;
      setNotice(null);
      const reason = window.prompt(`Reason (${disposition}):`, disposition === "resolved" ? "Reviewed with team" : "Acceptable chat");
      if (!reason) return;
      try {
        await api.resolve(ws, token, detail.id, detail.version, disposition, reason);
        setNotice(`Incident ${disposition}.`);
        if (!freezeList) await refreshList();
        await refreshDetail(detail.id);
      } catch (err) {
        setNotice(err instanceof ApiError ? `Failed [${err.code}]: ${err.message}` : "Failed.");
        await refreshDetail(detail.id);
      }
    },
    [detail, ws, token, refreshDetail, refreshList, freezeList]
  );

  const doMode = useCallback(
    async (mode: "preview" | "assist") => {
      setNotice(null);
      try {
        const w = await api.setMode(ws, token, mode);
        setInfo(w);
        setConfirmAssist(false);
        setNotice(mode === "assist" ? "Assist enabled (demo): human-approved SIMULATED actions only." : "Preview enabled: no writes of any kind.");
        void refreshAll();
      } catch (err) {
        setNotice(err instanceof ApiError ? `Mode change failed [${err.code}]: ${err.message}` : "Mode change failed.");
      }
    },
    [ws, token, refreshAll]
  );

  const doPause = useCallback(
    async (paused: boolean) => {
      setNotice(null);
      try {
        const w = await api.setPaused(ws, token, paused);
        setInfo(w);
        setNotice(paused ? "Dispatch paused: new approvals blocked." : "Dispatch resumed by owner.");
        void refreshAll();
      } catch (err) {
        setNotice(err instanceof ApiError ? `Failed [${err.code}]: ${err.message}` : "Failed.");
      }
    },
    [ws, token, refreshAll]
  );

  return (
    <div className="workspace">
      <header className="ws-header">
        <div>
          <h1 data-testid="workspace-name">{info?.name ?? ws}</h1>
          <p className="muted">
            {session.displayName} · {session.role} · channel {info?.channelId ?? "…"}
          </p>
        </div>
        <div className="ws-controls">
          <span className={`mode-badge mode-${info?.mode ?? "preview"}`} data-testid="mode-badge">
            {info?.mode === "assist" ? "Assist (simulated)" : "Preview (no writes)"}
          </span>
          {info?.paused ? (
            <span className="paused-badge" data-testid="paused-badge">
              Dispatch paused
            </span>
          ) : null}
          <button data-testid="policy-btn" onClick={() => setShowPolicy(true)}>
            Policy
          </button>
          {info?.mode === "preview" ? (
            <button data-testid="mode-assist-btn" onClick={() => setConfirmAssist(true)}>
              Switch to Assist
            </button>
          ) : (
            <button data-testid="mode-preview-btn" onClick={() => void doMode("preview")}>
              Back to Preview
            </button>
          )}
          {info?.paused ? (
            <button data-testid="resume-btn" onClick={() => void doPause(false)}>
              Resume dispatch
            </button>
          ) : (
            <button data-testid="pause-btn" onClick={() => void doPause(true)}>
              Pause dispatch
            </button>
          )}
          <button data-testid="logout-btn" onClick={props.onLogout}>
            Log out
          </button>
        </div>
      </header>

      {confirmAssist ? (
        <section className="confirm-panel" aria-label="Confirm Assist" data-testid="assist-confirm">
          <h2>Switch to Assist in this demo workspace?</h2>
          <p>
            Assist enables human-approved <strong>simulated</strong> delete/timeout actions, recorded
            in the simulation ledger only. No live platform calls exist in M0. Every approval expires
            after 120 seconds and is revalidated against current evidence and policy.
          </p>
          <div className="row">
            <button data-testid="assist-confirm-btn" onClick={() => void doMode("assist")}>
              Enable Assist (simulated)
            </button>
            <button onClick={() => setConfirmAssist(false)}>Cancel</button>
          </div>
        </section>
      ) : null}

      <div className="sr-live" aria-live="polite">
        {announce}
      </div>
      {error ? (
        <p role="alert" className="error" data-testid="ws-error">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="notice" data-testid="ws-notice">
          {notice}
        </p>
      ) : null}

      <section className="health" aria-label="Health and coverage" data-testid="health-panel">
        <h2>Health &amp; coverage</h2>
        {health ? (
          <dl>
            <div>
              <dt>Connection</dt>
              <dd>{health.connection === "demo-replay" ? "Demo replay (synthetic)" : health.connection}</dd>
            </div>
            <div>
              <dt>Coverage</dt>
              <dd>{health.coverage}</dd>
            </div>
            <div>
              <dt>Writes</dt>
              <dd>{health.writesDisabledReason}</dd>
            </div>
            <div>
              <dt>Events</dt>
              <dd>
                {health.receivedEvents} received · {health.deduplicatedDeliveries} duplicates ·{" "}
                {health.evaluatedEvents} evaluated · queue {health.queueDepth}
              </dd>
            </div>
            <div>
              <dt>Classifier</dt>
              <dd>Fake deterministic (proves pipeline behavior, not model quality)</dd>
            </div>
          </dl>
        ) : (
          <p>Loading…</p>
        )}
      </section>

      <section className="stream-card" aria-label="Chat-reported stream problems" data-testid="stream-card">
        <h2>Stream problems reported in chat</h2>
        {stream ? (
          stream.incidentId ? (
            <div>
              <p>
                <strong>{stream.headline}</strong>
              </p>
              <p className="muted">
                {stream.messageCount} message(s) · window {stream.windowMinutes} min · reports only, not
                a verified diagnosis · {stream.acknowledged ? "acknowledged" : "unacknowledged"}
              </p>
              <button
                data-testid="stream-view-btn"
                onClick={() => {
                  if (stream.incidentId) selectIncident(stream.incidentId);
                }}
              >
                View reports
              </button>
            </div>
          ) : (
            <p>{stream.headline}</p>
          )
        ) : (
          <p>Loading…</p>
        )}
      </section>

      <div className="inbox-layout">
        <nav className="inbox-list" aria-label="Incident inbox">
          <div className="inbox-toolbar">
            <label>
              Status{" "}
              <select
                data-testid="status-filter"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              >
                <option value="open">Open</option>
                <option value="claimed">Claimed</option>
                <option value="resolved">Resolved</option>
                <option value="dismissed">Dismissed</option>
                <option value="all">All</option>
              </select>
            </label>
            <label className="freeze">
              <input
                type="checkbox"
                data-testid="freeze-list"
                checked={freezeList}
                onChange={(e) => setFreezeList(e.target.checked)}
              />{" "}
              Hold list still
            </label>
          </div>
          {incidents.length === 0 ? (
            <p className="muted" data-testid="inbox-empty">
              {health && health.receivedEvents === 0
                ? "Waiting for replay: run the documented replay command to load synthetic chat."
                : "No incidents in this view."}
            </p>
          ) : (
            <ul data-testid="inbox-list">
              {incidents.map((i) => (
                <li key={i.id}>
                  <button
                    data-testid={`incident-card-${i.id}`}
                    className={`incident-card severity-${i.severity}${selectedId === i.id ? " selected" : ""}`}
                    onClick={() => selectIncident(i.id)}
                    aria-current={selectedId === i.id ? "true" : undefined}
                  >
                    <span className="card-top">
                      <span className="severity">{severityLabel(i.severity)}</span>
                      <span className="category">{categoryLabel(i.category)}</span>
                    </span>
                    <span className="card-title">{i.title}</span>
                    <span className="card-meta">
                      {i.accountCount} account(s) · {i.messageCount} message(s) ·{" "}
                      {new Date(i.lastObservedAt).toLocaleTimeString()} · {i.state}
                      {i.claimedByDisplayName ? ` · claimed by ${i.claimedByDisplayName}` : ""}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </nav>
        <main className="inbox-detail" aria-label="Incident detail">
          {detail ? (
            <IncidentDetailView
              detail={detail}
              workspaceId={ws}
              token={token}
              mode={info?.mode ?? "preview"}
              onClaim={doClaim}
              onResolve={doResolve}
              onRefresh={(reveal) => void refreshDetail(detail.id, reveal)}
              onNotice={setNotice}
            />
          ) : (
            <p className="muted">Select an incident to inspect evidence and act.</p>
          )}
        </main>
      </div>

      {showPolicy ? (
        <PolicyModal
          workspaceId={ws}
          token={token}
          role={session.role}
          onClose={() => setShowPolicy(false)}
          onNotice={setNotice}
        />
      ) : null}
    </div>
  );
}

function IncidentDetailView(props: {
  detail: IncidentDetail;
  workspaceId: string;
  token: string;
  mode: "preview" | "assist";
  onClaim: () => void;
  onResolve: (d: "resolved" | "dismissed") => void;
  onRefresh: (reveal: boolean) => void;
  onNotice: (n: string | null) => void;
}): JSX.Element {
  const { detail, workspaceId, token } = props;
  const [revealed, setRevealed] = useState(false);
  const [actions, setActions] = useState<ActionIntent[]>([]);
  const [targetMessageId, setTargetMessageId] = useState<string>("");
  const [busy, setBusy] = useState(false);
  // One idempotency key per (incident, action, target) attempt: a double click
  // or refresh replays the original operation instead of duplicating it.
  const keysRef = useRef(new Map<string, string>());

  const loadActions = useCallback(async () => {
    try {
      const res = await api.listActions(workspaceId, token, detail.id);
      setActions(res.actions);
    } catch {
      setActions([]);
    }
  }, [workspaceId, token, detail.id]);

  useEffect(() => {
    setRevealed(false);
    setTargetMessageId(detail.evidence[0]?.platformMessageId ?? "");
    void loadActions();
  }, [detail.id, detail.evidence, loadActions]);

  const keyFor = (action: string, target: string): string => {
    const k = `${detail.id}:${action}:${target}`;
    let key = keysRef.current.get(k);
    if (!key) {
      key = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
      keysRef.current.set(k, key);
    }
    return key;
  };

  const requestAction = async (action: "delete_message" | "timeout_user", durationSeconds?: number) => {
    if (props.mode === "preview") {
      props.onNotice("Preview never performs writes. Switch to Assist to request a simulated action.");
      return;
    }
    const first = detail.evidence[0];
    if (!first) {
      props.onNotice("No evidence to target.");
      return;
    }
    const targetUserId = action === "timeout_user" ? (detail.targetUserId ?? first.authorId) : first.authorId;
    const msgTarget = action === "delete_message" ? targetMessageId || first.platformMessageId : undefined;
    setBusy(true);
    try {
      const payload: {
        incidentId: string;
        action: string;
        targetMessageId?: string;
        targetUserId: string;
        durationSeconds?: number;
        expectedIncidentVersion: number;
        expectedPolicyVersion: number;
      } = {
        incidentId: detail.id,
        action,
        targetUserId,
        expectedIncidentVersion: detail.version,
        expectedPolicyVersion: detail.policyVersion,
      };
      if (msgTarget !== undefined) payload.targetMessageId = msgTarget;
      if (durationSeconds !== undefined) payload.durationSeconds = durationSeconds;
      const intent = await api.createAction(workspaceId, token, keyFor(action, msgTarget ?? targetUserId), payload);
      props.onNotice(`Requested simulated ${action} (operation ${intent.id.slice(0, 8)}…). Approve to queue.`);
      await loadActions();
    } catch (err) {
      props.onNotice(err instanceof ApiError ? `Request failed [${err.code}]: ${err.message}` : "Request failed.");
    } finally {
      setBusy(false);
    }
  };

  const approve = async (intent: ActionIntent) => {
    setBusy(true);
    try {
      await api.approveAction(workspaceId, token, intent.id, detail.version, detail.policyVersion);
      props.onNotice("Approved and queued for the simulation executor.");
      await loadActions();
    } catch (err) {
      props.onNotice(err instanceof ApiError ? `Approve failed [${err.code}]: ${err.message}` : "Approve failed.");
      await loadActions();
    } finally {
      setBusy(false);
    }
  };

  const reconcile = async (intent: ActionIntent) => {
    setBusy(true);
    try {
      const updated = await api.reconcileAction(workspaceId, token, intent.id);
      props.onNotice(`Reconciled: ${updated.state}.`);
      await loadActions();
    } catch (err) {
      props.onNotice(err instanceof ApiError ? `Reconcile [${err.code}]: ${err.message}` : "Reconcile failed.");
      await loadActions();
    } finally {
      setBusy(false);
    }
  };

  const reveal = async () => {
    setRevealed(true);
    props.onRefresh(true);
  };

  return (
    <article data-testid="incident-detail">
      <header>
        <h2>{DetailTitle(detail)}</h2>
        <p className="muted">
          {severityLabel(detail.severity)} · {categoryLabel(detail.category)} · {detail.state} · v
          {detail.version} · policy v{detail.policyVersion}
        </p>
      </header>
      <p>{DetailSummary(detail)}</p>
      <dl className="facts">
        <div>
          <dt>Observed pattern</dt>
          <dd>{DetailPattern(detail)}</dd>
        </div>
        <div>
          <dt>Channel rule</dt>
          <dd>{DetailRule(detail)}</dd>
        </div>
        <div>
          <dt>Uncertainty</dt>
          <dd>{DetailUncertainty(detail)}</dd>
        </div>
        <div>
          <dt>Recommendation</dt>
          <dd>{DetailRecommendation(detail)}</dd>
        </div>
      </dl>

      <h3>Evidence ({DetailEvidenceCount(detail)} messages)</h3>
      <ol className="evidence" data-testid="evidence-list">
        {DetailEvidence(detail).map((m) => (
          <li key={m.id}>
            <span className="ev-author">{m.authorName}</span>{" "}
            <span className="ev-time">{new Date(m.providerTime).toLocaleTimeString()}</span>
            <p className="ev-text">{m.masked ? <em>{m.text} </em> : m.text}</p>
            <span className="muted">id {m.platformMessageId} · origin {m.origin}</span>
          </li>
        ))}
      </ol>
      {DetailHasMasked(detail) && !revealed ? (
        <button data-testid="reveal-btn" onClick={() => void reveal()}>
          Reveal masked evidence (audited)
        </button>
      ) : null}

      <h3>Bounded context</h3>
      {DetailContext(detail).length === 0 ? (
        <p className="muted">No additional context in the bounded window.</p>
      ) : (
        <ol className="context">
          {DetailContext(detail).map((m) => (
            <li key={m.id}>
              <span className="ev-author">{m.authorName}</span>: <span className="ev-text">{m.text}</span>
            </li>
          ))}
        </ol>
      )}
      {DetailTruncated(detail) ? <p className="muted">Context truncated to 30 messages.</p> : null}

      <h3>Collaboration</h3>
      <div className="row">
        <button data-testid="claim-btn" onClick={props.onClaim}>
          {detail.state === "claimed" ? "Re-affirm claim" : "Claim"}
        </button>
        <button data-testid="resolve-btn" onClick={() => props.onResolve("resolved")}>
          Resolve
        </button>
        <button data-testid="dismiss-btn" onClick={() => props.onResolve("dismissed")}>
          Dismiss
        </button>
        {DetailClaimedBy(detail) ? <span className="muted">Claimed by {DetailClaimedBy(detail)}</span> : null}
      </div>

      <h3>Actions (simulated)</h3>
      {props.mode === "preview" ? (
        <p className="muted" data-testid="preview-actions-note">
          Preview: recommendations only. Switch to Assist to request simulated delete/timeout actions.
        </p>
      ) : DetailEligible(detail).length === 0 ? (
        <p className="muted">No moderation actions are eligible for this category.</p>
      ) : (
        <div className="row">
          <label>
            Target message{" "}
            <select
              data-testid="target-message-select"
              value={targetMessageId}
              onChange={(e) => setTargetMessageId(e.target.value)}
            >
              {DetailEvidence(detail).map((m) => (
                <option key={m.id} value={m.platformMessageId}>
                  {m.platformMessageId} ({m.authorName})
                </option>
              ))}
            </select>
          </label>
          {DetailEligible(detail).includes("delete_message") ? (
            <button data-testid="action-delete-btn" disabled={busy} onClick={() => void requestAction("delete_message")}>
              Request delete
            </button>
          ) : null}
          {DetailEligible(detail).includes("timeout_user") ? (
            <>
              <button data-testid="action-timeout-60-btn" disabled={busy} onClick={() => void requestAction("timeout_user", 60)}>
                Request 60s timeout
              </button>
              <button data-testid="action-timeout-600-btn" disabled={busy} onClick={() => void requestAction("timeout_user", 600)}>
                Request 10min timeout
              </button>
            </>
          ) : null}
        </div>
      )}

      <h4>Operations</h4>
      {actions.length === 0 ? (
        <p className="muted">No operations yet. A refresh recovers existing operations here.</p>
      ) : (
        <ul className="operations" data-testid="operations-list">
          {actions.map((a) => (
            <li key={a.id} data-testid={`operation-${a.id}`}>
              <strong>
                {a.action} → {a.targetUserId}
              </strong>{" "}
              <span>{actionStateLabel(a)}</span>
              {a.lastOutcomeDetail ? <p className="muted">{a.lastOutcomeDetail}</p> : null}
              <div className="row">
                {a.state === "awaiting_approval" ? (
                  <button data-testid={`approve-btn-${a.id}`} disabled={busy} onClick={() => void approve(a)}>
                    Approve &amp; queue (simulated)
                  </button>
                ) : null}
                {a.state === "unknown" ? (
                  <button data-testid={`reconcile-btn-${a.id}`} disabled={busy} onClick={() => void reconcile(a)}>
                    Reconcile from ledger
                  </button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}

      <details>
        <summary>Diagnostics</summary>
        <dl>
          <div>
            <dt>Incident</dt>
            <dd>{DetailId(detail)}</dd>
          </div>
          <div>
            <dt>Classifier</dt>
            <dd>fake-deterministic (explicitly fake; proves pipeline behavior only)</dd>
          </div>
          <div>
            <dt>Evidence freshness</dt>
            <dd>
              first {DetailFirst(detail)} · last {DetailLast(detail)}
            </dd>
          </div>
          <div>
            <dt>Eligible actions</dt>
            <dd>{DetailEligible(detail).join(", ") || "none"}</dd>
          </div>
        </dl>
      </details>
    </article>
  );
}

// Small accessors keep JSX readable and avoid optional-chain noise.
function DetailTitle(d: IncidentDetail): string {
  return d.title;
}
function DetailSummary(d: IncidentDetail): string {
  return d.summary;
}
function DetailPattern(d: IncidentDetail): string {
  return d.observedPattern;
}
function DetailRule(d: IncidentDetail): string {
  return d.channelRule;
}
function DetailUncertainty(d: IncidentDetail): string {
  return d.uncertainty;
}
function DetailRecommendation(d: IncidentDetail): string {
  return d.recommendedAction;
}
function DetailEvidence(d: IncidentDetail): IncidentDetail["evidence"] {
  return d.evidence;
}
function DetailEvidenceCount(d: IncidentDetail): number {
  return d.evidence.length;
}
function DetailHasMasked(d: IncidentDetail): boolean {
  return d.evidence.some((m) => m.masked);
}
function DetailContext(d: IncidentDetail): IncidentDetail["context"] {
  return d.context;
}
function DetailTruncated(d: IncidentDetail): boolean {
  return d.contextTruncated;
}
function DetailClaimedBy(d: IncidentDetail): string | null {
  return d.claimedByDisplayName;
}
function DetailEligible(d: IncidentDetail): string[] {
  return d.eligibleActions;
}
function DetailId(d: IncidentDetail): string {
  return d.id;
}
function DetailFirst(d: IncidentDetail): string {
  return new Date(d.firstObservedAt).toLocaleString();
}
function DetailLast(d: IncidentDetail): string {
  return new Date(d.lastObservedAt).toLocaleString();
}

function PolicyModal(props: {
  workspaceId: string;
  token: string;
  role: string;
  onClose: () => void;
  onNotice: (n: string | null) => void;
}): JSX.Element {
  const [current, setCurrent] = useState<{ policy: PolicyVersion; preview: PolicyPreview } | null>(null);
  const [preset, setPreset] = useState("balanced");
  const [nuance, setNuance] = useState("");
  const [domains, setDomains] = useState("");
  const [preview, setPreview] = useState<PolicyPreview | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const res = await api.policy(props.workspaceId, props.token);
        setCurrent(res);
        setPreset(res.policy.preset);
        setNuance(res.policy.nuance);
        setDomains(res.policy.blockedDomains.join(", "));
      } catch (err) {
        props.onNotice(err instanceof ApiError ? `Policy load failed: ${err.message}` : "Policy load failed.");
      }
    })();
  }, [props.workspaceId, props.token]);

  const draft = () => ({
    preset,
    nuance,
    blockedDomains: domains
      .split(",")
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean),
  });

  const doPreview = async (): Promise<void> => {
    try {
      const p = await api.policyPreview(props.workspaceId, props.token, draft());
      setPreview(p);
    } catch (err) {
      props.onNotice(err instanceof ApiError ? `Preview failed: ${err.message}` : "Preview failed.");
    }
  };

  const doSave = async (): Promise<void> => {
    try {
      const res = await api.savePolicy(props.workspaceId, props.token, draft());
      setCurrent(res);
      setPreview(res.preview);
      props.onNotice(`Policy saved as version ${res.policy.version}. Pending approvals pinned to older versions are superseded.`);
    } catch (err) {
      props.onNotice(err instanceof ApiError ? `Save failed [${err.code}]: ${err.message}` : "Save failed.");
    }
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Channel policy" data-testid="policy-modal">
      <div className="modal">
        <h2>Channel policy {current ? `(version ${current.policy.version})` : ""}</h2>
        <label>
          Preset{" "}
          <select data-testid="policy-preset" value={preset} onChange={(e) => setPreset(e.target.value)}>
            <option value="balanced">Balanced</option>
            <option value="banter_friendly">Banter-friendly</option>
            <option value="strict">Strict</option>
          </select>
        </label>
        <label>
          Nuance (bounded context for reviewers; grants no authority, max 500 chars)
          <textarea
            data-testid="policy-nuance"
            value={nuance}
            maxLength={500}
            rows={3}
            onChange={(e) => setNuance(e.target.value)}
          />
        </label>
        <label>
          Blocked domains (comma-separated, owner-approved)
          <input data-testid="policy-domains" value={domains} onChange={(e) => setDomains(e.target.value)} />
        </label>
        <div className="row">
          <button data-testid="policy-preview-btn" onClick={() => void doPreview()}>
            Preview effective policy (no writes)
          </button>
          {props.role === "owner" ? (
            <button data-testid="policy-save-btn" onClick={() => void doSave()}>
              Save as new version
            </button>
          ) : (
            <span className="muted">Only the owner can save policy.</span>
          )}
          <button onClick={props.onClose}>Close</button>
        </div>
        {preview ? (
          <div data-testid="policy-preview-result">
            <p>{preview.effectiveSummary}</p>
            <p className="muted">
              Allowed human actions: {preview.allowedHumanActions.join(", ") || "none"} · Automation:{" "}
              {preview.automationEnabled ? "ON" : "OFF (M0 has no automation)"}
            </p>
            {preview.warnings.map((w) => (
              <p key={w} className="warning">
                {w}
              </p>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
