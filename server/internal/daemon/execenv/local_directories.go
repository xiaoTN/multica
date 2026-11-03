package execenv

import (
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
)

// LocalDirectoryForEnv 记录本次任务实际可以读写的仓库路径。
// 隔离模式下 Path 指向任务 worktree，不能把原仓库作为额外可写目录。
type LocalDirectoryForEnv struct {
	Path          string
	Label         string
	ExecutionMode string
}

func prepareAdditionalLocalDirectories(params PrepareParams, env *Environment, logger *slog.Logger) (err error) {
	if len(params.LocalDirectories) == 0 {
		return nil
	}
	env.LocalDirectories = append([]LocalDirectoryForEnv(nil), params.LocalDirectories...)
	env.LocalDirectories[0].Path = env.WorkDir
	defer func() {
		if err != nil {
			for _, worktree := range env.AdditionalLocalWorktrees {
				worktree.Discard(logger)
			}
		}
	}()
	for i := 1; i < len(env.LocalDirectories); i++ {
		directory := &env.LocalDirectories[i]
		if directory.ExecutionMode != "worktree" {
			continue
		}
		root := filepath.Join(env.RootDir, "repositories", fmt.Sprint(i))
		if err := os.MkdirAll(root, 0o755); err != nil {
			return err
		}
		key, id := localWorktreeConversation(params)
		worktree, err := PrepareLocalWorktree(LocalWorktreeParams{
			LocalPath: directory.Path, EnvRoot: root, AgentName: params.AgentName, TaskID: params.TaskID,
			ConversationKey: key, ConversationID: id, WorkspaceID: params.WorkspaceID, AgentID: params.Task.AgentID,
		}, logger)
		if err != nil {
			return fmt.Errorf("准备仓库 %s 的隔离分支失败：%w", directory.Label, err)
		}
		env.AdditionalLocalWorktrees = append(env.AdditionalLocalWorktrees, worktree)
		if err := os.MkdirAll(worktree.WorkDir, 0o755); err != nil {
			return err
		}
		directory.Path = worktree.WorkDir
	}
	return nil
}
