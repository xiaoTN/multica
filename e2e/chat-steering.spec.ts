import "./env";
import { test as base, expect, type Page } from "@playwright/test";
import pg from "pg";
import { TestApiClient } from "./fixtures";
import { writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

interface ChatScenario {
  api: TestApiClient;
  database: pg.Client;
  workspace: { id: string; slug: string };
  sessionId: string;
  runtimeId: string;
}

async function captureSteeringEvidence(page: Page, path: string, label: string) {
  await page.evaluate(text => {
    const caption = document.createElement("div");
    caption.id = "steering-evidence-caption";
    caption.textContent = text;
    Object.assign(caption.style, { position: "fixed", top: "12px", right: "12px", zIndex: "2147483647", padding: "12px", maxWidth: "480px", background: "#102c3d", color: "white", borderRadius: "8px", font: "14px/1.5 sans-serif", pointerEvents: "none" });
    document.body.append(caption);
  }, label);
  try { await page.screenshot({ path }); }
  finally { await page.evaluate(() => document.getElementById("steering-evidence-caption")?.remove()); }
}

// Teardown has its own timeout so a browser timeout cannot strand the fixture.
const test = base.extend<{ chatScenario: ChatScenario }>({
  chatScenario: [async ({}, use) => {
    if (!process.env.DATABASE_URL?.includes("/multica_worktree_")) throw new Error("isolated worktree database required");
    const api = new TestApiClient();
    await api.loginLocal();
    await api.markUserOnboarded();
    const database = new pg.Client(process.env.DATABASE_URL);
    await database.connect();
    let sessionId: string | undefined;
    let agentId: string | undefined;
    let runtimeId: string | undefined;
    try {
      const workspace = (await api.getWorkspaces())[0]!;
      api.setWorkspaceId(workspace.id);
      const user = await database.query(`SELECT id FROM "user" WHERE email=$1`, [api.getEmail()]);
      const userId = user.rows[0].id;
      const fixtureName = `Chat steer ${randomUUID()}`;
      runtimeId = (await database.query(`INSERT INTO agent_runtime (workspace_id, name, runtime_mode, provider, status, device_info, metadata, owner_id, last_seen_at) VALUES ($1,$2,'cloud','codex','online','E2E fixture','{}',$3,now()) RETURNING id`, [workspace.id, fixtureName, userId])).rows[0].id;
      agentId = (await database.query(`INSERT INTO agent (workspace_id,name,description,instructions,runtime_mode,runtime_config,runtime_id,visibility,permission_mode,max_concurrent_tasks,owner_id) VALUES ($1,$2,'','','cloud','{}',$3,'private','private',1,$4) RETURNING id`, [workspace.id, fixtureName, runtimeId, userId])).rows[0].id;
      sessionId = (await database.query(`INSERT INTO chat_session (workspace_id,agent_id,creator_id,title,status,explicitly_created_at) VALUES ($1,$2,$3,'Enter steering verification','active',now()) RETURNING id`, [workspace.id, agentId, userId])).rows[0].id;
      await use({ api, database, workspace, sessionId: sessionId!, runtimeId: runtimeId! });
    } finally {
      try {
        await database.query("BEGIN");
        if (sessionId) {
          await database.query(`DELETE FROM chat_task_supplement WHERE chat_session_id=$1`, [sessionId]);
          await database.query(`DELETE FROM task_supplement_capability WHERE task_id IN (SELECT id FROM agent_task_queue WHERE chat_session_id=$1)`, [sessionId]);
          await database.query(`DELETE FROM chat_message WHERE chat_session_id=$1`, [sessionId]);
          await database.query(`DELETE FROM chat_session WHERE id=$1`, [sessionId]);
        }
        if (agentId) {
          await database.query(`DELETE FROM agent_task_queue WHERE agent_id=$1`, [agentId]);
          await database.query(`DELETE FROM agent WHERE id=$1`, [agentId]);
        }
        if (runtimeId) await database.query(`DELETE FROM agent_runtime WHERE id=$1`, [runtimeId]);
        await database.query("COMMIT");
      } catch (error) {
        await database.query("ROLLBACK");
        throw error;
      } finally {
        await database.end();
        await api.cleanup();
      }
    }
  }, { timeout: 60_000 }],
});

test.use({ launchOptions: { executablePath: process.env.MULTICA_E2E_CHROMIUM_EXECUTABLE } });

test("unsupported provider explains steering and preserves queued input and draft", async ({ page, chatScenario }, testInfo) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(30_000);
  const { api, database, workspace, sessionId, runtimeId } = chatScenario;
  await database.query(`UPDATE agent_runtime SET provider='qoder' WHERE id=$1`, [runtimeId]);
  await page.addInitScript(token => {
    localStorage.setItem("multica_token", token!);
    localStorage.setItem("multica:chat:isOpen", "false");
    localStorage.setItem("multica_comment_composer", JSON.stringify({ state: { sticky: true, runningAgentReply: "after_run" }, version: 0 }));
  }, api.getToken());
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/${workspace.slug}/chat?session=${sessionId}`, { waitUntil: "domcontentloaded" });
  const editor = page.locator('.ProseMirror[contenteditable="true"]').last();
  await expect(editor).toBeVisible({ timeout: 45_000 });
  await editor.fill("Original qoder prompt A");
  const send = page.getByRole("button", { name: "Send", exact: true });
  await expect(send).toBeEnabled({ timeout: 45_000 });
  const firstResponse = page.waitForResponse(r => r.request().method() === "POST" && r.url().endsWith(`/sessions/${sessionId}/messages`));
  await send.click();
  const first = await firstResponse;
  expect(first.status()).toBe(201);
  const original = await first.json();
  // Exercise the real claim/start handshake with the unsupported provider.
  // No daemon process, installed agent CLI, model, or fabricated capability row.
  await api.claimAndStartChatTask(runtimeId, original.task_id, []);
  expect((await database.query(`SELECT count(*)::int AS n FROM task_supplement_capability WHERE task_id=$1`, [original.task_id])).rows[0].n).toBe(0);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByRole("combobox", { name: "When replying to a running agent" })).toBeVisible({ timeout: 45_000 });
  await editor.fill("Queued qoder input B");
  const queueMessage = page.getByRole("button", { name: "Queue message", exact: true });
  await expect(queueMessage).toBeEnabled();
  const queuedResponse = page.waitForResponse(r => r.request().method() === "POST" && r.url().endsWith(`/sessions/${sessionId}/messages`));
  await queueMessage.click();
  const queuedResult = await queuedResponse;
  expect(queuedResult.status()).toBe(201);
  const queued = await queuedResult.json();
  expect(queued.queued).toBe(true);
  const reason = "This agent does not support steering during this run. Queued messages will be sent after the run ends.";
  const disabledSteer = page.getByRole("button", { name: reason, exact: true });
  await expect(disabledSteer).toBeDisabled();
  await disabledSteer.locator("..").hover();
  await expect(page.locator('[data-slot="tooltip-content"]')).toHaveText(reason);
  await editor.fill("Unsent draft D");
  await disabledSteer.locator("..").hover();
  await expect(page.locator('[data-slot="tooltip-content"]')).toHaveText(reason);
  await captureSteeringEvidence(page, testInfo.outputPath("unsupported-steer-disabled.png"), "IHOME-32 / qoder · negotiated capability rows: 0 · Steer disabled with a reason · Queue B and unsent draft D retained");

  // A legacy/stale snapshot lacks the additive capability field. Keep the real
  // server refusal visible in that case instead of implying it may work later.
  const pendingURL = `**/sessions/${sessionId}/pending-task`;
  await page.route(pendingURL, async route => {
    const response = await route.fetch();
    const pending = await response.json();
    expect(pending.can_steer).toBe(false);
    delete pending.can_steer;
    await route.fulfill({ response, json: pending });
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  const steer = page.getByRole("button", { name: "Steer", exact: true });
  await expect(steer).toBeEnabled({ timeout: 45_000 });
  await expect(editor).toHaveText("Unsent draft D");
  const rejection = page.waitForResponse(r => r.request().method() === "POST" && r.url().endsWith(`/queued-tasks/${queued.task_id}/steer`));
  await steer.click();
  const refused = await rejection;
  expect(refused.status()).toBe(409);
  expect(await refused.json()).toMatchObject({ code: "chat_steer_unsupported" });
  await expect(page.getByText(reason, { exact: true })).toBeVisible();
  await expect(page.locator('[data-slot="chat-queue-row"]')).toContainText("Queued qoder input B");
  await expect(editor).toHaveText("Unsent draft D");
  await captureSteeringEvidence(page, testInfo.outputPath("unsupported-steer-refused.png"), "IHOME-32 / legacy snapshot · POST steer → 409 / chat_steer_unsupported · Queue B and unsent draft D retained");
  await page.unrouteAll({ behavior: "wait" });
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(disabledSteer).toBeDisabled({ timeout: 45_000 });
  await expect(editor).toHaveText("Unsent draft D");
  await page.getByRole("combobox", { name: "When replying to a running agent" }).click();
  await page.getByRole("option", { name: "Add to current run", exact: true }).click();
  const directRefusal = page.waitForResponse(r => r.request().method() === "POST" && r.url().endsWith(`/sessions/${sessionId}/messages`));
  await page.getByRole("button", { name: "Add to current run", exact: true }).click();
  const direct = await directRefusal;
  expect(direct.status()).toBe(409);
  expect(await direct.json()).toMatchObject({ code: "chat_steer_unsupported" });
  await expect(page.getByText("This agent does not support steering during this run. Your draft is kept; choose to send after this run.", { exact: true })).toBeVisible();
  await expect(editor).toHaveText("Unsent draft D");
  expect((await database.query(`SELECT id, status FROM agent_task_queue WHERE chat_session_id=$1 ORDER BY created_at`, [sessionId])).rows).toEqual([
    { id: original.task_id, status: "running" }, { id: queued.task_id, status: "queued" },
  ]);
  expect((await database.query(`SELECT id FROM chat_message WHERE id=$1 AND task_id=$2`, [original.message_id, original.task_id])).rowCount).toBe(1);
  expect((await database.query(`SELECT id FROM chat_message WHERE id=$1 AND task_id=$2`, [queued.message_id, queued.task_id])).rowCount).toBe(1);
  expect((await database.query(`SELECT count(*)::int AS n FROM chat_task_supplement WHERE chat_session_id=$1`, [sessionId])).rows[0].n).toBe(0);
  await writeFile(testInfo.outputPath("unsupported-steer-identifiers.json"), JSON.stringify({ provider: "qoder", runtimeId, sessionId, original, queued, rejection: "chat_steer_unsupported", capabilityRows: 0 }, null, 2));
});

// This success case supplies capability and receipt preconditions. It covers
// editor routing and persistence, not provider negotiation or real reception.
// Real reception requires the separately gated TestCodexRealChatSteerBeforeCompletion.
test("Enter adds chat input to the exact running turn", async ({ page, chatScenario }, testInfo) => {
  // Cold Next.js compilation and hydration span several full-page navigations.
  test.setTimeout(240_000);
  const { api, database, workspace, sessionId } = chatScenario;
  let runId: string | undefined;
  await page.addInitScript(token => {
    localStorage.setItem("multica_token", token!);
    localStorage.setItem("multica:chat:isOpen", "false");
    localStorage.setItem("multica_comment_composer", JSON.stringify({ state: { sticky: true, runningAgentReply: "after_run" }, version: 0 }));
  }, api.getToken());
  await page.setViewportSize({width: 1440, height: 1000});
  await page.goto(`/${workspace.slug}/chat?session=${sessionId}`, { waitUntil: "domcontentloaded" });
  const editor = page.locator('.ProseMirror[contenteditable="true"]').last();
  await expect(editor).toBeVisible({timeout: 45_000});
  await editor.fill("Message A already sent");
  await expect(page.getByRole("button", {name:"Send",exact:true})).toBeEnabled();
  const firstResponse = page.waitForResponse(r => r.request().method()==="POST" && r.url().endsWith(`/sessions/${sessionId}/messages`));
  await editor.press("Enter");
  const first = await firstResponse;
  expect(first.status()).toBe(201);
  const original = await first.json();
  const originalId = original.message_id;
  runId = original.task_id;
  // The fixture supplies daemon state; no installed agent CLI is executed.
  await database.query(`UPDATE agent_task_queue SET status='running',started_at=now(),dispatched_at=now() WHERE id=$1`,[runId]);
  await database.query(`INSERT INTO task_supplement_capability (task_id,workspace_id,capability) VALUES ($1,$2,'task-supplement-v1')`, [runId,workspace.id]);
  await page.reload({waitUntil:"domcontentloaded"});
  await expect(page.getByRole("combobox", {name:"When replying to a running agent"})).toBeVisible({timeout: 45_000});
  await editor.fill("Enter steering browser evidence");
  await expect(page.getByRole("button", {name:"Queue message",exact:true})).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath("chat-steer-compose.png") });
  const posted = page.waitForResponse(response => response.request().method()==="POST" && response.url().endsWith(`/sessions/${sessionId}/messages`), { timeout: 15_000 });
  await editor.press("Enter");
  const response = await posted;
  expect(response.status()).toBe(201);
  expect(response.request().postDataJSON()).toMatchObject({mode: "steer", expected_task_id: runId});
  const sent = await response.json();
  expect(sent).toMatchObject({steered: true, queued: false, task_id: runId});
  expect((await database.query(`SELECT id FROM agent_task_queue WHERE chat_session_id=$1`,[sessionId])).rows).toHaveLength(1);
  await expect(page.getByText("Waiting for delivery to this run", {exact: true})).toBeVisible();
  await page.screenshot({path: testInfo.outputPath("chat-steer-pending.png")});
  await database.query(`UPDATE chat_task_supplement SET status='delivered', delivered_at=now() WHERE message_id=$1`,[sent.message_id]);
  await page.reload({waitUntil:"domcontentloaded"});
  await expect(page.getByText("Received by the current run", {exact: true})).toBeVisible({timeout: 30_000});
  await page.screenshot({path:testInfo.outputPath("chat-steer-receipt.png")});
  await page.getByRole("combobox", {name: "When replying to a running agent"}).click();
  await page.getByRole("option", {name: "Add to current run"}).click();
  await editor.fill("Explicit queue browser evidence");
  await expect(page.getByRole("button", {name:"Add to current run",exact:true})).toBeEnabled();
  const queuedResponse = page.waitForResponse(response => response.request().method() === "POST" && response.url().endsWith(`/sessions/${sessionId}/messages`));
  await editor.press("ControlOrMeta+Enter");
  const queued = await queuedResponse;
  expect(queued.request().postDataJSON()).toMatchObject({mode: "queue", expected_task_id: runId});
  const queuedSent = await queued.json();
  expect(queuedSent).toMatchObject({steered: false, queued: true});
  expect((await database.query(`SELECT id FROM agent_task_queue WHERE chat_session_id=$1`,[sessionId])).rows).toHaveLength(2);
  const actionResponse = page.waitForResponse(r => r.request().method()==="POST" && /queued-tasks\/[^/]+\/(prioritize|steer)$/.test(r.url()));
  const cancellation = page.waitForResponse(r => r.url().endsWith(`/tasks/${runId}/cancel`),{timeout:5000}).catch(() => null);
  await page.getByRole("button", { name: "Steer", exact: true }).click();
  const action = await actionResponse;
  expect(action.status()).toBe(200);
  if (action.url().endsWith("/prioritize")) {
    expect(await cancellation).not.toBeNull();
    await api.acknowledgeCancelledTask(runId!);
    await page.reload({waitUntil:"domcontentloaded"});
    await expect(page.getByRole("combobox", {name:"When replying to a running agent"})).toBeVisible({timeout: 45_000});
  }
  await expect(page.locator('[data-slot="chat-queue-shell"]')).toHaveCount(0);
  expect(await action.json()).toMatchObject({message_id:queuedSent.message_id,task_id:runId,steered:true});
  await expect(page.getByText("Waiting for delivery to this run",{exact:true})).toBeVisible();
  await page.screenshot({path:testInfo.outputPath("chat-continuous-after-steer.png")});
  await expect(editor).toHaveText("");
  await expect(page.getByText("Message A already sent", {exact:true})).toBeVisible();
  expect((await database.query(`SELECT id FROM chat_message WHERE id=$1`,[originalId])).rows).toHaveLength(1);
  const received = await api.receiveChatSupplement(runId!);
  expect(received.message_id).toBe(queuedSent.message_id);
  await expect(page.getByText("Received by the current run",{exact:true})).toHaveCount(2);
  await page.screenshot({path:testInfo.outputPath("chat-continuous-received.png")});

  await database.query(`DELETE FROM task_supplement_capability WHERE task_id=$1`,[runId]);
  await editor.fill("Retry message C");
  const rejectedResponse = page.waitForResponse(r => r.request().method()==="POST" && r.url().endsWith(`/sessions/${sessionId}/messages`));
  await editor.press("Enter");
  expect((await rejectedResponse).status()).toBe(409);
  await expect(editor).toHaveText("Retry message C");
  await expect(page.getByText("Message A already sent",{exact:true})).toBeVisible();
  await database.query(`INSERT INTO task_supplement_capability (task_id,workspace_id,capability) VALUES ($1,$2,'task-supplement-v1')`,[runId,workspace.id]);
  await page.route(`**/sessions/${sessionId}/messages`,async route => {
    if (route.request().method()!=="POST") return route.continue();
    const accepted = await route.fetch();
    await editor.fill("Unsent draft D typed during C");
    await route.fulfill({response:accepted});
  });
  const retriedResponse = page.waitForResponse(r => r.request().method()==="POST" && r.url().endsWith(`/sessions/${sessionId}/messages`));
  await page.getByRole("button",{name:"Add to current run",exact:true}).click();
  expect((await retriedResponse).status()).toBe(201);
  await page.unroute(`**/sessions/${sessionId}/messages`);
  await expect(editor).toHaveText("Unsent draft D typed during C");
  expect((await database.query(`SELECT id FROM chat_message WHERE chat_session_id=$1 AND content='Retry message C'`,[sessionId])).rows).toHaveLength(1);
  await page.reload({waitUntil:"domcontentloaded"});
  await expect(editor).toHaveText("Unsent draft D typed during C");
  await expect(page.getByText("Message A already sent",{exact:true})).toBeVisible();
  await page.screenshot({path:testInfo.outputPath("chat-draft-preserved.png")});
  await editor.fill("");

  await page.goto(`/${workspace.slug}/settings?tab=shortcuts`);
  const recorder = page.getByRole("button", {name: "Change shortcut for Queue message"});
  await expect(recorder).toBeVisible({timeout: 45_000});
  await page.screenshot({path:testInfo.outputPath("chat-shortcuts-defaults.png")});
  await recorder.click();
  await recorder.press("ControlOrMeta+Shift+Enter");
  await expect(recorder.locator('[data-shortcut-key="shift"]')).toBeVisible();
  await page.reload();
  await expect(recorder).toBeVisible({timeout: 45_000});
  await expect(recorder.locator('[data-shortcut-key="shift"]')).toBeVisible();
  await page.screenshot({path:testInfo.outputPath("chat-shortcuts-custom.png")});
  await page.goto(`/${workspace.slug}/chat?session=${sessionId}`);
  await expect(editor).toBeVisible({timeout: 45_000});
  await expect(page.getByRole("combobox", {name:"When replying to a running agent"})).toBeVisible({timeout: 45_000});
  await editor.fill("Custom queue shortcut browser evidence");
  await expect(page.getByRole("button", {name:"Queue message",exact:true})).toBeEnabled();
  const customResponse = page.waitForResponse(response => response.request().method() === "POST" && response.url().endsWith(`/sessions/${sessionId}/messages`));
  await editor.press("ControlOrMeta+Shift+Enter");
  const custom = await customResponse;
  expect(custom.request().postDataJSON()).toMatchObject({mode:"queue",expected_task_id:runId});
  expect(await custom.json()).toMatchObject({steered:false,queued:true});
  expect((await database.query(`SELECT id FROM agent_task_queue WHERE chat_session_id=$1`,[sessionId])).rows).toHaveLength(3);
  await page.goto(`/${workspace.slug}/settings?tab=shortcuts`);
  await expect(recorder).toBeVisible({timeout: 45_000});
  await page.keyboard.press("ControlOrMeta+J");
  const floatingEditor = page.locator('.ProseMirror[contenteditable="true"]:visible').last();
  await expect(floatingEditor).toBeVisible({timeout: 45_000});
  await expect(page.getByRole("combobox", {name:"When replying to a running agent"})).toBeVisible({timeout: 45_000});
  await floatingEditor.fill("Floating chat shortcut browser evidence");
  await expect(page.getByRole("button", {name:"Queue message",exact:true})).toBeEnabled();
  const floatingResponse = page.waitForResponse(response => response.request().method() === "POST" && response.url().endsWith(`/sessions/${sessionId}/messages`));
  await floatingEditor.press("Enter");
  const floating = await floatingResponse;
  expect(floating.request().postDataJSON()).toMatchObject({mode:"steer",expected_task_id:runId});
  expect(await floating.json()).toMatchObject({steered:true,queued:false,task_id:runId});
  expect((await database.query(`SELECT id FROM agent_task_queue WHERE chat_session_id=$1`,[sessionId])).rows).toHaveLength(3);
  await page.screenshot({path:testInfo.outputPath("chat-shortcuts-floating.png")});
  const receipts = (await database.query(`SELECT message_id,task_id,status,delivered_at FROM chat_task_supplement WHERE chat_session_id=$1 ORDER BY created_at`,[sessionId])).rows;
  const evidencePath = testInfo.outputPath("delivery-identifiers.json");
  await writeFile(evidencePath,JSON.stringify({original_message_id:originalId,queued_message_id:queuedSent.message_id,task_id:runId,receipts,request:response.request().postDataJSON()},null,2));
  await testInfo.attach("delivery-identifiers", {path:evidencePath,contentType:"application/json"});
});
