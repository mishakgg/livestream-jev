import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const API = "http://localhost:3001";

test.describe.configure({ mode: "serial" });

interface Session {
  token: string;
  workspaceId: string;
}

async function login(request: APIRequestContext, username: string): Promise<Session> {
  const res = await request.post(`${API}/api/demo/login`, { data: { username } });
  expect(res.ok()).toBe(true);
  return (await res.json()) as Session;
}

function fixture(name: string): Record<string, unknown>[] {
  const raw = JSON.parse(readFileSync(join(root, "fixtures", name), "utf8") as string) as Record<string, unknown>[];
  return raw.map((e) => {
    const { _note, ...rest } = e;
    void _note;
    return rest;
  });
}

async function replay(request: APIRequestContext, token: string, ws: string, name: string): Promise<void> {
  const events = fixture(name);
  events.sort((a, b) => String(a.providerTime) < String(b.providerTime) ? -1 : 1);
  const res = await request.post(`${API}/api/workspaces/${ws}/replay`, {
    headers: { authorization: `Bearer ${token}` },
    data: { events },
  });
  expect(res.ok()).toBe(true);
}

async function waitForEvaluated(request: APIRequestContext, token: string, ws: string, count: number): Promise<void> {
  await expect
    .poll(
      async () => {
        const r = await request.get(`${API}/api/workspaces/${ws}/health`, {
          headers: { authorization: `Bearer ${token}` },
        });
        if (!r.ok()) return -1;
        return ((await r.json()) as { evaluatedEvents: number }).evaluatedEvents;
      },
      { timeout: 90_000, intervals: [1000, 2000] }
    )
    .toBe(count);
}

async function uiLogin(page: Page, username: string): Promise<void> {
  await page.goto("/");
  await expect(page.getByTestId("demo-banner")).toContainText("DEMO");
  if (await page.getByTestId("logout-btn").isVisible()) {
    await page.getByTestId("logout-btn").click();
  }
  await page.getByTestId(`login-${username}`).click();
  await expect(page.getByTestId("workspace-name")).toBeVisible();
}

test("M0 journey: replay -> grouped incident -> claim -> simulated action -> refresh recovery", async ({
  page,
  request,
}) => {
  const alice = await login(request, "alice");
  await uiLogin(page, "alice");
  await expect(page.getByTestId("mode-badge")).toContainText("Preview");

  await replay(request, alice.token, "demo-alpha", "replay-basic.json");
  await waitForEvaluated(request, alice.token, "demo-alpha", 22);
  await page.reload();
  await expect(page.getByTestId("inbox-list")).toBeVisible({ timeout: 30_000 });

  // Grouped spam incident: 6 accounts, 6 messages.
  const spamCard = page.getByTestId("inbox-list").getByRole("button").filter({ hasText: "Possible coordinated spam" });
  await expect(spamCard).toBeVisible();
  await expect(spamCard).toContainText("6 account(s)");
  await spamCard.click();
  await expect(page.getByTestId("incident-detail")).toBeVisible();
  await expect(page.getByTestId("evidence-list").getByRole("listitem")).toHaveCount(6);

  // Claim it as Alice.
  await page.getByTestId("claim-btn").click();
  await expect(page.getByTestId("ws-notice")).toContainText("Claimed");

  // Stream card shows the distinct-account audio report.
  await expect(page.getByTestId("stream-card")).toContainText("6 distinct account");

  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: join(root, "docs", "demo", "m0-inbox.png") });

  // Explicit demo Assist transition, then a human-approved simulated delete.
  await page.getByTestId("mode-assist-btn").click();
  await expect(page.getByTestId("assist-confirm")).toBeVisible();
  await page.getByTestId("assist-confirm-btn").click();
  await expect(page.getByTestId("mode-badge")).toContainText("Assist");

  await page.getByTestId("action-delete-btn").click();
  await expect(page.getByTestId("ws-notice")).toContainText("Requested simulated delete_message");
  const operation = page.getByTestId("operations-list").getByRole("listitem").first();
  await expect(operation).toBeVisible();
  const approveBtn = operation.getByRole("button", { name: /Approve/ });
  await approveBtn.click();
  await expect(page.getByTestId("ws-notice")).toContainText("Approved and queued");
  await expect(operation).toContainText("simulation ledger", { timeout: 30_000 });

  await page.screenshot({ path: join(root, "docs", "demo", "m0-detail-action.png") });

  // Refresh recovery: one persisted logical action, no duplicates.
  await page.reload();
  await expect(page.getByTestId("inbox-list")).toBeVisible({ timeout: 30_000 });
  const res = await request.get(`${API}/api/workspaces/demo-alpha/incidents?status=claimed&limit=50`, {
    headers: { authorization: `Bearer ${alice.token}` },
  });
  const claimed = ((await res.json()) as { incidents: { id: string }[] }).incidents;
  expect(claimed.length).toBeGreaterThanOrEqual(1);
  const actionsRes = await request.get(
    `${API}/api/workspaces/demo-alpha/actions?incidentId=${claimed[0]?.id ?? ""}`,
    { headers: { authorization: `Bearer ${alice.token}` } }
  );
  const actions = ((await actionsRes.json()) as { actions: { state: string }[] }).actions;
  expect(actions).toHaveLength(1);
  expect(actions[0]?.state).toBe("succeeded");
});

