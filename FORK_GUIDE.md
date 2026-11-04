# 个人定制版与官方更新

这是基于 [Multica 官方源码](https://github.com/multica-ai/multica) 的个人定制版，应用名称为“Agent团队协作”。

- 个人 fork：<https://github.com/xiaoTN/multica>
- `main`：保留官方代码，便于同步上游。
- `codex/local-only`：日常开发和使用的定制分支，保留本机后台、免登录、多仓库任务、应用改名，以及网页复用桌面配置等改动。
- 本机功能和构建方法见 [LOCAL_ONLY.md](LOCAL_ONLY.md)；网页复用桌面后台的启动方法见 [CONTRIBUTING.md](CONTRIBUTING.md)。

本批定制提交基于官方提交 `82492f94d669e504a2fda36fb6c76f4ac7d65f2e`。保留这些提交的历史，后续通过合并接收官方更新。

## 在新电脑上获取定制版

```sh
git clone --branch codex/local-only https://github.com/xiaoTN/multica.git
cd multica
git remote set-url --push origin https://github.com/xiaoTN/multica.git
git remote add upstream https://github.com/multica-ai/multica.git
git branch --track main origin/main
```

`origin` 指向个人 fork，用来保存自己的改动；`upstream` 指向官方仓库，用来获取更新。

## 同步官方更新

先提交或妥善保存当前改动，保证工作区干净，再执行：

```sh
git fetch upstream
git fetch origin
git switch main
git merge --ff-only upstream/main
git push origin main
git switch codex/local-only
git merge main
```

如果合并发生冲突，逐个处理后完成合并提交，再按改动范围运行 [仓库检查](CONTRIBUTING.md) 并实际验收桌面和网页。确认可用后保存到个人 fork：

```sh
git push origin codex/local-only
```

GitHub 的 **Sync fork** 可以更新 `main`；更新后还要把 `main` 合入定制分支并验证，定制分支才会带上这些更新。不要把日常定制提交直接放到 `main`。

## 源码和本机数据

这个仓库保存源码及构建说明。`.env`、数据库数据、应用运行配置、登录凭据、执行日志和编译产物需要在每台电脑上单独准备或备份，不随本次源码推送上传。

若本机另装了旧版 `multica` 命令工具，需确认任务使用的是当前 App 内置的版本；登录 shell 可能重排 `PATH`，导致旧工具优先。个人 shell 配置属于本机设置，也不包含在仓库里。

## 来源与许可证

保留上游完整的 [LICENSE](LICENSE) 和来源信息。上游许可证允许公开源码 fork，同时对产品改名、LOGO 和界面署名有单独限制；本定制分支包含改名改动，不表示已取得品牌豁免。使用、分发或提供服务前需按许可证核对相应条件。
