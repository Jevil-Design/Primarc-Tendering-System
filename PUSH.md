# Pushing this project to GitHub

The repository `Jevil-Design/Tendering-System` exists but is empty apart from a
44-byte `README.md` — the previously tracked files were removed from `main`.
Treat this as an **initial commit**, not a merge.

> If that reset was accidental, recover the old commits first — `git reflog` on a
> clone that still has them, or the branch's pre-reset commit on GitHub. Pushing
> over `main` buries them.

---

## 1 · From the downloaded project folder

```bash
cd "path/to/Tendering System"

git init
git branch -M main
git add .
git commit -m "Cloudflare Workers backend: D1 schema, 101 endpoints, RBAC, audit"
```

`.gitignore` already excludes `uploads/`, `server/`, `cloud/`,
`github-deploy/`, `.dev.vars` and `.env`. Check what you are about to commit:

```bash
git status --short
```

---

## 2 · Point it at the repository

```bash
git remote add origin https://github.com/Jevil-Design/Tendering-System.git
```

---

## 3 · Push

The remote has one commit (its README) that your history does not share, so a
plain push is rejected. Two options:

**Replace the remote history** — simplest, since the only thing there is a stub
README that this project's own README supersedes:

```bash
git push --force -u origin main
```

**Or keep the remote commit** and merge the unrelated history:

```bash
git pull --allow-unrelated-histories --no-rebase origin main
# resolve the README.md conflict — keep this project's version
git push -u origin main
```

---

## 4 · Record the commit

After pushing:

```bash
git rev-parse HEAD
```

Paste that sha into `github.md` under `## Last sync` as `commit: <sha>`. That
line is what the next sync diffs against, so an accurate value there is what makes
incremental sync work.

---

## Notes

- `Tendering System.html` is large. It is under GitHub's 100 MB hard limit, but if `git push` warns about file size, consider tracking it with Git LFS or keeping it as a build artefact copied into the Pages deploy at release time.
- Never commit `.dev.vars` or a real `SESSION_PEPPER`. If either ever lands in a commit, rotate the secret — rewriting history does not un-leak it.
- `wrangler.toml` contains `REPLACE_WITH_YOUR_D1_DATABASE_ID` placeholders. A database id is not a secret, so committing the real one is fine.
