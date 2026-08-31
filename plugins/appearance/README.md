# DFY DSH Appearance

Adds an **外观** page to the Harness settings sidebar. It preserves every visible
Assistant text output and collapses the context/reasoning/tool segment immediately
before that output behind its own disclosure. It also adjusts the chat font size and line-height ratio
without changing the sidebar, settings UI, editor, or persisted transcript.

The process-group adapter uses the public `conversation.chat.turnTail` slot and
the stable `data-chat-flow-kind` attributes emitted by DSH rc.8. It never edits
conversation data; disabling or unloading the plugin removes every DOM marker.
Media tool rows belong to the same per-output segment, so screenshots and visual
analysis collapse with the process that produced the following text and return in
their original position when that segment is expanded.

On DSH 0.1.2, enabling the plugin's process folding switches the built-in
`ui-chat.transcriptView` from `Compact` to `Normal`, then keeps its finer
per-response disclosures. This also runs once at activation when process folding
is already enabled. If the user later explicitly selects `Compact`, the plugin
yields its own disclosure layer to avoid double folding until its folding switch
is turned off and on again. DSH 0.1.1-rc.2 has no built-in Turn disclosure and
continues through the original capability-detected path.
