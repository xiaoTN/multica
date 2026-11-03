package daemon

import (
	"context"
	"encoding/json"
	"log/slog"
	"testing"
)

func TestMultipleRepositorySnapshotLease(t *testing.T) {
	d := &Daemon{cfg: Config{DaemonID: "local"}, localPathLocks: NewLocalPathLocker(), logger: slog.Default()}
	direct, isolated := t.TempDir(), t.TempDir()
	task := Task{ID: "multi-task", localDirectoryLease: &localDirectoryTaskLease{}}
	for i, path := range []string{direct, isolated} {
		mode := "in_place"
		if i == 1 {
			mode = "worktree"
		}
		ref, err := json.Marshal(localDirectoryRef{LocalPath: path, DaemonID: "local", ExecutionMode: mode})
		if err != nil {
			t.Fatal(err)
		}
		task.ProjectResources = append(task.ProjectResources, ProjectResourceData{ResourceType: localDirectoryResourceType, ResourceRef: ref})
	}
	release, abort := d.acquireLocalDirectoryLockIfNeeded(context.Background(), task, slog.Default())
	if abort || release == nil {
		t.Fatalf("获取多仓库锁失败：%v", abort)
	}
	defer release()
	assignment, err := localDirectoryAssignmentForTask(task, "local")
	if err != nil {
		t.Fatal(err)
	}
	for _, directory := range assignment.Directories() {
		if got := d.localPathLocks.Holder(directory.RealPath); got != task.ID {
			t.Fatalf("准备时没有锁住仓库 %s：%s", directory.AbsPath, got)
		}
	}
	snapshotRelease, err := d.acquireWorktreeSnapshotLock(context.Background(), task, assignment, func(string) { t.Fatal("重复获取了自己持有的快照锁") })
	if err != nil {
		t.Fatal(err)
	}
	snapshotRelease()
	task.localDirectoryLease.releaseSnapshots()
	if got := d.localPathLocks.Holder(assignment.RealPath); got != task.ID {
		t.Fatal("直接编辑仓库被提前释放")
	}
	if got := d.localPathLocks.Holder(assignment.Additional[0].RealPath); got != "" {
		t.Fatal("隔离仓库快照结束后仍阻塞其他任务")
	}
	release()
	if got := d.localPathLocks.Holder(assignment.RealPath); got != "" {
		t.Fatal("任务结束后仍占用仓库")
	}
}
