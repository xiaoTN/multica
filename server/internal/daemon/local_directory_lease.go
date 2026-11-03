package daemon

import "context"

// localDirectoryTaskLease 让多仓库任务先统一获取锁，完成快照后释放隔离仓库的锁。
type localDirectoryTaskLease struct{ snapshots []func() }

func (l *localDirectoryTaskLease) releaseSnapshots() {
	for _, release := range l.snapshots {
		release()
	}
	l.snapshots = nil
}

func (d *Daemon) acquireWorktreeSnapshotLock(ctx context.Context, task Task, assignment *localDirectoryAssignment, onWait func(string)) (func(), error) {
	if task.localDirectoryLease != nil && len(assignment.Additional) > 0 {
		return func() {}, nil
	}
	return d.localPathLocks.Acquire(ctx, assignment.RealPath, task.ID, onWait)
}