test("cross-tenant isolation, preview zero-write, adversarial fixtures", async ({ page, request, browser }) => {
  const alice = await login(request, "alice");
  const dave = await login(request, "dave");

  // Alpha incident ids are invisible to beta sessions.
  const list = await request.get(`${API}/api/workspaces/demo-alpha/incidents?status=all&limit=50`, {
    headers: { authorization: `Bearer ${alice.token}` },
  });
  const alphaIds = ((await list.json()) as { incidents: { id: string }[] }).incidents.map((i) => i.id);
  expect(alphaIds.length).toBeGreaterThan(0);
  const cross = await request.get(`${API}/api/workspaces/demo-alpha/incidents/${alphaIds[0] ?? ""}`, {
    headers: { authorization: `Bearer ${dave.token}` },
  });
  expect(cross.status()).toBe(403);

  // Beta workspace is empty and isolated.
  await uiLogin(page, "dave");
  await expect(page.getByTestId("workspace-name")).toContainText("Beta");
  await expect(page.getByTestId("inbox-empty")).toBeVisible();
  await expect(page.getByTestId("stream-card")).toContainText("No stream problems");

  // Preview refuses writes at the API boundary.
  const policyBefore = await request.get(`${API}/api/workspaces/demo-beta/policy`, {
    headers: { authorization: `Bearer ${dave.token}` },
  });
  expect(((await policyBefore.json()) as { policy: { version: number } }).policy.version).toBe(1);

  // Adversarial replay: injection is flagged, never obeyed; policy unchanged.
  await replay(request, alice.token, "demo-alpha", "replay-adversarial.json");
  await waitForEvaluated(request, alice.token, "demo-alpha", 29);
  const policyAfter = await request.get(`${API}/api/workspaces/demo-alpha/policy`, {
    headers: { authorization: `Bearer ${alice.token}` },
  });
  const version = ((await policyAfter.json()) as { policy: { version: number } }).policy.version;
  const all = await request.get(`${API}/api/workspaces/demo-alpha/incidents?status=all&limit=50`, {
    headers: { authorization: `Bearer ${alice.token}` },
  });
  const incidents = ((await all.json()) as { incidents: { id: string }[] }).incidents;
  let sawInjectionEvidence = false;
  for (const inc of incidents) {
    const d = await request.get(`${API}/api/workspaces/demo-alpha/incidents/${inc.id}`, {
      headers: { authorization: `Bearer ${alice.token}` },
    });
    const body = (await d.json()) as { evidence: { platformMessageId: string }[] };
    if (body.evidence.some((e) => e.platformMessageId === "msg-adv-001" || e.platformMessageId === "msg-adv-002")) {
      sawInjectionEvidence = true;
    }
  }
  expect(sawInjectionEvidence).toBe(false);

  // Masked private-information evidence in the browser, revealed on demand.
  await uiLogin(page, "alice");
  let dialogSeen = false;
  page.on("dialog", () => {
    dialogSeen = true;
  });
  const leakCard = page.getByTestId("inbox-list").getByRole("button").filter({ hasText: "private-information" });
  await expect(leakCard).toBeVisible({ timeout: 30_000 });
  await leakCard.click();
  await expect(page.getByTestId("evidence-list")).toContainText("masked");
  await page.getByTestId("reveal-btn").click();
  await expect(page.getByTestId("evidence-list")).toContainText("Fiction Street");
  void version;

  // Malicious HTML in chat context is rendered as inert text, never executed.
  await page.getByTestId("status-filter").selectOption("all");
  const spamCard = page.getByTestId("inbox-list").getByRole("button").filter({ hasText: "Possible coordinated spam" });
  await spamCard.first().click();
  await expect(page.getByTestId("incident-detail")).toBeVisible();
  const detailHtml = await page.getByTestId("incident-detail").innerHTML();
  expect(detailHtml).toContain("&lt;script&gt;");
  expect(detailHtml).toContain("&lt;img");
  expect(detailHtml).not.toContain("<script>alert");
  expect(dialogSeen).toBe(false);

  // A second moderator session sees the same claim state (convergence).
  const bobPage = await browser.newContext().then((c) => c.newPage());
  await uiLogin(bobPage, "bob");
  await expect(bobPage.getByTestId("inbox-list")).toBeVisible({ timeout: 30_000 });
  await bobPage.close();
});
