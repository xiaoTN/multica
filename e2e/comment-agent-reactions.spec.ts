import "./env";

import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import pg from "pg";
import { TestApiClient } from "./fixtures";

test("an agent chooses a persistent reaction without a duplicate reply or a new run", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const api = new TestApiClient();
  await api.loginLocal();
  await api.ensureWorkspace();
  await api.markUserOnboarded();
  const db = new pg.Client(process.env.DATABASE_URL);
  await db.connect();
  let runtimeId: string | undefined;
  let agentId: string | undefined;
  let taskId: string | undefined;
  try {
    const workspace = (await api.getWorkspaces())[0]!;
    const user = await db.query<{ id: string }>(`SELECT id FROM "user" WHERE email = $1`, [api.getEmail()]);
    const userId = user.rows[0]!.id;
    runtimeId = (await db.query<{ id: string }>(
      `INSERT INTO agent_runtime (workspace_id, name, runtime_mode, provider, status, device_info, metadata, owner_id, last_seen_at)
       VALUES ($1, 'Reaction fixture', 'cloud', 'codex', 'online', 'E2E fixture', '{}', $2, now()) RETURNING id`,
      [workspace.id, userId],
    )).rows[0]!.id;
    agentId = (await db.query<{ id: string }>(
      `INSERT INTO agent (workspace_id, name, description, instructions, runtime_mode, runtime_config, runtime_id, visibility, permission_mode, max_concurrent_tasks, owner_id)
       VALUES ($1, 'Lambda', '', '', 'cloud', '{}', $2, 'private', 'private', 1, $3) RETURNING id`,
      [workspace.id, runtimeId, userId],
    )).rows[0]!.id;
    const issue = await api.createIssue("Agent comment acknowledgement");
    const root = await api.createComment(issue.id, "Please investigate and deliver locally.");
    taskId = (await db.query<{ id: string }>(
      `INSERT INTO agent_task_queue (agent_id, runtime_id, issue_id, trigger_comment_id, delivered_comment_ids, status, dispatched_at, started_at)
       VALUES ($1, $2, $3, $4, ARRAY[$4]::uuid[], 'running', now(), now()) RETURNING id`,
      [agentId, runtimeId, issue.id, root.id],
    )).rows[0]!.id;
    const comment = (await db.query<{ id: string }>(
      `INSERT INTO comment (workspace_id, issue_id, parent_id, author_type, author_id, content)
       VALUES ($1, $2, $3, 'member', $4, 'Received. Deliver locally only.') RETURNING id`,
      [workspace.id, issue.id, root.id, userId],
    )).rows[0]!;
    await db.query(
      `INSERT INTO task_supplement (task_id, workspace_id, issue_id, comment_id, author_id, client_request_id, status, delivered_at)
       VALUES ($1, $2, $3, $4, $5, gen_random_uuid(), 'delivered', now())`,
      [taskId, workspace.id, issue.id, comment.id, userId],
    );
    // This is a disposable test credential, never a real agent or member token.
    const token = `mat_${randomBytes(24).toString("hex")}`;
    await db.query(
      `INSERT INTO task_token (token_hash, task_id, agent_id, workspace_id, user_id, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + interval '10 minutes')`,
      [createHash("sha256").update(token).digest("hex"), taskId, agentId, workspace.id, userId],
    );
    const cliEnv = {
      ...process.env,
      MULTICA_SERVER_URL: process.env.NEXT_PUBLIC_API_URL || `http://localhost:${process.env.PORT}`,
      MULTICA_WORKSPACE_ID: workspace.id,
      MULTICA_TOKEN: token,
      MULTICA_TASK_ID: taskId,
      MULTICA_AGENT_ID: agentId,
    };
    const cli = (args: string[]) => execFileSync(resolve("server/bin/multica"), args, {
      env: cliEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    await page.addInitScript((authToken) => {
      localStorage.setItem("multica_token", authToken!);
      localStorage.setItem("multica:chat:isOpen", "false");
    }, api.getToken());
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`/${workspace.slug}/issues/${issue.id}`, { waitUntil: "domcontentloaded" });
    const block = page.locator("[data-comment-block]").filter({ has: page.locator(`[data-comment-content="${comment.id}"]`) }).first();
    await expect(block).toBeVisible({ timeout: 45_000 });
    // Reading the input does not automatically acknowledge it.
    await expect(page.getByText("Read by Lambda", { exact: true })).toBeVisible();
    await expect(block.getByRole("button", { name: /👌/ })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("read-without-response.png") });
    const args = ["issue", "comment", "reaction", "add", comment.id, "--emoji", "👌"];
    const first = JSON.parse(cli(args));
    expect(first).toMatchObject({ comment_id: comment.id, actor_type: "agent", actor_id: agentId, emoji: "👌" });
    // Observe the actual WebSocket update without reloading the page.
    const reaction = block.getByRole("button", { name: /👌/ });
    await expect(reaction).toHaveText("👌1", { timeout: 15_000 });
    await reaction.hover();
    await expect(page.locator('[data-slot="tooltip-content"]').filter({ hasText: "Lambda" })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("agent-reaction-live.png") });
    expect(JSON.parse(cli(args)).id).toBe(first.id);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(reaction).toHaveText("👌1", { timeout: 30_000 });
    await reaction.hover();
    await expect(page.locator('[data-slot="tooltip-content"]').filter({ hasText: "Lambda" })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("agent-reaction-reloaded.png") });
    expect((await db.query(`SELECT count(*)::int AS count FROM agent_task_queue WHERE issue_id=$1`, [issue.id])).rows[0].count).toBe(1);
    expect((await db.query(`SELECT count(*)::int AS count FROM comment WHERE issue_id=$1 AND author_type='agent'`, [issue.id])).rows[0].count).toBe(0);
    expect((await db.query(`SELECT status FROM issue WHERE id=$1`, [issue.id])).rows[0].status).toBe(issue.status);
    // A normal written reply remains available for messages needing text.
    const replyPath = testInfo.outputPath("reply.md");
    writeFileSync(replyPath, "Received; I will preserve the GitHub read-only protection.\n");
    cli(["issue", "comment", "add", issue.id, "--parent", comment.id, "--content-file", replyPath, "--output", "table"]);
    await expect(page.getByText("Received; I will preserve the GitHub read-only protection.", { exact: true })).toBeVisible({ timeout: 15_000 });
  } finally {
    if (taskId) await db.query(`DELETE FROM task_token WHERE task_id=$1`, [taskId]);
    await api.cleanup();
    if (agentId) await db.query(`DELETE FROM agent_task_queue WHERE agent_id=$1`, [agentId]);
    if (agentId) await db.query(`DELETE FROM agent WHERE id=$1`, [agentId]);
    if (runtimeId) await db.query(`DELETE FROM agent_runtime WHERE id=$1`, [runtimeId]);
    await db.end();
  }
});
