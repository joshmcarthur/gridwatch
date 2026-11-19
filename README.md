# Gridwatch NZ

An independent observatory for the New Zealand electricity market. Gridwatch turns public market data into plain-English explanations of what happened, why, and what it means. See the [project brief](docs/brief.md).

The project is in planning. There is no code yet.

## How work is tracked

GitHub issues in this repository are the work. The [Gridwatch Delivery Board](https://github.com/users/joshmcarthur/projects/5) shows their order and progress.

- **The issue is the spec.** Read the issue body and all comments before you start. When a later comment from the owner differs from the body, the comment wins.
- **Phases are parent issues.** Each phase is a parent issue with sub-issues.
- **Dependencies are "blocked by" links.** An issue is ready when every issue that blocks it is closed.
- **Priority is the board's `Priority` field**: `Now`, `Next` or `Later`. Labels do not set priority. The owner changes priority by moving cards on the board's **Steer** view.
- **Pick the next issue like this:** take an open, unassigned, ready issue with no sub-issues. Choose the highest `Priority`. If two issues have the same priority, choose the lower issue number.
- **Keep `Status` current:**

  | Status | When |
  |---|---|
  | Backlog | Not started |
  | In progress | You took the issue. Also comment on the issue to say so |
  | In review | A pull request is open. Link it from the issue |
  | Done | The issue is closed. The board sets this automatically |

- **`spike` issues** are research or decisions. The output is a document or an ADR, and the work usually ends with a question to the owner on the issue.
- **The owner merges pull requests.** Use `Closes #N` only when the pull request completes the issue. Otherwise use `Refs #N`.

To read or change board fields from the command line, `gh` needs the `project` scope (`gh auth refresh -s project`):

```bash
gh project item-list 5 --owner joshmcarthur --format json
```
