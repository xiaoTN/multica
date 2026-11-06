import "./env";
import { expect, test } from "@playwright/test";
import pg from "pg";
import { mkdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { TestApiClient } from "./fixtures";

test.use({ launchOptions: { executablePath: process.env.MULTICA_E2E_CHROMIUM_EXECUTABLE } });

test("reports admission evidence and updates the real run card through preparation", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  if (!process.env.DATABASE_URL?.includes("/multica_worktree_")) throw new Error("isolated worktree database required");
  const api = new TestApiClient();
  await api.loginLocal();
  await api.markUserOnboarded();
  const db = new pg.Client(process.env.DATABASE_URL);
  await db.connect();
  const evidence: unknown[] = [];
  const agentIds: string[] = [];
  let runtimeId: string | undefined;
  let sessionId: string | undefined;
  const base = process.env.NEXT_PUBLIC_API_URL!;
  try {
    const workspace = (await api.getWorkspaces())[0]!;
    api.setWorkspaceId(workspace.id);
    const userId = (await db.query('SELECT id FROM "user" WHERE email=$1', [api.getEmail()])).rows[0].id;
    await db.query('UPDATE "user" SET language=\'zh-Hans\' WHERE id=$1', [userId]);
    const request = async (path: string, body?: unknown) => {
      const res = await fetch(base + path, { method: body === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${api.getToken()}`, "X-Workspace-ID": workspace.id, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      expect(res.ok, `${path}: ${res.status}`).toBeTruthy();
      return res.json();
    };
    runtimeId = (await db.query(`INSERT INTO agent_runtime (workspace_id,name,runtime_mode,provider,status,device_info,metadata,owner_id,last_seen_at,daemon_id)
      VALUES ($1,'Wait verification','cloud','codex','online','E2E fixture','{}',$2,now(),'run-wait-fixture') RETURNING id`, [workspace.id,userId])).rows[0].id;
    const agentId = (await db.query(`INSERT INTO agent (workspace_id,name,description,instructions,runtime_mode,runtime_config,runtime_id,visibility,permission_mode,max_concurrent_tasks,owner_id)
      VALUES ($1,'等待诊断验收','','','cloud','{}',$2,'private','private',1,$3) RETURNING id`, [workspace.id,runtimeId,userId])).rows[0].id;
    agentIds.push(agentId);
    const issue = await api.createIssue("等待诊断：调度、准备与恢复");
    const commentId = (await db.query(`INSERT INTO comment (workspace_id,issue_id,author_type,author_id,content) VALUES ($1,$2,'member',$3,'请检查隔离运行的等待原因。') RETURNING id`, [workspace.id,issue.id,userId])).rows[0].id;
    const activeId = (await db.query(`INSERT INTO agent_task_queue (agent_id,runtime_id,issue_id,status,started_at,dispatched_at) VALUES ($1,$2,$3,'running',now(),now()) RETURNING id`,[agentId,runtimeId,issue.id])).rows[0].id;
    const queuedId = (await db.query(`INSERT INTO agent_task_queue (agent_id,runtime_id,issue_id,status,trigger_comment_id) VALUES ($1,$2,$3,'queued',$4) RETURNING id`,[agentId,runtimeId,issue.id,commentId])).rows[0].id;
    const claim = async (max = 1, capacity?: unknown) => {
      await db.query("UPDATE agent_runtime SET last_seen_at=now() WHERE id=$1", [runtimeId]);
      return request("/api/daemon/tasks/claim", { daemon_id: "run-wait-fixture", runtime_ids: [runtimeId], max_tasks: max, capacity });
    };
    const read = async () => {
      const runs = await request(`/api/issues/${issue.id}/task-runs`);
      const run = runs.find((r: { id: string }) => r.id === queuedId);
      evidence.push({ id: run.id, status: run.status, wait_diagnostic: run.wait_diagnostic, wait_history: run.wait_history });
      return run;
    };
    expect((await claim()).tasks).toHaveLength(0);
    expect((await read()).wait_diagnostic).toMatchObject({ code: "agent_concurrency", scope: "agent", occupied: 1, limit: 1 });
    await page.addInitScript(token => { localStorage.setItem("multica_token",token!); localStorage.setItem("multica:chat:isOpen","false"); },api.getToken());
    await page.context().addCookies([{ name: "multica-locale", value: "zh-Hans", url: process.env.FRONTEND_ORIGIN! }]);
    await page.setViewportSize({width:1440,height:1000});
    await page.goto(`/${workspace.slug}/issues/${issue.id}`, {waitUntil:"domcontentloaded"});
    const card = page.locator(`[data-run-id="${queuedId}"]`);
    await expect(card.getByText("该智能体并发已满 (1/1)",{exact:true})).toBeVisible({timeout:45_000});
    await card.getByRole("button",{name:"查看执行过程"}).click();
    await expect(card.locator("[data-run-wait-details]")).toBeVisible();
    await page.screenshot({path:testInfo.outputPath("agent-capacity.png"),fullPage:true});

    // The same queue row now reaches the next real admission gate.
    await db.query('UPDATE agent SET max_concurrent_tasks=2 WHERE id=$1',[agentId]);
    expect((await claim()).tasks).toHaveLength(0);
    expect((await read()).wait_diagnostic).toMatchObject({ code:"previous_run",scope:"issue_agent",blocking_task_id:activeId });
    await expect(card.getByText("等待上一条运行结束",{exact:true})).toBeVisible({timeout:15_000});
    await page.screenshot({path:testInfo.outputPath("serialization.png"),fullPage:true});
    await page.reload({waitUntil:"domcontentloaded"});
    await expect(card.getByText("等待上一条运行结束",{exact:true})).toBeVisible({timeout:30_000});

    await db.query("UPDATE agent_task_queue SET status='completed',completed_at=now() WHERE id=$1",[activeId]);
    const claimed=await claim();
    expect(claimed.tasks.map((r:{id:string})=>r.id)).toContain(queuedId);
    expect((await read()).wait_diagnostic.code).toBe("awaiting_daemon");
    await expect(card.getByText("已分派，等待守护进程确认领取",{exact:true})).toBeVisible({timeout:15_000});
    await request(`/api/daemon/tasks/${queuedId}/progress`,{preparation_code:"preparing_session"});
    await expect(card.getByText("已领取，正在准备智能体会话",{exact:true})).toBeVisible({timeout:15_000});
    await request(`/api/daemon/tasks/${queuedId}/wait-local-directory`,{reason:"verification-directory"});
    await request(`/api/daemon/tasks/${queuedId}/progress`,{preparation_code:"worktree_snapshot_busy"});
    expect((await read()).wait_diagnostic).toMatchObject({code:"worktree_snapshot_busy",phase:"resource_wait",scope:"local_directory"});
    await expect(card.getByText("等待目录释放以准备工作树快照",{exact:true})).toBeVisible({timeout:15_000});
    await page.screenshot({path:testInfo.outputPath("directory-wait.png"),fullPage:true});
    await request(`/api/daemon/tasks/${queuedId}/progress`,{preparation_code:"preparing_session"});
    await request(`/api/daemon/tasks/${queuedId}/start`,{});
    expect((await read()).wait_diagnostic).toBeUndefined();
    await expect(card.getByText("等待目录释放以准备工作树快照",{exact:true})).not.toBeVisible({timeout:15_000});

    if (process.env.RUN_WAIT_CLI) {
      const followUp=(await db.query(`INSERT INTO agent_task_queue (agent_id,runtime_id,issue_id,status) VALUES ($1,$2,$3,'queued') RETURNING id`,[agentId,runtimeId,issue.id])).rows[0].id;
      const observer=claimed.tasks.find((r:{id:string})=>r.id===queuedId);
      const cliEnv={...process.env,MULTICA_SERVER_URL:base,MULTICA_WORKSPACE_ID:workspace.id,MULTICA_TOKEN:observer.auth_token,MULTICA_AGENT_ID:agentId,MULTICA_TASK_ID:queuedId};
      const invokeCLI=(format:string)=>{
        const result=spawnSync(process.env.RUN_WAIT_CLI!,["issue","runs",issue.id,"--output",format],{env:cliEnv,encoding:"utf8"});
        const detail=`${result.error?.message ?? ""} ${result.stderr ?? ""}`.replaceAll(observer.auth_token,"[redacted]");
        expect(result.status,`CLI signal=${result.signal}: ${detail}`).toBe(0);
        return result.stdout;
      };
      const output=invokeCLI("json");
      const cliRun=JSON.parse(output).find((r:{id:string})=>r.id===followUp);
      expect(cliRun.wait_diagnostic).toMatchObject({code:"previous_run",scope:"issue_agent",blocking_task_id:queuedId});
      const table=invokeCLI("table");
      expect(table).toContain("等待上一条运行结束");
      await writeFile(`${process.env.RUN_WAIT_EVIDENCE_DIR ?? testInfo.outputDir}/run-wait-cli.json`,JSON.stringify({id:cliRun.id,status:cliRun.status,wait_diagnostic:cliRun.wait_diagnostic},null,2));
      await writeFile(`${process.env.RUN_WAIT_EVIDENCE_DIR ?? testInfo.outputDir}/run-wait-cli.txt`,table);
      await db.query("UPDATE agent_task_queue SET status='cancelled',completed_at=now() WHERE id=$1",[followUp]);
    }

    // Chat uses its own authorized endpoint and the same presentation.
    sessionId=(await db.query(`INSERT INTO chat_session (workspace_id,agent_id,creator_id,title,status,explicitly_created_at) VALUES ($1,$2,$3,'等待详情验收','active',now()) RETURNING id`,[workspace.id,agentId,userId])).rows[0].id;
    const chatRun=(await db.query(`INSERT INTO agent_task_queue (agent_id,runtime_id,chat_session_id,status) VALUES ($1,$2,$3,'queued') RETURNING id`,[agentId,runtimeId,sessionId])).rows[0].id;
    await claim(0,{occupied:8,limit:8,blocked:true});
    const chat=await request(`/api/chat/sessions/${sessionId}/pending-task`);
    expect(chat.wait_diagnostic).toMatchObject({code:"daemon_capacity",occupied:8,limit:8});
    evidence.push({task_id:chat.task_id,status:chat.status,wait_diagnostic:chat.wait_diagnostic});
    await page.goto(`/${workspace.slug}/chat?session=${sessionId}`,{waitUntil:"domcontentloaded"});
    await expect(page.getByText("守护进程执行槽已满 (8/8)",{exact:true})).toBeVisible({timeout:30_000});
    await page.getByText("等待详情",{exact:true}).click();
    await expect(page.locator("[data-run-wait-details]")).toBeVisible();
    await page.screenshot({path:testInfo.outputPath("chat-machine-capacity.png"),fullPage:true});
    await request(`/api/daemon/tasks/${queuedId}/complete`,{output:"Isolated verification complete."});
    await claim(0,{occupied:0,limit:8,blocked:false});
    await db.query("UPDATE agent_runtime SET status='offline' WHERE id=$1",[runtimeId]);
    const offline=await request(`/api/chat/sessions/${sessionId}/pending-task`);
    expect(offline.wait_diagnostic.code).toBe("runtime_offline");
    evidence.push({task_id:chatRun,status:offline.status,wait_diagnostic:offline.wait_diagnostic});
    await page.reload({waitUntil:"domcontentloaded"});
    await expect(page.getByText("运行时离线或心跳已过期",{exact:true})).toBeVisible({timeout:30_000});
  } finally {
    const outputDir=process.env.RUN_WAIT_EVIDENCE_DIR ?? testInfo.outputDir;
    await mkdir(outputDir,{recursive:true});
    await writeFile(`${outputDir}/run-wait-api.json`,JSON.stringify(evidence,null,2));
    await api.cleanup();
    for (const id of agentIds) await db.query('DELETE FROM agent_task_queue WHERE agent_id=$1',[id]);
    if (sessionId) await db.query('DELETE FROM chat_session WHERE id=$1',[sessionId]);
    for (const id of agentIds) await db.query('DELETE FROM agent WHERE id=$1',[id]);
    if(runtimeId) await db.query('DELETE FROM agent_runtime WHERE id=$1',[runtimeId]);
    await db.end();
  }
});
