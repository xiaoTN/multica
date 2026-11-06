import "./env";
import { test, expect, type Page, type Locator, type Request } from "@playwright/test";
import pg from "pg";
import { writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { TestApiClient } from "./fixtures";

test.use({
  launchOptions: { executablePath: process.env.MULTICA_E2E_CHROMIUM_EXECUTABLE },
  video: "on",
  trace: "on",
  viewport: { width: 1440, height: 1000 },
});

async function setup(page: Page) {
  page.setDefaultTimeout(15_000);
  page.setDefaultNavigationTimeout(45_000);
  if (!process.env.DATABASE_URL?.includes("/multica_worktree_")) throw new Error("isolated worktree database required");
  const api = new TestApiClient();
  await api.loginLocal();
  const workspace = await api.ensureWorkspace("Annotation focus verification", "annotation-focus");
  await api.markUserOnboarded();
  await page.addInitScript(token => {
    localStorage.setItem("multica_token", token!);
    localStorage.setItem("multica:chat:isOpen", "false");
  }, api.getToken());
  return { api, workspace };
}

async function openNote(page: Page, source: Locator, description = false) {
  await source.click({ trial: true });
  const rect = await source.evaluate(element => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const bounds = range.getBoundingClientRect();
    return { left: bounds.left, right: bounds.right, y: bounds.top + bounds.height / 2 };
  });
  await page.mouse.move(rect.left + 1, rect.y);
  await page.mouse.down();
  await page.mouse.move(rect.right - 1, rect.y, { steps: 12 });
  await page.mouse.up();
  expect(await page.evaluate(() => window.getSelection()?.toString())).not.toBe("");
  await page.getByRole("button", { name: description ? "Add to comment" : "Add to reply", exact: true }).click();
  const note = page.getByRole("textbox", { name: "Comment", exact: true });
  await expect(note).toBeFocused();
  return note;
}

function recordPosts(page: Page, path: string) {
  const posts: { body: Record<string, unknown>; status?: number }[] = [];
  const requests = new Map<Request, (typeof posts)[number]>();
  page.on("request", request => {
    if (request.url().endsWith(path) && request.method() === "POST") {
      const entry = { body: request.postDataJSON() };
      requests.set(request, entry);
      posts.push(entry);
    }
  });
  page.on("response", response => {
    const entry = requests.get(response.request());
    if (entry) entry.status = response.status();
  });
  return posts;
}

async function editSourceMarker(page: Page, note: string, surface: string) {
  const marker = page.locator('[data-reply-annotation-overlay] > button[aria-label="Edit annotation 1"]');
  await expect(marker).toBeVisible();
  const hit = await marker.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const target = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    return { matches: element === target || element.contains(target), target: target?.outerHTML.slice(0, 500) };
  });
  await writeFile(test.info().outputPath(`${surface}-marker-hit.json`), JSON.stringify(hit, null, 2));
  await marker.click();
  const input = page.getByRole("textbox", { name: "Comment", exact: true });
  await expect(input).toBeFocused();
  await page.screenshot({ path: test.info().outputPath(`${surface}-marker-edit.png`) });
  await input.fill(note);
  await page.keyboard.press("Enter");
}

function topCommentEditor(page: Page) {
  // Exclude description, thread and floating chat editors so lazy remounts
  // and page reloads cannot invalidate the composer's scope.
  return page.locator('.ProseMirror[contenteditable="true"]:not([data-comment-content] *, [data-annotation-thread] *, .absolute.z-50 *)');
}

