# Agent tools — how to add one

All scoped tools an agent can call in chat / the worker are declared in **one place** via a
reusable template: the `ToolRegistry` in [`toolkit.py`](./toolkit.py). Each tool is a single
decorated async handler in [`main.py`](./main.py) — schema, access scope and implementation
live together. The registry derives everything else: the per-provider JSON schemas
(OpenAI + Anthropic/Bedrock), which tools are offered to a given agent, and the server-side
dispatch + permission gate.

## Add a new tool (the whole checklist)

```python
@REG.tool(
    "set_task_priority",                         # tool name the model calls
    "Đổi độ ưu tiên một ticket.",                # description shown to the model
    params={                                     # JSON-Schema "properties"
        "task_id": {"type": "string"},
        "priority": {"type": "string", "enum": ["low", "medium", "high", "urgent"]},
    },
    required=["task_id", "priority"],
    access=Access.LEAD,                           # EVERYONE | LEAD  (see below)
    # reader_ok=True,                             # also offer to the worker read-step
)
async def _t_set_priority(actor: str, a: dict) -> str:
    # actor = the calling agent's slug (SERVER-SIDE, never trust it from args)
    ...
    return _jok(task_id=a["task_id"], priority=a["priority"])   # or _jerr("...")
```

That's it. No edits to any schema dict, offered-name list, or dispatch/if-elif — they're all
derived from the registry.

## Access scopes

| scope             | offered to                                              |
|-------------------|--------------------------------------------------------|
| `Access.EVERYONE` | every hired agent (base toolset: `view_db`, docs, `record_learning`) |
| `Access.LEAD`     | `WRITE_SLUGS` (the leads) **or** any agent explicitly granted this tool |
| `reader_ok=True`  | additionally offered to the worker's read-only deliverable step (`__reader__`) |

The gate is enforced server-side in `REG.execute` regardless of what the model requests, so a
non-lead can never run a `LEAD` tool unless it was granted the matching permission.

## Granting a LEAD tool to a non-lead (the permission catalog)

Who can run a `LEAD` tool beyond the leads is driven by the **canonical permission catalog**
`company.permissions` (see migration `../db/017_permissions.sql` and the Access Tools settings
tab). A permission row's `tools` array lists the backend tool names it unlocks; granting that
permission to an agent (Tuyển dụng flow → `company.agent_permissions`) adds those tool names to
the agent's offered+allowed set. So to expose a new LEAD tool to hires:

1. register the tool with `access=Access.LEAD` (above), then
2. add it to an existing permission's `tools`, or create a new permission whose `tools` includes
   it (Access Tools tab → **＋ Thêm quyền**, `tools` field).

## Contract

- Handler signature: `async (actor: str, args: dict) -> str`, returning a JSON string
  (`_jok(**kw)` / `_jerr(msg)`).
- **Identity is server-side.** `actor` is the calling agent — never read the acting agent from
  `args`, so a self-scoped tool (e.g. `record_learning`, `write_doc`) can only act as itself.
- Handlers stay plain functions (the decorator returns them unchanged), so they're still
  callable directly — e.g. the worker invokes `_t_write_doc` deterministically.

## Not covered here

The separate **MCP server** in `../mcp/` (Node) exposes its own scoped chat/task tools to
external MCP clients. That's a different runtime and is not part of this Python registry.
