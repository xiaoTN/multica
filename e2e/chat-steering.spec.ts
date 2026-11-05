import "./env";
import { test, expect } from "@playwright/test";
import pg from "pg";
import { TestApiClient } from "./fixtures";

test.use({ launchOptions: { executablePath: process.env.MULTICA_E2E_CHROMIUM_EXECUTABLE } });

// This browser test covers the real editor, preference restoration, request
// routing and persisted receipts. Provider reception is verified separately by
// TestCodexRealChatSteerBeforeCompletion, which executes the real Codex CLI.
test("Enter adds chat input to the exact running turn", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  if (!process.env.DATABASE_URL?.includes("/multica_worktree_")) throw new Error("isolated worktree database required");
  const api = new TestApiClient();
  await api.loginLocal();
  await api.markUserOnboarded();
  const database = new pg.Client(process.env.DATABASE_URL);
  await database.connect();
  let sessionId: string | undefined;
  let agentId: string | undefined;
  let runtimeId: string | undefined;
  let runId: string | undefined;
  try {
    const workspace = (await api.getWorkspaces())[0]!;
    api.setWorkspaceId(workspace.id);
    const user = await database.query(`SELECT id FROM "user" WHERE email=$1`, [api.getEmail()]);
    const userId = user.rows[0].id;
    runtimeId = (await database.query(`INSERT INTO agent_runtime (workspace_id, name, runtime_mode, provider, status, device_info, metadata, owner_id, last_seen_at) VALUES ($1,'Chat steer verification','cloud','codex','online','E2E fixture','{}',$2,now()) RETURNING id`, [workspace.id, userId])).rows[0].id;
    agentId = (await database.query(`INSERT INTO agent (workspace_id,name,description,instructions,runtime_mode,runtime_config,runtime_id,visibility,permission_mode,max_concurrent_tasks,owner_id) VALUES ($1,'Chat steer verification','','','cloud','{}',$2,'private','private',1,$3) RETURNING id`, [workspace.id, runtimeId, userId])).rows[0].id;
    sessionId = (await database.query(`INSERT INTO chat_session (workspace_id,agent_id,creator_id,title,status,explicitly_created_at) VALUES ($1,$2,$3,'Enter steering verification','active',now()) RETURNING id`, [workspace.id, agentId, userId])).rows[0].id;
    runId = (await database.query(`INSERT INTO agent_task_queue (agent_id,runtime_id,chat_session_id,status,dispatched_at,started_at) VALUES ($1,$2,$3,'running',now(),now()) RETURNING id`, [agentId,runtimeId,sessionId])).rows[0].id;
    await database.query(`UPDATE agent_task_queue SET chat_input_task_id=id WHERE id=$1`,[runId]);
    await database.query(`INSERT INTO task_supplement_capability (task_id,workspace_id,capability) VALUES ($1,$2,'task-supplement-v1')`, [runId,workspace.id]);
    const originalId = (await database.query(`INSERT INTO chat_message (chat_session_id,role,content,task_id) VALUES ($1,'user','Message A already sent',$2) RETURNING id`, [sessionId,runId])).rows[0].id;
    await page.addInitScript(token => {
      localStorage.setItem("multica_token", token!);
      localStorage.setItem("multica:chat:isOpen", "false");
      localStorage.setItem("multica_comment_composer", JSON.stringify({ state: { sticky: true, runningAgentReply: "after_run" }, version: 0 }));
    }, api.getToken());
    await page.setViewportSize({width: 1440, height: 1000});
    await page.goto(`/${workspace.slug}/chat?session=${sessionId}`, { waitUntil: "domcontentloaded" });
    const editor = page.locator('.ProseMirror[contenteditable="true"]').last();
    await expect(editor).toBeVisible({timeout: 45_000});
    await expect(page.getByRole("combobox", {name:"When replying to a running agent"})).toBeVisible();
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
    expect(await queued.json()).toMatchObject({steered: false, queued: true});
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
      await expect(page.getByRole("combobox", {name:"When replying to a running agent"})).toBeVisible();
    }
    await expect(page.locator('[data-slot="chat-queue-shell"]')).toHaveCount(0);
    await page.screenshot({path:testInfo.outputPath("chat-continuous-after-steer.png")});
    await expect(editor).toHaveText("");
    await expect(page.getByText("Message A already sent", {exact:true})).toBeVisible();
    expect((await database.query(`SELECT id FROM chat_message WHERE id=$1`,[originalId])).rows).toHaveLength(1);

    await page.goto(`/${workspace.slug}/settings?tab=shortcuts`);
    const recorder = page.getByRole("button", {name: "Change shortcut for Queue message"});
    await expect(recorder).toBeVisible();
    await page.screenshot({path:testInfo.outputPath("chat-shortcuts-defaults.png")});
    await recorder.click();
    await recorder.press("ControlOrMeta+Shift+Enter");
    await expect(recorder.locator('[data-shortcut-key="shift"]')).toBeVisible();
    await page.reload();
    await expect(recorder.locator('[data-shortcut-key="shift"]')).toBeVisible();
    await page.screenshot({path:testInfo.outputPath("chat-shortcuts-custom.png")});
    await page.goto(`/${workspace.slug}/chat?session=${sessionId}`);
    await expect(editor).toBeVisible();
    await editor.fill("Custom queue shortcut browser evidence");
    await expect(page.getByRole("button", {name:"Queue message",exact:true})).toBeEnabled();
    const customResponse = page.waitForResponse(response => response.request().method() === "POST" && response.url().endsWith(`/sessions/${sessionId}/messages`));
    await editor.press("ControlOrMeta+Shift+Enter");
    const custom = await customResponse;
    expect(custom.request().postDataJSON()).toMatchObject({mode:"queue",expected_task_id:runId});
    expect(await custom.json()).toMatchObject({steered:false,queued:true});
    expect((await database.query(`SELECT id FROM agent_task_queue WHERE chat_session_id=$1`,[sessionId])).rows).toHaveLength(3);
    await page.goto(`/${workspace.slug}/settings?tab=shortcuts`);
    await expect(recorder).toBeVisible();
    await page.keyboard.press("ControlOrMeta+J");
    const floatingEditor = page.locator('.ProseMirror[contenteditable="true"]:visible').last();
    await expect(floatingEditor).toBeVisible();
    await floatingEditor.fill("Floating chat shortcut browser evidence");
    await expect(page.getByRole("button", {name:"Queue message",exact:true})).toBeEnabled();
    const floatingResponse = page.waitForResponse(response => response.request().method() === "POST" && response.url().endsWith(`/sessions/${sessionId}/messages`));
    await floatingEditor.press("Enter");
    const floating = await floatingResponse;
    expect(floating.request().postDataJSON()).toMatchObject({mode:"steer",expected_task_id:runId});
    expect(await floating.json()).toMatchObject({steered:true,queued:false,task_id:runId});
    expect((await database.query(`SELECT id FROM agent_task_queue WHERE chat_session_id=$1`,[sessionId])).rows).toHaveLength(3);
    await page.screenshot({path:testInfo.outputPath("chat-shortcuts-floating.png")});
    await testInfo.attach("delivery-identifiers", {body: JSON.stringify({message_id:sent.message_id,task_id:runId,request:response.request().postDataJSON()},null,2),contentType:"application/json"});
  } finally {
    if (sessionId) await database.query(`DELETE FROM chat_task_supplement WHERE chat_session_id=$1`,[sessionId]);
    if (runId) await database.query(`DELETE FROM task_supplement_capability WHERE task_id=$1`,[runId]);
    if (agentId) await database.query(`DELETE FROM agent_task_queue WHERE agent_id=$1`,[agentId]);
    if (sessionId) await database.query(`DELETE FROM chat_session WHERE id=$1`,[sessionId]);
    if (agentId) await database.query(`DELETE FROM agent WHERE id=$1`,[agentId]);
    if (runtimeId) await database.query(`DELETE FROM agent_runtime WHERE id=$1`,[runtimeId]);
    await database.end();
    await api.cleanup();
  }
});