test("chat page and floating chat hand off focus without submitting the confirmation key", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const { api, workspace } = await setup(page);
  const database = new pg.Client(process.env.DATABASE_URL);
  await database.connect();
  let runtimeId: string | undefined;
  let agentId: string | undefined;
  let sessionId: string | undefined;
  try {
    const user = await database.query('SELECT id FROM "user" WHERE email=$1', [api.getEmail()]);
    runtimeId = (await database.query(`INSERT INTO agent_runtime (workspace_id,name,runtime_mode,provider,status,device_info,metadata,owner_id,last_seen_at) VALUES ($1,'Annotation focus','cloud','codex','online','E2E fixture','{}',$2,now()) RETURNING id`, [workspace.id, user.rows[0].id])).rows[0].id;
    agentId = (await database.query(`INSERT INTO agent (workspace_id,name,description,instructions,runtime_mode,runtime_config,runtime_id,visibility,permission_mode,max_concurrent_tasks,owner_id) VALUES ($1,'Annotation focus','','','cloud','{}',$2,'private','private',1,$3) RETURNING id`, [workspace.id, runtimeId, user.rows[0].id])).rows[0].id;
    sessionId = (await database.query(`INSERT INTO chat_session (workspace_id,agent_id,creator_id,title,status,explicitly_created_at) VALUES ($1,$2,$3,'Annotation focus test','active',now()) RETURNING id`, [workspace.id, agentId, user.rows[0].id])).rows[0].id;
    const sourceId = (await database.query(`INSERT INTO chat_message (chat_session_id,role,content) VALUES ($1,'assistant','Source sentence for annotation focus.') RETURNING id`, [sessionId])).rows[0].id;
    const otherSourceId = (await database.query(`INSERT INTO chat_message (chat_session_id,role,content) VALUES ($1,'assistant','Another source for consecutive annotations.') RETURNING id`, [sessionId])).rows[0].id;
    const path = `/sessions/${sessionId}/messages`;
    const posts = recordPosts(page, path);
    await page.goto(`/${workspace.slug}/chat?session=${sessionId}`);
    const editor = page.locator('.ProseMirror[contenteditable="true"]:visible').last();
    await expect(editor).toBeVisible({ timeout: 45_000 });
    await editor.fill("Preserved chat body");
    const source = page.locator(`[data-chat-reply-content="${sourceId}"] p`);
    const note = await openNote(page, source);
    await note.fill("   ");
    await page.keyboard.press("Enter");
    await expect(note).toBeFocused();
    const nativeImeTool = process.env.MULTICA_E2E_NATIVE_IME_TOOL;
    if (nativeImeTool) {
      const cdp = await page.context().browser()!.newBrowserCDPSession();
      const processes = await cdp.send("SystemInfo.getProcessInfo");
      const browserPid = processes.processInfo.find(p => p.type === "browser")!.id;
      await page.bringToFront();
      execFileSync("osascript", ["-e", `tell application "System Events" to set frontmost of (first application process whose unix id is ${browserPid}) to true`]);
      const originalSource = execFileSync(nativeImeTool, { encoding: "utf8" }).trim();
      try {
        await note.fill("");
        await note.evaluate(element => {
          element.addEventListener("compositionstart", () => { element.dataset.nativeComposition = "true"; });
          element.addEventListener("keydown", event => {
            if (event instanceof KeyboardEvent && event.key === "Enter") {
              element.dataset.nativeImeEnter = String(event.isComposing || event.keyCode === 229);
            }
          });
        });
        execFileSync(nativeImeTool, ["com.apple.inputmethod.SCIM.ITABC"]);
        execFileSync("osascript", ["-e", 'tell application "System Events" to keystroke "zhongwen"']);
        await expect(note).toHaveAttribute("data-native-composition", "true");
        execFileSync("osascript", ["-e", 'tell application "System Events" to key code 36']);
        await expect(note).toBeFocused();
        await expect(note).toHaveAttribute("data-native-ime-enter", "true");
        expect(posts).toHaveLength(0);
        await page.screenshot({ path: testInfo.outputPath("native-pinyin-commit.png") });
      } finally {
        execFileSync(nativeImeTool, [originalSource]);
      }
    }
    await note.fill("中文批注意见");
    // Browser composition events and Safari's keyCode boundary are covered
    // here; a native macOS input method still requires a separate manual run.
    await note.dispatchEvent("compositionstart", { data: "中" });
    await note.dispatchEvent("keydown", { key: "Enter", keyCode: 229, isComposing: true });
    await expect(note).toBeFocused();
    await note.dispatchEvent("compositionend", { data: "中文" });
    await page.keyboard.down("Enter");
    await expect(editor).toBeFocused();
    await expect(page.getByRole("button", { name: "1 annotation", exact: true })).toBeVisible();
    expect(posts).toHaveLength(0);
    await page.screenshot({ path: testInfo.outputPath("chat-first-enter.png") });
    // A second down without an up is a trusted repeat keydown in Chromium.
    await page.keyboard.down("Enter");
    await page.keyboard.down("Enter");
    await page.keyboard.up("Enter");
    expect(posts).toHaveLength(0);
    await editSourceMarker(page, "修订中文批注意见", "chat");
    await expect(editor).toBeFocused();
    await expect(page.getByRole("button", { name: "1 annotation", exact: true })).toBeVisible();
    expect(posts).toHaveLength(0);
    const sent = page.waitForResponse(r => r.url().endsWith(path) && r.request().method() === "POST");
    await page.keyboard.press("Enter");
    expect((await sent).status()).toBe(201);
    await expect(editor).toHaveText("");
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body.content).toContain("Preserved chat body");
    expect(posts[0]!.body.content).toContain("Source sentence for annotation focus");
    expect(posts[0]!.body.content).toContain("中文批注意见");
    expect(posts[0]!.body.content).toContain("修订中文批注意见");
    await page.screenshot({ path: testInfo.outputPath("chat-second-enter.png") });
    // No daemon exists in this environment. Complete the fixture task so the
    // next send exercises ordinary annotation-only sending.
    await database.query(`UPDATE agent_task_queue SET status='completed',completed_at=now() WHERE chat_session_id=$1`, [sessionId]);
    await page.goto(`/${workspace.slug}/settings?tab=shortcuts`);
    await page.keyboard.press("ControlOrMeta+J");
    await expect(editor).toBeVisible();
    const floatingNote = await openNote(page, source);
    await floatingNote.fill("Floating annotation only");
    await page.getByRole("button", { name: "Add annotation", exact: true }).click();
    await expect(editor).toBeFocused();
    expect(posts).toHaveLength(1);
    const nextNote = await openNote(page, page.locator(`[data-chat-reply-content="${otherSourceId}"] p`));
    await nextNote.fill("Second floating annotation");
    await page.keyboard.press("Enter");
    await expect(editor).toBeFocused();
    await editSourceMarker(page, "Revised floating annotation", "floating");
    await expect(editor).toBeFocused();
    await expect(page.getByRole("button", { name: "2 annotations", exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("floating-first-enter.png") });
    const floatingSent = page.waitForResponse(r => r.url().endsWith(path) && r.request().method() === "POST");
    await page.keyboard.press("Enter");
    expect((await floatingSent).status()).toBe(201);
    expect(posts).toHaveLength(2);
    expect(posts[1]!.body.content).toContain("Revised floating annotation");
    expect(posts[1]!.body.content).toContain("Second floating annotation");
    await writeFile(testInfo.outputPath("chat-requests.json"), JSON.stringify({
      boundaries: { page_confirmation: 0, page_send: 1, floating_confirmations_and_edit: 1, floating_send: 2 }, posts,
    }, null, 2));
  } finally {
    if (sessionId) {
      await database.query("DELETE FROM agent_task_queue WHERE chat_session_id=$1", [sessionId]);
      await database.query("DELETE FROM chat_message WHERE chat_session_id=$1", [sessionId]);
      await database.query("DELETE FROM chat_session WHERE id=$1", [sessionId]);
    }
    if (agentId) await database.query("DELETE FROM agent WHERE id=$1", [agentId]);
    if (runtimeId) await database.query("DELETE FROM agent_runtime WHERE id=$1", [runtimeId]);
    await database.end();
    await api.cleanup();
  }
});

