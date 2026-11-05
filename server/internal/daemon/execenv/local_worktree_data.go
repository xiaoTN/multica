package execenv

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// 私有数据放在仓库公共 Git 目录里，既不会被提交，也不属于任务目录的自动清理范围。
// 同一任务会话的不同智能体共用入口，每轮归档分别保存，避免覆盖上一轮的唯一副本。
func localWorktreeDataDir(gitRoot string, params LocalWorktreeParams) (string, error) {
	commonDir, err := gitCommonDirFor(gitRoot)
	if err != nil {
		return "", err
	}
	identity := params.WorkspaceID + "\x00" + params.ConversationID
	if params.ConversationID == "" {
		identity += "\x00" + params.TaskID
	}
	sum := sha256.Sum256([]byte(identity))
	dataDir := filepath.Join(commonDir, "multica-data", hex.EncodeToString(sum[:]))
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return "", fmt.Errorf("创建任务长期数据目录失败：%w", err)
	}
	return dataDir, nil
}

type worktreeDataManifest struct {
	Worktree string   `json:"worktree"`
	Branch   string   `json:"branch"`
	Paths    []string `json:"paths"`
}

// Git 忽略的文件同样可能是账本、原图和标注，不能因为 git status 看起来干净就删除。
// 按目录移动可以保留图片字节和 SQLite 的 WAL 文件，不需要复制大批缓存。
func (w *LocalWorktree) preserveIgnoredData() (string, error) {
	out, err := runGit(w.Path, "ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "--no-empty-directory", "-z")
	if err != nil {
		return "", fmt.Errorf("检查待保留的私有文件失败：%w", err)
	}
	if out == "" {
		return "", nil
	}
	if w.DataDir == "" {
		return "", fmt.Errorf("任务长期数据目录缺失，保留原工作目录")
	}
	paths := strings.Split(strings.TrimSuffix(out, "\x00"), "\x00")
	sum := sha256.Sum256([]byte(w.Path))
	archiveDir := filepath.Join(w.DataDir, "archives", hex.EncodeToString(sum[:]))
	filesDir := filepath.Join(archiveDir, "files")
	if err := os.MkdirAll(filesDir, 0o700); err != nil {
		return "", fmt.Errorf("创建私有文件归档失败：%w", err)
	}
	manifestPath := filepath.Join(archiveDir, "manifest.json")
	manifest := worktreeDataManifest{Worktree: w.Path, Branch: w.Branch}
	// 上次移动到一半时，已经保住的文件也必须继续出现在交接清单中。
	if data, readErr := os.ReadFile(manifestPath); readErr == nil {
		if err := json.Unmarshal(data, &manifest); err != nil {
			return archiveDir, fmt.Errorf("读取已有私有文件归档清单失败：%w", err)
		}
	} else if !os.IsNotExist(readErr) {
		return archiveDir, readErr
	}
	for _, path := range paths {
		rel := filepath.Clean(filepath.FromSlash(strings.TrimSuffix(path, "/")))
		if rel == "." || !filepath.IsLocal(rel) {
			return archiveDir, fmt.Errorf("私有文件路径不在工作目录内：%q", path)
		}
		found := false
		for _, saved := range manifest.Paths {
			found = found || saved == rel
		}
		if !found {
			manifest.Paths = append(manifest.Paths, rel)
		}
	}
	data, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return archiveDir, err
	}
	if err := os.WriteFile(manifestPath, data, 0o600); err != nil {
		return archiveDir, fmt.Errorf("保存私有文件归档清单失败：%w", err)
	}
	for _, path := range paths {
		rel := filepath.Clean(filepath.FromSlash(strings.TrimSuffix(path, "/")))
		source := filepath.Join(w.Path, rel)
		destination := filepath.Join(filesDir, rel)
		if _, err := os.Lstat(destination); err == nil || !os.IsNotExist(err) {
			return archiveDir, fmt.Errorf("归档目标已存在或不可读，保留原文件：%s", destination)
		}
		if err := os.MkdirAll(filepath.Dir(destination), 0o700); err != nil {
			return archiveDir, err
		}
		if err := os.Rename(source, destination); err != nil {
			return archiveDir, fmt.Errorf("保留私有文件 %q 失败，停止清理原工作目录：%w", rel, err)
		}
	}
	return archiveDir, nil
}
