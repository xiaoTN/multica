import "./env";
import { test, expect, type Locator, type Page } from "@playwright/test";
import pg from "pg";
import { TestApiClient } from "./fixtures";

const longTool = `multica_issue_comment_list_${"01a1af34-999f-7e2c-a878-5b3196fcdf2d_--thread_".repeat(28)}--tail_4_--output_json`;
const longCommand = `https://example.test/${"path/01a1af34-999f-7e2c-a878-5b3196fcdf2d/".repeat(35)}`;
const longThinking = `Checking_${"0123456789abcdef".repeat(150)}`;
const longOutput = JSON.stringify({ result: longCommand });

test.use({ launchOptions: { executablePath: process.env.MULTICA_E2E_CHROMIUM_EXECUTABLE } });

async function expectContained(locator: Locator) {
  expect(await locator.evaluate(element => element.clientWidth)).toBeGreaterThan(0);
  await expect.poll(() => locator.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
}

async function capture(page: Page, path: string, label: string) {
  await page.evaluate(text => {
    const caption = document.createElement("div");
    caption.id = "overflow-evidence-caption";
    caption.textContent = text;
    Object.assign(caption.style, { position: "fixed", bottom: "10px", left: "10px", right: "10px", zIndex: "2147483647", padding: "10px", background: "#102c3d", color: "white", font: "13px/1.4 sans-serif", pointerEvents: "none" });
    document.body.append(caption);
  }, label);
  try { await page.screenshot({ path, animations: "disabled" }); }
  finally { await page.evaluate(() => document.getElementById("overflow-evidence-caption")?.remove()); }
}

test("long process rows stay inside chat, comment runs and the full log", async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  if (!process.env.DATABASE_URL?.includes("/multica_worktree_")) throw new Error("isolated worktree database required");
  const api = new TestApiClient();
  const database = new pg.Client(process.env.DATABASE_URL);
  await database.connect();
  let runtimeId: string | undefined;
  let agentId: string | undefined;
  let sessionId: string | undefined;
  const taskIds: string[] = [];
  try {
    await api.loginLocal();
    await api.markUserOnboarded();
    const workspace = (await api.getWorkspaces())[0]!;
    api.setWorkspaceId(workspace.id);
    const userId = (await database.query('SELECT id FROM "user" WHERE email=$1', [api.getEmail()])).rows[0].id;
    await database.query('UPDATE "user" SET language=\'en\' WHERE id=$1', [userId]);
    runtimeId = (await database.query(`INSERT INTO agent_runtime (workspace_id,name,runtime_mode,provider,status,device_info,metadata,owner_id,last_seen_at)
      VALUES ($1,'Overflow fixture','cloud','codex','online','E2E fixture','{}',$2,now()) RETURNING id`, [workspace.id, userId])).rows[0].id;
    agentId = (await database.query(`INSERT INTO agent (workspace_id,name,description,instructions,runtime_mode,runtime_config,runtime_id,visibility,permission_mode,max_concurrent_tasks,owner_id)
      VALUES ($1,'Overflow fixture','','','cloud','{}',$2,'private','private',1,$3) RETURNING id`, [workspace.id, runtimeId, userId])).rows[0].id;
    sessionId = (await database.query(`INSERT INTO chat_session (workspace_id,agent_id,creator_id,title,status,explicitly_created_at)
      VALUES ($1,$2,$3,'Process overflow verification','active',now()) RETURNING id`, [workspace.id, agentId, userId])).rows[0].id;
    const issue = await api.createIssue("Process overflow verification");
    const commentId = (await database.query(`INSERT INTO comment (workspace_id,issue_id,author_type,author_id,content)
      VALUES ($1,$2,'member',$3,'Inspect long process rows') RETURNING id`, [workspace.id, issue.id, userId])).rows[0].id;
    const events = [
      { type: "tool_use", tool: longTool, input: { command: longCommand } },
      { type: "tool_result", tool: longTool, output: longOutput },
      { type: "tool_use", tool: longTool, input: { command: longCommand } },
      { type: "tool_result", tool: longTool, output: longOutput },
      { type: "thinking", content: longThinking },
      { type: "text", content: `Intermediate_${longCommand}` },
      { type: "error", content: `Error_${longCommand}` },
      { type: "tool_use", tool: "exec_command", input: { command: longCommand } },
      { type: "tool_result", tool: "exec_command", output: longOutput },
    ];
    for (const source of ["chat", "issue"]) {
      const taskId = (await database.query(`INSERT INTO agent_task_queue (agent_id,runtime_id,chat_session_id,issue_id,trigger_comment_id,status,started_at,dispatched_at)
        VALUES ($1,$2,$3,$4,$5,'running',now(),now()) RETURNING id`, [agentId, runtimeId, source === "chat" ? sessionId : null, source === "issue" ? issue.id : null, source === "issue" ? commentId : null])).rows[0].id;
      taskIds.push(taskId);
      const sourceEvents = source === "issue"
        ? [...events.slice(0, 4), events[0]!, events[1]!, ...events.slice(4)]
        : events;
      for (const [seq, event] of sourceEvents.entries()) {
        await database.query(`INSERT INTO task_message (task_id,seq,type,tool,input,output,content) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [taskId, seq + 1, event.type, "tool" in event ? event.tool : null, "input" in event ? event.input : null, "output" in event ? event.output : null, "content" in event ? event.content : null]);
      }
    }
    await page.addInitScript(token => {
      localStorage.setItem("multica_token", token!);
      localStorage.setItem("multica:chat:isOpen", "false");
    }, api.getToken());
    await page.context().addCookies([{ name: "multica-locale", value: "en", url: process.env.FRONTEND_ORIGIN! }]);
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    for (const state of ["running", "completed"]) {
      if (state === "completed") {
        await database.query(`UPDATE agent_task_queue SET status='completed',completed_at=now() WHERE id=ANY($1::uuid[])`, [taskIds]);
        await database.query(`INSERT INTO chat_message (chat_session_id,role,content,task_id) VALUES ($1,'assistant','Verification complete',$2)`, [sessionId, taskIds[0]]);
      }
      for (const width of [1440, 720]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.goto(`/${workspace.slug}/chat?session=${sessionId}`, { waitUntil: "domcontentloaded" });
        const foldButton = page.getByRole("button", { name: "9 steps", exact: true });
        await expect(foldButton).toBeVisible({ timeout: 60_000 });
        if (await foldButton.getAttribute("aria-expanded") !== "true") await foldButton.click();
        const process = foldButton.locator("..").locator('[data-slot="collapsible-content"]').first();
        const toolLabel = process.getByText(longTool, { exact: true }).first();
        await expect(toolLabel).toBeVisible();
        const summaryButton = toolLabel.locator("xpath=ancestor::button[1]");
        await summaryButton.scrollIntoViewIfNeeded();
        const metrics = await process.evaluate(element => ({ client: element.clientWidth, scroll: element.scrollWidth }));
        await capture(page, testInfo.outputPath(`chat-${state}-${width}-collapsed.png`), `IHOME-39 / chat / ${state} / ${width}px / tool=${longTool.length} chars / frame client=${metrics.client}, scroll=${metrics.scroll}`);
        await expectContained(process);
        await expectContained(page.locator('[data-virtuoso-scroller]').first());
        const clipped = await toolLabel.evaluate(element => ({ overflow: getComputedStyle(element).textOverflow, client: element.clientWidth, scroll: element.scrollWidth }));
        expect(clipped.overflow).toBe("ellipsis");
        expect(clipped.scroll).toBeGreaterThan(clipped.client);
        await summaryButton.click();
        const input = summaryButton.locator("..").locator("pre");
        await expect(input).toHaveText(JSON.stringify({ command: longCommand }, null, 2));
        const thinkingButton = process.getByRole("button").filter({ hasText: longThinking.slice(0, 100) });
        await thinkingButton.click();
        await expect(process.locator("pre").filter({ hasText: longThinking })).toHaveText(longThinking);
        await expectContained(process);
        await expectContained(page.locator('[data-virtuoso-scroller]').first());
        await capture(page, testInfo.outputPath(`chat-${state}-${width}-expanded.png`), `IHOME-39 / chat / ${state} / ${width}px / expanded command=${longCommand.length}, thinking=${longThinking.length} chars / full input retained`);
      }
    }
    // The comment activity and full transcript use different row renderers.
    await database.query(`UPDATE agent_task_queue SET status='running',completed_at=NULL WHERE id=$1`, [taskIds[1]]);
    for (const width of [1440, 720]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(`/${workspace.slug}/issues/${issue.id}`, { waitUntil: "domcontentloaded" });
      const card = page.locator(`[data-run-id="${taskIds[1]}"]`);
      const activity = card.getByRole("button", { name: /^View activity ·/ });
      await activity.click({ timeout: 45_000 });
      await expect(activity).toHaveAttribute("aria-expanded", "true");
      const step = card.locator("summary").filter({ hasText: longTool }).first();
      await expect(step).toBeVisible();
      await expectContained(step);
      await expectContained(card);
      await step.click();
      await expectContained(card);
      await capture(page, testInfo.outputPath(`comment-${width}.png`), `IHOME-39 / comment run / ${width}px / grouped long tools + expanded body / contained`);
      await card.getByRole("button", { name: "Open full log", exact: true }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await dialog.locator("[data-virtuoso-scroller]").evaluate(element => { element.scrollTop = 0; });
      const group = dialog.getByRole("button").filter({ hasText: longTool }).first();
      await expectContained(group);
      await group.click();
      await group.locator("..").getByRole("button").nth(1).click();
      await expect(dialog.locator("aside")).toContainText(longCommand);
      await expectContained(dialog.locator("aside"));
      await dialog.getByRole("button", { name: "Copy this step", exact: true }).click();
      const copied = await page.evaluate(() => navigator.clipboard.readText());
      expect(copied).toContain(longTool);
      expect(copied).toContain(longCommand);
      expect(copied).toContain(longOutput);
      await expectContained(dialog);
      await capture(page, testInfo.outputPath(`transcript-${width}.png`), `IHOME-39 / full execution log / ${width}px / group + inspector / contained`);
      await dialog.getByRole("button", { name: "Close", exact: true }).first().click();
    }
  } finally {
    if (taskIds.length) {
      await database.query("DELETE FROM task_message WHERE task_id=ANY($1::uuid[])", [taskIds]);
      await database.query("DELETE FROM chat_message WHERE task_id=ANY($1::uuid[])", [taskIds]);
      await database.query("DELETE FROM agent_task_queue WHERE id=ANY($1::uuid[])", [taskIds]);
    }
    if (sessionId) await database.query("DELETE FROM chat_session WHERE id=$1", [sessionId]);
    if (agentId) await database.query("DELETE FROM agent WHERE id=$1", [agentId]);
    if (runtimeId) await database.query("DELETE FROM agent_runtime WHERE id=$1", [runtimeId]);
    await database.end();
    await api.cleanup();
  }
});