test("board annotations focus their own top-level comment or thread reply and retain rejected drafts", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const { api, workspace } = await setup(page);
  try {
    const issue = await api.createIssue("Annotation focus board", { description: "Description sentence for annotation focus." });
    const root = await api.createComment(issue.id, "Thread sentence for annotation focus.");
    const path = `/issues/${issue.id}/comments`;
    const posts = recordPosts(page, path);
    // Avoid a UUID-to-identifier route replacement during selection or draft edits.
    const issueUrl = `/${workspace.slug}/issues/${issue.identifier}`;
    await page.goto(issueUrl);
    const description = page.locator(`[data-comment-content="description:${issue.id}"] p`);
    await expect(description).toBeVisible({ timeout: 45_000 });
    const topEditor = topCommentEditor(page);
    const topNote = await openNote(page, description, true);
    await topNote.fill("Top-level annotation");
    await page.keyboard.press("Enter");
    await expect(topEditor).toHaveCount(1);
    await expect(topEditor).toBeFocused();
    expect(posts).toHaveLength(0);
    await topEditor.fill("Preserved comment body");
    await editSourceMarker(page, "Revised Top-level annotation", "board-comment");
    await expect(topEditor).toBeFocused();
    await expect(topEditor).toContainText("Preserved comment body");
    await expect(page.getByRole("button", { name: "1 annotation", exact: true })).toBeVisible();
    expect(posts).toHaveLength(0);
    await page.screenshot({ path: testInfo.outputPath("board-comment-first-enter.png") });
    const commentSent = page.waitForResponse(r => r.url().endsWith(path) && r.request().method() === "POST");
    await page.keyboard.press("Enter");
    expect((await commentSent).status()).toBe(201);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body.content).toContain("Preserved comment body");
    expect(posts[0]!.body.content).toContain("Top-level annotation");
    expect(posts[0]!.body.content).toContain("Revised Top-level annotation");
    expect(posts[0]!.body.parent_id).toBeFalsy();
    const threadSource = page.locator(`[data-comment-content="${root.id}"] p`);
    const replyNote = await openNote(page, threadSource);
    await replyNote.fill("Thread annotation");
    await page.keyboard.press("Enter");
    const thread = page.locator(`[data-annotation-thread="reply:${issue.id}:${root.id}"]`);
    const replyEditor = thread.locator('.ProseMirror[contenteditable="true"]');
    await expect(replyEditor).toBeFocused();
    expect(posts).toHaveLength(1);
    await replyEditor.fill("Preserved reply body");
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.type("Second line");
    expect(posts).toHaveLength(1);
    await editSourceMarker(page, "Revised Thread annotation", "board-reply");
    await expect(replyEditor).toBeFocused();
    await expect(replyEditor).toContainText("Preserved reply body");
    await expect(thread.getByRole("button", { name: "1 annotation", exact: true })).toBeVisible();
    expect(posts).toHaveLength(1);
    await page.screenshot({ path: testInfo.outputPath("board-reply-first-enter.png") });
    // Reject at the request boundary, then retry the same real editor draft.
    await page.route(`**${path}`, route => route.request().method() === "POST"
      ? route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"Annotation focus fixture rejection"}' })
      : route.continue());
    const failed = page.waitForResponse(r => r.url().endsWith(path) && r.request().method() === "POST");
    await page.keyboard.press("Enter");
    expect((await failed).status()).toBe(500);
    await expect(replyEditor).toContainText("Preserved reply body");
    await expect(thread.getByRole("button", { name: "1 annotation", exact: true })).toBeVisible();
    await page.reload();
    await expect(thread).toBeVisible({ timeout: 45_000 });
    await expect(replyEditor).toContainText("Preserved reply body");
    await expect(thread.getByRole("button", { name: "1 annotation", exact: true })).toBeVisible();
    await replyEditor.click();
    await page.unroute(`**${path}`);
    const replySent = page.waitForResponse(r => r.url().endsWith(path) && r.request().method() === "POST");
    await page.keyboard.press("Enter");
    expect((await replySent).status()).toBe(201);
    expect(posts).toHaveLength(3);
    expect(posts[2]!.body).toMatchObject({ parent_id: root.id });
    expect(posts[2]!.body.content).toContain("Thread annotation");
    expect(posts[2]!.body.content).toContain("Revised Thread annotation");
    expect(posts[2]!.body.content).toContain("Preserved reply body");
    expect(posts[2]!.body.content).toContain("Second line");
    await page.screenshot({ path: testInfo.outputPath("board-reply-second-enter.png") });

    // An explicit Mod+Enter preference survives reload and takes precedence
    // over the annotation-only contextual default.
    await page.goto(`/${workspace.slug}/settings?tab=shortcuts`);
    const recorder = page.getByRole("button", { name: "Change shortcut for Send", exact: true });
    await recorder.click();
    await recorder.press("ControlOrMeta+Enter");
    await page.reload();
    await page.goto(issueUrl);
    const customNote = await openNote(page, description, true);
    await customNote.fill("Explicit send preference annotation");
    await page.keyboard.press("Enter");
    await expect(topEditor).toBeFocused();
    await page.keyboard.press("Enter");
    expect(posts).toHaveLength(3);
    const customSent = page.waitForResponse(r => r.url().endsWith(path) && r.request().method() === "POST");
    await page.keyboard.press("ControlOrMeta+Enter");
    expect((await customSent).status()).toBe(201);
    expect(posts).toHaveLength(4);
    await page.goto(`/${workspace.slug}/settings?tab=shortcuts`);
    await page.getByRole("button", { name: "Disable Send shortcut", exact: true }).click();
    await page.goto(issueUrl);
    const disabledNote = await openNote(page, description, true);
    await disabledNote.fill("Disabled send shortcut annotation");
    await page.keyboard.press("Enter");
    await expect(topEditor).toBeFocused();
    await page.keyboard.press("Enter");
    await page.keyboard.press("ControlOrMeta+Enter");
    expect(posts).toHaveLength(4);
    await page.screenshot({ path: testInfo.outputPath("board-disabled-shortcut.png") });
    await writeFile(testInfo.outputPath("board-requests.json"), JSON.stringify({
      boundaries: { comment_confirmation: 0, comment_send: 1, reply_confirmation: 1, rejected_reply: 2,
        reply_retry: 3, custom_plain_enter: 3, custom_primary_enter: 4, disabled_enter: 4 }, posts,
    }, null, 2));
  } finally {
    await api.cleanup();
  }
});
