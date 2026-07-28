"""Reusable agent-tool template + registry.

Before this, every scoped agent tool had its pieces scattered across main.py: a JSON
schema in a big `_TOOL_DEFS` dict, a `_t_*` handler far below, its name hand-added to an
"offered" set, and an if/elif branch in the dispatch/permission gate. Adding a tool meant
editing four places and it was easy to miss one.

This module is the ONE template they now inherit from. A new tool is a single decorated
async handler:

    @REG.tool(
        "set_task_priority",
        "Đổi độ ưu tiên một ticket.",
        params={"task_id": {"type": "string"},
                "priority": {"type": "string", "enum": ["low", "medium", "high", "urgent"]}},
        required=["task_id", "priority"],
        access=Access.LEAD,          # EVERYONE = mọi agent · LEAD = lead/được cấp quyền
    )
    async def _t_set_priority(actor: str, a: dict) -> str:
        ...
        return _jok(task_id=a["task_id"], priority=a["priority"])

The registry then derives, with no other edits:
  • the per-provider JSON schema (OpenAI + Anthropic function-calling shapes),
  • which tools are OFFERED to a given agent (by access scope + granted perms + reader flag),
  • the server-side DISPATCH + permission GATE (an agent only runs what its scope allows).

Handler contract: `async (actor: str, args: dict) -> str` returning a JSON string
(use the caller's _jok/_jerr). Identity (`actor`) comes from the server, never from args,
so a self-scoped tool can only act as the calling agent. Handlers stay plain functions —
the decorator returns them unchanged, so they're still callable directly (e.g. the worker
invoking `_t_write_doc` deterministically).
"""
from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Awaitable, Callable, Iterable


class Access(str, Enum):
    """Who a tool is offered to / allowed for."""
    EVERYONE = "everyone"      # every hired agent (the base toolset: view_db, docs, self-learning)
    LEAD = "lead"              # WRITE_SLUGS, or any agent explicitly granted this tool's permission
    RESTRICTED = "restricted"  # NOBODY by default — only an agent explicitly granted this tool
                               # (leads do NOT get it for free). For sensitive powers like access mgmt.


Handler = Callable[[str, dict], Awaitable[str]]


@dataclass
class ToolSpec:
    name: str
    description: str
    params: dict           # JSON-Schema "properties" object
    required: list[str]
    access: Access
    handler: Handler
    reader_ok: bool = False  # also offered to the worker read-only step (the "__reader__" slug)

    def _schema(self) -> dict:
        return {"type": "object", "properties": self.params, "required": self.required}

    def openai(self) -> dict:
        """OpenAI function-calling shape."""
        return {"type": "function", "function": {
            "name": self.name, "description": self.description, "parameters": self._schema()}}

    def anthropic(self) -> dict:
        """Anthropic / Bedrock tool shape."""
        return {"name": self.name, "description": self.description, "input_schema": self._schema()}


class ToolRegistry:
    """Holds every tool spec and derives schemas / offered-names / dispatch from them."""

    def __init__(self) -> None:
        self._tools: dict[str, ToolSpec] = {}

    # -- registration -----------------------------------------------------------
    def tool(
        self,
        name: str,
        description: str,
        *,
        params: dict | None = None,
        required: list[str] | None = None,
        access: Access = Access.LEAD,
        reader_ok: bool = False,
    ) -> Callable[[Handler], Handler]:
        """Decorator: register an async handler as a tool. Returns the handler unchanged."""
        def deco(fn: Handler) -> Handler:
            if name in self._tools:
                raise ValueError(f"tool '{name}' already registered")
            self._tools[name] = ToolSpec(name, description, params or {}, required or [], access, fn, reader_ok)
            return fn
        return deco

    def get(self, name: str) -> ToolSpec | None:
        return self._tools.get(name)

    def all(self) -> list[ToolSpec]:
        return list(self._tools.values())

    # -- what's OFFERED to an agent --------------------------------------------
    def names_for(self, *, reader: bool = False, lead: bool = False,
                  granted: Iterable[str] = ()) -> list[str]:
        """The sorted tool names offered to an agent.

        reader → only tools flagged reader_ok (worker deliverable step: look-up only).
        Otherwise: every EVERYONE tool, plus LEAD tools if `lead`, plus any explicitly
        `granted` tool names (from the per-agent permission grants)."""
        if reader:
            return sorted(t.name for t in self._tools.values() if t.reader_ok)
        names = {t.name for t in self._tools.values() if t.access is Access.EVERYONE}
        if lead:
            names |= {t.name for t in self._tools.values() if t.access is Access.LEAD}
        names |= {g for g in granted if g in self._tools}
        return sorted(names)

    def openai_tools(self, names: Iterable[str]) -> list[dict]:
        return [self._tools[n].openai() for n in names if n in self._tools]

    def anthropic_tools(self, names: Iterable[str]) -> list[dict]:
        return [self._tools[n].anthropic() for n in names if n in self._tools]

    # -- DISPATCH + server-side GATE -------------------------------------------
    async def execute(
        self,
        actor: str | None,
        name: str,
        args: dict | None,
        *,
        lead: bool = False,
        granted: Iterable[str] = (),
        err: Callable[[str], str] = lambda m: m,
    ) -> str:
        """Run a tool call after enforcing its access scope (regardless of what the model
        asked for). EVERYONE tools run for anyone; LEAD tools require `lead` or an explicit
        grant; RESTRICTED tools require an explicit grant only (leads don't get them free).
        Exceptions become an error payload via `err`."""
        spec = self._tools.get(name)
        if spec is None:
            return err(f"unknown tool '{name}'")
        gset = set(granted)
        if spec.access is Access.LEAD and not lead and name not in gset:
            return err("tool này chỉ dành cho lead / agent được cấp quyền")
        if spec.access is Access.RESTRICTED and name not in gset:
            return err("tool này chỉ dành cho agent được cấp quyền riêng (vd Access & Tools Administrator)")
        try:
            return await spec.handler(actor or "", args or {})
        except Exception as e:  # noqa: BLE001
            return err(str(e)[:300])
